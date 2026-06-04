// 交互式提示符的下拉补全计算（纯函数，零 IO，便于单测）。
// 把当前输入缓冲映射成「命令列表」或「参数列表」，每项带回填整行的 replacement。
// 行编辑器（repl-input.ts）据此渲染下拉并在 Tab/Enter 时回填。

import { SLASH_COMMANDS, commandArgOptions } from './commands.js'

export type CompletionKind = 'command' | 'arg' | 'file' | 'none'

export interface CompletionItem {
  label: string // 显示文案：命令为 '/clear'，参数为 'max'，文件为 'cli.ts'
  desc: string // 右侧说明
  replacement: string // 选中后回填的完整 buffer
}

export interface Completion {
  kind: CompletionKind
  items: CompletionItem[]
}

// 文件补全的目录列举依赖(注入以保持本模块零 IO、可单测)。repl 传真实 readdir 版本。
export interface CompletionDeps {
  listDir?: (dirRelPath: string) => { name: string; isDir: boolean }[]
}

const NONE: Completion = { kind: 'none', items: [] }

// @ 文件补全里跳过的噪音目录/文件。
const IGNORED_NAMES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.DS_Store', 'Thumbs.db'])

// 检测「行尾的 @<路径片段>」并列出匹配的文件/目录。@ 须位于行首或空白之后(避免命中邮箱 a@b)。
// 选中目录回填末尾加 '/'(菜单自动重开、继续向下钻);选中文件加 ' '(token 结束、菜单关闭)。
// 始终保留 '@' 前缀作为文件引用标记。
function computeFileCompletion(
  buffer: string,
  listDir?: (dirRelPath: string) => { name: string; isDir: boolean }[],
): Completion | null {
  if (!listDir) return null
  const m = /(^|\s)@([^\s]*)$/.exec(buffer)
  if (!m) return null
  const partial = m[2]
  const slash = partial.lastIndexOf('/')
  const dirPart = slash === -1 ? '' : partial.slice(0, slash)
  const namePart = slash === -1 ? partial : partial.slice(slash + 1)
  const nameLower = namePart.toLowerCase()
  // prefix 以 '@' 结尾(partial 是行尾非空白串,@ 紧邻其前)。
  const prefix = buffer.slice(0, buffer.length - partial.length)
  const showHidden = namePart.startsWith('.')

  let entries: { name: string; isDir: boolean }[]
  try { entries = listDir(dirPart || '.') } catch { entries = [] }

  const items = entries
    .filter((e) => !IGNORED_NAMES.has(e.name))
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .filter((e) => e.name.toLowerCase().startsWith(nameLower))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    .slice(0, 50)
    .map<CompletionItem>((e) => {
      const path = (dirPart ? dirPart + '/' : '') + e.name
      return {
        label: e.name + (e.isDir ? '/' : ''),
        desc: e.isDir ? 'dir' : 'file',
        replacement: prefix + path + (e.isDir ? '/' : ' '),
      }
    })
  return { kind: 'file', items }
}

// 给定输入 buffer，算出当前应弹出的补全项。
// 规则：
//  - 不以 '/' 开头 → 无菜单。
//  - '/<前缀>'（无空格）→ 按前缀过滤命令；若恰好是某个「带可枚举参数」命令的全名 → 直接进参数子菜单。
//  - '/<命令> <参数前缀>' → 该命令的参数选项按前缀过滤（命令无可枚举参数则无菜单）。
export function computeCompletions(buffer: string, deps?: CompletionDeps): Completion {
  // @ 文件补全优先(可出现在句中行尾,如 "explain @src/cli")。命中则不再走 slash 逻辑。
  const file = computeFileCompletion(buffer, deps?.listDir)
  if (file) return file
  if (!buffer.startsWith('/')) return NONE
  const rest = buffer.slice(1)
  const sp = rest.indexOf(' ')

  if (sp === -1) {
    const lower = rest.toLowerCase()
    const names = Object.keys(SLASH_COMMANDS).filter((n) => n.startsWith(lower))
    // 全名精确命中且该命令带可枚举参数 → 展开参数子菜单（如输入完整的 "/effort"）
    if (names.length === 1 && names[0] === lower && commandArgOptions(names[0])) {
      return argMenu(names[0], '')
    }
    const items = names.map<CompletionItem>((n) => ({
      label: '/' + n,
      desc: SLASH_COMMANDS[n].desc,
      replacement: '/' + n,
    }))
    return { kind: 'command', items }
  }

  // 命令已敲完并带空格：进入参数补全
  const cmd = rest.slice(0, sp).toLowerCase()
  if (!commandArgOptions(cmd)) return NONE
  return argMenu(cmd, rest.slice(sp + 1))
}

function argMenu(cmd: string, partial: string): Completion {
  const opts = commandArgOptions(cmd) ?? []
  const p = partial.trim().toLowerCase()
  const items = opts
    .filter((o) => o.value.startsWith(p))
    .map<CompletionItem>((o) => ({
      label: o.value,
      desc: o.desc,
      replacement: `/${cmd} ${o.value}`,
    }))
  return { kind: 'arg', items }
}
