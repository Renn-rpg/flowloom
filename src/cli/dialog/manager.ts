// 对话框管理器 —— 渲染模态覆盖层、管理 stdin 独占、保存/恢复背景。
//
// 设计：
//   · 一次只显示一个对话框（栈深度 1）。
//   · 打开时计算所需行数，用 ANSI 光标定位在终端底部绘制。
//   · 关闭时恢复背景内容（用保存的行数据覆盖）。
//   · 集成 Phase 2 的 ContextManager（进入 'modal' 上下文）。
//
// 对标 free-code 的 modal pane + PromptOverlay 系统，适合 FlowLoom 的非 React 架构。

import type { SelectDialogConfig, ConfirmDialogConfig } from './types.js'
import type { ContextManager } from '../keybindings/context.js'
import { color } from '../theme.js'
import { stripAnsi, visualWidth } from '../format.js'

export interface DialogManagerOptions {
  /** 终端列数 */
  columns: number
  /** 终端行数 */
  rows: number
  /** 上下文管理器（Phase 2） */
  contextManager: ContextManager
}

export class DialogManager {
  private columns: number
  private rows: number
  private ctx: ContextManager
  constructor(opts: DialogManagerOptions) {
    this.columns = opts.columns
    this.rows = opts.rows
    this.ctx = opts.contextManager
  }

  // 更新终端尺寸（resize 时调用）
  updateSize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
  }

  // 安全填充：按视觉宽度补齐空格（避免 ANSI 序列导致右边界错位）
  private padRight(line: string, targetWidth: number): string {
    const vw = visualWidth(stripAnsi(line))
    return line + ' '.repeat(Math.max(0, targetWidth - vw))
  }

  // ——— 渲染（纯组合，不写 IO）———

  // 渲染选择菜单为字符串数组
  renderSelect<T>(config: SelectDialogConfig<T>, selectedIndex: number): string[] {
    const border = color('dialog-border')
    const W = Math.max(8, Math.min(72, this.columns - 4))
    const lines: string[] = []

    // 顶边框 + 标题
    const titleLine = ` ${config.title} `
    const topBar = border('╭' + '─'.repeat(titleLine.length + 2) + '╮')
    lines.push('  ' + topBar)
    lines.push(`  ${border('│')} ${color('bold')(titleLine)} ${border('│')}`)

    if (config.message) {
      // 消息可能折行
      const msgW = W - 4
      let msg = config.message
      while (msg.length > 0) {
        const chunk = msg.slice(0, msgW)
        msg = msg.slice(msgW)
        lines.push(`  ${border('│')} ${color('dim')(chunk)}${' '.repeat(Math.max(0, msgW - chunk.length))} ${border('│')}`)
      }
    }

    // 分隔线
    lines.push(`  ${border('├')}${border('─'.repeat(W - 2))}${border('┤')}`)

    // 选项（最多 visible 行）
    const maxV = config.maxVisible ?? 8
    const start = Math.max(0, selectedIndex - Math.floor(maxV / 2))
    const visible = config.options.slice(start, start + maxV)
    for (let i = 0; i < visible.length; i++) {
      const idx = start + i
      const opt = visible[i]
      const isSelected = idx === selectedIndex
      const prefix = isSelected ? color('cyan')('❯ ') : '  '
      const numLabel = color('dim')(`${idx + 1}.`)
      const label = isSelected ? color('bold')(opt.label) : opt.label
      const desc = opt.description ? color('dim')(` — ${opt.description}`) : ''
      const line = `${prefix}${numLabel} ${label}${desc}`
      lines.push(`  ${border('│')} ${this.padRight(line, W - 2)} ${border('│')}`)
    }

    // 滚动指示器
    if (config.options.length > maxV) {
      const scrollHint = color('dim')(`  ${start + 1}-${Math.min(start + maxV, config.options.length)} / ${config.options.length}`)
      lines.push(`  ${border('│')} ${this.padRight(scrollHint, W - 2)} ${border('│')}`)
    }

    // 底边框
    lines.push(`  ${border('╰')}${border('─'.repeat(W - 2))}${border('╯')}`)

    return lines
  }

  // 渲染确认对话框为字符串数组
  renderConfirm(config: ConfirmDialogConfig, focusConfirm: boolean): string[] {
    const border = color('dialog-border')
    const W = Math.max(8, Math.min(64, this.columns - 4))
    const lines: string[] = []

    lines.push(`  ${border('╭')}${border('─'.repeat(W - 2))}${border('╮')}`)
    const titleLine = ` ${config.title} `
    const coloredTitle = color('bold')(titleLine)
    lines.push(`  ${border('│')} ${this.padRight(coloredTitle, W - 2)} ${border('│')}`)

    if (config.message) {
      lines.push(`  ${border('│')} ${this.padRight(config.message, W - 2)} ${border('│')}`)
    }

    // 按钮行
    const confirmLabel = config.confirmLabel ?? 'Yes'
    const cancelLabel = config.cancelLabel ?? 'No'
    const cf = focusConfirm ? color('bold')(`[${confirmLabel}]`) : ` ${confirmLabel} `
    const cx = focusConfirm ? ` ${cancelLabel} ` : color('bold')(`[${cancelLabel}]`)
    const btnLine = `  ${cf}  ${cx}`
    lines.push(`  ${border('│')} ${this.padRight(btnLine, W - 2)} ${border('│')}`)

    lines.push(`  ${border('╰')}${border('─'.repeat(W - 2))}${border('╯')}`)
    return lines
  }
}
