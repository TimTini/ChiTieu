// filename: apps_script/bot.gs
// [UPDATED] ExpenseBot.onText(): ưu tiên gọi parser/fn có sẵn và ghi trực tiếp bằng appendExpense()
// [ADDED] handleTelegramUpdate(update): entry được Code.gs gọi
// [REMOVED] doPost(e) ở file này để tránh trùng tên với Code.gs (đã route Telegram)

const BOT_TOKEN = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || "";
const PUBLIC_WEB = PropertiesService.getScriptProperties().getProperty("PUBLIC_WEB") || "https://example.com/expense";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzAEGzlUSU3lCidrxlJcCCh5phJ0LYBjaqRsPSJ9hGXO1B8dP4Zr-JA9z5wbZRLTSarOg/exec"
const APPS_SCRIPT_API_KEY = PropertiesService.getScriptProperties().getProperty("APPS_SCRIPT_API_KEY") || "";
const MINIAPP_SHORT_NAME = PropertiesService.getScriptProperties().getProperty("MINIAPP_SHORT_NAME") || "expense";

// [ADDED] parseExpenseText(): hỗ trợ “Thêm 3k”, “3k trà sữa”, “mua 1.5tr grab”, “97,000 vnd”...
function parseExpenseText(raw) {
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const text = String(raw || '').trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  // Gợi ý dấu: income (+) vs expense (-). Mặc định là chi (âm).
  const isIncomeHint = /(thu|cộng|nap|nạp|credit|income|\+)\b/.test(lower);
  const isExpenseHint = /(chi|mua|thanh toán|thêm|trả|pay|spent?)/.test(lower);

  // Bắt số + đơn vị (k|nghìn|ngàn|tr|triệu|m|tỷ|ty|bn…)
  const m = lower.match(/([+-]?\d[\d.,]*)(?:\s*(k|ngh?ìn|ngàn|tr|triệu|m|tỷ|ty|bn|b|bil|billion)?)\s*(?:vnd|đ|d)?/i);
  if (!m) return null;

  // Chuẩn hoá số
  let numStr = m[1].replace(/\s/g, '');
  let val = parseFloat(numStr.replace(/,/g, '.'));
  if (!isFinite(val)) return null;

  switch ((m[2] || '').toLowerCase()) {
    case 'k': case 'nghìn': case 'nghin': case 'ngàn': val *= 1e3; break;
    case 'tr': case 'triệu': case 'm': val *= 1e6; break;
    case 'tỷ': case 'ty': case 'bn': case 'b': case 'bil': case 'billion': val *= 1e9; break;
  }
  val = Math.round(val);

  // Dấu tiền
  let amount;
  if (/^-/.test(m[1])) amount = -Math.abs(val);
  else if (/^\+/.test(m[1])) amount = Math.abs(val);
  else if (isIncomeHint && !isExpenseHint) amount = Math.abs(val);
  else amount = -Math.abs(val); // mặc định: chi

  // Merchant = phần còn lại sau khi bỏ cụm số
  const before = text.slice(0, m.index).trim();
  const after = text.slice(m.index + m[0].length).trim();
  let merchant = (before + ' ' + after).replace(/\s+/g, ' ').trim();
  merchant = merchant.replace(/^(thêm|chi|mua|pay|thanh toán)\b/i, '').trim();
  if (!merchant) merchant = 'Manual';

  // Ngày: bắt dd/mm/yyyy | dd-mm-yy | yyyy-mm-dd nếu có, mặc định hôm nay
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

  return { amount, merchant, date, category: 'Uncategorized', note: '' };
}
/** ===== Telegram thin client ===== */
// [UPDATED] Cho phép truyền options khi setWebhook
class TelegramBot {
  constructor(token) { this.token = token; this.base = `https://api.telegram.org/bot${token}`; }
  api(method, payload) {
    const res = UrlFetchApp.fetch(`${this.base}/${method}`, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const obj = JSON.parse(res.getContentText() || "{}");
    if (!obj.ok) throw new Error(`Telegram ${method} failed: ${res.getResponseCode()} ${res.getContentText()}`);
    return obj.result;
  }
  getMe() { return this.api("getMe", {}); }
  sendMessage(params) { return this.api("sendMessage", params); }
  setMyCommands(commands, scope, language_code) {
    const body = { commands };
    if (scope) body.scope = scope;
    if (language_code) body.language_code = language_code;
    return this.api("setMyCommands", body);
  }
  setChatMenuButton(menu_button) { return this.api("setChatMenuButton", { menu_button }); }
  // [UPDATED]
  setWebhook(url, options) { return this.api("setWebhook", Object.assign({ url }, options || {})); }
}

/** ===== Downstream Apps Script client (fallback HTTP) ===== */
class AppsScriptClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
  }
  appendTransaction(userId, payload) {
    const body = {
      action: "append",
      api_key: this.apiKey,
      user_id: String(userId),
      amount: payload.amount,
      merchant: payload.merchant,
      date: payload.date,
      category: payload.category || "Uncategorized",
      note: payload.note || "",
      source: "tg_text",
      raw: payload.raw || "",
    };
    const res = UrlFetchApp.fetch(this.baseUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
      followRedirects: true,
    });
    return JSON.parse(res.getContentText() || "{}");
  }
}

