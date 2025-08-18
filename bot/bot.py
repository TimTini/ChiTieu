# filename: bot/bot.py
# Python 3.11+, python-telegram-bot==21.*
from typing import Optional, Dict, Any, Tuple, List
from typing import Optional, Dict, Any, Tuple
import asyncio
import logging
import os
from dotenv import load_dotenv
import re
from datetime import datetime
from typing import Optional, Dict, Any

from aiohttp import ClientSession
from telegram import (
    Update,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    WebAppInfo,
    MenuButtonWebApp,
    BotCommand, BotCommandScopeDefault
)
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)
from telegram.error import TelegramError
from telegram.ext import ApplicationHandlerStop
load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("expense-bot")

BOT_TOKEN = os.getenv("BOT_TOKEN", "PUT_YOUR_BOT_TOKEN_HERE")
MINIAPP_SHORT_NAME = os.getenv("MINIAPP_SHORT_NAME", "expense")
APPS_SCRIPT_ID = os.getenv("APPS_SCRIPT_ID", "EXEC_ID")
APPS_SCRIPT_URL = os.getenv(
    "APPS_SCRIPT_URL", "https://script.google.com/macros/s/{APPS_SCRIPT_ID}/exec").format(APPS_SCRIPT_ID=APPS_SCRIPT_ID)
APPS_SCRIPT_API_KEY = os.getenv("APPS_SCRIPT_API_KEY", "SET_A_SECRET_API_KEY")
PUBLIC_WEB = os.getenv("PUBLIC_WEB", "https://<username>.github.io/expense-web/")  # ← dùng .env

# filename: bot/bot.py (thay thế ExpenseParser)


