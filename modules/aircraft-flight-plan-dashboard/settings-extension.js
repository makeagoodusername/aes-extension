"use strict"

/**
 * AFP Dashboard — settings shell.
 *
 * Tier 1 hard-codes both safety gates (`dryRunOnly: true`, `applyEnabled: false`)
 * regardless of stored values. The store is wired now so Tier 2 can flip them
 * without a separate migration; until then `load()` returns the locked T1
 * shape and `save()` is a no-op (with a console warn) so a curious user
 * editing storage by hand can't accidentally enable live POSTs.
 */
class AesAfpDashboardSettings {
    static KEY = "aircraftFlightPlanDashboard:settings"

    static T1_LOCKED = {
        dryRunOnly:                 true,    // Tier 2 will allow false
        applyEnabled:               false,   // Tier 2 will allow true
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

        const merged = Object.assign({}, AesAfpDashboardSettings.T1_LOCKED, stored || {})
        // Force the T1 invariants regardless of whatever's in storage.
        merged.dryRunOnly   = true
        merged.applyEnabled = false
        return merged
    }

    static async save(patch) {
        // Tier 1 is read-only. We accept the call so callers don't break,
        // but log so anyone wiring a settings UI early sees it during
        // development.
        console.warn("[AES afp-dashboard] settings.save is a no-op in Tier 1; gates are locked", patch)
        return AesAfpDashboardSettings.load()
    }
}

if (typeof window !== "undefined") {
    window.AesAfpDashboardSettings = AesAfpDashboardSettings
}
