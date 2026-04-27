"use strict"

/**
 * CentralHubSettings — chrome.storage.local wrapper for hub user prefs.
 *
 * Storage key: "centralHub:settings"
 * Shape:
 *   {
 *     activeSection:  "fleet" | "routes" | "finance" | "tools",
 *     expandedTiles:  string[]  // tile ids that should mount expanded
 *     tileOrder:      { [section]: string[] }  // reserved for CH-5 drag-reorder
 *   }
 */
class CentralHubSettings {
    static KEY = "centralHub:settings"

    static defaults() {
        return {
            activeSection: "fleet",
            expandedTiles: [],
            tileOrder: {}
        }
    }

    static async load() {
        const blob = await chrome.storage.local.get([this.KEY])
        const stored = blob[this.KEY] || {}
        return Object.assign(this.defaults(), stored)
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
