import { describe, it, expect } from 'vitest'
import { estimateTokens, trimMessages } from './context.js'
import type { InternalMessage, ToolSpec } from '../protocol/types.js'

const NO_TOOLS: ToolSpec[] = []
const big = (n: number) => 'x'.repeat(n)

// 验证结构合法性：剩余消息必须以 user 开头，且每个 tool 结果的 tool_call_id
// 都能在更靠前的 assistant.toolCalls 中找到（不产生孤儿 tool 结果）。
function assertStructurallyValid(messages: InternalMessage[]) {
  if (messages.length === 0) return
  expect(messages[0].role).toBe('user')
  const seenCallIds = new Set<string>()
  for (const m of messages) {
    if (m.toolCalls) for (const c of m.toolCalls) seenCallIds.add(c.id)
    if (m.role === 'tool' && m.toolResults) {
      for (const r of m.toolResults) {
        expect(seenCallIds.has(r.toolCallId)).toBe(true)
      }
    }
  }
}

describe('estimateTokens', () => {
  it('grows with content size', () => {
    const small = estimateTokens('', [{ role: 'user', text: big(40) }], NO_TOOLS)
    const large = estimateTokens('', [{ role: 'user', text: big(4000) }], NO_TOOLS)
    expect(large).toBeGreaterThan(small)
  })

  it('counts tool calls, tool results, system, and tool specs', () => {
    const sysOnly = estimateTokens(big(400), [], NO_TOOLS)
    expect(sysOnly).toBeGreaterThan(0)
    const withCall = estimateTokens(
      '',
      [{ role: 'assistant', toolCalls: [{ id: 't1', name: 'read_file', input: { path: big(400) } }] }],
      NO_TOOLS,
    )
    expect(withCall).toBeGreaterThan(50)
  })
})

describe('trimMessages', () => {
  // 三轮，每轮一条 ~1000 token 的 user 消息
  const threeRounds: InternalMessage[] = [
    { role: 'user', text: big(4000) }, // round 1
    { role: 'user', text: big(4000) }, // round 2
    { role: 'user', text: big(4000) }, // round 3（最新）
  ]

  it('does nothing when budget is 0 (disabled)', () => {
    const r = trimMessages('', threeRounds, NO_TOOLS, 0)
    expect(r.droppedMessages).toBe(0)
    expect(r.messages).toBe(threeRounds)
  })

  it('does nothing when everything fits the budget', () => {
    const r = trimMessages('', threeRounds, NO_TOOLS, 1_000_000)
    expect(r.droppedMessages).toBe(0)
    expect(r.overBudget).toBe(false)
  })

  it('drops oldest rounds until it fits, always keeping the last round', () => {
    const r = trimMessages('', threeRounds, NO_TOOLS, 1500)
    expect(r.droppedRounds).toBe(2)
    expect(r.messages.length).toBe(1)
    expect(r.messages[0].text).toBe(threeRounds[2].text) // 保留最新一轮
    expect(r.overBudget).toBe(false)
    expect(r.estimatedTokens).toBeLessThanOrEqual(1500)
  })

  it('flags overBudget when the last round alone exceeds the budget (and drops nothing droppable)', () => {
    const oneHugeRound: InternalMessage[] = [{ role: 'user', text: big(8000) }]
    const r = trimMessages('', oneHugeRound, NO_TOOLS, 1000)
    expect(r.droppedMessages).toBe(0)
    expect(r.overBudget).toBe(true)
  })

  it('preserves tool_call / tool_result structure when trimming', () => {
    const messages: InternalMessage[] = [
      // round 1（将被丢弃）：含一对 tool_call / tool_result
      { role: 'user', text: big(8000) },
      { role: 'assistant', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 't1', content: big(8000), isError: false }] },
      { role: 'assistant', text: 'done round 1' },
      // round 2（最新，保留）：另一对 tool_call / tool_result
      { role: 'user', text: 'q2' },
      { role: 'assistant', toolCalls: [{ id: 't2', name: 'read_file', input: { path: 'b.txt' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 't2', content: 'file b', isError: false }] },
      { role: 'assistant', text: 'done round 2' },
    ]
    const r = trimMessages('', messages, NO_TOOLS, 1000)
    expect(r.droppedRounds).toBe(1)
    assertStructurallyValid(r.messages)
    // round 1 的 t1 应被整轮丢弃；round 2 的 t2 对仍完整保留
    expect(r.messages.some((m) => m.toolResults?.some((t) => t.toolCallId === 't1'))).toBe(false)
    expect(r.messages.some((m) => m.toolResults?.some((t) => t.toolCallId === 't2'))).toBe(true)
  })
})
