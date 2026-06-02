import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGlobTool } from './glob.js'
import { confineToRoot } from './permissions.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'floom-glob-'))
  await writeFile(join(dir, 'a.ts'), '', 'utf8')
  await writeFile(join(dir, 'b.ts'), '', 'utf8')
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'sub', 'c.ts'), '', 'utf8')
  await writeFile(join(dir, 'sub', 'd.txt'), '', 'utf8')
})

describe('glob tool', () => {
  it('matches files recursively with **', async () => {
    const tool = makeGlobTool(confineToRoot(dir))
    const out = await tool.handler({ pattern: '**/*.ts' })
    const lines = out.split('\n')
    expect(lines).toContain('a.ts')
    expect(lines).toContain('b.ts')
    expect(lines).toContain(join('sub', 'c.ts'))
    expect(out).not.toContain('d.txt')
  })

  it('matches only top-level with a non-recursive pattern', async () => {
    const tool = makeGlobTool(confineToRoot(dir))
    const out = await tool.handler({ pattern: '*.ts' })
    expect(out.split('\n').sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('returns "no matches" when nothing matches', async () => {
    const tool = makeGlobTool(confineToRoot(dir))
    expect(await tool.handler({ pattern: '*.rs' })).toBe('no matches')
  })

  it('confines results to the root (filters "../" escapes)', async () => {
    const tool = makeGlobTool(confineToRoot(dir))
    // 父目录里有其它内容，但都在根外 → 应被过滤为 no matches
    expect(await tool.handler({ pattern: '../*' })).toBe('no matches')
  })
})
