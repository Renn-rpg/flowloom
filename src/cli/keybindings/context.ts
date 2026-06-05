// 上下文栈管理器 —— 跟踪当前活跃的 UI 上下文。
//
// 一个按键可能在不同 context 下触发不同动作。ContextManager 维护一个栈：
// 最近进入的 context 在栈顶，匹配时从栈顶往下找，最后 fallback 到 global。
//
// 用法：
//   const ctx = createContextManager()
//   ctx.push('select')      // 打开选择菜单
//   ctx.match(index, key)    // 按当前栈匹配
//   ctx.pop()               // 关闭菜单

import type { Key, KeybindingContext, ContextEntry, KeybindingMatch } from './types.js'
import type { BindingIndex } from './match.js'
import { matchKey } from './match.js'

export class ContextManager {
  private stack: ContextEntry[] = []

  // 进入一个上下文。通常由 UI 组件在显示时调用。
  push(context: KeybindingContext): void {
    this.stack.push({ context, enteredAt: Date.now() })
  }

  // 离开最近进入的上下文。
  pop(): void {
    if (this.stack.length === 0) return
    this.stack.pop()
  }

  // 获取当前上下文栈（从栈顶到栈底），供 match.ts 使用。
  get contexts(): KeybindingContext[] {
    return this.stack.map(e => e.context).reverse()
  }

  // 栈深度（用于调试）。
  get depth(): number {
    return this.stack.length
  }

  // 当前最顶层的上下文（无则返回 'global'）。
  get top(): KeybindingContext {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].context : 'global'
  }

  // 便捷方法：给定索引和按键，返回匹配的动作。
  match(index: BindingIndex, key: Key): KeybindingMatch | null {
    return matchKey(index, this.contexts, key)
  }

  // 清空栈（通常在模式切换或重置时调用）。
  clear(): void {
    this.stack.length = 0
  }
}

// 工厂函数。
export function createContextManager(): ContextManager {
  return new ContextManager()
}
