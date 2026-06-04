// REPL slash 命令：解析 + 路由。核心保持纯函数（不碰 chalk/IO），副作用经 SlashContext 注入，
// 便于单测。cli.ts 负责把活动会话/存储包装成 ctx，并打印 output。

export interface SlashContext {
  getModel(): string
  setModel(id: string): void
  getEffort(): string | undefined
  // 按档位（high/max → thinking 模型）切换并返回一行状态文案（含未配置时的告警）
  applyEffort(level: string): string
  // 计划模式：只读调研→出计划→批准后再执行
  isPlanMode(): boolean
  setPlanMode(on: boolean): void
  messageCount(): number
  getUsage(): { inputTokens: number; outputTokens: number; cacheHitTokens: number }
  // 清空对话历史，返回被清掉的消息数
  clearHistory(): number
  save(): boolean
  listSessions(): string
  showSessionMenu?(): Promise<string>
  listMemories(): string
  getSettings(): string
  saveSetting(key: string, value: string): string
  resetSettings(): string
  listCronJobs(): string
  toggleStatus?(): boolean
}

export interface SlashResult {
  handled: boolean // false → 不是 slash 命令，按普通 prompt 处理
  output?: string // 要打印的反馈（cli 决定走 stderr + 配色）
  exit?: boolean // /exit /quit
  mutated?: boolean // 改了持久化状态（model/effort/clear），cli 据此落盘
  skill?: string // 技能名（如 'code-review'），cli 据此 dispatch 子 agent
  skillArgs?: string // 传给技能的参数（如 '/code-review --effort high' → '--effort high'）
  compact?: boolean
  retry?: boolean
  interactiveSessions?: boolean // /sessions → 交互式会话管理
}

interface SlashSpec {
  usage: string
  desc: string
}

// 顺序即 /help 展示顺序
export const SLASH_COMMANDS: Record<string, SlashSpec> = {
  help: { usage: '/help', desc: 'show this help' },
  model: { usage: '/model [id]', desc: 'show or switch the model' },
  effort: { usage: '/effort [level]', desc: 'show or set reasoning effort (high/max → thinking model)' },
  plan: { usage: '/plan', desc: 'toggle plan mode (read-only; propose a plan before changes)' },
  'plan revise': { usage: '/plan revise', desc: 'stay in plan mode but allow revising the current plan' },
  clear: { usage: '/clear', desc: 'clear conversation history (reset context)' },
  compact: { usage: '/compact', desc: 'summarize older history into a synopsis to free up context' },
  usage: { usage: '/usage', desc: 'show token usage this session' },
  save: { usage: '/save', desc: 'save the session now' },
  sessions: { usage: '/sessions', desc: 'list saved sessions in this project' },
  memory: { usage: '/memory', desc: 'list persistent memories' },
  'code-review': { usage: '/code-review', desc: 'review current changes for bugs and cleanups' },
  simplify: { usage: '/simplify', desc: 'review changes for reuse and simplification' },
  architect: { usage: '/architect', desc: 'analyze architecture and propose designs' },
  config: { usage: '/config', desc: 'show effective settings' },
  cron: { usage: '/cron', desc: 'list scheduled cron jobs' },
  status: { usage: '/status', desc: 'toggle the status bar on/off' },
  retry: { usage: '/retry', desc: 'retry the last failed turn' },
  'deep-review': { usage: '/deep-review', desc: 'adversarial multi-agent code review (correctness + security)' },
  exit: { usage: '/exit', desc: 'quit floom' },
}

// 命令别名映射：缩短常用命令
const COMMAND_ALIASES: Record<string, string> = {
  fix: 'code-review',
  test: 'code-review',  // /test → 建议模型跑测试+审查
  pr: 'code-review',    // /pr → 审查变更
}

// 某些命令的合法参数枚举：用于交互式下拉的二级子菜单（选完命令再选参数）。
// effort 档位与 resolveEffortModel 对齐：high/max → thinking 模型；其余（normal）→ 基础模型。
export interface ArgOption {
  value: string
  desc: string
}
export const SLASH_ARG_OPTIONS: Record<string, ArgOption[]> = {
  model: [
    { value: 'deepseek-v4-pro', desc: 'DeepSeek v4 Pro — thinking + tools' },
    { value: 'deepseek-v4-flash', desc: 'DeepSeek v4 Flash — fast, cost-effective' },
  ],
  effort: [
    { value: 'max', desc: 'thinking model — deepest reasoning' },
    { value: 'high', desc: 'thinking model — high reasoning' },
    { value: 'normal', desc: 'base model — no extra reasoning' },
  ],
}

// 该命令是否带「可枚举参数」（决定下拉补全是否进入二级子菜单）。
export function commandArgOptions(name: string): ArgOption[] | undefined {
  return SLASH_ARG_OPTIONS[name.toLowerCase()]
}

export function helpText(): string {
  const width = Math.max(...Object.values(SLASH_COMMANDS).map((s) => s.usage.length))
  const lines = Object.values(SLASH_COMMANDS).map((s) => `  ${s.usage.padEnd(width)}  ${s.desc}`)
  const prefixes = [
    '',
    'Input prefixes:',
    `  ${'!<command>'.padEnd(width)}  run a shell command directly (passthrough, no agent)`,
    `  ${'#<text>'.padEnd(width)}  save a note as a persistent memory`,
    `  ${'@<path>'.padEnd(width)}  reference a file/dir (type @ to pick)`,
  ]
  return 'Slash commands:\n' + lines.join('\n') + '\n' + prefixes.join('\n')
}

