// WebSearch 工具：基于 DuckDuckGo HTML 搜索（免费，无需 API key）。
// 搜索结果返回标题+URL+摘要，agent 可进一步用 web_fetch 获取详情。

import type { Tool } from './types.js'

const TIMEOUT_MS = 15_000
const UA = 'FlowLoom/0.8 (+coding-agent)'
const MAX_RESULTS = 8

interface SearchResult {
  title: string
  url: string
  snippet: string
}

// 从 DuckDuckGo HTML 搜索页提取结果（lite 版本更简洁，无 JS）。
async function searchDDG(query: string): Promise<SearchResult[]> {
  const u = new URL('https://lite.duckduckgo.com/lite/')
  u.searchParams.set('q', query)
  u.searchParams.set('kd', '-1') // 不限地区

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(u.href, {
      headers: { 'user-agent': UA },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const html = await res.text()

    // 解析 HTML：提取链接和描述
    // lite.ddg 的结构: <a rel="nofollow" href="...">title</a> ... <span class="snippet">description</span>
    const results: SearchResult[] = []
    // 匹配链接行
    const linkRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/g
    const snippetRe = /<span class="(?:snippet|link-text)">([^<]+)<\/span>/g

    let linkMatch
    const links: { url: string; title: string }[] = []
    while ((linkMatch = linkRe.exec(html)) !== null) {
      if (linkMatch[1].includes('duckduckgo.com')) continue
      const title = linkMatch[2].replace(/<[^>]+>/g, '').trim()
      if (title) links.push({ url: linkMatch[1], title })
    }

    let snippetMatch
    const snippets: string[] = []
    while ((snippetMatch = snippetRe.exec(html)) !== null) {
      const s = snippetMatch[1].replace(/<[^>]+>/g, '').trim()
      if (s) snippets.push(s)
    }

    for (let i = 0; i < Math.min(links.length, MAX_RESULTS); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] ?? '',
      })
    }
    return results
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export function makeWebSearchTool(): Tool {
  return {
    spec: {
      name: 'web_search',
      description:
        'Search the web for information. Returns title, URL, and snippet for each result. ' +
        `Up to ${MAX_RESULTS} results. Use web_fetch to read the full content of a result by its URL.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'search query' },
        },
        required: ['query'],
      },
    },
    handler: async (i) => {
      const query = String(i.query ?? '').trim()
      if (!query) return 'ERROR: search query is required'

      const results = await searchDDG(query)
      if (results.length === 0) return `No results found for "${query.slice(0, 100)}".`

      return results.map((r, idx) =>
        `${idx + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      ).join('\n\n')
    },
  }
}
