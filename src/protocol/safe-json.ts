// 容错解析 DeepSeek 可能产出的非法 JSON（规划 §4.2 第二层修复）
export function safeParseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) } catch { /* fallthrough */ }
  // 简单修复：补足缺失的右花括号后重试
  const opens = (raw.match(/\{/g) ?? []).length
  const closes = (raw.match(/\}/g) ?? []).length
  if (opens > closes) {
    try { return JSON.parse(raw + '}'.repeat(opens - closes)) } catch { /* fallthrough */ }
  }
  return {}
}
