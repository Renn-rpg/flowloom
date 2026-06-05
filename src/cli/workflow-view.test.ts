import { describe, it, expect } from 'vitest'
import { renderWorkflowView, reduceView, type ViewState } from './workflow-view.js'
import { AgentTracker } from './agent-tracker.js'
import type { Key } from './repl-input.js'

function buildRun() {
  const tr = new AgentTracker(() => 1000)
  const run = tr.startRun('parallel agents')
  const a1 = tr.addAgent(run, { label: 'auth', model: 'deepseek-v4-pro' })
  const a2 = tr.addAgent(run, { label: 'db', model: 'deepseek-v4-pro' })
  const a3 = tr.addAgent(run, { label: 'api', model: 'deepseek-v4-pro' })
  tr.agentRunning(a1)
  tr.agentTool(a1, 'glob')
  tr.agentUsage(a1, { inputTokens: 100, outputTokens: 5800 })
  tr.agentDone(a1, { tokens: 5800, tools: 5 })
  tr.agentRunning(a2)
  tr.agentDone(a2, { isError: true, error: 'boom' })
  tr.agentRunning(a3)
  return tr.last()!
}

const dims = { rows: 30, columns: 100, now: 5000 }

describe('renderWorkflowView', () => {
  it('renders the title, progress and all agent rows', () => {
    const lines = renderWorkflowView(buildRun(), { selected: 0 }, dims)
    const text = lines.join('\n')
    expect(text).toContain('parallel agents')
    expect(text).toContain('auth')
    expect(text).toContain('db')
    expect(text).toContain('api')
    expect(text).toContain('deepseek-v4-pro')
    expect(text).toContain('5.8k tok')
    expect(text).toContain('5 tools')
  })

  it('marks the selected row with a pointer', () => {
    const lines = renderWorkflowView(buildRun(), { selected: 1 }, dims)
    const selLine = lines.find((l) => l.includes('db'))!
    expect(selLine).toContain('❯')
  })

  it('shows the error of the selected failed agent in the detail line', () => {
    const lines = renderWorkflowView(buildRun(), { selected: 1 }, dims)
    expect(lines.join('\n')).toContain('boom')
  })

  it('always renders the control bar', () => {
    const lines = renderWorkflowView(buildRun(), { selected: 0 }, dims)
    expect(lines.join('\n')).toContain('esc back')
    expect(lines.join('\n')).toContain('x stop')
  })

  it('windows the body for many agents and shows more-indicators', () => {
    const tr = new AgentTracker(() => 1000)
    const run = tr.startRun('big')
    for (let i = 0; i < 40; i++) tr.addAgent(run, { label: `t${i}`, model: 'm' })
    const lines = renderWorkflowView(tr.last()!, { selected: 39 }, { rows: 15, columns: 80, now: 2000 })
    const text = lines.join('\n')
    expect(text).toContain('more') // 顶部或底部滚动指示
    expect(text).toContain('t39') // 选中项可见
  })

  it('renders a phase overview when the run has phases', () => {
    const tr = new AgentTracker(() => 1000)
    const run = tr.startRun('wf', ['Modules', 'Verify'])
    tr.addAgent(run, { label: 'm1', phase: 'Modules', model: 'm' })
    const lines = renderWorkflowView(tr.last()!, { selected: 0 }, dims)
    expect(lines.join('\n')).toContain('Modules')
    expect(lines.join('\n')).toContain('Verify')
  })
})

describe('reduceView', () => {
  const key = (k: Partial<Key> & { t: Key['t'] }) => k as Key
  const s: ViewState = { selected: 1 }

  it('moves selection within bounds', () => {
    expect(reduceView({ selected: 1 }, key({ t: 'up' }), 3)).toEqual({ state: { selected: 0 }, action: 'redraw' })
    expect(reduceView({ selected: 0 }, key({ t: 'up' }), 3).state.selected).toBe(0) // clamp
    expect(reduceView({ selected: 2 }, key({ t: 'down' }), 3).state.selected).toBe(2) // clamp
  })

  it('maps esc/q/ctrl-c to back (always escapable)', () => {
    expect(reduceView(s, key({ t: 'esc' }), 3).action).toBe('back')
    expect(reduceView(s, { t: 'char', ch: 'q' }, 3).action).toBe('back')
    expect(reduceView(s, key({ t: 'ctrl-c' }), 3).action).toBe('back')
  })

  it('maps x/p/s to stop/pause/save', () => {
    expect(reduceView(s, { t: 'char', ch: 'x' }, 3).action).toBe('stop')
    expect(reduceView(s, { t: 'char', ch: 'p' }, 3).action).toBe('pause')
    expect(reduceView(s, { t: 'char', ch: 's' }, 3).action).toBe('save')
  })

  it('ignores unrelated keys', () => {
    expect(reduceView(s, { t: 'char', ch: 'z' }, 3).action).toBe('none')
    expect(reduceView(s, key({ t: 'tab' }), 3).action).toBe('none')
  })
})
