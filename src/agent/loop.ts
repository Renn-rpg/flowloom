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

export function createSession(o: {
  client: ModelClient; registry: ToolRegistry; system: string; model: string; maxTokens: number; maxIters?: number
}): AgentSession {
  return { client: o.client, registry: o.registry, system: o.system, model: o.model, maxTokens: o.maxTokens, maxIters: o.maxIters ?? 25, messages: [], usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 } }
}

export async function runTurn(s: AgentSession, userText: string, onText?: (d: string) => void): Promise<string> {
  s.messages.push({ role: 'user', text: userText })
  for (let iter = 0; iter < s.maxIters; iter++) {
    const res = await s.client.generate(
      { system: s.system, messages: s.messages, tools: s.registry.specs(), model: s.model, maxTokens: s.maxTokens },
      { onText },
    )
    s.usage.inputTokens += res.usage.inputTokens
    s.usage.outputTokens += res.usage.outputTokens
    s.usage.cacheHitTokens += res.usage.cacheHitTokens ?? 0
    if (res.stopReason !== 'tool_use' || res.toolCalls.length === 0) {
      s.messages.push({ role: 'assistant', text: res.text })
      return res.text
    }
    s.messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls })
    for (const call of res.toolCalls) {
      const output = await s.registry.run(call.name, call.input)
      s.messages.push({ role: 'tool', toolResults: [{ toolCallId: call.id, content: output, isError: output.startsWith('ERROR') }] })
    }
  }
  return 'stopped: reached max iterations'
}
