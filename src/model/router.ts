// 多模型路由器：支持主模型 + 备选 fallback，含熔断器（circuit breaker）。
// 实现 ModelClient 接口，对上层透明。

import type { ModelClient } from './client.js'
import type { GenerateRequest, GenerateResult, GenerateOptions } from '../protocol/types.js'

// 熔断器：连续失败 N 次后打开，拒绝请求一段时间，避免在 API 故障时持续重试浪费资源。
export class CircuitBreaker {
  private failures = 0
  private lastFailureTime = 0
  private state: 'closed' | 'open' | 'half-open' = 'closed'

  constructor(
    private threshold = 5,
    private resetMs = 60_000,
  ) {}

  get isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetMs) {
        this.state = 'half-open'
        return false
      }
      return true
    }
    return false
  }

  recordSuccess(): void {
    this.failures = 0
    this.state = 'closed'
  }

  recordFailure(): void {
    this.failures++
    this.lastFailureTime = Date.now()
    if (this.failures >= this.threshold) {
      this.state = 'open'
    }
  }
}

export interface RouterClient {
  client: ModelClient
  name: string
}

export class ModelRouter implements ModelClient {
  private clients: RouterClient[]
  private breaker: CircuitBreaker

  constructor(clients: RouterClient[], breaker?: CircuitBreaker) {
    this.clients = clients
    this.breaker = breaker ?? new CircuitBreaker()
  }

  async generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResult> {
    const errors: string[] = []

    for (let i = 0; i < this.clients.length; i++) {
      const { client, name } = this.clients[i]

      // 主模型（index 0）受熔断器保护
      if (i === 0 && this.breaker.isOpen) {
        errors.push(`${name}: circuit breaker open`)
        continue
      }

      try {
        const result = await client.generate(req, opts)
        if (i === 0) this.breaker.recordSuccess()
        return result
      } catch (e: unknown) {
        const msg = `${name}: ${e instanceof Error ? e.message : String(e)}`
        errors.push(msg)
        if (i === 0) this.breaker.recordFailure()
        // 继续尝试下一个 fallback
      }
    }

    throw new Error(`All models failed:\n${errors.map(e => `  - ${e}`).join('\n')}`)
  }
}
