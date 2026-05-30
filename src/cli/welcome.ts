import chalk from 'chalk'

export function showWelcome(opts: {
  version: string
  model: string
  nodeVersion: string
  cwd: string
  isInteractive: boolean
}): void {
  const W = 58
  const blue = chalk.hex('#4A90D9')
  const title = ` FlowLoom v${opts.version} `
  const titleLen = title.length
  const leftDash = Math.floor((W - 2 - titleLen) / 2)
  const rightDash = W - 2 - titleLen - leftDash
  const user = process.env.USER || process.env.USERNAME || 'dev'

  process.stderr.write('\n')

  // 上框线，中间嵌入标题
  process.stderr.write(
    blue('╭') +
      blue('─'.repeat(leftDash)) +
      chalk.blue.bold(title) +
      blue('─'.repeat(rightDash)) +
      blue('╮') +
      '\n',
  )

  // 空行 → 鲸鱼行 → 空行
  const whaleLines = [
    '         ﹋ ﹋ ﹋ ﹋ ﹋ ﹋ ﹋ ﹋         ',
    '       ﹋                       ﹋       ',
    '      ﹋          🐋            ﹋      ',
    '       ﹋                       ﹋       ',
    '         ﹋ ﹋ ﹋ ﹋ ﹋ ﹋ ﹋ ﹋         ',
  ]

  process.stderr.write(blue('│') + ' '.repeat(W - 2) + blue('│') + '\n')

  for (const line of whaleLines) {
    const indent = Math.floor((W - 2 - line.length) / 2)
    process.stderr.write(
      blue('│') +
        ' '.repeat(indent) +
        chalk.cyanBright(line) +
        ' '.repeat(Math.max(0, W - 2 - indent - line.length)) +
        blue('│') +
        '\n',
    )
  }

  process.stderr.write(blue('│') + ' '.repeat(W - 2) + blue('│') + '\n')

  // 信息行
  const info = [
    chalk.dim('  Model:   ') + chalk.green(opts.model),
    chalk.dim('  Node:    ') + chalk.green(`v${opts.nodeVersion}`),
    chalk.dim('  User:    ') + chalk.green(user),
    chalk.dim('  CWD:     ') + chalk.green(opts.cwd),
  ]

  for (const line of info) {
    const stripped = line.replace(/\x1B\[[0-9;]*m/g, '')
    process.stderr.write(
      blue('│') +
        line +
        ' '.repeat(Math.max(0, W - 2 - stripped.length)) +
        blue('│') +
        '\n',
    )
  }

  process.stderr.write(blue('│') + ' '.repeat(W - 2) + blue('│') + '\n')

  if (opts.isInteractive) {
    const tips =
      chalk.dim('  ') +
      chalk.cyan('/exit') +
      chalk.dim(' quit  ·  ') +
      chalk.cyan('Ctrl+C') +
      chalk.dim(' cancel  ·  ') +
      chalk.cyan('#') +
      chalk.dim(' session')
    const tipsStripped = tips.replace(/\x1B\[[0-9;]*m/g, '')
    process.stderr.write(
      blue('│') +
        tips +
        ' '.repeat(Math.max(0, W - 2 - tipsStripped.length)) +
        blue('│') +
        '\n',
    )
    process.stderr.write(blue('│') + ' '.repeat(W - 2) + blue('│') + '\n')
  }

  // 下框线
  process.stderr.write(blue('╰') + blue('─'.repeat(W - 2)) + blue('╯') + '\n')
  process.stderr.write('\n')
}
