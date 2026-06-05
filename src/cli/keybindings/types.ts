// 按键绑定系统 —— 核心类型（对标 free-code 的 keybindings/types.ts）。
//
// 设计要点：
//   · Key 是从 repl-input.ts 提取的语义按键，与底层字节解码解耦。
//   · KeybindingContext 控制按键在哪个 UI 状态下生效。
//   · KeybindingAction 是字符串标识符，匹配 defaults.ts 中的动作名。
//   · Keybinding 描述一个绑定：在哪个 context 下、按什么键、触发什么动作。

// —— 语义按键（从 repl-input.ts 提取，保持向后兼容）——

export type Key =
  | { t: 'char'; ch: string }
  | { t: 'enter' }
  | { t: 'backspace' }
  | { t: 'delete' }
  | { t: 'tab' }
  | { t: 'shift-tab' }
  | { t: 'esc' }
  | { t: 'up' }
  | { t: 'down' }
  | { t: 'left' }
  | { t: 'right' }
  | { t: 'home' }
  | { t: 'end' }
  | { t: 'ctrl-c' }
  | { t: 'ctrl-d' }
  | { t: 'ctrl-r' }
  | { t: 'ctrl-o' }
  | { t: 'ctrl-e' }
  | { t: 'newline' }   // Alt+Enter / Shift+Enter → 插入换行，不提交
  | { t: 'unknown' }

// —— 按键上下文 ——

// 每个 UI 状态对应一个 context。一个按键可能在不同 context 下触发不同动作。
// 当前 v1 支持的上下文（与 free-code 对齐的精简集）：
export type KeybindingContext =
  | 'global'        // 全局（兜底）
  | 'chat'          // 主提示行（正常输入状态）
  | 'autocomplete'  // 下拉补全菜单打开中
  | 'select'        // 选择菜单/对话框
  | 'workflow-view' // 全屏 agent 钻入视图
  | 'modal'         // 模态对话框
  | 'help'          // 帮助面板

// —— 按键动作 ——

// 动作名是稳定的字符串标识符。defaults.ts 定义默认绑定，用户可通过 keybindings.json
// 覆盖或解绑（设为 null）。
export type KeybindingAction = string

// —— 按键描述（用户配置格式）——

// 用户配置中的按键描述字符串，如 "ctrl+o"、"shift+tab"、"esc"、"a"。
// 在 Zod schema 中验证格式。
export type KeyPattern = string

// —— 绑定条目 ——

export interface Keybinding {
  /** 按键模式（用户配置格式，如 "ctrl+o"） */
  key: KeyPattern
  /** 触发动作 */
  action: KeybindingAction
  /** 所属上下文 */
  context: KeybindingContext
  /** 可选描述（用于帮助面板） */
  description?: string
}

// —— 绑定匹配结果 ——

export interface KeybindingMatch {
  action: KeybindingAction
  context: KeybindingContext
  description?: string
}

// —— 用户配置文件格式 ——

export interface KeybindingConfig {
  /** 按键绑定列表 */
  bindings: Keybinding[]
}

// —— 上下文栈条目 ——

export interface ContextEntry {
  context: KeybindingContext
  /** 进入时间戳（用于调试和优先级） */
  enteredAt: number
}
