"use strict";

/**
 * AES Command Palette — formal extension API.
 *
 * Facade over AESCommandRegistry that augments AESCommandPalette
 * (the UI host's public surface) with registration, hotkey-legend, and
 * recents helpers. Modules call `AESCommandPalette.register({...})` once
 * at load time, get back an unregister function, and never touch the
 * registry directly.
 *
 * Namespace strategy: extends existing AESCommandPalette in place so
 * there's a single window-global to remember. Existing consumers
 * (open / close / toggle / dispatch) are unchanged.
 *
 * Hotkey legend: a separate index keyed by section id (e.g. "navigation",
 * "route-assistant"). The "?" command in legend.js renders all entries.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AESCommandPalette || !window.AESCommandRegistry) return;
    if (window.AESCommandPalette._apiExtended) return;

    const reg = window.AESCommandRegistry;
    const legendIndex = new Map();   // sectionId → [{keys, desc}]

    /**
     * Register a palette command. Returns an unregister fn.
     * @param {{id, label, hint?, keywords?, scope?, available?, run}} spec
     */
    function register(spec) {
        if (!spec || typeof spec !== "object") return function () {};
        return reg.register(spec);
    }

    /**
     * Contribute hotkey entries to the "?" subcommand legend.
     * @param {{sectionId: string, entries: Array<{keys, desc}>}} bundle
     */
    function registerLegend(bundle) {
        if (!bundle || typeof bundle !== "object") return function () {};
        const sectionId = String(bundle.sectionId || "").trim();
        if (!sectionId) return function () {};
        const entries = Array.isArray(bundle.entries) ? bundle.entries.slice() : [];
        const validated = [];
        for (const e of entries) {
            if (!e || typeof e !== "object") continue;
            const keys = String(e.keys || "").trim();
            const desc = String(e.desc || "").trim();
            if (keys && desc) validated.push({ keys: keys, desc: desc });
        }
        if (!validated.length) return function () {};
        legendIndex.set(sectionId, validated);
        return function unregister() {
            if (legendIndex.get(sectionId) === validated) {
                legendIndex.delete(sectionId);
            }
        };
    }

    /**
     * Read the legend index. Used by legend.js to render.
     * @returns {Map<string, Array<{keys, desc}>>}
     */
    function getLegend() {
        const out = new Map();
        for (const [k, v] of legendIndex) out.set(k, v.slice());
        return out;
    }

    /**
     * Read the recent-command ring (id + ts pairs, newest-first).
     * @returns {Array<{id, ts}>}
     */
    function recents() {
        return typeof reg.recent === "function" ? reg.recent() : [];
    }

    /* Augment existing palette object additively. */
    window.AESCommandPalette.register = register;
    window.AESCommandPalette.registerLegend = registerLegend;
    window.AESCommandPalette.getLegend = getLegend;
    window.AESCommandPalette.recents = recents;
    window.AESCommandPalette._apiExtended = true;

    /* Casing alias for module authors who prefer Aes over AES. */
    window.AesCommandPalette = window.AESCommandPalette;
})();
