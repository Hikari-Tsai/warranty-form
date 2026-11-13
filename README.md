# 產品線上保固登錄系統（靜態表單 + Turnstile + Apps Script）

```
瀏覽器 (index.html，GitHub Pages / Cloudflare Pages)
   │  1. Turnstile 取得 token
   │  2. 照片在瀏覽器縮到長邊 1600px、轉 JPEG 0.8（移除 EXIF）
   │  3. fetch POST，Content-Type: text/plain（不觸發 CORS 預檢）
   ▼
Google Apps Script Web App (Code.gs → doPost)
   ├─ 驗證欄位 / honeypot / 照片大小、張數、magic bytes
   ├─ UrlFetchApp → Cloudflare siteverify（檢查 success + hostname）
   ├─ LockService 鎖定 → 檢查 submissionId 是否已存在
   ├─ 照片存 Drive 資料夾（私人）
   └─ appendRow 寫入 Google Sheet
```

| 檔案 | 用途 |
|---|---|
| `index.html` | 前端表單（單一檔案，含樣式與程式；中文 / English 切換；自動支援深色模式） |
| `assets/cyuncai-logo.png` | 左上角群彩文創 Logo（點擊回首頁） |
| `Code.gs` | Apps Script 後端 |
| `CNAME` | GitHub Pages 自訂網域（`warranty.cyuncai.com`），請勿刪除 |

---

## 1. 申請 Cloudflare Turnstile

> **人機驗證可以先不開。** 後端 `TURNSTILE_SECRET` 不填、前端 `TURNSTILE_SITE_KEY` 設成 `''`，就會完全略過 Turnstile（不載入元件、不驗證、不報錯），只靠 honeypot 擋機器人。
> 兩邊要一起設定：只有前端關閉、後端有 secret → 送出會失敗（「請先完成人機驗證」）；前端有 key、後端沒 secret → 會顯示驗證元件但後端不檢查。

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/)（免費帳號即可，網站不需要託管在 Cloudflare）。
2. 左側選單進入 **Turnstile** → **Add widget**。
3. 填寫：
   - **Widget name**：例如 `保固登錄表單`
   - **Hostnames**：前端會放的網域（**只填網域，不含 https:// 與路徑**），例如
     - GitHub Pages：`yourname.github.io`
     - Cloudflare Pages：`your-project.pages.dev`
     - 自訂網域：`warranty.example.com`
   - **Widget Mode**：`Managed`（建議）
   - **Pre-clearance**：`No`
4. 建立後會拿到兩把金鑰：
   - **Site Key**（公開）→ 填到 `index.html`
   - **Secret Key**（保密）→ 填到 Apps Script 的 Script Properties，**絕對不要放進前端或 Git**

> 本機開發可用 Cloudflare 官方測試金鑰（永遠通過）：
> Site Key `1x00000000000000000000AA`、Secret Key `1x0000000000000000000000000000000AA`。
> 測試金鑰的 siteverify 回傳的 hostname 是 `example.com`，所以測試期間要把 `example.com` 暫時加進 `ALLOWED_HOSTNAMES`，正式上線前移除。

---

## 2. 準備 Google Sheet 與 Drive 資料夾

1. 建立一份 Google 試算表。網址 `https://docs.google.com/spreadsheets/d/【這段就是 SHEET_ID】/edit`
2. 在 Google Drive 建立一個資料夾放購買憑證照片，**保持私人（不要開啟「知道連結的人」）**。
   網址 `https://drive.google.com/drive/folders/【這段就是 DRIVE_FOLDER_ID】`

試算表第一次寫入時會自動建立 `Submissions` 工作表與標題列：

`時間戳 | submissionId | 姓名 | 聯繫電話 / 手機 | Email | Line ID | 產品廠牌 | 產品型號 | 產品序號 S/N | 購買日期 | 購買通路 | 購買店家 / 平台 | 個資告知同意 | 行銷通知 | 購買憑證連結`

照片連結指向私人檔案，只有你（與你分享資料夾的人）點得開。

---

## 3. 建立 Apps Script 專案

