"use strict";

// QOL: vim-style keyboard navigation across AS.
//
// Bindings live in modules/customization/shortcut-registry.js as
// id → {keys, desc, go|action}. The user can rebind any of them from
// the Customization Studio (`g c`); rebinds persist via
// chrome.storage.local["customization"] and apply on the next storage
// event. Defaults: g d/f/s/a/l/i/m/o/e/x/c, plus `/` `?` Esc.
//
// Listeners are no-ops when the user is typing into a field.

(function () {
    function ensureSiteSkinApi() {
        const root = document.documentElement;
        const skin = window.AESSiteSkin = window.AESSiteSkin || {};
        skin.SKIN_KEY = skin.SKIN_KEY || "aes_skin_enabled";
        skin.DENSITY_KEY = skin.DENSITY_KEY || "aes_skin_density";
        skin.PAGE_KEY = skin.PAGE_KEY || "aes_skin_page";
        if (typeof skin.isEnabled !== "function") {
            skin.isEnabled = function () { return root.dataset.aesSkin !== "off"; };
        }
        if (typeof skin.getDensity !== "function") {
            skin.getDensity = function () { return root.dataset.aesDensity || "comfortable"; };
        }
        if (typeof skin.getPageKind !== "function") {
            skin.getPageKind = function () { return root.dataset.aesPage || "other"; };
        }
        if (typeof skin.safeSyncSet !== "function") {
            skin.safeSyncSet = function (payload) {
                try {
                    if (typeof chrome === "undefined"
                        || !chrome.storage || !chrome.storage.sync) return false;
                    chrome.storage.sync.set(payload);
                    return true;
                } catch (_) {
                    return false;
                }
            };
        }
        if (typeof skin.setEnabled !== "function") {
            skin.setEnabled = function (v) {
                root.dataset.aesSkin = v ? "on" : "off";
                if (document.body) document.body.classList.toggle("aes-skin", !!v);
                return skin.safeSyncSet({ [skin.SKIN_KEY]: !!v });
            };
        }
        if (typeof skin.setDensity !== "function") {
            skin.setDensity = function (v) {
                const value = v === "compact" ? "compact" : "comfortable";
                root.dataset.aesDensity = value;
                return skin.safeSyncSet({ [skin.DENSITY_KEY]: value });
            };
        }
        if (typeof skin.cycleDensity !== "function") {
            skin.cycleDensity = function () {
                skin.setDensity(skin.getDensity() === "compact" ? "comfortable" : "compact");
            };
        }
        return skin;
    }

    const siteSkin = ensureSiteSkinApi();
    const skinEnabled = !(siteSkin && typeof siteSkin.isEnabled === "function" && !siteSkin.isEnabled());

    const PREFIX_TIMEOUT_MS = 800;

    function registry() { return window.AESShortcutRegistry; }

    function resolved() {
        const reg = registry();
        return reg ? reg.resolved() : [];
    }

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
        for (const sc of resolved()) {
            if (sc.disabled) continue;
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

    /* Index resolved bindings by `keys` string for fast lookup. Rebuilt
       whenever the customization store changes. */
    let byKeys = {};
    function rebuildIndex() {
        const out = Object.create(null);
        for (const sc of resolved()) {
            if (sc.disabled) continue;
            if (!sc.keys) continue;
            out[sc.keys] = sc;
        }
        byKeys = out;
    }
    rebuildIndex();
    if (window.AESCustomizationStore && typeof window.AESCustomizationStore.subscribe === "function") {
        window.AESCustomizationStore.subscribe(rebuildIndex);
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

    function dispatch(sc) {
        if (!sc) return false;
        if (typeof sc.go === "function") {
            const target = sc.go();
            if (target) { navigate(target); return true; }
            return false;
        }
        if (typeof sc.action === "function") {
            sc.action();
            return true;
        }
        if (sc.action === "focusFilter") return focusFilterInput();
        if (sc.action === "showHelp")    { showHelp(); return true; }
        return false;
    }

    /* The chord scanner — collects up to two characters separated by a
       space, then looks them up in the resolved index. Single keys like
       `/` and `?` are looked up immediately. */
    function handleKey(e) {
        if (e.key === "Escape") {
            if (helpEl) { hideHelp(); e.preventDefault(); return; }
        }

        if (isTypingTarget(e.target)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        if (e.key === "?") {
            const sc = byKeys["?"];
            if (sc) { dispatch(sc); e.preventDefault(); }
            return;
        }
        if (e.key === "/") {
            const sc = byKeys["/"];
            if (sc) { if (dispatch(sc)) e.preventDefault(); }
            return;
        }

        /* Look for a chord-prefix match: any binding whose keys are
           exactly "<key> ..." starts a chord. The legacy default uses
           `g` as the only prefix; the registry-driven matcher accepts
           any single-char prefix that appears in a binding. */
        if (!prefix && /^[a-z]$/i.test(e.key)) {
            const ch = e.key.toLowerCase();
            const startsChord = Object.keys(byKeys).some(function (k) {
                return k.length > 1 && k[0] === ch && k[1] === " ";
            });
            if (startsChord) {
                prefix = ch;
                if (prefixTimer) clearTimeout(prefixTimer);
                prefixTimer = setTimeout(clearPrefix, PREFIX_TIMEOUT_MS);
                return;
            }
            return;
        }

        if (prefix && /^[a-z]$/i.test(e.key)) {
            const combo = prefix + " " + e.key.toLowerCase();
            const sc = byKeys[combo];
            clearPrefix();
            if (sc) {
                if (dispatch(sc)) e.preventDefault();
            }
        }
    }

    // Help dialog is always available (menu "Shortcuts" item, programmatic
    // showShortcuts), but the chord scanner only attaches when the skin is
    // enabled — vim-style nav is a skin feature.
    if (skinEnabled) document.addEventListener("keydown", handleKey, true);

    window.AESSiteSkin = window.AESSiteSkin || {};
    window.AESSiteSkin.showShortcuts = showHelp;
    window.AESSiteSkin.hideShortcuts = hideHelp;
})();
