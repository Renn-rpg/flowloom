import type { Tool } from './types.js'

const TIMEOUT_MS = Number(process.env.FLOOM_FETCH_TIMEOUT_MS) || 15_000
const MAX_OUT = 50_000 // 返回给模型的最大字符数
const MAX_BYTES = 5_000_000 // content-length 上限
const MAX_REDIRECTS = 3
const UA = 'FlowLoom/0.8 (+coding-agent)'

// 判断主机是否为私有/环回/链路本地（SSRF 防护）。仅对 IP 字面量套用 IP 规则，
// 普通域名（如 fc.com）不会被误判。涵盖云元数据地址 169.254.169.254。
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '') // 去掉 IPv6 方括号
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true
  }
  if (h.includes(':')) {
    // IPv6 字面量
    if (h === '::1') return true // 环回
    // IPv4-mapped IPv6: ::ffff:x.x.x.x → 提取 IPv4 部分再判
    const v4mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (v4mapped) {
      const ipv4 = v4mapped[1]
      const ipParts = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (ipParts) {
        const a = Number(ipParts[1]), b = Number(ipParts[2])
        if (a === 127 || a === 10 || a === 0) return true
        if (a === 192 && b === 168) return true
        if (a === 172 && b >= 16 && b <= 31) return true
        if (a === 169 && b === 254) return true
        return false
      }
    }
    if (h.startsWith('fe80:')) return true // 链路本地
    if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
    return false
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true // 链路本地 / 云元数据
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  return false // 普通域名放行
}

export function parseUrl(
  raw: string,
  allowPrivate: boolean,
): { url: URL } | { error: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { error: 'invalid URL' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: `unsupported scheme "${u.protocol}" (only http/https)` }
  }
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    return { error: 'refusing to fetch a private/loopback/link-local address (use --yolo to allow)' }
  }
  return { url: u }
}

// 极简 HTML→文本：去掉 script/style/注释/标签，解码常见实体，压缩空白。
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function makeWebFetchTool(
  opts: { allowPrivate?: boolean; fetchImpl?: typeof globalThis.fetch } = {},
): Tool {
  const allowPrivate = opts.allowPrivate ?? false
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  return {
    spec: {
      name: 'web_fetch',
      description:
        'Fetch a public http/https URL and return its text content (HTML is reduced to readable text). Blocks private/loopback addresses; times out; truncates large pages.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    handler: async (i) => {
      const raw = String(i.url)
      const first = parseUrl(raw, allowPrivate)
      if ('error' in first) return `ERROR: ${first.error}: ${raw}`

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        let url = first.url.href
        let res: Response | undefined
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          res = await doFetch(url, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': UA },
          })
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location')
            if (!loc) break
            // 每一跳都重新做 SSRF 校验，防止重定向绕过
            const next = parseUrl(new URL(loc, url).href, allowPrivate)
            if ('error' in next) return `ERROR: blocked redirect (${next.error}): ${loc}`
            url = next.url.href
            continue
          }
          break
        }
        if (!res) return `ERROR: no response: ${raw}`
        if (res.status >= 300 && res.status < 400) return `ERROR: too many redirects: ${raw}`
        if (!res.ok) return `ERROR: HTTP ${res.status} for ${raw}`

        const ct = (res.headers.get('content-type') ?? '').toLowerCase()
        const clen = Number(res.headers.get('content-length') ?? 0)
        if (clen && clen > MAX_BYTES) return `ERROR: response too large (${clen} bytes): ${raw}`

        const body = await res.text()
        let text: string
        if (ct.includes('html')) text = htmlToText(body)
        else if (ct === '' || ct.includes('json') || ct.includes('text') || ct.includes('xml')) text = body
        else return `(non-text content: ${ct}, ${body.length} bytes) from ${raw}`

        if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + `\n… (truncated; ${text.length} chars total)`
        return text || '(empty response)'
      } catch (e: any) {
        if (e?.name === 'AbortError') return `ERROR: fetch timed out after ${TIMEOUT_MS}ms: ${raw}`
        return `ERROR: fetch failed: ${e?.message ?? String(e)}`
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
