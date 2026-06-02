import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker, ModelRouter, type RouterClient } from './router.js'
import type { ModelClient } from './client.js'
import type { GenerateResult } from '../protocol/types.js'

// 可控 mock 客户端：按配置返回成功或失败
function mockClient(name: string, opts?: { fail?: boolean; failMsg?: string }): ModelClient {
  return {
    async generate() {
      if (opts?.fail) throw new Error(opts.failMsg ?? `${name} failed`)
      return { text: `result from ${name}`, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } satisfies GenerateResult
    },
  }
}

function mockClients(count: number, prefix = 'm'): RouterClient[] {
  return Array.from({ length: count }, (_, i) => ({ client: mockClient(`${prefix}${i}`), name: `${prefix}${i}` }))
}

describe('CircuitBreaker', () => {
  // 用固定时间戳替代 Date.now()，保证熔断器行为可预测
  let now = 0
  const realNow = Date.now
  beforeEach(() => { now = 0; Date.now = () => now })
  afterEach(() => { Date.now = realNow })

  it('starts closed', () => {
    const cb = new CircuitBreaker(3, 1000)
    expect(cb.isOpen).toBe(false)
  })

  it('opens after threshold failures', () => {
    const cb = new CircuitBreaker(3, 1000)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen).toBe(false)
    cb.recordFailure() // 第 3 次 → open
    expect(cb.isOpen).toBe(true)
  })

  it('remains closed below threshold', () => {
    const cb = new CircuitBreaker(5, 1000)
    for (let i = 0; i < 4; i++) cb.recordFailure()
    expect(cb.isOpen).toBe(false)
  })

  it('resets to closed on recordSuccess', () => {
    const cb = new CircuitBreaker(2, 1000)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen).toBe(true)
    cb.recordSuccess()
    expect(cb.isOpen).toBe(false)
  })

  it('transitions open → half-open after resetMs', () => {
    const cb = new CircuitBreaker(2, 1000)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen).toBe(true)
    // 快进时间
    now = 2000
    expect(cb.isOpen).toBe(false) // half-open，放行一次试探
  })

  it('re-opens after half-open failure', () => {
    const cb = new CircuitBreaker(2, 1000)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen).toBe(true)
    now = 2000
    expect(cb.isOpen).toBe(false) // half-open
    cb.recordFailure() // 试探失败 → 重开
    expect(cb.isOpen).toBe(true)
  })

  it('closes after half-open success', () => {
    const cb = new CircuitBreaker(2, 1000)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen).toBe(true)
    now = 2000
    expect(cb.isOpen).toBe(false) // half-open
    cb.recordSuccess()
    expect(cb.isOpen).toBe(false) // closed
  })
})

describe('ModelRouter', () => {
  it('routes to primary on success', async () => {
    const primary = mockClient('primary')
    const spy = vi.spyOn(primary, 'generate')
    const router = new ModelRouter([{ client: primary, name: 'primary' }])
    const result = await router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 })
    expect(result.text).toBe('result from primary')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('falls back to secondary when primary fails', async () => {
    const primary = mockClient('primary', { fail: true, failMsg: 'down' })
    const fallback = mockClient('fallback')
    const spyFb = vi.spyOn(fallback, 'generate')
    const router = new ModelRouter([
      { client: primary, name: 'primary' },
      { client: fallback, name: 'fallback' },
    ])
    const result = await router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 })
    expect(result.text).toBe('result from fallback')
    expect(spyFb).toHaveBeenCalledTimes(1)
  })

  it('skips primary when circuit breaker is open', async () => {
    const primary = mockClient('primary')
    const fallback = mockClient('fallback')
    const spyPrimary = vi.spyOn(primary, 'generate')
    const breaker = new CircuitBreaker(1, 60_000)
    breaker.recordFailure() // open immediately
    const router = new ModelRouter([
      { client: primary, name: 'primary' },
      { client: fallback, name: 'fallback' },
    ], breaker)
    const result = await router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 })
    expect(result.text).toBe('result from fallback')
    expect(spyPrimary).not.toHaveBeenCalled()
  })

  it('throws when all models fail', async () => {
    const primary = mockClient('primary', { fail: true, failMsg: 'down' })
    const fallback = mockClient('fallback', { fail: true, failMsg: 'also down' })
    const router = new ModelRouter([
      { client: primary, name: 'primary' },
      { client: fallback, name: 'fallback' },
    ])
    await expect(router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 }))
      .rejects.toThrow('All models failed:')
  })

  it('aggregates all error messages when all fail', async () => {
    const router = new ModelRouter([
      { client: mockClient('primary', { fail: true, failMsg: 'err1' }), name: 'a' },
      { client: mockClient('fallback', { fail: true, failMsg: 'err2' }), name: 'b' },
    ])
    await expect(router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 }))
      .rejects.toThrow(/a: err1/)
    await expect(router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 }))
      .rejects.toThrow(/b: err2/)
  })

  it('records success and resets breaker when primary recovers', async () => {
    const primary = mockClient('primary')
    const breaker = new CircuitBreaker(1, 60_000)
    breaker.recordFailure() // open
    const router = new ModelRouter(
      [{ client: primary, name: 'primary' }],
      breaker,
    )
    // breaker is open → primary skipped → no clients → all failed
    await expect(router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 }))
      .rejects.toThrow('All models failed')
    // manually reset breaker to simulate half-open success
    breaker.recordSuccess()
    const result = await router.generate({ system: '', messages: [], tools: [], model: 'm', maxTokens: 100 })
    expect(result.text).toBe('result from primary')
  })
})
