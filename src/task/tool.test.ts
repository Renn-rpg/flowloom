import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store.js'
import { makeTaskCreateTool, makeTaskUpdateTool, makeTaskListTool } from './tool.js'

// 每次 makeStore 一个独立的系统临时目录（保持调用间隔离），全部在 afterAll 清理——
// 不在仓库工作树里留 .floom-test-* 产物。
const createdDirs: string[] = []

function makeStore(): TaskStore {
  const dir = mkdtempSync(join(tmpdir(), 'floom-task-tools-'))
  createdDirs.push(dir)
  return new TaskStore(dir)
}

afterAll(() => {
  for (const d of createdDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ok */ }
  }
})

function extractId(result: string): string {
  const m = result.match(/"([^"]+)"/)
  return m ? m[1] : ''
}

async function createTask(store: TaskStore, title: string, description: string, extras: Record<string, unknown> = {}): Promise<string> {
  const tool = makeTaskCreateTool(store)
  const result = await tool.handler({ title, description, ...extras })
  const id = extractId(result)
  if (!id) throw new Error(`Failed to extract ID from: ${result}`)
  return id
}

describe('task_create', () => {
  it('creates a task with required fields', async () => {
    const store = makeStore()
    const tool = makeTaskCreateTool(store)
    const result = await tool.handler({ title: 'My Task', description: 'Do stuff' })
    expect(result).toContain('Created task')
    expect(result).toContain('My Task')
    expect(result).toContain('[pending]')
  })

  it('rejects empty title', async () => {
    const store = makeStore()
    const tool = makeTaskCreateTool(store)
    const result = await tool.handler({ title: '', description: 'x' })
    expect(result).toContain('ERROR: task title is required')
  })

  it('creates with parentId', async () => {
    const store = makeStore()
    const id = await createTask(store, 'Child', 'Sub-task', { parentId: 'tparent' })
    const task = store.get(id)
    expect(task?.parentId).toBe('tparent')
  })
})

describe('task_update', () => {
  it('updates status', async () => {
    const store = makeStore()
    const updateTool = makeTaskUpdateTool(store)
    const id = await createTask(store, 'Task', 'Work')

    const result = await updateTool.handler({ id, status: 'in_progress' })
    expect(result).toContain('[in_progress]')
    expect(store.get(id)?.status).toBe('in_progress')
  })

  it('rejects invalid status', async () => {
    const store = makeStore()
    const updateTool = makeTaskUpdateTool(store)
    const id = await createTask(store, 'Task', 'Work')

    const result = await updateTool.handler({ id, status: 'bogus' })
    expect(result).toContain('ERROR: invalid status')
  })

  it('rejects update for non-existent task', async () => {
    const result = await makeTaskUpdateTool(makeStore()).handler({ id: 'nonexistent', status: 'in_progress' })
    expect(result).toContain('ERROR: task "nonexistent" not found')
  })

  it('allows any status change (no transition validation)', async () => {
    const store = makeStore()
    const updateTool = makeTaskUpdateTool(store)
    const id = await createTask(store, 'Task', 'Work')

    // pending → completed (direct, no transition check)
    const result = await updateTool.handler({ id, status: 'completed' })
    expect(result).not.toContain('ERROR')
    expect(store.get(id)?.status).toBe('completed')
  })
})

describe('task_list', () => {
  it('lists tasks sorted by status priority', async () => {
    const store = makeStore()
    const updateTool = makeTaskUpdateTool(store)
    const listTool = makeTaskListTool(store)
    const idA = await createTask(store, 'Task A', 'x')
    const idB = await createTask(store, 'Task B', 'x')
    await updateTool.handler({ id: idB, status: 'in_progress' })

    const result = await listTool.handler({})
    const idxA = result.indexOf('Task A')
    const idxB = result.indexOf('Task B')
    expect(idxB).toBeLessThan(idxA)
  })

  it('filters by status', async () => {
    const store = makeStore()
    const updateTool = makeTaskUpdateTool(store)
    const listTool = makeTaskListTool(store)
    const idA = await createTask(store, 'Task A', 'x')
    await createTask(store, 'Task B', 'x')
    await updateTool.handler({ id: idA, status: 'in_progress' })

    const result = await listTool.handler({ status: 'in_progress' })
    expect(result).toContain('Task A')
    expect(result).not.toContain('Task B')
  })

  it('shows "No tasks" when empty', async () => {
    const result = await makeTaskListTool(makeStore()).handler({})
    expect(result).toContain('No tasks')
  })
})
