export class CategoryCache {
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

export class ListCache {
    static ttlMs = 365 * 24 * 60 * 60 * 1000;
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

export class StatsCache {
    static prefix(uid) {
        return `ct:stats:${uid || "anon"}:`;
    }
    static key(uid, todayISO) {
        return `${this.prefix(uid)}${todayISO}`;
    }
    static _ttlMsUntilMidnight() {
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const msToMidnight = midnight - now;
        const maxMs = 365 * 24 * 60 * 60 * 1000;
        return Math.max(1_000, Math.min(maxMs, msToMidnight));
    }
    static get(uid, todayISO) {
        try {
            const raw = localStorage.getItem(this.key(uid, todayISO));
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !o.stats) return null;
            if (Date.now() > (o.exp || 0)) return null;
            return o.stats;
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
