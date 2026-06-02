import ora, { type Ora } from 'ora'

// 记录当前活跃 spinner / 闪烁定时器，供交互式确认在提问前暂停动画。
let active: Ora | null = null
let blinkTimer: ReturnType<typeof setInterval> | null = null

export function createSpinner(text: string): Ora {
  active = ora({ text, stream: process.stderr, spinner: 'dots' }).start()
  return active
}

export function stopActiveSpinner(): void {
  active?.stop()
  active = null
}

export function stopBlinking(): void {
  if (blinkTimer) {
    clearInterval(blinkTimer)
    blinkTimer = null
  }
}

// 工具图标映射
export function toolIcon(name: string): string {
  switch (name) {
    case 'read_file': return '📖'
    case 'write_file': return '✏️'
    case 'edit_file': return '🔧'
    case 'multi_edit': return '🛠️'
    case 'run_shell': return '⚡'
    case 'glob': return '🔍'
    case 'grep': return '🔎'
    case 'web_fetch': return '🌐'
    default: return '🔨'
  }
}
