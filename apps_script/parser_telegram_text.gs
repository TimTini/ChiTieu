// filename: apps-script/parser_telegram_text.gs
// [UPDATED] TelegramTextParser: ưu tiên ngữ nghĩa từ khóa > dấu số
// - "nạp -2tr" → THU +2tr
// - "ăn sáng 300k" → CHI -300k (mặc định chi nếu không có từ khóa thu)
class TelegramTextParser {
  match(m) {
    if (!m || typeof m.text !== 'string') return false;
    const t = m.text.trim();
    if (!t) return false;
    return /(\d+(?:[.,]\d+)?)\s*(k|nghìn|ngàn|ngan|tr|triệu|m|b|tỷ|ty)\b/i.test(t) ||
           /(?:^|[\s\+\-−–—])\d[\d.,]*(?:\s*(?:vnd|đ|₫|dong|đồng))\b/i.test(t);
  }

  parse(m) {
    const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
    const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const text = String(m.text || '').trim();
    if (!text) return null;

    const lower = text.toLowerCase();

    // Từ khóa định hướng dấu
    const isIncomeHint = /(thu|cộng|nap|nạp|credit(?!\s*card)|income|\+)\b/.test(lower);
    const isExpenseHint = /(chi|mua|thanh toán|thêm|trả|pay|spent?)/.test(lower);

    // Bắt số + đơn vị
    let mm = lower.match(/([+-]?\d[\d.,]*)(?:\s*(k|ngh?ìn|ngàn|ngan|tr|triệu|m|tỷ|ty|bn|b|bil|billion)?)\s*(?:vnd|đ|d|₫|dong|đồng)?/i);
    if (!mm) return null;

    // Chuẩn hoá trị tuyệt đối
    let numStr = mm[1].replace(/\s/g, '');
    let val = parseFloat(numStr.replace(/,/g, '.'));
    if (!isFinite(val)) return null;
    switch ((mm[2] || '').toLowerCase()) {
      case 'k': case 'nghìn': case 'nghin': case 'ngàn': case 'ngan': val *= 1e3; break;
      case 'tr': case 'triệu': case 'm': val *= 1e6; break;
      case 'tỷ': case 'ty': case 'bn': case 'b': case 'bil': case 'billion': val *= 1e9; break;
    }
    val = Math.round(val);

    // QUY TẮC DẤU:
    // 1) Nếu có từ khóa THU (và không có từ khóa CHI) → ép dương (thu), kể cả số có dấu '-'
    // 2) Nếu có từ khóa CHI (và không có từ khóa THU) → ép âm (chi)
    // 3) Nếu không có định hướng → tôn trọng dấu trong số; nếu không có dấu → mặc định âm (chi)
    let sign;
    if (isIncomeHint && !isExpenseHint) {
      sign = +1;
    } else if (isExpenseHint && !isIncomeHint) {
      sign = -1;
    } else if (/^-/.test(mm[1])) {
      sign = -1;
    } else if (/^\+/.test(mm[1])) {
      sign = +1;
    } else {
      sign = -1; // mặc định chi
    }

    // Merchant = phần còn lại sau khi bỏ cụm số
    const before = text.slice(0, mm.index).trim();
    const after = text.slice(mm.index + mm[0].length).trim();
    let merchant = (before + ' ' + after).replace(/\s+/g, ' ').trim();
    merchant = merchant.replace(/^(thêm|chi|mua|pay|thanh toán|nạp|nap)\b/i, '').trim();
    if (!merchant) merchant = 'Manual';

    // Ngày (tuỳ chọn trong text) → mặc định hôm nay
    let date = today;
    const dm = text.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
    if (dm) {
      const ds = dm[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
        date = ds;
      } else {
        const parts = ds.split(/[\/\-]/).map(x => parseInt(x, 10));
        const y = parts[2] < 100 ? (2000 + parts[2]) : parts[2];
        const dt = new Date(y, parts[1] - 1, parts[0]);
        if (!isNaN(dt.getTime())) date = Utilities.formatDate(dt, tz, 'yyyy-MM-dd');
      }
    }

    const amount = sign * Math.abs(val);
    return {
      amount,
      merchant,
      date,
      category: 'Uncategorized',
      type: classify(amount),
      note: '',
      source: 'tg_text',
      from: 'telegram'
    };
  }
}
ParserRegistry.register(new TelegramTextParser());
