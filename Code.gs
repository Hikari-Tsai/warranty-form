/**
 * 產品線上保固登錄系統 — Google Apps Script Web App 後端
 *
 * 需要的 Script Properties（專案設定 → 指令碼屬性）：
 *   SHEET_ID           Google 試算表 ID
 *   DRIVE_FOLDER_ID    存放購買憑證照片的 Google Drive 資料夾 ID
 *   TURNSTILE_SECRET   （選填）Cloudflare Turnstile 的 Secret Key；未填寫 = 關閉人機驗證
 *   ALLOWED_HOSTNAMES  （有填 TURNSTILE_SECRET 時必填）允許的前端網域，逗號分隔，
 *                      例如：yourname.github.io,warranty.pages.dev
 *   SHEET_NAME         （選填）工作表名稱，預設 "Submissions"
 *
 * 部署：部署 → 新增部署作業 → 網頁應用程式
 *   執行身分：我　／　誰可以存取：所有人
 */

const CONFIG = {
  MAX_PHOTOS: 3,
  MAX_TOTAL_BYTES: 5 * 1024 * 1024,          // 照片解碼後總大小上限 5MB
  MAX_BODY_CHARS: 7.5 * 1024 * 1024,         // 整個請求字串上限（base64 膨脹約 4/3 + 其他欄位）
  MIN_PHOTO_BYTES: 100,
  MAX_TOKEN_LENGTH: 2048,
  LOCK_WAIT_MS: 30000,
  DEFAULT_SHEET_NAME: 'Submissions',
  SITEVERIFY_URL: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  SUCCESS_MESSAGE: '保固登錄完成，感謝您的填寫！',
  SUCCESS_MESSAGE_EN: 'Your warranty registration is complete. Thank you!',

  /**
   * 表單欄位（順序 = 試算表欄位順序）。前端 index.html 的 name 必須與 key 一致。
   * type：
   *   text     字串；可設 max / singleLine / pattern
   *   select   必須是 options 之一（前端下拉選單 / 單選鈕的選項要一模一樣）
   *   date     YYYY-MM-DD，不可晚於今天；寫入試算表時是日期格式
   *   consent  必須為 true；寫入「已同意」
   */
  FIELDS: [
    { key: 'name',      label: '姓名', en: 'Name',          type: 'text', required: true,  max: 50,  singleLine: true },
    { key: 'phone',     label: '聯繫電話 / 手機', en: 'Phone', type: 'text', required: true,  max: 20,  singleLine: true,
      pattern: /^[0-9+\-()#\s]{6,20}$/ },
    { key: 'email',     label: 'Email', en: 'Email',         type: 'text', required: true,  max: 254, singleLine: true,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    { key: 'lineId',    label: 'Line ID', en: 'LINE ID',       type: 'text', required: false, max: 50,  singleLine: true },
    { key: 'brand',     label: '產品廠牌', en: 'Brand',       type: 'select', required: true, options: [
      'AIAIAI', 'AUDEZE', 'Solid State Logic - SSL', 'Universal Audio - UA',
      'Fosi Audio', 'M-Audio', 'iConnectivity', 'Expressive E',
    ] },
    { key: 'model',     label: '產品型號', en: 'Model',       type: 'text', required: true,  max: 100, singleLine: true },
    { key: 'serial',    label: '產品序號 S/N', en: 'Serial number',   type: 'text', required: true,  max: 100, singleLine: true },
    { key: 'purchaseDate', label: '購買日期', en: 'Purchase date',    type: 'date', required: true },
    { key: 'channel',   label: '購買通路', en: 'Purchase channel',       type: 'select', required: true, options: [
      '揚聲堡音樂實體門市', '揚聲堡音樂線上商城', '授權電商平台 - MoMo',
      '授權電商平台 - PCHome', '授權經銷商',
    ] },
    { key: 'store',     label: '購買店家 / 平台', en: 'Store / platform', type: 'text', required: true,  max: 100, singleLine: true },
    { key: 'privacyConsent', label: '個資告知同意', en: 'Privacy consent', type: 'consent', required: true },
    { key: 'marketing', label: '行銷通知', en: 'Marketing updates',       type: 'select', required: false, options: ['同意', '不同意'] },
  ],
  PHOTO_COLUMN_LABEL: '購買憑證連結',
  EARLIEST_PURCHASE_DATE: '2000-01-01',
};

/** 給使用者看的錯誤；其他錯誤一律回傳通用訊息，細節只寫進 log。 */
// 回應語系：前端送 lang: 'en' 時回英文訊息，其餘一律中文
let LANG_ = 'zh';
function T_(zh, en) { return LANG_ === 'en' ? en : zh; }
function label_(rule) { return LANG_ === 'en' ? (rule.en || rule.label) : rule.label; }
function successMessage_() { return T_(CONFIG.SUCCESS_MESSAGE, CONFIG.SUCCESS_MESSAGE_EN); }

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

// ---------------------------------------------------------------------------
// 進入點
// ---------------------------------------------------------------------------

function doPost(e) {
  LANG_ = 'zh';
  try {
    return json_(handleSubmission_(e));
  } catch (err) {
    if (err instanceof UserError) {
      return json_({ ok: false, message: err.message });
    }
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, message: T_('伺服器發生錯誤，請稍後再試。', 'Server error. Please try again later.') });
  }
}

/** 方便在瀏覽器打開 /exec 確認部署是否成功。 */
function doGet() {
  return json_({ ok: true, message: '服務運作中' });
}

function handleSubmission_(e) {
  const raw = e && e.postData && e.postData.contents;
  if (!raw) throw new UserError(T_('沒有收到資料。', 'No data received.'));
  if (raw.length > CONFIG.MAX_BODY_CHARS) throw new UserError(T_('資料量過大，請減少或縮小照片。', 'The submission is too large. Please use fewer or smaller photos.'));

  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    throw new UserError(T_('資料格式錯誤。', 'Invalid data format.'));
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new UserError(T_('資料格式錯誤。', 'Invalid data format.'));
  }
  LANG_ = body.lang === 'en' ? 'en' : 'zh';

  // Honeypot：真人看不到這個欄位。被填寫就假裝成功，但什麼都不寫入，避免機器人調整策略。
  if (body.website != null && String(body.website).trim() !== '') {
    console.warn('Honeypot triggered; submission dropped.');
    return { ok: true, message: successMessage_() };
  }

  // 先做便宜的本地驗證，再打 Turnstile（網路呼叫），最後才碰 Sheet/Drive
  const submissionId = validateSubmissionId_(body.submissionId);
  const fields = validateFields_(body.fields);
  const photos = validatePhotos_(body.photos);

  const props = getProps_();
  verifyTurnstile_(body.turnstileToken, props);

  return saveSubmission_(submissionId, fields, photos, props);
}

