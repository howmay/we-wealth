import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

let server, auth, worker, drive
const profile = { sub: 'account-a', email: 'a@example.com', name: 'Alice' }
const token = { value: 'test-token', expiresAt: Date.now() + 3600_000 }
const storage = new Map()
const tabStorage = new Map()
const originalFetch = globalThis.fetch

before(async () => {
  server = await createServer({ configFile: false, envDir: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    define: { 'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify('test-client') } })
  auth = await server.ssrLoadModule('/src/google/auth.ts')
  worker = (await server.ssrLoadModule('/worker/index.ts')).default
  drive = await server.ssrLoadModule('/src/google/drive.ts')
})
beforeEach(() => {
  storage.clear()
  tabStorage.clear()
  globalThis.sessionStorage = {
    getItem: (key) => tabStorage.get(key) ?? null,
    setItem: (key, value) => tabStorage.set(key, value),
    removeItem: (key) => tabStorage.delete(key),
  }
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  globalThis.fetch = originalFetch
})
after(async () => { globalThis.fetch = originalFetch; delete globalThis.localStorage; delete globalThis.sessionStorage; delete globalThis.window; await server?.close() })

test('the bearer token is never written to localStorage and survives a reload only in sessionStorage', () => {
  auth.storeSession({ token, profile })
  assert.ok(!JSON.stringify([...storage.values()]).includes('test-token'))
  assert.equal(auth.loadSession()?.profile.email, 'a@example.com')
  assert.equal(auth.loadSession()?.token?.value, 'test-token')
})

test('a stored token is dropped when expired or when it belongs to another account', () => {
  auth.storeSession({ token: { value: 'old', expiresAt: Date.now() + 1000 }, profile })
  assert.equal(auth.loadSession()?.token, undefined)
  assert.equal(tabStorage.size, 0)
  auth.storeSession({ token, profile })
  storage.set('we-wealth.session', JSON.stringify({ profile: { ...profile, sub: 'account-b' } }))
  assert.equal(auth.loadSession()?.token, undefined)
})

test('signing out clears the token and the profile', () => {
  auth.storeSession({ token, profile })
  auth.clearSession()
  assert.equal(storage.size, 0)
  assert.equal(tabStorage.size, 0)
})

test('loading a legacy session removes its stored bearer token', () => {
  storage.set('we-wealth.session', JSON.stringify({ token, profile }))
  const session = auth.loadSession()
  assert.equal(session?.token, undefined)
  assert.ok(!JSON.stringify([...storage.values()]).includes('test-token'))
  storage.set('we-wealth.session', '{"token":"test-token"')
  assert.equal(auth.loadSession(), null)
  assert.equal(storage.has('we-wealth.session'), false)
})

test('a renewed token from another Google account cannot be used to save existing data', async () => {
  globalThis.window = { google: { accounts: { oauth2: {
    initTokenClient: ({ callback }) => ({ requestAccessToken: () => callback({ access_token: 'other-token', expires_in: 3600 }) }),
    hasGrantedAllScopes: () => true,
  } } } }
  globalThis.fetch = async () => Response.json({ sub: 'account-b', email: profile.email, name: 'Bob' })
  await assert.rejects(() => auth.renewAccessToken(profile), /帳號/)
})

test('a renewed token from the same account is accepted', async () => {
  globalThis.window = { google: { accounts: { oauth2: {
    initTokenClient: ({ callback }) => ({ requestAccessToken: () => callback({ access_token: 'same-token', expires_in: 3600 }) }),
    hasGrantedAllScopes: () => true,
  } } } }
  globalThis.fetch = async () => Response.json(profile)
  assert.equal((await auth.renewAccessToken(profile)).value, 'same-token')
})

test('userinfo without a stable account identifier is rejected', async () => {
  globalThis.fetch = async () => Response.json({ email: 'a@example.com', name: 'Alice' })
  await assert.rejects(() => auth.fetchProfile(token))
})

test('HTML responses prevent framing and restrict script execution', async () => {
  const response = await worker.fetch(new Request('https://example.com/'), {
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) },
  })
  const csp = response.headers.get('Content-Security-Policy') ?? ''
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /script-src 'self' 'sha256-[^']+' https:\/\/accounts\.google\.com\/gsi\/client/)
  assert.ok(!csp.split(';').find((part) => part.includes('script-src'))?.includes('unsafe-inline'))
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
})

