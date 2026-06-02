import { readFile } from 'node:fs/promises'
import type { Tool } from './types.js'
import { type PathPolicy, allowAllPaths } from './permissions.js'

export function makeReadTool(paths: PathPolicy = allowAllPaths): Tool {
  return {
    spec: { name: 'read_file', description: 'Read a UTF-8 text file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    handler: async (i) => readFile(paths.check(String(i.path)), 'utf8'),
  }
}

// 向后兼容的非受限单例（probe.ts / 既有测试依赖）
export const readTool = makeReadTool()
