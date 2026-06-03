import { describe, it, expect, vi } from 'vitest'
import { createSpinner, stopActiveSpinner, Spinner } from './spinner.js'

describe('Spinner', () => {
  it('does not throw and stays silent when stderr is not a TTY', () => {
    // 测试环境下 stderr 通常非 TTY：enabled=false，不应写任何字节、不应抛错。
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const sp = new Spinner('Thinking...')
      sp.start()
      sp.text = 'Thinking... (1s)'
      sp.stop()
      sp.stop() // 幂等：重复 stop 不抛
      // 非 TTY 路径不写入
      if (!process.stderr.isTTY) expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('text is mutable (drives the rendered label)', () => {
    const sp = new Spinner('a')
    sp.text = 'b'
    expect(sp.text).toBe('b')
    sp.stop()
  })

  it('createSpinner registers an active spinner that stopActiveSpinner clears', () => {
    const sp = createSpinner('working')
    expect(sp).toBeInstanceOf(Spinner)
    // 不应抛；清理活跃 spinner
    expect(() => stopActiveSpinner()).not.toThrow()
  })

  it('animates by overwriting one line when stderr is a TTY', () => {
    const original = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const sp = new Spinner('Thinking...')
      sp.start()
      // 启动即渲染首帧（含回车 \r 行覆盖序列）
      expect(spy).toHaveBeenCalled()
      const firstFrame = spy.mock.calls[0][0] as string
      expect(firstFrame).toContain('\r')
      expect(firstFrame).toContain('Thinking...')
      sp.stop()
    } finally {
      spy.mockRestore()
      Object.defineProperty(process.stderr, 'isTTY', { value: original, configurable: true })
    }
  })
})