1. 到 <https://script.google.com/> → **新專案**（或在試算表中「擴充功能 → Apps Script」）。
2. 把預設的 `程式碼.gs` 內容整個換成 `Code.gs`。
3. **專案設定**（齒輪圖示）：
   - **時區** 設為 `(GMT+08:00) 台北`（影響時間戳與購買日期檢查）。
   - 確認執行環境為 **V8**（預設即是）。

### Script Properties

**專案設定 → 指令碼屬性 → 新增指令碼屬性**：

| 屬性 | 值 | 必填 |
|---|---|---|
| `SHEET_ID` | 試算表 ID | ✅ |
| `DRIVE_FOLDER_ID` | Drive 資料夾 ID | ✅ |
| `TURNSTILE_SECRET` | Turnstile Secret Key。**不填 = 關閉人機驗證** | 選填 |
| `ALLOWED_HOSTNAMES` | 前端網域，逗號分隔，例如 `yourname.github.io,warranty.example.com` | 有填 `TURNSTILE_SECRET` 時必填 |
| `SHEET_NAME` | 工作表名稱，預設 `Submissions` | 選填 |

### 授權與自我檢查

在編輯器上方函式選單選 **`checkSetup`** → **執行** → 依指示授權（會要求試算表、Drive、外部連線權限）。
看「執行記錄」，應該出現：

- `Sheet OK: …`
- `Folder OK: …（共用設定：PRIVATE）`
- （有設定 `TURNSTILE_SECRET` 時）`siteverify: {"success":false,"error-codes":["invalid-input-response"]…}` ← 這是正常的（用了假 token）；若出現 `invalid-input-secret` 表示 Secret 填錯。

---

## 4. 部署為網頁應用程式

1. 右上 **部署 → 新增部署作業**。
2. 類型選 **網頁應用程式**。
3. 設定：
   - **執行身分**：**我**（你的帳號）
   - **誰可以存取**：**所有人**（不是「擁有 Google 帳戶的所有人」）
4. **部署** → 複製 **網頁應用程式網址**，形如
   `https://script.google.com/macros/s/AKfycb…/exec`
5. 用瀏覽器打開這個網址，看到 `{"ok":true,"message":"服務運作中"}` 就成功了。

### 之後修改程式碼

**部署 → 管理部署作業 → 編輯（鉛筆）→ 版本：新版本 → 部署**。
這樣 `/exec` 網址不變。（若用「新增部署作業」會產生新網址，前端要跟著改。）

> 若你的帳號是公司 / 學校的 Google Workspace，管理員可能禁止「所有人」存取；此時選項會不見，需改用個人 Gmail 帳號部署或請管理員開放。

---

## 5. 設定前端

編輯 `index.html` 中 `<script>` 開頭的 `CONFIG`：

```js
const CONFIG = {
  TURNSTILE_SITE_KEY: '0x4AAAAAAA……',                                  // ← Turnstile Site Key（'' = 關閉人機驗證）
  ENDPOINT: 'https://script.google.com/macros/s/AKfycb……/exec',         // ← /exec 網址
  ...
};
```

### 本機測試

```bash
python3 -m http.server 8000
```

打開 <http://localhost:8000>。使用測試金鑰時記得在 `ALLOWED_HOSTNAMES` 暫時加上 `example.com`。

---

## 6. 部署前端

**GitHub Pages**：把 `index.html` 推到 repo → Settings → Pages → 選 branch（`main` / root）。

**Cloudflare Pages**：Workers & Pages → Create → Pages → 連結 Git repo 或直接上傳資料夾（不需 build 指令）。

上線後確認：網域已加進 Turnstile 的 Hostnames，且 `ALLOWED_HOSTNAMES` 有同一個網域。

---

## 安全與行為說明

