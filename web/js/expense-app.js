import { APPS_SCRIPT_URL, DEFAULT_PAGE_SIZE, PAGE_SIZES, TIMEZONE } from "./config.js";
import { tg } from "./telegram.js";
import { Api } from "./api.js";
import { CategoryCache, ListCache, StatsCache } from "./cache.js";
import { HeaderState, LoadBar, StickyCalcs, Toast } from "./ui.js";

export class ExpenseApp {
    constructor() {
        const initDataRaw = tg?.initData || "";
        this.initDataRaw = initDataRaw;
        this.initDataB64 = initDataRaw ? btoa(initDataRaw) : "";
        this.api = new Api(APPS_SCRIPT_URL, this.initDataB64);

        this.user = null;
        this.items = [];
        this.lastRev = null;

        this.page = 1;
        this.limit = this._normalizePageSize(Number(localStorage.getItem("ct:limit") || DEFAULT_PAGE_SIZE));
        this.total = 0;

        this.categories = [];
        this.stats = { day: 0, month: 0, year: 0 };

        this.$user = document.getElementById("user");
        this.$list = document.getElementById("list");
        this.$reload = document.getElementById("reload");
        this.$addOpen = document.getElementById("add-open");

        this.$statsDay = document.getElementById("stats-day");
        this.$statsMonth = document.getElementById("stats-month");
        this.$statsYear = document.getElementById("stats-year");

        this.$pageSize = document.getElementById("page-size");
        this.$prev = document.getElementById("page-prev");
        this.$next = document.getElementById("page-next");
        this.$range = document.getElementById("page-range");

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
        this._listReqId = 0;
        this._statsReqId = 0;
    }

    _normalizePageSize(value) {
        return PAGE_SIZES.includes(value) ? value : DEFAULT_PAGE_SIZE;
    }

