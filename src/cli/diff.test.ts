import { describe, it, expect } from 'vitest'
import { diffLines, renderDiff } from './diff.js'

const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

describe('diffLines', () => {
  it('returns all eq for identical text', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nb\nc\n')
    expect(ops.every((o) => o.tag === 'eq')).toBe(true)
  })

  it('detects a single-line replacement', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    const changed = ops.filter((o) => o.tag !== 'eq')
    expect(changed).toEqual([
      { tag: 'del', line: 'b' },
      { tag: 'add', line: 'B' },
    ])
  })

  it('detects a pure insertion', () => {
    const ops = diffLines('a\nc\n', 'a\nb\nc\n')
    expect(ops.filter((o) => o.tag === 'add')).toEqual([{ tag: 'add', line: 'b' }])
    expect(ops.filter((o) => o.tag === 'del')).toEqual([])
  })

  it('detects a pure deletion', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nc\n')
    expect(ops.filter((o) => o.tag === 'del')).toEqual([{ tag: 'del', line: 'b' }])
    expect(ops.filter((o) => o.tag === 'add')).toEqual([])
  })

  it('only diffs the changed middle (common prefix/suffix preserved as eq)', () => {
    const before = 'x\ny\nOLD\nz\nw\n'
    const after = 'x\ny\nNEW\nz\nw\n'
    const ops = diffLines(before, after)
    expect(ops.filter((o) => o.tag === 'del')).toEqual([{ tag: 'del', line: 'OLD' }])
    expect(ops.filter((o) => o.tag === 'add')).toEqual([{ tag: 'add', line: 'NEW' }])
  })
})

describe('renderDiff', () => {
  it('returns empty string when nothing changed', () => {
    expect(renderDiff('a\nb\n', 'a\nb\n', 'f.ts')).toBe('')
  })

  it('shows +/- lines, counts, and the path', () => {
    const out = strip(renderDiff('a\nb\nc\n', 'a\nB\nc\n', 'src/f.ts'))
    expect(out).toContain('src/f.ts')
    expect(out).toContain('+1')
    expect(out).toContain('-1')
    expect(out).toMatch(/- b/)
    expect(out).toMatch(/\+ B/)
  })

  it('renders a brand-new file as all additions', () => {
    const out = strip(renderDiff('', 'line1\nline2\n', 'new.ts'))
    expect(out).toContain('+2')
    expect(out).toMatch(/\+ line1/)
    expect(out).toMatch(/\+ line2/)
  })

  it('collapses large unchanged gaps with an ellipsis', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
    const after = before.replace('line25', 'CHANGED25')
    const out = strip(renderDiff(before, after, 'big.ts'))
    expect(out).toContain('…') // 折叠标记
    expect(out).toMatch(/CHANGED25/)
    expect(out).not.toMatch(/line0\b/) // 远离改动的行被折叠掉
  })
})
