// remember 工具：让 agent 主动写入/更新/删除记忆。
// 仅对 agent 暴露，不在 slash 命令中直接调用。

import type { Tool } from '../tools/types.js'
import type { MemoryStore, MemoryType } from '../memory/store.js'

export function makeRememberTool(store: MemoryStore): Tool {
  return {
    spec: {
      name: 'remember',
      description:
        'Write/update/delete a persistent memory (survives across sessions, auto-recalled on startup). ' +
        'Use for user preferences, project conventions, known issues, and references. Unique kebab-case name required.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Unique kebab-case identifier for this memory, e.g. "user-prefers-tabs" or "project-auth-pattern"',
          },
          description: {
            type: 'string',
            description: 'One-line summary — used to decide relevance during recall',
          },
          type: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
            description: 'Memory category',
          },
          content: {
            type: 'string',
            description: 'The body of the memory. For feedback/project types, include **Why:** and **How to apply:** lines. Leave empty to delete the memory.',
          },
        },
        required: ['name', 'description'],
      },
    },
    handler: async (input) => {
      const name = String(input.name ?? '').trim()
      if (!name) return 'ERROR: memory name is required'
      // slug 验证：只允许字母数字短横下划线
      if (!/^[a-z0-9_-]+$/.test(name)) {
        return 'ERROR: memory name must be a kebab-case slug (lowercase letters, digits, hyphens, underscores)'
      }

      const content = typeof input.content === 'string' ? input.content.trim() : ''
      const type: MemoryType = ['user', 'feedback', 'project', 'reference'].includes(String(input.type ?? ''))
        ? String(input.type) as MemoryType
        : 'reference'

      if (!content) {
        // 空内容 = 删除
        const deleted = store.delete(name)
        return deleted ? `Deleted memory "${name}".` : `Memory "${name}" not found — nothing to delete.`
      }

      const entry = {
        name,
        description: String(input.description ?? '').trim(),
        type,
        content,
      }

      store.save(name, entry)
      return `Saved memory "${name}" (${type}).`
    },
  }
}
