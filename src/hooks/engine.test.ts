import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluatePreToolUse,
  evaluatePostToolUse,
  expandHookCommand,
  loadHooks,
  type PreToolHook,
  type PostToolHook,
} from './engine.js'

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

describe('evaluatePostToolUse', () => {
  it('returns [] when there are no hooks', () => {
    expect(evaluatePostToolUse([], 'write_file', {})).toEqual([])
    expect(evaluatePostToolUse(undefined, 'write_file', {})).toEqual([])
  })

  it('matches tool name by regex; missing matcher matches any tool', () => {
    const hooks: PostToolHook[] = [{ matcher: '^write_file$', command: 'prettier --write ${path}' }]
    expect(evaluatePostToolUse(hooks, 'write_file', { path: 'a.ts' })).toHaveLength(1)
    expect(evaluatePostToolUse(hooks, 'read_file', { path: 'a.ts' })).toHaveLength(0)
    const anyHook: PostToolHook[] = [{ command: 'echo done' }]
    expect(evaluatePostToolUse(anyHook, 'anything', {})).toHaveLength(1)
  })

  it('drops hooks without a command and passes note through', () => {
    const hooks: PostToolHook[] = [
      { matcher: '.*', note: 'just a note, no command' },
      { matcher: '.*', command: 'git add .', note: 'stage changes' },
    ]
    const actions = evaluatePostToolUse(hooks, 'edit_file', {})
    expect(actions).toEqual([{ command: 'git add .', note: 'stage changes' }])
  })

  it('skips hooks with an invalid matcher regex', () => {
    const hooks: PostToolHook[] = [{ matcher: '(', command: 'echo bad' }]
    expect(evaluatePostToolUse(hooks, 'write_file', {})).toEqual([])
  })
})

describe('expandHookCommand', () => {
  it('substitutes ${key} from input', () => {
    expect(expandHookCommand('prettier --write ${path}', { path: 'src/a.ts' })).toBe('prettier --write src/a.ts')
  })

  it('substitutes multiple distinct vars', () => {
    expect(expandHookCommand('${a}-${b}', { a: 'x', b: 'y' })).toBe('x-y')
  })

  it('replaces a missing key with an empty string (no throw)', () => {
    expect(expandHookCommand('fmt ${path}', {})).toBe('fmt ')
  })

  it('leaves non-template text untouched', () => {
    expect(expandHookCommand('git status', { path: 'a.ts' })).toBe('git status')
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
  })

  it('returns empty config for malformed json', async () => {
    await mkdir(join(dir, '.floom'), { recursive: true })
    await writeFile(join(dir, '.floom', 'hooks.json'), '{ not valid json', 'utf8')
    expect(loadHooks(dir)).toEqual({ PreToolUse: [], PostToolUse: [] })
  })
})
