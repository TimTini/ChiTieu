// filename: web/app.js
// Mobile-first Telegram WebApp UI + caching + loading bar + sorted list + editor fixes
const APPS_SCRIPT_ID = "AKfycbw1dWR83pG_HSScL-e4RORz4Yb-i5oI6qt-vlQxpO82yxn1_P1ETkn38cRWOM7xNWAwYQ";
const APPS_SCRIPT_URL = `https://script.google.com/macros/s/${APPS_SCRIPT_ID}/exec`;
const tg = window.Telegram?.WebApp;

// [ADDED] Toast nhỏ gọn (không dùng alert)
class Toast {
    static show(message, timeout = 1800) {
        const el = document.getElementById("toast");
        if (!el) return;
        el.textContent = message || "";
        el.classList.add("show");
        clearTimeout(this._t);
        this._t = setTimeout(() => el.classList.remove("show"), timeout);
    }
}

class Api {
    constructor(base, initDataB64) {
        this.base = base;
        this.initDataB64 = initDataB64 || "";
    }
    async call(action, body = {}) {
        const started = performance.now();
        const req = { action, initDataB64: this.initDataB64, ...body };
        try {
            NetIndicator.show();
            console.groupCollapsed(`[API] → ${action}`);
            console.log("Request", req);
            const res = await fetch(this.base, {
                method: "POST",
                headers: { "Content-Type": "text/plain;charset=UTF-8" },
                body: JSON.stringify(req),
            });
            const text = await res.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                data = { ok: false, error: `Non-JSON (${res.status})`, _raw: text.slice(0, 200) };
            }
            const ms = Math.round(performance.now() - started);
            console.log("Status", res.status, `${ms}ms`);
            console.log("Response", data);
            console.groupEnd();
            return data;
        } catch (e) {
            const ms = Math.round(performance.now() - started);
            console.groupCollapsed(`[API] × ${action} (${ms}ms)`);
            console.error(e);
            console.groupEnd();
            const msg = e?.message || String(e);
            Toast.show({ title: "Lỗi mạng", message: msg, buttons: [{ type: "ok" }] });
            return { ok: false, error: msg };
        } finally {
            NetIndicator.hide();
        }
    }
}

/* Spinner for network */
class NetIndicator {
    static _n = 0;
    static _el() {
        return document.getElementById("net");
    }
    static show() {
        this._n++;
        const el = this._el();
        if (el) el.style.display = "inline-block";
        document.body.dataset.loading = "1";
    }
    static hide() {
        if (this._n > 0) this._n--;
        if (this._n === 0) {
            const el = this._el();
            if (el) el.style.display = "none";
            document.body.removeAttribute("data-loading");
        }
    }
}

/* Loading bar for list refresh */
class LoadBar {
    static _active = 0;
    static el() {
        return document.getElementById("bar");
    }
    static start() {
        this._active++;
        const el = this.el();
        if (!el) return;
        if (this._active === 1) {
            el.style.transition = "none";
            el.style.opacity = "1";
            el.style.width = "0%";
            void el.offsetWidth; // reflow
            el.style.transition = "width .4s ease, opacity .2s";
            el.style.width = "80%";
        }
    }
    static done() {
        if (this._active > 0) this._active--;
        const el = this.el();
        if (!el) return;
        if (this._active === 0) {
            el.style.width = "100%";
            setTimeout(() => {
                el.style.opacity = "0";
            }, 250);
            setTimeout(() => {
                el.style.transition = "none";
                el.style.width = "0%";
            }, 500);
        }
    }
}

/* Cache for categories (localStorage) */
class CategoryCache {
    static key = "ct:categories:v1";
    static ttlMs = 12 * 60 * 60 * 1000;
    static get() {
        try {
            const s = localStorage.getItem(this.key);
            if (!s) return null;
            const o = JSON.parse(s);
            if (!o || !Array.isArray(o.items)) return null;
            if (Date.now() - (o.t || 0) > this.ttlMs) return null;
            return o.items;
        } catch {
            return null;
        }
    }
    static set(items) {
        try {
            localStorage.setItem(this.key, JSON.stringify({ t: Date.now(), items }));
        } catch {}
    }
    static clear() {
        try {
            localStorage.removeItem(this.key);
        } catch {}
    }
}

