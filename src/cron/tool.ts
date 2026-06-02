// Cron 工具：让 agent 创建/管理定时任务。

import type { Tool } from '../tools/types.js'
import type { CronScheduler } from './scheduler.js'
import type { CronStore } from './store.js'

export function makeCronCreateTool(scheduler: CronScheduler, store: CronStore): Tool {
  return {
    spec: {
      name: 'cron_create',
      description:
        'Schedule a task to run at a future time or on a recurring schedule. ' +
        'Uses standard 5-field cron: minute hour day-of-month month day-of-week. ' +
        'Examples: "0 9 * * *" (daily at 9am), "*/5 * * * *" (every 5 minutes).',
      inputSchema: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: '5-field cron expression (e.g. "0 9 * * *")' },
          prompt: { type: 'string', description: 'task description to execute when triggered' },
          durable: { type: 'boolean', description: 'persist across sessions (default: true)' },
        },
        required: ['expr', 'prompt'],
      },
    },
    handler: async (i) => {
      const expr = String(i.expr ?? '').trim()
      const prompt = String(i.prompt ?? '').trim()
      if (!expr || !prompt) return 'ERROR: expr and prompt are required'

      const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      try {
        scheduler.add({
          id,
          expr,
          prompt,
          durable: i.durable !== false,
          nextRun: new Date().toISOString(),
        })
        return `Scheduled cron job ${id}: "${expr}" → "${prompt.slice(0, 80)}"`
      } catch (e: any) {
        return `ERROR: cron schedule failed: ${e.message}`
      }
    },
  }
}

export function makeCronListTool(scheduler: CronScheduler): Tool {
  return {
    spec: {
      name: 'cron_list',
      description: 'List all scheduled cron jobs.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async () => {
      const jobs = scheduler.list()
      if (jobs.length === 0) return 'No scheduled cron jobs.'
      return jobs.map(j =>
        `  ${j.id}  ${j.expr}  →  "${j.prompt.slice(0, 60)}"  next: ${j.nextRun.slice(0, 19)}  ${j.durable ? '' : '(session)'}`
      ).join('\n')
    },
  }
}

export function makeCronDeleteTool(scheduler: CronScheduler): Tool {
  return {
    spec: {
      name: 'cron_delete',
      description: 'Delete a scheduled cron job by its id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    handler: async (i) => {
      const id = String(i.id ?? '').trim()
      if (!id) return 'ERROR: cron job id is required'
      return scheduler.remove(id) ? `Deleted cron job ${id}.` : `Cron job "${id}" not found.`
    },
  }
}
