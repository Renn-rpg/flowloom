import { describe, it, expect } from 'vitest'
import { createSession, runTurn } from './loop.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ModelClient } from '../model/client.js'
import type { GenerateResult } from '../protocol/types.js'

function scriptedClient(results: GenerateResult[]): ModelClient {
  let i = 0
  return { generate: async () => results[i++] }
}
const r = (over: Partial<GenerateResult>): GenerateResult => ({ text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, ...over })

describe('runTurn', () => {
  it('executes tool calls then returns final text', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, handler: async () => 'FILE_DATA' })
    const client = scriptedClient([
      r({ toolCalls: [{ id: 'c1', name: 'read_file', input: { path: '/a' } }], stopReason: 'tool_use' }),
      r({ text: 'the file says FILE_DATA' }),
    ])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'deepseek-chat', maxTokens: 1000 })
    expect(await runTurn(s, 'read /a')).toBe('the file says FILE_DATA')
  })

  it('keeps conversation context across turns', async () => {
    const reg = new ToolRegistry()
    const client = scriptedClient([r({ text: 'turn1' }), r({ text: 'turn2' })])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'deepseek-chat', maxTokens: 1000 })
    await runTurn(s, 'hello')
    await runTurn(s, 'again')
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(s.messages[0].text).toBe('hello')
    expect(s.messages[2].text).toBe('again')
  })
})
