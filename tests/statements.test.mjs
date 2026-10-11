import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

let server, statements, expenses, model, history, saveState
before(async () => {
  server = await createServer({ configFile: false, envDir: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false } })
  statements = await server.ssrLoadModule('/src/statements.ts')
  expenses = await server.ssrLoadModule('/src/expenses.ts')
  model = await server.ssrLoadModule('/src/model.ts')
  history = await server.ssrLoadModule('/src/history.ts')
  saveState = await server.ssrLoadModule('/src/saveState.ts')
})
after(() => server?.close())
const lines = ['消費日 入帳日 商店名稱 臺幣金額', '09/01 09/03 SHOP ONE 1,200', '09/02 09/04 SHOP TWO 300.50', '09/03 09/05 SHOP REFUND -100', '09/04 09/06 自動轉帳繳款 -2,000', '本期應繳總額 1,400.50']
const parse = (text = lines, month = '2026-09') => statements.parseStatement(text, month, 'TWD')
const row = (description = 'SHOP ONE') => ({date:'2026-09-01', description, amount:1200, currency:'TWD'})
const prepare = async (rows = parse().rows, fileHash = 'a'.repeat(64)) => expenses.prepareExpenses(rows, '合成銀行 / 卡片A', fileHash)

test('extract transaction rows, preserve refunds, exclude repayments and summaries', () => {
  const result = parse()
  assert.equal(result.rows.length, 3)
  assert.deepEqual(result.rows[0], row())
  assert.equal(result.rows[1].amount, 300.5)
  assert.equal(result.rows[2].amount, -100)
  assert.ok(result.skipped.some(line => line.includes('繳款')))
})

test('year rollover and ROC years are resolved; impossible dates and ambiguous amounts are not guessed', () => {
  const result = parse(['12/30 01/02 STORE 100', '115/01/03 SHOP 200', '02/30 INVALID 30', '01/05 FOREIGN USD 10.00 320.00'], '2026-01')
  assert.deepEqual(result.rows.map(r => r.date), ['2025-12-30', '2026-01-03'])
  assert.equal(result.skipped.length, 2)
  assert.throws(() => parse([], '2026-13'), /月份/)
})

test('positioned PDF text is ordered into rows; unsupported scans fail visibly', () => {
  const item = (str,x,y) => ({str, transform:[1,0,0,1,x,y]})
  assert.deepEqual(statements.textLines([item('100',300,100),item('STORE',100,100),item('09/01',0,100),item('SECOND',100,80)]), ['09/01 STORE 100','SECOND'])
})

test('reimports of the same file and edited previews are idempotent; identical genuine purchases survive', async () => {
  const prepared = await prepare([row(),row()])
  assert.notEqual(prepared[0].importKey, prepared[1].importKey)
  const first = expenses.mergeExpenses([], prepared)
  assert.equal(first.added, 2)
  const edited = first.expenses.map(e => ({...e, description:'Corrected merchant', amount:1100}))
  assert.equal(expenses.mergeExpenses(edited, prepared).added, 0)
  const anotherPdf = await prepare([row(),row()], 'b'.repeat(64))
  assert.equal(expenses.mergeExpenses(edited, anotherPdf).added, 0)
  const otherCard = prepared.map(e => ({...e, card:'another card', sourceKey:undefined, importKey:undefined}))
  assert.equal(expenses.mergeExpenses(first.expenses, otherCard).added, 2)
})

test('edited rows are rechecked against existing transactions; invalid batch is atomic', async () => {
  const existing = expenses.mergeExpenses([], await prepare([row()])).expenses
  const corrected = (await prepare([row('WRONG')], 'b'.repeat(64))).map(e => ({...e,description:'SHOP ONE'}))
  assert.equal(expenses.mergeExpenses(existing, corrected).added,0)
  assert.throws(() => expenses.mergeExpenses(existing,[...corrected,{...corrected[0],amount:NaN}]), /金額/)
  assert.equal(existing.length,1)
})

test('partial import of identical purchases can later import the missing occurrence, with known rows unchecked',async()=>{
  const rows = await prepare([row(),row()])
  const existing = expenses.mergeExpenses([],[rows[1]]).expenses
  assert.equal(expenses.mergeExpenses(existing,rows).added,1)
  assert.equal(expenses.mergeExpenses(existing,[rows[0]],rows).added,1)
  const anotherFile = await prepare([row(),row()],'b'.repeat(64))
  assert.equal(expenses.mergeExpenses(existing,[anotherFile[0]],anotherFile).added,1)
})

