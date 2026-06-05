import { describe, it, expect } from 'vitest'
import { renderAgentTree, type AgentTreeNode } from './agent-tree.js'
import { visualWidth, stripAnsi } from './format.js'

describe('renderAgentTree', () => {
  it('renders a single node', () => {
    const nodes: AgentTreeNode[] = [{ id: '1', label: 'test-agent', status: 'running' }]
    const lines = renderAgentTree(nodes, { showBadges: false, showToolCounts: false, showTokens: false })
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('test-agent')
  })

  it('renders tree structure with children', () => {
    const nodes: AgentTreeNode[] = [{
      id: '1', label: 'root', status: 'done',
      children: [
        { id: '2', label: 'child1', status: 'done' },
        { id: '3', label: 'child2', status: 'running' },
      ],
    }]
    const lines = renderAgentTree(nodes, { showBadges: false, showToolCounts: false, showTokens: false })
    expect(lines.length).toBe(3)
    expect(lines[0]).toContain('root')
    expect(lines[1]).toContain('child1')
    expect(lines[1]).toContain('├──')
    expect(lines[2]).toContain('child2')
    expect(lines[2]).toContain('└──')
  })

  it('renders badges when enabled', () => {
    const nodes: AgentTreeNode[] = [{ id: '1', label: 'agent', status: 'done' }]
    const lines = renderAgentTree(nodes, { showBadges: true, showToolCounts: false, showTokens: false })
    expect(lines[0]).toContain('DONE')
  })

  it('renders tool counts and tokens', () => {
    const nodes: AgentTreeNode[] = [{ id: '1', label: 'agent', status: 'done', toolCount: 5, tokens: 1200 }]
    const lines = renderAgentTree(nodes, { showBadges: false })
    expect(lines[0]).toContain('5 tools')
    expect(lines[0]).toContain('1.2k')
  })

  it('truncates at maxWidth (visual width, ignoring ANSI)', () => {
    const nodes: AgentTreeNode[] = [{ id: '1', label: 'a-very-long-agent-name-that-should-be-truncated', status: 'done' }]
    const lines = renderAgentTree(nodes, { showBadges: false, showToolCounts: false, showTokens: false, maxWidth: 30 })
    // 视觉宽度（去除 ANSI 后）应 ≤ maxWidth
    expect(visualWidth(stripAnsi(lines[0]))).toBeLessThanOrEqual(30)
    // 截断标记应在末尾
    expect(lines[0]).toMatch(/…$/)
  })

  it('shows elapsed time', () => {
    const nodes: AgentTreeNode[] = [{ id: '1', label: 'agent', status: 'running', elapsedMs: 65000 }]
    const lines = renderAgentTree(nodes, { showBadges: false, showToolCounts: false, showTokens: false })
    expect(lines[0]).toContain('1m5s')
  })
})
