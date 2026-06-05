import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, renameSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InternalMessage } from '../protocol/types.js'

export interface PersistedSession {
  id: string
  createdAt: string
  updatedAt: string
  model: string
  cwd: string
  title: string
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

// 元数据文件（轻量，不含 messages，供 list() 快速读取）
function metaPath(dir: string, id: string): string { return join(dir, `meta-${id}.json`) }

// 消息文件（JSONL 格式，每行一个 InternalMessage，save() 只追加新行）
function msgsPath(dir: string, id: string): string { return join(dir, `msgs-${id}.jsonl`) }

// 旧格式全量 JSON 文件路径（用于自动迁移）
function legacyPath(dir: string, id: string): string { return join(dir, `${id}.json`) }

interface MetaRecord {
  id: string
  createdAt: string
  updatedAt: string
  model: string
  cwd: string
  title: string
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }
  msgCount: number
}

export class SessionStore {
  // 内存缓存：会话的消息行数，避免每次 save() 都读整个 JSONL 文件统计换行
  private _msgCounts = new Map<string, number>()

  constructor(private dir: string) {}

  private validId(id: string): string | null {
    return ID_RE.test(id) ? id : null
  }

  // ── 原子写入 ──────────────────────────────────────────────────────────
  // 复用 edit.ts 的 writeFile + rename 模式，避免崩溃损坏持久化数据。

  private atomicWrite(path: string, content: string): void {
    const tmp = join(this.dir, `.tmp-${Math.random().toString(36).slice(2)}`)
    writeFileSync(tmp, content, 'utf8')
    try {
      renameSync(tmp, path)
    } catch {
      try { unlinkSync(tmp) } catch { /* best-effort */ }
      throw new Error(`Failed to write ${path}: rename failed`)
    }
  }

  // ── 旧格式迁移 ──────────────────────────────────────────────────────────
  // 检测旧版全量 JSON 文件，自动转换为 meta + JSONL 分离格式。

