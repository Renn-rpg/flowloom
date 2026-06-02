// MCP SSE 传输：EventSource 接收 + HTTP POST 发送。
// 适用于 HTTP-based MCP servers（非 stdio 模式）。

import type { Transport } from './transport.js'
import { LineDecoder } from './protocol.js'

export interface SseTransportConfig {
  url: string
  headers?: Record<string, string>
  onLog?: (msg: string) => void
}

export class SseTransport implements Transport {
  private url: string
  private headers: Record<string, string>
  private onLog?: (msg: string) => void
  private handler: (msg: any) => void = () => {}
  private abort?: AbortController
  private endpoint?: string // 从 SSE endpoint 事件中获取的 POST URL

  constructor(cfg: SseTransportConfig) {
    this.url = cfg.url
    this.headers = cfg.headers ?? {}
    this.onLog = cfg.onLog
  }

  onMessage(handler: (msg: any) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.abort = new AbortController()
    const decoder = new LineDecoder()

    try {
      const res = await fetch(this.url, {
        headers: { ...this.headers, Accept: 'text/event-stream' },
        signal: this.abort.signal,
      })

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const textDecoder = new TextDecoder()

      // 异步读取 SSE 流
      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const text = textDecoder.decode(value, { stream: true })
            for (const line of text.split('\n')) {
              const trimmed = line.trim()
              if (trimmed.startsWith('data: ')) {
                const data = trimmed.slice(6)
                // 检查是否是 endpoint 事件
                if (data.startsWith('{') || data.startsWith('[')) {
                  try {
                    const msg = JSON.parse(data)
                    this.handler(msg)
                  } catch { /* skip non-JSON */ }
                }
              }
            }
          }
        } catch (e: any) {
          if (e?.name !== 'AbortError') {
            this.onLog?.(`SSE read error: ${e.message ?? String(e)}`)
          }
        }
      }
      readLoop() // fire-and-forget
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        throw new Error(`SSE connect failed: ${e.message ?? String(e)}`)
      }
    }
  }

  async send(msg: object): Promise<void> {
    const target = this.endpoint ?? this.url
    try {
      await fetch(target, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      })
    } catch (e: any) {
      this.onLog?.(`SSE send error: ${e.message ?? String(e)}`)
    }
  }

  async close(): Promise<void> {
    this.abort?.abort()
  }
}
