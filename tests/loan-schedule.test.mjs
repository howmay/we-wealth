import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
let server, schedule, debts, model, history, saveState, estimateLoan, quantity
before(async () => {
  server = await createServer({ configFile: false, envDir: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false } })
  quantity = await server.ssrLoadModule('/src/quantityHistory.ts')
  schedule = await server.ssrLoadModule('/src/loanSchedule.ts')
  debts = await server.ssrLoadModule('/src/liabilities.ts')
  model = await server.ssrLoadModule('/src/model.ts')
  history = await server.ssrLoadModule('/src/history.ts')
  saveState = await server.ssrLoadModule('/src/saveState.ts')
  ;({ estimateLoan } = await server.ssrLoadModule('/src/loanEstimate.ts'))
})
after(() => server.close())
const loan = (over = {}) => ({ id: 'synthetic-scheduled', name: '合成定期貸款', kind: 'personal', currency: 'TWD', balance: 1200, annualRate: 12, repaymentMethod: 'annuity', remainingInstallments: 12, schedule: { source: 'original', baseDate: '2024-01-30', firstDueDate: '2024-01-31', monthlyDay: 31, timeZone: 'Asia/Taipei' }, ...over })
const at = date => `${date}T12:00:00Z`
const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`)
test('due dates subtract only principal for both methods; no input mutation or double subtraction', () => {
  for (const method of ['annuity', 'equalPrincipal']) {
    const d = loan({ repaymentMethod: method }), before = structuredClone(d)
    Object.freeze(d.schedule); Object.freeze(d)
    const rows = estimateLoan({ principal: 1200, annualRate: 12, periods: 12, method }).rows
    assert.equal(schedule.projectLiability(d, at('2024-01-30')).balance, 1200)
    for (let i = 0; i < 12; i++) {
      const date = schedule.monthlyDate(d.schedule.firstDueDate, 31, i)
      const actual = schedule.projectLiability(d, at(date))
      close(actual.balance, rows[i].closingBalance)
      close(actual.principalRepaid, 1200 - rows[i].closingBalance)
      assert.equal(actual.remaining, 11-i)
      assert.equal(actual.elapsed, i+1)
      assert.deepEqual(schedule.projectLiability(structuredClone(d), at(date)), actual)
    }
    assert.deepEqual(d, before)
    assert.equal(schedule.projectLiability(d, at('2099-12-31')).balance, 0)
    assert.equal(schedule.projectLiability(d, at('2099-12-31')).nextDueDate, undefined)
  }
})
test('29/30/31 anchors survive February, leap years, century rules and year boundaries', () => {
  for (const day of [29,30,31]) {
    assert.equal(schedule.monthlyDate(`2023-01-${day}`, day, 1), '2023-02-28')
    assert.equal(schedule.monthlyDate(`2023-01-${day}`, day, 2), `2023-03-${day}`)
    assert.equal(schedule.monthlyDate(`2024-01-${day}`, day, 1), '2024-02-29')
  }
  assert.equal(schedule.monthlyDate('2000-01-31',31,1),'2000-02-29')
  assert.equal(schedule.monthlyDate('2100-01-31',31,1),'2100-02-28')
  assert.equal(schedule.monthlyDate('2024-12-31',31,2),'2025-02-28')
  assert.equal(schedule.nextMonthlyDate('2024-02-29',31),'2024-03-31')
})
test('stored loan timezone decides inclusive due day across midnight, DST and devices', () => {
  const d=loan()
  assert.equal(schedule.projectLiability(d,'2024-01-30T15:59:59Z').elapsed,0)
  assert.equal(schedule.projectLiability(d,'2024-01-30T16:00:00Z').elapsed,1)
  const la=loan({ schedule: { source:'original', baseDate:'2024-03-09', firstDueDate:'2024-03-10', monthlyDay:10, timeZone:'America/Los_Angeles' } })
  assert.equal(schedule.projectLiability(la,'2024-03-10T07:59:59Z').elapsed,0)
  assert.equal(schedule.projectLiability(la,'2024-03-10T08:00:00Z').elapsed,1)
  assert.equal(schedule.projectLiability(la,'2024-04-10T06:59:59Z').elapsed,1)
  assert.equal(schedule.projectLiability(la,'2024-04-10T07:00:00Z').elapsed,2)
  const old=process.env.TZ
  try {
    process.env.TZ='Pacific/Honolulu';const a=schedule.projectLiability(d,'2024-01-30T16:00:00Z')
    process.env.TZ='Pacific/Auckland';assert.deepEqual(schedule.projectLiability(d,'2024-01-30T16:00:00Z'),a)
  } finally { if(old===undefined) delete process.env.TZ; else process.env.TZ=old }
})
test('validation rejects inconsistent dates, invalid zones, unsupported debts and oversized schedules', () => {
  for(const changes of [{monthlyDay:0},{monthlyDay:32},{monthlyDay:1.5},{monthlyDay:30},{firstDueDate:'2024-02-30'},{firstDueDate:'2024-01-30'},{timeZone:'Not/AZone'},{baseDate:'0000-01-01'},{source:'unknown'}]) assert.throws(()=>debts.parseLiability(loan({schedule:{...loan().schedule,...changes}})))
  for(const changes of [{kind:'credit'},{repaymentMethod:'none'},{remainingInstallments:0},{remainingInstallments:1201},{annualRate:NaN}]) assert.throws(()=>debts.parseLiability(loan(changes)))
  assert.throws(()=>debts.parseLiability(loan({schedule:{...loan().schedule,baseDate:'9999-11-30',firstDueDate:'9999-12-31'}})),/範圍/)
})
test('zero rate, zero principal, final installment and maximum term remain nonnegative', () => {
  const d=loan({annualRate:0})
  assert.equal(schedule.projectLiability(d,at('2024-02-29')).balance,1000)
  assert.equal(schedule.projectLiability(loan({balance:0}),at('2024-02-29')).balance,0)
  assert.equal(schedule.projectLiability(loan({remainingInstallments:1}),at('2024-01-31')).balance,0)
  assert.equal(schedule.projectLiability(loan({remainingInstallments:1200}),at('2125-01-01')).remaining,0)
})
test('manual correction preserves old basis; new terms apply only from the new baseline', () => {
  const d=loan(), stamp=at('2024-02-29'), old=schedule.captureBasis(d,stamp,'合成調息與校正')
  const corrected=debts.parseLiability({...d,balance:950,annualRate:6,remainingInstallments:10,schedule:{...d.schedule,source:'correction',baseDate:'2024-02-29',firstDueDate:'2024-03-31'},basisHistory:[old]})
  assert.equal(schedule.projectLiability(corrected,stamp).balance,950)
  assert.equal(schedule.projectLiability(corrected,at('2024-02-28')).balance,null)
  assert.equal(schedule.projectLiability(corrected,at('2024-03-31')).elapsed,1)
  assert.deepEqual(corrected.basisHistory[0],old)
  assert.throws(()=>debts.parseLiability({...corrected,basisHistory:[old,old]}),/基準紀錄/)
  assert.throws(()=>debts.parseLiability({...corrected,basisHistory:[{...old,reason:''}]}),/基準紀錄/)
})
test('totals and dated snapshots use estimate but never mutate bank cash or stored baseline', () => {
  const data={...model.emptyData(),liabilities:[loan({annualRate:0})],accounts:[{id:'synthetic-cash',name:'合成帳戶',kind:'bank',country:'TW',category:'現金',positions:[{id:'cash',type:'cash',currency:'TWD',symbol:'',quantity:500,price:1}]}]}
  const before=structuredClone(data), stamp=at('2024-02-29')
  assert.deepEqual(debts.balanceSheet(data,stamp),{assets:500,liabilities:1000,net:-500,missing:[]})
  const snap=history.snapshotOf(data,stamp)
  assert.equal(snap.liabilityEstimated,true);assert.equal(snap.liabilityTotal,1000)
  assert.equal(snap.netWorth,-500);assert.equal(snap.total,500)
  assert.deepEqual(data,before)
  const foreign={...data,liabilities:[loan({currency:'USD'})]}
  assert.equal(debts.balanceSheet(foreign,stamp).liabilities,null)
  assert.equal(debts.balanceSheet(foreign,at('2025-01-31')).liabilities,0)
})
test('v4 protects schedule and audit fields; old formats still load; asynchronous saves cannot downgrade', () => {
  const base=model.emptyData(), submitted={...base,updatedAt:at('2024-01-01')}
  const next={...submitted,liabilities:[loan()]}
  const saved=history.recordSave(submitted,next)
  assert.equal(saved.version,4)
  assert.deepEqual(model.parseWealthData(JSON.parse(JSON.stringify(saved))).liabilities,saved.liabilities)
  assert.equal(model.parseWealthData({...base,version:1}).version,1)
  assert.equal(model.parseWealthData(base).version,2)
  assert.equal(model.parseWealthData({...base,version:3}).version,3)
  assert.throws(()=>model.parseWealthData({...base,version:11}),/不支援的版本/)
  const current={...base,version:4,liabilities:[loan()]}
  const merged=saveState.finishSave(current,submitted,{...submitted,version:2})
  assert.equal(merged.version,4);assert.deepEqual(merged.liabilities,current.liabilities)
  const removed=history.recordSave(saved,{...saved,liabilities:[]})
  assert.equal(removed.version,4)
})

const quantityDay = (date='2024-02-29') => ({ date, updatedAt:at(date), entries:[{accountId:'cash',account:'合成現金',category:'現金',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:500}] })
test('existing v3 quantities migrate to v4 with schedules and round-trip without any loss', () => {
  const day=quantityDay(), old={...model.emptyData(),version:3,updatedAt:at('2024-02-29')}
  old.history.quantityDays=[day]
  old.history.snapshots=[{date:'2023-12-01',at:at('2023-12-01'),total:600,accounts:[],categories:{}}]
  const loaded=model.parseWealthData(structuredClone(old))
  const next={...loaded,updatedAt:at('2024-03-31'),liabilities:[loan({annualRate:0})]}
  const saved=history.recordSave(loaded,next), roundtrip=model.parseWealthData(JSON.parse(JSON.stringify(saved)))
  assert.equal(roundtrip.version,4)
  assert.deepEqual(roundtrip.history.quantityDays,[day])
  assert.deepEqual(roundtrip.history.snapshots[0],old.history.snapshots[0])
  assert.deepEqual(roundtrip.liabilities,next.liabilities)
  assert.equal(roundtrip.history.snapshots[0].liabilityTotal,undefined)
  assert.equal(roundtrip.history.snapshots.at(-1).liabilityEstimated,true)
  const edited=quantity.applyQuantityDay(roundtrip,{...day,entries:[{...day.entries[0],quantity:400}]},roundtrip.history.quantityDays[0])
  assert.equal(edited.version,4)
  assert.deepEqual(edited.liabilities,roundtrip.liabilities)
  assert.equal(model.parseWealthData(JSON.parse(JSON.stringify(history.recordSave(roundtrip,edited)))).history.quantityDays[0].entries[0].quantity,400)
})
test('v4 audit and quantity history survive recalibration, disabling and deletion without downgrade', () => {
  const d=loan(), basis=schedule.captureBasis(d,at('2024-02-29'),'合成校正')
  const data={...model.emptyData(),version:4,liabilities:[{...d,balance:900,basisHistory:[basis],schedule:{...d.schedule,source:'correction',baseDate:'2024-02-29',firstDueDate:'2024-03-31'}}]}
  data.history.quantityDays=[quantityDay()]
  const parsed=model.parseWealthData(JSON.parse(JSON.stringify(data)))
  assert.deepEqual(parsed.liabilities,data.liabilities)
  assert.deepEqual(parsed.history.quantityDays,data.history.quantityDays)
  const removed=history.recordSave(parsed,{...parsed,liabilities:[]})
  assert.equal(removed.version,4)
  assert.deepEqual(removed.history.quantityDays,data.history.quantityDays)
  assert.deepEqual(removed.history.liabilityChanges.at(-1).before.basisHistory,[basis])
})
test('quantity valuation preserves estimates and defaults absent debt to zero', () => {
  const day=quantityDay(), data={...model.emptyData(),version:4,liabilities:[loan({annualRate:0})]}
  const snap=history.snapshotOf(data,at(day.date))
  const point=quantity.quantityPoint(day,snap)
  assert.equal(point.total,500);assert.equal(point.liabilityTotal,1000);assert.equal(point.netWorth,-500);assert.equal(point.liabilityEstimated,true)
  assert.equal(quantity.quantityPoint(day).liabilityTotal,0)
  assert.equal(quantity.quantityPoint(day).netWorth,500)
  assert.equal(quantity.quantityPoint(day,{...snap,liabilityTotal:null,netWorth:null}).netWorth,null)
  const incomplete=quantity.quantityPoint({...day,entries:[{...day.entries[0],quantity:null}]},snap)
  assert.equal(incomplete.netWorth,null);assert.equal(incomplete.liabilityEstimated,true)
  data.history.quantityDays=[day];data.history.snapshots=[snap]
  assert.deepEqual(history.totalPoints(data,at('2024-03-01'))[0],point)
})
test('manual quantity today uses current estimate consistently, while past absent debt defaults to zero', () => {
  const day=quantityDay(), data={...model.emptyData(),version:4,liabilities:[loan({annualRate:0})]}
  data.history.quantityDays=[day]
  const now=at(day.date), current=history.snapshotOf(data,now), point=history.totalPoints(data,now)[0]
  assert.equal(point.liabilityTotal,current.liabilityTotal)
  assert.equal(point.liabilityEstimated,true);assert.equal(point.netWorth,500-current.liabilityTotal)
  assert.equal(history.totalPoints(data,at('2024-03-01'))[0].liabilityTotal,0)
})
test('in-flight v3 save merges later schedule and quantity edits without dropping either or downgrading v4', () => {
  const day=quantityDay(), submitted={...model.emptyData(),version:3}
  submitted.history.quantityDays=[day]
  const edited=quantity.applyQuantityDay(submitted,{...day,entries:[{...day.entries[0],quantity:400}]},day)
  const current={...edited,version:4,liabilities:[loan()]}
  const persisted=history.recordSave(null,submitted)
  const finished=saveState.finishSave(current,submitted,persisted)
  assert.equal(finished.version,4);assert.deepEqual(finished.liabilities,current.liabilities)
  assert.deepEqual(finished.history.quantityDays,edited.history.quantityDays)
  const later=history.recordSave(persisted,finished)
  assert.deepEqual(model.parseWealthData(JSON.parse(JSON.stringify(later))).history.quantityDays,edited.history.quantityDays)
  assert.equal(saveState.finishSave({...submitted},submitted,{...persisted,version:4}).version,4)
})
