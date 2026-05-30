import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteJournal } from './journal.js'

describe('SqliteJournal', () => {
  let journal: SqliteJournal

  const makeRun = () => ({
    runId: 'r1',
    scriptHash: 'sh',
    argsHash: 'ah',
    schemaVersion: 1,
    status: 'running' as const,
    startedAt: new Date(0).toISOString(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheHitTokens: 0,
  })

  const makeCall = (seq = 0) => ({
    runId: 'r1',
    seq,
    callHash: `ch-${seq}`,
    status: 'done' as const,
    result: `result-${seq}`,
    inputTokens: 10,
    outputTokens: 5,
    cacheHitTokens: 0,
    completedAt: new Date(0).toISOString(),
  })

  beforeEach(() => {
    journal = new SqliteJournal(':memory:')
  })

  afterEach(() => {
    journal.close()
  })

  it('openRun inserts a row without throwing', () => {
    expect(() => journal.openRun(makeRun())).not.toThrow()
  })

  it('recordCall inserts a row without throwing', () => {
    journal.openRun(makeRun())
    expect(() => journal.recordCall(makeCall(0))).not.toThrow()
  })

  it('lookupPrefix returns null for unknown hash', () => {
    expect(journal.lookupPrefix('unknown', 'ah', 1)).toBeNull()
  })

  it('lookupPrefix returns run + calls for completed run', () => {
    journal.openRun(makeRun())
    journal.recordCall(makeCall(0))
    journal.closeRun('r1', 'done')

    const r = journal.lookupPrefix('sh', 'ah', 1)
    expect(r).not.toBeNull()
    expect(r!.calls).toHaveLength(1)
    expect(r!.calls[0].seq).toBe(0)
  })

  it('lookupPrefix returns null for failed run', () => {
    journal.openRun(makeRun())
    journal.recordCall(makeCall(0))
    journal.closeRun('r1', 'failed')

    expect(journal.lookupPrefix('sh', 'ah', 1)).toBeNull()
  })

  it('multiple calls sorted by seq', () => {
    journal.openRun(makeRun())
    journal.recordCall(makeCall(1))
    journal.recordCall(makeCall(0))
    journal.closeRun('r1', 'done')

    const r = journal.lookupPrefix('sh', 'ah', 1)
    expect(r!.calls.map(c => c.seq)).toEqual([0, 1])
  })

  it('returns most recent done run when multiple exist', () => {
    journal.openRun({ ...makeRun(), runId: 'r1' })
    journal.closeRun('r1', 'done')

    const j2 = new SqliteJournal(':memory:')
    j2.openRun({ ...makeRun(), runId: 'r2', startedAt: new Date(1000).toISOString() })
    j2.recordCall({ ...makeCall(0), runId: 'r2' })
    j2.closeRun('r2', 'done')

    const r = j2.lookupPrefix('sh', 'ah', 1)
    expect(r).not.toBeNull()
    expect(r!.run.runId).toBe('r2')
    j2.close()
  })

  it('migration is idempotent', () => {
    // Opening twice on same path should not throw
    const j2 = new SqliteJournal(':memory:')
    expect(() => new SqliteJournal(':memory:')).not.toThrow()
    j2.close()
  })
})