// ---------------------------------------------------------------------------
// 驗證
// ---------------------------------------------------------------------------

function validateSubmissionId_(id) {
  // 前端用 crypto.randomUUID()；不可用 - 開頭，順便確保不會觸發公式注入前綴
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(id)) {
    throw new UserError(T_('送出編號無效，請重新整理頁面後再試。', 'Invalid submission ID. Please reload the page and try again.'));
  }
  return id;
}

function validateFields_(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new UserError(T_('欄位資料錯誤。', 'Invalid form data.'));
  }
  const out = {};
  CONFIG.FIELDS.forEach(function (rule) {
    const v = input[rule.key];
    switch (rule.type) {
      case 'consent':
        if (rule.required && v !== true) throw new UserError(T_('請閱讀並勾選同意「個人資料蒐集與使用告知事項」。', 'Please read and accept the privacy notice.'));
        out[rule.key] = v === true ? '已同意' : '';
        break;
      case 'date':
        out[rule.key] = validateDate_(v, rule);
        break;
      default: {
        const s = cleanString_(v, rule);
        if (rule.required && !s) throw new UserError(T_('請填寫' + rule.label + '。', 'Please fill in ' + label_(rule) + '.'));
        if (s && rule.type === 'select' && rule.options.indexOf(s) === -1) {
          throw new UserError(T_(rule.label + ' 選項無效。', label_(rule) + ': invalid option.'));
        }
        if (s && rule.type === 'text') {
          if (Array.from(s).length > rule.max) throw new UserError(T_(rule.label + ' 不可超過 ' + rule.max + ' 字。', label_(rule) + ' must be at most ' + rule.max + ' characters.'));
          if (rule.singleLine && /[\n\t]/.test(s)) throw new UserError(T_(rule.label + ' 不可換行。', label_(rule) + ' must be a single line.'));
          if (rule.pattern && !rule.pattern.test(s)) throw new UserError(T_(rule.label + ' 格式不正確。', label_(rule) + ' is not valid.'));
        }
        out[rule.key] = s;
      }
    }
  });
  return out;
}

