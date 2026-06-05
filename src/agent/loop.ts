import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { InternalMessage } from '../protocol/types.js'
import { trimMessages, estimateTokens } from './context.js'
import { compactMessages } from './compaction.js'
import { makeAbortError } from '../utils/abort-error.js'

// 工具执行闸：返回是否放行 + 拒绝说明。模型/UI 无关——hooks 评估与"ask"交互都在 cli 里实现，
// loop 只看一个布尔结果。缺省（undefined）= 一律放行。
export type ToolGate = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ allow: boolean; message?: string }>

export interface AgentSession {
  client: ModelClient
  registry: ToolRegistry
  system: string
  model: string
  maxTokens: number
  maxIters: number
  // 可选的工具执行闸（hooks）。缺省放行，保持原行为。
  gate?: ToolGate
  // 自我保护用的上下文 token 预算（估算）。<=0 或缺省 = 关闭，不做任何窗口假设。
  contextTokens: number
  // 超预算时是否优先「语义压缩」（摘要最旧的轮）而非「整轮丢弃」。默认开；仅在 contextTokens>0 时才会触发。
  autoCompact: boolean
  messages: InternalMessage[]
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }
}

export interface RunTurnCallbacks {
  onText?: (delta: string) => void
  // 思考链增量（推理/thinking 模型流式时逐块回吐；普通模型不触发）
  onReasoning?: (delta: string) => void
  onThinking?: () => void
  onThinkingDone?: (ms: number) => void
  onToolCall?: (name: string, input: Record<string, unknown>) => void
  onToolResult?: (name: string, ms: number, isError: boolean) => void
  // 发起下一次 generate 前的闸：UI 据此在「全屏钻入视图打开」时挂起模型继续输出，
  // 避免流式文本写进 alt-screen 缓冲后被吞。缺省不阻塞。
  beforeGenerate?: () => void | Promise<void>
  // 发请求前丢弃了过旧历史时触发（非静默：调用方应提示用户）
  onContextTrim?: (info: {
    droppedRounds: number
    droppedMessages: number
    estimatedTokens: number
    overBudget: boolean
  }) => void
  // 发请求前对过旧历史做了「语义压缩」（摘要折叠进 system）时触发，供调用方提示用户。
  onContextCompact?: (info: {
    summarizedRounds: number
    estimatedTokens: number
    summaryChars: number
  }) => void
}

export function createSession(o: {
  client: ModelClient
  registry: ToolRegistry
  system: string
  model: string
  maxTokens: number
  maxIters?: number
  contextTokens?: number
  autoCompact?: boolean
  gate?: ToolGate
}): AgentSession {
  return {
    client: o.client,
    registry: o.registry,
    system: o.system,
    model: o.model,
    maxTokens: o.maxTokens,
    maxIters: o.maxIters ?? 25,
    contextTokens: o.contextTokens ?? 0,
    autoCompact: o.autoCompact ?? true,
    gate: o.gate,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
  }
}

