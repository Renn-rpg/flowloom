import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from './types.js'
export const editTool: Tool = {
  spec: {
    name: 'edit_file',
    description: 'Replace one exact, unique occurrence of old_string with new_string in a file. Fails if old_string is absent or appears more than once.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
  },
  handler: async (i) => {
    const path = String(i.path), oldS = String(i.old_string), newS = String(i.new_string)
    const content = await readFile(path, 'utf8')
    const count = content.split(oldS).length - 1
    if (count === 0) return `ERROR: old_string not found in ${path}`
    if (count > 1) return `ERROR: old_string is not unique in ${path} (${count} matches)`
    await writeFile(path, content.replace(oldS, newS), 'utf8')
    return `edited ${path}`
  },
}
