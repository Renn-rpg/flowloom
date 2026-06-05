// dispatch_agents 工具：一次扇出 N 个**并发**子 agent，各跑一个独立子任务。
//
// 与 dispatch_agent（单个、串行）的关键区别：这是对话内的「真并行」原语——把若干互不依赖的
// 子任务用 Promise.all 同时跑，并发度由信号量封顶（复用 workflow/concurrency.ts）。
// DeepSeek 不发并行 tool_call，所以并行只能由工具内部驱动，而非靠模型一次发多个 call。
//
// 模型无关：只依赖 ModelClient 接口 + loop（createSession/runTurn）+ ToolRegistry/Tool，
// **绝不 import openai/DeepSeek**。具体 client/registry/system/gate 由 cli.ts 注入。

import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import { createSession, runTurn, type ToolGate } from './loop.js'
import { Semaphore, defaultConcurrency } from '../workflow/concurrency.js'

// 扇出生命周期事件（cli 据 index 把每个子 agent 映射成 tracker 的一行）。
export type FanOutEvent =
  | { kind: 'start'; index: number; label: string; model: string }
  | { kind: 'tool'; index: number; name: string }
  | { kind: 'done'; index: number; tokens: number; tools: number; ms: number; isError: boolean; error?: string }

export interface DispatchManyDeps {
  client: ModelClient
  // 每个子 agent 一份独立工具集（**不含 dispatch_agent/dispatch_agents**，递归隔离）。
  buildRegistry: () => ToolRegistry
  system: string
  model: string
  maxTokens: number
  maxIters?: number
  contextTokens?: number
  gate?: ToolGate
  // 并发上限，默认 max(1, min(16, 核数-2))。
  concurrency?: number
  // 扇出开始：传入按提交顺序的标签数组，cli 据此一次性建好 tracker 行（避免并发乱序）。
  onStart?: (labels: string[]) => void
  // 扇出结束（成功/失败均触发，finally 保证）。
  onEnd?: () => void
  onActivity?: (e: FanOutEvent) => void
  // 子 agent token 用量回写父级累计（成本可视）。并发触发 → 必须是累加式。
  onUsage?: (u: { inputTokens: number; outputTokens: number; cacheHitTokens: number }) => void
  // 暂停闸（drill-in 的 p pause）：isPaused()=true 时暂缓「启动新 agent」——已在跑的跑完，
  // 占用的并发额度先归还，待 waitForResume() resolve 后再重新 acquire。缺省 = 不暂停。
  isPaused?: () => boolean
  waitForResume?: () => Promise<void>
  // 中断信号（drill-in 的 x stop）：扇出开始时解析一次，贯穿到每个子 agent 的 runTurn。
  // 用 getter 而非定值——信号在每次扇出开始时新建（registration 期还不存在）。
  getSignal?: () => AbortSignal | undefined
}

// 每个子任务回喂主 agent 的文本上限。比单 dispatch_agent（50k）小——并发场景有 N 份，
// 总量需受控，避免一次扇出就把主上下文撑爆。
const MAX_OUT = 16_000

interface TaskInput {
  description: string
  prompt: string
}

function parseTasks(input: Record<string, unknown>): TaskInput[] {
  const raw = Array.isArray(input.tasks) ? input.tasks : []
  return raw
    .map((t) => {
      const obj = (t ?? {}) as Record<string, unknown>
      return {
        description: typeof obj.description === 'string' ? obj.description.trim() : '',
        prompt: typeof obj.prompt === 'string' ? obj.prompt.trim() : '',
      }
    })
    .filter((t) => t.prompt)
}

