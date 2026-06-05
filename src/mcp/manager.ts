import type { Tool } from '../tools/types.js'
import type { McpConfig } from './config.js'
import { StdioTransport } from './transport.js'
import { McpClient } from './client.js'
import { mcpToolsToFloomTools } from './adapter.js'

export interface McpConnection {
  tools: Tool[]
  summary: string[]
  close: () => Promise<void>
}

// 心跳管理器：每 30s 发送 ping，连续 3 次失败触发重连。
class HeartbeatManager {
  private timer: ReturnType<typeof setInterval> | null = null
  private failures = 0
  private readonly maxFailures: number
  private readonly intervalMs: number

  constructor(
    private client: McpClient,
    private name: string,
    private onLog: (s: string) => void,
    private onDead: () => void,
    opts?: { intervalMs?: number; maxFailures?: number },
  ) {
    this.intervalMs = opts?.intervalMs ?? 30_000
    this.maxFailures = opts?.maxFailures ?? 3
  }

  start(): void {
    if (this.timer) return
    // 若 client 不支持 ping（如单测 mock），跳过心跳
    if (typeof this.client.ping !== 'function') return
    this.timer = setInterval(async () => {
      try {
        const ok = await this.client.ping()
        if (ok) { this.failures = 0; return }
      } catch { /* ping 抛异常视为失败 */ }
      this.failures++
      this.onLog(`MCP "${this.name}" heartbeat failed (${this.failures}/${this.maxFailures})`)
      if (this.failures >= this.maxFailures) {
        this.stop()
        this.onLog(`MCP "${this.name}" unresponsive — triggering reconnect`)
        this.onDead()
      }
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.failures = 0
  }
}

export async function connectMcpServers(
  config: McpConfig,
  opts: { clientVersion?: string; onLog?: (s: string) => void } = {},
): Promise<McpConnection> {
  const tools: Tool[] = []
  const clients: McpClient[] = []
  const summary: string[] = []
  const heartbeats: HeartbeatManager[] = []

  const log = (s: string) => opts.onLog?.(s)

  for (const [name, server] of Object.entries(config.mcpServers)) {
    // 用可变引用让 onDisconnect 和 onDead 都能在 transport/client 定义前被引用
    let hb: HeartbeatManager | null = null
    let transport: StdioTransport | null = null
    let client: McpClient | null = null

    // 重连调度器：指数退避，最多 3 次
    const scheduleReconnect = (attempt: number) => {
      if (attempt >= 3) {
        log(`MCP "${name}" reconnect exhausted after 3 attempts`)
        return
      }
      const delay = 1000 * Math.pow(2, attempt)
      setTimeout(async () => {
        try {
          if (!transport || !client) return
          await transport.restart()
          await client.initialize()
          log(`MCP "${name}" reconnected`)
          hb?.start()
        } catch (e) {
          log(`MCP "${name}" reconnect attempt ${attempt + 1} failed: ${(e as Error).message}`)
          scheduleReconnect(attempt + 1)
        }
      }, delay).unref?.()
    }

    try {
      transport = new StdioTransport({
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        onStderr: (s) => log(`MCP "${name}" stderr: ${s.trim()}`),
        onDisconnect: () => {
          log(`MCP "${name}" disconnected — reconnecting...`)
          hb?.stop()
          scheduleReconnect(0)
        },
      })
      const _client = new McpClient(transport, { clientName: 'flowloom', clientVersion: opts.clientVersion })
      client = _client
      await _client.start()
      await _client.initialize()
      const mcpTools = await _client.listTools()
      tools.push(...mcpToolsToFloomTools(_client, name, mcpTools))
      clients.push(_client)
      summary.push(`${name}: ${mcpTools.length} tool(s)`)

      // 启动心跳（在 transport/client 就绪后）
      hb = new HeartbeatManager(client, name, log, () => scheduleReconnect(0))
      hb.start()
      heartbeats.push(hb)
    } catch (e) {
      summary.push(`${name}: failed (${(e as Error).message})`)
      log(`MCP server "${name}" failed: ${(e as Error).message}`)
    }
  }

  return {
    tools,
    summary,
    close: async () => {
      for (const hb of heartbeats) hb.stop()
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
    },
  }
}
