// Cron 任务持久化：SQLite 存储，复用 journal 的 DatabaseSync 模式。

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

export interface CronEntry {
  id: string
  expr: string       // cron 表达式 "M H DoM Mon DoW"
  prompt: string      // 触发后执行的任务文本
  nextRun: string     // ISO 时间，下次触发
  durable: boolean    // true = 跨会话持久化
}

export class CronStore {
  private db: InstanceType<typeof DatabaseSync>

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        next_run TEXT NOT NULL,
        durable INTEGER NOT NULL DEFAULT 1
      )
    `)
  }

  save(entry: CronEntry): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO cron_jobs(id, expr, prompt, next_run, durable) VALUES(?,?,?,?,?)'
    )
    stmt.run(entry.id, entry.expr, entry.prompt, entry.nextRun, entry.durable ? 1 : 0)
  }

  loadAll(): CronEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM cron_jobs ORDER BY next_run'
    ).all() as any[]
    return rows.map((r: any) => ({
      id: r.id,
      expr: r.expr,
      prompt: r.prompt,
      nextRun: r.next_run,
      durable: r.durable !== 0,
    }))
  }

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM cron_jobs WHERE id=?').run(id)
    return r.changes > 0
  }

  close(): void {
    this.db.close()
  }
}
