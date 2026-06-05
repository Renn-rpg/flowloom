import type { ModelClient } from '../model/client.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import { createSession, runTurn } from '../agent/loop.js'
import type { AgentOpts, StructuredAgentOpts, AgentResult, AgentExecHooks } from './types.js'

export interface AgentExecutorConfig {
  client: ModelClient
  registry: ToolRegistry
  defaultModel: string
  defaultMaxTokens: number
  defaultSystem: string
}

export class AgentExecutor {
  constructor(private cfg: AgentExecutorConfig) {}

  async agent(prompt: string, opts?: AgentOpts, hooks?: AgentExecHooks): Promise<AgentResult> {
    // 若带 schema，走结构化路径
    if (opts && 'schema' in opts && (opts as StructuredAgentOpts).schema) {
      return this.agentStructured(prompt, opts as StructuredAgentOpts, hooks)
    }
    const s = createSession({
      client: this.cfg.client,
      registry: this.cfg.registry,
      system: opts?.system ?? this.cfg.defaultSystem,
      model: opts?.model ?? this.cfg.defaultModel,
      maxTokens: opts?.maxTokens ?? this.cfg.defaultMaxTokens,
    })
    const text = await runTurn(s, prompt, {
      onToolCall: hooks?.onToolCall ? (name) => hooks.onToolCall!(name) : undefined,
      onToolResult: hooks?.onToolResult,
    }, { signal: hooks?.signal })
    if (text.startsWith('stopped:')) {
      throw new Error(text)
    }
    return { text, usage: s.usage }
  }

  private async agentStructured(prompt: string, opts: StructuredAgentOpts, hooks?: AgentExecHooks): Promise<AgentResult> {
    const schemaName = opts.schemaName ?? 'respond_json'
    // 结构化输出兜底指令：DeepSeek JSON 模式下必须包含 "json" 关键词
    const jsonHint = '\n\nRespond by calling the "' + schemaName + '" tool exactly once with your structured output.'
    const fullPrompt = prompt + jsonHint

    // 独立 registry：含所有基础工具 + 临时 schema 工具，不污染共享 registry
    const reg = new ToolRegistry()
    for (const spec of this.cfg.registry.specs()) {
      const t = this.cfg.registry.get(spec.name)
      if (t) reg.register(t)
    }
    // 临时 schema 工具：模型调用它来交付结构化输出
    reg.register({
      spec: {
        name: schemaName,
        description: 'Deliver your structured output. Call this exactly once — do NOT call other tools.',
        inputSchema: opts.schema,
      },
      handler: async (input) => JSON.stringify(input),
    })

    const s = createSession({
      client: this.cfg.client,
      registry: reg,
      system: (opts.system ?? this.cfg.defaultSystem) + '\nYou MUST call the "' + schemaName + '" tool to respond.',
      model: opts.model ?? this.cfg.defaultModel,
      maxTokens: opts.maxTokens ?? this.cfg.defaultMaxTokens,
    })
    const text = await runTurn(s, fullPrompt, {
      onToolCall: hooks?.onToolCall ? (name) => hooks.onToolCall!(name) : undefined,
      onToolResult: hooks?.onToolResult,
    }, { signal: hooks?.signal })
    if (text.startsWith('stopped:')) {
      throw new Error(text)
    }
    // 优先从工具调用结果中提取结构化数据（模型调用 respond_json 工具后结果存入 messages）
    for (const m of s.messages) {
      if (m.role === 'tool' && m.toolResults) {
        for (const r of m.toolResults) {
          if (!r.isError && r.content) {
            try {
              const obj = JSON.parse(r.content)
              if (typeof obj === 'object' && obj !== null) {
                return { text, usage: s.usage, object: obj } as any
              }
            } catch { /* continue */ }
          }
        }
      }
    }
    // 回退：从文本中提取 JSON（使用大括号计数，处理嵌套）
    try {
      const start = text.indexOf('{')
      if (start !== -1) {
        let depth = 0, end = start
        for (let i = start; i < text.length; i++) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') depth--
          if (depth === 0) { end = i + 1; break }
        }
        if (end > start) {
          const obj = JSON.parse(text.slice(start, end))
          if (typeof obj === 'object' && obj !== null) {
            return { text, usage: s.usage, object: obj } as any
          }
        }
      }
    } catch { /* 非 JSON 文本，保持原样 */ }
    return { text, usage: s.usage }
  }
}
