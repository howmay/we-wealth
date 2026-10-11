// History kept inside the data file: every edit to a balance or holding, and one
// value snapshot per day, so the user can see how their assets change over time.

import { expandPeriodDays, parseHoldingPeriods, type HoldingPeriod } from './holdingPeriods'
import { isUnrecordedPartialDay, parseQuantityDays, quantityPoint, validDate, type QuantityDay, type HistoricalPoint } from './quantityHistory'
import { balanceSheet, parseLiability, type Liability } from './liabilities'
import { accountBaseValue, baseValue, type Account, type Position, type WealthData } from './model'

export interface PositionState {
  quantity: number
  price: number
}

// One balance or holding as it was before and after a save.
export interface Change {
  at: string
  accountId: string
  account: string // the account's name at the time
  type: 'cash' | 'holding'
  symbol: string // ticker, or the currency code for a balance
  currency: string
  before: PositionState | null // null when it was added
  after: PositionState | null // null when it was removed
}

// Base-currency values on one day; a later save that day replaces it.
export interface Snapshot {
  date: string // local YYYY-MM-DD
  at: string
  total: number
  accounts: { id: string; name: string; value: number }[]
  categories: Record<string, number>
  liabilityEstimated?: boolean
  liabilityTotal?: number | null // absent: not recorded by older clients; null: cannot convert
  netWorth?: number | null
}

export interface LiabilityChange {
  at: string
  liabilityId: string
  before: Liability | null
  after: Liability | null
}

export function diffLiabilities(prev: WealthData | null, next: WealthData, at: string): LiabilityChange[] {
  const before = new Map((prev?.liabilities ?? []).map((d) => [d.id, d]))
  const after = new Map((next.liabilities ?? []).map((d) => [d.id, d]))
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((id) => {
    const b = before.get(id) ?? null, a = after.get(id) ?? null
    return JSON.stringify(b && parseLiability(b)) === JSON.stringify(a && parseLiability(a)) ? [] : [{ at, liabilityId: id, before: b, after: a }]
  })
}

export const pendingLiabilityChanges = (saved: WealthData | null, data: WealthData) => diffLiabilities(saved, data, new Date().toISOString())
export function revertLiabilityChange(saved: WealthData | null, data: WealthData, id: string): WealthData {
  const original = saved?.liabilities?.find((d) => d.id === id)
  const others = (data.liabilities ?? []).filter((d) => d.id !== id)
  return { ...data, liabilities: original ? [...others, original] : others }
}

export interface History {
  changes: Change[]
  quantityDays?: QuantityDay[]
  holdingPeriods?: HoldingPeriod[]
  valuedQuantityDays?: QuantityDay[] // query-only; never persisted
  liabilityChanges?: LiabilityChange[]
  snapshots: Snapshot[]
}

export const emptyHistory = (): History => ({ changes: [], snapshots: [] })

export function localDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Positions are matched by what they are (a currency balance or a ticker), not by id,
// so re-importing a spreadsheet does not read as removing and re-adding everything.
export const keyOf = (p: Position) => `${p.type}:${p.type === 'cash' ? p.currency : p.symbol.toUpperCase()}`
// The same key for a change log entry, whose symbol is the currency for a balance.
export const changeKey = (c: { type: string; symbol: string }) => `${c.type}:${c.symbol.toUpperCase()}`

function states(a: Account | undefined): Map<string, { p: Position; s: PositionState }> {
  const m = new Map<string, { p: Position; s: PositionState }>()
  for (const p of a?.positions ?? []) {
    const k = keyOf(p)
    const prev = m.get(k)
    m.set(k, { p, s: { quantity: (prev?.s.quantity ?? 0) + p.quantity, price: p.price } })
  }
  return m
}

// What the user changed between two saved versions. Prices that moved with the market
// are not edits (the daily snapshot captures them); a price typed by hand is.
export function diffPositions(prev: WealthData, next: WealthData, at: string): Change[] {
  const changes: Change[] = []
  const ids = new Set([...prev.accounts.map((a) => a.id), ...next.accounts.map((a) => a.id)])
  for (const id of ids) {
    const pa = prev.accounts.find((a) => a.id === id)
    const na = next.accounts.find((a) => a.id === id)
    const before = states(pa)
    const after = states(na)
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(k)
      const n = after.get(k)
      const p = (n ?? b)!.p
      const edited =
        !b || !n || b.s.quantity !== n.s.quantity || (p.type === 'holding' && n.p.priceManual && b.s.price !== n.s.price)
      if (!edited) continue
      changes.push({
        at,
        accountId: id,
        account: (na ?? pa)!.name,
        type: p.type,
        symbol: p.type === 'cash' ? p.currency : p.symbol,
        currency: p.currency,
        before: b?.s ?? null,
        after: n?.s ?? null,
      })
    }
  }
  return changes
}

