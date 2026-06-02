// 交互式提示符的下拉补全计算（纯函数，零 IO，便于单测）。
// 把当前输入缓冲映射成「命令列表」或「参数列表」，每项带回填整行的 replacement。
// 行编辑器（repl-input.ts）据此渲染下拉并在 Tab/Enter 时回填。

import { SLASH_COMMANDS, commandArgOptions } from './commands.js'

export type CompletionKind = 'command' | 'arg' | 'none'

export interface CompletionItem {
  label: string // 显示文案：命令为 '/clear'，参数为 'max'
  desc: string // 右侧说明
  replacement: string // 选中后回填的完整 buffer
}

export interface Completion {
  kind: CompletionKind
  items: CompletionItem[]
}

const NONE: Completion = { kind: 'none', items: [] }

// 给定输入 buffer，算出当前应弹出的补全项。
// 规则：
//  - 不以 '/' 开头 → 无菜单。
//  - '/<前缀>'（无空格）→ 按前缀过滤命令；若恰好是某个「带可枚举参数」命令的全名 → 直接进参数子菜单。
//  - '/<命令> <参数前缀>' → 该命令的参数选项按前缀过滤（命令无可枚举参数则无菜单）。
export function computeCompletions(buffer: string): Completion {
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
