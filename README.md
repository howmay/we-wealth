<p align="center">
  <img src="public/favicon.svg" width="72" height="72" alt="Wealthline 圖示" />
</p>

<h1 align="center">Wealthline</h1>

<p align="center">
  開放原始碼的個人資產統計工具：以 Google 帳號登入，<b>所有資料只存在你自己的 Google Drive</b>，清楚呈現資產配置。
</p>

<p align="center">
  🌐 <a href="https://wealthline.haomeh.com"><b>wealthline.haomeh.com</b></a>
</p>

<p align="center">
  <a href="LICENSE">PolyForm Noncommercial 1.0.0</a> ·
  <a href="LICENSE.zh-TW.md">授權說明（中文）</a> ·
  <a href="#目前支援的功能">功能</a> ·
  <a href="#規劃中的功能">規劃中</a> ·
  <a href="#本機開發">開發</a>
</p>

---

## 立即使用

打開 **<https://wealthline.haomeh.com>**，用 Google 帳號登入即可，不需要註冊或安裝。也可以不登入，直接在瀏覽器使用（本機模式）。

- 隱私權政策：<https://wealthline.haomeh.com/privacy>
- 使用條款：<https://wealthline.haomeh.com/terms>
- 免責聲明：<https://wealthline.haomeh.com/disclaimer>

## 為什麼做這個

記錄資產的工具很多，但大多要把你的帳戶與金額交給別人的伺服器。Wealthline 的做法是：

- **沒有後端資料庫**：App 是純前端網頁，作者看不到、也無法保存任何使用者資料。
- **資料在你看得到的地方**：資料是你 Google Drive 裡的一個 JSON 檔（`我的雲端硬碟 / We Wealth / we-wealth-data.json`），可以隨時開啟、下載、備份或刪除。
- **最小權限**：只要求 Google Drive 的 `drive.file` 權限，App 只能存取它自己建立的檔案，看不到你雲端硬碟中的其他東西。
- **程式碼公開供審查**：處理財務資料的程式應該讓任何人都能檢查。歡迎閱讀原始碼、開 issue 或回報問題。

## 目前支援的功能

### 登入與資料保存
- [x] 使用 Google 帳號登入（Google Identity Services），權杖只存放在目前分頁的 sessionStorage，重新整理頁面後保持登入，關閉分頁即失效；權杖過期後可一鍵以同一帳號繼續。
- [x] 資料以 JSON 檔存放在使用者自己的 Google Drive，儲存前有未儲存變更提示，關閉分頁前會提醒。
- [x] 登出時撤銷 Google 存取權杖並清除本機登入資訊。
- [x] 本機模式：不登入也能使用，資料以同樣的 JSON 格式存放在瀏覽器的 localStorage。可以下載成資料檔，之後在任何瀏覽器上傳還原；也可以一鍵刪除瀏覽器中的資料。除了報價與匯率查詢，資料不會離開瀏覽器。

### 帳戶與持倉
- [x] 先建立帳戶（銀行帳戶／投資帳戶），設定國家、幣別與資產類別。新增或編輯時，同名稱與國家不可重複（忽略大小寫與前後空白）；同名不同國家的帳戶分開展示。
- [x] 銀行帳戶記錄各幣別餘額；投資帳戶記錄可用現金與持有標的。
- [x] 新增持倉只需輸入**代號與數量**，價格、幣別與名稱自動查詢（Yahoo Finance，台股代號自動補 `.TW`，加密貨幣自動對應 `-USD`）。
- [x] 查不到報價時可手動輸入價格，手動價格會被固定、不被自動更新覆蓋。
- [x] 從既有試算表直接貼上資料列，一次匯入帳戶與匯率。

### 負債
- [x] 手動新增、編輯與刪除房貸、信貸、信用卡及其他負債，正值記錄目前未償本金／餘額。
- [x] 消費明細：信用卡文字 PDF 在前端解密、解析，可預覽修改、補登後匯入並防止重複；原始帳單與密碼不保存。第一版範圍與 v10 資料格式見 [帳單匯入說明](docs/statement-import.md)。
- [x] 填原始貸款總額、年利率、總期數與第一期還款日，依日程預估本息／本金平均攤還的剩餘本金；信用卡及舊貸款保留手動餘額模式。預估不代表銀行實際餘額，也不扣現金。
- [x] 總覽分列總資產、總負債與淨資產；負債沿用現有匯率換算，缺匯率時不顯示不完整的淨資產。
- [x] 儲存前確認負債變更並可逐筆復原；每日紀錄另存負債／淨資產，既有資產圖維持資產口徑。

