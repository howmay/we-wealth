import { validDate } from './quantityHistory'
import type { StatementRow } from './expenses'

interface TextItem { str:string; transform:number[];width?:number;height?:number }
export function textRows(items: unknown[]) {
  const rows: {y:number; items:{x:number;str:string;width:number;height:number}[]}[] = []
  for (const raw of items) {
    const item = raw as TextItem
    if (typeof item.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) continue
    const x = item.transform[4], y = item.transform[5]
    let row = rows.find(r => Math.abs(r.y-y) <= 2)
    if (!row) {row = {y,items:[]}; rows.push(row)}
    row.items.push({x,str:item.str,width:item.width ?? 0,height:item.height ?? 0})
  }
  return rows.sort((a,b) => b.y-a.y).map(r=>({...r,items:r.items.sort((a,b)=>a.x-b.x)}))
}

export function textLines(items:unknown[]):string[] {
  return textRows(items).map(r=>r.items.map(i=>i.str).join(' ').replace(/\s+/g,' ').trim())
}

const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
const englishDate=(text:string)=>{
  const match=text.trim().match(/^(\d{1,2})\s+([A-Z]{3})$/i)
  const month=match ? months.indexOf(match[2].toUpperCase())+1 : 0
  return match && month ? `${String(month).padStart(2,'0')}/${match[1].padStart(2,'0')}` : undefined
}

export function hsbcSgPage(items:unknown[]) {
  const rows=textRows(items),lines=textLines(items)
  const header=rows.find(row=>row.items.filter(i=>/^DATE$/i.test(i.str.trim())).length===2 && row.items.some(i=>/^DESCRIPTION$/i.test(i.str.trim())) && row.items.some(i=>/^AMOUNT\s*\(SGD\)$/i.test(i.str.trim())))
  if(!header) return undefined
  const dates=header.items.filter(i=>/^DATE$/i.test(i.str.trim()))
  const merchantX=header.items.find(i=>/^DESCRIPTION$/i.test(i.str.trim()))!.x
  const amountX=header.items.find(i=>/^AMOUNT/i.test(i.str.trim()))!.x
  const transactionIndexes:number[]=[]
  for(const [index,row] of rows.entries()) {
    if(row.y>=header.y) continue
    if(row.items.some(i=>i.x>=merchantX-5 && /^Total(?:\s|$)/i.test(i.str.trim()))) break
    const date=dates.map(column=>englishDate(row.items.find(i=>Math.abs(i.x-column.x)<5)?.str ?? ''))
    if(!date.every(Boolean)) continue
    const description=row.items.filter(i=>i.x>=merchantX-5 && i.x<amountX).map(i=>i.str.trim()).join(' ')
    const amount=row.items.filter(i=>i.x>=amountX).map(i=>i.str.trim()).join(' ').replace(/(\d)(CR|DR)$/i,'$1 $2')
    lines[index]=`${date.join(' ')} ${description} ${amount}`
    transactionIndexes.push(index)
  }
  return {lines,transactionIndexes}
}

export function hsbcMerchantRegions(items:unknown[]) {
  return textRows(items).flatMap((row,index)=>{
    const line=row.items.map(i=>i.str).join(' ').replace(/\s+/g,' ').trim()
    if(!parseStatement([line],'2000-12','TWD','HSBC').review.length) return []
    const dates=row.items.filter(i=>/^\d{1,2}[/.-]\d{1,2}$/.test(i.str))
    if(dates.length < 2) return []
    const left=dates[1].x+dates[1].width+4
    const right=row.items.find(i=>i.x > left)?.x
    if(!right || right-left < 20) return []
    return [{index,line,left,right:right-4,bottom:row.y-3.5,top:row.y+9.5}]
  })
}

export function hsbcTransactionBounds(tsv:string, transactionTops:number[]):{top:number;bottom:number}|undefined {
  const rows=new Map<string,{text:string;top:number;bottom:number}>()
  for(const line of tsv.split('\n').slice(1)) {
    const columns=line.split('\t')
    if(columns.length < 12 || columns[0] !== '5') continue
    const top=Number(columns[7]),height=Number(columns[9])
    if(!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) continue
    const key=columns.slice(1,5).join('-')
    const row=rows.get(key) ?? {text:'',top,bottom:top+height}
    row.text+=columns.slice(11).join('').normalize('NFKC').replace(/\s/g,'')
    row.top=Math.min(row.top,top);row.bottom=Math.max(row.bottom,top+height)
    rows.set(key,row)
  }
  const sorted=[...rows.values()].sort((a,b)=>a.top-b.top)
  const anchors=sorted.filter(r=>/前期餘額|前期余额/.test(r.text))
  const starts=anchors.length ? anchors : sorted.filter(r=>/交易明細|消費明細|消費日(?:期)?.*入帳日/.test(r.text))
  const start=starts.find(r=>transactionTops.some(top=>top > r.bottom))
  if(!start) return undefined
  const firstTransactionTop=Math.min(...transactionTops.filter(top=>top > start.bottom))
  const end=sorted.find(r=>r.top > firstTransactionTop && /本期應繳|本期应缴|本期合計|本期消費總額|繳款資訊|注意事項/.test(r.text))
  return {top:start.bottom,bottom:end?.top ?? Infinity}
}