  private migrateIfNeeded(id: string): void {
    const legacy = legacyPath(this.dir, id)
    if (!existsSync(legacy)) return
    try {
      const s: PersistedSession = JSON.parse(readFileSync(legacy, 'utf8'))
      // 写 meta（原子）
      const meta: MetaRecord = {
        id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt,
        model: s.model, cwd: s.cwd, title: s.title, usage: s.usage,
        msgCount: s.messages.length,
      }
      mkdirSync(this.dir, { recursive: true })
      this.atomicWrite(metaPath(this.dir, id), JSON.stringify(meta, null, 2))
      // 写 messages（JSONL，每行一条）
      const mPath = msgsPath(this.dir, id)
      writeFileSync(mPath, s.messages.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf8')
      // 迁移成功 → 删除旧文件
      try { unlinkSync(legacy) } catch { /* best-effort */ }
    } catch {
      // 迁移失败保留旧文件，下次再试
    }
  }

  // ── 保存 ──────────────────────────────────────────────────────────────
  // JSONL 增量存储：首次保存写全量 messages，后续保存只追加自上次以来的新消息。
  // 元数据每次保存都原子更新（仅 ~500 字节，不随消息增长）。

  save(s: PersistedSession): void {
    const id = this.validId(s.id)
    if (!id) throw new Error(`invalid session id: ${s.id}`)
    mkdirSync(this.dir, { recursive: true })

    // 增量写 messages JSONL——用缓存避免每次读整个文件统计行数
    const mPath = msgsPath(this.dir, id)
    const cached = this._msgCounts.get(id) ?? 0
    const existingCount = cached > 0 ? cached : 0
    const newMsgs = s.messages.slice(existingCount)
    // 更新缓存（无论是否写盘，messages 总数已变）
    this._msgCounts.set(id, s.messages.length)
    if (newMsgs.length > 0) {
      // 原子追加：先写临时文件拼合已有+新增，再 rename
      const tmp = join(this.dir, `.tmp-msgs-${Math.random().toString(36).slice(2)}`)
      try {
        if (existsSync(mPath)) {
          writeFileSync(tmp, readFileSync(mPath, 'utf8') + newMsgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf8')
        } else {
          writeFileSync(tmp, newMsgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf8')
        }
        renameSync(tmp, mPath)
      } catch {
        try { unlinkSync(tmp) } catch { /* best-effort */ }
        throw new Error(`Failed to save session messages: rename failed`)
      }
    }

    // 原子写元数据（始终全量，因为体积小 ~500 字节）
    const meta: MetaRecord = {
      id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt,
      model: s.model, cwd: s.cwd, title: s.title, usage: s.usage,
      msgCount: s.messages.length,
    }
    this.atomicWrite(metaPath(this.dir, id), JSON.stringify(meta, null, 2))

    // 清理旧格式文件（若存在）
    const legacy = legacyPath(this.dir, id)
    if (existsSync(legacy)) try { unlinkSync(legacy) } catch { /* best-effort */ }
  }

  // ── 读取 ──────────────────────────────────────────────────────────────

  load(id: string): PersistedSession | null {
    if (!this.validId(id)) return null
    this.migrateIfNeeded(id)
    try {
      const meta: MetaRecord = JSON.parse(readFileSync(metaPath(this.dir, id), 'utf8'))
      const mPath = msgsPath(this.dir, id)
      let messages: InternalMessage[] = []
      if (existsSync(mPath)) {
        messages = readFileSync(mPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => { try { return JSON.parse(line) as InternalMessage } catch { return null } })
          .filter(Boolean) as InternalMessage[]
      }
      this._msgCounts.set(id, messages.length) // 填充缓存
      return {
        id: meta.id, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
        model: meta.model, cwd: meta.cwd, title: meta.title,
        messages, usage: meta.usage,
      }
    } catch {
      return null
    }
  }

  // ── 列表（只读元数据文件，~500 字节/会话，O(n) 但极快）────────────

  list(): SessionMeta[] {
    mkdirSync(this.dir, { recursive: true }) // 确保目录存在
    // 先迁移所有旧格式文件
    let legacyFiles: string[]
    try { legacyFiles = readdirSync(this.dir).filter(f => f.endsWith('.json') && !f.startsWith('meta-')) }
    catch { legacyFiles = [] }
    for (const f of legacyFiles) {
      const id = f.replace(/\.json$/, '')
      this.migrateIfNeeded(id)
    }

    // 只读 meta 文件
    let files: string[]
    try { files = readdirSync(this.dir).filter(f => f.startsWith('meta-') && f.endsWith('.json')) }
    catch { return [] }

    const metas: SessionMeta[] = []
    for (const f of files) {
      try {
        const m: MetaRecord = JSON.parse(readFileSync(join(this.dir, f), 'utf8'))
        if (!m || typeof m.id !== 'string') continue
        metas.push({
          id: m.id, updatedAt: m.updatedAt ?? '', model: m.model ?? '',
          title: m.title ?? '', messageCount: m.msgCount ?? 0,
        })
      } catch { /* skip corrupt */ }
    }
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return metas
  }

  latest(): PersistedSession | null {
    const metas = this.list()
    return metas.length > 0 ? this.load(metas[0].id) : null
  }

  delete(id: string): boolean {
    if (!this.validId(id)) return false
    this._msgCounts.delete(id)
    let ok = false
    for (const path of [metaPath(this.dir, id), msgsPath(this.dir, id), legacyPath(this.dir, id)]) {
      try { unlinkSync(path); ok = true } catch { /* skip missing */ }
    }
    return ok
  }

  cleanOldSessions(keep = 50): number {
    const metas = this.list()
    if (metas.length <= keep) return 0
    let deleted = 0
    for (const m of metas.slice(keep)) { if (this.delete(m.id)) deleted++ }
    return deleted
  }
}