| 項目 | 做法 |
|---|---|
| 人機驗證 | 未設定 `TURNSTILE_SECRET` 時略過；有設定時後端呼叫 siteverify，檢查 `success` 與 `hostname`；token 每次送出後前端都會重新取得 |
| Honeypot | 隱藏欄位 `website` 若有值：**回傳成功但不寫入**，讓機器人以為成功 |
| 欄位驗證 | 必填、長度、Email / 電話格式、下拉選項必須在白名單、購買日期不可晚於今天 |
| 照片 | 最多 3 張、解碼後總計 ≤ 5MB、檔頭必須是 JPEG（`FF D8 FF`）或 PNG（`89 50 4E 47 0D 0A 1A 0A`） |
| 檔名 | `submissionId_序號.jpg`（若收到 PNG 則為 `.png`；前端一律送 JPEG） |
| 公式注入 | 以 `= + - @` 開頭的值加 `'` 前綴；純數字樣式的值（電話、序號）也加 `'`，避免開頭的 0 被吃掉 |
| 重複送出 | 前端同一份表單重試沿用同一個 `submissionId`；後端在鎖內查 B 欄，已存在就回 `ok:true` 不重寫 |
| 錯誤訊息 | 只回傳給使用者看得懂的訊息；內部錯誤細節寫在 Apps Script「執行作業」記錄 |

### 型號 / 序號條碼掃描

「產品型號」與「原廠序號」欄旁的「掃描」按鈕會開啟相機即時掃描，也可以「改用拍照辨識」或手動輸入。

- 支援 Code 128 / 39 / 93、Codabar、ITF、Data Matrix、QR Code、EAN / UPC。
- Android Chrome、macOS Chrome 使用瀏覽器內建的 `BarcodeDetector`；iPhone Safari、Firefox、Windows 等不支援的瀏覽器，按下掃描時才從 jsDelivr 載入 [`barcode-detector`](https://github.com/Sec-ant/barcode-detector)（ZXing WebAssembly，約 1MB，有 SRI 驗證）。
- 同一個值連續讀到兩次才採用，降低誤讀；畫面中有多個條碼、或讀到的是 EAN/UPC 商品條碼或網址時，會讓使用者自己選。
- 掃描值開頭的 `S/N:`、`SERIAL NO.`、`MODEL:`、`P/N` 等字樣會自動去掉；填入後會提示使用者核對。
- 要讓其他欄位也能掃描：在 input 旁加 `<button class="scan-btn" data-scan-target="欄位id">`，並在 `TARGETS` 加一筆設定。
- 相機只能在 **HTTPS**（或 localhost）下使用；GitHub Pages / Cloudflare Pages 都是 HTTPS。

### 中文 / English

- 右上角按鈕切換語系，選擇會記在瀏覽器；第一次進站依瀏覽器語言決定（中文系統 → 中文，其他 → English）。
- 也可以直接用網址指定：`https://warranty.cyuncai.com/?lang=en`。
- 前端送出時會帶 `lang`，後端（`Code.gs`）依此回傳中文或英文訊息。**改過 `Code.gs` 後要重新部署（管理部署作業 → 新版本）才會生效。**
- 寫入試算表的選項值（廠牌、通路、行銷通知）不分語系，一律是中文原值，方便統計。
- 新增或修改文字：
  - 頁面上的固定文字：HTML 元素加 `data-i18n="key"`（內容）或 `data-i18n-attr="placeholder=key"`（屬性），中文寫在 HTML，英文寫在 `I18N.en`。
  - 程式產生的文字：用 `t('key', { 變數 })`，中英文都寫在 `I18N`。
  - 後端錯誤訊息：用 `T_('中文', 'English')`；欄位英文名稱在 `CONFIG.FIELDS` 的 `en`。

### HEIC

iPhone 用 `accept="image/*"` 選照片時，iOS 通常會自動轉成 JPEG；Safari 也能直接解碼 HEIC。
桌機 Chrome / Firefox 若遇到 HEIC 會提示使用者改傳 JPEG。若需要在所有瀏覽器支援 HEIC，可再加 `heic2any` 之類的函式庫（約 1MB）。

### 修改題目

1. `index.html`：新增 / 修改表單元素（`name` 屬性 = 欄位 key），並加進 `TEXT_FIELDS`。必填欄位的外層 `.field` 要有 `data-error="錯誤訊息"`，才會納入驗證與進度條。
2. `Code.gs`：修改 `CONFIG.FIELDS`（順序就是試算表欄位順序）。
3. 已有資料的試算表標題列不會自動更新，請手動調整或換一個 `SHEET_NAME`。
4. 重新部署（新版本）。
