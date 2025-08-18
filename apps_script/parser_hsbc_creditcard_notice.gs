// filename: apps-script/parser_hsbc_creditcard_notice.gs
/**
 * HSBC Credit Card – Purchase transaction notification
 * Quy tắc dấu: không có dấu = chi (âm). Có dấu '-' = thu (dương). (Nếu có '+', coi như thu.)
 */
class HsbcCcNoticeParser {
  match(m) {
    if (!m) return false;
    const from = String(m.from || '');
    const subject = String(m.subject || '');
    const body = String(m.body || '');
    const fromStrict = /(^|<)\s*hsbc@notification\.hsbc\.com\.hk\s*(>|$)/i.test(from) ||
                       /notification\.hsbc\.com/i.test(from);
    const subjHasHsbc = /hsbc/i.test(subject);
    const bodyHasHsbc = /hsbc/i.test(body);
    const hasTxKw = /(giao\s*dịch|charged|purchase)/i.test(subject + ' ' + body);
    return fromStrict || ((subjHasHsbc || bodyHasHsbc) && hasTxKw);
  }

  parse(m) {
    const body = (m.body || '').replace(/\r/g, '');
    if (!body) return null;

    // Amount (ưu tiên trong câu giao dịch)
    const txLine = this._findTxLine_(body);
    let g = this._extractVndAmountInText_(txLine) || this._extractVndAmountInText_(body) || findAmountGeneric_(body);
    if (!g) return null;

    // Quy tắc dấu dành cho HSBC
    let sign = -1; // mặc định chi nếu không có dấu
    const sNear = this._peekSignNearSpan_(body, g.span);
    if (sNear === -1) sign = +1; // '-' → thu
    else if (sNear === +1) sign = +1; // '+' (hiếm) → thu
    // Nếu có từ khoá refund thì ép thu
    if (/(refund|hoàn|hoan|credit\s*back|reversal)/i.test(body)) sign = +1;

    // Merchant
    let merchant = this._extractMerchant_(txLine) || this._extractMerchant_(body);
    if (!merchant && g.span) merchant = fallbackDescAfterRemoveAmount_(body, g.span);
    merchant = (merchant || '').trim();

    // Date
    const date = this._extractDateIso_(txLine) || this._extractDateIso_(body) || '';

    // Extras
    const card = this._extractCardTail_(body);
    const bal  = this._kvLabelVnd_(body, /(Dư nợ hiện tại|Your current balance)/i);
    const avail= this._kvLabelVnd_(body, /(số dư khả dụng|available limit)/i);

    return {
      amount: sign * g.abs,
      merchant: merchant || 'N/A',
      date,
      category: 'Uncategorized',
      type: classify(sign * g.abs),
      note: makeNote([card ? `Card ${card}` : '', bal ? `Bal ${bal}` : '', avail ? `Avail ${avail}` : '']),
      source: 'email',
      from: m.from || ''
    };
  }

  // ========= Helpers =========
  _findTxLine_(text) {
    const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean);
    const i = lines.findIndex(ln => /(giao\s*dịch|charged|purchase)/i.test(ln));
    if (i >= 0) return lines[i];
    const sentence = text.split(/[\.!\?]\s+/).find(s => /(giao\s*dịch|charged|purchase)/i.test(s));
    return sentence ? sentence.trim() : '';
  }

  _extractVndAmountInText_(text) {
    if (!text) return null;
    // "VND397,250" hoặc "397,250 VND" (hỗ trợ NBSP)
    let m = text.match(/VND\s*([0-9][0-9\.,\u00A0\u202F ]+)/i);
    if (m && m[1]) {
      const raw = m[0];
      const abs = toIntAmountFromStr_(m[1]);
      if (abs > 0) return { abs, span: [m.index, m.index + raw.length], raw, signHint: null };
    }
    m = text.match(/([0-9][0-9\.,\u00A0\u202F ]+)\s*VND/i);
    if (m && m[1]) {
      const raw = m[0];
      const abs = toIntAmountFromStr_(m[1]);
      if (abs > 0) return { abs, span: [m.index, m.index + raw.length], raw, signHint: null };
    }
    return null;
  }

  _extractMerchant_(text) {
    if (!text) return '';
    // VI
    let m = text.match(/tại\s+([A-Za-z0-9_\-\*\.\s]+?)(?=\s+(?:vào\s+ngày|on)\b|[,\.\n]|$)/i);
    if (m && m[1]) return m[1].trim();
    // EN
    m = text.match(/at\s+(?:merchant\s+)?([A-Za-z0-9_\-\*\.\s]+?)(?=\s+\bon\b|[,\.\n]|$)/i);
    if (m && m[1]) return m[1].trim();
    // fallback "merchant <name>"
    m = text.match(/\bmerchant\s+([A-Za-z0-9_\-\*\.\s]+?)(?=\s+(?:on|,|\.)|$)/i);
    if (m && m[1]) return m[1].trim();
    return findMerchantGeneric_(text) || '';
  }

  _extractDateIso_(text) {
    if (!text) return '';
    let m = text.match(/(?:vào\s+ngày|on)\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (m && m[1]) return toIsoDateFromVN(m[1]);
    m = text.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
    if (m && m[1]) return toIsoDateFromVN(m[1]);
    return '';
  }

  _extractCardTail_(text) {
    // Chỉ bắt dạng X3453 (1 chữ + 4 số), tránh dính amount
    const m = text.match(/\b([A-Z])(\d{4})\b/);
    return m ? (m[1] + m[2]) : '';
  }

  _kvLabelVnd_(text, labelRegex) {
    let m = text.match(new RegExp(labelRegex.source + String.raw`\s*(?:\w+\s+){0,3}VND\s*([0-9][0-9\.,\u00A0\u202F ]+)`, 'i'));
    if (m && m[1]) return `${toIntAmountFromStr_(m[1])} VND`;
    m = text.match(new RegExp(labelRegex.source + String.raw`.*?([0-9][0-9\.,\u00A0\u202F ]+)\s*VND`, 'i'));
    if (m && m[1]) return `${toIntAmountFromStr_(m[1])} VND`;
    return '';
  }

  _peekSignNearSpan_(text, span) {
    if (!span) return null;
    const left = String(text || '').slice(Math.max(0, span[0] - 2), span[0]);
    if (/[\-−–—]\s*$/.test(left)) return -1;
    if (/\+\s*$/.test(left)) return +1;
    return null;
  }
}
ParserRegistry.register(new HsbcCcNoticeParser());
