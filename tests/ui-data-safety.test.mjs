import assert from 'node:assert/strict'
import { after, before, beforeEach, afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { act, createElement, useState, useEffect } from 'react'

let server, root, dom, App, Accounts, Liabilities, Overview, HistoryView, SaveReview, model, auth, createRoot
const originalFetch = globalThis.fetch
const token = { value: 'test-token', expiresAt: Date.now() + 3600_000 }
const profile = { sub: 'account-a', email: 'a@example.com', name: 'Alice' }
before(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://wealthline.test/rates' })
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'PopStateEvent', 'localStorage', 'sessionStorage']) globalThis[key] = dom.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  window.scrollTo = () => {}
  globalThis.requestAnimationFrame = callback => setTimeout(callback,0)
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({ configFile: false, envDir: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false } })
  App = (await server.ssrLoadModule('/src/App.tsx')).default
  ;({ Accounts } = await server.ssrLoadModule('/src/views/Accounts.tsx'))
  ;({ Liabilities } = await server.ssrLoadModule('/src/views/Liabilities.tsx'))
  ;({ Overview } = await server.ssrLoadModule('/src/views/Overview.tsx'))
  ;({ HistoryView } = await server.ssrLoadModule('/src/views/History.tsx'))
  ;({ SaveReview } = await server.ssrLoadModule('/src/views/SaveReview.tsx'))
  model = await server.ssrLoadModule('/src/model.ts')
  auth = await server.ssrLoadModule('/src/google/auth.ts')
})
beforeEach(()=>{globalThis.confirm=()=>true})
afterEach(async () => {
  const {clearHistoryCache}=await server.ssrLoadModule('/src/priceHistory.ts');clearHistoryCache()
  if (root) await act(() => root.unmount())
  root = null
  globalThis.fetch = originalFetch
  localStorage.clear()
  sessionStorage.clear()
  delete globalThis.confirm
  window.history.replaceState(null, '', '/rates')
})
after(async () => { await server.close(); dom.window.close() })
const render = async (component, props = {}) => {
  if (!root) root = createRoot(document.getElementById('root'))
  await act(async () => { root.render(createElement(component, props)) })
}
const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)
const click = async (element) => { assert.ok(element); await act(async () => element.click()) }
const historyItem = (date, account = '') => [...document.querySelectorAll('[data-history-entry]')].find(b => b.dataset.historyEntry.startsWith(`item:${date}:`) && b.getAttribute('aria-label')?.includes(account))
const confirmCompletion = async () => {
 const label=[...document.querySelectorAll('.quantity-editor label')].find(e=>e.textContent.includes('確認當日補齊範圍'))
 const checkbox=label?.querySelector('input[type="checkbox"]')
 if(checkbox && !checkbox.checked) await click(checkbox)
}
const setInput = async (input, value) => {
  await act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const editRate = async (currency, value) => {
  const input = document.querySelector(`[aria-label="${currency} 匯率"]`)
  assert.ok(input)
  await act(async () => input.focus())
  await setInput(input, value)
  await act(async () => input.blur())
}
const fixture = () => ({ ...model.emptyData(), fxRates: { USD: 32, SGD: 24 }, fxUpdatedAt: new Date().toISOString() })
const setupDrive = (data) => {
  let resolveWrite, writes = 0, uploaded, uploadedEtag
  globalThis.fetch = async (url, init = {}) => {
    if (url.includes('userinfo')) return Response.json(profile)
    if (init.method === 'PUT') {
      writes++
      uploaded = JSON.parse(init.body)
      uploadedEtag = init.headers['If-Match']
      return new Promise((resolve) => { resolveWrite = resolve })
    }
    if (new URL(url).searchParams.has('q')) return Response.json({ files: [{ id: 'f' }] })
    if (new URL(url).searchParams.has('alt')) return Response.json(data)
    return Response.json({ id: 'f', etag: '"v1"', headRevisionId: 'r1' })
  }
  auth.storeSession({ token, profile })
  return {
    finish: async (status = 200) => act(async () => resolveWrite(status === 200 ? Response.json({ id: 'f', etag: '"v2"' }) : new Response('', { status }))),
    get writes() { return writes },
    get uploaded() { return uploaded },
    get uploadedEtag() { return uploadedEtag },
  }
}

test('editing another rate during a deferred save preserves it and remains dirty', async () => {
  const drive = setupDrive(fixture())
  await render(App)
  await editRate('USD', '33')
  const saveButton = button('儲存變更')
  await act(async () => { saveButton.click(); saveButton.click() })
  assert.equal(drive.writes, 1)
  assert.equal(drive.uploadedEtag, '"v1"')
  assert.equal(drive.uploaded.fxRates.USD, 33)
  await editRate('SGD', '25')
  await drive.finish()
  assert.equal(document.querySelector('[aria-label="SGD 匯率"]').value, '25')
  assert.ok(button('儲存變更'))
  await click(button('儲存變更'))
  assert.equal(drive.uploaded.fxRates.SGD, 25)
  assert.equal(drive.uploadedEtag, '"v2"')
  await drive.finish()
  assert.ok(document.querySelector('.synced'))
})

test('Drive conflict leaves unsaved rate and backup action available', async () => {
  const drive = setupDrive(fixture())
  await render(App)
  await editRate('USD', '34')
  await click(button('儲存變更'))
  await drive.finish(412)
  assert.equal(document.querySelector('[aria-label="USD 匯率"]').value, '34')
  assert.ok(button('儲存變更'))
  assert.match(document.querySelector('[role="alert"]').textContent, /其他裝置/)
  assert.ok(button('下載本機資料備份'))
})

test('daily snapshot and manual saves are serialized; edits during snapshot remain dirty', async () => {
  const data = fixture()
  data.accounts = [{ id: 'a', name: 'Bank', kind: 'bank', country: 'US', category: '現金', positions: [
    { id: 'p', type: 'cash', currency: 'USD', symbol: '', quantity: 10, price: 1 },
  ] }]
  const drive = setupDrive(data)
  await render(App)
  assert.equal(drive.writes, 1)
  await editRate('USD', '35')
  assert.equal(button('儲存中…').disabled, true)
  await click(button('儲存中…'))
  assert.equal(drive.writes, 1)
  await drive.finish()
  assert.equal(document.querySelector('[aria-label="USD 匯率"]').value, '35')
  assert.ok(button('儲存變更'))
})

test('review Escape and cancel work before save but cannot dismiss an in-flight save', async () => {
  let cancelled = 0, confirmed = 0
  const props = { changes: [], busy: false, canRevert: () => false, onRevert: () => {}, onConfirm: () => confirmed++, onCancel: () => cancelled++ }
  await render(SaveReview, props)
  await act(async () => document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })))
  assert.equal(cancelled, 1)
  await click(button('繼續編輯'))
  assert.equal(cancelled, 2)
  await click(button('確認儲存'))
  assert.equal(confirmed, 1)
  await render(SaveReview, { ...props, busy: true })
  const escape = new Event('cancel', { cancelable: true })
  await act(async () => document.querySelector('dialog').dispatchEvent(escape))
  assert.equal(escape.defaultPrevented, true)
  await click(button('繼續編輯'))
  await click(button('儲存中…'))
  assert.equal(cancelled, 2)
  assert.equal(confirmed, 1)
})

test('import preview shows deletions, blocks errors/stale preview, and only applies after confirmation', async () => {
  const data = fixture()
  data.accounts = [{ id: 'a', name: 'Broker', kind: 'investment', country: 'US', category: '股票', positions: [
    { id: 'p', type: 'holding', currency: 'USD', symbol: 'AAPL', quantity: 10, price: 100 },
  ] }]
  let changed, closed = 0
  const props = { data, onChange: (next) => { changed = next }, view: { page: 'list', importing: true }, setView: () => closed++, onBack: () => {}, onRefreshPrices: async () => {}, priceError: '' }
  await render(Accounts, props)
  await setInput(document.querySelector('textarea'), 'Broker\t現金\t\tUSDC\t20\t1\t\t32\nBroker\t現金\t\tNOPE\t10')
  await click(button('預覽匯入'))
  assert.equal(changed, undefined)
  assert.match(document.querySelector('[role="alert"]').textContent, /第 2 列/)
  assert.equal(button('確認匯入並取代上述資料').disabled, true)
  await setInput(document.querySelector('textarea'), 'Broker\t現金\t\tUSDC\t20\t1\t\t32')
  await click(button('預覽匯入'))
  assert.match(document.body.textContent, /刪除以下 1 筆原持倉/)
  assert.match(document.body.textContent, /AAPL · USD · 數量 10/)
  assert.equal(changed, undefined)
  await render(Accounts, { ...props, data: { ...data } })
  assert.equal(button('確認匯入並取代上述資料').disabled, true)
  await click(button('預覽匯入'))
  await click(button('確認匯入並取代上述資料'))
  assert.equal(changed.accounts[0].positions[0].currency, 'USDC')
  assert.equal(closed, 1)
})

test('cancelling import preview never changes the source data', async () => {
  let changes = 0, closed = 0
  await render(Accounts, { data: fixture(), onChange: () => changes++, view: { page: 'list', importing: true }, setView: () => closed++, onBack: () => {}, onRefreshPrices: async () => {}, priceError: '' })
  await setInput(document.querySelector('textarea'), 'Bank\t現金\t\tUSD\t20')
  await click(button('預覽匯入'))
  await click(button('取消'))
  assert.equal(changes, 0)
  assert.equal(closed, 1)
})

// All liability examples below are synthetic, not transcribed from financial documents.
const syntheticDebt = { id: 'synthetic-debt', name: '合成貸款', kind: 'personal', currency: 'TWD', balance: 800 }
const field = (label) => [...document.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent === label)?.querySelector('input,select,textarea') ?? [...document.querySelectorAll('input[aria-label]')].find(i => i.getAttribute('aria-label') === label)

test('liability create/edit/cancel/delete are local and payment details do not replace balance', async () => {
  let current
  function Harness() {
    const [data, setData] = useState(fixture)
    useEffect(() => { current = data }, [data])
    return createElement(Liabilities, { data, onChange: setData })
  }
  await render(Harness)
  await click(button('＋ 新增負債'))
  await selectValue('計算基準', 'manual')
  await setInput(field('負債名稱'), '不應保留的合成草稿')
  await click(button('取消'))
  assert.equal(current.liabilities.length, 0)
  await click(button('＋ 新增負債'))
  await selectValue('計算基準', 'manual')
  await setInput(field('負債名稱'), '合成貸款')
  await setInput(field('目前未償餘額'), '800')
  await setInput(field('年利率（%）'), '0')
  await setInput(field('剩餘期數（月）'), '24')
  await setInput(field('下次到期日（選填）'), '2028-02-29')
  await setInput(field('備註（選填）'), '純合成備註')
  await click(button('套用負債'))
  assert.equal(current.liabilities.length, 1)
  assert.equal(current.liabilities[0].balance, 800)
  assert.equal(current.liabilities[0].remainingInstallments, 24)
  assert.equal(current.liabilities[0].repaymentMethod, 'annuity')
  assert.equal(current.liabilities[0].annualRate, 0)
  const id = current.liabilities[0].id
  await click(document.querySelector('[aria-label="編輯負債 合成貸款"]'))
  await setInput(field('目前未償餘額'), '1')
  await click(button('取消'))
  assert.equal(current.liabilities[0].balance, 800)
  await click(document.querySelector('[aria-label="編輯負債 合成貸款"]'))
  await setInput(field('目前未償餘額'), '700')
  await setInput(field('幣別'), 'USD')
  await click(button('套用負債'))
  assert.equal(current.liabilities[0].id, id)
  assert.equal(current.liabilities[0].balance, 700)
  assert.equal(current.liabilities[0].currency, 'USD')
  assert.equal(current.liabilities[0].paymentAmount, undefined)
  globalThis.confirm = () => false
  await click(document.querySelector('[aria-label="刪除負債 合成貸款"]'))
  assert.equal(current.liabilities.length, 1)
  globalThis.confirm = () => true
  await click(document.querySelector('[aria-label="刪除負債 合成貸款"]'))
  assert.deepEqual(current.liabilities, [])
})

test('invalid liability form stays open without applying partial data', async () => {
  let changes = 0
  await render(Liabilities, { data: fixture(), onChange: () => changes++ })
  await click(button('＋ 新增負債'))
  await selectValue('計算基準', 'manual')
  await setInput(field('負債名稱'), '合成貸款')
  await setInput(field('年利率（%）'), '2')
  await setInput(field('剩餘期數（月）'), '12')
  await setInput(field('目前未償餘額'), '-10')
  await click(button('套用負債'))
  assert.match(document.querySelector('[role="alert"]').textContent, /不得小於/)
  assert.equal(changes, 0)
  await setInput(field('目前未償餘額'), '0')
  await setInput(field('剩餘期數（月）'), '3.5')
  await click(button('套用負債'))
  assert.match(document.querySelector('[role="alert"]').textContent, /整數/)
  assert.equal(changes, 0)
})

