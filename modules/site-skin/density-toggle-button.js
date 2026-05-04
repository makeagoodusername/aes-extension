"use strict";

/**
 * AES Site-skin — Density toggle nav button.
 *
 * The density-toggle keydown listener in density-toggle.js exposes
 * Shift+D as the cycle keybind, but offers no visible affordance — new
 * users have no way to discover it. This module mounts a small "DENSITY:
 * COMPACT|COMFORTABLE" button into the AS top nav whenever the skin is
 * enabled. Clicking it cycles the density just like the keybind, and the
 * label text reactively updates on chrome.storage changes.
 *
 * The button mounts opportunistically: tries common AS navbar selectors,
 * falls back to a MutationObserver that watches for the navbar appearing
 * later. Idempotent — multiple boot calls reuse the existing element.
 */
(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.AESDensityToggleButton) return;

    if (window.AESSiteSkin
        && typeof window.AESSiteSkin.isEnabled === "function"
        && !window.AESSiteSkin.isEnabled()) return;

    const BUTTON_ID = "aes-density-toggle-btn";
    const STYLE_ID  = "aes-density-toggle-btn-style";

    // AS top nav lives in one of these in practice; try in order.
    const NAV_SELECTORS = [
        "ul.nav.navbar-nav.navbar-right",
        "nav .nav.navbar-nav.navbar-right",
        ".navbar-nav.navbar-right",
        ".navbar .nav:last-child"
    ];

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
            "#" + BUTTON_ID + " {" +
                "display:inline-flex;align-items:center;gap:var(--aes-sp-1);" +
                "padding:var(--aes-sp-1) var(--aes-sp-3);margin:var(--aes-sp-1) var(--aes-sp-2);" +
                "border:var(--aes-bw-1) solid var(--aes-oxide);" +
                "background:var(--aes-bone);color:var(--aes-oxide);" +
                "font-family:var(--aes-font-mono);font-size:var(--aes-fs-micro);" +
                "letter-spacing:var(--aes-tracking-mono);text-transform:uppercase;" +
                "cursor:pointer;line-height:1;" +
            "}" +
            "#" + BUTTON_ID + ":hover { background:var(--aes-bone-2); }" +
            "#" + BUTTON_ID + " .key {" +
                "color:var(--aes-slate);font-size:var(--aes-fs-micro);" +
                "border:var(--aes-bw-1) solid var(--aes-paper-rule);" +
                "padding:0 4px;border-radius:var(--aes-radius);margin-left:var(--aes-sp-1);" +
            "}";
        document.head.appendChild(style);
    }

    function currentDensity() {
        try {
            return document.documentElement.dataset.aesDensity || "comfortable";
        } catch (_) {
            return "comfortable";
        }
    }

    function paint(btn) {
        const d = currentDensity();
        btn.innerHTML = "";
        const lbl = document.createElement("span");
        lbl.textContent = "Density: " + d.toUpperCase();
        btn.appendChild(lbl);
        const key = document.createElement("span");
        key.className = "key";
        key.textContent = "⇧D";
        btn.appendChild(key);
        btn.title = "Cycle AES UI density (Shift+D)";
        btn.setAttribute("aria-label", "Cycle AES UI density. Currently " + d + ".");
    }

    function findHost() {
        for (const sel of NAV_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    function mount() {
        if (document.getElementById(BUTTON_ID)) return true;
        const host = findHost();
        if (!host) return false;
        ensureStyle();

        // The host is a <ul> in AS — wrap our button in an <li> if so.
        const isList = host.tagName === "UL";
        const btn = document.createElement("button");
        btn.id = BUTTON_ID;
        btn.type = "button";
        paint(btn);
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            if (window.AESSiteSkin && typeof window.AESSiteSkin.cycleDensity === "function") {
                window.AESSiteSkin.cycleDensity();
            }
        });

        if (isList) {
            const li = document.createElement("li");
            li.appendChild(btn);
            host.insertBefore(li, host.firstChild);
        } else {
            host.insertBefore(btn, host.firstChild);
        }

        // Storage-driven repaint so click + Shift+D both update the label.
        try {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "sync" && area !== "local") return;
                if (changes.aes_skin_density) paint(btn);
            });
        } catch (_) { /* extension context may not be ready */ }

        // Watch the html element's attribute as a secondary source.
        try {
            const mo = new MutationObserver(function () { paint(btn); });
            mo.observe(document.documentElement, {attributes: true, attributeFilter: ["data-aes-density"]});
        } catch (_) { /* noop */ }

        return true;
    }

    function boot() {
        if (mount()) return;
        // Nav not present yet — observe body for it to appear, then mount once.
        let mounted = false;
        const mo = new MutationObserver(function () {
            if (mounted) { mo.disconnect(); return; }
            if (mount()) {
                mounted = true;
                mo.disconnect();
            }
        });
        try {
            mo.observe(document.body || document.documentElement, {childList: true, subtree: true});
        } catch (_) { /* noop */ }
        // Stop observing after 30s — no nav is going to appear that late.
        setTimeout(function () { mo.disconnect(); }, 30_000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, {once: true});
    } else {
        boot();
    }

    window.AESDensityToggleButton = {mount, boot};
})();
