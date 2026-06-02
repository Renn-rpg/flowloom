import { describe, it, expect } from 'vitest'
import { computeCompletions } from './completions.js'

describe('computeCompletions', () => {
  it('returns no menu for non-slash input', () => {
    expect(computeCompletions('hello')).toEqual({ kind: 'none', items: [] })
    expect(computeCompletions('')).toEqual({ kind: 'none', items: [] })
  })

  it('lists every command for a bare slash', () => {
    const c = computeCompletions('/')
    expect(c.kind).toBe('command')
    const labels = c.items.map((i) => i.label)
    expect(labels).toContain('/help')
    expect(labels).toContain('/effort')
    expect(labels).toContain('/exit')
    // 补全项填回完整 buffer
    expect(c.items.find((i) => i.label === '/clear')?.replacement).toBe('/clear')
  })

  it('filters commands by prefix', () => {
    const c = computeCompletions('/e')
    expect(c.kind).toBe('command')
    expect(c.items.map((i) => i.label).sort()).toEqual(['/effort', '/exit'])
  })

  it('completes a partial unique command without descending into args', () => {
    const c = computeCompletions('/ex')
    expect(c.kind).toBe('command')
    expect(c.items).toHaveLength(1)
    expect(c.items[0].replacement).toBe('/exit')
  })

  it('shows arg options once a command with args is fully typed', () => {
    const c = computeCompletions('/effort')
    expect(c.kind).toBe('arg')
    expect(c.items.map((i) => i.label)).toEqual(['max', 'high', 'normal'])
    expect(c.items[0].replacement).toBe('/effort max')
  })

  it('shows arg options after a trailing space', () => {
    const c = computeCompletions('/effort ')
    expect(c.kind).toBe('arg')
    expect(c.items).toHaveLength(3)
  })

  it('filters arg options by the partial argument', () => {
    const c = computeCompletions('/effort h')
    expect(c.kind).toBe('arg')
    expect(c.items.map((i) => i.label)).toEqual(['high'])
    expect(c.items[0].replacement).toBe('/effort high')
  })

  it('no menu for a fully-typed no-arg command (so Enter runs it)', () => {
    const c = computeCompletions('/clear')
    expect(c.kind).toBe('command')
    expect(c.items).toHaveLength(1)
    expect(c.items[0].replacement).toBe('/clear')
  })

  it('no menu for a command that takes no enumerable args', () => {
    expect(computeCompletions('/model ').items).toHaveLength(0)
    expect(computeCompletions('/model deepseek-chat').items).toHaveLength(0)
  })

  it('no menu for an unknown command with a space', () => {
    expect(computeCompletions('/bogus arg').items).toHaveLength(0)
  })
})
