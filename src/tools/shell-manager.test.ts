import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { BackgroundShells, makeBashOutputTool, makeKillShellTool } from './shell-manager.js'
import type { ChildProcess } from 'node:child_process'

// 伪子进程：EventEmitter + stdout/stderr + 记录 kill 信号。无 pid → killTree 跳过整树分支、
// 只调 proc.kill（确定性、无真实进程）。
function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter | null
    stderr: EventEmitter | null
    pid?: number
    killed: boolean
    signals: string[]
    kill: (sig?: string) => boolean
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.signals = []
  proc.kill = (sig = 'SIGTERM') => { proc.signals.push(sig); proc.killed = true; return true }
  return proc
}
const one = (proc: ReturnType<typeof fakeProc>) => () => proc as unknown as ChildProcess

describe('BackgroundShells', () => {
  it('starts a task and reads output incrementally (stdout + stderr)', () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('npm run dev')
    expect(id).toBe('bg_1')
    proc.stdout!.emit('data', 'listening on 3000\n')
    const r1 = mgr.read(id)
    expect(r1.output).toBe('listening on 3000\n')
    expect(r1.status).toBe('running')
    expect(mgr.read(id).output).toBe('') // 第二次只拿新输出
    proc.stderr!.emit('data', 'warn: x\n')
    expect(mgr.read(id).output).toBe('warn: x\n')
  })

  it('records exit status and code', () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('build')
    proc.emit('exit', 0)
    const r = mgr.read(id)
    expect(r.status).toBe('exited')
    expect(r.exitCode).toBe(0)
  })

  it('kill signals the process and the real exit marks it killed (not asserted prematurely)', () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('server')
    expect(mgr.kill(id)).toBe(true)
    expect(proc.signals).toContain('SIGTERM')
    expect(mgr.read(id).status).toBe('running') // 还没真正退出 → 不谎报 killed
    proc.emit('exit', null) // 进程响应信号退出
    expect(mgr.read(id).status).toBe('killed') // killRequested → killed
  })

  it('escalates to SIGKILL if SIGTERM is ignored past the grace period', () => {
    vi.useFakeTimers()
    try {
      const proc = fakeProc()
      const mgr = new BackgroundShells(one(proc))
      const id = mgr.start('stubborn')
      mgr.kill(id)
      expect(proc.signals).toContain('SIGTERM')
      expect(proc.signals).not.toContain('SIGKILL')
      vi.advanceTimersByTime(5000)
      expect(proc.signals).toContain('SIGKILL') // 宽限后升级
      expect(mgr.read(id).status).toBe('running') // 仍未 exit → 状态不臆断
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns not-found for unknown ids', () => {
    const mgr = new BackgroundShells(one(fakeProc()))
    expect(mgr.read('nope').found).toBe(false)
    expect(mgr.kill('nope')).toBe(false)
  })

  it('caps the buffer and shifts the read cursor', () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('spam')
    proc.stdout!.emit('data', 'a'.repeat(150_000)) // > 100k cap
    const r = mgr.read(id)
    expect(r.output.length).toBe(100_000) // 只保留最后 100k
  })

  it('killAll force-stops every running task', () => {
    const procs = [fakeProc(), fakeProc()]
    let i = 0
    const mgr = new BackgroundShells(() => procs[i++] as unknown as ChildProcess)
    mgr.start('a')
    mgr.start('b')
    mgr.killAll()
    expect(procs[0].signals).toContain('SIGKILL')
    expect(procs[1].signals).toContain('SIGKILL')
    expect(mgr.list().every((t) => t.status === 'killed')).toBe(true)
  })

  it('runningCount tracks only still-running tasks', () => {
    const procs: ReturnType<typeof fakeProc>[] = []
    const mgr = new BackgroundShells(() => { const p = fakeProc(); procs.push(p); return p as unknown as ChildProcess })
    expect(mgr.runningCount()).toBe(0)
    mgr.start('a')
    mgr.start('b')
    expect(mgr.runningCount()).toBe(2)
    procs[0].emit('exit', 0) // a 结束
    expect(mgr.runningCount()).toBe(1)
    procs[1].emit('exit', 0)
    expect(mgr.runningCount()).toBe(0)
  })

  it('caps the task map, evicting the oldest finished task', () => {
    const procs: ReturnType<typeof fakeProc>[] = []
    const mgr = new BackgroundShells(() => { const p = fakeProc(); procs.push(p); return p as unknown as ChildProcess }, 2)
    const a = mgr.start('a')
    procs[0].emit('exit', 0) // a 结束
    const b = mgr.start('b') // running
    const c = mgr.start('c') // size 已达 2 → 淘汰最旧的已结束任务 a
    expect(mgr.read(a).found).toBe(false) // a 被淘汰
    expect(mgr.read(b).found).toBe(true) // b 运行中，不淘汰
    expect(mgr.read(c).found).toBe(true)
  })

  it('refines a synthetic -1 exit code when a real exit follows an error', () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('x')
    proc.emit('error', new Error('post-spawn glitch')) // → exited, exitCode -1
    expect(mgr.read(id).exitCode).toBe(-1)
    proc.emit('exit', 3) // 真实退出码到达
    expect(mgr.read(id).exitCode).toBe(3)
  })

  it('records a diagnostic when no output streams are present', () => {
    const proc = fakeProc()
    proc.stdout = null
    proc.stderr = null
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('weird')
    expect(mgr.read(id).output).toContain('no output streams')
  })
})

describe('bash_output / kill_shell tools', () => {
  it('bash_output returns a status header + new output', async () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('dev')
    proc.stdout!.emit('data', 'hello\n')
    const out = await makeBashOutputTool(mgr).handler({ id })
    expect(out).toContain('[running]')
    expect(out).toContain('hello')
  })
  it('bash_output marks exit code once done', async () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('build')
    proc.emit('exit', 2)
    expect(await makeBashOutputTool(mgr).handler({ id })).toContain('exit=2')
  })
  it('bash_output errors on unknown id', async () => {
    const mgr = new BackgroundShells(one(fakeProc()))
    expect(await makeBashOutputTool(mgr).handler({ id: 'x' })).toMatch(/^ERROR/)
  })
  it('kill_shell requests termination and confirms', async () => {
    const proc = fakeProc()
    const mgr = new BackgroundShells(one(proc))
    const id = mgr.start('server')
    const out = await makeKillShellTool(mgr).handler({ id })
    expect(out).toMatch(/termination/)
    expect(proc.signals).toContain('SIGTERM')
  })
  it('kill_shell errors on unknown id', async () => {
    const mgr = new BackgroundShells(one(fakeProc()))
    expect(await makeKillShellTool(mgr).handler({ id: 'x' })).toMatch(/^ERROR/)
  })
})
