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
})
