"use strict"

/**
 * Per-account keybinding overrides. Defaults are shipped in code; the
 * store only writes user changes. The wave-palette + wave-overlay +
 * wave-strip read `resolve()` to map an action id to the (possibly
 * overridden) chord.
 *
 * Storage:
 *   routeAssistant:waveKeybinds                  → (legacy)
 *   routeAssistant:waveKeybinds:acct:<id>        → (L2+)
 *     {bindings: {<actionId>: <chord>}, updatedAt}
 *
 * Chord format: pipe-separated modifiers + key, in canonical order:
 *   "Mod+Shift+K"  // Mod = Cmd on Mac, Ctrl elsewhere — matched at consult time
 *   "W"
 *   "Shift+W"
 *   "Escape"
 *
 * Default Mod-Shift-K avoids Chrome's omnibar-focus binding (Cmd-K).
 * Users may rebind to Cmd-K explicitly if they accept the conflict.
 */
class RouteAssistantWaveKeybindsStore {
    static LEGACY_KEY   = "routeAssistant:waveKeybinds"
    static SCOPE_PREFIX = "routeAssistant:waveKeybinds"

    static DEFAULT_BINDINGS = {
        "palette.open":           "Mod+Shift+K",
        "panel.toggleWaves":      "Mod+Shift+W",
        "palette.savePresetVar":  "Mod+Shift+S",
        "palette.pinActive":      "Mod+Shift+P",
        "wave.next":              "W",
        "wave.prev":              "Shift+W",
        "wave.add":               "N",
        "wave.delete":            "Delete",
        "drag.cancel":            "Escape"
    }

    static _key()       { return acctKey(RouteAssistantWaveKeybindsStore.SCOPE_PREFIX, "") }
    static _legacyKey() { return RouteAssistantWaveKeybindsStore.LEGACY_KEY }

    static async load() {
        const ns = RouteAssistantWaveKeybindsStore._key()
        const lg = RouteAssistantWaveKeybindsStore._legacyKey()
        const keys = (ns === lg) ? [ns] : [ns, lg]
        const out  = await chrome.storage.local.get(keys)
        const raw  = (out[ns] !== undefined) ? out[ns] : (out[lg] || null)
        const overrides = (raw && typeof raw.bindings === "object") ? raw.bindings : {}
        return {bindings: Object.assign({}, RouteAssistantWaveKeybindsStore.DEFAULT_BINDINGS, overrides),
                overrides}
    }

    static async resolve(actionId) {
        const block = await RouteAssistantWaveKeybindsStore.load()
        return block.bindings[actionId] || null
    }

    static async setBinding(actionId, chord) {
        if (!actionId) return null
        const block = await RouteAssistantWaveKeybindsStore.load()
        const next  = Object.assign({}, block.overrides)
        if (chord == null || chord === "") {
            delete next[actionId]
        } else {
            next[actionId] = String(chord)
        }
        const ns = RouteAssistantWaveKeybindsStore._key()
        await chrome.storage.local.set({[ns]: {bindings: next, updatedAt: Date.now()}})
        return next[actionId] || RouteAssistantWaveKeybindsStore.DEFAULT_BINDINGS[actionId] || null
    }

    static async resetAll() {
        const ns = RouteAssistantWaveKeybindsStore._key()
        await chrome.storage.local.remove([ns])
        return Object.assign({}, RouteAssistantWaveKeybindsStore.DEFAULT_BINDINGS)
    }

    /**
     * Test whether a KeyboardEvent matches a chord. "Mod" resolves to
     * metaKey on Mac and ctrlKey elsewhere (mirrors common app convention).
     * Returns true on match, false otherwise.
     */
    static matches(event, chord) {
        if (!event || !chord) return false
        const parts = String(chord).split("+")
        const key   = parts[parts.length - 1]
        const mods  = parts.slice(0, -1)
        if (event.key !== key) return false
        const isMac = (typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform))
        const wantMod   = mods.includes("Mod")
        const wantShift = mods.includes("Shift")
        const wantAlt   = mods.includes("Alt")
        const wantCtrl  = mods.includes("Ctrl")
        const modKey    = isMac ? !!event.metaKey : !!event.ctrlKey
        const otherCtrl = isMac ? !!event.ctrlKey : false   // accept "Ctrl+" on mac as literal Ctrl
        if (wantMod   !== modKey)         return false
        if (wantShift !== !!event.shiftKey) return false
        if (wantAlt   !== !!event.altKey)   return false
        if (wantCtrl  && !otherCtrl && !modKey) return false
        return true
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantWaveKeybindsStore = RouteAssistantWaveKeybindsStore
}
