import { describe, it, expect } from 'vitest'
import { resolveEffortModel } from './effort.js'

describe('resolveEffortModel', () => {
  it('keeps the base model for default / low / medium', () => {
    expect(resolveEffortModel('deepseek-chat', undefined, 'X')).toMatchObject({ model: 'deepseek-chat', reasoning: false })
    expect(resolveEffortModel('deepseek-chat', 'low', 'X').model).toBe('deepseek-chat')
    expect(resolveEffortModel('deepseek-chat', 'medium', 'X').model).toBe('deepseek-chat')
    expect(resolveEffortModel('deepseek-chat', 'auto', 'X').reasoning).toBe(false)
  })

  it('switches to the reasoner model for high / max when FLOOM_REASONER_MODEL is set', () => {
    expect(resolveEffortModel('deepseek-chat', 'high', 'deepseek-v4-pro')).toMatchObject({ model: 'deepseek-v4-pro', reasoning: true })
    expect(resolveEffortModel('deepseek-chat', 'max', 'deepseek-v4-pro').model).toBe('deepseek-v4-pro')
  })

  it('warns and falls back to base model when high requested but no reasoner configured', () => {
    const res = resolveEffortModel('deepseek-chat', 'high', '')
    expect(res.model).toBe('deepseek-chat')
    expect(res.reasoning).toBe(false)
    expect(res.warning).toBeTruthy()
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveEffortModel('b', '  HIGH ', 'r').model).toBe('r')
  })
})
