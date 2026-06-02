#!/usr/bin/env node
import { config } from 'dotenv'
config({ quiet: true })
import { Command } from 'commander'
import { resolve, dirname } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import type { Ora } from 'ora'
import { DeepSeekClient } from './model/deepseek-client.js'
import { ToolRegistry } from './tools/registry.js'
import { makeReadTool } from './tools/read.js'
import { makeWriteTool } from './tools/write.js'
import { makeEditTool } from './tools/edit.js'
import { makeMultiEditTool } from './tools/multi-edit.js'
import { makeBashTool } from './tools/bash.js'
import { BackgroundShells, makeBashOutputTool, makeKillShellTool } from './tools/shell-manager.js'
import { makeGlobTool } from './tools/glob.js'
import { makeGrepTool } from './tools/grep.js'
import { makeWebFetchTool } from './tools/web-fetch.js'
import {
  type PathPolicy,
  type ShellPolicy,
  confineToRoot,
  denySecrets,
  allowAllPaths,
  allowAllShell,
  denyAllShell,
} from './tools/permissions.js'
import { selectMenu } from './cli/prompt.js'
import { ReplReader } from './cli/repl-input.js'
import { resolveEffortModel } from './cli/effort.js'
import { runSlash, type SlashContext } from './cli/commands.js'
import { loadHooks, evaluatePreToolUse } from './hooks/engine.js'
import { loadMcpConfig } from './mcp/config.js'
import { connectMcpServers } from './mcp/manager.js'
import { createSession, runTurn, type ToolGate } from './agent/loop.js'
import { makeDispatchAgentTool } from './agent/subagent.js'
import { makeExitPlanModeTool, planModeGate } from './agent/plan.js'
import type { Tool } from './tools/types.js'
import { SessionStore } from './agent/session-store.js'
import { executeWorkflow } from './workflow/workflow-runtime.js'
import { NodeVmRuntime } from './workflow/sandbox.js'
import { createSpinner, toolStart, stopActiveSpinner } from './cli/spinner.js'
import { fmt } from './cli/format.js'
import { showWelcome } from './cli/welcome.js'
import { renderDiff } from './cli/diff.js'

const VERSION = '0.8.0'

// system prompt 按当前 model id 动态生成，好让模型在被问到时如实说出自己是哪个底层模型。
// FlowLoom 只是外壳/CLI，底层是 DeepSeek 的某个模型——不强加虚假身份、不阻止它回答“你是什么模型”。
function makeSystem(model: string, planMode = false): string {
  return (
    `You are running inside FlowLoom, an open-source agentic coding CLI. FlowLoom is the tool/harness, not the AI itself: your underlying language model is DeepSeek (model id: "${model}"), served over its OpenAI-compatible API. ` +
    `If the user asks which model or AI you are, answer honestly and directly — you are the DeepSeek "${model}" model running inside the FlowLoom CLI. Do not claim to be a different model, and do not refuse or deflect the question. ` +
    `Use the provided tools (read_file, write_file, edit_file, multi_edit, run_shell, glob, grep, web_fetch, dispatch_agent) to inspect and modify the user's project. Use glob to find files by name pattern and grep to search file contents before reading; prefer edit_file for a single small change and multi_edit for several changes to one file; use web_fetch to read documentation or pages by URL; call a tool whenever you need file contents or to run a command. ` +
    `For long-running commands (dev servers, watchers, builds) call run_shell with background:true — it returns a task id immediately; read its output with bash_output and stop it with kill_shell instead of blocking. ` +
    `Use dispatch_agent to delegate a large, self-contained subtask (e.g. broad codebase exploration or a focused multi-step investigation) to an isolated sub-agent — it keeps that work out of this conversation and returns a summary; pass it a complete standalone task description.` +
    (planMode
      ? `\n\nPLAN MODE IS ACTIVE. Do NOT make any changes yet — writing/editing files, running shell commands, dispatching sub-agents, and MCP tools are all BLOCKED. Use ONLY the read-only tools (read_file, glob, grep, web_fetch) to investigate. When you have a concrete, complete plan, call exit_plan_mode with the full plan text and wait for the user to approve it. Only after approval will the editing tools be unblocked.`
      : '')
  )
}

