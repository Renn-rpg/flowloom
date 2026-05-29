export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  isRetryable?: (err: unknown) => boolean
}

function defaultRetryable(err: any): boolean {
  const status = err?.status ?? err?.response?.status
  if (status === 429) return true
  if (typeof status === 'number' && status >= 500) return true
  if (status === undefined) return true // 网络错误/超时（无 HTTP 状态）
  return false // 其它 4xx 不重试
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.maxRetries ?? 3
  const base = opts.baseDelayMs ?? 500
  const sleep = opts.sleep ?? defaultSleep
  const retryable = opts.isRetryable ?? defaultRetryable
  let lastErr: unknown
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === max || !retryable(err)) throw err
      await sleep(base * 2 ** attempt) // 指数退避：500, 1000, 2000...
    }
  }
  throw lastErr
}
