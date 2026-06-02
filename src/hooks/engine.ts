// 工具执行钩子（hooks）引擎。模型无关、UI 无关：只做"给定规则 + 工具名 + 入参 → 决策"。
// PreToolUse 规则可在工具真正执行前 allow/deny/ask，是一道独立于权限层、用户可声明的策略闸。
// 配置文件 .floom/hooks.json；无文件 = 无规则 = 零行为变化（安全默认）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type HookDecision = 'allow' | 'deny' | 'ask'

export interface PreToolHook {
  matcher?: string // 工具名正则；缺省匹配任意工具
  inputMatcher?: string // 可选：对 JSON.stringify(input) 的正则（如只拦含 "rm -rf" 的 run_shell）
  decision: HookDecision
  message?: string // deny/ask 时展示给用户、并作为 tool error 回喂模型的说明
}

export interface PostToolHook {
  matcher?: string
  // 命令型 PostToolUse 钩子留待后续；当前仅保留类型占位
}

export interface HooksConfig {
  PreToolUse?: PreToolHook[]
  PostToolUse?: PostToolHook[]
}

export interface PreToolUseResult {
  decision: HookDecision | 'none' // none = 无规则命中，交回既有权限层
  messages: string[]
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null // 非法正则 → 规则跳过（不因坏配置误放/误拦）
  }
}

function hookMatches(hook: PreToolHook, toolName: string, input: unknown): boolean {
  const nameRe = safeRegex(hook.matcher ?? '.*')
  if (!nameRe || !nameRe.test(toolName)) return false
  if (hook.inputMatcher != null) {
    const inRe = safeRegex(hook.inputMatcher)
    if (!inRe) return false
    let s: string
    try {
      s = JSON.stringify(input) ?? ''
    } catch {
      s = String(input)
    }
    if (!inRe.test(s)) return false
  }
  return true
}

// 优先级：deny > ask > allow > none。任一 deny 命中即拦截（最安全方向胜出）。
export function evaluatePreToolUse(
  hooks: PreToolHook[] | undefined,
  toolName: string,
  input: unknown,
): PreToolUseResult {
  const applicable = (hooks ?? []).filter((h) => hookMatches(h, toolName, input))
  const byDecision = (d: HookDecision) => applicable.filter((h) => h.decision === d)

  const denied = byDecision('deny')
  if (denied.length) {
    return { decision: 'deny', messages: denied.map((h) => h.message ?? `denied by hook (${h.matcher ?? '.*'})`) }
  }
  const asked = byDecision('ask')
  if (asked.length) {
    return { decision: 'ask', messages: asked.map((h) => h.message ?? '').filter(Boolean) }
  }
  if (byDecision('allow').length) {
    return { decision: 'allow', messages: [] }
  }
  return { decision: 'none', messages: [] }
}

// 从 <dir>/.floom/hooks.json 读配置；无文件/坏 JSON/非法形状 → 空配置（不抛、不影响运行）。
export function loadHooks(dir: string): HooksConfig {
  try {
    const raw = readFileSync(resolve(dir, '.floom', 'hooks.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return {
        PreToolUse: Array.isArray(parsed.PreToolUse) ? parsed.PreToolUse : [],
        PostToolUse: Array.isArray(parsed.PostToolUse) ? parsed.PostToolUse : [],
      }
    }
  } catch {
    /* 无文件/坏 json → 无 hooks */
  }
  return { PreToolUse: [], PostToolUse: [] }
}
