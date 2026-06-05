import { describe, it, expect, vi } from 'vitest'
import { AgentTracker, runProgress } from './agent-tracker.js'

// 注入一个递增时钟，保证 startedAt/endedAt 确定。
function fixedClock() {
  let t = 1000
  return () => (t += 10)
}

describe('AgentTracker', () => {
  it('tracks a plain fan-out run lifecycle', () => {
    const tr = new AgentTracker(fixedClock())
    const run = tr.startRun('explore the codebase')
    const a1 = tr.addAgent(run, { label: 'auth', model: 'deepseek-v4-pro' })
    const a2 = tr.addAgent(run, { label: 'db', model: 'deepseek-v4-pro' })

    expect(tr.current()?.rows).toHaveLength(2)
    expect(tr.current()?.rows[0].status).toBe('queued')

    tr.agentRunning(a1)
    tr.agentTool(a1, 'glob')
    tr.agentTool(a1, 'read_file')
    tr.agentUsage(a1, { inputTokens: 100, outputTokens: 40 })
    tr.agentDone(a1, { tokens: 40, tools: 2 })

    const row1 = tr.current()!.rows[0]
    expect(row1.status).toBe('done')
    expect(row1.toolCalls).toBe(2)
    expect(row1.outputTokens).toBe(40)
    expect(row1.currentTool).toBeUndefined()

    tr.agentRunning(a2)
    tr.agentDone(a2, { isError: true, error: 'boom' })
    expect(tr.current()!.rows[1].status).toBe('failed')
    expect(tr.current()!.rows[1].error).toBe('boom')
  })

  it('current() returns null after the run ends; last() still returns it', () => {
    const tr = new AgentTracker(fixedClock())
    const run = tr.startRun('x')
    expect(tr.current()?.id).toBe(run)
    tr.endRun(run, 'done')
    expect(tr.current()).toBeNull()
    expect(tr.last()?.id).toBe(run)
  })

  it('on abort: running rows → failed, but never-started queued rows stay queued', () => {
    const tr = new AgentTracker(fixedClock())
    const run = tr.startRun('x')
    const a1 = tr.addAgent(run, { label: 'a', model: 'm' })
    tr.addAgent(run, { label: 'b', model: 'm' }) // 保持 queued（从未开跑）
    tr.agentRunning(a1)
    tr.endRun(run, 'failed')
    expect(tr.last()!.rows[0].status).toBe('failed') // 在跑的 → failed
    expect(tr.last()!.rows[0].endedAt).toBeDefined()
    expect(tr.last()!.rows[1].status).toBe('queued') // 从未开跑 → 保留 queued，不误标 failed
  })

  it('on done: dangling queued rows are marked done', () => {
    const tr = new AgentTracker(fixedClock())
    const run = tr.startRun('x')
    tr.addAgent(run, { label: 'a', model: 'm' })
    tr.endRun(run, 'done')
    expect(tr.last()!.rows[0].status).toBe('done')
  })

  it('emits update on every mutation', () => {
    const tr = new AgentTracker(fixedClock())
    const spy = vi.fn()
    tr.on('update', spy)
    const run = tr.startRun('x')
    const a = tr.addAgent(run, { label: 'a', model: 'm' })
    tr.agentRunning(a)
    tr.agentDone(a)
    tr.endRun(run, 'done')
    expect(spy.mock.calls.length).toBe(5)
  })

  it('phaseChange appends unknown phases and advances the pointer', () => {
    const tr = new AgentTracker(fixedClock())
    const run = tr.startRun('wf', ['Modules', 'Integrate'])
    expect(tr.current()!.currentPhase).toBe(0)
    tr.phaseChange(run, 'Integrate')
    expect(tr.current()!.currentPhase).toBe(1)
    tr.phaseChange(run, 'Verify') // 未声明 → 追加
    expect(tr.current()!.phases).toEqual(['Modules', 'Integrate', 'Verify'])
    expect(tr.current()!.currentPhase).toBe(2)
  })

  it('ignores mutations for unknown ids (no throw)', () => {
    const tr = new AgentTracker(fixedClock())
    expect(() => {
      tr.agentRunning('nope')
      tr.agentDone('nope')
      tr.phaseChange('nope', 'x')
      tr.endRun('nope', 'done')
    }).not.toThrow()
  })
})

describe('runProgress', () => {
  it('counts done/total for a plain fan-out', () => {
    const tr = new AgentTracker(fixedClock())
    const run = tr.startRun('x')
    const a1 = tr.addAgent(run, { label: 'a', model: 'm' })
    const a2 = tr.addAgent(run, { label: 'b', model: 'm' })
    tr.addAgent(run, { label: 'c', model: 'm' })
    tr.agentDone(a1)
    tr.agentDone(a2, { isError: true })
    const p = runProgress(tr.current()!)
    expect(p.total).toBe(3)
    expect(p.done).toBe(1)
    expect(p.failed).toBe(1)
    expect(p.label).toBe('2/3 agents')
  })

  it('scopes progress to the current phase when phases exist', () => {
    const tr = new AgentTracker(fixedClock())
    const run = tr.startRun('wf', ['Modules', 'Verify'])
    const m1 = tr.addAgent(run, { label: 'm1', phase: 'Modules', model: 'm' })
    tr.addAgent(run, { label: 'm2', phase: 'Modules', model: 'm' })
    tr.agentDone(m1)
    // 切到 Verify phase
    tr.phaseChange(run, 'Verify')
    tr.addAgent(run, { label: 'v1', phase: 'Verify', model: 'm' })
    const p = runProgress(tr.current()!)
    expect(p.label).toBe('Verify 0/1')
    expect(p.total).toBe(1)
  })
})
