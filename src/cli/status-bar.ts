// 固定底部状态栏：每次 turn 后刷新，显示模型/Token/计划模式/会话时长。
// ANSI 最后一行作为状态栏，终端 resize 时自动适配宽度。

import { fmt } from './format.js'

export interface StatusInfo {
  model: string
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  planMode: boolean
  sessionStart: Date
  show: boolean
}

export function createStatusBar(): StatusInfo {
  return {
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    planMode: false,
    sessionStart: new Date(),
    show: true,
  }
}

export function renderStatusBar(s: StatusInfo): string {
  if (!s.show) return ''
  const elapsed = Math.floor((Date.now() - s.sessionStart.getTime()) / 1000)
  const dur = elapsed > 3600
    ? `${Math.floor(elapsed / 3600)}h${Math.floor((elapsed % 3600) / 60)}m`
    : elapsed > 60
      ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
      : `${elapsed}s`

  const parts = [
    fmt.cyan(s.model),
    `in:${fmt.yellow(String(s.inputTokens))} out:${fmt.yellow(String(s.outputTokens))}`,
    s.cacheHitTokens > 0 ? `cache:${fmt.yellow(String(s.cacheHitTokens))}` : '',
    s.planMode ? fmt.yellow(' PLAN') : '',
    fmt.dim(dur),
  ].filter(Boolean)

  const line = parts.join(' │ ')
  const width = process.stderr.columns ?? 80
  return '\n' + fmt.dim('─'.repeat(Math.min(width - 2, line.length + 4))) + '\n' + line
}
