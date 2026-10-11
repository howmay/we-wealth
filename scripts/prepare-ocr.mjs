import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const {version}=JSON.parse(await readFile(`${root}node_modules/tesseract.js/package.json`,'utf8'))
const destination=`${root}public/ocr/${version}`
await mkdir(`${destination}/core`,{recursive:true})
await mkdir(`${destination}/lang`,{recursive:true})
await copyFile(`${root}node_modules/tesseract.js/dist/worker.min.js`,`${destination}/worker.min.js`)
for(const variant of ['lstm','simd-lstm','relaxedsimd-lstm']) {
  for(const extension of ['wasm','wasm.js']) {
    const name=`tesseract-core-${variant}.${extension}`
    await copyFile(`${root}node_modules/tesseract.js-core/${name}`,`${destination}/core/${name}`)
  }
}
for(const language of ['eng','chi_tra']) {
  await copyFile(`${root}node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,`${destination}/lang/${language}.traineddata.gz`)
}
const notices=`${destination}/licenses`
await mkdir(notices,{recursive:true})
for(const name of ['tesseract.js','tesseract.js-core']) {
  await copyFile(`${root}node_modules/${name}/${name === 'tesseract.js' ? 'LICENSE.md' : 'LICENSE'}`,`${notices}/${name}-LICENSE`)
}
await writeFile(`${notices}/NOTICE.txt`,'Tesseract.js and Tesseract.js-core: Apache-2.0. Language packages @tesseract.js-data/eng and chi_tra 1.0.0 declare MIT; trained models are from https://github.com/naptha/tessdata and https://github.com/tesseract-ocr/tessdata_best (Apache-2.0). All assets are bundled locally; no document is sent to those projects.\n')
console.log(`Prepared local OCR assets (${version})`)
