import { describe, it, expect, vi } from 'vitest'
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

  it('backward compatible: accepts function as third arg (onText)', async () => {
    const client = scriptedClient([r({ text: 'ok' })])
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const texts: string[] = []
    expect(await runTurn(s, 'hi', (d) => texts.push(d))).toBe('ok')
  })

  it('fires onThinking and onThinkingDone callbacks', async () => {
    const client = scriptedClient([r({ text: 'ok' })])
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const thinking: string[] = []
    const done: number[] = []
    await runTurn(s, 'hi', {
      onThinking: () => thinking.push('start'),
      onThinkingDone: (ms) => done.push(ms),
    })
    expect(thinking).toEqual(['start'])
    expect(done.length).toBe(1)
    expect(done[0]).toBeGreaterThanOrEqual(0)
  })

  it('fires onToolCall and onToolResult for tool use', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'grep', description: '', inputSchema: { type: 'object', properties: {} } }, handler: async () => 'found' })
    const client = scriptedClient([
      r({ toolCalls: [{ id: 'c1', name: 'grep', input: { pattern: 'TODO' } }], stopReason: 'tool_use' }),
      r({ text: 'done' }),
    ])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100 })
    const calls: string[] = []
    const results: string[] = []
    await runTurn(s, 'grep TODO', {
      onToolCall: (name) => calls.push(name),
      onToolResult: (name, ms, isError) => results.push(`${name}:${ms}:${isError}`),
    })
    expect(calls).toEqual(['grep'])
    expect(results.length).toBe(1)
    expect(results[0]).toMatch(/^grep:\d+:false$/)
  })

  it('does not fire onToolCall for text-only responses', async () => {
    const client = scriptedClient([r({ text: 'just text' })])
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const calls: string[] = []
    await runTurn(s, 'hi', { onToolCall: () => calls.push('x') })
    expect(calls).toEqual([])
  })
})
