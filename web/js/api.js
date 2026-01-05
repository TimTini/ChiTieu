import { NetIndicator, Toast } from "./ui.js";

export class Api {
    constructor(base, initDataB64) {
        this.base = base;
        this.initDataB64 = initDataB64 || "";
    }
    async call(action, body = {}) {
        const started = performance.now();
        const req = { action, initDataB64: this.initDataB64, ...body };
        try {
            NetIndicator.show();
            console.groupCollapsed(`[API] -> ${action}`);
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
            console.groupCollapsed(`[API] <- ${action} (${ms}ms)`);
            console.error(e);
            console.groupEnd();
            const msg = e?.message || String(e);
            Toast.show({ title: "Lỗi mạng", message: msg });
            return { ok: false, error: msg };
        } finally {
            NetIndicator.hide();
        }
    }
}
