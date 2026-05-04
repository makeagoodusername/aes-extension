"use strict"

/**
 * AesScheduleColorOverrides — per-Chrome-profile bar color overrides
 * for the Fleet Schedule Grid + Schedule Canvas.
 *
 * One chrome.storage.local key, unscoped by airline:
 *   aesScheduleColors:overrides = {
 *     schemaVersion: 1,
 *     byRoute:    { "JFK→LAX": "#3656A8", ... },
 *     byAircraft: { "12345":   "#B8472A", ... },
 *     byDay:      { "0":       "#2F5F3F", ... },   // 0=Mon..6=Sun
 *     maintenance: "#1A1612"                         // global, contrasted
 *   }
 *
 * Public API (window.AesScheduleColorOverrides):
 *   .load()
 *     → Promise<state> — defaults overlaid with whatever is stored.
 *   .set(scope, key, color)
 *     → Promise<state> — scope ∈ {"route","aircraft","day","maintenance"}.
 *       For "maintenance" the key is ignored (single global value).
 *   .clear(scope, key)
 *     → Promise<state> — drop a single override; pass scope alone (no key)
 *       to clear the whole scope, or call .resetAll() for everything.
 *   .resetAll()
 *     → Promise<state> — wipe all overrides; deterministic palette returns.
 *   .watch(cb)
 *     → unsubscribe — fires cb(newState) whenever the key changes (including
 *       cross-tab edits).
 *   .defaultMaintenance()
 *     → string — the high-contrast default; used as fallback when the user
 *       has not set a maintenance override.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesScheduleColorOverrides) return

    const KEY = "aesScheduleColors:overrides"
    const SCHEMA = 1
    const VALID_SCOPES = ["route", "aircraft", "day", "maintenance"]

    // Default MX color: oxide (#1A1612 / near-black). Picked so it stays
    // readable against any user-chosen route palette and visibly contrasts
    // both the bone (#F4F1EA) lane and any pastel route fill.
    const DEFAULT_MAINTENANCE = "#1A1612"

    function _defaults() {
        return {
            schemaVersion: SCHEMA,
            byRoute:       {},
            byAircraft:    {},
            byDay:         {},
            maintenance:   DEFAULT_MAINTENANCE
        }
    }

    function _normalize(stored) {
        const def = _defaults()
        if (!stored || typeof stored !== "object") return def
        return {
            schemaVersion: SCHEMA,
            byRoute:       Object.assign({}, stored.byRoute    || {}),
            byAircraft:    Object.assign({}, stored.byAircraft || {}),
            byDay:         Object.assign({}, stored.byDay      || {}),
            maintenance:   typeof stored.maintenance === "string" && stored.maintenance
                            ? stored.maintenance
                            : DEFAULT_MAINTENANCE
        }
    }

    async function load() {
        try {
            const data = await chrome.storage.local.get([KEY])
            return _normalize(data[KEY])
        } catch (_) {
            return _defaults()
        }
    }

    async function _write(next) {
        try { await chrome.storage.local.set({[KEY]: next}) } catch (_) { /* noop */ }
        return next
    }

    function _bucketFor(state, scope) {
        if (scope === "route")    return state.byRoute
        if (scope === "aircraft") return state.byAircraft
        if (scope === "day")      return state.byDay
        return null
    }

    async function set(scope, key, color) {
        if (VALID_SCOPES.indexOf(scope) === -1) return load()
        if (typeof color !== "string" || !color) return load()
        const cur = await load()
        if (scope === "maintenance") {
            cur.maintenance = color
            return _write(cur)
        }
        const bucket = _bucketFor(cur, scope)
        if (!bucket) return cur
        if (key == null || key === "") return cur
        bucket[String(key)] = color
        return _write(cur)
    }

    async function clear(scope, key) {
        if (VALID_SCOPES.indexOf(scope) === -1) return load()
        const cur = await load()
        if (scope === "maintenance") {
            cur.maintenance = DEFAULT_MAINTENANCE
            return _write(cur)
        }
        const bucket = _bucketFor(cur, scope)
        if (!bucket) return cur
        if (key == null || key === "") {
            // Clear whole scope.
            if (scope === "route")    cur.byRoute    = {}
            if (scope === "aircraft") cur.byAircraft = {}
            if (scope === "day")      cur.byDay      = {}
            return _write(cur)
        }
        delete bucket[String(key)]
        return _write(cur)
    }

    async function resetAll() {
        return _write(_defaults())
    }

    function watch(cb) {
        if (typeof cb !== "function") return () => {}
        const listener = (changes, area) => {
            if (area !== "local") return
            if (!changes[KEY]) return
            try { cb(_normalize(changes[KEY].newValue)) }
            catch (err) { console.warn("[AES color-overrides] watcher threw", err) }
        }
        try { chrome.storage.onChanged.addListener(listener) } catch (_) {}
        return () => {
            try { chrome.storage.onChanged.removeListener(listener) } catch (_) {}
        }
    }

    function defaultMaintenance() { return DEFAULT_MAINTENANCE }

    window.AesScheduleColorOverrides = {
        load, set, clear, resetAll, watch,
        defaults: _defaults,
        defaultMaintenance,
        STORAGE_KEY: KEY
    }
})()
