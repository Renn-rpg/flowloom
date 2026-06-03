// 容错解析 DeepSeek 可能产出的非法 JSON（规划 §4.2 第二层修复）。
// 含深度限制防 DoS 攻击（恶意深度嵌套 JSON 可导致栈溢出）。

const MAX_DEPTH = 64
const MAX_LENGTH = 256 * 1024 // 256KB 上限，工具参数不应超过此值

function checkDepth(obj: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('JSON depth limit exceeded')
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      checkDepth(v, depth + 1)
    }
  }
}

export function safeParseArgs(raw: string): Record<string, unknown> {
  // 长度上限
  if (raw.length > MAX_LENGTH) return {}

  try {
    const obj = JSON.parse(raw)
    checkDepth(obj)
    return obj
  } catch { /* fallthrough */ }

  // 简单修复：补足缺失的右花括号后重试
  const opens = (raw.match(/\{/g) ?? []).length
  const closes = (raw.match(/\}/g) ?? []).length
  if (opens > closes && opens - closes <= 10) {
    try {
      const obj = JSON.parse(raw + '}'.repeat(opens - closes))
      checkDepth(obj)
      return obj
    } catch { /* fallthrough */ }
  }
  return {}
}
