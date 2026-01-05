// filename: apps_script/Code.gs
// Gắn vào Google Spreadsheet (SHEET_NAME = 'transactions')
// Script Properties: API_KEY=<secret>, BOT_TOKEN=<your_bot_token>, (tuỳ chọn) SPREADSHEET_ID=<id đích>

const SHEET_NAME = 'transactions';
const LOG_SHEET_NAME = 'log';
const DEBUG = false;

function _cors(resp) { return resp; }
// [ADDED] Nhận diện Telegram Update
function _isTelegramUpdate_(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if ('update_id' in obj) return true;
  if (obj.message || obj.edited_message || obj.channel_post || obj.callback_query) return true;
  return false;
}

// [UPDATED] Chống lặp bền vững bằng Properties + Lock (thay cho CacheService TTL=10m)
function _consumeOnceUpdate_(updateId) {
  if (updateId == null) return true;
  const idStr = String(updateId);

  const lock = LockService.getScriptLock();
  try { lock.waitLock(2000); } catch (_e) { /* nếu lock lỗi, vẫn thử tiếp */ }

  try {
    const props = PropertiesService.getScriptProperties();
    const KEY = 'processed_updates_json';
    let arr;
    try { arr = JSON.parse(props.getProperty(KEY) || '[]'); }
    catch (_e) { arr = []; }

    if (arr.indexOf(idStr) !== -1) return false; // đã xử lý → bỏ qua

    arr.push(idStr);
    if (arr.length > 500) arr = arr.slice(-500); // giữ 500 ID gần nhất
    props.setProperty(KEY, JSON.stringify(arr));
    return true;
  } finally {
    try { lock.releaseLock(); } catch (_e) { }
  }
}