/** ===== Expense bot (handlers) ===== */
// [UPDATED] handleUpdate(): bỏ qua message do chính bot gửi (chặn vòng lặp)

class ExpenseBot {
  constructor(token, webUrl) {
    this.publicWeb = webUrl;
    this.tg = new TelegramBot(token);
    this.appsScript = new AppsScriptClient(APPS_SCRIPT_URL, APPS_SCRIPT_API_KEY);
    this._botUsername = PropertiesService.getScriptProperties().getProperty("BOT_USERNAME") || null;
  }

  setupMenuAndCmds() {
    const me = this.tg.getMe();
    this._botUsername = me.username;
    PropertiesService.getScriptProperties().setProperty("BOT_USERNAME", this._botUsername);

    this.tg.setMyCommands(
      [{ command: "start", description: "Bắt đầu" }, { command: "app", description: "Mở sổ chi tiêu" }],
      { type: "default" }, "vi"
    );
    this.tg.setMyCommands(
      [{ command: "start", description: "Start" }, { command: "app", description: "Open expense book" }],
      { type: "default" }, "en"
    );

    this.tg.setChatMenuButton({ type: "web_app", text: "Sổ chi tiêu", web_app: { url: this.publicWeb } });
  }
  handleUpdate(update) {
    const msg = update.message || update.edited_message || update.channel_post || null;
    if (!msg) return;
    if (msg.from && msg.from.is_bot) return;        // [ADDED] ignore self/other bots

    const text = (msg.text || "").trim();
    if (text.startsWith("/start")) return this.start(msg);
    if (text.startsWith("/app")) return this.openApp(msg);
    if (text.startsWith("/")) return;
    return this.onText(msg);
  }
  start(msg) {
    const chatType = msg.chat.type;
    if (chatType === "group" || chatType === "supergroup") {
      return this.tg.sendMessage({
        chat_id: msg.chat.id,
        text: "Mở ứng dụng trong chat riêng:",
        reply_markup: JSON.stringify(this.kbGroupDeeplink()),
      });
    }
    return this.tg.sendMessage({
      chat_id: msg.chat.id,
      text: "Mở ứng dụng:",
      reply_markup: JSON.stringify(this.kbPrivateWebapp()),
    });
  }

  openApp(msg) { return this.start(msg); }

  // [UPDATED] Ưu tiên gọi fn parser & appendExpense trong cùng project
  // [UPDATED] onText(): khôi phục fallback + guard null trước khi ghi
  // [UPDATED] onText(): ưu tiên ParserRegistry (TelegramTextParser) → ExpenseParser → parseExpenseText → fallback
  onText(msg) {
    const text = msg.text || "";
    const priv = msg.chat.type === "private";

    let parsed = null;

    // 1) Ưu tiên dùng hệ ParserRegistry (class con TelegramTextParser vừa tách)
    try {
      if (typeof ParserRegistry !== "undefined" && ParserRegistry && typeof ParserRegistry.parse === "function") {
        parsed = ParserRegistry.parse({ text, channel: "telegram" });
      }
    } catch (_e) { parsed = null; }

    // 2) Fallback: nếu dự án có ExpenseParser riêng
    if (!parsed) {
      try {
        if (typeof ExpenseParser !== "undefined" && ExpenseParser && typeof ExpenseParser.parse === "function") {
          parsed = ExpenseParser.parse(text);
        }
      } catch (_e) { parsed = null; }
    }

    // 3) Fallback cuối: hàm cũ parseExpenseText
    if (!parsed && typeof parseExpenseText === "function") {
      try { parsed = parseExpenseText(text); } catch (_e) { parsed = null; }
    }

    // 4) Nếu vẫn không parse được → gợi ý mở webapp
    if (!parsed) {
      return this.tg.sendMessage({
        chat_id: msg.chat.id,
        text: "Không nhận diện được số tiền. Bạn có thể nhập tay trong ứng dụng.",
        reply_markup: JSON.stringify(this.webappBtn(priv)),
      });
    }

    // 5) Ghi dữ liệu (giữ nguyên logic cũ)
    let ok = false, err = "";
    try {
      const rec = {
        user_id: String(msg.from.id),
        amount: parsed.amount,
        merchant: parsed.merchant,
        date: parsed.date,
        category: parsed.category || "Uncategorized",
        note: parsed.note || "",
        source: parsed.source || "tg_text",
        raw: text,
      };
      if (typeof appendExpense === "function") {
        const id = appendExpense(rec);
        ok = !!id;
      } else {
        const result = this.appsScript.appendTransaction(msg.from.id, { ...parsed, raw: text });
        ok = !!(result && result.ok);
        if (!ok) err = (result && result.error) || "unknown";
      }
    } catch (e) { err = String(e); ok = false; }

    if (ok) {
      const sign = parsed.amount < 0 ? "-" : "+";
      const amt = Math.abs(parsed.amount).toLocaleString("vi-VN") + " VND";
      return this.tg.sendMessage({
        chat_id: msg.chat.id,
        text: `✔️ Đã lưu: ${sign}${amt} • ${parsed.merchant} • ${parsed.date}`,
        reply_markup: JSON.stringify(this.webappBtn(priv)),
      });
    }
    return this.tg.sendMessage({ chat_id: msg.chat.id, text: `Không lưu được: ${err || "unknown"}` });
  }
  kbPrivateWebapp() {
    return { inline_keyboard: [[{ text: "Mở sổ chi tiêu", web_app: { url: this.publicWeb } }]] };
  }
  kbGroupDeeplink() {
    return { inline_keyboard: [[{ text: "Mở sổ chi tiêu", url: this._deeplink("open") }]] };
  }
  webappBtn(privateChat) {
    return privateChat ? this.kbPrivateWebapp() : { inline_keyboard: [[{ text: "Mở sổ chi tiêu", url: this.publicWeb }]] };
  }
  _deeplink(startParam) {
    const username = this._botUsername || "YourBot";
    return `https://t.me/${username}/${MINIAPP_SHORT_NAME}?startapp=${encodeURIComponent(startParam || "from_group")}`;
  }

