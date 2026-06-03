import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store.js'
import type { Task } from './types.js'

// 每个测试一个独立的系统临时目录，跑完即删——不在仓库工作树里留产物。
let tmpDir: string

function makeStore(): TaskStore {
  return new TaskStore(tmpDir)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'floom-task-store-'))
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ok */ }
})

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't123',
    title: 'Test Task',
    description: 'A test task',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('TaskStore - CRUD', () => {
  it('stores and retrieves a task', () => {
    const store = makeStore()
    store.save(makeTask())
    expect(store.get('t123')?.title).toBe('Test Task')
  })

  it('returns undefined for missing task', () => {
    const store = makeStore()
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('updates an existing task', () => {
    const store = makeStore()
    store.save(makeTask())
    store.save(makeTask({ title: 'Updated', status: 'in_progress' }))
    expect(store.get('t123')?.title).toBe('Updated')
    expect(store.get('t123')?.status).toBe('in_progress')
  })

  it('deletes a task', () => {
    const store = makeStore()
    store.save(makeTask())
    expect(store.delete('t123')).toBe(true)
    expect(store.get('t123')).toBeUndefined()
  })

  it('returns false when deleting missing task', () => {
    expect(makeStore().delete('nonexistent')).toBe(false)
  })

  it('lists all tasks', () => {
    const store = makeStore()
    store.save(makeTask({ id: 't1', title: 'A' }))
    store.save(makeTask({ id: 't2', title: 'B' }))
    expect(store.list()).toHaveLength(2)
  })

  it('filters tasks by status', () => {
    const store = makeStore()
    store.save(makeTask({ id: 't1', status: 'pending' }))
    store.save(makeTask({ id: 't2', status: 'completed' }))
    store.save(makeTask({ id: 't3', status: 'in_progress' }))
    expect(store.list(['pending'])).toHaveLength(1)
    expect(store.list(['pending', 'completed'])).toHaveLength(2)
  })

  it('persists across instances', () => {
    const s1 = makeStore()
    s1.save(makeTask())
    const s2 = new TaskStore(tmpDir)
    expect(s2.get('t123')?.title).toBe('Test Task')
  })
})
