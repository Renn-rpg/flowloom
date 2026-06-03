import { describe, it, expect, vi } from 'vitest'
import { withRetry, errorTraceId, classifyError, formatApiError } from './retry.js'

const noSleep = async () => {}

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('retries on 429 then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValue('ok')
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('does not retry on 400', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 })
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ status: 400 })
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('retries network errors (no status) and gives up after maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(withRetry(fn, { sleep: noSleep, maxRetries: 2 })).rejects.toThrow('ECONNRESET')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('errorTraceId', () => {
  it('generates unique trace IDs with ERR- prefix', () => {
    const id1 = errorTraceId()
    const id2 = errorTraceId()
    expect(id1).toMatch(/^ERR-/)
    expect(id2).toMatch(/^ERR-/)
    expect(id1).not.toBe(id2)
  })
})

describe('classifyError', () => {
  it('classifies 429 as Rate Limited (yellow)', () => {
    expect(classifyError({ status: 429 })).toEqual({ label: 'Rate Limited', color: 'yellow' })
  })
  it('classifies 500 as Server Error (red)', () => {
    expect(classifyError({ status: 500 })).toEqual({ label: 'Server Error', color: 'red' })
  })
  it('classifies 404 as Not Found (magenta)', () => {
    expect(classifyError({ status: 404 })).toEqual({ label: 'Not Found', color: 'magenta' })
  })
  it('classifies ECONNREFUSED as Network Error (red)', () => {
    expect(classifyError({ code: 'ECONNREFUSED' })).toEqual({ label: 'Network Error', color: 'red' })
  })
  it('classifies unknown errors as dim', () => {
    expect(classifyError({})).toEqual({ label: 'Error', color: 'dim' })
  })
})

describe('formatApiError', () => {
  it('includes trace ID in output', () => {
    const result = formatApiError(new Error('test'))
    expect(result).toMatch(/^\[ERR-/)
  })

  it('includes retryable hint for 429', () => {
    const result = formatApiError({ status: 429, message: 'too many' })
    expect(result).toContain('retryable')
  })

  it('includes retryable hint for network errors', () => {
    const result = formatApiError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    expect(result).toContain('retryable')
  })
})
