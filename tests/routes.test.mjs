import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server, routes

before(async () => {
  server = await createServer({ configFile: false, envDir: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false } })
  routes = await server.ssrLoadModule('/src/routes.ts')
})
after(() => server.close())

test('each signed-in page has its own URL that parses back to the same page', () => {
  const pages = [
    [{ tab: 'overview' }, '/app'],
    [{ tab: 'accounts', page: 'list' }, '/accounts'],
    [{ tab: 'accounts', page: 'list', importing: true }, '/accounts/import'],
    [{ tab: 'accounts', page: 'new' }, '/accounts/new'],
    [{ tab: 'accounts', page: 'detail', id: 'a b/c' }, '/accounts/a%20b%2Fc'],
    [{ tab: 'accounts', page: 'edit', id: 'abc' }, '/accounts/abc/edit'],
    [{ tab: 'liabilities' }, '/liabilities'],
    [{ tab: 'expenses' }, '/expenses'],
    [{ tab: 'rates' }, '/rates'],
    [{ tab: 'history' }, '/history'],
    [{ tab: 'history', date: '2026-09-01' }, '/history/2026-09-01'],
  ]
  for (const [route, path] of pages) {
    assert.equal(routes.routePath(route), path)
    assert.deepEqual(routes.parseRoute(path), route)
  }
  for (const t of Object.keys(routes.TABS)) assert.equal(routes.parseRoute(routes.tabPath(t)).tab, t)
})

test('unknown paths fall back to the overview', () => {
  for (const path of ['/nope', '/history/x', '/history/2026-02-30', '/history/2026-09-01/x', '/accounts/abc/delete', '/accounts/abc/edit/x']) {
    assert.deepEqual(routes.parseRoute(path), { tab: 'overview' })
  }
})