export function snapshotOf(data: WealthData, at: string): Snapshot {
  const categories: Record<string, number> = {}
  for (const a of data.accounts) {
    for (const p of a.positions) {
      const v = baseValue(data, p)
      if (Number.isFinite(v)) categories[a.category] = (categories[a.category] ?? 0) + v
    }
  }
  const accounts = data.accounts.map((a) => ({ id: a.id, name: a.name, value: accountBaseValue(data, a) }))
  const totals = balanceSheet(data, at)
  return {
    date: localDate(at), at, total: accounts.reduce((s, a) => s + a.value, 0), accounts, categories,
    ...(data.liabilities !== undefined && { liabilityTotal: totals.liabilities, netWorth: totals.net, ...(data.liabilities?.some(d => d.schedule) && { liabilityEstimated: true }) }),
  }
}

// When each balance or holding first appeared: new ones get this save's time; ones saved
// earlier get the time the change log last recorded them being added, if it did.
function stampAdded(saved: WealthData | null, next: WealthData, changes: Change[], at: string): WealthData['accounts'] {
  return next.accounts.map((a) => {
    if (a.positions.every((p) => p.addedAt)) return a
    const before = new Set(saved?.accounts.find((x) => x.id === a.id)?.positions.map(keyOf) ?? [])
    const positions = a.positions.map((p) => {
      if (p.addedAt) return p
      const key = keyOf(p)
      if (!before.has(key)) return { ...p, addedAt: at }
      const added = changes
        .filter((c) => c.accountId === a.id && !c.before && c.after && changeKey(c) === key)
        .reduce<string | undefined>((latest, c) => (!latest || c.at > latest ? c.at : latest), undefined)
      return added ? { ...p, addedAt: added } : p
    })
    return { ...a, positions }
  })
}

function upsert(snapshots: Snapshot[], s: Snapshot): Snapshot[] {
  return [...snapshots.filter((x) => x.date !== s.date), s].sort((x, y) => x.date.localeCompare(y.date))
}

// Shared history source: original snapshots plus current today, with explicit
// quantity days taking precedence. Unknown totals remain gaps, not zeros.
export function totalPoints(data: WealthData, now: string): HistoricalPoint[] {
  const today = snapshotOf(data, now)
  const byDate = new Map<string, HistoricalPoint>(data.history.snapshots.map(s => [s.date, s]))
  byDate.set(today.date, today)
  for (const day of data.history.valuedQuantityDays ?? expandPeriodDays(data,now)) {
    const original = data.history.snapshots.find(s => s.date === day.date)
    if (day.periodDerived && original || isUnrecordedPartialDay(day)) continue
    // Today's manual asset quantities must still use today's live debt estimate.
    // Past days retain the recorded debt (including unknown), never backfill it.
    const basis = day.date === today.date ? { ...(original ?? today), liabilityTotal: today.liabilityTotal, netWorth: today.netWorth, liabilityEstimated: today.liabilityEstimated } : original
    byDate.set(day.date, quantityPoint(day, basis))
  }
  return [...byDate.values()].map(point => {
    const liabilityTotal = point.liabilityTotal === undefined ? 0 : point.liabilityTotal
    return { ...point, liabilityAssumed: point.liabilityAssumed ?? point.liabilityTotal === undefined, liabilityTotal, netWorth: point.netWorth === null || point.total === null || liabilityTotal === null ? null : point.total - liabilityTotal }
  }).sort((a,b) => a.date.localeCompare(b.date))
}

// The edits a save would record, for review before saving.
export const pendingChanges = (saved: WealthData | null, data: WealthData): Change[] =>
  diffPositions(saved ?? { ...data, accounts: [] }, data, new Date().toISOString())