test('overview displays negative net worth for debt-only data and hides totals with missing rates', async () => {
  const data = { ...fixture(), liabilities: [syntheticDebt] }
  const props = { data, onGoRates: () => {}, onGoLiabilities: () => {}, onNewAccount: () => {}, onImport: () => {}, onOpenAccount: () => {} }
  await render(Overview, props)
  assert.match(document.querySelector('[aria-label="總負債"]').textContent, /800/)
  assert.match(document.querySelector('[aria-label="淨資產"]').textContent, /-800/)
  assert.match(document.body.textContent, /總資產為 0/)
  await render(Overview, { ...props, data: { ...data, liabilities: [{ ...syntheticDebt, currency: 'EUR' }] } })
  assert.match(document.querySelector('[aria-label="淨資產"]').textContent, /尚無法換算/)
  assert.match(document.body.textContent, /EUR 沒有匯率/)
})

test('history distinguishes legacy unrecorded debt values while overview retains the chart modes', async () => {
  const data = { ...fixture(), liabilities: [syntheticDebt], history: { changes: [], snapshots: [
    { date: '2024-01-01', at: '2024-01-01T12:00:00Z', total: 500, accounts: [], categories: {} },
    { date: '2024-01-02', at: '2024-01-02T12:00:00Z', total: 500, accounts: [], categories: {}, liabilityTotal: 800, netWorth: -300 },
  ] } }
  await render(HistoryView, { data, dirty: false, busy: false, onSave: () => {}, onChange: () => {}, onOpenAccount: () => {} })
  assert.ok(document.querySelector('section[aria-label="每日紀錄"]'))
  assert.equal(document.querySelector('details.daily'), null)
  assert.equal((document.querySelector('table').textContent.match(/未記錄/g) ?? []).length, 1)
  assert.match(document.querySelector('table').textContent, /-300/)
  assert.equal(document.querySelector('[aria-label="顯示方式"]'),null)
  await render(Overview,{data})
  assert.ok(button('總資產'))
  assert.ok(button('依帳戶'))
  assert.ok(button('依類別'))
})

test('liability edit during daily save survives, stays dirty, and next save reviews the correct difference', async () => {
  window.history.replaceState(null, '', '/liabilities')
  const data = { ...fixture(), liabilities: [syntheticDebt] }
  const drive = setupDrive(data)
  await render(App)
  assert.equal(drive.writes, 1)
  assert.equal(drive.uploaded.liabilities[0].balance, 800)
  await click(document.querySelector('[aria-label="編輯負債 合成貸款"]'))
  await setInput(field('目前未償餘額'), '700')
  await click(button('套用負債'))
  await drive.finish()
  assert.match(document.querySelector('.liability-balance').textContent, /700/)
  assert.ok(button('儲存變更'))
  await click(button('儲存變更'))
  assert.match(document.querySelector('dialog').textContent, /TWD 800 → TWD 700/)
  assert.equal(drive.writes, 1)
  await click(button('確認儲存'))
  assert.equal(drive.writes, 2)
  assert.equal(drive.uploaded.liabilities[0].balance, 700)
  assert.equal(drive.uploaded.history.liabilityChanges.at(-1).before.balance, 800)
  assert.equal(drive.uploaded.history.liabilityChanges.at(-1).after.balance, 700)
  await drive.finish()
  assert.ok(document.querySelector('.synced'))
})

test('liability save review cancellation keeps edits and revert restores a deleted debt', async () => {
  window.history.replaceState(null, '', '/liabilities')
  const data = { ...fixture(), liabilities: [syntheticDebt] }
  const drive = setupDrive(data)
  await render(App)
  await drive.finish()
  globalThis.confirm = () => true
  await click(document.querySelector('[aria-label="刪除負債 合成貸款"]'))
  await click(button('儲存變更'))
  assert.match(document.querySelector('dialog').textContent, /移除負債/)
  await click(button('繼續編輯'))
  assert.equal(document.querySelector('.liability-balance'), null)
  assert.ok(button('儲存變更'))
  await click(button('儲存變更'))
  await click(button('復原負債'))
  assert.equal(document.querySelector('dialog'), null)
  assert.match(document.querySelector('.liability-balance').textContent, /800/)
  assert.equal(drive.writes, 1)
})

const selectValue = async (label, value) => act(async () => {
  const select = field(label)
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
})
test('loan form defaults to annuity, switches to declining payments, and bounds schedule pages', async () => {
  let changed
  await render(Liabilities, { data: fixture(), onChange: next => { changed = next } })
  await click(button('＋ 新增負債'))
  await selectValue('計算基準', 'manual')
  assert.equal(field('還款方式').value, 'annuity')
  await setInput(field('負債名稱'), '合成試算')
  await setInput(field('目前未償餘額'), '1200')
  await setInput(field('年利率（%）'), '12')
  await setInput(field('剩餘期數（月）'), '24')
  assert.match(document.body.textContent, /預估每月應付/)
  assert.equal(document.querySelectorAll('.loan-schedule tbody tr').length, 12)
  await click(button('後 12 期'))
  assert.equal(document.querySelector('.loan-schedule tbody td').textContent, '13')
  await selectValue('還款方式', 'equalPrincipal')
  assert.doesNotMatch(document.body.textContent, /預估每月應付/)
  assert.match(document.body.textContent, /預估首期應付/)
  await setInput(field('剩餘期數（月）'), '1')
  assert.equal(document.querySelectorAll('.loan-schedule tbody tr').length, 1)
  assert.equal(document.querySelector('.loan-schedule tbody td').textContent, '1')
  await click(button('套用負債'))
  assert.equal(changed.liabilities[0].balance, 1200)
  assert.equal(changed.liabilities[0].repaymentMethod, 'equalPrincipal')
  assert.equal(changed.liabilities[0].paymentAmount, undefined)
})
test('credit and irregular debt can save balance only even after invalid projection input', async () => {
  let changed
  await render(Liabilities, { data: fixture(), onChange: next => { changed = next } })
  await click(button('＋ 新增負債'))
  await selectValue('計算基準', 'manual')
  await setInput(field('負債名稱'), '合成信用卡')
  await setInput(field('目前未償餘額'), '200')
  await setInput(field('年利率（%）'), 'invalid')
  await setInput(field('剩餘期數（月）'), '-1')
  await selectValue('負債類型', 'credit')
  assert.equal(field('還款方式').value, 'none')
  assert.equal(document.querySelector('[aria-label="貸款試算"]'), null)
  await click(button('套用負債'))
  assert.equal(changed.liabilities[0].balance, 200)
  assert.equal(changed.liabilities[0].annualRate, undefined)
  assert.equal(changed.liabilities[0].remainingInstallments, undefined)
})
test('editing legacy manual debt retains values without inferring projection or remaining periods', async () => {
  const legacy = { ...syntheticDebt, annualRate: 2, paymentAmount: 20, totalInstallments: 24, paidInstallments: 3 }
  let changed
  await render(Liabilities, { data: { ...fixture(), liabilities: [legacy] }, onChange: next => { changed = next } })
  await click(document.querySelector('[aria-label="編輯負債 合成貸款"]'))
  assert.equal(field('還款方式').value, 'none')
  assert.match(document.body.textContent, /既有手填資料/)
  await setInput(field('目前未償餘額'), '700')
  await click(button('套用負債'))
  assert.deepEqual(changed.liabilities[0], { ...legacy, balance: 700, repaymentMethod: 'none' })
})

test('new scheduled loan uses original amount and first due date only; name edits preserve baseline', async () => {
  let current
  function Harness() {
    const [data, setData] = useState(fixture)
    useEffect(() => { current = data }, [data])
    return createElement(Liabilities, { data, onChange: setData })
  }
  await render(Harness)
  await click(button('＋ 新增負債'))
  assert.equal(field('計算基準').value, 'original')
  assert.equal(field('剩餘期數（月）'), undefined)
  assert.equal(field('下次到期日（選填）'), undefined)
  await setInput(field('負債名稱'), '合成按期貸款')
  await setInput(field('原始貸款總額'), '1200')
  await setInput(field('年利率（%）'), '0')
  await setInput(field('總期數（月）'), '12')
  await setInput(field('第一期還款日'), '2024-02-29')
  await setInput(field('每月還款日（選填）'), '31')
  await setInput(field('貸款日曆時區'), 'Asia/Taipei')
  await click(button('套用負債'))
  const original = structuredClone(current.liabilities[0])
  assert.equal(original.balance, 1200)
  assert.equal(original.remainingInstallments, 12)
  assert.deepEqual(original.schedule, { source: 'original', baseDate: '2024-02-28', firstDueDate: '2024-02-29', monthlyDay: 31, timeZone: 'Asia/Taipei' })
  assert.equal(original.nextDueDate, undefined)
  assert.match(document.body.textContent, /預估已清償/)
  assert.match(document.querySelector('.liability-balance').textContent, /TWD 0/)
  await click(document.querySelector('[aria-label="編輯負債 合成按期貸款"]'))
  assert.ok(field('原始貸款總額').closest('fieldset').disabled)
  await setInput(field('負債名稱'), '改名合成貸款')
  await click(button('套用負債'))
  assert.deepEqual(current.liabilities[0], { ...original, name: '改名合成貸款' })
  await click(button('校正餘額／重設基準'))
  await setInput(field('目前未償餘額'), '999')
  await click(button('取消'))
  assert.equal(current.liabilities[0].balance, 1200)
})

test('correction requires confirmation, rejects future baseline, keeps audit and can stop estimation', async () => {
  const initial = { ...syntheticDebt, balance: 1200, annualRate: 12, repaymentMethod: 'annuity', remainingInstallments: 12,
    schedule: { source: 'original', baseDate: '2024-01-30', firstDueDate: '2024-01-31', monthlyDay: 31, timeZone: 'Asia/Taipei' } }
  let current
  function Harness() {
    const [data, setData] = useState({ ...fixture(), liabilities: [initial] })
    useEffect(() => { current = data }, [data])
    return createElement(Liabilities, { data, onChange: setData })
  }
  await render(Harness)
  await click(button('校正餘額／重設基準'))
  await setInput(field('目前未償餘額'), '900')
  await setInput(field('年利率（%）'), '6')
  await setInput(field('剩餘期數（月）'), '10')
  await setInput(field('校正原因'), '合成利率調整')
  await click(button('套用負債'))
  assert.match(document.querySelector('[role="alert"]').textContent, /確認基準/)
  assert.deepEqual(current.liabilities[0], initial)
  await click(document.querySelector('input[type="checkbox"]'))
  await setInput(field('校正基準日'), '2099-01-01')
  await setInput(field('新基準後第一期還款日'), '2099-01-31')
  await click(button('套用負債'))
  assert.match(document.querySelector('[role="alert"]').textContent, /不得晚於/)
  await setInput(field('校正基準日'), '2024-02-29')
  await setInput(field('新基準後第一期還款日'), '2024-03-31')
  await click(button('套用負債'))
  const corrected = current.liabilities[0]
  assert.equal(corrected.balance, 900)
  assert.equal(corrected.annualRate, 6)
  assert.equal(corrected.schedule.source, 'correction')
  assert.equal(corrected.basisHistory[0].balance, 1200)
  assert.deepEqual(corrected.basisHistory[0].schedule, initial.schedule)
  assert.match(document.body.textContent, /基準變更紀錄/)
  await click(button('校正餘額／重設基準'))
  await selectValue('計算基準', 'manual')
  await setInput(field('目前未償餘額'), '50')
  await setInput(field('校正原因'), '改用合成銀行實際餘額')
  await click(document.querySelector('input[type="checkbox"]'))
  await click(button('套用負債'))
  assert.equal(current.liabilities[0].schedule, undefined)
  assert.equal(current.liabilities[0].balance, 50)
  assert.equal(current.liabilities[0].basisHistory.length, 2)
})

test('invalid monthly anchor blocks new loan with no partial application', async () => {
  let changes = 0
  await render(Liabilities, { data: fixture(), onChange: () => changes++ })
  await click(button('＋ 新增負債'))
  await setInput(field('負債名稱'), '合成錯誤日程')
  await setInput(field('原始貸款總額'), '1200')
  await setInput(field('年利率（%）'), '0')
  await setInput(field('總期數（月）'), '12')
  await setInput(field('第一期還款日'), '2024-03-30')
  await setInput(field('每月還款日（選填）'), '31')
  await click(button('套用負債'))
  assert.match(document.querySelector('[role="alert"]').textContent, /不一致/)
  assert.equal(changes, 0)
})

test('failed scheduled-debt save retains edits and original principal, with no payment writes', async () => {
  window.history.replaceState(null, '', '/liabilities')
  const data = { ...fixture(), version: 4, liabilities: [{ ...syntheticDebt, balance:1200, annualRate:0, repaymentMethod:'annuity', remainingInstallments:12,
    schedule:{source:'original',baseDate:'2024-01-30',firstDueDate:'2024-01-31',monthlyDay:31,timeZone:'Asia/Taipei'} }] }
  const drive = setupDrive(data)
  await render(App)
  assert.equal(drive.writes, 1) // existing daily snapshot, never a payment event
  assert.equal(drive.uploaded.liabilities[0].balance, 1200)
  assert.equal(drive.uploaded.history.snapshots.at(-1).liabilityEstimated, true)
  await click(document.querySelector('[aria-label="編輯負債 合成貸款"]'))
  await setInput(field('負債名稱'), '合成保留草稿')
  await click(button('套用負債'))
  await drive.finish(412)
  assert.match(document.body.textContent, /合成保留草稿/)
  assert.match(document.querySelector('.liability-balance').textContent, /TWD 0/)
  assert.equal(drive.writes, 1)
  assert.equal(drive.uploaded.liabilities[0].balance, 1200)
  assert.ok(button('儲存變更'))
})

