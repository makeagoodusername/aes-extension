"use strict"

/**
 * CanvasStateStore — persisted UI state for the Schedule Canvas.
 *
 * Holds the lightweight shell preferences (active hub, current view, rail
 * mode/visibility, focused row/column, onboarding flags). NOT a place for
 * canvas data — schedules, demand, presets, candidates all live in their
 * existing stores. This is purely "where the user was last time they had
 * the canvas open".
 *
 * Storage shape:
 *   chrome.storage.local["<acctKey('canvas','state')>"] = {
 *     activeHub: string|null,
 *     view: "waves"|"timeline",
 *     railMode: "builder"|"advisor",
 *     railOpen: boolean,
 *     focusedAircraftId: string|null,
 *     focusedWaveId: string|null,
 *     advisorPrefs: {
 *       firstRunSeen: boolean,
 *       debouncedSuggestions: { [suggestionKey: string]: epochMs }
 *     }
 *   }
 *
 * Account scoping uses `AesAccountKey.acctKey("canvas", "state")` so two
 * accounts logged into the same browser don't share canvas state. Falls
 * back to the legacy unscoped key when bootstrap hasn't resolved yet —
 * matches the contract documented in modules/_shared/account-scoped-key.js.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCanvasStateStore) return

    const KEY_PREFIX = "canvas"
    const KEY_SUFFIX = "state"

    function _key() {
        if (window.AesAccountKey && typeof window.AesAccountKey.acctKey === "function") {
            return window.AesAccountKey.acctKey(KEY_PREFIX, KEY_SUFFIX)
        }
        return KEY_PREFIX + ":" + KEY_SUFFIX
    }

    function _defaults() {
        return {
            activeHub:          null,
            view:               "waves",
            railMode:           "builder",
            railOpen:           true,
            focusedAircraftId:  null,
            focusedWaveId:      null,
            advisorPrefs: {
                firstRunSeen:           false,
                debouncedSuggestions:   {}
            }
        }
    }

    /**
     * Returns the merged state — defaults overlaid with whatever is in
     * storage. Sub-objects (advisorPrefs) are deep-merged so an older blob
     * missing newly-introduced fields doesn't drop them. Callers receive
     * a fresh object each call; mutate freely without polluting the next
     * load.
     */
    async function load() {
        const key = _key()
        const data = await chrome.storage.local.get([key])
        const stored = data[key] || {}
        const defs = _defaults()
        const merged = Object.assign({}, defs, stored)
        merged.advisorPrefs = Object.assign({}, defs.advisorPrefs, stored.advisorPrefs || {})
        merged.advisorPrefs.debouncedSuggestions = Object.assign({},
            defs.advisorPrefs.debouncedSuggestions,
            (stored.advisorPrefs && stored.advisorPrefs.debouncedSuggestions) || {})
        return merged
    }

    /**
     * Shallow-merge a partial into the persisted state and write back.
     * `advisorPrefs` is sub-merged (one level) so callers updating only
     * `firstRunSeen` don't blow away `debouncedSuggestions`.
     */
    async function save(partial) {
        if (!partial || typeof partial !== "object") return null
        const key = _key()
        const current = await load()
        const next = Object.assign({}, current, partial)
        if (partial.advisorPrefs) {
            next.advisorPrefs = Object.assign({}, current.advisorPrefs, partial.advisorPrefs)
        }
        await chrome.storage.local.set({[key]: next})
        return next
    }

    /**
     * Subscribe to cross-tab state changes. Fires the callback with the
     * new state whenever the canvas key changes (including from a
     * different tab editing the same account). Returns an unsubscribe
     * function. Callers should always unsubscribe on dispose to avoid
     * keeping detached listeners alive.
     */
    function watch(cb) {
        if (typeof cb !== "function") return () => {}
        const key = _key()
        const listener = (changes, area) => {
            if (area !== "local") return
            if (!changes[key]) return
            try { cb(changes[key].newValue || _defaults()) }
            catch (err) { console.warn("[AES Canvas] state watcher threw", err) }
        }
        chrome.storage.onChanged.addListener(listener)
        return () => chrome.storage.onChanged.removeListener(listener)
    }

    /**
     * Convenience: record a suggestion as "dismissed" with the current
     * timestamp so the advisor engine can debounce repeats. Returns the
     * updated state. The key is opaque (advisor-engine builds it from
     * kind + route signature).
     */
    async function rememberDismissed(suggestionKey) {
        if (!suggestionKey) return null
        const cur = await load()
        const debounced = Object.assign({}, cur.advisorPrefs.debouncedSuggestions || {})
        debounced[suggestionKey] = Date.now()
        return save({advisorPrefs: {debouncedSuggestions: debounced}})
    }

    window.AesCanvasStateStore = {
        load, save, watch, rememberDismissed,
        defaults: _defaults
    }
})()
