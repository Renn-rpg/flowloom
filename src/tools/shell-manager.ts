// 后台 shell 管理：run_shell(background:true) 启动的长跑命令（dev server / watch / build）
// 由这里管理——不阻塞 agent，输出累积进环形缓冲，bash_output 增量读取、kill_shell 终止。
// 进程退出/被杀都记录状态；floom 退出时 killAll 清理（整树，不留孤儿）。
//
// spawner 可注入（便于单测用伪进程，确定性、无真实子进程）。

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { Tool } from './types.js'

const MAX_BUF = 100_000 // 单任务输出缓冲上限，超出丢最旧（防长跑任务吃内存）
const MAX_TASKS = 100 // 任务表上限，超出淘汰最旧的已结束任务（防长会话泄漏）
const KILL_GRACE_MS = 5_000 // SIGTERM 后宽限，超时升级 SIGKILL

export type ShellSpawner = (command: string) => ChildProcess

// 平台 shell 启动器：win32 用 pwsh，否则 bash（与 makeBashTool 前台路径一致）。
// posix 用 detached 让子进程自成进程组，便于按组「整树」终止（杀 bash 包装不漏其子进程）；
// win32 不 detached（避免新开控制台窗口），终止改用 taskkill /T 按 pid 杀整树。
export const defaultShellSpawner: ShellSpawner = (command) => {
  const win = process.platform === 'win32'
  const sh = win ? 'pwsh' : 'bash'
  const args = win ? ['-NoProfile', '-Command', command] : ['-c', command]
  return nodeSpawn(sh, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: !win })
}

// 整树终止：连同包装 shell 的子进程（dev server 等）一起杀，而非只杀包装进程。
// force=false 优雅（SIGTERM / taskkill），force=true 强制（SIGKILL / taskkill /F）。
function killTree(proc: ChildProcess, force: boolean): void {
  const sig: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM'
  if (proc.pid) {
    if (process.platform === 'win32') {
      const args = ['/pid', String(proc.pid), '/T']
      if (force) args.push('/F')
      try {
        nodeSpawn('taskkill', args, { stdio: 'ignore' })
      } catch {
        /* taskkill 不可用 → 退回直接信号 */
      }
    } else {
      try {
        process.kill(-proc.pid, sig) // 负 pid = 终止整个进程组（依赖 detached）
      } catch {
        /* 组已不存在 */
      }
    }
  }
  // 同时直接给子进程发信号（伪进程测试 + 真进程兜底）
  try {
    proc.kill(sig)
  } catch {
    /* 已退出 */
  }
}

type BgStatus = 'running' | 'exited' | 'killed'

interface BgTask {
  id: string
  command: string
  buffer: string
  cursor: number // bash_output 已读到的位置（增量读取）
  status: BgStatus
  exitCode: number | null
  killRequested: boolean // 是否已请求终止（决定终态是 killed 还是 exited）
  killTimer: ReturnType<typeof setTimeout> | null
  proc: ChildProcess
}

export interface BashReadResult {
  found: boolean
  output: string
  status: BgStatus | 'unknown'
  exitCode: number | null
}

export class BackgroundShells {
  private tasks = new Map<string, BgTask>()
  private seq = 0
  constructor(
    private spawner: ShellSpawner = defaultShellSpawner,
    private maxTasks: number = MAX_TASKS,
  ) {}

  start(command: string): string {
    this.evictIfNeeded()
    const id = `bg_${++this.seq}`
    const proc = this.spawner(command)
    const task: BgTask = {
      id,
      command,
      buffer: '',
      cursor: 0,
      status: 'running',
      exitCode: null,
      killRequested: false,
      killTimer: null,
      proc,
    }
    const append = (chunk: unknown) => {
      task.buffer += typeof chunk === 'string' ? chunk : String(chunk)
      if (task.buffer.length > MAX_BUF) {
        const drop = task.buffer.length - MAX_BUF
        task.buffer = task.buffer.slice(drop)
        task.cursor = Math.max(0, task.cursor - drop) // 同步右移读取游标
      }
    }
    if (proc.stdout) proc.stdout.on('data', append)
    if (proc.stderr) proc.stderr.on('data', append)
    // 期望管道却拿不到流 → 记一行诊断，避免"永远 running 且空输出"无从察觉
    if (!proc.stdout && !proc.stderr) append('[no output streams captured]\n')
    proc.on('error', (e: Error) => {
      append(`\n[spawn error] ${e.message}\n`)
      if (task.status === 'running') {
        task.status = 'exited'
        task.exitCode = task.exitCode ?? -1
      }
    })
    proc.on('exit', (code: number | null) => {
      if (task.killTimer) {
        clearTimeout(task.killTimer)
        task.killTimer = null
      }
      if (task.status === 'running') {
        task.status = task.killRequested ? 'killed' : 'exited'
        task.exitCode = code
      } else if (task.exitCode === -1 && typeof code === 'number') {
        task.exitCode = code // 用真实退出码修正 error 路径写入的合成 -1
      }
    })
    this.tasks.set(id, task)
    return id
  }

