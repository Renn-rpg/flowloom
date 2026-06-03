// 从文件系统加载 `.md` 技能文件，支持 frontmatter 元数据。
// 扫描顺序：全局 (~/.floom/skills/) → 项目 (<cwd>/.floom/skills/)
// 项目级同名技能覆盖全局级。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import type { Skill } from './registry.js'

// 最简 frontmatter 解析：提取 --- 块之间的 YAML-like 键值对。
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== '---') return { meta: {}, body: raw }
  const end = lines.indexOf('---', 1)
  if (end === -1) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i].trim()
    const colon = line.indexOf(':')
    if (colon > 0) {
      const key = line.slice(0, colon).trim()
      const val = line.slice(colon + 1).trim()
      meta[key] = val
    }
  }
  const body = lines.slice(end + 1).join('\n').trim()
  return { meta, body }
}

function parseSkill(md: string, filePath: string): Skill | null {
  const { meta, body } = parseFrontmatter(md)
  const name = meta.name?.trim()
  if (!name || !body) return null
  return {
    name,
    description: meta.description?.trim() ?? `User skill: ${name}`,
    systemPrompt: body,
    version: meta.version?.trim() || undefined,
    toolAllowlist: meta.toolAllowlist
      ? meta.toolAllowlist.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
    readOnly: meta.readOnly === 'true',
  }
}

export function loadSkillsFromDir(dir: string): Skill[] {
  const skills: Skill[] = []
  try {
    if (!existsSync(dir)) return skills
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (extname(entry) !== '.md') continue
      const filePath = join(dir, entry)
      try {
        const raw = readFileSync(filePath, 'utf8')
        const skill = parseSkill(raw, filePath)
        if (skill) skills.push(skill)
      } catch {
        // 坏文件/权限问题 → 跳过
      }
    }
  } catch {
    // 目录不可读 → 返回空
  }
  return skills
}

// mtime 缓存：记录每个 .md 文件的修改时间，用于检测变更后的自动重载
const _mtimeCache = new Map<string, number>()

/** 检测目录中技能文件是否有变更（新增/删除/修改），有变更返回 true */
export function hasSkillChanges(dir: string): boolean {
  try {
    if (!existsSync(dir)) {
      // 目录被删除 → 始终视为变更，清理缓存
      let had = false
      for (const key of _mtimeCache.keys()) {
        if (key.startsWith(dir)) { _mtimeCache.delete(key); had = true }
      }
      return had || _mtimeCache.has(dir)
    }
    const entries = readdirSync(dir).filter(e => extname(e) === '.md')
    const currentFiles = new Set<string>()

    for (const entry of entries) {
      const filePath = join(dir, entry)
      currentFiles.add(filePath)
      try {
        const mtime = statSync(filePath).mtimeMs
        if (_mtimeCache.get(filePath) !== mtime) {
          _mtimeCache.set(filePath, mtime)
          return true
        }
      } catch {
        return true
      }
    }

    for (const cached of _mtimeCache.keys()) {
      if (cached.startsWith(dir) && !currentFiles.has(cached)) {
        _mtimeCache.delete(cached)
        return true
      }
    }

    return false
  } catch {
    return true // 目录不可读 → 视为变更
  }
}

// 加载全部技能：全局 + 项目级，项目级覆盖全局级同名技能。
export function loadAllSkills(cwd: string, home?: string): Skill[] {
  const map = new Map<string, Skill>()

  // 全局技能
  if (home) {
    for (const s of loadSkillsFromDir(resolve(home, '.floom', 'skills'))) {
      map.set(s.name, s)
    }
  }

  // 项目级技能（覆盖同名）
  for (const s of loadSkillsFromDir(resolve(cwd, '.floom', 'skills'))) {
    map.set(s.name, s)
  }

  return [...map.values()]
}
