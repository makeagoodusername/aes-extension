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
        { id: "customisation", label: "Customisation" },
        { id: "modules",       label: "Modules" },
        { id: "account",       label: "Account" },
        { id: "data",          label: "Data" },
        { id: "about",         label: "About" }
    ];

    let modal = null;
    let backdrop = null;
    let canvasEl = null;
    let railEl = null;
    let isOpen = false;
    let activeTabId = "customisation";
    let activeModuleId = null;

    function tokens() { return window.AESTokens; }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        const T = tokens();
        const colorBone = T ? T.color.bone : "#F4F1EA";
        const colorOxide = T ? T.color.oxide : "#2B2520";
        const colorPaperRule = T ? T.color.paperRule : "#C9C0B0";
        style.textContent =
            "#" + HOST_ID + "-backdrop {" +
                "position:fixed;inset:0;background:rgba(26,22,18,0.55);" +
                "z-index:9998;opacity:0;transition:opacity 120ms ease;" +
            "}" +
            "#" + HOST_ID + "-backdrop.open { opacity:1; }" +
            "#" + HOST_ID + " {" +
                "position:fixed;top:8vh;left:50%;transform:translateX(-50%);" +
                "width:min(960px, calc(100vw - 32px));max-height:84vh;" +
                "background:" + colorBone + ";color:" + colorOxide + ";" +
                "border:2px solid " + colorOxide + ";box-shadow:6px 6px 0 " + colorOxide + ";" +
                "z-index:9999;display:flex;flex-direction:column;overflow:hidden;" +
                "font-family:'Inter Tight',system-ui,sans-serif;font-size:13px;" +
            "}" +
            "#" + HOST_ID + " * { box-sizing:border-box; }" +
            "#" + HOST_ID + " .us-rail {" +
                "display:flex;gap:0;border-bottom:2px solid " + colorOxide + ";" +
                "background:" + colorBone + ";flex:0 0 auto;" +
            "}" +
            "#" + HOST_ID + " .us-rail button {" +
                "padding:14px 18px;background:transparent;border:none;border-right:1px solid " + colorPaperRule + ";" +
                "font-family:'Inter Tight',system-ui,sans-serif;font-weight:800;font-size:11px;" +
                "letter-spacing:0.08em;text-transform:uppercase;color:" + colorOxide + ";cursor:pointer;" +
            "}" +
            "#" + HOST_ID + " .us-rail button.active {" +
                "background:" + colorOxide + ";color:" + colorBone + ";" +
            "}" +
            "#" + HOST_ID + " .us-canvas {" +
                "flex:1 1 auto;overflow:auto;padding:0;background:" + colorBone + ";" +
            "}" +
            "#" + HOST_ID + " header.us-head {" +
                "display:flex;align-items:center;justify-content:space-between;gap:12px;" +
                "padding:14px 18px;border-bottom:1px solid " + colorPaperRule + ";flex:0 0 auto;" +
            "}" +
            "#" + HOST_ID + " header.us-head .us-title {" +
                "font-weight:800;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;" +
            "}" +
            "#" + HOST_ID + " header.us-head input.us-search {" +
                "flex:1 1 320px;max-width:380px;padding:6px 10px;" +
                "border:1px solid " + colorOxide + ";background:" + colorBone + ";font-size:12px;" +
                "outline:none;font-family:inherit;" +
            "}" +
            "#" + HOST_ID + " header.us-head button.us-close {" +
                "background:transparent;border:none;font-size:18px;cursor:pointer;color:" + colorOxide + ";" +
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
        for (const t of TABS) {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.tabId = t.id;
            b.textContent = t.label;
            b.addEventListener("click", function () { setActiveTab(t.id); });
            railEl.appendChild(b);
        }

        canvasEl = document.createElement("div");
        canvasEl.className = "us-canvas";

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
            b.classList.toggle("active", b.dataset.tabId === activeTabId);
        });
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
            ph.style.cssText = "padding:32px;text-align:center;color:#7A6F66;font-style:italic";
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
