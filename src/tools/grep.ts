import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import type { Tool } from './types.js'
import { type PathPolicy, allowAllPaths } from './permissions.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.floom', 'coverage'])
const MAX_RESULTS = 200
const MAX_FILE_BYTES = 2_000_000
const MAX_LINE = 300

export function makeGrepTool(paths: PathPolicy = allowAllPaths): Tool {
  return {
    spec: {
      name: 'grep',
      description:
        'Search file contents by regular expression. Returns matches as "relpath:line: text". Skips node_modules/.git/dist, dot-dirs, binary, and secret files.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'file or directory to search (default: project root)' },
          ignore_case: { type: 'boolean' },
        },
        required: ['pattern'],
      },
    },
    handler: async (i) => {
      let re: RegExp
      try {
        re = new RegExp(String(i.pattern), i.ignore_case ? 'i' : '')
      } catch (e) {
        return `ERROR: invalid regex: ${(e as Error).message}`
      }
      const base = paths.check(i.path ? String(i.path) : '.')

      let st
      try {
        st = await stat(base)
      } catch {
        return `ERROR: path not found: ${base}`
      }
      const displayRoot = st.isFile() ? dirname(base) : base

      const results: string[] = []
      let truncated = false

      const searchFile = async (abs: string) => {
        // 权限/密钥过滤：策略拒绝（出根或敏感文件）则跳过——grep 暴露内容，必须挡住密钥
        try {
          paths.check(abs)
        } catch {
          return
        }
        let buf: Buffer
        try {
          buf = await readFile(abs)
        } catch {
          return
        }
        if (buf.length > MAX_FILE_BYTES) return
        if (buf.includes(0)) return // 含 NUL 视为二进制
        const rel = relative(displayRoot, abs) || abs
        const lines = buf.toString('utf8').split('\n')
        for (let n = 0; n < lines.length; n++) {
          if (re.test(lines[n])) {
            const raw = lines[n].trimEnd()
            const text = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) + '…' : raw
            results.push(`${rel}:${n + 1}: ${text}`)
            if (results.length >= MAX_RESULTS) {
              truncated = true
              return
            }
          }
        }
      }

      const walk = async (dir: string) => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const ent of entries) {
          if (results.length >= MAX_RESULTS) return
          const abs = join(dir, ent.name)
          if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
            await walk(abs)
          } else if (ent.isFile()) {
            await searchFile(abs)
          }
        }
      }

      if (st.isFile()) await searchFile(base)
      else await walk(base)

      if (results.length === 0) return 'no matches'
      return results.join('\n') + (truncated ? `\n... (capped at ${MAX_RESULTS} matches)` : '')
    },
  }
}
