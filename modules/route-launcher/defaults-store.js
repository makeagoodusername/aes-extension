"use strict"

/**
 * Route Launcher — defaults applied to every one-click submission.
 *
 * Persisted in `chrome.storage.local["settings"].routeLauncher` via
 * AesSettings (modules/_shared/settings-bridge.js). Validated + clamped
 * here; the bridge is intentionally untyped.
 */
class AesRouteLauncherDefaults {
    static AREA = "routeLauncher"

    static DEFAULTS = Object.freeze({
        defaultPricePct:      100,
        defaultService:       "",
        defaultDepartureTime: "09:00",
        defaultTurnaroundMin: 30,
        slotStrategy:         "earliest-gap",
        maxConcurrentTabs:    3
    })

    static _validStrategies = new Set(["earliest-gap", "fixed-time", "daily-round-robin"])

    static async load() {
        if (typeof window === "undefined" || !window.AesSettings) {
            return Object.assign({}, AesRouteLauncherDefaults.DEFAULTS)
        }
        const raw = await window.AesSettings.getArea(AesRouteLauncherDefaults.AREA)
        return AesRouteLauncherDefaults._merge(raw || {})
    }

    static async save(patch) {
        if (typeof window === "undefined" || !window.AesSettings) return null
        const cur = await AesRouteLauncherDefaults.load()
        const merged = AesRouteLauncherDefaults._merge(Object.assign({}, cur, patch || {}))
        await window.AesSettings.saveArea(AesRouteLauncherDefaults.AREA, merged)
        return merged
    }

    static _merge(raw) {
        const D = AesRouteLauncherDefaults.DEFAULTS
        const pct = Number(raw.defaultPricePct)
        const turn = Number(raw.defaultTurnaroundMin)
        const cap = Number(raw.maxConcurrentTabs)
        const strat = String(raw.slotStrategy || "")
        const dep = String(raw.defaultDepartureTime || "")
        return {
            defaultPricePct:      Number.isFinite(pct) && pct >= 50 && pct <= 200 ? pct : D.defaultPricePct,
            defaultService:       typeof raw.defaultService === "string" ? raw.defaultService : D.defaultService,
            defaultDepartureTime: /^\d{1,2}:\d{2}$/.test(dep) ? dep : D.defaultDepartureTime,
            defaultTurnaroundMin: Number.isFinite(turn) && turn >= 0 && turn <= 240 ? Math.round(turn) : D.defaultTurnaroundMin,
            slotStrategy:         AesRouteLauncherDefaults._validStrategies.has(strat) ? strat : D.slotStrategy,
            maxConcurrentTabs:    Number.isFinite(cap) && cap >= 1 && cap <= 10 ? Math.round(cap) : D.maxConcurrentTabs
        }
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherDefaults = AesRouteLauncherDefaults
}
