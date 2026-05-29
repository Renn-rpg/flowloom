import type { GenerateResult, StopReason, ToolCall } from './types.js'
import { safeParseArgs } from './safe-json.js'

function mapStop(reason: string): StopReason {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    default: return 'unknown'
  }
}

export function fromOpenAIResponse(resp: any): GenerateResult {
  const choice = resp.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
    id: c.id,
    name: c.function?.name ?? '',
    input: safeParseArgs(c.function?.arguments ?? '{}'),
  }))
  return {
    text: msg.content ?? '',
    toolCalls,
    stopReason: mapStop(choice.finish_reason ?? ''),
    usage: { inputTokens: resp.usage?.prompt_tokens ?? 0, outputTokens: resp.usage?.completion_tokens ?? 0 },
  }
}
