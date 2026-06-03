import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// 在 mock 之前保存原始环境变量
const originalEnv = { ...process.env }

// Mock child_process.spawn — 返回可控的 EventEmitter fake
const mockSpawn = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

import { StdioTransport } from './transport.js'
import type { Transport } from './transport.js'

// 给 EventEmitter 装上 setEncoding 方法，模拟 ReadStream 接口
function makeStream(): EventEmitter & { setEncoding: ReturnType<typeof vi.fn> } {
  const ee = new EventEmitter()
  return Object.assign(ee, { setEncoding: vi.fn() })
}

function fakeChild(opts?: {
  stdout?: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stderr?: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stdin?: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null
}) {
  const child = new EventEmitter() as any
  child.stdout = opts?.stdout ?? makeStream()
  child.stderr = opts?.stderr ?? makeStream()
  child.stdin = opts?.stdin ?? { write: vi.fn(), end: vi.fn() }
  child.kill = vi.fn()
  child.pid = 12345
  return child
}

// 辅助：快速关闭（emit exit 避免 1s 超时等待）
async function quickClose(t: StdioTransport, child: ReturnType<typeof fakeChild>) {
  const closeP = t.close()
  child.emit('exit', 0)
  await closeP
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('StdioTransport', () => {
  describe('start()', () => {
    it('spawns child process with command and args', async () => {
      const child = fakeChild()
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      const startP = t.start()
      child.emit('spawn')
      await startP

      expect(mockSpawn).toHaveBeenCalledWith('node', ['server.js'], expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }))
      await quickClose(t, child)
    })

    it('resolves when spawn event fires', async () => {
      const child = fakeChild()
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'echo', args: ['hello'] })
      const startP = t.start()
      child.emit('spawn')
      await expect(startP).resolves.toBeUndefined()
      await quickClose(t, child)
    })

    it('rejects when child process emits error', async () => {
      const child = fakeChild()
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'nonexistent-binary' })
      const startP = t.start()
      child.emit('error', new Error('ENOENT'))
      await expect(startP).rejects.toThrow('ENOENT')
    })

    it('sets shell to false (no command injection)', async () => {
      const child = fakeChild()
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      const startP = t.start()
      child.emit('spawn')
      await startP

      expect(mockSpawn.mock.calls[0][2].shell).toBe(false)
      await quickClose(t, child)
    })
  })

  describe('stdout parsing', () => {
    it('decodes JSON lines from stdout and passes to onMessage handler', async () => {
      const stdout = makeStream()
      const child = fakeChild({ stdout })
      mockSpawn.mockReturnValue(child)

      const handler = vi.fn()
      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      t.onMessage(handler)

      const startP = t.start()
      child.emit('spawn')
      await startP

      stdout.emit('data', '{"jsonrpc":"2.0","id":1,"result":{"name":"test"}}\n')
      expect(handler).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, result: { name: 'test' } })
      await quickClose(t, child)
    })

    it('handles multiple JSON messages in a single chunk', async () => {
      const stdout = makeStream()
      const child = fakeChild({ stdout })
      mockSpawn.mockReturnValue(child)

      const handler = vi.fn()
      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      t.onMessage(handler)

      const startP = t.start()
      child.emit('spawn')
      await startP

      stdout.emit('data', '{"id":1}\n{"id":2}\n{"id":3}\n')
      expect(handler).toHaveBeenCalledTimes(3)
      expect(handler).toHaveBeenNthCalledWith(1, { id: 1 })
      expect(handler).toHaveBeenNthCalledWith(2, { id: 2 })
      expect(handler).toHaveBeenNthCalledWith(3, { id: 3 })
      await quickClose(t, child)
    })

    it('handles chunked messages (split across multiple data events)', async () => {
      const stdout = makeStream()
      const child = fakeChild({ stdout })
      mockSpawn.mockReturnValue(child)

      const handler = vi.fn()
      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      t.onMessage(handler)

      const startP = t.start()
      child.emit('spawn')
      await startP

      stdout.emit('data', '{"jsonrpc":"2.')
      stdout.emit('data', '0","id":42,"result":"ok"}\n')
      expect(handler).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 42, result: 'ok' })
      await quickClose(t, child)
    })

    it('skips empty lines', async () => {
      const stdout = makeStream()
      const child = fakeChild({ stdout })
      mockSpawn.mockReturnValue(child)

      const handler = vi.fn()
      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      t.onMessage(handler)

      const startP = t.start()
      child.emit('spawn')
      await startP

      stdout.emit('data', '\n\n{"id":1}\n\n')
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ id: 1 })
      await quickClose(t, child)
    })

    it('skips non-JSON lines (server log noise on stdout)', async () => {
      const stdout = makeStream()
      const child = fakeChild({ stdout })
      mockSpawn.mockReturnValue(child)

      const handler = vi.fn()
      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      t.onMessage(handler)

      const startP = t.start()
      child.emit('spawn')
      await startP

      stdout.emit('data', 'Server starting...\n{"id":1}\nDEBUG: connected\n')
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ id: 1 })
      await quickClose(t, child)
    })
  })

  describe('stderr routing', () => {
    it('routes stderr output to onStderr callback', async () => {
      const stderr = makeStream()
      const child = fakeChild({ stderr })
      mockSpawn.mockReturnValue(child)

      const onStderr = vi.fn()
      const t = new StdioTransport({ command: 'node', args: ['server.js'], onStderr })

      const startP = t.start()
      child.emit('spawn')
      await startP

      stderr.emit('data', 'some debug log\n')
      expect(onStderr).toHaveBeenCalledWith('some debug log\n')
      await quickClose(t, child)
    })

    it('does not crash when onStderr is not provided', async () => {
      const stderr = makeStream()
      const child = fakeChild({ stderr })
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })

      const startP = t.start()
      child.emit('spawn')
      await startP

      expect(() => stderr.emit('data', 'log message\n')).not.toThrow()
      await quickClose(t, child)
    })
  })

  describe('send()', () => {
    it('writes JSON-RPC message to child stdin', async () => {
      const stdin = { write: vi.fn(), end: vi.fn() }
      const child = fakeChild({ stdin })
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      const startP = t.start()
      child.emit('spawn')
      await startP

      const msg = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
      t.send(msg)
      expect(stdin.write).toHaveBeenCalledWith(JSON.stringify(msg) + '\n')
      await quickClose(t, child)
    })

    it('is a no-op when child has not been started', () => {
      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      expect(() => t.send({ id: 1 })).not.toThrow()
    })

    it('is a no-op when stdin is null (child closed stdin)', async () => {
      const child = fakeChild({ stdin: null })
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      const startP = t.start()
      child.emit('spawn')
      await startP

      expect(() => t.send({ id: 1 })).not.toThrow()
      await quickClose(t, child)
    })
  })

  describe('close()', () => {
    it('ends stdin and resolves on exit event', async () => {
      const stdin = { write: vi.fn(), end: vi.fn() }
      const child = fakeChild({ stdin })
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      const startP = t.start()
      child.emit('spawn')
      await startP

      stdin.end.mockClear()
      const closeP = t.close()
      expect(stdin.end).toHaveBeenCalled()

      child.emit('exit', 0)
      await expect(closeP).resolves.toBeUndefined()
    })

    it('sends SIGTERM if child does not exit within 1 second', async () => {
      vi.useFakeTimers()
      try {
        const stdin = { write: vi.fn(), end: vi.fn() }
        const child = fakeChild({ stdin })
        mockSpawn.mockReturnValue(child)

        const t = new StdioTransport({ command: 'node', args: ['server.js'] })
        const startP = t.start()
        child.emit('spawn')
        await startP

        const closeP = t.close()
        vi.advanceTimersByTime(1000)
        expect(child.kill).toHaveBeenCalledWith('SIGTERM')
        await expect(closeP).resolves.toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is a no-op when child was never started', async () => {
      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      await expect(t.close()).resolves.toBeUndefined()
    })

    it('does not throw when stdin.end() fails', async () => {
      const child = fakeChild({ stdin: null })
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      const startP = t.start()
      child.emit('spawn')
      await startP

      const closeP = t.close()
      child.emit('exit', 1)
      await expect(closeP).resolves.toBeUndefined()
    })

    it('does not throw when kill() fails (already dead process)', async () => {
      vi.useFakeTimers()
      try {
        const stdin = { write: vi.fn(), end: vi.fn() }
        const child = fakeChild({ stdin })
        child.kill = vi.fn(() => { throw new Error('ESRCH: no such process') })
        mockSpawn.mockReturnValue(child)

        const t = new StdioTransport({ command: 'node', args: ['server.js'] })
        const startP = t.start()
        child.emit('spawn')
        await startP

        const closeP = t.close()
        vi.advanceTimersByTime(1000)
        await expect(closeP).resolves.toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('environment filtering', () => {
    it('passes whitelisted environment variables to child', async () => {
      process.env.PATH = '/usr/bin'
      process.env.HOME = '/home/user'
      process.env.NODE_ENV = 'production'
      process.env.DEEPSEEK_API_KEY = 'sk-secret'
      process.env.AWS_SECRET = 'topsecret'

      const child = fakeChild()
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'] })
      const startP = t.start()
      child.emit('spawn')
      await startP

      const childEnv = mockSpawn.mock.calls[0][2].env
      expect(childEnv.PATH).toBe('/usr/bin')
      expect(childEnv.HOME).toBe('/home/user')
      expect(childEnv.NODE_ENV).toBe('production')
      expect(childEnv.DEEPSEEK_API_KEY).toBeUndefined()
      expect(childEnv.AWS_SECRET).toBeUndefined()
      await quickClose(t, child)
    })

    it('allows user-specified env to override and extend', async () => {
      process.env.PATH = '/usr/bin'
      process.env.NODE_ENV = 'production'

      const child = fakeChild()
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({
        command: 'node',
        args: ['server.js'],
        env: { NODE_ENV: 'development', MY_CUSTOM_VAR: 'custom-value' },
      })
      const startP = t.start()
      child.emit('spawn')
      await startP

      const childEnv = mockSpawn.mock.calls[0][2].env
      expect(childEnv.NODE_ENV).toBe('development')
      expect(childEnv.MY_CUSTOM_VAR).toBe('custom-value')
      expect(childEnv.PATH).toBe('/usr/bin')
      await quickClose(t, child)
    })

    it('passes cwd option to spawn', async () => {
      const child = fakeChild()
      mockSpawn.mockReturnValue(child)

      const t = new StdioTransport({ command: 'node', args: ['server.js'], cwd: '/tmp/mcp' })
      const startP = t.start()
      child.emit('spawn')
      await startP

      expect(mockSpawn.mock.calls[0][2].cwd).toBe('/tmp/mcp')
      await quickClose(t, child)
    })
  })

  describe('Transport interface compliance', () => {
    it('implements all Transport methods', () => {
      const t: Transport = new StdioTransport({ command: 'echo' })
      expect(typeof t.start).toBe('function')
      expect(typeof t.send).toBe('function')
      expect(typeof t.onMessage).toBe('function')
      expect(typeof t.close).toBe('function')
    })
  })

})
