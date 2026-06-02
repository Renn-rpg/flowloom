// 技能系统：可注册的 slash command 技能，每个技能 = 名称 + prompt 模板 + 可选的工具白名单。
// 技能调用时复用 dispatch_agent 机制，注入专用 system prompt 和工具有限制。

export interface Skill {
  name: string         // slash 命令名（如 "code-review"）
  description: string  // 一行描述
  systemPrompt: string // 技能专用的 system prompt（注入到子 agent）
  toolAllowlist?: string[] // 可选：只允许哪些工具（未设 = 全工具可用）
  readOnly?: boolean   // 默认 false。true = 只读工具（适合 review 类技能）
}

// 只读工具名集合（与 plan.ts 保持一致）
const READONLY_TOOLS = new Set(['read_file', 'glob', 'grep', 'web_fetch'])

export const DEFAULT_READONLY_SKILL_PROMPT = `
This is a read-only review skill. You may ONLY use read-only tools: read_file, glob, grep, web_fetch.
Do NOT edit any files, run shell commands, or dispatch sub-agents. Provide analysis and recommendations only.`.trim()

export class SkillRegistry {
  private skills = new Map<string, Skill>()

  register(skill: Skill): void {
    this.skills.set(skill.name, skill)
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  list(): Skill[] {
    return [...this.skills.values()]
  }

  getToolAllowlist(name: string): string[] | undefined {
    const skill = this.skills.get(name)
    if (skill?.toolAllowlist) return skill.toolAllowlist
    if (skill?.readOnly) return [...READONLY_TOOLS]
    return undefined
  }
}

// 全局技能注册表单例
export const skillRegistry = new SkillRegistry()
