// filename: apps-script/parser_hsbc_creditcard_notice.gs
/**
 * HSBC Credit Card – Purchase transaction notification (VI/EN)
 * Không chỉnh core. Chỉ tinh chỉnh lớp con để bám đúng mẫu mail và ghi chú theo yêu cầu.
 */
class HsbcCcNoticeParser {
  /** Tên ngân hàng (tuỳ biến theo brand tại VN) */
  static get BANK_NAME() { return 'Ngân hàng TNHH một thành viên HSBC (Việt Nam)'; }

  match(m) {
    if (!m) return false;
    const from = String(m.from || '');
    const subject = String(m.subject || '');
    const body = String(m.body || '');
    // Nới lỏng domain VN + cụm từ khoá giao dịch
    const fromStrict =
      /(^|<)\s*hsbc@notification\.hsbc\.com\.hk\s*(>|$)/i.test(from) ||
      /(^|<)[^>]*@(?:hsbc\.com\.vn|notification\.hsbc\.com)[^>]*?(>|$)/i.test(from);
    const subjHasHsbc = /hsbc/i.test(subject);
    const bodyHasHsbc = /hsbc/i.test(body);
    const hasTxKw = /(giao\s*dịch|charged|purchase|has been charged)/i.test(subject + ' ' + body);
    return fromStrict || ((subjHasHsbc || bodyHasHsbc) && hasTxKw);
  }

  parse(m) {
    const body = (m.body || '').replace(/\r/g, '');
    if (!body) return null;

    // Ưu tiên câu chứa mô tả giao dịch (VI hoặc EN)
    const txLine = this._findTxLine_(body);

    // Amount: ưu tiên trong txLine để tránh dính "Dư nợ/Số dư"
    const g = this._extractVndAmountInText_(txLine) || this._extractVndAmountInText_(body) || findAmountGeneric_((body));
    if (!g) return null;

    // Dấu cho HSBC: không dấu = chi; có dấu +/- => thu; có từ khoá refund => thu
    let sign = -1;
    const hasExplicitSign = (g.signHint === -1 || g.signHint === +1);
    if (hasExplicitSign) sign = +1;
    if (/(refund|hoàn|hoan|credit\s*back|reversal)/i.test(body)) sign = +1;

    // Merchant + Date (ưu tiên cùng câu với amount/txLine)
    let merchant = this._extractMerchant_(txLine) || this._extractMerchant_(body) || '';
    merchant = merchant.trim() || 'N/A';

    const date =
      this._extractDateIso_(txLine) ||
      this._extractDateIso_(body) ||
      '';

    // Số dư và khả dụng (ghi chú theo yêu cầu, giữ dấu phẩy ngăn nghìn)
    const curBalance = this._kvLabelVndInt_(body, /(Dư nợ hiện tại|Your current balance)/i);
    const availLimit = this._kvLabelVndInt_(body, /(số dư khả dụng|available limit)/i);
    const note = this._composeVietnameseNote_(curBalance, availLimit);

    return {
      amount: sign * g.abs,
      merchant,
      date,
      category: 'Uncategorized',
      type: classify(sign * g.abs),
      note,
      source: 'email',
      from: m.from || ''
    };
  }

  // ========= Helpers chuyên biệt cho HSBC =========
  _findTxLine_(text) {
    const lines = String(text || '').split(/\n/).map(s => s.trim()).filter(Boolean);
    // Tìm dòng chứa “giao dịch … số tiền … tại … vào ngày …” hoặc EN tương đương
    const i = lines.findIndex(ln => /(giao\s*dịch|has been charged|charged|purchase)/i.test(ln));
    if (i >= 0) return lines[i];
    const sentence = text.split(/[\.!\?]\s+/).find(s => /(giao\s*dịch|has been charged|charged|purchase)/i.test(s));
    return sentence ? sentence.trim() : '';
  }

