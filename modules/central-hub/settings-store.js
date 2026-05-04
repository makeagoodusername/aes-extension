"use strict"

/**
 * CentralHubSettings — chrome.storage.local wrapper for hub user prefs.
 *
 * Storage key: "centralHub:settings"
 * Shape:
 *   {
 *     activeSection:  "fleet" | "routes" | "operations" | "finance" | "tools",
 *     expandedTiles:  string[]  // tile ids that should mount expanded
 *     tileOrder:      { [section]: string[] }  // reserved for CH-5 drag-reorder
 *     pinnedTiles:    string[]  // CH-5f — tile ids pinned to a virtual
 *                               //   "Pinned" section above the active one
 *   }
 */
class CentralHubSettings {
    static KEY = "centralHub:settings"
    static _memory = {}

    static SECTIONS = ["fleet", "routes", "operations", "finance", "tools"]

    static defaults() {
        return {
            activeSection: "fleet",
            expandedTiles: [],
            tileOrder:     {},
            pinnedTiles:   [],
            // C-2 — recents rail ring buffer (cap 5). Pushed by shell
            // when a tile is expanded; rendered by recents-rail.js.
            recentTiles:   [],
            // C-3 — per-tile section overrides. Behind kill switch
            // (default OFF) — even when enabled, the override map
            // starts empty so the default IA is preserved.
            tileSectionOverrides:        {},
            tileSectionOverridesEnabled: false,
            // CB0 — opt-in Cubist visual mode. Defaults OFF; first
            // activation prompts a confirm (§4.18 invariant).
            cubistMode:        false,
            cubistModeAcked:   false,
            // CB6 — polish sub-toggles. Read by js/cubist-a11y.js
            // and reflected to body[data-aes-motion] +
            // body[data-aes-cb-patterns] on every page.
            cubistMotion:      "on",   // "on" | "off"
            cubistColorBlind:  false,
            // CH-W1+ — Cascade overhaul. layoutMode flips between the
            // legacy section flow ("classic") and the salience-ranked
            // waterfall ("cascade"). Defaults to classic; cascadePromptedAt
            // gates the first-boot prompt (§4.18 — no silent default flips).
            // cascadePromptDismissed is a permanent-reject flag set by the
            // "Don't show again" CTA in the prompt — when true the prompt
            // never re-fires regardless of cascadePromptedAt.
            layoutMode:               "classic",      // "classic" | "cascade"
            cascadePromptedAt:        0,
            cascadePromptDismissed:   false,
            // CH-W1 — per-input weights for the salience scorer. Empty
            // map → CentralHubSalience.DEFAULT_WEIGHTS used. The
            // Customization → Dashboard section exposes sliders.
            salienceWeights:      {},
            // CH-W4 — full-width pinning (long-press cycle on the pin
            // button). Layered above pinnedTiles[] — a tile can be in
            // both lists; full-width implies pinned-to-top.
            pinnedFullWidthTiles: [],
            // CH-W5 — projection of tileSectionOverrides{} into multi-topic
            // overrides for cascade. Populated on first cascade boot;
            // tileSectionOverrides{} stays unchanged for backwards-compat.
            tileTopicOverrides:   {},
            // CH-W3 — multi-select topic chip filter for cascade.
            // Empty array = ALL (no filter).
            activeTopicFilter:    [],
            // CH-W5 — schema bumps record one-shot migrations.
            //   1 → 2: tileSectionOverrides → tileTopicOverrides projection
            schemaVersion:        1
        }
    }

