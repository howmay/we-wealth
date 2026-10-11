import { validDate } from './quantityHistory'

// The signed-in app's pages and their URLs, so browser back/forward and the mobile back swipe
// move between them. Cloudflare serves index.html for these paths (wrangler.jsonc).

export const TABS = { overview: '總覽', accounts: '帳戶', liabilities: '負債', expenses: '消費明細', history: '歷史明細', rates: '匯率' }
export type Tab = keyof typeof TABS

export type Route =
  | { tab: 'overview' }
  | { tab: 'accounts'; page: 'list'; importing?: boolean }
  | { tab: 'accounts'; page: 'new' }
  | { tab: 'accounts'; page: 'edit'; id: string }
  | { tab: 'accounts'; page: 'detail'; id: string }
  | { tab: 'liabilities' }
  | { tab: 'expenses' }
  | { tab: 'history'; date?: string }
  | { tab: 'rates' }

export const tabPath = (t: Tab) => (t === 'overview' ? '/app' : `/${t}`)

export function parseRoute(path: string): Route {
  const [first, second, third, ...rest] = path.split('/').filter(Boolean).map(decodeURIComponent)
  if (first === 'liabilities' && !second) return { tab: 'liabilities' }
  if (first === 'expenses' && !second) return { tab: 'expenses' }
  if (first === 'history' && !third && !rest.length) {
    if (!second) return { tab: 'history' }
    if (validDate(second)) return { tab: 'history', date: second }
  }
  if (first === 'rates' && !second) return { tab: 'rates' }
  if (first === 'accounts' && !rest.length) {
    if (!second) return { tab: 'accounts', page: 'list' }
    if (second === 'import' && !third) return { tab: 'accounts', page: 'list', importing: true }
    if (second === 'new' && !third) return { tab: 'accounts', page: 'new' }
    if (!third) return { tab: 'accounts', page: 'detail', id: second }
    if (third === 'edit') return { tab: 'accounts', page: 'edit', id: second }
  }
  return { tab: 'overview' }
}

export function routePath(r: Route): string {
  switch (r.tab) {
    case 'overview':
      return '/app'
    case 'history':
      return r.date ? `/history/${r.date}` : '/history'
    case 'liabilities':
    case 'expenses':
    case 'rates':
      return `/${r.tab}`
    case 'accounts':
      if (r.page === 'list') return r.importing ? '/accounts/import' : '/accounts'
      if (r.page === 'new') return '/accounts/new'
      return `/accounts/${encodeURIComponent(r.id)}${r.page === 'edit' ? '/edit' : ''}`
  }
}
