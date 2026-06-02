// 交互式提示符的行编辑器：替换 readline，以支持「打 / 即弹下拉、随输入实时过滤、↑↓ 选、
// Tab/Enter 补全、ctrl+o 切换详情」等类 Claude Code 的体验。
//
// 分层（与 prompt.ts 同思路）：
//   · decodeKey —— 把 stdin chunk 解析成语义按键（纯函数，可单测）
//   · reduceKey —— 给定状态 + 按键 + 当前补全项，算出新状态与动作（纯函数，可单测）
//   · ReplReader —— raw-mode IO 外壳：接管 stdin、渲染提示行 + 下拉、回调 ctrl+o
// 非 TTY（管道/CI）自动降级为普通 readline 逐行读取，行为与改造前一致。

import { createInterface, type Interface } from 'node:readline/promises'
import { StringDecoder } from 'node:string_decoder'
import { computeCompletions, type CompletionItem } from './completions.js'
import { fmt } from './format.js'

// ——— 按键解析 ———

export type Key =
  | { t: 'char'; ch: string }
  | { t: 'enter' }
  | { t: 'backspace' }
  | { t: 'delete' }
  | { t: 'tab' }
  | { t: 'esc' }
  | { t: 'up' }
  | { t: 'down' }
  | { t: 'left' }
  | { t: 'right' }
  | { t: 'home' }
  | { t: 'end' }
  | { t: 'ctrl-c' }
  | { t: 'ctrl-d' }
  | { t: 'ctrl-o' }
  | { t: 'ctrl-e' }
  | { t: 'unknown' }

// 把单个按键（或一段转义序列、或一段可见字符的粘贴）解析为语义按键。
export function decodeKey(s: string): Key {
  switch (s) {
    case '\r':
    case '\n':
      return { t: 'enter' }
    case '\x7f':
    case '\b':
      return { t: 'backspace' }
    case '\t':
      return { t: 'tab' }
    case '\x03':
      return { t: 'ctrl-c' }
    case '\x04':
      return { t: 'ctrl-d' }
    case '\x0f':
      return { t: 'ctrl-o' }
    case '\x01': // Ctrl-A → 行首
      return { t: 'home' }
    case '\x05': // Ctrl-E → 展开全部细节
      return { t: 'ctrl-e' }
    case '\x1b':
      return { t: 'esc' }
    case '\x1b[A':
    case '\x1bOA':
      return { t: 'up' }
    case '\x1b[B':
    case '\x1bOB':
      return { t: 'down' }
    case '\x1b[C':
    case '\x1bOC':
      return { t: 'right' }
    case '\x1b[D':
    case '\x1bOD':
      return { t: 'left' }
    case '\x1b[H':
    case '\x1bOH':
    case '\x1b[1~':
      return { t: 'home' }
    case '\x1b[F':
    case '\x1bOF':
    case '\x1b[4~':
      return { t: 'end' }
    case '\x1b[3~':
      return { t: 'delete' }
  }
  // 可见字符（含多字符粘贴）：无控制字符、非转义序列、非 U+FFFD 替换字符
  if (
    s.length >= 1 &&
    !s.startsWith('\x1b') &&
    [...s].every((c) => c >= ' ' && c !== '\x7f' && c !== '�')
  ) {
    return { t: 'char', ch: s }
  }
  return { t: 'unknown' }
}

