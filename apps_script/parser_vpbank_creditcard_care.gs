// filename: apps-script/parser_vpbank_creditcard_care.gs
/**
 * VPBank Credit Card – Balance Changed (VI/EN)
 * From (typical): customercare@care.vpb.com.vn
 * Quy tắc dấu: '-' = chi (âm), '+' = thu (dương). Nếu không thấy dấu → mặc định chi.
 * Yêu cầu: CHỈ thay đổi note → "Ngân hàng TMCP Việt Nam Thịnh Vượng (VPBank). <AvailValue> Hạn mức còn lại / Available Limit"
 */
class VpbankCcCareParser {
  /** Tên ngân hàng hiển thị trong note */
  static get BANK_NAME() { return 'Ngân hàng TMCP Việt Nam Thịnh Vượng (VPBank)'; }

  match(m) {
    if (!m) return false;
    const from = String(m.from || '');
    const subject = String(m.subject || '');
    const body = String(m.body || '');

    const fromOk = /(^|<)[^>]*@(?:care\.)?vpb\.com\.vn\s*(>|$)/i.test(from);
    const kw = /(bi[eê]n ?đ[ôo]ng s[ốo]\s*d[ưư]|balance\s*chang(?:e|ed))/i; // "BIẾN ĐỘNG SỐ DƯ" / "Balance Changed"
    return fromOk && (kw.test(subject) || kw.test(body));
  }

  parse(m) {
    const b = (m.body || '').replace(/\r/g, '');

    // Amount (giá trị thường nằm TRÊN nhãn "Số tiền thay đổi / Changed Amount")
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
      else sign = -1; // mặc định chi
    } else {
      const g = findAmountGeneric_(b);
      if (!g) return null;
      abs = g.abs;
      const sNear = this._peekSignNearSpan_(b, g.span);
      if (sNear === +1) sign = +1;
      else if (sNear === -1) sign = -1;
      else sign = -1;
      span = g.span;
    }

    // Merchant (giá trị thường nằm TRÊN nhãn "Nội dung / Transaction Content")
    let merchant = nearValueForLabels_(b, ['Nội dung', 'Transaction Content'], (s) => !!s && !/\bVND\b/i.test(s)) || '';
    if (!merchant) merchant = findMerchantGeneric_(b) || (span ? fallbackDescAfterRemoveAmount_(b, span) : '') || '';
    merchant = merchant.trim();

    // Date (giá trị thường nằm TRÊN nhãn "Thời gian / Time")
    const dateStr = nearValueForLabels_(b, ['Thời gian', 'Time'], (s) => /\d{2}[\/-]\d{2}[\/-]\d{2,4}/.test(s)) || '';
    const date = toIsoDateFromVN(dateStr) || findDateIso_(b) || '';

    // Avail (giá trị thường nằm TRÊN nhãn "Hạn mức còn lại / Available Limit")
    const availVal = nearValueForLabels_(b, ['Hạn mức còn lại', 'Available Limit'], (s) => /\bVND\b/i.test(s)) || '';

    // NOTE — chỉ theo yêu cầu: "<BANK>. <avail> Hạn mức còn lại / Available Limit"
    const note = [
      VpbankCcCareParser.BANK_NAME,
      availVal ? `${availVal} Hạn mức còn lại / Available Limit` : ''
    ].filter(Boolean).join('. ');

    /** @type {ExpenseRecord} */
    return {
      amount: sign * abs,
      merchant,
      date,
      category: 'Uncategorized',
      type: classify(sign * abs),
      note,
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
