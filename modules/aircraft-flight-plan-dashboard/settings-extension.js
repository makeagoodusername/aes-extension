"use strict"

/**
 * AFP Dashboard — settings shell.
 *
 * Live-write settings for the Fleet Hub AFP dashboard.
 *
 * Earlier tiers hard-coded `dryRunOnly: true` and ignored saves. The dashboard
 * now defaults to live one-leg POSTs and persists edits normally; callers can
 * still force a one-off dry-run by passing `opts.dryRun` to the applier.
 */
class AesAfpDashboardSettings {
    static KEY = "aircraftFlightPlanDashboard:settings"

    static DEFAULTS = {
        permanentLiveMode:          true,
        dryRunOnly:                 false,
        applyEnabled:               true,
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
        merged.permanentLiveMode = merged.permanentLiveMode !== false
        merged.dryRunOnly = merged.permanentLiveMode ? false : merged.dryRunOnly === true
        merged.applyEnabled = merged.permanentLiveMode ? true : merged.applyEnabled !== false
        merged.cooldownMinPerAircraft = isFinite(merged.cooldownMinPerAircraft)
            ? Math.max(0, Number(merged.cooldownMinPerAircraft))
            : AesAfpDashboardSettings.DEFAULTS.cooldownMinPerAircraft
        merged.maxBulkPostsPerRun = isFinite(merged.maxBulkPostsPerRun)
            ? Math.max(1, Number(merged.maxBulkPostsPerRun))
            : AesAfpDashboardSettings.DEFAULTS.maxBulkPostsPerRun
        merged.staggerMs = isFinite(merged.staggerMs)
            ? Math.max(0, Number(merged.staggerMs))
            : AesAfpDashboardSettings.DEFAULTS.staggerMs
        return merged
    }

    static async save(patch) {
        const current = await AesAfpDashboardSettings.load()
        const next = Object.assign({}, current, patch || {})
        await chrome.storage.local.set({[AesAfpDashboardSettings.KEY]: next})
        return AesAfpDashboardSettings.load()
    }
}

if (typeof window !== "undefined") {
    window.AesAfpDashboardSettings = AesAfpDashboardSettings
}
