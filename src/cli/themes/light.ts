// 浅色主题令牌值。在亮色终端背景上保持可读性。

import chalk from 'chalk'
import type { Theme } from '../theme.js'

const brandBlue = chalk.hex('#2563EB')

export const lightTheme: Theme = {
  // —— 基础色 ——
  'text': chalk.black,
  'dim': chalk.hex('#6B7280'),
  'bold': chalk.bold,
  'italic': chalk.italic,
  'strike': chalk.strikethrough,
  'bold-italic': chalk.bold.italic,
  'green': chalk.hex('#166534'),
  'red': chalk.hex('#991B1B'),
  'yellow': chalk.hex('#854D0E'),
  'blue': chalk.hex('#1E40AF'),
  'cyan': chalk.hex('#0E7490'),
  'white': chalk.black,
  'magenta': chalk.hex('#6B21A8'),
  'gray': chalk.hex('#9CA3AF'),

  // —— 品牌 / spinner ——
  'brand': brandBlue,
  'spinner': chalk.hex('#0E7490'),

  // —— Markdown 语义 ——
  'heading': chalk.bold.hex('#0E7490'),
  'link': chalk.hex('#0E7490').underline,
  'code': chalk.hex('#854D0E'),
  'quote': chalk.hex('#6B7280'),
  'bullet': chalk.hex('#0E7490'),

  // —— Diff 语义 ——
  'diff-del-bg': chalk.bgHex('#FEE2E2').hex('#991B1B'),
  'diff-add-bg': chalk.bgHex('#DCFCE7').hex('#166534'),
  'diff-del': chalk.hex('#991B1B'),
  'diff-add': chalk.hex('#166534'),
  'diff-hunk': chalk.hex('#0E7490'),
  'diff-context': chalk.hex('#6B7280'),
  'diff-file': chalk.bold,

  // —— 用户消息 ——
  'user-msg-bg': chalk.bgHex('#F3F4F6'),

  // —— Footer / 状态栏 ——
  'mode-auto': chalk.hex('#854D0E'),
  'mode-plan': chalk.hex('#1E40AF'),
  'mode-normal': chalk.black,
  'ctx-low': chalk.hex('#166534'),
  'ctx-mid': chalk.hex('#854D0E'),
  'ctx-high': chalk.hex('#991B1B'),
  'status-bar': chalk.hex('#1E40AF'),

  // —— 工具调用 ——
  'tool-running': chalk.black,
  'tool-done': chalk.hex('#166534'),
  'tool-error': chalk.hex('#991B1B'),

  // —— 对话框 ——
  'dialog-border': chalk.hex('#9CA3AF'),
  'dialog-bg': chalk.bgHex('#F9FAFB'),

  // —— Agent 徽章 ——
  'agent-badge-done': chalk.bgHex('#DCFCE7').hex('#166534'),
  'agent-badge-running': chalk.bgHex('#FEF9C3').hex('#854D0E'),
  'agent-badge-error': chalk.bgHex('#FEE2E2').hex('#991B1B'),
  'agent-badge-queued': chalk.bgHex('#F3F4F6').hex('#6B7280'),
}