/* Cache for list items (per-user) */
class ListCache {
    // static ttlMs = 5 * 60 * 1000; // 5 phút
    static ttlMs = 365 * 24 * 60 * 60 * 1000; // 1 năm
    static key(uid, page, limit) {
        return `ct:list:${uid || "anon"}:v2:${limit}:${page}`;
    }
    static get(uid, page, limit) {
        try {
            const s = localStorage.getItem(this.key(uid, page, limit));
            if (!s) return null;
            const o = JSON.parse(s);
            if (!o || !Array.isArray(o.items)) return null;
            if (Date.now() - (o.t || 0) > this.ttlMs) return null;
            return o;
        } catch {
            return null;
        }
    }
    static set(uid, page, limit, items, rev, total) {
        try {
            localStorage.setItem(this.key(uid, page, limit), JSON.stringify({ t: Date.now(), items, rev, total }));
        } catch {}
    }
    static clear(uid) {
        try {
            Object.keys(localStorage).forEach((k) => {
                if (k.startsWith(`ct:list:${uid || "anon"}:v2:`)) localStorage.removeItem(k);
            });
        } catch {}
    }
}

/* Cache for global stats (per-user, per-day) */
class StatsCache {
    static prefix(uid) {
        return `ct:stats:${uid || "anon"}:`;
    }
    static key(uid, todayISO) {
        return `${this.prefix(uid)}${todayISO}`;
    }
    // TTL tối đa 10 phút, nhưng không vượt quá 0h đêm tiếp theo
    static _ttlMsUntilMidnight() {
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const msToMidnight = midnight - now;
        // const MAX = 10 * 60 * 1000; // 10 phút
        const MAX = 365 * 24 * 60 * 60 * 1000; // 1 năm
        return Math.max(1_000, Math.min(MAX, msToMidnight));
    }
    static get(uid, todayISO) {
        try {
            const raw = localStorage.getItem(this.key(uid, todayISO));
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !o.stats) return null;
            if (Date.now() > (o.exp || 0)) return null;
            return o.stats; // { day, month, year }
        } catch {
            return null;
        }
    }
    static set(uid, todayISO, stats) {
        try {
            const ttl = this._ttlMsUntilMidnight();
            const exp = Date.now() + ttl;
            localStorage.setItem(this.key(uid, todayISO), JSON.stringify({ exp, stats }));
        } catch {}
    }
    static clear(uid) {
        try {
            const pref = this.prefix(uid);
            Object.keys(localStorage).forEach((k) => {
                if (k.startsWith(pref)) localStorage.removeItem(k);
            });
        } catch {}
    }
    static clearAll() {
        try {
            Object.keys(localStorage).forEach((k) => {
                if (k.startsWith("ct:stats:")) localStorage.removeItem(k);
            });
        } catch {}
    }
}
// [ADDED] Đồng bộ chiều cao header vào CSS var --header-h (tránh pager "lơ lửng" khi header co/ẩn)
class StickyCalcs {
    static _set = () => {
        const h = document.querySelector("header");
        // lấy chiều cao thực tế (kể cả safe-area / co giãn)
        const px = Math.round(h?.getBoundingClientRect().height || 0);
        if (px > 0) document.documentElement.style.setProperty("--header-h", px + "px");
    };
    static init() {
        StickyCalcs._set();
        const head = document.querySelector("header");
        if (head && "ResizeObserver" in window) {
            this._ro = new ResizeObserver(StickyCalcs._set);
            this._ro.observe(head);
        }
        window.addEventListener("resize", StickyCalcs._set, { passive: true });
        window.addEventListener("orientationchange", StickyCalcs._set);
        // Telegram WebApp viewport thay đổi khi thanh app thu/phóng
        try {
            tg?.onEvent?.("viewportChanged", StickyCalcs._set);
        } catch {}
        // dự phòng: tick sau layout
        setTimeout(StickyCalcs._set, 0);
    }
}
// [ADDED] Toggle .header-hidden trên <html> khi header rời viewport
class HeaderState {
    static init() {
        const head = document.querySelector("header");
        if (!head || !("IntersectionObserver" in window)) return;
        const io = new IntersectionObserver(
            ([e]) => {
                const visible = !!e && e.intersectionRatio > 0;
                document.documentElement.classList.toggle("header-hidden", !visible);
            },
            { threshold: 0.01 }
        );
        io.observe(head);
    }
}
class ExpenseApp {
    constructor() {
        const initDataRaw = tg?.initData || "";
        this.initDataRaw = initDataRaw;
        this.initDataB64 = initDataRaw ? btoa(initDataRaw) : "";
        this.api = new Api(APPS_SCRIPT_URL, this.initDataB64);

        this.user = null;
        this.items = [];
        this.lastRev = null;

        // Phân trang
        this.page = 1;
        this.limit = Number(localStorage.getItem("ct:limit") || 20);
        this.total = 0;

        this.categories = [];
        this.$user = document.getElementById("user");
        this.$list = document.getElementById("list");
        this.$reload = document.getElementById("reload");
        this.$addOpen = document.getElementById("add-open");

        // Stats
        this.$statsDay = document.getElementById("stats-day");
        this.$statsMonth = document.getElementById("stats-month");
        this.$statsYear = document.getElementById("stats-year");

        // Pager nodes
        this.$pageSize = document.getElementById("page-size");
        this.$prev = document.getElementById("page-prev");
        this.$next = document.getElementById("page-next");
        this.$range = document.getElementById("page-range");

        // Editor
        this.$sheet = document.getElementById("sheet");
        this.$sheetTitle = document.getElementById("sheet-title");
        this.$sheetClose = document.getElementById("sheet-close");
        this.$eMerchant = document.getElementById("e-merchant");
        this.$eAmount = document.getElementById("e-amount");
        this.$eDate = document.getElementById("e-date");
        this.$eCategory = document.getElementById("e-category");
        this.$eType = document.getElementById("e-type");
        this.$eNote = document.getElementById("e-note");
        this.$eSave = document.getElementById("e-save");
        this.$eDelete = document.getElementById("e-delete");
        this.editingId = null;
        this._busy = false;
    }
    async init() {
        // StickyCalcs.init(); // [ADDED]
        HeaderState.init(); // [ADDED]
        this.applyThemeFromTelegram();
        this.bindEvents();
        if (tg?.ready) tg.ready();
        tg?.expand?.();
        this.setUserFromInitData();
        this.setUserBadge(this.user ? `@${this.user.username || this.user.id}` : "Đang tải…");

        this._printInitDebug();
        window.printInitDebug = () => this._printInitDebug();
        window.copyInitDebug = async () => {
            /* (giữ nguyên thân cũ) */
        };

        if (this.$pageSize) this.$pageSize.value = String(this.limit);

        // Chạy song song: categories, list, stats
        const pCats = this.loadCategories();
        const pList = this.loadList();
        const pStats = this.loadStats(false, pList); // chỉ chờ list nếu cần fallback

        await Promise.all([pCats, pList, pStats]);
    }
    _getUid() {
        return String(this.user?.id || "anon");
    }
    _persistPageCache() {
        const uid = this._getUid();
        const rev = this.computeRev(this.items);
        ListCache.set(uid, this.page, this.limit, this.items, rev, this.total);
        this.lastRev = rev;
    }

