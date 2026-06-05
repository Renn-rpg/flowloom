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
  createContext(api: Record<string, unknown>): RuntimeContext | Promise<RuntimeContext>
}

export interface RuntimeContext {
  run(
    fn: (...args: any[]) => any,
    ...args: any[]
  ): Promise<unknown>
  runInSandbox(
    fn: (...args: unknown[]) => unknown,
    ...args: unknown[]
  ): Promise<unknown>
  dispose?(): Promise<void>
}

// agent-executor 返回结果（文本 + 用量，供 journal 落盘用）。
// 若使用了 StructuredAgentOpts.schema，object 为解析出的结构化数据。
export interface AgentResult {
  text: string
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }
  object?: Record<string, unknown>
}

// 工作流执行期的进度事件（喂给 UI：footer 摘要 / 钻入视图 / floom run phase 树）。
// 引擎只发结构化事件，不碰 ANSI——渲染层（cli）订阅后自行渲染。seq 与 agent_calls 的
// seq 一致，便于把后续 tool/usage/done 事件关联到同一次 agent() 调用。
export type WorkflowEvent =
  | { kind: 'phase'; title: string }
  | { kind: 'agent-start'; seq: number; label: string; phase?: string; model: string }
  | { kind: 'agent-tool'; seq: number; name: string }
  | { kind: 'agent-usage'; seq: number; inputTokens: number; outputTokens: number }
  | { kind: 'agent-done'; seq: number; tokens: number; tools: number; ms: number; isError: boolean; error?: string }
  | { kind: 'log'; message: string }

// agent() 执行期的内部回调（不进 DSL opts，故不影响 resume 的 callHash）。
export interface AgentExecHooks {
  onToolCall?: (name: string) => void
  onToolResult?: (name: string, ms: number, isError: boolean) => void
  signal?: AbortSignal
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
  forceReload?: boolean
  workspacePath?: string
  // 进度事件回调。存在时引擎抑制 per-agent stderr 流（由 UI 渲染），仍保留最终 [usage] 行。
  onEvent?: (e: WorkflowEvent) => void
  // 中断（drill-in 的 x stop）：贯穿到每次 agent() 的 runTurn；预检在 acquire 前。
  signal?: AbortSignal
  // 暂停闸（drill-in 的 p pause）：isPaused()=true 时暂缓启动新 agent（已在跑的跑完）。
  isPaused?: () => boolean
  waitForResume?: () => Promise<void>
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
