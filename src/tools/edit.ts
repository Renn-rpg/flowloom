import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Tool } from './types.js'
import { type PathPolicy, allowAllPaths } from './permissions.js'

export function makeEditTool(paths: PathPolicy = allowAllPaths): Tool {
  return {
    spec: {
      name: 'edit_file',
      description: 'Replace one exact, unique occurrence of old_string with new_string in a file. Fails if old_string is absent or appears more than once.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
    },
    handler: async (i) => {
      const path = paths.check(String(i.path)), oldS = String(i.old_string), newS = String(i.new_string)
      const content = await readFile(path, 'utf8')
      const count = content.split(oldS).length - 1
      if (count === 0) return `ERROR: old_string not found in ${path}`
      if (count > 1) return `ERROR: old_string is not unique in ${path} (${count} matches)`
      // split/join 做字面替换：避免 String.replace 把 new_string 里的 $&/$1/$` 当成特殊替换模式
      const updated = content.split(oldS).join(newS)
      // 原子写入：先写临时文件再 rename，避免 TOCTOU 竞态与中途崩溃文件损坏
      const tmpPath = join(dirname(path), `.floom-edit-${Math.random().toString(36).slice(2)}.tmp`)
      await writeFile(tmpPath, updated, 'utf8')
      try {
        await rename(tmpPath, path)
      } catch {
        // rename 失败（如跨设备/权限）→ 清理临时文件
        try { await unlink(tmpPath) } catch { /* best-effort */ }
        throw new Error(`Failed to replace ${path}: rename failed`)
      }
      return `edited ${path}`
    },
  }
}
