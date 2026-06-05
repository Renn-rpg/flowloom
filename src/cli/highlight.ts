// 轻量代码语法高亮(手写 mini-lexer,无第三方依赖,延续项目「不引重依赖」的风格)。
//
// 不做完整语言解析——只识别跨语言通用的词法:注释 / 字符串 / 数字 / 关键字 / 字面量。
// 对 JS/TS、Python、Go、Rust、Java、C 家族、JSON 等常见语言已足够好看。逐行高亮,但用一个
// 小状态跟踪跨行的块注释 /* */(C 家族常见)。三引号字符串等跨行结构按行处理(可接受的近似)。
//
// 设计要点:`tokenizeLine` 与颜色无关、可独立测试,且**保证 tokens 拼回原行**(不增删字符);
// `highlightLine` 只是把 token 映射成颜色再拼接。颜色通过 theme.ts 统一管理。
import { color } from './theme.js'

export type TokenType = 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'text'
export interface Token {
  type: TokenType
  text: string
}
export interface HlState {
  inBlock: boolean // 是否处于跨行 /* */ 块注释中
}
export function makeHlState(): HlState {
  return { inBlock: false }
}

// 跨语言关键字并集。宁可多染色,也比漏染好看;偶尔把别的语言关键字染上属于可接受的小瑕疵。
const KEYWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break',
  'continue', 'switch', 'case', 'default', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of',
  'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'as', 'async', 'await', 'yield',
  'try', 'catch', 'finally', 'throw', 'void', 'interface', 'type', 'enum', 'namespace', 'implements',
  'abstract', 'public', 'private', 'protected', 'static', 'readonly', 'get', 'set', 'declare',
  // Python
  'def', 'lambda', 'elif', 'except', 'raise', 'with', 'pass', 'global', 'nonlocal', 'assert', 'del',
  'and', 'or', 'not', 'is', 'print', // 注:None/True/False 归到 LITERALS,不在此处
  // Go / Rust / others
  'func', 'fn', 'struct', 'impl', 'trait', 'pub', 'mut', 'use', 'mod', 'match', 'where', 'defer',
  'go', 'chan', 'select', 'package', 'fmt', 'let', 'loop', 'unsafe', 'extern', 'crate', 'self',
  // C-family / Java
  'int', 'long', 'short', 'char', 'float', 'double', 'bool', 'boolean', 'string', 'void', 'unsigned',
  'signed', 'const', 'final', 'volatile', 'synchronized', 'throws', 'extends', 'implements', 'package',
])

// 布尔/空值字面量(含 Python 大写形式)。
const LITERALS = new Set([
  'true', 'false', 'null', 'undefined', 'nil', 'NaN', 'Infinity',
  'True', 'False', 'None',
])

interface CommentCfg {
  slash: boolean // // 行注释
  hash: boolean // # 行注释
  block: boolean // /* */ 块注释
}

const HASH_LANGS = new Set([
  'py', 'python', 'rb', 'ruby', 'sh', 'bash', 'zsh', 'shell', 'console', 'yaml', 'yml', 'toml',
  'ini', 'dockerfile', 'docker', 'make', 'makefile', 'r', 'perl', 'pl', 'conf', 'properties',
  'gitignore', 'env', 'dotenv',
])
const NO_COMMENT_LANGS = new Set(['json', 'html', 'xml', 'md', 'markdown', 'csv', 'text', 'txt'])

function commentCfg(lang: string): CommentCfg {
  const l = lang.toLowerCase()
  if (NO_COMMENT_LANGS.has(l)) return { slash: false, hash: false, block: false }
  if (HASH_LANGS.has(l)) return { slash: false, hash: true, block: false }
  // 其余(含未知语言)按 C 家族处理:// 行注释 + /* */ 块注释
  return { slash: true, hash: false, block: true }
}

const isIdentStart = (ch: string) => /[A-Za-z_$]/.test(ch)
const isIdentPart = (ch: string) => /[A-Za-z0-9_$]/.test(ch)
const isDigit = (ch: string) => ch >= '0' && ch <= '9'

