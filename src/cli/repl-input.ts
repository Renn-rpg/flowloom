// 交互式提示符的行编辑器：替换 readline，以支持「打 / 即弹下拉、随输入实时过滤、↑↓ 选、
// Tab/Enter 补全、ctrl+o 切换详情」等类 Claude Code 的体验。
//
// 分层（与 prompt.ts 同思路）：
//   · decodeKey —— 把 stdin chunk 解析成语义按键（纯函数，可单测）
//   · reduceKey —— 给定状态 + 按键 + 当前补全项，算出新状态与动作（纯函数，可单测）
//   · ReplReader —— raw-mode IO 外壳：接管 stdin、渲染提示行 + 下拉、回调 ctrl+o
// 非 TTY（管道/CI）自动降级为普通 readline 逐行读取，行为与改造前一致。

import { createInterface, type Interface } from 'node:readline/promises'
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { computeCompletions, type CompletionItem } from './completions.js'

// @ 文件补全的真实目录列举:相对 cwd 读目录;不可读返回空(computeCompletions 据此显示无菜单)。
function listProjectDir(dirRel: string): { name: string; isDir: boolean }[] {
  try {
    return readdirSync(resolve(process.cwd(), dirRel || '.'), { withFileTypes: true })
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  } catch {
    return []
  }
}
import { fmt, visualWidth, physicalRows } from './format.js'

// ——— 按键解析 ———

export type Key =
  | { t: 'char'; ch: string }
  | { t: 'enter' }
  | { t: 'backspace' }
  | { t: 'delete' }
  | { t: 'tab' }
  | { t: 'shift-tab' }
  | { t: 'esc' }
  | { t: 'up' }
  | { t: 'down' }
  | { t: 'left' }
  | { t: 'right' }
  | { t: 'home' }
  | { t: 'end' }
  | { t: 'ctrl-c' }
  | { t: 'ctrl-d' }
  | { t: 'ctrl-r' }
  | { t: 'ctrl-o' }
  | { t: 'ctrl-e' }
  | { t: 'newline' }  // Alt+Enter / Shift+Enter → 插入换行，不提交
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
    case '\x1b[Z': // Shift+Tab（CSI Z）→ 循环切换模式
      return { t: 'shift-tab' }
    case '\x03':
      return { t: 'ctrl-c' }
    case '\x04':
      return { t: 'ctrl-d' }
    case '\x12':
      return { t: 'ctrl-r' }
    case '\x0f':
      return { t: 'ctrl-o' }
    case '\x1b[13;2u': // Shift+Enter (kitty protocol)
    case '\x1b[13u':   // Shift+Enter (bare CSI u)
      return { t: 'newline' }
    case '\x1b\r': // Alt+Enter → 插入换行 (\r === \x0d)
      return { t: 'newline' }
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

// ——— 状态机 ———

export interface EditorState {
  buffer: string
  cursor: number
  menuIndex: number
  dismissed: boolean
  historyIndex: number
  savedBuffer: string
  scrollOffset: number // 菜单滚动偏移（视窗起始索引）
  searchMode: boolean
  searchQuery: string
  searchMatch: number
}

export type EditorAction = 'redraw' | 'submit' | 'cancel' | 'expand-one' | 'expand-all' | 'cycle-mode' | 'none'

export interface ReduceResult {
  state: EditorState
  action: EditorAction
}

export function initialEditorState(): EditorState {
  return { buffer: '', cursor: 0, menuIndex: 0, dismissed: false, historyIndex: -1, savedBuffer: '', scrollOffset: 0, searchMode: false, searchQuery: '', searchMatch: 0 }
}

function edited(buffer: string, cursor: number): EditorState {
  return { buffer, cursor, menuIndex: 0, dismissed: false, historyIndex: -1, savedBuffer: '', scrollOffset: 0, searchMode: false, searchQuery: '', searchMatch: 0 }
}