test('v10 records roundtrip, validate imports and remain v10 through saves and concurrent edits', async () => {
  const data = {...model.emptyData(),version:10,expenses:(await prepare([row()]))}
  assert.deepEqual(model.parseWealthData(JSON.parse(JSON.stringify(data))).expenses,data.expenses)
  assert.throws(() => model.parseWealthData({...data,expenses:[{...data.expenses[0],date:'2026-02-30'}]}),/日期/)
  assert.throws(() => model.parseWealthData({...data,expenses:[data.expenses[0],data.expenses[0]]}),/識別碼/)
  assert.throws(() => model.parseWealthData({...data,expenses:undefined}),/消費/)
  const persisted = history.recordSave(null,data)
  assert.equal(persisted.version,10)
  const current = {...data,expenses:[]}
  assert.deepEqual(saveState.finishSave(current,data,persisted).expenses,[])
  assert.equal(saveState.finishSave(current,data,persisted).version,10)
  assert.equal(model.parseWealthData(model.emptyData()).expenses,undefined)
  const quantity = await server.ssrLoadModule('/src/quantityHistory.ts')
  const next = quantity.applyQuantityDay(data,{date:'2025-09-01',updatedAt:'2025-09-01T12:00:00Z',entries:[]})
  assert.equal(next.version,10)
  assert.deepEqual(next.expenses,data.expenses)
})