    _upsertItemLocal(item, isNew) {
        // Nếu đang không ở trang 1 và là item mới, chỉ tăng total rồi update pager
        if (isNew && this.page !== 1) {
            this.total = Math.max(0, Number(this.total || 0) + 1);
            this.renderPager();
            this._persistPageCache();
            return;
        }

        // Có thể item đã nằm trong slice hiện tại
        const idx = this.items.findIndex((x) => x.id === item.id);

        if (idx >= 0) {
            // Sửa: thay dữ liệu và resort slice
            this.items[idx] = { ...this.items[idx], ...item };
            this.items = this.sortByDateTimeDesc(this.items);
        } else if (this.page === 1) {
            // Thêm mới ở trang 1: chèn theo sort & cắt độ dài theo limit
            const merged = this.items.concat([item]);
            this.items = this.sortByDateTimeDesc(merged).slice(0, this.limit);
            // Tổng tăng 1 (ngay cả khi bị cắt bớt cuối danh sách hiển thị)
            this.total = Math.max(0, Number(this.total || 0) + 1);
        } else {
            // Không nằm trong trang hiện tại
            if (isNew) this.total = Math.max(0, Number(this.total || 0) + 1);
        }

        this.renderList();
        this.renderPager();
        this._persistPageCache();
    }

    _removeItemLocal(id) {
        const before = this.items.length;
        this.items = this.items.filter((x) => x.id !== id);
        const removedInSlice = this.items.length < before;

        // Giảm tổng bản ghi toàn cục
        this.total = Math.max(0, Number(this.total || 0) - 1);

        // (tuỳ chọn) Nếu muốn luôn đủ số lượng ở trang hiện tại thì phải “kéo” 1 item kế tiếp từ trang sau.
        // Ở đây ta giữ đơn giản: chỉ render lại slice hiện tại (có thể ngắn hơn limit một chút).
        if (removedInSlice) {
            this.renderList();
        }
        this.renderPager();
        this._persistPageCache();
    }

