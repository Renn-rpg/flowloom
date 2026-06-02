import ora, { type Ora } from 'ora'

// 记录当前活跃 spinner，供交互式确认（如 run_shell 询问）在提问前暂停动画，
// 避免 ora 在 stderr 上的 \r 刷新覆盖 readline 的提示行。
let active: Ora | null = null

export function createSpinner(text: string): Ora {
  active = ora({ text, stream: process.stderr, spinner: 'dots' }).start()
  return active
}

export function stopActiveSpinner(): void {
  active?.stop()
  active = null
}

export function toolIcon(name: string): string {
  switch (name) {
    case 'read_file':
      return '📖'
    case 'write_file':
      return '✏️'
    case 'edit_file':
      return '🔧'
    case 'multi_edit':
      return '🛠️'
    case 'run_shell':
      return '⚡'
    case 'glob':
      return '🔍'
    case 'grep':
      return '🔎'
    case 'web_fetch':
      return '🌐'
    default:
      return '🔨'
  }
}

export function toolStart(name: string, detail?: string): Ora {
  const icon = toolIcon(name)
  const msg = detail ? `${icon} ${name} ${detail}` : `${icon} ${name}`
  return createSpinner(msg)
}
