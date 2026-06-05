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
