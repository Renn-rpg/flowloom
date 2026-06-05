// 默认按键绑定 —— 匹配当前 FlowLoom 的 20 个硬编码动作。
// 用户可通过 ~/.floom/keybindings.json 覆盖（设为 null 解绑）。

import type { Keybinding } from './types.js'

export const DEFAULTS: Keybinding[] = [
  // —— Global ——
  { key: 'ctrl+c', action: 'interrupt', context: 'global', description: '发送 SIGINT / 取消输入' },
  { key: 'ctrl+d', action: 'exit-eof', context: 'global', description: 'EOF 退出（空提示行时）' },

  // —— Chat ——
  { key: 'enter', action: 'submit', context: 'chat', description: '提交当前输入' },
  { key: 'shift+enter', action: 'newline', context: 'chat', description: '插入换行' },
  { key: 'alt+enter', action: 'newline', context: 'chat', description: '插入换行' },
  { key: 'ctrl+o', action: 'expand-one', context: 'chat', description: '展开下一个折叠块' },
  { key: 'ctrl+e', action: 'expand-all', context: 'chat', description: '展开全部折叠块' },
  { key: 'up', action: 'history-prev', context: 'chat', description: '上一条历史' },
  { key: 'down', action: 'history-next', context: 'chat', description: '下一条历史' },
  { key: 'left', action: 'cursor-left', context: 'chat', description: '光标左移' },
  { key: 'right', action: 'cursor-right', context: 'chat', description: '光标右移' },
  { key: 'home', action: 'cursor-home', context: 'chat', description: '光标到行首' },
  { key: 'end', action: 'cursor-end', context: 'chat', description: '光标到行尾' },
  { key: 'backspace', action: 'delete-backward', context: 'chat', description: '删除左侧字符' },
  { key: 'delete', action: 'delete-forward', context: 'chat', description: '删除右侧字符' },
  { key: 'esc', action: 'interrupt-model', context: 'chat', description: '中断模型输出' },
  { key: 'ctrl+r', action: 'history-search', context: 'chat', description: '反向搜索历史' },
  { key: 'shift+tab', action: 'cycle-mode', context: 'chat', description: '循环切换模式' },

  // —— Autocomplete ——
  { key: 'tab', action: 'complete-accept', context: 'autocomplete', description: '接受补全项' },
  { key: 'enter', action: 'complete-accept', context: 'autocomplete', description: '接受补全项并提交' },
  { key: 'up', action: 'complete-prev', context: 'autocomplete', description: '上一个补全项' },
  { key: 'down', action: 'complete-next', context: 'autocomplete', description: '下一个补全项' },
  { key: 'esc', action: 'complete-dismiss', context: 'autocomplete', description: '关闭补全菜单' },

  // —— Select ——
  { key: 'up', action: 'select-prev', context: 'select', description: '上一个选项' },
  { key: 'down', action: 'select-next', context: 'select', description: '下一个选项' },
  { key: 'enter', action: 'select-confirm', context: 'select', description: '确认选择' },
  { key: 'esc', action: 'select-cancel', context: 'select', description: '取消选择' },
  { key: '1', action: 'select-num-1', context: 'select', description: '直接选第 1 项' },
  { key: '2', action: 'select-num-2', context: 'select', description: '直接选第 2 项' },
  { key: '3', action: 'select-num-3', context: 'select', description: '直接选第 3 项' },
  { key: '4', action: 'select-num-4', context: 'select', description: '直接选第 4 项' },
  { key: '5', action: 'select-num-5', context: 'select', description: '直接选第 5 项' },
  { key: '6', action: 'select-num-6', context: 'select', description: '直接选第 6 项' },
  { key: '7', action: 'select-num-7', context: 'select', description: '直接选第 7 项' },
  { key: '8', action: 'select-num-8', context: 'select', description: '直接选第 8 项' },
  { key: '9', action: 'select-num-9', context: 'select', description: '直接选第 9 项' },

  // —— Workflow View ——
  { key: 'up', action: 'wf-prev', context: 'workflow-view', description: '上一个 agent' },
  { key: 'down', action: 'wf-next', context: 'workflow-view', description: '下一个 agent' },
  { key: 'j', action: 'wf-prev', context: 'workflow-view', description: '上一个 agent (vim)' },
  { key: 'k', action: 'wf-next', context: 'workflow-view', description: '下一个 agent (vim)' },
  { key: 'x', action: 'wf-stop', context: 'workflow-view', description: '停止选中 agent' },
  { key: 'p', action: 'wf-pause', context: 'workflow-view', description: '暂停/恢复选中 agent' },
  { key: 's', action: 'wf-save', context: 'workflow-view', description: '保存运行摘要' },
  { key: 'esc', action: 'wf-exit', context: 'workflow-view', description: '退出钻入视图' },
  { key: 'q', action: 'wf-exit', context: 'workflow-view', description: '退出钻入视图' },

  // —— Modal ——
  { key: 'esc', action: 'modal-dismiss', context: 'modal', description: '关闭模态框' },
  { key: 'enter', action: 'modal-confirm', context: 'modal', description: '确认模态框' },
  { key: 'tab', action: 'modal-next', context: 'modal', description: '下一个按钮/选项' },
  { key: 'shift+tab', action: 'modal-prev', context: 'modal', description: '上一个按钮/选项' },

  // —— Help ——
  { key: 'esc', action: 'help-dismiss', context: 'help', description: '关闭帮助面板' },
  { key: 'q', action: 'help-dismiss', context: 'help', description: '关闭帮助面板' },
  { key: 'up', action: 'help-scroll-up', context: 'help', description: '帮助面板上滚' },
  { key: 'down', action: 'help-scroll-down', context: 'help', description: '帮助面板下滚' },
]
