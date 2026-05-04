"use strict"

/**
 * AesConductorForecastStore — K15 cache layer over AesConductorForecaster.
 *
 * Stores per-(metric, scope, scopeId) forecast envelopes computed from the
 * signal ring buffer. Refreshes on:
 *   - signal:conductor:baseline:tick   (24h, from baseline-driver)
 *   - data:conductor:baseline:updated  (debounced, opportunistic)
 *   - explicit refresh(host) call (tile + scenario engine consult on demand)
 *
 * Storage:
 *   aesConductor:forecasts:<server>:<airline>
 *     → { "<metric>:<scope>:<scopeId>": forecastEnvelope }
 *
 * Cap 50 entries, soft TTL = 25h (so a missed daily tick still leaves the
 * forecast available for ~one extra day). Reads are cached in-process to
 * keep ctx-injection on the scenario engine hot path sync-fast.
 *
 * Forecasts the bundled scenarios declare via `scenario.forecast = [{...}]`:
 *   {metric, scope, scopeId | "*", horizonDays, model: "linear"|"ewma"}
 *
 * `scopeId: "*"` expands to every scopeId currently observed in the signal
 * series (e.g. every (hub, dest) pair seen in route.profit.changed).
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorForecastStore) return

    const PREFIX = "aesConductor:forecasts:"
    const CAP    = 50
    const TTL_MS = 25 * 3600 * 1000

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    function _composite(metric, scope, scopeId) {
        return String(metric) + ":" + String(scope || "global") + ":" + String(scopeId || "")
    }

    async function _read(key) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return {}
        try {
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return (v && typeof v === "object") ? v : {}
        } catch (_) { return {} }
    }

    async function _write(key, obj) {
        try { await chrome.storage.local.set({[key]: obj}) } catch (_) { /* noop */ }
    }

    let _cache = null
    let _cacheKey = null

    async function loadCached(host) {
        const k = _key(host)
        if (!k) return {}
        if (_cacheKey === k && _cache) return _cache
        const blob = await _read(k)
        _cache = blob
        _cacheKey = k
        return blob
    }

    function getForecast(blob, metric, scope, scopeId) {
        if (!blob) return null
        const e = blob[_composite(metric, scope, scopeId)]
        if (!e) return null
        if (e.computedAt && Date.now() - e.computedAt > TTL_MS) return null
        return e
    }

    /** Build sample series for a (metric, scope, scopeId) from the signal
     *  ring. Maps the same way baseline-driver does on the way in.
     *  Returns [{t, v}, …] newest-last. */
    async function _samplesFor(host, metric, scope, scopeId) {
        const ss = window.AesConductorSignalStore
        if (!ss || typeof ss.byType !== "function") return []
        let signals = []
        switch (metric) {
            case "maintenance.ratio":
                signals = await ss.byType(host, "maintenance.ratio.changed", 200); break
            case "maintenance.condition":
                signals = await ss.byType(host, "maintenance.condition.changed", 200); break
            case "cash.balance":
                signals = await ss.byType(host, "cash.balance.changed", 200); break
            case "route.profit":
                signals = await ss.byType(host, "route.profit.changed", 200); break
            default: return []
        }
        const out = []
        for (let i = signals.length - 1; i >= 0; i--) {
            const s = signals[i]
            if (!s || typeof s.firedAt !== "number") continue
            const p = s.payload || {}
            let match = false
            switch (metric) {
                case "maintenance.ratio":
                case "maintenance.condition":
                    match = (scope === "tail" && String(p.aircraftId || "") === String(scopeId || "")); break
                case "cash.balance":
                    match = (scope === "global"); break
                case "route.profit": {
                    const rk = (p.hub && p.dest) ? (String(p.hub).toUpperCase() + "-" + String(p.dest).toUpperCase()) : ""
                    match = (scope === "route" && rk === String(scopeId || "")); break
                }
                default: match = false
            }
            if (!match) continue
            const v = (typeof p.to === "number" && isFinite(p.to)) ? p.to : null
            if (v == null) continue
            out.push({t: s.firedAt, v})
        }
        return out
    }

    function _activeForecastSpecs() {
        const out = []
        try {
            const all = window.AesConductorScenarios && typeof window.AesConductorScenarios.all === "function"
                ? window.AesConductorScenarios.all() : []
            for (const sc of all) {
                const list = sc && Array.isArray(sc.forecast) ? sc.forecast : (sc && sc.forecast ? [sc.forecast] : [])
                for (const spec of list) {
                    if (!spec || !spec.metric) continue
                    out.push({
                        scenarioId:  sc.id,
                        metric:      String(spec.metric),
                        scope:       String(spec.scope || "global"),
                        scopeId:     spec.scopeId == null ? "" : String(spec.scopeId),
                        horizonDays: typeof spec.horizonDays === "number" ? spec.horizonDays : 28,
                        model:       spec.model === "ewma" ? "ewma" : "linear"
                    })
                }
            }
        } catch (_) { /* noop */ }
        return out
    }

    /** Discover concrete scope IDs for `scopeId:"*"` specs from recent
     *  signals (e.g. every observed route hub-dest). */
    async function _expandWildcards(host, specs) {
        const out = []
        const ss = window.AesConductorSignalStore
        for (const spec of specs) {
            if (spec.scopeId !== "*") { out.push(spec); continue }
            if (spec.scope === "global") { out.push({...spec, scopeId: ""}); continue }
            if (!ss || typeof ss.byType !== "function") continue
            let signalType = null
            switch (spec.metric) {
                case "maintenance.ratio":     signalType = "maintenance.ratio.changed"; break
                case "maintenance.condition": signalType = "maintenance.condition.changed"; break
                case "route.profit":          signalType = "route.profit.changed"; break
                default: signalType = null
            }
            if (!signalType) continue
            const signals = await ss.byType(host, signalType, 200)
            const seen = new Set()
            for (const s of signals) {
                const p = s && s.payload || {}
                let id = ""
                if (spec.scope === "tail" && p.aircraftId) id = String(p.aircraftId)
                else if (spec.scope === "route" && p.hub && p.dest) {
                    id = String(p.hub).toUpperCase() + "-" + String(p.dest).toUpperCase()
                }
                if (id && !seen.has(id)) { seen.add(id); out.push({...spec, scopeId: id}) }
            }
        }
        return out
    }

    async function refresh(host) {
        const k = _key(host)
        if (!k) return {count: 0}
        const fc = window.AesConductorForecaster
        if (!fc) return {count: 0, reason: "forecaster unavailable"}
        const expanded = await _expandWildcards(host, _activeForecastSpecs())
        const blob = {}
        let computed = 0
        for (const spec of expanded) {
            if (computed >= CAP) break
            const samples = await _samplesFor(host, spec.metric, spec.scope, spec.scopeId)
            if (samples.length < 3) continue
            const f = (spec.model === "ewma")
                ? fc.forecastEWMA(samples, spec.horizonDays)
                : fc.forecastLinear(samples, spec.horizonDays)
            if (!f || f.p50 == null) continue
            f.computedAt = Date.now()
            f.scenarioId = spec.scenarioId
            blob[_composite(spec.metric, spec.scope, spec.scopeId)] = f
            computed += 1
        }
        await _write(k, blob)
        _cache = blob
        _cacheKey = k
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("data:conductor:forecast:updated", {host, count: computed})
            }
        } catch (_) { /* noop */ }
        return {count: computed}
    }

    function _onBaselineTick() { try { refresh(window.AESHost || _hostFromAES()).catch(() => {}) } catch (_) {} }

    function _hostFromAES() {
        try {
            if (typeof AES === "undefined") return null
            const server  = AES.getServerName ? AES.getServerName() : ""
            const code    = AES.getAirlineCode ? AES.getAirlineCode() : null
            const airline = (code && code.code) || (AES.getAirlineIdentity ? AES.getAirlineIdentity() : "")
            return server ? {server, airline} : null
        } catch (_) { return null }
    }

    if (typeof window.CentralHubBus !== "undefined" && typeof window.CentralHubBus.on === "function") {
        window.CentralHubBus.on("signal:conductor:baseline:tick", _onBaselineTick)
        // Opportunistic refresh on debounced baseline writes — at most every
        // 60s to avoid thrashing when many signals fire in a burst.
        let lastOpportunistic = 0
        window.CentralHubBus.on("data:conductor:baseline:updated", () => {
            const now = Date.now()
            if (now - lastOpportunistic < 60_000) return
            lastOpportunistic = now
            _onBaselineTick()
        })
    }

    /** Sync accessor for the in-memory blob. Returns `null` until the cache
     *  is warmed by a `loadCached(host)` or `refresh(host)` call. UI surfaces
     *  rendering on hot paths warm it once at body render and consult `peek`
     *  per row to avoid awaiting in render loops. */
    function peek() { return _cache || null }

    window.AesConductorForecastStore = {
        loadCached, getForecast, refresh, peek,
        PREFIX, CAP, TTL_MS
    }
})()
