import { describe, it, expect } from 'vitest'
import { encodeMessage, LineDecoder } from './protocol.js'

describe('encodeMessage', () => {
  it('appends a single newline and contains no embedded real newline', () => {
    const s = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x', params: { a: 'line1\nline2' } })
    expect(s.endsWith('\n')).toBe(true)
    expect(s.slice(0, -1).includes('\n')).toBe(false) // 内嵌换行被转义为 \\n，无真换行
    expect(JSON.parse(s)).toMatchObject({ method: 'x', params: { a: 'line1\nline2' } })
  })
})

describe('LineDecoder', () => {
  it('parses multiple messages in one chunk', () => {
    const d = new LineDecoder()
    const msgs = d.push('{"id":1}\n{"id":2}\n')
    expect(msgs).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('buffers a message split across chunks', () => {
    const d = new LineDecoder()
    expect(d.push('{"id":')).toEqual([])
    expect(d.push('3}\n')).toEqual([{ id: 3 }])
  })

  it('skips blank lines and non-JSON lines (stray server logs)', () => {
    const d = new LineDecoder()
    const msgs = d.push('\nnot json here\n{"ok":true}\n')
    expect(msgs).toEqual([{ ok: true }])
  })

  it('holds an incomplete trailing line until its newline arrives', () => {
    const d = new LineDecoder()
    expect(d.push('{"a":1}\n{"b":2')).toEqual([{ a: 1 }])
    expect(d.push('}\n')).toEqual([{ b: 2 }])
  })
})
