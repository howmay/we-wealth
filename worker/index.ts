// Cloudflare Worker entry: answers /api/quote and /api/history, and leaves everything else to the static
// assets in dist/ (configured in wrangler.jsonc), applying security headers to both.
import { cachedApiResponse, type EdgeCache } from '../server/edgeCache.ts'
import { isApiPath } from '../server/yahoo.ts'

// The public pages listed in dist/sitemap.xml (written by scripts/prerender.mjs from src/site.ts).
// Every other HTML response is the signed-in app's fallback page, which search engines should skip.
export const INDEXABLE_PATHS = ['/', '/privacy', '/terms', '/disclaimer']

function isIndexable(pathname: string): boolean {
  const path = pathname.replace(/\.html$/, '').replace(/\/index$/, '/').replace(/(.)\/+$/, '$1')
  return INDEXABLE_PATHS.includes(path)
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url)
    // The Cache API exists only on Workers (not in the Node tests or the Vite dev server).
    const edge = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default
    const result = request.method === 'GET' && isApiPath(url.pathname)
      ? await cachedApiResponse(url, edge, { waitUntil: (p) => ctx?.waitUntil(p), headers: request.headers })
      : await env.ASSETS.fetch(request)
    const response = new Response(result.body, result)
    // run_worker_first bypasses public/_headers, so keep HTML revalidated here (see that file).
    if (response.headers.get('Content-Type')?.includes('text/html')) {
      response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate')
      response.headers.set('Cloudflare-CDN-Cache-Control', 'no-store')
      if (!isIndexable(url.pathname)) response.headers.set('X-Robots-Tag', 'noindex')
    }
    if (isApiPath(url.pathname)) response.headers.set('X-Robots-Tag', 'noindex')
    const ocrScript = url.pathname.startsWith('/ocr/') && /(?:application|text)\/(?:javascript|ecmascript)/.test(response.headers.get('Content-Type') ?? '')
    response.headers.set('Content-Security-Policy', [
      "default-src 'self'",
      // The hash is index.html's inline restore script (tests/security.test.mjs keeps them in sync).
      `script-src 'self' 'sha256-y9ZP2XkknaC8PB9I+/GCdUGofPK4Iz8oAARSz8989ek=' https://accounts.google.com/gsi/client${ocrScript ? " 'wasm-unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      "connect-src 'self' https://accounts.google.com/gsi/ https://www.googleapis.com https://oauth2.googleapis.com https://open.er-api.com https://api.coingecko.com",
      "frame-src https://accounts.google.com/gsi/",
      "img-src 'self' data: https://*.googleusercontent.com",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ].join('; '))
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
    response.headers.set('Strict-Transport-Security', 'max-age=31536000')
    return response
  },
}
