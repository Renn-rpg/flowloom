import { describe, it, expect } from 'vitest'
import { McpClient } from './client.js'
import type { Transport } from './transport.js'

// 假传输：记录发出的消息；对带 id 的请求用 responder 给出 result（或 error），异步回吐。
class FakeTransport implements Transport {
  sent: any[] = []
  private handler: (m: any) => void = () => {}
  constructor(private responder: (req: any) => { result?: any; error?: any }) {}
  onMessage(h: (m: any) => void) { this.handler = h }
  async start() {}
  send(msg: any) {
    this.sent.push(msg)
    if (msg.id != null) {
      const { result, error } = this.responder(msg)
      queueMicrotask(() => this.handler({ jsonrpc: '2.0', id: msg.id, result, error }))
    }
  }
  async close() {}
}

const okResponder = (req: any) => {
  switch (req.method) {
    case 'initialize':
      return { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'srv', version: '1.2.3' } } }
    case 'tools/list':
      return { result: { tools: [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } }
    case 'tools/call':
      return { result: { content: [{ type: 'text', text: 'pong' }], isError: false } }
    default:
      return { result: {} }
  }
}

describe('McpClient', () => {
  it('initialize stores serverInfo and sends notifications/initialized', async () => {
    const t = new FakeTransport(okResponder)
    const c = new McpClient(t)
    await c.start()
    await c.initialize()
    expect(c.serverInfo).toEqual({ name: 'srv', version: '1.2.3' })
    expect(c.capabilities).toEqual({ tools: {} })
    const init = t.sent.find((m) => m.method === 'initialize')
    expect(init.params.protocolVersion).toBe('2025-06-18')
    expect(init.params.clientInfo.name).toBe('flowloom')
    const note = t.sent.find((m) => m.method === 'notifications/initialized')
    expect(note).toBeTruthy()
    expect(note.id).toBeUndefined() // 通知无 id
  })

  it('listTools returns tools and follows nextCursor pagination', async () => {
    let page = 0
    const t = new FakeTransport((req) => {
      if (req.method === 'tools/list') {
        page++
        return page === 1
          ? { result: { tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'p2' } }
          : { result: { tools: [{ name: 'b', inputSchema: {} }] } }
      }
      return okResponder(req)
    })
    const c = new McpClient(t)
    await c.start()
    const tools = await c.listTools()
    expect(tools.map((x) => x.name)).toEqual(['a', 'b'])
    // 第二页请求带上了 cursor
    const second = t.sent.filter((m) => m.method === 'tools/list')[1]
    expect(second.params.cursor).toBe('p2')
  })

  it('callTool returns content and isError', async () => {
    const t = new FakeTransport(okResponder)
    const c = new McpClient(t)
    await c.start()
    const r = await c.callTool('echo', { msg: 'ping' })
    expect(r.content).toEqual([{ type: 'text', text: 'pong' }])
    expect(r.isError).toBe(false)
    const call = t.sent.find((m) => m.method === 'tools/call')
    expect(call.params).toEqual({ name: 'echo', arguments: { msg: 'ping' } })
  })

  it('rejects when the server returns a JSON-RPC error', async () => {
    const t = new FakeTransport((req) =>
      req.method === 'tools/call' ? { error: { code: -32602, message: 'Unknown tool' } } : okResponder(req),
    )
    const c = new McpClient(t)
    await c.start()
    await expect(c.callTool('nope', {})).rejects.toThrow(/Unknown tool/)
  })

  it('rejects on request timeout', async () => {
    const silent: Transport = { onMessage() {}, async start() {}, send() {}, async close() {} }
    const c = new McpClient(silent, { timeoutMs: 10 })
    await c.start()
    await expect(c.initialize()).rejects.toThrow(/timed out/)
  })
})
