import { describe, it, expect } from 'vitest'
import { computeCompletions } from './completions.js'

describe('computeCompletions', () => {
  it('returns no menu for non-slash input', () => {
    expect(computeCompletions('hello')).toEqual({ kind: 'none', items: [] })
    expect(computeCompletions('')).toEqual({ kind: 'none', items: [] })
  })

  it('lists every command for a bare slash', () => {
    const c = computeCompletions('/')
    expect(c.kind).toBe('command')
    const labels = c.items.map((i) => i.label)
    expect(labels).toContain('/help')
    expect(labels).toContain('/effort')
    expect(labels).toContain('/exit')
    // 补全项填回完整 buffer
    expect(c.items.find((i) => i.label === '/clear')?.replacement).toBe('/clear')
  })

  it('filters commands by prefix', () => {
    const c = computeCompletions('/e')
    expect(c.kind).toBe('command')
    expect(c.items.map((i) => i.label).sort()).toEqual(['/effort', '/exit'])
  })

  it('completes a partial unique command without descending into args', () => {
    const c = computeCompletions('/ex')
    expect(c.kind).toBe('command')
    expect(c.items).toHaveLength(1)
    expect(c.items[0].replacement).toBe('/exit')
  })

  it('shows arg options once a command with args is fully typed', () => {
    const c = computeCompletions('/effort')
    expect(c.kind).toBe('arg')
    expect(c.items.map((i) => i.label)).toEqual(['max', 'high', 'normal'])
    expect(c.items[0].replacement).toBe('/effort max')
  })

  it('shows arg options after a trailing space', () => {
    const c = computeCompletions('/effort ')
    expect(c.kind).toBe('arg')
    expect(c.items).toHaveLength(3)
  })

  it('filters arg options by the partial argument', () => {
    const c = computeCompletions('/effort h')
    expect(c.kind).toBe('arg')
    expect(c.items.map((i) => i.label)).toEqual(['high'])
    expect(c.items[0].replacement).toBe('/effort high')
  })

  it('no menu for a fully-typed no-arg command (so Enter runs it)', () => {
    const c = computeCompletions('/clear')
    expect(c.kind).toBe('command')
    expect(c.items).toHaveLength(1)
    expect(c.items[0].replacement).toBe('/clear')
  })

  it('no menu for a command that takes no enumerable args', () => {
    expect(computeCompletions('/plan ').items).toHaveLength(0)
    expect(computeCompletions('/plan extra').items).toHaveLength(0)
  })

  it('no menu for an unknown command with a space', () => {
    expect(computeCompletions('/bogus arg').items).toHaveLength(0)
  })
})

describe('computeCompletions — @ file completion', () => {
  // 假目录树:'.' 根、'src' 子目录
  const tree: Record<string, { name: string; isDir: boolean }[]> = {
    '.': [
      { name: 'src', isDir: true },
      { name: 'node_modules', isDir: true },
      { name: 'package.json', isDir: false },
      { name: 'README.md', isDir: false },
      { name: '.env', isDir: false },
    ],
    src: [
      { name: 'cli.ts', isDir: false },
      { name: 'cli', isDir: true },
      { name: 'agent', isDir: true },
    ],
  }
  const listDir = (d: string) => tree[d] ?? []
  const deps = { listDir }

  it('does nothing without a listDir dependency (stays pure)', () => {
    expect(computeCompletions('see @src/')).toEqual({ kind: 'none', items: [] })
  })

  it('lists cwd entries on a bare @, dirs first, skipping noise and dotfiles', () => {
    const c = computeCompletions('explain @', deps)
    expect(c.kind).toBe('file')
    const labels = c.items.map((i) => i.label)
    // 目录在前(带 /)、隐藏文件与 node_modules 被过滤
    expect(labels).toEqual(['src/', 'package.json', 'README.md'])
  })

  it('keeps the @ prefix and appends a space for files, slash for dirs', () => {
    const c = computeCompletions('explain @', deps)
    expect(c.items.find((i) => i.label === 'src/')?.replacement).toBe('explain @src/')
    expect(c.items.find((i) => i.label === 'package.json')?.replacement).toBe('explain @package.json ')
  })

  it('descends into a subdirectory and filters by the name fragment', () => {
    const c = computeCompletions('see @src/cl', deps)
    expect(c.kind).toBe('file')
    expect(c.items.map((i) => i.label)).toEqual(['cli/', 'cli.ts'])
    expect(c.items.find((i) => i.label === 'cli.ts')?.replacement).toBe('see @src/cli.ts ')
    expect(c.items.find((i) => i.label === 'cli/')?.replacement).toBe('see @src/cli/')
  })

  it('shows dotfiles only when the fragment starts with a dot', () => {
    const c = computeCompletions('@.', deps)
    expect(c.items.map((i) => i.label)).toEqual(['.env'])
  })

  it('does not trigger on an email-like a@b (no whitespace before @)', () => {
    expect(computeCompletions('mail to a@b', deps)).toEqual({ kind: 'none', items: [] })
  })

  it('@ completion wins over slash logic when both could apply', () => {
    const c = computeCompletions('/foo @src/', deps)
    expect(c.kind).toBe('file')
    expect(c.items.map((i) => i.label)).toEqual(['agent/', 'cli/', 'cli.ts'])
  })

  it('returns an empty file menu (not slash) when nothing matches the fragment', () => {
    const c = computeCompletions('@zzz', deps)
    expect(c.kind).toBe('file')
    expect(c.items).toHaveLength(0)
  })
})