  // 读取自上次以来的新输出（并推进游标）。
  read(id: string): BashReadResult {
    const t = this.tasks.get(id)
    if (!t) return { found: false, output: '', status: 'unknown', exitCode: null }
    const output = t.buffer.slice(t.cursor)
    t.cursor = t.buffer.length
    return { found: true, output, status: t.status, exitCode: t.exitCode }
  }

  // 请求终止：先优雅，宽限后未退出则强制升级。**不在此处臆断 killed**——终态由真实 exit 事件落定，
  // 否则一个忽略 SIGTERM 的进程会被谎报为 killed 而其实仍在跑。
  kill(id: string): boolean {
    const t = this.tasks.get(id)
    if (!t) return false
    if (t.status === 'running' && !t.killRequested) {
      t.killRequested = true
      killTree(t.proc, false)
      t.killTimer = setTimeout(() => {
        if (t.status === 'running') killTree(t.proc, true)
      }, KILL_GRACE_MS)
      t.killTimer.unref?.()
    }
    return true
  }

  list(): { id: string; command: string; status: BgStatus }[] {
    return [...this.tasks.values()].map((t) => ({ id: t.id, command: t.command, status: t.status }))
  }

  // 仍在运行的后台任务数（供状态栏显示「N bg」提醒,避免起了 server 却忘记）。
  runningCount(): number {
    let n = 0
    for (const t of this.tasks.values()) if (t.status === 'running') n++
    return n
  }

  // floom 退出时强制清理所有仍在跑的后台进程（整树）。退出在即，直接强制 + 据实标记。
  killAll(): void {
    for (const t of this.tasks.values()) {
      if (t.killTimer) {
        clearTimeout(t.killTimer)
        t.killTimer = null
      }
      if (t.status === 'running') {
        t.killRequested = true
        killTree(t.proc, true)
        t.status = 'killed'
      }
    }
  }

  // 任务表上限：超出则淘汰最旧的已结束任务（运行中的永不淘汰）。
  private evictIfNeeded(): void {
    if (this.tasks.size < this.maxTasks) return
    for (const [k, t] of this.tasks) {
      if (t.status !== 'running') {
        this.tasks.delete(k)
        return
      }
    }
  }
}

// ——— 工具：bash_output / kill_shell ———

export function makeBashOutputTool(manager: BackgroundShells): Tool {
  return {
    spec: {
      name: 'bash_output',
      description:
        'Read new output from a background shell previously started with run_shell (background:true). ' +
        'Returns output produced since your last read, plus the task status (running / exited / killed). ' +
        'Poll this to watch a long-running command (server, build, test watcher).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'background task id, e.g. "bg_1"' } },
        required: ['id'],
      },
    },
    handler: async (i) => {
      const id = String(i.id ?? '')
      const res = manager.read(id)
      if (!res.found) return `ERROR: no background shell with id "${id}"`
      const head =
        res.status === 'running'
          ? '[running]'
          : `[${res.status}${res.exitCode != null ? ` exit=${res.exitCode}` : ''}]`
      const body = res.output || '(no new output)'
      return `${head}\n${body}`.slice(0, 10_000)
    },
  }
}

export function makeKillShellTool(manager: BackgroundShells): Tool {
  return {
    spec: {
      name: 'kill_shell',
      description: 'Terminate (SIGTERM, escalating to SIGKILL) a background shell started with run_shell (background:true).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'background task id, e.g. "bg_1"' } },
        required: ['id'],
      },
    },
    handler: async (i) => {
      const id = String(i.id ?? '')
      return manager.kill(id)
        ? `Requested termination of background shell ${id} (poll bash_output to confirm it exits).`
        : `ERROR: no background shell with id "${id}"`
    },
  }
}
