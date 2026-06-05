import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { decodeKey, reduceKey, initialEditorState, ReplReader, type EditorState, type Key } from './repl-input.js'
import type { CompletionItem } from './completions.js'

describe('decodeKey', () => {
  it('maps control keys', () => {
    expect(decodeKey('\r')).toEqual({ t: 'enter' })
    expect(decodeKey('\n')).toEqual({ t: 'enter' })
    expect(decodeKey('\x7f')).toEqual({ t: 'backspace' })
    expect(decodeKey('\b')).toEqual({ t: 'backspace' })
    expect(decodeKey('\t')).toEqual({ t: 'tab' })
    expect(decodeKey('\x1b')).toEqual({ t: 'esc' })
    expect(decodeKey('\x03')).toEqual({ t: 'ctrl-c' })
    expect(decodeKey('\x04')).toEqual({ t: 'ctrl-d' })
    expect(decodeKey('\x0f')).toEqual({ t: 'ctrl-o' })
    expect(decodeKey('\x01')).toEqual({ t: 'home' }) // ctrl-a
    expect(decodeKey('\x05')).toEqual({ t: 'ctrl-e' })
  })
  it('maps arrows and nav (CSI and SS3 forms)', () => {
    expect(decodeKey('\x1b[A')).toEqual({ t: 'up' })
    expect(decodeKey('\x1bOA')).toEqual({ t: 'up' })
    expect(decodeKey('\x1b[B')).toEqual({ t: 'down' })
    expect(decodeKey('\x1b[C')).toEqual({ t: 'right' })
    expect(decodeKey('\x1b[D')).toEqual({ t: 'left' })
    expect(decodeKey('\x1b[H')).toEqual({ t: 'home' })
    expect(decodeKey('\x1b[F')).toEqual({ t: 'end' })
    expect(decodeKey('\x1b[3~')).toEqual({ t: 'delete' })
  })
  it('maps Shift+Tab (CSI Z) to shift-tab', () => {
    expect(decodeKey('\x1b[Z')).toEqual({ t: 'shift-tab' })
  })
  it('maps printable chars and pastes', () => {
    expect(decodeKey('a')).toEqual({ t: 'char', ch: 'a' })
    expect(decodeKey('hello')).toEqual({ t: 'char', ch: 'hello' })
  })
  it('treats unrecognized escape sequences as unknown', () => {
    expect(decodeKey('\x1b[99~')).toEqual({ t: 'unknown' })
  })
  it('maps lone ESC as esc (IO shell handles split-ESC buffering)', () => {
    expect(decodeKey('\x1b')).toEqual({ t: 'esc' })
  })
  it('maps control chars embedded in a paste: TAB→tab, CR/LF→enter, others→unknown', () => {
    // These are what decodeKey returns per byte. The IO shell (onData) now strips
    // control chars from multi-char pastes before dispatching, so these only trigger
    // when typed interactively as single keystrokes.
    expect(decodeKey('\t')).toEqual({ t: 'tab' })
    expect(decodeKey('\r')).toEqual({ t: 'enter' })
    expect(decodeKey('\n')).toEqual({ t: 'enter' })
    expect(decodeKey('\x02')).toEqual({ t: 'unknown' })
    expect(decodeKey('\x0c')).toEqual({ t: 'unknown' })
  })
  it('rejects the UTF-8 replacement char U+FFFD as unknown (not printable)', () => {
    // With StringDecoder, a split multi-byte sequence never produces U+FFFD.
    // But if it did arrive (e.g. from a non-UTF8 source), we prevent it from
    // being inserted as a visible char.
    expect(decodeKey('�')).toEqual({ t: 'unknown' })
  })
})

const items = (...vals: string[]): CompletionItem[] =>
  vals.map((v) => ({ label: v, desc: '', replacement: v }))

function st(partial: Partial<EditorState> = {}): EditorState {
  return { ...initialEditorState(), ...partial }
}

const reduce = (s: EditorState, key: Key, it: CompletionItem[] = []) => reduceKey(s, key, it)

describe('reduceKey: shift-tab', () => {
  it('emits a cycle-mode action and leaves the buffer untouched', () => {
    const r = reduce(st({ buffer: 'half typed', cursor: 4 }), { t: 'shift-tab' })
    expect(r.action).toBe('cycle-mode')
    expect(r.state.buffer).toBe('half typed')
    expect(r.state.cursor).toBe(4)
  })
})

