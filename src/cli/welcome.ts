import chalk from 'chalk'

const WHALE = [
  '                    ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '                ▄▄██████████████████████▄▄',
  '             ▄██████████████████████████████▄',
  '           ▄██████████████████████████████████▄',
  '         ▄██████████▀▀          ▀▀███████████▄',
  '       ▄███████▀                    ▀████████▄',
  '      ███████▀       ▐█     █▌        ▀███████',
  '     ██████▀         ▐█     █▌          ▀██████',
  '    █████▀            ▀▀▀▀▀▀▀▀             █████',
  '   █████              ▄▄▄▄▄▄▄▄             ▐████',
  '  ▐████              █▌       █▌             ████▌',
  '  ████              ▐█  ▄▄▄▄▄  █▌             ████',
  '  ████              █▌         ▐█             ████',
  '  ▐████              ▀█████████▀              ████▌',
  '   █████▄                                   ▄█████',
  '    ▀█████▄                               ▄█████▀',
  '     ▀██████▄                           ▄██████▀',
  '      ▀███████▄                       ▄███████▀',
  '        ▀████████▄                 ▄▄████████▀',
  '          ▀█████████▄▄         ▄▄██████████▀',
  '            ▀▀███████████████████████████▀▀',
  '                ▀▀████████████████████▀▀',
  '                     ▀▀▀▀▀▀▀▀▀▀▀▀▀',
]

function boxTop(width: number): string {
  return chalk.blueBright('╭') + chalk.blueBright('─'.repeat(width - 2)) + chalk.blueBright('╮')
}

function boxBottom(width: number): string {
  return chalk.blueBright('╰') + chalk.blueBright('─'.repeat(width - 2)) + chalk.blueBright('╯')
}

function boxLine(text: string, width: number): string {
  const stripped = text.replace(/\x1B\[[0-9;]*m/g, '')
  const pad = Math.max(0, width - 2 - stripped.length)
  return chalk.blueBright('│') + text + ' '.repeat(pad) + chalk.blueBright('│')
}

export function showWelcome(opts: {
  version: string
  model: string
  nodeVersion: string
  cwd: string
  isInteractive: boolean
}): void {
  const W = 60
  const now = new Date().toLocaleString()
  const user = process.env.USER || process.env.USERNAME || 'dev'

  process.stderr.write('\n')

  // 鲸鱼吉祥物
  for (const line of WHALE) {
    process.stderr.write(chalk.cyan(line) + '\n')
  }

  process.stderr.write('\n' + boxTop(W) + '\n')

  const lines: string[] = [
    chalk.bold.cyan('  🐋  FlowLoom') + chalk.dim(`  v${opts.version}`),
    '',
    chalk.dim('  Model:   ') + chalk.green(opts.model),
    chalk.dim('  Node:    ') + chalk.green(`v${opts.nodeVersion}`),
    chalk.dim('  User:    ') + chalk.green(user),
    chalk.dim('  CWD:     ') + chalk.green(opts.cwd),
  ]

  if (opts.isInteractive) {
    lines.push('')
    lines.push(
      chalk.dim('  ') +
        chalk.cyan('/exit') +
        chalk.dim(' quit  ·  ') +
        chalk.cyan('#') +
        chalk.dim(' session  ·  ') +
        chalk.cyan('Ctrl+C') +
        chalk.dim(' cancel'),
    )
    lines.push(
      chalk.dim('  🐋 DeepSeek whale says: "Let\'s build something great!"'),
    )
  }

  for (const line of lines) {
    if (line === '') {
      process.stderr.write(chalk.blueBright('│') + ' '.repeat(W - 2) + chalk.blueBright('│') + '\n')
    } else {
      process.stderr.write(boxLine(line, W) + '\n')
    }
  }

  process.stderr.write(chalk.blueBright('│') + ' '.repeat(W - 2) + chalk.blueBright('│') + '\n')
  process.stderr.write(
    boxLine(
      chalk.cyan.bold('  🐋 ') + chalk.dim(new Date().toLocaleString()),
      W,
    ) + '\n',
  )
  process.stderr.write(boxBottom(W) + '\n')
  process.stderr.write('\n')
}
