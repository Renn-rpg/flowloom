import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpConfig } from './config.js'

// Mock 依赖模块
vi.mock('./transport.js', () => ({ StdioTransport: vi.fn() }))
vi.mock('./client.js', () => ({ McpClient: vi.fn() }))
vi.mock('./adapter.js', () => ({
  mcpToolsToFloomTools: (_client: unknown, name: string, tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) =>
    tools.map(t => ({
      spec: { name: `${name}_${t.name}`, description: t.description ?? '', inputSchema: t.inputSchema ?? {} },
      handler: async () => 'ok',
    })),
}))

import { connectMcpServers } from './manager.js'
import { McpClient } from './client.js'

function makeConfig(servers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }>): McpConfig {
  return { mcpServers: servers } as McpConfig
}

function makeMock(opts?: { start?: () => Promise<void>; listTools?: () => Promise<Array<{ name: string }>>; close?: () => Promise<void> }) {
  const mock = {
    start: opts?.start ?? (async () => {}),
    initialize: async () => {},
    listTools: opts?.listTools ?? (async () => [{ name: 'tool1' }]),
    close: opts?.close ?? vi.fn(async () => {}),
  }
  vi.mocked(McpClient).mockImplementation(() => mock as any)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('connectMcpServers', () => {
  it('returns empty connection for empty config', async () => {
    const conn = await connectMcpServers(makeConfig({}))
    expect(conn.tools).toHaveLength(0)
    expect(conn.summary).toHaveLength(0)
    await conn.close()
  })

  it('connects single server and returns its tools', async () => {
    makeMock()
    const conn = await connectMcpServers(makeConfig({ test: { command: 'node', args: ['server.js'] } }))
    expect(conn.tools).toHaveLength(1)
    expect(conn.tools[0].spec.name).toBe('test_tool1')
    expect(conn.summary).toContain('test: 1 tool(s)')
    await conn.close()
  })

  it('connects multiple servers and collects all tools', async () => {
    makeMock({ listTools: async () => [{ name: 't1' }, { name: 't2' }] })
    const conn = await connectMcpServers(makeConfig({ s1: { command: 'a' }, s2: { command: 'b' } }))
    expect(conn.tools).toHaveLength(4)
    expect(conn.summary).toHaveLength(2)
    await conn.close()
  })

  it('single server failure does not block other servers', async () => {
    let call = 0
    vi.mocked(McpClient).mockImplementation(() => {
      call++
      if (call === 1) throw new Error('spawn failed')
      return { start: async () => {}, initialize: async () => {}, listTools: async () => [{ name: 'ok' }], close: vi.fn(async () => {}) } as any
    })
    const onLog = vi.fn()
    const conn = await connectMcpServers(makeConfig({ bad: { command: 'x' }, good: { command: 'y' } }), { onLog })
    expect(conn.tools).toHaveLength(1)
    expect(conn.tools[0].spec.name).toBe('good_ok')
    expect(conn.summary[0]).toContain('failed')
    expect(onLog).toHaveBeenCalled()
    await conn.close()
  })

  it('close() calls close on all connected clients', async () => {
    const c1 = vi.fn(async () => {})
    const c2 = vi.fn(async () => {})
    let idx = 0
    vi.mocked(McpClient).mockImplementation(() => {
      idx++
      return { start: async () => {}, initialize: async () => {}, listTools: async () => [{ name: 't' }], close: idx === 1 ? c1 : c2 } as any
    })
    const conn = await connectMcpServers(makeConfig({ a: { command: 'a' }, b: { command: 'b' } }))
    await conn.close()
    expect(c1).toHaveBeenCalled()
    expect(c2).toHaveBeenCalled()
  })

  it('close() does not throw when individual client close fails', async () => {
    vi.mocked(McpClient).mockImplementation(() => ({
      start: async () => {}, initialize: async () => {}, listTools: async () => [{ name: 't' }],
      close: async () => { throw new Error('close failed') },
    }) as any)
    const conn = await connectMcpServers(makeConfig({ a: { command: 'a' } }))
    await expect(conn.close()).resolves.toBeUndefined()
  })
})
