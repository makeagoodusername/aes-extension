"use strict"

/**
 * AesConductorForecastDriver — K15 bootstrap.
 *
 * AesConductorForecastStore self-subscribes to the daily
 * `signal:conductor:baseline:tick` and to debounced
 * `data:conductor:baseline:updated`. That covers *steady-state* refreshes,
 * but a fresh page load with stale (or empty) forecast cache and no recent
 * baseline writes would never refresh until the next baseline:tick.
 *
 * This driver fires one refresh shortly after `data:account:bootstrapped`
 * arrives so the conductor / risk-dashboard tiles see live forecasts on
 * first paint. The forecast-store deduplicates internally (a no-data
 * refresh is cheap; non-empty refreshes overwrite the prior blob).
 *
 * Idempotent: subsequent bootstrap events still re-fire refresh, but
 * forecasts only land when ≥3 samples exist per (metric, scope, scopeId).
 *
 * Pure plumbing — no UI, no settings.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorForecastDriver) return

    const BOOT_DELAY_MS = 1500   // give the signal store a chance to populate

    function _resolveHost(payload) {
        const server  = (payload && payload.server)  || ""
        const airline = (payload && payload.airline) || ""
        if (server) return {server, airline}
        try {
            if (typeof AES === "undefined") return null
            const s = AES.getServerName ? AES.getServerName() : ""
            const code = AES.getAirlineCode ? AES.getAirlineCode() : null
            const a = (code && code.code) || ""
            return s ? {server: s, airline: a} : null
        } catch (_) { return null }
    }

    let _bootedFor = null

    async function _bootstrap(host) {
        if (!host || !host.server) return
        const tail = host.server + ":" + (host.airline || "")
        if (_bootedFor === tail) return
        _bootedFor = tail
        const fs = window.AesConductorForecastStore
        if (!fs || typeof fs.refresh !== "function") return
        try { await fs.refresh(host) }
        catch (_) { /* noop */ }
    }

    function _scheduleBootstrap(payload) {
        const host = _resolveHost(payload)
        if (!host) return
        setTimeout(() => { _bootstrap(host).catch(() => {}) }, BOOT_DELAY_MS)
    }

    if (typeof window.CentralHubBus !== "undefined" && typeof window.CentralHubBus.on === "function") {
        window.CentralHubBus.on("data:account:bootstrapped", _scheduleBootstrap)
    }

    // If the bus already fired before this module loaded, schedule once anyway —
    // the host resolver falls back to AES.* globals so it'll catch up.
    setTimeout(() => {
        if (_bootedFor) return
        _scheduleBootstrap(null)
    }, BOOT_DELAY_MS * 2)

    window.AesConductorForecastDriver = {
        rebuildAll: () => {
            const host = _resolveHost(null)
            return host ? _bootstrap(host) : Promise.resolve()
        }
    }
})()
