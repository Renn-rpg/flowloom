import { describe, it, expect, vi } from 'vitest'
import { createSession, runTurn } from './loop.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ModelClient } from '../model/client.js'
import type { GenerateResult } from '../protocol/types.js'

function scriptedClient(results: GenerateResult[]): ModelClient {
  let i = 0
  return { generate: async () => results[i++] }
}
const r = (over: Partial<GenerateResult>): GenerateResult => ({ text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, ...over })

describe('runTurn', () => {
  it('executes tool calls then returns final text', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, handler: async () => 'FILE_DATA' })
    const client = scriptedClient([
      r({ toolCalls: [{ id: 'c1', name: 'read_file', input: { path: '/a' } }], stopReason: 'tool_use' }),
      r({ text: 'the file says FILE_DATA' }),
    ])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'deepseek-chat', maxTokens: 1000 })
    expect(await runTurn(s, 'read /a')).toBe('the file says FILE_DATA')
  })

  it('keeps conversation context across turns', async () => {
    const reg = new ToolRegistry()
    const client = scriptedClient([r({ text: 'turn1' }), r({ text: 'turn2' })])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'deepseek-chat', maxTokens: 1000 })
    await runTurn(s, 'hello')
    await runTurn(s, 'again')
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(s.messages[0].text).toBe('hello')
    expect(s.messages[2].text).toBe('again')
  })

  it('backward compatible: accepts function as third arg (onText)', async () => {
    const client = scriptedClient([r({ text: 'ok' })])
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const texts: string[] = []
    expect(await runTurn(s, 'hi', (d) => texts.push(d))).toBe('ok')
  })

  it('awaits beforeGenerate before each generate (overlay gate)', async () => {
    const order: string[] = []
    const client: ModelClient = { generate: async () => { order.push('generate'); return r({ text: 'done' }) } }
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    let blocked = true
    const p = runTurn(s, 'hi', {
      beforeGenerate: async () => { order.push('gate'); if (blocked) { await gate; blocked = false } },
    })
    await new Promise((res) => setTimeout(res, 10))
    expect(order).toEqual(['gate']) // generate 被挂起，未执行
    release()
    expect(await p).toBe('done')
    expect(order).toEqual(['gate', 'generate'])
  })

  it('does not call generate if aborted while beforeGenerate is awaiting', async () => {
    const ac = new AbortController()
    let generated = false
    const client: ModelClient = { generate: async () => { generated = true; return r({ text: 'x' }) } }
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const p = runTurn(s, 'hi', {
      beforeGenerate: async () => { ac.abort(); await new Promise((res) => setTimeout(res, 5)) },
    }, { signal: ac.signal })
    await expect(p).rejects.toThrow(/aborted/)
    expect(generated).toBe(false)
  })

  it('fires onThinking and onThinkingDone callbacks', async () => {
    const client = scriptedClient([r({ text: 'ok' })])
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const thinking: string[] = []
    const done: number[] = []
    await runTurn(s, 'hi', {
      onThinking: () => thinking.push('start'),
      onThinkingDone: (ms) => done.push(ms),
    })
    expect(thinking).toEqual(['start'])
    expect(done.length).toBe(1)
    expect(done[0]).toBeGreaterThanOrEqual(0)
  })

  it('fires onToolCall and onToolResult for tool use', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'grep', description: '', inputSchema: { type: 'object', properties: {} } }, handler: async () => 'found' })
    const client = scriptedClient([
      r({ toolCalls: [{ id: 'c1', name: 'grep', input: { pattern: 'TODO' } }], stopReason: 'tool_use' }),
      r({ text: 'done' }),
    ])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100 })
    const calls: string[] = []
    const results: string[] = []
    await runTurn(s, 'grep TODO', {
      onToolCall: (name) => calls.push(name),
      onToolResult: (name, ms, isError) => results.push(`${name}:${ms}:${isError}`),
    })
    expect(calls).toEqual(['grep'])
    expect(results.length).toBe(1)
    expect(results[0]).toMatch(/^grep:\d+:false$/)
  })

  it('stores reasoningText on the tool-call assistant message but not on the terminal one (R7/R8)', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }, handler: async () => 'DATA' })
    const client = scriptedClient([
      r({ reasoningText: 'plan: read the file', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: '/a' } }], stopReason: 'tool_use' }),
      r({ text: 'done', reasoningText: 'final cot' }),
    ])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100 })
    await runTurn(s, 'go')
    const asstTool = s.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length)
    expect(asstTool?.reasoningText).toBe('plan: read the file') // 工具轮：回传
    const asstFinal = s.messages.find((m) => m.role === 'assistant' && !m.toolCalls?.length)
    expect(asstFinal?.reasoningText).toBeUndefined() // 终态：剥掉（R7）
  })

  it('forwards onReasoning through to the client', async () => {
    const client: ModelClient = {
      generate: async (_req, opts) => {
        opts?.onReasoning?.('cot-')
        opts?.onReasoning?.('delta')
        return r({ text: 'ok' })
      },
    }
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const cot: string[] = []
    await runTurn(s, 'hi', { onReasoning: (d) => cot.push(d) })
    expect(cot.join('')).toBe('cot-delta')
  })

  it('blocks a tool when the gate denies it and feeds the reason back as a tool error', async () => {
    const reg = new ToolRegistry()
    let ran = false
    reg.register({ spec: { name: 'run_shell', description: '', inputSchema: { type: 'object', properties: {} } }, handler: async () => { ran = true; return 'should not run' } })
    const client = scriptedClient([
      r({ toolCalls: [{ id: 'c1', name: 'run_shell', input: { cmd: 'rm -rf /' } }], stopReason: 'tool_use' }),
      r({ text: 'understood, blocked' }),
    ])
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100 })
    s.gate = async (name) => (name === 'run_shell' ? { allow: false, message: 'no shell' } : { allow: true })
    const results: string[] = []
    await runTurn(s, 'go', { onToolResult: (name, _ms, isError) => results.push(`${name}:${isError}`) })
    expect(ran).toBe(false) // 工具未执行
    expect(results).toEqual(['run_shell:true']) // 以 error 形式上报
    const toolMsg = s.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.toolResults?.[0].content).toContain('blocked by hook: no shell')
  })

  it('does not fire onToolCall for text-only responses', async () => {
    const client = scriptedClient([r({ text: 'just text' })])
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const calls: string[] = []
    await runTurn(s, 'hi', { onToolCall: () => calls.push('x') })
    expect(calls).toEqual([])
  })

  it('trims oldest rounds and fires onContextTrim when contextTokens is exceeded', async () => {
    const reg = new ToolRegistry()
    const client = scriptedClient([r({ text: 'a1' }), r({ text: 'a2' })])
    // autoCompact:false → 走纯「整轮丢弃」路径（语义压缩另有专门用例覆盖）
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100, contextTokens: 1500, autoCompact: false })
    const trims: number[] = []
    const bigText = 'x'.repeat(4000) // ~1000 token，单轮可容，两轮超 1500
    await runTurn(s, bigText) // turn 1：仅一轮，不裁剪
    await runTurn(s, bigText + '_LATEST', {
      onContextTrim: (info) => trims.push(info.droppedMessages),
    })
    expect(trims.length).toBeGreaterThanOrEqual(1) // 第二轮触发裁剪
    expect(s.messages.length).toBe(2) // 仅保留最新一轮：user + assistant
    expect(s.messages[0].role).toBe('user')
    expect(s.messages[0].text).toBe(bigText + '_LATEST')
    expect(s.messages.find((m) => m.text === bigText)).toBeUndefined() // 旧一轮已丢弃
  })

  it('does not trim when contextTokens is 0 (disabled, default)', async () => {
    const client = scriptedClient([r({ text: 'a1' }), r({ text: 'a2' })])
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const bigText = 'x'.repeat(8000)
    let trimmed = false
    await runTurn(s, bigText)
    await runTurn(s, bigText, { onContextTrim: () => { trimmed = true } })
    expect(trimmed).toBe(false)
    expect(s.messages.length).toBe(4) // 全部保留
  })

  // 区分「摘要请求」与「正常对话请求」：摘要请求由 buildSummaryRequest 构造，消息含 "Transcript to summarize"。
  const isSummaryReq = (req: { messages: { text?: string }[] }) =>
    req.messages.some((m) => typeof m.text === 'string' && m.text.includes('Transcript to summarize'))

  it('auto-compacts oldest rounds into a system summary when over budget (autoCompact default on)', async () => {
    const reg = new ToolRegistry()
    let summaryReqs = 0
    const client: ModelClient = {
      generate: async (req) => {
        if (isSummaryReq(req)) { summaryReqs++; return r({ text: 'CONDENSED' }) }
        return r({ text: 'resp' })
      },
    }
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100, contextTokens: 1500 })
    const bigText = 'x'.repeat(4000) // ~1000 token/轮
    const compacts: number[] = []
    const trims: number[] = []
    await runTurn(s, bigText) // 第一轮：单轮可容，不压缩
    await runTurn(s, bigText + '_LATEST', {
      onContextCompact: (info) => compacts.push(info.summarizedRounds),
      onContextTrim: (info) => trims.push(info.droppedMessages),
    })
    expect(summaryReqs).toBe(1) // 触发了一次摘要调用
    expect(compacts).toEqual([1]) // 压缩了最旧一轮，且走的是压缩而非裁剪
    expect(trims).toEqual([])
    expect(s.system).toContain('CONDENSED') // 摘要折叠进 system
    expect(s.messages[0].text).toBe(bigText + '_LATEST') // 仅保留最新一轮
    expect(s.messages.find((m) => m.text === bigText)).toBeUndefined() // 旧轮已被摘要替换
  })

  it('falls back to trimming when the summary call fails (never breaks the turn)', async () => {
    const reg = new ToolRegistry()
    const client: ModelClient = {
      generate: async (req) => {
        if (isSummaryReq(req)) throw new Error('summary boom')
        return r({ text: 'resp' })
      },
    }
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100, contextTokens: 1500 })
    const bigText = 'x'.repeat(4000)
    const compacts: number[] = []
    const trims: number[] = []
    await runTurn(s, bigText)
    const out = await runTurn(s, bigText + '_LATEST', {
      onContextCompact: (info) => compacts.push(info.summarizedRounds),
      onContextTrim: (info) => trims.push(info.droppedMessages),
    })
    expect(out).toBe('resp') // 本轮仍正常完成
    expect(compacts).toEqual([]) // 摘要失败 → 未压缩
    expect(trims.length).toBeGreaterThanOrEqual(1) // 回退到裁剪
    expect(s.messages[0].text).toBe(bigText + '_LATEST')
  })

  it('applies a secondary trim when the folded summary itself keeps the request over budget', async () => {
    // 摘要本身很大时，折叠进 system 后仍可能超预算；此时应再叠加一次整轮丢弃（major 修复）。
    const reg = new ToolRegistry()
    const client: ModelClient = {
      generate: async (req) => {
        if (isSummaryReq(req)) return r({ text: 'S'.repeat(12000) }) // ~3000 token 的超大摘要
        return r({ text: 'resp' })
      },
    }
    const s = createSession({ client, registry: reg, system: 'sys', model: 'm', maxTokens: 100, contextTokens: 2500 })
    const big = 'x'.repeat(4000) // ~1000 token/轮
    const compacts: number[] = []
    const trims: number[] = []
    await runTurn(s, big) // 轮1
    await runTurn(s, big + '_2') // 轮2（两轮 ~2000，仍 ≤ 2500，不压缩）
    await runTurn(s, big + '_3', { // 轮3：三轮超 2500 → 压缩最旧轮
      onContextCompact: (info) => compacts.push(info.summarizedRounds),
      onContextTrim: (info) => trims.push(info.droppedMessages),
    })
    expect(compacts).toEqual([1]) // 压缩发生
    expect(trims.length).toBeGreaterThanOrEqual(1) // 超大摘要 → 触发二次裁剪
    expect(s.messages[0].text).toBe(big + '_3') // 仅保留最新一轮
    expect(s.messages.find((m) => m.text === big + '_2')).toBeUndefined()
  })

  // ——— 用户中断(ESC):AbortSignal 透传 ———

  it('throws immediately when the signal is already aborted, without calling the model', async () => {
    const generate = vi.fn(async () => r({ text: 'should not run' }))
    const s = createSession({ client: { generate }, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const ac = new AbortController()
    ac.abort()
    await expect(runTurn(s, 'hi', {}, { signal: ac.signal })).rejects.toThrow(/abort/i)
    expect(generate).not.toHaveBeenCalled()
  })

  it('forwards the abort signal to client.generate', async () => {
    let seenSignal: AbortSignal | undefined
    const client: ModelClient = {
      generate: async (_req, opts) => { seenSignal = opts?.signal; return r({ text: 'ok' }) },
    }
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const ac = new AbortController()
    await runTurn(s, 'hi', {}, { signal: ac.signal })
    expect(seenSignal).toBe(ac.signal)
  })

  it('restores messages to a consistent state when generate aborts mid-turn (no orphan assistant)', async () => {
    const client: ModelClient = {
      generate: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    }
    const s = createSession({ client, registry: new ToolRegistry(), system: 'sys', model: 'm', maxTokens: 100 })
    const ac = new AbortController()
    await expect(runTurn(s, 'hi', {}, { signal: ac.signal })).rejects.toThrow(/abort/i)
    // generate 抛错 → 还原到本轮起点快照(仅含刚 push 的 user 消息),不留半截 assistant/tool
    expect(s.messages.map((m) => m.role)).toEqual(['user'])
  })

  it('aborts before the next generate when the signal fires during tool execution', async () => {
    const reg = new ToolRegistry()
    const ac = new AbortController()
    // 工具执行时触发中断 → 下一轮迭代起点应立即抛错,不再调用 generate 第二次
    reg.register({ spec: { name: 'slow', description: '', inputSchema: { type: 'object', properties: {} } }, handler: async () => { ac.abort(); return 'done' } })
    const generate = vi.fn(async () => r({ toolCalls: [{ id: 'c1', name: 'slow', input: {} }], stopReason: 'tool_use' }))
    const s = createSession({ client: { generate }, registry: reg, system: 'sys', model: 'm', maxTokens: 100 })
    await expect(runTurn(s, 'go', {}, { signal: ac.signal })).rejects.toThrow(/abort/i)
    expect(generate).toHaveBeenCalledTimes(1) // 仅第一轮 generate,中断后不再发起第二轮
  })
})
