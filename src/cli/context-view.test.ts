import { describe, it, expect } from 'vitest'
import { renderContextBreakdown, renderContextGrid, type ContextBreakdown } from './context-view.js'

const sample: ContextBreakdown = {
  system: 5000,
  messages: 12000,
  tools: 3000,
  mcp: 0,
  memory: 2000,
  skills: 800,
}

describe('renderContextBreakdown', () => {
  it('renders a title line with token counts', () => {
    const lines = renderContextBreakdown(sample, { columns: 80, window: 100000 })
    expect(lines.some(l => l.includes('Context Usage'))).toBe(true)
    // 总计 = 5000+12000+3000+0+2000+800 = 22800 → fmtTokens 四舍五入为 23k
    expect(lines.some(l => l.includes('23k'))).toBe(true)
  })

  it('renders category rows for non-zero entries', () => {
    const lines = renderContextBreakdown(sample, { columns: 80, window: 100000 })
    expect(lines.some(l => l.includes('System'))).toBe(true)
    expect(lines.some(l => l.includes('Messages'))).toBe(true)
    expect(lines.some(l => l.includes('Memory'))).toBe(true)
    // MCP 为 0，应跳过
    expect(lines.every(l => !l.includes('MCP'))).toBe(true)
  })

  it('adapts to narrow terminals', () => {
    const lines = renderContextBreakdown(sample, { columns: 40, window: 100000 })
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('renderContextGrid', () => {
  it('renders a single-line grid', () => {
    const grid = renderContextGrid(sample, 100000)
    expect(grid.length).toBeGreaterThan(0)
    expect(grid).toContain('⛁')
    expect(grid).toContain('⛀')
  })

  it('skips zero-token categories', () => {
    const grid = renderContextGrid(sample, 100000)
    expect(grid).not.toContain('⛝') // MCP = 0
  })

  it('shows fill level characters', () => {
    const grid = renderContextGrid({ system: 80000, messages: 0, tools: 0, mcp: 0, memory: 0, skills: 0 }, 100000)
    // 80% → █
    expect(grid).toContain('█')
  })
})
