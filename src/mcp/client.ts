import type { Transport } from './transport.js'

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}
export interface McpCallResult {
  content: any[]
  isError: boolean
  structuredContent?: unknown
}

// 我们请求时声明的 MCP 协议版本。spec 规定 server 支持则回同版本，否则回它支持的版本；
// 本最小客户端容忍版本差异（tools/list、tools/call 在各版本稳定），不因不识别就断开。
export const PROTOCOL_VERSION = '2025-06-18'
const MAX_PAGES = 50 // tools/list 分页保险丝

// 最小 MCP 客户端：传输注入（便于单测），管理 JSON-RPC id ↔ pending promise，完成握手并列举/调用工具。
export class McpClient {
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  serverInfo?: { name?: string; version?: string }
  capabilities?: Record<string, unknown>

  constructor(
    private transport: Transport,
    private opts: { timeoutMs?: number; clientName?: string; clientVersion?: string } = {},
  ) {}

  async start(): Promise<void> {
    this.transport.onMessage((m) => this.handle(m))
    await this.transport.start()
  }

  private handle(msg: any): void {
    // 只处理"对我请求的响应"（带 id 且有 result/error）；通知（无 id）对最小客户端忽略。
    if (msg && typeof msg === 'object' && msg.id != null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    }
  }

  private request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    const timeoutMs = this.opts.timeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.transport.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.transport.send({ jsonrpc: '2.0', method, params })
  }

  // 握手：initialize → 存 serverInfo/capabilities → 发 notifications/initialized
  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.opts.clientName ?? 'flowloom', version: this.opts.clientVersion ?? '0.0.0' },
    })
    this.serverInfo = result?.serverInfo
    this.capabilities = result?.capabilities
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {})
      if (Array.isArray(result?.tools)) tools.push(...result.tools)
      cursor = result?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args ?? {} })
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: result?.isError === true,
      structuredContent: result?.structuredContent,
    }
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP client closed'))
    }
    this.pending.clear()
    await this.transport.close()
  }
}