test('only OCR JavaScript assets may compile WebAssembly', async () => {
  for (const [path, contentType, allowed] of [
    ['/ocr/7.0.0/worker.min.js', 'text/javascript; charset=utf-8', true],
    ['/ocr/7.0.0/core/tesseract-core-lstm.wasm.js', 'application/javascript', true],
    ['/ocr/missing', 'text/html', false],
    ['/assets/pdf.worker.min.mjs', 'application/javascript', false],
    ['/expenses', 'text/html', false],
  ]) {
    const response = await worker.fetch(new Request(`https://example.com${path}`), {
      ASSETS: { fetch: async () => new Response('', { headers: { 'Content-Type': contentType } }) },
    })
    const csp = response.headers.get('Content-Security-Policy') ?? ''
    assert.equal(csp.includes("'wasm-unsafe-eval'"), allowed, path)
    assert.ok(!csp.includes("'unsafe-eval'"), path)
  }
})

test('the CSP allows exactly the inline scripts in index.html', async () => {
  const response = await worker.fetch(new Request('https://example.com/'), {
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) },
  })
  const allowed = [...(response.headers.get('Content-Security-Policy') ?? '').matchAll(/'sha256-([^']+)'/g)].map((m) => m[1])
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => createHash('sha256').update(m[1]).digest('base64'))
  assert.ok(inline.length > 0)
  assert.deepEqual(allowed.sort(), inline.sort())
})

test('legacy plaintext Drive files remain readable', async () => {
  const data = { version: 1, accounts: [] }
  globalThis.fetch = async (url) => new URL(url).searchParams.has('alt')
    ? Response.json(data) : new URL(url).pathname.endsWith('/file-a')
      ? Response.json({ id: 'file-a', etag: '"v1"', headRevisionId: 'r1' }) : Response.json({ files: [{ id: 'file-a' }] })
  assert.deepEqual(await drive.loadData(token, (raw) => raw), { fileId: 'file-a', etag: '"v1"', data })
})

test('invalid quote symbols cannot turn the proxy into an arbitrary URL fetcher', async () => {
  globalThis.fetch = async () => { assert.fail('invalid symbols must not reach the network') }
  const response = await worker.fetch(new Request('https://example.com/api/quote?symbol=https://evil.example'), {})
  assert.equal(response.status, 404)
})

test('HTML responses stay revalidated even though the Worker runs first', async () => {
  const env = { ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) } }
  const response = await worker.fetch(new Request('https://example.com/privacy'), env)
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate')
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store')
})

test('only the public pages are indexable; app routes and the API are marked noindex', async () => {
  const env = { ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) } }
  const robots = async (path) => (await worker.fetch(new Request(`https://example.com${path}`), env)).headers.get('X-Robots-Tag')
  for (const path of ['/', '/index.html', '/privacy', '/privacy/', '/terms.html', '/disclaimer']) assert.equal(await robots(path), null, path)
  for (const path of ['/app', '/accounts', '/history', '/privacy/extra', '/no-such-page']) assert.equal(await robots(path), 'noindex', path)
  globalThis.fetch = async () => { assert.fail('invalid symbols must not reach the network') }
  assert.equal(await robots('/api/quote?symbol=%20'), 'noindex')
})

test('the Worker\'s indexable paths match the public pages in the sitemap', async () => {
  const { PAGES } = await server.ssrLoadModule('/src/site.ts')
  const { INDEXABLE_PATHS } = await server.ssrLoadModule('/worker/index.ts')
  assert.deepEqual([...INDEXABLE_PATHS].sort(), ['/', ...Object.values(PAGES).map((p) => p.path)].sort())
})
