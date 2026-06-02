// 任务持久化：JSON 文件存储，简洁可审计。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type { Task, TaskStatus } from './types.js'

export class TaskStore {
  private path: string

  constructor(cwd: string) {
    this.path = resolve(cwd, '.floom', 'tasks.json')
  }

  private read(): Task[] {
    try {
      if (!existsSync(this.path)) return []
      const raw = readFileSync(this.path, 'utf8')
      return JSON.parse(raw) as Task[]
    } catch {
      return []
    }
  }

  private write(tasks: Task[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(tasks, null, 2), 'utf8')
  }

  save(task: Task): void {
    const tasks = this.read().filter(t => t.id !== task.id)
    tasks.push(task)
    this.write(tasks)
  }

  get(id: string): Task | undefined {
    return this.read().find(t => t.id === id)
  }

  list(statuses?: TaskStatus[]): Task[] {
    const tasks = this.read()
    if (statuses && statuses.length > 0) return tasks.filter(t => statuses.includes(t.status))
    return tasks
  }

  delete(id: string): boolean {
    const tasks = this.read()
    const idx = tasks.findIndex(t => t.id === id)
    if (idx === -1) return false
    tasks.splice(idx, 1)
    this.write(tasks)
    return true
  }
}
