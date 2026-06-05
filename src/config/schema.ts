// FloomSettings Zod schema — 运行时校验 + 类型生成。
// 所有字段都有默认值，保证 loadSettings 返回完整可用配置。

import { z } from 'zod'

export const permissionsSchema = z.object({
  yolo: z.boolean().optional(),
  shellTimeout: z.number().int().positive().optional(),
  fetchTimeout: z.number().int().positive().optional(),
}).optional()

export const hooksSchema = z.object({
  path: z.string().optional(),
}).optional()

export const settingsSchema = z.object({
  model: z.string().optional(),
  maxTokens: z.number().int().positive().default(8192),
  // 上下文裁剪自保护预算（≈4 字符/token 估算超过它就从最旧对话轮整轮丢弃）。默认 1M：
  // 对齐旗舰 deepseek-v4-pro 的窗口（owner 设定，非官方实测，可 FLOOM_CONTEXT_TOKENS 覆盖；0=关闭）。
  contextTokens: z.number().int().min(0).default(1_000_000),
  effort: z.string().optional(),
  permissions: permissionsSchema,
  hooks: hooksSchema,
  autoCompact: z.boolean().default(true),
  sandbox: z.enum(['vm', 'isolated']).default('vm'),
}).default({})

export type ValidatedSettings = z.infer<typeof settingsSchema>

// 校验 + 填充默认值
export function validateSettings(raw: unknown): ValidatedSettings {
  return settingsSchema.parse(raw ?? {})
}