    /**
     * Load + validate. Falls back to "fleet" when persisted activeSection
     * isn't in the section list (covers tiles being moved between
     * sections — CH-5b moved Crew/Alliance from "tools" to "operations",
     * Service Profile/Station Auto from "routes" to "operations").
     */
    static async load() {
        const blob = await this._getStorage().get([this.KEY])
        const stored = blob[this.KEY] || {}
        const merged = Object.assign(this.defaults(), stored)
        if (this.SECTIONS.indexOf(merged.activeSection) < 0) {
            merged.activeSection = "fleet"
        }
        if (!Array.isArray(merged.expandedTiles)) merged.expandedTiles = []
        if (!Array.isArray(merged.pinnedTiles))   merged.pinnedTiles   = []
        if (!Array.isArray(merged.recentTiles))   merged.recentTiles   = []
        if (!merged.tileSectionOverrides || typeof merged.tileSectionOverrides !== "object") {
            merged.tileSectionOverrides = {}
        }
        if (typeof merged.tileSectionOverridesEnabled !== "boolean") merged.tileSectionOverridesEnabled = false
        if (!merged.tileOrder || typeof merged.tileOrder !== "object") merged.tileOrder = {}
        if (typeof merged.cubistMode !== "boolean")      merged.cubistMode      = false
        if (typeof merged.cubistModeAcked !== "boolean") merged.cubistModeAcked = false
        if (merged.cubistMotion !== "off")               merged.cubistMotion    = "on"
        if (typeof merged.cubistColorBlind !== "boolean") merged.cubistColorBlind = false
        if (merged.layoutMode !== "cascade")             merged.layoutMode      = "classic"
        if (typeof merged.cascadePromptedAt !== "number") merged.cascadePromptedAt = 0
        if (typeof merged.cascadePromptDismissed !== "boolean") merged.cascadePromptDismissed = false
        if (!merged.salienceWeights || typeof merged.salienceWeights !== "object") {
            merged.salienceWeights = {}
        }
        if (!Array.isArray(merged.pinnedFullWidthTiles)) merged.pinnedFullWidthTiles = []
        if (!merged.tileTopicOverrides || typeof merged.tileTopicOverrides !== "object") {
            merged.tileTopicOverrides = {}
        }
        if (typeof merged.schemaVersion !== "number" || merged.schemaVersion < 1) {
            merged.schemaVersion = 1
        }
        if (!Array.isArray(merged.activeTopicFilter)) merged.activeTopicFilter = []
        return merged
    }

    static async save(settings) {
        return this._getStorage().set({[this.KEY]: settings})
    }

    static async patch(partial) {
        const current = await this.load()
        const next = Object.assign(current, partial)
        await this.save(next)
        return next
    }

    static _getStorage() {
        const local = typeof chrome !== "undefined"
            && chrome.storage
            && chrome.storage.local
        if (local && typeof local.get === "function" && typeof local.set === "function") {
            return {
                get: async (keys) => {
                    try {
                        return await local.get(keys)
                    } catch (err) {
                        console.warn("[AES Hub] settings storage read failed; using in-memory fallback", err)
                        return this._memoryGet(keys)
                    }
                },
                set: async (items) => {
                    try {
                        await local.set(items)
                        Object.assign(this._memory, items || {})
                    } catch (err) {
                        console.warn("[AES Hub] settings storage write failed; using in-memory fallback", err)
                        Object.assign(this._memory, items || {})
                    }
                }
            }
        }
        return {
            get: async (keys) => this._memoryGet(keys),
            set: async (items) => {
                Object.assign(this._memory, items || {})
            }
        }
    }

    static _memoryGet(keys) {
        if (keys === null || keys === undefined) {
            return Object.assign({}, this._memory)
        }
        if (typeof keys === "string") {
            return keys in this._memory ? {[keys]: this._memory[keys]} : {}
        }
        if (Array.isArray(keys)) {
            const out = {}
            keys.forEach((key) => {
                if (key in this._memory) out[key] = this._memory[key]
            })
            return out
        }
        if (keys && typeof keys === "object") {
            const out = {}
            Object.keys(keys).forEach((key) => {
                out[key] = key in this._memory ? this._memory[key] : keys[key]
            })
            return out
        }
        return {}
    }
}

if (typeof window !== "undefined") {
    window.CentralHubSettings = CentralHubSettings
}