### 匯率
- [x] 自動取得法幣匯率（ExchangeRate-API）與穩定幣、加密貨幣價格（CoinGecko），全部換算成新臺幣。
- [x] 可手動覆寫匯率並固定。

### 統計與圖表
- [x] 總覽：總資產、資產配置（依類別）、各帳戶、國家分布、幣別曝險。
- [x] 點選圖表中的帳戶可直接進入帳戶明細。

### 歷史紀錄
- [x] 每天保存一次資產快照（各帳戶、各類別的台幣價值），呈現資產走勢。每天第一次登入時，會用最新報價自動記下當天的快照。
- [x] 記錄每個標的的加入日期；在帳戶頁點標的代號，會用歷史收盤價、歷史匯率與異動紀錄中的數量，算出加入以來每天的台幣價值（不另外存進 Drive）。
- [x] 每次修改餘額或持倉都留下異動紀錄（修改前後的值）。
- [x] 儲存前列出本次變更供確認，變動超過 50% 會特別提醒，可以逐筆還原。
- [x] 可以刪除歷史紀錄。

### 介面與網站
- [x] 深色／淺色模式自動跟隨系統，支援手機版面。
- [x] 公開產品首頁 `/`，登入後總覽 `/app`；隱私權政策、使用條款與免責聲明頁面（`/privacy`、`/terms`、`/disclaimer`）。
- [x] App 圖示、PWA manifest 與 Apple touch icon。
- [x] SEO：`sitemap.xml`、`robots.txt`（允許搜尋引擎與 AI 爬蟲讀取公開頁面）、給 AI 助理閱讀的 `llms.txt`、各頁的 canonical 與描述、首頁的 schema.org 結構化資料；登入後的 App 頁面一律標示 `noindex`。

## 規劃中的功能

