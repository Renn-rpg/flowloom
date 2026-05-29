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

export class StreamAccumulator {
  private textBuf = ''
  private calls = new Map<number, { id: string; name: string; args: string }>()
  private finish = ''
  private usage = { inputTokens: 0, outputTokens: 0 }

  // 返回本 chunk 的文本增量（供实时输出）
  addChunk(chunk: any): string {
    if (chunk?.usage) this.usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 }
    const choice = chunk?.choices?.[0]
    if (!choice) return ''
    if (choice.finish_reason) this.finish = choice.finish_reason
    const delta = choice.delta ?? {}
    for (const tc of delta.tool_calls ?? []) {
      const idx: number = tc.index ?? 0
      const cur = this.calls.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name = tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments // 增量累积，最后再 parse
      this.calls.set(idx, cur)
    }
    const textDelta = typeof delta.content === 'string' ? delta.content : ''
    this.textBuf += textDelta
    return textDelta
  }

  result(): GenerateResult {
    const toolCalls: ToolCall[] = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, input: safeParseArgs(c.args || '{}') }))
    return { text: this.textBuf, toolCalls, stopReason: mapStop(this.finish), usage: this.usage }
  }
}
