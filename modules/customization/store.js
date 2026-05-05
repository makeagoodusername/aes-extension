"use strict";

/**
 * AES Customization — store.
 *
 * Wraps the dedicated `chrome.storage.local["customization"]` blob.
 * Writes funnel through a background message (`aes:customization:patch`)
 * so concurrent tabs cannot race each other; the background uses the
 * same single-writer queue pattern as `aesAccounts`.
 *
 * Reads are direct — content scripts hydrate a local cache once at
 * boot, then refresh on `chrome.storage.onChanged`.
 *
 * Schema lives in token-registry + presets; this file is glue.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESCustomizationStore) return;

    const KEY = "customization";
    const SCHEMA_VERSION = 1;
    const PATCH_MSG = "aes:customization:patch";

    /* B-1 ornament intensity scale — keep in sync with skin-art-deco.css.
       "moderate" is the default so a fresh install of a deco preset
       surfaces the full Art Deco vocabulary; users tune down via Studio. */
    const ORNAMENT_INTENSITIES = ["none", "subtle", "moderate", "full"];
    const DENSITY_VALUES = ["compact", "comfortable", "spacious"];
    const NUMERAL_STYLES = ["tabular", "proportional"];

    function emptyStore() {
        return {
            schemaVersion: SCHEMA_VERSION,
            active: { presetId: "default" },
            presets: {},
            scopes: { global: {} },
            shortcuts: {},
            ornament: { intensity: "moderate" },
            density: { bySurface: {} },
            numerals: {},
            userPresets: {}
        };
    }

    let cache = emptyStore();
    let hydrated = false;
    const subscribers = new Set();

    function notify() {
        for (const fn of subscribers) {
            try { fn(cache); } catch (e) { console && console.warn && console.warn("[customization]", e); }
        }
    }

    function applyHydrated(blob) {
        if (!blob || typeof blob !== "object") {
            cache = emptyStore();
            return;
        }
        const scopes = (blob.scopes && typeof blob.scopes === "object") ? blob.scopes : {};
        const ornamentBlob = (blob.ornament && typeof blob.ornament === "object") ? blob.ornament : {};
        const densityBlob = (blob.density && typeof blob.density === "object") ? blob.density : {};
        const intensity = String(ornamentBlob.intensity || "");
        const okIntensity = ORNAMENT_INTENSITIES.indexOf(intensity) >= 0 ? intensity : "moderate";
        cache = {
            schemaVersion: Number(blob.schemaVersion) || SCHEMA_VERSION,
            active: blob.active && typeof blob.active === "object"
                ? { presetId: String(blob.active.presetId || "default") }
                : { presetId: "default" },
            presets: (blob.presets && typeof blob.presets === "object") ? blob.presets : {},
            scopes: {
                global:  (scopes.global  && typeof scopes.global  === "object") ? scopes.global  : {},
                section: (scopes.section && typeof scopes.section === "object") ? scopes.section : {},
                tile:    (scopes.tile    && typeof scopes.tile    === "object") ? scopes.tile    : {}
            },
            shortcuts: (blob.shortcuts && typeof blob.shortcuts === "object") ? blob.shortcuts : {},
            ornament: { intensity: okIntensity },
            density: {
                bySurface: (densityBlob.bySurface && typeof densityBlob.bySurface === "object")
                    ? densityBlob.bySurface : {}
            },
            numerals: (blob.numerals && typeof blob.numerals === "object") ? blob.numerals : {},
            userPresets: (blob.userPresets && typeof blob.userPresets === "object") ? blob.userPresets : {}
        };
    }

    function load() {
        return new Promise(function (resolve) {
            if (typeof chrome === "undefined" || !chrome.storage) {
                hydrated = true;
                resolve(cache);
                return;
            }
            chrome.storage.local.get([KEY], function (items) {
                applyHydrated(items && items[KEY]);
                hydrated = true;
                // Track C — fire subscribers on first hydration so consumers
                // that subscribed before load resolved (e.g. site-skin
                // keyboard-shortcuts.js's rebuildIndex) re-read the now-
                // populated cache. Without this, persisted shortcut
                // overrides only took effect after the next storage write.
                notify();
                resolve(cache);
            });
        });
    }

    function get() { return cache; }

    function isHydrated() { return hydrated; }

    function activePresetId() {
        return (cache.active && cache.active.presetId) || "default";
    }

    function activePreset() {
        const id = activePresetId();
        if (cache.presets && cache.presets[id]) return cache.presets[id];
        if (window.AESPresets) return window.AESPresets.getById(id) || window.AESPresets.getById("default");
        return null;
    }

    function globalOverrides() {
        return (cache.scopes && cache.scopes.global) || {};
    }

    function sectionOverrides(sectionId) {
        const all = (cache.scopes && cache.scopes.section) || {};
        if (sectionId == null) return all;
        return all[sectionId] || {};
    }

    function tileOverrides(tileId) {
        const all = (cache.scopes && cache.scopes.tile) || {};
        if (tileId == null) return all;
        return all[tileId] || {};
    }

    function shortcutOverrides() {
        return cache.shortcuts || {};
    }

    /* ── B-1 ornament / density / numerals / user-preset accessors ── */

    function ornamentIntensity() {
        const v = (cache.ornament && cache.ornament.intensity) || "moderate";
        return ORNAMENT_INTENSITIES.indexOf(v) >= 0 ? v : "moderate";
    }

    function densityFor(surface) {
        const all = (cache.density && cache.density.bySurface) || {};
        if (surface == null) return all;
        const v = all[surface];
        return DENSITY_VALUES.indexOf(v) >= 0 ? v : null;
    }

    function numerals() {
        return cache.numerals || {};
    }

    function listUserPresets() {
        const dict = cache.userPresets || {};
        const out = [];
        for (const id of Object.keys(dict)) {
            const p = dict[id];
            if (p && typeof p === "object") out.push(p);
        }
        out.sort(function (a, b) {
            return Number(b.createdAt || 0) - Number(a.createdAt || 0);
        });
        return out;
    }

    function getUserPreset(id) {
        const dict = cache.userPresets || {};
        return (id && dict[id]) || null;
    }

    function setOrnamentIntensity(intensity) {
        const v = String(intensity || "");
        if (ORNAMENT_INTENSITIES.indexOf(v) < 0) {
            return Promise.resolve({ ok: false, error: "bad intensity" });
        }
        return patch({ ornament: { intensity: v } });
    }

    function setDensityFor(surface, value) {
        const s = String(surface || "");
        if (!s) return Promise.resolve({ ok: false, error: "missing surface" });
        if (value == null) {
            return patch({ density: { bySurface: { [s]: null } } });
        }
        const v = String(value);
        if (DENSITY_VALUES.indexOf(v) < 0) {
            return Promise.resolve({ ok: false, error: "bad density" });
        }
        return patch({ density: { bySurface: { [s]: v } } });
    }

    function setNumerals(spec) {
        if (!spec || typeof spec !== "object") {
            return Promise.resolve({ ok: false, error: "bad numerals" });
        }
        const node = {};
        if (typeof spec.style === "string" && NUMERAL_STYLES.indexOf(spec.style) >= 0) {
            node.style = spec.style;
        }
        if (typeof spec.currency === "string") node.currency = spec.currency;
        if (typeof spec.time === "string") node.time = spec.time;
        if (typeof spec.separator === "string") node.separator = spec.separator;
        return patch({ numerals: node });
    }

    function saveUserPreset(name, snapshot) {
        const trimmed = String(name || "").trim().slice(0, 64);
        if (!trimmed) return Promise.resolve({ ok: false, error: "missing name" });
        const id = "user-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
        const entry = {
            id: id,
            name: trimmed,
            createdAt: Date.now(),
            snapshot: (snapshot && typeof snapshot === "object") ? snapshot : {}
        };
        return patch({ userPresets: { [id]: entry } }).then(function (resp) {
            if (resp && resp.ok) resp.id = id;
            return resp;
        });
    }

    function updateUserPreset(id, fields) {
        const k = String(id || "");
        if (!k || !cache.userPresets || !cache.userPresets[k]) {
            return Promise.resolve({ ok: false, error: "missing preset" });
        }
        const node = {};
        if (fields && typeof fields === "object") {
            if (typeof fields.name === "string") node.name = fields.name.trim().slice(0, 64);
            if (fields.snapshot && typeof fields.snapshot === "object") node.snapshot = fields.snapshot;
        }
        if (!Object.keys(node).length) {
            return Promise.resolve({ ok: false, error: "empty update" });
        }
        return patch({ userPresets: { [k]: node } });
    }

    function deleteUserPreset(id) {
        const k = String(id || "");
        if (!k) return Promise.resolve({ ok: false, error: "missing id" });
        return patch({ userPresets: { [k]: null } });
    }

    /* ── Active editing scope (in-memory only, not persisted) ─────
       Sections that write overrides consult this so a single click on
       the scope ribbon retargets all subsequent edits. */
    let currentScope = { type: "global" };
    const scopeSubs = new Set();
    function notifyScope() {
        for (const fn of scopeSubs) {
            try { fn(currentScope); } catch (_) {}
        }
    }
    function getCurrentScope() { return currentScope; }
    function setCurrentScope(s) {
        if (!s || typeof s !== "object") return;
        const t = s.type;
        if (t !== "global" && t !== "section" && t !== "tile") return;
        if (t !== "global" && !s.id) return;
        currentScope = t === "global" ? { type: "global" } : { type: t, id: String(s.id) };
        notifyScope();
    }
    function subscribeScope(fn) {
        if (typeof fn !== "function") return function () {};
        scopeSubs.add(fn);
        return function () { scopeSubs.delete(fn); };
    }

    /**
     * Send a patch to the background worker. Patches are shallow-merged
     * by the background; passing `{scopes: {global: {"--aes-bone": null}}}`
     * deletes that override.
     *
     * @param {Object} patch — partial CustomizationStore tree
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    function patch(patch) {
        return new Promise(function (resolve) {
            if (typeof chrome === "undefined" || !chrome.runtime) {
                resolve({ ok: false, error: "no chrome.runtime" });
                return;
            }
            try {
                chrome.runtime.sendMessage(
                    { type: PATCH_MSG, patch: patch },
                    function (resp) {
                        if (chrome.runtime.lastError) {
                            resolve({ ok: false, error: chrome.runtime.lastError.message || "sendMessage failed" });
                            return;
                        }
                        resolve(resp || { ok: false, error: "no response" });
                    }
                );
            } catch (err) {
                resolve({ ok: false, error: (err && err.message) || String(err) });
            }
        });
    }

    function setActivePreset(presetId) {
        return patch({ active: { presetId: String(presetId) } });
    }

    /**
     * Write a CSS-var override into the given scope. If `scope` is
     * omitted, writes to the active editing scope (currentScope).
     *
     * @param {{type: "global"|"section"|"tile", id?: string} | string} [scope]
     * @param {string} cssVar
     * @param {string|null} value — null clears
     */
    function setOverride(/* scope?, cssVar, value */) {
        let scope, cssVar, value;
        if (arguments.length >= 3) {
            scope  = arguments[0]; cssVar = arguments[1]; value = arguments[2];
        } else {
            scope  = currentScope; cssVar = arguments[0]; value = arguments[1];
        }
        const v = (value === null || value === undefined) ? null : String(value);
        const node = { [cssVar]: v };
        if (typeof scope === "string") scope = { type: "global" };  // legacy hint
        if (!scope || scope.type === "global") {
            return patch({ scopes: { global: node } });
        }
        if (scope.type === "section" && scope.id) {
            return patch({ scopes: { section: { [scope.id]: node } } });
        }
        if (scope.type === "tile" && scope.id) {
            return patch({ scopes: { tile: { [scope.id]: node } } });
        }
        return Promise.resolve({ ok: false, error: "bad scope" });
    }

    /* Backwards-compatible — Phase 1 call sites used setGlobalOverride.
       It now routes through the active scope so a Phase 2 user editing
       a per-tile scope sees per-tile writes from the same call site. */
    function setGlobalOverride(cssVar, value) {
        return setOverride(currentScope, cssVar, value);
    }

    /**
     * Batched scope-aware override write — a single patch round-trip
     * for many tokens. Used by bulk-shift / motion / typography-scale.
     *
     * @param {{type, id?}} [scope] — defaults to currentScope
     * @param {Object<string, string|null>} tokens — cssVar → value
     */
    function setOverridesBatch(/* scope?, tokens */) {
        let scope, tokens;
        if (arguments.length >= 2) { scope = arguments[0]; tokens = arguments[1]; }
        else                       { scope = currentScope; tokens = arguments[0]; }
        const node = {};
        for (const k of Object.keys(tokens || {})) {
            const v = tokens[k];
            node[k] = (v === null || v === undefined) ? null : String(v);
        }
        if (!scope || scope.type === "global") {
            return patch({ scopes: { global: node } });
        }
        if (scope.type === "section" && scope.id) {
            return patch({ scopes: { section: { [scope.id]: node } } });
        }
        if (scope.type === "tile" && scope.id) {
            return patch({ scopes: { tile: { [scope.id]: node } } });
        }
        return Promise.resolve({ ok: false, error: "bad scope" });
    }

    function clearGlobalOverrides() {
        return patch({ scopes: { global: "__CLEAR__" } });
    }

    function clearScope(scope) {
        if (!scope || scope.type === "global") {
            return patch({ scopes: { global: "__CLEAR__" } });
        }
        if (scope.type === "section" && scope.id) {
            return patch({ scopes: { section: { [scope.id]: null } } });
        }
        if (scope.type === "tile" && scope.id) {
            return patch({ scopes: { tile: { [scope.id]: null } } });
        }
        return Promise.resolve({ ok: false, error: "bad scope" });
    }

    /**
     * Get all overrides for a scope.
     */
    function scopeOverrides(scope) {
        if (!scope || scope.type === "global") return globalOverrides();
        if (scope.type === "section") return sectionOverrides(scope.id);
        if (scope.type === "tile") return tileOverrides(scope.id);
        return {};
    }

    function setShortcut(actionId, keys, disabled) {
        return patch({
            shortcuts: {
                [actionId]: keys === null
                    ? null
                    : { keys: String(keys), disabled: !!disabled }
            }
        });
    }

    function subscribe(fn) {
        if (typeof fn !== "function") return function () {};
        subscribers.add(fn);
        return function () { subscribers.delete(fn); };
    }

    function _onStorageChanged(changes, area) {
        if (area !== "local") return;
        if (!changes[KEY]) return;
        applyHydrated(changes[KEY].newValue);
        notify();
    }

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        try { chrome.storage.onChanged.addListener(_onStorageChanged); } catch (_) { /* noop */ }
    }

    window.AESCustomizationStore = {
        KEY,
        SCHEMA_VERSION,
        ORNAMENT_INTENSITIES,
        DENSITY_VALUES,
        NUMERAL_STYLES,
        load,
        get,
        isHydrated,
        activePresetId,
        activePreset,
        globalOverrides,
        sectionOverrides,
        tileOverrides,
        scopeOverrides,
        shortcutOverrides,
        ornamentIntensity,
        densityFor,
        numerals,
        listUserPresets,
        getUserPreset,
        patch,
        setActivePreset,
        setOverride,
        setOverridesBatch,
        setGlobalOverride,
        clearGlobalOverrides,
        clearScope,
        setShortcut,
        setOrnamentIntensity,
        setDensityFor,
        setNumerals,
        saveUserPreset,
        updateUserPreset,
        deleteUserPreset,
        subscribe,
        getCurrentScope,
        setCurrentScope,
        subscribeScope
    };
})();
