import { describe, it, expect } from 'vitest'
import { renderInline, renderMarkdown, createMarkdownStream } from './markdown.js'

// 注:测试环境非 TTY → useColor=false → chalk 不输出 ANSI,断言聚焦「结构变换」(标记被去除/替换)。

describe('renderInline', () => {
  it('strips bold/italic markers', () => {
    expect(renderInline('a **b** c')).toBe('a b c')
    expect(renderInline('a *b* c')).toBe('a b c')
    expect(renderInline('a ***b*** c')).toBe('a b c')
    expect(renderInline('a __b__ c')).toBe('a b c')
  })

  it('strips inline code backticks but keeps content', () => {
    expect(renderInline('run `npm test` now')).toBe('run npm test now')
  })

  it('does not treat markers inside inline code as emphasis', () => {
    // `a*b*c` 内的 * 不应被当成斜体
    expect(renderInline('see `a*b*c` here')).toBe('see a*b*c here')
  })

  it('renders links as label (url)', () => {
    expect(renderInline('[docs](http://x.com)')).toBe('docs (http://x.com)')
  })

  it('does not italicize snake_case identifiers', () => {
    expect(renderInline('call my_func_name now')).toBe('call my_func_name now')
  })

  it('strips strikethrough', () => {
    expect(renderInline('~~gone~~ kept')).toBe('gone kept')
  })

  it('does not mangle a plain number with surrounding spaces', () => {
    expect(renderInline('I have 3 cats and `code`')).toBe('I have 3 cats and code')
  })
})

describe('renderMarkdown block-level', () => {
  it('strips heading hashes', () => {
    expect(renderMarkdown('# Title')).toBe('Title\n')
    expect(renderMarkdown('### Sub')).toBe('Sub\n')
  })

  it('renders unordered list with a bullet', () => {
    expect(renderMarkdown('- item')).toBe('• item\n')
    expect(renderMarkdown('* item')).toBe('• item\n')
  })

  it('keeps ordered list numbering', () => {
    expect(renderMarkdown('1. first')).toBe('1. first\n')
  })

  it('prefixes blockquotes', () => {
    expect(renderMarkdown('> quoted')).toBe('│ quoted\n')
  })

  it('does not parse emphasis inside fenced code blocks', () => {
    const out = renderMarkdown('```\n**not bold** and _not italic_\n```')
    expect(out).toContain('**not bold** and _not italic_')
  })

  it('applies a prefix to every emitted line', () => {
    expect(renderMarkdown('hello', '  ')).toBe('  hello\n')
  })

  it('collapses blank lines to a bare newline (no trailing prefix spaces)', () => {
    expect(renderMarkdown('a\n\nb', '  ')).toBe('  a\n\n  b\n')
  })
})

describe('createMarkdownStream buffering', () => {
  it('does not emit a line until a newline (or end) arrives', () => {
    const out: string[] = []
    const s = createMarkdownStream({ write: (x) => out.push(x) })
    s.push('partial line no newline yet')
    expect(out.join('')).toBe('') // 还没换行 → 不输出
    s.push(' more')
    expect(out.join('')).toBe('')
    s.end() // flush 残余
    expect(out.join('')).toBe('partial line no newline yet more\n')
  })

  it('emits complete lines as newlines arrive across deltas', () => {
    const out: string[] = []
    const s = createMarkdownStream({ write: (x) => out.push(x) })
    s.push('# Hea')
    s.push('ding\n- one\n- t')
    s.push('wo\n')
    expect(out.join('')).toBe('Heading\n• one\n• two\n')
  })
})
