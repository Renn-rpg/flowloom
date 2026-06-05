import { describe, it, expect, afterEach } from 'vitest'
import {
  composeFooter,
  composeStatusLine,
  composeModeLine,
  composeRunLine,
  composeBox,
  maxFooterHeight,
  supportsFooter,
  ctxWindow,
  Footer,
  type FooterState,
} from './footer.js'

const base = (over: Partial<FooterState> = {}): FooterState => ({
  run: null,
  model: 'deepseek-v4-pro',
  mode: 'normal',
  ctxTokens: 12_800,
  ctxWindow: 128_000,
  columns: 120,
  rows: 40,
  ...over,
})

describe('composeFooter (layout)', () => {
  it('renders exactly two fixed lines (status on top, mode below) when idle', () => {
    const lines = composeFooter(base())
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('deepseek-v4-pro') // 状态在上
    expect(lines[1]).toContain('shift+tab to cycle') // mode 在下
    expect(lines[1]).toContain('normal')
  })

  it('adds the run summary above the two fixed lines when a run is active', () => {
    const lines = composeFooter(base({ run: { title: 'parallel agents', progress: '2/6 agents', elapsedMs: 81_000, paused: false } }))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('parallel agents')
    expect(lines[0]).toContain('2/6 agents')
    expect(lines[0]).toContain('1m21s')
    expect(lines[0]).toContain('↓ inspect')
    expect(lines[1]).toContain('deepseek-v4-pro') // 状态行仍在 mode 之上
    expect(lines[2]).toContain('shift+tab')
  })

  it('prepends a static input box during model output (showBox) when the terminal is tall enough', () => {
    const lines = composeFooter(base({ showBox: true, rows: 40 }))
    expect(lines).toHaveLength(5) // box(3) + status + mode
    expect(lines[1]).toContain('❯') // 框中间一行
    expect(lines[3]).toContain('deepseek-v4-pro')
    expect(lines[4]).toContain('shift+tab')
  })

  it('omits the static box on a short terminal even when showBox is set', () => {
    const lines = composeFooter(base({ showBox: true, rows: 8 }))
    expect(lines).toHaveLength(2)
    expect(lines.some((l) => l.includes('❯'))).toBe(false)
  })
})

describe('composeStatusLine', () => {
  it('renders model(window) + a ctx progress bar + percent + used/window', () => {
    const line = composeStatusLine(base({ ctxTokens: 84_000, ctxWindow: 200_000 }))
    expect(line).toContain('deepseek-v4-pro (200K)') // 模型名 + 窗口标注
    expect(line).toContain('ctx')
    expect(line).toContain('42%') // 84000 / 200000
    expect(line).toContain('84k/200K') // 实际用量/窗口（窗口用紧凑大写）
    expect(line).toMatch(/[█░]/) // 进度条
  })

  it('renders a million-token window as 1M, not 1000k', () => {
    const line = composeStatusLine(base({ ctxTokens: 84_000, ctxWindow: 1_000_000 }))
    expect(line).toContain('deepseek-v4-pro (1M)')
    expect(line).toContain('84k/1M')
    expect(line).not.toContain('1000k')
  })

  it('shows the context percentage against the display window', () => {
    const line = composeStatusLine(base({ ctxTokens: 12_800, ctxWindow: 128_000 }))
    expect(line).toContain('10%')
    expect(line).toContain('(128K)')
    expect(line).toContain('/128K')
  })

  it('fills the bar more as ctx grows (proportional)', () => {
    const low = composeStatusLine(base({ ctxTokens: 0, ctxWindow: 200_000 }))
    const high = composeStatusLine(base({ ctxTokens: 190_000, ctxWindow: 200_000 }))
    const fills = (s: string) => (s.match(/█/g) || []).length
    expect(fills(low)).toBeLessThan(fills(high))
  })

  it('falls back to a raw token count when the window is unknown (0)', () => {
    const line = composeStatusLine(base({ ctxTokens: 4200, ctxWindow: 0 }))
    expect(line).toContain('ctx')
    expect(line).not.toContain('%')
    expect(line).not.toMatch(/[█░]/) // 不臆造进度条
    expect(line).toContain('4.2k')
  })

  it('reflects effort and background tasks only when present', () => {
    expect(composeStatusLine(base())).not.toContain('effort')
    expect(composeStatusLine(base())).not.toContain('bg')
    expect(composeStatusLine(base({ effort: 'high' }))).toContain('effort:high')
    expect(composeStatusLine(base({ backgroundTasks: 3 }))).toContain('3 bg')
  })

  it('clips to the terminal width', () => {
    const line = composeStatusLine(base({ columns: 20 }))
    expect(line.length).toBeLessThanOrEqual(20)
  })
})

describe('composeModeLine', () => {
  it('renders each of the three modes with the cycle hint', () => {
    expect(composeModeLine({ mode: 'normal', columns: 120 })).toMatch(/normal.*shift\+tab/)
    expect(composeModeLine({ mode: 'auto-accept', columns: 120 })).toMatch(/auto-accept.*shift\+tab/)
    expect(composeModeLine({ mode: 'plan', columns: 120 })).toMatch(/plan.*shift\+tab/)
  })

  it('clips to the terminal width', () => {
    expect(composeModeLine({ mode: 'auto-accept', columns: 16 }).length).toBeLessThanOrEqual(16)
  })
})

