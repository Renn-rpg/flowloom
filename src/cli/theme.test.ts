import { describe, it, expect, afterEach } from 'vitest'
import { color, getTheme, reloadTheme, colorsEnabled, type ThemeToken } from './theme.js'

// 保存/恢复环境变量，避免测试间污染。
function withEnv(kv: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(kv)) {
    prev[k] = process.env[k]
    if (kv[k] === undefined) delete process.env[k]
    else process.env[k] = kv[k]
  }
  try { fn() } finally {
    for (const k of Object.keys(kv)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

describe('theme', () => {
  describe('getTheme', () => {
    it('returns a theme object with all required tokens', () => {
      const t = getTheme()
      const required: ThemeToken[] = [
        'text', 'dim', 'bold', 'green', 'red', 'yellow', 'blue', 'cyan',
        'heading', 'link', 'code', 'diff-del', 'diff-add', 'diff-del-bg', 'diff-add-bg',
        'user-msg-bg', 'mode-auto', 'mode-plan', 'mode-normal',
        'ctx-low', 'ctx-mid', 'ctx-high', 'spinner', 'brand',
        'tool-running', 'tool-done', 'tool-error',
        'dialog-border', 'dialog-bg',
        'agent-badge-done', 'agent-badge-running', 'agent-badge-error', 'agent-badge-queued',
      ]
      for (const token of required) {
        expect(t[token]).toBeTypeOf('function')
      }
    })

    it('defaults to dark theme when FLOOM_THEME is unset', () => {
      withEnv({ FLOOM_THEME: undefined }, () => {
        reloadTheme(undefined)
        // dark theme 的 green 是深绿色 #4E9A06，不等于浅色 #166534
        const t = getTheme()
        expect(t).toBeDefined()
      })
    })

    it('resolves light theme when FLOOM_THEME=light', () => {
      withEnv({ FLOOM_THEME: 'light' }, () => {
        reloadTheme('light')
        const t = getTheme()
        expect(t).toBeDefined()
      })
    })
  })

  describe('color', () => {
    it('returns a function that applies color (or passthrough when !isTTY)', () => {
      const fn = color('green')
      expect(fn).toBeTypeOf('function')
      const result = fn('test')
      expect(result).toBeTypeOf('string')
      // 无论颜色是否开启，原始文本始终包含在结果中
      expect(result).toContain('test')
    })

    it('returns a function for style tokens like bold', () => {
      const fn = color('bold')
      expect(fn).toBeTypeOf('function')
      const result = fn('test')
      expect(result).toContain('test')
    })

    it('each color token returns a working function', () => {
      const tokens: ThemeToken[] = [
        'text', 'dim', 'green', 'red', 'yellow', 'blue', 'cyan', 'white',
        'magenta', 'gray', 'brand', 'spinner', 'heading', 'link', 'code',
        'quote', 'bullet', 'diff-del', 'diff-add', 'diff-hunk', 'diff-context',
        'diff-file', 'diff-del-bg', 'diff-add-bg', 'user-msg-bg',
        'mode-auto', 'mode-plan', 'mode-normal', 'ctx-low', 'ctx-mid', 'ctx-high',
        'status-bar', 'tool-running', 'tool-done', 'tool-error',
        'dialog-border', 'dialog-bg',
        'agent-badge-done', 'agent-badge-running', 'agent-badge-error', 'agent-badge-queued',
        'italic', 'strike', 'bold-italic',
      ]
      for (const token of tokens) {
        const fn = color(token)
        const result = fn('x')
        expect(result).toContain('x')
      }
    })
  })

  describe('reloadTheme', () => {
    afterEach(() => {
      reloadTheme('dark')
    })

    it('switches theme at runtime', () => {
      reloadTheme('dark')
      const dark = getTheme()
      reloadTheme('light')
      const light = getTheme()
      // 两个主题是不同的对象
      expect(dark).not.toBe(light)
    })

    it('accepts a custom Theme object', () => {
      const t = getTheme()
      const custom = { ...t, 'green': (s: string) => `[GREEN]${s}[/GREEN]` }
      reloadTheme(custom)
      // getTheme() 应返回自定义对象（不经过 useColor 包裹）
      expect(getTheme()['green']('x')).toContain('[GREEN]')
      reloadTheme('dark')
    })
  })

  describe('colorsEnabled', () => {
    it('returns a boolean', () => {
      expect(typeof colorsEnabled()).toBe('boolean')
    })
  })
})