// 纯状态转移：items 为「当前 buffer 对应的补全项」（由调用方先算好）。
// history 为历史命令数组（可选），供 ↑↓ 导航。
export function reduceKey(state: EditorState, key: Key, items: CompletionItem[], history?: string[]): ReduceResult {
  const menuOpen = items.length > 0 && !state.dismissed
  const len = state.buffer.length
  const redraw = (s: EditorState): ReduceResult => ({ state: s, action: 'redraw' })
  const none = (): ReduceResult => ({ state, action: 'none' })

  // 非导航状态的字符输入 → 退出历史模式
  const exitHistory = (next: EditorState): EditorState =>
    key.t === 'char' || key.t === 'backspace' || key.t === 'delete'
      ? { ...next, historyIndex: -1, savedBuffer: '' }
      : next

  switch (key.t) {
    case 'newline': {
      // 插入字面换行符（不提交）
      const b = state.buffer.slice(0, state.cursor) + '\n' + state.buffer.slice(state.cursor)
      return redraw(exitHistory(edited(b, state.cursor + 1)))
    }
    case 'char': {
      if (state.searchMode && history) {
        const q = state.searchQuery + key.ch
        // 从当前匹配位置往前搜索
        let found = -1
        for (let i = state.searchMatch; i >= 0; i--) {
          if (history[i].includes(q)) { found = i; break }
        }
        if (found === -1) {
          for (let i = history.length - 1; i > state.searchMatch; i--) {
            if (history[i].includes(q)) { found = i; break }
          }
        }
        if (found !== -1) {
          return redraw({ ...state, searchQuery: q, searchMatch: found, buffer: history[found], cursor: history[found].length })
        }
        return redraw({ ...state, searchQuery: q }) // 无匹配，保留查询
      }
      const b = state.buffer.slice(0, state.cursor) + key.ch + state.buffer.slice(state.cursor)
      return redraw(exitHistory(edited(b, state.cursor + key.ch.length)))
    }
    case 'backspace': {
      if (state.cursor === 0) return none()
      const b = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor)
      return redraw(exitHistory(edited(b, state.cursor - 1)))
    }
    case 'delete': {
      if (state.cursor >= len) return none()
      const b = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1)
      return redraw(exitHistory(edited(b, state.cursor)))
    }
    case 'left':
      return state.cursor > 0 ? redraw(exitHistory({ ...state, cursor: state.cursor - 1 })) : none()
    case 'right':
      return state.cursor < len ? redraw(exitHistory({ ...state, cursor: state.cursor + 1 })) : none()
    case 'home':
      return state.cursor > 0 ? redraw(exitHistory({ ...state, cursor: 0 })) : none()
    case 'end':
      return state.cursor < len ? redraw(exitHistory({ ...state, cursor: len })) : none()
    case 'up':
      if (menuOpen) {
        const newIdx = state.menuIndex > 0 ? state.menuIndex - 1 : items.length - 1
        return redraw({ ...state, menuIndex: newIdx, scrollOffset: 0 })
      }
      if (!history || history.length === 0) return none()
      if (state.historyIndex === -1) {
        const idx = history.length - 1
        return redraw({ ...state, buffer: history[idx], cursor: history[idx].length, historyIndex: idx, savedBuffer: state.buffer })
      }
      if (state.historyIndex > 0) {
        const idx = state.historyIndex - 1
        return redraw({ ...state, buffer: history[idx], cursor: history[idx].length, historyIndex: idx })
      }
      return none()
    case 'down':
      if (menuOpen) {
        const newIdx = state.menuIndex < items.length - 1 ? state.menuIndex + 1 : 0
        return redraw({ ...state, menuIndex: newIdx, scrollOffset: 0 })
      }
      if (state.historyIndex === -1) return none()
      if (state.historyIndex < (history?.length ?? 0) - 1) {
        const idx = state.historyIndex + 1
        return redraw({ ...state, buffer: history![idx], cursor: history![idx].length, historyIndex: idx })
      }
      // 到达最新之后 ↓ → 恢复原始输入
      return redraw({ ...state, buffer: state.savedBuffer, cursor: state.savedBuffer.length, historyIndex: -1, savedBuffer: '' })
    case 'ctrl-r': {
      if (!history || history.length === 0) return none()
      if (!state.searchMode) {
        return redraw({ ...state, searchMode: true, searchQuery: '', searchMatch: history.length - 1, savedBuffer: state.savedBuffer || state.buffer })
      }
      // 已在搜索模式中 → 跳转到下一个匹配
      if (state.searchQuery) {
        let idx = state.searchMatch - 1
        for (let i = 0; i < history.length; i++) {
          if (idx < 0) idx = history.length - 1
          if (history[idx].includes(state.searchQuery)) {
            return redraw({ ...state, searchMatch: idx, buffer: history[idx], cursor: history[idx].length })
          }
          idx--
        }
      }
      return none()
    }
    case 'tab': {
      if (!menuOpen) return none()
      const accepted = items[Math.min(state.menuIndex, items.length - 1)].replacement
      if (accepted === state.buffer) return none()
      return redraw(edited(accepted, accepted.length))
    }
    case 'esc':
      if (state.searchMode) {
        return redraw({ ...state, searchMode: false, searchQuery: '', buffer: state.savedBuffer, cursor: state.savedBuffer.length })
      }
      return menuOpen ? redraw({ ...state, dismissed: true }) : none()
    case 'enter': {
      if (state.searchMode) {
        return { state: { ...state, searchMode: false, searchQuery: '' }, action: 'redraw' }
      }
      if (menuOpen) {
        const accepted = items[Math.min(state.menuIndex, items.length - 1)].replacement
        if (accepted !== state.buffer) return redraw(edited(accepted, accepted.length))
      }
      if (state.buffer.trim() === '') return none()
      return { state, action: 'submit' }
    }
    case 'ctrl-c':
      if (state.searchMode) {
        return redraw({ ...state, searchMode: false, searchQuery: '', buffer: state.savedBuffer, cursor: state.savedBuffer.length })
      }
      if (state.buffer === '') return { state, action: 'cancel' }
      return redraw(initialEditorState())
    case 'ctrl-d':
      // 空行 EOF → 退出；非空忽略
      return state.buffer === '' ? { state, action: 'cancel' } : none()
    case 'ctrl-o':
      return { state, action: 'expand-one' }
    case 'ctrl-e':
      return { state, action: 'expand-all' }
    case 'shift-tab':
      return { state, action: 'cycle-mode' }
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
  onCycleMode?: () => void // Shift+Tab 回调：循环切换 normal/auto-accept/plan
  // 输入框下方常驻面板行（如状态行 + 模式行）。每帧重新求值 → 切模式立刻反映；
  // 随输入框一起被 \x1b[J 清除/重绘，故无论是否有滚动区页脚都「永久可见、不只输出时出现」。
  panelLines?: () => string[]
  maxMenu?: number // 下拉最多展示项数，默认 12
}

