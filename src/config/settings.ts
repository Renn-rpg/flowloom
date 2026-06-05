// 设置系统：全局/项目/本地三层配置，深层合并，Zod 校验。
//
// 优先级（低 → 高）：
//   ~/.floom/settings.json       — 全局配置
//   .floom/settings.json          — 项目配置
//   .floom/settings.local.json    — 本地配置（gitignore）
//
// 读取逻辑：深层合并，数组用覆盖（不合并），高优先级覆盖低优先级。

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { validateSettings, type ValidatedSettings } from './schema.js'

export interface FloomSettings {
  model?: string
  maxTokens?: number
  contextTokens?: number
  effort?: string
  permissions?: {
    yolo?: boolean
    shellTimeout?: number
    fetchTimeout?: number
  }
  hooks?: {
    path?: string
  }
}

const DEFAULT_SETTINGS: FloomSettings = {
  maxTokens: 8192,
  contextTokens: 1_000_000, // 默认 1M 上下文窗口（对齐 deepseek-v4-pro；owner 设定，可 env/配置覆盖，0=关闭裁剪）
}

// 简单深层合并（仅 2 层，符合 settings 结构）
function mergeDeep(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [k, v] of Object.entries(override)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue // 防原型污染
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        k in result && typeof result[k] === 'object' && !Array.isArray(result[k])) {
      result[k] = mergeDeep(result[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      result[k] = v
    }
  }
  return result
}

function loadJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    if (statSync(path).size > 1_000_000) return null // 拒绝 >1MB 的配置文件
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 坏 JSON → 跳过
  }
  return null
}

export function loadSettings(projectDir: string, envOverrides?: Record<string, string>): ValidatedSettings {
  const global = loadJson(join(homedir(), '.floom', 'settings.json'))
  const project = loadJson(join(projectDir, '.floom', 'settings.json'))
  const local = loadJson(join(projectDir, '.floom', 'settings.local.json'))

  let merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>
  if (global) merged = mergeDeep(merged, global)
  if (project) merged = mergeDeep(merged, project)
  if (local) merged = mergeDeep(merged, local)

  // 环境变量覆盖（最高优先级）
  const overrides = envOverrides ?? process.env as Record<string, string>
  if (overrides.FLOOM_MODEL) merged.model = overrides.FLOOM_MODEL
  if (overrides.FLOOM_MAX_TOKENS) {
    const v = Number(overrides.FLOOM_MAX_TOKENS)
    merged.maxTokens = Number.isFinite(v) && v > 0 ? v : 8192
  }
  if (overrides.FLOOM_CONTEXT_TOKENS) merged.contextTokens = Math.max(0, Number(overrides.FLOOM_CONTEXT_TOKENS) || 0)
  if (overrides.FLOOM_EFFORT) merged.effort = overrides.FLOOM_EFFORT

  // Zod 校验 + 填充默认值
  return validateSettings(merged)
}

// 生成 settings 文件的 JSON 描述（供 /config 展示）
export function describeSettings(settings: FloomSettings): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(settings).filter(([, v]) => v !== undefined)) {
    if (typeof v === 'object' && v !== null) {
      lines.push(`${k}:`)
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${sk}: ${JSON.stringify(sv)}`)
      }
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    }
  }
  return lines.join('\n')
}

// 热重载支持

/** 保存单个配置项到项目级 .floom/settings.json */
export function saveSetting(projectDir: string, key: string, value: unknown): string {
  const path = join(projectDir, '.floom', 'settings.json')
  const current = loadJson(path) ?? {}
  // 支持嵌套键（如 "permissions.yolo"）
  const keys = key.split('.').filter(k => k !== '')
  if (keys.length === 0) return 'ERROR: invalid key'
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      return 'ERROR: invalid key (prototype pollution blocked)'
    }
  }
  let obj = current
  for (let i = 0; i < keys.length - 1; i++) {
    const existing = obj[keys[i]]
    if (existing === null || existing === undefined || typeof existing !== 'object' || Array.isArray(existing)) {
      obj[keys[i]] = {}
    }
    obj = obj[keys[i]] as Record<string, unknown>
  }
  obj[keys[keys.length - 1]] = value
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(current, null, 2), 'utf8')
    return `Saved ${key} = ${JSON.stringify(value)}`
  } catch (e) {
    return `ERROR: failed to save settings: ${(e as Error).message}`
  }
}

/** 删除项目级配置文件，恢复默认值 */
export function resetSettings(projectDir: string): string {
  const path = join(projectDir, '.floom', 'settings.json')
  try {
    if (existsSync(path)) { unlinkSync(path); return 'Settings reset to defaults.' }
    return 'No project settings to reset.'
  } catch (e) {
    return `ERROR: failed to reset settings: ${(e as Error).message}`
  }
}
