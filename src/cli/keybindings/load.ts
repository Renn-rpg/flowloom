// 按键绑定加载器 —— 三级配置合并（global > project），遵循 settings.ts 模式。
//
// 加载顺序：
//   1. 内置默认（DEFAULTS）
//   2. ~/.floom/keybindings.json（全局覆盖）
//   3. .floom/keybindings.json（项目覆盖，优先级最高）
//
// 合并策略：用户配置中的绑定按 (context, key) 对覆盖默认项。
// 设为 null 的 action 表示解绑（删除该绑定）。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Keybinding, KeybindingContext, KeybindingAction, KeyPattern } from './types.js'
import { DEFAULTS } from './defaults.js'
import { keybindingConfigSchema } from './schema.js'
import type { KeybindingConfigParsed } from './schema.js'

export interface LoadResult {
  bindings: Keybinding[]
  errors: string[]
}

// (context, key) 唯一键
function bindingKey(b: Keybinding): string {
  return `${b.context}:${b.key}`
}

// 加载并合并全部绑定。errors 包含解析失败信息（非致命，回退到默认）。
export function loadKeybindings(cwd: string = process.cwd()): LoadResult {
  const errors: string[] = []
  const map = new Map<string, Keybinding>()
  const unbindKeys = new Set<string>() // 用户设为 null 的解绑

  // 第一层：默认
  for (const d of DEFAULTS) {
    map.set(bindingKey(d), { ...d })
  }

  // 第二层：全局
  const globalPath = join(homedir(), '.floom', 'keybindings.json')
  mergeFile(globalPath, map, unbindKeys, errors)

  // 第三层：项目
  const projectPath = join(cwd, '.floom', 'keybindings.json')
  mergeFile(projectPath, map, unbindKeys, errors)

  // 过滤被解绑的条目
  const bindings = [...map.values()].filter(b => !unbindKeys.has(bindingKey(b)))

  return { bindings, errors }
}

function mergeFile(
  filePath: string,
  map: Map<string, Keybinding>,
  unbindKeys: Set<string>,
  errors: string[],
): void {
  if (!existsSync(filePath)) return

  // 限制文件大小，防止 OOM
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
    if (raw.length > 64 * 1024) {
      errors.push(`${filePath}: file too large (${(raw.length / 1024).toFixed(0)}KB > 64KB limit)`)
      return
    }
  } catch {
    errors.push(`Cannot read ${filePath}`)
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    errors.push(`${filePath}: invalid JSON — ${String(e)}`)
    return
  }

  const result = keybindingConfigSchema.safeParse(parsed)
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${filePath}: ${issue.path.join('.')} — ${issue.message}`)
    }
    return
  }

  const config: KeybindingConfigParsed = result.data
  for (const entry of config.bindings) {
    const kb: Keybinding = {
      key: entry.key as KeyPattern,
      action: entry.action as KeybindingAction,
      context: entry.context as KeybindingContext,
      description: entry.description,
    }
    const bk = bindingKey(kb)
    // 用户设 null 表示解绑
    if (entry.action === null) {
      unbindKeys.add(bk)
      map.delete(bk)
    } else {
      map.set(bk, kb)
    }
  }
}
