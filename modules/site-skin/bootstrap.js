"use strict";

// Runs at document_start. Reads the user's skin/density preferences from
// chrome.storage.sync and stamps data attributes onto <html> before AS's
// own CSS paints, so there is no flash of un-skinned UI. The CSS in
// css/skin/skin-global.css is gated on `html[data-aes-skin="on"]` (and
// the mirrored `body.aes-skin` class) so flipping the toggle off in the
// options page reverts to vanilla AS within one storage event.

(function () {
    const SKIN_KEY = "aes_skin_enabled";
    const DENSITY_KEY = "aes_skin_density";
    const PAGE_KEY = "aes_skin_page";

    const root = document.documentElement;

    // Default: skin on, comfortable density. Match defaults in options.js.
    root.dataset.aesSkin = "on";
    root.dataset.aesDensity = "comfortable";

    function pageKindFromPath(pathname) {
        // Coarse page-family classification used by per-page CSS files
        // and the breadcrumb module. Keep keys lowercase, no slashes.
        if (/^\/app\/finance\//.test(pathname))                return "finance";
        if (/^\/action\/enterprise\/schedule/.test(pathname))  return "finance";
        if (/^\/app\/fleets/.test(pathname))                   return "fleet";
        if (/^\/app\/com\/scheduling/.test(pathname))          return "scheduling";
        if (/^\/app\/com\/inventory/.test(pathname))           return "inventory";
        if (/^\/app\/com\/markets/.test(pathname))             return "markets";
        if (/^\/app\/aircraft\/market/.test(pathname))         return "aircraft-market";
        if (/^\/app\/info\/airports/.test(pathname))           return "airports";
        if (/^\/app\/info\/enterprises/.test(pathname))        return "enterprises";
        if (/^\/app\/ops\//.test(pathname))                    return "ops";
        if (/^\/app\/enterprise\/dashboard/.test(pathname))    return "dashboard";
        if (/^\/app\/enterprise\/settings/.test(pathname))     return "settings";
        if (/^\/action\/info\/flight/.test(pathname))          return "flight-info";
        if (/^\/action\/enterprise\/staffOverview/.test(pathname)) return "staff";
        if (/^\/app\//.test(pathname))                         return "app";
        if (/^\/action\//.test(pathname))                      return "action";
        return "other";
    }

    root.dataset.aesPage = pageKindFromPath(location.pathname);

    function applySkin(enabled) {
        root.dataset.aesSkin = enabled === false ? "off" : "on";
        const body = document.body;
        if (body) {
            body.classList.toggle("aes-skin", enabled !== false);
        }
    }

    function applyDensity(density) {
        const value = density === "compact" ? "compact" : "comfortable";
        root.dataset.aesDensity = value;
    }

    function recoverInvalidatedContext(err) {
        const message = err && err.message ? err.message : String(err || "");
        if (!/Extension context invalidated/i.test(message)) return false;
        try { root.dataset.aesContext = "reloading"; } catch (_) { /* noop */ }
        try {
            if (document.body) document.body.dataset.aesContext = "reloading";
        } catch (_) { /* noop */ }
        try { location.reload(); } catch (_) { /* noop */ }
        return true;
    }

    // Synchronous initial read. chrome.storage.sync.get is async, so the
    // very first paint may briefly use the defaults set above — that's
    // fine because the defaults match the most common opt-in (skin on,
    // comfortable). The async callback corrects within a few ms.
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get([SKIN_KEY, DENSITY_KEY], function (items) {
            if (items && Object.prototype.hasOwnProperty.call(items, SKIN_KEY)) {
                applySkin(items[SKIN_KEY]);
            }
            if (items && Object.prototype.hasOwnProperty.call(items, DENSITY_KEY)) {
                applyDensity(items[DENSITY_KEY]);
            }
        });

        chrome.storage.onChanged.addListener(function (changes, area) {
            if (area !== "sync") return;
            if (changes[SKIN_KEY])    applySkin(changes[SKIN_KEY].newValue);
            if (changes[DENSITY_KEY]) applyDensity(changes[DENSITY_KEY].newValue);
        });

        if (chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener(function (msg) {
                if (!msg || msg.type !== "aes:site-skin:update") return false;
                if (Object.prototype.hasOwnProperty.call(msg, "enabled")) {
                    applySkin(msg.enabled);
                }
                if (Object.prototype.hasOwnProperty.call(msg, "density")) {
                    applyDensity(msg.density);
                }
                return false;
            });
        }
    }

    // <body> doesn't exist at document_start — wait for it then mirror the
    // skin state as a class so CSS authors can write `body.aes-skin .foo`
    // (familiar Bootstrap-override pattern) rather than chaining off <html>.
    function whenBodyReady(fn) {
        if (document.body) { fn(); return; }
        new MutationObserver(function (_, obs) {
            if (document.body) { obs.disconnect(); fn(); }
        }).observe(document.documentElement, { childList: true });
    }

    whenBodyReady(function () {
        if (root.dataset.aesSkin !== "off") {
            document.body.classList.add("aes-skin");
        }
        // Page kind also mirrored on body for selector convenience.
        document.body.dataset.aesPage = root.dataset.aesPage;
    });

    // Tiny global hook so other site-skin modules can read/write the toggle
    // without re-implementing the storage glue.
    window.AESSiteSkin = window.AESSiteSkin || {};
    window.AESSiteSkin.SKIN_KEY = SKIN_KEY;
    window.AESSiteSkin.DENSITY_KEY = DENSITY_KEY;
    window.AESSiteSkin.PAGE_KEY = PAGE_KEY;
    window.AESSiteSkin.isEnabled = function () { return root.dataset.aesSkin !== "off"; };
    window.AESSiteSkin.getDensity = function () { return root.dataset.aesDensity || "comfortable"; };
    window.AESSiteSkin.getPageKind = function () { return root.dataset.aesPage || "other"; };
    window.AESSiteSkin.handleInvalidatedContext = recoverInvalidatedContext;
    window.AESSiteSkin.safeRuntimeSendMessage = function (message, callback) {
        try {
            chrome.runtime.sendMessage(message, function (resp) {
                const lastErr = chrome.runtime && chrome.runtime.lastError;
                if (lastErr && recoverInvalidatedContext(lastErr)) return;
                if (typeof callback === "function") callback(resp, lastErr || null);
            });
            return true;
        } catch (e) {
            if (recoverInvalidatedContext(e)) return false;
            throw e;
        }
    };
    window.AESSiteSkin.safeSyncSet = function (payload) {
        try {
            chrome.storage.sync.set(payload, function () {
                const lastErr = chrome.runtime && chrome.runtime.lastError;
                if (lastErr) recoverInvalidatedContext(lastErr);
            });
            return true;
        } catch (e) {
            if (recoverInvalidatedContext(e)) return false;
            throw e;
        }
    };
    window.AESSiteSkin.setEnabled = function (v) {
        return window.AESSiteSkin.safeSyncSet({ [SKIN_KEY]: !!v });
    };
    window.AESSiteSkin.setDensity = function (v) {
        return window.AESSiteSkin.safeSyncSet({
            [DENSITY_KEY]: v === "compact" ? "compact" : "comfortable"
        });
    };
    window.AESSiteSkin.cycleDensity = function () {
        const next = root.dataset.aesDensity === "compact" ? "comfortable" : "compact";
        window.AESSiteSkin.setDensity(next);
    };
})();
