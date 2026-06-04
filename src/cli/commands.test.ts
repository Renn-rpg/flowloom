import { describe, it, expect } from 'vitest'
import {
  parseSlash,
  parseReplDirective,
  runSlash,
  helpText,
  commandArgOptions,
  SLASH_ARG_OPTIONS,
  type SlashContext,
} from './commands.js'

function fakeCtx(): SlashContext & { _s: Record<string, unknown> } {
  const s = {
    model: 'deepseek-v4-pro',
    effort: undefined as string | undefined,
    plan: false,
    messages: 3,
    usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 2 },
    saved: false,
  }
  return {
    _s: s,
    getModel: () => s.model,
    setModel: (id) => { s.model = id },
    getEffort: () => s.effort,
    applyEffort: (lvl) => { s.effort = lvl; if (lvl === 'high') s.model = 'reasoner-x'; return `effort=${lvl} · model ${s.model}` },
    isPlanMode: () => s.plan,
    setPlanMode: (on) => { s.plan = on },
    messageCount: () => s.messages,
    getUsage: () => s.usage,
    clearHistory: () => { const n = s.messages; s.messages = 0; return n },
    save: () => { s.saved = true; return true },
    listSessions: () => 'SESSION-LIST',
    listMemories: () => 'MEMORY-LIST',
    getSettings: () => 'SETTINGS-SUMMARY',
    saveSetting: () => 'SAVED',
    resetSettings: () => 'RESET',
    listCronJobs: () => 'CRON-LIST',
    toggleStatus: () => true,
  }
}

describe('parseSlash', () => {
  it('returns null for non-slash lines', () => {
    expect(parseSlash('hello world')).toBeNull()
    expect(parseSlash('  not a command')).toBeNull()
  })
  it('splits name and arg, lowercasing the name', () => {
    expect(parseSlash('/Model deepseek-chat')).toEqual({ name: 'model', arg: 'deepseek-chat' })
    expect(parseSlash('  /clear  ')).toEqual({ name: 'clear', arg: '' })
    expect(parseSlash('/effort high extra')).toEqual({ name: 'effort', arg: 'high extra' })
  })
})

describe('runSlash', () => {
  it('passes through non-slash input as not handled', () => {
    expect(runSlash('fix the bug', fakeCtx())).toEqual({ handled: false })
  })

  it('/help lists known commands', () => {
    const r = runSlash('/help', fakeCtx())
    expect(r.handled).toBe(true)
    expect(r.output).toContain('/model')
    expect(r.output).toContain('/effort')
    expect(r.output).toContain('/exit')
  })

  it('/exit and /quit signal exit', () => {
    expect(runSlash('/exit', fakeCtx()).exit).toBe(true)
    expect(runSlash('/quit', fakeCtx()).exit).toBe(true)
  })

  it('/model with no arg shows the current model', () => {
    expect(runSlash('/model', fakeCtx()).output).toBe('current model: deepseek-v4-pro')
  })

  it('/model <id> switches and is marked mutated', () => {
    const ctx = fakeCtx()
    const r = runSlash('/model deepseek-chat', ctx)
    expect(r.mutated).toBe(true)
    expect(ctx.getModel()).toBe('deepseek-chat')
    expect(r.output).toContain('deepseek-chat')
  })

  it('/effort high applies effort (switches model) and is mutated', () => {
    const ctx = fakeCtx()
    const r = runSlash('/effort high', ctx)
    expect(r.mutated).toBe(true)
    expect(ctx.getModel()).toBe('reasoner-x')
    expect(r.output).toContain('effort=high')
  })

  it('/plan toggles plan mode on then off', () => {
    const ctx = fakeCtx()
    const on = runSlash('/plan', ctx)
    expect(ctx._s.plan).toBe(true)
    expect(on.output).toMatch(/plan mode ON/)
    const off = runSlash('/plan', ctx)
    expect(ctx._s.plan).toBe(false)
    expect(off.output).toMatch(/plan mode OFF/)
  })

  it('/plan reports when plan mode cannot be enabled (no interactive terminal)', () => {
    const ctx = { ...fakeCtx(), setPlanMode: () => {} } // setPlanMode refuses to enable → stays off
    const r = runSlash('/plan', ctx)
    expect(r.output).toMatch(/interactive terminal/)
  })

  it('/clear resets history and reports the count', () => {
    const ctx = fakeCtx()
    const r = runSlash('/clear', ctx)
    expect(r.mutated).toBe(true)
    expect(r.output).toContain('cleared 3')
    expect(ctx.messageCount()).toBe(0)
  })

  it('/usage shows token counts', () => {
    expect(runSlash('/usage', fakeCtx()).output).toContain('out=5')
  })

  it('/compact signals compaction (handled async by cli, no ctx mutation)', () => {
    const r = runSlash('/compact', fakeCtx())
    expect(r).toEqual({ handled: true, compact: true })
  })

  it('/save persists and confirms', () => {
    const ctx = fakeCtx()
    expect(runSlash('/save', ctx).output).toBe('session saved')
    expect(ctx._s.saved).toBe(true)
  })

  it('/sessions delegates to the context', () => {
    expect(runSlash('/sessions', fakeCtx()).output).toBe('SESSION-LIST')
  })

  it('/memory shows persistent memories', () => {
    expect(runSlash('/memory', fakeCtx()).output).toBe('MEMORY-LIST')
  })

  it('/config shows effective settings', () => {
    expect(runSlash('/config', fakeCtx()).output).toBe('SETTINGS-SUMMARY')
  })

  it('/cron lists scheduled jobs', () => {
    expect(runSlash('/cron', fakeCtx()).output).toBe('CRON-LIST')
  })

  it('unknown command hints at /help', () => {
    const r = runSlash('/bogus', fakeCtx())
    expect(r.handled).toBe(true)
    expect(r.output).toContain('/help')
  })
})

