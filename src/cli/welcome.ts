import chalk from 'chalk'

const W = 58
const blue = chalk.hex('#4A90D9')
const bluePipe = blue('│')
const STRIP_ANSI = /\x1B\[[0-9;]*m/g
const blankLine = bluePipe + ' '.repeat(W - 2) + bluePipe

function border(text: string): string {
  const visual = text.replace(STRIP_ANSI, '')
  const pad = W - 2 - visual.length
  return bluePipe + text + ' '.repeat(Math.max(0, pad)) + bluePipe
}

export function showWelcome(opts: {
  version: string
  model: string
  nodeVersion: string
  cwd: string
  isInteractive: boolean
  safety?: string
}): void {
  const title = ` FlowLoom v${opts.version} `
  const titleLen = title.length
  const leftDash = Math.floor((W - 2 - titleLen) / 2)
  const rightDash = W - 2 - titleLen - leftDash
  const user = process.env.USER || process.env.USERNAME || 'dev'

  const out: string[] = []

  out.push('')
  out.push(
    blue('╭') +
      blue('─'.repeat(leftDash)) +
      chalk.blue.bold(title) +
      blue('─'.repeat(rightDash)) +
      blue('╮'),
  )

  out.push(blankLine)

  const rows: [string, string][] = [
    ['Model:   ', opts.model],
    ['Node:    ', `v${opts.nodeVersion}`],
    ['User:    ', user],
    ['CWD:     ', opts.cwd],
  ]
  if (opts.safety) rows.push(['Safety:  ', opts.safety])
  for (const [label, value] of rows) {
    out.push(border(chalk.dim(`  ${label}`) + chalk.green(value)))
  }

  out.push(blankLine)

  if (opts.isInteractive) {
    out.push(
      border(
        chalk.dim('  ') +
          chalk.cyan('/') +
          chalk.dim(' menu  ·  ') +
          chalk.cyan('Tab/↑↓') +
          chalk.dim(' pick  ·  ') +
          chalk.cyan('Ctrl+O') +
          chalk.dim(' expand thinking'),
      ),
    )
    out.push(
      border(
        chalk.dim('  ') +
          chalk.cyan('/exit') +
          chalk.dim(' quit  ·  ') +
          chalk.cyan('Ctrl+C') +
          chalk.dim(' cancel  ·  ') +
          chalk.cyan('--yolo') +
          chalk.dim(' guards'),
      ),
    )
    out.push(blankLine)
  }

  out.push(blue('╰') + blue('─'.repeat(W - 2)) + blue('╯'))
  out.push('')

  process.stderr.write(out.join('\n'))
}
