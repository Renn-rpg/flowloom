// Agent 树形可视化（对标 free-code 的 AgentProgressLine 组件）。
//
// 使用 Unicode 制表符绘制 agent 层级树（├──/└──），配合彩色状态徽章、
// 工具计数、token 用量。纯渲染函数，无副作用。
//
// 用法：
//   import { renderAgentTree } from './agent-tree.js'
//   const lines = renderAgentTree(agents, { showBadges: true, maxWidth: 80 })

import { color } from './theme.js'
import { fmtDuration, fmtTokens, visualWidth, stripAnsi } from './format.js'

export type AgentStatus = 'done' | 'running' | 'error' | 'queued'

export interface AgentTreeNode {
  id: string
  label: string
  status: AgentStatus
  /** 工具调用次数（可选） */
  toolCount?: number
  /** token 用量（可选） */
  tokens?: number
  /** 已耗时 ms（可选） */
  elapsedMs?: number
  /** 子 agent（嵌套层级） */
  children?: AgentTreeNode[]
}

export interface AgentTreeOptions {
  /** 是否显示状态徽章 */
  showBadges?: boolean
  /** 是否显示工具计数 */
  showToolCounts?: boolean
  /** 是否显示 token 用量 */
  showTokens?: boolean
  /** 最大宽度（超出截断） */
  maxWidth?: number
  /** 缩进宽度（空格数） */
  indent?: number
}

function statusBadge(status: AgentStatus): string {
  switch (status) {
    case 'done':    return color('agent-badge-done')(' DONE ')
    case 'running': return color('agent-badge-running')(' RUN ')
    case 'error':   return color('agent-badge-error')(' FAIL ')
    case 'queued':  return color('agent-badge-queued')(' WAIT ')
  }
}

// 递归渲染树节点。
function renderNode(
  node: AgentTreeNode,
  opts: Required<AgentTreeOptions>,
  prefix: string,
  isLast: boolean,
  out: string[],
): void {
  const connector = isLast ? '└── ' : '├── '
  const line = buildLine(node, opts, prefix + connector)
  out.push(line)

  const childPrefix = prefix + (isLast ? '    ' : '│   ')
  if (node.children && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      renderNode(node.children[i], opts, childPrefix, i === node.children.length - 1, out)
    }
  }
}

function buildLine(node: AgentTreeNode, opts: Required<AgentTreeOptions>, prefix: string): string {
  let line = prefix

  if (opts.showBadges) {
    line += statusBadge(node.status) + ' '
  }

  line += color('bold')(node.label)

  const extras: string[] = []
  if (opts.showToolCounts && node.toolCount !== undefined) {
    extras.push(color('dim')(`${node.toolCount} tools`))
  }
  if (opts.showTokens && node.tokens !== undefined) {
    extras.push(color('dim')(fmtTokens(node.tokens)))
  }
  if (node.elapsedMs !== undefined) {
    extras.push(color('dim')(fmtDuration(node.elapsedMs)))
  }

  if (extras.length > 0) {
    line += '  ' + extras.join(color('dim')(' · '))
  }

  // 截断到最大宽度（按视觉宽度，保护 ANSI 序列不被切碎）
  if (opts.maxWidth > 0) {
    const plain = stripAnsi(line)
    if (visualWidth(plain) > opts.maxWidth) {
      // 逐字符安全截断（跳过 ANSI 序列，按视觉宽度计数）
      let out = ''
      let w = 0
      let inAnsi = false
      for (const ch of line) {
        if (ch === '\x1b') inAnsi = true
        if (inAnsi) {
          out += ch
          if (/[a-zA-Z]/.test(ch)) inAnsi = false // SGR 以 m 结尾，所有 ANSI 序列以字母结尾
          continue
        }
        const cw = visualWidth(ch)
        if (w + cw > opts.maxWidth - 1) break
        out += ch
        w += cw
      }
      line = out + '\x1b[0m…'
    }
  }

  return line
}

// 默认选项。
const DEFAULTS: Required<AgentTreeOptions> = {
  showBadges: true,
  showToolCounts: true,
  showTokens: true,
  maxWidth: 0,  // 0 = 不截断
  indent: 0,
}

// 把 agent 树渲染为 ANSI 字符串行数组。
export function renderAgentTree(
  nodes: AgentTreeNode[],
  opts?: AgentTreeOptions,
): string[] {
  const o = { ...DEFAULTS, ...(opts ?? {}) }
  const out: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    renderNode(nodes[i], o, '', i === nodes.length - 1, out)
  }
  return out
}
