import { describe, it, expect } from 'vitest'
import { canonicalJson, hashCanonical } from './hash.js'

describe('canonicalJson', () => {
  it('orders keys: {model,phase} equals {phase,model}', () => {
    const a = { model: 'gpt', phase: 'test' }
    const b = { phase: 'test', model: 'gpt' }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })
  it('sorts nested object keys', () => {
    expect(canonicalJson({ b: { z: 1, a: 2 }, a: 1 }))
      .toBe('{"a":1,"b":{"a":2,"z":1}}')
  })
  it('preserves array element order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })
  it('handles null and primitives', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson('hello')).toBe('"hello"')
  })
  it('drops undefined values from objects', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('hashCanonical', () => {
  it('returns hex SHA-256', () => {
    expect(hashCanonical({ x: 1 })).toHaveLength(64)
  })
  it('same object same hash regardless of key order', () => {
    expect(hashCanonical({ model: 'a', phase: 'b' }))
      .toBe(hashCanonical({ phase: 'b', model: 'a' }))
  })
  it('different objects different hash', () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }))
  })
})
