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
      await sleep(base * 2 ** attempt)
    }
  }
  throw lastErr
}

// 从 API 错误中提取有用的错误信息
export function formatApiError(err: unknown): string {
  const e = err as any
  const name = e?.name ?? e?.constructor?.name ?? ''
  const msg = e?.message ?? String(err)

  // 拼装：ErrorName: message [detail=value, ...]
  const parts: string[] = []
  if (name && name !== 'Error') parts.push(name)

  // HTTP status
  if (e?.status) parts.push(`HTTP ${e.status}`)

  // 关键字段
  for (const k of ['code', 'type', 'param']) {
    if (e?.[k]) parts.push(`${k}=${e[k]}`)
  }

  // 嵌套 error/body
  if (e?.error?.message) parts.push(`api: ${e.error.message}`)
  if (e?.body?.error?.message) parts.push(`body: ${e.body.error.message}`)

  // 底层 cause
  if (e?.cause) {
    const c = e.cause
    parts.push(`cause: ${c?.message ?? c?.code ?? String(c)}`)
  }

  // 请求 URL
  if (e?.request_id) parts.push(`req=${e.request_id}`)

  parts.push(msg)
  return parts.join(' | ')
}
