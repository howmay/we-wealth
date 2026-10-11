import type { WealthData, Position } from './model'
import type { Snapshot } from './history'
import { localDate } from './history'
import { fetchHistory, fxSymbol, type PriceHistory } from './priceHistory'
import { fetchHistoricalFx, historicalFxError, isCryptoCurrency, USD_TWD_HISTORY } from './historicalFx'
import { candidates } from './quotes'
import { isSupportedCurrency } from './currencies'

// One absolute end-of-day quantity for an account/instrument/currency group.
// No lot allocations, trades, or changes to current positions are inferred.
export interface HistoricalInstrument {
  accountId: string; account: string; category: string; country: string
  type: Position['type']; symbol: string; currency: string
}
// Yahoo market quotes. Legacy manual fields remain readable but are never used
// as valuation fallback or exposed as editable prices.
export interface HistoricalFxLeg {source:'Yahoo';symbol:string;currency:string;date:string;value:number}
export interface HistoricalQuote { source: 'Yahoo' | 'manual' | 'derived'; symbol: string; date: string; value: number; legs?: [HistoricalFxLeg,HistoricalFxLeg] }
export interface QuantityEntry extends HistoricalInstrument {
  quantityAsOf?: string // query-only basis date for split conversion
  quantity: number | null // null: unknown, not zero
  price?: HistoricalQuote
  fx?: HistoricalQuote
  error?: string
}
export interface CompleteInventory {
  accounts: {id:string;name:string}[]
  source: {kind: 'current' | 'day'; date:string}
}
// Supplements are scoped to this date. Raw entries retain their historical event semantics.
export interface DayCompletion extends CompleteInventory { entries: QuantityEntry[] }
export interface QuantityDay { completion?: DayCompletion; inventory?: CompleteInventory; date: string; updatedAt: string; entries: QuantityEntry[]; sparse?: true; periodDerived?: boolean; quantityEvidence?: 'complete' | 'incomplete' | 'explicit-unknown' }
export type HistoricalPoint = Omit<Snapshot, 'total' | 'accounts' | 'categories'> & {
  total: number | null
  accounts: { id: string; name: string; value: number | null }[]
  categories: Record<string, number | null>
  liabilityAssumed?: boolean
  periodDerived?: boolean
  manual?: boolean
}
export const instrumentKey = <T extends Pick<HistoricalInstrument,'accountId'|'type'|'symbol'|'currency'>>(p: T) => JSON.stringify([p.accountId, p.type, p.type === 'cash' ? '' : p.symbol.toUpperCase(), p.currency])
export function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '0001-01-01' && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}
export function validatePastDate(date: string, now = new Date().toISOString()) {
  if (!validDate(date)) throw new Error('請選擇有效日期')
  if (date > localDate(now)) throw new Error('不可補登未來日期')
}
export function historyCatalog(data: WealthData): HistoricalInstrument[] {
  const all = new Map<string, HistoricalInstrument>()
  const add = (p: HistoricalInstrument) => {
    const { accountId, account, category, country, type, symbol, currency } = p
    all.set(instrumentKey(p), { accountId, account, category, country, type, symbol, currency })
  }
  for (const period of data.history.holdingPeriods ?? []) add(period)
  for (const day of data.history.quantityDays ?? []) for (const e of [...day.entries,...(day.completion?.entries ?? [])]) add(e)
  for (const c of data.history.changes) {
    const account = data.accounts.find(a => a.id === c.accountId)
    add({ accountId: c.accountId, account: account?.name ?? c.account, category: account?.category ?? '未分類', country: account?.country ?? 'GLOBAL', type: c.type, symbol: c.type === 'cash' ? '' : c.symbol.toUpperCase(), currency: c.currency })
  }
  for (const a of data.accounts) for (const p of a.positions) add({ accountId: a.id, account: a.name, category: a.category, country: a.country, type: p.type, symbol: p.type === 'cash' ? '' : p.symbol.toUpperCase(), currency: p.currency })
  return [...all.values()].sort((a, b) => a.account.localeCompare(b.account) || a.symbol.localeCompare(b.symbol) || a.currency.localeCompare(b.currency))
}
export function entriesForDate(data: WealthData, date: string): QuantityEntry[] {
  const existing = data.history.quantityDays?.find(d => d.date === date)
  if (existing) return existing.entries
  // Legacy logs aggregate lots and do not record the calendar date's timezone.
  // Only a log on the selected local date supplies a known quantity; never extend it
  // backwards or across dates/corporate actions. A snapshot has no quantities.
  const catalog = historyCatalog(data)
  return catalog.map(p => {
    const ambiguous = catalog.some(other => other.accountId === p.accountId && other.type === p.type && other.symbol === p.symbol && other.currency !== p.currency)
    const changes = ambiguous ? [] : data.history.changes.filter(c => c.accountId === p.accountId && c.type === p.type && (p.type === 'cash' ? c.currency === p.currency : c.symbol.toUpperCase() === p.symbol) && c.currency === p.currency && localDate(c.at) === date).sort((a,b) => a.at.localeCompare(b.at))
    return { ...p, quantity: changes.length ? changes.at(-1)!.after?.quantity ?? 0 : null }
  })
}
const age = (a: string, b: string) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000
export function quoteOn(history: PriceHistory | null, date: string): HistoricalQuote | undefined {
  if (!history?.asTraded) return undefined
  if(history.conversion) {
    const {currency,asset,usd}=history.conversion
    if(asset?.currency!=='USD' || usd?.currency!=='TWD' || asset.symbol!==`${currency}-USD` || usd.symbol!==USD_TWD_HISTORY) return undefined
    const first=quoteOn(asset,date),second=quoteOn(usd,date)
    if(!first || !second || first.source!=='Yahoo' || second.source!=='Yahoo') return undefined
    const value=first.value*second.value
    if(!Number.isFinite(value)||value<=0) return undefined
    return {source:'derived',symbol:fxSymbol(currency),date,value,legs:[{...first,source:'Yahoo',currency:'USD'},{...second,source:'Yahoo',currency:'TWD'}]}
  }
  const pt = history.points.filter(p => validDate(p.date) && p.date <= date && Number.isFinite(p.close) && p.close > 0).sort((a,b) => a.date.localeCompare(b.date)).at(-1)
  // A seven-calendar-day limit covers normal weekends/holidays; long suspensions
  // and absent prehistory remain unavailable. Never borrow a future close.
  if (!pt || age(date, pt.date) > 7 || history.splits?.some(s => s.date > pt.date && s.date <= date)) return undefined
  return { source: 'Yahoo', symbol: history.symbol, date: pt.date, value: pt.close }
}
export function entryValue(entry: QuantityEntry): number | null {
  if (entry.quantity === null) return null
  if (entry.quantity === 0) return 0
  const price = entry.type === 'cash' ? 1 : entry.price?.source === 'Yahoo' ? entry.price.value : undefined
  const fx = entry.currency === 'TWD' ? 1 : entry.fx?.value
  const value = price === undefined || fx === undefined ? NaN : entry.quantity * price * fx
  return Number.isFinite(value) ? value : null
}
// Preserve legacy manual fields on read, but only market quotes can value history.
const TICKER = /^[A-Z0-9.\-=^]{1,24}$/
export function splitQuantity(entry: QuantityEntry, date: string, prices: PriceHistory | null): number | null {
  if (!entry.quantityAsOf || entry.quantityAsOf === date || entry.type === 'cash' || entry.quantity === 0 || entry.quantity === null) return entry.quantity
  if (!prices?.asTraded || prices.currency !== entry.currency) return null
  const factor = (d: string) => (prices.splits ?? []).filter(s => s.date > d).reduce((n,s) => n*s.ratio,1)
  const value = entry.quantity * factor(entry.quantityAsOf) / factor(date)
  return Number.isFinite(value) ? value : null
}
export function repriceEntry(e: QuantityEntry, date: string, prices: PriceHistory | null, rates: PriceHistory | null): QuantityEntry {
  const { price: _price, fx: _fx, error: _error, ...entry } = e
  if (e.quantity === null || e.quantity === 0) return entry
  const price = e.type !== 'cash' && prices?.currency === e.currency ? quoteOn(prices, date) : undefined
  const fx = e.currency !== 'TWD' && rates?.currency === 'TWD' ? quoteOn(rates, date) : undefined
  const error = [e.type !== 'cash' && !price && '缺少相符幣別的歷史收盤價', e.currency !== 'TWD' && !fx && historicalFxError(e.currency,date,rates)].filter(Boolean).join('；')
  return { ...entry, quantity:splitQuantity(entry,date,prices), ...(price && {price}), ...(fx && {fx}), ...(error && {error}) }
}
export async function valueEntries(
  entries: QuantityEntry[],
  date: string,
  fetcher = fetchHistory,
): Promise<QuantityEntry[]> {
  validatePastDate(date)
  const cache = new Map<string, Promise<PriceHistory | null>>()
  // Period evidence may precede the destination; fetch its split history while
  // still selecting prices and FX strictly on the destination date.
  const from=entries.reduce((first,e)=>e.quantityAsOf && e.quantityAsOf<first ? e.quantityAsOf : first,date)
  const get = (symbol: string) => {
    if (!cache.has(symbol)) cache.set(symbol, fetcher(symbol, from).catch(() => null))
    return cache.get(symbol)!
  }
  // Only symbol/date leave the client. Names, account IDs and quantities do not.
  return Promise.all(entries.map(async e => {
    const { price: _price, fx: _fx, error: _error, ...entry } = e
    if (entry.quantity === null || entry.quantity === 0) return entry
    let priceHistory: PriceHistory | null = null
    let price: HistoricalQuote | undefined
    let fx: HistoricalQuote | undefined
    let rates:PriceHistory|null=null
    if (entry.type !== 'cash' && !price && TICKER.test(entry.symbol)) for (const symbol of candidates(entry.symbol, entry.country, entry.category.includes('加密'))) {
      const history = await get(symbol)
      if (history?.currency === entry.currency) { priceHistory = history; price = quoteOn(history, date) }
      if (price) break
    }
    if (entry.currency !== 'TWD') {
      rates = await fetchHistoricalFx(entry.currency,date,symbol=>get(symbol))
      if (rates?.currency === 'TWD') fx = quoteOn(rates, date)
    }
    const error = [entry.type !== 'cash' && !price && '缺少相符幣別的歷史收盤價', entry.currency !== 'TWD' && !fx && historicalFxError(entry.currency,date,rates)].filter(Boolean).join('；')
    const result = { ...entry, quantity:splitQuantity(entry,date,priceHistory), ...(price && { price }), ...(fx && { fx }), ...(error && { error }) }
    return !error && entryValue(result) === null ? { ...result, error: '估值超出有效數值範圍' } : result
  }))
}
// Values every entered day with one query per symbol, from the earliest day, shared by
// all days; per-day queries would multiply requests by the number of days.
export async function valueDays(days: QuantityDay[], fetcher = fetchHistory): Promise<QuantityDay[]> {
  const from = days.map((d) => d.date).sort()[0]
  const cache = new Map<string, Promise<PriceHistory | null>>()
  const shared = (symbol: string) => {
    if (!cache.has(symbol)) cache.set(symbol, fetcher(symbol, from).catch(() => null))
    return cache.get(symbol)!
  }
  return Promise.all(days.map(async (day) => ({
    ...day,
    entries: await valueEntries(day.entries, day.date, shared).catch(() => day.entries.map((e) => repriceEntry(e, day.date, null, null))),
  })))
}
// Projection-only coverage, recorded before market lookup. An incomplete day has no
// total whatever the quotes say, so loading or failed quotes must not bring it back.
// Explicit unknowns and complete days with price gaps keep their own evidence class.
export function isUnrecordedPartialDay(day: QuantityDay) {
  return day.periodDerived === true && day.quantityEvidence === 'incomplete'
}
export function quantityPoint(day: QuantityDay, original?: Snapshot): HistoricalPoint {
  const accounts = new Map<string, { id: string; name: string; value: number | null }>((day.inventory?.accounts ?? day.completion?.accounts ?? []).map(a=>[a.id,{...a,value:0}]))
  const categories: Record<string, number | null> = Object.create(null)
  let total: number | null = 0
  for (const entry of day.entries) {
    const v = entryValue(entry)
    const a = accounts.get(entry.accountId) ?? { id: entry.accountId, name: entry.account, value: 0 }
    a.value = a.value === null || v === null ? null : a.value + v
    accounts.set(a.id, a)
    const c = Object.hasOwn(categories, entry.category) ? categories[entry.category] : 0
    categories[entry.category] = c === null || v === null ? null : c + v
    total = total === null || v === null ? null : total + v
  }
  // Unknown legacy inventory in an original snapshot must not disappear; an account
  // that was empty that day has nothing to add.
  if ((!day.inventory && (original?.accounts.some(a => !accounts.has(a.id) && a.value !== 0) || !day.entries.length)) || !Number.isFinite(total)) total = null
  const liabilityAssumed = original?.liabilityTotal === undefined
  const debt = liabilityAssumed ? 0 : original?.liabilityTotal
  return { date: day.date, at: day.updatedAt, total, accounts: [...accounts.values()], categories, manual: !day.periodDerived, ...(day.periodDerived && {periodDerived:true}),
    liabilityAssumed, liabilityTotal: debt,
    ...(original?.liabilityEstimated !== undefined && { liabilityEstimated: original.liabilityEstimated }),
    ...(debt !== undefined && { netWorth: total === null || debt === null ? null : total - debt }) }
}
export function applyQuantityDay(data: WealthData, day: QuantityDay, expected?: QuantityDay): WealthData {
  validatePastDate(day.date)
  const existing = data.history.quantityDays?.find(d => d.date === day.date)
  if (existing !== expected) throw new Error('這一天已新增或變更，請取消並重新開啟，避免覆蓋其他修改')
  const parsed = parseQuantityDays([day])[0]
  return { ...data, version: data.version === 10 || data.expenses !== undefined ? 10 : data.version === 9 || parsed.completion ? 9 : data.version === 8 || parsed.inventory ? 8 : data.version === 7 || parsed.entries.some(e=>e.fx?.source==='derived') ? 7 : data.version === 6 || day.sparse ? 6 : data.version === 5 || data.history.holdingPeriods !== undefined ? 5 : data.version === 4 || data.liabilities?.some(d => d.schedule || d.basisHistory) ? 4 : 3, history: { ...data.history, quantityDays: [...(data.history.quantityDays ?? []).filter(d => d.date !== day.date), parsed].sort((a,b) => a.date.localeCompare(b.date)) } }
}
export function parseQuantityDays(raw: unknown): QuantityDay[] {
  if (!Array.isArray(raw)) throw new Error('歷史數量必須是陣列')
  const days = raw.map((value): QuantityDay => {
    const d = value as QuantityDay
    if (!d || !validDate(d.date) || !Number.isFinite(Date.parse(d.updatedAt)) || !Array.isArray(d.entries)) throw new Error('歷史數量日期或資料格式不正確')
    if (d.sparse !== undefined && d.sparse !== true) throw new Error('單日紀錄範圍不正確')
    const entries = d.entries.map((e): QuantityEntry => {
      const named = [e?.accountId, e?.account, e?.category, e?.country, e?.currency].every((x) => typeof x === 'string' && x.trim())
      // A holding's symbol is whatever the account uses for it, ticker or not.
      const symbolOk = typeof e?.symbol === 'string' && (e.type === 'cash' ? e.symbol === '' : !!e.symbol.trim() && e.symbol.length <= 64)
      if (!e || !named || !['cash', 'holding'].includes(e.type) || !symbolOk || !isSupportedCurrency(e.currency)) throw new Error('歷史持倉識別資料不正確')
      if (e.quantity !== null && (typeof e.quantity !== 'number' || !Number.isFinite(e.quantity) || e.quantity < 0)) throw new Error('歷史數量須為非負有限數字，空白表示未知')
      const quote = (q: HistoricalQuote | undefined, isFx: boolean) => {
        if (q === undefined) return undefined
        if(q?.source==='derived') {
          if(!isFx || !isCryptoCurrency(e.currency) || q.symbol!==fxSymbol(e.currency) || q.date!==d.date || !Array.isArray(q.legs) || q.legs.length!==2) throw new Error('歷史換算鏈格式不正確')
          const legs=q.legs.map((leg,i)=>{
            if(leg?.source!=='Yahoo' || leg.symbol!==(i===0?`${e.currency}-USD`:USD_TWD_HISTORY) || leg.currency!==(i===0?'USD':'TWD') || !validDate(leg.date) || leg.date>d.date || age(d.date,leg.date)>7 || !Number.isFinite(leg.value) || leg.value<=0) throw new Error('歷史換算鏈來源或日期不正確')
            return {source:'Yahoo' as const,symbol:leg.symbol,currency:leg.currency,date:leg.date,value:leg.value}
          }) as [HistoricalFxLeg,HistoricalFxLeg]
          const value=legs[0].value*legs[1].value
          if(!Number.isFinite(value)||value<=0||!Number.isFinite(q.value)||Math.abs(value-q.value)>Math.abs(value)*1e-12) throw new Error('歷史換算鏈數值不正確')
          return {source:'derived' as const,symbol:q.symbol,date:q.date,value,legs}
        }
        const manual = q?.source === 'manual'
        const sourceOk = manual ? !isFx && q.symbol === e.symbol && q.date === d.date : q?.source === 'Yahoo' && typeof q.symbol === 'string' && !!q.symbol
        if (!q || !sourceOk || !validDate(q.date) || q.date > d.date || age(d.date, q.date) > 7 || !Number.isFinite(q.value) || q.value <= 0 || (isFx && q.symbol !== fxSymbol(e.currency))) throw new Error('歷史行情來源或日期不正確')
        return { source: q.source, symbol: q.symbol, date: q.date, value: q.value }
      }
      const price = quote(e.price, false), fx = quote(e.fx, true)
      return { accountId:e.accountId, account:e.account, category:e.category, country:e.country, type:e.type, symbol:e.symbol, currency:e.currency, quantity:e.quantity, ...(price && {price}), ...(fx && {fx}), ...(typeof e.error === 'string' && {error:e.error}) }
    })
    if (new Set(entries.map(instrumentKey)).size !== entries.length) throw new Error('同日同帳戶同持倉幣別不可重複')
    let inventory:CompleteInventory|undefined
    if(d.inventory!==undefined) {
      const x=d.inventory
      if(!x || d.sparse || !Array.isArray(x.accounts) || !x.source || !['current','day'].includes(x.source.kind) || !validDate(x.source.date)) throw new Error('完整持倉基底格式不正確')
      if(x.accounts.some(a=>!a || typeof a.id!=='string' || !a.id.trim() || typeof a.name!=='string' || !a.name.trim()) || new Set(x.accounts.map(a=>a.id)).size!==x.accounts.length) throw new Error('完整持倉帳戶範圍不正確')
      if(entries.some(e=>e.quantity===null)) throw new Error('完整回補清單的數量不可留空；當時未持有請填 0。')
      if(entries.some(e=>!x.accounts.some(a=>a.id===e.accountId))) throw new Error('此帳戶不在這天的完整回補範圍。請取消編輯，使用「沿用持倉回補差異」重新回補此日期以擴大範圍；不必刪除原紀錄。')
      inventory={accounts:x.accounts.map(a=>({id:a.id,name:a.name})),source:{kind:x.source.kind,date:x.source.date}}
    }
    let completion:DayCompletion|undefined
    if(d.completion!==undefined) {
      const x=d.completion
      if(d.inventory || !x || !Array.isArray(x.entries) || !Array.isArray(x.accounts) || !x.source || !['current','day'].includes(x.source.kind) || !validDate(x.source.date)) throw new Error('當日補齊資料格式不正確')
      if(x.accounts.some(a=>!a || typeof a.id!=='string' || !a.id.trim() || typeof a.name!=='string' || !a.name.trim()) || new Set(x.accounts.map(a=>a.id)).size!==x.accounts.length) throw new Error('當日補齊帳戶範圍不正確')
      const supplements=parseQuantityDays([{date:d.date,updatedAt:d.updatedAt,entries:x.entries}])[0].entries.map(e=>{
        const {price:_price,fx:_fx,error:_error,...identity}=e
        return identity
      })
      if(supplements.some(e=>entries.some(raw=>instrumentKey(raw)===instrumentKey(e))) || [...entries,...supplements].some(e=>!x.accounts.some(a=>a.id===e.accountId))) throw new Error('當日補齊範圍重複或缺少帳戶')
      completion={source:{kind:x.source.kind,date:x.source.date},accounts:x.accounts.map(a=>({id:a.id,name:a.name})),entries:supplements}
    }
    return { date: d.date, updatedAt:d.updatedAt, entries, ...(completion && {completion}), ...(d.sparse && {sparse:true as const}), ...(inventory && {inventory}) }
  })
  if (new Set(days.map(d=>d.date)).size !== days.length) throw new Error('歷史數量日期不可重複')
  return days.sort((a,b)=>a.date.localeCompare(b.date))
}