// 子 agent 的 system prompt：强调它看不到主对话、最终消息必须自包含、不能再派发子 agent。
function makeSubAgentSystem(model: string): string {
  return (
    `You are a sub-agent dispatched by FlowLoom (running on the DeepSeek "${model}" model) to autonomously complete one focused, self-contained task. ` +
    `You have file, search, and shell tools (read_file, write_file, edit_file, multi_edit, run_shell, glob, grep, web_fetch). You CANNOT dispatch further sub-agents. ` +
    `Whoever dispatched you sees ONLY your final message — not your intermediate steps, tool calls, or tool output. So your final message must be a COMPLETE, self-contained report: include concrete results (file paths, key findings, exactly what you changed). ` +
    `Work autonomously with the tools, then summarize. Do NOT ask the dispatcher questions — you cannot interact with them.`
  )
}

// 工具权限策略：文件工具的路径围栏 + run_shell 的放行决定。
// read/edit 暴露内容 → 用 readPaths（含敏感文件防护）；write 仅落盘 → 用 writePaths（仅限根目录）。
interface ToolPolicy {
  readPaths: PathPolicy
  writePaths: PathPolicy
  shell: ShellPolicy
  allowPrivateNet: boolean // web_fetch 是否允许私有/环回地址（仅 --yolo / 工作流）
}

// shells 存在时 run_shell 支持 background:true，并额外注册 bash_output/kill_shell。
function makeRegistry(policy: ToolPolicy, shells?: BackgroundShells) {
  const registry = new ToolRegistry()
  const tools: Tool[] = [
    makeReadTool(policy.readPaths),
    makeWriteTool(policy.writePaths),
    makeEditTool(policy.readPaths),
    makeMultiEditTool(policy.readPaths),
    makeBashTool(policy.shell, shells),
    makeGlobTool(policy.readPaths),
    makeGrepTool(policy.readPaths),
    makeWebFetchTool({ allowPrivate: policy.allowPrivateNet }),
  ]
  if (shells) tools.push(makeBashOutputTool(shells), makeKillShellTool(shells))
  tools.forEach((t) => registry.register(t))
  return registry
}

// 自我保护用的上下文 token 预算（估算）。默认 0 = 关闭，不臆造 DeepSeek 窗口大小。
const CONTEXT_TOKENS = Number(process.env.FLOOM_CONTEXT_TOKENS) || 0

// --effort high/max 切换到的「thinking+工具」模型 id。**不预设默认值**（deepseek-reasoner
// 不支持工具、文档示例的 deepseek-v4-pro 未在本账户实测，见 fact-check R2/R9）；
// 由用户用真实 key 确认后自行填写。
const REASONER_MODEL = process.env.FLOOM_REASONER_MODEL ?? ''

// 单次响应的 max_tokens 上限（客户端请求参数，非模型固有窗口）。thinking 模型的 CoT 与
// 最终答案共用此额度，4096 太小会截断答案，故默认调高到 8192；可用 FLOOM_MAX_TOKENS 覆盖。
const MAX_TOKENS = Number(process.env.FLOOM_MAX_TOKENS) || 8192

function makeSession(model: string, policy: ToolPolicy, shells?: BackgroundShells) {
  return createSession({
    client: new DeepSeekClient({ model }),
    registry: makeRegistry(policy, shells),
    system: makeSystem(model),
    model,
    maxTokens: MAX_TOKENS,
    contextTokens: CONTEXT_TOKENS,
  })
}

// 交互式 shell 审批：方向键菜单代替手输 y/N；可选「本会话不再询问」。
// label 用于在提示里标注来源（如子 agent），让用户知道在给谁授权。
// 注意：每次调用产生**独立的 allowAll 状态**——子 agent 必须用自己的实例，
// 否则在子 agent 里选「不再询问」会泄漏到父 agent，跨信任边界关闭确认。
function makeInteractiveShell(label = ''): ShellPolicy {
  let allowAll = false
  return {
    authorize: async (cmd) => {
      if (allowAll) return true
      stopActiveSpinner() // 停掉工具 spinner，把终端让给菜单
      const shown = cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd
      const choice = await selectMenu(
        [fmt.yellow(`⚠ ${label}run_shell wants to execute:`), '  ' + fmt.cyan(shown), ''],
        [
          { label: 'Yes', value: 'yes' },
          { label: "Yes, and don't ask again this session", value: 'always' },
          { label: 'No', value: 'no' },
        ],
      )
      if (choice === 1) {
        allowAll = true
        return true
      }
      return choice === 0 // 0=Yes；2/-1(No/取消)=拒绝
    },
  }
}

