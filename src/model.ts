// Shape of the JSON file stored in the user's Drive. Bump `version` on breaking changes.

import { parseLiability, type Liability } from './liabilities'
import { emptyHistory, parseHistory, type History } from './history'
import { parseExpense, type Expense } from './expenses'

export const BASE_CURRENCY = 'TWD'

export const CATEGORIES = [
  '現金與外幣活存',
  '國內股票 (台股)',
  '海外股票 (美股)',
  '海外股票 (新股)',
  '基金與退休金',
  '加密貨幣資產',
  '不動產',
  '其他',
]

export const COUNTRIES: Record<string, string> = {
  TW: '台灣',
  SG: '新加坡',
  US: '美國',
  JP: '日本',
  HK: '香港',
  GLOBAL: '全球 / 不限',
}
export const accountLabel = (a: { name: string; country?: string }) => `${a.name} (${a.country || '未設定國家'})`
export const accountIdentity = (a: { name: string; country: string }) => JSON.stringify([a.name.trim().toUpperCase(), a.country.trim().toUpperCase()])

export const countryLabel = (code: string) => COUNTRIES[code] ?? code

export const COMMON_CURRENCIES = ['TWD', 'USD', 'SGD', 'JPY', 'HKD', 'EUR', 'CNY', 'USDT']
const HOME_CURRENCY: Record<string, string> = { TW: 'TWD', SG: 'SGD', US: 'USD', JP: 'JPY', HK: 'HKD' }
export const homeCurrency = (country: string) => HOME_CURRENCY[country] ?? 'USD'

export function defaultCategory(kind: AccountKind, country: string): string {
  if (kind === 'bank') return '現金與外幣活存'
  if (country === 'TW') return '國內股票 (台股)'
  if (country === 'US') return '海外股票 (美股)'
  if (country === 'SG') return '海外股票 (新股)'
  return '其他'
}

// Currencies an account holds cash in, in the order they were added.
export const cashCurrencies = (a: Account) => [...new Set(a.positions.filter((p) => p.type === 'cash').map((p) => p.currency))]

// A bank account only holds currency balances; an investment account holds
// available cash plus holdings (stocks, funds, coins).
export type AccountKind = 'bank' | 'investment'
export const ACCOUNT_KINDS: Record<AccountKind, string> = { bank: '銀行帳戶', investment: '投資帳戶' }

export interface Position {
  id: string
  type: 'cash' | 'holding'
  currency: string
  symbol: string // empty for cash
  quantity: number // the balance for cash
  price: number // always 1 for cash
  name?: string // security name from the quote
  priceManual?: boolean // the user typed the price; automatic updates leave it alone
  priceUpdatedAt?: string
  addedAt?: string // first save that included it; unknown for ones saved before this was kept
}

export interface Account {
  id: string
  name: string
  kind: AccountKind
  country: string
  category: string
  positions: Position[]
}

export interface WealthData {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  updatedAt: string
  // How many TWD one unit of each currency is worth.
  fxRates: Record<string, number>
  // Currencies whose rate the user typed in; automatic updates leave these alone.
  fxManual: string[]
  // When rates were last fetched automatically.
  fxUpdatedAt?: string
  accounts: Account[]
  liabilities?: Liability[]
  expenses?: Expense[]
  // Past edits and daily values; see history.ts.
  history: History
}

export function emptyData(): WealthData {
  return { version: 2, liabilities: [], updatedAt: new Date().toISOString(), fxRates: {}, fxManual: [], accounts: [], history: emptyHistory() }
}

export const newId = () => crypto.randomUUID()

export const positionValue = (p: Position) => p.quantity * p.price

// Returns NaN when the currency has no exchange rate yet.
export function rateOf(data: WealthData, currency: string): number {
  if (currency === BASE_CURRENCY) return 1
  return data.fxRates[currency] ?? NaN
}

export const baseValue = (data: WealthData, p: Position) => positionValue(p) * rateOf(data, p.currency)

export function accountBaseValue(data: WealthData, a: Account): number {
  return a.positions.reduce((sum, p) => sum + (baseValue(data, p) || 0), 0)
}

export function usedCurrencies(data: WealthData): string[] {
  const set = new Set<string>()
  for (const a of data.accounts) for (const p of a.positions) set.add(p.currency)
  for (const d of data.liabilities ?? []) set.add(d.currency)
  for (const c of Object.keys(data.fxRates)) set.add(c)
  set.delete(BASE_CURRENCY)
  return [...set].sort()
}

// Merges automatically fetched rates, keeping the ones the user set by hand.
export function applyFetchedRates(data: WealthData, rates: Record<string, number>, updatedAt: string): WealthData {
  const fxRates = { ...data.fxRates }
  for (const [c, r] of Object.entries(rates)) if (!data.fxManual.includes(c)) fxRates[c] = r
  return { ...data, fxRates, fxUpdatedAt: updatedAt }
}

// Rates are refreshed on open when missing or older than six hours.
export const ratesStale = (data: WealthData) =>
  missingRates(data).some((c) => !data.fxManual.includes(c)) ||
  !data.fxUpdatedAt ||
  Date.now() - Date.parse(data.fxUpdatedAt) > 6 * 3600_000

export const missingRates = (data: WealthData) => usedCurrencies(data).filter((c) => !(data.fxRates[c] > 0))

export interface Slice {
  label: string
  value: number
  share: number
}