export function makeDispatchAgentsTool(deps: DispatchManyDeps): Tool {
  return {
    spec: {
      name: 'dispatch_agents',
      description:
        'Launch MULTIPLE sub-agents that run CONCURRENTLY, each on its own focused, self-contained sub-task. ' +
        'Use this whenever you have several INDEPENDENT subtasks that can proceed in parallel (e.g. explore N modules at once, audit N files, research N topics). ' +
        'Each sub-agent has its own fresh context and the same file/search/shell tools, but CANNOT dispatch further sub-agents, and does NOT see this conversation — pass each a COMPLETE, standalone task description. ' +
        'They execute in parallel (capped by a concurrency limit) and each returns only its final report. ' +
        'STRONGLY prefer this over calling dispatch_agent many times in sequence — it is dramatically faster for independent work.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'The independent sub-tasks to run in parallel (2 or more).',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'A short 3-5 word label for the sub-task' },
                prompt: {
                  type: 'string',
                  description: 'The complete, self-contained task for this sub-agent (it cannot see this conversation)',
                },
              },
              required: ['prompt'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    handler: async (input) => {
      const tasks = parseTasks(input)
      if (tasks.length === 0) {
        return 'ERROR: dispatch_agents requires a non-empty "tasks" array, each item with a "prompt" string'
      }

      const labels = tasks.map((t, i) => t.description || `task ${i + 1}`)
      deps.onStart?.(labels)
      const signal = deps.getSignal?.()

      const sem = new Semaphore(deps.concurrency ?? defaultConcurrency())
      const results: { index: number; label: string; text: string; isError: boolean }[] = []

      try {
      await Promise.all(
        tasks.map(async (task, index) => {
          const label = labels[index]
          // acquire 一个并发额度；若此刻处于暂停态，归还额度并等恢复后再抢（不阻塞在跑的 agent）。
          // 注意：恢复后的重抢顺序不保证严格 FIFO——对相互独立的并行子任务，恢复次序无所谓。
          let release = await sem.acquire()
          while (deps.isPaused?.() && !signal?.aborted) {
            release()
            await (deps.waitForResume?.() ?? Promise.resolve())
            release = await sem.acquire()
          }
          const t0 = Date.now()
          let tools = 0
          // 子 agent 用独立 session（全新 messages / usage / 工具集），互不串扰。
          const sub = createSession({
            client: deps.client,
            registry: deps.buildRegistry(),
            system: deps.system,
            model: deps.model,
            maxTokens: deps.maxTokens,
            maxIters: deps.maxIters,
            contextTokens: deps.contextTokens,
            gate: deps.gate,
          })
          deps.onActivity?.({ kind: 'start', index, label, model: deps.model })
          try {
            const out = await runTurn(
              sub,
              task.prompt,
              { onToolCall: (name) => { tools++; deps.onActivity?.({ kind: 'tool', index, name }) } },
              { signal },
            )
            deps.onUsage?.(sub.usage)
            // runTurn 耗尽迭代上限返回 "stopped:" 哨兵 → 视为未完成（与 dispatch_agent 一致）。
            const isStopped = out.startsWith('stopped:')
            deps.onActivity?.({ kind: 'done', index, tokens: sub.usage.outputTokens, tools, ms: Date.now() - t0, isError: isStopped })
            const body = isStopped
              ? `ERROR: sub-agent did not finish — ${out}`
              : out.trim() || '(sub-agent returned no text)'
            results.push({
              index,
              label,
              text: body.length > MAX_OUT ? body.slice(0, MAX_OUT) + '\n…(truncated)' : body,
              isError: isStopped,
            })
          } catch (e) {
            deps.onUsage?.(sub.usage)
            const msg = (e as Error).message
            deps.onActivity?.({ kind: 'done', index, tokens: sub.usage.outputTokens, tools, ms: Date.now() - t0, isError: true, error: msg })
            results.push({ index, label, text: `ERROR: sub-agent failed: ${msg}`, isError: true })
          } finally {
            release()
          }
        }),
      )
      } finally {
        deps.onEnd?.()
      }

      // 聚合：按提交顺序编号汇总（并发完成顺序不定，按 index 排序保证稳定输出）。
      results.sort((a, b) => a.index - b.index)
      const ok = results.filter((r) => !r.isError).length
      const header = `Dispatched ${tasks.length} parallel sub-agent(s) — ${ok} succeeded, ${tasks.length - ok} failed.\n`
      return (
        header +
        results
          .map((r) => `\n## [${r.index + 1}] ${r.label}${r.isError ? ' (failed)' : ''}\n${r.text}`)
          .join('\n')
      )
    },
  }
}
