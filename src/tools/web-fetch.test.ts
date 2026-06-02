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
    const tool = makeWebFetchTool({ fetchImpl })
    const out = await tool.handler({ url: 'https://example.com' })
    expect(out).toContain('Hello')
    expect(out).toContain('world')
    expect(out).not.toContain('<p>')
  })

  it('passes through text/plain', async () => {
    const fetchImpl = (async () =>
      fakeRes({ headers: { 'content-type': 'text/plain' }, body: 'raw text body' })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl }).handler({ url: 'https://example.com/x.txt' })
    expect(out).toBe('raw text body')
  })

  it('reports HTTP errors', async () => {
    const fetchImpl = (async () => fakeRes({ status: 404 })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl }).handler({ url: 'https://example.com/missing' })
    expect(out).toContain('ERROR: HTTP 404')
  })

  it('blocks a redirect that points at a private address', async () => {
    const fetchImpl = (async () =>
      fakeRes({ status: 302, headers: { location: 'http://127.0.0.1/' } })) as unknown as typeof fetch
    const out = await makeWebFetchTool({ fetchImpl }).handler({ url: 'https://example.com/redir' })
    expect(out).toContain('blocked redirect')
  })
})
