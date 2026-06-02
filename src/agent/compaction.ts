// 语义上下文压缩：当历史超出 token 预算时，不再「整轮丢弃」（数据丢失），
// 而是把最旧的若干轮交给模型摘要成一段紧凑的「早前对话摘要」，折叠进 system 保留要点。
// 与 Claude Code 的 /compact 对齐：既支持超预算时的自动压缩，也支持手动 /compact。
//
// 架构边界：摘要一律经 ModelClient 接口发起（src/agent 不得 import openai）。摘要请求把要压缩的
// 轮「扁平化为纯文本」放进单条 user 消息——刻意不复用结构化 tool 消息，从根上避免孤儿 tool_call_id。
// 失败语义：compactMessages 仅在「无可压缩的旧轮」或「模型未给出摘要」时返回 null（调用方回退 trim）；
// 模型调用本身出错则向上抛出，由调用方决定回退/报错。
import type { InternalMessage, ToolSpec, GenerateRequest } from '../protocol/types.js'
import type { ModelClient } from '../model/client.js'
import { estimateTokens, splitRounds } from './context.js'

// 折叠进 system 的摘要块用稳定分隔符包裹，便于「替换而非叠加」——反复压缩时 system 不会无限膨胀。
const SUMMARY_BEGIN = '<<<FLOOM_SUMMARY>>>'
const SUMMARY_END = '<<<END_FLOOM_SUMMARY>>>'
const SUMMARY_TITLE = '## 早前对话摘要（已压缩，由系统生成）'

// 摘要请求的 max_tokens 自设上限：摘要是「压缩」任务，不需要会话级的大输出预算。
// 这是 FlowLoom 自定的成本/体积约束（同 4 字符/token 估算一样是经验值，**非** DeepSeek 官方数字），
// 既省 token，又把折叠进 system 的摘要块控制得足够小，避免压缩后反而把 system 撑大。
const SUMMARY_MAX_TOKENS = 2048

export interface SystemSplit {
  base: string // 原始 system（剥离摘要块后）
  summary: string | null // 已折叠的早前摘要正文；无则 null
}

// 从 system 中分离「原始 system」与「已折叠的早前摘要」。标记残缺（只有开头无结尾）当作无摘要处理。
export function extractSystemSummary(system: string): SystemSplit {
  const start = system.indexOf(SUMMARY_BEGIN)
  if (start === -1) return { base: system, summary: null }
  const end = system.indexOf(SUMMARY_END, start)
  if (end === -1) return { base: system, summary: null }
  const inner = system.slice(start + SUMMARY_BEGIN.length, end).trim()
  const summary = inner.startsWith(SUMMARY_TITLE) ? inner.slice(SUMMARY_TITLE.length).trim() : inner
  const base = (system.slice(0, start) + system.slice(end + SUMMARY_END.length)).trim()
  return { base, summary: summary || null }
}

// 把摘要折叠进 system：先剥掉既有摘要块再追加新的——保证至多一个摘要块（替换语义）。
export function foldSummaryIntoSystem(system: string, summary: string): string {
  const { base } = extractSystemSummary(system)
  const block = `${SUMMARY_BEGIN}\n${SUMMARY_TITLE}\n${summary.trim()}\n${SUMMARY_END}`
  return base ? `${base}\n\n${block}` : block
}

export interface CompactionPlan {
  summarizeRounds: InternalMessage[][] // 被摘要的最旧若干轮
  keptMessages: InternalMessage[] // 保留的较新消息（已 flat，仍以 user 开头）
  keptRounds: number
}

// 决定哪些最旧的轮被摘要。两种策略：
//  - budget 模式（不给 keepLastRounds）：与 trimMessages 选择口径一致，摘要最旧的轮直到剩余落入预算，至少留最后 1 轮。
//  - manual 模式（给 keepLastRounds）：摘要除最后 keepLastRounds 轮之外的全部（手动 /compact 用）。
// 按「整轮」切分，保证 keptMessages 仍以 user 开头且无孤儿 tool_call_id（与 trim 同一不变量）。
export function planCompaction(
  system: string,
  messages: InternalMessage[],
  tools: ToolSpec[],
  budget: number,
  opts: { keepLastRounds?: number } = {},
): CompactionPlan {
  const rounds = splitRounds(messages)
  if (rounds.length <= 1) {
    return { summarizeRounds: [], keptMessages: messages, keptRounds: rounds.length }
  }
  let dropTo: number
  if (opts.keepLastRounds != null) {
    dropTo = Math.max(0, Math.min(rounds.length - 1, rounds.length - opts.keepLastRounds))
  } else {
    dropTo = 0
    while (dropTo < rounds.length - 1) {
      const kept = rounds.slice(dropTo).flat()
      if (estimateTokens(system, kept, tools) <= budget) break
      dropTo++
    }
  }
  return {
    summarizeRounds: rounds.slice(0, dropTo),
    keptMessages: rounds.slice(dropTo).flat(),
    keptRounds: rounds.length - dropTo,
  }
}

