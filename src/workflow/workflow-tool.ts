// 对话内 `workflow` 工具：让模型用一段 JS 脚本编排「多阶段 / 多 agent」工作流（phase/parallel/
// pipeline/budget），进度实时进面板 + 钻入视图。比 dispatch_agents 的扁平扇出更结构化。
//
// 安全注意：脚本经 import 加载（顶层代码以 Node 权限运行），run(ctx) 走 NodeVmRuntime（node:vm，
// **非安全沙箱**）。因此本工具等价于「让模型跑任意 Node 代码」，会绕过路径限界/shell 审批。
// 故 cli **仅在 --yolo 下注册它**；受限模式下模型改用受策略约束的 dispatch_agents。
// 其内部 agent() 仍走注入的 registry（建议传受限工具集）。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../tools/types.js'
import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import { executeWorkflow } from './workflow-runtime.js'
import { NodeVmRuntime } from './sandbox.js'
import type { WorkflowEvent } from './types.js'

export interface WorkflowToolDeps {
  client: ModelClient
  registry: ToolRegistry // 工作流内 agent() 用的工具集（建议受限：不含 dispatch_*/workflow）
  model: string
  system: string
  maxTokens: number
  defaultBudget?: number
  onEvent?: (e: WorkflowEvent) => void
  // 控制（drill-in）：signal getter（每次 run 新建）、暂停闸。
  getSignal?: () => AbortSignal | undefined
  isPaused?: () => boolean
  waitForResume?: () => Promise<void>
  onStart?: () => void
  onEnd?: () => void
  onUsage?: (u: { inputTokens: number; outputTokens: number; cacheHitTokens: number }) => void
}

export function makeWorkflowTool(deps: WorkflowToolDeps): Tool {
  return {
    spec: {
      name: 'workflow',
      description:
        'Run a multi-phase, multi-agent workflow described as a small JavaScript script. ' +
        'Use this for orchestrated work that needs PHASES, pipelines, a shared token budget, or cross-stage coordination — more structured than a flat dispatch_agents fan-out. ' +
        'The script MUST export `meta` (a literal with at least { name, schemaVersion: 1 }) and an async `run(ctx)`. ' +
        'ctx provides: agent(prompt, opts?) → text, parallel(thunks) → results[], pipeline(items, ...stages), phase(title), log(msg), budget, args. ' +
        'Agents run concurrently (capped) and progress shows live in the panel; the return value of run(ctx) is returned to you. ' +
        'Prefer dispatch_agents for simple "do N independent things at once"; reach for workflow when you need phases/pipelines/budget control.',
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'The workflow JS: `export const meta = { name, schemaVersion: 1 }; export async function run(ctx) { ... }`',
          },
          args: { type: 'object', description: 'Optional JSON args exposed to the script as ctx.args' },
          budget: { type: 'number', description: 'Optional token budget (default 1,000,000)' },
        },
        required: ['script'],
      },
    },
    handler: async (input) => {
      const script = typeof input.script === 'string' ? input.script : ''
      if (!script.trim()) return 'ERROR: workflow requires a non-empty "script" string'
      const args = input.args && typeof input.args === 'object' ? (input.args as Record<string, unknown>) : {}
      const budgetIn = input.budget
      const budget = typeof budgetIn === 'number' && Number.isFinite(budgetIn) && budgetIn > 0 ? budgetIn : deps.defaultBudget ?? 1_000_000

      const dir = mkdtempSync(join(tmpdir(), 'floom-wf-'))
      const scriptPath = join(dir, 'workflow.mjs')
      writeFileSync(scriptPath, script, 'utf8')
      deps.onStart?.()
      try {
        const result = await executeWorkflow({
          scriptPath,
          args,
          client: deps.client,
          registry: deps.registry,
          model: deps.model,
          system: deps.system,
          maxTokens: deps.maxTokens,
          budgetLimit: budget,
          runtime: new NodeVmRuntime(),
          forceReload: true,
          onEvent: deps.onEvent,
          signal: deps.getSignal?.(),
          isPaused: deps.isPaused,
          waitForResume: deps.waitForResume,
        })
        deps.onUsage?.(result.usage)
        if (result.status === 'failed') {
          return `ERROR: workflow failed: ${result.error ?? 'unknown error'}`
        }
        const out =
          result.result === undefined
            ? '(workflow returned no value)'
            : typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result, null, 2)
        return `workflow done · live=${result.liveCalls} cached=${result.cachedCalls} · ${result.usage.outputTokens} out tok\n\n${out}`
      } catch (e) {
        return `ERROR: workflow execution failed: ${(e as Error).message}`
      } finally {
        deps.onEnd?.()
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  }
}
