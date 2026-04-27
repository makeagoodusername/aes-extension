"use strict";

// QOL: vim-style keyboard navigation across AS.
//
// `g <key>` navigates to a page family:
//   g d → /app/enterprise/dashboard
//   g f → /app/fleets
//   g s → /app/com/scheduling/<HUB>     (only when current path has a hub segment)
//   g a → /app/finance/accounting
//   g i → /app/com/inventory
//   g m → /app/com/markets
//   g o → /app/ops/stations
//   g e → /app/info/enterprises
//   g x → /app/enterprise/settings
// `/` focuses the first visible filter / search input.
// `?` opens a brutalist help popover listing every shortcut.
//
// Listeners are no-ops when the user is typing into a field.

(function () {
    if (window.AESSiteSkin && !window.AESSiteSkin.isEnabled()) return;

    const PREFIX_TIMEOUT_MS = 800;
    const HUB_RE = /\/app\/com\/scheduling\/([^/?#]+)/;
    const ENTERPRISE_RE = /\/app\/info\/enterprises\/([^/?#]+)/;

    const shortcuts = [
        { keys: "g d", desc: "Dashboard",          go: () => "/app/enterprise/dashboard" },
        { keys: "g f", desc: "Fleets",             go: () => "/app/fleets" },
        { keys: "g s", desc: "Scheduling (hub)",   go: () => {
            const m = location.pathname.match(HUB_RE);
            if (m) return `/app/com/scheduling/${m[1]}`;
            return null;
        } },
        { keys: "g a", desc: "Accounting",         go: () => "/app/finance/accounting" },
        { keys: "g l", desc: "Leasing",            go: () => "/app/finance/leasing" },
        { keys: "g i", desc: "Inventory (hub)",    go: () => {
            const m = location.pathname.match(HUB_RE);
            if (m) return `/app/com/inventory/${m[1]}`;
            return "/app/com/inventory";
        } },
        { keys: "g m", desc: "Markets (hub)",      go: () => {
            const m = location.pathname.match(HUB_RE);
            if (m) return `/app/com/markets/${m[1]}`;
            return null;
        } },
        { keys: "g o", desc: "Stations / ops",     go: () => "/app/ops/stations" },
        { keys: "g e", desc: "Enterprise info",    go: () => {
            const m = location.pathname.match(ENTERPRISE_RE);
            if (m) return `/app/info/enterprises/${m[1]}`;
            return null;
        } },
        { keys: "g x", desc: "Settings",           go: () => "/app/enterprise/settings" },
        { keys: "/",   desc: "Focus search/filter input", action: focusFilterInput },
        { keys: "?",   desc: "Show shortcuts",     action: showHelp },
        { keys: "Esc", desc: "Close popover/help / clear filter", action: null /* handled inline */ }
    ];

    function isTypingTarget(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        return false;
    }

    function focusFilterInput() {
        const filter = document.querySelector('input[data-aes-skin-filter="1"]');
        if (filter) { filter.focus(); filter.select(); return true; }
        const search = document.querySelector('input[type="search"]:not([disabled]), input[placeholder*="search" i]:not([disabled])');
        if (search) { search.focus(); search.select(); return true; }
        const firstText = document.querySelector('input[type="text"]:not([disabled])');
        if (firstText) { firstText.focus(); firstText.select(); return true; }
        return false;
    }

    let helpEl = null;
    let helpOverlay = null;

    function hideHelp() {
        if (helpEl) { helpEl.remove(); helpEl = null; }
        if (helpOverlay) { helpOverlay.remove(); helpOverlay = null; }
    }

    function showHelp() {
        if (helpEl) { hideHelp(); return; }
        helpOverlay = document.createElement("div");
        helpOverlay.className = "aes-skin-help__overlay";
        helpOverlay.addEventListener("click", hideHelp);

        helpEl = document.createElement("div");
        helpEl.className = "aes-skin-help";

        const header = document.createElement("div");
        header.className = "aes-skin-help__header";
        const title = document.createElement("h3");
        title.className = "aes-skin-help__title";
        title.textContent = "AES Shortcuts";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "aes-modal__close";
        close.textContent = "×";
        close.addEventListener("click", hideHelp);
        header.append(title, close);

        const body = document.createElement("div");
        body.className = "aes-skin-help__body";
        for (const sc of shortcuts) {
            const row = document.createElement("div");
            row.className = "aes-skin-help__row";
            const keys = document.createElement("span");
            keys.className = "aes-skin-help__keys";
            keys.textContent = sc.keys;
            const desc = document.createElement("span");
            desc.className = "aes-skin-help__desc";
            desc.textContent = sc.desc;
            row.append(keys, desc);
            body.append(row);
        }

        helpEl.append(header, body);
        document.body.append(helpOverlay, helpEl);
    }

    let prefix = null;
    let prefixTimer = null;

    function clearPrefix() {
        prefix = null;
        if (prefixTimer) { clearTimeout(prefixTimer); prefixTimer = null; }
    }

    function navigate(target) {
        if (!target) return;
        location.pathname = target;
    }

    function handleKey(e) {
        // Always respect Esc for closing help, even from inputs.
        if (e.key === "Escape") {
            if (helpEl) { hideHelp(); e.preventDefault(); return; }
        }

        if (isTypingTarget(e.target)) {
            // Inside a field: only Esc handled (above).
            return;
        }

        // Ignore modified key chords (Ctrl/Meta/Alt) so we don't fight browser shortcuts.
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        // `?` is shift+/. It's a real character with key "?".
        if (e.key === "?") { showHelp(); e.preventDefault(); return; }
        if (e.key === "/") { if (focusFilterInput()) e.preventDefault(); return; }

        if (e.key === "g") {
            prefix = "g";
            if (prefixTimer) clearTimeout(prefixTimer);
            prefixTimer = setTimeout(clearPrefix, PREFIX_TIMEOUT_MS);
            return;
        }

        if (prefix === "g" && /^[a-z]$/.test(e.key)) {
            const combo = `g ${e.key}`;
            const sc = shortcuts.find(s => s.keys === combo);
            clearPrefix();
            if (sc) {
                if (typeof sc.go === "function") {
                    const target = sc.go();
                    if (target) { navigate(target); e.preventDefault(); }
                } else if (typeof sc.action === "function") {
                    sc.action();
                    e.preventDefault();
                }
            }
            return;
        }
    }

    document.addEventListener("keydown", handleKey, true);

    // Expose the help popover so the AES menu can trigger it.
    window.AESSiteSkin = window.AESSiteSkin || {};
    window.AESSiteSkin.showShortcuts = showHelp;
    window.AESSiteSkin.hideShortcuts = hideHelp;
})();
