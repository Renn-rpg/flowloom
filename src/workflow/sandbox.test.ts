import { describe, it, expect } from 'vitest'
import { NodeVmRuntime } from './sandbox.js'

describe('NodeVmRuntime', () => {
  const rt = new NodeVmRuntime()

  it('injected functions are callable from script via global scope', async () => {
    const ctx = rt.createContext({ greet: async (name: string) => `Hello ${name}` })
    const result = await ctx.runScript(async function () { return await (globalThis as any).greet('world') })
    expect(result).toBe('Hello world')
  })

  it('Date.now() throws', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runScript(function () { Date.now() })).rejects.toThrow()
  })

  it('Math.random() throws', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runScript(function () { Math.random() })).rejects.toThrow()
  })

  it('new Date() (no args) throws', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runScript(function () { return new (Date as any)() })).rejects.toThrow()
  })

  it('new Date(0) works', async () => {
    const ctx = rt.createContext({})
    const d = await ctx.runScript(function () { return new Date(0) }) as Date
    expect(d.toISOString()).toBe('1970-01-01T00:00:00.000Z')
  })

  it('process is not accessible', async () => {
    const ctx = rt.createContext({})
    const r = await ctx.runScript(function () { return typeof (globalThis as any).process })
    expect(r).toBe('undefined')
  })

  it('async host function can be awaited', async () => {
    const ctx = rt.createContext({ agent: async (x: string) => `RESULT:${x}` })
    const r = await ctx.runScript(async function () { return await (globalThis as any).agent('test') })
    expect(r).toBe('RESULT:test')
  })

  it('vm timeout kills sync infinite loop', async () => {
    const rt2 = new NodeVmRuntime(200)
    const ctx = rt2.createContext({})
    await expect(ctx.runScript(function () { while (true) {} })).rejects.toThrow()
  })

  it('returns primitive values from script', async () => {
    const ctx = rt.createContext({})
    expect(await ctx.runScript(function () { return 42 })).toBe(42)
    expect(await ctx.runScript(function () { return 'hello' })).toBe('hello')
    expect(await ctx.runScript(function () { return true })).toBe(true)
  })

  it('returns objects from script', async () => {
    const ctx = rt.createContext({})
    const r = await ctx.runScript(function () { return { x: 1, y: { z: 2 } } }) as any
    expect(r).toEqual({ x: 1, y: { z: 2 } })
  })

  it('throws when async function returns rejection', async () => {
    const ctx = rt.createContext({})
    await expect(ctx.runScript(async function () { throw new Error('boom') })).rejects.toThrow('boom')
  })
})
