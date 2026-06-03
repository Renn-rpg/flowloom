// 任务系统类型定义——轻量级任务跟踪，支持平铺列表 + 可选父子关系。

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
export type TaskPriority = 'high' | 'medium' | 'low'

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority?: TaskPriority
  parentId?: string
  result?: string
  createdAt: string
  updatedAt: string
}
