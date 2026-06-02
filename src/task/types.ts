// 任务系统类型定义——轻量级任务跟踪，支持平铺列表 + 可选父子关系。

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  parentId?: string // 可选父子层级
  result?: string   // 完成后的输出摘要
  createdAt: string
  updatedAt: string
}