const chooseHistoryInstrument = async (accountId, symbol) => {
 const accounts = field('補登帳戶')
 await selectValue('補登帳戶', accountId ?? accounts.options[1].value)
 await click(button('下一步：選標的'))
 const instruments = field('補登標的')
 const option = symbol ? [...instruments.options].find(o => o.textContent.includes(symbol)) : instruments.options[1]
 await selectValue('補登標的', option.value)
 await click(button('下一步：填數量'))
}
const historicalFixture = () => ({ ...fixture(), accounts: [{ id: 'history-account', name: '合成歷史帳戶', kind: 'investment', country: 'TW', category: '股票', positions: [
  { id: 'history-cash', type: 'cash', currency: 'TWD', symbol: '', quantity: 900, price: 1 },
] }] })
test('historical quantity add/edit/cancel/restore changes only chosen date; charts and list use the same value', async () => {
  let current
  function Harness() {
    const [data,setData] = useState(historicalFixture)
    useEffect(()=>{current=data},[data])
    return createElement(HistoryView,{data,dirty:true,busy:false,onChange:setData,onSave:()=>{},onOpenAccount:()=>{}})
  }
  await render(Harness)
  await click(button('＋ 補登歷史數量'))
 await chooseHistoryInstrument()
  await setInput(field('歷史日期'),'2025-10-04')
  const label='合成歷史帳戶 · TWD · TWD 當日數量'
  assert.equal(field(label).value,'')
  await setInput(field(label),'100')
  await click(button('取消歷史編輯'))
  assert.equal(current.history.quantityDays,undefined)
  await click(button('＋ 補登歷史數量'))
 await chooseHistoryInstrument()
  await setInput(field('歷史日期'),'2025-10-04')
  await setInput(field(label),'100')
  await click(button('取得歷史估值'))
  assert.match(document.querySelector('[role="status"]').textContent,/100/)
  await confirmCompletion();await click(button('儲存歷史數量'))
  assert.equal(current.accounts[0].positions[0].quantity,900)
  assert.equal(current.history.quantityDays[0].entries[0].quantity,100)
  const row=[...document.querySelectorAll('section.daily tbody tr')].find(r=>r.textContent.includes('2025/10/04'))
  assert.match(row.textContent,/100/)
  assert.match(row.textContent,/未記錄/)
  await click(historyItem('2025-10-04'))
  assert.equal(field('歷史日期').disabled,true)
  await setInput(field(label),'0')
  await click(button('取得歷史估值'))
  await confirmCompletion();await click(button('儲存歷史數量'))
  assert.equal(current.history.quantityDays[0].entries[0].quantity,0)
  await click(button('復原上次歷史修改'))
  assert.equal(current.history.quantityDays[0].entries[0].quantity,100)
  globalThis.confirm=()=>false
  await click(button('移除 2025-10-04'))
  assert.equal(current.history.quantityDays.length,1)
  globalThis.confirm=()=>true
  await click(button('移除 2025-10-04'))
  assert.equal(current.history.quantityDays.length,0)
  assert.ok(![...document.querySelectorAll('section.daily tbody tr')].some(r=>r.textContent.includes('2025/10/04')))
  await click(button('復原上次歷史修改'))
  assert.equal(current.history.quantityDays.length,1)
})
test('historical editor validates quantities, duplicates and future dates; late quotes cannot apply cancelled edits', async () => {
  let current
  const base=historicalFixture()
  base.accounts[0].positions=[{id:'history-stock',type:'holding',symbol:'TEST',currency:'USD',quantity:1,price:999}]
  function Harness(){const [data,setData]=useState(base);useEffect(()=>{current=data},[data]);return createElement(HistoryView,{data,dirty:true,busy:false,onChange:setData,onSave:()=>{},onOpenAccount:()=>{}})}
  await render(Harness)
  await click(button('＋ 補登歷史數量'))
 await chooseHistoryInstrument()
  await setInput(field('歷史日期'),'2999-01-01')
  await click(button('取得歷史估值'))
  assert.match(document.querySelector('[role="alert"]').textContent,/未來/)
  await setInput(field('歷史日期'),'2025-10-04')
  await setInput(field('合成歷史帳戶 · TEST · USD 當日數量'),'-1')
  await click(button('取得歷史估值'))
  assert.match(document.querySelector('[role="alert"]').textContent,/非負/)
  await setInput(field('合成歷史帳戶 · TEST · USD 當日數量'),'2')
  const pending=[]
  globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve))
  await click(button('取得歷史估值'))
  assert.ok(button('取得歷史行情中…'))
  await click(button('取消歷史編輯'))
  await act(async()=>{pending.forEach(resolve=>resolve(Response.json({symbol:'TEST',currency:'USD',asTraded:true,points:[]})))})
  // A cancelled request may finish its market-only FX request; it must not write.
  await act(async()=>{pending.forEach(resolve=>resolve(Response.json({symbol:'USDTWD=X',currency:'TWD',asTraded:true,points:[]})))})
  assert.equal(document.querySelector('[aria-label="編輯歷史數量"]'),null)
  assert.equal(current.history.quantityDays,undefined)
})
test('missing historical prices preserve quantity and show incomplete total instead of zero',async()=>{
 const data=historicalFixture();data.accounts[0].positions=[{id:'history-stock',type:'holding',symbol:'TEST',currency:'USD',quantity:1,price:999}]
 let changed
 await render(HistoryView,{data,dirty:true,busy:false,onChange:next=>{changed=next},onSave:()=>{},onOpenAccount:()=>{}})
 globalThis.fetch=async()=>new Response('',{status:404})
 await click(button('＋ 補登歷史數量'))
 await chooseHistoryInstrument()
 await setInput(field('歷史日期'),'2025-10-04')
 await setInput(field('合成歷史帳戶 · TEST · USD 當日數量'),'2')
 await click(button('取得歷史估值'))
 assert.match(document.querySelector('[role="status"]').textContent,/資料不完整/)
 assert.match(document.body.textContent,/缺少歷史匯率/)
 await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(changed.history.quantityDays[0].entries[0].quantity,2)
 assert.equal(changed.history.quantityDays[0].entries[0].price,undefined)
 assert.equal(changed.accounts[0].positions[0].quantity,1)
})
test('history page waits for background save and then saves directly; failed writes retain the draft',async()=>{
 window.history.replaceState(null,'','/history')
 const data=historicalFixture(),drive=setupDrive(data)
 await render(App)
 assert.equal(window.location.pathname,'/history')
 assert.equal(drive.writes,1)
 assert.equal(button('＋ 補登歷史數量').disabled,true)
 await drive.finish()
 await click(button('＋ 補登歷史數量'))
 assert.ok(document.querySelector('dialog[open]'))
 await chooseHistoryInstrument()
 await setInput(field('歷史日期'),'2025-10-04')
 await setInput(field('合成歷史帳戶 · TWD · TWD 當日數量'),'100')
 await click(button('取得歷史估值'))
 await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(drive.writes,2)
 assert.equal(drive.uploaded.history.quantityDays[0].entries[0].quantity,100)
 assert.equal(drive.uploaded.accounts[0].positions[0].quantity,900)
 await drive.finish(500)
 assert.ok(button('儲存變更'))
 assert.match(document.querySelector('section.daily').textContent,/100/)
 await click(button('儲存變更'))
 assert.equal(drive.writes,3)
 await drive.finish()
 assert.ok(document.querySelector('.synced'))
})

test('same-day manual quantities survive login without an automatic Drive write',async()=>{
 window.history.replaceState(null,'','/history')
 const data=historicalFixture(),now=new Date().toISOString()
 const {localDate}=await server.ssrLoadModule('/src/history.ts')
 data.version=3
 data.history.quantityDays=[{date:localDate(now),updatedAt:now,entries:[{accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:0}]}]
 const drive=setupDrive(data)
 await render(App)
 assert.equal(drive.writes,0)
 assert.match(document.querySelector('section.daily tbody tr').textContent,/NT\$ 0/)
 assert.match(document.querySelector('section.daily tbody tr').textContent,/手動/)
})
test('trend chart leaves an actual gap for unknown history and clears out-of-range hover after deletion',async()=>{
 const oldObserver=globalThis.ResizeObserver
 globalThis.ResizeObserver=class{constructor(callback){this.callback=callback}observe(){this.callback([{contentRect:{width:400}}])}disconnect(){}}
 const {TrendChart}=await server.ssrLoadModule('/src/views/TrendChart.tsx')
 try{
 await render(TrendChart,{dates:['2025-10-01','2025-10-02','2025-10-03'],series:[{key:'test',label:'合成資產',color:'blue',values:[100,null,300]}],area:true})
 const path=document.querySelector('path.line').getAttribute('d')
 assert.equal((path.match(/M/g)??[]).length,2)
 assert.equal(path.includes('L'),false)
 assert.equal(document.querySelector('path.area'),null)
 assert.equal(document.querySelectorAll('circle.dot').length,2)
 await act(async()=>document.querySelector('svg > rect').dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:400})))
 await render(TrendChart,{dates:['2025-10-01'],series:[{key:'test',label:'合成資產',color:'blue',values:[null]}],area:true})
 assert.equal(document.querySelector('.trend-tip'),null)
 assert.equal(document.querySelectorAll('circle.dot').length,0)
 assert.doesNotMatch(document.querySelector('svg').outerHTML,/NaN|Infinity/)
 }finally{globalThis.ResizeObserver=oldObserver}
})
test('unquoted holdings keep quantity without a historical manual price field',async()=>{
 const data=historicalFixture();data.accounts[0].positions=[{id:'fund',type:'holding',symbol:'基金與退休金',currency:'TWD',quantity:3,price:10,priceManual:true}]
 let changed,requests=0
 await render(HistoryView,{data,dirty:true,busy:false,onChange:next=>{changed=next},onSave:()=>{},onOpenAccount:()=>{}})
 globalThis.fetch=async()=>{requests++;return new Response('',{status:404})}
 await click(button('＋ 補登歷史數量'))
 await chooseHistoryInstrument()
 await setInput(field('歷史日期'),'2025-10-04')
 await setInput(field('合成歷史帳戶 · 基金與退休金 · TWD 當日數量'),'2')
 assert.equal(field('合成歷史帳戶 · 基金與退休金 · TWD 當日單價'),undefined)
 await click(button('取得歷史估值'))
 assert.equal(requests,0)
 assert.match(document.querySelector('[role="status"]').textContent,/資料不完整/)
 await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(changed.history.quantityDays[0].entries[0].price,undefined)
  assert.equal(changed.accounts[0].positions[0].price,10)
})

test('viewing and refreshing historical valuations queries market data without editing stored quantities or prices',async()=>{
 const data=historicalFixture();data.accounts[0].positions=[{id:'history-stock',type:'holding',symbol:'TEST',currency:'TWD',quantity:1,price:999,priceManual:true}]
 data.version=3
 data.history.quantityDays=[{date:'2025-10-04',updatedAt:'2025-10-06T12:00:00Z',entries:[{accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'holding',symbol:'TEST',currency:'TWD',quantity:2,price:{source:'manual',symbol:'TEST',date:'2025-10-04',value:999}}]}]
 let price=10,requests=0,changes=0,missing=false
 globalThis.fetch=async()=>{requests++;return missing?new Response('',{status:404}):Response.json({symbol:'TEST',currency:'TWD',asTraded:true,splits:[],points:[{date:'2025-10-03',close:price}]})}
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>changes++,onSave:()=>{},onOpenAccount:()=>{}})
 const row=()=>[...document.querySelectorAll('section.daily tbody tr')].find(r=>r.textContent.includes('2025/10/04'))
 assert.match(row().textContent,/NT\$ 20/)
 assert.match(document.querySelector('[aria-label="歷史持倉數量"]').textContent,/2025-10-03/)
 price=20
 await click(button('重新查詢歷史行情'))
 assert.match(row().textContent,/NT\$ 40/)
 missing=true
 await click(button('重新查詢歷史行情'))
 assert.match(row().textContent,/資料不完整/)
 assert.equal(requests,3);assert.equal(changes,0)
 assert.equal(data.history.quantityDays[0].entries[0].price.value,999)
 assert.equal(data.accounts[0].positions[0].price,999)
 await click(historyItem('2025-10-04'))
 assert.equal(field('合成歷史帳戶 · TEST · TWD 當日單價'),undefined)
 await click(button('取消歷史編輯'))
})

