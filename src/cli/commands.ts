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
  listMemories(): string
  getSettings(): string
}

export interface SlashResult {
  handled: boolean // false → 不是 slash 命令，按普通 prompt 处理
  output?: string // 要打印的反馈（cli 决定走 stderr + 配色）
  exit?: boolean // /exit /quit
  mutated?: boolean // 改了持久化状态（model/effort/clear），cli 据此落盘
  skill?: string // 技能名（如 'code-review'），cli 据此 dispatch 子 agent
  compact?: boolean // 请求语义压缩历史（需模型调用，由 cli 在 runSlash 返回后异步执行）
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
  exit: { usage: '/exit', desc: 'quit floom' },
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
  return 'Slash commands:\n' + lines.join('\n')
}

export function parseSlash(line: string): { name: string; arg: string } | null {
  const t = line.trim()
  if (!t.startsWith('/')) return null
  const body = t.slice(1)
  const sp = body.search(/\s/)
  if (sp === -1) return { name: body.toLowerCase(), arg: '' }
  return { name: body.slice(0, sp).toLowerCase(), arg: body.slice(sp + 1).trim() }
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
      const want = !ctx.isPlanMode()
      ctx.setPlanMode(want)
      const now = ctx.isPlanMode() // setPlanMode 可能拒绝（无可批准的 TTY）→ 据实汇报
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
      return { handled: true, output: ctx.listSessions() }
    case 'memory':
      return { handled: true, output: ctx.listMemories() }
    case 'config':
      return { handled: true, output: ctx.getSettings() }
    case 'code-review':
    case 'simplify':
    case 'architect':
      return { handled: true, skill: name }
    default:
      return { handled: true, output: `unknown command: /${name} — try /help` }
  }
}
