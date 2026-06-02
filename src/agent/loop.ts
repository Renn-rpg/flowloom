import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { InternalMessage } from '../protocol/types.js'
import { trimMessages } from './context.js'

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
  // 发请求前丢弃了过旧历史时触发（非静默：调用方应提示用户）
  onContextTrim?: (info: {
    droppedRounds: number
    droppedMessages: number
    estimatedTokens: number
    overBudget: boolean
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
    gate: o.gate,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
  }
}

export async function runTurn(
  s: AgentSession,
  userText: string,
  cbs?: RunTurnCallbacks | ((d: string) => void),
): Promise<string> {
  // 向后兼容：如果第三个参数是函数，视为 onText
  const callbacks: RunTurnCallbacks =
    typeof cbs === 'function' ? { onText: cbs } : (cbs ?? {})

  s.messages.push({ role: 'user', text: userText })
  for (let iter = 0; iter < s.maxIters; iter++) {
    callbacks.onThinking?.()

    // 上下文上限保护：发请求前若估算 token 超预算，从最旧对话轮整轮丢弃。
    // 当前轮（最新 user 及其后续）始终保留，故多轮工具调用中不会丢掉进行中的上下文。
    if (s.contextTokens > 0) {
      const trim = trimMessages(s.system, s.messages, s.registry.specs(), s.contextTokens)
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

    const t0 = Date.now()
    const res = await s.client.generate(
      {
        system: s.system,
        messages: s.messages,
        tools: s.registry.specs(),
        model: s.model,
        maxTokens: s.maxTokens,
      },
      { onText: callbacks.onText, onReasoning: callbacks.onReasoning },
    )
    callbacks.onThinkingDone?.(Date.now() - t0)

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
    for (const call of res.toolCalls) {
      callbacks.onToolCall?.(call.name, call.input)
      const toolT0 = Date.now()
      // PreToolUse 闸（hooks）：被拦则不执行工具，把原因当作 tool error 回喂模型，
      // 模型据此知晓被拦并自行调整，而非静默失败。
      const decision = s.gate ? await s.gate(call.name, call.input) : { allow: true }
      const output = decision.allow
        ? await s.registry.run(call.name, call.input)
        : `ERROR: blocked by hook${decision.message ? ': ' + decision.message : ''}`
      const toolMs = Date.now() - toolT0
      const isError = output.startsWith('ERROR')
      callbacks.onToolResult?.(call.name, toolMs, isError)
      s.messages.push({
        role: 'tool',
        toolResults: [
          { toolCallId: call.id, content: output, isError },
        ],
      })
    }
  }
  return 'stopped: reached max iterations'
}