describe('reduceKey: editing', () => {
  it('inserts a char at the cursor and advances', () => {
    const r = reduce(st({ buffer: 'ac', cursor: 1 }), { t: 'char', ch: 'b' })
    expect(r.action).toBe('redraw')
    expect(r.state.buffer).toBe('abc')
    expect(r.state.cursor).toBe(2)
  })
  it('inserts a multi-char paste at once', () => {
    const r = reduce(st(), { t: 'char', ch: 'fix bug' })
    expect(r.state.buffer).toBe('fix bug')
    expect(r.state.cursor).toBe(7)
  })
  it('backspace removes the char before the cursor', () => {
    const r = reduce(st({ buffer: 'abc', cursor: 2 }), { t: 'backspace' })
    expect(r.state.buffer).toBe('ac')
    expect(r.state.cursor).toBe(1)
  })
  it('backspace at column 0 is a no-op', () => {
    expect(reduce(st({ buffer: 'abc', cursor: 0 }), { t: 'backspace' }).action).toBe('none')
  })
  it('delete removes the char at the cursor', () => {
    const r = reduce(st({ buffer: 'abc', cursor: 1 }), { t: 'delete' })
    expect(r.state.buffer).toBe('ac')
    expect(r.state.cursor).toBe(1)
  })
  it('left/right/home/end move the cursor within bounds', () => {
    expect(reduce(st({ buffer: 'abc', cursor: 2 }), { t: 'left' }).state.cursor).toBe(1)
    expect(reduce(st({ buffer: 'abc', cursor: 0 }), { t: 'left' }).action).toBe('none')
    expect(reduce(st({ buffer: 'abc', cursor: 1 }), { t: 'right' }).state.cursor).toBe(2)
    expect(reduce(st({ buffer: 'abc', cursor: 3 }), { t: 'right' }).action).toBe('none')
    expect(reduce(st({ buffer: 'abc', cursor: 2 }), { t: 'home' }).state.cursor).toBe(0)
    expect(reduce(st({ buffer: 'abc', cursor: 1 }), { t: 'end' }).state.cursor).toBe(3)
  })
  it('editing clears the dismissed flag (menu can reopen)', () => {
    const r = reduce(st({ buffer: '/cl', cursor: 3, dismissed: true }), { t: 'char', ch: 'e' })
    expect(r.state.dismissed).toBe(false)
  })
})

describe('reduceKey: menu navigation', () => {
  it('up/down move the highlight when the menu is open', () => {
    const it = items('/a', '/b', '/c')
    expect(reduce(st({ buffer: '/' }), { t: 'down' }, it).state.menuIndex).toBe(1)
    expect(reduce(st({ buffer: '/', menuIndex: 0 }), { t: 'up' }, it).state.menuIndex).toBe(2) // wrap
  })
  it('up/down do nothing when there is no menu', () => {
    expect(reduce(st({ buffer: 'hi' }), { t: 'down' }, []).action).toBe('none')
  })
  it('up/down do nothing when the menu was dismissed', () => {
    const it = items('/a', '/b')
    expect(reduce(st({ buffer: '/', dismissed: true }), { t: 'down' }, it).action).toBe('none')
  })
})

describe('reduceKey: accept & submit', () => {
  it('Tab completes the highlighted item without submitting', () => {
    const it = items('/clear')
    const r = reduce(st({ buffer: '/cl', cursor: 3 }), { t: 'tab' }, it)
    expect(r.action).toBe('redraw')
    expect(r.state.buffer).toBe('/clear')
    expect(r.state.cursor).toBe(6)
  })
  it('Enter completes (not submit) when buffer differs from the highlighted item', () => {
    const it = items('/clear')
    const r = reduce(st({ buffer: '/cl', cursor: 3 }), { t: 'enter' }, it)
    expect(r.action).toBe('redraw')
    expect(r.state.buffer).toBe('/clear')
  })
  it('Enter submits when buffer already equals the highlighted item', () => {
    const it = items('/clear')
    expect(reduce(st({ buffer: '/clear', cursor: 6 }), { t: 'enter' }, it).action).toBe('submit')
  })
  it('Enter submits a plain prompt with no menu', () => {
    expect(reduce(st({ buffer: 'fix the bug', cursor: 11 }), { t: 'enter' }, []).action).toBe('submit')
  })
  it('Enter submits when the menu was dismissed', () => {
    const it = items('/clear')
    expect(reduce(st({ buffer: '/cl', dismissed: true }), { t: 'enter' }, it).action).toBe('submit')
  })
})