// 把一行切成有色彩语义的 token。保证 tokens.map(t => t.text).join('') === line。
// state 会被原地更新(跨行块注释)。
export function tokenizeLine(line: string, lang: string, state: HlState): Token[] {
  const cfg = commentCfg(lang)
  const tokens: Token[] = []
  let plain = ''
  const flush = () => {
    if (plain) {
      tokens.push({ type: 'text', text: plain })
      plain = ''
    }
  }

  let i = 0

  // 续上一行未闭合的块注释
  if (state.inBlock) {
    const end = line.indexOf('*/')
    if (end === -1) {
      tokens.push({ type: 'comment', text: line })
      return tokens
    }
    tokens.push({ type: 'comment', text: line.slice(0, end + 2) })
    i = end + 2
    state.inBlock = false
  }

  while (i < line.length) {
    const ch = line[i]
    const two = line.slice(i, i + 2)

    if (cfg.block && two === '/*') {
      flush()
      const end = line.indexOf('*/', i + 2)
      if (end === -1) {
        tokens.push({ type: 'comment', text: line.slice(i) })
        state.inBlock = true
        i = line.length
        break
      }
      tokens.push({ type: 'comment', text: line.slice(i, end + 2) })
      i = end + 2
      continue
    }
    if (cfg.slash && two === '//') {
      flush()
      tokens.push({ type: 'comment', text: line.slice(i) })
      break
    }
    if (cfg.hash && ch === '#') {
      flush()
      tokens.push({ type: 'comment', text: line.slice(i) })
      break
    }
    // 字符串:扫到匹配的未转义引号或行尾
    if (ch === '"' || ch === "'" || ch === '`') {
      flush()
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === ch) { j++; break }
        j++
      }
      tokens.push({ type: 'string', text: line.slice(i, j) })
      i = j
      continue
    }
    // 数字(前一个字符不是标识符字符,避免把 x2 的 2 当数字)
    if (isDigit(ch) && !(i > 0 && isIdentPart(line[i - 1]))) {
      flush()
      let j = i + 1
      while (j < line.length && /[0-9a-fA-FxXob._]/.test(line[j])) j++
      tokens.push({ type: 'number', text: line.slice(i, j) })
      i = j
      continue
    }
    // 标识符 / 关键字 / 字面量
    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < line.length && isIdentPart(line[j])) j++
      const word = line.slice(i, j)
      if (KEYWORDS.has(word)) {
        flush()
        tokens.push({ type: 'keyword', text: word })
      } else if (LITERALS.has(word)) {
        flush()
        tokens.push({ type: 'literal', text: word })
      } else {
        plain += word
      }
      i = j
      continue
    }
    plain += ch
    i++
  }
  flush()
  return tokens
}

const HL: Record<TokenType, (s: string) => string> = {
  comment: color('gray'),
  string: color('green'),
  number: color('yellow'),
  keyword: color('magenta'),
  literal: color('yellow'),
  text: (s) => s,
}

import { HighlightCache } from './highlight-cache.js'

const hlCache = new HighlightCache()

// 高亮一行代码:先查 LRU 缓存,miss 时走 tokenize → 上色 → 拼接。
// colors 关闭时返回与输入完全一致的字符串。
// 注意:state.inBlock 跨行变化 → 带块注释状态的行不缓存（语义依赖前一行）。
// 缓存命中时仍需检查行内是否含 /*（会开启块注释状态），若有则调用 tokenizeLine
// 推进状态（仅用于副作用，丢弃返回值），避免缓存导致状态漂移。
export function highlightLine(line: string, lang: string, state: HlState): string {
  if (!state.inBlock) {
    const cached = hlCache.get(lang, line)
    if (cached !== undefined) {
      if (line.includes('/*')) tokenizeLine(line, lang, state) // 推进跨行状态
      return cached
    }
  }
  const rendered = tokenizeLine(line, lang, state)
    .map((t) => HL[t.type](t.text))
    .join('')
  if (!state.inBlock) {
    hlCache.set(lang, line, rendered)
  }
  return rendered
}
