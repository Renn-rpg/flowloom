import { describe, it, expect } from 'vitest'
import { createStatusBar, renderStatusBar } from './status-bar.js'

describe('renderStatusBar', () => {
  it('returns empty string when hidden', () => {
    const s = createStatusBar()
    s.show = false
    expect(renderStatusBar(s)).toBe('')
  })

  it('includes the model and token counts', () => {
    const s = createStatusBar()
    s.model = 'deepseek-v4-pro'
    s.inputTokens = 12
    s.outputTokens = 34
    const out = renderStatusBar(s)
    expect(out).toContain('deepseek-v4-pro')
    expect(out).toContain('in:')
    expect(out).toContain('12')
    expect(out).toContain('34')
  })

  it('shows a background-task segment only when there are running tasks', () => {
    const s = createStatusBar()
    expect(renderStatusBar(s)).not.toContain('bg')
    s.backgroundTasks = 2
    expect(renderStatusBar(s)).toContain('2 bg')
  })

  it('shows PLAN only in plan mode', () => {
    const s = createStatusBar()
    expect(renderStatusBar(s)).not.toContain('PLAN')
    s.planMode = true
    expect(renderStatusBar(s)).toContain('PLAN')
  })
})
