import { describe, it, expect } from 'vitest'
import { fromOpenAIResponse, StreamAccumulator } from './from-openai.js'

describe('fromOpenAIResponse', () => {
  it('maps tool_calls finish_reason to tool_use and parses arguments', () => {
    const resp = {
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a.ts"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }
    const r = fromOpenAIResponse(resp)
    expect(r.stopReason).toBe('tool_use')
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: '/a.ts' } }])
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 })
  })
  it('maps stop to end_turn and extracts text', () => {
    const resp = { choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    const r = fromOpenAIResponse(resp)
    expect(r.stopReason).toBe('end_turn')
    expect(r.text).toBe('done')
    expect(r.toolCalls).toEqual([])
  })
  it('repairs malformed tool arguments via safeParseArgs', () => {
    const resp = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{"a":1' } }] } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }
    const r = fromOpenAIResponse(resp)
    expect(r.toolCalls[0].input).toEqual({ a: 1 })
  })

  it('reads cache hit tokens when present', () => {
    const resp = { choices: [{ finish_reason: 'stop', message: { content: 'x' } }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 } }
    expect(fromOpenAIResponse(resp).usage.cacheHitTokens).toBe(8)
  })
})

describe('StreamAccumulator', () => {
  it('accumulates text deltas and tool_calls across chunks', () => {
    const acc = new StreamAccumulator()
    const seen: string[] = []
    seen.push(acc.addChunk({ choices: [{ delta: { content: 'Hel' } }] }))
    seen.push(acc.addChunk({ choices: [{ delta: { content: 'lo' } }] }))
    acc.addChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] })
    acc.addChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a"}' } }] }, finish_reason: 'tool_calls' }] })
    const r = acc.result()
    expect(seen.join('')).toBe('Hello')
    expect(r.text).toBe('Hello')
    expect(r.stopReason).toBe('tool_use')
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'read_file', input: { path: '/a' } }])
  })
})
