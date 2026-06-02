import ora, { type Ora } from 'ora'

// 记录当前活跃 spinner / 闪烁定时器，供交互式确认在提问前暂停动画。
let active: Ora | null = null
let blinkTimer: ReturnType<typeof setInterval> | null = null
let blinkTarget: { update: (ch: string) => void } | null = null

export function createSpinner(text: string): Ora {
  active = ora({ text, stream: process.stderr, spinner: 'dots' }).start()
  return active
}

export function stopActiveSpinner(): void {
  active?.stop()
  active = null
}

// 开始白色闪烁圈动画：在 '◌' 和 '●' 之间交替。
// update 回调在每次切换时被调用，负责通过 ANSI 重绘该行。
export function startBlinking(update: (ch: string) => void): void {
  stopBlinking()
  blinkTarget = { update }
  let tick = false
  update('◌')
  blinkTimer = setInterval(() => {
    tick = !tick
    update(tick ? '●' : '◌')
  }, 400)
  blinkTimer.unref?.()
}

// 停止闪烁并写入最终状态圈（绿色 ● 或红色 ●）。
export function finishBlinking(finalCh: string): void {
  stopBlinking()
  if (blinkTarget) {
    blinkTarget.update(finalCh)
    blinkTarget = null
  }
}

export function stopBlinking(): void {
  if (blinkTimer) {
    clearInterval(blinkTimer)
    blinkTimer = null
  }
}

// 向后兼容：cli.ts 仍在引用，Phase 4 后移除
export function toolStart(name: string, detail?: string): ReturnType<typeof createSpinner> {
  const icon = toolIcon(name)
  const msg = detail ? `${icon} ${name} ${detail}` : `${icon} ${name}`
  return createSpinner(msg)
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
