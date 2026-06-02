// MCP server 配置：.floom/mcp.json，沿用 Claude Desktop / Claude Code 的 "mcpServers" 形状。
// 无文件 = 无 server = 零行为变化。容错：坏 JSON / 非法条目被丢弃，不抛、不影响主流程。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface McpServerConfig {
  command: string // 必填：启动 server 的可执行（如 "npx" / "node" / 绝对路径）
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  disabled?: boolean // true 则跳过该 server
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

function sanitizeServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.command !== 'string' || r.command.trim() === '') return null
  const out: McpServerConfig = { command: r.command }
  if (Array.isArray(r.args)) out.args = r.args.filter((a): a is string => typeof a === 'string')
  if (r.env && typeof r.env === 'object') {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v
    }
    out.env = env
  }
  if (typeof r.cwd === 'string') out.cwd = r.cwd
  if (r.disabled === true) out.disabled = true
  return out
}

export function loadMcpConfig(dir: string): McpConfig {
  const mcpServers: Record<string, McpServerConfig> = {}
  try {
    const raw = readFileSync(resolve(dir, '.floom', 'mcp.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const servers = parsed?.mcpServers
    if (servers && typeof servers === 'object') {
      for (const [name, cfg] of Object.entries(servers)) {
        const clean = sanitizeServer(cfg)
        if (clean && !clean.disabled) mcpServers[name] = clean
      }
    }
  } catch {
    /* 无文件 / 坏 json → 无 server */
  }
  return { mcpServers }
}