// Puts one balance or holding back the way it was at the last save.
// Returns null when the account itself was deleted (cancel the save to get it back).
export function revertChange(saved: WealthData | null, data: WealthData, c: Change): WealthData | null {
  const current = data.accounts.find((a) => a.id === c.accountId)
  if (!current) return null
  const key = `${c.type}:${c.type === 'cash' ? c.currency : c.symbol.toUpperCase()}`
  const original = (saved?.accounts.find((a) => a.id === c.accountId)?.positions ?? []).filter((p) => keyOf(p) === key)
  const i = current.positions.findIndex((p) => keyOf(p) === key)
  const others = current.positions.filter((p) => keyOf(p) !== key)
  // Keep the position where it was in the list.
  const at = i >= 0 ? i : others.length
  const positions = [...others.slice(0, at), ...original, ...others.slice(at)]
  return { ...data, accounts: data.accounts.map((a) => (a.id === current.id ? { ...a, positions } : a)) }
}

// Share of the earlier quantity that changed; Infinity for something added or removed.
export function changeRatio(c: Change): number {
  if (!c.before || !c.after) return Infinity
  if (c.before.quantity === 0) return c.after.quantity === 0 ? 0 : Infinity
  return Math.abs(c.after.quantity - c.before.quantity) / Math.abs(c.before.quantity)
}

// Adds this save to the history: the edits since the last saved version, and today's snapshot.
// `saved` is the version currently in Drive (null before the first save).
export function recordSave(saved: WealthData | null, next: WealthData): WealthData {
  const at = next.updatedAt
  let snapshots = next.history.snapshots
  // Files saved before history existed: keep their last state as the starting point.
  if (saved && saved.accounts.length && snapshots.length === 0 && localDate(saved.updatedAt) !== localDate(at)) {
    snapshots = [snapshotOf(saved, saved.updatedAt)]
  }
  const changes = [...next.history.changes, ...diffPositions(saved ?? { ...next, accounts: [] }, next, at)]
  const stamped: WealthData = { ...next, version: next.version === 10 || next.expenses !== undefined ? 10 : next.version === 9 ? 9 : next.version === 8 ? 8 : next.version === 7 ? 7 : next.version === 6 ? 6 : next.version === 5 || next.history.holdingPeriods !== undefined ? 5 : next.version === 4 || next.liabilities?.some(d => d.schedule || d.basisHistory) ? 4 : next.version === 3 || next.history.quantityDays !== undefined ? 3 : 2, liabilities: next.liabilities ?? [], accounts: stampAdded(saved, next, changes, at) }
  return {
    ...stamped,
    history: {
      ...(next.history.holdingPeriods !== undefined && { holdingPeriods: next.history.holdingPeriods }),
      ...(next.history.quantityDays !== undefined && { quantityDays: next.history.quantityDays }),
      changes,
      liabilityChanges: [...(next.history.liabilityChanges ?? []), ...diffLiabilities(saved, next, at)],
      snapshots: next.accounts.length || next.liabilities?.length || snapshots.length || saved?.accounts.length || saved?.liabilities?.length
        // Today's entered quantities live in quantityDays and still win over this snapshot;
        // the snapshot keeps today's debt so later days can still show it.
        ? upsert(snapshots, snapshotOf(stamped, at)) : snapshots,
    },
  }
}

