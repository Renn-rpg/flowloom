// 轻量 Markdown → ANSI 终端渲染器。
// 支持代码块、内联代码、粗体、标题、列表。流式兼容：缓冲未闭合的代码块。

import { fmt } from './format.js'

// 渲染状态：跟踪代码块是否开启（跨 chunk 流式渲染用）
export interface MdState {
  inCodeBlock: boolean
  codeLang: string
}

export function createMdState(): MdState {
  return { inCodeBlock: false, codeLang: '' }
}

// 核心渲染：将 markdown 文本转换为 ANSI 终端字符串。
// 流式模式（isStreaming=true）下，未闭合的代码块不会关闭。
export function renderMarkdown(text: string, state?: MdState, isStreaming = false): string {
  const st = state ?? createMdState()
  const lines = text.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 代码块边界
    if (line.trimStart().startsWith('```')) {
      if (st.inCodeBlock) {
        // 关闭代码块
        st.inCodeBlock = false
        st.codeLang = ''
        out.push(fmt.dim('  ──')) // 代码块结束标记
      } else {
        st.inCodeBlock = true
        st.codeLang = line.trimStart().slice(3).trim()
        out.push(fmt.dim(`  ── ${st.codeLang || 'code'} ──`)) // 代码块开始标记
      }
      continue
    }

    if (st.inCodeBlock) {
      // 代码块内：暗色渲染
      out.push(fmt.dim('  │ ' + line))
      continue
    }

    // 标题
    if (/^#{1,6}\s/.test(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)/)
      if (m) {
        out.push(fmt.bold('  ' + m[2]))
        continue
      }
    }

    // 列表项
    if (/^\s*[-*]\s/.test(line)) {
      const content = line.replace(/^\s*[-*]\s/, '')
      out.push('  • ' + renderInline(content))
      continue
    }
    // 数字列表
    if (/^\s*\d+\.\s/.test(line)) {
      const m = line.match(/^(\s*\d+\.)\s(.*)/)
      if (m) {
        out.push('  ' + fmt.dim(m[1]) + ' ' + renderInline(m[2]))
        continue
      }
    }

    // 水平线
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push(fmt.dim('  ─────────────────'))
      continue
    }

    // 普通段落
    out.push('  ' + renderInline(line))
  }

  // 流式模式下不自动关闭代码块（等下一 chunk 闭合）
  if (!isStreaming && st.inCodeBlock) {
    st.inCodeBlock = false
    out.push(fmt.dim('  ──'))
  }

  return out.join('\n')
}

// 内联渲染：粗体、内联代码、斜体
function renderInline(text: string): string {
  // 粗体 **text**
  text = text.replace(/\*\*(.+?)\*\*/g, (_, c) => fmt.bold(c))
  // 内联代码 `text`（可能含单词边界）
  text = text.replace(/`([^`]+)`/g, (_, c) => fmt.dim(c))
  // 斜体 *text*（不冲突列表项，前面已有缩进）
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, c) => fmt.dim(c))
  return text
}