// 会话持久化：每个项目的会话存在 .floom/sessions/ 下
function sessionStore(): SessionStore {
  return new SessionStore(resolve(process.cwd(), '.floom', 'sessions'))
}

function makeSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 8)
  return `s-${ts}-${rand}`
}

function sessionsText(store: SessionStore): string {
  const metas = store.list()
  if (metas.length === 0) {
    return fmt.dim('No saved sessions in this project (.floom/sessions).')
  }
  const lines = metas.map(
    (m) => `  ${fmt.cyan(m.id)}  ${fmt.dim(m.updatedAt)}  ${fmt.dim(`(${m.messageCount} msgs · ${m.model})`)}  ${m.title}`,
  )
  return fmt.bold(`Saved sessions (${metas.length}):`) + '\n' + lines.join('\n')
}

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
  // 是否有 REPL 提示符（ReplReader）可接收 ctrl+o。一次性模式为 false，折叠提示不加
  // "ctrl+o to expand"（因为进程马上就退出了）。
  hasRepl: boolean
}

// 单次 turn 的 UI 渲染：流式文本 + 思考计时 + 工具链动画 + 改动 diff
async function runTurnWithUI(
  session: ReturnType<typeof makeSession>,
  task: string,
  write: (d: string) => void,
  ui: UiState,
) {
  const startTime = Date.now()
  let totalTools = 0
  // 本轮全部思考链（跨多轮 generate 累计）；turn 结束写入 ui.lastReasoning 供 ctrl+o 展开。
  let reasoningBuf = ''

  // —— 思考计时 spinner（实时秒数，类 Claude）——
  let thinkSpinner: Ora | null = null
  let thinkTimer: ReturnType<typeof setInterval> | null = null
  let thinkStart = 0
  let thinkingReported = false
  const startThinking = () => {
    thinkStart = Date.now()
    thinkingReported = false
    thinkSpinner = createSpinner('Thinking...')
    thinkTimer = setInterval(() => {
      const s = Math.floor((Date.now() - thinkStart) / 1000)
      if (thinkSpinner) thinkSpinner.text = s >= 1 ? `Thinking... (${s}s)` : 'Thinking...'
    }, 250)
    thinkTimer.unref?.()
  }
  const stopThinking = () => {
    if (thinkTimer) {
      clearInterval(thinkTimer)
      thinkTimer = null
    }
    if (thinkSpinner) {
      thinkSpinner.stop()
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
  let toolSpinner: Ora | null = null
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
        }
        write(delta)
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
      onToolCall: (name, input) => {
        if (streaming) {
          write('\n') // 流式文本收尾换行
          streaming = false
        }
        const detail = input.path ? String(input.path) : undefined
        // 捕获改动前内容（best-effort；新建文件读不到 → 视为空）
        pendingDiff = null
        if (DIFF_TOOLS.has(name) && input.path) {
          let before = ''
          try {
            before = readFileSync(resolve(process.cwd(), String(input.path)), 'utf8')
          } catch {
            before = ''
          }
          pendingDiff = { path: String(input.path), before }
        }
        toolSpinner = toolStart(name, detail)
      },
      onToolResult: (name, ms, isError) => {
        toolSpinner?.stop()
        toolSpinner = null
        totalTools++
        if (isError) {
          process.stderr.write(fmt.toolError(name, ms) + '\n')
        } else {
          process.stderr.write(fmt.toolDone(name, ms) + '\n')
          // 渲染改动 diff
          if (pendingDiff) {
            try {
              const after = readFileSync(resolve(process.cwd(), pendingDiff.path), 'utf8')
              const d = renderDiff(pendingDiff.before, after, pendingDiff.path)
              if (d) process.stderr.write(d + '\n')
            } catch {
              /* 读不到就跳过 diff */
            }
          }
        }
        pendingDiff = null
      },
    })
  } finally {
    stopThinking() // 异常路径也要清掉定时器，避免事件循环挂住
    ui.lastReasoning = reasoningBuf // 缓存本轮思考链，供提示符处 ctrl+o 展开
  }

  if (streaming) write('\n') // 末轮流式文本收尾换行

  const elapsed = Date.now() - startTime
  const outTokens = session.usage.outputTokens
  const summary = fmt.summary(outTokens, totalTools, elapsed)
  ui.lastTurnSummary = summary
  process.stderr.write(summary + '\n')
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
    'reasoning effort: high/max switches to the thinking model in FLOOM_REASONER_MODEL',
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
      },
    ) => {
      const store = sessionStore()
      if (opts.listSessions) {
        printSessions(store)
        return
      }

      const resuming = opts.resume !== undefined
      const yolo = Boolean(opts.yolo)
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
      // 详情显隐：默认折叠思考链；--verbose 启动即全开。ctrl+o 在提示符处切换 verbose，
      // 并把上一轮被折叠的思考链就地展开。
      const ui: UiState = {
        verbose: Boolean(opts.verbose),
        lastReasoning: '',
        lastTurnSummary: '',
        hasRepl: interactive,
      }
      const onToggleVerbose = () => {
        ui.verbose = !ui.verbose
        process.stderr.write(
          fmt.dim(
            ui.verbose
              ? '  ✻ verbose on — thinking will stream live'
              : '  ✻ verbose off — thinking collapsed',
          ) + '\n',
        )
        if (ui.verbose) {
          // 先展示上一轮摘要，再展开被折叠的思考链
          if (ui.lastTurnSummary) {
            process.stderr.write(fmt.dim('  ✻ last turn: ' + ui.lastTurnSummary) + '\n')
          }
          if (ui.lastReasoning) {
            process.stderr.write(fmt.dim('  ✻ last thinking:') + '\n')
            const body = ui.lastReasoning
              .split('\n')
              .map((l) => '    ' + l)
              .join('\n')
            process.stderr.write(fmt.dim(body) + '\n')
          } else {
            process.stderr.write(fmt.dim('  (no thinking was produced last turn)') + '\n')
          }
        }
      }

      // 交互模式用自建行编辑器（/ 下拉补全 + ctrl+o + raw-mode 行编辑）；非 TTY 自动降级为
      // readline 逐行读取。一次性模式无需提示符。shell 确认由 selectMenu 自管 stdin。
      const reader = interactive
        ? new ReplReader({
            out: process.stderr,
            promptText: () => (planState.active ? 'floom(plan)> ' : 'floom> '),
            colorPrompt: fmt.green,
            onToggleVerbose,
          })
        : null

      // 默认：文件工具限定在当前工作目录内；read/edit 额外拦截敏感文件；
      // shell 用方向键菜单逐条确认（无 TTY 则拒绝）。--yolo 放开全部围栏。
      const confined: PathPolicy = yolo ? allowAllPaths : confineToRoot(process.cwd())
      const readPaths: PathPolicy = yolo ? allowAllPaths : denySecrets(confined)
      const writePaths: PathPolicy = confined
      const shell: ShellPolicy = yolo
        ? allowAllShell
        : canPrompt
          ? makeInteractiveShell()
          : denyAllShell

      const session = makeSession(effectiveModel, { readPaths, writePaths, shell, allowPrivateNet: yolo }, shells)

      // 计划模式开关会改变 system（注入"只读调研、先出计划"须知）；切模型/档位时也要据当前 plan 状态重算。
      const refreshSystem = () => {
        session.system = makeSystem(session.model, planState.active)
      }
      refreshSystem() // 应用 --plan 启动态（若开）

      // PreToolUse hooks（.floom/hooks.json）：在工具执行前 allow/deny/ask 的策略闸。
      // 无文件 = 无规则 = 零行为变化。--yolo 不绕过 hooks（用户显式声明的策略应一直生效）。
      const hooks = loadHooks(process.cwd())
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
          return { allow: choice === 0 }
        }
        return { allow: true } // allow / none → 放行（仍受既有权限层约束）
      }
      session.gate = makeGate()

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
                stopActiveSpinner() // 让出终端给嵌套进度
                process.stderr.write(fmt.dim('    ⤷ sub-agent working…') + '\n')
                subDepth = 1
              }
              process.stderr.write(
                fmt.dim(`      · ${a.name}${a.detail ? ' ' + a.detail : ''}`) + '\n',
              )
            } else if (a.kind === 'done') {
              if (subDepth === 0) stopActiveSpinner() // 子 agent 没调工具也要清掉 spinner
              const head = a.isError
                ? fmt.red('    ⤷ sub-agent failed')
                : fmt.dim('    ⤷ sub-agent done')
              process.stderr.write(
                head +
                  fmt.dim(
                    ` · ${a.tools} tool(s) · ${a.tokens} tok · ${((a.ms ?? 0) / 1000).toFixed(1)}s`,
                  ) +
                  '\n',
              )
              subDepth = 0
              subShells?.killAll() // 子 agent 跑完即清理它的后台进程，不留孤儿
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
      session.registry.register(
        makeExitPlanModeTool({
          active: () => planState.active,
          propose: async (plan) => {
            if (!canApprove) return false // 无 TTY 无法弹批准菜单（计划模式入口已据此门控，此处为防御）
            stopActiveSpinner()
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
            process.stderr.write(fmt.green('  ✦ plan approved — executing\n'))
          },
        }),
      )

      // OS 级中断（Ctrl-C / kill）兜底清理：turn 进行中终端非 raw 模式，Ctrl-C 会走默认 SIGINT，
      // 否则会绕过 killAll 留下后台进程孤儿。这里强制清理后再退出。
      const onSignal = (sig: NodeJS.Signals, exitCode: number) => {
        shells.killAll()
        void mcpClose()
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

      // 一次性模式（给了 task 且非 resume）：跑完即走，不落盘
      if (!interactive) {
        try {
          await runTurnWithUI(session, task.join(' '), (d) => process.stdout.write(d), ui)
          process.stdout.write('\n')
        } finally {
          // 即使 runTurn 抛错（网络/API 错误）也要清理后台进程，绝不留孤儿
          shells.killAll()
          await mcpClose()
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
        session.client = new DeepSeekClient({ model: id })
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
      }

      try {
        for (;;) {
          const raw = await reader!.question()
          if (raw === null) break // Ctrl-C / Ctrl-D / EOF → 退出
          const line = raw.trim()
          if (line === '') continue
          const slash = runSlash(line, slashCtx)
          if (slash.handled) {
            if (slash.exit) break
            if (slash.output) process.stderr.write(fmt.dim(slash.output) + '\n')
            if (slash.mutated) persist()
            continue
          }
          await runTurnWithUI(session, line, write, ui)
          process.stdout.write('\n')
          if (!title) title = line.slice(0, 60)
          persist()
        }
      } finally {
        // 任何路径退出（正常 / runTurn 抛错）都清理：关后台进程、关 MCP、关 reader
        reader!.close()
        shells.killAll()
        await mcpClose()
      }
    },
  )

program
  .command('run <script>')
  .description('run a workflow script')
  .option('-b, --budget <n>', 'token budget', '1000000')
  .option('-j, --journal <path>', 'journal database path', '.floom/journal.db')
  .option('-a, --args <json>', 'JSON args to pass to the script', '{}')
  .option(
    '-m, --model <id>',
    'model id',
    process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
  )
  .option('--sandbox <type>', 'sandbox type: vm (default) or isolated (stub)', 'vm')
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
      },
    ) => {
      // 工作流是开发者显式编写的批处理脚本，且已有独立的临时 Workspace 隔离，
      // 不适合逐条确认 shell，也不能把文件工具限死在 cwd（会拦住 workspace 临时目录写入）。
      const registry = makeRegistry({ readPaths: allowAllPaths, writePaths: allowAllPaths, shell: allowAllShell, allowPrivateNet: true })
      const client = new DeepSeekClient({ model: opts.model })
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(opts.args)
      } catch {
        process.stderr.write(
          fmt.yellow('WARNING: ') + 'invalid --args JSON, using {}\n',
        )
      }

      let runtime: NodeVmRuntime | undefined
      if (opts.sandbox === 'vm') {
        runtime = new NodeVmRuntime()
      } else if (opts.sandbox === 'isolated') {
        process.stderr.write(
          fmt.yellow('WARNING: ') +
            'isolated-vm sandbox not yet implemented, using default\n',
        )
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
        budgetLimit: parseInt(opts.budget, 10),
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