describe('composeRunLine', () => {
  it('marks a paused run', () => {
    const line = composeRunLine({ title: 'wf', progress: 'Modules 1/3', elapsedMs: 5_000, paused: true }, 120)
    expect(line).toContain('paused')
    expect(line).toContain('⏸')
  })
})

describe('composeBox', () => {
  it('returns a 3-line box with a centered prompt + hint', () => {
    const box = composeBox(80, 'esc to interrupt')
    expect(box).toHaveLength(3)
    expect(box[1]).toContain('❯')
    expect(box[1]).toContain('esc to interrupt')
  })
})

describe('maxFooterHeight', () => {
  it('reserves room for box + run + status + mode on a tall terminal', () => {
    expect(maxFooterHeight(40)).toBe(6) // 3 + 1 + 1 + 1
  })
  it('drops the box budget on a short terminal', () => {
    expect(maxFooterHeight(8)).toBe(3) // run + status + mode
  })
})

describe('supportsFooter', () => {
  const fakeTty = (over: Partial<NodeJS.WriteStream> = {}): NodeJS.WriteStream =>
    ({ isTTY: true, rows: 40, ...over } as unknown as NodeJS.WriteStream)

  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  const onWin32 = (fn: () => void) => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try { fn() } finally { Object.defineProperty(process, 'platform', orig) }
  }

  it('is false for non-TTY', () => {
    expect(supportsFooter({ isTTY: false, rows: 40 } as unknown as NodeJS.WriteStream)).toBe(false)
  })

  it('is false when FLOOM_NO_FOOTER is set', () => {
    process.env.FLOOM_NO_FOOTER = '1'
    expect(supportsFooter(fakeTty())).toBe(false)
  })

  it('is false for a too-short terminal', () => {
    delete process.env.FLOOM_NO_FOOTER
    expect(supportsFooter(fakeTty({ rows: 4 }))).toBe(false)
  })

  it('is true on Windows Terminal', () => {
    delete process.env.FLOOM_NO_FOOTER
    process.env.WT_SESSION = 'x'
    onWin32(() => expect(supportsFooter(fakeTty())).toBe(true))
  })

  it('is true on a plain Windows console (conhost, no WT_SESSION)', () => {
    delete process.env.FLOOM_NO_FOOTER
    delete process.env.WT_SESSION
    delete process.env.TERM_PROGRAM
    delete process.env.ConEmuTask
    onWin32(() => expect(supportsFooter(fakeTty())).toBe(true))
  })
})

describe('Footer (scroll-region IO)', () => {
  const fakeOut = (rows = 40, columns = 80) => {
    let buf = ''
    return {
      rows, columns, isTTY: true,
      write: (s: string) => { buf += s; return true },
      on: () => {}, off: () => {},
      get text() { return buf },
      reset() { buf = '' },
    } as unknown as NodeJS.WriteStream & { text: string; reset: () => void }
  }

  it('install sets a scroll region and paints status+mode at the bottom', () => {
    const out = fakeOut(40)
    const f = new Footer(() => base({ rows: 40 }), out)
    f.install()
    expect(out.text).toMatch(/\x1b\[1;\d+r/) // DECSTBM 设滚动区
    expect(out.text).toContain('shift+tab') // 模式行已画
    f.remove()
  })

  it('remove() clears only the footer rows (lastF), never reaches up into body text', () => {
    const out = fakeOut(40) // H=40; idle footer F=2(status+mode); maxFooterHeight=6 → pushed=6
    const f = new Footer(() => base({ rows: 40, columns: 80 }), out)
    f.install()
    out.reset()
    f.remove()
    // 正确:清页脚顶行 = H - lastF + 1 = 40 - 2 + 1 = 39。
    expect(out.text).toContain('\x1b[39;1H')
    expect(out.text).toContain('\x1b[r') // 复位滚动区
    // 回归保护:绝不按 pushed 清(H - pushed + 1 = 35),否则会擦掉正文最后几行。
    expect(out.text).not.toContain('\x1b[35;1H')
  })

  it('is idempotent across install/remove cycles (per-turn lifecycle)', () => {
    const out = fakeOut(40)
    const f = new Footer(() => base({ rows: 40 }), out)
    f.install(); f.remove(); f.remove() // 二次 remove 不应抛错/写额外清除
    expect(f.active).toBe(false)
    f.install()
    expect(f.active).toBe(true)
    f.remove()
  })
})

describe('ctxWindow', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('prefers FLOOM_CONTEXT_TOKENS, then FLOOM_CONTEXT_DISPLAY, then default (1M)', () => {
    delete process.env.FLOOM_CONTEXT_TOKENS
    delete process.env.FLOOM_CONTEXT_DISPLAY
    expect(ctxWindow()).toBe(1_000_000)
    process.env.FLOOM_CONTEXT_DISPLAY = '64000'
    expect(ctxWindow()).toBe(64_000)
    process.env.FLOOM_CONTEXT_TOKENS = '200000'
    expect(ctxWindow()).toBe(200_000)
  })
})
