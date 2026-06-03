// 终端 Markdown 渲染器（流式）。
//
// 设计：**行缓冲**。增量文本攒到出现 `\n` 才渲染整行——块级结构（标题/列表/引用/代码围栏/
// 分隔线）天然是行向的，这样最稳；行内强调（粗体/斜体/行内 code/链接/删除线）在整行落定时解析。
// 代价是「当前未完成的行」要等换行才显示（逐行而非逐字），这是终端 Markdown 流式的通行取舍。
//
// 颜色开关与 format.ts 一致（NO_COLOR / TERM=dumb / 非 TTY 时退化为纯结构变换，不输出 ANSI）。
// 代码块样式集中在 `codeBlock`，P0-2 语法高亮可直接替换它，无需改其它逻辑。
import chalk from 'chalk'
import { highlightLine, makeHlState, type HlState } from './highlight.js'

const useColor = !process.env.NO_COLOR && process.env.TERM !== 'dumb' && !!process.stderr.isTTY
const paint = (fn: (s: string) => string) => (s: string) => (useColor ? fn(s) : s)

const C = {
  bold: paint(chalk.bold),
  italic: paint(chalk.italic),
  boldItalic: paint(chalk.bold.italic),
  dim: paint(chalk.dim),
  code: paint(chalk.yellow), // 行内 code
  heading: paint(chalk.bold.cyan),
  link: paint(chalk.cyan.underline),
  strike: paint(chalk.strikethrough),
  quote: paint(chalk.dim),
  bullet: paint(chalk.cyan),
}

// 占位符前后哨兵：用 NUL 包裹序号保护行内 code（模型几乎不会输出 NUL，不会与正文「空格+数字」误撞）。
// 用 fromCharCode 而非字面量,避免源码里出现 NUL 字节被 git/grep 当成二进制文件。
const NUL = String.fromCharCode(0)
const restoreRe = new RegExp(NUL + '(\\d+)' + NUL, 'g')

// 行内强调渲染。先抽出行内 code 用占位符保护（避免其中的 * _ ~ 被当成强调），最后还原。
// chalk 产生的 ANSI 序列里不含 markdown 标记字符，故按优先级多次 replace 不会相互破坏。
export function renderInline(text: string): string {
  const codeSpans: string[] = []
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(C.code(code))
    return NUL + (codeSpans.length - 1) + NUL
  })
  // 链接 [label](url) → label (url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => C.link(label) + C.dim(` (${url})`))
  // 粗斜体 / 粗体 / 斜体（先长后短，避免 ** 被 * 抢匹配）
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (_m, t: string) => C.boldItalic(t))
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => C.bold(t))
  s = s.replace(/__([^_]+)__/g, (_m, t: string) => C.bold(t))
  s = s.replace(/\*([^*\n]+)\*/g, (_m, t: string) => C.italic(t))
  // 下划线斜体：两侧非字母数字，避免误伤 snake_case
  s = s.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, (_m, t: string) => C.italic(t))
  // 删除线 ~~x~~
  s = s.replace(/~~([^~]+)~~/g, (_m, t: string) => C.strike(t))
  // 还原行内 code
  s = s.replace(restoreRe, (_m, i: string) => codeSpans[Number(i)] ?? '')
  return s
}

function hrWidth(): number {
  const cols = process.stderr.columns ?? 40
  return Math.max(8, Math.min(40, cols - 4))
}

// 渲染单个块级行（非代码块）。不含前缀缩进——由 stream 统一加。代码块行在 stream 里走语法高亮。
function renderBlockLine(line: string): string {
  const h = /^(#{1,6})\s+(.*)$/.exec(line)
  if (h) return C.heading(h[2])

  const q = /^>\s?(.*)$/.exec(line)
  if (q) return C.quote('│ ' + renderInline(q[1]))

  // 水平分隔线：整行由同一个 - * _ 重复 3+ 次构成
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return C.dim('─'.repeat(hrWidth()))

  const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (ul) return ul[1] + C.bullet('•') + ' ' + renderInline(ul[2])

  const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
  if (ol) return ol[1] + C.bullet(ol[2] + '.') + ' ' + renderInline(ol[3])

  return renderInline(line)
}

export interface MarkdownStream {
  push(delta: string): void
  end(): void
}

export function createMarkdownStream(opts: {
  write: (s: string) => void
  prefix?: string
}): MarkdownStream {
  const prefix = opts.prefix ?? ''
  // 捕获围栏语言:```ts → lang='ts';闭合围栏 lang=''
  const fenceRe = /^\s*(```+|~~~+)\s*([^\s`]*)/
  let buf = ''
  let inCode = false
  let codeLang = ''
  let hlState: HlState = makeHlState()

  const emit = (rendered: string) => {
    // 空行只发换行，避免留下「前缀空格 + 换行」的可见尾随空白
    opts.write(rendered.length ? prefix + rendered + '\n' : '\n')
  }

  const handleLine = (line: string) => {
    const f = fenceRe.exec(line)
    if (f) {
      if (!inCode) {
        inCode = true
        codeLang = (f[2] || '').toLowerCase()
        hlState = makeHlState() // 每个代码块独立的跨行块注释状态
      } else {
        inCode = false
        codeLang = ''
      }
      emit(C.dim(line.trim())) // 围栏标记本身按 dim 显示
      return
    }
    if (inCode) {
      emit(highlightLine(line, codeLang, hlState)) // 代码块内:语法高亮,不做行内 Markdown 解析
      return
    }
    emit(renderBlockLine(line))
  }

  return {
    push(delta: string) {
      buf += delta
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        handleLine(line)
      }
    },
    end() {
      if (buf.length > 0) {
        handleLine(buf)
        buf = ''
      }
    },
  }
}

// 非流式便捷封装：把整段 Markdown 渲染成字符串（供测试 / 一次性渲染用）。
export function renderMarkdown(full: string, prefix = ''): string {
  let out = ''
  const s = createMarkdownStream({ write: (x) => { out += x }, prefix })
  s.push(full)
  s.end()
  return out
}
