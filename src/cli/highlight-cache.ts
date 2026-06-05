// 代码高亮 LRU 缓存 —— 基于泛型 LruCache。
//
// 缓存策略：容量 500 条。键 = `${lang}\x00${line}`（用 NUL 分隔，
// 避免 lang 和 line 的意外碰撞）。缓存命中时无需重新 tokenize+上色。

import { LruCache } from './lru-cache.js'

const MAX_SIZE = 500

export class HighlightCache {
  private cache = new LruCache<string, string>(MAX_SIZE)

  get(lang: string, line: string): string | undefined {
    return this.cache.get(`${lang}\x00${line}`)
  }

  set(lang: string, line: string, rendered: string): void {
    this.cache.set(`${lang}\x00${line}`, rendered)
  }

  invalidate(): void {
    this.cache.invalidate()
  }

  get size(): number {
    return this.cache.size
  }
}
