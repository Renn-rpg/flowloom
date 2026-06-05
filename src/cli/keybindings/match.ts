// 按键匹配器 —— 给定一个 Key 和当前上下文栈，返回匹配的动作。
//
// 匹配优先级：上下文栈从栈顶到栈底（最近进入的 context 优先），最后 fallback 到 global。
// 参考 free-code 的 match.ts（context-scoped matching with fallback）。

import type { Key, Keybinding, KeybindingContext, KeybindingMatch, KeyPattern } from './types.js'

// 把语义 Key 转成与用户配置兼容的按键描述字符串（如 { t:'ctrl-o' } → "ctrl+o"）。
// 用于与 Keybinding.key 做字符串比较。
export function keyToPattern(k: Key): string | null {
  switch (k.t) {
    case 'char':
      return k.ch
    case 'enter':
      return 'enter'
    case 'backspace':
      return 'backspace'
    case 'delete':
      return 'delete'
    case 'tab':
      return 'tab'
    case 'shift-tab':
      return 'shift+tab'
    case 'esc':
      return 'esc'
    case 'up':
      return 'up'
    case 'down':
      return 'down'
    case 'left':
      return 'left'
    case 'right':
      return 'right'
    case 'home':
      return 'home'
    case 'end':
      return 'end'
    case 'ctrl-c':
      return 'ctrl+c'
    case 'ctrl-d':
      return 'ctrl+d'
    case 'ctrl-r':
      return 'ctrl+r'
    case 'ctrl-o':
      return 'ctrl+o'
    case 'ctrl-e':
      return 'ctrl+e'
    case 'newline':
      return 'shift+enter' // 统一用 shift+enter（alt+enter 也映射到此）
    case 'unknown':
      return null
  }
}

// 构建绑定索引：Map<context, Map<keyPattern, action>>
export type BindingIndex = Map<KeybindingContext, Map<KeyPattern, Keybinding>>

export function buildIndex(bindings: Keybinding[]): BindingIndex {
  const idx: BindingIndex = new Map()
  for (const b of bindings) {
    let ctxMap = idx.get(b.context)
    if (!ctxMap) {
      ctxMap = new Map()
      idx.set(b.context, ctxMap)
    }
    ctxMap.set(b.key, b)
  }
  return idx
}

// 在给定索引和上下文栈中匹配按键。
// contexts: 从栈顶到栈底（最近优先），不含 global（自动 fallback）。
export function matchKey(
  index: BindingIndex,
  contexts: KeybindingContext[],
  key: Key,
): KeybindingMatch | null {
  const pattern = keyToPattern(key)
  if (!pattern) return null

  // 先按上下文栈顺序匹配
  for (const ctx of contexts) {
    const ctxMap = index.get(ctx)
    if (ctxMap) {
      const binding = ctxMap.get(pattern)
      if (binding) {
        return { action: binding.action, context: binding.context, description: binding.description }
      }
    }
  }

  // fallback 到 global
  const globalMap = index.get('global')
  if (globalMap) {
    const binding = globalMap.get(pattern)
    if (binding) {
      return { action: binding.action, context: binding.context, description: binding.description }
    }
  }

  return null
}
