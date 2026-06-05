import { describe, it, expect } from 'vitest'
import { fmt, stripAnsi, physicalRows, visualWidth } from './format.js'

describe('fmt', () => {
  it('summary includes tools, tokens, time', () => {
    const s = fmt.summary(100, 3, 2500)
    expect(s).toContain('3')
    expect(s).toContain('100')
    expect(s).toContain('2.5s')
  })

  it('thinking shows time', () => {
    const s = fmt.thinking(4700)
    expect(s).toContain('Thinking')
    expect(s).toContain('4.7s')
  })

  it('colors return non-empty strings', () => {
    expect(fmt.green('test').length).toBeGreaterThan(0)
    expect(fmt.red('test').length).toBeGreaterThan(0)
    expect(fmt.dim('test').length).toBeGreaterThan(0)
  })
})

describe('stripAnsi', () => {
  it('removes SGR color sequences, keeps visible text', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m')).toBe('red')
    expect(stripAnsi('\x1b[1m\x1b[36mhi\x1b[0m there')).toBe('hi there')
  })
  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain 中文')).toBe('plain 中文')
  })
})

describe('physicalRows', () => {
  it('is 1 for a short line', () => {
    expect(physicalRows('hello', 80)).toBe(1)
  })
  it('wraps ASCII lines by column width', () => {
    expect(physicalRows('x'.repeat(80), 40)).toBe(2)
    expect(physicalRows('x'.repeat(81), 40)).toBe(3)
  })
  it('counts CJK as width 2 (wraps sooner)', () => {
    // 30 个 CJK = 60 列 → 80 列宽内 1 行;40 列宽则 2 行
    const cjk = '文'.repeat(30)
    expect(visualWidth(cjk)).toBe(60)
    expect(physicalRows(cjk, 80)).toBe(1)
    expect(physicalRows(cjk, 40)).toBe(2)
  })
  it('ignores ANSI when measuring width', () => {
    expect(physicalRows('\x1b[31m' + 'x'.repeat(40) + '\x1b[39m', 40)).toBe(1)
  })
  it('treats unknown/zero column width as no wrapping (1 row)', () => {
    expect(physicalRows('x'.repeat(200), 0)).toBe(1)
  })
})
