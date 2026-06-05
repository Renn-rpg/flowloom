import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadKeybindings } from './load.js'
import type { Keybinding } from './types.js'

// 使用临时目录隔离，避免受开发者机器上 ~/.floom/keybindings.json 影响。

const homedirPath = join(tmpdir(), 'floom-test-home')
const cwdPath = join(tmpdir(), 'floom-test-cwd')

// 收集所有 DEFAULTS 中需要的 context（用于后续断言）
const ALL_CONTEXTS = ['global', 'chat', 'autocomplete', 'select', 'workflow-view', 'modal', 'help']

describe('loadKeybindings', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Mock homedir 返回临时路径
    vi.mock('node:os', async (importOriginal) => {
      const mod = await importOriginal<typeof import('node:os')>()
      return { ...mod, homedir: () => homedirPath }
    })
    // 清理并重建临时目录
    rmSync(homedirPath, { recursive: true, force: true })
    rmSync(cwdPath, { recursive: true, force: true })
    mkdirSync(join(homedirPath, '.floom'), { recursive: true })
    mkdirSync(join(cwdPath, '.floom'), { recursive: true })
  })

  afterEach(() => {
    rmSync(homedirPath, { recursive: true, force: true })
    rmSync(cwdPath, { recursive: true, force: true })
  })

  it('loads defaults when no config files exist', () => {
    const result = loadKeybindings(cwdPath)
    expect(result.bindings.length).toBeGreaterThan(0)
    expect(result.bindings.some((b: Keybinding) => b.context === 'global')).toBe(true)
    expect(result.bindings.some((b: Keybinding) => b.context === 'chat')).toBe(true)
  })

  it('includes all required contexts', () => {
    const result = loadKeybindings(cwdPath)
    const contexts = new Set(result.bindings.map((b: Keybinding) => b.context))
    for (const ctx of ALL_CONTEXTS) {
      expect(contexts.has(ctx)).toBe(true)
    }
  })

  it('each binding has required fields', () => {
    const result = loadKeybindings(cwdPath)
    for (const b of result.bindings) {
      expect(b.key).toBeTruthy()
      expect(b.action).toBeTruthy()
      expect(b.context).toBeTruthy()
    }
  })

  it('no duplicate (context, key) pairs', () => {
    const result = loadKeybindings(cwdPath)
    const seen = new Set<string>()
    for (const b of result.bindings) {
      const id = `${b.context}:${b.key}`
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })

  it('merges project config over defaults', () => {
    const projectConfig = {
      bindings: [
        { key: 'ctrl+o', action: 'my-custom-expand', context: 'chat' as const, description: 'Custom expand' },
      ],
    }
    writeFileSync(join(cwdPath, '.floom', 'keybindings.json'), JSON.stringify(projectConfig))

    const result = loadKeybindings(cwdPath)
    const chatCtrlO = result.bindings.filter((b: Keybinding) => b.context === 'chat' && b.key === 'ctrl+o')
    expect(chatCtrlO.length).toBe(1)
    expect(chatCtrlO[0].action).toBe('my-custom-expand')
  })

  it('reports errors for invalid JSON in config', () => {
    writeFileSync(join(cwdPath, '.floom', 'keybindings.json'), 'not json')

    const result = loadKeybindings(cwdPath)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.bindings.length).toBeGreaterThan(0) // 仍 fallback 到默认
  })
})