以下為預計方向，尚未排定時程，順序不代表優先度。歡迎在 [Issues](https://github.com/howmay/Wealthline/issues) 提出建議。

- [ ] **長期登入**：以伺服器端 refresh token 流程延長登入時間，不必每小時重新授權。
- [ ] **匯出報表**：匯出 CSV／Excel，或產生月度資產報告。
- [ ] **交易紀錄與損益**：記錄買賣與成本，計算已實現／未實現損益與報酬率。
- [ ] **股利與利息**：記錄配息、利息收入，統計被動收入。
- [ ] **目標配置與再平衡**：設定目標比例，提示偏離與建議調整金額。
- [ ] **多基準幣別**：可切換以新臺幣以外的幣別（如美元、新幣）呈現總資產。
- [ ] **自訂資產類別與標籤**。
- [ ] **資料加密**：可選擇以使用者自訂密碼在瀏覽器端加密 Drive 中的資料檔。
- [ ] **離線使用（PWA）**：安裝到手機主畫面，離線檢視最近一次資料。
- [ ] **多語系**：英文介面。
- [ ] **CI**（已有安全回歸測試）。

## 技術架構

| 項目 | 選擇 |
| --- | --- |
| 前端 | Vite + React + TypeScript（純前端 SPA） |
| 登入 | Google Identity Services（OAuth 2.0 token model） |
| 儲存 | Google Drive API v3，`drive.file` 範圍 |
| 報價 | Yahoo Finance（經由 `/api/quote` 與 `/api/history` 轉發，只傳送代號與歷史價格的起始日期） |
| 匯率 | ExchangeRate-API（法幣）、CoinGecko（加密貨幣） |
| 部署 | Cloudflare Workers（靜態資源 + `/api/quote` Worker） |

唯一的伺服器端程式是報價查詢 `/api/quote` 與歷史價格 `/api/history`：Yahoo Finance 不允許瀏覽器跨站請求，所以由這個小程式轉發。它只收到代號（以及歷史價格的起始日期），不含數量、金額或使用者身分，也不記錄請求。成功的查詢結果會暫存在 Cloudflare 邊緣快取（報價約 3 分鐘、歷史價格約 6 小時，以代號為單位，錯誤不快取），因此向 Yahoo 發出的請求數取決於「不同代號」的數量，不會隨使用者人數增加；快取內容只有公開的市場價格與其代號（歷史價格另含起始日期），並已寫入隱私權政策。

存取權杖只存放在目前分頁的 sessionStorage（重新整理保持登入，關閉分頁或瀏覽器即失去，不與其他分頁共用）；localStorage 只保存 Google 帳號識別碼、名稱、電子郵件與大頭貼網址，供下次繼續登入，並記錄最後看過的隱私權政策版本。舊版保存的權杖會在讀取時移除。重新授權時會核對 Google 帳號識別碼，避免把目前資料存到其他帳號。



## 本機開發

1. 依照 [docs/google-cloud-setup.md](docs/google-cloud-setup.md) 建立 Google Cloud OAuth 用戶端 ID。
2. 設定環境變數並啟動：

   ```bash
   cp .env.example .env.local   # 填入 VITE_GOOGLE_CLIENT_ID
   npm install
   npm run dev                  # http://localhost:5173
   ```

`/api/history` 與 `/api/quote` 應回傳 JSON；若本機收到首頁 HTML，請先儲存草稿，再停止並重新啟動 `npm run dev`，讓 Vite 載入目前的 API 設定，然後按「重新查詢歷史行情」。

| 指令 | 用途 |
| --- | --- |
| `npm run dev` | 本機開發伺服器 |
| `npm run build` | 型別檢查並建置到 `dist/` |
| `npm run preview` | 預覽建置結果 |
| `npm run lint` | oxlint |
| `npm test` | 登入、安全標頭與 Drive 讀寫回歸測試（Node.js 22.18+） |


`sharp` 暫時以 npm override 鎖定 0.35.5，修補 Wrangler / Miniflare 間接引入的 [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)。待上游正式更新並通過 `npm audit` 與 Worker 驗證後，可移除此 override。`npm audit` 無漏洞不代表網站不存在其他漏洞。

### 部署到 Cloudflare Workers

- 建置指令：`npm run build`，輸出目錄：`dist`。
- 環境變數：`VITE_GOOGLE_CLIENT_ID`。
- `wrangler.jsonc` 設定：請求先經過 `worker/index.ts` 套用 CSP、防嵌入與 HTTPS 等安全標頭，`/api/quote` 處理報價，其餘讀取 `dist/` 靜態資源；找不到的路徑回傳 `index.html`。所有請求都會執行 Worker，須留意 Worker 用量。
- `previews` 區塊讓 Pull Request 可以自動建立預覽部署（`wrangler preview`）。
- 建置時會預先產生 `index.html`、`privacy.html`、`terms.html`、`disclaimer.html`，不執行 JavaScript 也能讀到內容，同時寫出只列這四頁的 `sitemap.xml`。
- 在 Google Search Console 提交 `https://wealthline.haomeh.com/sitemap.xml`。若 Cloudflare 開啟了「AI 爬蟲封鎖」或「受管理的 robots.txt」，它會改寫或擋掉 `robots.txt` 的設定，需依需求調整。
- 正式網站為 `https://wealthline.haomeh.com`：在 Worker 的「網域與路由」加入 `wealthline.haomeh.com`。
- 公開頁面不需要登入；直接開啟政策不會載入 Drive。已登入從 `/` 進入會以 replace 導向 `/app`，原有帳戶與歷史連結保留。
- 品牌驗證重送前，確認正式部署已包含最新政策與公開首頁，再於 Google Auth Platform 核對應用程式名稱 Wealthline、首頁 `https://wealthline.haomeh.com/`、隱私權 `/privacy`、服務條款 `/terms`，並確認網域驗證及支援信箱。政策已列出四個實際登入權限、負債與歷史資料、自動儲存、行情傳輸、保存及刪除方式，保留 Limited Use 聲明；不能保證審查結果。
- 把正式網址加入 OAuth 用戶端的「已授權的 JavaScript 來源」，並在 OAuth 同意畫面填入首頁、隱私權政策（`/privacy`）與服務條款（`/terms`）網址。

## 程式結構

| 路徑 | 內容 |
| --- | --- |
| `src/google/auth.ts` | 載入 GIS、取得／撤銷 access token、讀取使用者資料、保存登入狀態 |
| `src/google/drive.ts` | 在 Drive 中尋找、建立、讀取、覆寫資料檔 |
| `src/model.ts` | 資料檔格式（帳戶、餘額／持倉、匯率）、讀取驗證與統計函式 |
| `src/quotes.ts`、`server/yahoo.ts`、`worker/index.ts` | 持倉報價：代號轉換與 Yahoo Finance 查詢 |
| `src/rates.ts` | 匯率：ExchangeRate-API 與 CoinGecko |
| `src/liabilities.ts` | 負債資料驗證與資產／負債／淨資產計算 |
| `src/views/Liabilities.tsx` | 負債清單及編輯／試算表單 |
| `src/loanEstimate.ts` | 按月攤還試算與數值驗證 |
| `src/history.ts` | 歷史：異動紀錄與每日快照 |
| `src/importSheet.ts` | 從試算表貼上的資料列匯入帳戶與匯率 |
| `src/site.ts` | 網站連結與公告頁面路由 |
| `src/App.tsx` | 登入流程、分頁與儲存 |
| `src/views/` | 首頁、總覽、帳戶、歷史、匯率與公告頁面 |
| `public/` | 圖示與 PWA manifest |

## 資料模型

- **帳戶**：名稱、類型（銀行帳戶／投資帳戶）、國家、資產類別。
- **銀行帳戶**記錄各幣別餘額；**投資帳戶**記錄可用金額（各幣別現金）與持有標的。
- **匯率**：每 1 單位外幣兌新臺幣，統計時全部換算成新臺幣。
- **負債**：名稱、類型、幣別、非負的目前未償餘額，以及獨立的選填還款資訊。
- **歷史**：資產與負債各自的異動紀錄（修改前後的值）與每日快照。首頁時間線可選擇歷史快照，歷史明細頁可逐日核對資料來源與編輯數量；未記錄負債以 0 計，淨資產為當日資產減負債。明確缺少匯率的紀錄仍為未知。

手動負債使用資料格式 `version: 2`，按期預估與校正基準使用 `version: 4`，完整讀取 v1／v2／v3／v4。既有 v3 持倉歷史加入自動還款後升為 v4，保留兩組資料；之後編輯歷史、停用或刪除貸款亦不降版。舊客戶端會拒絕不支援的版本。詳見 [負債資料與驗證說明](docs/liabilities.md)。

歷史明細頁的日期編輯統一使用完整持倉清單彈窗，原始快照與補登紀錄皆帶入選定日期；已有完整紀錄時沿用當日數量，否則使用較早的完整清單或目前持倉供核對。逐項捷徑仍可修改單一標的；價格與匯率取統一的 Yahoo 歷史來源，缺資料保留未知。只有手動歷史時使用 schema v3，啟用自動還款後共用 v4；保留 v1／v2／v3／v4 讀取相容，不修改目前持倉。詳見 [歷史數量、行情政策與驗證限制](docs/quantity-history.md)。

## 審查與回報

- 一般問題與建議：[GitHub Issues](https://github.com/howmay/Wealthline/issues)。
- 安全漏洞：請勿公開細節，改用 GitHub 的[私下回報安全漏洞](https://github.com/howmay/Wealthline/security/advisories/new)功能。

## 營運者

Wealthline 由 GitHub 組織 [howmay](https://github.com/howmay) 營運，網站為 <https://wealthline.haomeh.com>。

## 授權

Copyright (c) 2026 Harvey Chen。

本專案以 **[PolyForm Noncommercial License 1.0.0](LICENSE)** 授權，並附有[繁體中文授權說明](LICENSE.zh-TW.md)（依中華民國《著作權法》說明授權範圍）：

- ✅ 個人學習、研究、實驗與自用
- ✅ 學校教學、學生作業與學術研究等教育用途
- ✅ 非營利組織與政府機關使用
- ❌ **任何商業用途**（收費服務、販售、整合進商業產品、營利事業內部使用等），須事先取得作者**書面授權**

商業授權請見 [授權說明第七節](LICENSE.zh-TW.md#七商業授權申請補充約定)。

本專案為資產記錄工具，不構成任何投資建議。

快照帳戶名稱附上國家代碼，優先採當日持倉的國家；原始快照未保存國家時，使用對應帳戶目前設定，帳戶已刪除且無持倉來源則標示未設定國家。既有同名同國家資料仍可讀取以便修正，不自動合併。匯入表格未提供國家，遇到同名多筆會阻擋，請改用帳戶頁編輯。
