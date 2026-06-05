// 可折叠区块系统：在终端输出中插入可折叠的内容块，支持 Ctrl+O 逐个展开、Ctrl+E 全部展开。
// BlockManager 负责状态追踪，提供 ANSI 原位回溯展开所需的行数计算。
import { physicalRows, type MsgType } from './format.js'

export type BlockType =
  | 'thinking'      // 思考计时
  | 'reasoning'     // 模型思考链 (CoT)
  | 'tool-call'     // 工具调用
  | 'tool-output'   // 工具结果输出 (stdout / 搜索结果 / diff)
  | 'summary'       // turn 汇总行

export interface Block {
  readonly id: string
  readonly type: BlockType
  state: 'collapsed' | 'expanded'
  summaryLine: string             // 折叠时显示的单行摘要
  previewLines: string[]          // 折叠时预览的前几行（可为空）
  contentLines: string[]          // 完整展开内容
  messageType?: MsgType           // 可选消息类型（verbose 模式标签）
}

export class BlockManager {
  private blocks: Block[] = []
  private nextId = 1

  get all(): readonly Block[] { return this.blocks }

  addBlock(type: BlockType, summary: string, content?: string[]): Block {
    const block: Block = {
      id: `b${this.nextId++}`,
      type,
      state: 'collapsed',
      summaryLine: summary,
      previewLines: [],
      contentLines: content ?? [],
    }
    this.blocks.push(block)
    return block
  }

  appendContent(id: string, lines: string[]): void {
    const b = this.blocks.find(b => b.id === id)
    if (b) b.contentLines.push(...lines)
  }

  setPreview(id: string, lines: string[]): void {
    const b = this.blocks.find(b => b.id === id)
    if (b) b.previewLines = lines
  }

  finalizeBlock(id: string): void {
    const b = this.blocks.find(b => b.id === id)
    if (b && b.contentLines.length === 0) {
      // 无额外内容时不需要折叠（如简单的只读操作）
      b.state = 'expanded'
    }
  }

  // 从底部向上找第一个折叠的块，返回它的 id。
  // 用于 Ctrl+O 逐层展开。
  expandOne(): string | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].state === 'collapsed') {
        this.blocks[i].state = 'expanded'
        return this.blocks[i].id
      }
    }
    return null
  }

  expandAll(): string[] {
    const ids: string[] = []
    for (const b of this.blocks) {
      if (b.state === 'collapsed') {
        b.state = 'expanded'
        ids.push(b.id)
      }
    }
    return ids
  }

  // 所有可折叠的块中第一个折叠块的下标，没有则返回 -1。
  // 用于计算原位展开时需要上移的行数。
  firstCollapsedIndex(): number {
    return this.blocks.findIndex(b => b.state === 'collapsed')
  }

  // 返回从光标位置上移到第 fromIndex 个块开头所需的 ANSI 上移行数（= 物理行数）。
  // fromIndex 之后的块（包含 fromIndex）都需要被重绘。传入终端列宽以正确计入折行
  // （窄终端 / CJK 路径会让单条逻辑行占多物理行）；columns 省略(0)则按不折行算，保持旧行为。
  cursorDelta(fromIndex: number, columns = 0): number {
    let lines = 0
    for (let i = fromIndex; i < this.blocks.length; i++) {
      lines += this.visibleLines(i, columns)
    }
    return lines
  }

  // 单块占用的物理行数（计入折行）。
  private visibleLines(index: number, columns = 0): number {
    const b = this.blocks[index]
    if (!b) return 0
    const rows = (line: string) => physicalRows(line, columns)
    if (b.state === 'expanded') {
      // summaryLine + 完整内容
      return rows(b.summaryLine) + b.contentLines.reduce((n, l) => n + rows(l), 0)
    }
    // summaryLine + 预览行 + (有内容时)折叠提示行 "… +N lines"（提示行短，恒占 1 行）
    let n = rows(b.summaryLine) + b.previewLines.reduce((s, l) => s + rows(l), 0)
    if (b.contentLines.length > 0) n += 1
    return n
  }

  // 渲染从 fromIndex 开始的所有块为输出行数组
  renderFrom(fromIndex: number, useExpanded: boolean): string[] {
    const out: string[] = []
    for (let i = fromIndex; i < this.blocks.length; i++) {
      const b = this.blocks[i]
      const expanded = b.state === 'expanded' || (useExpanded && i >= fromIndex)
      out.push(b.summaryLine)
      if (expanded && b.contentLines.length > 0) {
        out.push(...b.contentLines)
      } else if (b.contentLines.length > 0) {
        // 折叠状态：显示预览 + 折叠提示
        out.push(...b.previewLines)
        const hidden = b.contentLines.length - b.previewLines.length
        if (hidden > 0) {
          const hintKey = 'ctrl+o' // 实际键名由调用方传递；默认保持向后兼容
          out.push(`  … +${hidden} lines (${hintKey} to expand)`)
        }
      }
    }
    return out
  }

  // 渲染全部块（当前状态）
  renderAll(): string[] {
    return this.renderFrom(0, false)
  }

  clear(): void {
    this.blocks = []
  }
}
