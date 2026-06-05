// 深色主题令牌值。所有函数返回 chalk 染色的字符串（不自行做 useColor 检查——由 theme.ts 的
// color() 统一包裹）。

import chalk from 'chalk'
import type { Theme } from '../theme.js'

// 品牌蓝（来自 welcome.ts 的 #4A90D9，偏柔和不刺眼）。
const brandBlue = chalk.hex('#4A90D9')

export const darkTheme: Theme = {
  // —— 基础色 ——
  'text': chalk.white,
  'dim': chalk.dim,
  'bold': chalk.bold,
  'italic': chalk.italic,
  'strike': chalk.strikethrough,
  'bold-italic': chalk.bold.italic,
  'green': chalk.hex('#4E9A06'),
  'red': chalk.hex('#CC0000'),
  'yellow': chalk.hex('#C4A000'),
  'blue': chalk.hex('#3465A4'),
  'cyan': chalk.hex('#06989A'),
  'white': chalk.white,
  'magenta': chalk.hex('#75507B'),
  'gray': chalk.gray,

  // —— 品牌 / spinner ——
  'brand': brandBlue,
  'spinner': chalk.hex('#06989A'),

  // —— Markdown 语义 ——
  'heading': chalk.bold.hex('#00CED1'),
  'link': chalk.hex('#00CED1').underline,
  'code': chalk.hex('#C4A000'),
  'quote': chalk.dim,
  'bullet': chalk.hex('#06989A'),

  // —— Diff 语义 ——
  'diff-del-bg': chalk.bgHex('#5F0000').black,
  'diff-add-bg': chalk.bgHex('#005F00').black,
  'diff-del': chalk.hex('#FF6666'),
  'diff-add': chalk.hex('#66FF66'),
  'diff-hunk': chalk.hex('#06989A'),
  'diff-context': chalk.dim,
  'diff-file': chalk.bold,

  // —— 用户消息 ——
  'user-msg-bg': chalk.bgHex('#2D2D2D'),

  // —— Footer / 状态栏 ——
  'mode-auto': chalk.hex('#C4A000'),
  'mode-plan': chalk.hex('#3465A4'),
  'mode-normal': chalk.white,
  'ctx-low': chalk.hex('#4E9A06'),
  'ctx-mid': chalk.hex('#C4A000'),
  'ctx-high': chalk.hex('#CC0000'),
  'status-bar': chalk.hex('#3465A4'),

  // —— 工具调用 ——
  'tool-running': chalk.white,
  'tool-done': chalk.hex('#4E9A06'),
  'tool-error': chalk.hex('#CC0000'),

  // —— 对话框 ——
  'dialog-border': chalk.hex('#555555'),
  'dialog-bg': chalk.bgHex('#1C1C1C'),

  // —— Agent 徽章 ——
  'agent-badge-done': chalk.bgHex('#005F00').hex('#66FF66'),
  'agent-badge-running': chalk.bgHex('#5F5F00').hex('#FFFF66'),
  'agent-badge-error': chalk.bgHex('#5F0000').hex('#FF6666'),
  'agent-badge-queued': chalk.bgHex('#2D2D2D').dim,
}