describe('reduceKey: control actions', () => {
  it('Esc dismisses an open menu', () => {
    const it = items('/a', '/b')
    const r = reduce(st({ buffer: '/' }), { t: 'esc' }, it)
    expect(r.action).toBe('redraw')
    expect(r.state.dismissed).toBe(true)
  })
  it('Esc with no menu does nothing', () => {
    expect(reduce(st({ buffer: 'hi' }), { t: 'esc' }, []).action).toBe('none')
  })
  it('Ctrl-C exits on an empty line, clears a non-empty line otherwise', () => {
    expect(reduce(st({ buffer: '' }), { t: 'ctrl-c' }).action).toBe('cancel')
    const r = reduce(st({ buffer: 'half typed', cursor: 10 }), { t: 'ctrl-c' })
    expect(r.action).toBe('redraw')
    expect(r.state.buffer).toBe('')
    expect(r.state.cursor).toBe(0)
  })
  it('Ctrl-D exits only on an empty line', () => {
    expect(reduce(st({ buffer: '' }), { t: 'ctrl-d' }).action).toBe('cancel')
    expect(reduce(st({ buffer: 'x' }), { t: 'ctrl-d' }).action).toBe('none')
  })
  it('Ctrl-O requests a verbose toggle without changing the buffer', () => {
    const s = st({ buffer: 'keep me', cursor: 4 })
    const r = reduce(s, { t: 'ctrl-o' })
    expect(r.action).toBe('expand-one')
    expect(r.state.buffer).toBe('keep me')
    expect(r.state.cursor).toBe(4)
  })
})

describe('ReplReader (IO shell)', () => {
  function fakeTTY() {
    const s = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough
    ;(s as unknown as { isTTY: boolean }).isTTY = true
    ;(s as unknown as { isRaw: boolean }).isRaw = false
    ;(s as unknown as { setRawMode: (v: boolean) => unknown }).setRawMode = (v: boolean) => {
      ;(s as unknown as { isRaw: boolean }).isRaw = v
      return s
    }
    return s
  }
  function sink() {
    let buf = ''
    return { columns: 80, write: (x: string) => { buf += x; return true }, get text() { return buf } }
  }
  const tick = () => new Promise((r) => setImmediate(r))

  it('renders a dynamic (function) promptText and resolves the typed line', async () => {
    const input = fakeTTY()
    const out = sink()
    let mode = 'plan'
    const reader = new ReplReader({
      input: input as unknown as NodeJS.ReadStream,
      out: out as unknown as NodeJS.WriteStream,
      promptText: () => (mode === 'plan' ? 'floom(plan)> ' : 'floom> '),
      colorPrompt: (s) => s,
    })
    const p = reader.question()
    await tick()
    for (const c of ['h', 'i', '\r']) { input.write(c); await tick() }
    expect(await p).toBe('hi')
    expect(out.text).toContain('floom(plan)> ')

    mode = 'normal' // 函数每次 question() 求值 → 切换后用新文案
    const p2 = reader.question()
    await tick()
    for (const c of ['o', 'k', '\r']) { input.write(c); await tick() }
    expect(await p2).toBe('ok')
    expect(out.text).toContain('floom> ')
  })

  it('renders panelLines below the input box and re-evaluates them every frame', async () => {
    const input = fakeTTY()
    const out = sink()
    let mode = 'normal'
    const reader = new ReplReader({
      input: input as unknown as NodeJS.ReadStream,
      out: out as unknown as NodeJS.WriteStream,
      promptText: '❯ ',
      colorPrompt: (s) => s,
      // 模拟 cli 的状态行+模式行：每帧重新求值（Shift+Tab 切模式须立刻反映）。
      panelLines: () => ['STATUS deepseek', `MODE:${mode}`],
    })
    const p = reader.question()
    await tick()
    input.write('a') // 触发一次 render
    await tick()
    expect(out.text).toContain('STATUS deepseek')
    expect(out.text).toContain('MODE:normal')

    mode = 'plan' // 模拟 Shift+Tab 切换
    input.write('b') // 触发重绘 → 面板行应反映新模式
    await tick()
    expect(out.text).toContain('MODE:plan')

    input.write('\r')
    expect(await p).toBe('ab')
  })
})
