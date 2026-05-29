import { describe, it, expect } from 'vitest'
import { fromOpenAIResponse } from './from-openai.js'

describe('fromOpenAIResponse', () => {
  it('maps tool_calls finish_reason to tool_use and parses arguments', () => {
    const resp = {
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a.ts"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }
    const r = fromOpenAIResponse(resp)
    expect(r.stopReason).toBe('tool_use')
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: '/a.ts' } }])
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
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
})
