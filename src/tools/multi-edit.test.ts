import { describe, it, expect, beforeEach } from 'vitest'
import { writeFile, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { multiEditTool } from './multi-edit.js'

let file: string
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'floom-medit-'))
  file = join(dir, 'a.ts')
  await writeFile(file, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')
})

describe('multiEditTool', () => {
  it('applies multiple edits to one file', async () => {
    const r = await multiEditTool.handler({
      path: file,
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 10' },
        { old_string: 'const c = 3', new_string: 'const c = 30' },
      ],
    })
    expect(r).toContain('2 edits')
    expect(await readFile(file, 'utf8')).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
  })

  it('applies edits in order (later edit sees earlier result)', async () => {
    const r = await multiEditTool.handler({
      path: file,
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 99' },
        { old_string: 'const a = 99', new_string: 'const a = 100' }, // 命中前一处的产物
      ],
    })
    expect(r).toContain('2 edits')
    expect(await readFile(file, 'utf8')).toContain('const a = 100')
  })

  it('is atomic: a failing edit leaves the file unchanged', async () => {
    const before = await readFile(file, 'utf8')
    const r = await multiEditTool.handler({
      path: file,
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 10' }, // 本可成功
        { old_string: 'NOPE_NOT_PRESENT', new_string: 'x' }, // 第二处失败 → 整体回滚
      ],
    })
    expect(r).toContain('ERROR')
    expect(r).toContain('#2')
    expect(await readFile(file, 'utf8')).toBe(before) // 文件未被改动
  })

  it('errors when an old_string is not unique', async () => {
    await writeFile(file, 'x\nx\n', 'utf8')
    const r = await multiEditTool.handler({ path: file, edits: [{ old_string: 'x', new_string: 'y' }] })
    expect(r).toContain('not unique')
  })

  it('errors on empty edits array', async () => {
    expect(await multiEditTool.handler({ path: file, edits: [] })).toContain('non-empty array')
  })

  it('errors when old_string equals new_string', async () => {
    const r = await multiEditTool.handler({ path: file, edits: [{ old_string: 'const a = 1', new_string: 'const a = 1' }] })
    expect(r).toContain('identical')
  })

  it('treats $-sequences in new_string literally', async () => {
    await multiEditTool.handler({ path: file, edits: [{ old_string: 'const b = 2', new_string: 'const b = "$& $1 $`"' }] })
    expect(await readFile(file, 'utf8')).toContain('const b = "$& $1 $`"')
  })
})
