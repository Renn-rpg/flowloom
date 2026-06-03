import { spawn, type ChildProcess } from 'node:child_process'
import { encodeMessage, LineDecoder } from './protocol.js'

// MCP 子进程不应继承宿主进程的凭据类环境变量。
// 白名单放行系统基础变量 + 用户显式配置的 env；其余一律不传递。
const MCP_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'USERPROFILE', 'TMP', 'TMPDIR', 'TEMP',
  'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_PATH', 'NODE_ENV',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', // Windows
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', // Linux
])

function buildChildEnv(userEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of MCP_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!
  }
  if (userEnv) Object.assign(env, userEnv)
  return env
}

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
  onDisconnect?: () => void // 子进程意外退出回调
}

// stdio 传输：spawn 子进程，stdin 写、stdout 读（换行分隔 JSON），stderr 仅日志。
// 支持进程退出检测 + restart() 重连。
export class StdioTransport implements Transport {
  private child?: ChildProcess
  private decoder = new LineDecoder()
  private handler: (msg: any) => void = () => {}
  private _closing: Promise<void> | null = null
  private _exited = false
  constructor(private cfg: StdioTransportConfig) {}

  get isConnected(): boolean { return !!this.child && !this._exited }

  onMessage(handler: (msg: any) => void): void { this.handler = handler }

  async start(): Promise<void> { await this._spawn() }

  async restart(): Promise<void> {
    if (this._closing) return
    this._exited = false; this._closing = null
    for (let i = 0; i < 3; i++) {
      try { await this._spawn(); return } catch {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
    throw new Error(`MCP restart failed after 3 attempts: ${this.cfg.command}`)
  }

  private async _spawn(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(this.cfg.env),
      cwd: this.cfg.cwd, shell: false,
    })
    this.child = child; this._exited = false
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const msg of this.decoder.push(chunk)) {
        try { this.handler(msg) } catch { /* ignore */ }
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (s: string) => {
      try { this.cfg.onStderr?.(s) } catch { /* ignore */ }
    })
    child.on('exit', () => {
      if (this.child !== child) return // 忽略旧子进程的 exit 事件
      if (!this._closing) { this._exited = true; this.cfg.onDisconnect?.() }
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e) => reject(e))
    })
  }

  send(msg: object): void { this.child?.stdin?.write(encodeMessage(msg)) }

  close(): Promise<void> {
    if (this._closing) return this._closing
    const child = this.child
    if (!child) return Promise.resolve()
    this._closing = new Promise<void>((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; try { child.stdin?.end() } catch {}; resolve() }
      child.once('exit', () => finish())
      const t = setTimeout(() => { try { child.kill('SIGTERM') } catch {}; finish() }, 1000)
      t.unref?.()
      try { child.stdin?.end() } catch {}
    }).finally(() => { this._closing = null }) // 完成后清理，允许 restart
    return this._closing
  }
}
