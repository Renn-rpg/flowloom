import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, type PersistedSession } from './session-store.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'floom-sess-'))
})

function mk(id: string, updatedAt: string, title = id): PersistedSession {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    model: 'deepseek-chat',
    cwd: '/proj',
    title,
    messages: [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ],
    usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
  }
}

describe('SessionStore', () => {
  it('saves then loads a session round-trip', () => {
    const store = new SessionStore(dir)
    const s = mk('s-1', '2026-05-30T10:00:00.000Z')
    store.save(s)
    const loaded = store.load('s-1')
    expect(loaded).toEqual(s)
    expect(loaded?.messages.length).toBe(2)
  })

  it('creates the directory on first save', () => {
    const store = new SessionStore(join(dir, 'nested', 'sessions'))
    store.save(mk('s-x', '2026-05-30T10:00:00.000Z'))
    expect(store.load('s-x')?.id).toBe('s-x')
  })

  it('returns null when loading a missing session', () => {
    const store = new SessionStore(dir)
    expect(store.load('nope')).toBeNull()
  })

  it('lists sessions sorted by updatedAt descending', () => {
    const store = new SessionStore(dir)
    store.save(mk('old', '2026-05-30T09:00:00.000Z'))
    store.save(mk('new', '2026-05-30T12:00:00.000Z'))
    store.save(mk('mid', '2026-05-30T10:30:00.000Z'))
    expect(store.list().map((m) => m.id)).toEqual(['new', 'mid', 'old'])
    expect(store.list()[0].messageCount).toBe(2)
  })

  it('latest() returns the most recently updated session', () => {
    const store = new SessionStore(dir)
    store.save(mk('a', '2026-05-30T09:00:00.000Z'))
    store.save(mk('b', '2026-05-30T11:00:00.000Z'))
    expect(store.latest()?.id).toBe('b')
  })

  it('list() returns [] for a non-existent directory and latest() null', () => {
    const store = new SessionStore(join(dir, 'does-not-exist'))
    expect(store.list()).toEqual([])
    expect(store.latest()).toBeNull()
  })

  it('skips corrupt json files when listing', async () => {
    const store = new SessionStore(dir)
    store.save(mk('good', '2026-05-30T10:00:00.000Z'))
    await writeFile(join(dir, 'bad.json'), '{ not valid json', 'utf8')
    expect(store.list().map((m) => m.id)).toEqual(['good'])
  })

  it('rejects path-traversal ids on save and load', () => {
    const store = new SessionStore(dir)
    expect(() => store.save(mk('../escape', '2026-05-30T10:00:00.000Z'))).toThrow(/invalid session id/)
    expect(store.load('../../etc/passwd')).toBeNull()
  })
})
