import type { ToolSpec } from '../protocol/types.js'

// 脚本导出的元数据（必须为纯字面量，供 resume key 使用）
export interface WorkflowMeta {
  name: string
  version?: string
  description?: string
  schemaVersion: number
}

// 普通 agent 调用选项
export interface AgentOpts {
  model?: string
  maxTokens?: number
  system?: string
  phase?: string
  label?: string
}

// 带结构化输出 schema 的 agent 调用选项
export interface StructuredAgentOpts extends AgentOpts {
  schema: Record<string, unknown>
  schemaName?: string
}

// 预算追踪器（注入到脚本 ctx 中，脚本侧可调 charge/remaining/assertHasBudget）
export interface BudgetTracker {
  readonly total: number
  spent: number
  remaining(): number
  charge(n: number): void
  assertHasBudget(estimate?: number): void
}

// 单次 run 的持久化记录 → runs 表
export interface RunRecord {
  runId: string
  scriptHash: string
  argsHash: string
  schemaVersion: number
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheHitTokens: number
}

// 单次 agent() 调用的持久化记录 → agent_calls 表
export interface CallRecord {
  runId: string
  seq: number
  callHash: string
  status: 'done' | 'failed'
  result: string
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  completedAt?: string
}

// Journal 接口（薄抽象，隔离 node:sqlite 到实现文件）
export interface Journal {
  openRun(run: RunRecord): void
  recordCall(call: CallRecord): void
  lookupPrefix(
    scriptHash: string,
    argsHash: string,
    schemaVersion: number,
  ): { run: RunRecord; calls: CallRecord[] } | null
  closeRun(runId: string, status: 'done' | 'failed'): void
  close(): void
}

// 注入到 workflow 脚本的 ctx 对象（冻结后传入 vm context）
export interface WorkflowCtx {
  readonly agent: (
    prompt: string,
    opts?: AgentOpts | StructuredAgentOpts,
  ) => Promise<string | Record<string, unknown> | null>
  readonly parallel: <T>(
    thunks: Array<() => Promise<T>>,
  ) => Promise<(T | null)[]>
  readonly pipeline: <T>(
    items: T[],
    ...stages: Array<
      (prev: unknown, item: T, index: number) => Promise<unknown>
    >
  ) => Promise<(unknown | null)[]>
  readonly phase: (title: string) => void
  readonly log: (msg: string) => void
  readonly budget: BudgetTracker
  readonly workflow: (
    nameOrRef: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>
  readonly args: Record<string, unknown>
}

// Runtime 抽象（默认 NodeVmRuntime，未来可选 IsolatedVmRuntime）
export interface Runtime {
  createContext(api: Record<string, unknown>): RuntimeContext
}

export interface RuntimeContext {
  runScript(
    fn: (...args: unknown[]) => unknown,
    ...args: unknown[]
  ): Promise<unknown>
}

// agent-executor 返回结果（文本 + 用量，供 journal 落盘用）
export interface AgentResult {
  text: string
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }
}

// executeWorkflow 入参
export interface WorkflowRunOptions {
  scriptPath: string
  args: Record<string, unknown>
  client: import('../model/client.js').ModelClient
  registry: import('../tools/registry.js').ToolRegistry
  journalPath?: string
  runtime?: Runtime
  budgetLimit?: number
  model?: string
  maxTokens?: number
  system?: string
}

// executeWorkflow 返回值
export interface WorkflowRunResult {
  runId: string
  status: 'done' | 'failed'
  cachedCalls: number
  liveCalls: number
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }
  result?: unknown
  error?: string
}
