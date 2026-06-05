// 对话框类型系统（对标 free-code 的 dialog/ 子系统）。
// 提供 select / confirm / info / warning / error 五种对话框。
// 与 Phase 1 主题系统、Phase 2 按键上下文集成。

export type DialogKind = 'select' | 'confirm' | 'info' | 'warning' | 'error'

export interface SelectOption<T = string> {
  value: T
  label: string
  description?: string
}

export interface SelectDialogConfig<T = string> {
  kind: 'select'
  title: string
  message?: string
  options: SelectOption<T>[]
  defaultIndex?: number
  /** 最多显示选项数（超出可滚动） */
  maxVisible?: number
}

export interface ConfirmDialogConfig {
  kind: 'confirm'
  title: string
  message: string
  detail?: string // 可展开的详细信息
  confirmLabel?: string
  cancelLabel?: string
  defaultConfirm?: boolean
}

export interface InfoDialogConfig {
  kind: 'info' | 'warning' | 'error'
  title: string
  message: string
  /** 自动关闭毫秒数（0 = 手动关闭） */
  autoDismissMs?: number
}

export type DialogConfig<T = string> =
  | SelectDialogConfig<T>
  | ConfirmDialogConfig
  | InfoDialogConfig

export interface DialogResult<T = string> {
  /** 选择的值（select 对话框） */
  value?: T
  /** 是否确认（confirm 对话框） */
  confirmed?: boolean
  /** 是否取消 */
  cancelled: boolean
}

