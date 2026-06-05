// 按键解码器 —— 从 stdin 原始字节/转义序列解析为语义 Key。
// 从 repl-input.ts 提取（保持行为完全一致），供 keybindings 模块和其他 UI 组件共享。
//
// 支持：普通字符、控制字符（^C/^D/^R/^O/^E/^A）、ANSI 转义序列（方向键/Home/End/
// Delete）、Kitty 键盘协议（Shift+Tab=CSI Z、Shift+Enter=CSI 13;2u）、Alt+Enter。
// 多字符粘贴合并为一个 char Key（ch 存完整内容）。

import type { Key } from './types.js'

// 把单个按键（或一段转义序列、或一段可见字符的粘贴）解析为语义按键。
export function decodeKey(s: string): Key {
  switch (s) {
    case '\r':
    case '\n':
      return { t: 'enter' }
    case '\x7f':
    case '\b':
      return { t: 'backspace' }
    case '\t':
      return { t: 'tab' }
    case '\x1b[Z': // Shift+Tab（CSI Z）→ 循环切换模式
      return { t: 'shift-tab' }
    case '\x03':
      return { t: 'ctrl-c' }
    case '\x04':
      return { t: 'ctrl-d' }
    case '\x12':
      return { t: 'ctrl-r' }
    case '\x0f':
      return { t: 'ctrl-o' }
    case '\x1b[13;2u': // Shift+Enter (kitty protocol)
    case '\x1b[13u':   // Shift+Enter (bare CSI u)
      return { t: 'newline' }
    case '\x1b\r': // Alt+Enter → 插入换行 (\r === \x0d)
      return { t: 'newline' }
    case '\x01': // Ctrl-A → 行首
      return { t: 'home' }
    case '\x05': // Ctrl-E → 展开全部细节
      return { t: 'ctrl-e' }
    case '\x1b':
      return { t: 'esc' }
    case '\x1b[A':
    case '\x1bOA':
      return { t: 'up' }
    case '\x1b[B':
    case '\x1bOB':
      return { t: 'down' }
    case '\x1b[C':
    case '\x1bOC':
      return { t: 'right' }
    case '\x1b[D':
    case '\x1bOD':
      return { t: 'left' }
    case '\x1b[H':
    case '\x1bOH':
    case '\x1b[1~':
      return { t: 'home' }
    case '\x1b[F':
    case '\x1bOF':
    case '\x1b[4~':
      return { t: 'end' }
    case '\x1b[3~':
      return { t: 'delete' }
  }
  // 可见字符（含多字符粘贴）：无控制字符、非转义序列、非 U+FFFD 替换字符
  if (
    s.length >= 1 &&
    !s.startsWith('\x1b') &&
    [...s].every((c) => c >= ' ' && c !== '\x7f' && c !== '�')
  ) {
    return { t: 'char', ch: s }
  }
  return { t: 'unknown' }
}