test('history wizard selects account before instrument, clears cross-account selection and cancels cleanly', async () => {
 const data=historicalFixture()
 data.accounts[0].positions=[{id:'a-stock',type:'holding',symbol:'TEST',currency:'TWD',quantity:1,price:10}]
 data.accounts.push({...data.accounts[0],id:'second-account',name:'第二合成帳戶',positions:[{...data.accounts[0].positions[0],id:'b-stock'}]})
 let changes=0
 await render(HistoryView,{data,dirty:true,busy:false,onChange:()=>changes++,onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('＋ 補登歷史數量'))
 assert.equal(field('補登帳戶').value,'')
 assert.equal(field('補登標的'),undefined);assert.equal(field('歷史日期'),undefined)
 await chooseHistoryInstrument('history-account','TEST')
 await setInput(field('合成歷史帳戶 · TEST · TWD 當日數量'),'77')
 await click(button('上一步'));await click(button('上一步'))
 await selectValue('補登帳戶','second-account');await click(button('下一步：選標的'))
 assert.equal(field('補登標的').value,'')
 assert.ok([...field('補登標的').options].filter(o=>o.value && o.value!=='__new__').every(o=>JSON.parse(o.value)[0]==='second-account'))
 await selectValue('補登標的',field('補登標的').options[1].value);await click(button('下一步：填數量'))
 assert.equal(field('第二合成帳戶 · TEST · TWD 當日數量').value,'')
 await click(button('取消歷史編輯'));assert.equal(changes,0)
 await click(button('＋ 補登歷史數量'));assert.equal(field('補登帳戶').value,'')
})

test('single-instrument update preserves every other entry and date, including the same symbol in another account', async () => {
 const data=historicalFixture(),date='2025-10-04'
 data.accounts[0].positions=[{id:'stock',type:'holding',symbol:'TEST',currency:'TWD',quantity:100,price:10}]
 data.accounts.push({...data.accounts[0],id:'b',name:'第二合成帳戶'})
 const entry=(accountId,account,quantity)=>({accountId,account,category:'股票',country:'TW',type:'holding',symbol:'TEST',currency:'TWD',quantity})
 const day={date,updatedAt:date+'T12:00:00Z',entries:[entry('history-account','合成歷史帳戶',5),entry('b','第二合成帳戶',8)]}
 data.history.quantityDays=[{...day,date:'2025-10-03'},day]
 let changed
 globalThis.fetch=async()=>Response.json({symbol:'TEST',currency:'TWD',asTraded:true,splits:[],points:[{date:'2025-10-03',close:10}]})
 await render(HistoryView,{data,dirty:true,busy:false,onChange:next=>{changed=next},onSave:()=>{},onOpenAccount:()=>{}})
 assert.ok([...document.querySelectorAll('details.quantity-day')].every(d=>!d.open))
 await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument('history-account','TEST')
 await setInput(field('歷史日期'),date);assert.equal(field('合成歷史帳戶 · TEST · TWD 當日數量').value,'5')
 await setInput(field('合成歷史帳戶 · TEST · TWD 當日數量'),'6')
 await click(button('取得歷史估值'));assert.match(document.querySelector('[role="status"]').textContent,/140/)
 await click(button('返回修改'));assert.equal(field('合成歷史帳戶 · TEST · TWD 當日數量').value,'6')
 await click(button('取得歷史估值'));await confirmCompletion();await click(button('儲存歷史數量'))
 const result=changed.history.quantityDays.find(d=>d.date===date)
 assert.equal(result.entries.find(e=>e.accountId==='history-account').quantity,6)
 assert.equal(result.entries.find(e=>e.accountId==='b').quantity,8)
 assert.deepEqual(result.entries.find(e=>e.accountId==='b'),day.entries.find(e=>e.accountId==='b'))
 assert.deepEqual(changed.history.quantityDays[0],data.history.quantityDays[0])
 assert.deepEqual(changed.accounts,data.accounts)
})

test('empty account accepts a removed instrument without manual pricing and row edit opens only that instrument', async () => {
 const initial=historicalFixture();initial.accounts[0].positions=[]
 let current
 function Harness(){const [data,setData]=useState(initial);useEffect(()=>{current=data},[data]);return createElement(HistoryView,{data,dirty:true,busy:false,onChange:setData,onSave:()=>{},onOpenAccount:()=>{}})}
 globalThis.fetch=async()=>new Response('',{status:404})
 await render(Harness);await click(button('＋ 補登歷史數量'))
 await selectValue('補登帳戶','history-account');await click(button('下一步：選標的'))
 assert.match(document.body.textContent,/目前沒有持倉/)
 await selectValue('補登標的','__new__');await setInput(field('歷史標的代號'),'已移除合成基金');await click(button('下一步：填數量'))
 await setInput(field('歷史日期'),'2025-10-04');await setInput(field('合成歷史帳戶 · 已移除合成基金 · TWD 當日數量'),'3')
 await click(button('取得歷史估值'));assert.match(document.querySelector('[role="status"]').textContent,/資料不完整/)
 assert.equal(document.querySelector('input[inputmode="decimal"]'),null)
 await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(current.accounts[0].positions.length,0)
 const rowButton=document.querySelector('[aria-label="編輯 2025-10-04 合成歷史帳戶 · 已移除合成基金 · TWD"]')
 await click(rowButton)
 assert.equal(field('合成歷史帳戶 · 已移除合成基金 · TWD 當日數量').value,'3')
 assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length,1)
 assert.equal(field('歷史日期').disabled,true)
})

test('wizard blocks stale day preview after proposing nearest complete quantities', async () => {
 const data=historicalFixture();data.accounts.push({...data.accounts[0],id:'b',name:'第二合成帳戶'})
 let applied=0
 const props={data,dirty:true,busy:false,onChange:()=>applied++,onSave:()=>{},onOpenAccount:()=>{}}
 await render(HistoryView,props);await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument()
 await setInput(field('歷史日期'),'2025-10-04');await setInput(field('合成歷史帳戶 · TWD · TWD 當日數量'),'100')
 await click(button('取得歷史估值'));assert.match(document.querySelector('[role="status"]').textContent,/1,000/)
 const newer={...data,history:{...data.history,quantityDays:[{date:'2025-10-04',updatedAt:'2025-10-04T12:00:00Z',entries:[]}]}}
 await render(HistoryView,{...props,data:newer});await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(applied,0);assert.match(document.querySelector('[role="alert"]').textContent,/已變更/)
})

