// 固定底部面板（对标 Claude Code 的常驻输入框 + 状态/模式区）。
//
// 布局（自上而下，永远贴屏幕底部）：
//   ┌ 输入框（模型输出期由本页脚画静态框，使「对话框一直存在」；空闲/输入期由 ReplReader
//   │        在滚动区内画可编辑框 → 见 repl-input.ts，本页脚此时只画下面两行）
//   ├ 运行摘要（仅有活动 run 时：⟳ 标题 · k/N agents · 1m21s · ↓ inspect）
//   ├ 状态行（model · effort · ctx% · bg）         ← 用户要求：状态在上
//   └ 模式行（⏵⏵ auto-accept on · shift+tab…）     ← 用户要求：mode 在下
//
// 渲染策略：用 DECSTBM 滚动区（`\x1b[1;<H-F>r`）把屏幕底部 F 行永久保留给面板，正文只在上方
// 滚动；面板用绝对定位重绘（`\x1b[row;1H\x1b[2K…`，不发换行 → 不滚动），重绘前后用 DECSC/DECRC
// （`\x1b7`/`\x1b8`）保存/恢复光标，使正文光标不受影响。**底部物理空间只在 install/resize 时按
// 「可能达到的最高面板」一次性腾出**（push 换行）；之后无论面板高度涨缩都只重设滚动区、绝不在
// 流式输出途中注入换行（否则会把正文顶乱）。高度涨缩最多覆盖几行「已显示过」的正文 → 仅视觉、不损数据。
//
// 两部分彻底分离：compose* 是纯函数（状态→字符串行，可单测）；Footer 类只管 ANSI/IO。
// 老终端（无 supportsFooter）由 cli 降级回内联状态栏，绝不输出滚动区转义序列。

import { fmt, visualWidth, stripAnsi, fmtDuration, fmtTokens } from './format.js'

export type Mode = 'normal' | 'auto-accept' | 'plan'

export interface FooterRunInfo {
  title: string
  progress: string // 来自 runProgress().label，如 "6/7 agents" 或 "Modules 6/7"
  elapsedMs: number
  paused: boolean
}

export interface FooterState {
  run: FooterRunInfo | null
  model: string
  effort?: string // 'high' | 'max' | undefined
  mode: Mode
  ctxTokens: number // 当前上下文估算 token
  ctxWindow: number // 仅显示用窗口（0 = 未知 → 显示原始 token 数）
  columns: number
  rows?: number // 终端高度（决定模型输出期是否还画静态输入框，避免矮终端吃掉正文）
  showBox?: boolean // 模型输出期：在页脚顶部画一个静态输入框，使「对话框一直存在」
  inputHint?: string // 静态框内提示（默认 'esc to interrupt'）
  backgroundTasks?: number
  cacheHitRatio?: number  // 0-1，缓存命中占比
  sessionDurationMs?: number // 会话已运行时长
}

// 模型输出期要在页脚里画静态输入框所需的最低终端高度（框 3 行 + 状态/模式 2 行 + 至少 5 行正文）。
const BOX_MIN_ROWS = 10

// 仅显示用的「上下文窗口」：用于页脚 ctx 百分比。遵守 CLAUDE.md「不臆造 DeepSeek 数字」——
// 该值**不参与任何裁剪/请求决策**，只用于页脚展示，且可由 env 覆盖；未知时退回原始 token 数。
export function ctxWindow(): number {
  const fromCtx = Number(process.env.FLOOM_CONTEXT_TOKENS)
  if (Number.isFinite(fromCtx) && fromCtx > 0) return fromCtx
  const fromDisplay = Number(process.env.FLOOM_CONTEXT_DISPLAY)
  if (Number.isFinite(fromDisplay) && fromDisplay > 0) return fromDisplay
  // 默认 1M：项目旗舰模型 deepseek-v4-pro 按 owner 设定的 1M 窗口显示（状态行 (1M)）。
  // 非官方实测确认（docs/deepseek-fact-check.md 仍标 ❓），可由 FLOOM_CONTEXT_TOKENS/_DISPLAY 覆盖。
  return 1_000_000
}