  /** Fallback parser tối thiểu */
  static _fallbackParse(text) {
    const m = (text || "").match(/(-?\d[\d.,]*)\s*(vnd|đ)?\s+(.+?)(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
    if (!m) return null;
    const rawAmt = m[1].replace(/[.,]/g, "");
    const amount = Number(rawAmt);
    if (!isFinite(amount)) return null;
    return {
      amount,
      merchant: (m[3] || "Unknown").trim(),
      date: m[4] || Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "yyyy-MM-dd"),
      category: "Uncategorized",
      note: "",
    };
  }
}

/** [ADDED] Entry dùng bởi Code.gs khi nhận Telegram webhook */
function handleTelegramUpdate(update) {
  if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
  const bot = new ExpenseBot(BOT_TOKEN, PUBLIC_WEB);
  bot.handleUpdate(update);
}
// [ADDED] Tiện ích reset webhook + kiểm tra trạng thái
function getWebhookStatus() {
  const tg = new TelegramBot(BOT_TOKEN);
  return tg.api("getWebhookInfo", {}); // xem pending_update_count, last_error_message
}
function resetWebhook() {
  const tg = new TelegramBot(BOT_TOKEN);
  tg.api("deleteWebhook", { drop_pending_updates: true });
  // giảm đồng thời hóa để hạn chế nhận update cùng lúc
  tg.setWebhook(APPS_SCRIPT_URL, {
    max_connections: 1,
    // chỉ nhận những loại cần thiết để giảm nhiễu
    allowed_updates: ["message", "edited_message", "callback_query"]
  });
}
// [UPDATED] Quy trình: drop backlog → set webhook với options → verify
function setWebhook() {
  if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
  const tg = new TelegramBot(BOT_TOKEN);

  // 1) Xoá update tồn đọng để tránh xử lý lại các update cũ
  try {
    tg.api("deleteWebhook", { drop_pending_updates: true });
  } catch (e) {
    console.log("deleteWebhook error:", String(e));
  }

  // 2) Cài webhook với đồng thời hoá thấp + chỉ nhận loại cần thiết
  const setOk = tg.api("setWebhook", {
    url: APPS_SCRIPT_URL,
    max_connections: 1,
    allowed_updates: ["message", "edited_message", "callback_query"],
  });

  // 3) Kiểm tra trạng thái webhook
  const info = tg.api("getWebhookInfo", {});
  console.log(JSON.stringify({
    set_ok: setOk === true,
    url: info.url,
    pending_update_count: info.pending_update_count,
    last_error_date: info.last_error_date || null,
    last_error_message: info.last_error_message || null,
    ip_address: info.ip_address || null,
  }));
  bootstrap();
  return info; // tiện cho việc gọi tay trong Apps Script editor
}
function bootstrap() {
  const bot = new ExpenseBot(BOT_TOKEN, PUBLIC_WEB);
  bot.setupMenuAndCmds();
}
