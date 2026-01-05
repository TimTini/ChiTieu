import { tg } from "./telegram.js";

export class Toast {
    static show(message, timeout = 1800) {
        const el = document.getElementById("toast");
        if (!el) return;
        let text = "";
        if (message && typeof message === "object") {
            text = [message.title, message.message].filter(Boolean).join("\n");
        } else {
            text = message || "";
        }
        el.textContent = String(text);
        el.classList.add("show");
        clearTimeout(this._t);
        this._t = setTimeout(() => el.classList.remove("show"), timeout);
    }
}

export class NetIndicator {
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

export class LoadBar {
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
            void el.offsetWidth;
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

export class StickyCalcs {
    static _set = () => {
        const h = document.querySelector("header");
        const px = Math.round(h?.getBoundingClientRect().height || 0);
        if (px > 0) document.documentElement.style.setProperty("--header-h", `${px}px`);
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
        try {
            tg?.onEvent?.("viewportChanged", StickyCalcs._set);
        } catch {}
        setTimeout(StickyCalcs._set, 0);
    }
}

export class HeaderState {
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
