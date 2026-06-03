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

// 为每个错误生成可追踪 ID（ERR-时间戳-随机数）
let _errSeq = 0
export function errorTraceId(): string {
  return `ERR-${Date.now().toString(36)}-${(_errSeq++).toString(36)}`
}

// HTTP status → 人类可读分类
const HTTP_LABELS: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 408: 'Timeout', 429: 'Rate Limited',
  500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable', 504: 'Gateway Timeout',
}

export function classifyError(err: unknown): { label: string; color: 'red' | 'yellow' | 'magenta' | 'dim' } {
  const e = err as any
  const status = e?.status ?? e?.response?.status
  const code = e?.code ?? e?.error?.code ?? ''

  if (status === 429) return { label: 'Rate Limited', color: 'yellow' }
  if (typeof status === 'number' && status >= 500) return { label: HTTP_LABELS[status] ?? 'Server Error', color: 'red' }
  if (typeof status === 'number' && status >= 400) return { label: HTTP_LABELS[status] ?? 'Client Error', color: 'magenta' }
  if (!status && (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET')) {
    return { label: 'Network Error', color: 'red' }
  }
  return { label: 'Error', color: 'dim' }
}

// 从 API 错误中提取有用的错误信息，含追踪 ID 和分类
export function formatApiError(err: unknown): string {
  const e = err as any
  const name = e?.name ?? e?.constructor?.name ?? ''
  const msg = e?.message ?? String(err)
  const traceId = errorTraceId()
  const { label } = classifyError(err)

  const parts: string[] = [`[${traceId}]`]
  if (label !== 'Error') parts.push(`[${label}]`)

  if (name && name !== 'Error') parts.push(name)
  if (e?.status) parts.push(`HTTP ${e.status}`)

  for (const k of ['code', 'type', 'param']) {
    if (e?.[k]) parts.push(`${k}=${e[k]}`)
  }

  if (e?.error?.message) parts.push(`api: ${e.error.message}`)
  if (e?.body?.error?.message) parts.push(`body: ${e.body.error.message}`)

  if (e?.cause) {
    const c = e.cause
    parts.push(`cause: ${c?.message ?? c?.code ?? String(c)}`)
  }
  if (e?.request_id) parts.push(`req=${e.request_id}`)

  parts.push(msg)

  // 可恢复错误提示
  if (label === 'Rate Limited' || label === 'Network Error' || (typeof e?.status === 'number' && e.status >= 500)) {
    parts.push('(retryable — press Enter to retry or /retry)')
  }

  return parts.join(' | ')
}