function cleanString_(v, rule) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new UserError(T_(rule.label + ' 格式錯誤。', label_(rule) + ' has an invalid format.'));
  if (v.length > 10000) throw new UserError(T_(rule.label + ' 太長。', label_(rule) + ' is too long.'));
  return v.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // 移除控制字元（保留 \t \n）
    .trim();
}

/** 回傳 Date（以指令碼時區的當天 00:00），寫入試算表會是日期格式。 */
function validateDate_(v, rule) {
  const s = cleanString_(v, rule);
  if (!s) {
    if (rule.required) throw new UserError(T_('請填寫' + rule.label + '。', 'Please fill in ' + label_(rule) + '.'));
    return '';
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new UserError(T_(rule.label + ' 格式不正確。', label_(rule) + ' is not valid.'));
  const y = +m[1], mo = +m[2], d = +m[3];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    throw new UserError(T_(rule.label + ' 不是有效的日期。', label_(rule) + ' is not a valid date.'));
  }
  // 時區差異留一天緩衝
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (s > tomorrow) throw new UserError(T_(rule.label + ' 不可晚於今天。', label_(rule) + ' cannot be in the future.'));
  if (s < CONFIG.EARLIEST_PURCHASE_DATE) throw new UserError(T_(rule.label + ' 不正確。', label_(rule) + ' is not valid.'));
  return date;
}

function validatePhotos_(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new UserError(T_('照片資料錯誤。', 'Invalid photo data.'));
  if (input.length > CONFIG.MAX_PHOTOS) throw new UserError(T_('照片最多 ' + CONFIG.MAX_PHOTOS + ' 張。', 'Up to ' + CONFIG.MAX_PHOTOS + ' photos.'));

  const maxB64 = Math.ceil(CONFIG.MAX_TOTAL_BYTES / 3) * 4;
  let total = 0;

  return input.map(function (p, i) {
    const n = i + 1;
    const data = p && typeof p.data === 'string' ? p.data : '';
    if (!data) throw new UserError(T_('第 ' + n + ' 張照片資料錯誤。', 'Photo ' + n + ': invalid data.'));
    if (data.length > maxB64) throw new UserError(T_('照片總大小超過 5MB。', 'Photos exceed 5MB in total.'));
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new UserError(T_('第 ' + n + ' 張照片編碼錯誤。', 'Photo ' + n + ': invalid encoding.'));

    let bytes;
    try {
      bytes = Utilities.base64Decode(data);
    } catch (_) {
      throw new UserError(T_('第 ' + n + ' 張照片編碼錯誤。', 'Photo ' + n + ': invalid encoding.'));
    }

    total += bytes.length;
    if (total > CONFIG.MAX_TOTAL_BYTES) throw new UserError(T_('照片總大小超過 5MB。', 'Photos exceed 5MB in total.'));
    if (bytes.length < CONFIG.MIN_PHOTO_BYTES) throw new UserError(T_('第 ' + n + ' 張照片檔案不完整。', 'Photo ' + n + ': file is incomplete.'));

    // 不相信前端宣告的 type，一律看檔頭 magic bytes
    const kind = detectImageType_(bytes);
    if (!kind) throw new UserError(T_('第 ' + n + ' 張照片不是 JPEG 或 PNG。', 'Photo ' + n + ' is not a JPEG or PNG.'));
    return { bytes: bytes, kind: kind };
  });
}