// ——— 终端视觉宽度 ———
// CJK / 全角字符在等宽终端中占 2 列，JavaScript .length 只计 1。
// 光标定位和折行计算必须用视觉宽度，否则中文输入时光标「居中」。
function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    // 控制字符（不渲染的）不计宽度
    if (cp < 0x20 || cp === 0x7F) continue
    // 宽字符范围：Hangul / CJK / 全角 / Emoji
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0xA4CF) ||   // CJK Radicals .. Yi
      (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compat
      (cp >= 0xFE10 && cp <= 0xFE6F) ||   // Vertical / Small Form
      (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth ASCII
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth signs
      (cp >= 0x1F300 && cp <= 0x1F9FF) || // Emoji & symbols
      (cp >= 0x20000 && cp <= 0x3FFFF)     // CJK Ext-B+
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

// ——— 状态机 ———

export interface EditorState {
  buffer: string
  cursor: number // 0..buffer.length
  menuIndex: number // 下拉高亮项
  dismissed: boolean // 用户按 Esc 暂时收起下拉（再编辑即恢复）
}

export type EditorAction = 'redraw' | 'submit' | 'cancel' | 'expand-one' | 'expand-all' | 'none'

export interface ReduceResult {
  state: EditorState
  action: EditorAction
}

export function initialEditorState(): EditorState {
  return { buffer: '', cursor: 0, menuIndex: 0, dismissed: false }
}

// 编辑了 buffer 后的通用收尾：清掉 dismissed、把高亮复位到顶部。
function edited(buffer: string, cursor: number): EditorState {
  return { buffer, cursor, menuIndex: 0, dismissed: false }
}

// 纯状态转移：items 为「当前 buffer 对应的补全项」（由调用方先算好）。
export function reduceKey(state: EditorState, key: Key, items: CompletionItem[]): ReduceResult {
  const menuOpen = items.length > 0 && !state.dismissed
  const len = state.buffer.length
  const redraw = (s: EditorState): ReduceResult => ({ state: s, action: 'redraw' })
  const none = (): ReduceResult => ({ state, action: 'none' })

  switch (key.t) {
    case 'char': {
      const b = state.buffer.slice(0, state.cursor) + key.ch + state.buffer.slice(state.cursor)
      return redraw(edited(b, state.cursor + key.ch.length))
    }
    case 'backspace': {
      if (state.cursor === 0) return none()
      const b = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor)
      return redraw(edited(b, state.cursor - 1))
    }
    case 'delete': {
      if (state.cursor >= len) return none()
      const b = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1)
      return redraw(edited(b, state.cursor))
    }
    case 'left':
      return state.cursor > 0 ? redraw({ ...state, cursor: state.cursor - 1 }) : none()
    case 'right':
      return state.cursor < len ? redraw({ ...state, cursor: state.cursor + 1 }) : none()
    case 'home':
      return state.cursor > 0 ? redraw({ ...state, cursor: 0 }) : none()
    case 'end':
      return state.cursor < len ? redraw({ ...state, cursor: len }) : none()
    case 'up':
      if (!menuOpen) return none()
      return redraw({ ...state, menuIndex: (state.menuIndex - 1 + items.length) % items.length })
    case 'down':
      if (!menuOpen) return none()
      return redraw({ ...state, menuIndex: (state.menuIndex + 1) % items.length })
    case 'tab': {
      if (!menuOpen) return none()
      const accepted = items[Math.min(state.menuIndex, items.length - 1)].replacement
      if (accepted === state.buffer) return none()
      return redraw(edited(accepted, accepted.length))
    }
    case 'enter': {
      if (menuOpen) {
        const accepted = items[Math.min(state.menuIndex, items.length - 1)].replacement
        // 已经等于补全结果 → 没什么可补，直接执行；否则先补全（不提交）
        if (accepted !== state.buffer) return redraw(edited(accepted, accepted.length))
      }
      return { state, action: 'submit' }
    }
    case 'esc':
      return menuOpen ? redraw({ ...state, dismissed: true }) : none()
    case 'ctrl-c':
      // 空行 → 退出；否则清空当前输入（类 bash/Claude Code），再按一次空行退出
      if (state.buffer === '') return { state, action: 'cancel' }
      return redraw(initialEditorState())
    case 'ctrl-d':
      // 空行 EOF → 退出；非空忽略
      return state.buffer === '' ? { state, action: 'cancel' } : none()
    case 'ctrl-o':
      return { state, action: 'expand-one' }
    case 'ctrl-e':
      return { state, action: 'expand-all' }
    default:
      return none()
  }
}

// ——— IO 外壳 ———

export interface ReplReaderOptions {
  input?: NodeJS.ReadStream
  out?: NodeJS.WriteStream
  // 可见提示符（无颜色），默认 '❯ '。可传函数，每次读取行时求值。
  promptText?: string | (() => string)
  colorPrompt?: (s: string) => string // 提示符着色（默认绿色 ❯）
  onExpand?: (mode: 'one' | 'all') => void // ctrl+o/ctrl+e 回调
  maxMenu?: number // 下拉最多展示项数，默认 8
}

export class ReplReader {
  private input: NodeJS.ReadStream
  private out: NodeJS.WriteStream
  private promptText: string | (() => string)
  private colorPrompt: (s: string) => string
  private onExpand?: (mode: 'one' | 'all') => void
  private maxMenu: number
  private rl: Interface | null = null

