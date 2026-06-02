// 计划模式（Plan Mode）：先调研出计划、用户批准后再动手。
// 计划模式下只放行只读工具，写/编辑/run_shell/子 agent/MCP 等一律拦截，让模型先调研、
// 调 exit_plan_mode 提交计划；用户批准后关闭计划模式、解锁全工具。
//
// 模型无关：本模块只依赖 Tool 类型；闸的拦截决策是纯函数；批准的 UI 交互由 cli 注入。

import type { Tool } from '../tools/types.js'

// 计划模式下允许的只读工具（其余一律拦截——无副作用才符合"先规划后执行"）。
// exit_plan_mode 自身必须放行（它是退出计划模式的唯一途径）。
export const PLAN_MODE_READONLY = new Set([
  'read_file',
  'glob',
  'grep',
  'web_fetch',
  'exit_plan_mode',
])

export function isReadOnlyInPlanMode(name: string): boolean {
  return PLAN_MODE_READONLY.has(name)
}

// 计划模式工具闸（纯函数）：active 且非只读 → 拦截并提示模型先出计划。
export function planModeGate(active: boolean, name: string): { allow: boolean; message?: string } {
  if (!active || isReadOnlyInPlanMode(name)) return { allow: true }
  return {
    allow: false,
    message:
      `plan mode is active — "${name}" would make changes. Investigate with read-only tools ` +
      `(read_file, glob, grep, web_fetch) only, then call exit_plan_mode with your plan and wait for ` +
      `the user to approve before changing anything.`,
  }
}

export interface ExitPlanModeDeps {
  active: () => boolean
  // 把计划呈现给用户并返回是否批准（UI 注入：cli 用方向键菜单）。
  propose: (plan: string) => Promise<boolean>
  // 批准后的副作用：关闭计划模式（cli 注入：翻转 planState + 刷新 system）。
  onApproved: () => void
}

export function makeExitPlanModeTool(deps: ExitPlanModeDeps): Tool {
  return {
    spec: {
      name: 'exit_plan_mode',
      description:
        'Call this ONLY when plan mode is active and you have finished researching and have a concrete, complete plan ready. ' +
        'Pass the full plan text; the user is shown the plan and approves or rejects it. ' +
        'On approval, plan mode turns off and you may implement the plan with the full set of tools. ' +
        'Do NOT call this before you have a complete plan, and do not use it to make changes yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: 'The complete implementation plan to present to the user for approval (markdown ok)',
          },
        },
        required: ['plan'],
      },
    },
    handler: async (input) => {
      if (!deps.active()) return 'Not in plan mode — there is no plan to exit. Proceed normally.'
      const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
      if (!plan) return 'ERROR: exit_plan_mode requires a non-empty "plan" string'
      const approved = await deps.propose(plan)
      if (approved) {
        deps.onApproved()
        return 'The user APPROVED the plan. Plan mode is now OFF — implement the plan now using the full set of tools.'
      }
      return (
        'The user did NOT approve the plan. Stay in plan mode: revise the plan based on any feedback ' +
        'and call exit_plan_mode again when ready. Do not make any changes yet.'
      )
    },
  }
}
