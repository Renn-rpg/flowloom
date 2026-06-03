// 把「非核心」工具家族（git / task / cron）批量注册进会话 registry。
// 从 cli.ts 的 action handler 抽出——那里原本内联了 ~25 行重复的 registry.register 调用，
// 让本就臃肿的入口函数更难读。这里只做装配，无行为变化。
import type { ToolRegistry } from '../tools/registry.js'
import type { ShellPolicy } from '../tools/permissions.js'
import {
  makeGitDiffTool, makeGitLogTool, makeGitBranchTool, makeGitCommitTool, makeGitStatusTool,
  makeGitStashTool, makeGitWorktreeTool, makeGitFetchTool, makeGitPushTool, makeGitPullTool,
  makeGitMergeTool, makeGitRebaseTool, makeGitResetTool, makeGitRevertTool, makeGitBlameTool,
  makeGitTagTool, makeGitBisectTool,
} from '../tools/git.js'
import { makeTaskCreateTool, makeTaskUpdateTool, makeTaskListTool } from '../task/tool.js'
import type { TaskStore } from '../task/store.js'
import { makeCronCreateTool, makeCronListTool, makeCronDeleteTool } from '../cron/tool.js'
import type { CronScheduler } from '../cron/scheduler.js'
import type { CronStore } from '../cron/store.js'

// Git 工具（17 个）。读类工具无需审批；会改远端/历史的（commit/push/pull/rebase/reset）走传入的
// 独立 shell 策略实例（与 bash 的「不再询问」状态隔离）。
export function registerGitTools(registry: ToolRegistry, gitCommitShell: ShellPolicy): void {
  registry.register(makeGitDiffTool())
  registry.register(makeGitLogTool())
  registry.register(makeGitBranchTool())
  registry.register(makeGitCommitTool(gitCommitShell))
  registry.register(makeGitStatusTool())
  registry.register(makeGitStashTool())
  registry.register(makeGitWorktreeTool())
  registry.register(makeGitFetchTool())
  registry.register(makeGitPushTool(gitCommitShell))
  registry.register(makeGitPullTool(gitCommitShell))
  registry.register(makeGitMergeTool())
  registry.register(makeGitRebaseTool(gitCommitShell))
  registry.register(makeGitResetTool(gitCommitShell))
  registry.register(makeGitRevertTool())
  registry.register(makeGitBlameTool())
  registry.register(makeGitTagTool())
  registry.register(makeGitBisectTool())
}

// Task 系统（task_create / task_update / task_list）。
export function registerTaskTools(registry: ToolRegistry, taskStore: TaskStore): void {
  registry.register(makeTaskCreateTool(taskStore))
  registry.register(makeTaskUpdateTool(taskStore))
  registry.register(makeTaskListTool(taskStore))
}

// Cron 定时任务（cron_create / cron_list / cron_delete）。
export function registerCronTools(
  registry: ToolRegistry,
  scheduler: CronScheduler,
  store: CronStore,
): void {
  registry.register(makeCronCreateTool(scheduler, store))
  registry.register(makeCronListTool(scheduler))
  registry.register(makeCronDeleteTool(scheduler))
}
