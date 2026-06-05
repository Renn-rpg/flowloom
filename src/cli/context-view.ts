// 上下文使用可视化（对标 free-code 的 ContextVisualization 组件）。
//
// 提供两个层次的渲染：
//   1. 紧凑进度条（已存在于 footer.ts 的 composeStatusLine）
//   2. 可展开的分类分解视图（/ctx 命令或 Ctrl+T 快捷键触发）
//
// 分类设计（与 free-code 对齐的精简集）：
//   system / messages / tools / MCP / memory / skills

import { color, type ThemeToken } from './theme.js'
import { fmtTokens } from './format.js'

export interface ContextBreakdown {
  /** 系统提示词 token 估算 */
  system: number
  /** 对话消息 token 估算 */
  messages: number
  /** 工具定义 token 估算 */
  tools: number
  /** MCP 服务器 token 估算 */
  mcp: number
  /** memory 文件 token 估算 */
  memory: number
  /** skills token 估算 */
  skills: number
}

export interface ContextViewOptions {
  /** 终端列数 */
  columns: number
  /** 上下文窗口总容量 */
  window: number
}

// 分类定义（用于图例和颜色）
interface Category {
  key: keyof ContextBreakdown
  label: string
  colorToken: ThemeToken
  symbol: string
}

const CATEGORIES: Category[] = [
  { key: 'system',   label: 'System',    colorToken: 'blue',   symbol: '⛁' },
  { key: 'messages', label: 'Messages',  colorToken: 'green',  symbol: '⛀' },
  { key: 'tools',    label: 'Tools',     colorToken: 'yellow', symbol: '⛶' },
  { key: 'mcp',      label: 'MCP',       colorToken: 'cyan',   symbol: '⛝' },
  { key: 'memory',   label: 'Memory',    colorToken: 'magenta',symbol: '⛃' },
  { key: 'skills',   label: 'Skills',    colorToken: 'cyan',   symbol: '⛟' },
]

// 渲染分类分解视图（/ctx 命令输出）。
export function renderContextBreakdown(
  breakdown: ContextBreakdown,
  opts: ContextViewOptions,
): string[] {
  const border = color('dialog-border')
  const W = Math.max(30, Math.min(60, opts.columns - 4))
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
  const lines: string[] = []

  // 标题
  lines.push('')
  lines.push(color('bold')(`  Context Usage: ${fmtTokens(total)} / ${fmtTokens(opts.window)}`))
  lines.push(color('dim')(`  ${'─'.repeat(W)}`))

  // 分类行
  for (const cat of CATEGORIES) {
    const tokens = breakdown[cat.key]
    if (tokens === 0) continue
    const pct = opts.window > 0 ? Math.round((tokens / opts.window) * 100) : 0
    const barW = Math.max(1, Math.round((tokens / Math.max(1, total)) * 20))
    const bar = color(cat.colorToken)('█'.repeat(barW)) + color('dim')('░'.repeat(20 - barW))
    const label = color(cat.colorToken)(cat.symbol + ' ' + cat.label.padEnd(8))
    const tokStr = color('dim')(`${fmtTokens(tokens)}`.padStart(6))
    const pctStr = color('dim')(`${pct}%`.padStart(4))
    lines.push(`  ${label} ${bar} ${tokStr} ${pctStr}`)
  }

  // 图例
  lines.push(color('dim')(`  ${'─'.repeat(W)}`))
  lines.push(color('dim')('  /ctx to refresh  ·  shift+tab to cycle mode'))

  lines.push('')
  return lines
}

// 紧凑网格视图（单行，适合嵌入 footer 或简短输出）。
export function renderContextGrid(
  breakdown: ContextBreakdown,
  window: number,
): string {
  const parts: string[] = []
  for (const cat of CATEGORIES) {
    const tokens = breakdown[cat.key]
    if (tokens === 0) continue
    const pct = window > 0 ? Math.min(100, Math.round((tokens / window) * 100)) : 0
    // 用 Unicode 块元素表示填充级别：0%→░, 1-25%→▁, 26-50%→▃, 51-75%→▅, 76-100%→█
    const fill = pct === 0 ? '░' : pct <= 25 ? '▁' : pct <= 50 ? '▃' : pct <= 75 ? '▅' : '█'
    parts.push(color(cat.colorToken)(cat.symbol + fill))
  }
  return parts.join(' ')
}
