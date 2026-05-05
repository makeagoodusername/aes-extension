"use strict"

/**
 * AFP Dashboard — settings shell.
 *
 * Tier 2 settings shell. Controls live writes.
 */
class AesAfpDashboardSettings {
    static KEY = "aircraftFlightPlanDashboard:settings"

    static DEFAULTS = {
        dryRunOnly:                 false,
        applyEnabled:               false,
        cooldownMinPerAircraft:     5,
        circuitBreakerTrippedAt:    null,
        maxBulkPostsPerRun:         50,
        staggerMs:                  1500
    }

    static async load() {
        let stored = null
        try {
            const got = await chrome.storage.local.get([AesAfpDashboardSettings.KEY])
            stored = got[AesAfpDashboardSettings.KEY] || null
        } catch (e) { /* non-fatal */ }

        const merged = Object.assign({}, AesAfpDashboardSettings.DEFAULTS, stored || {})
        return merged
    }

    static async save(patch) {
        if (!patch) return AesAfpDashboardSettings.load()
        const current = await AesAfpDashboardSettings.load()
        const next = Object.assign({}, current, patch)
        try {
            await chrome.storage.local.set({[AesAfpDashboardSettings.KEY]: next})
        } catch (e) {
            console.warn("[AES afp-dashboard] settings save failed", e)
        }
        return next
    }
}

if (typeof window !== "undefined") {
    window.AesAfpDashboardSettings = AesAfpDashboardSettings
}
