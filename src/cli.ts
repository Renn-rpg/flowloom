#!/usr/bin/env node
// ⚠ 必须是第一个 import：先加载 .env，使 session-factory 等在 import 期求值的环境常量
// （CONTEXT_TOKENS / MAX_TOKENS / REASONER_MODEL）能读到 .env 覆盖。详见 load-env.ts。
import './load-env.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { resolve, dirname, basename } from 'node:path'
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
import { runSlash, parseReplDirective, takeReplInput, type SlashContext } from './cli/commands.js'
import { execShell } from './tools/bash.js'
import { BackgroundShells } from './tools/shell-manager.js'
import { ToolRegistry } from './tools/registry.js'
import { loadHooks, evaluatePreToolUse, evaluatePostToolUse, expandHookCommand } from './hooks/engine.js'
import { loadMcpConfig } from './mcp/config.js'
import { connectMcpServers } from './mcp/manager.js'
import { runTurn, type ToolGate } from './agent/loop.js'
import { compactMessages } from './agent/compaction.js'
import { makeDispatchAgentTool } from './agent/subagent.js'
import { makeDispatchAgentsTool } from './agent/dispatch-many.js'
import { AgentTracker } from './cli/agent-tracker.js'
import { makeExitPlanModeTool, planModeGate } from './agent/plan.js'
import type { Tool } from './tools/types.js'
import { SessionStore } from './agent/session-store.js'
import { executeWorkflow } from './workflow/workflow-runtime.js'
import { makeWorkflowTool } from './workflow/workflow-tool.js'
import type { WorkflowEvent } from './workflow/types.js'
import { NodeVmRuntime, IsolatedVmRuntime } from './workflow/sandbox.js'
import { createSpinner, stopActiveSpinner, stopBlinking } from './cli/spinner.js'
import { fmt, physicalRows } from './cli/format.js'
import { showWelcome } from './cli/welcome.js'
import { renderDiff } from './cli/diff.js'
import { createMarkdownStream, type MarkdownStream } from './cli/markdown.js'
import { createStatusBar, renderStatusBar } from './cli/status-bar.js'
import { Footer, supportsFooter, ctxWindow, composeStatusLine, composeModeLine, composeRunLine, type FooterState, type Mode } from './cli/footer.js'
import { runProgress, type RunGroup } from './cli/agent-tracker.js'
import { openWorkflowView, type WorkflowViewCtl } from './cli/workflow-view.js'
import { estimateTokens } from './agent/context.js'
import { BlockManager } from './cli/blocks.js'
import { MemoryStore, memorySlug, type MemoryEntry } from './memory/store.js'
import { formatRecall } from './memory/recall.js'
import { makeRememberTool } from './memory/tool.js'
import { skillRegistry } from './skills/registry.js'
import { codeReviewSkill } from './skills/builtin/code-review.js'
import { simplifySkill } from './skills/builtin/simplify.js'
import { architectSkill } from './skills/builtin/architect.js'
import { deepReviewSkill } from './skills/builtin/deep-review.js'
import { loadAllSkills } from './skills/fs-loader.js'
import { loadSettings, describeSettings, saveSetting, resetSettings } from './config/settings.js'
import { CronStore } from './cron/store.js'
import { CronScheduler } from './cron/scheduler.js'
import { formatApiError } from './model/retry.js'
import { getFactory } from './model/factory.js'
import { TaskStore } from './task/store.js'
import { registerGitTools, registerTaskTools, registerCronTools } from './cli/wiring.js'
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

const VERSION = '0.14.1'

// 会话工厂、工具注册、权限策略等核心构造逻辑已提取到 session-factory.ts。
// 以下仅保留 CLI 特有的输出函数 printSessions（写 stderr，依赖 sessionsText）。

function printSessions(store: SessionStore): void {
  process.stderr.write(sessionsText(store) + '\n')
}

// 改完后展示 diff 的工具
const DIFF_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file'])

