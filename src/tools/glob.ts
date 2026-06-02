import { glob } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Tool } from './types.js'
import { type PathPolicy, allowAllPaths } from './permissions.js'

const MAX_MATCHES = 1000

export function makeGlobTool(paths: PathPolicy = allowAllPaths): Tool {
  return {
    spec: {
      name: 'glob',
      description:
        'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.ts"). Returns matching paths relative to the search base, one per line, sorted.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'base directory to search from (default: project root)' },
        },
        required: ['pattern'],
      },
    },
    handler: async (i) => {
      const pattern = String(i.pattern)
      // 含 ".." 段的模式会试图爬出根目录，对编码 agent 没有合法用途，直接拒绝（防逃逸）。
      if (pattern.split(/[\\/]/).includes('..')) return 'no matches'
      const base = paths.check(i.path ? String(i.path) : '.')
      const matches: string[] = []
      let capped = false
      for await (const entry of glob(pattern, { cwd: base })) {
        // 把结果约束在根目录内（挡住 "../" 逃逸），顺带跳过敏感命名
        try {
          paths.check(resolve(base, entry))
        } catch {
          continue
        }
        matches.push(entry)
        if (matches.length >= MAX_MATCHES) {
          capped = true
          break
        }
      }
      if (matches.length === 0) return 'no matches'
      matches.sort()
      return matches.join('\n') + (capped ? `\n... (capped at ${MAX_MATCHES})` : '')
    },
  }
}

// 向后兼容的非受限单例
export const globTool = makeGlobTool()
