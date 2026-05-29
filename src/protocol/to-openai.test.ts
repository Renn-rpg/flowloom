import { describe, it, expect } from 'vitest'
import { toOpenAIRequest } from './to-openai.js'
import type { GenerateRequest } from './types.js'

const req: GenerateRequest = {
  system: 'You are a coding agent',
  messages: [{ role: 'user', text: 'hi' }],
  tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  model: 'deepseek-chat',
  maxTokens: 4096,
}

describe('toOpenAIRequest', () => {
  it('moves system to messages[0]', () => {
    const out = toOpenAIRequest(req)
    expect(out.messages[0]).toEqual({ role: 'system', content: 'You are a coding agent' })
  })
  it('wraps tools as type:function with parameters', () => {
    const out = toOpenAIRequest(req)
    expect(out.tools![0]).toEqual({
      type: 'function',
      function: { name: 'read_file', description: 'read', parameters: req.tools[0].inputSchema },
    })
  })
  it('never sets top_k and always sets max_tokens', () => {
    const out = toOpenAIRequest(req) as Record<string, unknown>
    expect(out).not.toHaveProperty('top_k')
    expect(out.max_tokens).toBe(4096)
  })
  it('serializes assistant tool_calls arguments to string', () => {
    const out = toOpenAIRequest({
      ...req,
      messages: [{ role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: '/a.ts' } }] }],
    })
    const m = out.messages.find((x) => x.role === 'assistant')!
    expect(m.tool_calls![0].function.arguments).toBe('{"path":"/a.ts"}')
  })
  it('maps tool result to role:tool with tool_call_id', () => {
    const out = toOpenAIRequest({
      ...req,
      messages: [{ role: 'tool', toolResults: [{ toolCallId: 'c1', content: 'data', isError: false }] }],
    })
    expect(out.messages.find((x) => x.role === 'tool')).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'data' })
  })
})
