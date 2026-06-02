import { describe, it, expect, vi, beforeEach } from 'vitest'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextRunTime, CronScheduler } from './scheduler.js'
import { CronStore, type CronEntry } from './store.js'
import { makeCronCreateTool, makeCronListTool, makeCronDeleteTool } from './tool.js'

// 冻结"现在"以保证 nextRunTime 结果可预测
const FROZEN = new Date('2026-06-02T12:00:00.000Z')

describe('nextRunTime', () => {
  it('finds next minute for wildcard', () => {
    const next = nextRunTime('* * * * *', FROZEN)
    expect(next.getTime()).toBeGreaterThan(FROZEN.getTime())
    expect(next.getMinutes()).toBe(1) // from 12:00 → 12:01
  })

  it('matches specific hour/minute', () => {
    // "30 14 * * *" = daily at 14:30。用本地时间 12:00 做起点断言分钟为 30、小时在合理范围
    const local = new Date(FROZEN.getFullYear(), FROZEN.getMonth(), FROZEN.getDate(), 12, 0)
    const next = nextRunTime('30 14 * * *', local)
    expect(next.getMinutes()).toBe(30)
    // 小时>=14（若 12:00 则当天 14:30；若已过则次日 14:30）
    expect(next.getHours()).toBeGreaterThanOrEqual(14)
  })

  it('handles step values (*/5)', () => {
    // "*/5 * * * *" = every 5 minutes. From 12:00 → 12:05
    const next = nextRunTime('*/5 * * * *', FROZEN)
    expect(next.getMinutes() % 5).toBe(0)
    expect(next.getTime()).toBeGreaterThan(FROZEN.getTime())
  })

  it('handles comma-separated values', () => {
    // "0,30 * * * *" = at :00 and :30 of each hour. From 12:00 → 12:30 (12:00 is exactly now, so next is 12:30 since we skip current minute)
    const next = nextRunTime('0,30 * * * *', FROZEN)
    expect(next.getMinutes()).toBe(30)
  })

  it('handles range values', () => {
    // "0 9-17 * * *" = 整点在 9-17 之间。用本地时间 10:30 作为起点，下一匹配应为 11:00
    const local = new Date(FROZEN.getFullYear(), FROZEN.getMonth(), FROZEN.getDate(), 10, 30)
    const next = nextRunTime('0 9-17 * * *', local)
    expect(next.getMinutes()).toBe(0)
    // 小时应在 9-17 范围内
    expect(next.getHours()).toBeGreaterThanOrEqual(9)
    expect(next.getHours()).toBeLessThanOrEqual(17)
    // 从 10:30 出发，下一整点应为 11:00
    expect(next.getHours()).toBe(11)
  })

  it('throws on invalid expression', () => {
    expect(() => nextRunTime('invalid', FROZEN)).toThrow('Invalid cron expression')
    expect(() => nextRunTime('* * *', FROZEN)).toThrow('Invalid cron expression')
  })

  it('respects day-of-week filter', () => {
    // "0 9 * * 1" = Monday at 9am. 2026-06-02 is a Tuesday (day 2).
    // Next Monday from Tue Jun 2 12:00 → Mon Jun 8 09:00
    const next = nextRunTime('0 9 * * 1', FROZEN)
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getHours()).toBe(9)
  })
})

describe('CronScheduler', () => {
  let store: CronStore
  let scheduler: CronScheduler
  let triggered: CronEntry[]

  beforeEach(() => {
    store = new CronStore(':memory:')
    triggered = []
    scheduler = new CronScheduler(store, (e) => triggered.push(e))
  })

  it('adds and lists cron jobs', () => {
    const entry: CronEntry = {
      id: 'test_1',
      expr: '0 9 * * *',
      prompt: 'daily report',
      durable: true,
      nextRun: FROZEN.toISOString(),
    }
    scheduler.add(entry)
    const list = scheduler.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test_1')
    expect(list[0].expr).toBe('0 9 * * *')
  })

  it('removes cron jobs by id', () => {
    scheduler.add({ id: 'test_1', expr: '* * * * *', prompt: 'p', durable: false, nextRun: FROZEN.toISOString() })
    expect(scheduler.remove('test_1')).toBe(true)
    expect(scheduler.list()).toHaveLength(0)
  })

  it('returns false when removing non-existent job', () => {
    expect(scheduler.remove('nope')).toBe(false)
  })

  it('starts and stops without error', () => {
    scheduler.start()
    scheduler.stop()
    // 无异常 = 通过
  })
})

