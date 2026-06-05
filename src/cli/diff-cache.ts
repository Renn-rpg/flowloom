// Diff 词级 LCS 缓存 —— 基于泛型 LruCache。
//
// wordDiff 的 O(n*m) LCS 计算在重复 diff（如 edit→redo 场景）中浪费 CPU。
// 缓存键 = `${delLine}\x00${addLine}`（文本内容不变则 diff 结果不变）。

import { LruCache } from './lru-cache.js'

const MAX_SIZE = 200

export class DiffCache {
  private cache = new LruCache<string, { del: string; add: string }>(MAX_SIZE)

  get(delLine: string, addLine: string): { del: string; add: string } | undefined {
    return this.cache.get(`${delLine}\x00${addLine}`)
  }

  set(delLine: string, addLine: string, result: { del: string; add: string }): void {
    this.cache.set(`${delLine}\x00${addLine}`, result)
  }

  invalidate(): void {
    this.cache.invalidate()
  }

  get size(): number {
    return this.cache.size
  }
}