  _extractVndAmountInText_(text) {
    if (!text) return null;
    // Cả hai định dạng: "VND397,250" hoặc "397,250 VND" (hỗ trợ NBSP, cho phép +/-)
    let m = text.match(/VND\s*([\+\-−–—]?\s*[0-9][0-9\.,\u00A0\u202F ]+)/i);
    if (m && m[1]) {
      const raw = m[0];
      const signHint = /^[\s]*[\-−–—]/.test(m[1]) ? -1 : (/^[\s]*\+/.test(m[1]) ? +1 : null);
      const abs = toIntAmountFromStr_(m[1]);
      if (abs > 0) return { abs, span: [m.index, m.index + raw.length], raw, signHint };
    }
    m = text.match(/([\+\-−–—]?\s*[0-9][0-9\.,\u00A0\u202F ]+)\s*VND/i);
    if (m && m[1]) {
      const raw = m[0];
      const signHint = /^[\s]*[\-−–—]/.test(m[1]) ? -1 : (/^[\s]*\+/.test(m[1]) ? +1 : null);
      const abs = toIntAmountFromStr_(m[1]);
      if (abs > 0) return { abs, span: [m.index, m.index + raw.length], raw, signHint };
    }
    return null;
  }

  _extractMerchant_(text) {
    if (!text) return '';
    // VI: “… tại BHX_5236 vào ngày …”
    let m = text.match(/tại\s+([A-Za-z0-9_\-\*\.\s]+?)(?=\s+(?:vào\s+ngày|on)\b|[,\.\n]|$)/i);
    if (m && m[1]) return m[1].trim();
    // EN: “… at merchant BHX_5236 on …” hoặc “… at BHX_5236 on …”
    m = text.match(/at\s+(?:merchant\s+)?([A-Za-z0-9_\-\*\.\s]+?)(?=\s+\bon\b|[,\.\n]|$)/i);
    if (m && m[1]) return m[1].trim();
    // Fallback: “merchant <name>”
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

  _kvLabelVndInt_(text, labelRegex) {
    if (!text) return 0;
    const lines = String(text || '').split(/\r?\n/);
    for (const lineRaw of lines) {
      const line = String(lineRaw || '').trim();
      if (!line) continue;
      const mLabel = line.match(labelRegex);
      if (!mLabel) continue;
      const tail = line.slice(mLabel.index + mLabel[0].length);
      let g = this._extractVndAmountInText_(tail);
      if (!g) g = this._extractVndAmountInText_(line);
      if (g && g.abs > 0) return g.abs;
    }

    const labelSrc = labelRegex.source;
    let m = text.match(new RegExp('(?:' + labelSrc + ')' + String.raw`[\s\S]{0,80}?VND\s*([0-9][0-9\.,\u00A0\u202F ]+)`, 'i'));
    if (m && m[1]) return toIntAmountFromStr_(m[1]);
    m = text.match(new RegExp('(?:' + labelSrc + ')' + String.raw`[\s\S]{0,80}?([0-9][0-9\.,\u00A0\u202F ]+)\s*VND`, 'i'));
    if (m && m[1]) return toIntAmountFromStr_(m[1]);
    return 0;
  }

  _composeVietnameseNote_(curBalanceInt, availInt) {
    const bank = HsbcCcNoticeParser.BANK_NAME;
    const hasBal = curBalanceInt > 0;
    const hasAvail = availInt > 0;
    const parts = [bank];
    if (hasBal && hasAvail) {
      parts.push(`Dư nợ hiện tại là ${this._formatVnd(curBalanceInt)} và số dư khả dụng là ${this._formatVnd(availInt)}`);
    } else if (hasBal) {
      parts.push(`Dư nợ hiện tại là ${this._formatVnd(curBalanceInt)}`);
    } else if (hasAvail) {
      parts.push(`Số dư khả dụng là ${this._formatVnd(availInt)}`);
    }
    return parts.filter(Boolean).join('. ');
  }

  _formatVnd(n) {
    if (!n || isNaN(n)) return '';
    const s = Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${s} VND`;
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