test('wizard offers recorded instruments from removed accounts and gives an empty-account-list explanation', async () => {
 const data=fixture()
 await render(HistoryView,{data,dirty:true,busy:false,onChange:()=>{},onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('＋ 補登歷史數量'))
 assert.match(document.body.textContent,/目前沒有可補登的帳戶/)
 assert.equal(button('下一步：選標的').disabled,true)
 await click(button('取消歷史編輯'))
 data.history.quantityDays=[{date:'2025-10-04',updatedAt:'2025-10-04T12:00:00Z',entries:[{accountId:'removed',account:'已移除合成帳戶',category:'現金',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:5}]}]
 await render(HistoryView,{data:{...data},dirty:true,busy:false,onChange:()=>{},onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('＋ 補登歷史數量'))
 assert.match(field('補登帳戶').textContent,/已移除合成帳戶（歷史帳戶）/)
 await chooseHistoryInstrument('removed')
 await setInput(field('歷史日期'),'2025-10-04')
 assert.equal(field('已移除合成帳戶 · TWD · TWD 當日數量').value,'5')
 await setInput(field('歷史日期'),'')
 await click(button('上一步'))
 await click(button('下一步：填數量'))
 assert.ok(field('歷史日期')) // an invalid draft date cannot trap the user on instrument selection
})

test('period wizard validates sale date, confirms overlap, preserves current positions, and supports undo',async()=>{
 const initial=historicalFixture();let current
 function Harness(){const [data,setData]=useState(initial);useEffect(()=>{current=data},[data]);return createElement(HistoryView,{data,dirty:true,busy:false,onChange:setData,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness)
 const enter=async(start,end,quantity)=>{
  await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument();await selectValue('補登方式','period')
  await setInput(field('開始日期（含）'),start);await setInput(field('結束／賣出日期（不含，選填）'),end)
  await setInput(field('合成歷史帳戶 · TWD · TWD 當日數量'),quantity)
 }
 await enter('2026-10-01','2026-10-01','100');await click(button('取得歷史估值'))
 assert.match(document.querySelector('[role="alert"]').textContent,/晚於開始日/)
 await setInput(field('結束／賣出日期（不含，選填）'),'2026-10-02');await click(button('取得歷史估值'))
 assert.match(document.querySelector('[role="status"]').textContent,/結束不含/)
 await click(button('返回修改'));assert.equal(field('結束／賣出日期（不含，選填）').value,'2026-10-02')
 await click(button('取得歷史估值'));await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(current.version,5);assert.equal(current.history.holdingPeriods.length,1);assert.deepEqual(current.accounts,initial.accounts)
 await enter('2026-10-01','','200');await click(button('取得歷史估值'));await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(current.history.holdingPeriods.length,1);assert.match(document.querySelector('[role="alert"]').textContent,/確認重疊/)
 await click(document.querySelector('.quantity-editor input[type="checkbox"]'));await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(current.history.holdingPeriods.length,2)
 await click(button('復原上次歷史修改'));assert.equal(current.history.holdingPeriods.length,1)
 globalThis.confirm=()=>true
 await click(button('移除期間 2026-10-01'));assert.equal(current.history.holdingPeriods.length,0)
 await click(button('復原上次歷史修改'));assert.equal(current.history.holdingPeriods.length,1)
})

test('period preview rejects edits arriving after preview and cancellation ignores delayed quote results',async()=>{
 const data=historicalFixture();let applied=0
 const props={data,dirty:true,busy:false,onChange:()=>applied++,onSave:()=>{},onOpenAccount:()=>{}}
 await render(HistoryView,props);await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument();await selectValue('補登方式','period')
 await setInput(field('開始日期（含）'),'2026-10-01');await setInput(field('合成歷史帳戶 · TWD · TWD 當日數量'),'100')
 await click(button('取得歷史估值'))
 const newer={...data,accounts:[{...data.accounts[0],name:'已修改帳戶'}]}
 await render(HistoryView,{...props,data:newer});await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(applied,0);assert.match(document.querySelector('[role="alert"]').textContent,/重新預覽期間/)
 await click(button('取消歷史編輯'))
 const stock={...data,accounts:[{...data.accounts[0],positions:[{id:'stock',type:'holding',symbol:'DELAY',currency:'TWD',quantity:1,price:10}]}]}
 let release
 globalThis.fetch=()=>new Promise(resolve=>{release=resolve})
 await render(HistoryView,{...props,data:stock});await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument('history-account','DELAY');await selectValue('補登方式','period')
 await setInput(field('開始日期（含）'),'2026-10-01');await setInput(field('合成歷史帳戶 · DELAY · TWD 當日數量'),'10');await click(button('取得歷史估值'))
 await click(button('取消歷史編輯'))
 await act(async()=>release(Response.json({symbol:'DELAY',currency:'TWD',asTraded:true,splits:[],points:[]})))
 assert.equal(applied,0);assert.equal(document.querySelector('.quantity-editor'),null)
})

test('review: single-target UI writes no placeholder for another account period, and retained snapshots are labelled',async()=>{
 const data=historicalFixture();const first=data.accounts[0]
 data.accounts.push({...first,id:'b',name:'另一合成帳戶'})
 data.history.holdingPeriods=[{id:'range',accountId:first.id,account:first.name,category:first.category,country:first.country,type:'cash',symbol:'',currency:'TWD',quantity:10,start:'2026-09-01',timeZone:'Asia/Taipei',updatedAt:'2026-10-09T12:00:00Z'}]
 const {snapshotOf}=await server.ssrLoadModule('/src/history.ts')
 data.history.snapshots=[snapshotOf(data,'2026-10-05T12:00:00Z')]
 let current=data
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:true,busy:false,onChange:setValue,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness)
 const snapshotRow=[...document.querySelectorAll('section.daily tbody tr')].find(x=>x.textContent.includes('2026/10/05'))
 assert.match(snapshotRow.textContent,/原始快照/);assert.doesNotMatch(snapshotRow.textContent,/資料不完整/)
 const derivedRow=[...document.querySelectorAll('section.daily tbody tr')].find(x=>x.textContent.includes('2026/10/04'))
 assert.equal(derivedRow,undefined);assert.match(document.body.textContent,/持倉數量不足的推算日/)
 await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument('b');await setInput(field('歷史日期'),'2026-09-15');await setInput(field('另一合成帳戶 · TWD · TWD 當日數量'),'3');await click(button('取得歷史估值'));assert.match(document.querySelector('[role="status"]').textContent,/NT\$ 13/);await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(current.history.quantityDays[0].entries.length,1);assert.equal(current.history.quantityDays[0].entries[0].accountId,'b');assert.equal(current.version,9)
 const {periodQuantityOn}=await server.ssrLoadModule('/src/holdingPeriods.ts')
 assert.equal(periodQuantityOn(current,data.history.holdingPeriods[0],'2026-09-20').quantity,10)
 assert.equal(current.history.snapshots,data.history.snapshots)
})

test('review: unrelated edits retain values; refresh retains same-target values, failures and late responses are safe',async()=>{
 const {useHistoricalValuations,historicalProjectionKey}=await server.ssrLoadModule('/src/useHistoricalValuations.ts')
 const data=historicalFixture();data.accounts[0].positions=[{id:'test',type:'holding',symbol:'TEST',currency:'TWD',quantity:1,price:10}]
 const identity={accountId:'history-account',account:'合成歷史帳戶',category:data.accounts[0].category,country:'TW',type:'holding',symbol:'TEST',currency:'TWD'}
 data.history.holdingPeriods=[{...identity,id:'range',start:'2026-10-01',quantity:2,timeZone:'Asia/Taipei',updatedAt:'2026-10-09T12:00:00Z'}]
 let state,hold=false,calls=0;const pending=[],renders=[]
 globalThis.fetch=async url=>{calls++;const symbol=new URL(url,'https://synthetic.invalid').searchParams.get('symbol');if(hold && symbol!=='USDTWD=X')return new Promise(resolve=>pending.push({symbol,resolve}));return Response.json({symbol,currency:'TWD',asTraded:true,splits:[],points:[{date:'2026-10-01',close:10},{date:'2026-10-08',close:10}]})}
 function Probe({data}){const value=useHistoricalValuations(data);useEffect(()=>{state=value;const e=value.data.history.valuedQuantityDays?.[0]?.entries[0];renders.push({loading:value.loading,symbol:e?.symbol,quantity:e?.quantity,price:e?.price?.value})});return null}
 await render(Probe,{data});assert.equal(renders.at(-1).price,10);renders.length=0
 const metadata={...data,fxUpdatedAt:'new',fxRates:{USD:999}}
 assert.equal(historicalProjectionKey(data,'2026-10-09'),historicalProjectionKey(metadata,'2026-10-09'))
 await render(Probe,{data:metadata});assert.ok(renders.every(x=>!x.loading&&x.price===10));assert.equal(calls,1)
 hold=true;await act(async()=>state.refresh());assert.equal(renders.at(-1).price,10);assert.match(state.status,/暫顯示上次/)
 await act(async()=>pending.shift().resolve(new Response('',{status:500})));assert.equal(renders.at(-1).price,undefined);assert.match(state.status,/保持未知/)
 const fresh={...data,history:{...data.history,holdingPeriods:[{...data.history.holdingPeriods[0],quantity:4}]}}
 await render(Probe,{data:fresh});assert.equal(renders.at(-1).quantity,4)
 // Different target/currency cannot borrow the old target's value. Resolve B before A.
 const a={...fresh,accounts:[{...data.accounts[0],positions:[{...data.accounts[0].positions[0],symbol:'AAA'}]}],history:{...fresh.history,holdingPeriods:[{...fresh.history.holdingPeriods[0],symbol:'AAA'}]}}
 await render(Probe,{data:a});assert.equal(renders.at(-1).price,undefined)
 const b={...a,accounts:[{...a.accounts[0],positions:[{...a.accounts[0].positions[0],symbol:'BBB',currency:'USD'}]}],history:{...a.history,holdingPeriods:[{...a.history.holdingPeriods[0],symbol:'BBB',currency:'USD'}]}}
 await render(Probe,{data:b});assert.equal(renders.at(-1).price,undefined)
 const response=(symbol,currency,close)=>Response.json({symbol,currency,asTraded:true,splits:[],points:[{date:'2026-10-01',close}]})
 await act(async()=>pending.find(x=>x.symbol==='BBB').resolve(response('BBB','USD',25)))
 assert.equal(renders.at(-1).symbol,'BBB');assert.equal(renders.at(-1).quantity,4);assert.equal(renders.at(-1).price,25);assert.equal(state.loading,false)
 await act(async()=>pending.find(x=>x.symbol==='AAA').resolve(response('AAA','TWD',999)))
 assert.equal(renders.at(-1).symbol,'BBB');assert.equal(renders.at(-1).price,25)
 // A true quantity correction recalculates against the cached quote, with no stale count.
 const corrected={...b,history:{...b.history,holdingPeriods:[{...b.history.holdingPeriods[0],quantity:7}]}}
 await render(Probe,{data:corrected});assert.equal(renders.at(-1).quantity,7);assert.equal(renders.at(-1).price,25)
 // Unmounting while an explicit refresh is pending cannot publish its response.
 await act(async()=>state.refresh());const last=pending.at(-1);const beforeUnmount=renders.length
 await act(async()=>root.unmount());root=null
 await act(async()=>last.resolve(response('BBB','USD',40)))
 assert.equal(renders.length,beforeUnmount)
})

test('overview compares actual last record and history preserves omitted or explicitly unknown dates',async()=>{
 const data=historicalFixture();data.accounts[0].positions[0].quantity=100
 data.accounts.push({...data.accounts[0],id:'b',name:'合成B'})
 const {snapshotOf,localDate}=await server.ssrLoadModule('/src/history.ts')
 const {shiftDate}=await server.ssrLoadModule('/src/holdingPeriods.ts')
 const {ChangeSinceLast}=await server.ssrLoadModule('/src/views/AssetChange.tsx')
 const today=localDate(new Date().toISOString()),old=shiftDate(today,-3),yesterday=shiftDate(today,-1)
 data.history.snapshots=[snapshotOf(data,old+'T12:00:00')]
 data.accounts[1].positions[0].quantity=200
 data.history.holdingPeriods=[{id:'r',accountId:'history-account',account:'合成歷史帳戶',category:data.accounts[0].category,country:data.accounts[0].country,type:'cash',symbol:'',currency:'TWD',start:shiftDate(today,-8),end:shiftDate(today,-6),quantity:10,timeZone:'UTC',updatedAt:new Date().toISOString()}]
 await render(ChangeSinceLast,{data})
 assert.match(document.body.textContent,/\+100/);assert.doesNotMatch(document.body.textContent,/較昨天/)
 const props={data,dirty:true,busy:false,onChange:()=>{},onSave:()=>{},onOpenAccount:()=>{}}
 await render(HistoryView,props)
 assert.equal(document.querySelector('.stats'),null)
 assert.equal([...document.querySelectorAll('section.daily tbody tr')].some(row=>row.textContent.includes(yesterday.replaceAll('-','/'))),false)
 assert.match(document.body.textContent,/持倉數量不足的推算日/)
 const entry={...data.history.holdingPeriods[0],quantity:null}
 const unknown={...data,history:{...data.history,quantityDays:[{date:yesterday,updatedAt:new Date().toISOString(),sparse:true,entries:[entry]}]}}
 await render(ChangeSinceLast,{data:unknown});assert.match(document.body.textContent,/資料不完整，無法比較/)
 await render(HistoryView,{...props,data:unknown});
 const unknownRow=[...document.querySelectorAll('section.daily tbody tr')].find(row=>row.textContent.includes(yesterday.replaceAll('-','/')))
 assert.match(unknownRow.textContent,/資料不完整/)
})

test('crypto cash preview shows depeg conversion legs, persists provenance, and failed refresh stays unknown',async()=>{
 const initial=historicalFixture();initial.accounts[0].positions=[{id:'crypto',type:'cash',symbol:'',currency:'USDT',quantity:7,price:1}];initial.fxRates.USDT=999
 let current,fail=false;const requests=[]
 globalThis.fetch=async url=>{
  const symbol=new URL(url,'https://synthetic.invalid').searchParams.get('symbol');requests.push(symbol)
  if(fail&&symbol==='USDT-USD')return Response.json({error:'provider_error'},{status:502})
  return Response.json({symbol,currency:symbol==='TWD=X'?'TWD':'USD',asTraded:true,splits:[],points:[{date:'2026-09-01',close:symbol==='TWD=X'?32:0.98}]})
 }
 function Harness(){const [data,setData]=useState(initial);useEffect(()=>{current=data},[data]);return createElement(HistoryView,{data,dirty:true,busy:false,onChange:setData,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument();await setInput(field('歷史日期'),'2026-09-01');await setInput(field('合成歷史帳戶 · USDT · USDT 當日數量'),'7');await click(button('取得歷史估值'))
 assert.match(document.querySelector('.quantity-editor').textContent,/219\.52/)
 assert.match(document.querySelector('.quantity-editor').textContent,/USDT-USD.*2026-09-01/)
 assert.match(document.querySelector('.quantity-editor').textContent,/TWD=X.*2026-09-01/)
 assert.equal(requests.includes('USDTTWD=X'),false)
 await confirmCompletion();await click(button('儲存歷史數量'));assert.equal(current.version,9);assert.equal(current.history.quantityDays[0].entries[0].fx.legs.length,2)
 const row=()=>[...document.querySelectorAll('section.daily tbody tr')].find(x=>x.textContent.includes('2026/09/01'))
 assert.match(row().textContent,/NT\$ 220/)
 fail=true;await click(button('重新查詢歷史行情'));assert.match(row().textContent,/資料不完整/)
 await click(historyItem('2026-09-01'));await click(button('取得歷史估值'))
 assert.match(document.querySelector('.quantity-editor').textContent,/USDT\/USD.*來源暫時異常/)
 await click(button('取消歷史編輯'));assert.equal(current.history.quantityDays[0].entries[0].quantity,7)
})

test('single-item shortcuts preserve recorded siblings and reset after cancel',async()=>{
 const data=historicalFixture(),date='2026-09-01'
 const entry={accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:7}
 const other={...entry,accountId:'removed',account:'已移除的合成帳戶',quantity:null}
 data.history.quantityDays=[{date,updatedAt:date+'T12:00:00Z',sparse:true,entries:[entry,other]}]
 let current
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:false,busy:false,onChange:setValue,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);await click(historyItem(date,other.account));assert.equal(document.querySelector('input[inputmode="decimal"]').value,'')
 await click(button('取消歷史編輯'));await click(historyItem(date,entry.account));await setInput(document.querySelector('input[inputmode="decimal"]'),'11')
 await click(button('取得歷史估值'));await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(current.history.quantityDays[0].entries.find(e=>e.accountId===entry.accountId).quantity,11)
 assert.deepEqual(current.history.quantityDays[0].entries.find(e=>e.accountId==='removed'),other);assert.deepEqual(current.accounts,data.accounts)
 await click(historyItem(date,entry.account));await setInput(document.querySelector('input[inputmode="decimal"]'),'55');await click(button('取消歷史編輯'))
 await click(historyItem(date,entry.account));assert.equal(document.querySelector('input[inputmode="decimal"]').value,'11');await click(button('取消歷史編輯'))
})

test('single recorded unknown or zero opens directly without choosing an account or losing its value',async()=>{
 for(const quantity of [null,0]){
  const data=historicalFixture();data.history.quantityDays=[{date:'2026-09-01',updatedAt:'2026-09-01T12:00:00Z',entries:[{accountId:'gone',account:'已移除的合成帳戶',category:'其他',country:'GLOBAL',type:'cash',symbol:'',currency:'TWD',quantity}]}]
  await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('cancel must not mutate'),onSave:()=>{},onOpenAccount:()=>{}})
  await click(historyItem('2026-09-01'));assert.equal(field('補登帳戶'),undefined);assert.equal(document.querySelector('.history-item-choices'),null)
  assert.equal(document.querySelector('input[inputmode="decimal"]').value,quantity===null?'':'0');assert.match(document.querySelector('.history-original').textContent,quantity===null?/既有數量：未知/:/既有數量：0/)
  await click(button('取消歷史編輯'))
 }
})

test('snapshot-only date shows a full editable baseline and explains unavailable original quantities',async()=>{
 const data=historicalFixture();data.history.snapshots=[{date:'2026-09-01',at:'2026-09-01T12:00:00Z',total:900,accounts:[{id:'history-account',name:'合成歷史帳戶',value:900}],categories:{股票:900}}]
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('cancel must not mutate'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('編輯數量 2026-09-01'));assert.equal(field('回補目的日期').value,'2026-09-01');assert.equal(field('回補目的日期').readOnly,true)
 assert.match(document.querySelector('.baseline-editor').textContent,/不能從原始總額快照還原/);assert.equal(field('合成歷史帳戶 · TWD 目的日數量').value,'900')
 await click(button('取消回補'));assert.equal(document.activeElement,button('編輯數量 2026-09-01'))
 await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument();assert.equal(field('補登方式').value,'day')
})

test('direct row edit saves only the selected historical quantity through the existing Drive save flow',async()=>{
 window.history.replaceState(null,'','/history')
 const data=historicalFixture(),now=new Date().toISOString()
 const {localDate}=await server.ssrLoadModule('/src/history.ts')
 const entry={accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:7}
 data.version=7
 data.history.quantityDays=[{date:'2026-09-01',updatedAt:now,sparse:true,entries:[entry]},{date:localDate(now),updatedAt:now,sparse:true,entries:[{...entry,quantity:900}]}]
 const drive=setupDrive(data);await render(App);assert.equal(drive.writes,0)
 await click(button('編輯數量 2026-09-01'));assert.equal(document.querySelector('input[inputmode="decimal"]').value,'7')
 await setInput(document.querySelector('input[inputmode="decimal"]'),'11');await click(baselineConfirm());await click(button('預覽回補差異'));await click(baselineConfirm());await click(button('儲存完整回補'))
 assert.equal(drive.writes,1)
 assert.equal(drive.uploaded.version,8);assert.equal(drive.uploaded.history.quantityDays[0].entries[0].quantity,11)
 assert.deepEqual(drive.uploaded.history.quantityDays[1],data.history.quantityDays[1]);assert.equal(drive.uploaded.accounts[0].positions[0].quantity,900)
 await drive.finish();assert.ok(document.querySelector('.synced'))
 await click(button('編輯數量 2026-09-01'));assert.equal(document.querySelector('input[inputmode="decimal"]').value,'11');await click(button('取消回補'));assert.equal(drive.writes,1)
})

const baselineFixture=()=>{
 const data=historicalFixture();data.version=8
 const entries=['A','B','C','D','E'].map((id,i)=>({accountId:id,account:`合成基底帳戶 ${id}`,category:'其他',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:[100,2,0,3,4][i]}))
 data.accounts=entries.map(e=>({id:e.accountId,name:e.account,kind:'investment',category:e.category,country:e.country,positions:[{id:`p${e.accountId}`,type:e.type,symbol:'',currency:'TWD',quantity:e.quantity,price:1}]}))
 data.history.quantityDays=[{date:'2026-10-09',updatedAt:'2026-10-09T12:00:00Z',inventory:{accounts:entries.map(e=>({id:e.accountId,name:e.account})),source:{kind:'day',date:'2026-10-08'}},entries}]
 return data
}
const baselineConfirm=()=>document.querySelector('.baseline-editor input[type="checkbox"]')
const startBaseline=async()=>{
 await click(button('沿用持倉回補差異'));await selectValue('持倉基底來源','day:2026-10-09');await setInput(field('回補目的日期'),'2026-09-01')
}
test('baseline UI prefills A–E, shows absolute and delta quantities, confirms overwrite and preserves source and current',async()=>{
 const data=baselineFixture(),originalSource=data.history.quantityDays[0]
 data.history.quantityDays.unshift({date:'2026-09-01',updatedAt:'2026-09-01T12:00:00Z',entries:[{...originalSource.entries[0],quantity:8},{...originalSource.entries[0],accountId:'removed',account:'目的日既有合成帳戶',quantity:99}]})
 let current
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:true,busy:false,onChange:setValue,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);await startBaseline();assert.equal(field('合成基底帳戶 A · TWD 目的日數量').value,'100');assert.equal(field('合成基底帳戶 C · TWD 目的日數量').value,'0')
 assert.equal(button('預覽回補差異').disabled,true);await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'300');assert.match(document.querySelector('.baseline-editor').textContent,/差異 \+200/)
 await click(baselineConfirm());await click(button('預覽回補差異'))
 const text=document.querySelector('.baseline-editor').textContent
 assert.match(text,/來源：2026-10-09.*目的：2026-09-01/);assert.match(text,/目的日原紀錄：8/);assert.match(text,/目的日將移除的項目.*目的日既有合成帳戶.*99 → 未持有/)
 assert.match(text,/目的日總資產：NT\$ 309/);assert.equal(button('儲存完整回補').disabled,true)
 await click(baselineConfirm());await click(button('儲存完整回補'));assert.equal(current.version,8)
 assert.deepEqual(current.history.quantityDays[0].entries.map(e=>e.quantity),[300,2,0,3,4]);assert.deepEqual(current.history.quantityDays[1],originalSource);assert.deepEqual(current.accounts,data.accounts)
 assert.match([...document.querySelectorAll('section.daily tbody tr')].find(r=>r.textContent.includes('2026/09/01')).textContent,/完整回補.*NT\$ 309/)
 await click(button('復原上次歷史修改'));assert.deepEqual(current.history.quantityDays,data.history.quantityDays)
})
test('baseline cancel, Escape, source switch and reopening never retain prior confirmations or quantities',async()=>{
 const data=baselineFixture();await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('cancel must not apply'),onSave:()=>{},onOpenAccount:()=>{}})
 await startBaseline();await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'300');await click(baselineConfirm());await click(button('預覽回補差異'));await click(baselineConfirm());await click(button('返回調整差異'))
 assert.equal(field('合成基底帳戶 A · TWD 目的日數量').value,'300');await selectValue('持倉基底來源','current');assert.equal(baselineConfirm().checked,false);assert.equal(field('合成基底帳戶 A · TWD 目的日數量').value,'100')
 await act(()=>field('合成基底帳戶 A · TWD 目的日數量').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.querySelector('.baseline-editor'),null)
 await click(button('沿用持倉回補差異'));assert.equal(field('持倉基底來源').value,'');assert.equal(field('回補目的日期'),undefined);await click(button('取消回補'))
 await click(button('＋ 補登歷史數量'));assert.ok(field('補登帳戶'));await click(button('取消歷史編輯'))
})
test('baseline blocks unknown quantities and blank destination values, and ignores late quotes after cancellation',async()=>{
 const data=baselineFixture();data.history.quantityDays.push({date:'2026-09-20',updatedAt:'2026-09-20T12:00:00Z',entries:[{...data.history.quantityDays[0].entries[0],quantity:null}]})
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('must not apply'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('沿用持倉回補差異'));await selectValue('持倉基底來源','day:2026-09-20');assert.match(document.querySelector('.baseline-editor').textContent,/來源含未知/);assert.equal(button('預覽回補差異'),undefined)
 await selectValue('持倉基底來源','day:2026-10-09');await setInput(field('回補目的日期'),'2026-09-01');await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'');await click(baselineConfirm());await click(button('預覽回補差異'));assert.match(document.querySelector('.baseline-editor [role="alert"]').textContent,/數量不可留空/)
 await click(button('取消回補'))
 const stock=baselineFixture();stock.accounts[0].positions[0]={...stock.accounts[0].positions[0],type:'holding',symbol:'DELAY',currency:'USD'}
 let resolve,requests=0
 globalThis.fetch=async()=>{requests++;return new Promise(r=>{resolve=r})}
 await render(HistoryView,{data:stock,dirty:false,busy:false,onChange:()=>assert.fail('late query must not apply'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('沿用持倉回補差異'));await selectValue('持倉基底來源','current');await setInput(field('回補目的日期'),'2026-09-01');await click(baselineConfirm());await click(button('預覽回補差異'));assert.ok(requests)
 await click(button('取消回補'));await act(async()=>resolve(new Response('',{status:404})));assert.equal(document.querySelector('.baseline-editor'),null)
})
test('baseline refuses stale source before preview and stale destination after confirmation',async()=>{
 let current=baselineFixture();const props={dirty:false,busy:false,onChange:()=>assert.fail('stale must not apply'),onSave:()=>{},onOpenAccount:()=>{}}
 await render(HistoryView,{...props,data:current});await startBaseline();await click(baselineConfirm())
 current=structuredClone(current);current.history.quantityDays[0].entries[0].quantity=200
 await render(HistoryView,{...props,data:current});await click(button('預覽回補差異'));assert.match(document.querySelector('.baseline-editor [role="alert"]').textContent,/來源數量已變更/)
 await selectValue('持倉基底來源','current');await selectValue('持倉基底來源','day:2026-10-09');await click(baselineConfirm());await click(button('預覽回補差異'));await click(baselineConfirm())
 current=structuredClone(current);current.history.quantityDays.push({date:'2026-09-01',updatedAt:'2026-09-01T12:00:00Z',entries:[{...current.history.quantityDays[0].entries[0],quantity:1}]})
 await render(HistoryView,{...props,data:current});await click(button('儲存完整回補'));assert.match(document.querySelector('.baseline-editor [role="alert"]').textContent,/來源或目的日資料已變更/)
})
test('baseline saves and reloads v8 through mock Drive, then row editing preserves complete scope',async()=>{
 window.history.replaceState(null,'','/history');const data=baselineFixture()
 const h=await server.ssrLoadModule('/src/history.ts');data.history.snapshots=[h.snapshotOf(data,new Date().toISOString())]
 const drive=setupDrive(data)
 await render(App);assert.equal(drive.writes,0);await startBaseline();await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'300');await click(baselineConfirm());await click(button('預覽回補差異'));await click(baselineConfirm());await click(button('儲存完整回補'))
 assert.equal(drive.writes,1);assert.equal(drive.uploaded.version,8)
 const parsed=model.parseWealthData(JSON.parse(JSON.stringify(drive.uploaded)));assert.equal(parsed.history.quantityDays[0].inventory.source.date,'2026-10-09');assert.deepEqual(parsed.history.quantityDays[0].entries.map(e=>e.quantity),[300,2,0,3,4])
 await drive.finish();await click(button('編輯數量 2026-09-01'))
 assert.equal(button('清除數量（未知）'),undefined);await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'301');await click(baselineConfirm());await click(button('預覽回補差異'));await click(baselineConfirm());await click(button('儲存完整回補'))
 assert.equal(drive.uploaded.version,8);assert.ok(drive.uploaded.history.quantityDays[0].inventory);assert.equal(drive.uploaded.history.quantityDays[0].entries[0].quantity,301);await drive.finish()
})