class ExpenseParser:
    """
    Trả về dict:
      {
        "amount": int,               # âm = chi, dương = thu
        "merchant": str,
        "date": "YYYY-MM-DD",
        "category": "Uncategorized",
        "type": "expense"|"income",
        "note": str
      }
    """

    # ===== Generic regex =====
    _AMT_CURRENCY = re.compile(
        r"""(?P<sign>[\+\-\u2212\u2013\u2014])?\s*
        (?P<num>(?:\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:[.,]\d{1,2})?)
        \s*(?P<cur>vnd|vnđ|đ|₫|dong|đồng)?\b""",
        re.I | re.U | re.X,
    )
    _AMT_SHORTHAND = re.compile(
        r"""(?P<num>\d+(?:[.,]\d+)?)
            \s*(?P<unit>k|nghìn|ngàn|ngan|tr|triệu|m|b|tỷ|ty)\b""",
        re.I | re.U | re.X,
    )
    _DATE_YMD = re.compile(r"\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b")              # yyyy-mm-dd
    _DATE_DMY = re.compile(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b")        # dd/mm[/yy]
    _TIME = re.compile(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b")

    _MERCHANT_PATTERNS = [
        r"(?:NỘI\s*DUNG|NOI\s*DUNG|ND|ND\s*GD|NỘI\s*DUNG\s*GD)[:\-]\s*(?P<m>[^.;\n]+)",
        r"(?:MÔ\s*TẢ|MO\s*TA|DIỄN\s*GIẢI|DIEN\s*GIAI|DG)[:\-]\s*(?P<m>[^.;\n]+)",
        r"(?:TẠI|TAI|Ở|O)\s+(?P<m>[^.;\n]+)",
        r"(?:MERCHANT|POS|NAPAS|QR)[:\s]+(?P<m>[^.;\n]+)",
        r"(?:FROM|TỪ|TU)[:\s]+(?P<m>[^.;\n]+)",
    ]
    _MERCHANTS = [re.compile(p, re.I | re.U) for p in _MERCHANT_PATTERNS]

    _KW_EXPENSE = re.compile(r"(chi|thanh\s*toán|mua|trừ|ghi\s*nợ|debit|pos|qr|napas|auto[- ]?debit)", re.I | re.U)
    _KW_INCOME = re.compile(
        r"(thu|nhận|ghi\s*có|credit(?!\s*card)|cộng|nạp|refund|hoàn)",
        re.I | re.U
    )
    # ===== Label map cho email/SMS có 2 ngôn ngữ (VPBank, v.v.) =====
    LABELS = {
        "amount": [r"số\s*tiền\s*thay\s*đổi", r"changed\s*amount"],
        "merchant": [r"nội\s*dung", r"transaction\s*content"],
        "time": [r"thời\s*gian", r"\btime\b"],
        # có thể thêm: available limit, card...
    }
    LABEL_RX = {k: re.compile("|".join(v), re.I | re.U) for k, v in LABELS.items()}

    @staticmethod
    def _to_int_amount(num_str: str) -> int:
        s = num_str.replace(" ", "")
        if "." in s and "," in s:
            s = s.replace(".", "").split(",")[0]   # "1.234.567,89" -> "1234567"
        else:
            s = re.sub(r"[.,]", "", s)
        digits = re.sub(r"[^\d]", "", s)
        return int(digits) if digits else 0

    @staticmethod
    def _unit_multiplier(unit: str) -> int:
        u = unit.lower()
        if u in ("k", "nghìn", "ngan", "ngàn"):
            return 1_000
        if u in ("tr", "triệu", "m"):
            return 1_000_000
        if u in ("b", "tỷ", "ty"):
            return 1_000_000_000
        return 1

    @classmethod
    def _find_amount_generic(cls, text: str) -> Optional[Tuple[int, Tuple[int, int], str, Optional[int]]]:
        m = cls._AMT_SHORTHAND.search(text)
        if m:
            val = float(m.group("num").replace(",", "."))
            mul = cls._unit_multiplier(m.group("unit"))
            sign_local = cls._peek_sign(text, m.start())
            return int(round(val * mul)), m.span(), m.group(0), sign_local

        hint = re.search(r"(số\s*t[ií]ền|amount|sotien)", text, re.I | re.U)
        near = hint.span() if hint else None
        best = None
        best_sign = None
        for mm in cls._AMT_CURRENCY.finditer(text):
            amt = cls._to_int_amount(mm.group("num"))
            if amt <= 0:
                continue
            dist = min(abs(mm.start() - near[0]), abs(mm.end() - near[1])) if near else 9999
            score = (0 if near else 1, dist, mm.start())
            if best is None or score < best[0]:
                best = (score, amt, mm.span(), mm.group(0))
                sgn = mm.group("sign")
                best_sign = -1 if sgn and sgn in "-−–—" else (+1 if sgn == "+" else None)
        if best:
            _, amt, sp, raw = best
            return amt, sp, raw, best_sign
        return None

    @classmethod
    def _lines(cls, text: str) -> List[str]:
        # Chỉ gom space, KHÔNG strip ký tự '-' để khỏi mất dấu âm
        lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()]
        return [ln for ln in lines if ln]

    @classmethod
    def _pick_neighbor(cls, lines: List[str], i: int) -> Optional[str]:
        # Lấy dòng trước/sau nhãn, KHÔNG strip '-'
        for j in (i - 1, i + 1):
            if 0 <= j < len(lines):
                val = lines[j].strip(" •:.;")  # bỏ bullet/space nhưng giữ '-'
                if val:
                    return val
        return None

    @classmethod
    def _parse_labeled_blocks(cls, text: str) -> Dict[str, str]:
        out: Dict[str, str] = {}
        lines = cls._lines(text)
        for i, ln in enumerate(lines):
            for key, rx in cls.LABEL_RX.items():
                if rx.search(ln):
                    val = cls._pick_neighbor(lines, i)
                    if val:
                        out[key] = val
        return out

    @classmethod
    def _detect_sign(cls, text: str) -> int:
        if cls._KW_INCOME.search(text):
            return +1
        if cls._KW_EXPENSE.search(text):
            return -1
        # nếu có từ "thẻ tín dụng/credit card" → mặc định là chi
        if re.search(r"(thẻ\s*tín\s*dụng|credit\s*card)", text, re.I | re.U):
            return -1
        return -1  # mặc định chi

    @classmethod
    def _find_date_iso(cls, text: str) -> Optional[str]:
        # Y-M-D
        m = cls._DATE_YMD.search(text)
        if m:
            y, mm, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
            return f"{y:04d}-{mm:02d}-{dd:02d}"
        # D-M-[Y]
        m = cls._DATE_DMY.search(text)
        if m:
            dd, mm = int(m.group(1)), int(m.group(2))
            y = m.group(3)
            if y:
                y = int(y)
                if y < 100:
                    y += 2000 if y < 70 else 1900
            else:
                y = datetime.now().year
            return f"{y:04d}-{mm:02d}-{dd:02d}"
        return None

    @classmethod
    def _extract_ymd_from_time_block(cls, s: str) -> Optional[str]:
        # ví dụ: "17/08/2025 09:12:22"
        d = cls._find_date_iso(s)
        if d:
            return d
        # đôi khi time đứng cạnh ngày, đã bắt được ở _find_date_iso
        return None

    @staticmethod
    def _peek_sign(s: str, idx: int) -> Optional[int]:
        # nhìn 1-2 ký tự bên trái vị trí bắt đầu số
        left = s[max(0, idx-2):idx]
        if re.search(r"[\-\u2212\u2013\u2014]\s*$", left):  # -, −, –, —
            return -1
        if re.search(r"\+\s*$", left):
            return +1
        return None

    @classmethod
    def parse(cls, text: str) -> Optional[Dict[str, Any]]:

        sign_local: Optional[int] = None
        if not text or not text.strip():
            return None
        raw = text.strip()

        # --- 1) Ưu tiên format dạng "label: value" của VPBank & đồng dạng ---
        labeled = cls._parse_labeled_blocks(raw)
        amount_abs = None
        merchant = None
        date_iso = None

        # amount theo nhãn
        amt_src = labeled.get("amount")
        if amt_src:
            m_sh = cls._AMT_SHORTHAND.search(amt_src)
            if m_sh:
                val = float(m_sh.group("num").replace(",", "."))
                mul = cls._unit_multiplier(m_sh.group("unit"))
                amount_abs = int(round(val * mul))
                sign_local = cls._peek_sign(amt_src, m_sh.start())
            else:
                m_cur = cls._AMT_CURRENCY.search(amt_src)
                if m_cur:
                    amount_abs = cls._to_int_amount(m_cur.group("num"))
                    sgn = m_cur.group("sign")
                    if sgn:
                        sign_local = -1 if sgn in "-−–—" else (+1 if sgn == "+" else None)

        # merchant theo nhãn
        if labeled.get("merchant"):
            merchant = labeled["merchant"]

        # date theo nhãn time/hoặc tự bắt trong chuỗi time
        if labeled.get("time"):
            date_iso = cls._extract_ymd_from_time_block(labeled["time"])

        # --- 2) Nếu chưa có đủ, fallback generic ---
        if amount_abs is None:
            am = cls._find_amount_generic(raw)
            if not am:
                return None
            amount_abs, span, _, sign_from_generic = am
            if sign_local is None:
                sign_local = sign_from_generic
        if merchant is None:
            # thử regex merchant chung
            merchant = cls._find_merchant_generic(raw)
            if merchant is None and 'span' in locals():
                # fallback: lấy phần còn lại (freeform)
                merchant = cls._fallback_desc_after_remove_amount(raw, span) or "N/A"
        if not date_iso:
            date_iso = cls._find_date_iso(raw) or datetime.now().strftime("%Y-%m-%d")

        # chuẩn hóa merchant
        merchant = re.sub(r"\b(\d+(?:[.,]\d+)?\s*(k|nghìn|ngàn|ngan|tr|triệu|m|b|tỷ|ty|vnd|vnđ|đ|₫))\b",
                          "", merchant, flags=re.I).strip(" .;:-")

        sign = sign_local if sign_local is not None else cls._detect_sign(raw)
        typ = "income" if sign > 0 else "expense"
        return {
            "amount": amount_abs * sign,
            "merchant": merchant or "N/A",
            "date": date_iso,
            "category": "Uncategorized",
            "type": typ,
            "note": "",
        }

    # ==== helpers cho generic merchant & fallback ====

    @classmethod
    def _find_merchant_generic(cls, text: str) -> Optional[str]:
        for rx in cls._MERCHANTS:
            m = rx.search(text)
            if m:
                name = (m.group("m") or "").strip(" .;:-")
                if name:
                    return name
        return None

    @classmethod
    def _fallback_desc_after_remove_amount(cls, text: str, amt_span: Tuple[int, int]) -> str:
        s = text[:amt_span[0]] + text[amt_span[1]:]
        s = re.sub(r"[\-\–\—\:|\(\)\[\]<>~]+", " ", s)
        s = re.sub(r"\s+", " ", s).strip(" .;:-\n\t")
        return s

# [UPDATED] AppsScriptClient.append_transaction: gửi api_key trong JSON body (đừng dùng header)


class AppsScriptClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._session: Optional[ClientSession] = None

    async def _session_get(self) -> ClientSession:
        if not self._session:
            self._session = ClientSession(timeout=None)
        return self._session

    async def close(self):
        if self._session:
            await self._session.close()

    async def append_transaction(self, user_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        sess = await self._session_get()
        body = {
            "action": "append",
            "api_key": self.api_key,            # [UPDATED] đưa API key vào body
            "user_id": str(user_id),
            "amount": payload["amount"],
            "merchant": payload["merchant"],
            "date": payload["date"],
            "category": payload.get("category", "Uncategorized"),
            "note": payload.get("note", ""),
            "source": "bank_sms",
        }
        async with sess.post(self.base_url, json=body, headers={"Content-Type": "application/json"}) as resp:
            return await resp.json()


def is_private_chat(update) -> bool:
    return (getattr(update, "effective_chat", None) and
            getattr(update.effective_chat, "type", "") == "private")


class ExpenseBot:
    def __init__(self, token: str, web_url: str):
        self.public_web = web_url

        self.app = Application.builder().token(token).build()
        self.apps_script = AppsScriptClient(APPS_SCRIPT_URL, APPS_SCRIPT_API_KEY)

        # sẽ được điền ở runtime (run()) nhờ get_me()
        self.bot_username: str | None = None

        self.app.add_handler(CommandHandler("start", self.start))
        self.app.add_handler(CommandHandler("app", self.open_app))
        self.app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.on_text))

        # Bắt lỗi chung để không “No error handlers are registered…”
        self.app.add_error_handler(self.on_error)

    def webapp_btn(self) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(
            [[InlineKeyboardButton("Mở sổ chi tiêu", web_app=WebAppInfo(url=self.public_web))]]
        )

    async def _setup_commands(self):
        cmds_vi = [
            BotCommand("start", "Bắt đầu"),
            BotCommand("app", "Mở sổ chi tiêu"),
        ]
        # scope mặc định cho tất cả chat
        await self.app.bot.set_my_commands(cmds_vi, scope=BotCommandScopeDefault(), language_code="vi")

        # (tuỳ chọn) thêm bản tiếng Anh
        cmds_en = [
            BotCommand("start", "Start"),
            BotCommand("app", "Open expense book"),
        ]
        await self.app.bot.set_my_commands(cmds_en, scope=BotCommandScopeDefault(), language_code="en")

    async def _setup_menu_button(self):
        await self.app.bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(text="Sổ chi tiêu", web_app=WebAppInfo(url=self.public_web))
        )
    # ====== UI helpers

    def _deeplink(self, start_param: str = "from_group") -> str:
        # Direct Mini App link: https://t.me/<bot>/<short_name>?startapp=<param>
        # (yêu cầu bạn đã tạo Mini App và đặt short_name)
        username = self.bot_username or "YourBot"
        return f"https://t.me/{username}/{MINIAPP_SHORT_NAME}?startapp={start_param}"

    def kb_private_webapp(self) -> InlineKeyboardMarkup:
        # Dùng trong DM: mở WebApp trực tiếp
        return InlineKeyboardMarkup(
            [[InlineKeyboardButton("Mở sổ chi tiêu", web_app=WebAppInfo(url=self.public_web))]]
        )

    def kb_group_deeplink(self) -> InlineKeyboardMarkup:
        # Dùng trong group: chuyển qua bot riêng + auto mở app
        return InlineKeyboardMarkup(
            [[InlineKeyboardButton("Mở sổ chi tiêu", url=self._deeplink("open"))]]
        )

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_type = update.effective_chat.type
        if chat_type in ("group", "supergroup"):
            await update.message.reply_text(
                "Mở ứng dụng trong chat riêng:", reply_markup=self.kb_group_deeplink()
            )
        else:
            await update.message.reply_text(
                "Mở ứng dụng:", reply_markup=self.kb_private_webapp()
            )

    async def open_app(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        # /app: tương tự /start
        await self.start(update, context)

    async def on_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        text = update.message.text or ""
        parsed = ExpenseParser.parse(text)
        priv = is_private_chat(update)
        if not parsed:
            await update.effective_message.reply_text(
                "Không nhận diện được số tiền. Bạn có thể nhập tay trong ứng dụng.",
                reply_markup=self.webapp_btn(priv),
            )
            return

        user_id = update.effective_user.id
        try:
            result = await self.apps_script.append_transaction(user_id, parsed)
            if result.get("ok"):
                sign = "-" if parsed["amount"] < 0 else "+"
                amt = f"{abs(parsed['amount']):,} VND".replace(",", ".")
                await update.effective_message.reply_text(
                    f"✔️ Đã lưu: {sign}{amt} • {parsed['merchant']} • {parsed['date']}",
                    reply_markup=self.webapp_btn(priv),
                )
            else:
                await update.message.reply_text(f"Không lưu được: {result.get('error','unknown')}")
        except Exception as e:
            log.exception("append failed")
            await update.message.reply_text(f"Lỗi kết nối Apps Script: {e!s}")

    async def on_error(self, update: object, context: ContextTypes.DEFAULT_TYPE):
        log.exception("Unhandled error", exc_info=context.error)

    async def _setup_menu_and_cmds(self):
        # Lấy username bot để dùng vào deep link
        me = await self.app.bot.get_me()
        self.bot_username = me.username

        # Đặt lệnh
        await self.app.bot.set_my_commands([
            BotCommand("start", "Bắt đầu"),
            BotCommand("app", "Mở sổ chi tiêu"),
        ])

        # Gắn Mini App vào menu nút “☰” (DM)
        await self.app.bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(text="Sổ chi tiêu", web_app=WebAppInfo(url=self.public_web))
        )

    def webapp_btn(self, private_chat: bool) -> InlineKeyboardMarkup:
        if private_chat:
            # Private chat: dùng Web App button
            return InlineKeyboardMarkup(
                [[InlineKeyboardButton("Mở sổ chi tiêu", web_app=WebAppInfo(url=self.public_web))]]
            )
        # Group/supergroup: fallback sang URL button
        return InlineKeyboardMarkup(
            [[InlineKeyboardButton("Mở sổ chi tiêu", url=self.public_web)]]
        )

    async def run(self):
        try:
            await self.app.initialize()
            await self.app.start()
            await self._setup_menu_and_cmds()
            await self.app.updater.start_polling(allowed_updates=Update.ALL_TYPES)
            await asyncio.Event().wait()
        finally:
            await self.apps_script.close()
            await self.app.stop()
            await self.app.shutdown()


if __name__ == "__main__":
    asyncio.run(ExpenseBot(BOT_TOKEN, PUBLIC_WEB).run())
