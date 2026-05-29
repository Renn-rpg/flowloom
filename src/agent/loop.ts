import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { InternalMessage } from '../protocol/types.js'

export interface RunArgs {
  client: ModelClient
  registry: ToolRegistry
  system: string
  userText: string
  model: string
  maxTokens: number
  maxIters?: number
}

export async function runAgentTurn(a: RunArgs): Promise<string> {
  const messages: InternalMessage[] = [{ role: 'user', text: a.userText }]
  const limit = a.maxIters ?? 25
  for (let iter = 0; iter < limit; iter++) {
    const res = await a.client.generate({ system: a.system, messages, tools: a.registry.specs(), model: a.model, maxTokens: a.maxTokens })
    if (res.stopReason !== 'tool_use' || res.toolCalls.length === 0) return res.text
    messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls })
    for (const call of res.toolCalls) {
      const output = await a.registry.run(call.name, call.input)
      const isError = output.startsWith('ERROR')
      messages.push({ role: 'tool', toolResults: [{ toolCallId: call.id, content: output, isError }] })
    }
  }
  return 'stopped: reached max iterations'
}