    todayISOInTZ(tz = "Asia/Ho_Chi_Minh") {
        const d = new Date();
        const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
        return fmt.format(d); // yyyy-mm-dd
    }
    _printInitDebug() {
        const dbg = this._buildInitDebug();
        console.groupCollapsed("[INITDATA] Tổng quan");
        console.log({
            platform: tg?.platform,
            version: tg?.version,
            init_len: dbg.input.init_len,
            init_head: dbg.input.init_head,
            init_tail: dbg.input.init_tail,
            init_b64_len: dbg.input_b64.init_b64_len,
            b64_head: dbg.input_b64.b64_head,
            b64_tail: dbg.input_b64.b64_tail,
            has_user: dbg.hash.has_user,
            hash_got: dbg.hash.hash_got,
        });
        console.groupEnd();
        console.group("[INITDATA] Cặp key=value (RAW & DEC)");
        dbg.pairs.forEach((p, i) => console.log(`pair[${i + 1}]`, p));
        console.groupEnd();
        console.group("[INITDATA] DCS (sorted by decoded key; bỏ hash/signature)");
        console.log("keys_sorted", dbg.keys_sorted);
        dbg.dcs_lines.forEach((line, i) => console.log(`line ${i + 1}:`, line));
        console.groupEnd();
    }
    _buildInitDebug() {
        const init = this.initDataRaw || "";
        const pairs = this._parseRawPairs(init);
        const dcsObj = this._buildDCSFromPairs(pairs);
        const search = new URLSearchParams(init);
        let hashGot = "",
            hasUser = false;
        try {
            hashGot = (search.get("hash") || "").toLowerCase();
            hasUser = !!search.get("user");
        } catch {}
        return {
            input: { init_len: init.length, init_head: this._safeHeadTail(init).head, init_tail: this._safeHeadTail(init).tail },
            input_b64: (() => {
                const b64 = this.initDataB64 || "";
                const ht = this._safeHeadTail(b64);
                return { init_b64_len: b64.length, b64_head: ht.head, b64_tail: ht.tail };
            })(),
            pairs: pairs.map((p) => ({ kRaw: p.kRaw, vRaw: p.vRaw, kDec: p.kDec, vDec: p.vDec })),
            keys_sorted: dcsObj.keys_sorted,
            dcs_lines: dcsObj.lines,
            hash: { hash_got: hashGot, has_user: hasUser },
        };
    }
    _parseRawPairs(qs) {
        const out = [];
        (qs || "").split("&").forEach((pair) => {
            const i = pair.indexOf("=");
            if (i < 0) return;
            const kRaw = pair.slice(0, i),
                vRaw = pair.slice(i + 1);
            let kDec = "",
                vDec = "";
            try {
                kDec = decodeURIComponent(kRaw);
            } catch {
                kDec = kRaw;
            }
            try {
                vDec = decodeURIComponent(vRaw);
            } catch {
                vDec = vRaw;
            }
            out.push({ kRaw, vRaw, kDec, vDec });
        });
        return out;
    }
    _buildDCSFromPairs(pairs) {
        const filtered = pairs.filter((p) => p.kDec !== "hash" && p.kDec !== "signature");
        filtered.sort((a, b) => a.kDec.localeCompare(b.kDec));
        const lines = filtered.map((p) => `${p.kRaw}=${p.vRaw}`);
        const keys_sorted = filtered.map((p) => p.kDec);
        return { lines, keys_sorted };
    }
    _safeHeadTail(s, n = 120) {
        if (!s) return { head: "", tail: "" };
        return { head: s.slice(0, n), tail: s.slice(-n) };
    }
    /* ==== Date helpers: normalize to input[type=date] YYYY-MM-DD ==== */
    toISODate(val) {
        if (!val && val !== 0) return "";
        if (val instanceof Date) return this._fmtDate(val);
        if (typeof val === "number") return this._fmtDate(new Date(val));
        if (typeof val === "string") {
            if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
            const d = new Date(val);
            return isNaN(d.getTime()) ? "" : this._fmtDate(d);
        }
        // Apps Script may send Date as object in JSON -> handled above; otherwise unknown
        try {
            const d = new Date(val);
            return isNaN(d.getTime()) ? "" : this._fmtDate(d);
        } catch {
            return "";
        }
    }
    _fmtDate(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }
    dateKey(val) {
        const iso = this.toISODate(val);
        if (!iso) return 0;
        const t = Date.parse(`${iso}T00:00:00`);
        return isNaN(t) ? 0 : t;
    }
    dateTimeKey(it) {
        // 'YYYY-MM-DDTHH:mm:ss' để so sánh chuỗi giảm dần cho ổn định
        const d = this.toISODate(it?.date) || "0000-00-00";
        const t = it?.time && /^\d{2}:\d{2}(:\d{2})?$/.test(it.time) ? (it.time.length === 5 ? it.time + ":00" : it.time) : "00:00:00";
        return `${d}T${t}`;
    }
    sortByDateTimeDesc(items) {
        return (items || []).slice().sort((a, b) => {
            const ka = this.dateTimeKey(a);
            const kb = this.dateTimeKey(b);
            if (kb !== ka) return kb > ka ? 1 : -1; // mới → cũ
            return String(b?.id || "").localeCompare(String(a?.id || ""));
        });
    }

