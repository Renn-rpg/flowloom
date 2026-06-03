import { describe, it, expect } from 'vitest'
import { tokenizeLine, highlightLine, makeHlState } from './highlight.js'

// 注:测试环境非 TTY → useColor=false → highlightLine 返回与输入完全一致的字符串(无 ANSI)。
// 故对「上色」的断言改为针对 tokenizeLine 的 token 类型(与颜色无关、确定性强)。

function types(line: string, lang: string) {
  return tokenizeLine(line, lang, makeHlState()).map((t) => t.type)
}
function textOf(line: string, lang: string, type: string) {
  return tokenizeLine(line, lang, makeHlState())
    .filter((t) => t.type === type)
    .map((t) => t.text)
}

describe('tokenizeLine — invariant', () => {
  it('always reconstructs the original line exactly', () => {
    const samples = [
      'const x = 1 // comment',
      'def foo(): # hi',
      'a = "string with // not comment"',
      '/* block */ code()',
      'x ** 2 + y',
      'обычный текст 中文 emoji 🚀',
      '   ',
      '',
    ]
    for (const lang of ['ts', 'py', 'go', 'unknownlang', '']) {
      for (const s of samples) {
        const joined = tokenizeLine(s, lang, makeHlState()).map((t) => t.text).join('')
        expect(joined).toBe(s)
      }
    }
  })
})

describe('tokenizeLine — token classification', () => {
  it('classifies keywords, strings, numbers, comments in TS', () => {
    expect(textOf('const n = 42', 'ts', 'keyword')).toContain('const')
    expect(textOf('const n = 42', 'ts', 'number')).toContain('42')
    expect(textOf('let s = "hi"', 'ts', 'string')).toContain('"hi"')
    expect(textOf('x = 1 // tail', 'ts', 'comment')).toContain('// tail')
  })

  it('uses # comments for python/shell, not //', () => {
    expect(textOf('x = 1 # note', 'py', 'comment')).toContain('# note')
    // 在 JS 里 # 不是注释,不应被当注释
    expect(textOf('a # b', 'ts', 'comment')).toHaveLength(0)
  })

  it('treats // as plain text in python (no slash comments)', () => {
    expect(textOf('a // b', 'py', 'comment')).toHaveLength(0)
  })

  it('does not classify a digit that is part of an identifier as a number', () => {
    expect(textOf('let x2 = y', 'ts', 'number')).toHaveLength(0)
  })

  it('does not treat // inside a string as a comment', () => {
    const toks = tokenizeLine('const u = "http://x"', 'ts', makeHlState())
    expect(toks.some((t) => t.type === 'comment')).toBe(false)
    expect(toks.some((t) => t.type === 'string' && t.text === '"http://x"')).toBe(true)
  })

  it('classifies literals (true/false/null/None)', () => {
    expect(textOf('return true', 'ts', 'literal')).toContain('true')
    expect(textOf('x = None', 'py', 'literal')).toContain('None')
  })

  it('disables comments for json', () => {
    expect(textOf('"k": "v" // x', 'json', 'comment')).toHaveLength(0)
  })
})

describe('tokenizeLine — cross-line block comments', () => {
  it('tracks an unterminated /* across lines and closes on */', () => {
    const st = makeHlState()
    const l1 = tokenizeLine('code /* start', 'ts', st)
    expect(st.inBlock).toBe(true)
    expect(l1.some((t) => t.type === 'comment' && t.text === '/* start')).toBe(true)

    const l2 = tokenizeLine('still in comment', 'ts', st)
    expect(st.inBlock).toBe(true)
    expect(l2).toEqual([{ type: 'comment', text: 'still in comment' }])

    const l3 = tokenizeLine('end */ real()', 'ts', st)
    expect(st.inBlock).toBe(false)
    expect(l3[0]).toEqual({ type: 'comment', text: 'end */' })
  })

  it('does not start a block comment for hash-comment languages', () => {
    const st = makeHlState()
    tokenizeLine('a /* not a comment in py */ b', 'py', st)
    expect(st.inBlock).toBe(false)
  })
})

describe('highlightLine', () => {
  it('returns the input unchanged when colors are disabled (non-TTY test env)', () => {
    const st = makeHlState()
    expect(highlightLine('const x = "y" // z', 'ts', st)).toBe('const x = "y" // z')
  })
})
