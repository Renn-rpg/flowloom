import { describe, it, expect } from 'vitest'
import { safeParseArgs } from './safe-json.js'

describe('safeParseArgs', () => {
  it('parses valid json', () => {
    expect(safeParseArgs('{"path":"/a.ts"}')).toEqual({ path: '/a.ts' })
  })
  it('repairs missing closing brace', () => {
    expect(safeParseArgs('{"path":"/a.ts"')).toEqual({ path: '/a.ts' })
  })
  it('returns empty object on unrepairable input', () => {
    expect(safeParseArgs('not json at all')).toEqual({})
  })

  it('returns empty object for deeply nested JSON (DoS protection)', () => {
    // 构造超过 64 层嵌套的对象
    let deep = '{"a":'
    for (let i = 0; i < 100; i++) deep += '{"a":'
    deep += '"x"'
    for (let i = 0; i < 100; i++) deep += '}'
    deep += '}'
    expect(safeParseArgs(deep)).toEqual({})
  })

  it('returns empty object for excessively long input', () => {
    // 构造超过 256KB 的输入（长度限制）
    let long = '{"a":"'
    for (let i = 0; i < 17; i++) long += 'x'.repeat(16 * 1024) // 17×16KB = 272KB
    long += '"}'
    expect(safeParseArgs(long)).toEqual({})
  })

  it('limits brace repair to at most 10 missing', () => {
    // 需要补 11 个右括号 → 不应修复
    const manyMissing = '{"a":' + '{"b":"c"'.repeat(11)
    expect(safeParseArgs(manyMissing)).toEqual({})
  })
})
