import { describe, it, expect } from 'vitest'
import { HighlightCache } from './highlight-cache.js'

describe('HighlightCache', () => {
  it('returns undefined on miss', () => {
    const c = new HighlightCache()
    expect(c.get('ts', 'const x = 1')).toBeUndefined()
  })

  it('returns cached value on hit', () => {
    const c = new HighlightCache()
    c.set('ts', 'const x = 1', 'COLORED')
    expect(c.get('ts', 'const x = 1')).toBe('COLORED')
  })

  it('distinguishes languages', () => {
    const c = new HighlightCache()
    c.set('ts', 'const x = 1', 'TS')
    c.set('py', 'const x = 1', 'PY')
    expect(c.get('ts', 'const x = 1')).toBe('TS')
    expect(c.get('py', 'const x = 1')).toBe('PY')
  })

  it('evicts oldest on overflow', () => {
    const c = new HighlightCache()
    // 填充超过 500 条
    for (let i = 0; i < 510; i++) {
      c.set('ts', `line${i}`, `color${i}`)
    }
    // 前几条应被回收
    expect(c.get('ts', 'line0')).toBeUndefined()
    // 最新条目应存活
    expect(c.get('ts', 'line509')).toBe('color509')
    expect(c.size).toBe(500)
  })

  it('invalidate clears all', () => {
    const c = new HighlightCache()
    c.set('ts', 'x', 'y')
    c.invalidate()
    expect(c.size).toBe(0)
  })
})