// [ADDED] Helper: so sánh date desc + id desc (date dạng yyyy-MM-dd)
// [UPDATED] Helper: so sánh date desc → time desc → id desc
function _cmpByDateIdDesc_(a, b) {
  var da = String(a.date || '');
  var db = String(b.date || '');
  if (db !== da) return db > da ? 1 : -1;

  var ta = String(a.time || '00:00:00');
  var tb = String(b.time || '00:00:00');
  if (tb !== ta) return tb > ta ? 1 : -1;

  var ia = String(a.id || '');
  var ib = String(b.id || '');
  return ib.localeCompare(ia);
}
// [ADDED] Chuẩn hoá giờ về 'HH:mm:ss' + tiện ích lấy giờ hiện tại theo TZ
function _isoTimeFromCell_(val, tz) {
  tz = tz || (Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh');
  if (val == null || val === '') return '';
  if (val instanceof Date) return Utilities.formatDate(val, tz, 'HH:mm:ss');
  if (typeof val === 'number') {
    // Sheets time-as-fraction (0..1) → giây
    if (val >= 0 && val <= 1) {
      var total = Math.round(val * 24 * 60 * 60);
      var h = Math.floor(total / 3600) % 24, m = Math.floor((total % 3600) / 60), s = total % 60;
      return [h, m, s].map(function (x) { return String(x).padStart(2, '0'); }).join(':');
    }
    // Fallback: xem như epoch millis
    return Utilities.formatDate(new Date(val), tz, 'HH:mm:ss');
  }
  var s = String(val).trim();
  // chấp nhận 'HH:mm' / 'HH:mm:ss'
  var m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    var hh = String(Math.min(23, Number(m[1]))).padStart(2, '0');
    var mm = String(Math.min(59, Number(m[2]))).padStart(2, '0');
    var ss = String(Math.min(59, Number(m[3] || '0'))).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }
  // Nếu là datetime string → trích giờ
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz, 'HH:mm:ss');
  return '';
}
function _nowTime_(tz) {
  tz = tz || (Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh');
  return Utilities.formatDate(new Date(), tz, 'HH:mm:ss');
}

// [ADDED] Helper: giới hạn limit 10|20|50
function _parseLimit_(v) {
  var n = Number(v);
  if (n === 10 || n === 20 || n === 50) return n;
  if (n <= 10) return 10;
  if (n >= 50) return 50;
  return 20;
}
/** [ADDED] Chuẩn hoá ngày về 'yyyy-MM-dd' (hỗ trợ Date, số ms, chuỗi tự do) */
function _isoFromCell_(val, tz) {
  tz = tz || (Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh');
  if (val instanceof Date) return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  if (val == null) return '';
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var n = Number(s);
  if (!isNaN(n) && s !== '') return Utilities.formatDate(new Date(n), tz, 'yyyy-MM-dd');
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  return '';
}

/** [ADDED] Parse VND: chấp nhận '1.234.567₫', '1,234,567', '-50000', ' - 1 000 ' */
function _parseAmountVND_(val) {
  if (typeof val === 'number') return val;
  if (val == null) return 0;
  var s = String(val).trim();
  if (s === '') return 0;
  var neg = s.indexOf('-') !== -1 || /^\(.*\)$/.test(s);
  var digits = s.replace(/[^\d]/g, '');
  if (digits === '') return 0;
  var n = Number(digits);
  return neg ? -n : n;
}
/** [ADDED] NÉN/ GIẢI NÉN raw: gzip + base64, lưu dạng "gz:<b64>" để nhẹ cột raw */
function _gzipB64Encode_(text) {
  if (!text) return '';
  const bytes = Utilities.newBlob(String(text), 'text/plain; charset=utf-8').getBytes();
  const gz = Utilities.gzip(Utilities.newBlob(bytes));             // Blob gzip
  const b64 = Utilities.base64Encode(gz.getBytes());               // base64
  return 'gz:' + b64;
}
function _gzipB64Decode_(val) {
  if (!val) return '';
  let s = String(val);
  if (s.startsWith('gz:')) s = s.slice(3);
  const gzBytes = Utilities.base64Decode(s);
  const blob = Utilities.newBlob(gzBytes, 'application/x-gzip');
  const out = Utilities.ungzip(blob);                              // Blob text
  return out.getDataAsString('UTF-8');
}

/** [ADDED] Custom functions cho Google Sheets UI */
function RAW_DECODE(value) {
  try { return _gzipB64Decode_(value); } catch (_e) { return String(value || ''); }
}
function RAW_PREVIEW(value, len) {
  const n = Math.max(1, Number(len || 500));
  let s;
  try { s = _gzipB64Decode_(value); } catch (_e) { s = String(value || ''); }
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function RAW_ENCODE(value) {
  try { return _gzipB64Encode_(String(value || '')); } catch (_e) { return ''; }
}
/** [ADDED] Truthy helpers cho cờ */
function _truthy_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'x';
}
function _isDeletedRow_(row, idx) {
  return idx.deleted != null && _truthy_(row[idx.deleted]);
}
/** Spreadsheet sheet helpers */
/** [UPDATED] _sheetTarget_(): thêm cột 'deleted' nếu chưa có */
// [UPDATED] _sheetTarget_(): thêm cột 'time' (nếu thiếu) và 'deleted'
function _sheetTarget_() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('SPREADSHEET_ID');
  const ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['id', 'user_id', 'date', 'time', 'amount', 'merchant', 'category', 'note', 'source', 'raw', 'deleted']);
  } else {
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var needAppend = false;
    if (headers.indexOf('time') === -1) { sh.getRange(1, sh.getLastColumn() + 1).setValue('time'); needAppend = true; }
    if (headers.indexOf('deleted') === -1) { sh.getRange(1, sh.getLastColumn() + 1).setValue('deleted'); needAppend = true; }
    if (needAppend) { /* no-op; headers vừa được thêm ở cuối */ }
  }
  return sh;
}


