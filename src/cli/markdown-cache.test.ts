import { describe, it, expect } from 'vitest'
import { MarkdownCache } from './markdown-cache.js'

describe('MarkdownCache', () => {
  it('returns undefined on miss', () => {
    const c = new MarkdownCache()
    expect(c.get('**bold**')).toBeUndefined()
  })

  it('returns cached rendered output', () => {
    const c = new MarkdownCache()
    c.set('**bold**', '\x1b[1mbold\x1b[22m')
    expect(c.get('**bold**')).toBe('\x1b[1mbold\x1b[22m')
  })

  it('evicts oldest on overflow', () => {
    const c = new MarkdownCache()
    for (let i = 0; i < 510; i++) {
      c.set(`text${i}`, `rendered${i}`)
    }
    expect(c.get('text0')).toBeUndefined()
    expect(c.size).toBe(500)
  })

  it('invalidate clears all', () => {
    const c = new MarkdownCache()
    c.set('a', 'b')
    c.invalidate()
    expect(c.size).toBe(0)
  })
})
