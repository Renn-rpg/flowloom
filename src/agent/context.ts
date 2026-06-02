import type { InternalMessage, ToolSpec } from '../protocol/types.js'

// 粗略 token 估算：约 4 字符 / token。这是行业经验近似，**不是** DeepSeek 官方数字，
// 仅用于「自我保护阈值」判断——是否需要在发请求前丢弃过旧的历史。
const CHARS_PER_TOKEN = 4

export function estimateTokens(
  system: string,
  messages: InternalMessage[],
  tools: ToolSpec[],
): number {
  let chars = system.length
  for (const m of messages) {
    if (m.text) chars += m.text.length
    if (m.toolCalls) {
      for (const c of m.toolCalls) chars += c.name.length + JSON.stringify(c.input).length
    }
    if (m.toolResults) {
      for (const r of m.toolResults) chars += r.content.length
    }
    chars += 8 // 每条消息的角色 / 结构开销近似
  }
  chars += JSON.stringify(tools).length
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export interface TrimResult {
  messages: InternalMessage[]
  droppedMessages: number
  droppedRounds: number
  estimatedTokens: number
  overBudget: boolean // true = 即便只剩最后一轮，估算仍超预算
}

// 把消息流切成「对话轮」：每个 user 消息开启新的一轮，其后的 assistant / tool
// 消息归入该轮。runTurn 保证 messages[0] 一定是 user。
function splitRounds(messages: InternalMessage[]): InternalMessage[][] {
  const rounds: InternalMessage[][] = []
  for (const m of messages) {
    if (m.role === 'user' || rounds.length === 0) rounds.push([m])
    else rounds[rounds.length - 1].push(m)
  }
  return rounds
}

// 当估算 token 超过 budget 时，从最旧的对话轮开始整轮丢弃，直到落入预算或只剩最后一轮。
//
// 为什么按「整轮」丢弃：OpenAI/DeepSeek 要求每个 role:'tool' 消息的 tool_call_id 必须能
// 对应同一请求里某个 assistant 的 tool_calls。整轮丢弃可保证剩余消息仍以 user 开头，
// 且每个 tool 结果的 assistant 祖先仍在集合内——不会产生「孤儿 tool 结果」让 API 报 400。
//
// budget <= 0 视为关闭（不做任何窗口假设，保持原行为）。
export function trimMessages(
  system: string,
  messages: InternalMessage[],
  tools: ToolSpec[],
  budgetTokens: number,
): TrimResult {
  const fullEstimate = estimateTokens(system, messages, tools)
  if (budgetTokens <= 0 || fullEstimate <= budgetTokens) {
    return {
      messages,
      droppedMessages: 0,
      droppedRounds: 0,
      estimatedTokens: fullEstimate,
      overBudget: false,
    }
  }

  const rounds = splitRounds(messages)
  let dropTo = 0 // 丢弃 rounds[0 .. dropTo)
  while (dropTo < rounds.length - 1) {
    const kept = rounds.slice(dropTo).flat()
    if (estimateTokens(system, kept, tools) <= budgetTokens) break
    dropTo++
  }

  const kept = rounds.slice(dropTo).flat()
  const est = estimateTokens(system, kept, tools)
  return {
    messages: kept,
    droppedMessages: messages.length - kept.length,
    droppedRounds: dropTo,
    estimatedTokens: est,
    overBudget: est > budgetTokens,
  }
}