  // 持久的 UTF-8 流式解码器：跨 data 事件拼接被截断的多字节字符（中文/Emoji 常见），
  // 避免 per-event chunk.toString('utf8') 把不完整的字节序列解为 U+FFFD 替换字符。
  private decoder: StringDecoder

  // 转义序列缓冲：终端高负载/PTY/SSH 下可能把 ESC 单独 flush 成一个 data 事件，
  // 下一个事件才带后续字节（如 '[A'）。缓冲 lone ESC 并用微任务等待续着，
  // 否则会先把 ESC 当「收起下拉」、再把 '[A' 当字面字符插进输入。
  private pendingEscTimer: ReturnType<typeof setTimeout> | null = null
  private pendingEscBuf: Buffer[] = []

  constructor(opts: ReplReaderOptions = {}) {
    this.input = opts.input ?? process.stdin
    this.out = opts.out ?? process.stderr
    this.promptText = opts.promptText ?? '❯ '
    this.colorPrompt = opts.colorPrompt ?? ((s) => fmt.green(s))
    this.onExpand = opts.onExpand
    this.maxMenu = opts.maxMenu ?? 8
    this.decoder = new StringDecoder('utf8')
  }

  // 读取一行：Enter → 字符串；ctrl-c/ctrl-d（空行）→ null（调用方据此退出 REPL）。
  question(): Promise<string | null> {
    return this.input.isTTY ? this.questionTTY() : this.questionPiped()
  }

  close(): void {
    this.rl?.close()
    this.rl = null
  }

  // 求值提示符文案（支持动态函数，如计划模式切换 'floom(plan)> '）。
  private resolvePrompt(): string {
    return typeof this.promptText === 'function' ? this.promptText() : this.promptText
  }

  // 非 TTY：退化为 readline 逐行读取，行为与改造前一致。
  private async questionPiped(): Promise<string | null> {
    if (!this.rl) this.rl = createInterface({ input: this.input, output: process.stdout })
    try {
      return await this.rl.question(this.resolvePrompt())
    } catch {
      return null // EOF / 中断
    }
  }

