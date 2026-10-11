import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {createServer} from 'vite'
let server,createStatementOcr
const originalWorker=globalThis.Worker
before(async()=>{
  server=await createServer({configFile:false,envDir:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false}})
  ;({createStatementOcr}=await server.ssrLoadModule('/src/statementOcr.ts'))
})
after(async()=>{globalThis.Worker=originalWorker;await server.close()})
function fakeWorker(handler) {
  const calls=[],instances=[]
  globalThis.Worker=class {
    constructor(url){this.url=url;this.terminated=0;instances.push(this)}
    postMessage(message){calls.push(message);queueMicrotask(()=>handler(this,message))}
    terminate(){this.terminated++}
  }
  return {calls,instances}
}
const success=(worker,message)=>worker.onmessage({data:{jobId:message.jobId,status:'resolve',data:message.action==='recognize'?{text:'SYNTHETIC SHOP',confidence:95}:{}}})
test('OCR worker uses only local assets and returns text without storing images',async()=>{
  const {calls,instances}=fakeWorker(success)
  const ocr=await createStatementOcr(new AbortController().signal)
  assert.equal(instances[0].url,'/ocr/7.0.0/worker.min.js')
  assert.equal(calls[0].payload.options.corePath,'/ocr/7.0.0/core')
  assert.equal(calls[1].payload.options.langPath,'/ocr/7.0.0/lang')
  assert.equal(calls[1].payload.options.cacheMethod,'none')
  assert.deepEqual(await ocr.recognize(new Uint8Array([1,2,3])),{text:'SYNTHETIC SHOP',confidence:95})
  ocr.close();assert.ok(instances[0].terminated)
})
test('cancel during model loading terminates immediately and never sends an image',async()=>{
  const controller=new AbortController()
  const {calls,instances}=fakeWorker((worker,message)=>{if(message.action==='loadLanguage')controller.abort();else success(worker,message)})
  await assert.rejects(createStatementOcr(controller.signal),/已取消/)
  assert.ok(instances[0].terminated)
  assert.ok(calls.every(m=>m.action!=='recognize'))
})
test('cancel during recognition rejects pending work instead of leaving the parser hanging',async()=>{
  const controller=new AbortController()
  const {instances}=fakeWorker((worker,message)=>{if(message.action==='recognize')controller.abort();else success(worker,message)})
  const ocr=await createStatementOcr(controller.signal)
  await assert.rejects(ocr.recognize(new Uint8Array([1])),/已取消/)
  assert.ok(instances[0].terminated)
})
test('initialization failures are sanitized and worker is terminated',async()=>{
  const {instances}=fakeWorker((worker,message)=>worker.onmessage({data:{jobId:message.jobId,status:'reject',data:'private statement text should not leak'}}))
  await assert.rejects(createStatementOcr(new AbortController().signal),e=>/OCR/.test(e.message)&&!e.message.includes('private'))
  assert.ok(instances[0].terminated)
})


test('page layout recognition requests TSV and restores single-line mode for merchant crops',async()=>{
  const {calls}=fakeWorker(success)
  const ocr=await createStatementOcr(new AbortController().signal)
  await ocr.recognize(new Uint8Array([1]),true)
  assert.equal(calls.at(-2).payload.params.tessedit_pageseg_mode,'3')
  assert.equal(calls.at(-1).payload.output.tsv,true)
  await ocr.recognize(new Uint8Array([2]))
  assert.equal(calls.at(-2).payload.params.tessedit_pageseg_mode,'7')
  assert.equal(calls.at(-1).payload.output.tsv,false)
  ocr.close()
})
