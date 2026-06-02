import { describe, it, expect } from 'vitest'
import {
  extractSystemSummary,
  foldSummaryIntoSystem,
  planCompaction,
  flattenRoundsToText,
  buildSummaryRequest,
  compactMessages,
} from './compaction.js'
import { estimateTokens } from './context.js'
import type { InternalMessage, ToolSpec, GenerateRequest, GenerateResult } from '../protocol/types.js'
import type { ModelClient } from '../model/client.js'

const NO_TOOLS: ToolSpec[] = []
const big = (n: number) => 'x'.repeat(n)

// 与 context.test.ts 同款结构合法性校验：剩余消息以 user 开头，且无孤儿 tool_call_id。
function assertStructurallyValid(messages: InternalMessage[]) {
  if (messages.length === 0) return
  expect(messages[0].role).toBe('user')
  const seen = new Set<string>()
  for (const m of messages) {
    if (m.toolCalls) for (const c of m.toolCalls) seen.add(c.id)
    if (m.role === 'tool' && m.toolResults) {
      for (const r of m.toolResults) expect(seen.has(r.toolCallId)).toBe(true)
    }
  }
}

// 可控 mock client：返回固定摘要文本，并记录收到的请求与 opts（用于断言「静默」与请求形状）。
function mockClient(
  text: string,
  capture?: { req?: GenerateRequest; opts?: unknown },
): ModelClient {
  return {
    async generate(req, opts) {
      if (capture) {
        capture.req = req
        capture.opts = opts
      }
      return { text, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } satisfies GenerateResult
    },
  }
}

describe('extractSystemSummary', () => {
  it('returns the system unchanged with null summary when no marker', () => {
    expect(extractSystemSummary('plain system prompt')).toEqual({ base: 'plain system prompt', summary: null })
  })

  it('round-trips with foldSummaryIntoSystem', () => {
    const folded = foldSummaryIntoSystem('BASE', 'the summary text')
    const { base, summary } = extractSystemSummary(folded)
    expect(base).toBe('BASE')
    expect(summary).toBe('the summary text')
  })

  it('treats a truncated marker (no end) as no summary', () => {
    const broken = 'BASE\n<<<FLOOM_SUMMARY>>>\nhalf written'
    expect(extractSystemSummary(broken)).toEqual({ base: broken, summary: null })
  })
})

describe('foldSummaryIntoSystem', () => {
  it('embeds the summary text into the system', () => {
    const out = foldSummaryIntoSystem('BASE', 'remember X and Y')
    expect(out).toContain('BASE')
    expect(out).toContain('remember X and Y')
  })

  it('replaces an existing summary block instead of stacking (no unbounded growth)', () => {
    const once = foldSummaryIntoSystem('BASE', 'first summary')
    const twice = foldSummaryIntoSystem(once, 'second summary')
    expect(twice).toContain('second summary')
    expect(twice).not.toContain('first summary')
    // 只有一个摘要块
    expect(twice.match(/<<<FLOOM_SUMMARY>>>/g)?.length).toBe(1)
    // 原始 base 仍在
    expect(extractSystemSummary(twice).base).toBe('BASE')
  })

  it('produces a block-only system when base is empty', () => {
    const out = foldSummaryIntoSystem('', 'just a summary')
    expect(out.startsWith('<<<FLOOM_SUMMARY>>>')).toBe(true)
    expect(extractSystemSummary(out)).toEqual({ base: '', summary: 'just a summary' })
  })

  it('stays at exactly one summary block across many re-compactions (no unbounded growth)', () => {
    let sys = 'BASE'
    for (let i = 0; i < 5; i++) sys = foldSummaryIntoSystem(sys, `summary_${i}`)
    const { base, summary } = extractSystemSummary(sys)
    expect(base).toBe('BASE')
    expect(summary).toContain('summary_4') // 仅保留最新
    expect(summary).not.toContain('summary_0') // 旧的被替换
    expect(sys.match(/<<<FLOOM_SUMMARY>>>/g)?.length).toBe(1) // 始终只有一个块
  })
})

describe('planCompaction', () => {
  const threeRounds: InternalMessage[] = [
    { role: 'user', text: big(4000) }, // round 1
    { role: 'user', text: big(4000) }, // round 2
    { role: 'user', text: big(4000) }, // round 3 (newest)
  ]

  it('plans nothing when there is at most one round', () => {
    const plan = planCompaction('', [{ role: 'user', text: 'hi' }], NO_TOOLS, 1)
    expect(plan.summarizeRounds).toHaveLength(0)
    expect(plan.keptMessages).toHaveLength(1)
  })

  it('budget mode: summarizes oldest rounds until the rest fits, always keeping the last round', () => {
    const plan = planCompaction('', threeRounds, NO_TOOLS, 1500)
    expect(plan.summarizeRounds).toHaveLength(2)
    expect(plan.keptMessages).toHaveLength(1)
    expect(plan.keptMessages[0].text).toBe(threeRounds[2].text)
    assertStructurallyValid(plan.keptMessages)
  })

  it('manual mode (keepLastRounds): summarizes all but the last N rounds', () => {
    const plan = planCompaction('', threeRounds, NO_TOOLS, 0, { keepLastRounds: 1 })
    expect(plan.summarizeRounds).toHaveLength(2)
    expect(plan.keptMessages).toHaveLength(1)
    expect(plan.keptMessages[0].text).toBe(threeRounds[2].text)
  })

  it('keeps tool_call / tool_result structure intact across the split', () => {
    const messages: InternalMessage[] = [
      { role: 'user', text: big(8000) }, // round 1 -> summarized
      { role: 'assistant', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 't1', content: big(8000), isError: false }] },
      { role: 'assistant', text: 'done 1' },
      { role: 'user', text: 'q2' }, // round 2 -> kept
      { role: 'assistant', toolCalls: [{ id: 't2', name: 'read_file', input: { path: 'b.txt' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 't2', content: 'file b', isError: false }] },
      { role: 'assistant', text: 'done 2' },
    ]
    const plan = planCompaction('', messages, NO_TOOLS, 1000)
    expect(plan.summarizeRounds).toHaveLength(1)
    assertStructurallyValid(plan.keptMessages)
    // round 2 的 t2 对仍完整保留；round 1 的 t1 不在保留集
    expect(plan.keptMessages.some((m) => m.toolResults?.some((t) => t.toolCallId === 't2'))).toBe(true)
    expect(plan.keptMessages.some((m) => m.toolResults?.some((t) => t.toolCallId === 't1'))).toBe(false)
  })
})

