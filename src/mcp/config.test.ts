import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpConfig } from './config.js'

describe('loadMcpConfig', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'floom-mcp-'))
  })

  const write = async (obj: unknown) => {
    await mkdir(join(dir, '.floom'), { recursive: true })
    await writeFile(join(dir, '.floom', 'mcp.json'), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')
  }

  it('returns empty when no file exists', () => {
    expect(loadMcpConfig(dir)).toEqual({ mcpServers: {} })
  })

  it('loads valid servers with args/env', async () => {
    await write({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs', '/tmp'], env: { TOKEN: 'x' } } } })
    const cfg = loadMcpConfig(dir)
    expect(cfg.mcpServers.fs.command).toBe('npx')
    expect(cfg.mcpServers.fs.args).toEqual(['-y', 'server-fs', '/tmp'])
    expect(cfg.mcpServers.fs.env).toEqual({ TOKEN: 'x' })
  })

  it('drops entries without a valid command', async () => {
    await write({ mcpServers: { bad: { args: ['x'] }, ok: { command: 'node' } } })
    const cfg = loadMcpConfig(dir)
    expect(cfg.mcpServers.bad).toBeUndefined()
    expect(cfg.mcpServers.ok.command).toBe('node')
  })

  it('skips disabled servers', async () => {
    await write({ mcpServers: { off: { command: 'node', disabled: true } } })
    expect(loadMcpConfig(dir).mcpServers.off).toBeUndefined()
  })

  it('coerces away non-string args/env values', async () => {
    await write({ mcpServers: { s: { command: 'node', args: ['a', 2, 'b'], env: { A: 'x', B: 5 } } } })
    const s = loadMcpConfig(dir).mcpServers.s
    expect(s.args).toEqual(['a', 'b'])
    expect(s.env).toEqual({ A: 'x' })
  })

  it('returns empty for malformed json', async () => {
    await write('{ not json')
    expect(loadMcpConfig(dir)).toEqual({ mcpServers: {} })
  })
})
