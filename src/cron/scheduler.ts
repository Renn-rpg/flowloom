// Cron 调度引擎：基于 setInterval 的轻量调度，支持 5 字段 cron 表达式。
// 持久化任务在启动时恢复，会话级任务在进程退出后自动清理。

import { type CronEntry, CronStore } from './store.js'

// 解析 cron 表达式计算下一次触发时间。简化实现：每分钟检查一次。
// 完整 cron 实现可用 node-cron，此处为 0 依赖的简化版。
export function nextRunTime(expr: string, from: Date = new Date()): Date {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Invalid cron expression: "${expr}" (need 5 fields)`)

  const [min, hour, dom, month, dow] = parts
  const now = new Date(from.getTime() + 60_000) // 至少 +1 分钟

  // 简化：每分钟检查一次，找到匹配的时间
  for (let i = 0; i < 525600; i++) { // 最多往前找 1 年
    const d = new Date(from.getTime() + (i + 1) * 60_000)
    if (matchField(min, d.getMinutes(), 0, 59) &&
        matchField(hour, d.getHours(), 0, 23) &&
        matchField(dom, d.getDate(), 1, 31) &&
        matchField(month, d.getMonth() + 1, 1, 12) &&
        matchField(dow, d.getDay(), 0, 6)) {
      return d
    }
  }
  throw new Error(`No matching time in next year for cron: ${expr}`)
}

function matchField(field: string, value: number, _min: number, _max: number): boolean {
  if (field === '*') return true
  if (field.includes(',')) {
    return field.split(',').some(f => matchSingle(f.trim(), value))
  }
  return matchSingle(field, value)
}

function matchSingle(field: string, value: number): boolean {
  if (field === '*') return true
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10)
    return value % step === 0
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number)
    return value >= lo && value <= hi
  }
  return Number(field) === value
}

export class CronScheduler {
  private store: CronStore
  private jobs = new Map<string, { entry: CronEntry; timer: ReturnType<typeof setTimeout> }>()
  private onTrigger: (entry: CronEntry) => void
  private running = false

  constructor(store: CronStore, onTrigger: (entry: CronEntry) => void) {
    this.store = store
    this.onTrigger = onTrigger
  }

  start(): void {
    if (this.running) return
    this.running = true
    // 恢复持久化任务
    const entries = this.store.loadAll()
    for (const e of entries) {
      if (e.durable) this.schedule(e)
    }
  }

  add(entry: CronEntry): void {
    this.store.save(entry)
    this.schedule(entry)
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id)
    if (job) clearTimeout(job.timer)
    this.jobs.delete(id)
    return this.store.delete(id)
  }

  list(): CronEntry[] {
    return [...this.jobs.values()].map(j => j.entry)
  }

  private schedule(entry: CronEntry): void {
    const scheduleNext = () => {
      try {
        const next = nextRunTime(entry.expr)
        entry.nextRun = next.toISOString()
        this.store.save(entry)
        const delay = next.getTime() - Date.now()
        const timer = setTimeout(() => {
          this.onTrigger(entry)
          scheduleNext() // 递归调度下一次
        }, Math.max(0, delay))
        timer.unref?.()
        this.jobs.set(entry.id, { entry, timer })
      } catch {
        // 非法表达式 → 跳过
      }
    }
    scheduleNext()
  }

  stop(): void {
    this.running = false
    for (const [, job] of this.jobs) clearTimeout(job.timer)
    this.jobs.clear()
  }
}