export class ReplReader {
  private input: NodeJS.ReadStream
  private out: NodeJS.WriteStream
  private promptText: string | (() => string)
  private colorPrompt: (s: string) => string
  private onExpand?: (mode: 'one' | 'all') => void
  private onCycleMode?: () => void
  private panelLines?: () => string[]
  private maxMenu: number
  private rl: Interface | null = null

  // 持久的 UTF-8 流式解码器：跨 data 事件拼接被截断的多字节字符（中文/Emoji 常见），
  // 避免 per-event chunk.toString('utf8') 把不完整的字节序列解为 U+FFFD 替换字符。
  private decoder: StringDecoder
  private history: string[] = [] // 命令历史（去重连续相同）

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
    this.onCycleMode = opts.onCycleMode
    this.panelLines = opts.panelLines
    this.maxMenu = opts.maxMenu ?? 12
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

  // 模型输出期间监听中断键:接管 stdin(raw + resume),只识别 ESC(打断本轮)与 Ctrl-C(退出),
  // 吞掉其余输入(避免流式时杂键回显/排队)。返回 disarm() 原样恢复 stdin 状态。非 TTY 返回空函数。
  // 与 questionTTY 用同一套「保存→接管→恢复」手法,确保不与行编辑器的 stdin 接管冲突。
  watchInterrupt(handlers: {
    onEsc: () => void
    onCtrlC: () => void
    // 运行期按 ↓ → 进入全屏钻入视图。onInspect 自管 stdin（本监听器期间已让出），await 其返回后复位。
    onInspect?: () => Promise<void>
    // 运行期按 Shift+Tab → 循环切换模式（输出途中也能切，不被吞）。
    onCycleMode?: () => void
  }): () => void {
    const input = this.input
    if (!input.isTTY) return () => {}
    const prevData = input.listeners('data') as ((c: Buffer) => void)[]
    const wasRaw = input.isRaw ?? false
    const wasPaused = input.isPaused()
    input.removeAllListeners('data')
    let busy = false // 钻入视图打开期间，本监听器让出 stdin
    let disarmed = false // 本轮已结束（disarm 被调用）
    let escTimer: ReturnType<typeof setTimeout> | null = null // 缓冲 lone ESC，区分独立 ESC 与被拆分的转义序列
    const restoreOriginal = () => {
      input.setRawMode?.(wasRaw)
      for (const l of prevData) input.on('data', l)
      if (wasPaused) input.pause()
    }
    const openInspect = () => {
      busy = true
      input.removeListener('data', onData)
      Promise.resolve(handlers.onInspect!()).finally(() => {
        busy = false
        // 视图打开期间若本轮已结束(disarm 被调用)：stdin 当时未还原(见下),此刻补还原到原始态，
        // **不**重新接管(否则会把中断监听器泄漏到 REPL 提示符)。
        if (disarmed) { restoreOriginal(); return }
        input.setRawMode?.(true)
        input.resume()
        input.on('data', onData)
      })
    }
    // 把一段(可能含被缓冲 ESC 前缀的)序列分发为语义动作。
    const dispatchSeq = (s: string): void => {
      if (handlers.onCycleMode && s === '\x1b[Z') { handlers.onCycleMode(); return } // Shift+Tab → 切模式
      if (handlers.onInspect && (s === '\x1b[B' || s === '\x1bOB')) { openInspect(); return } // ↓ → 钻入视图
      // 其余转义序列在模型输出期一律忽略
    }
    const onData = (chunk: Buffer) => {
      if (busy) return
      // 若上一个 chunk 是被缓冲的 lone ESC：把当前 chunk 接上,作为完整转义序列分发(避免拆分误触)。
      if (escTimer !== null) {
        clearTimeout(escTimer)
        escTimer = null
        dispatchSeq('\x1b' + chunk.toString('latin1'))
        return
      }
      // Ctrl-C(0x03):raw 模式下不会自动产生 SIGINT,这里手动转交退出逻辑
      if (chunk.includes(0x03)) { handlers.onCtrlC(); return }
      // 单字节 ESC：可能是独立 ESC(打断),也可能是被拆分的转义序列首字节。
      // 缓冲 30ms——Windows ConPTY/pwsh 下序列字节间延迟可能 >12ms，导致误触。
      if (chunk.length === 1 && chunk[0] === 0x1b) {
        escTimer = setTimeout(() => { escTimer = null; handlers.onEsc() }, 30)
        return
      }
      dispatchSeq(chunk.toString('latin1'))
    }
    input.setRawMode?.(true)
    input.resume()
    input.on('data', onData)
    return () => {
      if (disarmed) return
      disarmed = true
      if (escTimer !== null) { clearTimeout(escTimer); escTimer = null }
      // 钻入视图打开中(busy)：stdin 归视图所有，延迟还原到视图关闭时的 finally 处理。
      if (busy) return
      input.removeListener('data', onData)
      restoreOriginal()
    }
  }

