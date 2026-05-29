import { describe, it, expect } from 'vitest'
import { runAgentTurn } from './loop.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ModelClient } from '../model/client.js'
import type { GenerateResult } from '../protocol/types.js'

describe('runAgentTurn', () => {
  it('executes tool calls then returns final text', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, handler: async () => 'FILE_DATA' })
    const scripted: GenerateResult[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: '/a' } }], stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
      { text: 'the file says FILE_DATA', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ]
    let i = 0
    const client: ModelClient = { generate: async () => scripted[i++] }
    const out = await runAgentTurn({ client, registry: reg, system: 'sys', userText: 'read /a', model: 'deepseek-chat', maxTokens: 1000 })
    expect(out).toBe('the file says FILE_DATA')
  })
})
