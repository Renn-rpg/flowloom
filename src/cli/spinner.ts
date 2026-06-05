import { color } from './theme.js'

// 自驱动 thinking spinner——不依赖 ora 的内部渲染。
//
// 为什么不用 ora：ora 在目标流非交互 TTY 时把 isEnabled 置 false（is-interactive
// 检查 stream.isTTY），此后 .start() 只打一帧静态、render() 全程提前返回，外部对
// .text 的更新根本不触发重绘。在 Windows PowerShell / ConPTY 下（即便 isTTY=true，
// braille 帧经 ora 的局部光标移动也常不重绘）表现为"完全不闪烁"。这里我们自己用
// interval 写 `\r` 整行覆盖帧：TTY 才动画，非 TTY 保持静默（由调用方的耗时汇总行
// 兜底），避免管道/重定向里出现 ANSI 乱码。

let active: Spinner | null = null

// 终端是否能正常显示 braille 动画帧。Windows 老 conhost 不行，退化到 ASCII。
function unicodeOk(): boolean {
  if (process.platform !== 'win32') return process.env.TERM !== 'linux'
  return Boolean(
    process.env.WT_SESSION ||                  // Windows Terminal
    process.env.TERM_PROGRAM === 'vscode' ||   // VS Code 集成终端
    process.env.ConEmuTask ||                  // ConEmu / Cmder
    /^xterm/.test(process.env.TERM ?? ''),     // xterm-256color 等
  )
}

const FRAMES = unicodeOk()
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['-', '\\', '|', '/']

export class Spinner {
  text: string
  private idx = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly stream = process.stderr
  private readonly enabled: boolean

  constructor(text: string) {
    this.text = text
    // 仅在 stderr 是交互 TTY 时驱动动画；管道/重定向下保持静默，避免 `\r` 乱码。
    this.enabled = Boolean(this.stream.isTTY)
  }

  start(): this {
    if (!this.enabled) return this
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.render()
    // ~90ms/帧，自己驱动（不靠 ora 内部 interval）。unref 避免悬挂阻止进程退出——
    // turn 期间网络 Promise 已 keep-alive 事件循环，动画照常推进。
    this.timer = setInterval(() => {
      this.idx = (this.idx + 1) % FRAMES.length
      this.render()
    }, 90)
    this.timer.unref?.()
    return this
  }

  private render(): void {
    if (!this.enabled) return
    // `\r` 回到行首 + `\x1b[2K` 清整行 + 当前帧 + 文本：逐帧覆盖同一行 → 闪烁动画。
    this.stream.write(`\r\x1b[2K${color('spinner')(FRAMES[this.idx])} ${this.text}`)
  }

  stop(): this {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // 清掉 spinner 行；光标显隐由调用方统一管理（不在此恢复光标）。
    if (this.enabled) this.stream.write('\r\x1b[2K')
    if (active === this) active = null
    return this
  }
}

export function createSpinner(text: string): Spinner {
  if (active) active.stop()
  active = new Spinner(text).start()
  return active
}

export function stopActiveSpinner(): void {
  active?.stop()
  active = null
}
