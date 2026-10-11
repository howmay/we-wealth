import { validDate } from './quantityHistory'

export interface Expense {
  id: string
  date: string
  description: string
  amount: number // positive spending, negative refund; never modifies balances
  currency: string
  card: string // user-defined bank/card label, no full card number required
  sourceKey?: string
  importKey?: string
}
export type StatementRow = Pick<Expense, 'date' | 'description' | 'amount' | 'currency'>

export function parseExpense(raw: unknown): Expense {
  const e = raw as Expense
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id.trim()) throw new Error('消費識別碼無效')
  if (typeof e.date !== 'string' || !validDate(e.date)) throw new Error('消費日期無效')
  if (typeof e.description !== 'string' || !e.description.trim() || e.description.length > 500) throw new Error('請填寫商家／說明（最多 500 字）')
  if (typeof e.card !== 'string' || !e.card.trim() || e.card.length > 100) throw new Error('請填寫銀行／卡片名稱（最多 100 字）')
  if (typeof e.amount !== 'number' || !Number.isFinite(e.amount) || Math.abs(e.amount) > 1e12) throw new Error('消費金額無效')
  if (typeof e.currency !== 'string' || !/^[A-Z]{3}$/.test(e.currency)) throw new Error('消費幣別必須是三碼，如 TWD')
  for (const key of ['sourceKey','importKey'] as const) if (e[key] !== undefined && (typeof e[key] !== 'string' || !/^[a-f0-9]{64}$/.test(e[key]))) throw new Error('消費匯入識別碼無效')
  return {id:e.id, date:e.date, description:e.description.trim(), amount:e.amount, currency:e.currency, card:e.card.trim(), ...(e.sourceKey && {sourceKey:e.sourceKey}), ...(e.importKey && {importKey:e.importKey})}
}

const normalized = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g,' ').toUpperCase()
export function isUnrecognizedMerchant(description:string):boolean {
  const value=normalized(description)
  return value.startsWith('商家未能辨識') || /^[I|丨]+$/.test(value.replace(/\s/g,''))
}
const signature = (e: StatementRow & {card:string}) => JSON.stringify([normalized(e.card),e.date,normalized(e.description),e.currency,e.amount])
export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2,'0')).join('')
}
const hashText = (text:string) => sha256(new TextEncoder().encode(text))

export async function prepareExpenses(rows: StatementRow[], card: string, fileHash: string, sourceIndexes?:number[]): Promise<Expense[]> {
  if(sourceIndexes && (sourceIndexes.length !== rows.length || new Set(sourceIndexes).size !== rows.length || sourceIndexes.some(i=>!Number.isSafeInteger(i) || i<0))) throw new Error('帳單來源列無效')
  const counts = new Map<string,number>()
  return Promise.all(rows.map(async (row,index) => {
    const e = parseExpense({...row,card,id:crypto.randomUUID()})
    const key = signature(e), ordinal = (counts.get(key) ?? 0) + 1
    counts.set(key,ordinal)
    return {...e,sourceKey:await hashText(JSON.stringify(sourceIndexes ? [normalized(card),fileHash,'source-line',sourceIndexes[index]] : [normalized(card),fileHash,index])),importKey:await hashText(JSON.stringify([key,ordinal]))}
  }))
}

// Count matching occurrences rather than collapsing two genuine identical purchases.
export function mergeExpenses(existing: Expense[], incoming: Expense[], statementRows: Expense[] = incoming): {expenses:Expense[]; added:number; duplicates:number} {
  const rows = incoming.map(parseExpense)
  if(rows.some(e=>isUnrecognizedMerchant(e.description))) throw new Error('請補上可辨識的商家，並核對是否為繳款')
  const sourceKeys = new Set(existing.flatMap(e => e.sourceKey ? [e.sourceKey] : []))
  const importKeys = new Set(existing.flatMap(e => e.importKey ? [e.importKey] : []))
  const contextSources = new Set(statementRows.flatMap(e=>e.sourceKey?[e.sourceKey]:[]))
  const contextImports = new Set(statementRows.flatMap(e=>e.importKey?[e.importKey]:[]))
  const counts = new Map<string,number>()
  // Exact matches already account for these occurrences, even when unchecked in the preview.
  for (const e of existing) {
    if((e.sourceKey && contextSources.has(e.sourceKey)) || (e.importKey && contextImports.has(e.importKey))) continue
    counts.set(signature(e),(counts.get(signature(e)) ?? 0) + 1)
  }
  const added:Expense[] = []
  for (const e of rows) {
    const key = signature(e)
    if ((e.sourceKey && sourceKeys.has(e.sourceKey)) || (e.importKey && importKeys.has(e.importKey))) continue
    if((counts.get(key) ?? 0)>0) {counts.set(key,counts.get(key)!-1);continue}
    added.push(e)
    if(e.sourceKey) sourceKeys.add(e.sourceKey)
    if(e.importKey) importKeys.add(e.importKey)
  }
  return {expenses:[...existing,...added],added:added.length,duplicates:rows.length-added.length}
}
