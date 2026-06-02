import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from './types.js'
import { type PathPolicy, allowAllPaths } from './permissions.js'

interface EditOp {
  old_string: string
  new_string: string
}

export function makeMultiEditTool(paths: PathPolicy = allowAllPaths): Tool {
  return {
    spec: {
      name: 'multi_edit',
      description:
        'Apply multiple exact-and-unique string replacements to a single file, atomically (all-or-nothing). Edits apply in order; each old_string must occur exactly once in the content as modified by prior edits. If any edit fails, the file is left unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: { old_string: { type: 'string' }, new_string: { type: 'string' } },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    handler: async (i) => {
      const path = paths.check(String(i.path))
      const edits = i.edits as EditOp[] | undefined
      if (!Array.isArray(edits) || edits.length === 0) {
        return 'ERROR: edits must be a non-empty array'
      }
      // 先在内存里串行应用全部编辑，全部成功后才落盘一次 → 原子（任一失败文件不动）
      let content = await readFile(path, 'utf8')
      for (let k = 0; k < edits.length; k++) {
        const oldS = String(edits[k]?.old_string ?? '')
        const newS = String(edits[k]?.new_string ?? '')
        if (oldS === '') return `ERROR: edit #${k + 1}: old_string is empty`
        if (oldS === newS) return `ERROR: edit #${k + 1}: old_string and new_string are identical`
        const count = content.split(oldS).length - 1
        if (count === 0) return `ERROR: edit #${k + 1}: old_string not found in ${path}`
        if (count > 1) return `ERROR: edit #${k + 1}: old_string is not unique in ${path} (${count} matches)`
        // split/join 字面替换：避免 String.replace 把 new_string 里的 $&/$1/$` 当成特殊替换模式
        content = content.split(oldS).join(newS)
      }
      await writeFile(path, content, 'utf8')
      return `edited ${path} (${edits.length} edits)`
    },
  }
}

// 向后兼容的非受限单例
export const multiEditTool = makeMultiEditTool()