test('baseline preview discloses destination holding-period basis and leaves later period quantities unchanged',async()=>{
 const data=baselineFixture(),entry=data.history.quantityDays[0].entries[0]
 data.history.holdingPeriods=[{...entry,id:'synthetic-period',start:'2026-08-30',end:'2026-09-02',quantity:10,updatedAt:'2026-10-09T12:00:00Z',timeZone:'UTC'}]
 let current
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:true,busy:false,onChange:setValue,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);await startBaseline();await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'300');await click(baselineConfirm());await click(button('預覽回補差異'))
 assert.match(document.querySelector('.baseline-editor').textContent,/目的日原有期間推算.*基準日 2026-08-30，基準數量 10/)
 await click(baselineConfirm());await click(button('儲存完整回補'))
 assert.deepEqual(current.history.holdingPeriods,data.history.holdingPeriods)
 const periods=await server.ssrLoadModule('/src/holdingPeriods.ts');assert.equal(periods.periodQuantityOn(current,entry,'2026-09-02').quantity,0)
})

test('review: unverified history source has no confirmation path and current complete source remains available',async()=>{
 const data=baselineFixture();delete data.history.quantityDays[0].inventory;data.history.quantityDays[0].sparse=true;data.history.quantityDays[0].entries=data.history.quantityDays[0].entries.slice(0,1)
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('blocked source must not apply'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('沿用持倉回補差異'));await selectValue('持倉基底來源','day:2026-10-09')
 assert.match(document.querySelector('.baseline-editor').textContent,/部分或未驗證.*目前完整持倉/);assert.equal(baselineConfirm(),null);assert.equal(button('預覽回補差異'),undefined)
 await selectValue('持倉基底來源','current');assert.equal(document.querySelectorAll('.baseline-account').length,5);assert.ok(baselineConfirm())
})
test('review: complete-date blank and outside-account errors give distinct recovery instructions before any market request',async()=>{
 const data=baselineFixture(),source=data.history.quantityDays[0]
 data.history.quantityDays.push({...source,date:'2026-09-01',inventory:{...source.inventory,accounts:source.inventory.accounts.slice(0,1)},entries:source.entries.slice(0,1)})
 globalThis.fetch=async()=>assert.fail('invalid edit must not query market')
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('invalid edit must not apply'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument('B');await setInput(field('歷史日期'),'2026-09-01');await setInput(field('合成基底帳戶 B · TWD · TWD 當日數量'),'5');await click(button('取得歷史估值'))
 assert.match(document.querySelector('.quantity-editor [role="alert"]').textContent,/帳戶不在.*沿用持倉回補差異.*不必刪除/)
 await click(button('取消歷史編輯'));await click(historyItem('2026-09-01'));await setInput(field('合成基底帳戶 A · TWD · TWD 當日數量'),'');await click(button('取得歷史估值'))
 assert.match(document.querySelector('.quantity-editor [role="alert"]').textContent,/數量不可留空.*填 0/)
})
test('review: baseline dirty close and preview Escape require confirmation, preserve drafts when declined, restore focus when accepted',async()=>{
 const data=baselineFixture();let prompts=0,allow=false;globalThis.confirm=()=>{prompts++;return allow}
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('cancel must not apply'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('沿用持倉回補差異'));await click(button('取消回補'));assert.equal(prompts,0);assert.equal(document.activeElement,button('沿用持倉回補差異'))
 await startBaseline();await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'300');await click(button('取消回補'));assert.equal(prompts,1);assert.equal(field('合成基底帳戶 A · TWD 目的日數量').value,'300')
 const escape=async(target,extra={})=>act(()=>target.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,...extra})))
 await escape(field('持倉基底來源'));await escape(field('回補目的日期'));await escape(field('合成基底帳戶 A · TWD 目的日數量'),{isComposing:true});assert.equal(prompts,1)
 await click(baselineConfirm());await click(button('預覽回補差異'));await escape(document.querySelector('.baseline-editor h4'));assert.equal(prompts,2);assert.ok(button('儲存完整回補'))
 allow=true;await escape(document.querySelector('.baseline-editor h4'));assert.equal(prompts,3);assert.equal(document.querySelector('.baseline-editor'),null);assert.equal(document.activeElement,button('沿用持倉回補差異'))
 await click(button('沿用持倉回補差異'));assert.equal(field('持倉基底來源').value,'');await click(button('取消回補'));assert.equal(prompts,3)
})
test('review: full-list date editor restores date-row and nested-item focus, and only changed drafts prompt',async()=>{
 const data=baselineFixture();data.history.quantityDays[0].entries=data.history.quantityDays[0].entries.slice(0,1)
 let prompts=0,allow=false;globalThis.confirm=()=>{prompts++;return allow}
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('cancel must not apply'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button('編輯數量 2026-10-09'));await click(button('取消回補'));assert.equal(prompts,0);assert.equal(document.activeElement,button('編輯數量 2026-10-09'))
 await click(button('編輯數量 2026-10-09'));await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'300');await click(button('取消回補'));assert.equal(prompts,1);assert.equal(field('合成基底帳戶 A · TWD 目的日數量').value,'300')
 allow=true;await click(button('取消回補'));assert.equal(prompts,2);assert.equal(document.activeElement,button('編輯數量 2026-10-09'))
 await click(button('編輯這項數量'));await click(button('取消歷史編輯'));assert.equal(prompts,2);assert.equal(document.activeElement,button('編輯這項數量'));assert.equal(document.activeElement.closest('details').open,true)
})

