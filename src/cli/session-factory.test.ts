import { describe, it, expect } from 'vitest'
import { makeInteractiveShell } from './session-factory.js'

// 这些测试在非 TTY 下运行：selectMenu 直接返回 -1（取消）→ 未授权。
// 故可在不弹菜单的前提下验证 isAuto 短路逻辑。
describe('makeInteractiveShell auto-accept', () => {
  it('auto-approves when isAuto() is true (no prompt)', async () => {
    const shell = makeInteractiveShell('', () => true)
    expect(await shell.authorize('rm -rf build')).toBe(true)
  })

  it('falls through to the prompt (denied in non-TTY) when isAuto() is false', async () => {
    const shell = makeInteractiveShell('', () => false)
    expect(await shell.authorize('ls')).toBe(false)
  })

  it('reflects live mode changes via the predicate', async () => {
    let auto = false
    const shell = makeInteractiveShell('', () => auto)
    expect(await shell.authorize('echo a')).toBe(false)
    auto = true
    expect(await shell.authorize('echo b')).toBe(true)
  })

  it('without a predicate behaves as before (denied in non-TTY)', async () => {
    const shell = makeInteractiveShell()
    expect(await shell.authorize('whoami')).toBe(false)
  })
})