/** Logging */
function _logSheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(LOG_SHEET_NAME) || ss.insertSheet(LOG_SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['time', 'level', 'action', 'user_id', 'message', 'payload']);
  }
  return sh;
}
function _nowISO() {
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
}
function _safeStringify(obj) {
  try { return typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (e) { return String(obj); }
}
function logRow(level, action, userId, message, payload) {
  if (!DEBUG) return;
  try {
    _logSheet().appendRow([_nowISO(), level, action, userId || '', message || '', _safeStringify(payload || {})]);
  } catch (e) { }
}

/** Web app endpoints */
function doOptions() {
  logRow('INFO', 'OPTIONS', '', 'Preflight', {});
  return _cors(ContentService.createTextOutput('')).setMimeType(ContentService.MimeType.TEXT);
}
function doGet(e) {
  logRow('INFO', 'GET', '', 'Healthcheck', { params: e && e.parameter });
  return ContentService.createTextOutput(JSON.stringify({ ok: true, hint: 'Use POST' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Base64 helpers */
function _b64ToString(b64) {
  const bytes = Utilities.base64Decode(b64);
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}
/** Byte[] -> hex (log) */
function _toHex(bytes) {
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/** Telegram bot token check (cache 1h) */
function _getMeChecked(botToken, force) {
  const cache = CacheService.getScriptCache();
  const key = 'bot_me_checked';
  if (!force) {
    const cached = cache.get(key);
    if (cached) {
      const obj = JSON.parse(cached);
      return obj;
    }
  }
  const url = 'https://api.telegram.org/bot' + encodeURIComponent(botToken) + '/getMe';
  let status = 0, json = {};
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, method: 'get' });
    status = res.getResponseCode();
    try { json = JSON.parse(res.getContentText() || '{}'); } catch (e) { json = {}; }
  } catch (e) {
    json = { ok: false, description: String(e) };
  }
  const out = { ok: json.ok === true, http_status: status || 0, result: json.result || null, description: json.description || null };
  cache.put(key, JSON.stringify(out), 3600);
  const botInfo = out.result ? { id: out.result.id, username: out.result.username, is_bot: out.result.is_bot } : null;
  logRow(out.ok ? 'INFO' : 'ERROR', 'BOT/GETME', '', out.ok ? 'getMe OK' : 'getMe FAIL', { status: out.http_status, description: out.description, bot: botInfo });
  return out;
}

/** Fallback headers index */
function _headersIndexSafe(headerRow) {
  const map = {};
  const h = headerRow || [];
  for (let i = 0; i < h.length; i++) map[String(h[i])] = i;
  return map;
}
// Lấy nhanh hash & auth_date để làm key và TTL
function _quickParseInit(initData) {
  const dec = {};
  (initData || '').split('&').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    const k = decodeURIComponent(p.slice(0, i));
    const v = decodeURIComponent(p.slice(i + 1));
    dec[k] = v;
  });
  return {
    hash: String(dec.hash || '').toLowerCase(),
    auth_date: Number(dec.auth_date || 0),
  };
}
// Verify có cache (per-user)
function verifyInitDataCached(initDataB64, botToken) {
  if (!botToken) return { ok: false, error: 'missing_bot_token' };
  const initData = _b64ToString(initDataB64);
  const { hash, auth_date } = _quickParseInit(initData);
  if (!hash) return { ok: false, error: 'missing_hash' };

  const cache = CacheService.getScriptCache();
  const key = `auth:${hash}`;
  const hit = cache.get(key);

  if (hit) {
    const data = JSON.parse(hit);
    logRow("INFO", "CACHE_HIT", data.user?.id, `key=${key}`, data);
    return { ...data, cached: true };
  }

  const res = verifyInitData(initData, botToken);
  if (res && res.ok) {
    const age = Math.max(0, Math.floor(Date.now() / 1000) - (auth_date || 0));
    const remain = Math.max(1, 86400 - age);

    // const ttl = Math.min(300, remain); // 5 phút
    const ttl = Math.min(24 * 60 * 60, remain); // 1 ngày
    // const ttl = Math.min(365*24*60*60, remain); // 1 năm

    cache.put(key, JSON.stringify({ ok: true, user: res.user }), ttl);
    logRow("INFO", "CACHE_MISS", res.user?.id, `key=${key}, ttl=${ttl}s`, res.user);
  } else {
    logRow("WARN", "CACHE_VERIFY_FAIL", null, `key=${key}`, res);
  }
  return res;
}
/** Mini-app auth verify */
/** [UPDATED] verifyInitData(): thêm cache bằng ScriptCache (tối đa 5 phút, không vượt quá 24h) */
function verifyInitData(initData, botToken) {
  try {
    if (!botToken) return { ok: false, error: 'missing_bot_token' };

    // --- Quick parse để lấy hash + auth_date ---
    var decQuick = {};
    (initData || '').split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i < 0) return;
      var k = decodeURIComponent(pair.slice(0, i));
      var v = decodeURIComponent(pair.slice(i + 1));
      decQuick[k] = v;
    });

    // --- Xác thực chuẩn (như cũ) ---
    var raw = {}, dec = {};
    (initData || '').split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i < 0) return;
      var kRaw = pair.slice(0, i), vRaw = pair.slice(i + 1);
      raw[kRaw] = vRaw;
      dec[decodeURIComponent(kRaw)] = decodeURIComponent(vRaw);
    });

    var hash = (dec['hash'] || '').toLowerCase();
    if (!hash) return { ok: false, error: 'missing_hash' };

    var decodedEntries = Object.keys(dec).filter(function (k) { return k !== 'hash'; }).sort().map(function (k) { return [k, dec[k]]; });
    var dcs = decodedEntries.map(function (kv) { return kv[0] + '=' + kv[1]; }).join('\n');

    var secretKey = Utilities.computeHmacSignature(
      Utilities.MacAlgorithm.HMAC_SHA_256,
      Utilities.newBlob(botToken).getBytes(),
      Utilities.newBlob('WebAppData').getBytes()
    );
    var sigBytes = Utilities.computeHmacSignature(
      Utilities.MacAlgorithm.HMAC_SHA_256,
      Utilities.newBlob(dcs).getBytes(),
      secretKey
    );
    var calcHex = _toHex(sigBytes);
    var authDate = Number(dec['auth_date'] || '0');

    if (calcHex !== hash) return { ok: false, error: 'hash_mismatch', dcs: dcs };
    if (authDate && Date.now() / 1000 - authDate > 86400) return { ok: false, error: 'auth_date_expired' };

    var user = dec['user'] ? JSON.parse(dec['user']) : null;

    // // --- Lưu cache: TTL = min(300s, thời gian còn lại tới 24h) ---
    // if (hash) {
    // var nowSec = Math.floor(Date.now() / 1000);
    // var remain = Math.max(0, 86400 - (nowSec - (authDate || 0)));
    // var ttl = Math.max(1, Math.min(300, remain)); // ≤ 5 phút
    // try { cache.put('auth:' + hash, JSON.stringify({ user: user, dcs: dcs }), ttl); } catch (_) { }
    // }
    return { ok: true, user: user, dcs: dcs };
  } catch (e) {
    return { ok: false, error: 'exception' };
  }
}

