const assets = '/ocr/7.0.0'

export async function createStatementOcr(signal:AbortSignal) {
  // Use the pinned worker protocol to also terminate during language-model initialization.
  const worker = new Worker(`${assets}/worker.min.js`)
  let serial = 0
  let pending: {id:string;resolve:(data:{text:string;confidence:number;tsv?:string})=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>} | undefined
  const close = () => {
    worker.terminate()
    if(pending) {clearTimeout(pending.timer);pending.reject(new Error('已取消解析'));pending=undefined}
    signal.removeEventListener('abort',close)
  }
  signal.addEventListener('abort',close,{once:true})
  worker.onmessage = ({data}) => {
    if(!pending || data.jobId !== pending.id || data.status === 'progress') return
    clearTimeout(pending.timer)
    const current=pending;pending=undefined
    if(data.status === 'resolve') current.resolve(data.data)
    else current.reject(new Error('OCR 無法辨識，請核對帳單或手動補上商家'))
  }
  worker.onerror = () => {
    if(pending) {clearTimeout(pending.timer);pending.reject(new Error('OCR 載入失敗，請重新解析或手動補上商家'));pending=undefined}
  }
  const run = (action:string,payload:unknown) => new Promise<{text:string;confidence:number;tsv?:string}>((resolve,reject)=>{
    if(signal.aborted) {close();reject(new Error('已取消解析'));return}
    const id=String(serial++)
    const timer=setTimeout(()=>{reject(new Error('OCR 等待逾時，請重試或手動補上商家'));close()},120_000)
    pending={id,resolve,reject,timer}
    worker.postMessage({workerId:'statement-ocr',jobId:id,action,payload})
  })
  try {
    await run('load',{options:{lstmOnly:true,corePath:`${assets}/core`,logging:false}})
    await run('loadLanguage',{langs:'chi_tra+eng',options:{langPath:`${assets}/lang`,gzip:true,lstmOnly:true,cacheMethod:'none'}})
    await run('initialize',{langs:'chi_tra+eng',oem:1,config:{}})
    await run('setParameters',{params:{tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'}})
    return {close,recognize:async(image:Uint8Array,layout=false)=>{
      await run('setParameters',{params:{tessedit_pageseg_mode:layout?'3':'7'}})
      return run('recognize',{image,options:{},output:{text:true,tsv:layout}})
    }}
  } catch(e) {close();throw e}
}
