"use strict";

/**
 * Unified Settings — modal shell.
 *
 * 960px modal opened by AesUnifiedSettings.open(). Layout:
 *   [header: title · search · close]
 *   [tab rail: Customisation · Modules · Account · Data · About]
 *   [canvas: active tab content]
 *
 * Each tab is rendered by an external module (tab-customisation.js,
 * tab-account.js, etc.) registered into TAB_RENDERERS. Modules tab
 * dynamically lists adapters from AesUnifiedSettingsRegistry.
 *
 * Lazy mount: DOM is built on first open() and torn down on close().
 * Esc closes; backdrop click closes; resize repositions.
 */
(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.AesUnifiedSettingsShell) return;

    const HOST_ID = "aes-unified-settings";
    const STYLE_ID = HOST_ID + "-style";

    const TABS = [
        { id: "features",      label: "Features" },
        { id: "customisation", label: "Customisation" },
        { id: "modules",       label: "Modules" },
        { id: "account",       label: "Account" },
        { id: "data",          label: "Data" },
        { id: "coverage",      label: "Coverage" },
        { id: "about",         label: "About" }
    ];

    let modal = null;
    let backdrop = null;
    let canvasEl = null;
    let railEl = null;
    let isOpen = false;
    let activeTabId = "features";
    let activeModuleId = null;

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
            "#" + HOST_ID + "-backdrop {" +
                "position:fixed;inset:0;background:var(--aes-shadow-backdrop);" +
                "z-index:calc(var(--aes-z-modal) - 1);" +
                "opacity:0;transition:opacity var(--aes-tr-medium);" +
            "}" +
            "#" + HOST_ID + "-backdrop.open { opacity:1; }" +
            "#" + HOST_ID + " {" +
                "position:fixed;top:8vh;left:50%;transform:translateX(-50%);" +
                "width:min(960px, calc(100vw - 32px));max-height:84vh;" +
                "background:var(--aes-bone);color:var(--aes-oxide);" +
                "border:var(--aes-bw-2) solid var(--aes-oxide);" +
                "box-shadow:var(--aes-shadow-modal);" +
                "z-index:var(--aes-z-modal);display:flex;flex-direction:column;overflow:hidden;" +
                "font-family:var(--aes-font-display);font-size:var(--aes-fs-body);" +
            "}" +
            "#" + HOST_ID + " * { box-sizing:border-box; }" +
            "#" + HOST_ID + " .us-rail {" +
                "display:flex;gap:0;border-bottom:var(--aes-bw-2) solid var(--aes-oxide);" +
                "background:var(--aes-bone);flex:0 0 auto;" +
            "}" +
            "#" + HOST_ID + " .us-rail button {" +
                "padding:14px 18px;background:transparent;border:none;" +
                "border-right:var(--aes-bw-1) solid var(--aes-paper-rule);" +
                "font-family:var(--aes-font-display);font-weight:var(--aes-fw-display);" +
                "font-size:var(--aes-fs-small);" +
                "letter-spacing:var(--aes-tracking-caps);text-transform:uppercase;" +
                "color:var(--aes-oxide);cursor:pointer;" +
            "}" +
            "#" + HOST_ID + " .us-rail button.active {" +
                "background:var(--aes-oxide);color:var(--aes-bone);" +
            "}" +
            "#" + HOST_ID + " .us-canvas {" +
                "flex:1 1 auto;overflow:auto;padding:0;background:var(--aes-bone);" +
            "}" +
            "#" + HOST_ID + " header.us-head {" +
                "display:flex;align-items:center;justify-content:space-between;gap:12px;" +
                "padding:14px 18px;border-bottom:var(--aes-bw-1) solid var(--aes-paper-rule);" +
                "flex:0 0 auto;" +
            "}" +
            "#" + HOST_ID + " header.us-head .us-title {" +
                "font-weight:var(--aes-fw-display);font-size:var(--aes-fs-lead);" +
                "letter-spacing:var(--aes-tracking-caps);text-transform:uppercase;" +
            "}" +
            "#" + HOST_ID + " header.us-head input.us-search {" +
                "flex:1 1 320px;max-width:380px;padding:6px 10px;" +
                "border:var(--aes-bw-1) solid var(--aes-oxide);" +
                "background:var(--aes-bone);font-size:var(--aes-fs-body);" +
                "outline:none;font-family:inherit;" +
            "}" +
            "#" + HOST_ID + " header.us-head button.us-close {" +
                "background:transparent;border:none;font-size:var(--aes-fs-h3);" +
                "cursor:pointer;color:var(--aes-oxide);" +
            "}";
        document.head.appendChild(style);
    }

    function build() {
        ensureStyle();
        backdrop = document.createElement("div");
        backdrop.id = HOST_ID + "-backdrop";
        backdrop.addEventListener("click", close);

        modal = document.createElement("div");
        modal.id = HOST_ID;
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("aria-label", "AES — settings");

        const head = document.createElement("header");
        head.className = "us-head";
        const title = document.createElement("div");
        title.className = "us-title";
        title.textContent = "AES SETTINGS";
        const search = document.createElement("input");
        search.className = "us-search";
        search.type = "text";
        search.placeholder = "Search settings…";
        search.addEventListener("input", function (e) { runSearch(e.target.value); });
        const closeBtn = document.createElement("button");
        closeBtn.className = "us-close";
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", close);
        head.append(title, search, closeBtn);

        railEl = document.createElement("nav");
        railEl.className = "us-rail";
        railEl.setAttribute("role", "tablist");
        railEl.setAttribute("aria-label", "Settings sections");
        for (const t of TABS) {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.tabId = t.id;
            b.textContent = t.label;
            b.id = HOST_ID + "-tab-" + t.id;
            b.setAttribute("role", "tab");
            b.setAttribute("aria-selected", "false");
            b.setAttribute("aria-controls", HOST_ID + "-canvas");
            b.tabIndex = -1;
            b.addEventListener("click", function () { setActiveTab(t.id); });
            railEl.appendChild(b);
        }

        canvasEl = document.createElement("div");
        canvasEl.className = "us-canvas";
        canvasEl.id = HOST_ID + "-canvas";
        canvasEl.setAttribute("role", "tabpanel");

        modal.append(head, railEl, canvasEl);
    }

    function open(opts) {
        if (!document.body) return;
        if (!modal) build();
        if (opts && opts.tab) activeTabId = String(opts.tab);
        if (opts && opts.moduleId) activeModuleId = String(opts.moduleId);
        if (!modal.parentNode) document.body.append(backdrop, modal);
        isOpen = true;
        renderActiveTab();
        requestAnimationFrame(function () {
            if (backdrop) backdrop.classList.add("open");
        });
        document.addEventListener("keydown", onKey, true);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        // Let the active tab tear down (e.g. RA adapter releases its modal-mount).
        const renderers = window.AesUnifiedSettingsTabs || {};
        const r = renderers[activeTabId];
        if (r && typeof r.teardown === "function") {
            try { r.teardown(); } catch (e) { console && console.warn && console.warn("[unified-settings teardown]", activeTabId, e); }
        }
        if (backdrop) backdrop.classList.remove("open");
        setTimeout(function () {
            if (!isOpen) {
                if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
                if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
            }
        }, 140);
        document.removeEventListener("keydown", onKey, true);
    }

    function setActiveTab(tabId) {
        if (TABS.findIndex(function (t) { return t.id === tabId; }) < 0) return;
        if (tabId === activeTabId) return;
        // Tear down the outgoing tab so adapters can release embedded mounts.
        const renderers = window.AesUnifiedSettingsTabs || {};
        const prev = renderers[activeTabId];
        if (prev && typeof prev.teardown === "function") {
            try { prev.teardown(); } catch (e) { console && console.warn && console.warn("[unified-settings teardown]", activeTabId, e); }
        }
        activeTabId = tabId;
        if (modal) renderActiveTab();
    }

    function renderActiveTab() {
        if (!railEl || !canvasEl) return;
        Array.from(railEl.children).forEach(function (b) {
            const isActive = b.dataset.tabId === activeTabId;
            b.classList.toggle("active", isActive);
            b.setAttribute("aria-selected", isActive ? "true" : "false");
            b.tabIndex = isActive ? 0 : -1;
        });
        canvasEl.setAttribute("aria-labelledby", HOST_ID + "-tab-" + activeTabId);
        canvasEl.textContent = "";
        const renderers = window.AesUnifiedSettingsTabs || {};
        const r = renderers[activeTabId];
        if (r && typeof r.render === "function") {
            try { r.render(canvasEl, { moduleId: activeModuleId }); }
            catch (e) {
                console && console.warn && console.warn("[unified-settings tab]", activeTabId, e);
                canvasEl.textContent = "Tab failed to render.";
            }
        } else {
            const ph = document.createElement("div");
            ph.style.cssText = "padding:32px;text-align:center;color:var(--aes-slate);font-style:italic";
            ph.textContent = "Tab unavailable.";
            canvasEl.appendChild(ph);
        }
    }

    function onKey(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    }

    function runSearch(query) {
        const q = String(query || "").trim().toLowerCase();
        if (!q) { renderActiveTab(); return; }
        // Lightweight: jump to first matching module if any.
        const reg = window.AesUnifiedSettingsRegistry;
        if (!reg) return;
        const list = reg.list();
        for (const m of list) {
            if ((m.label || "").toLowerCase().indexOf(q) >= 0) {
                activeTabId = "modules";
                activeModuleId = m.moduleId;
                renderActiveTab();
                return;
            }
        }
    }

    window.AesUnifiedSettingsShell = {
        open, close, isOpen: function () { return isOpen; },
        setActiveTab, runSearch
    };
})();
