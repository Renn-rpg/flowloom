// 全屏钻入视图（对标 Claude Code 的 /workflows 视图）：运行中按 ↓ 进入，看每个子 agent 的
// model / tokens / tools / 耗时 / 状态，并能 x 停 / p 暂停 / s 存 / esc 返回。
//
// 用 alt-screen（`\x1b[?1049h`）与主屏隔离 → 不与滚动区页脚相互干扰。
// 三段分离：renderWorkflowView（纯帧渲染，可单测）/ reduceView（纯选择 reducer，可单测）/
// openWorkflowView（alt-screen + raw-mode IO 外壳）。

import { StringDecoder } from 'node:string_decoder'
import { fmt, visualWidth, stripAnsi, fmtDuration, fmtTokens } from './format.js'
import { decodeKey, type Key } from './repl-input.js'
import type { RunGroup, AgentRow } from './agent-tracker.js'

export interface ViewState {
  selected: number
}

export type ViewAction = 'redraw' | 'back' | 'stop' | 'pause' | 'save' | 'none'

export function reduceView(s: ViewState, key: Key, rowCount: number): { state: ViewState; action: ViewAction } {
  const clamp = (n: number) => Math.max(0, Math.min(rowCount - 1, n))
  switch (key.t) {
    case 'up':
      return { state: { selected: clamp(s.selected - 1) }, action: 'redraw' }
    case 'down':
      return { state: { selected: clamp(s.selected + 1) }, action: 'redraw' }
    case 'esc':
    case 'ctrl-c': // 始终可退出视图（raw 模式下 Ctrl-C 不会自动 SIGINT，否则会卡死在视图里）
      return { state: s, action: 'back' }
    case 'char':
      switch (key.ch) {
        case 'q': return { state: s, action: 'back' }
        case 'x': return { state: s, action: 'stop' }
        case 'p': return { state: s, action: 'pause' }
        case 's': return { state: s, action: 'save' }
        case 'k': return { state: { selected: clamp(s.selected - 1) }, action: 'redraw' }
        case 'j': return { state: { selected: clamp(s.selected + 1) }, action: 'redraw' }
      }
      return { state: s, action: 'none' }
    default:
      return { state: s, action: 'none' }
  }
}

function statusIcon(st: AgentRow['status']): string {
  switch (st) {
    case 'done': return fmt.green('✓')
    case 'failed': return fmt.red('✗')
    case 'running': return fmt.cyan('●')
    default: return fmt.dim('◌')
  }
}

