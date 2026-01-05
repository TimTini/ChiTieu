// filename: apps-script/core_parser_framework.gs
/**
 * Kiểu chuẩn đầu ra.
 * @typedef {Object} ExpenseRecord
 * @property {number} amount     // âm = chi, dương = thu
 * @property {string} merchant
 * @property {string} date       // YYYY-MM-DD
 * @property {string} category   // mặc định "Uncategorized"
 * @property {"expense"|"income"} type
 * @property {string} note
 * @property {"bank_sms"|"webapp"|"email"} source
 * @property {string} from
 */

/**
 * Kiểu message đầu vào (đã lấy được plain text body).
 * @typedef {Object} EmailMessage
 * @property {string} from
 * @property {string} subject
 * @property {string} body
 */

class ParserRegistry {
  static register(parser) {
    if (!this._parsers) this._parsers = [];
    this._parsers.push(parser);
  }
  static parse(msg) {
    const parsers = this._parsers || [];
    for (const p of parsers) {
      try {
        if (p.match(msg)) {
          const rec = p.parse(msg);
          if (rec) return rec;
        }
      } catch (_e) {}
    }
    return null;
  }
}

/** ===== Helpers chung (port từ Python logic) ===== */
function stripHtml_(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function parseVndToInt(str) { return toIntAmountFromStr_(str); } // dùng chung 1 đường
function classify(n) { return n <= 0 ? 'expense' : 'income'; }   // 0 coi là chi để tránh sai "income"
function makeNote(parts) { return parts.filter(Boolean).join(' · '); }
function toIsoDateFromVN(dtStr) {
  if (!dtStr) return '';
  // yyyy-mm-dd / yyyy/mm/dd
  let m = dtStr.match(/\b(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\b/);
  if (m) return `${pad2_(m[1])}-${pad2_(m[2])}-${pad2_(m[3])}`;
  // dd/mm[/yy|yyyy]
  m = dtStr.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (m) {
    let dd = +m[1], MM = +m[2]; let yy = m[3];
    let y;
    if (!yy) y = new Date().getFullYear();
    else if (yy.length === 2) { const n = +yy; y = n < 70 ? 2000 + n : 1900 + n; }
    else y = +yy;
    return `${pad2_(y)}-${pad2_(MM)}-${pad2_(dd)}`;
  }
  return '';
}
function pad2_(v){ v=String(v); return v.length===1?'0'+v:v; }

/** Regex & generic finders (tương tự Python) */
const AMT_CURRENCY_RE = /([+\-−–—])?\s*\b((?:\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:[.,]\d{1,2})?)\s*(vnd|vnđ|đ|₫|dong|đồng)?\b/gi;
const AMT_SHORTHAND_RE = /(\d+(?:[.,]\d+)?)\s*(k|nghìn|ngàn|ngan|tr|triệu|m|b|tỷ|ty)\b/gi;

const KW_EXPENSE_RE = /(chi|thanh\s*toán|mua|trừ|ghi\s*nợ|debit|pos|qr|napas|auto[- ]?debit|credit\s*card)/i;
const KW_INCOME_RE  = /(thu|nhận|ghi\s*có|credit(?!\s*card)|cộng|nạp|refund|hoàn|credit\s*back|reversal)/i;
const MERCHANT_RES = [
  /(?:NỘI\s*DUNG|NOI\s*DUNG|ND|ND\s*GD|NỘI\s*DUNG\s*GD)[:\-]\s*([^.;\n]+)/i,
  /(?:MÔ\s*TẢ|MO\s*TA|DIỄN\s*GIẢI|DIEN\s*GIAI|DG)[:\-]\s*([^.;\n]+)/i,
  /(?:TẠI|TAI|Ở|O)\s+([^.;\n]+)/i,
  /(?:MERCHANT|POS|NAPAS|QR)[:\s]+([^.;\n]+)/i,
  /(?:FROM|TỪ|TU)[:\s]+([^.;\n]+)/i,
];

function unitMultiplier_(u){
  const t = (u||'').toLowerCase();
  if (['k','nghìn','ngan','ngàn'].includes(t)) return 1000;
  if (['tr','triệu','m'].includes(t)) return 1000000;
  if (['b','tỷ','ty'].includes(t)) return 1000000000;
  return 1;
}
function toIntAmountFromStr_(s){
  s = String(s||'').replace(/\s+/g,'');
  // chấp nhận NBSP & narrow NBSP:
  s = s.replace(/\u00A0|\u202F/g, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g,'').split(',')[0];
  else s = s.replace(/[.,]/g,'');
  const d = s.replace(/[^\d]/g,'');
  return d?parseInt(d,10):0;
}
function peekSign_(text, idx){
  const left = String(text||'').slice(Math.max(0, idx-2), idx);
  if (/[{\[\(]$/.test(left)) return null;
  if (/[\-−–—]\s*$/.test(left)) return -1;
  if (/\+\s*$/.test(left)) return +1;
  return null;
}

/** Tìm amount generic: trả {abs, span:[s,e], raw, signHint} */
function findAmountGeneric_(text){
  if (!text) return null;

  // 1) shorthand: 12k, 3.5tr...
  AMT_SHORTHAND_RE.lastIndex = 0;
  let m = AMT_SHORTHAND_RE.exec(text);
  if (m){
    const val = parseFloat(m[1].replace(',','.'));
    const abs = Math.round(val * unitMultiplier_(m[2]));
    const signHint = peekSign_(text, m.index);
    return { abs, span:[m.index, m.index+m[0].length], raw:m[0], signHint };
  }

  // 2) số kèm đơn vị / số rời rạc
  const hint = /số\s*t[ií]ền|amount|sotien/i.exec(text);
  const nearPos = hint ? hint.index : -1;

  let best = null;
  AMT_CURRENCY_RE.lastIndex = 0;
  while ((m = AMT_CURRENCY_RE.exec(text))){
    const raw = m[0];
    const numStr = m[2];
    const cur = m[3]; // có đơn vị?
    const abs = toIntAmountFromStr_(numStr);
    if (abs <= 0) continue;

    // Bỏ qua chuỗi dính liền chữ cái mà KHÔNG có đơn vị (ví dụ "X3453")
    const prevChar = text[m.index - 1] || '';
    if (!cur && /[A-Za-z]/.test(prevChar)) continue;

    const signToken = m[1];
    const signHint = signToken ? (/\+/.test(signToken)?+1:-1) : peekSign_(text, m.index);

    const dist = nearPos>=0 ? Math.abs(m.index - nearPos) : 9999;
    const hasVND = cur ? 0 : 1; // có đơn vị → điểm tốt hơn (0 tốt hơn 1)
    const early = m.index;

    const score = (hasVND*1e9) + (dist*1e3) + early; // càng nhỏ càng tốt
    if (!best || score < best.score){
      best = { score, abs, span:[m.index, m.index+raw.length], raw, signHint };
    }
  }
  return best ? {abs:best.abs, span:best.span, raw:best.raw, signHint:best.signHint} : null;
}

function findMerchantGeneric_(text){
  for (const rx of MERCHANT_RES){
    const m = rx.exec(text);
    if (m && m[1]) return m[1].trim().replace(/\s{2,}/g,' ');
  }
  return '';
}
function fallbackDescAfterRemoveAmount_(text, span){
  if (!span) return '';
  const s = (text.slice(0,span[0]) + ' ' + text.slice(span[1])).replace(/[\-\–\—\:|\(\)\[\]<>~]+/g, ' ');
  return s.replace(/\s+/g,' ').trim();
}
function findDateIso_(text){
  // ưu tiên yyyy-mm-dd (nếu có), không thì đ/tt/nn
  let d = toIsoDateFromVN(text);
  if (d) return d;
  return '';
}
/** Tìm giá trị ở TRÊN hoặc DƯỚI dòng nhãn (ưu tiên TRÊN). */
function nearValueForLabels_(body, labels, validator){
  const linesRaw = String(body||'').split(/\r?\n/);
  const lines = linesRaw.map(s=>s.trim());
  const idxs = [];
  for (let i=0;i<lines.length;i++) if (lines[i]) idxs.push(i);
  const isLabel = (ln)=> labels.some(lb => ln.toLowerCase().includes(lb.toLowerCase()));
  for (let k=0;k<idxs.length;k++){
    const i = idxs[k];
    if (!isLabel(lines[i])) continue;
    // trên
    if (k-1>=0){
      const v = lines[idxs[k-1]].trim();
      if (!validator || validator(v)) return v;
    }
    // dưới
    if (k+1<idxs.length){
      const v = lines[idxs[k+1]].trim();
      if (!validator || validator(v)) return v;
    }
  }
  return '';
}
