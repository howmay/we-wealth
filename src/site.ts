// Site-wide links and a tiny path router for the public notice pages.

import { useSyncExternalStore } from 'react'

export const SITE_HOST = 'wealthline.haomeh.com'
export const SITE_URL = `https://${SITE_HOST}`
export const SUPPORT_URL = 'https://ko-fi.com/haomeh'
export const REPO_URL = 'https://github.com/howmay/Wealthline'
export const ISSUES_URL = `${REPO_URL}/issues`
export const SECURITY_URL = `${REPO_URL}/security/advisories/new`
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`
export const LICENSE_ZH_URL = `${REPO_URL}/blob/main/LICENSE.zh-TW.md`
// The organization that operates the app; the copyright holder in LICENSE is AUTHOR.
export const OPERATOR = 'howmay'
export const OPERATOR_URL = 'https://github.com/howmay'
export const AUTHOR = 'Harvey Chen'
export const AUTHOR_URL = 'https://github.com/zhChenOuO'

// Bump when the privacy policy changes in a way that affects Google user data;
// signed-in users then see a notice in the app (PrivacyNotice in views/Site.tsx).
export const PRIVACY_UPDATED = '2026-10-11'

export const PAGES = {
  privacy: {
    path: '/privacy', title: '隱私權政策', en: 'Privacy Policy',
    description: 'Wealthline 如何使用你的 Google 帳號資料：只要求 drive.file 權限，資料只存在你自己的 Google Drive，沒有後端資料庫。How Wealthline handles your Google user data.',
  },
  terms: {
    path: '/terms', title: '使用條款', en: 'Terms of Service',
    description: 'Wealthline 個人資產統計工具的使用條款。Terms of Service for Wealthline, the open-source personal asset tracker.',
  },
  disclaimer: {
    path: '/disclaimer', title: '免責聲明', en: 'Disclaimer',
    description: 'Wealthline 的報價、匯率與統計僅供參考，不構成投資建議。Quotes, exchange rates and totals in Wealthline are for reference only, not investment advice.',
  },
} as const
export type PageKey = keyof typeof PAGES

// Cloudflare serves index.html for unknown paths (wrangler.jsonc), so these routes work on reload too.
const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb)
  return () => window.removeEventListener('popstate', cb)
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname.replace(/\/+$/, '') || '/')
}

export function usePage(): PageKey | null {
  const path = usePath()
  return (Object.keys(PAGES) as PageKey[]).find((k) => PAGES[k].path === path) ?? null
}

// Each entry this app pushes counts how deep it is, so `goBack` knows whether the previous
// entry is one of ours or a page from before the app was opened.
const depth = (): number => (window.history.state as { depth?: number } | null)?.depth ?? 0

export function navigate(to: string, { replace = false } = {}) {
  if (to === window.location.pathname) return
  if (replace) window.history.replaceState({ depth: depth() }, '', to)
  else window.history.pushState({ depth: depth() + 1 }, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo({ top: 0 })
}

// Whether the previous history entry is a page of this app.
export const hasPrevious = () => depth() > 0

// Returns to the page the user came from, like the browser's back button; when they arrived
// here directly (a reload or a shared link), replaces this page with `fallback` instead.

export function goBack(fallback: string) {
  if (hasPrevious()) window.history.back()
  else navigate(fallback, { replace: true })
}
