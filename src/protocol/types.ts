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
}

export interface GenerateOptions { onText?: (delta: string) => void }
