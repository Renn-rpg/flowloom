// 记忆回忆：基于关键词匹配，从记忆列表中筛选相关记忆。
// 不做向量检索，保持简单、零依赖。

import type { MemoryEntry } from './store.js'

// 从用户输入或当前上下文提取关键词，返回匹配的记忆列表。
// 匹配策略：记忆的 name + description + content 中是否包含关键词。
export function recallMemories(memories: MemoryEntry[], query: string, maxResults = 5): MemoryEntry[] {
  const keywords = extractKeywords(query)
  if (keywords.length === 0) return []

  const scored = memories.map(m => ({
    entry: m,
    score: scoreMemory(m, keywords),
  }))

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.entry)
}

function extractKeywords(query: string): string[] {
  // 取前 200 字符，去特殊字符，分词
  return query
    .slice(0, 200)
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2) // 跳过单字符
}

function scoreMemory(m: MemoryEntry, keywords: string[]): number {
  const text = `${m.name} ${m.description} ${m.content}`.toLowerCase()
  let score = 0
  for (const kw of keywords) {
    const count = (text.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    score += count
  }
  return score
}

// 将回忆结果格式化为 system prompt 注入片段
export function formatRecall(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = ['\n<system-reminder>', 'Relevant memories from previous sessions:', '']
  for (const e of entries) {
    lines.push(`## ${e.description}`)
    lines.push(e.content.slice(0, 500)) // 截断长内容
    lines.push('')
  }
  lines.push('Keep these in mind when helping the user. If they contradict the current request, clarify with the user.</system-reminder>')
  return lines.join('\n')
}
