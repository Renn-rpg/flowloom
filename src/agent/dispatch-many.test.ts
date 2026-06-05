import { describe, it, expect } from 'vitest'
import { makeDispatchAgentsTool, type FanOutEvent } from './dispatch-many.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ModelClient } from '../model/client.js'
import type { GenerateResult, GenerateRequest } from '../protocol/types.js'

const r = (over: Partial<GenerateResult>): GenerateResult => ({
  text: '',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 0, outputTokens: 0 },
  ...over,
})

// 回声 client：把最后一条 user 文本回吐为 "echo:<text>"，且每次调用独立（适合并发）。
function echoClient(over: Partial<GenerateResult> = {}): ModelClient {
  return {
    generate: async (req: GenerateRequest) => {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
      return r({ text: 'echo:' + (lastUser?.text ?? ''), usage: { inputTokens: 3, outputTokens: 7 }, ...over })
    },
  }
}

const base = (over: Partial<Parameters<typeof makeDispatchAgentsTool>[0]> = {}) => ({
  client: echoClient(),
  buildRegistry: () => new ToolRegistry(),
  system: 'sub sys',
  model: 'm',
  maxTokens: 100,
  ...over,
})

describe('dispatch_agents tool', () => {
  it('exposes a dispatch_agents spec requiring tasks', () => {
    const tool = makeDispatchAgentsTool(base())
    expect(tool.spec.name).toBe('dispatch_agents')
    expect(tool.spec.inputSchema.required).toContain('tasks')
  })

  it('rejects empty/missing tasks with ERROR', async () => {
    const tool = makeDispatchAgentsTool(base())
    expect(await tool.handler({})).toMatch(/^ERROR/)
    expect(await tool.handler({ tasks: [] })).toMatch(/^ERROR/)
    expect(await tool.handler({ tasks: [{ description: 'x' }] })).toMatch(/^ERROR/) // 无 prompt
  })

  it('runs all tasks and aggregates results in submission order', async () => {
    const tool = makeDispatchAgentsTool(base())
    const out = await tool.handler({
      tasks: [
        { description: 'first', prompt: 'A' },
        { description: 'second', prompt: 'B' },
        { description: 'third', prompt: 'C' },
      ],
    })
    expect(out).toContain('Dispatched 3 parallel sub-agent(s) — 3 succeeded, 0 failed.')
    // 顺序稳定，且各自的回声文本归位
    expect(out.indexOf('[1] first')).toBeLessThan(out.indexOf('[2] second'))
    expect(out.indexOf('[2] second')).toBeLessThan(out.indexOf('[3] third'))
    expect(out).toContain('echo:A')
    expect(out).toContain('echo:B')
    expect(out).toContain('echo:C')
  })

  it('emits start/tool/done activity per agent with the right index', async () => {
    const reg = new ToolRegistry()
    reg.register({
      spec: { name: 'glob', description: 'g', inputSchema: { type: 'object', properties: {} } },
      handler: async () => 'x',
    })
    // 第一次调用发一个 tool_call，第二次结束。
    const client: ModelClient = (() => {
      const calls = new Map<string, number>()
      return {
        generate: async (req: GenerateRequest) => {
          const key = [...req.messages].find((m) => m.role === 'user')?.text ?? ''
          const n = (calls.get(key) ?? 0) + 1
          calls.set(key, n)
          if (n === 1) return r({ toolCalls: [{ id: 'c', name: 'glob', input: {} }], stopReason: 'tool_use' })
          return r({ text: 'done ' + key })
        },
      }
    })()
    const events: FanOutEvent[] = []
    const tool = makeDispatchAgentsTool(base({ client, buildRegistry: () => reg, onActivity: (e) => events.push(e) }))
    await tool.handler({ tasks: [{ prompt: 'P0' }, { prompt: 'P1' }] })
    expect(events.filter((e) => e.kind === 'start')).toHaveLength(2)
    expect(events.some((e) => e.kind === 'tool' && e.name === 'glob' && e.index === 0)).toBe(true)
    expect(events.some((e) => e.kind === 'tool' && e.name === 'glob' && e.index === 1)).toBe(true)
    const dones = events.filter((e) => e.kind === 'done')
    expect(dones).toHaveLength(2)
    expect(dones.every((d) => d.kind === 'done' && d.tools === 1)).toBe(true)
  })

  it('isolates failures — one throwing agent does not sink the others', async () => {
    let n = 0
    const client: ModelClient = {
      generate: async (req: GenerateRequest) => {
        const text = [...req.messages].find((m) => m.role === 'user')?.text ?? ''
        n++
        if (text === 'BAD') throw new Error('boom')
        return r({ text: 'ok ' + text })
      },
    }
    const tool = makeDispatchAgentsTool(base({ client }))
    const out = await tool.handler({ tasks: [{ prompt: 'GOOD' }, { prompt: 'BAD' }] })
    expect(out).toContain('1 succeeded, 1 failed')
    expect(out).toContain('ok GOOD')
    expect(out).toMatch(/failed.*boom|boom/)
    expect(n).toBeGreaterThanOrEqual(2)
  })

  it('accumulates usage across all agents back to the parent', async () => {
    let agg = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 }
    const tool = makeDispatchAgentsTool(
      base({ onUsage: (u) => { agg = { inputTokens: agg.inputTokens + u.inputTokens, outputTokens: agg.outputTokens + u.outputTokens, cacheHitTokens: agg.cacheHitTokens + u.cacheHitTokens } } }),
    )
    await tool.handler({ tasks: [{ prompt: 'A' }, { prompt: 'B' }, { prompt: 'C' }] })
    // echoClient: 每个 agent out=7 → 3 个 = 21
    expect(agg.outputTokens).toBe(21)
  })

  it('respects the concurrency cap (never more than N running at once)', async () => {
    let running = 0
    let peak = 0
    const client: ModelClient = {
      generate: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((res) => setTimeout(res, 5))
        running--
        return r({ text: 'x' })
      },
    }
    const tool = makeDispatchAgentsTool(base({ client, concurrency: 2 }))
    await tool.handler({ tasks: Array.from({ length: 6 }, (_, i) => ({ prompt: 'p' + i })) })
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(0)
  })

  it('pause gate holds new agents until resumed', async () => {
    let started = 0
    const client: ModelClient = { generate: async () => { started++; return r({ text: 'x' }) } }
    let paused = true
    const resumers: Array<() => void> = []
    const waitForResume = () => new Promise<void>((res) => resumers.push(res))
    const tool = makeDispatchAgentsTool(base({ client, concurrency: 4, isPaused: () => paused, waitForResume }))
    const p = tool.handler({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] })
    await new Promise((r) => setTimeout(r, 15))
    expect(started).toBe(0) // 暂停态 → 一个都不该启动
    paused = false
    resumers.forEach((r) => r())
    await p
    expect(started).toBe(2)
  })

  it('does not hang when aborted while paused (stop wakes the pause gate)', async () => {
    const ac = new AbortController()
    let paused = true
    let resumers: Array<() => void> = []
    const waitForResume = () => new Promise<void>((res) => resumers.push(res))
    const client: ModelClient = { generate: async () => r({ text: 'x' }) }
    const tool = makeDispatchAgentsTool(
      base({ client, concurrency: 1, isPaused: () => paused, waitForResume, getSignal: () => ac.signal }),
    )
    const p = tool.handler({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] })
    await new Promise((r) => setTimeout(r, 15)) // 让任务到达暂停闸
    // 模拟 drill-in 的 x stop：abort + 清暂停 + 排空 resumers（唤醒卡住的任务）
    ac.abort()
    paused = false
    resumers.forEach((r) => r())
    resumers = []
    const out = await p // 必须 resolve，不能挂死
    expect(out).toContain('0 succeeded, 2 failed')
  })

  it('aborts in-flight agents when the signal fires', async () => {
    const ac = new AbortController()
    const client: ModelClient = {
      generate: async () => { await new Promise((res) => setTimeout(res, 20)); return r({ text: 'late' }) },
    }
    const tool = makeDispatchAgentsTool(base({ client, getSignal: () => ac.signal }))
    ac.abort()
    const out = await tool.handler({ tasks: [{ prompt: 'A' }, { prompt: 'B' }] })
    expect(out).toContain('0 succeeded, 2 failed')
  })
})
