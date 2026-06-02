import { describe, it, expect } from 'vitest'
import { makeDispatchAgentTool, type SubAgentActivity } from './subagent.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ModelClient } from '../model/client.js'
import type { GenerateResult } from '../protocol/types.js'

const r = (over: Partial<GenerateResult>): GenerateResult => ({
  text: '',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 0, outputTokens: 0 },
  ...over,
})
function scripted(results: GenerateResult[]): ModelClient {
  let i = 0
  return { generate: async () => results[i++] }
}
const base = (over: Partial<Parameters<typeof makeDispatchAgentTool>[0]> = {}) => ({
  client: scripted([r({ text: 'sub final answer' })]),
  buildRegistry: () => new ToolRegistry(),
  system: 'sub sys',
  model: 'm',
  maxTokens: 100,
  ...over,
})

describe('dispatch_agent tool', () => {
  it('exposes a dispatch_agent spec requiring prompt', () => {
    const tool = makeDispatchAgentTool(base())
    expect(tool.spec.name).toBe('dispatch_agent')
    expect(tool.spec.inputSchema.required).toContain('prompt')
  })

  it('runs a sub-turn and returns its final text', async () => {
    const tool = makeDispatchAgentTool(base())
    expect(await tool.handler({ prompt: 'do x' })).toBe('sub final answer')
  })

  it('rejects an empty or missing prompt with ERROR', async () => {
    const tool = makeDispatchAgentTool(base())
    expect(await tool.handler({})).toMatch(/^ERROR/)
    expect(await tool.handler({ prompt: '   ' })).toMatch(/^ERROR/)
  })

  it('runs the sub-agent tool loop and emits activity events', async () => {
    const reg = new ToolRegistry()
    reg.register({
      spec: { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      handler: async () => 'DATA',
    })
    const client = scripted([
      r({ toolCalls: [{ id: 'c1', name: 'read_file', input: { path: '/a' } }], stopReason: 'tool_use' }),
      r({ text: 'used DATA' }),
    ])
    const events: SubAgentActivity[] = []
    const tool = makeDispatchAgentTool(base({ client, buildRegistry: () => reg, onActivity: (a) => events.push(a) }))
    expect(await tool.handler({ prompt: 'read /a', description: 'read file' })).toBe('used DATA')
    expect(events.some((e) => e.kind === 'tool' && e.name === 'read_file' && e.detail === '/a')).toBe(true)
    const done = events.find((e) => e.kind === 'done')
    expect(done?.tools).toBe(1)
  })

  it('builds a fresh registry each dispatch (recursion isolation)', async () => {
    let built = 0
    const tool = makeDispatchAgentTool(base({ buildRegistry: () => { built++; return new ToolRegistry() } }))
    await tool.handler({ prompt: 'p' })
    expect(built).toBe(1)
  })

  it('returns ERROR and flags the done activity when the sub-agent throws', async () => {
    const events: SubAgentActivity[] = []
    const tool = makeDispatchAgentTool(
      base({ client: { generate: async () => { throw new Error('boom') } }, onActivity: (a) => events.push(a) }),
    )
    expect(await tool.handler({ prompt: 'p' })).toMatch(/^ERROR: sub-agent failed: boom/)
    expect(events.find((e) => e.kind === 'done')?.isError).toBe(true)
  })

  it('converts a maxIters "stopped:" sentinel into an ERROR (not a silent success)', async () => {
    // A sub-agent that keeps calling a tool forever exhausts maxIters and runTurn returns
    // "stopped: reached max iterations" — must surface as ERROR so the parent knows it was truncated.
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'glob', description: 'g', inputSchema: { type: 'object', properties: {} } }, handler: async () => 'x' })
    const loopForever = { generate: async () => r({ toolCalls: [{ id: 'c', name: 'glob', input: {} }], stopReason: 'tool_use' }) }
    const events: SubAgentActivity[] = []
    const tool = makeDispatchAgentTool(base({ client: loopForever, buildRegistry: () => reg, maxIters: 3, onActivity: (a) => events.push(a) }))
    const out = await tool.handler({ prompt: 'p' })
    expect(out).toMatch(/^ERROR: sub-agent did not finish/)
    expect(events.find((e) => e.kind === 'done')?.isError).toBe(true)
  })

  it('reports sub-agent token usage back to the parent', async () => {
    let usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number } | null = null
    const tool = makeDispatchAgentTool(
      base({
        client: scripted([r({ text: 'x', usage: { inputTokens: 10, outputTokens: 5 } })]),
        onUsage: (u) => { usage = u },
      }),
    )
    await tool.handler({ prompt: 'p' })
    expect(usage).not.toBeNull()
    expect(usage!.outputTokens).toBe(5)
  })

  it('truncates very large sub-agent output', async () => {
    const big = 'x'.repeat(60_000)
    const tool = makeDispatchAgentTool(base({ client: scripted([r({ text: big })]) }))
    const out = await tool.handler({ prompt: 'p' })
    expect(out.length).toBeLessThan(60_000)
    expect(out.endsWith('…(truncated)')).toBe(true)
  })
})
