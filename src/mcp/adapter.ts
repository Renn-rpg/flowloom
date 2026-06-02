import type { Tool } from '../tools/types.js'
import type { McpClient, McpTool, McpCallResult } from './client.js'

const MAX_OUT = 50_000

// 把 MCP 工具名映射为对模型安全的函数名：mcp__<server>__<tool>，非 [A-Za-z0-9_-] 一律转 _。
export function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`
}

// 把 tools/call 的 content[] 拍平成给模型的字符串。isError:true 时加 ERROR 前缀（loop.ts 据此判 isError）。
export function renderMcpResult(result: McpCallResult): string {
  const parts: string[] = []
  for (const item of result.content) {
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else if (item?.type === 'image') parts.push(`[image ${item.mimeType ?? ''}]`)
    else if (item?.type === 'audio') parts.push(`[audio ${item.mimeType ?? ''}]`)
    else if (item?.type === 'resource_link') parts.push(`[resource_link ${item.uri ?? ''}]`)
    else if (item?.type === 'resource')
      parts.push(typeof item.resource?.text === 'string' ? item.resource.text : `[resource ${item.resource?.uri ?? ''}]`)
    else parts.push(`[${item?.type ?? 'unknown'} content]`)
  }
  let text = parts.join('\n')
  if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + '\n…[truncated]'
  if (result.isError) return `ERROR: ${text || 'MCP tool execution error'}`
  return text || '(no content)'
}

// 把一个 server 的 MCP 工具列表包装成 FlowLoom Tool[]，注册进 registry 后 agent 循环像用内置工具一样用它们。
// client 仅需 callTool（便于用假 client 单测）。
export function mcpToolsToFloomTools(
  client: Pick<McpClient, 'callTool'>,
  server: string,
  tools: McpTool[],
): Tool[] {
  return tools.map((t) => {
    const schema =
      t.inputSchema && typeof t.inputSchema === 'object'
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} }
    return {
      spec: {
        name: mcpToolName(server, t.name),
        description: t.description ?? `MCP tool "${t.name}" from server "${server}"`,
        inputSchema: schema,
      },
      handler: async (input: Record<string, unknown>) => renderMcpResult(await client.callTool(t.name, input)),
    }
  })
}
