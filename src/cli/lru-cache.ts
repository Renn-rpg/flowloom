// 泛型 LRU 缓存 —— 供 diff/highlight/markdown 等模块复用。
//
// 设计要点：
//   · Map 实现 O(1) get/set + 插入顺序追踪。
//   · get() 命中时重新插入以维护 LRU 顺序。
//   · set() 先删后插，容量溢出时驱逐最旧条目（Map 首个 key）。
//   · invalidate() 清空全部，size getter 返回当前条目数。
//   · 驱逐阈值用 > MAX_SIZE（先插入后检查，超出才驱逐）。

export class LruCache<K, V> {
  private map = new Map<K, V>()
  private maxSize: number

  constructor(maxSize = 500) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      // LRU: 删除再插入以更新顺序
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key: K, value: V): void {
    // 先删再插以确保 LRU 顺序
    this.map.delete(key)
    this.map.set(key, value)
    // 先插入后检查：size > maxSize 时才驱逐，保证可存满 maxSize 条
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  invalidate(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
