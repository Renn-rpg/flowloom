import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { InternalMessage } from '../protocol/types.js'

export interface AgentSession {
  client: ModelClient
  registry: ToolRegistry
  system: string
  model: string
  maxTokens: number
  maxIters: number
  messages: InternalMessage[]
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }
}

export interface RunTurnCallbacks {
  onText?: (delta: string) => void
  onThinking?: () => void
  onThinkingDone?: (ms: number) => void
  onToolCall?: (name: string, input: Record<string, unknown>) => void
  onToolResult?: (name: string, ms: number, isError: boolean) => void
}

export function createSession(o: {
  client: ModelClient
  registry: ToolRegistry
  system: string
  model: string
  maxTokens: number
  maxIters?: number
}): AgentSession {
  return {
    client: o.client,
    registry: o.registry,
    system: o.system,
    model: o.model,
    maxTokens: o.maxTokens,
    maxIters: o.maxIters ?? 25,
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

    const t0 = Date.now()
    const res = await s.client.generate(
      {
        system: s.system,
        messages: s.messages,
        tools: s.registry.specs(),
        model: s.model,
        maxTokens: s.maxTokens,
      },
      { onText: callbacks.onText },
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
      toolCalls: res.toolCalls,
    })
    for (const call of res.toolCalls) {
      callbacks.onToolCall?.(call.name, call.input)
      const toolT0 = Date.now()
      const output = await s.registry.run(call.name, call.input)
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
