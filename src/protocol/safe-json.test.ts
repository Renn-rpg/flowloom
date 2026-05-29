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
})
