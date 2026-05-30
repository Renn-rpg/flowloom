import chalk from 'chalk'

export const fmt = {
  dim: (s: string) => chalk.dim(s),
  bold: (s: string) => chalk.bold(s),
  green: (s: string) => chalk.green(s),
  red: (s: string) => chalk.red(s),
  yellow: (s: string) => chalk.yellow(s),
  cyan: (s: string) => chalk.cyan(s),
  blue: (s: string) => chalk.blue(s),

  summary: (tokens: number, tools: number, ms: number) =>
    chalk.dim(
      `  ── ${tools} tools · ${tokens} tokens · ${(ms / 1000).toFixed(1)}s ──`,
    ),

  toolDone: (name: string, ms: number) =>
    `  ${chalk.green('✓')} ${name} ${chalk.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  toolError: (name: string, ms: number) =>
    `  ${chalk.red('✗')} ${name} ${chalk.dim(`(${(ms / 1000).toFixed(1)}s)`)}`,

  thinking: (ms: number) =>
    chalk.dim(`  Thinking... (${(ms / 1000).toFixed(1)}s)`),

  done: () => chalk.green('✓ Done.'),
}