    _calcMaxPage(total = this.total, limit = this.limit) {
        const safeLimit = Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE);
        return Math.max(1, Math.ceil((Number(total) || 0) / safeLimit));
    }

    async init() {
        StickyCalcs.init();
        HeaderState.init();
        this.applyThemeFromTelegram();
        this.bindEvents();
        if (tg?.ready) tg.ready();
        tg?.expand?.();
        this.setUserFromInitData();
        this.setUserBadge(this.user ? `@${this.user.username || this.user.id}` : "Đang tải...");

        this._printInitDebug();
        window.printInitDebug = () => this._printInitDebug();
        window.copyInitDebug = async () => {};

        if (this.$pageSize) this.$pageSize.value = String(this.limit);

        const pCats = this.loadCategories();
        const pList = this.loadList();
        const pStats = this.loadStats(false, pList);

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

    _openItemFromTarget(target) {
        const root = target.closest(".item");
        if (!root) return;
        const id = root.dataset.id;
        if (!id) return;
        const it = this.items.find((x) => x.id === id);
        if (!it) return;
        this.openEditor(it);
    }

    _upsertItemLocal(item, isNew) {
        if (isNew && this.page !== 1) {
            this.total = Math.max(0, Number(this.total || 0) + 1);
            this.renderPager();
            this._persistPageCache();
            return;
        }

        const idx = this.items.findIndex((x) => x.id === item.id);
        if (idx >= 0) {
            this.items[idx] = { ...this.items[idx], ...item };
            this.items = this.sortByDateTimeDesc(this.items);
        } else if (this.page === 1) {
            const merged = this.items.concat([item]);
            this.items = this.sortByDateTimeDesc(merged).slice(0, this.limit);
            this.total = Math.max(0, Number(this.total || 0) + 1);
        } else {
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

        this.total = Math.max(0, Number(this.total || 0) - 1);

        const maxPage = this._calcMaxPage();
        if (this.page > maxPage) {
            this.page = maxPage;
            this.loadList(true);
            return;
        }

        if (removedInSlice) {
            this.renderList();
        }
        this.renderPager();
        this._persistPageCache();
    }

    todayISOInTZ(tz = TIMEZONE) {
        const d = new Date();
        const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
        return fmt.format(d);
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

    toISODate(val) {
        if (!val && val !== 0) return "";
        if (val instanceof Date) return this._fmtDate(val);
        if (typeof val === "number") return this._fmtDate(new Date(val));
        if (typeof val === "string") {
            if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
            const d = new Date(val);
            return isNaN(d.getTime()) ? "" : this._fmtDate(d);
        }
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
        const d = this.toISODate(it?.date) || "0000-00-00";
        const t = it?.time && /^\d{2}:\d{2}(:\d{2})?$/.test(it.time) ? (it.time.length === 5 ? it.time + ":00" : it.time) : "00:00:00";
        return `${d}T${t}`;
    }

    sortByDateTimeDesc(items) {
        return (items || []).slice().sort((a, b) => {
            const ka = this.dateTimeKey(a);
            const kb = this.dateTimeKey(b);
            if (kb !== ka) return kb > ka ? 1 : -1;
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

    bindEvents() {
        this.$reload.addEventListener("click", () => {
            this.loadList(true);
            this.loadStats(true);
        });
        this.$addOpen?.addEventListener("click", () => this.openEditor(null));

        this.$pageSize?.addEventListener("change", (e) => {
            this.limit = this._normalizePageSize(Number(e.target.value) || DEFAULT_PAGE_SIZE);
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
            const maxPage = this._calcMaxPage();
            if (this.page < maxPage) {
                this.page++;
                this.loadList(true);
            }
        });

        this.$sheetClose.addEventListener("click", () => this.closeSheet());
        this.$eSave.addEventListener("click", () => this.saveEditor());
        this.$eDelete.addEventListener("click", () => this.deleteItem());

        this.$list.addEventListener("click", (e) => this._openItemFromTarget(e.target));
        this.$list.addEventListener("keydown", (e) => {
            const isActivate = e.key === "Enter" || e.key === " " || e.key === "Spacebar";
            if (!isActivate) return;
            e.preventDefault();
            this._openItemFromTarget(e.target);
        });

        const haptic = () => tg?.HapticFeedback?.impactOccurred?.("light");
        ["click", "touchend"].forEach((ev) => {
            document.querySelectorAll(".btn").forEach((b) => b.addEventListener(ev, haptic, { passive: true }));
        });
    }

    async loadStats(force = false, itemsReady = null) {
        const reqId = ++this._statsReqId;
        const uid = String(this.user?.id || "anon");
        const todayISO = this.todayISOInTZ();

        if (!force) {
            const cached = StatsCache.get(uid, todayISO);
            console.debug("[STATS] cache", { key: StatsCache.key(uid, todayISO), hit: !!cached });
            if (cached) {
                this.renderStats(cached);
            }
        }

        try {
            const r = await this.api.call("stats");
            if (reqId !== this._statsReqId) return;
            if (r?.ok) {
                const stats = { day: r.day || 0, month: r.month || 0, year: r.year || 0 };
                this.renderStats(stats);
                StatsCache.set(uid, todayISO, stats);
                if (typeof r.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.today) && r.today !== todayISO) {
                    StatsCache.set(uid, r.today, stats);
                }
                return;
            }
        } catch (e) {
            console.debug("[STATS] api error", e);
        }

        if (reqId !== this._statsReqId) return;

        if ((!this.items || this.items.length === 0) && itemsReady?.then) {
            try {
                await itemsReady;
            } catch {}
        }

        if (reqId !== this._statsReqId) return;
        const est = this.computeStats(this.items);
        this.renderStats(est);
    }

    renderPager() {
        const total = Number(this.total) || 0;
        const limit = Number(this.limit) || DEFAULT_PAGE_SIZE;
        const maxPage = this._calcMaxPage(total, limit);
        if (this.page > maxPage) this.page = maxPage;
        const page = Math.max(1, Number(this.page) || 1);
        const from = total ? (page - 1) * limit + 1 : 0;
        const to = Math.min(total, page * limit);
        if (this.$range) this.$range.textContent = `${from}-${to} / ${this.fmtMoney(total)}`;
        if (this.$prev) this.$prev.disabled = page <= 1;
        if (this.$next) this.$next.disabled = page >= maxPage;
    }

    _fillSelectOptions(select, items) {
        if (!select) return;
        select.innerHTML = "";
        items.forEach((value) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = value;
            select.appendChild(opt);
        });
    }

    renderCatOptions() {
        const q = document.getElementById("q-category");
        this._fillSelectOptions(q, this.categories);
        this._fillSelectOptions(this.$eCategory, this.categories);
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
        const items = Array.isArray(r.items) ? r.items : null;
        this.categories = r.ok && items ? items : cached || ["Uncategorized"];
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

    renderEmptyMessage(message) {
        this.$list.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = message;
        this.$list.appendChild(empty);
    }

    async loadList(force = false) {
        const reqId = ++this._listReqId;
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
            if (reqId !== this._listReqId) return;
            if (!r.ok) {
                if (!cached) this.renderEmptyMessage(`Không tải được danh sách: ${r.error || ""}`);
                return;
            }
            const fresh = this.sortByDateTimeDesc(Array.isArray(r.items) ? r.items : []);
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
            this.renderEmptyMessage("Chưa có giao dịch.");
            return;
        }
        const rows = this.items.map((it) => {
            const amt = Number(it.amount) || 0;
            const isIncome = amt >= 0;
            const cls = isIncome ? "income" : "expense";
            const sign = isIncome ? "" : "-";
            const d = this.toISODate(it.date) || "";
            const t = it.time ? ` ${it.time.slice(0, 5)}` : "";
            const noteHtml = it.note ? `<span>•</span><span class="note">${this.escape(it.note)}</span>` : "";
            return `
      <div class="item" data-id="${it.id}" role="button" tabindex="0">
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
        this.$eDate.value = this.toISODate(it?.date) || this.toISODate(new Date());
        this.$eCategory.value = it?.category || this.categories[0] || "Uncategorized";
        if (this.$eType) this.$eType.value = isIncome ? "income" : "expense";
        this.$eNote.value = it?.note || "";
        this.$eDelete.style.display = isEdit ? "inline-flex" : "none";
        this.$sheet.classList.add("open");
        this.$sheet.setAttribute("aria-hidden", "false");
        try {
            tg?.MainButton?.offClick?.();
            tg?.MainButton?.hide?.();
        } catch {}
    }

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

        if (r.item && r.item.id) {
            this._upsertItemLocal(r.item, !isUpdate);
            this._applyStatsChange(prevItem, r.item);
        } else if (!isUpdate && r.id) {
            const newItem = { id: r.id, ...fields };
            this._upsertItemLocal(newItem, true);
            this._applyStatsChange(null, newItem);
        }

        this.closeSheet();
        this.toast("Đã lưu.");
    }

    async deleteItem() {
        if (!this.editingId) return;

        const prevItem = this.items.find((x) => x.id === this.editingId) || null;
        const r = await this.api.call("delete", { id: this.editingId });
        if (!r.ok) {
            this.toast("Không xoá được: " + (r.error || ""));
            return;
        }
        tg?.HapticFeedback?.notificationOccurred?.("success");

        this._removeItemLocal(this.editingId);

        if (prevItem) this._applyStatsChange(prevItem, null);

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

    toast(msg) {
        Toast.show(msg);
    }

    computeStats(items) {
        const list = Array.isArray(items) ? items : [];
        const todayISO = this.toISODate(new Date());
        const ym = todayISO.slice(0, 7);
        const y = todayISO.slice(0, 4);
        let day = 0,
            month = 0,
            year = 0;
        for (const it of list) {
            const amt = Number(it.amount) || 0;
            const spend = amt < 0 ? -amt : 0;
            if (!spend) continue;
            const dISO = this.toISODate(it.date);
            if (!dISO) continue;
            if (dISO === todayISO) day += spend;
            if (dISO.startsWith(ym)) month += spend;
            if (dISO.startsWith(y)) year += spend;
        }
        return { day, month, year };
    }

    _contribForItem(item) {
        const amt = Number(item?.amount) || 0;
        const spend = amt < 0 ? -amt : 0;
        if (!spend) return { day: 0, month: 0, year: 0 };

        const dISO = this.toISODate(item?.date) || "";
        if (!dISO) return { day: 0, month: 0, year: 0 };

        const today = this.todayISOInTZ();
        const ym = today.slice(0, 7);
        const y = today.slice(0, 4);

        return {
            day: dISO === today ? spend : 0,
            month: dISO.startsWith(ym) ? spend : 0,
            year: dISO.startsWith(y) ? spend : 0,
        };
    }

    _applyStatsDelta(sign, item) {
        const c = this._contribForItem(item);
        const next = {
            day: Math.max(0, (this.stats?.day || 0) + sign * c.day),
            month: Math.max(0, (this.stats?.month || 0) + sign * c.month),
            year: Math.max(0, (this.stats?.year || 0) + sign * c.year),
        };
        this.renderStats(next);
    }

    _applyStatsChange(prevItem, nextItem) {
        if (prevItem) this._applyStatsDelta(-1, prevItem);
        if (nextItem) this._applyStatsDelta(+1, nextItem);
    }

    renderStats(stats) {
        if (!stats) stats = { day: 0, month: 0, year: 0 };
        this.stats = { day: Number(stats.day) || 0, month: Number(stats.month) || 0, year: Number(stats.year) || 0 };
        if (this.$statsDay) this.$statsDay.textContent = `${this.fmtMoney(this.stats.day)} ₫`;
        if (this.$statsMonth) this.$statsMonth.textContent = `${this.fmtMoney(this.stats.month)} ₫`;
        if (this.$statsYear) this.$statsYear.textContent = `${this.fmtMoney(this.stats.year)} ₫`;
        const uid = String(this.user?.id || "anon");
        const todayISO = this.todayISOInTZ();
        StatsCache.set(uid, todayISO, this.stats);
    }
}
