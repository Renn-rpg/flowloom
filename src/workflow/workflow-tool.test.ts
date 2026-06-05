import { describe, it, expect } from 'vitest'
import { makeWorkflowTool } from './workflow-tool.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ModelClient } from '../model/client.js'
import type { GenerateResult, GenerateRequest } from '../protocol/types.js'
import type { WorkflowEvent } from './types.js'

const r = (over: Partial<GenerateResult>): GenerateResult => ({
  text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, ...over,
})
const echo = (): ModelClient => ({
  generate: async (req: GenerateRequest) => {
    const u = [...req.messages].reverse().find((m) => m.role === 'user')
    return r({ text: 'echo:' + (u?.text ?? ''), usage: { inputTokens: 2, outputTokens: 3 } })
  },
})
const base = (over: Partial<Parameters<typeof makeWorkflowTool>[0]> = {}) => ({
  client: echo(), registry: new ToolRegistry(), model: 'm', system: 'sys', maxTokens: 100, ...over,
})

describe('workflow tool', () => {
  it('requires a non-empty script', async () => {
    const t = makeWorkflowTool(base())
    expect(await t.handler({})).toMatch(/^ERROR/)
    expect(await t.handler({ script: '   ' })).toMatch(/^ERROR/)
  })

  it('runs a single-agent script and returns its result, emitting events', async () => {
    const events: WorkflowEvent[] = []
    const t = makeWorkflowTool(base({ onEvent: (e) => events.push(e) }))
    const script =
      'export const meta={name:"t",schemaVersion:1};\nexport async function run(ctx){ const a=await ctx.agent("hello"); return { got:a } }'
    const out = await t.handler({ script })
    expect(out).toContain('workflow done')
    expect(out).toContain('echo:hello')
    expect(events.some((e) => e.kind === 'agent-start')).toBe(true)
    expect(events.some((e) => e.kind === 'agent-done')).toBe(true)
  })

  it('supports phase + parallel and aggregates results', async () => {
    const events: WorkflowEvent[] = []
    const t = makeWorkflowTool(base({ onEvent: (e) => events.push(e) }))
    const script =
      'export const meta={name:"t",schemaVersion:1};\n' +
      'export async function run(ctx){ ctx.phase("Work"); const xs=await ctx.parallel([()=>ctx.agent("a"),()=>ctx.agent("b")]); return xs }'
    const out = await t.handler({ script })
    expect(out).toContain('echo:a')
    expect(out).toContain('echo:b')
    expect(events.some((e) => e.kind === 'phase' && e.title === 'Work')).toBe(true)
    expect(events.filter((e) => e.kind === 'agent-start')).toHaveLength(2)
  })

  it('reports a throwing script as ERROR', async () => {
    const t = makeWorkflowTool(base())
    const out = await t.handler({
      script: 'export const meta={name:"t",schemaVersion:1}; export async function run(ctx){ throw new Error("boom") }',
    })
    expect(out).toMatch(/ERROR: workflow failed/)
  })

  it('reports usage back via onUsage', async () => {
    let usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number } | null = null
    const t = makeWorkflowTool(base({ onUsage: (u) => { usage = u } }))
    await t.handler({
      script: 'export const meta={name:"t",schemaVersion:1}; export async function run(ctx){ await ctx.agent("x"); return 1 }',
      budget: 5000,
    })
    expect(usage).not.toBeNull()
    expect(usage!.outputTokens).toBeGreaterThanOrEqual(3)
  })
})