    applyThemeFromTelegram() {
        const tp = tg?.themeParams || {};
        const map = { "--bg": tp.bg_color, "--text": tp.text_color, "--muted": tp.hint_color, "--card": tp.secondary_bg_color, "--border": tp.section_separator_color, "--accent": tp.button_color };
        for (const k in map) if (map[k]) document.documentElement.style.setProperty(k, map[k]);
        try {
            tg?.setHeaderColor?.("secondary_bg_color");
            tg?.setBackgroundColor?.(tp.secondary_bg_color || "#171923");
        } catch {}
    }

    // [UPDATED] bindEvents: gắn nút Thêm, bỏ lắng nghe quick form
    bindEvents() {
        this.$reload.addEventListener("click", () => {
            this.loadList(true);
            this.loadStats(true);
        });
        this.$addOpen?.addEventListener("click", () => this.openEditor(null));

        // Pager
        this.$pageSize?.addEventListener("change", (e) => {
            this.limit = Number(e.target.value) || 20;
            if (![10, 20, 50].includes(this.limit)) this.limit = 20;
            localStorage.setItem("ct:limit", this.limit);
            this.page = 1;
            ListCache.clear(this.user?.id || "anon");
            this.loadList(true);
            this.loadStats(true);
        });
        this.$prev?.addEventListener("click", () => {
            if (this.page > 1) {
                this.page--;
                this.loadList(true);
            }
        });
        this.$next?.addEventListener("click", () => {
            const maxPage = Math.max(1, Math.ceil((Number(this.total) || 0) / (Number(this.limit) || 20)));
            if (this.page < maxPage) {
                this.page++;
                this.loadList(true);
            }
        });

        this.$sheetClose.addEventListener("click", () => this.closeSheet());
        this.$eSave.addEventListener("click", () => this.saveEditor());
        this.$eDelete.addEventListener("click", () => this.deleteItem());
        this.$list.addEventListener("click", (e) => {
            const root = e.target.closest(".item");
            if (!root) return;
            const id = root.dataset.id;
            if (!id) return;
            const it = this.items.find((x) => x.id === id);
            if (!it) return;
            this.openEditor(it);
        });
        const haptic = () => tg?.HapticFeedback?.impactOccurred?.("light");
        ["click", "touchend"].forEach((ev) => {
            document.querySelectorAll(".btn").forEach((b) => b.addEventListener(ev, haptic, { passive: true }));
        });
    }
    // [ADDED] loadStats(): thống kê toàn cục từ server (không phụ thuộc trang)
    // [UPDATED] loadStats(): thống kê toàn cục từ server (không phụ thuộc trang) + cache
    // [UPDATED] loadStats(): luôn dùng todayISO (Asia/Ho_Chi_Minh) làm key khi set/get
    // loadStats(force = false, itemsReady = Promise|undefined)
    async loadStats(force = false, itemsReady = null) {
        const uid = String(this.user?.id || "anon");
        const todayISO = this.todayISOInTZ("Asia/Ho_Chi_Minh");

        if (!force) {
            const cached = StatsCache.get(uid, todayISO);
            console.debug("[STATS] cache", { key: StatsCache.key(uid, todayISO), hit: !!cached });
            if (cached) {
                // Hiển thị trước data trong cache và tiếp tục request stats mới nhất
                this.renderStats(cached);
                // return;
            }
        }

        try {
            // request data mới nhất
            const r = await this.api.call("stats");
            if (r?.ok) {
                const stats = { day: r.day || 0, month: r.month || 0, year: r.year || 0 };
                this.renderStats(stats);
                StatsCache.set(uid, todayISO, stats);
                if (typeof r.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.today) && r.today !== todayISO) {
                    // tương thích ngược khi backend dùng ngày khác múi giờ
                    StatsCache.set(uid, r.today, stats);
                }
                return;
            }
        } catch (e) {
            console.debug("[STATS] api error", e);
        }