describe('flattenRoundsToText', () => {
  it('renders user / assistant / tool-call / tool-result as plain lines', () => {
    const rounds: InternalMessage[][] = [
      [
        { role: 'user', text: 'fix the bug' },
        { role: 'assistant', text: 'looking', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
        { role: 'tool', toolResults: [{ toolCallId: 't1', content: 'contents', isError: false }] },
        { role: 'assistant', text: 'done' },
      ],
    ]
    const text = flattenRoundsToText(rounds)
    expect(text).toContain('User: fix the bug')
    expect(text).toContain('Assistant: looking')
    expect(text).toContain('Assistant called read_file')
    expect(text).toContain('Tool result: contents')
    expect(text).toContain('Assistant: done')
    // 不应包含任何结构化 tool_call_id 残留（纯文本）
    expect(text).not.toContain('toolCallId')
  })
})

describe('buildSummaryRequest', () => {
  const rounds: InternalMessage[][] = [[{ role: 'user', text: 'do the thing' }]]

  it('builds a single-user-message request with empty tools', () => {
    const req = buildSummaryRequest(rounds, null, 'deepseek-v4-pro', 1024)
    expect(req.tools).toEqual([])
    expect(req.model).toBe('deepseek-v4-pro')
    expect(req.maxTokens).toBe(1024)
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0].role).toBe('user')
    expect(req.messages[0].text).toContain('do the thing')
  })

  it('folds a prior summary into the request when provided', () => {
    const req = buildSummaryRequest(rounds, 'earlier stuff happened', 'm', 512)
    expect(req.messages[0].text).toContain('earlier stuff happened')
  })
})

describe('compactMessages', () => {
  const threeRounds: InternalMessage[] = [
    { role: 'user', text: big(4000) },
    { role: 'user', text: big(4000) },
    { role: 'user', text: big(4000) },
  ]

  it('summarizes oldest rounds, folds into system, and shrinks the kept context', async () => {
    const fullEst = estimateTokens('SYS', threeRounds, NO_TOOLS)
    const cap: { req?: GenerateRequest; opts?: unknown } = {}
    const r = await compactMessages({
      client: mockClient('CONDENSED SUMMARY', cap),
      system: 'SYS',
      messages: threeRounds,
      tools: NO_TOOLS,
      model: 'm',
      budget: 1500,
      maxTokens: 1024,
    })
    expect(r).not.toBeNull()
    expect(r!.summarizedRounds).toBe(2)
    expect(r!.system).toContain('CONDENSED SUMMARY')
    expect(r!.messages).toHaveLength(1)
    assertStructurallyValid(r!.messages)
    expect(r!.estimatedTokens).toBeLessThan(fullEst)
    // 摘要请求应不带工具，且为「静默」调用（无第二参数 / 无 onText）
    expect(cap.req!.tools).toEqual([])
    expect(cap.opts).toBeUndefined()
  })

  it('returns null when messages are empty', async () => {
    const r = await compactMessages({
      client: mockClient('unused'),
      system: 'SYS',
      messages: [],
      tools: NO_TOOLS,
      model: 'm',
      budget: 1,
      maxTokens: 1024,
    })
    expect(r).toBeNull()
  })

  it('returns null when there is nothing to compact (one round)', async () => {
    const r = await compactMessages({
      client: mockClient('unused'),
      system: 'SYS',
      messages: [{ role: 'user', text: 'hi' }],
      tools: NO_TOOLS,
      model: 'm',
      budget: 1,
      maxTokens: 1024,
    })
    expect(r).toBeNull()
  })

  it('returns null when the model yields an empty summary (caller falls back to trim)', async () => {
    const r = await compactMessages({
      client: mockClient('   '),
      system: 'SYS',
      messages: threeRounds,
      tools: NO_TOOLS,
      model: 'm',
      budget: 1500,
      maxTokens: 1024,
    })
    expect(r).toBeNull()
  })

  it('propagates a model error (caller decides fallback)', async () => {
    const failing: ModelClient = {
      async generate() {
        throw new Error('network down')
      },
    }
    await expect(
      compactMessages({
        client: failing,
        system: 'SYS',
        messages: threeRounds,
        tools: NO_TOOLS,
        model: 'm',
        budget: 1500,
        maxTokens: 1024,
      }),
    ).rejects.toThrow('network down')
  })
})
