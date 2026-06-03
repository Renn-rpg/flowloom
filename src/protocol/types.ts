// 内部统一用 "Anthropic 风格"。L1 在出入口与 OpenAI/DeepSeek 互转。
export type Role = 'user' | 'assistant' | 'tool'

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema (object)
}

export interface ToolCall { id: string; name: string; input: Record<string, unknown> }
export interface ToolResult { toolCallId: string; content: string; isError: boolean }

export interface InternalMessage {
  role: Role
  text?: string
  // 思考链。仅在 thinking 模型的「工具轮」assistant 上保留并回传（fact-check R8：
  // 工具轮不回传 reasoning_content 会触发 400）。非工具轮的终态 assistant 不存它（R7：下一轮须剥掉）。
  reasoningText?: string
  toolCalls?: ToolCall[]   // assistant
  toolResults?: ToolResult[] // tool/user 回传
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'unknown'

export interface GenerateRequest {
  system: string
  messages: InternalMessage[]
  tools: ToolSpec[]
  model: string
  maxTokens: number
}

export interface GenerateResult {
  text: string
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens?: number }
  // 思考链（仅推理/thinking 模型返回；deepseek-chat 不返回则为 undefined）。
  // 模型无关命名：内部不感知这是 DeepSeek 的 reasoning_content。
  reasoningText?: string
}

export interface GenerateOptions {
  onText?: (delta: string) => void
  // 思考链增量（推理模型流式时逐块回吐）。普通模型永不触发。
  onReasoning?: (delta: string) => void
  // 外部中断信号（如用户在 REPL 里按 ESC 打断本轮）。aborted 时 generate 应尽快抛错退出。
  signal?: AbortSignal
}
