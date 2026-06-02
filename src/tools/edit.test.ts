import { describe, it, expect, beforeEach } from 'vitest'
import { writeFile, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editTool } from './edit.js'

let file: string
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'floom-edit-'))
  file = join(dir, 'a.txt')
  await writeFile(file, 'hello world\nfoo bar\n', 'utf8')
})

describe('editTool', () => {
  it('replaces a unique string', async () => {
    const r = await editTool.handler({ path: file, old_string: 'foo bar', new_string: 'baz qux' })
    expect(r).toContain('edited')
    expect(await readFile(file, 'utf8')).toBe('hello world\nbaz qux\n')
  })
  it('errors when old_string not found', async () => {
    expect(await editTool.handler({ path: file, old_string: 'nope', new_string: 'x' })).toContain('ERROR')
  })
  it('errors when old_string is not unique', async () => {
    await writeFile(file, 'x\nx\n', 'utf8')
    expect(await editTool.handler({ path: file, old_string: 'x', new_string: 'y' })).toContain('not unique')
  })
  it('treats $-sequences in new_string literally (no special replacement patterns)', async () => {
    const r = await editTool.handler({ path: file, old_string: 'foo bar', new_string: 'price $& $1 $`' })
    expect(r).toContain('edited')
    expect(await readFile(file, 'utf8')).toBe('hello world\nprice $& $1 $`\n')
  })
})
