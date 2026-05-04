"use strict"

/**
 * AesConductorBaselineDriver — K13 subscriber that maps conductor:signal
 * payloads into BaselineStore.update() calls.
 *
 * Mapping (signal.type → metric, scope, scopeId, value):
 *   maintenance.ratio.changed     → maintenance.ratio    tail   payload.aircraftId  payload.to
 *   maintenance.condition.changed → maintenance.condition tail  payload.aircraftId  payload.to
 *   cash.balance.changed          → cash.balance         global —                    payload.to
 *   route.profit.changed          → route.profit         route  hub-dest             payload.to
 *   ors.rank.changed              → (per-class)          route  hub-dest             rankAvg
 *
 * Scenarios with absent baselines stay on shipped DEFAULT_* constants — the
 * store is a passive observer; never gates writes to AS.
 *
 * Roll-up tick is registered against chrome.alarms when available. Today the
 * tick is a no-op (the EWMA is already incremental); the hook is here so K15
 * forecast-store can pick it up to refresh forecasts on a daily cadence.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorBaselineDriver) return

    function _num(v) { return (typeof v === "number" && isFinite(v)) ? v : null }
    function _routeKey(p) {
        const h = p && p.hub  ? String(p.hub).toUpperCase()  : ""
        const d = p && p.dest ? String(p.dest).toUpperCase() : ""
        return (h && d) ? (h + "-" + d) : null
    }

    function _emitsFor(signal) {
        if (!signal || !signal.type) return []
        const p = signal.payload || {}
        const out = []
        switch (signal.type) {
            case "maintenance.ratio.changed": {
                const v = _num(p.to)
                if (v != null && p.aircraftId) out.push(["maintenance.ratio", "tail", String(p.aircraftId), v])
                return out
            }
            case "maintenance.condition.changed": {
                const v = _num(p.to)
                if (v != null && p.aircraftId) out.push(["maintenance.condition", "tail", String(p.aircraftId), v])
                return out
            }
            case "cash.balance.changed": {
                const v = _num(p.to)
                if (v != null) out.push(["cash.balance", "global", "", v])
                return out
            }
            case "route.profit.changed": {
                const v = _num(p.to)
                const rk = _routeKey(p)
                if (v != null && rk) out.push(["route.profit", "route", rk, v])
                return out
            }
            case "ors.rank.changed": {
                const rk = _routeKey(p)
                if (!rk || !Array.isArray(p.classes)) return out
                let sum = 0, cnt = 0
                for (const c of p.classes) {
                    const r = _num(c && c.rankTo)
                    if (r != null) { sum += r; cnt += 1 }
                }
                if (cnt > 0) out.push(["ors.rank.avg", "route", rk, sum / cnt])
                return out
            }
            default:
                return out
        }
    }

    function _onSignal(signal) {
        if (!signal) return
        const host = {server: signal.server, airline: signal.airline}
        if (!host.server) return
        const store = window.AesConductorBaselineStore
        if (!store || typeof store.update !== "function") return
        const triplets = _emitsFor(signal)
        for (const t of triplets) {
            store.update(host, t[0], t[1], t[2], t[3]).catch(() => {})
        }
    }

    if (typeof window.CentralHubBus !== "undefined" && typeof window.CentralHubBus.on === "function") {
        window.CentralHubBus.on("conductor:signal", _onSignal)
    }

    function _onTick() {
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("signal:conductor:baseline:tick", {at: Date.now()})
            }
        } catch (_) { /* noop */ }
    }

    if (typeof chrome !== "undefined" && chrome.alarms && chrome.alarms.create) {
        try {
            chrome.alarms.create("aesConductor:baseline:tick", {periodInMinutes: 24 * 60})
            if (chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener) {
                chrome.alarms.onAlarm.addListener((a) => {
                    if (a && a.name === "aesConductor:baseline:tick") _onTick()
                })
            }
        } catch (_) { /* noop */ }
    }

    window.AesConductorBaselineDriver = {
        evaluate: _onSignal,
        emitsFor: _emitsFor
    }
})()
