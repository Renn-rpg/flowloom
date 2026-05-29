import { describe, it, expect, beforeAll } from 'vitest'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTool } from './read.js'

let file: string
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'floom-'))
  file = join(dir, 'a.txt')
  await writeFile(file, 'hello world', 'utf8')
})

describe('readTool', () => {
  it('returns file contents', async () => {
    expect(await readTool.handler({ path: file })).toContain('hello world')
  })
})
