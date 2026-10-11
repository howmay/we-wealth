import { useEffect, useReducer, useRef, useState } from 'react'
import {
  clearSession,
  fetchProfile,
  isFresh,
  loadSession,
  requestAccessToken,
  renewAccessToken,
  revokeAccessToken,
  storeSession,
  type AccessToken,
  type UserProfile,
} from './google/auth'
import { DATA_FILE_NAME, FOLDER_NAME, loadData, saveData, type DriveFile, type DriveVersion } from './google/drive'
import { applyFetchedRates, emptyData, missingRates, parseWealthData, ratesStale, usedCurrencies, type WealthData } from './model'
import { finishSave } from './saveState'
import { clearLocal, downloadDataFile, hasLocalData, loadLocal, opensLocal, readDataFile, replaceLocal, saveLocal, setLocalActive, type LocalFile } from './localStore'
import { localDate, pendingChanges, pendingLiabilityChanges, recordSave, revertChange, revertLiabilityChange } from './history'
import { applyQuotes, fetchHoldingQuotes } from './quotes'
import { fetchRates } from './rates'
import { Accounts, type AccountsView } from './views/Accounts'
import { Liabilities } from './views/Liabilities'
import { Expenses } from './views/Expenses'
import { Overview } from './views/Overview'
import { HistoryView } from './views/History'
import { Rates } from './views/Rates'
import { SaveReview } from './views/SaveReview'
import { Landing } from './views/Landing'
import { Opening, type OpeningStep } from './views/Opening'
import { LegalPage } from './views/Legal'
import { PAGES, goBack, navigate, usePage, usePath } from './site'
import { TABS, parseRoute, routePath, tabPath, type Route, type Tab } from './routes'
import { Link, Logo, PrivacyNotice, SiteFooter } from './views/Site'
import { DeviceIcon, UploadButton } from './views/LocalData'

type Status = { kind: 'idle' } | { kind: 'busy'; text: string } | { kind: 'error'; text: string }

