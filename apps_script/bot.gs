// filename: apps_script/bot.gs
// [UPDATED] ExpenseBot.onText(): ưu tiên gọi parser/fn có sẵn và ghi trực tiếp bằng appendExpense()
// [ADDED] handleTelegramUpdate(update): entry được Code.gs gọi
// [REMOVED] doPost(e) ở file này để tránh trùng tên với Code.gs (đã route Telegram)

const BOT_TOKEN = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || "";
const PUBLIC_WEB = PropertiesService.getScriptProperties().getProperty("PUBLIC_WEB") || "https://example.com/expense";
const APPS_SCRIPT_URL = PropertiesService.getScriptProperties().getProperty("APPS_SCRIPT_URL") || "https://script.google.com/macros/s/XXXX/exec";
const APPS_SCRIPT_API_KEY = PropertiesService.getScriptProperties().getProperty("APPS_SCRIPT_API_KEY") || "";
const MINIAPP_SHORT_NAME = PropertiesService.getScriptProperties().getProperty("MINIAPP_SHORT_NAME") || "expense";

/** ===== Telegram thin client ===== */
class TelegramBot {
    constructor(token) {
        this.token = token;
        this.base = `https://api.telegram.org/bot${token}`;
    }
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
    getMe() {
        return this.api("getMe", {});
    }
    sendMessage(params) {
        return this.api("sendMessage", params);
    }
    setMyCommands(commands, scope, language_code) {
        const body = { commands };
        if (scope) body.scope = scope;
        if (language_code) body.language_code = language_code;
        return this.api("setMyCommands", body);
    }
    setChatMenuButton(menu_button) {
        return this.api("setChatMenuButton", { menu_button });
    }
    setWebhook(url) {
        return this.api("setWebhook", { url });
    }
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
            [
                { command: "start", description: "Bắt đầu" },
                { command: "app", description: "Mở sổ chi tiêu" },
            ],
            { type: "default" },
            "vi"
        );
        this.tg.setMyCommands(
            [
                { command: "start", description: "Start" },
                { command: "app", description: "Open expense book" },
            ],
            { type: "default" },
            "en"
        );

        this.tg.setChatMenuButton({ type: "web_app", text: "Sổ chi tiêu", web_app: { url: this.publicWeb } });
    }

    handleUpdate(update) {
        const msg = update.message || update.edited_message;
        if (!msg) return;
        const text = (msg.text || "").trim();

        if (text.startsWith("/start")) return this.start(msg);
        if (text.startsWith("/app")) return this.openApp(msg);
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

    openApp(msg) {
        return this.start(msg);
    }

    // [UPDATED] Ưu tiên gọi fn parser & appendExpense trong cùng project
    onText(msg) {
        const text = msg.text || "";
        const priv = msg.chat.type === "private";

        // 1) Gọi parser đã có nếu tồn tại
        let parsed = null;
        try {
            if (typeof ExpenseParser !== "undefined" && ExpenseParser && typeof ExpenseParser.parse === "function") {
                parsed = ExpenseParser.parse(text);
            } else if (typeof parseExpenseText === "function") {
                parsed = parseExpenseText(text);
            }
        } catch (_e) {
            parsed = null;
        }

        // 2) Fallback đơn giản nếu chưa có parser
        if (!parsed) parsed = ExpenseBot._fallbackParse(text);
        if (!parsed) {
            return this.tg.sendMessage({
                chat_id: msg.chat.id,
                text: "Không nhận diện được số tiền. Bạn có thể nhập tay trong ứng dụng.",
                reply_markup: JSON.stringify(this.webappBtn(priv)),
            });
        }

        // 3) Ghi trực tiếp bằng appendExpense nếu có; nếu không -> fallback HTTP
        let ok = false,
            err = "";
        try {
            const rec = {
                user_id: String(msg.from.id),
                amount: parsed.amount,
                merchant: parsed.merchant,
                date: parsed.date,
                category: parsed.category || "Uncategorized",
                note: parsed.note || "",
                source: "tg_text",
                raw: text,
            };
            if (typeof appendExpense === "function") {
                const id = appendExpense(rec); // Code.gs sẽ tự nén raw & thêm time/deleted
                ok = !!id;
            } else {
                const result = this.appsScript.appendTransaction(msg.from.id, { ...parsed, raw: text });
                ok = !!(result && result.ok);
                if (!ok) err = (result && result.error) || "unknown";
            }
        } catch (e) {
            err = String(e);
            ok = false;
        }

        if (ok) {
            const sign = parsed.amount < 0 ? "-" : "+";
            const amt = Math.abs(parsed.amount).toLocaleString("vi-VN") + " VND";
            return this.tg.sendMessage({
                chat_id: msg.chat.id,
                text: `✔️ Đã lưu: ${sign}${amt} • ${parsed.merchant} • ${parsed.date}`,
                reply_markup: JSON.stringify(this.webappBtn(priv)),
            });
        }
        return this.tg.sendMessage({
            chat_id: msg.chat.id,
            text: `Không lưu được: ${err || "unknown"}`,
        });
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

/** One-time setup helpers (giữ nguyên) */
function setWebhook() {
    const url = APPS_SCRIPT_URL;
    console.log(url);
    const tg = new TelegramBot(BOT_TOKEN);
    tg.setWebhook(url);
}
function bootstrap() {
    const bot = new ExpenseBot(BOT_TOKEN, PUBLIC_WEB);
    bot.setupMenuAndCmds();
}
