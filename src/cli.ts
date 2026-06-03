#!/usr/bin/env node
import { config } from 'dotenv'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 加载 .env：全局 (~/.floom/.env) 优先，项目级 ($CWD/.env) 覆盖
config({ path: join(homedir(), '.floom', '.env'), quiet: true })
config({ quiet: true }) // $CWD/.env 覆盖全局

import { Command } from 'commander'
import { resolve, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { Spinner } from './cli/spinner.js'
import {
  type PathPolicy,
  type ShellPolicy,
  confineToRoot,
  denySecrets,
  allowAllPaths,
  allowAllShell,
  denyAllShell,
  auditLog,
} from './tools/permissions.js'
import { selectMenu } from './cli/prompt.js'
import { ReplReader } from './cli/repl-input.js'
import { resolveEffortModel } from './cli/effort.js'
import { runSlash, type SlashContext } from './cli/commands.js'
import { BackgroundShells } from './tools/shell-manager.js'
import { ToolRegistry } from './tools/registry.js'
import { loadHooks, evaluatePreToolUse, evaluatePostToolUse, expandHookCommand } from './hooks/engine.js'
import { loadMcpConfig } from './mcp/config.js'
import { connectMcpServers } from './mcp/manager.js'
import { runTurn, type ToolGate } from './agent/loop.js'
import { compactMessages } from './agent/compaction.js'
import { makeDispatchAgentTool } from './agent/subagent.js'
import { makeExitPlanModeTool, planModeGate } from './agent/plan.js'
import type { Tool } from './tools/types.js'
import { SessionStore } from './agent/session-store.js'
import { executeWorkflow } from './workflow/workflow-runtime.js'
import { NodeVmRuntime, IsolatedVmRuntime } from './workflow/sandbox.js'
import { createSpinner, stopActiveSpinner, stopBlinking } from './cli/spinner.js'
import { fmt } from './cli/format.js'
import { showWelcome } from './cli/welcome.js'
import { renderDiff } from './cli/diff.js'
import { createStatusBar, renderStatusBar } from './cli/status-bar.js'
import { BlockManager } from './cli/blocks.js'
import { MemoryStore } from './memory/store.js'
import { formatRecall } from './memory/recall.js'
import { makeRememberTool } from './memory/tool.js'
import { skillRegistry } from './skills/registry.js'
import { codeReviewSkill } from './skills/builtin/code-review.js'
import { simplifySkill } from './skills/builtin/simplify.js'
import { architectSkill } from './skills/builtin/architect.js'
import { deepReviewSkill } from './skills/builtin/deep-review.js'
import { loadAllSkills } from './skills/fs-loader.js'
import { loadSettings, describeSettings, saveSetting, resetSettings } from './config/settings.js'
import { makeGitDiffTool, makeGitLogTool, makeGitBranchTool, makeGitCommitTool, makeGitStatusTool, makeGitStashTool, makeGitWorktreeTool, makeGitFetchTool, makeGitPushTool, makeGitPullTool, makeGitMergeTool, makeGitRebaseTool, makeGitResetTool, makeGitRevertTool, makeGitBlameTool, makeGitTagTool, makeGitBisectTool } from './tools/git.js'
import { CronStore } from './cron/store.js'
import { CronScheduler } from './cron/scheduler.js'
import { makeCronCreateTool, makeCronListTool, makeCronDeleteTool } from './cron/tool.js'
import { formatApiError } from './model/retry.js'
import { getFactory } from './model/factory.js'
import { TaskStore } from './task/store.js'
import { makeTaskCreateTool, makeTaskUpdateTool, makeTaskListTool } from './task/tool.js'
import {
  makeSystem,
  makeSubAgentSystem,
  makeSession,
  makeRegistry,
  makeInteractiveShell,
  sessionStore,
  makeSessionId,
  sessionsText,
  type ToolPolicy,
  CONTEXT_TOKENS,
  REASONER_MODEL,
  MAX_TOKENS,
} from './cli/session-factory.js'

// 注册内置技能
skillRegistry.register(codeReviewSkill)
skillRegistry.register(simplifySkill)
skillRegistry.register(architectSkill)
skillRegistry.register(deepReviewSkill)

// 从文件系统加载用户技能（~/.floom/skills/ + .floom/skills/）
const fsSkills = loadAllSkills(process.cwd(), homedir())
for (const s of fsSkills) {
  skillRegistry.register(s)
}
if (fsSkills.length > 0) {
  process.stderr.write(
    fmt.dim(`  📄 loaded ${fsSkills.length} file-based skill(s): ${fsSkills.map(s => s.name).join(', ')}\n`),
  )
}

const VERSION = '0.10.0'

// 会话工厂、工具注册、权限策略等核心构造逻辑已提取到 session-factory.ts。
// 以下仅保留 CLI 特有的输出函数 printSessions（写 stderr，依赖 sessionsText）。

function printSessions(store: SessionStore): void {
  process.stderr.write(sessionsText(store) + '\n')
}

// 改完后展示 diff 的工具
const DIFF_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file'])

// 详情显隐状态：verbose=false 时不流式打印思考链（CoT），仅留 "Thinking…(Ns) · ctrl+o to expand"
// 提示，完整 CoT 缓存在 lastReasoning，供提示符处按 ctrl+o 展开。verbose=true 则实时流式。
export interface UiState {
  verbose: boolean
  lastReasoning: string
  // 上一轮 turn 的摘要（工具数 / token 数 / 耗时），ctrl+o 展开时一并显示。
  lastTurnSummary: string
  hasRepl: boolean
  // 可折叠区块管理器：每个 turn 新建，turn 结束保留供 Ctrl+O/E 展开
  blockManager: BlockManager
  // PostToolUse hooks 规则（从 hooks.json 加载，在 onToolResult 中触发）
  postToolHooks: import('./hooks/engine.js').PostToolHook[]
  // 工具调用详情存储（供 Ctrl+T 展开查看 input/output）
  toolDetails: Map<string, { input: Record<string, unknown>; output?: string; isError?: boolean }>
}

// 单次 turn 的 UI 渲染：流式文本 + 思考计时 + 工具链动画 + 改动 diff
async function runTurnWithUI(
  session: ReturnType<typeof makeSession>,
  task: string,
  write: (d: string) => void,
  ui: UiState,
) {
  const startTime = Date.now()
  // 模型输出期间：隐藏光标，暂停 stdin 防止 Enter 干扰
  process.stderr.write('\x1b[?25l')
  const wasPaused = process.stdin.isPaused()
  process.stdin.pause() // 暂停 data 事件，不接收任何输入
  let totalTools = 0
  // 本轮全部思考链（跨多轮 generate 累计）；turn 结束写入 ui.lastReasoning 供 ctrl+o 展开。
  let reasoningBuf = ''

  // —— 思考计时 spinner（实时秒数 + 推理活动量，类 Claude）——
  let thinkSpinner: Spinner | null = null
  let thinkTimer: ReturnType<typeof setInterval> | null = null
  let thinkStart = 0
  let thinkingReported = false
  const startThinking = () => {
    thinkStart = Date.now()
    thinkingReported = false
    thinkSpinner = createSpinner('Thinking...')
    // 250ms 刷新 spinner 文本：秒数 + 已收推理字符数。thinking 模型在折叠模式下
    // 推理阶段不打印 CoT，靠这个递增的计数让用户看到"在动"（而非冻结的一行）；
    // 节流到 250ms 而非每个 reasoning delta 更新，避免刷屏。
    thinkTimer = setInterval(() => {
      if (!thinkSpinner) return
      const s = Math.floor((Date.now() - thinkStart) / 1000)
      const rc = reasoningBuf.length
      const prog = rc > 0 ? ` · ${rc >= 1000 ? (rc / 1000).toFixed(1) + 'k' : rc} reasoning` : ''
      thinkSpinner.text = (s >= 1 ? `Thinking... (${s}s)` : 'Thinking...') + prog
    }, 250)
    thinkTimer.unref?.()
  }
  const stopThinking = () => {
    if (thinkTimer) {
      clearInterval(thinkTimer)
      thinkTimer = null
    }
    if (thinkSpinner) {
      thinkSpinner.stop() // 清掉 spinner 行；光标显隐由本函数外层统一管理
      thinkSpinner = null
    }
  }
  const reportThinking = () => {
    if (thinkingReported) return
    thinkingReported = true
    // 折叠模式下若本轮产生了被隐藏的思考链且存在 REPL 提示符，提示用户可按 ctrl+o 展开。
    // 一次性模式下 hasRepl=false，不加该提示——进程马上就退出了，按键无处理器。
    const hint = ui.hasRepl && !ui.verbose && reasoningBuf.length > 0 ? fmt.dim(' · ctrl+o to expand') : ''
    process.stderr.write(fmt.thinking(Date.now() - thinkStart) + hint + '\n')
  }

  // —— 流式文本：首个 token 到达即停思考动画、随后逐块打印 ——
  let streaming = false
  // —— 思考链流式（thinking 模型）：暗色打到 stderr，保持 stdout 只含最终答案 ——
  let reasoningStreaming = false
  // —— diff：在工具执行前后读取文件内容做对比 ——
  let pendingDiff: { path: string; before: string } | null = null

  try {
    await runTurn(session, task, {
      onReasoning: (delta) => {
        reasoningBuf += delta
        // 折叠模式（默认）：不流式打印思考链，spinner 继续转；turn 结束后可 ctrl+o 展开。
        if (!ui.verbose) return
        // verbose 模式：首块到达即停 spinner，打一行暗色表头，随后逐块暗色输出。
        if (!reasoningStreaming) {
          stopThinking()
          thinkingReported = true // 思考流取代 "Thinking... (X.Xs)" 行
          process.stderr.write(fmt.dim('  ✻ Thinking…\n'))
          reasoningStreaming = true
        }
        process.stderr.write(fmt.dim(delta))
      },
      onText: (delta) => {
        if (!streaming) {
          stopThinking()
          if (reasoningStreaming) {
            process.stderr.write('\n') // 思考块收尾换行，再开始最终答案
            reasoningStreaming = false
          } else {
            reportThinking() // 无思考流的普通模型：补一行 "Thinking... (X.Xs)"
          }
          streaming = true
          // 语义分区：思考链与最终答案之间加区域标记
          if (reasoningBuf.length > 0) {
            write(fmt.dim('\n  ── Response ──\n'))
          }
          write('  ')
        }
        // 换行后保持缩进
        write(delta.replace(/\n/g, '\n  '))
      },
      onThinking: () => {
        streaming = false
        reasoningStreaming = false
        startThinking()
      },
      onThinkingDone: () => {
        // 本轮 generate 结束：收尾思考流（仅有 CoT 无文本/纯工具轮时），
        // 并在纯工具调用轮补出思考耗时行。
        stopThinking()
        if (reasoningStreaming) {
          process.stderr.write('\n')
          reasoningStreaming = false
        }
        reportThinking()
      },
      onContextTrim: (info) => {
        const warn = info.overBudget ? ' (still over budget — last round alone is large)' : ''
        process.stderr.write(
          fmt.yellow(
            `  ⚠ context trimmed: dropped ${info.droppedMessages} msg / ${info.droppedRounds} round(s), ~${info.estimatedTokens} tok kept${warn}\n`,
          ),
        )
      },
      onContextCompact: (info) => {
        process.stderr.write(
          fmt.dim(
            `  🗜 context compacted: summarized ${info.summarizedRounds} round(s) → ~${info.estimatedTokens} tok kept\n`,
          ),
        )
      },
      onToolCall: (name, input) => {
        if (streaming) { write('\n'); streaming = false }
        const args = input.path ? String(input.path).slice(-40)
          : input.command ? String(input.command).slice(0, 50)
          : input.pattern ? String(input.pattern).slice(0, 50)
          : ''
        pendingDiff = null
        if (DIFF_TOOLS.has(name) && input.path) {
          try { pendingDiff = { path: String(input.path), before: readFileSync(resolve(process.cwd(), String(input.path)), 'utf8') } } catch { pendingDiff = { path: String(input.path), before: '' } }
        }
        // 存储工具输入供 Ctrl+T 展开
        ui.toolDetails.set(`t${totalTools}`, { input: { ...input } })
        if (thinkSpinner) thinkSpinner.text = `Running ${name}...`
        const blockId = `t${totalTools}`
        ui.blockManager.addBlock('tool-call', fmt.toolCompactRunning(name, args))
        process.stderr.write(`\r\x1b[0K${fmt.toolCompactRunning(name, args)}\n`)
      },
      onToolResult: (name, ms, isError) => {
        totalTools++
        const args = pendingDiff?.path ? String(pendingDiff.path).slice(-40) : ''
        const line = isError
          ? fmt.toolCompactError(name, args, ms)
          : fmt.toolCompactDone(name, args, ms)
        // ANSI 上移一行覆盖运行态，写最终结果
        process.stderr.write(`\x1b[1A\r\x1b[0K${line}\n`)
        // diff 折叠
        if (!isError && pendingDiff) {
          try {
            const after = readFileSync(resolve(process.cwd(), pendingDiff.path), 'utf8')
            const d = renderDiff(pendingDiff.before, after, pendingDiff.path)
            if (d) {
              const lines = d.split('\n')
              const block = ui.blockManager.addBlock('tool-output', `  ● ${pendingDiff.path}`, lines)
              ui.blockManager.setPreview(block.id, lines.slice(0, 3))
              ui.blockManager.finalizeBlock(block.id)
            }
          } catch { /* skip diff */ }
        }
        // PostToolUse hooks
        const postActions = evaluatePostToolUse(ui.postToolHooks, name, pendingDiff ? { path: pendingDiff.path } : {})
        for (const act of postActions) {
          try {
            const cmd = expandHookCommand(act.command, pendingDiff ? { path: pendingDiff.path } : {})
            process.stderr.write(fmt.dim(`  ⚙ post-hook: ${act.note ?? cmd}\n`))
          } catch { /* skip */ }
        }
        pendingDiff = null
      },
    })
  } finally {
    stopThinking()
    stopBlinking()
    ui.lastReasoning = reasoningBuf
    if (!wasPaused) process.stdin.resume() // 恢复 REPL 输入
  }

  if (streaming) write('\n') // 末轮流式文本收尾换行

  const elapsed = Date.now() - startTime
  const outTokens = session.usage.outputTokens
  const summary = fmt.summary(outTokens, totalTools, elapsed)
  ui.lastTurnSummary = summary
  process.stderr.write(summary + '\n')
  if (ui.hasRepl) process.stderr.write('\x1b[?25h') // 恢复光标给 REPL
}

const program = new Command()
program
  .name('floom')
  .version(VERSION, '-v, --version', 'output the floom version')
  .argument(
    '[task...]',
    'task for the agent; omit to enter interactive mode',
  )
  .option(
    '-m, --model <id>',
    'model id',
    process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
  )
  .option(
    '-e, --effort <level>',
    'reasoning effort: high/max enables thinking mode (defaults to base model)',
  )
  .option(
    '--yolo',
    'disable safety guards: allow any file path and run shell without confirmation',
  )
  .option(
    '--verbose',
    'stream model thinking/CoT live (default: collapsed; toggle with Ctrl-O in the REPL)',
  )
  .option(
    '--plan',
    'start in plan mode: read-only; the agent proposes a plan for approval before changes',
  )
  .option(
    '-r, --resume [id]',
    'resume a previous session (most recent if no id) in interactive mode',
  )
  .option('-C, --cwd <dir>', 'project directory (default: current working directory)')
  .option('--list-sessions', 'list saved sessions for this project and exit')
  .action(
    async (
      task: string[],
      opts: {
        model: string
        effort?: string
        yolo?: boolean
        verbose?: boolean
        plan?: boolean
        resume?: string | boolean
        listSessions?: boolean
        cwd?: string
      },
    ) => {
      // 切换到指定项目目录（-C / --cwd），后续所有 process.cwd() 引用自动指向该目录
      if (opts.cwd) {
        try {
          process.chdir(resolve(opts.cwd))
        } catch (e) {
          process.stderr.write(fmt.red(`ERROR: cannot access directory "${opts.cwd}": ${(e as Error).message}\n`))
          process.exitCode = 1
          return
        }
      }

      const store = sessionStore()
      if (opts.listSessions) {
        printSessions(store)
        return
      }

      const resuming = opts.resume !== undefined
      const yolo = Boolean(opts.yolo)
      let settings: ReturnType<typeof loadSettings>
      try { settings = loadSettings(process.cwd()) } catch {
        settings = { maxTokens: 8192, contextTokens: 0, autoCompact: true, sandbox: 'isolated' } as any
        process.stderr.write(fmt.yellow('⚠ Settings error — using defaults\n'))
      }
      // --effort high/max → 切到 FLOOM_REASONER_MODEL 指定的 thinking+工具模型（未配置则告警回退）
      const effort = resolveEffortModel(opts.model, opts.effort, REASONER_MODEL)
      const effectiveModel = effort.model
      if (effort.warning) process.stderr.write(fmt.yellow('⚠ ' + effort.warning + '\n'))
      // resume 总是进入交互式；否则有 task 即一次性、无 task 进 REPL
      const interactive = task.length === 0 || resuming
      // 非 yolo + 有 TTY 时可逐条确认 shell；否则（管道/CI）shell 兜底拒绝
      const canPrompt = !yolo && Boolean(process.stdin.isTTY)
      // 能否弹出批准菜单：只取决于 TTY（与 --yolo 无关——批准菜单是独立 UI）。计划模式据此门控。
      const canApprove = Boolean(process.stdin.isTTY)
      // 计划模式：只读调研→出计划→批准后再执行。需可弹批准菜单（TTY），否则会卡死无法退出，
      // 故 --plan 仅在 interactive + canApprove 时生效；请求了但无 TTY 则告警忽略。
      const planState = { active: interactive && canApprove && Boolean(opts.plan) }
      if (opts.plan && interactive && !canApprove) {
        process.stderr.write(fmt.yellow('⚠ plan mode needs an interactive terminal; ignoring --plan\n'))
      }
      // 后台 shell 管理器（run_shell background:true / bash_output / kill_shell）。会话级单例，
      // 父 + 子 agent 共享；退出时 killAll 清理仍在跑的进程。
      const shells = new BackgroundShells()
      // PreToolUse hooks（.floom/hooks.json）：在工具执行前 allow/deny/ask 的策略闸。
      const hooks = loadHooks(process.cwd())

      // 详情显隐：默认折叠，ctrl+o 逐个展开折叠块，ctrl+e 展开全部。
      const ui: UiState = {
        verbose: Boolean(opts.verbose),
        lastReasoning: '',
        lastTurnSummary: '',
        hasRepl: interactive,
        blockManager: new BlockManager(),
        postToolHooks: hooks.PostToolUse ?? [],
        toolDetails: new Map(),
      }

      const onExpand = (mode: 'one' | 'all') => {
        const idx = mode === 'all' ? 0 : ui.blockManager.firstCollapsedIndex()
        if (idx === -1 || (mode === 'one' && !ui.blockManager.expandOne())) {
          return
        }
        if (mode === 'all') ui.blockManager.expandAll()

        process.stderr.write('\x1b[?25l')
        // ANSI 原位展开：上移到第一个折叠块，+2 补齐摘要行和状态栏
        const upLines = ui.blockManager.cursorDelta(idx) + 2
        if (upLines > 0) process.stderr.write(`\x1b[${upLines}A`)
        process.stderr.write('\r\x1b[J') // 清除从光标到屏幕底
        const rendered = ui.blockManager.renderFrom(idx, false)
        for (const line of rendered) process.stderr.write(line + '\n')
        process.stderr.write('\x1b[?25h')
      }

      // 交互模式用自建行编辑器（/ 下拉补全 + ctrl+o + raw-mode 行编辑）；非 TTY 自动降级为
      // readline 逐行读取。一次性模式无需提示符。shell 确认由 selectMenu 自管 stdin。
      const reader = interactive
        ? new ReplReader({
            out: process.stderr,
            promptText: () => (planState.active ? '❯(plan) ' : '❯ '),
            colorPrompt: (s: string) => fmt.white(s),
            onExpand,
          })
        : null

      // 加载命令历史
      if (reader) {
        reader.loadHistory(resolve(homedir(), '.floom', 'history.json'))
      }

      // 默认：文件工具限定在当前工作目录内；敏感文件防护始终生效（--yolo 不绕过）。
      const confined: PathPolicy = yolo ? allowAllPaths : confineToRoot(process.cwd())
      const readPaths: PathPolicy = denySecrets(confined) // denySecrets 始终生效
      const writePaths: PathPolicy = confined
      const shell: ShellPolicy = yolo
        ? allowAllShell
        : canPrompt
          ? makeInteractiveShell()
          : denyAllShell

      const session = makeSession(effectiveModel, { readPaths, writePaths, shell, allowPrivateNet: yolo }, shells)

      // 计划模式开关会改变 system（注入"只读调研、先出计划"须知）；切模型/档位时也要据当前 plan 状态重算。
      let refreshSystem = () => {
        session.system = makeSystem(session.model, planState.active)
      }
      refreshSystem() // 应用 --plan 启动态（若开）

      // —— 记忆系统 ——
      const memoryStore = new MemoryStore(process.cwd())
      const allMemories = memoryStore.loadAll()
      if (allMemories.length > 0) {
        // 将记忆注入 system prompt
        const recall = formatRecall(allMemories)
        session.system += recall
        process.stderr.write(
          fmt.dim(`  🧠 loaded ${allMemories.length} memor${allMemories.length === 1 ? 'y' : 'ies'}\n`),
        )
      }
      // 注册 remember 工具，让 agent 主动管理记忆
      session.registry.register(makeRememberTool(memoryStore))
      // Git 工具
      session.registry.register(makeGitDiffTool())
      session.registry.register(makeGitLogTool())
      session.registry.register(makeGitBranchTool())
      // Git commit 用独立 shell policy 实例——避免「bash 不再询问」泄漏到 commit 确认
      const gitCommitShell = yolo ? allowAllShell : canPrompt ? makeInteractiveShell('git-commit ') : denyAllShell
      session.registry.register(makeGitCommitTool(gitCommitShell))
      session.registry.register(makeGitStatusTool())
      session.registry.register(makeGitStashTool())
      session.registry.register(makeGitWorktreeTool())
      session.registry.register(makeGitFetchTool())
      session.registry.register(makeGitPushTool(gitCommitShell))
      session.registry.register(makeGitPullTool(gitCommitShell))
      session.registry.register(makeGitMergeTool())
      session.registry.register(makeGitRebaseTool(gitCommitShell))
      session.registry.register(makeGitResetTool(gitCommitShell))
      session.registry.register(makeGitRevertTool())
      session.registry.register(makeGitBlameTool())
      session.registry.register(makeGitTagTool())
      session.registry.register(makeGitBisectTool())
      // Task 系统
      const taskStore = new TaskStore(process.cwd())
      session.registry.register(makeTaskCreateTool(taskStore))
      session.registry.register(makeTaskUpdateTool(taskStore))
      session.registry.register(makeTaskListTool(taskStore))
      // Cron 定时任务
      const cronStore = new CronStore(resolve(process.cwd(), '.floom', 'cron.db'))
      const cronScheduler = new CronScheduler(cronStore, (entry) => {
        // 定时触发：把任务作为普通 prompt 注入 REPL 或记录到 stderr
        process.stderr.write(fmt.dim(`\n  ⏰ cron: ${entry.id} → "${entry.prompt.slice(0, 60)}"\n`))
      })
      cronScheduler.start()
      session.registry.register(makeCronCreateTool(cronScheduler, cronStore))
      session.registry.register(makeCronListTool(cronScheduler))
      session.registry.register(makeCronDeleteTool(cronScheduler))
      // 刷新 system 的函数现在还要拿记忆，用闭包保留 memoryStore 引用
      const origRefreshSystem = refreshSystem
      refreshSystem = () => {
        origRefreshSystem()
        const mems = memoryStore.loadAll()
        if (mems.length > 0) session.system += formatRecall(mems)
      }

      const hookCount = (hooks.PreToolUse ?? []).length
      if (hookCount > 0) {
        process.stderr.write(fmt.dim(`  ⚙ loaded ${hookCount} PreToolUse hook(s) from .floom/hooks.json\n`))
      }
      // PreToolUse 闸工厂。label 标注来源（子 agent 用 'sub-agent '），让 ask 提示显示授权对象。
      const makeGate = (label = ''): ToolGate => async (name, input) => {
        // 计划模式优先：拦掉一切有副作用的工具，提示模型先调研、调 exit_plan_mode。
        const pm = planModeGate(planState.active, name)
        if (!pm.allow) return pm
        const res = evaluatePreToolUse(hooks.PreToolUse, name, input)
        if (res.decision === 'deny') {
          auditLog({ decision: 'deny', tool: name, input: JSON.stringify(input).slice(0, 200) })
          return { allow: false, message: res.messages.join('; ') || 'denied by PreToolUse hook' }
        }
        if (res.decision === 'ask') {
          if (!canPrompt) return { allow: false, message: 'PreToolUse hook requires confirmation but no TTY' }
          stopActiveSpinner()
          const detail = String(input.path ?? input.command ?? input.url ?? '')
          const lines = [fmt.yellow(`⚙ ${label}hook: confirm ${name}?`)]
          if (res.messages.length) lines.push('  ' + fmt.dim(res.messages.join('; ')))
          if (detail) lines.push('  ' + fmt.cyan(detail.length > 200 ? detail.slice(0, 200) + '…' : detail))
          lines.push('')
          const choice = await selectMenu(lines, [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ])
          auditLog({ decision: 'ask', tool: name, input: JSON.stringify(input).slice(0, 200), userChoice: choice === 0 ? 'yes' : 'no' })
          return { allow: choice === 0 }
        }
        return { allow: true } // allow / none → 放行（仍受既有权限层约束）
      }
      session.gate = makeGate()

      // 状态栏
      const status = createStatusBar()
      status.model = effectiveModel
      status.planMode = planState.active
      const updateStatus = () => {
        status.model = session.model
        status.inputTokens = session.usage.inputTokens
        status.outputTokens = session.usage.outputTokens
        status.cacheHitTokens = session.usage.cacheHitTokens
        status.planMode = planState.active
        const sb = renderStatusBar(status)
        if (sb) process.stderr.write(sb + '\n')
      }

      // MCP servers（.floom/mcp.json）：连接后把其工具注册进 registry，agent 像用内置工具一样用它们。
      // 无配置 = 不 spawn 任何进程 = 零行为变化。单个 server 失败只告警跳过。
      const mcpConfig = loadMcpConfig(process.cwd())
      let mcpClose: () => Promise<void> = async () => {}
      const mcpTools: Tool[] = [] // 供子 agent 复用（dispatch_agent 的 buildRegistry）
      const mcpNames = Object.keys(mcpConfig.mcpServers)
      if (mcpNames.length > 0) {
        process.stderr.write(fmt.dim(`  ⌁ connecting ${mcpNames.length} MCP server(s)…\n`))
        const conn = await connectMcpServers(mcpConfig, {
          clientVersion: VERSION,
          onLog: (s) => process.stderr.write(fmt.yellow('  ⚠ ' + s + '\n')),
        })
        for (const t of conn.tools) {
          session.registry.register(t)
          mcpTools.push(t)
        }
        mcpClose = conn.close
        for (const line of conn.summary) process.stderr.write(fmt.dim(`  ⌁ MCP ${line}\n`))
      }

      // 子 agent（dispatch_agent）：主 agent 可派发隔离子 agent 处理自包含子任务。
      // 子 agent 工具集 = 同款基础工具 + MCP（共享同一权限策略/shell 审批状态），但**不含
      // dispatch_agent**（递归隔离，深度封顶 1）。gate 与父级同款（hooks 对子 agent 同样生效）。
      let subDepth = 0 // 嵌套进度缩进/spinner 复位用
      // 子 agent 的后台 shell 用**独立实例**，dispatch 结束即 killAll——子 agent 不该留下
      // 父 agent 看不见、控制不了的后台进程（句柄只在子 agent 自己的上下文里）。dispatch 串行执行。
      let subShells: BackgroundShells | null = null
      session.registry.register(
        makeDispatchAgentTool({
          client: session.client,
          buildRegistry: () => {
            // 子 agent 用**独立 shell 策略实例**（fresh makeInteractiveShell）：在子 agent 里选
            // 「不再询问」只对该子 agent 生效，不泄漏到父 agent 或后续子 agent（信任边界隔离）。
            // 路径策略是无状态纯函数，可安全共享。
            const subShell: ShellPolicy = yolo
              ? allowAllShell
              : canPrompt
                ? makeInteractiveShell('sub-agent ')
                : denyAllShell
            subShells = new BackgroundShells()
            const reg = makeRegistry({ readPaths, writePaths, shell: subShell, allowPrivateNet: yolo }, subShells)
            for (const t of mcpTools) reg.register(t)
            return reg // 不注册 dispatch_agent → 子 agent 无法再派发
          },
          system: makeSubAgentSystem(effectiveModel),
          model: effectiveModel,
          maxTokens: MAX_TOKENS,
          contextTokens: CONTEXT_TOKENS,
          gate: makeGate('sub-agent '), // 子 agent 的 hooks 闸标注来源
          onActivity: (a) => {
            if (a.kind === 'tool') {
              if (subDepth === 0) {
                stopActiveSpinner()
                process.stderr.write(fmt.dim('  ╭─ sub-agent\n'))
                subDepth = 1
              }
              const ms = a.ms ? fmt.dim(` (${(a.ms / 1000).toFixed(1)}s)`) : ''
              const err = a.isError ? fmt.red(' ✗') : ''
              process.stderr.write(fmt.dim(`  ├─ ${a.name ?? 'tool'}${err}${ms}`) + '\n')
            } else if (a.kind === 'tool-done') {
              // tool-done events are suppressed — final status shown inline above
            } else if (a.kind === 'done') {
              if (subDepth === 0) stopActiveSpinner()
              const icon = a.isError ? fmt.red('  ╰─ failed') : fmt.green('  ╰─ done')
              process.stderr.write(
                icon + fmt.dim(` · ${a.tools ?? 0} tools · ${a.tokens ?? 0} tok · ${((a.ms ?? 0) / 1000).toFixed(1)}s`) + '\n',
              )
              subDepth = 0
              subShells?.killAll()
              subShells = null
            }
          },
          onUsage: (u) => {
            session.usage.inputTokens += u.inputTokens
            session.usage.outputTokens += u.outputTokens
            session.usage.cacheHitTokens += u.cacheHitTokens
          },
        }),
      )

      // exit_plan_mode：计划模式下模型调研完后提交计划；用户方向键批准则关计划模式、解锁全工具。
      let lastPlanText = ''
      session.registry.register(
        makeExitPlanModeTool({
          active: () => planState.active,
          propose: async (plan) => {
            if (!canApprove) return false
            stopActiveSpinner()
            lastPlanText = plan
            process.stderr.write('\n' + fmt.bold('  ✦ Proposed plan') + '\n')
            for (const line of plan.split('\n')) process.stderr.write(fmt.cyan('  │ ') + line + '\n')
            process.stderr.write('\n')
            const choice = await selectMenu(
              [fmt.yellow('Proceed with this plan?'), ''],
              [
                { label: 'Approve & execute', value: 'approve' },
                { label: 'Keep planning (revise)', value: 'keep' },
              ],
            )
            return choice === 0
          },
          onApproved: () => {
            planState.active = false
            refreshSystem()
            // 保存计划到 .floom/plan-{sessionId}.md
            try {
              const planPath = resolve(process.cwd(), '.floom', `plan-${sessionId}.md`)
              mkdirSync(dirname(planPath), { recursive: true })
              writeFileSync(planPath, `# Plan: ${title || 'Untitled'}\n\n${lastPlanText}\n`, 'utf8')
              process.stderr.write(fmt.dim(`  📋 plan saved to .floom/plan-${sessionId}.md\n`))
            } catch { /* 落盘失败不影响主流程 */ }
            process.stderr.write(fmt.green('  ✦ plan approved — executing\n'))
          },
        }),
      )

      // OS 级中断（Ctrl-C / kill）兜底清理。用 cleanedUp 标志防止信号处理器
      // 与 finally 块并发执行双重清理。
      let cleanedUp = false
      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        shells.killAll()
        void mcpClose()
      }
      const onSignal = (sig: NodeJS.Signals, exitCode: number) => {
        cleanup()
        process.stderr.write(fmt.dim(`\n  ↘ ${sig} — cleaned up background processes, exiting\n`))
        process.exit(exitCode)
      }
      process.once('SIGINT', () => onSignal('SIGINT', 130))
      process.once('SIGTERM', () => onSignal('SIGTERM', 143))

      // 会话身份：resume 时载入历史，否则新建
      let sessionId: string
      let createdAt: string
      let title = ''
      if (resuming) {
        const id = typeof opts.resume === 'string' ? opts.resume : undefined
        const saved = id ? store.load(id) : store.latest()
        if (!saved) {
          process.stderr.write(
            fmt.red(id ? `No session "${id}" found in this project.\n` : 'No session to resume.\n'),
          )
          reader?.close()
          process.exitCode = 1
          return
        }
        session.messages = saved.messages
        session.usage = saved.usage
        sessionId = saved.id
        createdAt = saved.createdAt
        title = saved.title
      } else {
        sessionId = makeSessionId()
        createdAt = new Date().toISOString()
      }

      // 自动清理旧会话（保留最近 50 个）
      try { store.cleanOldSessions(50) } catch { /* 清理失败不影响主流程 */ }

      // 一次性模式（给了 task 且非 resume）：跑完即走，不落盘
      if (!interactive) {
        try {
          await runTurnWithUI(session, task.join(' '), (d) => process.stdout.write(d), ui)
          process.stdout.write('\n')
        } finally {
          // 即使 runTurn 抛错（网络/API 错误）也要清理后台进程，绝不留孤儿
          cleanup()
          reader?.close()
        }
        return
      }

      const persist = (): boolean => {
        try {
          store.save({
            id: sessionId,
            createdAt,
            updatedAt: new Date().toISOString(),
            model: session.model, // 可能被 /model、/effort 改过，取实时值
            cwd: process.cwd(),
            title,
            messages: session.messages,
            usage: session.usage,
          })
          return true
        } catch {
          return false // 落盘失败不影响交互
        }
      }

      // REPL：响应文本走 stderr，避免和 readline 的 stdout 争用
      const write = (d: string) => process.stderr.write(d)
      if (yolo) {
        process.stderr.write(
          fmt.yellow('⚠ --yolo: path confinement and shell confirmation disabled\n'),
        )
      }
      // 首次运行向导：API key 未配置时交互式引导
      const key = process.env.DEEPSEEK_API_KEY
      if (!key && interactive) {
        process.stderr.write(fmt.yellow('\n  ⚡ First run detected — let\'s configure your API key.\n'))
        process.stderr.write(fmt.dim('  Get a key at https://platform.deepseek.com/api_keys\n'))
        process.stderr.write(fmt.dim('  Paste your key below (input hidden):\n  > '))
        // 简易隐藏输入：切换 raw mode 逐字符读取
        try {
          const { ReplReader } = await import('./cli/repl-input.js')
          const r = new ReplReader({ out: process.stderr, promptText: '' })
          const input = await r.question()
          r.close()
          const trimmed = (input ?? '').trim()
          if (trimmed) {
            const envPath = join(homedir(), '.floom', '.env')
            try { mkdirSync(dirname(envPath), { recursive: true }) } catch {}
            const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
            const quoted = JSON.stringify(trimmed) // 安全转义 $ ` " # 等特殊字符
            const hasKey = /^DEEPSEEK_API_KEY=/m.test(existing)
            const content = hasKey
              ? existing.replace(/^DEEPSEEK_API_KEY=.*/m, () => `DEEPSEEK_API_KEY=${quoted}`)
              : existing + `\nDEEPSEEK_API_KEY=${quoted}\n`
            writeFileSync(envPath, content, 'utf8')
            process.env.DEEPSEEK_API_KEY = trimmed
            process.stderr.write(fmt.green('  ✓ API key saved to ~/.floom/.env\n\n'))
          }
        } catch { /* 向导失败不阻止启动 */ }
      } else if (!key) {
        process.stderr.write(fmt.red('\n⚠ NO API KEY — set DEEPSEEK_API_KEY in ~/.floom/.env or .env\n\n'))
      }
      showWelcome({
        version: VERSION,
        model: effectiveModel,
        nodeVersion: process.versions.node,
        cwd: process.cwd(),
        isInteractive: true,
        safety: yolo
          ? 'guards OFF (--yolo)'
          : canPrompt
            ? 'confined to CWD · shell asks'
            : 'confined to CWD · shell off',
      })
      if (effort.reasoning) {
        process.stderr.write(
          fmt.dim(`  ✻ effort=${opts.effort} · reasoning model ${effectiveModel}\n`),
        )
      }
      if (resuming) {
        process.stderr.write(
          fmt.dim(`  ↩ resumed ${sessionId} · ${session.messages.length} messages\n`),
        )
      }
      if (planState.active) {
        process.stderr.write(
          fmt.dim('  ✦ plan mode ON — read-only; I will propose a plan before changes (/plan to toggle)\n'),
        )
      }
      process.stderr.write(fmt.dim('  Type /help for slash commands.\n'))

      // slash 命令的副作用边界：把活动会话/存储包装成 ctx 注入纯路由器
      let currentEffort = opts.effort
      const swapModel = (id: string) => {
        session.client = getFactory().createClient(id)
        session.model = id
        refreshSystem() // 据当前 plan 状态重算 system（换模型不应丢掉计划模式须知）
      }
      const slashCtx: SlashContext = {
        getModel: () => session.model,
        setModel: (id) => { swapModel(id); currentEffort = undefined },
        getEffort: () => currentEffort,
        applyEffort: (level) => {
          const res = resolveEffortModel(opts.model, level, REASONER_MODEL)
          swapModel(res.model)
          currentEffort = res.reasoning ? level : undefined
          return res.warning ?? `effort=${level} · model ${res.model}`
        },
        isPlanMode: () => planState.active,
        // 开启需可弹批准菜单（TTY）；否则会卡死无法退出，故拒绝开启（关闭总是允许）。
        setPlanMode: (on) => { planState.active = on && canApprove; refreshSystem() },
        messageCount: () => session.messages.length,
        getUsage: () => session.usage,
        clearHistory: () => {
          const n = session.messages.length
          session.messages = []
          return n
        },
        save: () => persist(),
        listSessions: () => sessionsText(store),
        showSessionMenu: async () => {
          const { showSessionMenu } = await import('./cli/session-factory.js')
          return showSessionMenu(store, {})
        },
        getSettings: () => describeSettings(settings),
        saveSetting: (key, value) => saveSetting(process.cwd(), key, value),
        resetSettings: () => resetSettings(process.cwd()),
        listMemories: () => {
          const mems = memoryStore.list()
          if (mems.length === 0) return fmt.dim('No memories stored.')
          return fmt.bold(`Memories (${mems.length}):`) + '\n' +
            mems.map(m => `  ${fmt.cyan(m.name)}  ${fmt.dim(`(${m.type})`)}  ${m.description}`).join('\n')
        },
        listCronJobs: () => {
          const jobs = cronScheduler.list()
          if (jobs.length === 0) return fmt.dim('No scheduled cron jobs.')
          return jobs.map(j =>
            `  ${j.id}  ${j.expr}  →  "${j.prompt.slice(0, 60)}"  next: ${j.nextRun.slice(0, 19)}`
          ).join('\n')
        },
        toggleStatus: () => { status.show = !status.show; return status.show },
      }

      let retryLine = ''
      let turnNum = 0
      try {
        for (;;) {
          let line: string
          const slashRetry = retryLine && retryLine !== '/retry' ? runSlash('/retry', slashCtx) : null
          if (slashRetry?.handled && slashRetry.retry) {
            line = retryLine
            retryLine = ''
            process.stderr.write(fmt.dim(`  ↻ retrying: ${line.slice(0, 80)}\n`))
          } else {
            const raw = await reader!.question()
            if (raw === null) break
            line = raw.trim()
            if (line === '') continue
          }
          const slash = runSlash(line, slashCtx)
          if (slash.handled) {
            if (slash.exit) break
            if (slash.retry) {
              if (line !== '/retry') retryLine = line
              continue
            }
            if (slash.interactiveSessions) {
              try { const r = await slashCtx.showSessionMenu!(); if (r) process.stderr.write(r + '\n') } catch {}
              continue
            }
            if (slash.skill) {
              const skill = skillRegistry.get(slash.skill)
              if (skill) {
                process.stderr.write(fmt.dim(`  ⚡ ${skill.name}: ${skill.description}\n`))
                const savedSystem = session.system
                // 工具过滤：readOnly 或 toolAllowlist → 只暴露允许的工具
                const allowlist = skillRegistry.getToolAllowlist(slash.skill)
                const savedRegistry = allowlist ? session.registry : null
                if (allowlist) {
                  const filtered = new ToolRegistry()
                  for (const name of allowlist) {
                    const t = session.registry.get(name)
                    if (t) filtered.register(t)
                  }
                  session.registry = filtered
                }
                try {
                  // 技能参数化：${args} / ${1} ${2} ... 替换
                  let prompt = skill.systemPrompt
                  if (slash.skillArgs) {
                    const argsArr = slash.skillArgs.split(/\s+/).filter(Boolean)
                    prompt = prompt.replace(/\$\{args\}/g, () => slash.skillArgs!)
                    argsArr.forEach((a, i) => { prompt = prompt.replace(new RegExp(`\\$\\{${i + 1}\\}`, 'g'), () => a) })
                  }
                  session.system = prompt
                  try {
                    await runTurnWithUI(session, `${line}`, write, ui)
                  } catch (e) {
                    process.stderr.write(fmt.red(`\n  ✗ ${formatApiError(e)}\n`))
                  }
                } finally {
                  session.system = savedSystem
                  if (savedRegistry) session.registry = savedRegistry
                }
              } else {
                process.stderr.write(fmt.yellow(`  ⚠ unknown skill: /${slash.skill}\n`))
              }
              continue
            }
            if (slash.compact) {
              if (session.messages.length === 0) {
                process.stderr.write(fmt.dim('  nothing to compact (no history yet)\n'))
                continue
              }
              process.stderr.write(fmt.dim('  🗜 compacting conversation…\n'))
              try {
                // 网络错误重试一次，模型拒绝不重试
                const doCompact = async () => compactMessages({
                  client: session.client,
                  system: session.system,
                  messages: session.messages,
                  tools: session.registry.specs(),
                  model: session.model,
                  budget: 0,
                  maxTokens: session.maxTokens,
                  keepLastRounds: 1,
                })
                let c = await doCompact().catch((e) => {
                  // 网络错误（无 HTTP 状态码）→ 重试一次；模型拒绝（4xx）→ 直接失败
                  const status = (e as any)?.status ?? (e as any)?.response?.status
                  const code = (e as any)?.code ?? ''
                  const netErr = !status && (
                    code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
                    code === 'ENOTFOUND' || code === 'ECONNRESET'
                  )
                  if (netErr) return null
                  throw e
                })
                if (c === null) {
                  process.stderr.write(fmt.dim('  🗜 retrying after network error…\n'))
                  c = await doCompact()
                }
                if (c) {
                  session.system = c.system
                  session.messages = c.messages
                  process.stderr.write(
                    fmt.dim(`  🗜 compacted ${c.summarizedRounds} round(s) into a summary · ~${c.estimatedTokens} tok kept\n`),
                  )
                  persist()
                } else {
                  process.stderr.write(fmt.dim('  nothing to compact (need at least 2 exchanges)\n'))
                }
              } catch (e) {
                process.stderr.write(fmt.red(`  ✗ compact failed: ${formatApiError(e)}\n`))
              }
              continue
            }
            if (slash.output) process.stderr.write(fmt.dim(slash.output) + '\n')
            if (slash.mutated) persist()
            continue
          }
          try {
            turnNum++
            if (turnNum > 1) process.stderr.write(fmt.dim(`\n  ── turn ${turnNum} ──\n`))
            await runTurnWithUI(session, line, write, ui)
          } catch (e) {
            process.stderr.write(fmt.red(`\n  ✗ ${(e as Error).message ?? String(e)}\n`))
            if (session.messages.length > 0) {
              // 移除本次出错的 user 消息，保持状态一致
              const last = session.messages[session.messages.length - 1]
              if (last.role === 'user') session.messages.pop()
            }
          }
          process.stdout.write('\n')
          if (!title) title = line.slice(0, 60)
          retryLine = line // 保存以供 /retry
          persist()
          updateStatus()
        }
      } finally {
        // 任何路径退出（正常 / runTurn 抛错）都清理：关后台进程、关 MCP、关 reader
        reader!.saveHistory(resolve(homedir(), '.floom', 'history.json'))
        reader!.close()
        cleanup()
      }
    },
  )

