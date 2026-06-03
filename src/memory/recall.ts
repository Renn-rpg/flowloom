// 记忆回忆：基于关键词匹配，从记忆列表中筛选相关记忆。
// 不做向量检索，保持简单、零依赖。

import type { MemoryEntry } from './store.js'
import { MEMORY_CONTENT_LIMIT } from '../config/constants.js'

// 将回忆结果格式化为 system prompt 注入片段
export function formatRecall(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = ['\n<system-reminder>', 'Relevant memories from previous sessions:', '']
  for (const e of entries) {
    lines.push(`## ${e.description}`)
    lines.push(e.content.slice(0, MEMORY_CONTENT_LIMIT))
    lines.push('')
  }
  lines.push('Keep these in mind when helping the user. If they contradict the current request, clarify with the user.</system-reminder>')
  return lines.join('\n')
}
