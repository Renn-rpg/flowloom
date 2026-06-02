import { spawn, type ChildProcess } from 'node:child_process'
import { encodeMessage, LineDecoder } from './protocol.js'

// 传输抽象：把"如何收发 JSON-RPC 消息"与客户端逻辑解耦，便于用假传输单测 McpClient。
export interface Transport {
  start(): Promise<void>
  send(msg: object): void
  onMessage(handler: (msg: any) => void): void
  close(): Promise<void>
}

export interface StdioTransportConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  onStderr?: (s: string) => void
}

// stdio 传输：spawn 子进程，stdin 写、stdout 读（换行分隔 JSON），stderr 仅日志（不当错误）。
export class StdioTransport implements Transport {
  private child?: ChildProcess
  private decoder = new LineDecoder()
  private handler: (msg: any) => void = () => {}
  constructor(private cfg: StdioTransportConfig) {}

  onMessage(handler: (msg: any) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      cwd: this.cfg.cwd,
      shell: false, // 不经 shell，避免注入；命令/参数按 config 原样传
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const msg of this.decoder.push(chunk)) this.handler(msg)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (s: string) => this.cfg.onStderr?.(s)) // 仅日志
    // 等 spawn 成功或失败（命令不存在 → error）
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e) => reject(e))
    })
  }

  send(msg: object): void {
    this.child?.stdin?.write(encodeMessage(msg))
  }

  // 优雅关停：关 stdin → 等退出 → 超时则 SIGTERM（spec 的 stdio shutdown 流程）
  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve()
        }
      }
      child.once('exit', finish)
      const t = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        finish()
      }, 1000)
      t.unref?.()
    })
  }
}