// [ADDED] Helpers cho khóa trùng
function _dupKey_(user_id, dateISO, timeISO, amount, merchant) {
  var u = String(user_id || '').trim();
  var d = String(dateISO || '');
  var t = String(timeISO || '00:00:00');
  var a = String(_parseAmountVND_(amount));
  var m = String(merchant || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return [u, d, t, a, m].join('|');
}
function _existingDupKeysSet_(sh) {
  var tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return { set: new Set(), idx: _headersIndexSafe([]) };
  var headers = data[0].map(String);
  var idx = _headersIndexSafe(headers);
  var S = new Set();
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (idx.deleted != null) {
      var del = String(row[idx.deleted] == null ? '' : row[idx.deleted]).trim();
      if (del === '1' || /^true$/i.test(del)) continue;
    }
    var k = _dupKey_(
      row[idx.user_id],
      _isoFromCell_(row[idx.date], tz),
      _isoTimeFromCell_(row[idx.time], tz) || '00:00:00',
      row[idx.amount],
      row[idx.merchant]
    );
    S.add(k);
  }
  return { set: S, idx: idx };
}

/** Public append (gọi trực tiếp hoặc qua Library) – [UPDATED] nén raw mặc định */
/** [UPDATED] appendExpense(): mặc định deleted=0 */
// [UPDATED] appendExpense(): mặc định thêm 'time' hiện tại & deleted=0
// [UPDATED] appendExpense(): bỏ qua nếu trùng khóa
function appendExpense(rec, apiKey) {
  const props = PropertiesService.getScriptProperties();
  const expect = props.getProperty('API_KEY');
  if (expect && apiKey && apiKey !== expect) throw new Error('Unauthorized: bad apiKey');

  const sh = _sheetTarget_();
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';

  // Chuẩn hóa & kiểm tra trùng
  const user_id = String(rec.user_id || '');
  const dateISO = String(rec.date || _today_());
  const timeISO = String(rec.time || _nowTime_(tz));
  const amount = Number(rec.amount || 0);
  const merchant = String(rec.merchant || '');
  const key = _dupKey_(user_id, dateISO, timeISO, amount, merchant);

  const { set, idx } = _existingDupKeysSet_(sh);
  if (set.has(key)) {
    // Đã tồn tại -> bỏ qua (không chèn)
    return null;
  }

  const row = {
    id: Utilities.getUuid(),
    user_id,
    date: dateISO,
    time: timeISO,
    amount,
    merchant,
    category: String(rec.category || 'Uncategorized'),
    note: String(rec.note || ''),
    source: String(rec.source || 'scanner'),
    raw: rec.raw ? _gzipB64Encode_(rec.raw) : '',
    deleted: 0
  };
  sh.appendRow([row.id, row.user_id, row.date, row.time, row.amount, row.merchant, row.category, row.note, row.source, row.raw, row.deleted]);
  return row.id;
}
/* [ADDED] Append nhiều bản ghi trong 1 lần setValues (nhanh hơn appendRow từng dòng) */
// [UPDATED] appendExpenses(): lọc trùng trước khi setValues; đồng thời khử trùng nội bộ batch
function appendExpenses(records, apiKey) {
  const props = PropertiesService.getScriptProperties();
  const expect = props.getProperty('API_KEY');
  if (expect && apiKey && apiKey !== expect) throw new Error('Unauthorized: bad apiKey');

  const sh = _sheetTarget_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const idx = _headersIndexSafe(headers);
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  const numCols = headers.length;

  // Tải khóa hiện có 1 lần
  const exist = _existingDupKeysSet_(sh).set;

  const rows = [];
  const ids = [];
  const seenInBatch = new Set();

  (records || []).forEach(function (rec) {
    const user_id = String(rec.user_id || '');
    const dateISO = String(rec.date || _today_());
    const timeISO = String(rec.time || _nowTime_(tz));
    const amount = Number(rec.amount || 0);
    const merchant = String(rec.merchant || '');
    const k = _dupKey_(user_id, dateISO, timeISO, amount, merchant);

    // Bỏ qua nếu đã có trong sheet hoặc đã gặp trong batch
    if (exist.has(k) || seenInBatch.has(k)) return;
    seenInBatch.add(k);

    const id = String(rec.id || Utilities.getUuid());
    const row = new Array(numCols).fill('');

    row[idx.id] = id;
    row[idx.user_id] = user_id;
    row[idx.date] = dateISO;
    if (idx.time != null) row[idx.time] = timeISO;
    row[idx.amount] = amount;
    row[idx.merchant] = merchant;
    row[idx.category] = String(rec.category || 'Uncategorized');
    row[idx.note] = String(rec.note || '');
    row[idx.source] = String(rec.source || 'scanner');
    row[idx.raw] = rec.raw ? _gzipB64Encode_(rec.raw) : '';
    if (idx.deleted != null) row[idx.deleted] = 0;

    rows.push(row);
    ids.push(id);
    exist.add(k); // thêm ngay để chặn các bản ghi sau
  });

  if (!rows.length) return []; // tất cả đều trùng

  const lock = LockService.getScriptLock();
  try { lock.waitLock(2000); } catch (_) { }

  try {
    const startRow = sh.getLastRow() + 1;
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      sh.getRange(startRow + i, 1, slice.length, numCols).setValues(slice);
    }
  } finally {
    try { lock.releaseLock(); } catch (_) { }
  }

  return ids;
}