// 设置终端窗口/标签标题(OSC 0)。仅 TTY 生效;传空串恢复默认。
function setTerminalTitle(s: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\x1b]0;${s}\x07`)
}
const idleTitle = () => `floom · ${basename(process.cwd()) || 'floom'}`

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
  // 中断装置（REPL+TTY 才传）：注册中断回调,返回 disarm()。模型输出期接管 stdin 监听 ESC/Ctrl-C。
  armInterrupt?: (onInterrupt: (kind: 'esc' | 'ctrl-c') => void) => () => void,
  // 重绘固定页脚（页脚启用时传 footer.paint）。内容区的 ED(\x1b[0J) 会擦到页脚，写完即重绘补回。
  repaintFooter?: () => void,
  // 「下一次 generate 前」闸：钻入视图打开期间挂起模型输出，防流式文本写进 alt 缓冲被吞。
  awaitOverlay?: () => Promise<void>,
) {
  const startTime = Date.now()
  // 终端标题:turn 进行中显示任务摘要(标签页可见在跑什么),结束在 finally 复位为 idle。
  if (ui.hasRepl) setTerminalTitle(`floom ⠿ ${task.replace(/\s+/g, ' ').trim().slice(0, 50)}`)
  // 模型输出期间：隐藏光标。可中断模式下接管 stdin 监听 ESC(打断本轮)/Ctrl-C(退出);
  // 否则(一次性/管道)简单暂停 stdin 防 Enter 干扰。
  process.stderr.write('\x1b[?25l')
  const turnAbort = new AbortController()
  let interrupted = false
  const wasPaused = process.stdin.isPaused()
  let disarmInterrupt: (() => void) | null = null
  if (armInterrupt) {
    disarmInterrupt = armInterrupt((kind) => {
      if (kind === 'esc') { interrupted = true; turnAbort.abort() }
      else {
        // Ctrl-C:raw 模式下不会自动触发 SIGINT。先 disarm 恢复 stdin(raw/echo),避免 process.exit
        // 后终端残留 raw 模式;再转交既有退出处理器(cleanup + exit)。
        if (disarmInterrupt) disarmInterrupt()
        ;(process.emit as (event: string, ...args: unknown[]) => boolean)('SIGINT')
      }
    })
  } else {
    process.stdin.pause() // 暂停 data 事件，不接收任何输入
  }
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
  // 运行态工具行占用的物理行数(窄终端/CJK 折行时 >1)；onToolResult 据此上移覆盖,避免错位。
  let runningRows = 1
  // —— Markdown 渲染：仅在 REPL + TTY 时把最终答案当 Markdown 渲染（标题/列表/强调/代码块）。
  // 一次性/管道模式（write 写 stdout，供程序消费）保持裸文本,不做结构变换。每个文本突发一个 stream，
  // 被工具调用/turn 结束打断时 flush 残余行。
  const useMarkdown = ui.hasRepl && Boolean(process.stderr.isTTY)
  let md: MarkdownStream | null = null
  const flushMd = () => { if (md) { md.end(); md = null } }

  try {
    await runTurn(session, task, {
      beforeGenerate: awaitOverlay,
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
          if (useMarkdown) md = createMarkdownStream({ write, prefix: '  ' })
          else write('  ')
        }
        if (md) md.push(delta)
        else write(delta.replace(/\n/g, '\n  ')) // 非 Markdown 路径：换行后保持缩进
      },
      onThinking: () => {
        flushMd() // 防御性：上一突发若未在工具调用处 flush，这里兜底
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
        if (streaming) { flushMd(); write('\n'); streaming = false }
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
        const runLine = fmt.toolCompactRunning(name, args)
        // 记下运行行的物理行数:窄终端/CJK 路径会折行,onToolResult 须按真实行数上移覆盖。
        runningRows = physicalRows(runLine, process.stderr.columns ?? 80)
        ui.blockManager.addBlock('tool-call', runLine)
        process.stderr.write(`\r\x1b[0K${runLine}\n`)
      },
      onToolResult: (name, ms, isError) => {
        totalTools++
        const args = pendingDiff?.path ? String(pendingDiff.path).slice(-40) : ''
        const line = isError
          ? fmt.toolCompactError(name, args, ms)
          : fmt.toolCompactDone(name, args, ms)
        if (name === 'dispatch_agent') {
          // 子 agent 在执行期已打印进度树,运行行不再紧邻光标——不上移覆盖,直接另起一行写结果。
          process.stderr.write(`${line}\n`)
        } else {
          // 上移到运行行顶部(运行行可能因窄终端/CJK 折行占多物理行)→ 清到屏幕底 → 写最终结果。
          process.stderr.write(`\x1b[${runningRows}A\r\x1b[0J${line}\n`)
        }
        runningRows = 1
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
        repaintFooter?.() // 工具行覆盖用了 \x1b[0J 会擦到页脚 → 补画
      },
    }, { signal: turnAbort.signal })
  } catch (e) {
    // 用户 ESC 打断:吞掉中断错误,走「已中断」收尾;其它错误照常上抛给 REPL 处理。
    if (turnAbort.signal.aborted) interrupted = true
    else throw e
  } finally {
    flushMd() // 任何退出路径(含异常中断)都 flush 已缓冲的 Markdown 行,避免丢字
    stopThinking()
    stopBlinking()
    ui.lastReasoning = reasoningBuf
    if (ui.hasRepl) setTerminalTitle(idleTitle()) // turn 结束:标题复位
    if (disarmInterrupt) disarmInterrupt() // 恢复 stdin 原状态(raw/listeners/paused)
    else if (!wasPaused) process.stdin.resume() // 恢复 REPL 输入
  }

  if (interrupted) {
    process.stderr.write(fmt.yellow('\n  ⎋ interrupted\n'))
    if (ui.hasRepl) process.stderr.write('\x1b[?25h') // 恢复光标给 REPL
    repaintFooter?.()
    // 弹出本次未应答的 user 消息,保持历史一致(与出错路径一致)
    const last = session.messages[session.messages.length - 1]
    if (last?.role === 'user') session.messages.pop()
    return
  }

  if (streaming) {
    flushMd() // md 路径:flush 最后一行(自带换行)
    if (!useMarkdown) write('\n') // 非 md 路径:补末轮流式文本的收尾换行
  }

  const elapsed = Date.now() - startTime
  const outTokens = session.usage.outputTokens
  const summary = fmt.summary(outTokens, totalTools, elapsed)
  ui.lastTurnSummary = summary
  process.stderr.write(summary + '\n')
  if (ui.hasRepl) process.stderr.write('\x1b[?25h') // 恢复光标给 REPL
  repaintFooter?.()
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
      // 模式三态（Shift+Tab 循环 normal→auto-accept→plan）。plan 用 planState.active（沿用既有 gate/
      // system 接线）；auto-accept 用独立标志（shell 自动放行）。两者互斥，由 cycleMode 协调。
      let autoAccept = false
      const currentMode = (): Mode => (planState.active ? 'plan' : autoAccept ? 'auto-accept' : 'normal')
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
        // ANSI 原位展开：上移到第一个折叠块，+2 补齐摘要行和状态栏。
        // 传列宽让 cursorDelta 计入折行(窄终端/CJK 路径下逻辑行会占多物理行,否则上移行数不足而错位)。
        const upLines = ui.blockManager.cursorDelta(idx, process.stderr.columns ?? 80) + 2
        if (upLines > 0) process.stderr.write(`\x1b[${upLines}A`)
        process.stderr.write('\r\x1b[J') // 清除从光标到屏幕底
        const rendered = ui.blockManager.renderFrom(idx, false)
        for (const line of rendered) process.stderr.write(line + '\n')
        process.stderr.write('\x1b[?25h')
        footer?.paint() // 原位展开用了 \x1b[J 会擦页脚 → 补画
      }

      // 交互模式用自建行编辑器（/ 下拉补全 + ctrl+o + raw-mode 行编辑）；非 TTY 自动降级为
      // readline 逐行读取。一次性模式无需提示符。shell 确认由 selectMenu 自管 stdin。
      const reader = interactive
        ? new ReplReader({
            out: process.stderr,
            // 面板开启时:mode 显示在框下方的「模式行」,提示符恒为 '❯ '(用户要求框里不再显示 mode)。
            // 面板关闭(/status off)或降级终端:把 mode 放进提示符,作为 Shift+Tab 切换的唯一可见反馈。
            promptText: () => {
              if (panelEnabled) return '❯ '
              const m = currentMode()
              return m === 'plan' ? '❯(plan) ' : m === 'auto-accept' ? '❯(auto) ' : '❯ '
            },
            colorPrompt: (s: string) => fmt.white(s),
            onExpand,
            onCycleMode: () => cycleMode(),
            // 输入态:把状态行+模式行画在输入框正下方(随框一起清/重绘),使其「永久可见、不只输出时出现」。
            panelLines: () => composePanel(),
          })
        : null

      // 加载命令历史
      if (reader) {
        reader.loadHistory(resolve(homedir(), '.floom', 'history.json'))
      }

      // 中断装置:仅在 REPL + TTY 时启用。模型输出期接管 stdin:ESC 打断本轮(并停掉在跑的并行 run)、
      // Ctrl-C 退出、↓ 进钻入视图(仅当有活动 run)、Shift+Tab 切模式。
      const armInterrupt: ((onInterrupt: (kind: 'esc' | 'ctrl-c') => void) => () => void) | undefined =
        reader && process.stdin.isTTY
          ? (onInterrupt) => reader.watchInterrupt({
              onEsc: () => { activeRunControl?.stop(); onInterrupt('esc') }, // ESC 同时中止并行 run 的子 agent
              onCtrlC: () => onInterrupt('ctrl-c'),
              onInspect: () => (tracker.current() ? openDrillIn() : Promise.resolve()), // 仅有活动 run 时才进视图,避免吞掉流式文本
              onCycleMode: () => cycleMode(),
            })
          : undefined

      // 默认：文件工具限定在当前工作目录内；敏感文件防护始终生效（--yolo 不绕过）。
      const confined: PathPolicy = yolo ? allowAllPaths : confineToRoot(process.cwd())
      const readPaths: PathPolicy = denySecrets(confined) // denySecrets 始终生效
      const writePaths: PathPolicy = confined
      const shell: ShellPolicy = yolo
        ? allowAllShell
        : canPrompt
          ? makeInteractiveShell('', () => autoAccept)
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
      // Git 工具（17 个）。commit/push/pull/rebase/reset 用独立 shell 策略实例——
      // 避免「bash 不再询问」泄漏到 commit 确认。
      // git commit/push/… 用独立 shell 实例 + **不受 auto-accept 影响**(高风险操作始终单独确认,
      // 即便全局切到 auto-accept;保持与既有「commit 确认独立」设计一致)。
      const gitCommitShell = yolo ? allowAllShell : canPrompt ? makeInteractiveShell('git-commit ') : denyAllShell
      registerGitTools(session.registry, gitCommitShell)
      // Task 系统
      const taskStore = new TaskStore(process.cwd())
      registerTaskTools(session.registry, taskStore)
      // Cron 定时任务
      const cronStore = new CronStore(resolve(process.cwd(), '.floom', 'cron.db'))
      const cronScheduler = new CronScheduler(cronStore, (entry) => {
        // 定时触发：把任务作为普通 prompt 注入 REPL 或记录到 stderr
        process.stderr.write(fmt.dim(`\n  ⏰ cron: ${entry.id} → "${entry.prompt.slice(0, 60)}"\n`))
      })
      cronScheduler.start()
      registerCronTools(session.registry, cronScheduler, cronStore)
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
        status.backgroundTasks = shells.runningCount()
        const sb = renderStatusBar(status)
        if (sb) process.stderr.write(sb + '\n')
      }

      // 多 agent 运行态真相源：dispatch_agent / dispatch_agents / workflow 都把活动喂进来，
      // 页脚摘要与全屏钻入视图只从它读、订阅 'update' 节流重绘。
      const tracker = new AgentTracker()

      // ── 固定底部页脚（对标 Claude Code 常驻状态区）──
      // 现代终端：滚动区页脚（model · effort · ctx% · mode + 运行摘要）。老终端/非交互：null，
      // 由 updateStatus() 内联状态栏兜底。状态读取在 paint 时求值（闭包延后绑定 currentEffort）。
      // 模型是否正在输出本轮:为 true 时页脚顶部画一个静态输入框,使「对话框一直存在(含模型回答时)」。
      // 空闲/输入态由 ReplReader 在滚动区内画可编辑框,页脚此时只画状态行+模式行。
      let turnActive = false
      // ctx token 估算的记忆化：输入态的内联面板每次按键都会读 footerState → 不能每键都重算
      // estimateTokens(含多次 JSON.stringify)。上下文只在「轮之间/消息变化」时改,故按 (消息数:system 长度)
      // 做键控缓存:打字期间命中缓存(零开销),新增消息/compact 时自动失效重算。
      let ctxCache = { key: '', val: 0 }
      const estimateCtx = (): number => {
        const key = `${session.messages.length}:${session.system.length}`
        if (ctxCache.key !== key) {
          ctxCache = { key, val: estimateTokens(session.system, session.messages, session.registry.specs()) }
        }
        return ctxCache.val
      }
      const footerState = (): FooterState => {
        const run = tracker.current()
        return {
          run: run
            ? { title: run.title, progress: runProgress(run).label, elapsedMs: Date.now() - run.startedAt, paused: run.status === 'paused' }
            : null,
          model: session.model,
          effort: currentEffort,
          mode: currentMode(),
          ctxTokens: estimateCtx(),
          ctxWindow: ctxWindow(),
          columns: process.stderr.columns ?? 80,
          rows: process.stderr.rows ?? 24,
          showBox: turnActive,
          backgroundTasks: shells.runningCount(),
        }
      }
      const footer = interactive && supportsFooter() ? new Footer(footerState) : null
      // 底部面板总开关（/status 切换）：输入态由 ReplReader 内联画，输出态由滚动区页脚画。
      let panelEnabled = interactive
      // 输入态的常驻面板行（喂给 ReplReader.panelLines）：运行摘要? + 状态行(上) + 模式行(下)。
      // 与滚动区页脚共用同一组 compose*，保证输入态/输出态视觉一致。
      const composePanel = (): string[] => {
        if (!panelEnabled) return []
        const s = footerState()
        const lines: string[] = []
        if (s.run) lines.push(composeRunLine(s.run, s.columns))
        lines.push(composeStatusLine(s))
        lines.push(composeModeLine(s))
        return lines
      }
      tracker.on('update', () => footer?.paint())
      const footerTimer = setInterval(() => { if (footer && tracker.current()) footer.paint() }, 500)
      footerTimer.unref?.()
      // 每轮后刷新底部：面板开启时,输出态有页脚就补画(输入态页脚已撤、由 ReplReader 内联面板显示,
      // 此处无需画);面板关闭(/status off)时回退老式内联状态栏。
      const refreshFooter = () => { if (panelEnabled) footer?.paint(); else updateStatus() }

      // 模型输出途中 Shift+Tab 切模式时延后重算 system 的标志。原因:cycleMode→refreshSystem() 会用
      // plan/normal 的 system **覆盖** session.system,而技能(/skill)执行期 session.system 是技能提示词
      // → 会被冲掉、技能后续行为错乱。故 turnActive 时只置脏标志,等下一轮开头(技能已恢复 savedSystem)
      // 再重算。模式的功能效果(shell 自动放行 isAuto、planModeGate)读 live 标志,本就即时生效,不受影响。
      let systemDirty = false
      // Shift+Tab 循环模式：normal → auto-accept → plan → normal。plan 需可弹批准菜单（TTY），
      // 否则跳过 plan 直接回 normal。切完(空闲态)重算 system（plan 须知）+ 重绘底部。
      const cycleMode = () => {
        const m = currentMode()
        if (m === 'normal') { autoAccept = true; planState.active = false }
        else if (m === 'auto-accept') { autoAccept = false; planState.active = canApprove }
        else { planState.active = false; autoAccept = false }
        if (turnActive) systemDirty = true // 输出途中:延后重算,别冲掉技能/本轮 system
        else refreshSystem()
        footer?.paint()
      }

      // ── 钻入视图（Phase 4）控制 ──
      // 当前活动 run 的控制句柄：由正在跑的工具（dispatch_agents / workflow）在开始时设置、
      // 结束时清空；钻入视图的 x/p 经它作用到底层执行。
      let activeRunControl: { stop: () => void; pause: () => void; resume: () => void; isPaused: () => boolean } | null = null
      // 把一次 run 的摘要落盘 .floom/runs/<id>.md（钻入视图的 s save）。
      const saveRunSummary = (run: RunGroup | null): string => {
        if (!run) return 'nothing to save'
        try {
          const dir = resolve(process.cwd(), '.floom', 'runs')
          mkdirSync(dir, { recursive: true })
          const lines = [
            `# ${run.title}`,
            ``,
            `status: ${run.status} · agents: ${run.rows.length}`,
            ``,
            ...run.rows.map((r) => `- ${r.status === 'failed' ? '✗' : '✓'} ${r.label} · ${r.model} · ${r.outputTokens} tok · ${r.toolCalls} tools${r.error ? ` · ERROR: ${r.error}` : ''}`),
          ]
          const path = resolve(dir, `${run.id}-${Date.now().toString(36)}.md`)
          writeFileSync(path, lines.join('\n') + '\n', 'utf8')
          return `saved → .floom/runs/${basename(path)}`
        } catch (e) {
          return `save failed: ${(e as Error).message}`
        }
      }
      const viewCtl: WorkflowViewCtl = {
        stop: () => activeRunControl?.stop(),
        pause: () => activeRunControl?.pause(),
        resume: () => activeRunControl?.resume(),
        isPaused: () => activeRunControl?.isPaused() ?? false,
        save: () => saveRunSummary(tracker.last()),
      }
      // 钻入视图开关 + 「挂起下一次 generate」闸:视图打开期间模型不得继续流式输出(否则文本写进
      // alt 缓冲、退出即丢)。runTurn 在每次 generate 前 await awaitOverlay()。
      let viewOpen = false
      let viewClosers: Array<() => void> = []
      const awaitOverlay = (): Promise<void> => (viewOpen ? new Promise<void>((res) => viewClosers.push(res)) : Promise.resolve())
      // 打开钻入视图：让页脚让出滚动区(进 alt-screen),返回后重建并放行被挂起的 generate。防重入。
      const openDrillIn = async () => {
        if (viewOpen) return
        viewOpen = true
        footer?.suspend()
        try {
          await openWorkflowView(tracker, viewCtl)
        } finally {
          footer?.resume()
          viewOpen = false
          viewClosers.forEach((r) => r())
          viewClosers = []
        }
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
      // 把单个 dispatch_agent 也映射进 tracker（drill-in 视图统一展示）。SubAgentActivity 无显式
      // start，故首个事件时惰性建 run+row。dispatch 串行，故单一可变对即可。
      let dispRunId = ''
      let dispAgentId = ''
      const ensureDispRow = () => {
        if (dispRunId) return
        dispRunId = tracker.startRun('sub-agent')
        dispAgentId = tracker.addAgent(dispRunId, { label: 'sub-agent', model: session.model })
        tracker.agentRunning(dispAgentId)
      }
      session.registry.register(
        makeDispatchAgentTool({
          client: session.client,
          buildRegistry: () => {
            // 子 agent 用**独立 shell 策略实例**（fresh makeInteractiveShell）：在子 agent 里选
            // 「不再询问」只对该子 agent 生效，不泄漏到父 agent 或后续子 agent（信任边界隔离）。
            // 路径策略是无状态纯函数，可安全共享。子 agent **不继承** auto-accept(它是父级临时模式,
            // 不应回溯影响已在跑的子 agent);单 dispatch 串行执行,交互确认安全。
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
              ensureDispRow()
              tracker.agentTool(dispAgentId, a.name ?? 'tool')
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
              ensureDispRow()
              tracker.agentDone(dispAgentId, { tokens: a.tokens, tools: a.tools, isError: a.isError })
              tracker.endRun(dispRunId, a.isError ? 'failed' : 'done')
              dispRunId = ''
              dispAgentId = ''
            }
          },
          onUsage: (u) => {
            session.usage.inputTokens += u.inputTokens
            session.usage.outputTokens += u.outputTokens
            session.usage.cacheHitTokens += u.cacheHitTokens
          },
        }),
      )

      // dispatch_agents（并发扇出）：一次跑 N 个独立子 agent。每个子 agent 用独立工具集
      // （不含任何 dispatch_* → 递归隔离），foreground shell（不给后台句柄，免并发清理复杂度）。
      // 每个 index 映射成 tracker 的一行；页脚/钻入视图据此实时展示并行进度。
      // dispatch_* 工具调用在 loop 里串行 → fan* 可变状态无需加锁。
      let fanRunId = ''
      let fanAbort: AbortController | null = null
      let fanPaused = false
      let fanResumers: Array<() => void> = []
      const fanIds: string[] = []
      session.registry.register(
        makeDispatchAgentsTool({
          client: session.client,
          buildRegistry: () => {
            // 并行扇出：N 个子 agent 同时跑，交互式 shell 审批会并发抢 stdin → 互相打架。
            // 故受限模式下并行子 agent 的 shell 一律 deny(读/搜/web 仍可用);需要并行跑 shell 用 --yolo。
            const subShell: ShellPolicy = yolo ? allowAllShell : denyAllShell
            const reg = makeRegistry({ readPaths, writePaths, shell: subShell, allowPrivateNet: yolo })
            for (const t of mcpTools) reg.register(t)
            return reg // 不注册 dispatch_agent/dispatch_agents → 子 agent 无法再派发
          },
          system: makeSubAgentSystem(effectiveModel),
          model: effectiveModel,
          maxTokens: MAX_TOKENS,
          contextTokens: CONTEXT_TOKENS,
          gate: makeGate('sub-agent '),
          getSignal: () => fanAbort?.signal,
          isPaused: () => fanPaused,
          waitForResume: () => new Promise<void>((res) => fanResumers.push(res)),
          onStart: (labels) => {
            stopActiveSpinner()
            fanAbort = new AbortController()
            fanPaused = false
            fanResumers = []
            fanRunId = tracker.startRun('parallel agents')
            fanIds.length = 0
            for (const label of labels) fanIds.push(tracker.addAgent(fanRunId, { label, model: session.model }))
            // 暴露控制句柄给钻入视图（x stop / p pause）。
            // stop 必须**同时唤醒暂停中的子 agent**(清 fanPaused + 排空 resumers):否则
            // 「暂停→中止」时它们会永远卡在 await waitForResume(),Promise.all 不解析 → turn 挂死。
            activeRunControl = {
              stop: () => { fanAbort?.abort(); fanPaused = false; fanResumers.forEach((r) => r()); fanResumers = [] },
              pause: () => { if (!fanPaused) { fanPaused = true; if (fanRunId) tracker.setRunStatus(fanRunId, 'paused') } },
              resume: () => { if (fanPaused) { fanPaused = false; fanResumers.forEach((r) => r()); fanResumers = []; if (fanRunId) tracker.setRunStatus(fanRunId, 'running') } },
              isPaused: () => fanPaused,
            }
          },
          onActivity: (e) => {
            const id = fanIds[e.index]
            if (!id) return
            if (e.kind === 'start') tracker.agentRunning(id)
            else if (e.kind === 'tool') tracker.agentTool(id, e.name)
            else if (e.kind === 'done') tracker.agentDone(id, { tokens: e.tokens, tools: e.tools, isError: e.isError, error: e.error })
          },
          onEnd: () => { if (fanRunId) { tracker.endRun(fanRunId, fanAbort?.signal.aborted ? 'failed' : 'done'); fanRunId = '' } activeRunControl = null },
          onUsage: (u) => {
            session.usage.inputTokens += u.inputTokens
            session.usage.outputTokens += u.outputTokens
            session.usage.cacheHitTokens += u.cacheHitTokens
          },
        }),
      )

      // workflow（对话内多阶段编排工具）：脚本顶层以 Node 权限运行、run(ctx) 走 node:vm（非安全沙箱），
      // 等价于让模型跑任意代码、绕过路径/shell 守卫 → **仅 --yolo 注册**。受限模式下模型用 dispatch_agents。
      if (yolo) {
        let wfRunId = ''
        let wfAbort: AbortController | null = null
        let wfPaused = false
        let wfResumers: Array<() => void> = []
        const wfSeqToAgent = new Map<number, string>()
        const onWfEvent = (e: WorkflowEvent) => {
          if (!wfRunId) return
          switch (e.kind) {
            case 'phase': tracker.phaseChange(wfRunId, e.title); break
            case 'agent-start': {
              const id = tracker.addAgent(wfRunId, { label: e.label, phase: e.phase, model: e.model })
              wfSeqToAgent.set(e.seq, id)
              tracker.agentRunning(id)
              break
            }
            case 'agent-tool': { const id = wfSeqToAgent.get(e.seq); if (id) tracker.agentTool(id, e.name); break }
            case 'agent-usage': { const id = wfSeqToAgent.get(e.seq); if (id) tracker.agentUsage(id, e); break }
            case 'agent-done': { const id = wfSeqToAgent.get(e.seq); if (id) tracker.agentDone(id, { tokens: e.tokens, tools: e.tools, isError: e.isError, error: e.error }); break }
            case 'log': break
          }
        }
        // workflow 内 agent() 的工具集：基础工具 + MCP，不含 dispatch_*/workflow（递归隔离）。
        const wfRegistry = makeRegistry({ readPaths, writePaths, shell: allowAllShell, allowPrivateNet: yolo })
        for (const t of mcpTools) wfRegistry.register(t)
        session.registry.register(
          makeWorkflowTool({
            client: session.client,
            registry: wfRegistry,
            model: effectiveModel,
            system: makeSubAgentSystem(effectiveModel),
            maxTokens: MAX_TOKENS,
            onEvent: onWfEvent,
            getSignal: () => wfAbort?.signal,
            isPaused: () => wfPaused,
            waitForResume: () => new Promise<void>((res) => wfResumers.push(res)),
            onStart: () => {
              stopActiveSpinner()
              wfAbort = new AbortController()
              wfPaused = false
              wfResumers = []
              wfSeqToAgent.clear()
              wfRunId = tracker.startRun('workflow')
              activeRunControl = {
                stop: () => { wfAbort?.abort(); wfPaused = false; wfResumers.forEach((r) => r()); wfResumers = [] },
                pause: () => { if (!wfPaused) { wfPaused = true; if (wfRunId) tracker.setRunStatus(wfRunId, 'paused') } },
                resume: () => { if (wfPaused) { wfPaused = false; wfResumers.forEach((r) => r()); wfResumers = []; if (wfRunId) tracker.setRunStatus(wfRunId, 'running') } },
                isPaused: () => wfPaused,
              }
            },
            onEnd: () => { if (wfRunId) { tracker.endRun(wfRunId, wfAbort?.signal.aborted ? 'failed' : 'done'); wfRunId = '' } activeRunControl = null },
            onUsage: (u) => {
              session.usage.inputTokens += u.inputTokens
              session.usage.outputTokens += u.outputTokens
              session.usage.cacheHitTokens += u.cacheHitTokens
            },
          }),
        )
      }

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
        clearInterval(footerTimer)
        footer?.remove() // 复位滚动区 + 清页脚（所有退出路径都经此，含 SIGINT/SIGTERM）
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
      setTerminalTitle(idleTitle()) // 进入 REPL:标题设为 idle

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
        toggleStatus: () => {
          // 底部面板（输入态内联面板 + 输出态滚动区页脚）统一由 panelEnabled 控制；
          // 关闭时若正巧装着页脚则撤掉,并回退到老式内联状态栏。下次提示符/下一轮即反映。
          if (footer || panelEnabled) {
            panelEnabled = !panelEnabled
            if (!panelEnabled && footer?.active) footer.remove()
            return panelEnabled
          }
          status.show = !status.show
          return status.show
        },
      }

      // 进入 REPL：底部面板按「每轮」装/撤——输入态由 ReplReader 内联画(状态+模式贴在框下),
      // 输出态(turnActive)才装上滚动区页脚(box+状态+模式)。所有退出路径经 cleanup() 复位。

      // lastLine = 上一条 agent prompt(每轮都记,成功/失败均可供 /retry 重跑)。
      // retryRequested = 仅当用户敲 /retry 时置位,消费一次。两者分离 → /retry 不会自激(修无限重试 bug)。
      let lastLine = ''
      let retryRequested = false
      let turnNum = 0
      try {
        for (;;) {
          let line: string
          const input = takeReplInput({ retryRequested, lastLine })
          if (input.source === 'retry') {
            retryRequested = false
            line = input.line
            process.stderr.write(fmt.dim(`  ↻ retrying: ${line.slice(0, 80)}\n`))
          } else {
            const raw = await reader!.question()
            if (raw === null) break
            line = raw.trim()
            if (line === '') continue
          }
          // 应用「上一轮输出途中 Shift+Tab 切模式」延后的 system 重算(此刻技能已恢复 savedSystem,
          // 安全;技能路径稍后会再用自己的提示词覆盖)。详见 cycleMode 的 systemDirty 注释。
          if (systemDirty) { refreshSystem(); systemDirty = false }
          // 行首 ! / # 前缀:本地直接处理,不进 agent 循环、也不当 slash 命令。
          const directive = parseReplDirective(line)
          if (directive) {
            if (directive.kind === 'bash') {
              // ! 透传:用户显式输入的命令,直接跑并回显(不经 agent 的 shell 审批)。
              stopActiveSpinner()
              process.stderr.write(fmt.dim(`  $ ${directive.command}\n`))
              const { output } = await execShell(directive.command)
              const body = output.replace(/\s+$/, '')
              if (body) process.stderr.write(body.split('\n').map((l) => '  ' + l).join('\n') + '\n')
            } else {
              // # 快捷记忆:存成持久 memory,并重建 system 让本会话即时可用。
              const text = directive.text
              const name = (memorySlug(text) || 'note') + '-' + Date.now().toString(36).slice(-5)
              // description 必须单行(进 frontmatter 的 `description:` 行);多行 # 笔记折成一行
              const oneLine = text.replace(/\s+/g, ' ').trim()
              const entry: MemoryEntry = {
                name,
                description: oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine,
                type: 'user',
                content: text,
              }
              try {
                memoryStore.save(name, entry)
                refreshSystem()
                process.stderr.write(fmt.green(`  🧠 remembered as ${name}\n`))
              } catch (e) {
                process.stderr.write(fmt.red(`  ✗ could not save memory: ${(e as Error).message}\n`))
              }
            }
            continue
          }
          const slash = runSlash(line, slashCtx)
          if (slash.handled) {
            if (slash.exit) break
            if (slash.retry) {
              if (lastLine) retryRequested = true
              else process.stderr.write(fmt.dim('  nothing to retry yet\n'))
              continue
            }
            if (slash.interactiveSessions) {
              try { const r = await slashCtx.showSessionMenu!(); if (r) process.stderr.write(r + '\n') } catch {}
              continue
            }
            if (slash.openWorkflows) {
              if (tracker.last()) { try { await openDrillIn() } catch {} }
              else process.stderr.write(fmt.dim('  no agent runs yet — dispatch_agents / workflow to start one\n'))
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
                    turnActive = true // 输出态:装上滚动区页脚
                    if (panelEnabled) { footer?.install(); footer?.paint() }
                    await runTurnWithUI(session, `${line}`, write, ui, armInterrupt, () => footer?.paint(), awaitOverlay)
                  } catch (e) {
                    process.stderr.write(fmt.red(`\n  ✗ ${formatApiError(e)}\n`))
                  } finally {
                    turnActive = false // 回到输入态:撤掉页脚
                    footer?.remove()
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
            turnActive = true // 输出态:装上滚动区页脚(box+状态+模式),正文在其上方滚动
            if (panelEnabled) { footer?.install(); footer?.paint() }
            await runTurnWithUI(session, line, write, ui, armInterrupt, () => footer?.paint(), awaitOverlay)
            if (!title) title = line.slice(0, 60)
          } catch (e) {
            process.stderr.write(fmt.red(`\n  ✗ ${(e as Error).message ?? String(e)}\n`))
            if (session.messages.length > 0) {
              // 移除本次出错的 user 消息，保持状态一致
              const last = session.messages[session.messages.length - 1]
              if (last.role === 'user') session.messages.pop()
            }
          } finally {
            turnActive = false // 回到输入态:撤掉滚动区页脚,改由 ReplReader 内联画面板(状态+模式)
            footer?.remove()
          }
          lastLine = line // 记住本轮 prompt(成功或失败都可供 /retry 重跑);不触发自动重试
          process.stdout.write('\n')
          persist()
          refreshFooter()
        }
      } finally {
        // 任何路径退出（正常 / runTurn 抛错）都清理：关后台进程、关 MCP、关 reader
        setTerminalTitle('') // 退出:复位终端标题
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

      // TTY：把进度事件喂进共享 tracker，打印分组实时行（phase 头 + 每 agent 起/止），
      // 跑完再打一张「每 agent: model/tokens/tools/耗时/状态」汇总表。非 TTY：onEvent=undefined →
      // 引擎沿用扁平 stderr 流（CI/管道行为不变）。
      const isTty = Boolean(process.stderr.isTTY)
      const runTracker = new AgentTracker()
      const runId = runTracker.startRun(basename(resolve(script)))
      const seqToId = new Map<number, string>()
      const onEvent = isTty
        ? (e: WorkflowEvent) => {
            switch (e.kind) {
              case 'phase':
                runTracker.phaseChange(runId, e.title)
                process.stderr.write(fmt.cyan(`\n▸ ${e.title}\n`))
                break
              case 'agent-start': {
                const id = runTracker.addAgent(runId, { label: e.label, phase: e.phase, model: e.model })
                seqToId.set(e.seq, id)
                runTracker.agentRunning(id)
                process.stderr.write(fmt.dim(`  → ${e.label} …\n`))
                break
              }
              case 'agent-tool': { const id = seqToId.get(e.seq); if (id) runTracker.agentTool(id, e.name); break }
              case 'agent-usage': { const id = seqToId.get(e.seq); if (id) runTracker.agentUsage(id, e); break }
              case 'agent-done': {
                const id = seqToId.get(e.seq)
                if (id) runTracker.agentDone(id, { tokens: e.tokens, tools: e.tools, isError: e.isError, error: e.error })
                const label = id ? runTracker.last()?.rows.find((r) => r.id === id)?.label ?? `#${e.seq}` : `#${e.seq}`
                const icon = e.isError ? fmt.red('  ✗') : fmt.green('  ✓')
                process.stderr.write(icon + fmt.dim(` ${label}  (${(e.ms / 1000).toFixed(1)}s · ${e.tokens} tok · ${e.tools} tools)\n`))
                break
              }
              case 'log': process.stderr.write(fmt.dim(`  ${e.message}\n`)); break
            }
          }
        : undefined

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
        onEvent,
      })

      if (isTty) {
        runTracker.endRun(runId, result.status === 'failed' ? 'failed' : 'done')
        const run = runTracker.last()
        if (run && run.rows.length > 0) {
          process.stderr.write(fmt.bold(`\n  Agents (${run.rows.length}):\n`))
          for (const row of run.rows) {
            const icon = row.status === 'failed' ? fmt.red('✗') : fmt.green('✓')
            const el = ((row.endedAt ?? Date.now()) - row.startedAt) / 1000
            process.stderr.write(`  ${icon} ${row.label}  ${fmt.dim(`${row.model} · ${row.outputTokens} tok · ${row.toolCalls} tools · ${el.toFixed(1)}s`)}\n`)
          }
        }
      }

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
