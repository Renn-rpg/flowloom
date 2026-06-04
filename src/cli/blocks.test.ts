import { describe, it, expect } from 'vitest'
import { BlockManager } from './blocks.js'

describe('BlockManager.cursorDelta — physical rows', () => {
  it('counts one row per logical line when columns is omitted (legacy behavior)', () => {
    const bm = new BlockManager()
    bm.addBlock('tool-output', 'summary', ['a', 'b', 'c'])
    // 折叠态:summary(1) + preview(0) + 折叠提示(1) = 2
    expect(bm.cursorDelta(0)).toBe(2)
    // 展开态:summary(1) + 3 行内容 = 4
    bm.expandAll()
    expect(bm.cursorDelta(0)).toBe(4)
  })

  it('counts wrapped physical rows when a column width is given', () => {
    const bm = new BlockManager()
    // 摘要 60 列宽,内容一行 100 列宽
    bm.addBlock('tool-output', 'x'.repeat(60), ['y'.repeat(100)])
    bm.expandAll()
    // columns=40: summary ceil(60/40)=2, content ceil(100/40)=3 → 5
    expect(bm.cursorDelta(0, 40)).toBe(5)
    // 宽终端 columns=200: 各 1 行 → 2
    expect(bm.cursorDelta(0, 200)).toBe(2)
  })

  it('accounts for CJK width-2 when wrapping', () => {
    const bm = new BlockManager()
    bm.addBlock('tool-output', '文'.repeat(30), []) // 60 列;无内容 → 无折叠提示
    // 折叠态无 content:只有 summary。columns=40 → ceil(60/40)=2
    expect(bm.cursorDelta(0, 40)).toBe(2)
    expect(bm.cursorDelta(0, 80)).toBe(1)
  })

  it('sums across multiple blocks from the given index', () => {
    const bm = new BlockManager()
    bm.addBlock('tool-call', 'first')               // summary only, no content → 1
    bm.addBlock('tool-call', 'second')              // 1
    bm.addBlock('tool-output', 'third', ['line'])   // collapsed: summary(1)+提示(1)=2
    expect(bm.cursorDelta(0)).toBe(1 + 1 + 2)
    expect(bm.cursorDelta(1)).toBe(1 + 2)
  })
})
