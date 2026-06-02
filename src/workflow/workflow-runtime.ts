import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import type { WorkflowRunOptions, WorkflowRunResult, WorkflowCtx, CallRecord } from './types.js'
import { AgentExecutor } from './agent-executor.js'
import { SqliteJournal } from './journal.js'
import { hashCanonical } from './hash.js'
import { Semaphore } from './concurrency.js'
import { BudgetTracker } from './budget.js'
import { NodeVmRuntime } from './sandbox.js'
import { Workspace } from './workspace.js'

const MAX_AGENTS = 1000

function makeRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 8)
  return `run-${ts}-${rand}`
}

export async function executeWorkflow(
  opts: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  const argsHash = hashCanonical(opts.args)
  // 读取脚本文件内容 → 内容哈希（改名不影响 resume）
  const scriptContent = await readFile(opts.scriptPath, 'utf8')
  const scriptHash = hashCanonical(scriptContent)

  const journal = new SqliteJournal(opts.journalPath ?? ':memory:')

  // Phase 1: 完全命中快速路径
  const prior = journal.lookupPrefix(scriptHash, argsHash, 1)
  if (prior) {
    let lastOutput: unknown = undefined
    if (prior.calls.length > 0) {
      const lastCall = prior.calls[prior.calls.length - 1]
      try {
        const parsed = JSON.parse(lastCall.result)
        lastOutput = parsed?.output
      } catch { /* ignore */ }
    }
    process.stderr.write(
      `[usage] all-cached live=0 cached=${prior.calls.length}\n`,
    )
    journal.close()
    return {
      runId: prior.run.runId,
      status: 'done',
      cachedCalls: prior.calls.length,
      liveCalls: 0,
      usage: {
        inputTokens: prior.run.totalInputTokens,
        outputTokens: prior.run.totalOutputTokens,
        cacheHitTokens: prior.run.totalCacheHitTokens,
      },
      result: lastOutput,
    }
  }

  // Phase 2: 全新运行 — 加载脚本（forceReload 时绕过 ESM 缓存）
  const importUrl =
    pathToFileURL(opts.scriptPath).href +
    (opts.forceReload ? '?r=' + Date.now() : '')
  const mod = await import(importUrl)
  const userMeta = mod.meta
  const userRun = mod.run as ((ctx: WorkflowCtx) => Promise<unknown>) | undefined

  if (!userMeta || !userRun) {
    journal.close()
    return {
      runId: '',
      status: 'failed',
      cachedCalls: 0,
      liveCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      error: 'Script must export { meta, run }',
    }
  }

  const runId = makeRunId()
  journal.openRun({
    runId,
    scriptHash,
    argsHash,
    schemaVersion: userMeta.schemaVersion ?? 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheHitTokens: 0,
  })

  // 开跑横幅：Enter 后立刻给反馈，避免长任务"看起来没动静"的错觉
  process.stderr.write(
    `\n▶ running workflow "${userMeta.name ?? 'workflow'}" (budget ${opts.budgetLimit ?? 1_000_000} tok)…\n`,
  )

  // Phase 3: 构建执行环境 — 所有共享实例
  const executor = new AgentExecutor({
    client: opts.client,
    registry: opts.registry,
    defaultModel: opts.model ?? 'deepseek-chat',
    defaultMaxTokens: opts.maxTokens ?? 4096,
    defaultSystem: opts.system ?? 'You are a coding agent.',
  })

  const semaphore = new Semaphore()
  const budget = new BudgetTracker(opts.budgetLimit ?? 1_000_000)
  const logs: string[] = []

  // 状态机
  let seq = 0
  let cachedCalls = 0
  let liveCalls = 0
  let agentCount = 0
  const priorCalls: CallRecord[] = [] // prior 为 null
  let inPrefix = false
  const recordedCalls: CallRecord[] = []

  // 总用量累计
  let totalIn = 0
  let totalOut = 0
  let totalCache = 0

  const wrappedAgent = async (
    prompt: string,
    agentOpts?: any,
  ): Promise<string | Record<string, unknown> | null> => {
    const callHash = hashCanonical({
      prompt,
      opts: agentOpts ?? {},
      model: opts.model ?? 'deepseek-chat',
      sv: 1,
    })

    // Resume: 前缀命中检查
    if (inPrefix && seq < priorCalls.length) {
      const prev = priorCalls[seq]
      if (prev && prev.callHash === callHash && prev.status === 'done') {
        process.stderr.write(`  ⟳ [${seq}] cached\n`)
        seq++
        cachedCalls++
        try {
          const parsed = JSON.parse(prev.result)
          if (typeof parsed === 'object' && parsed != null && 'output' in parsed) {
            return (parsed as any).output
          }
          return prev.result
        } catch {
          return prev.result
        }
      }
      inPrefix = false
    }

    // 硬控 1: agent 计数上限
    if (++agentCount > MAX_AGENTS) {
      throw new Error(`agent count limit (${MAX_AGENTS}) exceeded`)
    }

    // 进度标签：优先用脚本传的 label/phase，否则泛称 agent
    const label = String(agentOpts?.label ?? agentOpts?.phase ?? 'agent')

    // 硬控 2: 信号量获取（排队等待）。
    // seq 在信号量获取之后分配，确保并发场景下 seq 唯一且与执行顺序一致。
    const release = await semaphore.acquire()

    // seq 在 acquire 之后分配（已串行化），保证唯一 + 单调。
    const currentSeq = seq++

    let t0 = 0
    try {
      // 硬控 3: 预算预检（保守估计至少消耗 10 tokens）
      budget.assertHasBudget(10)

      liveCalls++

      // 实时进度：真正开跑时（拿到信号量后）落一行，避免长任务全程静默
      process.stderr.write(`  → [${currentSeq}] ${label} …\n`)
      t0 = Date.now()

      // 用 executor.agent() 拿 AgentResult（含 usage），而非 execute()
      const r = await executor.agent(prompt, agentOpts)
      const text = r.text

      // 回写用量
      totalIn += r.usage.inputTokens
      totalOut += r.usage.outputTokens
      totalCache += r.usage.cacheHitTokens ?? 0

      // 记账：按实际 output tokens charge（+ input tokens 的保守估值）
      budget.charge(r.usage.outputTokens + r.usage.inputTokens)

      process.stderr.write(
        `  ✓ [${currentSeq}] ${label}  (${((Date.now() - t0) / 1000).toFixed(1)}s · ${r.usage.outputTokens} tok)\n`,
      )

      const record: CallRecord = {
        runId,
        seq: currentSeq,
        callHash,
        status: 'done',
        result: JSON.stringify({ output: text }),
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        cacheHitTokens: r.usage.cacheHitTokens ?? 0,
        completedAt: new Date().toISOString(),
      }
      recordedCalls.push(record)
      return text
    } catch (e) {
      const why =
        e instanceof Error && e.name === 'BudgetExhaustedError'
          ? 'budget exhausted'
          : `failed: ${(e as Error).message}`
      process.stderr.write(`  ✗ [${currentSeq}] ${label}  ${why}\n`)
      const record: CallRecord = {
        runId,
        seq: currentSeq, // 复用进入时分配的 seq，避免主键冲突覆盖已成功记录
        callHash,
        status: 'failed',
        result: JSON.stringify({ error: (e as Error).message }),
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        completedAt: new Date().toISOString(),
      }
      recordedCalls.push(record)
      return null
    } finally {
      release()
    }
  }

  const ctx: WorkflowCtx = {
    agent: wrappedAgent,

    parallel: async (thunks) => {
      const results = await Promise.all(thunks.map((t) => t().catch(() => null)))
      return results
    },

    pipeline: async (items, ...stages) => {
      const results = await Promise.all(
        items.map(async (item, index) => {
          let cur: unknown = item
          for (const stage of stages) {
            try {
              cur = await stage(cur, item, index)
            } catch {
              return null
            }
          }
          return cur
        }),
      )
      return results
    },

    phase: (title: string) => {
      const msg = `\n[phase] ${title}`
      process.stderr.write(msg + '\n')
      logs.push(msg)
    },

    log: (msg: string) => {
      process.stderr.write(`  ${msg}\n`)
      logs.push(msg)
    },

    budget,

    workflow: async (nameOrRef: string, wfArgs?: Record<string, unknown>) => {
      // 嵌套 workflow：子脚本共享信号量 + 预算，不暴露 workflow()
      const subUrl =
        pathToFileURL(nameOrRef).href +
        (opts.forceReload ? '?r=' + Date.now() : '')
      const subMod = await import(subUrl)
      const subRun = subMod.run as ((ctx: WorkflowCtx) => Promise<unknown>) | undefined
      if (!subRun) throw new Error(`No run export in ${nameOrRef}`)

      const subCtx: WorkflowCtx = {
        agent: wrappedAgent,
        parallel: ctx.parallel,
        pipeline: ctx.pipeline,
        phase: ctx.phase,
        log: ctx.log,
        budget,
        workflow: async () => {
          throw new Error('workflow() nesting limited to one level')
        },
        args: wfArgs ?? {},
      }
      return await subRun(subCtx)
    },

    args: opts.args,
  }

  // Phase 4: 创建 workspace，可选 vm 沙箱，执行脚本
  let workspace: Workspace | null = null
  try {
    // 创建 workspace（临时目录隔离文件操作）
    workspace = await Workspace.create()
    // 把 workspace root 注回 ctx，供脚本内使用
    ;(ctx as any).workspaceRoot = workspace.root

    let result: unknown
    if (opts.runtime) {
      // 走 vm sandbox 执行（确定性：Date.now/Math.random 被拦截）
      const rt = opts.runtime.createContext(ctx as unknown as Record<string, unknown>)
      result = await rt.run(userRun, ctx)
    } else {
      // 直接宿主执行（默认路径）
      result = await userRun(ctx)
    }

    for (const rc of recordedCalls) {
      journal.recordCall(rc)
    }
    journal.closeRun(runId, 'done')
    journal.close()

    process.stderr.write(
      `[usage] budget=${budget.spent}/${budget.total} live=${liveCalls} cached=${cachedCalls}\n`,
    )

    return {
      runId,
      status: 'done',
      cachedCalls,
      liveCalls,
      usage: { inputTokens: totalIn, outputTokens: totalOut, cacheHitTokens: totalCache },
      result,
    }
  } catch (e) {
    for (const rc of recordedCalls) {
      journal.recordCall(rc)
    }
    journal.closeRun(runId, 'failed')
    journal.close()

    return {
      runId,
      status: 'failed',
      cachedCalls,
      liveCalls,
      usage: { inputTokens: totalIn, outputTokens: totalOut, cacheHitTokens: totalCache },
      error: (e as Error).message,
    }
  } finally {
    if (workspace) {
      await workspace.cleanup().catch(() => {})
    }
  }
}