  // 从文件加载历史（JSONL 格式，每行一条命令），上限 600 与 in-memory 限制对齐
  loadHistory(path: string): void {
    try {
      const raw = readFileSync(path, 'utf8')
      const lines = raw.split('\n').map(s => s.trim()).filter(Boolean)
      this.history = lines.length > 600 ? lines.slice(-600) : lines
    } catch { /* 无文件/不可读 → 空历史 */ }
  }

  saveHistory(path: string): void {
    try {
      const recent = this.history.slice(-500)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, recent.join('\n') + '\n', 'utf8')
    } catch { /* 落盘失败不影响交互 */ }
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
    // 提示符**每帧**重新求值（而非整行读取期只算一次）：模式切换/动态提示符须立刻反映在屏上，
    // 否则 Shift+Tab 改了状态却看不到任何变化（曾导致「shift+tab 像没反应」）。
    const promptNow = () => {
      const text = this.resolvePrompt()
      return { vis: visualWidth(text), colored: this.colorPrompt(text) }
    }

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
        // 清掉可能仍挂着的 split-ESC 定时器：否则 question() 已 resolve 后定时器仍会 fire，
        // 在已关闭/已交还的 stdin 上用失效闭包调用 apply()，造成陈旧状态写入。
        if (this.pendingEscTimer !== null) {
          clearTimeout(this.pendingEscTimer)
          this.pendingEscTimer = null
          this.pendingEscBuf = []
        }
        input.removeListener('data', onData)
        input.setRawMode?.(wasRaw)
        for (const l of prevData) input.on('data', l)
        for (const l of prevKeypress) input.on('keypress', l)
        if (wasPaused) input.pause()
      }

      const tw = out.columns ?? 80

      const render = () => {
        const { vis: promptVis, colored } = promptNow()
        const comp = computeCompletions(st.buffer, { listDir: listProjectDir })
        const open = comp.items.length > 0 && !st.dismissed
        // 滚动窗口：计算 scrollOffset 使 menuIndex 始终可见
        const allItems = comp.items
        const maxVis = this.maxMenu
        let offset = st.scrollOffset
        if (st.menuIndex < offset) offset = st.menuIndex
        else if (st.menuIndex >= offset + maxVis) offset = st.menuIndex - maxVis + 1
        const menu = open ? allItems.slice(offset, offset + maxVis) : []
        const hasAbove = open && offset > 0
        const hasBelow = open && offset + maxVis < allItems.length

        // 光标目前在输入区，上移 prevRenderHeight 行回到帧顶（上边框），然后清屏
        if (prevRenderHeight > 0) out.write(`\x1b[${prevRenderHeight}A`)
        out.write('\r\x1b[J')

        // ── 上边框 ──
        out.write(`${fmt.inputLine(tw)}\n`)

        // ── 提示符 ──
        if (st.searchMode) {
          const searchPrompt = `(reverse-i-search\`${st.searchQuery}'): `
          out.write(fmt.dim(searchPrompt) + st.buffer)
        } else {
          out.write(colored + st.buffer)
        }

        // ── 下拉菜单 ──
        if (hasAbove) out.write('\n' + fmt.dim(`  ↑ ${offset} more`))
        for (let i = 0; i < menu.length; i++) {
          const it = menu[i]
          const globalIdx = offset + i
          const ptr = globalIdx === st.menuIndex ? '❯ ' : '  '
          const label = `${ptr}${it.label}`
          const maxDesc = Math.max(10, tw - visualWidth(label) - 4)
          const desc = it.desc.length > maxDesc ? it.desc.slice(0, maxDesc - 1) + '…' : it.desc
          out.write('\n' + (globalIdx === st.menuIndex ? fmt.cyan(label + '  ' + desc) : fmt.dim(label + '  ' + desc)))
        }
        if (hasBelow) out.write('\n' + fmt.dim(`  ↓ ${allItems.length - offset - maxVis} more`))

        // ── 下边框 ──
        out.write(`\n${fmt.inputLine(tw)}`)

        // ── 常驻面板行（状态行在上、模式行在下）：贴在输入框下方,与框一起被 \x1b[J 清/重绘。──
        const panel = this.panelLines?.() ?? []
        for (const pl of panel) out.write('\n' + pl)
        // 面板行可能超列宽而折行 → 按**物理行数**计入光标回移(逻辑行数不准会错位)。
        const panelRows = panel.reduce((n, pl) => n + physicalRows(pl, tw), 0)

        // 计算本帧总视觉行数（含 ↑/↓ 滚动指示器）
        const totalWidth = promptVis + visualWidth(st.buffer)
        const inputLines = Math.floor(totalWidth / tw) + 1
        const indicatorLines = (hasAbove ? 1 : 0) + (hasBelow ? 1 : 0)
        const cursorOffset = promptVis + visualWidth(st.buffer.slice(0, st.cursor))
        const cursorLine = Math.floor(cursorOffset / tw)
        const cursorCol = cursorOffset % tw

        // 光标从帧顶(上边框)到当前位置的行数 = 上边框(1) + 输入区内行号
        // 存为 prevRenderHeight，供下次 render 从光标位置回到帧顶
        prevRenderHeight = 1 + cursorLine

        // 光标目前在最后一条面板行之后。上移到输入区光标位置
        // （经过 面板物理行 + 下边框 + 菜单 + 指示器 + 剩余输入行）
        const linesUpToCursor = panelRows + 1 + indicatorLines + menu.length + (inputLines - 1 - cursorLine)
        if (linesUpToCursor > 0) out.write(`\x1b[${linesUpToCursor}A`)
        out.write('\r')
        if (cursorCol > 0) out.write(`\x1b[${cursorCol}C`)
      }

      const finalize = () => {
        const { colored } = promptNow()
        // 光标在输入区，上移回到顶部边框行，清除整个边框区域
        if (prevRenderHeight > 0) out.write(`\x1b[${prevRenderHeight}A`)
        out.write('\r\x1b[J')
        // 输出灰底渲染的最终输入行到 scrollback（所有路径统一回显）
        out.write(fmt.userMsg(`${colored}${st.buffer}`, out.columns ?? 80) + '\n')
      }

      const apply = (key: Key): boolean => {
        const comp = computeCompletions(st.buffer, { listDir: listProjectDir })
        // 先 clamp menuIndex（防御越界），再传给 reduceKey
        if (st.menuIndex >= comp.items.length) st.menuIndex = 0
        if (st.menuIndex < 0) st.menuIndex = 0
        const r = reduceKey(st, key, comp.items, this.history)
        st = r.state
        switch (r.action) {
          case 'submit': {
            finalize()
            restore()
            // 添加到历史（去重连续相同）
            const trimmed = st.buffer.trim()
            if (trimmed && this.history[this.history.length - 1] !== trimmed) {
              this.history.push(trimmed)
              // 防止 in-memory 历史无限增长：保留最近 600 条（写盘时只取 500）
              if (this.history.length > 600) this.history = this.history.slice(-600)
            }
            resolve(st.buffer)
            return true
          }
          case 'cancel':
            finalize()
            restore()
            resolve(null)
            return true
          case 'expand-one':
          case 'expand-all': {
            out.write('\r\x1b[0K')
            this.onExpand?.(r.action === 'expand-all' ? 'all' : 'one')
            // onExpand 逐块重渲染、每块尾随 '\n' → 结束时光标已落在展开内容下方的新行上。
            // 故新帧应**就地**从该行开始画(prevRenderHeight=0:render 不再上移),否则上移 1 行会
            // 把展开内容的最后一行覆盖掉(实测 bug)。render() 内部随后会把 prevRenderHeight 重置为正常值。
            prevRenderHeight = 0
            render()
            return false
          }
          case 'cycle-mode': {
            // 切模式（cli 侧更新 plan/auto-accept + 重绘页脚）。提示符文案可能随之变（plan/auto）→ 重绘。
            this.onCycleMode?.()
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
        // 多字符粘贴：所有控制字符（含 \n \r）替换为空格，合并空白，避免换行符导致
        // decodeKey 可见字符检查失败（\n < ' '）而整个粘贴被当成 unknown 丢弃。
        const cleaned = s.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f\x0a\x0d]/g, ' ').replace(/\s{2,}/g, ' ').trim()
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
