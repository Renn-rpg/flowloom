import { describe, it, expect, vi } from 'vitest'
import { withRetry } from './retry.js'

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
    expect(fn).toHaveBeenCalledTimes(3) // 1 + 2 retries
  })
})