// Groups every position's base-currency value by a key, largest first.
export function breakdown(data: WealthData, keyOf: (a: Account, p: Position) => string): { total: number; slices: Slice[] } {
  const sums = new Map<string, number>()
  for (const a of data.accounts) {
    for (const p of a.positions) {
      const v = baseValue(data, p)
      if (!Number.isFinite(v)) continue
      const key = keyOf(a, p) || '未設定'
      sums.set(key, (sums.get(key) ?? 0) + v)
    }
  }
  const total = [...sums.values()].reduce((s, v) => s + v, 0)
  const slices = [...sums]
    .map(([label, value]) => ({ label, value, share: total ? value / total : 0 }))
    .sort((x, y) => y.value - x.value)
  return { total, slices }
}

// The file sits in the user's Drive (or was uploaded) and may have been edited by hand, so check it before use.
// Throws instead of guessing, so a broken file is never silently overwritten.
// Where the data came from, for the error message when it does not parse.
const SOURCES = {
  drive: ['Drive 中的資料檔', '請修正或刪除該檔案後重新登入。'],
  file: ['上傳的資料檔', '請確認選的是 Wealthline 的 JSON 資料檔。'],
  browser: ['此瀏覽器保存的資料', '可以上傳備份的資料檔取代它。'],
} as const

export function parseWealthData(raw: unknown, source: keyof typeof SOURCES = 'drive'): WealthData {
  const fail = (why: string): never => {
    throw new Error(`${SOURCES[source][0]}格式不正確：${why}。${SOURCES[source][1]}`)
  }
  const obj = (typeof raw === 'object' && raw !== null ? raw : fail('不是 JSON 物件')) as Record<string, unknown>
  if (obj.version !== 1 && obj.version !== 2 && obj.version !== 3 && obj.version !== 4 && obj.version !== 5 && obj.version !== 6 && obj.version !== 7 && obj.version !== 8 && obj.version !== 9 && obj.version !== 10) fail(`不支援的版本 ${String(obj.version)}`)
  if (!Array.isArray(obj.accounts)) fail('缺少 accounts 陣列')

  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : fallback)
  const num = (v: unknown, where: string) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fail(`${where}不是數字`)

  const fxRates: Record<string, number> = {}
  if (typeof obj.fxRates === 'object' && obj.fxRates !== null) {
    for (const [c, r] of Object.entries(obj.fxRates)) fxRates[c.toUpperCase()] = num(r, `匯率 ${c} `)
  }

  const accounts = (obj.accounts as unknown[]).map((item, i): Account => {
    const where = `第 ${i + 1} 個帳戶`
    const a = (typeof item === 'object' && item !== null ? item : fail(`${where}不是物件`)) as Record<string, unknown>
    if (!str(a.name)) fail(`${where}缺少名稱`)
    if (!Array.isArray(a.positions)) fail(`${where}缺少 positions 陣列`)
    return {
      id: str(a.id) || newId(),
      name: str(a.name),
      kind: a.kind === 'bank' ? 'bank' : 'investment',
      country: str(a.country).toUpperCase(),
      category: str(a.category, '其他') || '其他',
      positions: (a.positions as unknown[]).map((pi, j): Position => {
        const pw = `${where}（${str(a.name)}）的第 ${j + 1} 筆資料`
        const p = (typeof pi === 'object' && pi !== null ? pi : fail(`${pw}不是物件`)) as Record<string, unknown>
        const type = p.type === 'holding' ? 'holding' : 'cash'
        return {
          id: str(p.id) || newId(),
          type,
          currency: str(p.currency).toUpperCase() || BASE_CURRENCY,
          symbol: str(p.symbol),
          quantity: num(p.quantity, `${pw}的數量`),
          price: type === 'cash' ? 1 : num(p.price, `${pw}的單價`),
          ...(type === 'holding' && {
            name: str(p.name) || undefined,
            priceManual: p.priceManual === true || undefined,
            priceUpdatedAt: str(p.priceUpdatedAt) || undefined,
          }),
          addedAt: str(p.addedAt) || undefined,
        }
      }),
    }
  })

  if (new Set(accounts.map(a => a.id)).size !== accounts.length) fail('帳戶識別碼重複')
  for (const a of accounts) if (new Set(a.positions.map(p => p.id)).size !== a.positions.length) fail('同帳戶持倉識別碼重複')

  if ((obj.version !== 1 || obj.liabilities !== undefined) && !Array.isArray(obj.liabilities)) fail('負債資料必須是陣列')
  const liabilities = obj.liabilities === undefined ? undefined : (obj.liabilities as unknown[]).map((d) => {
    try { return parseLiability(d) } catch (e) { return fail(e instanceof Error ? e.message : '負債格式不正確') }
  })
  if (liabilities && new Set(liabilities.map((d) => d.id)).size !== liabilities.length) fail('負債識別碼重複')
  const fxManual = Array.isArray(obj.fxManual) ? obj.fxManual.filter((c): c is string => typeof c === 'string') : []
  if ((obj.version === 10 || obj.expenses !== undefined) && !Array.isArray(obj.expenses)) fail('消費明細必須是陣列')
  const expenses = obj.expenses === undefined ? undefined : (obj.expenses as unknown[]).map(e => {
    try { return parseExpense(e) } catch(e) {return fail(e instanceof Error ? e.message : '消費明細無效')}
  })
  if(expenses && new Set(expenses.map(e=>e.id)).size !== expenses.length) fail('消費識別碼重複')
  return {
    version: expenses !== undefined ? 10 : obj.version as WealthData['version'],
    updatedAt: str(obj.updatedAt) || new Date().toISOString(),
    fxRates,
    fxManual,
    fxUpdatedAt: str(obj.fxUpdatedAt) || undefined,
    accounts,
    liabilities,
    ...(expenses !== undefined && {expenses}),
    history: parseHistory(obj.history, fail),
  }
}
