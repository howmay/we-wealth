# 合成帳單

所有名稱、交易、金額與密碼均為合成測試資料，不含真實帳單或個人資訊；銀行名稱僅用於格式辨識。

- `synthetic-statement.pdf`：五列，包含兩筆完全相同的真實獨立消費、一筆小數、一筆退款與一筆繳款；應解析出四筆。
- `synthetic-statement-encrypted.pdf`：相同內容，以 ReportLab StandardEncryption 128-bit 加密；使用者密碼 `fixture-password`，擁有者密碼 `fixture-owner`。
- `synthetic-statement-cjk.pdf`：繁體中文商家、退款及繳款。以 MSung-Light/CNS1 與 UniCNS-UCS2-H 字元映射產生，應解析出兩筆。
- `synthetic-batch-esun-encrypted.pdf`、`synthetic-batch-fubon-encrypted.pdf`：合成玉山／富邦標題，分別標示 114年11月／12月；每份兩筆消費／退款及一筆繳款。密碼為 `fixture-esun`、`fixture-fubon`，擁有者密碼為 `fixture-owner`。用於不同銀行／月份／密碼的批次辨識及去重。
- `synthetic-hsbc-2026-04-image-merchants.pdf`：日期／金額為文字層，英文／繁中商家與繳款為圖片，另含前期餘額／本期應繳標題及區段外的假日期金額，驗證交易範圍、本機 OCR、待核對預覽及原始日期／金額保留。
- `synthetic-hsbc-2026-04-multipage.pdf`：兩頁圖片商家；續頁不含銀行名稱、以前述交易表頭定位。瀏覽器應合併六筆消費，排除兩頁繳款及第一頁區段外假交易。
- `synthetic-hsbc-sg.pdf`：兩頁合成 SG 匯豐文字帳單，第一頁為摘要，第二頁包含英文月份、SGD 表頭、原幣附註、退款及付款。應解析出兩筆 SGD 消費／退款，使用結帳月份且不需要 OCR。
- `synthetic-scan.pdf`：只含圖形、不含文字的 PDF，驗證不把未辨識當成成功匯入。

使用 ReportLab／pypdf 產生固定樣本，正常測試不需要 Python，只使用專案的 PDF.js。瀏覽器流程另外驗證錯誤密碼、解密、預覽編輯、本機儲存及重匯入。