export function ocrMerchantLine(line:string, description:string, confidence:number):string {
  const merchant=description.normalize('NFKC').replace(/\s+/g,' ').trim()
  const dates=line.match(/^(\d{1,2}[/.-]\d{1,2}\s+\d{1,2}[/.-]\d{1,2})\s+/)?.[1]
  const amount=line.match(/(?:^|\s)(\(?[+-]?\d[\d,]*(?:\.\d{1,2})?\)?(?:\s*(?:CR|DR))?)$/i)?.[1]
  if(!dates || !amount || confidence < 65 || !Number.isFinite(confidence) || !/[\p{L}]/u.test(merchant) || merchant.length > 500) return line
  return `${dates} ${merchant} ${amount}`
}

const datePattern = /^(?:(\d{3,4})[/.-])?(\d{1,2})[/.-](\d{1,2})(?:\s+|$)/
const nonSpending = /繳款|繳費|轉帳扣款|自動扣繳|匯豐銀行自動扣款|滙豐銀行自動扣款|上期|前期|應繳|最低應繳|總額|小計|合計|PAYMENT|BALANCE|TOTAL/i
// One worker tries each candidate; passwords never enter persisted import data.
export function statementPasswordHandler(passwordText:string) {
  const passwords = [...new Set(passwordText.split(',').map(p=>p.trim()).filter(Boolean))]
  let index = 0
  return (update:(value:string|Error)=>void) => update(index < passwords.length ? passwords[index++] : new Error('帳單需要密碼，或提供的密碼均不正確。'))
}

