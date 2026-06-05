import { describe, it, expect } from 'vitest'
import { buildIndex, matchKey, keyToPattern } from './match.js'
import type { Key, Keybinding } from './types.js'
import { DEFAULTS } from './defaults.js'

describe('keyToPattern', () => {
  it('converts char key to pattern', () => {
    expect(keyToPattern({ t: 'char', ch: 'a' })).toBe('a')
  })

  it('converts control keys to pattern', () => {
    expect(keyToPattern({ t: 'ctrl-o' })).toBe('ctrl+o')
    expect(keyToPattern({ t: 'ctrl-c' })).toBe('ctrl+c')
    expect(keyToPattern({ t: 'ctrl-d' })).toBe('ctrl+d')
    expect(keyToPattern({ t: 'ctrl-r' })).toBe('ctrl+r')
    expect(keyToPattern({ t: 'ctrl-e' })).toBe('ctrl+e')
  })

  it('converts special keys to pattern', () => {
    expect(keyToPattern({ t: 'enter' })).toBe('enter')
    expect(keyToPattern({ t: 'esc' })).toBe('esc')
    expect(keyToPattern({ t: 'tab' })).toBe('tab')
    expect(keyToPattern({ t: 'shift-tab' })).toBe('shift+tab')
    expect(keyToPattern({ t: 'up' })).toBe('up')
    expect(keyToPattern({ t: 'down' })).toBe('down')
  })

  it('returns null for unknown keys', () => {
    expect(keyToPattern({ t: 'unknown' })).toBeNull()
  })
})

describe('matchKey', () => {
  const bindings: Keybinding[] = [
    { key: 'ctrl+o', action: 'expand-one', context: 'chat' },
    { key: 'esc', action: 'interrupt-model', context: 'chat' },
    { key: 'esc', action: 'modal-dismiss', context: 'modal' },
    { key: 'ctrl+c', action: 'interrupt', context: 'global' },
  ]
  const index = buildIndex(bindings)

  it('matches in correct context', () => {
    const result = matchKey(index, ['chat'], { t: 'ctrl-o' })
    expect(result?.action).toBe('expand-one')
  })

  it('prioritizes most recent context', () => {
    const result = matchKey(index, ['chat', 'modal'], { t: 'esc' })
    expect(result?.action).toBe('interrupt-model')
    // reversed: modal is more recent
    const result2 = matchKey(index, ['modal', 'chat'], { t: 'esc' })
    expect(result2?.action).toBe('modal-dismiss')
  })

  it('falls back to global', () => {
    const result = matchKey(index, ['chat'], { t: 'ctrl-c' })
    expect(result?.action).toBe('interrupt')
  })

  it('returns null for unmatched key', () => {
    const result = matchKey(index, ['chat'], { t: 'left' })
    expect(result).toBeNull()
  })
})

describe('buildIndex', () => {
  it('indexes defaults without error', () => {
    const idx = buildIndex(DEFAULTS)
    expect(idx.size).toBeGreaterThan(0)
    // global context should exist
    expect(idx.has('global')).toBe(true)
  })
})