function _today_() {
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

/** doPost – [UPDATED] nén raw mặc định khi action=append */
/** [UPDATED] doPost(): list có phân trang + [ADDED] stats toàn cục */
/** [UPDATED] doPost(): sửa 'list' (chuẩn hoá date) + 'stats' (parse date/amount an toàn) */
/** [UPDATED] doPost(): dùng cờ deleted thay vì xóa dòng; lọc deleted ở list/stats; cho phép update cờ */
/** [UPDATED] doPost(): nếu là Telegram thì phản hồi lại chính message (text/plain) */
// [UPDATED] doPost(): Telegram → trả lời nhanh text/plain + chống lặp theo update_id
/* [UPDATED] doPost(): thêm nhánh action=append_many để import theo lô */
function doPost(e) {
  const out = ContentService.createTextOutput();
  _cors(out).setMimeType(ContentService.MimeType.JSON);

  let payload = {};
  try {
    payload = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  } catch (err) {
    logRow('ERROR', 'POST/PARSE', '', 'Bad JSON', { err: String(err), sample: (e.postData && e.postData.contents || '').slice(0, 200) });
    return out.setContent(JSON.stringify({ ok: false, error: 'Bad JSON' }));
  }

  // Telegram webhook
  if (_isTelegramUpdate_(payload)) {
    // chống lặp do retry/timeout: chỉ xử lý lần đầu của update_id
    if (!_consumeOnceUpdate_(payload.update_id)) {
      // return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }
    try {
      handleTelegramUpdate(payload);
      // trả lời nhanh để Telegram không retry
      // return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    } catch (_e) {
      // return ContentService.createTextOutput("telegram_handle_failed").setMimeType(ContentService.MimeType.TEXT);
    }
    return;
  }

  // --- OLD: JSON API (action=append|list|update|stats|delete|categories) ---
  const action = (payload.action || '').toLowerCase();
  if (!action) return out.setContent(JSON.stringify({ ok: false, error: 'Missing action' }));

  const props = PropertiesService.getScriptProperties();
  const apiKey = (e.parameter && e.parameter.api_key) || (payload.api_key);
  const okBot = apiKey && apiKey === props.getProperty('API_KEY');

  let userId = null;
  if (!okBot) {
    const b64 = payload.initDataB64;
    if (!b64) return out.setContent(JSON.stringify({ ok: false, error: 'Missing initDataB64' }));
    const botToken = props.getProperty('BOT_TOKEN');
    if (!botToken) return out.setContent(JSON.stringify({ ok: false, error: 'missing_bot_token' }));
    const parsed = verifyInitDataCached(b64, botToken);
    if (!parsed.ok) return out.setContent(JSON.stringify({ ok: false, error: 'Invalid initData' }));
    userId = String(parsed.user.id);
  } else {
    userId = String(payload.user_id || '');
  }

  try {
    if (action === 'append') {
      const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
      const rec = {
        id: Utilities.getUuid(),
        user_id: userId,
        date: String(payload.date || _today_()),
        time: String(payload.time || _nowTime_(tz)),
        amount: Number(payload.amount || 0),
        merchant: String(payload.merchant || ''),
        category: String(payload.category || 'Uncategorized'),
        note: String(payload.note || ''),
        source: String(payload.source || 'manual'),
        raw: payload.raw ? _gzipB64Encode_(payload.raw) : '',
        deleted: 0
      };
      _sheetTarget_().appendRow([rec.id, rec.user_id, rec.date, rec.time, rec.amount, rec.merchant, rec.category, rec.note, rec.source, rec.raw, rec.deleted]);
      var item = {
        id: rec.id,
        date: rec.date,
        time: rec.time,
        amount: rec.amount,
        merchant: rec.merchant,
        category: rec.category,
        note: rec.note,
        source: rec.source,
        deleted: rec.deleted
      };
      // return out.setContent(JSON.stringify({ ok: true, item: item }));
      return out.setContent(JSON.stringify({ ok: true, id: rec.id, item: item }));
    }

    /* [ADDED] Import theo lô */
    if (action === 'append_many') {
      const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
      const srcItems = Array.isArray(payload.items) ? payload.items
        : Array.isArray(payload.records) ? payload.records
          : null;
      if (!srcItems) return out.setContent(JSON.stringify({ ok: false, error: 'Missing items[]' }));

      const toInsert = srcItems.map(function (it) {
        return {
          user_id: userId,
          date: String(it.date || _today_()),
          time: String(it.time || _nowTime_(tz)),
          amount: Number(it.amount || 0),
          merchant: String(it.merchant || ''),
          category: String(it.category || 'Uncategorized'),
          note: String(it.note || ''),
          source: String(it.source || 'manual'),
          raw: it.raw ? String(it.raw) : '',
          deleted: 0
        };
      });

      const ids = appendExpenses(toInsert, null); // nội bộ: không cần apiKey
      const items = toInsert.map(function (rec, i) {
        return {
          id: ids[i], date: rec.date, time: rec.time, amount: rec.amount,
          merchant: rec.merchant, category: rec.category, note: rec.note, source: rec.source, deleted: rec.deleted
        };
      });
      return out.setContent(JSON.stringify({ ok: true, count: ids.length, ids, items }));
    }

    if (action === 'list') {
      const page = Math.max(1, Number(payload.page || 1));
      const limit = _parseLimit_(payload.limit);
      const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
      const sh = _sheetTarget_();
      const data = sh.getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);
      const all = data.slice(1)
        .filter(function (r) { return String(r[idx.user_id]) === userId && !_isDeletedRow_(r, idx); })
        .map(function (r) {
          return {
            id: r[idx.id],
            date: _isoFromCell_(r[idx.date], tz),
            time: _isoTimeFromCell_(r[idx.time], tz) || '00:00:00',
            amount: r[idx.amount],
            merchant: r[idx.merchant],
            category: r[idx.category],
            note: r[idx.note],
            source: r[idx.source]
          };
        });
      all.sort(_cmpByDateIdDesc_);
      const total = all.length;
      const offset = (page - 1) * limit;
      const items = all.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      return out.setContent(JSON.stringify({ ok: true, items: items, total: total, page: page, limit: limit, hasMore: hasMore }));
    }

    if (action === 'update') {
      const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
      const id = payload.id;
      const fields = payload.fields;
      if (!id) return out.setContent(JSON.stringify({ ok: false, error: 'Missing id' }));
      const sh = _sheetTarget_();
      const data = sh.getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);

      for (var i = 1; i < data.length; i++) {
        if (data[i][idx.id] === id && String(data[i][idx.user_id]) === userId) {
          var row = i + 1;
          if (fields && typeof fields === 'object') {
            if (fields.date != null) sh.getRange(row, idx.date + 1).setValue(fields.date);
            if (fields.time != null && idx.time != null) sh.getRange(row, idx.time + 1).setValue(fields.time);
            if (fields.amount != null) sh.getRange(row, idx.amount + 1).setValue(Number(fields.amount));
            if (fields.merchant != null) sh.getRange(row, idx.merchant + 1).setValue(fields.merchant);
            if (fields.category != null) sh.getRange(row, idx.category + 1).setValue(fields.category);
            if (fields.note != null) sh.getRange(row, idx.note + 1).setValue(fields.note);
            if (fields.raw != null) sh.getRange(row, idx.raw + 1).setValue(fields.raw ? _gzipB64Encode_(fields.raw) : '');
            if (fields.deleted != null && idx.deleted != null) sh.getRange(row, idx.deleted + 1).setValue(_truthy_(fields.deleted) ? 1 : 0);
          }
          // đọc lại để trả về item đã cập nhật
          var vals = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
          var item = {
            id: vals[idx.id],
            date: _isoFromCell_(vals[idx.date], tz),
            time: _isoTimeFromCell_(vals[idx.time], tz) || '00:00:00',
            amount: vals[idx.amount],
            merchant: vals[idx.merchant],
            category: vals[idx.category],
            note: vals[idx.note],
            source: vals[idx.source],
            deleted: idx.deleted != null ? (_truthy_(vals[idx.deleted]) ? 1 : 0) : 0
          };
          return out.setContent(JSON.stringify({ ok: true, item: item }));
        }
      }
      return out.setContent(JSON.stringify({ ok: false, error: 'Not found' }));
    }
    if (action === 'stats') {
      const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
      const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
      const ym = today.slice(0, 7);
      const y = today.slice(0, 4);

      const sh = _sheetTarget_();
      const data = sh.getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);

      var day = 0, month = 0, year = 0;
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idx.user_id]) !== userId) continue;
        if (_isDeletedRow_(data[i], idx)) continue;

        var amt = _parseAmountVND_(data[i][idx.amount]);
        if (!(amt < 0)) continue; // chỉ tính chi

        var dISO = _isoFromCell_(data[i][idx.date], tz);
        if (!dISO) continue;

        var v = -amt;
        if (dISO === today) day += v;
        if (dISO.substring(0, 7) === ym) month += v;
        if (dISO.substring(0, 4) === y) year += v;
      }
      return out.setContent(JSON.stringify({ ok: true, day, month, year, today, ym, y }));
    }



    if (action === 'delete') {
      const { id } = payload;
      if (!id) return out.setContent(JSON.stringify({ ok: false, error: 'Missing id' }));
      const sh = _sheetTarget_();
      const data = sh.getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);
      if (idx.deleted == null) return out.setContent(JSON.stringify({ ok: false, error: 'Missing deleted column' }));
      for (let i = 1; i < data.length; i++) {
        if (data[i][idx.id] === id && String(data[i][idx.user_id]) === userId) {
          const row = i + 1;
          sh.getRange(row, idx.deleted + 1).setValue(1); // bật cờ xóa
          return out.setContent(JSON.stringify({ ok: true }));
        }
      }
      return out.setContent(JSON.stringify({ ok: false, error: 'Not found' }));
    }

    if (action === 'categories') {
      const items = ['Food', 'Transport', 'Shopping', 'Bills', 'Health', 'Education', 'Entertainment', 'Uncategorized'];
      return out.setContent(JSON.stringify({ ok: true, items }));
    }

    return out.setContent(JSON.stringify({ ok: false, error: 'Unknown action' }));
  } catch (err) {
    return out.setContent(JSON.stringify({ ok: false, error: String(err) }));
  }
}