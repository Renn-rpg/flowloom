import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluatePreToolUse, loadHooks, type PreToolHook } from './engine.js'

describe('evaluatePreToolUse', () => {
  it('returns none when no hooks match', () => {
    expect(evaluatePreToolUse([], 'run_shell', {})).toEqual({ decision: 'none', messages: [] })
    expect(evaluatePreToolUse([{ matcher: 'write_file', decision: 'deny' }], 'run_shell', {}).decision).toBe('none')
  })

  it('matches tool name by regex (default matches any)', () => {
    expect(evaluatePreToolUse([{ decision: 'deny' }], 'anything', {}).decision).toBe('deny')
    expect(evaluatePreToolUse([{ matcher: '^run_shell$', decision: 'ask' }], 'run_shell', {}).decision).toBe('ask')
  })

  it('deny wins over ask and allow (most-restrictive precedence)', () => {
    const hooks: PreToolHook[] = [
      { matcher: '.*', decision: 'allow' },
      { matcher: 'run_shell', decision: 'ask' },
      { matcher: 'run_shell', decision: 'deny', message: 'no shell' },
    ]
    const r = evaluatePreToolUse(hooks, 'run_shell', {})
    expect(r.decision).toBe('deny')
    expect(r.messages).toContain('no shell')
  })

  it('ask wins over allow', () => {
    const hooks: PreToolHook[] = [
      { decision: 'allow' },
      { matcher: 'edit_file', decision: 'ask' },
    ]
    expect(evaluatePreToolUse(hooks, 'edit_file', {}).decision).toBe('ask')
  })

  it('inputMatcher gates on stringified input', () => {
    const hooks: PreToolHook[] = [
      { matcher: 'run_shell', inputMatcher: 'rm\\s+-rf', decision: 'deny', message: 'destructive rm blocked' },
    ]
    expect(evaluatePreToolUse(hooks, 'run_shell', { cmd: 'rm -rf /' }).decision).toBe('deny')
    expect(evaluatePreToolUse(hooks, 'run_shell', { cmd: 'ls -la' }).decision).toBe('none') // 不含 rm -rf → 不命中
  })

  it('skips rules with invalid regex rather than mis-deciding', () => {
    const hooks: PreToolHook[] = [{ matcher: '(', decision: 'deny' }]
    expect(evaluatePreToolUse(hooks, 'run_shell', {}).decision).toBe('none')
  })

  it('supplies a default message for deny without one', () => {
    const r = evaluatePreToolUse([{ matcher: 'web_fetch', decision: 'deny' }], 'web_fetch', {})
    expect(r.messages[0]).toContain('web_fetch')
  })
})

describe('loadHooks', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'floom-hooks-'))
  })

  it('returns empty config when no file exists', () => {
    expect(loadHooks(dir)).toEqual({ PreToolUse: [], PostToolUse: [] })
  })

  it('loads and shapes a valid hooks.json', async () => {
    await mkdir(join(dir, '.floom'), { recursive: true })
    await writeFile(
      join(dir, '.floom', 'hooks.json'),
      JSON.stringify({ PreToolUse: [{ matcher: 'run_shell', decision: 'deny' }] }),
      'utf8',
    )
    const cfg = loadHooks(dir)
    expect(cfg.PreToolUse).toHaveLength(1)
    expect(cfg.PreToolUse![0].decision).toBe('deny')
    expect(cfg.PostToolUse).toEqual([])
  })

  it('returns empty config for malformed json', async () => {
    await mkdir(join(dir, '.floom'), { recursive: true })
    await writeFile(join(dir, '.floom', 'hooks.json'), '{ not valid json', 'utf8')
    expect(loadHooks(dir)).toEqual({ PreToolUse: [], PostToolUse: [] })
  })
})
