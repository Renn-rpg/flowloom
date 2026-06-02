import { describe, it, expect, beforeAll } from 'vitest'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { makeReadTool } from './read.js'
import { confineToRoot, denySecrets } from './permissions.js'

let dir: string
let file: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'floom-'))
  file = join(dir, 'a.txt')
  await writeFile(file, 'hello world', 'utf8')
})

describe('readTool', () => {
  it('returns file contents', async () => {
    const tool = makeReadTool()
    expect(await tool.handler({ path: file })).toContain('hello world')
  })
})

describe('makeReadTool with confineToRoot', () => {
  it('reads a file inside the root', async () => {
    const tool = makeReadTool(confineToRoot(dir))
    expect(await tool.handler({ path: 'a.txt' })).toContain('hello world')
  })

  it('rejects reading a file outside the root', async () => {
    const tool = makeReadTool(confineToRoot(join(dir, 'sub')))
    await expect(
      tool.handler({ path: join(dirname(file), 'a.txt') }),
    ).rejects.toThrow(/outside the project root/)
  })

  it('refuses to read a secret file even when it exists in root', async () => {
    const tool = makeReadTool(denySecrets(confineToRoot(dir)))
    await writeFile(join(dir, '.env'), 'DEEPSEEK_API_KEY=sk-leak', 'utf8')
    await expect(tool.handler({ path: '.env' })).rejects.toThrow(/secret\/credential/)
  })
})
