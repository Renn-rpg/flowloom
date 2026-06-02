import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGrepTool } from './grep.js'
import { confineToRoot, denySecrets } from './permissions.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'floom-grep-'))
  await writeFile(join(dir, 'foo.ts'), 'hello\nworld TODO\nbye\n', 'utf8')
  await writeFile(join(dir, 'bar.txt'), 'nothing\nTODO here\n', 'utf8')
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'skip.ts'), 'TODO in deps\n', 'utf8')
  await writeFile(join(dir, '.env'), 'SECRET=TODO-do-not-leak\n', 'utf8')
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0x54, 0x4f, 0x44, 0x4f, 0x00, 0x01]))
})

describe('grep tool', () => {
  const tool = () => makeGrepTool(denySecrets(confineToRoot(dir)))

  it('finds matching lines as relpath:line: text', async () => {
    const out = await tool().handler({ pattern: 'TODO' })
    expect(out).toMatch(/foo\.ts:2: world TODO/)
    expect(out).toMatch(/bar\.txt:2: TODO here/)
  })

  it('skips node_modules', async () => {
    const out = await tool().handler({ pattern: 'TODO' })
    expect(out).not.toContain('skip.ts')
  })

  it('skips secret files (does not leak .env contents)', async () => {
    const out = await tool().handler({ pattern: 'TODO' })
    expect(out).not.toContain('do-not-leak')
    expect(out).not.toContain('.env')
  })

  it('skips binary files (NUL byte)', async () => {
    const out = await tool().handler({ pattern: 'TODO' })
    expect(out).not.toContain('bin.dat')
  })

  it('supports ignore_case', async () => {
    const out = await tool().handler({ pattern: 'todo', ignore_case: true })
    expect(out).toMatch(/foo\.ts:2/)
  })

  it('errors on an invalid regex', async () => {
    expect(await tool().handler({ pattern: '(' })).toContain('ERROR: invalid regex')
  })

  it('returns "no matches" when nothing matches', async () => {
    expect(await tool().handler({ pattern: 'zzz-not-present' })).toBe('no matches')
  })
})
