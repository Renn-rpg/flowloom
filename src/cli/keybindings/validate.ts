// 按键绑定校验器 —— 提供友好的配置错误信息。
// 在加载配置时由 load.ts 调用，也可由 /keybindings validate 命令直接使用。

import { keybindingConfigSchema, type KeybindingConfigParsed } from './schema.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
  parsed: KeybindingConfigParsed | null
}

// 校验 JSON 字符串是否符合 keybindings.json 格式。
export function validateKeybindingConfig(json: string): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    return { valid: false, errors: [`Invalid JSON: ${String(e)}`], parsed: null }
  }

  const result = keybindingConfigSchema.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues.map(
      i => `${i.path.join('.')}: ${i.message}`
    )
    return { valid: false, errors, parsed: null }
  }

  return { valid: true, errors: [], parsed: result.data }
}

// 校验单个绑定条目。
export function validateBinding(binding: unknown): { valid: boolean; error?: string } {
  const result = keybindingConfigSchema.shape.bindings.element.safeParse(binding)
  if (!result.success) {
    return { valid: false, error: result.error.issues.map(i => i.message).join('; ') }
  }
  return { valid: true }
}
