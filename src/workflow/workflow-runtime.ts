import { pathToFileURL } from 'node:url'
import type { WorkflowRunOptions, WorkflowRunResult, WorkflowCtx, CallRecord } from './types.js'
import { AgentExecutor } from './agent-executor.js'
import { SqliteJournal } from './journal.js'
import { hashCanonical } from './hash.js'

function makeRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 8)
  return `run-${ts}-${rand}`
}

export async function executeWorkflow(
  opts: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  const scriptHash = hashCanonical({ path: opts.scriptPath })
  const argsHash = hashCanonical(opts.args)

  const journal = new SqliteJournal(opts.journalPath ?? ':memory:')

  // Phase 1: 检查是否有已完成的前缀（完全命中快速路径）
  const prior = journal.lookupPrefix(scriptHash, argsHash, 1)
  if (prior) {
    // 存在 status='done' 的先前 run → 提取最后一个 agent 调用的结果作为返回值
    let lastOutput: unknown = undefined
    if (prior.calls.length > 0) {
      const lastCall = prior.calls[prior.calls.length - 1]
      try {
        const parsed = JSON.parse(lastCall.result)
        lastOutput = parsed?.output
      } catch {
        // ignore
      }
    }
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

  // Phase 2: 全新运行 — 动态加载脚本（加时间戳绕过 ESM 缓存）
  const scriptUrl = pathToFileURL(opts.scriptPath).href + '?t=' + Date.now()
  const mod = await import(scriptUrl)
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

  // Phase 3: 构建 AgentExecutor
  const executor = new AgentExecutor({
    client: opts.client,
    registry: opts.registry,
    defaultModel: opts.model ?? 'deepseek-chat',
    defaultMaxTokens: opts.maxTokens ?? 4096,
    defaultSystem: opts.system ?? 'You are a coding agent.',
  })

  // 日志缓冲区（phase / log）
  const logs: string[] = []

  // 预算追踪器（3a advisory）
  const budget = {
    total: opts.budgetLimit ?? 1_000_000,
    spent: 0,
    remaining(): number {
      return Math.max(0, this.total - this.spent)
    },
    charge(n: number): void {
      this.spent += n
    },
  }

  // Resume 状态机：前缀比对
  let seq = 0
  let cachedCalls = 0
  let liveCalls = 0
  const priorCalls = prior?.calls ?? []
  let inPrefix = priorCalls.length > 0

  // 记录当前这次 run 的 agent 调用结果（最终落盘用）
  const recordedCalls: CallRecord[] = []

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
        seq++
        cachedCalls++
        try {
          const parsed = JSON.parse(prev.result)
          if (
            typeof parsed === 'object' &&
            parsed != null &&
            'output' in parsed
          ) {
            return (parsed as any).output
          }
          return prev.result
        } catch {
          return prev.result
        }
      }
      // 第一个不匹配或失败的调用 → 退出前缀模式，该调用及其后全部 live
      inPrefix = false
    }

    liveCalls++
    const currentSeq = seq++
    try {
      const text = await executor.execute(prompt, agentOpts)
      const record: CallRecord = {
        runId,
        seq: currentSeq,
        callHash,
        status: 'done',
        result: JSON.stringify({ output: text }),
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        completedAt: new Date().toISOString(),
      }
      recordedCalls.push(record)
      return text
    } catch {
      const record: CallRecord = {
        runId,
        seq: currentSeq,
        callHash,
        status: 'failed',
        result: JSON.stringify({ error: 'agent call failed' }),
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        completedAt: new Date().toISOString(),
      }
      recordedCalls.push(record)
      return null
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
      logs.push(`[phase] ${title}`)
    },
    log: (msg: string) => {
      logs.push(msg)
    },
    budget,
    workflow: async () => {
      throw new Error('nested workflow not yet implemented (3b)')
    },
    args: opts.args,
  }

  // Phase 4: 在宿主上下文中执行 run(ctx)（vm 沙箱延至 3b）
  try {
    const result = await userRun(ctx)

    // 落盘所有 recordCall
    for (const rc of recordedCalls) {
      journal.recordCall(rc)
    }
    journal.closeRun(runId, 'done')
    journal.close()

    return {
      runId,
      status: 'done',
      cachedCalls,
      liveCalls,
      usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      result,
    }
  } catch (e) {
    // 失败调用也要落盘（供 resume 时知道哪些 seq 应该重跑）
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
      usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      error: (e as Error).message,
    }
  }
}