        // Fallback: nếu API lỗi và list chưa sẵn, đợi list xong rồi mới tính ước lượng
        if ((!this.items || this.items.length === 0) && itemsReady?.then) {
            try {
                await itemsReady;
            } catch {}
        }
        const est = this.computeStats(this.items);
        this.renderStats(est);
    }

    // [ADDED] renderPager(): cập nhật phạm vi + disable prev/next
    renderPager() {
        const total = Number(this.total) || 0;
        const limit = Number(this.limit) || 20;
        const page = Math.max(1, Number(this.page) || 1);
        const from = total ? (page - 1) * limit + 1 : 0;
        const to = Math.min(total, page * limit);
        if (this.$range) this.$range.textContent = `${from}–${to} / ${this.fmtMoney(total)}`;
        if (this.$prev) this.$prev.disabled = page <= 1;
        const maxPage = Math.max(1, Math.ceil(total / limit));
        if (this.$next) this.$next.disabled = page >= maxPage;
    }
    renderCatOptions() {
        const opts = this.categories.map((c) => `<option value="${c}">${c}</option>`).join("");
        const q = document.getElementById("q-category"); // có thể KHÔNG tồn tại (đã bỏ Quick add)
        if (q) q.innerHTML = opts;
        const e = document.getElementById("e-category");
        if (e) e.innerHTML = opts;
    }
    setUserBadge(text) {
        if (this.$user) this.$user.textContent = text;
    }

    setUserFromInitData() {
        let u = tg?.initDataUnsafe?.user;
        if (!u) {
            try {
                const p = new URLSearchParams(tg?.initData || "");
                const js = p.get("user");
                if (js) u = JSON.parse(js);
            } catch {}
        }
        this.user = u || null;
        if (!this.user) {
            const inTg = !!tg && (tg?.platform || "").length > 0;
            this.setUserBadge(inTg ? "Không nhận được initData" : "Không chạy trong Telegram");
            console.debug("[TG]", { platform: tg?.platform, hasUnsafe: !!tg?.initDataUnsafe, hasUser: !!tg?.initDataUnsafe?.user, initDataLen: (tg?.initData || "").length });
        } else {
            this.setUserBadge(`@${this.user.username || this.user.id}`);
        }
    }

    async loadCategories(force = false) {
        const cached = CategoryCache.get();
        if (cached && !force) {
            this.categories = cached;
            this.renderCatOptions();
            return;
        }
        const r = await this.api.call("categories");
        this.categories = r.ok ? r.items : cached || ["Uncategorized"];
        if (r.ok) CategoryCache.set(this.categories);
        this.renderCatOptions();
    }

    showListSkeleton() {
        const sk = Array.from({ length: 6 })
            .map(
                () => `
      <div class="item skeleton">
        <div class="top"><div class="title"></div><div class="amount"> </div></div>
        <div class="meta"><span></span><span>•</span><span></span></div>
      </div>`
            )
            .join("");
        this.$list.innerHTML = sk;
    }

    computeRev(items) {
        try {
            const arr = (items || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
            return JSON.stringify(arr);
        } catch {
            return JSON.stringify(items || []);
        }
    }

    async loadList(force = false) {
        const uid = this.user?.id || "anon";
        const cached = !force ? ListCache.get(uid, this.page, this.limit) : null;

        if (cached) {
            this.items = this.sortByDateTimeDesc(cached.items || []);
            this.lastRev = cached.rev || this.computeRev(this.items);
            this.total = Number(cached.total) || 0;
            this.renderList();
            this.renderPager();
        } else {
            this.showListSkeleton();
        }

        LoadBar.start();
        try {
            const r = await this.api.call("list", { page: this.page, limit: this.limit });
            if (!r.ok) {
                if (!cached) this.$list.innerHTML = `<div class="empty">Không tải được danh sách: ${r.error || ""}</div>`;
                return;
            }
            const fresh = this.sortByDateTimeDesc(r.items || []);
            const rev = this.computeRev(fresh);
            const total = Number(r.total) || fresh.length;
            this.items = fresh;
            this.lastRev = rev;
            this.total = total;
            this.renderList();
            this.renderPager();
            ListCache.set(uid, this.page, this.limit, fresh, rev, total);
        } finally {
            LoadBar.done();
        }
    }
    renderList() {
        if (!this.items.length) {
            this.$list.innerHTML = `<div class="empty">Chưa có giao dịch.</div>`;
            return;
        }
        const rows = this.items.map((it) => {
            const amt = Number(it.amount) || 0;
            const isIncome = amt >= 0;
            const cls = isIncome ? "income" : "expense";
            const sign = isIncome ? "" : "−";
            const d = this.toISODate(it.date) || "";
            const t = it.time ? ` ${it.time.slice(0, 5)}` : ""; // HH:mm
            const noteHtml = it.note ? `<span>•</span><span class="note">${this.escape(it.note)}</span>` : "";
            return `
      <div class="item" data-id="${it.id}">
        <div class="top">
          <div class="title">${this.escape(it.merchant || "")}</div>
          <div class="amount ${cls}">${sign}${this.fmtMoney(Math.abs(amt))}&nbsp;₫</div>
        </div>
        <div class="meta">
          <span>${d}${t}</span><span>•</span><span>${this.escape(it.category || "")}</span>
          ${noteHtml}
        </div>
      </div>`;
        });
        this.$list.innerHTML = rows.join("");
    }

    openEditor(it) {
        this.editingId = it?.id || null;
        const isEdit = !!this.editingId;
        this.$sheetTitle.textContent = isEdit ? "Sửa giao dịch" : "Thêm giao dịch";
        const isIncome = it ? Number(it.amount) >= 0 : false;
        this.$eMerchant.value = it?.merchant || "";
        this.$eAmount.value = it ? String(Math.abs(Number(it.amount) || 0)) : "";
        // ---- FIX: đảm bảo input date là YYYY-MM-DD
        this.$eDate.value = this.toISODate(it?.date) || this.toISODate(new Date());
        this.$eCategory.value = it?.category || this.categories[0] || "Uncategorized";
        if (this.$eType) this.$eType.value = isIncome ? "income" : "expense";
        this.$eNote.value = it?.note || "";
        this.$eDelete.style.display = isEdit ? "inline-flex" : "none";
        this.$sheet.classList.add("open");
        this.$sheet.setAttribute("aria-hidden", "false");
        // ---- FIX: không dùng Telegram MainButton để tránh 2 nút Lưu
        try {
            tg?.MainButton?.offClick?.();
            tg?.MainButton?.hide?.();
        } catch {}
    }
    // [UPDATED] saveEditor(): sau khi lưu -> reload trang hiện tại + stats
    async saveEditor() {
        const type = this.$eType?.value || "expense";
        const amountRaw = this.parseIntVND(this.$eAmount.value);
        const fields = {
            merchant: this.$eMerchant.value.trim(),
            amount: type === "expense" ? -Math.abs(amountRaw) : Math.abs(amountRaw),
            date: this.$eDate.value || this.toISODate(new Date()),
            category: this.$eCategory.value || "Uncategorized",
            note: this.$eNote.value.trim(),
            type,
        };
        if (!fields.merchant || !(Math.abs(fields.amount) > 0)) {
            this.toast("Nhập diễn giải và số tiền > 0");
            return;
        }

        const isUpdate = !!this.editingId;
        const prevItem = isUpdate ? this.items.find((x) => x.id === this.editingId) : null;

        const r = isUpdate ? await this.api.call("update", { id: this.editingId, fields }) : await this.api.call("append", { ...fields, source: "webapp" });

        if (!r.ok) {
            this.toast((isUpdate ? "Không cập nhật được: " : "Không thêm được: ") + (r.error || ""));
            return;
        }

        tg?.HapticFeedback?.notificationOccurred?.("success");

        // cập nhật list cục bộ (đã làm ở lần trước)
        if (r.item && r.item.id) {
            this._upsertItemLocal(r.item, !isUpdate);
            // cập nhật Stats cục bộ theo delta
            this._applyStatsChange(prevItem, r.item);
        } else if (!isUpdate && r.id) {
            const newItem = { id: r.id, ...fields };
            this._upsertItemLocal(newItem, true);
            this._applyStatsChange(null, newItem);
        }

        // KHÔNG gọi await this.loadStats(true);
        this.closeSheet();
        this.toast("Đã lưu.");
    }

    // [UPDATED] deleteItem(): sau khi xoá -> reload trang hiện tại + stats
    async deleteItem() {
        if (!this.editingId) return;

        const prevItem = this.items.find((x) => x.id === this.editingId) || null;

        const r = await this.api.call("delete", { id: this.editingId });
        if (!r.ok) {
            this.toast("Không xoá được: " + (r.error || ""));
            return;
        }
        tg?.HapticFeedback?.notificationOccurred?.("success");

        // cập nhật list cục bộ
        this._removeItemLocal(this.editingId);

        // trừ Stats cục bộ theo item vừa xoá
        if (prevItem) this._applyStatsChange(prevItem, null);

        // KHÔNG gọi await this.loadStats(true);
        this.closeSheet();
        this.toast("Đã xoá.");
    }

    closeSheet() {
        this.$sheet.classList.remove("open");
        this.$sheet.setAttribute("aria-hidden", "true");
        try {
            tg?.MainButton?.offClick?.();
            tg?.MainButton?.hide?.();
        } catch {}
        this.editingId = null;
    }

    fmtMoney(v) {
        try {
            return Number(v).toLocaleString("vi-VN");
        } catch {
            return v;
        }
    }
    escape(s) {
        return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
    }
    parseIntVND(s) {
        return Number(String(s).replace(/[^\d]/g, "")) || 0;
    }
    // [UPDATED] toast(): chuyển sang dùng Toast riêng
    toast(msg) {
        Toast.show(msg);
    }
    // [ADDED] Tính và render thống kê (chi tiêu âm, lấy trị tuyệt đối)
    computeStats(items) {
        const list = Array.isArray(items) ? items : [];
        const todayISO = this.toISODate(new Date());
        const ym = todayISO.slice(0, 7); // YYYY-MM
        const y = todayISO.slice(0, 4); // YYYY
        let day = 0,
            month = 0,
            year = 0;
        for (const it of list) {
            const amt = Number(it.amount) || 0;
            const spend = amt < 0 ? -amt : 0; // chỉ tính chi
            if (!spend) continue;
            const dISO = this.toISODate(it.date);
            if (!dISO) continue;
            if (dISO === todayISO) day += spend;
            if (dISO.startsWith(ym)) month += spend;
            if (dISO.startsWith(y)) year += spend;
        }
        return { day, month, year };
    }
    _isExpenseAmount(a) {
        return Number(a) < 0;
    }
    _contribForItem(item) {
        // chỉ tính CHI (amount < 0), trị tuyệt đối
        const amt = Number(item?.amount) || 0;
        const spend = amt < 0 ? -amt : 0;
        if (!spend) return { day: 0, month: 0, year: 0 };

        const dISO = this.toISODate(item?.date) || "";
        if (!dISO) return { day: 0, month: 0, year: 0 };

        const today = this.todayISOInTZ("Asia/Ho_Chi_Minh");
        const ym = today.slice(0, 7);
        const y = today.slice(0, 4);

        return {
            day: dISO === today ? spend : 0,
            month: dISO.startsWith(ym) ? spend : 0,
            year: dISO.startsWith(y) ? spend : 0,
        };
    }
    _applyStatsDelta(sign, item) {
        // sign = +1 để cộng, -1 để trừ (khi xoá hoặc rollback bản cũ trong update)
        const c = this._contribForItem(item);
        const next = {
            day: Math.max(0, (this.stats?.day || 0) + sign * c.day),
            month: Math.max(0, (this.stats?.month || 0) + sign * c.month),
            year: Math.max(0, (this.stats?.year || 0) + sign * c.year),
        };
        this.renderStats(next); // tự ghi cache luôn trong renderStats
    }
    // Dùng cho thêm/sửa/xoá:
    _applyStatsChange(prevItem, nextItem) {
        if (prevItem) this._applyStatsDelta(-1, prevItem); // trừ đóng góp bản cũ
        if (nextItem) this._applyStatsDelta(+1, nextItem); // cộng đóng góp bản mới
    }

    renderStats(stats) {
        if (!stats) stats = { day: 0, month: 0, year: 0 };
        this.stats = { day: Number(stats.day) || 0, month: Number(stats.month) || 0, year: Number(stats.year) || 0 };
        if (this.$statsDay) this.$statsDay.textContent = `${this.fmtMoney(this.stats.day)} ₫`;
        if (this.$statsMonth) this.$statsMonth.textContent = `${this.fmtMoney(this.stats.month)} ₫`;
        if (this.$statsYear) this.$statsYear.textContent = `${this.fmtMoney(this.stats.year)} ₫`;
        // ghi cache để lần sau vào app có baseline
        const uid = String(this.user?.id || "anon");
        const todayISO = this.todayISOInTZ("Asia/Ho_Chi_Minh");
        StatsCache.set(uid, todayISO, this.stats);
    }
}

const app = new ExpenseApp();
app.init();