// 按视觉宽度裁剪明文到 columns（CJK 占 2 列）；超出时末尾加 '…'。
function clipVisual(plain: string, columns: number): string {
  if (columns <= 0 || visualWidth(plain) <= columns) return plain
  let out = ''
  let w = 0
  for (const ch of plain) {
    const cw = visualWidth(ch)
    if (w + cw > columns - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

// 给定「明文行 raw」与「带色行 colored」：明文不超列宽则用带色版，否则裁明文（避免截断 ANSI）。
function fit(raw: string, colored: string, columns: number): string {
  return visualWidth(raw) <= columns ? colored : clipVisual(raw, columns)
}

// —— 各行的纯组合（供页脚与 ReplReader 内联面板共用，保证两态一致）——

// ctx 进度条宽度（格）。
const BAR_W = 14

// 显示用窗口大小：1.2M / 200K / 128K（大写 K/M，仅用于「模型名 (窗口)」标注）。
function fmtWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  return `${Math.round(n / 1000)}K`
}

// 状态行：`<模型> (<窗口>)  │  ctx <进度条> <pct>% <用量>/<窗口>`（清新蓝/青绿，无 emoji，进度条式）。
// ctx 占用越多越警示:<70% 低绿 · 70%+ 黄 · 90%+ 珊瑚红。effort/bg 仅在存在时追加(默认清爽)。
// 用户要求它常驻、且在 mode 之上。
export function composeStatusLine(s: FooterState): string {
  const win = s.ctxWindow
  // 窗口未知:不臆造百分比/进度条,退回原始 token 数(遵守「不臆造 DeepSeek 数字」)。
  if (!(win > 0)) {
    const raw = `  ${s.model} · ~${fmtTokens(s.ctxTokens)} ctx`
    const col = `  ${fmt.blue(s.model)} ${fmt.dim('· ~' + fmtTokens(s.ctxTokens) + ' ctx')}`
    return fit(raw, col, s.columns)
  }
  const pct = Math.min(100, Math.round((s.ctxTokens / win) * 100))
  const color = pct >= 90 ? fmt.red : pct >= 70 ? fmt.yellow : fmt.green
  const filled = Math.max(0, Math.min(BAR_W, Math.round((pct / 100) * BAR_W)))
  const barPlain = '█'.repeat(filled) + '░'.repeat(BAR_W - filled)
  const barCol = color('█'.repeat(filled)) + fmt.dim('░'.repeat(BAR_W - filled))
  const used = fmtTokens(s.ctxTokens)
  const winTok = fmtWindow(win) // 窗口用紧凑大写(1M / 200K),避免 1000000 显示成「1000k」

  // 附加段（FlowLoom 既有信息）：仅在存在时追加，保持清爽。
  const extras: string[] = []
  const extrasCol: string[] = []
  if (s.effort) { extras.push(`effort:${s.effort}`); extrasCol.push(fmt.dim(`effort:${s.effort}`)) }
  if (s.backgroundTasks && s.backgroundTasks > 0) { extras.push(`${s.backgroundTasks} bg`); extrasCol.push(fmt.green(`${s.backgroundTasks} bg`)) }
  if (s.cacheHitRatio !== undefined && s.cacheHitRatio > 0.2) {
    const pct = Math.round(s.cacheHitRatio * 100)
    extras.push(`cache:${pct}%`); extrasCol.push(fmt.dim(`cache:${pct}%`))
  }
  if (s.sessionDurationMs !== undefined && s.sessionDurationMs > 60_000) {
    const dur = fmtDuration(s.sessionDurationMs)
    extras.push(dur); extrasCol.push(fmt.dim(dur))
  }
  const extraRaw = extras.length ? `  │  ${extras.join(' · ')}` : ''
  const extraCol = extrasCol.length ? fmt.dim('  │  ') + extrasCol.join(fmt.dim(' · ')) : ''

  const raw = `  ${s.model} (${fmtWindow(win)})  │  ctx ${barPlain} ${pct}% ${used}/${winTok}${extraRaw}`
  const col =
    `  ${fmt.blue(s.model)} ${fmt.cyan(`(${fmtWindow(win)})`)}` +
    `${fmt.dim('  │  ')}${fmt.dim('ctx')} ${barCol} ${color(`${pct}%`)} ${fmt.dim(`${used}/${winTok}`)}${extraCol}`
  return fit(raw, col, s.columns)
}

// 模式行：三态（normal / auto-accept / plan），始终带 shift+tab 提示——这是用户切模式的唯一可见反馈。
export function composeModeLine(s: { mode: Mode; columns: number }): string {
  const hint = 'shift+tab to cycle'
  let raw: string
  let col: string
  switch (s.mode) {
    case 'auto-accept':
      raw = `⏵⏵ auto-accept on · ${hint}`
      col = `${fmt.yellow('⏵⏵ auto-accept on')} ${fmt.dim('· ' + hint)}` // 用户要求:auto 黄色
      break
    case 'plan':
      raw = `⏸ plan mode on · ${hint}`
      col = `${fmt.blue('⏸ plan mode on')} ${fmt.dim('· ' + hint)}` // 用户要求:plan 蓝色
      break
    default:
      raw = `▷ normal · ${hint}`
      col = `${fmt.white('▷ normal')} ${fmt.dim('· ' + hint)}`
  }
  return fit('  ' + raw, '  ' + col, s.columns)
}

// 运行摘要行：仅有活动 run 时。
export function composeRunLine(run: FooterRunInfo, columns: number): string {
  const icon = run.paused ? fmt.yellow('⏸') : fmt.cyan('⟳')
  const tail = run.paused ? 'paused' : fmtDuration(run.elapsedMs)
  const raw = `  ${stripAnsi(icon)} ${run.title} · ${run.progress} · ${tail} · ↓ inspect`
  const col = `  ${icon} ${fmt.bold(run.title)} ${fmt.dim('·')} ${fmt.cyan(run.progress)} ${fmt.dim('·')} ${fmt.dim(tail)} ${fmt.dim('· ↓ inspect')}`
  return fit(raw, col, columns)
}

// 静态输入框（模型输出期常驻）：上下两条规则线 + 中间 `❯ <提示>`。与 ReplReader 的可编辑框同款边框，
// 使输入态/输出态视觉连续（「对话框一直存在」）。
export function composeBox(columns: number, hint?: string): string[] {
  const border = fmt.inputLine(columns)
  const h = hint ?? 'esc to interrupt'
  return [border, fit(`❯ ${h}`, `${fmt.white('❯')} ${fmt.dim(h)}`, columns), border]
}

// 纯组合：返回页脚应占用的所有行（自上而下）。颜色在非 TTY 下被 fmt 自动剥离。
export function composeFooter(s: FooterState): string[] {
  const lines: string[] = []
  const rows = s.rows ?? 24
  // 模型输出期：页脚顶部画常驻输入框（终端够高才画，避免吃掉正文）。
  if (s.showBox && rows >= BOX_MIN_ROWS) lines.push(...composeBox(s.columns, s.inputHint))
  if (s.run) lines.push(composeRunLine(s.run, s.columns))
  lines.push(composeStatusLine(s)) // 状态在上
  lines.push(composeModeLine(s)) // 模式在下
  return lines
}

// 面板「可能达到的最高高度」：用于一次性预留底部物理空间，使涨缩时无需再注入换行。
// = 静态框(3，够高才有) + 运行摘要(1) + 状态(1) + 模式(1)。
export function maxFooterHeight(rows: number): number {
  return (rows >= BOX_MIN_ROWS ? 3 : 0) + 1 + 1 + 1
}

// 终端是否支持滚动区页脚。非 TTY/太矮/显式关闭 → false。
// win32：现代 conhost（Win10 1903+）与 Windows Terminal/VS Code 均支持 DECSTBM 滚动区 + VT，
// 且 Node 在 Win10+ 的 TTY 上自动启用 VT 处理 → 任意 win32 TTY 都启用页脚（FLOOM_NO_FOOTER 兜底关闭）。
// （旧实现只认 WT_SESSION/vscode → 普通 PowerShell 控制台拿不到页脚，是「mode 行看不见、shift+tab
// 像没反应」的根因，故此处放宽。）
export function supportsFooter(out: NodeJS.WriteStream = process.stderr): boolean {
  if (process.env.FLOOM_NO_FOOTER) return false
  if (!out.isTTY) return false
  if (!out.rows || out.rows < 6) return false // 太矮的终端不值得保留页脚
  if (process.platform !== 'win32') return process.env.TERM !== 'dumb' && process.env.TERM !== 'linux'
  return true
}

export class Footer {
  private out: NodeJS.WriteStream
  private getState: () => FooterState
  private installed = false
  private suspended = false // 进 alt-screen 钻入视图期间挂起：paint 一律 no-op，避免污染 alt 缓冲
  private reserved = -1 // 当前已设滚动区对应的页脚行数（-1 = 强制下次重设）
  private pushed = 0 // 已 push 换行物理腾出的底部行数（= 历史最高面板高度，避免行数蠕变 + 流式注入换行）
  private lastF = 0 // 上一帧实际绘制的页脚行数（用于面板缩短时清残留、remove 时只清页脚不伤正文）
  private lastPaint = 0
  private trailing: ReturnType<typeof setTimeout> | null = null
  // resize：挂起期间(alt-screen)不动主屏；否则按新高度强制重设滚动区(reserved=-1)，必要时补腾空间。
  private onResize = () => {
    if (this.installed && !this.suspended) {
      this.reserved = -1
      this.applyAndPaint()
    }
  }

  constructor(getState: () => FooterState, out: NodeJS.WriteStream = process.stderr) {
    this.out = out
    this.getState = getState
  }

  install(): void {
    if (this.installed) return
    this.installed = true
    this.out.on?.('resize', this.onResize)
    this.applyAndPaint()
  }

  // 节流重绘：>=60ms 直接画；否则安排一次尾随重绘，避免事件风暴刷屏。
  paint(): void {
    if (!this.installed || this.suspended) return // 钻入视图(alt-screen)期间不画，避免污染 alt 缓冲
    const now = Date.now()
    if (now - this.lastPaint < 60) {
      if (!this.trailing) this.trailing = setTimeout(() => { this.trailing = null; this.applyAndPaint() }, 60)
      return
    }
    this.applyAndPaint()
  }

  private applyAndPaint(): void {
    if (!this.installed || this.suspended) return
    this.lastPaint = Date.now()
    const H = this.out.rows ?? 24
    const lines = composeFooter(this.getState())
    const F = Math.max(1, Math.min(lines.length, H - 2))

    // 一次性按「可能达到的最高面板」腾底部物理空间：只有当需要的最高高度超过已 push 的量时才补 push
    // （此刻光标多在底部/安静期，安全）。之后面板涨缩都 ≤ pushed → 不再注入换行，绝不破坏流式正文。
    const want = Math.max(F, Math.min(maxFooterHeight(H), H - 2))
    if (want > this.pushed) {
      const delta = want - this.pushed
      this.out.write('\n'.repeat(delta)) // 把正文顶上去
      this.out.write(`\x1b[${delta}A`) // 光标移回正文区
      this.pushed = want
    }

    const top = H - F // 滚动区 = 1..top；页脚 = top+1..H
    if (this.reserved !== F) {
      this.out.write('\x1b7') // DECSC 保存光标
      this.out.write(`\x1b[1;${top}r`) // 设滚动区（排除页脚）
      this.out.write('\x1b8') // DECRC 恢复光标
      this.reserved = F
    }

    // 绝对定位逐行重绘页脚（不发换行 → 不滚动）。
    this.out.write('\x1b7')
    // 面板比上一帧矮：上一帧多出来的页脚行现已落回滚动区 → 清掉,否则残留旧静态框/旧行文字。
    if (this.lastF > F) {
      for (let r = H - this.lastF + 1; r <= top; r++) this.out.write(`\x1b[${r};1H\x1b[2K`)
    }
    for (let i = 0; i < F; i++) {
      this.out.write(`\x1b[${top + 1 + i};1H\x1b[2K`)
      if (lines[i]) this.out.write(lines[i])
    }
    this.out.write('\x1b8')
    this.lastF = F
  }

  // 临时让出底部（进 alt-screen 钻入视图前调）：挂起重绘 + 复位滚动区，使全屏可用。
  suspend(): void {
    if (!this.installed) return
    this.suspended = true
    if (this.trailing) { clearTimeout(this.trailing); this.trailing = null }
    this.out.write('\x1b7\x1b[r\x1b8') // DECSC + 复位滚动区 + DECRC（保护光标位置）
    this.reserved = -1
  }

  // 从 alt-screen 返回后重建页脚。alt-screen 退出会还原主屏内容(含已腾的页脚空间)，但滚动区是
  // 终端全局状态、已被 suspend 复位 → 必须按当前高度强制重设(reserved=-1)，不再腾新行。
  resume(): void {
    if (!this.installed) return
    this.suspended = false
    this.reserved = -1
    this.applyAndPaint()
  }

  remove(): void {
    if (this.installed) {
      this.out.off?.('resize', this.onResize)
      if (this.trailing) { clearTimeout(this.trailing); this.trailing = null }
      const H = this.out.rows ?? 24
      // 只清**页脚那几行**(上一帧实际高度 lastF),移到页脚顶行清到屏幕底后把光标落在该处,使后续
      // REPL 输出从正文末尾紧接着继续。**绝不**按 pushed 清(pushed 可能 > lastF → 会擦掉正文最后几行)。
      // 滚动区复位前用 DECSC/DECRC 保护光标,避免 \x1b[r 的实现把光标弹到 home。
      this.out.write('\x1b7\x1b[r\x1b8')
      if (this.lastF > 0) {
        this.out.write(`\x1b[${Math.max(1, H - this.lastF + 1)};1H\x1b[J`)
      }
      this.installed = false
      this.reserved = -1
      this.pushed = 0
      this.lastF = 0
      this.suspended = false
    }
  }

  get active(): boolean {
    return this.installed
  }
}
