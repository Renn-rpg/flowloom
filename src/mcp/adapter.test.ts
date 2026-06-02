import { describe, it, expect } from 'vitest'
import { mcpToolName, sanitizeName, renderMcpResult, mcpToolsToFloomTools } from './adapter.js'

describe('name mapping', () => {
  it('namespaces and sanitizes tool names for model safety', () => {
    expect(mcpToolName('my server', 'do.thing!')).toBe('mcp__my_server__do_thing_')
    expect(sanitizeName('a/b c')).toBe('a_b_c')
  })
})

describe('renderMcpResult', () => {
  it('joins text content', () => {
    expect(renderMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false })).toBe('a\nb')
  })
  it('prefixes ERROR when isError is true', () => {
    expect(renderMcpResult({ content: [{ type: 'text', text: 'boom' }], isError: true })).toBe('ERROR: boom')
  })
  it('describes non-text content', () => {
    expect(renderMcpResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'x' }], isError: false })).toBe('[image image/png]')
  })
  it('handles empty content', () => {
    expect(renderMcpResult({ content: [], isError: false })).toBe('(no content)')
  })
})

describe('mcpToolsToFloomTools', () => {
  it('wraps each MCP tool into a FlowLoom Tool whose handler calls the client', async () => {
    const calls: { name: string; args: unknown }[] = []
    const fakeClient = {
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: `ran ${name}` }], isError: false }
      },
    }
    const tools = mcpToolsToFloomTools(fakeClient, 'srv', [
      { name: 'echo', description: 'd', inputSchema: { type: 'object', properties: { m: { type: 'string' } } } },
      { name: 'noschema' }, // 无 inputSchema → 退化为空 object schema
    ])
    expect(tools[0].spec.name).toBe('mcp__srv__echo')
    expect(tools[0].spec.description).toBe('d')
    expect(tools[1].spec.inputSchema).toEqual({ type: 'object', properties: {} })
    expect(tools[1].spec.description).toContain('noschema') // 无 description → 自动生成

    const out = await tools[0].handler({ m: 'hi' })
    expect(out).toBe('ran echo')
    expect(calls).toEqual([{ name: 'echo', args: { m: 'hi' } }]) // 用 MCP 原始名调用，而非命名空间名
  })
})
