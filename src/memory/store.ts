// 记忆系统：跨会话持久化用户偏好、项目约定和引用信息。
// 记忆文件格式：markdown frontmatter + 正文内容。
//
// 存储目录：
//   ~/.claude/memory/          — 用户级全局记忆
//   <project>/.floom/memory/  — 项目级记忆

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryMeta {
  name: string   // kebab-case slug，文件名（含 .md）
  description: string
  type: MemoryType
}

export interface MemoryEntry {
  name: string
  description: string
  type: MemoryType
  content: string // 去掉 frontmatter 后的正文
}

// 解析 frontmatter 的 memory 文件
function parseMemoryFile(raw: string): MemoryEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return null
  const header = m[1]
  const content = m[2].trim()

  const name = (header.match(/^name:\s*(.+)$/m) ?? [])[1]?.trim() ?? ''
  const description = (header.match(/^description:\s*(.+)$/m) ?? [])[1]?.trim() ?? ''
  const typeRaw = (header.match(/^metadata:\s*\n\s*type:\s*(.+)$/m) ?? [])[1]?.trim() ?? 'reference'

  if (!name) return null

  const type: MemoryType =
    typeRaw === 'user' || typeRaw === 'feedback' || typeRaw === 'project' || typeRaw === 'reference'
      ? typeRaw
      : 'reference'

  return { name, description, type, content }
}

// 序列化为 frontmatter markdown 格式
export function formatMemory(entry: MemoryEntry): string {
  return [
    '---',
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    'metadata:',
    `  type: ${entry.type}`,
    '---',
    '',
    entry.content,
  ].join('\n')
}

export class MemoryStore {
  private dirs: string[]

  constructor(projectDir?: string) {
    this.dirs = []
    // 全局记忆（用户级，跨项目共享）
    const globalDir = join(homedir(), '.claude', 'memory')
    this.dirs.push(globalDir)
    // 项目记忆
    if (projectDir) {
      this.dirs.push(join(projectDir, '.floom', 'memory'))
    }
  }

  // 列出所有目录下的记忆条目（去重：同 name 的优先项目级）
  list(): MemoryMeta[] {
    const seen = new Map<string, MemoryMeta>()
    // 先读全局，再读项目（后者覆盖前者）
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue
      let files: string[]
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.md'))
      } catch {
        continue
      }
      for (const f of files) {
        try {
          const raw = readFileSync(join(dir, f), 'utf8')
          const entry = parseMemoryFile(raw)
          if (entry) {
            seen.set(entry.name, { name: f, description: entry.description, type: entry.type })
          }
        } catch {
          // 跳过损坏文件
        }
      }
    }
    return [...seen.values()]
  }

  // 读取（自动查全局+项目，项目优先）
  load(name: string): MemoryEntry | null {
    for (const dir of [...this.dirs].reverse()) {
      // 反向：项目目录优先
      const p = join(dir, `${name}.md`)
      try {
        const raw = readFileSync(p, 'utf8')
        return parseMemoryFile(raw)
      } catch {
        continue
      }
    }
    return null
  }

  // 写入到指定目录（默认写入项目目录；若无项目目录则写全局）
  save(name: string, entry: MemoryEntry, forceGlobal = false): void {
    const dir = forceGlobal || this.dirs.length < 2 ? this.dirs[0] : this.dirs[1]
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `${name}.md`)
    writeFileSync(p, formatMemory(entry), 'utf8')
  }

  // 删除
  delete(name: string): boolean {
    for (const dir of [...this.dirs].reverse()) {
      const p = join(dir, `${name}.md`)
      try {
        unlinkSync(p)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  // 列出所有记忆的完整内容（用于注入 system prompt）
  loadAll(): MemoryEntry[] {
    const metas = this.list()
    return metas.map(m => this.load(m.name.replace(/\.md$/, ''))).filter(Boolean) as MemoryEntry[]
  }
}
