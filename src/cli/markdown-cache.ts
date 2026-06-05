// Markdown 行内渲染 LRU 缓存 —— 基于泛型 LruCache。
//
// `renderInline` 在流式场景中会被同一文本反复调用（前缀不变，仅末尾变化）；
// LRU 缓存文本 → 已渲染字符串，避免重复正则匹配。

import { LruCache } from './lru-cache.js'

const MAX_SIZE = 500

export class MarkdownCache {
  private cache = new LruCache<string, string>(MAX_SIZE)

  get(text: string): string | undefined {
    return this.cache.get(text)
  }

  set(text: string, rendered: string): void {
    this.cache.set(text, rendered)
  }

  invalidate(): void {
    this.cache.invalidate()
  }

  get size(): number {
    return this.cache.size
  }
}
