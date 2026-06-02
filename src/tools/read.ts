import { readFile, stat } from 'node:fs/promises'
import type { Tool } from './types.js'
import { type PathPolicy, allowAllPaths } from './permissions.js'

const MAX_FILE_BYTES = 2_000_000 // 2MB 上限，防大文件吃内存

export function makeReadTool(paths: PathPolicy = allowAllPaths): Tool {
  return {
    spec: { name: 'read_file', description: 'Read a UTF-8 text file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    handler: async (i) => {
      const path = paths.check(String(i.path))
      const s = await stat(path)
      if (s.size > MAX_FILE_BYTES) return `ERROR: file too large (${s.size} bytes); max is ${MAX_FILE_BYTES}`
      return readFile(path, 'utf8')
    },
  }
}
