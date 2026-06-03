import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeWriteTool } from './write.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'floom-write-test-'))
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ok */ }
})

describe('makeWriteTool', () => {
  it('writes file content to the given path', async () => {
    const tool = makeWriteTool()
    const filePath = join(tmpDir, 'test.txt')
    const result = await tool.handler({ path: filePath, content: 'hello world' })

    expect(result).toBe(`wrote ${filePath}`)
    expect(readFileSync(filePath, 'utf8')).toBe('hello world')
  })

  it('creates parent directories automatically', async () => {
    const tool = makeWriteTool()
    const filePath = join(tmpDir, 'deep', 'nested', 'dirs', 'file.txt')
    const result = await tool.handler({ path: filePath, content: 'nested content' })

    expect(result).toBe(`wrote ${filePath}`)
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe('nested content')
  })

  it('writes UTF-8 content (including non-ASCII)', async () => {
    const tool = makeWriteTool()
    const filePath = join(tmpDir, 'utf8.txt')
    await tool.handler({ path: filePath, content: '你好世界 🌍\némoji' })

    expect(readFileSync(filePath, 'utf8')).toBe('你好世界 🌍\némoji')
  })

  it('overwrites existing file', async () => {
    const tool = makeWriteTool()
    const filePath = join(tmpDir, 'overwrite.txt')

    await tool.handler({ path: filePath, content: 'first write' })
    await tool.handler({ path: filePath, content: 'second write' })

    expect(readFileSync(filePath, 'utf8')).toBe('second write')
  })

  it('writes empty content', async () => {
    const tool = makeWriteTool()
    const filePath = join(tmpDir, 'empty.txt')
    await tool.handler({ path: filePath, content: '' })

    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe('')
  })

  it('coerces non-string inputs to strings', async () => {
    const tool = makeWriteTool()
    const filePath = join(tmpDir, 'number.txt')
    // handler 调用 String(i.content) 和 String(i.path)
    await tool.handler({ path: filePath, content: 12345 })

    expect(readFileSync(filePath, 'utf8')).toBe('12345')
  })
})