export default function App() {
  const token = useRef<AccessToken | null>(null)
  const driveVersion = useRef<DriveVersion | undefined>(undefined)
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const editVersion = useRef(0)
  const sessionVersion = useRef(0)
  // The version last read from or written to Drive; each save records what changed since it.
  const saved = useRef<WealthData | null>(null)
  const [user, setUser] = useState<UserProfile | null>(null)
  // Local mode: no sign-in, the data file is kept in this browser (localStore.ts). The ref is for
  // background tasks started before the state re-renders; `localRaw` is the stored text this tab last read or wrote.
  // A tab keeps the mode it chose itself; otherwise a live Google session in the tab wins over
  // the flag other tabs share (see opensLocal).
  const [local, setLocal] = useState(() => opensLocal(!!loadSession()?.token))
  const localMode = useRef(local)
  const localRaw = useRef<string | null>(null)
  // The home page reads whether local data exists on render; this re-renders it after a delete.
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [data, setData] = useState<WealthData | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // Edits to balances or holdings are shown for review before they become history.
  const [reviewing, setReviewing] = useState(false)
  const [ratesError, setRatesError] = useState('')
  const [priceError, setPriceError] = useState('')
  // A previous session whose token has expired: offer one-click resume as this account.
  const [returning, setReturning] = useState<UserProfile | null>(() => loadSession()?.profile ?? null)
  // Between getting a token and showing the app. A reload with a live token starts here,
  // so the signed-out page never flashes before the app.
  const [opening, setOpening] = useState<{ step: OpeningStep; profile?: UserProfile } | null>(() =>
    loadSession()?.token && !opensLocal(true) ? { step: 'auth' } : null,
  )
  // Prices and rates being fetched after the data file has loaded.
  const [refreshing, setRefreshing] = useState(false)
  // The notice pages are open to everyone; the app's own state stays mounted behind them.
  const page = usePage()
  // Every page of the signed-in app has its own URL, so back and forward move between them.
  const path = usePath()
  const route = parseRoute(path)
  const tab = route.tab

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Renew on save, verifying the account before any Drive write.
  async function validToken(): Promise<AccessToken> {
    if (!token.current || !isFresh(token.current)) {
      if (!user) throw new Error('請先登入')
      token.current = await renewAccessToken(user)
      storeSession({ profile: user, token: token.current })
    }
    return token.current
  }

  async function run(text: string, task: () => Promise<void>) {
    setStatus({ kind: 'busy', text })
    try {
      await task()
      setStatus({ kind: 'idle' })
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    }
  }

  async function openSession(t: AccessToken) {
    setOpening({ step: 'auth' })
    let p: UserProfile
    let file: DriveFile<WealthData> | null
    try {
      p = await fetchProfile(t)
      setOpening({ step: 'drive', profile: p })
      file = await loadData(t, parseWealthData)
    } finally {
      setOpening(null)
    }
    token.current = t
    storeSession({ profile: p, token: t })
    setUser(p)
    driveVersion.current = file ? { fileId: file.fileId, etag: file.etag } : undefined
    startSession(file?.data ?? null)
  }

  // Opens local mode with the data stored in this browser, or with `file` (an upload just
  // stored). Throws, without entering local mode, when the stored data does not parse.
  function openLocal(file: LocalFile | null = loadLocal()) {
    setLocalActive(true)
    localMode.current = true
    localRaw.current = file?.raw ?? null
    setLocal(true)
    startSession(file?.data ?? null)
  }

  // Shows the loaded data file (null: none yet) and refreshes its prices and rates.
  function startSession(file: WealthData | null) {
    const version = ++sessionVersion.current
    saved.current = file
    const loaded = file ?? emptyData()
    setData(loaded)
    setDirty(false)
    setRefreshing(true)
    void refreshMarket(loaded)
      .then((market) => {
        if (version === sessionVersion.current) setRefreshing(false)
        return market && recordToday(market)
      })
      .catch(() => version === sessionVersion.current && setRefreshing(false))
  }

  // Updates holding prices, then exchange rates (new quotes can bring new currencies).
  // Like rates, prices stay in memory until the next save. Returns `from` with the
  // new prices and rates, or null when the user signed out meanwhile.
  async function refreshMarket(from: WealthData): Promise<WealthData | null> {
    const version = sessionVersion.current
    const { quotes, failed } = await fetchHoldingQuotes(from)
    if (version !== sessionVersion.current) return null
    const at = new Date().toISOString()
    setData((d) => (d ? applyQuotes(d, quotes, at) : d))
    setPriceError(failed.length ? `找不到 ${failed.join('、')} 的報價，可以點價格手動輸入。` : '')
    const withQuotes = applyQuotes(from, quotes, at)
    return ratesStale(withQuotes) ? refreshRates(withQuotes) : withQuotes
  }

  // Updates exchange rates in the background. The new rates are kept in memory and
  // written to Drive with the next save (or today's first record), so opening the app never leaves unsaved changes.
  async function refreshRates(from: WealthData): Promise<WealthData | null> {
    const version = sessionVersion.current
    setRatesError('')
    try {
      const r = await fetchRates(usedCurrencies(from))
      if (version !== sessionVersion.current) return null
      setData((d) => (d ? applyFetchedRates(d, r.rates, r.updatedAt) : d))
      if (r.unsupported.length) setRatesError(`找不到 ${r.unsupported.join('、')} 的匯率，請手動輸入。`)
      return applyFetchedRates(from, r.rates, r.updatedAt)
    } catch (e) {
      if (version !== sessionVersion.current) return null
      setRatesError(e instanceof Error ? e.message : String(e))
      return from
    }
  }

  // The first sign-in of the day records that day's values with fresh prices, so the
  // daily history fills in without the user having to save. Only market data changes:
  // `market` is the saved file with new prices and rates, so no edits are logged.
  async function recordToday(market: WealthData) {
    const version = sessionVersion.current
    const at = new Date().toISOString()
    const last = saved.current
    if (!last || (!market.accounts.length && !market.liabilities?.length) || dirtyRef.current || savingRef.current) return
    if (last.history.snapshots.some((s) => s.date === localDate(at)) || last.history.quantityDays?.some(d => d.date === localDate(at))) return
    // A value without its exchange rate would record a wrong day.
    if (missingRates(market).length) return
    const next = recordSave(last, { ...market, updatedAt: at })
    savingRef.current = true
    setSaving(true)
    try {
      await write(next)
      if (version !== sessionVersion.current) return
      saved.current = next
      setData((d) => d ? finishSave(d, market, next) : d)
    } catch (e) {
      if (version === sessionVersion.current) setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // Writes the data file to Drive, or to this browser in local mode.
  async function write(next: WealthData) {
    const session = sessionVersion.current
    if (localMode.current) {
      const raw = await saveLocal(next, localRaw.current)
      if (session === sessionVersion.current) localRaw.current = raw
      return
    }
    const result = await saveData(await validToken(), next, driveVersion.current)
    if (session === sessionVersion.current) driveVersion.current = result
  }

  // Restore the session after a reload while this tab's token is still valid,
  // or local mode when the user was using it.
  const restored = useRef(false)
  useEffect(() => {
    if (page || restored.current) return
    restored.current = true
    if (localMode.current) {
      void run('載入中…', async () => {
        try {
          openLocal()
        } catch (e) {
          // Unreadable stored data: back to the home page, which shows why and offers an upload.
          setLocalActive(false)
          localMode.current = false
          setLocal(false)
          throw e
        }
      })
      return
    }
    const stored = loadSession()?.token
    if (!stored) return
    void run('載入中…', async () => {
      try {
        await openSession(stored)
      } catch {
        // Token revoked or rejected: fall back to the one-click resume button.
        token.current = null
        setUser(null)
        setData(null)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  useEffect(() => {
    if ((user || local) && path === '/') navigate('/app', { replace: true })
  }, [user, local, path])

  const signIn = () =>
    run('登入中…', async () => {
      await openSession(await requestAccessToken('select_account'))
    })

  const resume = () =>
    run('登入中…', async () => {
      if (!returning) return
      const t = await requestAccessToken('', returning.email)
      // The user may have picked a different account in Google's dialog.
      await openSession(t)
    })

  const signOut = () =>
    run('登出中…', async () => {
      const previous = token.current
      sessionVersion.current++
      clearSession()
      token.current = null
      driveVersion.current = undefined
      saved.current = null
      setReturning(null)
      setRefreshing(false)
      setUser(null)
      setData(null)
      setDirty(false)
      setReviewing(false)
      navigate('/', { replace: true })
      // Local logout must finish even if Google's revoke request fails or hangs.
      if (previous) void revokeAccessToken(previous).catch(() => {})
    })

  const startLocal = () =>
    run('開啟中…', async () => {
      openLocal()
      navigate('/app')
    })

  // Restores a downloaded data file into this browser, replacing what is stored here.
  const upload = (file: File) =>
    run('讀取資料檔…', async () => {
      // Leaving local mode, deleting its data or opening another session meanwhile cancels the upload.
      const session = sessionVersion.current
      const current = () => session === sessionVersion.current
      const uploaded = await readDataFile(file)
      if (!current()) return
      const replacing = localMode.current ? !!saved.current || dirtyRef.current : hasLocalData()
      if (replacing && !confirm('上傳的資料檔會取代此瀏覽器中目前的資料，包括未儲存的修改。建議先下載目前的資料備份。要繼續嗎？')) return
      const raw = await replaceLocal(uploaded, current)
      if (raw === null || !current()) return
      openLocal({ data: uploaded, raw })
      navigate('/app')
    })

  // Leaves local mode, keeping the stored data for next time unless `erase` is set.
  const leaveLocal = (erase = false) => {
    const question = erase
      ? '要刪除此瀏覽器中的 Wealthline 資料嗎？刪除後無法復原，建議先下載資料檔備份。'
      : dirtyRef.current ? '有尚未儲存的修改，離開本機模式後會遺失。要繼續嗎？' : ''
    if (question && !confirm(question)) return
    // First, so an upload still being read or waiting to write is dropped (see `upload`).
    sessionVersion.current++
    setLocalActive(false)
    localMode.current = false
    localRaw.current = null
    saved.current = null
    setLocal(false)
    setRefreshing(false)
    setData(null)
    setDirty(false)
    setReviewing(false)
    setStatus({ kind: 'idle' })
    navigate('/', { replace: true })
    if (erase) {
      void clearLocal()
        .then(rerender)
        .catch((e) => setStatus({ kind: 'error', text: `資料沒有刪除：${e instanceof Error ? e.message : String(e)}` }))
    }
  }

  const persist = async (submitted: WealthData) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    const edits = editVersion.current
    const session = sessionVersion.current
    try {
      await run(localMode.current ? '儲存到此瀏覽器…' : '儲存到 Google Drive…', async () => {
        const next = recordSave(saved.current, { ...submitted, updatedAt: new Date().toISOString() })
        await write(next)
        if (session !== sessionVersion.current) return
        saved.current = next
        setData((current) => current ? finishSave(current, submitted, next) : current)
        const stillDirty = edits !== editVersion.current
        dirtyRef.current = stillDirty
        setDirty(stillDirty)
        setReviewing(false)
      })
    } finally {
      savingRef.current = false
      setSaving(false)
      // A failed save must reveal its error and backup action outside the dialog.
      setReviewing(false)
    }
  }

  const save = () => data ? persist(data) : Promise.resolve()

  const requestSave = () => {
    if (data && (pendingChanges(saved.current, data).length || pendingLiabilityChanges(saved.current, data).length)) setReviewing(true)
    else void save()
  }
  const pending = reviewing && data ? pendingChanges(saved.current, data) : []
  const pendingDebts = reviewing && data ? pendingLiabilityChanges(saved.current, data) : []
  useEffect(() => {
    if (reviewing && pending.length === 0 && pendingDebts.length === 0) setReviewing(false)
  }, [reviewing, pending.length, pendingDebts.length])

  function update(next: WealthData) {
    editVersion.current++
    dirtyRef.current = true
    setData({ ...next, version: next.version === 10 || next.expenses !== undefined ? 10 : next.version === 9 ? 9 : next.version === 8 ? 8 : next.version === 7 ? 7 : next.version === 6 ? 6 : next.version === 5 || next.history.holdingPeriods !== undefined ? 5 : next.version === 4 || next.liabilities?.some(d => d.schedule || d.basisHistory) ? 4 : next.version === 3 || next.history.quantityDays !== undefined ? 3 : 2, liabilities: next.liabilities ?? [] })
    setDirty(true)
  }

  // A newly added holding or balance can bring a currency without a rate: fetch it right away.
  const missingAuto = data ? missingRates(data).filter((c) => !data.fxManual.includes(c)).join(',') : ''
  useEffect(() => {
    if (missingAuto && data) void refreshRates(data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingAuto])

  // An account that no longer exists (deleted, or an old link) shows the account list instead.
  const missingAccount = !!data && 'id' in route && !data.accounts.some((a) => a.id === route.id)
  useEffect(() => {
    if (missingAccount) navigate('/accounts', { replace: true })
  }, [missingAccount])

  const busy = saving || status.kind === 'busy'

  const go = (r: Route, replace = false) => navigate(routePath(r), { replace })
  const goAccounts = (view: AccountsView, replace = false) => go({ tab: 'accounts', ...view }, replace)

  if (page) return <LegalPage page={page} signedIn={!!user || local} />

  if (!user && !local) {
    if (opening) return <Opening step={opening.step} profile={opening.profile} />
    return (
      <Landing
        returning={returning}
        hasLocal={hasLocalData()}
        busy={busy}
        message={status.kind === 'idle' ? null : status}
        onSignIn={signIn}
        onResume={resume}
        onLocal={startLocal}
        onUpload={upload}
      />
    )
  }

  return (
    <div className="app-enter">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Logo />
            <span className="brand-name">Wealthline</span>
          </div>
          <nav className="tabs" aria-label="分頁">
            {(Object.keys(TABS) as Tab[]).map((t) => (
              <button
                key={t}
                className={t === tab ? 'active' : ''}
                aria-current={t === tab ? 'page' : undefined}
                onClick={() => navigate(tabPath(t))}
              >
                {TABS[t]}
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            {dirty ? (
              <button className="primary save" onClick={requestSave} disabled={busy}>
                {busy ? '儲存中…' : '儲存變更'}
              </button>
            ) : refreshing || saving ? (
              <span className="refreshing" role="status">
                <span className="spinner" aria-hidden /> {saving ? '儲存中…' : '更新報價'}
              </span>
            ) : status.kind === 'error' ? (
              <span className="muted">同步未完成</span>
            ) : local ? (
              <span className="synced" title="資料存在這個瀏覽器的 localStorage">
                <span aria-hidden>✓</span> 已存在此瀏覽器
              </span>
            ) : (
              <span className="synced" title={`我的雲端硬碟 / ${FOLDER_NAME} / ${DATA_FILE_NAME}`}>
                <span aria-hidden>✓</span> 已同步
              </span>
            )}
            {user ? <details className="account-menu">
              <summary aria-label="帳號選單">
                {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{user.email[0]}</span>}
              </summary>
              <div className="menu">
                <strong>{user.name}</strong>
                <span className="muted">{user.email}</span>
                <span className="muted small">
                  資料檔：我的雲端硬碟 / {FOLDER_NAME} / {DATA_FILE_NAME}
                </span>
                <Link to={PAGES.privacy.path} className="small">
                  隱私權政策 Privacy Policy
                </Link>
                <button onClick={signOut} disabled={busy}>
                  登出
                </button>
              </div>
            </details> : <details className="account-menu">
              <summary aria-label="本機模式選單">
                <span className="avatar"><DeviceIcon /></span>
              </summary>
              <div className="menu">
                <strong>本機模式（未登入）</strong>
                <span className="muted small">資料只存在這個瀏覽器。清除網站資料、換瀏覽器或換裝置都看不到，請定期下載資料檔備份。</span>
                <button onClick={() => saved.current && downloadDataFile(saved.current)} disabled={busy || dirty || !saved.current}>
                  下載資料檔
                </button>
                {dirty ? <span className="muted small">請先儲存變更，再下載資料檔。</span> : !saved.current && <span className="muted small">儲存過資料後就能下載。</span>}
                <UploadButton onFile={upload} disabled={busy}>上傳資料檔</UploadButton>
                <Link to={PAGES.privacy.path} className="small">
                  隱私權政策 Privacy Policy
                </Link>
                <button onClick={() => leaveLocal()} disabled={saving}>
                  離開本機模式
                </button>
                <button className="danger" onClick={() => leaveLocal(true)} disabled={saving}>
                  刪除此瀏覽器中的資料
                </button>
              </div>
            </details>}
          </div>
        </div>
      </header>

      {reviewing && data && (pending.length > 0 || pendingDebts.length > 0) && (
        <SaveReview
          changes={pending}
          liabilityChanges={pendingDebts}
          onRevertLiability={(id) => update(revertLiabilityChange(saved.current, data, id))}
          busy={busy}
          canRevert={(c) => data.accounts.some((a) => a.id === c.accountId)}
          onRevert={(c) => {
            const next = revertChange(saved.current, data, c)
            if (next) update(next)
          }}
          onConfirm={save}
          onCancel={() => { if (!savingRef.current) setReviewing(false) }}
        />
      )}

      <main className="content view-enter" key={tab}>
        <PrivacyNotice />
        {status.kind === 'busy' && !data && <p className="muted">{status.text}</p>}
        {status.kind === 'error' && <div className="banner error" role="alert">
          <p>{status.text}</p>
          {data && <button onClick={() => downloadDataFile(data, 'we-wealth-local-backup.json')}>下載本機資料備份</button>}
        </div>}

        {data && tab === 'overview' && (
          <Overview
            data={data}
            onGoHistory={(date) => go(date ? { tab: 'history', date } : { tab: 'history' })}
            onGoLiabilities={() => go({ tab: 'liabilities' })}
            onGoRates={() => go({ tab: 'rates' })}
            onNewAccount={() => goAccounts({ page: 'new' })}
            onImport={() => goAccounts({ page: 'list', importing: true })}
            onOpenAccount={(id) => goAccounts({ page: 'detail', id })}
          />
        )}
        {data && route.tab === 'history' && <HistoryView key={route.date ?? 'history'} initialDate={route.date} data={data} dirty={dirty} busy={busy || dirty} onSave={requestSave}
          onChange={(next) => {
            if (savingRef.current) throw new Error('背景儲存中，請稍後再儲存歷史修改。')
            if (dirtyRef.current) throw new Error('請先儲存或捨棄其他未儲存修改，再儲存歷史。')
            update(next); void persist(next)
          }} onOpenAccount={(id) => goAccounts({ page: 'detail', id })} />}
        {data && route.tab === 'accounts' && (
          <Accounts
            data={data}
            onChange={update}
            view={route}
            setView={goAccounts}
            onBack={(fallback) => goBack(routePath({ tab: 'accounts', ...fallback }))}
            onRefreshPrices={async () => void (await refreshMarket(data))}
            priceError={priceError}
          />
        )}
        {data && tab === 'liabilities' && <Liabilities data={data} onChange={update} />}
        {data && tab === 'expenses' && <Expenses data={data} onChange={update} busy={busy} />}
        {data && tab === 'rates' && <Rates data={data} onChange={update} onRefresh={async () => void (await refreshRates(data))} error={ratesError} />}
      </main>
      <SiteFooter />
    </div>
  )
}
