// MCP 走 JSON-RPC 2.0；stdio 传输用「换行分隔的紧凑 JSON」（无 Content-Length 头，禁止内嵌换行）。
// 见 docs/deepseek 同款做法的 spec 引用：modelcontextprotocol.io/specification/.../basic/transports。
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

// 序列化为单行 + 换行结尾。JSON.stringify 不缩进，字符串内的换行会被转义为 \n，故不会产生内嵌真换行。
export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + '\n'
}

// 增量解码器：累积 stdout chunk，按 \n 切出完整消息并 JSON.parse；跳过空行与非 JSON 行（防 server 误写）。
export class LineDecoder {
  private buf = ''
  push(chunk: string): any[] {
    this.buf += chunk
    const out: any[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 非 JSON 行（server 把日志误写进 stdout 等）→ 跳过 */
      }
    }
    return out
  }
}
