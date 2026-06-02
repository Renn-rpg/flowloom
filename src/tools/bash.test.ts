import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { makeBashTool } from './bash.js'
import { allowAllShell, denyAllShell, confirmShell } from './permissions.js'
import { BackgroundShells } from './shell-manager.js'

describe('makeBashTool shell policy gating', () => {
  it('blocks the command (no execution) when policy denies', async () => {
    const tool = makeBashTool(denyAllShell)
    const out = await tool.handler({ command: 'echo should-not-run' })
    expect(out).toContain('not authorized')
  })

  it('passes the gate when policy allows', async () => {
    const tool = makeBashTool(allowAllShell)
    const out = await tool.handler({ command: 'echo flowloom-allows' })
    // 放行的关键证明：没有被权限门禁拦下（不含 "not authorized"）
    expect(out).not.toContain('not authorized')
  })

  it('uses the confirm callback to decide per command', async () => {
    const tool = makeBashTool(confirmShell((cmd) => cmd.startsWith('echo')))
    const allowed = await tool.handler({ command: 'echo ok' })
    const blocked = await tool.handler({ command: 'curl http://evil' })
    expect(allowed).not.toContain('not authorized')
    expect(blocked).toContain('not authorized')
  })
})

describe('makeBashTool background mode', () => {
  function fakeProc() {
    const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    p.kill = () => true
    return p
  }

  it('background:true hands off to the manager and returns a task id (does not block)', async () => {
    const started: string[] = []
    const mgr = new BackgroundShells(() => { started.push('spawned'); return fakeProc() as unknown as ChildProcess })
    const tool = makeBashTool(allowAllShell, mgr)
    const out = await tool.handler({ command: 'npm run dev', background: true })
    expect(out).toContain('bg_1')
    expect(out).toContain('bash_output')
    expect(started).toHaveLength(1)
  })

  it('background still respects the shell gate', async () => {
    const mgr = new BackgroundShells(() => fakeProc() as unknown as ChildProcess)
    const tool = makeBashTool(denyAllShell, mgr)
    expect(await tool.handler({ command: 'npm run dev', background: true })).toContain('not authorized')
  })

  it('errors if background requested without a manager', async () => {
    const tool = makeBashTool(allowAllShell) // no manager
    expect(await tool.handler({ command: 'x', background: true })).toMatch(/^ERROR: background/)
  })
})
