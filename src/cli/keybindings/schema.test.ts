import { describe, it, expect } from 'vitest'
import { keybindingConfigSchema, keybindingSchema, contextSchema, keyPatternSchema } from './schema.js'

describe('keybinding schema', () => {
  describe('keyPatternSchema', () => {
    it('accepts single visible chars', () => {
      expect(keyPatternSchema.safeParse('a').success).toBe(true)
      expect(keyPatternSchema.safeParse('9').success).toBe(true)
      expect(keyPatternSchema.safeParse('Z').success).toBe(true)
    })

    it('accepts ctrl/shift combos', () => {
      expect(keyPatternSchema.safeParse('ctrl+o').success).toBe(true)
      expect(keyPatternSchema.safeParse('ctrl+e').success).toBe(true)
      expect(keyPatternSchema.safeParse('shift+tab').success).toBe(true)
    })

    it('accepts special keys', () => {
      expect(keyPatternSchema.safeParse('esc').success).toBe(true)
      expect(keyPatternSchema.safeParse('enter').success).toBe(true)
      expect(keyPatternSchema.safeParse('up').success).toBe(true)
      expect(keyPatternSchema.safeParse('backspace').success).toBe(true)
    })

    it('rejects invalid patterns', () => {
      expect(keyPatternSchema.safeParse('ctrl++o').success).toBe(false)
      expect(keyPatternSchema.safeParse('').success).toBe(false)
      expect(keyPatternSchema.safeParse('F1').success).toBe(false)
    })
  })

  describe('contextSchema', () => {
    it('accepts valid contexts', () => {
      expect(contextSchema.safeParse('global').success).toBe(true)
      expect(contextSchema.safeParse('chat').success).toBe(true)
      expect(contextSchema.safeParse('select').success).toBe(true)
      expect(contextSchema.safeParse('workflow-view').success).toBe(true)
      expect(contextSchema.safeParse('modal').success).toBe(true)
      expect(contextSchema.safeParse('autocomplete').success).toBe(true)
      expect(contextSchema.safeParse('help').success).toBe(true)
    })

    it('rejects invalid contexts', () => {
      expect(contextSchema.safeParse('unknown').success).toBe(false)
    })
  })

  describe('keybindingConfigSchema', () => {
    it('parses a valid config', () => {
      const result = keybindingConfigSchema.safeParse({
        bindings: [
          { key: 'ctrl+o', action: 'expand-one', context: 'chat' },
        ],
      })
      expect(result.success).toBe(true)
    })

    it('rejects config without bindings array', () => {
      const result = keybindingConfigSchema.safeParse({})
      expect(result.success).toBe(false)
    })

    it('rejects invalid binding entry', () => {
      const result = keybindingConfigSchema.safeParse({
        bindings: [{ key: 'bad!!', action: '', context: 'invalid' }],
      })
      expect(result.success).toBe(false)
    })
  })
})
