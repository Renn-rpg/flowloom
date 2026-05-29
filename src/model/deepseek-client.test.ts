import { describe, it, expect, vi } from 'vitest'
import { DeepSeekClient } from './deepseek-client.js'

describe('DeepSeekClient', () => {
  it('transforms request out and response back through protocol layer', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    })
    const fakeOpenAI = { chat: { completions: { create } } } as any
    const client = new DeepSeekClient({ model: 'deepseek-chat', openai: fakeOpenAI })
    const res = await client.generate({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'deepseek-chat', maxTokens: 100 })
    // 出口转换：system 进 messages[0]
    expect(create.mock.calls[0][0].messages[0]).toEqual({ role: 'system', content: 'sys' })
    // 入口转换：拿到内部结果
    expect(res.text).toBe('hello')
    expect(res.stopReason).toBe('end_turn')
  })

  it('streams text via onText and returns accumulated result', async () => {
    async function* gen() {
      yield { choices: [{ delta: { content: 'hi' } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    }
    const create = vi.fn().mockResolvedValue(gen())
    const fakeOpenAI = { chat: { completions: { create } } } as any
    const client = new DeepSeekClient({ model: 'deepseek-chat', openai: fakeOpenAI })
    const seen: string[] = []
    const res = await client.generate(
      { system: 's', messages: [{ role: 'user', text: 'x' }], tools: [], model: 'deepseek-chat', maxTokens: 10 },
      { onText: (d) => seen.push(d) },
    )
    expect(create.mock.calls[0][0].stream).toBe(true)
    expect(seen.join('')).toBe('hi')
    expect(res.text).toBe('hi')
    expect(res.stopReason).toBe('end_turn')
  })
})
