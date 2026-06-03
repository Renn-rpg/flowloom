import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeWebSearchTool } from './web-search.js'

// DuckDuckGo lite 返回的简化 HTML 片段（模拟真实响应）
function ddgHtml(results: Array<{ title: string; url: string; snippet: string }>): string {
  const lines: string[] = []
  for (const r of results) {
    lines.push(`<a rel="nofollow" href="${r.url}">${r.title}</a>`)
  }
  for (const r of results) {
    if (r.snippet) lines.push(`<span class="snippet">${r.snippet}</span>`)
  }
  return `<html><body>${lines.join('\n')}</body></html>`
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals?.()
})

describe('makeWebSearchTool', () => {
  describe('handler validation', () => {
    it('returns ERROR when query is empty', async () => {
      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: '' })
      expect(result).toContain('ERROR')
    })

    it('returns ERROR when query is missing', async () => {
      const tool = makeWebSearchTool()
      const result = await tool.handler({})
      expect(result).toContain('ERROR')
    })

    it('returns ERROR when query is only whitespace', async () => {
      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: '   ' })
      expect(result).toContain('ERROR')
    })
  })

  describe('search results formatting', () => {
    it('returns formatted results on success', async () => {
      // Mock fetch 返回模拟 HTML
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => ddgHtml([
          { title: 'FlowLoom GitHub', url: 'https://github.com/flowloom', snippet: 'Open source agentic coding CLI' },
          { title: 'Node.js', url: 'https://nodejs.org', snippet: 'JavaScript runtime' },
        ]),
      }))

      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: 'flowloom' })

      expect(result).toContain('FlowLoom GitHub')
      expect(result).toContain('https://github.com/flowloom')
      expect(result).toContain('Open source agentic coding CLI')
      expect(result).toContain('Node.js')
      expect(result).toContain('https://nodejs.org')
    })

    it('returns "No results" message when search returns empty', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '<html><body></body></html>',
      }))

      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: 'xyznonexistent12345' })
      expect(result).toContain('No results found')
    })

    it('returns "No results" when fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: 'test' })
      expect(result).toContain('No results found')
    })

    it('returns "No results" when response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }))

      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: 'test' })
      expect(result).toContain('No results found')
    })

    it('truncates query in "No results" message to 100 chars', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '<html><body></body></html>',
      }))

      const tool = makeWebSearchTool()
      const longQuery = 'a'.repeat(200)
      const result = await tool.handler({ query: longQuery })
      expect(result).toContain('a'.repeat(100))
      expect(result).not.toContain('a'.repeat(101))
    })

    it('skips duckduckgo.com links in results', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => ddgHtml([
          { title: 'DDG Internal', url: 'https://duckduckgo.com/something', snippet: 'internal' },
          { title: 'Real Result', url: 'https://example.com', snippet: 'real content' },
        ]),
      }))

      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: 'test' })

      expect(result).toContain('Real Result')
      expect(result).toContain('https://example.com')
      expect(result).not.toContain('duckduckgo.com')
    })

    it('limits results to 8 max', async () => {
      const manyResults = Array.from({ length: 12 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        snippet: `Snippet ${i}`,
      }))

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => ddgHtml(manyResults),
      }))

      const tool = makeWebSearchTool()
      const result = await tool.handler({ query: 'test' })

      // 检查有 8 个编号的结果
      expect(result).toContain('1.')
      expect(result).toContain('8.')
      expect(result).not.toContain('9.')
    })
  })
})
