import { describe, it, expect } from 'vitest'
import { handleKey } from './prompt.js'

const UP = '\x1b[A'
const DOWN = '\x1b[B'

describe('handleKey', () => {
  it('moves down and wraps to top', () => {
    expect(handleKey(0, DOWN, 3)).toEqual({ selected: 1, action: 'move' })
    expect(handleKey(2, DOWN, 3)).toEqual({ selected: 0, action: 'move' }) // 末项再下 → 回到首项
  })

  it('moves up and wraps to bottom', () => {
    expect(handleKey(1, UP, 3)).toEqual({ selected: 0, action: 'move' })
    expect(handleKey(0, UP, 3)).toEqual({ selected: 2, action: 'move' }) // 首项再上 → 跳到末项
  })

  it('supports j/k as down/up', () => {
    expect(handleKey(0, 'j', 3).selected).toBe(1)
    expect(handleKey(1, 'k', 3).selected).toBe(0)
  })

  it('confirms on Enter (both \\r and \\n)', () => {
    expect(handleKey(2, '\r', 3)).toEqual({ selected: 2, action: 'confirm' })
    expect(handleKey(1, '\n', 3)).toEqual({ selected: 1, action: 'confirm' })
  })

  it('cancels on Esc and Ctrl+C', () => {
    expect(handleKey(1, '\x1b', 3).action).toBe('cancel')
    expect(handleKey(1, '\x03', 3).action).toBe('cancel')
  })

  it('selects directly by number key and confirms', () => {
    expect(handleKey(0, '2', 3)).toEqual({ selected: 1, action: 'confirm' })
    expect(handleKey(0, '3', 3)).toEqual({ selected: 2, action: 'confirm' })
  })

  it('ignores out-of-range number keys and unknown keys', () => {
    expect(handleKey(1, '9', 3)).toEqual({ selected: 1, action: 'none' }) // 只有 3 项
    expect(handleKey(1, 'x', 3)).toEqual({ selected: 1, action: 'none' })
  })
})
