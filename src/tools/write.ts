import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from './types.js'
export const writeTool: Tool = {
  spec: { name: 'write_file', description: 'Write a UTF-8 text file (creates dirs)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  handler: async (i) => { const p = String(i.path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, String(i.content), 'utf8'); return `wrote ${p}` },
}
