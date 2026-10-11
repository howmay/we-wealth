import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {createServer} from 'vite'
let server,c,q,p,m,b,h,t,s
before(async()=>{
 server=await createServer({configFile:false,envDir:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false}})
 ;[c,q,p,m,b,h,t,s]=await Promise.all(['historyCompletion','quantityHistory','holdingPeriods','model','historyBaseline','history','priceHistory','saveState'].map(n=>server.ssrLoadModule(`/src/${n}.ts`)))
})
after(()=>server.close())
const now='2026-10-09T12:00:00Z',date='2026-09-01'
const fixture=()=>({...m.emptyData(),accounts:['A','B','C','D'].map((id,i)=>({id,name:`合成 ${id}`,kind:'investment',country:'TW',category:'其他',positions:[{id,type:'cash',symbol:'',currency:'TWD',quantity:(i+1)*10,price:1}]}))})
const entries=d=>b.quantityBaselines(d,now)[0].entries
const complete=(d,date)=>({date,updatedAt:now,inventory:{accounts:d.accounts.map(a=>({id:a.id,name:a.name})),source:{kind:'current',date:'2026-10-09'}},entries:entries(d)})
const save=(d,day)=>c.applyCompletion(d,day,c.completionRevision(d),true)
test('nearest uses calendar distance, earlier tie, saved-day tie, future sources; rejects sparse/self',()=>{
 const d=fixture();d.history.quantityDays=[complete(d,'2026-08-30'),complete(d,'2026-09-03'),{date,updatedAt:now,sparse:true,entries:entries(d)}]
 assert.equal(c.nearestBaseline(d,date,now).date,'2026-08-30')
 d.history.quantityDays.shift();assert.equal(c.nearestBaseline(d,date,now).date,'2026-09-03')
 d.history.quantityDays=[complete(d,'2026-10-09')];assert.equal(c.nearestBaseline(d,date,now).kind,'day')
 assert.equal(c.nearestBaseline(d,'2026-10-09',now).kind,'current')
 delete d.history.quantityDays[0].inventory;assert.equal(c.nearestBaseline(d,date,now).kind,'current')
})
test('ordinary edit preserves explicit zero/null and fills only missing destination items',()=>{
 const d=fixture(),[a,bEntry,cEntry]=entries(d)
 d.history.quantityDays=[{date,updatedAt:now,sparse:true,entries:[a,{...bEntry,quantity:0},{...cEntry,quantity:null}]}]
 const raw=structuredClone(d.history.quantityDays[0]),result=c.prepareCompletion(d,date,{...a,quantity:77},[],now)
 assert.deepEqual(result.day.entries.map(e=>e.quantity),[77,0,null]);assert.deepEqual(result.day.completion.entries.map(e=>e.quantity),[40])
 assert.equal(result.filled.length,1);assert.deepEqual(d.history.quantityDays[0],raw)
 assert.throws(()=>c.applyCompletion(d,result.day,c.completionRevision(d),false),/確認/)
 const next=save(d,result.day),view=p.expandPeriodDays(next,now).find(x=>x.date===date)
 assert.equal(q.quantityPoint(view).total,null);assert.equal(next.version,9)
})
test('period evidence wins over source but supplements never create future quantity events',()=>{
 const d=fixture(),[a,bEntry]=entries(d)
 d.history.holdingPeriods=[{...bEntry,id:'p',start:'2026-08-30',quantity:7,updatedAt:now,timeZone:'UTC'}]
 const result=c.prepareCompletion(d,date,{...a,quantity:99},[],now),next=save(d,result.day)
 assert.equal(c.resolveCompletion(next,result.day).entries.find(e=>e.accountId==='B').quantity,7)
 assert.equal(p.periodQuantityOn(next,bEntry,'2026-09-02').quantity,7)
 assert.equal(result.filled.includes(q.instrumentKey(bEntry)),false)
 // A raw null is an actual event and remains so after adding supplements.
 d.history.quantityDays=[{date,updatedAt:now,sparse:true,entries:[{...bEntry,quantity:null}]}]
 const withNull=save(d,c.prepareCompletion(d,date,{...a,quantity:99},[],now).day)
 assert.equal(p.periodQuantityOn(withNull,bEntry,'2026-09-02').quantity,null)
})
test('raw existing events keep their downstream behavior and supplement absent zeros do not carry',()=>{
 const d=fixture(),[a,bEntry]=entries(d)
 d.history.holdingPeriods=[{...a,id:'p',start:'2026-08-30',quantity:1,updatedAt:now,timeZone:'UTC'}]
 d.history.quantityDays=[{date,updatedAt:now,sparse:true,entries:[{...a,quantity:5}]}]
 const next=save(d,c.prepareCompletion(d,date,{...bEntry,quantity:6},[],now).day)
 assert.equal(p.periodQuantityOn(next,a,'2026-09-02').quantity,5)
 const account=next.accounts[2],pos=account.positions[0]
 const timeline=t.positionTimeline(next,account,pos,null,null,now)
 assert.equal(timeline.days.find(x=>x.date===date).quantity,30)
 assert.equal(q.quantityPoint(p.expandPeriodDays(next,now).find(x=>x.date===date)).total,81)
})
test('confirm zero fills, fixed coverage, old v8 scope and removal leave original snapshots intact',()=>{
 const d=fixture(),a=entries(d)[0],key=q.instrumentKey(entries(d)[1])
 const result=c.prepareCompletion(d,date,{...a,quantity:5},[key],now),next=save(d,result.day)
 assert.equal(result.day.completion.entries[0].quantity,0)
 next.accounts.push({id:'later',name:'later',kind:'investment',country:'TW',category:'其他',positions:[{id:'later',type:'cash',symbol:'',currency:'TWD',quantity:999,price:1}]})
 const edited=c.prepareCompletion(next,date,{...a,quantity:6},[],now).day
 assert.equal(edited.completion.entries.length,3);assert.equal(p.expandPeriodDays(next,now).find(x=>x.date===date).entries.length,4)
 const old={...fixture(),history:{...d.history,quantityDays:[complete(d,date)]}},before=structuredClone(old.history.quantityDays[0].inventory)
 const day=c.prepareCompletion(old,date,{...a,quantity:2},[],now).day
 assert.equal(day.completion,undefined);assert.deepEqual(day.inventory,before);assert.equal(save(old,day).version,8)
 next.history.snapshots=[{date,at:now,total:123,accounts:[],categories:{}}]
 assert.match(c.removalMessage(next,date),/恢復原始快照/);assert.equal(next.history.snapshots.length,1)
 assert.match(c.removalMessage(fixture(),h.localDate(new Date().toISOString())),/恢復目前持倉/)
 assert.match(c.removalMessage(fixture(),date),/會從每日列表消失/)
})
test('v9 survives parsing, recordSave and asynchronous saves; malformed supplements reject',()=>{
 const d=fixture(),day=c.prepareCompletion(d,date,{...entries(d)[0],quantity:5},[],now).day,next=save(d,day)
 const reloaded=m.parseWealthData(JSON.parse(JSON.stringify(h.recordSave(d,next))))
 assert.equal(reloaded.version,9);assert.deepEqual(reloaded.history.quantityDays[0].completion,day.completion)
 assert.equal(s.finishSave({...next},d,reloaded).version,9)
 for(const change of [x=>x.completion.source.date='bad',x=>x.completion.accounts=[],x=>x.completion.entries.push(x.entries[0]),x=>x.inventory=complete(d,date).inventory]) {
  const bad=structuredClone(day);change(bad);assert.throws(()=>q.parseQuantityDays([bad]),/當日補齊|完整持倉/)
 }
})
test('source/destination race rejects and destination market provenance never copies source quotes',async()=>{
 const d=fixture();d.history.quantityDays=[complete(d,'2026-08-31')]
 d.history.quantityDays[0].entries[1]={...entries(d)[1],type:'holding',symbol:'TEST',currency:'USD',price:{source:'Yahoo',symbol:'TEST',date:'2026-08-31',value:999},fx:{source:'Yahoo',symbol:'USDTWD=X',date:'2026-08-31',value:99}}
 const result=c.prepareCompletion(d,date,{...entries(d)[0],quantity:5},[],now),revision=c.completionRevision(d)
 const stock=result.day.completion.entries.find(e=>e.symbol==='TEST');assert.equal(stock.price,undefined);assert.equal(stock.fx,undefined)
 const requests=[],valued=await q.valueEntries(c.resolveCompletion(d,result.day).entries,date,async(symbol,from)=>{requests.push(from);return {symbol,currency:symbol==='USDTWD=X'?'TWD':'USD',asTraded:true,points:[{date,close:2}]}})
 assert.ok(requests.every(x=>x===date));assert.equal(valued.find(e=>e.symbol==='TEST').price.value,2)
 for(const mutate of [x=>x.accounts[0].positions[0].quantity++,x=>x.history.quantityDays[0].entries[0].quantity++,x=>x.history.snapshots.push({date})]) {
  const newer=structuredClone(d);mutate(newer);assert.throws(()=>c.applyCompletion(newer,result.day,revision,true),/已變更/)
 }
})
test('no trustworthy source keeps sparse single-item mode; snapshot omitted coverage stays unknown',()=>{
 const d=fixture(),a=entries(d)[0];d.accounts[1].positions[0].quantity=NaN
 assert.equal(c.nearestBaseline(d,date,now),undefined)
 assert.equal(c.prepareCompletion(d,date,a,[],now).day.completion,undefined)
 const good=fixture(),day=c.prepareCompletion(good,date,a,[],now).day
 assert.equal(q.quantityPoint(c.resolveCompletion(good,day),{accounts:[{id:'omitted',value:9}]}).total,null)
})
test('confirmed v9 quantity scope becomes a nearest source only when counts and coverage are provable',()=>{
 const d=fixture(),day=c.prepareCompletion(d,'2026-08-31',{...entries(d)[0],quantity:5},[],now).day,next=save(d,day)
 assert.equal(c.nearestBaseline(next,date,now).id,'day:2026-08-31')
 next.history.quantityDays[0].entries[0].quantity=null
 assert.equal(c.nearestBaseline(next,date,now).kind,'current')
})
test('confirmed supplements including zero/null stay explicit when later periods or sources change',()=>{
 const d=fixture(),[a,bEntry]=entries(d),key=q.instrumentKey(bEntry)
 let next=save(d,c.prepareCompletion(d,date,{...a,quantity:3},[key],now).day)
 next.history.holdingPeriods=[{...bEntry,id:'new-period',start:'2026-08-30',quantity:999,updatedAt:now,timeZone:'UTC'}]
 next.accounts[1].positions[0].quantity=777
 assert.equal(c.resolveCompletion(next,next.history.quantityDays[0]).entries.find(e=>e.accountId==='B').quantity,0)
 const edited=c.prepareCompletion(next,date,{...a,quantity:4},[],now).day
 assert.equal(edited.completion.entries.find(e=>e.accountId==='B').quantity,0)
 next.history.quantityDays[0].completion.entries[0].quantity=null
 assert.equal(c.prepareCompletion(next,date,{...a,quantity:4},[],now).day.completion.entries[0].quantity,null)
})
test('destination period split basis is queried then frozen as absolute quantity, never carried as a new event',async()=>{
 const d=fixture(),a=entries(d)[0]
 d.accounts[1].positions[0]={id:'b',type:'holding',symbol:'TEST',currency:'USD',quantity:9,price:1}
 const stock=entries(d)[1]
 d.history.holdingPeriods=[{...stock,id:'period',start:'2026-08-29',quantity:2,updatedAt:now,timeZone:'UTC'}]
 const prepared=c.prepareCompletion(d,date,{...a,quantity:4},[],now)
 assert.equal(prepared.day.completion.entries.find(e=>e.symbol==='TEST').quantity,null)
 const requests=[]
 const valued=await q.valueEntries(prepared.projectedEntries,date,async(symbol,from)=>{requests.push(from);return {symbol,currency:symbol==='TEST'?'USD':'TWD',asTraded:true,splits:symbol==='TEST'?[{date:'2026-08-31',ratio:2}]:[],points:[{date,close:10}]}})
 const e=valued.find(e=>e.symbol==='TEST');assert.equal(e.quantity,4);assert.ok(requests.every(x=>x==='2026-08-29'))
 const day={...prepared.day,completion:{...prepared.day.completion,entries:prepared.day.completion.entries.map(old=>b.quantityOnly(valued.find(e=>q.instrumentKey(e)===q.instrumentKey(old))))}}
 const next=save(d,day)
 assert.equal(c.resolveCompletion(next,next.history.quantityDays[0]).entries.find(e=>e.symbol==='TEST').quantity,4)
 assert.equal(p.periodQuantityOn(next,stock,'2026-09-02').quantity,2)
 assert.equal(next.history.quantityDays[0].completion.entries.find(e=>e.symbol==='TEST').quantityAsOf,undefined)
})
