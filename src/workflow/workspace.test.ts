import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Workspace } from './workspace.js'

describe('Workspace', () => {
  const workspaces: Workspace[] = []
  afterEach(async () => {
    await Promise.all(workspaces.map((w) => w.cleanup().catch(() => {})))
    workspaces.length = 0
  })

  async function makeWs() {
    const ws = await Workspace.create()
    workspaces.push(ws)
    return ws
  }

  it('creates a temp directory', async () => {
    const ws = await makeWs()
    expect(ws.root).toBeTruthy()
    expect(ws.root).toContain('floom-ws-')
  })

  it('resolve returns joined path for relative input', async () => {
    const ws = await makeWs()
    const resolved = ws.resolve('src/index.ts')
    expect(resolved).toBe(join(ws.root, 'src/index.ts'))
    expect(resolved.startsWith(ws.root)).toBe(true)
  })

  it('resolve rejects absolute paths', async () => {
    const ws = await makeWs()
    expect(() => ws.resolve('/etc/passwd')).toThrow()
    expect(() => ws.resolve('C:\\foo')).toThrow()
  })

  it('resolve rejects .. escape attempts', async () => {
    const ws = await makeWs()
    expect(() => ws.resolve('../outside')).toThrow()
    expect(() => ws.resolve('foo/../../bar')).toThrow()
  })

  it('resolve allows nested subdirectories', async () => {
    const ws = await makeWs()
    const resolved = ws.resolve('a/b/c/file.txt')
    expect(resolved).toBe(join(ws.root, 'a', 'b', 'c', 'file.txt'))
  })

  it('files written to workspace are inside workspace', async () => {
    const ws = await makeWs()
    const p = ws.resolve('test.txt')
    await writeFile(p, 'hello')
    const content = await readFile(p, 'utf8')
    expect(content).toBe('hello')
  })

  it('cleanup removes the workspace directory', async () => {
    const ws = await Workspace.create()
    const p = ws.resolve('file.txt')
    await writeFile(p, 'data')
    await ws.cleanup()
    await expect(readFile(p, 'utf8')).rejects.toThrow()
  })
})
