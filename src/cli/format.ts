import chalk from 'chalk'

export const fmt = {
  dim: (s: string) => chalk.dim(s),
  bold: (s: string) => chalk.bold(s),
  green: (s: string) => chalk.green(s),
  red: (s: string) => chalk.red(s),
  yellow: (s: string) => chalk.yellow(s),
  cyan: (s: string) => chalk.cyan(s),
  blue: (s: string) => chalk.blue(s),
  white: (s: string) => chalk.white(s),

  summary: (tokens: number, tools: number, ms: number) =>
    chalk.dim(
      `  ── ${tools} tools · ${tokens} tokens · ${(ms / 1000).toFixed(1)}s ──`,
    ),

  // 紧凑工具调用行：状态圈 + 工具名 + 参数
  toolCompactRunning: (name: string, args: string) =>
    `  ${chalk.white('◌')} ${name}(${chalk.dim(args)})`,

  toolCompactDone: (name: string, args: string, ms: number) =>
    `  ${chalk.green('●')} ${name}(${chalk.dim(args)})  ${chalk.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  toolCompactError: (name: string, args: string, ms: number) =>
    `  ${chalk.red('●')} ${name}(${chalk.dim(args)})  ${chalk.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  // 折叠提示行
  collapsedHint: (count: number, unit: string) =>
    chalk.dim(`  … +${count} ${unit} (ctrl+o to expand)`),

  // 思考折叠显示
  thinkingCollapsed: (ms: number) =>
    chalk.dim(`  Thinking... (${(ms / 1000).toFixed(1)}s)`) + chalk.dim(' · ctrl+o to expand'),

  // 思考展开标题
  thinkingExpanded: (ms: number) =>
    chalk.dim(`  ✻ Thinking (${(ms / 1000).toFixed(1)}s):`),

  // 输入框线条：'─' 填充到宽度
  inputLine: (width: number) =>
    chalk.white('─'.repeat(Math.max(0, width))),

  // 向后兼容别名（Phase 4 将替换为紧凑格式）
  toolDone: (name: string, ms: number) =>
    `  ${chalk.green('✓')} ${name} ${chalk.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  toolError: (name: string, ms: number) =>
    `  ${chalk.red('✗')} ${name} ${chalk.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  thinking: (ms: number) =>
    chalk.dim(`  Thinking... (${(ms / 1000).toFixed(1)}s)`),
}

// 计算字符串在终端上的视觉宽度：CJK/全角/Emoji 占 2 列，其余占 1 列。
// 从 repl-input.ts 移入，供 blocks.ts 和 format.ts 共享。
export function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    // CJK、全角、Emoji 范围
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK Radicals ~ Yi
      (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility
      (cp >= 0xfe10 && cp <= 0xfe19) ||   // Vertical Forms
      (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth Signs
      (cp >= 0x1f000 && cp <= 0x1f644) || // Emoticons
      (cp >= 0x1f900 && cp <= 0x1f9ff) || // Supplemental Symbols
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B+
      (cp >= 0x30000 && cp <= 0x3fffd)     // CJK Extension G+
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}
