// 交互式单选菜单：↑/↓（或 j/k）移动，Enter 确认，数字键直选，Esc/Ctrl+C 取消。
// 按键→导航逻辑抽成纯函数 handleKey 便于单测；TTY 原始模式接管放在 selectMenu。

export interface MenuOption {
  label: string
  value: string
}

export type MenuAction = 'move' | 'confirm' | 'cancel' | 'none'
export interface KeyResult {
  selected: number
  action: MenuAction
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'
const ENTER2 = '\n'
const ESC = '\x1b'
const CTRL_C = '\x03'

// 给定当前选中项、收到的按键、选项总数，返回新的选中项与动作。纯函数。
export function handleKey(selected: number, key: string, count: number): KeyResult {
  if (count <= 0) return { selected: 0, action: 'none' }
  switch (key) {
    case UP:
    case 'k':
      return { selected: (selected - 1 + count) % count, action: 'move' }
    case DOWN:
    case 'j':
      return { selected: (selected + 1) % count, action: 'move' }
    case ENTER:
    case ENTER2:
      return { selected, action: 'confirm' }
    case ESC:
    case CTRL_C:
      return { selected, action: 'cancel' }
    default:
      if (key.length === 1 && key >= '1' && key <= String(Math.min(9, count))) {
        return { selected: Number(key) - 1, action: 'confirm' }
      }
      return { selected, action: 'none' }
  }
}

// 渲染并交互选择，resolve 选中下标；取消（Esc/Ctrl+C）resolve -1。
// 非 TTY 环境直接返回 -1（调用方据此安全降级，绝不误判为确认）。
// 自包含地接管 stdin：临时摘掉现有监听（含 readline 的），结束后原样恢复。
export function selectMenu(title: string[], options: MenuOption[]): Promise<number> {
  const stdin = process.stdin
  const out = process.stderr
  if (!stdin.isTTY || options.length === 0) return Promise.resolve(-1)

  return new Promise<number>((resolve) => {
    let selected = 0
    const lines = title.length + options.length

    const draw = (first: boolean) => {
      if (!first) out.write(`\x1b[${lines}A`) // 光标上移，覆盖重绘
      for (const t of title) out.write(`\x1b[2K${t}\n`)
      options.forEach((o, i) => {
        const ptr = i === selected ? '❯ ' : '  '
        const line = i === selected ? `\x1b[36m${ptr}${o.label}\x1b[0m` : `${ptr}${o.label}`
        out.write(`\x1b[2K${line}\n`)
      })
    }

    // 接管 stdin：保存并摘掉现有监听，结束后恢复（与 REPL 的 readline 共存）
    const prevData = stdin.listeners('data') as ((c: Buffer) => void)[]
    const prevKeypress = stdin.listeners('keypress') as ((...a: unknown[]) => void)[]
    const wasRaw = stdin.isRaw ?? false
    const wasPaused = stdin.isPaused()
    stdin.removeAllListeners('data')
    stdin.removeAllListeners('keypress')

    const finish = (result: number) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode?.(wasRaw)
      for (const l of prevData) stdin.on('data', l)
      for (const l of prevKeypress) stdin.on('keypress', l)
      if (wasPaused) stdin.pause()
      else stdin.resume()
      resolve(result)
    }

    const onData = (chunk: Buffer) => {
      const r = handleKey(selected, chunk.toString(), options.length)
      selected = r.selected
      if (r.action === 'move') {
        draw(false)
      } else if (r.action === 'confirm') {
        draw(false)
        finish(selected)
      } else if (r.action === 'cancel') {
        finish(-1)
      }
    }

    stdin.setRawMode?.(true)
    stdin.resume()
    draw(true)
    stdin.on('data', onData)
  })
}