export async function runTurn(
  s: AgentSession,
  userText: string,
  cbs?: RunTurnCallbacks | ((d: string) => void),
  opts?: { signal?: AbortSignal },
): Promise<string> {
  // 向后兼容：如果第三个参数是函数，视为 onText
  const callbacks: RunTurnCallbacks =
    typeof cbs === 'function' ? { onText: cbs } : (cbs ?? {})

  s.messages.push({ role: 'user', text: userText })
  for (let iter = 0; iter < s.maxIters; iter++) {
    // 用户中断(如 ESC):在每轮迭代起点(工具执行后/下一次 generate 前)尽早退出。
    if (opts?.signal?.aborted) throw makeAbortError('turn aborted by user')
    // UI 闸:钻入视图(alt-screen)打开期间挂起,等关闭后再 generate,防止流式文本写进 alt 缓冲被吞。
    if (callbacks.beforeGenerate) {
      await callbacks.beforeGenerate()
      if (opts?.signal?.aborted) throw makeAbortError('turn aborted by user')
    }
    callbacks.onThinking?.()

    // 保存快照：若 generate 异常，恢复消息数组以避免工具结果孤儿
    const snapshotLen = s.messages.length

    // 缓存 specs 避免同一次迭代中重复创建数组
    const tools = s.registry.specs()

    // 上下文上限保护：发请求前若估算 token 超预算。优先「语义压缩」——把最旧的对话轮摘要成
    // 一段「早前对话摘要」折叠进 system，保留要点;摘要失败或无可压缩的旧轮时回退到「整轮丢弃」。
    // 当前轮（最新 user 及其后续）始终保留，故多轮工具调用中不会丢掉进行中的上下文。
    if (s.contextTokens > 0) {
      if (estimateTokens(s.system, s.messages, tools) > s.contextTokens) {
        let compacted = false
        if (s.autoCompact) {
          try {
            // 静默摘要（不传 onText/onReasoning），经 ModelClient 接口——agent 层不感知具体模型。
            const c = await compactMessages({
              client: s.client,
              system: s.system,
              messages: s.messages,
              tools,
              model: s.model,
              budget: s.contextTokens,
              maxTokens: s.maxTokens,
            })
            if (c) {
              s.system = c.system
              s.messages = c.messages
              compacted = true
              callbacks.onContextCompact?.({
                summarizedRounds: c.summarizedRounds,
                estimatedTokens: c.estimatedTokens,
                summaryChars: c.summary.length,
              })
              // 二次保险：摘要本身也占 token，折叠进 system 后体量会变大。若（含新 system）仍超预算
              // ——摘要偏大或保留轮本身很大——再叠加一次「整轮丢弃」把超出部分清掉，保证发请求前确实尽力落入预算。
              if (c.estimatedTokens > s.contextTokens) {
                const after = trimMessages(s.system, s.messages, tools, s.contextTokens)
                if (after.droppedMessages > 0) {
                  s.messages = after.messages
                  callbacks.onContextTrim?.({
                    droppedRounds: after.droppedRounds,
                    droppedMessages: after.droppedMessages,
                    estimatedTokens: after.estimatedTokens,
                    overBudget: after.overBudget,
                  })
                }
              }
            }
          } catch {
            // 摘要调用失败（网络/超时等）→ 回退整轮丢弃，绝不打断本轮。
          }
        }
        if (!compacted) {
          const trim = trimMessages(s.system, s.messages, tools, s.contextTokens)
          if (trim.droppedMessages > 0) {
            s.messages = trim.messages
            callbacks.onContextTrim?.({
              droppedRounds: trim.droppedRounds,
              droppedMessages: trim.droppedMessages,
              estimatedTokens: trim.estimatedTokens,
              overBudget: trim.overBudget,
            })
          }
        }
      }
    }

    const t0 = Date.now()
    let res
    try {
      res = await s.client.generate(
        {
          system: s.system,
          messages: s.messages,
          tools, // 复用缓存的 specs()
          model: s.model,
          maxTokens: s.maxTokens,
        },
        { onText: callbacks.onText, onReasoning: callbacks.onReasoning, signal: opts?.signal },
      )
    } catch (e) {
      // generate 异常时恢复消息数组到本轮开始前，避免工具结果孤儿导致后续 API 400
      s.messages = s.messages.slice(0, snapshotLen)
      throw e
    }
    callbacks.onThinkingDone?.(Date.now() - t0)
    // generate 返回后立即检查中断：避免把已中断的响应消息推入会话
    if (opts?.signal?.aborted) throw makeAbortError('turn aborted by user')

    s.usage.inputTokens += res.usage.inputTokens
    s.usage.outputTokens += res.usage.outputTokens
    s.usage.cacheHitTokens += res.usage.cacheHitTokens ?? 0
    if (res.stopReason !== 'tool_use' || res.toolCalls.length === 0) {
      s.messages.push({ role: 'assistant', text: res.text })
      return res.text
    }
    s.messages.push({
      role: 'assistant',
      text: res.text,
      // R8：工具轮保留 reasoningText，to-openai 会把它回传（thinking 模型不回传会 400）。
      // 普通模型 res.reasoningText 为 undefined，不影响原行为。终态 assistant（上面 return 分支）
      // 不保留 reasoningText，符合 R7「非工具轮下一轮须剥掉思考链」。
      reasoningText: res.reasoningText,
      toolCalls: res.toolCalls,
    })
    // 工具执行前保存消息栈快照，中断时回滚以清理孤立工具结果
    const preToolsLen = s.messages.length
    for (const call of res.toolCalls) {
      if (opts?.signal?.aborted) {
        // 回滚：移除本轮的 assistant + 已执行的工具结果
        s.messages.length = preToolsLen
        throw makeAbortError('turn aborted by user')
      }
      callbacks.onToolCall?.(call.name, call.input)
      const toolT0 = Date.now()
      // PreToolUse 闸（hooks）：被拦则不执行工具。使用 DENIED: 前缀区分于真正的工具执行错误，
      // 让模型明确知晓这是人类/策略拒绝，而非工具执行失败。
      const decision = s.gate ? await s.gate(call.name, call.input) : { allow: true }
      const output = decision.allow
        ? await s.registry.run(call.name, call.input)
        : `DENIED: blocked by hook${decision.message ? ': ' + decision.message : ''}`
      const toolMs = Date.now() - toolT0
      const isError = output.startsWith('ERROR') || output.startsWith('DENIED')
      callbacks.onToolResult?.(call.name, toolMs, isError)
      s.messages.push({
        role: 'tool',
        toolResults: [
          { toolCallId: call.id, content: output, isError },
        ],
      })
    }
  }
  const usage = s.usage
  return `stopped: reached max iterations (${s.maxIters} turns) — ${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cacheHitTokens} cache hit tokens. Consider simplifying the task or increasing maxIters.`
}