// REPL 行首特殊前缀(非 slash 命令):
//   !<command> → 直接跑 shell 并回显(用户显式输入,不进 agent、不经 shell 审批)
//   #<text>    → 把一句话存成持久记忆
// 副作用(执行/落盘)在 cli.ts 完成;这里只做纯解析,便于单测。
export type ReplDirective =
  | { kind: 'bash'; command: string }
  | { kind: 'memory'; text: string }

export function parseReplDirective(line: string): ReplDirective | null {
  const t = line.trim()
  if (t.startsWith('!')) {
    const command = t.slice(1).trim()
    return command ? { kind: 'bash', command } : null // 裸 '!' 不触发
  }
  if (t.startsWith('#')) {
    const text = t.slice(1).trim()
    return text ? { kind: 'memory', text } : null // 裸 '#' 不触发
  }
  return null
}

// 决定本轮 REPL 取哪条输入。**纯函数**,锁定 /retry 语义:
//   - retry 是「一次性」的:只有用户显式请求(retryRequested=true)且存在上一条 prompt 时才复用;
//   - 仅仅 lastLine 非空**绝不**触发重试——否则每轮结束都会自激,造成无限重试(历史 bug)。
// 真正的 IO(读新行)由调用方做;这里只返回决策。
export type ReplInputChoice =
  | { source: 'retry'; line: string }
  | { source: 'read' }

export function takeReplInput(s: { retryRequested: boolean; lastLine: string }): ReplInputChoice {
  if (s.retryRequested && s.lastLine) return { source: 'retry', line: s.lastLine }
  return { source: 'read' }
}

export function parseSlash(line: string): { name: string; arg: string } | null {
  const t = line.trim()
  if (!t.startsWith('/')) return null
  const body = t.slice(1)
  const sp = body.search(/\s/)
  const rawName = sp === -1 ? body.toLowerCase() : body.slice(0, sp).toLowerCase()
  const name = COMMAND_ALIASES[rawName] ?? rawName
  const arg = sp === -1 ? '' : body.slice(sp + 1).trim()
  return { name, arg }
}

export function runSlash(line: string, ctx: SlashContext): SlashResult {
  const parsed = parseSlash(line)
  if (!parsed) return { handled: false }
  const { name, arg } = parsed
  switch (name) {
    case 'help':
    case '?':
      return { handled: true, output: helpText() }
    case 'exit':
    case 'quit':
      return { handled: true, exit: true }
    case 'model':
      if (!arg) return { handled: true, output: `current model: ${ctx.getModel()}` }
      ctx.setModel(arg)
      return { handled: true, output: `model → ${arg}`, mutated: true }
    case 'effort': {
      if (!arg) {
        const e = ctx.getEffort()
        return { handled: true, output: `current model: ${ctx.getModel()}${e ? ` (effort=${e})` : ''}` }
      }
      return { handled: true, output: ctx.applyEffort(arg), mutated: true }
    }
    case 'plan': {
      if (arg === 'revise') {
        if (!ctx.isPlanMode()) return { handled: true, output: 'Not in plan mode — nothing to revise.' }
        return { handled: true, output: 'Plan mode still ON — revise your plan and call exit_plan_mode when ready.' }
      }
      const want = !ctx.isPlanMode()
      ctx.setPlanMode(want)
      const now = ctx.isPlanMode()
      if (want && !now) {
        return { handled: true, output: 'plan mode needs an interactive terminal — not available here' }
      }
      return {
        handled: true,
        output: now
          ? 'plan mode ON — read-only; I will research and propose a plan before making changes'
          : 'plan mode OFF — changes enabled',
      }
    }
    case 'clear': {
      const n = ctx.clearHistory()
      return { handled: true, output: `cleared ${n} message(s); context reset`, mutated: true }
    }
    case 'compact':
      // 摘要需模型调用（异步）；runSlash 保持纯同步，仅发出信号，由 cli 执行实际压缩。
      return { handled: true, compact: true }
    case 'usage': {
      const u = ctx.getUsage()
      return {
        handled: true,
        output: `usage: in=${u.inputTokens} out=${u.outputTokens} cacheHit=${u.cacheHitTokens} · ${ctx.messageCount()} message(s)`,
      }
    }
    case 'save':
      return { handled: true, output: ctx.save() ? 'session saved' : 'save failed' }
    case 'sessions':
      if (ctx.showSessionMenu) return { handled: true, interactiveSessions: true }
      return { handled: true, output: ctx.listSessions() }
    case 'memory':
      return { handled: true, output: ctx.listMemories() }
    case 'config': {
      if (!arg) return { handled: true, output: ctx.getSettings() }
      const parts = arg.split(/\s+/)
      if (parts[0] === 'set' && parts.length >= 3) {
        return { handled: true, output: ctx.saveSetting(parts[1], parts.slice(2).join(' ')), mutated: true }
      }
      if (parts[0] === 'reload') {
        return { handled: true, output: 'Settings reloaded (some changes require restart).', mutated: true }
      }
      if (parts[0] === 'reset') {
        return { handled: true, output: ctx.resetSettings(), mutated: true }
      }
      return { handled: true, output: `Usage: /config [set <key> <value> | reload | reset]` }
    }
    case 'cron':
      return { handled: true, output: ctx.listCronJobs() }
    case 'status': {
      const on = ctx.toggleStatus?.() ?? true
      return { handled: true, output: on ? 'status bar ON' : 'status bar OFF' }
    }
    case 'retry':
      return { handled: true, retry: true }
    case 'code-review':
    case 'simplify':
    case 'architect':
    case 'deep-review':
      return { handled: true, skill: name, skillArgs: arg || undefined }
    default:
      return { handled: true, output: `unknown command: /${name} — try /help` }
  }
}
