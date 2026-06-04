import chalk from 'chalk'

// NO_COLOR / TERM=dumb / 非 TTY 管道 → 禁用颜色
const useColor = !process.env.NO_COLOR && process.env.TERM !== 'dumb' && !!process.stderr.isTTY
const c = (fn: (s: string) => string) => (s: string) => useColor ? fn(s) : s

export const fmt = {
  dim: c(chalk.dim),
  bold: c(chalk.bold),
  green: c(chalk.green),
  red: c(chalk.red),
  yellow: c(chalk.yellow),
  cyan: c(chalk.cyan),
  blue: c(chalk.blue),
  white: c(chalk.white),

  summary: (tokens: number, tools: number, ms: number) =>
    fmt.dim(`  ── ${tools} tools · ${tokens} tokens · ${(ms / 1000).toFixed(1)}s ──`),

  toolCompactRunning: (name: string, args: string) =>
    `  ${fmt.white('◌')} ${name}(${fmt.dim(args)})`,

  toolCompactDone: (name: string, args: string, ms: number) =>
    `  ${fmt.green('●')} ${name}(${fmt.dim(args)})  ${fmt.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  toolCompactError: (name: string, args: string, ms: number) =>
    `  ${fmt.red('●')} ${name}(${fmt.dim(args)})  ${fmt.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  collapsedHint: (count: number, unit: string) =>
    fmt.dim(`  … +${count} ${unit} (ctrl+o to expand)`),

  inputLine: (width: number) =>
    fmt.white('─'.repeat(Math.max(0, width))),

  toolDone: (name: string, ms: number) =>
    `  ${fmt.green('✓')} ${name} ${fmt.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  toolError: (name: string, ms: number) =>
    `  ${fmt.red('✗')} ${name} ${fmt.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  thinking: (ms: number) =>
    fmt.dim(`  Thinking... (${(ms / 1000).toFixed(1)}s)`),
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