test('ordinary preview requires scope confirmation, can zero a source fill, preserves raw null and cancels without writes',async()=>{
 const data=historicalFixture(),date='2026-09-01'
 data.accounts.push({...data.accounts[0],id:'b',name:'來源補入帳戶',positions:[{id:'b',type:'cash',symbol:'',currency:'TWD',quantity:55,price:1}]})
 const a={accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:7}
 const unknown={...a,accountId:'old',account:'原有未知帳戶',quantity:null}
 data.history.quantityDays=[{date,updatedAt:date+'T12:00:00Z',sparse:true,entries:[a,unknown]}]
 let current,writes=0
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:true,busy:false,onChange:next=>{writes++;setValue(next)},onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);await click(historyItem(date,a.account));assert.ok(document.querySelector('input[inputmode="decimal"]'),document.querySelector('.quantity-editor')?.textContent);await setInput(document.querySelector('input[inputmode="decimal"]'),'11');await click(button('取得歷史估值'))
 assert.match(document.querySelector('.quantity-editor').textContent,/補齊來源/)
 assert.match(document.querySelector('.quantity-editor').textContent,/保留未知/)
 assert.match(document.querySelector('.quantity-editor').textContent,/來源補入：55/)
 await click(button('儲存歷史數量'));assert.equal(writes,0);assert.match(document.querySelector('[role="alert"]').textContent,/請確認/)
 const zero=[...document.querySelectorAll('.quantity-editor label')].find(l=>l.textContent.includes('目的日未持有')).querySelector('input')
 await click(zero);assert.match(document.querySelector('.quantity-editor').textContent,/來源補入：0/)
 assert.equal(current.history.quantityDays[0].completion,undefined)
 let prompts=0;globalThis.confirm=()=>{prompts++;return false}
 await act(()=>document.querySelector('.quantity-editor').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 assert.equal(prompts,1);assert.ok(document.querySelector('.quantity-editor'));assert.equal(writes,0)
 await confirmCompletion();await click(button('儲存歷史數量'))
 assert.equal(writes,1);assert.equal(current.history.quantityDays[0].completion.entries[0].quantity,0)
 assert.equal(current.history.quantityDays[0].entries.find(e=>e.accountId==='old').quantity,null)
 assert.equal(document.activeElement,historyItem(date))
})
test('daily manual removal confirms restore semantics and preserves the original snapshot',async()=>{
 const data=historicalFixture(),date='2026-09-01'
 data.history.snapshots=[{date,at:date+'T12:00:00Z',total:123,accounts:[{id:'history-account',name:'合成歷史帳戶',value:123}],categories:{股票:123}}]
 data.history.quantityDays=[{date,updatedAt:date+'T12:00:00Z',sparse:true,entries:[{accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:5}]}]
 let current,message
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:true,busy:false,onChange:setValue,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);globalThis.confirm=text=>{message=text;return false}
 await click(button(`移除補登 ${date}`));assert.equal(current.history.quantityDays.length,1);assert.match(message,/恢復原始快照/);assert.match(message,/後續日期/)
 globalThis.confirm=()=>true;await click(button(`移除補登 ${date}`));assert.equal(current.history.quantityDays.length,0);assert.deepEqual(current.history.snapshots,data.history.snapshots)
 const row=[...document.querySelectorAll('section.daily tr')].find(r=>r.textContent.includes('2026/09/01'))
 assert.match(row.textContent,/原始快照/);assert.match(row.textContent,/123/)
})
test('daily removal without a snapshot restores periods or removes the day; period row manages without deleting',async()=>{
 const date=new Date(Date.now()-86400000).toISOString().slice(0,10),data=historicalFixture()
 const entry={accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:5}
 data.history.quantityDays=[{date,updatedAt:date+'T12:00:00Z',sparse:true,entries:[entry]}]
 data.history.holdingPeriods=[{...entry,id:'period',start:date,quantity:10,updatedAt:date+'T12:00:00Z',timeZone:'UTC'}]
 let current,message
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:true,busy:false,onChange:setValue,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);globalThis.confirm=text=>{message=text;return true}
 await click(button(`移除補登 ${date}`));assert.match(message,/依剩餘期間重新推算/);assert.equal(current.history.holdingPeriods.length,1)
 const row=[...document.querySelectorAll('section.daily tr')].find(r=>r.textContent.includes(date.replaceAll('-','/')))
 assert.match(row.textContent,/期間推算/);assert.match(row.textContent,/10/);assert.equal(button(`移除補登 ${date}`),undefined)
 await click(button('管理持有期間'));assert.ok(document.querySelector('[data-period-management]').open);assert.equal(current.history.holdingPeriods.length,1)
 await click(button(`移除期間 ${date}`));assert.equal(current.history.holdingPeriods.length,0)
 assert.equal([...document.querySelectorAll('section.daily tr')].some(r=>r.textContent.includes(date.replaceAll('-','/'))),false)
})


test('unsaved account drafts cannot be uploaded by any history page action',async()=>{
 window.history.replaceState(null,'','/accounts/history-account')
 const data=historicalFixture(),h=await server.ssrLoadModule('/src/history.ts')
 data.accounts[0].kind='bank'
 data.history.snapshots=[h.snapshotOf(data,new Date().toISOString())]
 const drive=setupDrive(data);await render(App)
 const balance=document.querySelector('[aria-label="TWD 餘額"]')
 await act(async()=>balance.focus());await setInput(balance,'9000');await act(async()=>balance.blur())
 await act(async()=>{window.history.pushState(null,'','/history');window.dispatchEvent(new PopStateEvent('popstate'))})
 assert.equal(button('＋ 補登歷史數量').disabled,true)
 assert.equal(button('沿用持倉回補差異').disabled,true)
 assert.match(document.body.textContent,/請先儲存或捨棄其他未儲存修改/)
 await click(button('＋ 補登歷史數量'));assert.equal(document.querySelector('dialog'),null)
 assert.equal(drive.writes,0);assert.ok(button('儲存變更'))
 await click(button('儲存變更'))
 assert.equal(drive.writes,0);assert.ok(document.querySelector('dialog[open]'))
 assert.match(document.querySelector('dialog').textContent,/50|9000|9,000/)
})

test('a background save starting after the history modal opens disables submit without closing the draft',async()=>{
 const data=historicalFixture();let writes=0
 const props={data,onChange:()=>writes++,onSave:()=>{},onOpenAccount:()=>{},dirty:false,busy:false}
 await render(HistoryView,props);await click(button('＋ 補登歷史數量'));await chooseHistoryInstrument()
 await setInput(field('歷史日期'),'2025-10-04');await setInput(field('合成歷史帳戶 · TWD · TWD 當日數量'),'100')
 await click(button('取得歷史估值'));await confirmCompletion()
 await render(HistoryView,{...props,busy:true})
 assert.equal(button('儲存歷史數量').disabled,true)
 await click(button('儲存歷史數量'))
 assert.equal(writes,0);assert.ok(document.querySelector('dialog[open]'))
 assert.equal(button('取消歷史編輯').disabled,false)
 await render(HistoryView,props);await click(button('儲存歷史數量'))
 assert.equal(writes,1);assert.equal(document.querySelector('dialog'),null)
})

test('homepage browses snapshots and links to their history sources without edit controls',async()=>{
 const data=historicalFixture()
 data.history.snapshots=[{date:'2026-09-01',at:'2026-09-01T12:00:00Z',total:100,accounts:[{id:'history-account',name:'合成歷史帳戶',value:100}],categories:{股票:100}},
 {date:'2026-09-02',at:'2026-09-02T12:00:00Z',total:200,accounts:[],categories:{},liabilityTotal:0,netWorth:200},
 {date:'2026-09-03',at:'2026-09-03T12:00:00Z',total:200,accounts:[],categories:{},liabilityTotal:null,netWorth:null}]
 let requestedDate
 await render(Overview,{data,onGoHistory:date=>{requestedDate=date}})
 await setInput(document.querySelector('input[type="range"]'),'0')
 assert.match(document.querySelector('[aria-label="總負債"]').textContent,/未記錄（以 0 計）/)
 assert.match(document.querySelector('[aria-label="淨資產"]').textContent,/NT\$ 100/)
 await selectValue('選擇時間節點','2026-09-02')
 assert.match(document.querySelector('[aria-label="總負債"]').textContent,/NT\$ 0/)
 assert.doesNotMatch(document.querySelector('[aria-label="總負債"]').textContent,/未記錄/)
 await selectValue('選擇時間節點','2026-09-03')
 assert.match(document.querySelector('[aria-label="總負債"]').textContent,/資料不完整/)
 assert.ok(button('依帳戶'));assert.ok(button('依類別'))
 await click(button('查看這天的明細'));assert.equal(requestedDate,'2026-09-03')
 assert.equal(button('＋ 補登歷史數量'),undefined)
 assert.equal(document.querySelector('[aria-label="每日紀錄"]'),null)
 assert.doesNotMatch(document.body.textContent,/歷史管理與異動紀錄/)
 await click(button('回到目前'));assert.match(document.querySelector('.hero-figure').textContent,/900/)
})


test('today manual point and live balance remain selectable without duplicate dates in the trend',async()=>{
 const data=historicalFixture(),now=new Date().toISOString()
 const h=await server.ssrLoadModule('/src/history.ts'),today=h.localDate(now)
 data.history.quantityDays=[{date:today,updatedAt:now,entries:[{accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:7}]}]
 const previousObserver=globalThis.ResizeObserver
 globalThis.ResizeObserver=class{constructor(callback){this.callback=callback}observe(){this.callback([{contentRect:{width:400}}])}disconnect(){}}
 try{
  await render(Overview,{data})
  assert.equal(document.querySelectorAll('circle.dot').length,1)
  assert.match(document.querySelector('.hero-figure').textContent,/900/)
  await selectValue('選擇時間節點',today)
  assert.match(document.querySelector('[aria-label="快照總資產"]').textContent,/NT\$ 7/)
  assert.equal(document.querySelectorAll('circle.dot').length,1)
 }finally{globalThis.ResizeObserver=previousObserver}
})

test('homepage source link opens the selected date on the dedicated history page and restoring the overview route removes history management',async()=>{
 window.history.replaceState(null,'','/')
 const data=historicalFixture(),h=await server.ssrLoadModule('/src/history.ts')
 data.history.snapshots=[{date:'2026-09-01',at:'2026-09-01T12:00:00Z',total:100,accounts:[{id:'history-account',name:'合成歷史帳戶',value:100}],categories:{股票:100}},h.snapshotOf(data,new Date().toISOString())]
 const drive=setupDrive(data);await render(App)
 await selectValue('選擇時間節點','2026-09-01');await click(button('查看這天的明細'))
 assert.equal(window.location.pathname,'/history/2026-09-01')
 assert.equal(field('明細日期').value,'2026-09-01')
 const sources=document.querySelector('[aria-label="快照資料明細"]')
 assert.match(sources.textContent,/合成歷史帳戶.*100/)
 assert.match(sources.textContent,/原始每日快照/)
 assert.match(sources.textContent,/無法還原/)
 assert.ok(button('編輯數量 2026-09-01'))
 assert.equal(drive.writes,0)
 await act(async()=>{window.history.replaceState(null,'','/');window.dispatchEvent(new PopStateEvent('popstate'))})
 assert.ok(document.querySelector('[aria-label="資產時間線"]'))
 assert.equal(document.querySelector('[aria-label="每日紀錄"]'),null)
})

test('history source details use the overview quantity valuation, show Yahoo price provenance and edit only that source',async()=>{
 const data=historicalFixture(),date='2026-09-01'
 data.accounts[0].positions=[{id:'test',type:'holding',symbol:'TEST',currency:'TWD',quantity:900,price:1}]
 const entry={accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'holding',symbol:'TEST',currency:'TWD',quantity:2}
 data.history.quantityDays=[{date,updatedAt:date+'T12:00:00Z',inventory:{accounts:[{id:entry.accountId,name:entry.account}],source:{kind:'current',date:'2026-10-01'}},entries:[entry]}]
 globalThis.fetch=async()=>Response.json({symbol:'TEST',currency:'TWD',asTraded:true,splits:[],points:[{date:'2026-08-31',close:10}]})
 await render(HistoryView,{data,initialDate:date,dirty:false,busy:false,onChange:()=>assert.fail('opening or cancel must not write'),onSave:()=>{},onOpenAccount:()=>{}})
 const sources=document.querySelector('[aria-label="快照資料明細"]')
 assert.match(sources.textContent,/總資產 NT\$ 20/)
 assert.match(sources.textContent,/持倉清單來源：2026-10-01/)
 assert.match(sources.textContent,/數量 2/)
 assert.match(sources.textContent,/Yahoo TEST · 2026-08-31 收盤 10 TWD/)
 assert.match(sources.textContent,/TWD 匯率 1/)
 await click(button('編輯來源數量'))
 assert.equal(field('合成歷史帳戶 · TEST · TWD 當日數量').value,'2')
 assert.equal(field('歷史日期').value,date)
 await click(button('取消歷史編輯'));assert.equal(document.activeElement,button('編輯來源數量'))
 await render(Overview,{data})
 await selectValue('選擇時間節點',date)
 assert.match(document.querySelector('[aria-label="快照總資產"]').textContent,/NT\$ 20/)
 assert.equal(button('編輯來源數量'),undefined)
})

