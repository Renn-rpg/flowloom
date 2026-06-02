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
export const CONTEXT_TOKENS = Math.max(0, Number(process.env.FLOOM_CONTEXT_TOKENS) || 0)
export const REASONER_MODEL = process.env.FLOOM_REASONER_MODEL || (process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro')
export const MAX_TOKENS = Number(process.env.FLOOM_MAX_TOKENS) || 8192

// ── System Prompts ─────────────────────────────────────────────────────────

export function makeSystem(model: string, planMode = false): string {
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

export function makeSubAgentSystem(model: string): string {
  return (
    `You are a sub-agent dispatched by FlowLoom (running on the DeepSeek "${model}" model) to autonomously complete one focused, self-contained task. ` +
    `You have file, search, and shell tools (read_file, write_file, edit_file, multi_edit, run_shell, glob, grep, web_fetch). You CANNOT dispatch further sub-agents. ` +
    `Whoever dispatched you sees ONLY your final message — not your intermediate steps, tool calls, or tool output. Your final message must be CONCISE and COMPLETE: include concrete results (file paths, key findings, exactly what you changed). ` +
    `Keep your final response under 40,000 characters — overly long output will be truncated without notice. ` +
    `Work autonomously with the tools, then summarize. Do NOT ask the dispatcher questions — you cannot interact with them.`
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

export function makeInteractiveShell(label = ''): ShellPolicy {
  let allowAll = false
  return {
    authorize: async (cmd) => {
      if (allowAll) return true
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
