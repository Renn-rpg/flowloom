import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import { createSession, runTurn } from '../agent/loop.js'
import type { AgentOpts, AgentResult } from './types.js'

export interface AgentExecutorConfig {
  client: ModelClient
  registry: ToolRegistry
  defaultModel: string
  defaultMaxTokens: number
  defaultSystem: string
}

export class AgentExecutor {
  constructor(private cfg: AgentExecutorConfig) {}

  async agent(prompt: string, opts?: AgentOpts): Promise<AgentResult> {
    const s = createSession({
      client: this.cfg.client,
      registry: this.cfg.registry,
      system: opts?.system ?? this.cfg.defaultSystem,
      model: opts?.model ?? this.cfg.defaultModel,
      maxTokens: opts?.maxTokens ?? this.cfg.defaultMaxTokens,
    })
    const text = await runTurn(s, prompt)
    if (text.startsWith('stopped:')) {
      throw new Error(text)
    }
    return { text, usage: s.usage }
  }
}
