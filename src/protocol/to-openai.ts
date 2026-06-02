import type { GenerateRequest, InternalMessage } from './types.js'

interface OpenAIToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface OpenAIMessage {
  role: string
  content?: string | null
  reasoning_content?: string // thinking 模型工具轮回传（fact-check R8）
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}
export interface OpenAIRequest {
  model: string
  max_tokens: number
  messages: OpenAIMessage[]
  tools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } }
}

function mapMessage(m: InternalMessage): OpenAIMessage {
  if (m.role === 'tool' && m.toolResults?.length) {
    // 错误信息编码进 content 前缀（OpenAI 无 is_error 字段，规划 §4.1d）
    const r = m.toolResults[0]
    return { role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${r.content}` : r.content }
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const msg: OpenAIMessage = {
      role: 'assistant',
      content: m.text ?? '',
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })),
    }
    // R8：thinking 模型的工具轮必须回传 reasoning_content，否则后续请求 400。
    // 普通模型（无 reasoningText）不附带该字段，保持原行为。
    if (m.reasoningText) msg.reasoning_content = m.reasoningText
    return msg
  }
  return { role: m.role, content: m.text ?? '' }
}

export function toOpenAIRequest(req: GenerateRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [{ role: 'system', content: req.system }, ...req.messages.map(mapMessage)]
  const out: OpenAIRequest = { model: req.model, max_tokens: req.maxTokens, messages }
  if (req.tools.length) {
    out.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
  }
  return out // 注意：永不附带 top_k（DeepSeek/OpenAI 不支持，规划 §4.1g 已 confirmed）
}
