// 任务工具：让 agent 创建、更新、列出任务。

import type { Tool } from '../tools/types.js'
import type { TaskStore } from './store.js'
import type { TaskStatus, TaskPriority } from './types.js'

let _idCounter = 0 // 防同毫秒 ID 碰撞
const VALID_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'cancelled']

export function makeTaskCreateTool(store: TaskStore): Tool {
  return {
    spec: {
      name: 'task_create',
      description: 'Create a new task. Use this to track your progress on complex multi-step work.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Brief task title' },
          description: { type: 'string', description: 'What needs to be done' },
          parentId: { type: 'string', description: 'Optional parent task id for hierarchy' },
          priority: { type: 'string', description: 'Priority: high, medium, or low (default: medium)' },
        },
        required: ['title', 'description'],
      },
    },
    handler: async (i) => {
      const title = String(i.title ?? '').trim()
      if (!title) return 'ERROR: task title is required'
      const now = new Date().toISOString()
      const id = `t${Date.now().toString(36)}_${_idCounter++}`
      const priorityRaw = String(i.priority ?? '').toLowerCase()
      const priority: TaskPriority | undefined = ['high', 'medium', 'low'].includes(priorityRaw) ? priorityRaw as TaskPriority : undefined
      if (i.priority !== undefined && i.priority !== null && i.priority !== '' && !priority) {
        return `ERROR: invalid priority "${String(i.priority)}". Valid: high, medium, low.`
      }
      store.save({ id, title, description: String(i.description ?? ''), status: 'pending', priority, parentId: i.parentId ? String(i.parentId) : undefined, createdAt: now, updatedAt: now })
      return `Created task "${id}": ${title} [pending]`
    },
  }
}

export function makeTaskUpdateTool(store: TaskStore): Tool {
  return {
    spec: {
      name: 'task_update',
      description: 'Update a task status or add a result. Use this to mark tasks as in_progress, completed, failed, or cancelled.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id to update' },
          status: { type: 'string', description: 'New status: pending, in_progress, completed, failed, cancelled' },
          result: { type: 'string', description: 'Completion result or failure reason' },
        },
        required: ['id'],
      },
    },
    handler: async (i) => {
      const id = String(i.id).trim()
      const task = store.get(id)
      if (!task) return `ERROR: task "${id}" not found`
      if (i.status) {
        const s = String(i.status)
        if (!VALID_STATUSES.includes(s as TaskStatus)) return `ERROR: invalid status "${s}". Valid: ${VALID_STATUSES.join(', ')}`
        task.status = s as TaskStatus
      }
      if (i.result) task.result = String(i.result)
      task.updatedAt = new Date().toISOString()
      store.save(task)
      return `Updated task "${id}": ${task.title} [${task.status}]`
    },
  }
}

export function makeTaskListTool(store: TaskStore): Tool {
  return {
    spec: {
      name: 'task_list',
      description: 'List all tasks, optionally filtered by status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by status (e.g., "pending", "in_progress")' },
        },
      },
    },
    handler: async (i) => {
      const statuses = i.status ? [String(i.status) as TaskStatus] : undefined
      const tasks = store.list(statuses)
      if (tasks.length === 0) {
        const filter = i.status ? ` (status=${i.status})` : ''
        return `No tasks${filter}.`
      }
      const statusOrder: Record<TaskStatus, number> = { in_progress: 0, pending: 1, failed: 2, completed: 3, cancelled: 4 }
      const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
      tasks.sort((a, b) => {
        const s = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5)
        if (s !== 0) return s
        return (priorityOrder[a.priority ?? 'medium'] ?? 1) - (priorityOrder[b.priority ?? 'medium'] ?? 1)
      })
      const completed = tasks.filter(t => t.status === 'completed').length
      const total = tasks.length
      const header = total > 0 ? `  ${completed}/${total} completed\n` : ''
      return header + tasks.map(t => {
        const prio = t.priority === 'high' ? ' 🔴' : t.priority === 'low' ? ' 🔵' : ''
        return `  ${statusIcon(t.status)} ${t.id}${prio}  ${t.title}  [${t.status}]${t.result ? ' — ' + t.result.slice(0, 80) : ''}`
      }).join('\n')
    },
  }
}

function statusIcon(s: TaskStatus): string {
  switch (s) {
    case 'completed': return '✅'
    case 'in_progress': return '🔄'
    case 'failed': return '❌'
    case 'cancelled': return '🚫'
    default: return '⬜'
  }
}
