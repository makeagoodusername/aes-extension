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
            cubistColorBlind:  false
        }
    }

    /**
     * Load + validate. Falls back to "fleet" when persisted activeSection
     * isn't in the section list (covers tiles being moved between
     * sections — CH-5b moved Crew/Alliance from "tools" to "operations",
     * Service Profile/Station Auto from "routes" to "operations").
     */
    static async load() {
        const blob = await chrome.storage.local.get([this.KEY])
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
        return merged
    }

    static async save(settings) {
        return chrome.storage.local.set({[this.KEY]: settings})
    }

    static async patch(partial) {
        const current = await this.load()
        const next = Object.assign(current, partial)
        await this.save(next)
        return next
    }
}

if (typeof window !== "undefined") {
    window.CentralHubSettings = CentralHubSettings
}
