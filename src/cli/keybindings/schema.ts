// Zod schema for keybindings.json validation.
// 验证用户配置格式，拒绝非法按键描述和上下文名。

import { z } from 'zod'

const CONTEXTS = [
  'global', 'chat', 'autocomplete', 'select',
  'workflow-view', 'modal', 'help',
] as const

// 按键格式：单个可见字符、"ctrl+x"/"shift+x"、特殊键名。
// 注意：alt+ 组合暂不支持，因为终端把 Alt+key 作为 ESC+key 分两个 chunk 发送。
const KEY_PATTERN_RE = /^[a-zA-Z0-9]$|^(ctrl|shift)\+[a-zA-Z0-9]$|^(ctrl|shift)\+(tab|enter|up|down|left|right|home|end|delete|backspace|space|esc|o|e|r|d|c|n|p|s|x|q|t|f|g|h|j|k|l|b|w|u|v|m|z|y|a|i)$|^(up|down|left|right|home|end|delete|backspace|tab|enter|esc|space)$/

export const keyPatternSchema = z.string().regex(KEY_PATTERN_RE, 'Invalid key pattern. Use "ctrl+o", "shift+tab", "esc", etc.')

export const contextSchema = z.enum(CONTEXTS)

export const keybindingSchema = z.object({
  key: keyPatternSchema,
  action: z.string().min(1).nullable(), // null = 解绑该键
  context: contextSchema,
  description: z.string().optional(),
})

export const keybindingConfigSchema = z.object({
  bindings: z.array(keybindingSchema),
})

export type KeybindingConfigParsed = z.infer<typeof keybindingConfigSchema>
export type KeybindingParsed = z.infer<typeof keybindingSchema>
