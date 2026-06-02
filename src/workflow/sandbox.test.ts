import { describe, it, expect } from 'vitest'
import { NodeVmRuntime } from './sandbox.js'

describe('NodeVmRuntime', () => {
  const rt = new NodeVmRuntime()

  it('injected functions are callable from sandbox via runInSandbox', async () => {
    const ctx = rt.createContext({ greet: async (name: string) => `Hello ${name}` })
    const result = await ctx.runInSandbox(async function () { return await (globalThis as any).greet('world') })
    expect(result).toBe('Hello world')
  })

  it('Date.now() throws inside sandbox', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runInSandbox(function () { Date.now() })).rejects.toThrow()
  })

  it('Math.random() throws inside sandbox', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runInSandbox(function () { Math.random() })).rejects.toThrow()
  })

  it('new Date() (no args) throws inside sandbox', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runInSandbox(function () { return new (Date as any)() })).rejects.toThrow()
  })

  it('new Date(0) works inside sandbox', async () => {
    const ctx = rt.createContext({})
    const d = await ctx.runInSandbox(function () { return new Date(0) }) as Date
    expect(d.toISOString()).toBe('1970-01-01T00:00:00.000Z')
  })

  it('process is not accessible inside sandbox', async () => {
    const ctx = rt.createContext({})
    const r = await ctx.runInSandbox(function () { return typeof (globalThis as any).process })
    expect(r).toBe('undefined')
  })

  it('async host function can be awaited via runInSandbox', async () => {
    const ctx = rt.createContext({ agent: async (x: string) => `RESULT:${x}` })
    const r = await ctx.runInSandbox(async function () { return await (globalThis as any).agent('test') })
    expect(r).toBe('RESULT:test')
  })

  it('vm timeout kills sync infinite loop', async () => {
    const rt2 = new NodeVmRuntime(200)
    const ctx = rt2.createContext({})
    await expect(ctx.runInSandbox(function () { while (true) {} })).rejects.toThrow()
  })

  it('returns primitive values from sandbox', async () => {
    const ctx = rt.createContext({})
    expect(await ctx.runInSandbox(function () { return 42 })).toBe(42)
    expect(await ctx.runInSandbox(function () { return 'hello' })).toBe('hello')
    expect(await ctx.runInSandbox(function () { return true })).toBe(true)
  })

  it('returns objects from sandbox', async () => {
    const ctx = rt.createContext({})
    const r = await ctx.runInSandbox(function () { return { x: 1, y: { z: 2 } } }) as any
    expect(r).toEqual({ x: 1, y: { z: 2 } })
  })

  it('throws when async function returns rejection', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runInSandbox(async function () { throw new Error('boom') })).rejects.toThrow('boom')
  })
})
