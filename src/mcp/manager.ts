import type { Tool } from '../tools/types.js'
import type { McpConfig } from './config.js'
import { StdioTransport } from './transport.js'
import { McpClient } from './client.js'
import { mcpToolsToFloomTools } from './adapter.js'

export interface McpConnection {
  tools: Tool[] // 所有 server 适配出的工具，待注册进 registry
  summary: string[] // 每个 server 的连接结果（成功 N 个工具 / 失败原因）
  close: () => Promise<void> // 关闭所有 server 子进程
}

// 连接 .floom/mcp.json 里所有 server：spawn → 握手 → 列举工具 → 适配。
// 单个 server 失败（命令不存在/握手失败/超时）只记一行并跳过，绝不让整个 floom 崩。
export async function connectMcpServers(
  config: McpConfig,
  opts: { clientVersion?: string; onLog?: (s: string) => void } = {},
): Promise<McpConnection> {
  const tools: Tool[] = []
  const clients: McpClient[] = []
  const summary: string[] = []

  for (const [name, server] of Object.entries(config.mcpServers)) {
    try {
      const transport = new StdioTransport({
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        onStderr: () => {},
        onDisconnect: () => {
          opts.onLog?.(`MCP "${name}" disconnected — reconnecting...`)
          ;(async () => {
            try { await transport.restart(); await client.initialize(); opts.onLog?.(`MCP "${name}" reconnected`) }
            catch (e) { opts.onLog?.(`MCP "${name}" reconnect failed: ${(e as Error).message}`) }
          })()
        },
      })
      const client = new McpClient(transport, { clientName: 'flowloom', clientVersion: opts.clientVersion })
      await client.start()
      await client.initialize()
      const mcpTools = await client.listTools()
      tools.push(...mcpToolsToFloomTools(client, name, mcpTools))
      clients.push(client)
      summary.push(`${name}: ${mcpTools.length} tool(s)`)
    } catch (e) {
      summary.push(`${name}: failed (${(e as Error).message})`)
      opts.onLog?.(`MCP server "${name}" failed: ${(e as Error).message}`)
    }
  }

  return {
    tools,
    summary,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
    },
  }
}
