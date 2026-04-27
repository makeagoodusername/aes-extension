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
            pinnedTiles:   []
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
        if (!merged.tileOrder || typeof merged.tileOrder !== "object") merged.tileOrder = {}
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
