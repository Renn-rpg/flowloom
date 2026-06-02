import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkflow } from './workflow-runtime.js'
import type { WorkflowRunResult } from './types.js'

describe('executeWorkflow', () => {
  let tmpDir: string
  let scriptPath: string
  let journalPath: string
  let client: { generate: any }

  const makeScript = async (body: string) => {
    const content = `
export const meta = { name: 'test', version: '1.0.0', schemaVersion: 1 }
export async function run(ctx) { ${body} }
`
    await writeFile(scriptPath, content, 'utf8')
  }

  const run = (args = {}) =>
    executeWorkflow({
      scriptPath,
      args,
      client,
      registry: { specs: () => [], run: async () => 'ok', get: () => undefined, register: () => {} } as any,
      journalPath,
      forceReload: true,
      model: 'm',
      maxTokens: 100,
      system: 'sys',
    })

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'floom-wf-test-'))
    scriptPath = join(tmpDir, 'test.mjs')
    journalPath = join(tmpDir, 'journal.db')
    client = {
      generate: vi.fn(async () => ({
        text: 'agent result',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
      })),
    }
  })

  it('executes a simple script with one agent call', async () => {
    await makeScript('return await ctx.agent("task A")')
    const r: WorkflowRunResult = await run()
    expect(r.status).toBe('done')
    expect(r.liveCalls).toBe(1)
    expect(r.cachedCalls).toBe(0)
    expect(r.result).toBe('agent result')
  })

  it('returns result from script', async () => {
    await makeScript('const a = await ctx.agent("a"); const b = await ctx.agent("b"); return { a, b }')
    const r: WorkflowRunResult = await run()
    expect(r.status).toBe('done')
    expect(r.liveCalls).toBe(2)
    expect(r.result).toEqual({ a: 'agent result', b: 'agent result' })
  })

  it('second run with same args returns 100% cached', async () => {
    await makeScript('await ctx.agent("task"); return await ctx.agent("task2")')
    const r1: WorkflowRunResult = await run({ x: 1 })
    expect(r1.status).toBe('done')
    expect(r1.liveCalls).toBe(2)
    expect(r1.cachedCalls).toBe(0)

    const r2: WorkflowRunResult = await run({ x: 1 })
    expect(r2.status).toBe('done')
    expect(r2.liveCalls).toBe(0)
    expect(r2.cachedCalls).toBe(2)
    expect(r2.result).toEqual(r1.result)
  })

  it('different args produce different cache keys', async () => {
    await makeScript('return await ctx.agent("task")')
    const r1: WorkflowRunResult = await run({ v: 1 })
    expect(r1.liveCalls).toBe(1)

    const r2: WorkflowRunResult = await run({ v: 2 })
    expect(r2.liveCalls).toBe(1) // different args → no cache hit
    expect(r2.cachedCalls).toBe(0)
  })

  it('parallel runs thunks concurrently', async () => {
    await makeScript(`
      const results = await ctx.parallel([
        () => ctx.agent("task A"),
        () => ctx.agent("task B"),
      ])
      return results
    `)
    const r: WorkflowRunResult = await run()
    expect(r.status).toBe('done')
    expect(Array.isArray(r.result)).toBe(true)
    expect((r.result as any[]).length).toBe(2)
    expect(r.liveCalls).toBe(2)
  })

  it('parallel handles individual thunk failures', async () => {
    let call = 0
    client.generate = vi.fn(async () => {
      call++
      if (call === 1) throw new Error('fail')
      return { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 } }
    })
    await makeScript(`
      const results = await ctx.parallel([
        () => ctx.agent("will fail"),
        () => ctx.agent("will succeed"),
      ])
      return results
    `)
    const r: WorkflowRunResult = await run()
    expect(r.status).toBe('done')
    expect(Array.isArray(r.result)).toBe(true)
    const arr = r.result as any[]
    expect(arr[0]).toBeNull()
    expect(arr[1]).toBe('ok')
  })

  it('pipeline processes items through stages', async () => {
    // pipeline: each item independently flows through all stages
    await makeScript(`
      const items = ['a', 'b']
      const results = await ctx.pipeline(
        items,
        async (item) => item.toUpperCase(),
        async (prev) => prev + '!',
      )
      return results
    `)
    const r: WorkflowRunResult = await run()
    expect(r.status).toBe('done')
    expect(r.result).toEqual(['A!', 'B!'])
  })

  it('pipeline skips failed items', async () => {
    await makeScript(`
      const items = ['a', 'b', 'c']
      const results = await ctx.pipeline(
        items,
        async (item) => {
          if (item === 'b') throw new Error('skip b')
          return item.toUpperCase()
        },
        async (prev) => prev + '!',
      )
      return results
    `)
    const r: WorkflowRunResult = await run()
    expect(r.result).toEqual(['A!', null, 'C!'])
  })

  it('log and phase do not throw', async () => {
    await makeScript(`
      ctx.phase('test phase')
      ctx.log('test log message')
      return 'done'
    `)
    const r: WorkflowRunResult = await run()
    expect(r.result).toBe('done')
  })

  it('emits live progress for each agent (start + done) to stderr', async () => {
    const seen: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      seen.push(String(chunk))
      return true
    })
    try {
      await makeScript('return await ctx.agent("task A", { label: "scout" })')
      await run()
    } finally {
      spy.mockRestore()
    }
    const out = seen.join('')
    expect(out).toContain('running workflow') // 开跑横幅
    expect(out).toContain('→ [0] scout') // agent 启动行（含 label）
    expect(out).toMatch(/✓ \[0\] scout/) // agent 完成行
  })

  it('script can access args', async () => {
    await makeScript('return ctx.args.x + ctx.args.y')
    const r: WorkflowRunResult = await run({ x: 3, y: 4 })
    expect(r.result).toBe(7)
  })

  it('handles script errors gracefully', async () => {
    await makeScript('throw new Error("script bug")')
    const r: WorkflowRunResult = await run()
    expect(r.status).toBe('failed')
    expect(r.error).toContain('script bug')
  })
})
