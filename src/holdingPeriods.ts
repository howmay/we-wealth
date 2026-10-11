import type { WealthData } from './model'
import { calendarDate, validateTimeZone } from './loanSchedule'
import { localDate } from './history'
import { historyCatalog, instrumentKey, parseQuantityDays, validDate, type HistoricalInstrument, type QuantityDay, type QuantityEntry } from './quantityHistory'

export interface HoldingPeriod extends HistoricalInstrument {
  id: string
  updatedAt: string
  start: string // inclusive closing position on this literal calendar date
  end?: string // exclusive: zero at the close on this date
  quantity: number
  timeZone: string
}
export const MAX_PERIOD_DAYS = 3660
const DAY = 86400000
export function shiftDate(date: string, days: number) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0,10) }
export function parseHoldingPeriods(raw: unknown): HoldingPeriod[] {
  if (!Array.isArray(raw)) throw new Error('持有期間必須是陣列')
  const ids = new Set<string>(), zones = new Map<string,string>()
  return raw.map(value => {
    const p = value as HoldingPeriod
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt))) throw new Error('持有期間識別碼或時間不正確')
    if (!validDate(p.start) || (p.end !== undefined && (!validDate(p.end) || p.end <= p.start))) throw new Error('結束／賣出日必須晚於開始日（開始含、結束不含）')
    try { validateTimeZone(p.timeZone) } catch { throw new Error('持有期間須填寫有效的 IANA 日曆時區，例如 Asia/Taipei') }
    const entry = parseQuantityDays([{ date:p.start, updatedAt:p.updatedAt, entries:[p] }])[0].entries[0]
    if (entry.quantity === null) throw new Error('持有期間必須填寫絕對數量')
    const key = instrumentKey(entry)
    if (zones.has(key) && zones.get(key) !== p.timeZone) throw new Error('同帳戶同標的的持有期間須使用相同日曆時區')
    ids.add(p.id); zones.set(key,p.timeZone)
    const { quantity, price: _price, fx: _fx, error: _error, ...identity } = entry
    return { ...identity, id:p.id, updatedAt:p.updatedAt, start:p.start, ...(p.end && {end:p.end}), quantity:quantity!, timeZone:p.timeZone }
  })
}
export function validatePeriodInput(p: HoldingPeriod, now = new Date().toISOString()) {
  parseHoldingPeriods([p])
  const today = calendarDate(now,p.timeZone)
  if (p.start > today || (p.end && p.end > today)) throw new Error('開始及結束日不可晚於期間時區的今天')
  if (p.start < shiftDate(today,-MAX_PERIOD_DAYS)) throw new Error('一次持有期間最多回溯近十年（3660 日），請縮短日期')
}
export interface HeldQuantity { quantity: number | null; basisDate: string }
// Compile each event once. Queries use binary search over resolved transitions;
// neither charts nor daily expansion reformat/sort all changes for every date.
export function createPeriodIndex(data: WealthData) {
  type Event = { date:string; rank:number; order:number; quantity:number|null; owner?:string; end?:boolean }
  const groups = new Map<string,{start:string;zone:string;events:Event[]}>()
  const formatters = new Map<string,Intl.DateTimeFormat>()
  const dateInZone = (at:string, zone:string) => {
    let formatter = formatters.get(zone)
    if (!formatter) { formatter = new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}); formatters.set(zone,formatter) }
    const parts = formatter.formatToParts(new Date(at))
    return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-')
  }
  ;(data.history.holdingPeriods ?? []).forEach((p,i)=>{
    const key=instrumentKey(p), group=groups.get(key) ?? {start:p.start,zone:p.timeZone,events:[]}
    if(p.start<group.start) group.start=p.start
    group.events.push({date:p.start,rank:0,order:i,quantity:p.quantity,owner:p.id})
    if(p.end) group.events.push({date:p.end,rank:1,order:i,quantity:0,owner:p.id,end:true})
    groups.set(key,group)
  })
  for(const c of data.history.changes) {
    if(c.before && c.after && c.before.quantity===c.after.quantity) continue
    const group=groups.get(instrumentKey({...c,symbol:c.type==='cash'?'':c.symbol}))
    if(group) group.events.push({date:dateInZone(c.at,group.zone),rank:2,order:Date.parse(c.at),quantity:c.after?.quantity ?? 0})
  }
  for(const day of data.history.quantityDays ?? []) for(const entry of day.inventory ? [] : day.entries) {
    const group=groups.get(instrumentKey(entry))
    if(group) group.events.push({date:day.date,rank:3,order:0,quantity:entry.quantity})
  }
  const resolved=new Map<string,{start:string;states:HeldQuantity[]}>()
  for(const [key,group] of groups) {
    group.events.sort((a,b)=>a.date.localeCompare(b.date)||a.rank-b.rank||a.order-b.order)
    let owner:string|undefined
    const states:HeldQuantity[]=[]
    for(const event of group.events) {
      if(event.end) { if(owner!==event.owner) continue }
      else if(event.owner) owner=event.owner
      states.push({quantity:event.quantity,basisDate:event.date})
    }
    resolved.set(key,{start:group.start,states})
  }
  return (identity:HistoricalInstrument,date:string):HeldQuantity|undefined => {
    const group=resolved.get(instrumentKey(identity))
    if(!group || date<group.start) return undefined
    let lo=0,hi=group.states.length
    while(lo<hi) { const mid=(lo+hi)>>>1; if(group.states[mid].basisDate<=date) lo=mid+1; else hi=mid }
    return group.states[lo-1]
  }
}
export function periodQuantityOn(data: WealthData, identity: HistoricalInstrument, date: string) {
  return createPeriodIndex(data)(identity,date)
}
export function periodConflicts(data: WealthData, p: HoldingPeriod): string[] {
  const key=instrumentKey(p), messages:string[]=[]
  for (const old of data.history.holdingPeriods ?? []) if (instrumentKey(old)===key && (!old.end || old.end >= p.start) && (!p.end || old.start <= p.end)) messages.push(`期間 ${old.start} 至 ${old.end ?? '持續持有'}：${old.quantity} → 新基準 ${p.quantity}；按較晚開始日接手，同日以後新增者優先，原紀錄保留`)
  for (const day of data.history.quantityDays ?? []) {
    const e=day.entries.find(e=>instrumentKey(e)===key)
    if(e && day.date>=p.start) messages.push(day.inventory ? `完整回補 ${day.date}：${e.quantity}（只在該日優先，不改變期間延續數量）` : `單日 ${day.date}：${e.quantity ?? '未知'}（保留且優先；不改為期間數量 ${p.quantity}）${e.quantity===null ? '：未知會中斷期間直到下一個明確事件；舊紀錄無法判別是佔位或刻意清除，請確認並編輯此項。' : ''}`)
  }
  for(const c of data.history.changes) if(c.accountId===p.accountId && c.type===p.type && c.currency===p.currency && (c.type==='cash'||c.symbol.toUpperCase()===p.symbol.toUpperCase()) && (!c.before||!c.after||c.before.quantity!==c.after.quantity)) {
    const date=calendarDate(c.at,p.timeZone)
    if(date>=p.start) messages.push(`數量異動 ${date}：${c.after?.quantity ?? 0}（保留；期間內在結束日前優先，結束日後再買可恢復持倉）`)
  }
  return messages
}
export function periodRevision(data: WealthData) { return JSON.stringify({periods:data.history.holdingPeriods,days:data.history.quantityDays,changes:data.history.changes,accounts:data.accounts}) }
export function applyHoldingPeriod(data: WealthData, period: HoldingPeriod, expectedRevision: string, confirmed: boolean, now = new Date().toISOString()): WealthData {
  if (periodRevision(data)!==expectedRevision) throw new Error('歷史或持倉已變更，請重新預覽期間')
  validatePeriodInput(period,now)
  if(periodConflicts(data,period).length && !confirmed) throw new Error('請先確認重疊期間與明確數量紀錄的差異')
  const holdingPeriods=parseHoldingPeriods([...(data.history.holdingPeriods ?? []),period])
  const next:WealthData={...data,version:data.version===10||data.expenses!==undefined?10:data.version===9?9:data.version===8?8:data.version===7?7:data.version===6?6:5,history:{...data.history,holdingPeriods}}
  expandPeriodDays(next,now) // bound work before accepting the edit
  return next
}
// Resolve only known destination evidence; generated catalog nulls are never evidence.
export function destinationEvidence(data:WealthData,date:string):QuantityEntry[] {
  const lookup=createPeriodIndex(data)
  const catalog=historyCatalog(data)
  return catalog.flatMap<QuantityEntry>(identity=>{
    const state=lookup(identity,date)
    if(state) return [{...identity,quantity:state.quantity,quantityAsOf:state.basisDate}]
    const ambiguous=catalog.some(other=>other.accountId===identity.accountId && other.type===identity.type && other.symbol===identity.symbol && other.currency!==identity.currency)
    const changes=ambiguous ? [] : data.history.changes.filter(c=>instrumentKey({...c,symbol:c.type==='cash'?'':c.symbol})===instrumentKey(identity) && localDate(c.at)===date).sort((a,b)=>a.at.localeCompare(b.at))
    return changes.length ? [{...identity,quantity:changes.at(-1)!.after?.quantity ?? 0}] : []
  })
}
export function resolveCompletion(_data:WealthData,day:QuantityDay):QuantityDay {
  if(!day.completion) return day
  return {...day,entries:[...day.entries,...day.completion.entries]}
}
export function expandPeriodDays(data: WealthData, now = new Date().toISOString()): QuantityDay[] {
  const periods=data.history.holdingPeriods ?? []
  const rawDays=data.history.quantityDays ?? []
  const catalog=historyCatalog(data)
  const complete=(day:QuantityDay):QuantityDay=>{
    if(day.completion) return resolveCompletion(data,day)
    if(day.inventory || !day.sparse) return day
    const entries=new Map(day.entries.map(e=>[instrumentKey(e),e]))
    return {...day,entries:catalog.map(identity=>entries.get(instrumentKey(identity)) ?? {...identity,quantity:null})}
  }
  if(!periods.length) return rawDays.some(d=>d.sparse || d.completion) ? rawDays.map(complete) : rawDays
  const today=localDate(now), from=periods.map(p=>p.start).sort()[0]
  const start=from < shiftDate(today,-MAX_PERIOD_DAYS) ? shiftDate(today,-MAX_PERIOD_DAYS) : from
  const result=new Map(rawDays.map(d=>[d.date,complete(d)]))
  const snapshots=new Set(data.history.snapshots.map(s=>s.date))
  const days=Math.max(0,(Date.parse(today)-Date.parse(start))/DAY)
  if(days*catalog.length>50000) throw new Error('期間估值超過 50,000 項日資料，請縮短期間或減少標的')
  const lookup=createPeriodIndex(data)
  // Index same-day legacy evidence once, without inventing carry-forward counts.
  const counts=new Map<string,Map<string,number>>()
  const ambiguous=new Set(catalog.filter(p=>catalog.some(other=>other.accountId===p.accountId && other.type===p.type && other.symbol===p.symbol && other.currency!==p.currency)).map(instrumentKey))
  for(const c of [...data.history.changes].sort((a,b)=>a.at.localeCompare(b.at))) {
    const key=instrumentKey({...c,symbol:c.type==='cash'?'':c.symbol})
    if(ambiguous.has(key)) continue
    const date=localDate(c.at), entries=counts.get(date) ?? new Map<string,number>()
    entries.set(key,c.after?.quantity ?? 0);counts.set(date,entries)
  }
  for(let date=start;date<today;date=shiftDate(date,1)) {
    // Original snapshots remain authoritative. Explicit single-day edits alone can
    // replace them; generated periods only fill previously unrecorded dates.
    if(result.get(date)?.completion || result.get(date)?.inventory || snapshots.has(date) && !result.has(date)) continue
    const existing=new Map((result.get(date)?.entries ?? []).map(e=>[instrumentKey(e),e]))
    let missingEvidence=false, explicitUnknown=false
    const entries=catalog.map(identity=>{
      const key=instrumentKey(identity),state=lookup(identity,date)
      if(state) { if(state.quantity===null) explicitUnknown=true; return {...identity,quantity:state.quantity,quantityAsOf:state.basisDate} }
      const recorded=existing.get(key), count=counts.get(date)?.get(key)
      if(recorded?.quantity===null) explicitUnknown=true
      if(!recorded && count===undefined) missingEvidence=true
      return recorded ?? {...identity,quantity:count ?? null}
    })
    const manual=result.get(date)
    result.set(date,{...manual,date,updatedAt:manual?.updatedAt ?? now,entries,periodDerived:!manual,quantityEvidence:explicitUnknown?'explicit-unknown':missingEvidence?'incomplete':'complete'})
  }
  return [...result.values()].sort((a,b)=>a.date.localeCompare(b.date))
}
