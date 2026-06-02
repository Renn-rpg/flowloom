import { describe, it, expect, vi } from 'vitest'
import { AgentExecutor } from './agent-executor.js'

function mockClient(responses: any[]) {
  let i = 0
  return {
    generate: vi.fn(async () => {
      const r = responses[i++]
      if (!r) throw new Error('no more responses')
      return r
    }),
  }
}

describe('AgentExecutor', () => {
  const makeExec = (client: any) =>
    new AgentExecutor({
      client,
      registry: { specs: () => [], run: async () => 'ok', get: () => undefined, register: () => {} } as any,
      defaultModel: 'm',
      defaultMaxTokens: 100,
      defaultSystem: 'sys',
    })

  it('agent returns text result', async () => {
    const client = mockClient([
      {
        text: 'final answer',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
      },
    ])
    const exec = makeExec(client)
    const r = await exec.agent('hello')
    expect(r.text).toBe('final answer')
    expect(r.usage.outputTokens).toBe(5)
  })

  it('agent throws on stopped: sentinel (iteration limit)', async () => {
    const client = mockClient([
      {
        text: 'stopped: reached max iterations',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 10 },
      },
    ])
    const exec = makeExec(client)
    await expect(exec.agent('loop')).rejects.toThrow('stopped:')
  })
})