// Read side of parseWealthData: an absent history is fine, a malformed one is not.
export function parseHistory(raw: unknown, fail: (why: string) => never): History {
  if (raw === undefined) return emptyHistory()
  const h = (typeof raw === 'object' && raw !== null ? raw : fail('history 不是物件')) as Record<string, unknown>
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const isStr = (v: unknown): v is string => typeof v === 'string'
  const state = (v: unknown, where: string): PositionState | null => {
    if (v === null) return null
    const s = v as Record<string, unknown>
    if (typeof v !== 'object' || !isNum(s.quantity) || !isNum(s.price)) fail(`${where}格式不正確`)
    return { quantity: s.quantity as number, price: s.price as number }
  }
  const changes = (Array.isArray(h.changes) ? h.changes : []).map((item: unknown, i): Change => {
    const where = `第 ${i + 1} 筆異動紀錄`
    const c = (typeof item === 'object' && item !== null ? item : fail(`${where}不是物件`)) as Record<string, unknown>
    if (!isStr(c.at) || !isStr(c.accountId) || !isStr(c.symbol)) fail(`${where}缺少欄位`)
    return {
      at: c.at as string,
      accountId: c.accountId as string,
      account: isStr(c.account) ? c.account : '',
      type: c.type === 'holding' ? 'holding' : 'cash',
      symbol: c.symbol as string,
      currency: isStr(c.currency) ? c.currency : '',
      before: state(c.before ?? null, `${where}的 before `),
      after: state(c.after ?? null, `${where}的 after `),
    }
  })
  if (h.liabilityChanges !== undefined && !Array.isArray(h.liabilityChanges)) fail('負債異動紀錄必須是陣列')
  const liabilityChanges = ((h.liabilityChanges ?? []) as unknown[]).map((item): LiabilityChange => {
    if (typeof item !== 'object' || item === null) return fail('負債異動紀錄不是物件')
    const c = item as Record<string, unknown>
    if (!isStr(c.at) || !isStr(c.liabilityId)) fail('負債異動紀錄缺少欄位')
    const read = (v: unknown) => {
      if (v === null) return null
      try { return parseLiability(v) } catch { return fail('負債異動紀錄格式不正確') }
    }
    const before = read(c.before), after = read(c.after)
    if ((!before && !after) || (before && before.id !== c.liabilityId) || (after && after.id !== c.liabilityId)) fail('負債異動紀錄識別碼不符')
    return { at: c.at as string, liabilityId: c.liabilityId as string, before, after }
  })
  const snapshots = (Array.isArray(h.snapshots) ? h.snapshots : []).map((item: unknown, i): Snapshot => {
    const where = `第 ${i + 1} 筆每日紀錄`
    const s = (typeof item === 'object' && item !== null ? item : fail(`${where}不是物件`)) as Record<string, unknown>
    if (!isStr(s.date) || !isNum(s.total) || !Array.isArray(s.accounts)) fail(`${where}缺少欄位`)
    const categories: Record<string, number> = {}
    if (typeof s.categories === 'object' && s.categories !== null) {
      for (const [k, v] of Object.entries(s.categories)) if (isNum(v)) categories[k] = v
    }
    if (s.liabilityEstimated !== undefined && typeof s.liabilityEstimated !== 'boolean') fail(`${where}的負債預估標記不正確`)
    for (const key of ['liabilityTotal', 'netWorth']) {
      if (s[key] !== undefined && s[key] !== null && !isNum(s[key])) fail(`${where}的負債／淨資產格式不正確`)
    }
    if (typeof s.liabilityTotal === 'number' && s.liabilityTotal < 0) fail(`${where}的負債不可為負值`)
    return {
      ...(s.liabilityEstimated !== undefined && { liabilityEstimated: s.liabilityEstimated as boolean }),
      ...(s.liabilityTotal !== undefined && { liabilityTotal: s.liabilityTotal as number | null }),
      ...(s.netWorth !== undefined && { netWorth: s.netWorth as number | null }),
      date: s.date as string,
      at: isStr(s.at) ? s.at : (s.date as string),
      total: s.total as number,
      accounts: (s.accounts as unknown[]).map((a) => {
        const r = a as Record<string, unknown>
        if (typeof a !== 'object' || a === null || !isStr(r.id) || !isNum(r.value)) fail(`${where}的帳戶格式不正確`)
        return { id: r.id as string, name: isStr(r.name) ? r.name : '', value: r.value as number }
      }),
      categories,
    }
  })
  if (snapshots.some(s => !validDate(s.date)) || new Set(snapshots.map(s => s.date)).size !== snapshots.length) fail('每日紀錄日期無效或重複')
  let quantityDays: QuantityDay[] | undefined
  try { if (h.quantityDays !== undefined) quantityDays = parseQuantityDays(h.quantityDays) } catch (e) { fail(e instanceof Error ? e.message : '歷史數量格式不正確') }
  let holdingPeriods: HoldingPeriod[] | undefined
  try { if (h.holdingPeriods !== undefined) holdingPeriods = parseHoldingPeriods(h.holdingPeriods) } catch (e) { fail(e instanceof Error ? e.message : '持有期間格式不正確') }
  return { changes, liabilityChanges, ...(holdingPeriods !== undefined && {holdingPeriods}), ...(quantityDays !== undefined && { quantityDays }), snapshots: snapshots.sort((x, y) => x.date.localeCompare(y.date)) }
}
