import type { Tool } from './types.js'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const TIMEOUT_MS = Number(process.env.FLOOM_FETCH_TIMEOUT_MS) || 15_000
const MAX_OUT = 50_000 // 返回给模型的最大字符数
const MAX_BYTES = 5_000_000 // content-length 上限
const MAX_REDIRECTS = 3
const UA = 'FlowLoom/0.10 (+coding-agent)'

// 简单 LRU 内存缓存：避免同一 URL 短时间内重复抓取
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟
const CACHE_MAX = 100
const fetchCache = new Map<string, { text: string; ts: number }>()

function cacheGet(url: string): string | null {
  const entry = fetchCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    fetchCache.delete(url)
    return null
  }
  // LRU: 移到末尾
  fetchCache.delete(url)
  fetchCache.set(url, entry)
  return entry.text
}

function cacheSet(url: string, text: string): void {
  if (fetchCache.size >= CACHE_MAX) {
    // 删除最旧条目
    const oldest = fetchCache.keys().next().value
    if (oldest) fetchCache.delete(oldest)
  }
  fetchCache.set(url, { text, ts: Date.now() })
}

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
    // 拒绝前导零的八进制 IP 记法（如 0177.0.0.1 → 部分解析器按八进制处理成 127.0.0.1）
    const octets = [m[1], m[2], m[3], m[4]]
    if (octets.some(o => o.startsWith('0') && o.length > 1)) return true
    const a = Number(octets[0])
    const b = Number(octets[1])
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true // 链路本地 / 云元数据
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  // 拒绝纯数字 IP（十进制整数表示，如 http://2130706433/ → 127.0.0.1）
  if (/^\d+$/.test(h)) {
    const n = BigInt(h)
    if (n <= 0xFFFFFFFFn) {
      const a = Number((n >> 24n) & 0xFFn)
      const b = Number((n >> 16n) & 0xFFn)
      if (a === 127 || a === 10 || a === 0) return true
      if (a === 192 && b === 168) return true
      if (a === 172 && b >= 16 && b <= 31) return true
      if (a === 169 && b === 254) return true
      return true // 保守策略：任何纯数字 IP 都拒绝
    }
  }
  // 拒绝十六进制 IP（如 http://0x7f000001/ → 127.0.0.1）
  if (/^0x[0-9a-fA-F]{8}$/.test(h)) {
    return true // 保守策略：任何十六进制 IP 都拒绝
  }
  return false // 普通域名放行
}

// 把主机名解析成真实 IP 列表（注入便于测试）。DNS 重绑定防护：只校验主机名字符串不够，
// 一个普通域名可以解析到内网/环回 IP（如 evil.com → 127.0.0.1）绕过 isPrivateHost。
export type HostLookup = (hostname: string) => Promise<string[]>

const defaultLookup: HostLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

// 对「域名」做解析后 IP 校验（IP 字面量已被 parseUrl/isPrivateHost 同步拦过，跳过）。
// 返回 null = 放行，否则返回错误原因。解析失败按「失败关闭」处理（拦截）。
// 注：解析与实际连接之间仍有 TOCTOU 窗口（攻击者可在校验后翻转 DNS）；彻底消除需把连接钉死到
// 已校验的 IP（自定义 dispatcher），此处先封堵最常见的「域名直接指向内网」情形。
export async function assertHostPublic(
  hostname: string,
  allowPrivate: boolean,
  lookup: HostLookup,
): Promise<string | null> {
  if (allowPrivate) return null
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (isIP(bare) !== 0) return null // 纯 IP 字面量：isPrivateHost 已校验过
  let addrs: string[]
  try {
    addrs = await lookup(hostname)
  } catch {
    return `cannot resolve host "${hostname}"`
  }
  for (const ip of addrs) {
    if (isPrivateHost(ip)) return `host "${hostname}" resolves to a private/loopback address (${ip})`
  }
  return null
}

// 读取响应体并按字节上限截断：缺失 content-length 时仍能防超大响应耗尽内存。
// 返回 null = 超过 maxBytes。无 ReadableStream（如单测 mock）时回退到 text()。
export async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const body = (res as unknown as { body?: ReadableStream<Uint8Array> }).body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          try { await reader.cancel() } catch { /* ignore */ }
          return null
        }
        chunks.push(Buffer.from(value))
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  return res.text()
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
  opts: { allowPrivate?: boolean; fetchImpl?: typeof globalThis.fetch; lookupImpl?: HostLookup } = {},
): Tool {
  const allowPrivate = opts.allowPrivate ?? false
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const lookup = opts.lookupImpl ?? defaultLookup
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

      // 检查缓存
      const cached = cacheGet(first.url.href)
      if (cached) return cached

      // DNS 重绑定防护：对首个目标做解析后 IP 校验
      const hostErr = await assertHostPublic(first.url.hostname, allowPrivate, lookup)
      if (hostErr) return `ERROR: ${hostErr}: ${raw}`

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        let url = first.url
        let res: Response | undefined
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          res = await doFetch(url.href, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': UA },
          })
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location')
            if (!loc) break
            // 每一跳都重新做 SSRF 字符串校验 + 解析后 IP 校验，防止重定向绕过
            const next = parseUrl(new URL(loc, url.href).href, allowPrivate)
            if ('error' in next) return `ERROR: blocked redirect (${next.error}): ${loc}`
            const nextHostErr = await assertHostPublic(next.url.hostname, allowPrivate, lookup)
            if (nextHostErr) return `ERROR: blocked redirect (${nextHostErr}): ${loc}`
            url = next.url
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

        // 读取响应体并按字节上限截断（缺失 content-length 时仍受保护，防内存膨胀）
        const body = await readCapped(res, MAX_BYTES)
        if (body === null) return `ERROR: response too large (exceeds ${MAX_BYTES} bytes): ${raw}`
        let text: string
        if (ct.includes('html')) text = htmlToText(body)
        else if (ct === '' || ct.includes('json') || ct.includes('text') || ct.includes('xml')) text = body
        else return `(non-text content: ${ct}, ${body.length} bytes) from ${raw}`

        if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + `\n… (truncated; ${text.length} chars total)`
        const result = text || '(empty response)'
        cacheSet(first.url.href, result)
        return result
      } catch (e: any) {
        if (e?.name === 'AbortError') return `ERROR: fetch timed out after ${TIMEOUT_MS}ms: ${raw}`
        return `ERROR: fetch failed: ${e?.message ?? String(e)}`
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
