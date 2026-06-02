import { describe, it, expect } from 'vitest'
import { planModeGate, isReadOnlyInPlanMode, makeExitPlanModeTool } from './plan.js'
import { createSession, runTurn } from './loop.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ModelClient } from '../model/client.js'
import type { GenerateResult } from '../protocol/types.js'

describe('planModeGate', () => {
  it('allows everything when plan mode is inactive', () => {
    expect(planModeGate(false, 'write_file').allow).toBe(true)
    expect(planModeGate(false, 'run_shell').allow).toBe(true)
  })
  it('allows read-only tools while active', () => {
    for (const t of ['read_file', 'glob', 'grep', 'web_fetch', 'exit_plan_mode']) {
      expect(planModeGate(true, t).allow).toBe(true)
    }
  })
  it('blocks mutating tools while active and explains how to proceed', () => {
    const r = planModeGate(true, 'write_file')
    expect(r.allow).toBe(false)
    expect(r.message).toContain('exit_plan_mode')
    expect(planModeGate(true, 'run_shell').allow).toBe(false)
    expect(planModeGate(true, 'dispatch_agent').allow).toBe(false)
    expect(planModeGate(true, 'mcp__srv__do').allow).toBe(false)
  })
})

describe('isReadOnlyInPlanMode', () => {
  it('classifies known read-only tools', () => {
    expect(isReadOnlyInPlanMode('grep')).toBe(true)
    expect(isReadOnlyInPlanMode('edit_file')).toBe(false)
  })
})

describe('exit_plan_mode tool', () => {
  const make = (over = {}) =>
    makeExitPlanModeTool({ active: () => true, propose: async () => true, onApproved: () => {}, ...over })

  it('requires a non-empty plan', async () => {
    expect(await make().handler({})).toMatch(/^ERROR/)
    expect(await make().handler({ plan: '   ' })).toMatch(/^ERROR/)
  })

  it('is a no-op when not in plan mode', async () => {
    const tool = make({ active: () => false })
    expect(await tool.handler({ plan: 'do stuff' })).toMatch(/Not in plan mode/)
  })

  it('approves: calls onApproved and tells the model to implement', async () => {
    let approvedCalled = false
    let shownPlan = ''
    const tool = make({
      propose: async (p: string) => { shownPlan = p; return true },
      onApproved: () => { approvedCalled = true },
    })
    const out = await tool.handler({ plan: '1. do X\n2. do Y' })
    expect(shownPlan).toBe('1. do X\n2. do Y')
    expect(approvedCalled).toBe(true)
    expect(out).toMatch(/APPROVED/)
  })

  it('rejection: keeps plan mode and tells the model to revise', async () => {
    let approvedCalled = false
    const tool = make({ propose: async () => false, onApproved: () => { approvedCalled = true } })
    const out = await tool.handler({ plan: 'a plan' })
    expect(approvedCalled).toBe(false)
    expect(out).toMatch(/did NOT approve/)
  })
})

// 集成：planModeGate 经真实 runTurn 闸，确认会拦下有副作用的工具（cli 里 makeGate 同款组合）。
describe('plan gate wired through runTurn', () => {
  const r = (over: Partial<GenerateResult>): GenerateResult => ({
    text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, ...over,
  })
  function scripted(results: GenerateResult[]): ModelClient {
    let i = 0
    return { generate: async () => results[i++] }
  }

  it('blocks a mutating tool and feeds the plan-mode message back (tool never runs)', async () => {
    const reg = new ToolRegistry()
    let wrote = false
    reg.register({
      spec: { name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: {} } },
      handler: async () => { wrote = true; return 'ok' },
    })
    let active = true
    const gate = async (name: string) => {
      const pm = planModeGate(active, name)
      return pm.allow ? { allow: true } : pm
    }
    const client = scripted([
      r({ toolCalls: [{ id: 'c', name: 'write_file', input: {} }], stopReason: 'tool_use' }),
      r({ text: 'understood, I will plan first' }),
    ])
    const s = createSession({ client, registry: reg, system: 's', model: 'm', maxTokens: 100, gate })
    await runTurn(s, 'write a file')
    expect(wrote).toBe(false) // 工具被闸拦下，未执行
    const toolMsg = s.messages.find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMsg)).toMatch(/plan mode is active/)
  })

  it('lets a read-only tool through while active', async () => {
    const reg = new ToolRegistry()
    let read = false
    reg.register({
      spec: { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: {} } },
      handler: async () => { read = true; return 'DATA' },
    })
    const gate = async (name: string) => planModeGate(true, name)
    const client = scripted([
      r({ toolCalls: [{ id: 'c', name: 'read_file', input: {} }], stopReason: 'tool_use' }),
      r({ text: 'done' }),
    ])
    const s = createSession({ client, registry: reg, system: 's', model: 'm', maxTokens: 100, gate })
    await runTurn(s, 'read a file')
    expect(read).toBe(true)
  })
})