async function pdfLines(name,password) {
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({data:new Uint8Array(await readFile(new URL(`./fixtures/${name}`,import.meta.url))),password,
    cMapUrl:fileURLToPath(new URL('../node_modules/pdfjs-dist/cmaps/',import.meta.url)),
    standardFontDataUrl:fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/',import.meta.url)),verbosity:0})
  try {
    const pdf = await task.promise, page = await pdf.getPage(1)
    return statements.textLines((await page.getTextContent()).items)
  } finally {await task.destroy()}
}

test('real synthetic encrypted PDF rejects wrong password and yields transactions with the right password',async()=>{
  await assert.rejects(()=>pdfLines('synthetic-statement-encrypted.pdf','wrong'),{name:'PasswordException'})
  const result = parse(await pdfLines('synthetic-statement-encrypted.pdf','fixture-password'))
  assert.equal(result.rows.length,4)
  assert.deepEqual(result.rows.slice(0,2),[row(),row()])
  assert.equal(result.rows[3].amount,-100)
})

test('CJK PDF character maps preserve Chinese names and exclude repayment; textless PDFs yield no rows',async()=>{
  const result = parse(await pdfLines('synthetic-statement-cjk.pdf'))
  assert.deepEqual(result.rows.map(r=>r.description),['合成商店','合成退款'])
  assert.equal(result.rows[1].amount,-100)
  assert.deepEqual(await pdfLines('synthetic-scan.pdf'),[])
  assert.equal(parse(await pdfLines('synthetic-statement.pdf')).rows.length,4)
})


test('Fubon ROC posting columns and E.SUN original amounts use the final billed TWD amount',()=>{
  const fubon = statements.parseStatement(['消費日期 消費明細 入帳日期 外幣金額 台幣金額',
    '115/04/01 自動轉帳繳款 115/04/02 -5,000',
    '115/04/03 合成旅遊商店 115/04/05 1150404/ HKD 50.30/ NLD 205',
    '115/04/06 合成商店 123 分店 115/04/08 TWD 25'], '2026-04','USD','富邦信用卡.pdf')
  assert.deepEqual(fubon.rows,[{date:'2026-04-03',description:'合成旅遊商店',amount:205,currency:'TWD'},
    {date:'2026-04-06',description:'合成商店 123 分店',amount:25,currency:'TWD'}])
  const esun = statements.parseStatement(['消費日 入帳日 消費明細 幣別',
    '11/01 11/02 合成海外商店 11/02 USD 10.00 TWD 320',
    '11/03 11/04 合成退款 TWD -100',
    '11/05 感謝您辦理自動轉帳繳款 TWD -900'],'2025-11','USD','玉山信用卡.pdf')
  assert.deepEqual(esun.rows,[{date:'2025-11-01',description:'合成海外商店',amount:320,currency:'TWD'},
    {date:'2025-11-03',description:'合成退款',amount:-100,currency:'TWD'}])
})

test('HSBC unreadable merchant rows require review; foreign source amount never replaces billed TWD',()=>{
  const result=statements.parseStatement(['04/01 04/02 1,200', '04/03 04/04 USA USD 10.00 04/04 320'],'2026-04','TWD','HSBC信用卡.pdf')
  assert.deepEqual(result.rows.map(r=>[r.amount,r.currency]),[[1200,'TWD'],[320,'TWD']])
  assert.deepEqual(result.review,[0,1])
  assert.ok(result.rows.every(r=>r.description.includes('未能辨識')))
})

test('securities statements are rejected by filename and strong content markers, not credit-card ads',()=>{
  assert.throws(()=>statements.assertCreditCardFile('台新證券綜合月對帳單.pdf'),/證券/)
  assert.throws(()=>parse(['綜合月對帳單','成交日期 買賣別 證券帳號']),/證券/)
  assert.doesNotThrow(()=>parse(['信用卡優惠與證券廣告',...lines]))
})


test('PDF heading identifies bank and ROC statement month before filename, without payment/advertisement dates',()=>{
  assert.deepEqual(statements.statementMetadata(['玉山銀行','114年11月 信用卡電子帳單'],'','renamed-2026-04.pdf'),{bank:'玉山',month:'2025-11',monthSource:'帳單標題'})
  assert.deepEqual(statements.statementMetadata(['台北富邦銀行','本期結帳日 繳款截止日','115/04/25 115/05/10'],'','renamed.pdf'),{bank:'富邦',month:'2026-04',monthSource:'帳單結帳日'})
  assert.equal(statements.statementMetadata(['繳款截止日 115/05/10','消費日 商家','廣告活動 115年06月']).month,undefined)
  assert.equal(statements.statementMetadata(['本期結帳日 115/02/30']).month,undefined)
  assert.deepEqual(statements.statementMetadata([],'HSBC credit card statement','2026-04.pdf'),{bank:'匯豐',month:'2026-04',monthSource:'檔名'})
  assert.equal(statements.statementMetadata(['114年13月 信用卡帳單']).month,undefined)
})

test('comma separated passwords retry locally and exhaust safely; plaintext needs no prompt',async()=>{
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
  for(const [file,secrets,success] of [['synthetic-statement-encrypted.pdf','wrong, fixture-password, wrong',true],
    ['synthetic-statement-encrypted.pdf','wrong,also-wrong',false],['synthetic-statement.pdf','',true]]) {
    const task=getDocument({data:new Uint8Array(await readFile(new URL(`./fixtures/${file}`,import.meta.url))),password:'',verbosity:0})
    task.onPassword=statements.statementPasswordHandler(secrets)
    try {
      if(success) assert.equal((await task.promise).numPages,1)
      else await assert.rejects(task.promise,{name:'PasswordException'})
    } finally {await task.destroy()}
  }
})


test('two encrypted bank PDFs auto-detect distinct months and bank names',async()=>{
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
  const previews=[]
  for(const bank of ['esun','fubon']) {
    const task=getDocument({data:new Uint8Array(await readFile(new URL(`./fixtures/synthetic-batch-${bank}-encrypted.pdf`,import.meta.url))),password:'',
      cMapUrl:fileURLToPath(new URL('../node_modules/pdfjs-dist/cmaps/',import.meta.url)),verbosity:0})
    task.onPassword=statements.statementPasswordHandler('wrong, fixture-esun, fixture-fubon')
    try {
      const pdf=await task.promise
      const text=statements.textLines((await (await pdf.getPage(1)).getTextContent()).items)
      const {info}=await pdf.getMetadata()
      const metadata=statements.statementMetadata(text,info.Title,'renamed.pdf')
      assert.equal(metadata.bank,bank==='esun'?'玉山':'富邦')
      assert.equal(metadata.month,bank==='esun'?'2025-11':'2025-12')
      const parsed=statements.parseStatement(text,metadata.month,'TWD',metadata.bank)
      assert.deepEqual(parsed.rows.map(r=>r.amount),[200,-50])
      previews.push(...await expenses.prepareExpenses(parsed.rows,metadata.bank,bank==='esun'?'a'.repeat(64):'b'.repeat(64)))
    } finally {await task.destroy()}
  }
  const first=expenses.mergeExpenses([],previews)
  assert.equal(first.added,4)
  assert.equal(expenses.mergeExpenses(first.expenses,previews).added,0)
  assert.equal(expenses.mergeExpenses([],[...previews,...previews]).added,4)
})


test('merchant OCR preserves original date and billed amount, excludes repayments, and refuses uncertain text',()=>{
  const line='04/03 04/05 USA USD 10.00 04/05 320'
  const enriched=statements.ocrMerchantLine(line,'SYNTHETIC.SHOP123',92)
  assert.equal(enriched,'04/03 04/05 SYNTHETIC.SHOP123 320')
  assert.deepEqual(statements.parseStatement([enriched],'2026-04','TWD','HSBC').rows,[{date:'2026-04-03',description:'SYNTHETIC.SHOP123',amount:320,currency:'TWD'}])
  assert.equal(statements.ocrMerchantLine(line,'unclear',20),line)
  assert.equal(statements.ocrMerchantLine(line,'123',99),line)
  assert.equal(statements.ocrMerchantLine(line,'word',NaN),line)
  assert.equal(statements.parseStatement([statements.ocrMerchantLine('04/01 04/02 -2,000','自動转帳繳款',90)],'2026-04','TWD','HSBC').rows.length,0)
  const item=(str,x,width)=>({str,width,height:9,transform:[1,0,0,1,x,100]})
  const regions=statements.hsbcMerchantRegions([item('04/03',30,25),item('04/05',80,25),item('320',400,20)])
  assert.equal(regions.length,1)
  assert.deepEqual([regions[0].left,regions[0].right],[109,396])
  assert.deepEqual(statements.hsbcMerchantRegions([item('04/03',30,25),item('04/05',80,25),item('READABLE SHOP',140,100),item('320',400,20)]),[])
})


test('HSBC source rows stay stable when OCR excludes repayments or merchants change',async()=>{
  const raw=['04/01 04/02 -2000','04/03 04/04 210','04/03 04/04 210']
  const initial=statements.parseStatement(raw,'2026-04','TWD','HSBC')
  const recognized=raw.map((line,i)=>statements.ocrMerchantLine(line,['自動轉帳繳款','SYNTHETIC A','SYNTHETIC B'][i],90))
  const next=statements.parseStatement(recognized,'2026-04','TWD','HSBC')
  assert.deepEqual(next.sourceIndexes,[1,2])
  const before=await expenses.prepareExpenses(initial.rows,'HSBC','a'.repeat(64),initial.sourceIndexes)
  const after=await expenses.prepareExpenses(next.rows,'HSBC','a'.repeat(64),next.sourceIndexes)
  assert.equal(before[1].sourceKey,after[0].sourceKey)
  assert.equal(before[2].sourceKey,after[1].sourceKey)
  assert.equal(expenses.mergeExpenses([before[1]],after).added,1)
  assert.equal(expenses.mergeExpenses(after,after).added,0)
  await assert.rejects(()=>expenses.prepareExpenses(next.rows,'HSBC','a',[1,1]),/來源列/)
})


test('HSBC auto-debit repayment is excluded without dropping merchant subscriptions or refunds',()=>{
  const result=statements.parseStatement(['04/01 04/02 匯豐銀行自動扣款 -2000','04/03 04/04 SYNTHETIC SUBSCRIPTION 640','04/04 04/05 合成退款 -100'],'2026-04','TWD','HSBC')
  assert.deepEqual(result.rows.map(r=>r.amount),[640,-100])
})
test('HSBC layout bounds start below prior balance and end before payment summary',()=>{
  const tsv='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'+[
    '5\t1\t1\t1\t1\t1\t20\t100\t60\t10\t90\t前期',
    '5\t1\t1\t1\t1\t2\t80\t100\t60\t10\t90\t餘額',
    '5\t1\t1\t1\t2\t1\t20\t120\t60\t10\t90\t本期應繳',
    '5\t1\t2\t1\t1\t1\t20\t300\t60\t10\t90\t本期應繳'].join('\n')
  assert.deepEqual(statements.hsbcTransactionBounds(tsv,[80,180,220,330]),{top:110,bottom:300})
  assert.equal(statements.hsbcTransactionBounds('',[180]),undefined)
  const lines=['04/01 04/02 999','04/03 04/04 SYNTHETIC SHOP 210','04/05 04/06 888']
  const parsed=statements.parseStatement(lines,'2026-04','TWD','HSBC',[1])
  assert.deepEqual(parsed.rows.map(r=>r.amount),[210])
  assert.deepEqual(parsed.sourceIndexes,[1])
  assert.deepEqual(parsed.skipped,[])
})


test('synthetic HSBC PDF preserves readable scope headings and excludes date-shaped rows outside the table',async()=>{
  const extracted=await pdfLines('synthetic-hsbc-2026-04-image-merchants.pdf')
  const start=extracted.findIndex(l=>l.includes('前期餘額'))
  const end=extracted.findIndex(l=>l.includes('本期應繳'))
  assert.ok(start>0 && end>start)
  const indices=extracted.flatMap((_,i)=>i>start && i<end?[i]:[])
  const parsed=statements.parseStatement(extracted,'2026-04','TWD','HSBC',indices)
  assert.deepEqual(parsed.rows.map(r=>r.amount),[210,900,640,-2000])
  assert.equal(extracted.filter(l=>l.endsWith('999')).length,2)
  assert.ok(parsed.rows.every(r=>r.amount!==999))
})


test('multi-page HSBC fixture has a bankless continuation page with a readable transaction heading',async()=>{
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task=getDocument({data:new Uint8Array(await readFile(new URL('./fixtures/synthetic-hsbc-2026-04-multipage.pdf',import.meta.url))),verbosity:0})
  try {
    const pdf=await task.promise
    assert.equal(pdf.numPages,2)
    const second=statements.textLines((await (await pdf.getPage(2)).getTextContent()).items)
    assert.ok(second.some(l=>l.includes('消費日期') && l.includes('入帳日期')))
    assert.ok(!second.some(l=>/HSBC|匯豐/.test(l)))
    assert.equal(statements.parseStatement(second,'2026-04','TWD','HSBC').rows.length,4)
  } finally {await task.destroy()}
})


test('SG HSBC metadata uses statement-period end month and the billed SGD header',()=>{
  const info=statements.statementMetadata(['HSBC','ACCOUNT SUMMARY SGD','Statement From 21 Dec 2025 to 20 Jan 2026'],'HSBC statement','renamed.pdf')
  assert.deepEqual(info,{bank:'匯豐',currency:'SGD',month:'2026-01',monthSource:'帳單結帳日'})
})
test('SG HSBC positioned columns preserve merchant numbers, final SGD amount and CR, excluding summary/payment',()=>{
  const item=(str,x,y)=>({str,width:20,height:8,transform:[1,0,0,1,x,y]})
  const items=[item('DATE',56,660),item('DATE',101,660),item('DESCRIPTION',139,660),item('AMOUNT(SGD)',278,660),
    item('Previous statement balance',139,625),item('999',338,625),
    item('31 DEC',59,600),item('02 JAN',100,600),item('SYNTHETIC SHOP 123',139,600),item('12.34',348,600),
    item('CNY 80.00',139,590),item('COUNTRY',200,590),
    item('03 JAN',59,570),item('04 JAN',100,570),item('SYNTHETIC REFUND',139,570),item('2.00CR',330,570),
    item('05 JAN',59,540),item('06 JAN',100,540),item('PAYMENT THANK YOU',139,540),item('500.00CR',330,540),
    item('Total',139,510),item('999',338,510),item('07 JAN',59,490),item('08 JAN',100,490),item('AD',139,490),item('999',348,490)]
  const page=statements.hsbcSgPage(items)
  assert.ok(page)
  const parsed=statements.parseStatement(page.lines,'2026-01','SGD','HSBC',page.transactionIndexes)
  assert.deepEqual(parsed.rows,[{date:'2025-12-31',description:'SYNTHETIC SHOP 123',amount:12.34,currency:'SGD'},{date:'2026-01-03',description:'SYNTHETIC REFUND',amount:-2,currency:'SGD'}])
  assert.deepEqual(statements.hsbcSgPage([item('HSBC',50,700)]),undefined)
})


test('SG HSBC PDF skips its cover and combines only billed SGD transactions',async()=>{
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task=getDocument({data:new Uint8Array(await readFile(new URL('./fixtures/synthetic-hsbc-sg.pdf',import.meta.url))),verbosity:0})
  try {
    const pdf=await task.promise,lines=[],allowed=[]
    for(let n=1;n<=pdf.numPages;n++) {
      const items=(await (await pdf.getPage(n)).getTextContent()).items
      const sg=statements.hsbcSgPage(items)
      if(sg) allowed.push(...sg.transactionIndexes.map(i=>lines.length+i))
      lines.push(...(sg?.lines ?? statements.textLines(items)))
    }
    const info=statements.statementMetadata(lines,(await pdf.getMetadata()).info.Title,'renamed.pdf')
    assert.equal(info.month,'2026-09');assert.equal(info.currency,'SGD')
    const parsed=statements.parseStatement(lines,info.month,info.currency,info.bank,allowed)
    assert.deepEqual(parsed.rows.map(r=>[r.description,r.amount,r.currency]),[['SYNTHETIC SHOP 123',12.34,'SGD'],['SYNTHETIC REFUND',-2,'SGD']])
    const rows=await expenses.prepareExpenses(parsed.rows,'匯豐 (SG)','a'.repeat(64),parsed.sourceIndexes)
    assert.equal(expenses.mergeExpenses(rows,rows).added,0)
  } finally {await task.destroy()}
})