test('history source details include projected period holdings and daily detail buttons select the corresponding sources',async()=>{
 const data=historicalFixture(),h=await server.ssrLoadModule('/src/history.ts')
 const date=h.localDate(new Date(Date.now()-86400000).toISOString())
 data.history.holdingPeriods=[{id:'source-period',accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:10,start:date,updatedAt:date+'T12:00:00Z',timeZone:'UTC'}]
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('viewing sources must not write'),onSave:()=>{},onOpenAccount:()=>{}})
 await click(button(`查看明細 ${date}`))
 assert.equal(field('明細日期').value,date)
 const sources=document.querySelector('[aria-label="快照資料明細"]')
 assert.match(sources.textContent,/持有期間推算/)
 assert.match(sources.textContent,/數量 10/)
 assert.match(sources.textContent,/NT\$ 10/)
 assert.equal(document.activeElement,sources)
 assert.ok(button('編輯來源數量'))
})

test('timeline previous and next controls move through snapshots and stop at either boundary',async()=>{
 const data=historicalFixture()
 data.history.snapshots=[{date:'2026-09-01',at:'2026-09-01T12:00:00Z',total:100,accounts:[],categories:{}}]
 await render(Overview,{data})
 assert.ok(button('上一筆快照'))
 assert.equal(button('下一筆快照').disabled,true)
 await click(button('上一筆快照'))
 assert.equal(button('上一筆快照').disabled,true)
 assert.match(document.querySelector('[aria-label="快照總資產"]').textContent,/NT\$ 100/)
 assert.equal(field('選擇時間節點').value,'2026-09-01')
 await click(button('下一筆快照'))
 assert.equal(field('選擇時間節點').value,'current')
 assert.match(document.querySelector('.hero-figure').textContent,/900/)
})

test('daily record icons keep accessible names and editing restores focus to its date row',async()=>{
 const data=historicalFixture(),date='2026-09-01'
 data.history.quantityDays=[{date,updatedAt:date+'T12:00:00Z',entries:[{accountId:'history-account',account:'合成歷史帳戶',category:'股票',country:'TW',type:'cash',symbol:'',currency:'TWD',quantity:100}]}]
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>assert.fail('opening or cancel must not save'),onSave:()=>{},onOpenAccount:()=>{}})
 const actions=[...document.querySelectorAll('section.daily .daily-action-group button')]
 assert.ok(actions.length)
 for(const action of actions){assert.equal(action.textContent.trim(),'');assert.ok(action.getAttribute('aria-label'));assert.ok(action.title);assert.equal(action.querySelector('svg').getAttribute('aria-hidden'),'true')}
 await click(button(`查看明細 ${date}`));assert.equal(field('明細日期').value,date)
 const edit=button(`編輯數量 ${date}`)
 await click(edit);assert.equal(field('合成歷史帳戶 · TWD 目的日數量').value,'100')
 await click(button('取消回補'));assert.equal(document.activeElement,edit)
})


test('accounts reject duplicate name and country while allowing another country and unchanged edits',async()=>{
 const data=historicalFixture();data.accounts[0].name='HSBC';data.accounts[0].country='TW'
 const props={data,setView:()=>{},onBack:()=>{},onRefreshPrices:async()=>{},priceError:'',onChange:()=>assert.fail('duplicate must not save')}
 await render(Accounts,{...props,view:{page:'new'}})
 await setInput(field('帳戶名稱'),' hsbc ')
 assert.equal(button('建立帳戶').disabled,true)
 assert.match(document.querySelector('[role="alert"]').textContent,/同名帳戶/)
 await act(async()=>{field('國家').value='SG';field('國家').dispatchEvent(new Event('change',{bubbles:true}))})
 assert.equal(button('建立帳戶').disabled,false)
 await render(Accounts,{...props,key:'edit',view:{page:'edit',id:data.accounts[0].id}})
 assert.equal(button('儲存').disabled,false)
})

test('same-name accounts show countries in history and overview and open the correct account',async()=>{
 const data=historicalFixture(),a=data.accounts[0]
 data.accounts=[{...a,name:'HSBC',country:'TW'},{...a,id:'sg-account',name:'HSBC',country:'SG'}]
 await render(HistoryView,{data,dirty:false,busy:false,onChange:()=>{},onSave:()=>{},onOpenAccount:()=>{}})
 assert.match(document.querySelector('.snapshot-accounts').textContent,/HSBC \(TW\)/)
 assert.match(document.querySelector('.snapshot-accounts').textContent,/HSBC \(SG\)/)
 let opened
 await render(Overview,{data,onOpenAccount:id=>{opened=id}})
 const rows=[...document.querySelectorAll('.rank button')]
 assert.equal(rows.length,2)
 await click(rows.find(b=>b.textContent.includes('HSBC (SG)')))
 assert.equal(opened,'sg-account')
})


test('raw snapshot date editing opens the full list with destination prefilled and preserves the original snapshot',async()=>{
 const data=baselineFixture(),date='2026-09-01'
 data.history.snapshots=[{date,at:date+'T12:00:00Z',total:500,accounts:[{id:'A',name:'合成基底帳戶 A',value:500}],categories:{其他:500}}]
 let current
 function Harness(){const [value,setValue]=useState(data);useEffect(()=>{current=value},[value]);return createElement(HistoryView,{data:value,dirty:false,busy:false,onChange:setValue,onSave:()=>{},onOpenAccount:()=>{}})}
 await render(Harness);await click(button(`編輯數量 ${date}`))
 assert.ok(document.querySelector('.baseline-editor'));assert.equal(field('回補目的日期').value,date)
 assert.equal(document.querySelectorAll('.baseline-account input').length,5)
 await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'300')
 await click(baselineConfirm());await click(button('預覽回補差異'));await click(baselineConfirm());await click(button('儲存完整回補'))
 assert.deepEqual(current.history.snapshots,data.history.snapshots);assert.deepEqual(current.accounts,data.accounts)
 assert.deepEqual(current.history.quantityDays.find(d=>d.date===date).entries.map(e=>e.quantity),[300,2,0,3,4])
})

test('complete backfill date editing uses the same full-list editor and keeps its provenance',async()=>{
 const data=baselineFixture(),date='2026-10-09',before=data.history.quantityDays[0]
 let current
 await render(HistoryView,{data,dirty:false,busy:false,onChange:next=>{current=next},onSave:()=>{},onOpenAccount:()=>{}})
 await click(button(`編輯數量 ${date}`));assert.ok(document.querySelector('.baseline-editor'))
 assert.equal(field('回補目的日期').value,date);assert.equal(field('合成基底帳戶 A · TWD 目的日數量').value,'100')
 await setInput(field('合成基底帳戶 A · TWD 目的日數量'),'150')
 await click(baselineConfirm());await click(button('預覽回補差異'));await click(baselineConfirm());await click(button('儲存完整回補'))
 assert.deepEqual(current.history.quantityDays[0].inventory,before.inventory)
 assert.deepEqual(current.history.quantityDays[0].entries.map(e=>e.quantity),[150,2,0,3,4]);assert.deepEqual(current.accounts,data.accounts)
})


test('public home and legal pages need no sign-in and legal pages do not restore Drive sessions', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('public pages must not fetch account or Drive data') }
  for (const path of ['/', '/privacy', '/terms', '/disclaimer', '/app']) {
    if (root) { await act(() => root.unmount()); root = null }
    auth.clearSession()
    if (path === '/privacy') auth.storeSession({ token, profile })
    window.history.replaceState(null, '', path)
    await render(App)
    assert.ok(document.querySelector('footer a[href="/privacy"]'))
    assert.ok(document.querySelector('footer a[href="/terms"]'))
    assert.equal(document.querySelectorAll('script[src*="accounts.google.com"]').length, 0)
    assert.equal(document.querySelector('.topbar'), null)
    assert.equal(calls, 0, path)
    if (path === '/' || path === '/app') assert.ok(button('使用 Google 登入'))
    else assert.ok(document.querySelector('.legal article'))
  }
})

test('restored home session moves to /app without replacing a protected deep link', async () => {
  window.history.replaceState(null, '', '/')
  setupDrive(fixture())
  await render(App)
  assert.equal(window.location.pathname, '/app')
  assert.ok(document.querySelector('.topbar'))
  await act(async () => { window.history.replaceState(null, '', '/history'); window.dispatchEvent(new PopStateEvent('popstate')) })
  assert.equal(window.location.pathname, '/history')
  assert.ok(document.querySelector('section.daily'))
})

test('expense edits use existing save flow and preserve assets; cancelled imports write nothing', async () => {
  const expense = {id:'expense-a',date:'2026-09-01',description:'Synthetic shop',amount:100,currency:'TWD',card:'Synthetic card'}
  const data = {...fixture(),version:10,expenses:[expense]}
  window.history.replaceState(null,'','/expenses')
  const drive = setupDrive(data)
  await render(App)
  await click(button('編輯消費 2026-09-01 Synthetic shop'))
  await setInput(document.querySelector('input[type="number"]'),'120')
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  assert.match(document.querySelector('table').textContent,/120/)
  await click(button('儲存變更'))
  assert.equal(drive.uploaded.version,10)
  assert.equal(drive.uploaded.expenses[0].amount,120)
  assert.deepEqual(drive.uploaded.accounts,data.accounts)
  assert.equal(drive.uploaded.password,undefined)
  await drive.finish()
  await click(button('匯入信用卡帳單'))
  await setInput(document.querySelector('input[type="password"]'),'synthetic-secret')
  await click(button('取消匯入'))
  assert.equal(document.querySelector('input[type="password"]'),null)
  assert.equal(drive.writes,1)
  assert.equal(localStorage.getItem('synthetic-secret'),null)
})

test('legacy unknown merchants remain readable but cannot be saved unchanged',async()=>{
  const description='商家未能辨識（請對照帳單填寫；可能包含繳款）'
  const data={...fixture(),version:10,expenses:[{id:'unknown',date:'2026-09-01',description,amount:100,currency:'TWD',card:'HSBC'}]}
  window.history.replaceState(null,'','/expenses')
  const drive=setupDrive(data)
  await render(App)
  await click(button(`編輯消費 2026-09-01 ${description}`))
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  assert.match(document.querySelector('[role="alert"]').textContent,/可辨識的商家/)
  assert.equal(drive.writes,0)
  await setInput(document.querySelector('input[maxlength="500"]'),'Corrected shop')
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  assert.match(document.querySelector('table').textContent,/Corrected shop/)
})

test('statement privacy disclosure notifies users who saw the previous policy',async()=>{
  localStorage.setItem('wealthline.privacySeen','2026-10-10')
  setupDrive(fixture())
  await render(App)
  assert.ok(button('知道了'))
  await click(button('知道了'))
  assert.equal(localStorage.getItem('wealthline.privacySeen'),'2026-10-11')
})

test('oversized statement is rejected before file reading or PDF loading, and password is cleared',async()=>{
  window.history.replaceState(null,'','/expenses')
  const drive = setupDrive(fixture())
  await render(App)
  await click(button('匯入信用卡帳單'))
  const input = document.querySelector('input[type="file"]')
  Object.defineProperty(input,'files',{value:[{size:21*1024*1024,arrayBuffer:()=>assert.fail('must reject before reading')}]})
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})))
  await setInput(document.querySelector('input[type="password"]'),'synthetic-password')
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  assert.match(document.querySelector('[aria-label="各帳單解析結果"]').textContent,/20 MB/)
  assert.equal(document.querySelector('input[type="password"]').value,'')
  assert.equal(drive.writes,0)
})


test('securities statement is rejected before reading even when password protected',async()=>{
  window.history.replaceState(null,'','/expenses')
  const drive=setupDrive(fixture())
  await render(App)
  await click(button('匯入信用卡帳單'))
  const input=document.querySelector('input[type="file"]')
  Object.defineProperty(input,'files',{value:[{name:'台新證券綜合月對帳單.pdf',size:100,arrayBuffer:()=>assert.fail('securities file must not be read')}]})
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})))
  await setInput(document.querySelector('input[type="password"]'),'synthetic-password')
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  assert.match(document.querySelector('[aria-label="各帳單解析結果"]').textContent,/證券對帳單不支援/)
  assert.equal(document.querySelector('input[type="password"]').value,'')
  assert.equal(drive.writes,0)
})


test('multiple file import isolates failures and leaves financial data untouched',async()=>{
  window.history.replaceState(null,'','/expenses')
  const drive=setupDrive(fixture())
  await render(App)
  await click(button('匯入信用卡帳單'))
  const input=document.querySelector('input[type="file"]')
  assert.equal(input.multiple,true)
  Object.defineProperty(input,'files',{value:[
    {name:'證券月報.pdf',size:100,arrayBuffer:()=>assert.fail('must reject securities')},
    {name:'huge.pdf',size:21*1024*1024,arrayBuffer:()=>assert.fail('must reject oversized')},
    {name:'invalid.pdf',size:10,arrayBuffer:async()=>new TextEncoder().encode('invalid').buffer},
  ]})
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})))
  await setInput(document.querySelector('input[type="password"]'),'first,second')
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  const results=document.querySelector('[aria-label="各帳單解析結果"]')
  assert.equal(results.querySelectorAll('li').length,3)
  assert.match(results.textContent,/證券對帳單不支援/)
  assert.match(results.textContent,/20 MB/)
  assert.match(results.textContent,/有效的 PDF/)
  assert.equal(document.querySelector('input[type="password"]').value,'')
  assert.equal(drive.writes,0)
})