  private questionTTY(): Promise<string | null> {
    const input = this.input
    const out = this.out
    const promptText = this.resolvePrompt()
    const promptVis = promptText.length
    const colored = this.colorPrompt(promptText)

    return new Promise<string | null>((resolve) => {
      let st = initialEditorState()
      let prevRenderHeight = 1 // 上一帧渲染占用的总视觉行数（含换行+菜单）

      // 接管 stdin（复刻 selectMenu：保存并摘掉现有监听，结束后原样恢复）
      const prevData = input.listeners('data') as ((c: Buffer) => void)[]
      const prevKeypress = input.listeners('keypress') as ((...a: unknown[]) => void)[]
      const wasRaw = input.isRaw ?? false
      const wasPaused = input.isPaused()
      input.removeAllListeners('data')
      input.removeAllListeners('keypress')

      const restore = () => {
        input.removeListener('data', onData)
        input.setRawMode?.(wasRaw)
        for (const l of prevData) input.on('data', l)
        for (const l of prevKeypress) input.on('keypress', l)
        if (wasPaused) input.pause()
      }

      const tw = out.columns ?? 80

      const render = () => {
        const comp = computeCompletions(st.buffer)
        const open = comp.items.length > 0 && !st.dismissed
        if (st.menuIndex >= comp.items.length) {
          st.menuIndex = comp.items.length ? st.menuIndex % comp.items.length : 0
        }
        const menu = open ? comp.items.slice(0, this.maxMenu) : []

        // 光标目前在输入区，上移 prevRenderHeight 行回到帧顶（上边框），然后清屏
        if (prevRenderHeight > 0) out.write(`\x1b[${prevRenderHeight}A`)
        out.write('\r\x1b[J')

        // ── 上边框 ──
        out.write(`${fmt.inputLine(tw)}\n`)

        // ── ❯ 提示符 + 输入文本 ──
        out.write(colored + st.buffer)

        // ── 下拉菜单 ──
        for (let i = 0; i < menu.length; i++) {
          const it = menu[i]
          const ptr = i === st.menuIndex ? '❯ ' : '  '
          let text = `${ptr}${it.label}  ${it.desc}`
          const maxWidth = tw - 2
          if (text.length > maxWidth) text = text.slice(0, Math.max(1, maxWidth - 1)) + '…'
          out.write('\n' + (i === st.menuIndex ? fmt.cyan(text) : fmt.dim(text)))
        }

        // ── 下边框 ──
        out.write(`\n${fmt.inputLine(tw)}`)

        // 计算本帧总视觉行数及光标位置
        const totalWidth = promptVis + visualWidth(st.buffer)
        const inputLines = Math.floor(totalWidth / tw) + 1
        const totalRenderLines = 1 + inputLines + menu.length + 1

        const cursorOffset = promptVis + visualWidth(st.buffer.slice(0, st.cursor))
        const cursorLine = Math.floor(cursorOffset / tw)
        const cursorCol = cursorOffset % tw

        // 光标从帧顶(上边框)到当前位置的行数 = 上边框(1) + 输入区内行号
        // 存为 prevRenderHeight，供下次 render 从光标位置回到帧顶
        prevRenderHeight = 1 + cursorLine

        // 光标目前在下边框之后。上移到输入区光标位置。
        const linesUpToCursor = menu.length + 1 + (inputLines - 1 - cursorLine)
        if (linesUpToCursor > 0) out.write(`\x1b[${linesUpToCursor}A`)
        out.write('\r')
        if (cursorCol > 0) out.write(`\x1b[${cursorCol}C`)
      }

      const finalize = () => {
        // 光标在输入区，上移回到顶部边框行，清除整个边框区域
        if (prevRenderHeight > 0) out.write(`\x1b[${prevRenderHeight}A`)
        out.write('\r\x1b[J')
        // 输出不带边框的最终输入行到 scrollback
        out.write(`${colored}${st.buffer}\n`)
      }

      const apply = (key: Key): boolean => {
        const comp = computeCompletions(st.buffer)
        const r = reduceKey(st, key, comp.items)
        st = r.state
        switch (r.action) {
          case 'submit':
            finalize()
            restore()
            resolve(st.buffer)
            return true
          case 'cancel':
            finalize()
            restore()
            resolve(null)
            return true
          case 'expand-one':
          case 'expand-all': {
            out.write('\r\x1b[0K')
            this.onExpand?.(r.action === 'expand-all' ? 'all' : 'one')
            prevRenderHeight = 1
            render()
            return false
          }
          case 'redraw':
            render()
            return false
          default:
            return false
        }
      }

      const onData = (chunk: Buffer) => {
        // esc split buffering: 若上一个 chunk 是 lone ESC 且我们等合并，则把当前 chunk
        // 接上去、清掉定时器，作为转义序列整体解码。
        if (this.pendingEscTimer !== null) {
          clearTimeout(this.pendingEscTimer)
          this.pendingEscTimer = null
          this.pendingEscBuf.push(chunk)
          const merged = Buffer.concat(this.pendingEscBuf)
          this.pendingEscBuf = []
          const s = this.decoder.write(merged)
          this.decoder.end()
          this.decoder = new StringDecoder('utf8') // 重置解码器状态
          apply(decodeKey(s))
          return
        }

        const s = this.decoder.write(chunk) as string
        // 转义序列：整段解析
        if (s.startsWith('\x1b')) {
          // 如果刚好是 lone ESC（无后续字节），可能是被拆分的转义序列首字节。
          // 用微任务缓冲等待下一个 data 事件——若超时未到则当独立 ESC 处理。
          if (s === '\x1b') {
            this.pendingEscTimer = setTimeout(() => {
              this.pendingEscTimer = null
              this.pendingEscBuf = []
              apply(decodeKey('\x1b'))
            }, 10) // 10ms 内下一个 chunk 到达则拼接；否则当独立 ESC
            this.pendingEscBuf = [chunk]
            return
          }
          apply(decodeKey(s))
          return
        }
        // 单字符（非 ESC、非转义序列）：按键直派发
        if (s.length === 1) {
          apply(decodeKey(s))
          return
        }
        // 多字符粘贴：把控制字符清理后作为字面文本一次插入，不再逐个字节过
        // decodeKey，避免 Tab 在菜单打开时误补全、换行误提交。换行→空格以保持可读。
        const cleaned = s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s{2,}/g, ' ').trim()
        if (cleaned.length > 0) apply(decodeKey(cleaned))
      }

      input.setRawMode?.(true)
      input.resume()
      out.write('\n') // 与上一段输出留一行间隔
      render()
      input.on('data', onData)
    })
  }
}