describe('CronStore', () => {
  it('saves and loads entries', () => {
    const store = new CronStore(':memory:')
    const entry: CronEntry = {
      id: 'c1',
      expr: '0 9 * * 1-5',
      prompt: 'weekday report',
      durable: true,
      nextRun: FROZEN.toISOString(),
    }
    store.save(entry)
    const all = store.loadAll()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('c1')
    expect(all[0].expr).toBe('0 9 * * 1-5')
    expect(all[0].durable).toBe(true)
    store.close()
  })

  it('deletes entries', () => {
    const store = new CronStore(':memory:')
    store.save({ id: 'c1', expr: '* * * * *', prompt: 'x', durable: true, nextRun: FROZEN.toISOString() })
    expect(store.delete('c1')).toBe(true)
    expect(store.loadAll()).toHaveLength(0)
    store.close()
  })

  it('returns false when deleting non-existent', () => {
    const store = new CronStore(':memory:')
    expect(store.delete('no-such')).toBe(false)
    store.close()
  })

  it('persists across store instances', () => {
    // :memory: 无法跨实例，用文件路径
    const tmpPath = join(tmpdir(), `floom-cron-test-${Date.now()}.db`)
    const s1 = new CronStore(tmpPath)
    s1.save({ id: 'p1', expr: '0 0 * * *', prompt: 'midnight', durable: true, nextRun: FROZEN.toISOString() })
    s1.close()

    const s2 = new CronStore(tmpPath)
    const all = s2.loadAll()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('p1')
    s2.close()

    // cleanup
    try { unlinkSync(tmpPath) } catch {}
  })
})

describe('cron tools', () => {
  let store: CronStore
  let scheduler: CronScheduler

  beforeEach(() => {
    store = new CronStore(':memory:')
    scheduler = new CronScheduler(store, () => {})
  })

  describe('cron_create', () => {
    it('creates a cron job and returns its id', async () => {
      const tool = makeCronCreateTool(scheduler, store)
      const result = await tool.handler({ expr: '0 9 * * *', prompt: 'daily task', durable: true })
      expect(result).toContain('Scheduled cron job cron_')
      expect(scheduler.list()).toHaveLength(1)
    })

    it('returns error when expr is missing', async () => {
      const tool = makeCronCreateTool(scheduler, store)
      const result = await tool.handler({ prompt: 'no expr' })
      expect(result).toContain('ERROR')
    })
  })

  describe('cron_list', () => {
    it('returns "No scheduled cron jobs" when empty', async () => {
      const tool = makeCronListTool(scheduler)
      const result = await tool.handler({})
      expect(result).toBe('No scheduled cron jobs.')
    })

    it('lists scheduled jobs', async () => {
      scheduler.add({ id: 'c1', expr: '0 9 * * *', prompt: 'daily', durable: true, nextRun: FROZEN.toISOString() })
      const tool = makeCronListTool(scheduler)
      const result = await tool.handler({})
      expect(result).toContain('c1')
      expect(result).toContain('0 9 * * *')
    })
  })

  describe('cron_delete', () => {
    it('deletes an existing job', async () => {
      scheduler.add({ id: 'c1', expr: '* * * * *', prompt: 'p', durable: false, nextRun: FROZEN.toISOString() })
      const tool = makeCronDeleteTool(scheduler)
      const result = await tool.handler({ id: 'c1' })
      expect(result).toContain('Deleted cron job c1')
      expect(scheduler.list()).toHaveLength(0)
    })

    it('returns not found for missing id', async () => {
      const tool = makeCronDeleteTool(scheduler)
      const result = await tool.handler({ id: 'nope' })
      expect(result).toContain('not found')
    })
  })
})
