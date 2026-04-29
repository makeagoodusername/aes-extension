"use strict";

/**
 * Unified Settings — adapter helper primitives.
 *
 * Tiny shared toolkit so each adapter file stays focused on its own
 * module's settings shape. No business logic — just DOM/style helpers.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AesUnifiedSettingsAdapterHelpers) return;

    const COLORS = {
        bone:   "#F4F1EA",
        bone2:  "#E7E0CC",
        oxide:  "#2B2520",
        oxide2: "#5A4F45",
        slate:  "#7A6F66",
        rule:   "#C9C0B0",
        rust:   "#B8862E"
    };

    function header(label, sub) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "padding-bottom:10px;border-bottom:1px solid " + COLORS.rule + ";margin-bottom:14px";
        const t = document.createElement("div");
        t.textContent = String(label || "").toUpperCase();
        t.style.cssText = "font-weight:800;font-size:13px;letter-spacing:0.08em;color:" + COLORS.oxide;
        wrap.appendChild(t);
        if (sub) {
            const s = document.createElement("div");
            s.textContent = sub;
            s.style.cssText = "font-size:11px;color:" + COLORS.slate + ";margin-top:4px;line-height:1.4";
            wrap.appendChild(s);
        }
        return wrap;
    }

    function card() {
        const c = document.createElement("div");
        c.style.cssText = [
            "padding:14px 16px",
            "border:2px solid " + COLORS.oxide,
            "background:" + COLORS.bone,
            "box-shadow:4px 4px 0 " + COLORS.oxide,
            "margin-bottom:12px"
        ].join(";");
        return c;
    }

    function row(label, value) {
        const r = document.createElement("div");
        r.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;font-size:12px";
        const l = document.createElement("span");
        l.textContent = label;
        l.style.cssText = "color:" + COLORS.oxide + ";font-weight:600";
        const v = document.createElement("span");
        v.textContent = value == null ? "—" : String(value);
        v.style.cssText = "color:" + COLORS.oxide2 + ";font-family:'JetBrains Mono',monospace;font-size:11px";
        r.append(l, v);
        return r;
    }

    function actionBtn(label, onClick, opts) {
        const o = opts || {};
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.style.cssText = [
            "border:1px solid " + COLORS.oxide,
            "background:" + (o.primary ? COLORS.oxide : COLORS.bone),
            "color:" + (o.primary ? COLORS.bone : COLORS.oxide),
            "padding:6px 12px",
            "font-family:inherit",
            "font-size:11px",
            "font-weight:700",
            "letter-spacing:0.06em",
            "cursor:pointer"
        ].join(";");
        if (o.disabled) {
            btn.disabled = true;
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
        } else if (typeof onClick === "function") {
            btn.addEventListener("click", onClick);
        }
        return btn;
    }

    function notice(msg) {
        const n = document.createElement("div");
        n.style.cssText = "padding:14px;background:" + COLORS.bone2 + ";border:1px dashed " + COLORS.rule + ";font-size:11px;color:" + COLORS.oxide2 + ";line-height:1.5";
        n.textContent = msg;
        return n;
    }

    function actions() {
        const r = document.createElement("div");
        r.style.cssText = "display:flex;gap:8px;margin-top:10px";
        return r;
    }

    function pageContext() {
        return (typeof location !== "undefined" && location && location.pathname) || "";
    }

    function closeModalThen(fn) {
        try {
            if (window.AesUnifiedSettings && typeof window.AesUnifiedSettings.close === "function") {
                window.AesUnifiedSettings.close();
            }
        } catch (_) {}
        try { fn(); } catch (e) { console && console.warn && console.warn("[unified-settings adapter]", e); }
    }

    window.AesUnifiedSettingsAdapterHelpers = {
        COLORS: COLORS,
        header: header,
        card: card,
        row: row,
        actionBtn: actionBtn,
        notice: notice,
        actions: actions,
        pageContext: pageContext,
        closeModalThen: closeModalThen
    };
})();
