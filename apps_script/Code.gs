// filename: apps_script/Code.gs
// Gắn vào Google Spreadsheet (SHEET_NAME = 'transactions')
// Script Properties: API_KEY=<secret>, BOT_TOKEN=<your_bot_token>, (tuỳ chọn) SPREADSHEET_ID=<id đích>

const SHEET_NAME = 'transactions';
const LOG_SHEET_NAME = 'log';
const DEBUG = false;

function _cors(resp) { return resp; }
// [ADDED] Helper: so sánh date desc + id desc (date dạng yyyy-MM-dd)
function _cmpByDateIdDesc_(a, b) {
  const da = String(a.date || '');
  const db = String(b.date || '');
  if (db !== da) return db > da ? 1 : -1;
  const ia = String(a.id || '');
  const ib = String(b.id || '');
  return ib.localeCompare(ia);
}

// [ADDED] Helper: giới hạn limit 10|20|50
function _parseLimit_(v) {
  var n = Number(v);
  if (n === 10 || n === 20 || n === 50) return n;
  if (n <= 10) return 10;
  if (n >= 50) return 50;
  return 20;
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

/** Spreadsheet sheet helpers */
function _sheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['id', 'user_id', 'date', 'amount', 'merchant', 'category', 'note', 'source', 'raw']);
  }
  return sh;
}
function _sheetTarget_() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('SPREADSHEET_ID');
  const ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['id', 'user_id', 'date', 'amount', 'merchant', 'category', 'note', 'source', 'raw']);
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

/** Mini-app auth verify */
function verifyInitData(initData, botToken) {
  const CTX = 'AUTH/WEBAPP';
  try {
    if (!botToken) return { ok: false, error: 'missing_bot_token' };
    const raw = {}, dec = {};
    (initData || '').split('&').forEach((pair) => {
      const i = pair.indexOf('=');
      if (i < 0) return;
      const kRaw = pair.slice(0, i), vRaw = pair.slice(i + 1);
      raw[kRaw] = vRaw;
      dec[decodeURIComponent(kRaw)] = decodeURIComponent(vRaw);
    });
    const hash = (dec['hash'] || '').toLowerCase();
    if (!hash) return { ok: false, error: 'missing_hash' };

    const decodedEntries = Object.keys(dec).filter(k => k !== 'hash').sort().map(k => [k, dec[k]]);
    const dcs = decodedEntries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = Utilities.computeHmacSignature(
      Utilities.MacAlgorithm.HMAC_SHA_256,
      Utilities.newBlob(botToken).getBytes(),
      Utilities.newBlob('WebAppData').getBytes()
    );
    const sigBytes = Utilities.computeHmacSignature(
      Utilities.MacAlgorithm.HMAC_SHA_256,
      Utilities.newBlob(dcs).getBytes(),
      secretKey
    );
    const calcHex = _toHex(sigBytes);
    const authDate = Number(dec['auth_date'] || '0');
    if (calcHex !== hash) return { ok: false, error: 'hash_mismatch', dcs };
    if (authDate && Date.now() / 1000 - authDate > 86400) return { ok: false, error: 'auth_date_expired' };
    const user = dec['user'] ? JSON.parse(dec['user']) : null;
    return { ok: true, user, dcs };
  } catch (e) { return { ok: false, error: 'exception' }; }
}

/** Public append (gọi trực tiếp hoặc qua Library) – [UPDATED] nén raw mặc định */
function appendExpense(rec, apiKey) {
  const props = PropertiesService.getScriptProperties();
  const expect = props.getProperty('API_KEY');
  if (expect && apiKey && apiKey !== expect) throw new Error('Unauthorized: bad apiKey');

  const row = {
    id: Utilities.getUuid(),
    user_id: String(rec.user_id || ''),
    date: String(rec.date || _today_()),
    amount: Number(rec.amount || 0),
    merchant: String(rec.merchant || ''),
    category: String(rec.category || 'Uncategorized'),
    note: String(rec.note || ''),
    source: String(rec.source || 'scanner'),
    raw: rec.raw ? _gzipB64Encode_(rec.raw) : ''   // <<< nén ở đây
  };
  const sh = _sheetTarget_();
  sh.appendRow([row.id, row.user_id, row.date, row.amount, row.merchant, row.category, row.note, row.source, row.raw]);
  return row.id;
}

