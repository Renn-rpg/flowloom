import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { InternalMessage } from '../protocol/types.js'

export interface PersistedSession {
  id: string
  createdAt: string
  updatedAt: string
  model: string
  cwd: string
  title: string // 首条 user 消息截断，用于列表展示
  messages: InternalMessage[]
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }
}

export interface SessionMeta {
  id: string
  updatedAt: string
  model: string
  title: string
  messageCount: number
}

// 合法 id 字符集：防止 resume <id> 时 id 含 "../" 造成路径穿越
const ID_RE = /^[A-Za-z0-9_.-]+$/

// 把一次 REPL 会话（messages + usage + 元数据）持久化为 <dir>/<id>.json。
export class SessionStore {
  constructor(private dir: string) {}

  private pathFor(id: string): string | null {
    if (!ID_RE.test(id)) return null
    return join(this.dir, `${id}.json`)
  }

  save(s: PersistedSession): void {
    const p = this.pathFor(s.id)
    if (!p) throw new Error(`invalid session id: ${s.id}`)
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')
  }

  load(id: string): PersistedSession | null {
    const p = this.pathFor(id)
    if (!p) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as PersistedSession
    } catch {
      return null
    }
  }

  list(): SessionMeta[] {
    let files: string[]
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'))
    } catch {
      return [] // 目录不存在 = 无会话
    }
    const metas: SessionMeta[] = []
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as PersistedSession
        if (!s || typeof s.id !== 'string') continue
        metas.push({
          id: s.id,
          updatedAt: s.updatedAt ?? '',
          model: s.model ?? '',
          title: s.title ?? '',
          messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
        })
      } catch {
        // 跳过损坏文件
      }
    }
    // ISO 时间串按字典序即时间序；倒序 → 最新在前
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return metas
  }

  latest(): PersistedSession | null {
    const metas = this.list()
    return metas.length > 0 ? this.load(metas[0].id) : null
  }
}
