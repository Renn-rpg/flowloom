// dispatch_agent 工具：主 agent 在循环里派发一个隔离的子 agent 处理自包含子任务。
// 子 agent 有独立上下文（全新 messages）、独立 usage、自己的工具集（**不含 dispatch_agent
// 本身，防止无限递归**），跑完后只把最终文本回喂主 agent——把大段探索/研究挡在主上下文之外。
//
// 模型无关：本模块只依赖 ModelClient 接口、loop（runTurn/createSession）、ToolRegistry、Tool，
// **绝不 import openai/DeepSeek**。具体 client/registry/system 由 cli.ts 注入（同 hooks/MCP 的隔离思路）。

import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import { createSession, runTurn, type ToolGate } from './loop.js'

// 子 agent 运行期的进度事件（cli 据此渲染嵌套进度；agent 层不碰 UI）。
export interface SubAgentActivity {
  kind: 'tool' | 'tool-done' | 'done'
  name?: string
  detail?: string
  ms?: number
  isError?: boolean
  tokens?: number // done：子 agent 输出 token 数
  tools?: number // done：子 agent 调用的工具次数
}

export interface DispatchAgentDeps {
  client: ModelClient
  // 子 agent 的工具集工厂。**必须不含 dispatch_agent**（递归隔离，深度封顶为 1）。
  buildRegistry: () => ToolRegistry
  system: string // 子 agent 的 system prompt（cli 用 makeSubAgentSystem 生成）
  model: string
  maxTokens: number
  maxIters?: number
  contextTokens?: number
  gate?: ToolGate // 与父级同款 PreToolUse 闸（hooks）
  onActivity?: (a: SubAgentActivity) => void
  // 把子 agent token 用量回写父级累计，保持"成本可视"
  onUsage?: (u: { inputTokens: number; outputTokens: number; cacheHitTokens: number }) => void
}

const MAX_OUT = 50_000 // 回喂主 agent 的文本上限，防子 agent 输出爆主上下文

export function makeDispatchAgentTool(deps: DispatchAgentDeps): Tool {
  return {
    spec: {
      name: 'dispatch_agent',
      description:
        'Launch ONE sub-agent for a focused, self-contained subtask. ' +
        'Has its own context + tools (cannot dispatch further). Sees no conversation history — pass a complete standalone task. ' +
        'Returns only its final summary. Keeps large work out of the main context.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A short 3-5 word label for the sub-task' },
          prompt: {
            type: 'string',
            description: 'The complete, self-contained task for the sub-agent (it cannot see this conversation)',
          },
        },
        required: ['prompt'],
      },
    },
    handler: async (input) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (!prompt) return 'ERROR: dispatch_agent requires a non-empty "prompt" string'

      const sub = createSession({
        client: deps.client,
        registry: deps.buildRegistry(), // 不含 dispatch_agent → 子 agent 无法再派发
        system: deps.system,
        model: deps.model,
        maxTokens: deps.maxTokens,
        maxIters: deps.maxIters,
        contextTokens: deps.contextTokens,
        gate: deps.gate,
      })

      const t0 = Date.now()
      let tools = 0
      const done = (isError: boolean) =>
        deps.onActivity?.({ kind: 'done', tokens: sub.usage.outputTokens, tools, ms: Date.now() - t0, isError })
      try {
        const out = await runTurn(sub, prompt, {
          onToolCall: (name, inp) => {
            tools++
            deps.onActivity?.({ kind: 'tool', name, detail: pickDetail(inp) })
          },
          onToolResult: (name, ms, isError) => {
            deps.onActivity?.({ kind: 'tool-done', name, ms, isError })
          },
        })
        deps.onUsage?.(sub.usage)
        // runTurn 耗尽迭代上限时返回 "stopped: ..." 哨兵（loop.ts），**不是成功**——
        // 若当成功回喂，主 agent 会把被截断的子任务当已完成。转成 ERROR，让主 agent 知晓未完成
        //（与 workflow 的 agent-executor 对该哨兵的处理一致）。
        if (out.startsWith('stopped:')) {
          done(true)
          return `ERROR: sub-agent did not finish — ${out}`
        }
        done(false)
        const text = out.trim() || '(sub-agent returned no text)'
        return text.length > MAX_OUT ? text.slice(0, MAX_OUT) + '\n…(truncated)' : text
      } catch (e) {
        deps.onUsage?.(sub.usage)
        done(true)
        return `ERROR: sub-agent failed: ${(e as Error).message}`
      }
    },
  }
}

// 从工具入参里挑一个简短的展示细节（路径/命令/模式/URL）。
// 注意 run_shell 的入参键是 `command`（见 tools/bash.ts），不是 cmd。
function pickDetail(input: Record<string, unknown>): string | undefined {
  const v = input.path ?? input.command ?? input.pattern ?? input.url
  if (typeof v !== 'string') return undefined
  return v.length > 60 ? v.slice(0, 60) + '…' : v
}
