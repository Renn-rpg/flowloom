import chalk from 'chalk'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function terminalWidth(): number {
  return Math.min(80, Math.max(40, process.stderr.columns ?? 80))
}

const blue = chalk.hex('#4A90D9')

function detectProject(cwd: string): string[] {
  const items: string[] = []
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const raw = readFileSync(join(cwd, 'package.json'), 'utf8')
      if (raw.length < 100_000) {
        const pkg = JSON.parse(raw)
        items.push(pkg.name ? `Node.js · ${pkg.name}` : 'Node.js')
      } else { items.push('Node.js') }
    } catch { items.push('Node.js') }
  }
  if (existsSync(join(cwd, 'tsconfig.json'))) items.push('TypeScript')
  if (existsSync(join(cwd, '.git'))) {
    try {
      const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
      const branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : 'detached'
      items.push(`Git · ${branch}`)
    } catch { items.push('Git') }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) items.push('Rust')
  if (existsSync(join(cwd, 'go.mod'))) items.push('Go')
  if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) items.push('Python')
  return items
}

export function showWelcome(opts: {
  version: string
  model: string
  nodeVersion: string
  cwd: string
  isInteractive: boolean
  safety?: string
}): void {
  const W = terminalWidth()
  const bluePipe = blue('│')
  const blankLine = bluePipe + ' '.repeat(W - 2) + bluePipe
  const STRIP_ANSI = /\x1B\[[0-9;]*m/g
  function border(text: string): string {
    const visual = text.replace(STRIP_ANSI, '')
    const pad = W - 2 - visual.length
    return bluePipe + text + ' '.repeat(Math.max(0, pad)) + bluePipe
  }

  const title = ` FlowLoom v${opts.version} `
  const titleLen = title.length
  const leftDash = Math.floor((W - 2 - titleLen) / 2)
  const rightDash = W - 2 - titleLen - leftDash
  const user = process.env.USER || process.env.USERNAME || 'dev'
  const projectTypes = detectProject(opts.cwd)

  const out: string[] = []
  out.push('')
  out.push(
    blue('╭') + blue('─'.repeat(leftDash)) + chalk.blue.bold(title) + blue('─'.repeat(rightDash)) + blue('╮'),
  )
  out.push(blankLine)

  const rows: [string, string][] = [
    ['Model:   ', opts.model],
    ['Node:    ', `v${opts.nodeVersion}`],
    ['User:    ', user],
    ['CWD:     ', opts.cwd],
  ]
  if (projectTypes.length > 0) rows.push(['Project: ', projectTypes.join(', ')])
  if (opts.safety) rows.push(['Safety:  ', opts.safety])
  for (const [label, value] of rows) {
    out.push(border(chalk.dim(`  ${label}`) + chalk.green(value)))
  }
  out.push(blankLine)

  if (opts.isInteractive) {
    out.push(
      border(
        chalk.dim('  ') + chalk.cyan('/') + chalk.dim(' menu  ·  ') +
        chalk.cyan('Tab/↑↓') + chalk.dim(' pick  ·  ') + chalk.cyan('Ctrl+O/E') + chalk.dim(' expand'),
      ),
    )
    out.push(
      border(
        chalk.dim('  ') + chalk.cyan('/exit') + chalk.dim(' quit  ·  ') +
        chalk.cyan('Ctrl+C') + chalk.dim(' cancel  ·  ') + chalk.cyan('--yolo') + chalk.dim(' off'),
      ),
    )
    out.push(blankLine)
  }

  out.push(blue('╰') + blue('─'.repeat(W - 2)) + blue('╯'))
  out.push('')
  process.stderr.write(out.join('\n'))
}