function _today_() {
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

/** doPost – [UPDATED] nén raw mặc định khi action=append */
// [UPDATED] doPost(): list có phân trang + [ADDED] stats toàn cục
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
    const chk = _getMeChecked(botToken, false);
    if (!chk.ok) return out.setContent(JSON.stringify({ ok: false, error: 'invalid_bot_token' }));
    const parsed = verifyInitData(_b64ToString(b64), botToken);
    if (!parsed.ok) return out.setContent(JSON.stringify({ ok: false, error: 'Invalid initData' }));
    userId = String(parsed.user.id);
  } else {
    userId = String(payload.user_id || '');
  }

  try {
    if (action === 'append') {
      const rec = {
        id: Utilities.getUuid(),
        user_id: userId,
        date: String(payload.date || _today_()),
        amount: Number(payload.amount || 0),
        merchant: String(payload.merchant || ''),
        category: String(payload.category || 'Uncategorized'),
        note: String(payload.note || ''),
        source: String(payload.source || 'manual'),
        raw: payload.raw ? _gzipB64Encode_(payload.raw) : ''
      };
      _sheetTarget_().appendRow([rec.id, rec.user_id, rec.date, rec.amount, rec.merchant, rec.category, rec.note, rec.source, rec.raw]);
      return out.setContent(JSON.stringify({ ok: true, id: rec.id }));
    }

    // [UPDATED] LIST: phân trang + sắp xếp ổn định
    if (action === 'list') {
      const page = Math.max(1, Number(payload.page || 1));
      const limit = _parseLimit_(payload.limit);
      const data = _sheet().getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);
      const all = data.slice(1)
        .filter(r => String(r[idx.user_id]) === userId)
        .map(r => ({
          id: r[idx.id], date: r[idx.date], amount: r[idx.amount],
          merchant: r[idx.merchant], category: r[idx.category],
          note: r[idx.note], source: r[idx.source]
        }));
      all.sort(_cmpByDateIdDesc_);
      const total = all.length;
      const offset = (page - 1) * limit;
      const items = all.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      return out.setContent(JSON.stringify({ ok: true, items, total, page, limit, hasMore }));
    }

    // [ADDED] STATS: tổng chi hôm nay / tháng / năm (không phụ thuộc trang)
    if (action === 'stats') {
      const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
      const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
      const ym = today.slice(0, 7);
      const y = today.slice(0, 4);
      const data = _sheet().getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);
      var day = 0, month = 0, year = 0;
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idx.user_id]) !== userId) continue;
        var amt = Number(data[i][idx.amount]) || 0;
        if (amt >= 0) continue; // chỉ tính chi
        var d = String(data[i][idx.date] || '');
        var v = -amt;
        if (d === today) day += v;
        if (d.substring(0, 7) === ym) month += v;
        if (d.substring(0, 4) === y) year += v;
      }
      return out.setContent(JSON.stringify({ ok: true, day, month, year, today, ym, y }));
    }

    if (action === 'update') {
      const { id, fields } = payload;
      if (!id) return out.setContent(JSON.stringify({ ok: false, error: 'Missing id' }));
      const sh = _sheetTarget_();
      const data = sh.getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);
      for (let i = 1; i < data.length; i++) {
        if (data[i][idx.id] === id && String(data[i][idx.user_id]) === userId) {
          const row = i + 1;
          if (fields && typeof fields === 'object') {
            if (fields.date) sh.getRange(row, idx.date + 1).setValue(fields.date);
            if (fields.amount != null) sh.getRange(row, idx.amount + 1).setValue(Number(fields.amount));
            if (fields.merchant != null) sh.getRange(row, idx.merchant + 1).setValue(fields.merchant);
            if (fields.category != null) sh.getRange(row, idx.category + 1).setValue(fields.category);
            if (fields.note != null) sh.getRange(row, idx.note + 1).setValue(fields.note);
            if (fields.raw != null) sh.getRange(row, idx.raw + 1).setValue(fields.raw ? _gzipB64Encode_(fields.raw) : '');
          }
          return out.setContent(JSON.stringify({ ok: true }));
        }
      }
      return out.setContent(JSON.stringify({ ok: false, error: 'Not found' }));
    }

    if (action === 'delete') {
      const { id } = payload;
      if (!id) return out.setContent(JSON.stringify({ ok: false, error: 'Missing id' }));
      const sh = _sheetTarget_();
      const data = sh.getDataRange().getValues();
      const idx = (typeof _headersIndex === 'function' ? _headersIndex : _headersIndexSafe)(data[0]);
      for (let i = 1; i < data.length; i++) {
        if (data[i][idx.id] === id && String(data[i][idx.user_id]) === userId) {
          sh.deleteRow(i + 1);
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