program
  .command('run <script>')
  .description('run a workflow script')
  .option('-C, --cwd <dir>', 'project directory')
  .option('-b, --budget <n>', 'token budget', '1000000')
  .option('-j, --journal <path>', 'journal database path', '.floom/journal.db')
  .option('-a, --args <json>', 'JSON args to pass to the script', '{}')
  .option(
    '-m, --model <id>',
    'model id',
    process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
  )
  .option('--sandbox <type>', 'sandbox type: isolated (default) or vm (requires --unsafe-sandbox)')
  .option('--unsafe-sandbox', 'allow node:vm as sandbox fallback (NOT a security sandbox)')
  .option('--workspace <dir>', 'custom workspace directory (default: temp dir)')
  .option('--no-cleanup', 'keep workspace directory after execution')
  .action(
    async (
      script: string,
      opts: {
        budget: string
        journal: string
        args: string
        model: string
        sandbox: string
        workspace?: string
        cleanup: boolean
        cwd?: string
      },
    ) => {
      if (opts.cwd) {
        try { process.chdir(resolve(opts.cwd)) } catch (e) {
          process.stderr.write(fmt.red(`ERROR: cannot access "${opts.cwd}": ${(e as Error).message}\n`))
          process.exit(1)
        }
      }
      // 工作流是开发者显式编写的批处理脚本，且已有独立的临时 Workspace 隔离，
      // 不适合逐条确认 shell，也不能把文件工具限死在 cwd（会拦住 workspace 临时目录写入）。
      const registry = makeRegistry({ readPaths: allowAllPaths, writePaths: allowAllPaths, shell: allowAllShell, allowPrivateNet: true })
      const client = getFactory().createClient(opts.model)
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(opts.args)
      } catch {
        process.stderr.write(
          fmt.yellow('WARNING: ') + 'invalid --args JSON, using {}\n',
        )
      }

      let runtime: NodeVmRuntime | IsolatedVmRuntime | undefined
      const sandboxType = (opts.sandbox ?? 'isolated').toLowerCase()
      if (sandboxType === 'vm') {
        if (!(opts as any).unsafeSandbox) {
          process.stderr.write(fmt.red('ERROR: --sandbox vm requires --unsafe-sandbox flag (node:vm is NOT secure)\n'))
          process.exit(1)
        }
        runtime = new NodeVmRuntime()
      } else if (sandboxType !== 'isolated') {
        process.stderr.write(fmt.red(`ERROR: invalid --sandbox "${opts.sandbox}". Valid: isolated, vm\n`))
        process.exit(1)
      } else {
        try {
          runtime = await IsolatedVmRuntime.create()
        } catch {
          if ((opts as any).unsafeSandbox) {
            process.stderr.write(fmt.yellow('WARNING: isolated-vm not available, falling back to node:vm (--unsafe-sandbox enabled)\n'))
            runtime = new NodeVmRuntime()
          } else {
            process.stderr.write(fmt.red('ERROR: isolated-vm is not installed. Install with: npm install isolated-vm\n'))
            process.stderr.write(fmt.dim('       Or pass --unsafe-sandbox to use node:vm (NOT a security sandbox).\n'))
            process.exit(1)
          }
        }
      }

      const result = await executeWorkflow({
        scriptPath: resolve(script),
        args,
        client,
        registry,
        journalPath: (() => {
          mkdirSync(dirname(resolve(opts.journal)), { recursive: true })
          return opts.journal
        })(),
        budgetLimit: (Number.isFinite(Number(opts.budget)) ? Number(opts.budget) : 1_000_000),
        model: opts.model,
        system: makeSystem(opts.model),
        runtime,
        forceReload: true,
      })

      if (result.status === 'done') {
        if (result.result !== undefined) {
          const out =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result, null, 2)
          console.log(out)
        }
        process.stderr.write(
          fmt.dim(
            `  live=${result.liveCalls} cached=${result.cachedCalls} · budget=${result.usage.outputTokens}\n`,
          ),
        )
      } else {
        process.stderr.write(fmt.red(`ERROR: ${result.error}\n`))
        process.exit(1)
      }
    },
  )

// 顶层错误兜底：action 的 try/finally 已做清理，这里只负责把错误打出来并以非零码退出，
// 避免 unhandled promise rejection 的难看堆栈。
program.parseAsync().catch((err: unknown) => {
  process.stderr.write(fmt.red(`\nERROR: ${err instanceof Error ? err.message : String(err)}\n`))
  process.exitCode = 1
})