export function statementMetadata(lines:string[], title = '', fileName = ''): {bank?:string;month?:string;monthSource?:string;currency?:string} {
  const identify = (text:string) => {
    const compact = text.normalize('NFKC').replace(/\s/g,'')
    const banks = [[/玉山|E\.?SUN/i,'玉山'],[/富邦|FUBON/i,'富邦'],[/HSBC|滙豐|匯豐/i,'匯豐']] as const
    const matches = banks.filter(([pattern])=>pattern.test(compact))
    return matches.length === 1 ? matches[0][1] : undefined
  }
  const bank = identify(title) ?? lines.slice(0,10).map(identify).find(Boolean) ?? identify(fileName) ?? identify(lines.join(' '))
  const identity={bank,...(bank === '匯豐' && /AMOUNT\s*\(\s*SGD\s*\)|ACCOUNT\s+SUMMARY\s+SGD/i.test(lines.join(' ')) ? {currency:'SGD'} : {})}
  for(const line of lines) {
    const closing=line.match(/^Statement From \d{1,2}\s+[A-Z]{3}\s+\d{4}\s+to\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/i)
    const date=closing && englishDate(`${closing[1]} ${closing[2]}`)
    if(identity.currency && closing && date && validDate(`${closing[3]}-${date.replace('/','-')}`)) return {...identity,month:`${closing[3]}-${date.slice(0,2)}`,monthSource:'帳單結帳日'}
  }
  const yearMonth = (year:string,month:string) => {
    const y = Number(year)+(year.length === 3 ? 1911 : 0), m = Number(month)
    return y >= 1900 && y <= 9999 && m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2,'0')}` : undefined
  }
  // Only explicit statement headings/dates count; payment deadlines and advertising dates do not.
  for(const heading of [title,...lines.slice(0,20).filter(l=>/信用卡|帳單|對帳單/.test(l))]) {
    const match = heading.normalize('NFKC').match(/(\d{3,4})\s*年\s*(\d{1,2})\s*月/)
    if(match) {const month=yearMonth(match[1],match[2]);if(month) return {...identity,month,monthSource:'帳單標題'}}
  }
  for(let i=0;i<Math.min(lines.length,20);i++) {
    const line=lines[i].normalize('NFKC')
    const labels=[...line.matchAll(/結帳日(?:期)?|帳單日期|繳款截止日(?:期)?|繳款期限/g)]
    const index=labels.findIndex(m=>/結帳|帳單日期/.test(m[0]))
    if(index < 0) continue
    const dates=[...(line.match(/\d{3,4}[/.-]\d{1,2}[/.-]\d{1,2}/g) ?? [])]
    const values=dates.length ? dates : (lines[i+1]?.normalize('NFKC').match(/\d{3,4}[/.-]\d{1,2}[/.-]\d{1,2}/g) ?? [])
    if(values.length !== labels.length) continue
    const [year,m,d]=values[index].split(/[/.-]/)
    const month=yearMonth(year,m)
    if(month && validDate(`${month}-${d.padStart(2,'0')}`)) return {...identity,month,monthSource:'帳單結帳日'}
  }
  const match=fileName.match(/(?:^|\D)(20\d{2})[-_](0[1-9]|1[0-2])(?:\D|$)/)
  return {...identity,...(match?{month:yearMonth(match[1],match[2]),monthSource:'檔名'}:{})}
}

export function assertCreditCardFile(name:string) {
  if(/證券|证券|綜合月對帳單|综合月对账单/.test(name)) throw new Error('證券對帳單不支援：請選擇信用卡帳單')
}
export function parseStatement(lines:string[], month:string, currency:string, fileName = '', transactionIndexes?:number[]): {rows:StatementRow[];skipped:string[];review:number[];sourceIndexes:number[]} {
  assertCreditCardFile(fileName)
  const text = lines.join(' ').replace(/\s/g,'')
  if(/綜合月對帳單|综合月对账单/.test(text) || (/成交日期/.test(text) && /買賣別|證券帳號/.test(text))) throw new Error('證券對帳單不支援：請選擇信用卡帳單')
  const detected = statementMetadata(lines,'',fileName).bank
  const bank = detected === '富邦' ? 'fubon' : detected === '玉山' ? 'esun' : detected === '匯豐' ? 'hsbc' : null
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('請填寫有效的帳單月份')
  if(!/^[A-Z]{3}$/.test(currency)) throw new Error('請填寫三碼幣別')
  const rows:StatementRow[] = [], skipped:string[] = [], review:number[] = [], sourceIndexes:number[] = []
  const allowed=transactionIndexes ? new Set(transactionIndexes) : undefined
  for (const [sourceIndex,original] of lines.entries()) {
    if(allowed && !allowed.has(sourceIndex)) continue
    let line = original.normalize('NFKC').trim()
    const match = line.match(datePattern)
    if (!match) { if (/\d/.test(line)) skipped.push(original); continue }
    if(nonSpending.test(line) || (bank === 'hsbc' && /[匯滙]豐銀行自動扣款/.test(line.replace(/\s/g,'')))) {skipped.push(original);continue}
    const m = Number(match[2]), d = Number(match[3])
    let year = match[1] ? Number(match[1]) : Number(month.slice(0,4))
    if(match[1]?.length === 3) year += 1911
    if(!match[1] && m > Number(month.slice(5))) year--
    const date = `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    line = line.slice(match[0].length)
    // Some statements have posting date in a second column.
    const posting = line.match(datePattern)
    if(posting) line = line.slice(posting[0].length)
    if(bank === 'hsbc' && !posting) {skipped.push(original);continue}
    const amountMatch = line.match(/(?:^|\s+)(?:NT\$|TWD|\$)?\s*(\(?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\)?)(?:\s*(CR|DR))?$/i)
    if(!validDate(date) || !amountMatch) {skipped.push(original);continue}
    let description = line.slice(0,amountMatch.index).trim()
    if(bank === 'fubon') {
      // The posting date separates the merchant from original-currency metadata.
      const middlePosting = description.search(/\s\d{3,4}[/.-]\d{1,2}[/.-]\d{1,2}(?:\s|$)/)
      if(middlePosting >= 0) description = description.slice(0,middlePosting).trim()
    }
    if(bank === 'esun' || bank === 'hsbc') {
      description = description.split(/\s(?:TWD|NTD|USD|SGD|HKD|JPY|EUR)\s+[+-]?\d/i)[0].trim()
      description = description.replace(/\s\d{1,2}[/.-]\d{1,2}$/, '').trim()
    }
    if(bank === 'hsbc' && (!description || !/[\p{L}]/u.test(description) || /^[A-Z]{3}$/i.test(description))) {
      description = '商家未能辨識（請對照帳單填寫；可能包含繳款）'
      review.push(rows.length)
    }
    // shortcut: unknown bank layouts require a single unambiguous amount; add verified layouts when samples are available.
    if(!description || (!bank && /\s[+-]?\d[\d,.]*\s*$/.test(description))) {skipped.push(original);continue}
    let amount = Number(amountMatch[1].replace(/[(),]/g,''))
    if(amountMatch[1].startsWith('(') || amountMatch[2]?.toUpperCase() === 'CR') amount = -Math.abs(amount)
    if(!Number.isFinite(amount)) {skipped.push(original);continue}
    sourceIndexes.push(sourceIndex)
    rows.push({date,description,amount,currency:bank === 'fubon' || bank === 'esun' ? 'TWD' : currency})
  }
  return {rows,skipped,review,sourceIndexes}
}
