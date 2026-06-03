import { describe, it, expect } from 'vitest'
import { isPrivateHost, parseUrl, htmlToText, makeWebFetchTool } from './web-fetch.js'

// 构造一个 Response 形态的假对象
function fakeRes(opts: {
  status?: number
  headers?: Record<string, string>
  body?: string
}) {
  const h = opts.headers ?? {}
  return {
    status: opts.status ?? 200,
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
    text: async () => opts.body ?? '',
  } as unknown as Response
}

// 带 ReadableStream body 的假响应，用于验证按字节上限的流式截断
function streamRes(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let i = 0
  return {
    status: 200,
    ok: true,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
    text: async () => Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
  } as unknown as Response
}

// 测试用确定性 DNS：默认把任意域名解析成公网 IP，保持单测无网络依赖
const publicLookup = async () => ['93.184.216.34']

describe('isPrivateHost', () => {
  it('flags loopback / private / link-local IPv4', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.9.9', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateHost(h)).toBe(true)
    }
  })
  it('flags localhost and internal suffixes', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('db.internal')).toBe(true)
    expect(isPrivateHost('foo.local')).toBe(true)
  })
  it('flags IPv6 loopback / ULA / link-local', () => {
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('[::1]')).toBe(true)
    expect(isPrivateHost('fe80::1')).toBe(true)
    expect(isPrivateHost('fc00::1')).toBe(true)
  })
  it('allows public hosts and lookalike domains', () => {
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    expect(isPrivateHost('172.32.0.1')).toBe(false) // 出了私网段
    expect(isPrivateHost('fc.com')).toBe(false) // 不是 IPv6 字面量
  })
})

describe('parseUrl', () => {
  it('rejects non-http(s) schemes', () => {
    expect(parseUrl('file:///etc/passwd', true)).toEqual({ error: expect.stringContaining('scheme') })
    expect(parseUrl('ftp://x', true)).toEqual({ error: expect.stringContaining('scheme') })
  })
  it('rejects private hosts unless allowPrivate', () => {
    expect('error' in parseUrl('http://127.0.0.1/x', false)).toBe(true)
    expect('url' in parseUrl('http://127.0.0.1/x', true)).toBe(true)
  })
  it('accepts public https URLs', () => {
    const r = parseUrl('https://example.com/docs', false)
    expect('url' in r && r.url.hostname).toBe('example.com')
  })
})

describe('htmlToText', () => {
  it('strips tags, scripts and styles, decodes entities', () => {
    const html = '<html><head><style>x{}</style><script>evil()</script></head><body><h1>Hi</h1><p>A &amp; B</p></body></html>'
    const out = htmlToText(html)
    expect(out).not.toContain('evil')
    expect(out).not.toContain('<')
    expect(out).toContain('Hi')
    expect(out).toContain('A & B')
  })
})

describe('makeWebFetchTool handler', () => {
  it('blocks a private URL without ever calling fetch', async () => {
    let called = false
    const tool = makeWebFetchTool({ fetchImpl: (async () => { called = true; return fakeRes({}) }) as unknown as typeof fetch })
    const out = await tool.handler({ url: 'http://169.254.169.254/latest/meta-data/' })
    expect(out).toContain('ERROR')
    expect(out).toContain('private')
    expect(called).toBe(false)
  })

  it('returns reduced text for an HTML page', async () => {
    const fetchImpl = (async () =>
      fakeRes({ headers: { 'content-type': 'text/html' }, body: '<p>Hello <b>world</b></p>' })) as unknown as typeof fetch
    const tool = makeWebFetchTool({ fetchImpl, lookupImpl: publicLookup })
    const out = await tool.handler({ url: 'https://example.com' })
    expect(out).toContain('Hello')
    expect(out).toContain('world')
    expect(out).not.toContain('<p>')
  })

  it('passes through text/plain', async () => {
    const fetchImpl = (async () =>
      fakeRes({ headers: { 'content-type': 'text/plain' }, body: 'raw text body' })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl, lookupImpl: publicLookup }).handler({ url: 'https://example.com/x.txt' })
    expect(out).toBe('raw text body')
  })

  it('reports HTTP errors', async () => {
    const fetchImpl = (async () => fakeRes({ status: 404 })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl, lookupImpl: publicLookup }).handler({ url: 'https://example.com/missing' })
    expect(out).toContain('ERROR: HTTP 404')
  })

  it('blocks a redirect that points at a private address', async () => {
    const fetchImpl = (async () =>
      fakeRes({ status: 302, headers: { location: 'http://127.0.0.1/' } })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl, lookupImpl: publicLookup }).handler({ url: 'https://example.com/redir' })
    expect(out).toContain('blocked redirect')
  })

  it('blocks a domain that resolves to a private address (DNS rebinding) without fetching', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return fakeRes({}) }) as unknown as typeof fetch
    const tool = makeWebFetchTool({ fetchImpl, lookupImpl: async () => ['127.0.0.1'] })
    const out = await tool.handler({ url: 'https://rebind.attacker.example/' })
    expect(out).toContain('ERROR')
    expect(out).toContain('private')
    expect(called).toBe(false)
  })

  it('blocks a redirect to a domain that resolves to a private address', async () => {
    // 第一跳是公网域名 → 放行;重定向到一个解析到内网的域名 → 拦
    const lookupImpl = async (host: string) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34'])
    const fetchImpl = (async () =>
      fakeRes({ status: 302, headers: { location: 'http://internal.example/' } })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl, lookupImpl }).handler({ url: 'https://example.com/redir' })
    expect(out).toContain('blocked redirect')
    expect(out).toContain('private')
  })

  it('rejects a response whose streamed body exceeds the byte cap', async () => {
    // 6 × 1MB chunk = 6MB > MAX_BYTES(5MB),且不带 content-length → 靠流式截断兜底
    const chunks = Array.from({ length: 6 }, () => new Uint8Array(1_000_000))
    const fetchImpl = (async () =>
      streamRes(chunks, { 'content-type': 'text/plain' })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl, lookupImpl: publicLookup }).handler({ url: 'https://example.com/huge' })
    expect(out).toContain('ERROR')
    expect(out).toContain('too large')
  })

  it('reads a small streamed body normally', async () => {
    const chunks = [Buffer.from('hello '), Buffer.from('stream')].map((b) => new Uint8Array(b))
    const fetchImpl = (async () =>
      streamRes(chunks, { 'content-type': 'text/plain' })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl, lookupImpl: publicLookup }).handler({ url: 'https://example.com/s.txt' })
    expect(out).toBe('hello stream')
  })
})
