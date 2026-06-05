// 会话工厂：创建 AgentSession、ToolRegistry、ShellPolicy 等核心对象。
// 从 cli.ts 拆分出来——把模型构造、工具注册、权限策略的组装集中在一处。
import { resolve } from 'node:path'
import { getFactory } from '../model/factory.js'
import type { ModelClient } from '../model/client.js'
import { ToolRegistry } from '../tools/registry.js'
import { makeReadTool } from '../tools/read.js'
import { makeWriteTool } from '../tools/write.js'
import { makeEditTool } from '../tools/edit.js'
import { makeMultiEditTool } from '../tools/multi-edit.js'
import { makeBashTool } from '../tools/bash.js'
import { BackgroundShells, makeBashOutputTool, makeKillShellTool } from '../tools/shell-manager.js'
import { makeGlobTool } from '../tools/glob.js'
import { makeGrepTool } from '../tools/grep.js'
import { makeWebFetchTool } from '../tools/web-fetch.js'
import { makeWebSearchTool } from '../tools/web-search.js'
import { type PathPolicy, type ShellPolicy } from '../tools/permissions.js'
import { createSession, type ToolGate } from '../agent/loop.js'
import type { Tool } from '../tools/types.js'
import { SessionStore } from '../agent/session-store.js'
import { selectMenu } from './prompt.js'
import { stopActiveSpinner } from './spinner.js'
import { fmt } from './format.js'

// ── 工具权限策略 ──────────────────────────────────────────────────────────
export interface ToolPolicy {
  readPaths: PathPolicy
  writePaths: PathPolicy
  shell: ShellPolicy
  allowPrivateNet: boolean
}

// ── 常量 ───────────────────────────────────────────────────────────────────
// 上下文裁剪自保护预算（≈4 字符/token 估算超过它就从最旧对话轮整轮丢弃）。
// 默认 1M：对齐旗舰 deepseek-v4-pro 的窗口（owner 设定，非官方实测）。显式设 FLOOM_CONTEXT_TOKENS=0 关闭。
export const CONTEXT_TOKENS = (() => {
  const raw = process.env.FLOOM_CONTEXT_TOKENS
  if (raw === undefined || raw === '') return 1_000_000
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? v : 1_000_000
})()
export const REASONER_MODEL = process.env.FLOOM_REASONER_MODEL || (process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro')
export const MAX_TOKENS = Math.max(1, Number(process.env.FLOOM_MAX_TOKENS) || 8192)

// ── System Prompts ─────────────────────────────────────────────────────────

export function makeSystem(model: string, planMode = false): string {
  return (
    `You are FlowLoom, an open-source agentic coding CLI powered by DeepSeek "${model}". ` +
    `If asked which model you are, say "DeepSeek ${model} running inside FlowLoom". ` +
    `Use the provided tools to inspect and modify the project. Prefer glob for file patterns and grep for content before reading; use edit_file for single changes and multi_edit for multiple changes in one file. All git_* tools wrap git subcommands. ` +
    `@<path> is an explicit file/dir reference — read it before answering. ` +
    `For long-running commands, use run_shell with background:true; poll with bash_output, stop with kill_shell. ` +
    `For one large subtask, use dispatch_agent; for several independent ones, use dispatch_agents concurrently. ` +
    (planMode
      ? `\n\nPLAN MODE IS ACTIVE. Do NOT make any changes — writing, editing, shell, sub-agents, and MCP are BLOCKED. Use ONLY read-only tools (read_file, glob, grep, web_fetch, web_search). Call exit_plan_mode with your plan for approval before making changes.`
      : '')
  )
}

export function makeSubAgentSystem(model: string, planMode = false): string {
  const planNote = planMode
    ? `\n\nPLAN MODE IS ACTIVE in the parent — use ONLY read-only tools.`
    : ''
  return (
    `You are a FlowLoom sub-agent (DeepSeek "${model}") completing one focused task autonomously. ` +
    `You have file/search/shell tools but CANNOT dispatch further sub-agents. ` +
    `The dispatcher sees ONLY your final message — be concise but complete: include concrete results, file paths, and exactly what you changed. ` +
    `Keep output under 40,000 characters. Do NOT ask questions — work autonomously, then summarize.` +
    planNote
  )
}

// ── Registry 构建 ──────────────────────────────────────────────────────────

export function makeRegistry(policy: ToolPolicy, shells?: BackgroundShells): ToolRegistry {
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
    makeWebSearchTool(),
  ]
  if (shells) tools.push(makeBashOutputTool(shells), makeKillShellTool(shells))
  tools.forEach((t) => registry.register(t))
  return registry
}

