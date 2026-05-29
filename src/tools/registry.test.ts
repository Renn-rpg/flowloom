import { describe, it, expect } from 'vitest'
import { ToolRegistry } from './registry.js'
import type { Tool } from './types.js'

const fake: Tool = { spec: { name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {} } }, handler: async () => 'ok' }

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const r = new ToolRegistry()
    r.register(fake)
    expect(r.get('echo')).toBe(fake)
  })
  it('exposes specs for the model request', () => {
    const r = new ToolRegistry()
    r.register(fake)
    expect(r.specs()).toEqual([fake.spec])
  })
  it('runs a tool, errors become a string (never throws)', async () => {
    const r = new ToolRegistry()
    expect(await r.run('missing', {})).toContain('ERROR')
  })
})
