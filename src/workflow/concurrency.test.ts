import { describe, it, expect } from 'vitest'
import { Semaphore, defaultConcurrency } from './concurrency.js'

describe('Semaphore', () => {
  it('acquires immediately when under limit', async () => {
    const s = new Semaphore(3)
    const release = await s.acquire()
    expect(typeof release).toBe('function')
    release()
  })

  it('limits concurrent tasks to max', async () => {
    const s = new Semaphore(2)
    let running = 0
    let maxRunning = 0

    const tasks = Array.from({ length: 5 }, async () => {
      const release = await s.acquire()
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((r) => setTimeout(r, 10))
      running--
      release()
    })

    await Promise.all(tasks)
    expect(maxRunning).toBe(2)
  })

  it('queues tasks and eventually runs all', async () => {
    const s = new Semaphore(2)
    const results: number[] = []

    const tasks = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        const release = await s.acquire()
        results.push(i)
        release()
      })(),
    )

    await Promise.all(tasks)
    expect(results).toHaveLength(5)
  })

  it('release allows next queued task to run', async () => {
    const s = new Semaphore(1)
    let stage = 0

    const release1 = await s.acquire()
    stage = 1

    const p2 = (async () => {
      const r = await s.acquire()
      stage = 2
      r()
    })()

    // p2 should be blocked waiting for semaphore
    await new Promise((r) => setTimeout(r, 10))
    expect(stage).toBe(1) // still blocked

    release1()
    await p2
    expect(stage).toBe(2) // now unblocked
  })
})

describe('defaultConcurrency', () => {
  it('returns a positive number', () => {
    expect(defaultConcurrency()).toBeGreaterThan(0)
  })

  it('does not exceed 16', () => {
    expect(defaultConcurrency()).toBeLessThanOrEqual(16)
  })
})