// ── Session 构建 ───────────────────────────────────────────────────────────

export function makeSession(
  model: string,
  policy: ToolPolicy,
  shells?: BackgroundShells,
) {
  const factory = getFactory()
  const primary = factory.createClient(model)
  const fallbackModel = process.env.FLOOM_FALLBACK_MODEL
  const fallbackKey = process.env.FLOOM_FALLBACK_API_KEY
  const fallbackUrl = process.env.FLOOM_FALLBACK_BASE_URL
  if (fallbackModel && !fallbackKey) {
    process.stderr.write('⚠ FLOOM_FALLBACK_MODEL set but FLOOM_FALLBACK_API_KEY missing; fallback disabled\n')
  }
  const client: ModelClient = fallbackModel && fallbackKey
    ? factory.createRouter([
        { client: primary, name: `deepseek:${model}` },
        { client: factory.createClient(fallbackModel, { apiKey: fallbackKey, baseURL: fallbackUrl }), name: `fallback:${fallbackModel}` },
      ])
    : primary

  return createSession({
    client,
    registry: makeRegistry(policy, shells),
    system: makeSystem(model),
    model,
    maxTokens: MAX_TOKENS,
    contextTokens: CONTEXT_TOKENS,
  })
}

// ── Shell 审批策略 ─────────────────────────────────────────────────────────

// isAuto：auto-accept 模式断言（Shift+Tab 切到 auto-accept 时返回 true）→ shell 自动放行，
// 不弹确认。与会话内「不再询问」（allowAll）正交：任一为真即放行。
export function makeInteractiveShell(label = '', isAuto?: () => boolean): ShellPolicy {
  let allowAll = false
  return {
    authorize: async (cmd) => {
      if (allowAll || isAuto?.()) return true
      stopActiveSpinner()
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
      return choice === 0
    },
  }
}

// ── 会话持久化 ─────────────────────────────────────────────────────────────

export function sessionStore(): SessionStore {
  return new SessionStore(resolve(process.cwd(), '.floom', 'sessions'))
}

export function makeSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 8)
  return `s-${ts}-${rand}`
}

export function sessionsText(store: SessionStore): string {
  const metas = store.list()
  if (metas.length === 0) {
    return fmt.dim('No saved sessions in this project (.floom/sessions).')
  }
  const lines = metas.map(
    (m) => `  ${fmt.cyan(m.id)}  ${fmt.dim(m.updatedAt)}  ${fmt.dim(`(${m.messageCount} msgs · ${m.model})`)}  ${m.title}`,
  )
  return fmt.bold(`Saved sessions (${metas.length}):`) + '\n' + lines.join('\n')
}

// 交互式会话管理器：方向键选择，d=delete, q=quit
export async function showSessionMenu(
  store: SessionStore,
  opts: { onResume?: (id: string) => void; onDelete?: (id: string) => void },
): Promise<string> {
  const { selectMenu } = await import('./prompt.js')
  const metas = store.list()
  if (metas.length === 0) return fmt.dim('No saved sessions.')

  const items = metas.map(m => ({
    label: `${m.id.slice(0, 20)}  ${m.updatedAt.slice(0, 19)}  ${String(m.messageCount).padStart(3)}msgs  ${m.model.slice(0, 20)}  ${m.title.slice(0, 40) || '(untitled)'}`,
    value: m.id,
  }))

  const lines = [fmt.bold(`Saved sessions (${metas.length}) — select to resume, d=delete, q=quit`), '']
  const choice = await selectMenu(lines, items)
  if (choice < 0) return ''

  const id = items[choice].value
  const session = store.load(id)
  if (!session) return fmt.red('Session not found.')

  // 显示操作选择
  const actionLines = [
    fmt.bold(`Session: ${session.id}`),
    fmt.dim(`  ${session.messages.length} messages · ${session.model} · ${session.updatedAt}`),
    fmt.dim(`  ${session.title || '(untitled)'}`),
    '',
  ]
  const action = await selectMenu(actionLines, [
    { label: 'Resume', value: 'resume' },
    { label: 'Delete', value: 'delete' },
  ])

  if (action === 0) {
    opts.onResume?.(id)
    return fmt.green(`Resumed session ${id}`)
  }
  if (action === 1) {
    store.delete(id) // using the store's delete method
    opts.onDelete?.(id)
    return fmt.yellow(`Deleted session ${id}`)
  }
  return ''
}
