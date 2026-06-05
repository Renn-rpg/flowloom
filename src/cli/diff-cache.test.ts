import { describe, it, expect } from 'vitest'
import { DiffCache } from './diff-cache.js'

describe('DiffCache', () => {
  it('returns undefined on miss', () => {
    const c = new DiffCache()
    expect(c.get('old', 'new')).toBeUndefined()
  })

  it('returns cached result on hit', () => {
    const c = new DiffCache()
    c.set('old', 'new', { del: 'old', add: '<new>' })
    const r = c.get('old', 'new')
    expect(r?.del).toBe('old')
    expect(r?.add).toBe('<new>')
  })

  it('distinguishes by pair', () => {
    const c = new DiffCache()
    c.set('a', 'b', { del: 'a', add: 'b' })
    expect(c.get('b', 'a')).toBeUndefined()
  })

  it('evicts oldest on overflow', () => {
    const c = new DiffCache()
    for (let i = 0; i < 210; i++) {
      c.set(`old${i}`, `new${i}`, { del: `old${i}`, add: `new${i}` })
    }
    expect(c.get('old0', 'new0')).toBeUndefined()
    expect(c.size).toBe(200)
  })

  it('invalidate clears all', () => {
    const c = new DiffCache()
    c.set('old', 'new', { del: 'old', add: 'new' })
    c.invalidate()
    expect(c.size).toBe(0)
  })
})