/** Utilities.base64Decode 回傳的是有號 byte（-128~127），比對前要 & 0xFF。 */
function detectImageType_(bytes) {
  const b = function (i) { return bytes[i] & 0xff; };
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every(function (v, i) { return b(i) === v; })) {
    return { mime: 'image/png', ext: 'png' };
  }
  return null;
}

function verifyTurnstile_(token, props) {
  // 未設定 TURNSTILE_SECRET：人機驗證關閉，直接放行（只剩 honeypot 擋機器人）
  if (!props.turnstileSecret) return;

  if (typeof token !== 'string' || !token || token.length > CONFIG.MAX_TOKEN_LENGTH) {
    throw new UserError(T_('請先完成人機驗證。', 'Please complete the verification first.'));
  }

  const res = UrlFetchApp.fetch(CONFIG.SITEVERIFY_URL, {
    method: 'post',
    payload: { secret: props.turnstileSecret, response: token },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    console.error('siteverify HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
    throw new UserError(T_('人機驗證服務暫時無法使用，請稍後再試。', 'Verification service is unavailable. Please try again later.'));
  }

  let result;
  try {
    result = JSON.parse(res.getContentText());
  } catch (_) {
    console.error('siteverify non-JSON: ' + res.getContentText());
    throw new UserError(T_('人機驗證服務暫時無法使用，請稍後再試。', 'Verification service is unavailable. Please try again later.'));
  }

  if (result.success !== true) {
    console.warn('Turnstile failed: ' + JSON.stringify(result['error-codes'] || []));
    throw new UserError(T_('人機驗證失敗或已過期，請重新驗證後再送出。', 'Verification failed or expired. Please verify again and resubmit.'));
  }

  const hostname = String(result.hostname || '').toLowerCase();
  if (props.allowedHostnames.indexOf(hostname) === -1) {
    console.warn('Turnstile hostname not allowed: ' + hostname);
    throw new UserError(T_('人機驗證來源不符。', 'Verification origin mismatch.'));
  }
}

// ---------------------------------------------------------------------------
// 寫入 Drive / Sheet
// ---------------------------------------------------------------------------

function saveSubmission_(submissionId, fields, photos, props) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    throw new UserError(T_('系統忙碌中，請稍後再試。', 'The system is busy. Please try again later.'));
  }

  const createdFiles = [];
  try {
    const sheet = getSheet_(props);

    // 冪等：同一個 submissionId 已存在就直接回成功，不再寫入
    if (submissionExists_(sheet, submissionId)) {
      return { ok: true, duplicate: true, message: T_('這筆資料先前已送出成功，不會重複記錄。', 'This registration was already submitted and will not be recorded twice.') };
    }

    // 照片沿用資料夾權限（保持私人），不呼叫 setSharing
    const folder = DriveApp.getFolderById(props.driveFolderId);
    const links = photos.map(function (p, i) {
      const name = submissionId + '_' + (i + 1) + '.' + p.kind.ext;
      const file = folder.createFile(Utilities.newBlob(p.bytes, p.kind.mime, name));
      createdFiles.push(file);
      return file.getUrl();
    });

    sheet.appendRow(buildRow_(submissionId, fields, links));
    SpreadsheetApp.flush();

    return { ok: true, message: successMessage_() };
  } catch (err) {
    // 寫入 Sheet 失敗時，把這次已建立的照片丟進垃圾桶，避免孤兒檔案
    createdFiles.forEach(function (f) {
      try { f.setTrashed(true); } catch (_) { /* ignore */ }
    });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function headerRow_() {
  return ['時間戳', 'submissionId']
    .concat(CONFIG.FIELDS.map(function (f) { return f.label; }))
    .concat([CONFIG.PHOTO_COLUMN_LABEL]);
}

function buildRow_(submissionId, fields, links) {
  return [new Date(), submissionId]
    .concat(CONFIG.FIELDS.map(function (f) { return sanitizeCell_(fields[f.key]); }))
    .concat([links.join('\n')]);
}

/**
 * 1. 防公式注入：以 = + - @（及 Tab、CR）開頭的字串加上 ' 前綴，讓 Sheets 當成純文字。
 * 2. 純數字樣式的字串（電話 0912…、序號 00123）也加 '，避免被轉成數字而掉開頭的 0。
 * ' 是 Sheets 的「強制文字」標記，儲存格中不會顯示出來。
 */
function sanitizeCell_(v) {
  if (typeof v !== 'string' || v === '') return v;
  if (/^[=+\-@\t\r]/.test(v)) return "'" + v;
  if (/^[\d\s.,:/()#-]+$/.test(v)) return "'" + v;
  return v;
}

function getSheet_(props) {
  const ss = SpreadsheetApp.openById(props.sheetId);
  let sheet = ss.getSheetByName(props.sheetName);
  if (!sheet) sheet = ss.insertSheet(props.sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headerRow_());
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function submissionExists_(sheet, submissionId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  return sheet.getRange(2, 2, lastRow - 1, 1)   // B 欄 = submissionId
    .createTextFinder(submissionId)
    .matchCase(true)
    .matchEntireCell(true)
    .findNext() !== null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function getProps_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const str = function (k) { return String(p[k] || '').trim(); };
  const turnstileSecret = str('TURNSTILE_SECRET');

  const required = ['SHEET_ID', 'DRIVE_FOLDER_ID'];
  if (turnstileSecret) required.push('ALLOWED_HOSTNAMES'); // 只有啟用人機驗證時才需要
  const missing = required.filter(function (k) { return !str(k); });
  if (missing.length) throw new Error('Missing script properties: ' + missing.join(', '));

  return {
    turnstileSecret: turnstileSecret,
    sheetId: str('SHEET_ID'),
    driveFolderId: str('DRIVE_FOLDER_ID'),
    sheetName: str('SHEET_NAME') || CONFIG.DEFAULT_SHEET_NAME,
    allowedHostnames: str('ALLOWED_HOSTNAMES').split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean),
  };
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 在編輯器中手動執行一次：觸發授權，並檢查屬性、試算表、資料夾、對外連線是否正常。
 * 結果看「執行記錄」。
 */
function checkSetup() {
  const props = getProps_();
  console.log('Turnstile: ' + (props.turnstileSecret ? '已啟用' : '未設定 TURNSTILE_SECRET，人機驗證已關閉'));
  if (props.turnstileSecret) console.log('Allowed hostnames: ' + props.allowedHostnames.join(', '));
  console.log('Script time zone: ' + Session.getScriptTimeZone());

  const sheet = getSheet_(props);
  console.log('Sheet OK: ' + sheet.getParent().getName() + ' / ' + sheet.getName());

  const folder = DriveApp.getFolderById(props.driveFolderId);
  console.log('Folder OK: ' + folder.getName() + '（共用設定：' + folder.getSharingAccess() + '）');

  if (props.turnstileSecret) {
    const res = UrlFetchApp.fetch(CONFIG.SITEVERIFY_URL, {
      method: 'post',
      payload: { secret: props.turnstileSecret, response: 'dummy-token' },
      muteHttpExceptions: true,
    });
    // 預期 success:false、error-codes 含 invalid-input-response；若出現 invalid-input-secret 代表 secret 填錯
    console.log('siteverify: ' + res.getContentText());
  }
}
