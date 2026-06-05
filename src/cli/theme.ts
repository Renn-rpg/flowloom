// 主题与颜色系统（对标 free-code 的 ThemeProvider + colorize.ts）。
//
// 集中管理所有终端颜色令牌，其余模块（format, highlight, markdown, diff, footer, welcome,
// spinner）统一通过 `color(token)` 获取染色函数，不再各自声明 useColor / paint。
//
// 设计要点：
//   · Theme = Record<ThemeToken, (s: string) => string> —— 每个令牌存一个 chalk 染色函数。
//   · color(token) 包裹 useColor 检查（NO_COLOR / TERM=dumb / !isTTY → 退化为透传）。
//   · 深色/浅色主题通过 FLOOM_THEME env 切换，默认深色。
//   · getTheme() / reloadTheme() 支持运行时切换（供 /theme 命令使用）。
//   · 样式令牌（bold / dim / italic）也被视为合法的 ThemeToken。

import chalk from 'chalk'
import { darkTheme } from './themes/dark.js'
import { lightTheme } from './themes/light.js'

// —— 类型 ——

// 语义颜色令牌：所有出现在 UI 中的颜色都通过令牌引用，绝不硬编码 chalk 调用。
// 新增令牌时在此追加，并在 themes/dark.ts / themes/light.ts 提供对应值。
export type ThemeToken =
  // 基础色
  | 'text' | 'dim' | 'bold' | 'italic' | 'strike' | 'bold-italic'
  | 'green' | 'red' | 'yellow' | 'blue' | 'cyan' | 'white' | 'magenta' | 'gray'
  // 品牌 / spinner
  | 'brand' | 'spinner'
  // Markdown 语义
  | 'heading' | 'link' | 'code' | 'quote' | 'bullet'
  // Diff 语义
  | 'diff-del-bg' | 'diff-add-bg' | 'diff-del' | 'diff-add'
  | 'diff-hunk' | 'diff-context' | 'diff-file'
  // 用户消息
  | 'user-msg-bg'
  // Footer / 状态栏
  | 'mode-auto' | 'mode-plan' | 'mode-normal'
  | 'ctx-low' | 'ctx-mid' | 'ctx-high'
  | 'status-bar'
  // 工具调用
  | 'tool-running' | 'tool-done' | 'tool-error'
  // 对话框
  | 'dialog-border' | 'dialog-bg'
  // Agent 徽章
  | 'agent-badge-done' | 'agent-badge-running' | 'agent-badge-error' | 'agent-badge-queued'

export type Theme = Record<ThemeToken, (s: string) => string>

// —— 状态 ——

const useColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  !!process.stderr.isTTY

let currentTheme: Theme = resolveTheme(process.env.FLOOM_THEME)

function resolveTheme(name?: string): Theme {
  switch (name?.toLowerCase()) {
    case 'light':
      return lightTheme
    case 'dark':
    default:
      return darkTheme
  }
}

// —— 公开 API ——

// 返回当前主题对象（只读引用）。用于需要直接遍历令牌的场景。
export function getTheme(): Readonly<Theme> {
  return currentTheme
}

// 运行时切换主题。传入 'dark' / 'light' 或自定义 Theme。
export function reloadTheme(nameOrTheme?: string | Theme): void {
  if (typeof nameOrTheme === 'object') {
    currentTheme = nameOrTheme
  } else {
    currentTheme = resolveTheme(nameOrTheme)
    if (nameOrTheme) process.env.FLOOM_THEME = nameOrTheme
  }
}

// 当前是否启用颜色。供不需要具体令牌、只需判断的调用方使用。
export function colorsEnabled(): boolean {
  return useColor
}

// 核心染色函数：color('green')('success') → (绿色 success 或纯文本)。
// color('bold') 可用于仅加粗不染色的场景——只要是 ThemeToken，都走这条路径。
export function color(token: ThemeToken): (s: string) => string {
  const fn = currentTheme[token] ?? ((s: string) => s)
  return (s: string) => (useColor ? fn(s) : s)
}