function clip(line: string, columns: number): string {
  if (columns <= 0) return line
  const plain = stripAnsi(line)
  if (visualWidth(plain) <= columns) return line
  // 含颜色时退化为明文裁剪，避免截断 ANSI 序列。
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

function padVisual(s: string, width: number): string {
  const w = visualWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

// 纯帧渲染：给定 run + 选择态 + 终端尺寸（含 now，便于确定性测试），返回应写入 alt-screen 的行。
export function renderWorkflowView(
  run: RunGroup,
  s: ViewState,
  dims: { rows: number; columns: number; now: number },
): string[] {
  const cols = dims.columns
  const out: string[] = []
  const done = run.rows.filter((r) => r.status === 'done').length
  const failed = run.rows.filter((r) => r.status === 'failed').length
  const elapsed = fmtDuration((run.endedAt ?? dims.now) - run.startedAt)
  const statusTag =
    run.status === 'paused' ? fmt.yellow(' [paused]') : run.status === 'failed' ? fmt.red(' [failed]') : run.status === 'done' ? fmt.green(' [done]') : ''

  // 标题行
  out.push(clip(fmt.bold(run.title) + statusTag + fmt.dim(`   ${done + failed}/${run.rows.length} agents · ${elapsed}`), cols))

  // phase 概览（有 phase 时）
  if (run.phases.length > 0) {
    const segs = run.phases.map((p, i) => {
      const inPhase = run.rows.filter((r) => r.phase === p)
      const d = inPhase.filter((r) => r.status === 'done' || r.status === 'failed').length
      const txt = `${p} ${d}/${inPhase.length}`
      return i === run.currentPhase ? fmt.cyan('▸' + txt) : fmt.dim(' ' + txt)
    })
    out.push(clip(segs.join(fmt.dim('  ')), cols))
  }

  out.push(fmt.dim('─'.repeat(Math.min(cols, 100))))

  // body：窗口化 agent 行（顶部标题/分隔 + 底部分隔/详情/控制条占用的行预留）
  const chrome = out.length + 3 // 已用行 + 底部分隔 + 详情 + 控制条
  const bodyRows = Math.max(3, dims.rows - chrome)
  const total = run.rows.length
  let start = 0
  if (total > bodyRows) {
    start = Math.min(Math.max(0, s.selected - Math.floor(bodyRows / 2)), total - bodyRows)
  }
  const end = Math.min(total, start + bodyRows)
  if (start > 0) out.push(fmt.dim(`  ↑ ${start} more`))
  const labelW = Math.min(28, Math.max(...run.rows.map((r) => visualWidth(r.label)), 8))
  for (let i = start; i < end; i++) {
    const r = run.rows[i]
    const sel = i === s.selected
    const ptr = sel ? '❯ ' : '  '
    const el = fmtDuration((r.endedAt ?? dims.now) - r.startedAt)
    const tail = `${fmtTokens(r.outputTokens)} tok · ${r.toolCalls} tools · ${el}`
    const cur = r.status === 'running' && r.currentTool ? fmt.dim(` ${r.currentTool}…`) : ''
    const body = `${ptr}${statusIcon(r.status)} ${padVisual(r.label, labelW)}  ${fmt.dim(r.model)}  ${fmt.dim(tail)}${cur}`
    out.push(clip(sel ? fmt.cyan(stripAnsi(body)) : body, cols))
  }
  if (end < total) out.push(fmt.dim(`  ↓ ${total - end} more`))

  out.push(fmt.dim('─'.repeat(Math.min(cols, 100))))

  // 选中行详情（错误优先）
  const selRow = run.rows[s.selected]
  const detail = selRow?.error
    ? fmt.red('  ✗ ' + selRow.error)
    : selRow
      ? fmt.dim(`  ${selRow.label} · ${selRow.status}${selRow.currentTool ? ' · ' + selRow.currentTool : ''}`)
      : ''
  out.push(clip(detail, cols))

  // 控制条
  out.push(fmt.dim('  ↑↓ select · x stop · p pause/resume · s save · esc back'))
  return out
}

export interface WorkflowViewCtl {
  stop?: () => void
  pause?: () => void
  resume?: () => void
  isPaused?: () => boolean
  save?: () => string | void
}

// alt-screen + raw-mode IO 外壳：打开钻入视图，订阅 tracker 实时重绘，按键走 reduceView。
// 返回 Promise，用户按 esc/q 返回时 resolve。非 TTY 直接 resolve（无操作）。
export function openWorkflowView(
  tracker: { last: () => RunGroup | null; on: (e: 'update', cb: () => void) => void; off: (e: 'update', cb: () => void) => void },
  ctl: WorkflowViewCtl,
  opts: { input?: NodeJS.ReadStream; out?: NodeJS.WriteStream } = {},
): Promise<void> {
  const input = opts.input ?? process.stdin
  const out = opts.out ?? process.stderr
  if (!input.isTTY) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let sel: ViewState = { selected: 0 }
    const decoder = new StringDecoder('utf8')

    // 接管 stdin（保存现有监听，结束恢复）。watchInterrupt 调本函数前已摘掉自己的监听。
    const prevData = input.listeners('data') as ((c: Buffer) => void)[]
    const wasRaw = input.isRaw ?? false
    const wasPaused = input.isPaused()
    input.removeAllListeners('data')

    out.write('\x1b[?1049h') // 进 alt-screen
    out.write('\x1b[r') // 复位本缓冲滚动区（与主屏页脚区无关）
    out.write('\x1b[?25l') // 隐藏光标

    let toast = ''
    let lastPaint = 0
    let trailing: ReturnType<typeof setTimeout> | null = null

    const draw = () => {
      lastPaint = Date.now()
      // 渲染异常不能让视图卡在「光标已隐藏 + alt-screen」状态 → 兜底退出并显示错误。
      try {
        const run = tracker.last()
        const dims = { rows: out.rows ?? 24, columns: out.columns ?? 80, now: Date.now() }
        const lines = run ? renderWorkflowView(run, clampSel(run), dims) : [fmt.dim('  (no active run)')]
        if (toast) lines.push(fmt.green('  ' + toast))
        out.write('\x1b[2J\x1b[H')
        out.write(lines.join('\r\n'))
      } catch {
        finish() // 还原光标 + 退出 alt-screen + 交还 stdin
      }
    }
    const clampSel = (run: RunGroup): ViewState => {
      const max = Math.max(0, run.rows.length - 1)
      if (sel.selected > max) sel = { selected: max }
      if (sel.selected < 0) sel = { selected: 0 }
      return sel
    }
    const render = () => {
      const now = Date.now()
      if (now - lastPaint < 60) {
        if (!trailing) trailing = setTimeout(() => { trailing = null; draw() }, 60)
        return
      }
      draw()
    }

    const onUpdate = () => render()
    tracker.on('update', onUpdate)

    let finished = false
    const finish = () => {
      if (finished) return // 幂等：draw() 异常兜底 + 用户按键可能都触发，避免重复交还 stdin/重复 resolve
      finished = true
      if (trailing) { clearTimeout(trailing); trailing = null }
      tracker.off('update', onUpdate)
      out.write('\x1b[?25h') // 显示光标
      out.write('\x1b[?1049l') // 离开 alt-screen（恢复主屏）
      input.removeListener('data', onData)
      input.setRawMode?.(wasRaw)
      for (const l of prevData) input.on('data', l)
      if (wasPaused) input.pause()
      resolve()
    }

    const onData = (chunk: Buffer) => {
      const key = decodeKey(decoder.write(chunk) as string)
      const run = tracker.last()
      const r = reduceView(sel, key, run ? run.rows.length : 0)
      sel = r.state
      switch (r.action) {
        case 'back': finish(); return
        case 'stop': ctl.stop?.(); toast = 'stopping…'; render(); return
        case 'pause':
          if (ctl.isPaused?.()) { ctl.resume?.(); toast = 'resumed' } else { ctl.pause?.(); toast = 'paused' }
          render(); return
        case 'save': { const m = ctl.save?.(); toast = typeof m === 'string' ? m : 'saved'; render(); return }
        case 'redraw': toast = ''; render(); return
        default: return
      }
    }

    input.setRawMode?.(true)
    input.resume()
    input.on('data', onData)
    draw()
  })
}
