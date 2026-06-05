import { color } from './theme.js'

export const fmt = {
  dim: color('dim'),
  bold: color('bold'),
  green: color('green'),
  red: color('red'),
  yellow: color('yellow'),
  cyan: color('cyan'),
  blue: color('blue'),
  white: color('white'),

  summary: (tokens: number, tools: number, ms: number) =>
    fmt.dim(`  ── ${tools} tools · ${tokens} tokens · ${(ms / 1000).toFixed(1)}s ──`),

  toolCompactRunning: (name: string, args: string) =>
    `  ${fmt.white('◌')} ${name}(${fmt.dim(args)})`,

  toolCompactDone: (name: string, args: string, ms: number) =>
    `  ${fmt.green('●')} ${name}(${fmt.dim(args)})  ${fmt.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  toolCompactError: (name: string, args: string, ms: number) =>
    `  ${fmt.red('●')} ${name}(${fmt.dim(args)})  ${fmt.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  inputLine: (width: number) =>
    fmt.white('─'.repeat(Math.max(0, width))),

  thinking: (ms: number) =>
    fmt.dim(`  Thinking... (${(ms / 1000).toFixed(1)}s)`),

  // 用户已发送消息：灰底渲染，占满终端宽度
  userMsg: (text: string, columns?: number) => {
    const termW = Math.max(40, Math.min(120, columns ?? 80))
    let line = text
    if (visualWidth(text) > termW - 1) {
      let w = 0
      for (let i = 0; i < text.length; i++) {
        const chW = visualWidth(text[i])
        if (w + chW > termW - 2) { line = text.slice(0, i) + '…'; break }
        w += chW
      }
    }
    const pad = Math.max(0, termW - visualWidth(stripAnsi(line)))
    return color('user-msg-bg')(line + ' '.repeat(pad))
  },
}

// —— 消息类型标签 ——

export type MsgType = 'user' | 'assistant' | 'tool' | 'system' | 'error'

export function msgTypeLabel(type: MsgType): string {
  switch (type) {
    case 'user':      return color('dim')('[USER]')
    case 'assistant': return color('blue')('[ASST]')
    case 'tool':      return color('yellow')('[TOOL]')
    case 'system':    return color('dim')('[SYS]')
    case 'error':     return color('red')('[ERR]')
  }
}

// 去除 ANSI SGR 颜色序列（chalk 产生的 \x1b[..m）。计算视觉宽度/物理行数前先剥掉，
// 否则转义序列里的字符会被错算成可见宽度。
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR_RE, '')
}

// 一行文本在给定列宽下占用的「物理行数」：CJK/Emoji 占 2 列,超过列宽即折行。
// 空行/窄到放不下也至少算 1 行。columns<=0(未知列宽)时按不折行处理。
export function physicalRows(line: string, columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 1
  const w = visualWidth(stripAnsi(line))
  return Math.max(1, Math.ceil(w / columns))
}

// 时长（ms → 人类可读）：>=1h → 1h2m；>=1m → 1m2s；否则 Ns。footer / workflow-view / status 共用。
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${s}s`
}

// token 数缩写：>=10k → 12k；>=1k → 1.2k；否则原值。
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

// 计算字符串在终端上的视觉宽度：CJK/全角/Emoji 占 2 列，其余占 1 列。
// 从 repl-input.ts 移入，供 blocks.ts 和 format.ts 共享。
export function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20 || cp === 0x7F) continue
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0xA4CF) ||   // CJK Radicals .. Yi
      (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compat
      (cp >= 0xFE10 && cp <= 0xFE6F) ||   // Vertical / Small Form
      (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth ASCII
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth signs
      (cp >= 0x1F300 && cp <= 0x1F9FF) || // Emoji & symbols
      (cp >= 0x20000 && cp <= 0x3FFFF)     // CJK Ext-B+
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}