describe('helpText', () => {
  it('includes every registered command', () => {
    const h = helpText()
    for (const name of ['help', 'model', 'effort', 'clear', 'usage', 'save', 'sessions', 'exit']) {
      expect(h).toContain(`/${name}`)
    }
  })
})

describe('commandArgOptions', () => {
  it('returns the enumerated levels for /effort (case-insensitive)', () => {
    const opts = commandArgOptions('effort')
    expect(opts?.map((o) => o.value)).toEqual(['max', 'high', 'normal'])
    expect(commandArgOptions('EFFORT')).toBe(SLASH_ARG_OPTIONS.effort)
  })
  it('returns undefined for commands without enumerable args', () => {
    expect(commandArgOptions('plan')).toBeUndefined()
    expect(commandArgOptions('clear')).toBeUndefined()
    expect(commandArgOptions('bogus')).toBeUndefined()
  })
})

describe('parseReplDirective', () => {
  it('parses a ! bash passthrough', () => {
    expect(parseReplDirective('!ls -la')).toEqual({ kind: 'bash', command: 'ls -la' })
    expect(parseReplDirective('!  git status ')).toEqual({ kind: 'bash', command: 'git status' })
  })

  it('parses a # memory note', () => {
    expect(parseReplDirective('#prefer tabs over spaces')).toEqual({ kind: 'memory', text: 'prefer tabs over spaces' })
    expect(parseReplDirective('#  记住要跑测试 ')).toEqual({ kind: 'memory', text: '记住要跑测试' })
  })

  it('ignores a bare ! or # with no payload', () => {
    expect(parseReplDirective('!')).toBeNull()
    expect(parseReplDirective('#  ')).toBeNull()
  })

  it('returns null for normal prompts and slash commands', () => {
    expect(parseReplDirective('explain this code')).toBeNull()
    expect(parseReplDirective('/help')).toBeNull()
    expect(parseReplDirective('a@b mentions')).toBeNull()
  })

  it('helpText documents the ! / # / @ input prefixes', () => {
    const h = helpText()
    expect(h).toContain('!<command>')
    expect(h).toContain('#<text>')
    expect(h).toContain('@<path>')
  })
})
