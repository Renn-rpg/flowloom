import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, formatMemory, type MemoryEntry } from './store.js'

describe('MemoryStore', () => {
  let dir: string
  let store: MemoryStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'floom-mem-'))
    store = new MemoryStore(dir)
  })

  it('lists no memories for empty store', () => {
    expect(store.list()).toHaveLength(0)
  })

  it('saves and loads a memory', () => {
    store.save('test-mem', { name: 'test-mem', description: 'A test memory', type: 'user', content: 'Hello world' })
    const meta = store.list()
    expect(meta).toHaveLength(1)
    expect(meta[0].name).toBe('test-mem.md')
    expect(meta[0].type).toBe('user')

    const entry = store.load('test-mem')
    expect(entry).not.toBeNull()
    expect(entry!.content).toBe('Hello world')
  })

  it('deletes a memory with empty content via tool', () => {
    store.save('del', { name: 'del', description: 'x', type: 'reference', content: 'data' })
    expect(store.list()).toHaveLength(1)
    store.delete('del')
    expect(store.list()).toHaveLength(0)
  })

  it('loadAll returns all entries', () => {
    store.save('a', { name: 'a', description: 'first', type: 'user', content: '1' })
    store.save('b', { name: 'b', description: 'second', type: 'project', content: '2' })
    const all = store.loadAll()
    expect(all).toHaveLength(2)
  })
})

describe('formatMemory', () => {
  it('produces valid frontmatter', () => {
    const entry: MemoryEntry = { name: 'test', description: 'desc', type: 'user', content: 'Body text' }
    const raw = formatMemory(entry)
    expect(raw).toContain('---')
    expect(raw).toContain('name: test')
    expect(raw).toContain('type: user')
    expect(raw).toContain('Body text')
  })
})
