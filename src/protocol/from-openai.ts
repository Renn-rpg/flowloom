import type { GenerateResult, StopReason, ToolCall } from './types.js'
import { safeParseArgs } from './safe-json.js'

function mapStop(reason: string): StopReason {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'content_filter': return 'max_tokens' // 内容过滤，模型被截断
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
    usage: { inputTokens: resp.usage?.prompt_tokens ?? 0, outputTokens: resp.usage?.completion_tokens ?? 0, cacheHitTokens: resp.usage?.prompt_cache_hit_tokens ?? resp.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
    reasoningText: msg.reasoning_content || undefined, // 推理模型才有；与 content 同级的独立字段
  }
}

export class StreamAccumulator {
  private textBuf = ''
  private reasoningBuf = ''
  private calls = new Map<number, { id: string; name: string; args: string }>()
  private finish = ''
  private usage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 }

  // 返回本 chunk 的文本增量与思考链增量（供实时输出）。
  // reasoning_content 与 content 同级、互斥成块：推理模型先吐 CoT 再吐答案。
  addChunk(chunk: any): { text: string; reasoning: string } {
    if (chunk?.usage) this.usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0, cacheHitTokens: chunk.usage.prompt_cache_hit_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 }
    const choice = chunk?.choices?.[0]
    if (!choice) return { text: '', reasoning: '' }
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
    const reasoningDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
    this.textBuf += textDelta
    this.reasoningBuf += reasoningDelta
    return { text: textDelta, reasoning: reasoningDelta }
  }

  result(): GenerateResult {
    const toolCalls: ToolCall[] = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, input: safeParseArgs(c.args || '{}') }))
    return {
      text: this.textBuf,
      toolCalls,
      stopReason: mapStop(this.finish),
      usage: this.usage,
      reasoningText: this.reasoningBuf || undefined,
    }
  }
}
