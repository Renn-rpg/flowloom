import { readFile } from 'node:fs/promises'
import type { Tool } from './types.js'
export const readTool: Tool = {
  spec: { name: 'read_file', description: 'Read a UTF-8 text file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  handler: async (i) => readFile(String(i.path), 'utf8'),
}