// 把要摘要的轮渲染成可读纯文本。刻意不复用结构化 tool 消息——摘要请求里出现 role:'tool' 会牵连
// tool_call_id 校验，扁平化为文本则从根上规避。
export function flattenRoundsToText(rounds: InternalMessage[][]): string {
  const lines: string[] = []
  for (const round of rounds) {
    for (const m of round) {
      if (m.role === 'user') {
        if (m.text) lines.push(`User: ${m.text}`)
      } else if (m.role === 'assistant') {
        if (m.text) lines.push(`Assistant: ${m.text}`)
        if (m.toolCalls) {
          for (const c of m.toolCalls) lines.push(`Assistant called ${c.name}(${JSON.stringify(c.input)})`)
        }
      } else if (m.role === 'tool' && m.toolResults) {
        for (const r of m.toolResults) lines.push(`Tool result${r.isError ? ' (error)' : ''}: ${r.content}`)
      }
    }
  }
  return lines.join('\n')
}

const SUMMARY_INSTRUCTION =
  'You are compacting an agentic coding session to save context window. ' +
  'Summarize the transcript below into a concise but information-dense synopsis so the assistant can continue seamlessly. ' +
  'Preserve: the user\'s goals and explicit instructions, decisions made, files/functions created or modified, ' +
  'key facts discovered, commands run and their outcomes, and any unfinished tasks or next steps. ' +
  'Omit small talk. Use compact bullet points. Do NOT invent anything not present in the transcript.'

// 构造摘要请求：单条 user 消息装扁平化文本 + （如有）更早的摘要，tools 置空（摘要不应发起工具调用）。
export function buildSummaryRequest(
  rounds: InternalMessage[][],
  priorSummary: string | null,
  model: string,
  maxTokens: number,
): GenerateRequest {
  const transcript = flattenRoundsToText(rounds)
  const prior = priorSummary
    ? `Summary of even-earlier conversation (fold this into your summary):\n${priorSummary}\n\n`
    : ''
  return {
    system: SUMMARY_INSTRUCTION,
    messages: [{ role: 'user', text: `${prior}Transcript to summarize:\n${transcript}` }],
    tools: [],
    model,
    maxTokens,
  }
}

export interface CompactionResult {
  system: string // 折叠摘要后的新 system
  messages: InternalMessage[] // 保留的较新消息
  summarizedRounds: number
  summary: string
  estimatedTokens: number
}

// 编排：规划 → （经 ModelClient）静默摘要 → 折叠进 system → 返回结果。
// 返回 null = 无可压缩的旧轮 / 模型未给出摘要（调用方回退 trim）；模型调用出错则抛出。
export async function compactMessages(opts: {
  client: ModelClient
  system: string
  messages: InternalMessage[]
  tools: ToolSpec[]
  model: string
  budget: number
  maxTokens: number
  keepLastRounds?: number
}): Promise<CompactionResult | null> {
  const plan = planCompaction(opts.system, opts.messages, opts.tools, opts.budget, {
    keepLastRounds: opts.keepLastRounds,
  })
  if (plan.summarizeRounds.length === 0) return null
  const { summary: priorSummary } = extractSystemSummary(opts.system)
  // 摘要输出用 min(会话上限, SUMMARY_MAX_TOKENS)：thinking 模型 CoT+答案共用额度，留足但不挥霍。
  const summaryMaxTokens = Math.min(opts.maxTokens, SUMMARY_MAX_TOKENS)
  const req = buildSummaryRequest(plan.summarizeRounds, priorSummary, opts.model, summaryMaxTokens)
  // 静默调用：不传 onText/onReasoning，摘要内容不应泄漏到用户输出流。
  const res = await opts.client.generate(req)
  const summary = (res.text ?? '').trim()
  if (!summary) return null
  const newSystem = foldSummaryIntoSystem(opts.system, summary)
  return {
    system: newSystem,
    messages: plan.keptMessages,
    summarizedRounds: plan.summarizeRounds.length,
    summary,
    estimatedTokens: estimateTokens(newSystem, plan.keptMessages, opts.tools),
  }
}
