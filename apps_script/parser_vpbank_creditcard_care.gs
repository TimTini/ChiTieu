// filename: apps-script/parser_vpbank_creditcard_care.gs
/**
 * VPBank Credit Card balance change
 * From: customercare@care.vpb.com.vn
 * Quy tắc dấu: '-' = chi (âm), '+' = thu (dương). Nếu không thấy dấu → mặc định chi.
 */
class VpbankCcCareParser {
  match(m) {
    if (!m || !m.from || !m.subject) return false;
    const fromOk = /customercare@care\.vpb\.com\.vn/i.test(m.from);
    const subjOk = /bi[eê]n ?đ[ôo]ng s[ốo] d[ưu]|balance ?change/i.test(m.subject);
    return fromOk && subjOk;
  }

  parse(m) {
    const b = m.body || '';

    // Amount: ưu tiên dòng kề nhãn (giá trị thường NẰM TRÊN nhãn)
    let amountLine = nearValueForLabels_(
      b,
      ['Số tiền thay đổi', 'Changed Amount'],
      (s) => /\bVND\b/i.test(s) || /^[\+\-−–—]?\s*[\d\.,]+\s*VND$/i.test(s)
    );
    let abs = 0, sign = -1, span = null;

    if (amountLine) {
      abs = parseVndToInt(amountLine);
      const c = amountLine.trimStart().charAt(0);
      if (c === '+') sign = +1;
      else if (c === '-' || c === '−' || c === '–' || c === '—') sign = -1;
      else sign = -1; // mặc định chi nếu không có dấu
    } else {
      // Fallback generic
      const g = findAmountGeneric_(b);
      if (!g) return null;
      abs = g.abs;
      // cố gắng đọc dấu ngay trước số
      const sNear = this._peekSignNearSpan_(b, g.span);
      if (sNear === +1) sign = +1;
      else if (sNear === -1) sign = -1;
      else sign = -1; // mặc định chi
      span = g.span;
    }

    // Merchant
    let merchant =
      nearValueForLabels_(b, ['Nội dung', 'Transaction Content'], (s) => !!s && !/\bVND\b/i.test(s)) ||
      '';
    if (!merchant) merchant = findMerchantGeneric_(b) || (span ? fallbackDescAfterRemoveAmount_(b, span) : '') || '';

    // Date
    const dateStr = nearValueForLabels_(b, ['Thời gian', 'Time'], (s) => /\d{2}[\/-]\d{2}[\/-]\d{2,4}/.test(s)) || '';
    const date = toIsoDateFromVN(dateStr) || findDateIso_(b) || '';

    // Extras
    const avail = nearValueForLabels_(b, ['Hạn mức còn lại', 'Available Limit'], (s) => /\bVND\b/i.test(s)) || '';
    const card  = nearValueForLabels_(b, ['Thẻ', 'Card'], () => true) || '';
    const code  = nearValueForLabels_(b, ['Mã giao dịch', 'Transaction Code'], () => true) || '';

    /** @type {ExpenseRecord} */
    return {
      amount: sign * abs,
      merchant,
      date,
      category: 'Uncategorized',
      type: classify(sign * abs),
      note: makeNote([card, code ? `Code ${code}` : '', avail ? `Avail ${avail}` : '']),
      source: 'email',
      from: m.from || ''
    };
  }

  _peekSignNearSpan_(text, span) {
    if (!span) return null;
    const left = String(text || '').slice(Math.max(0, span[0] - 2), span[0]);
    if (/[\-−–—]\s*$/.test(left)) return -1;
    if (/\+\s*$/.test(left)) return +1;
    return null;
  }
}
ParserRegistry.register(new VpbankCcCareParser());
