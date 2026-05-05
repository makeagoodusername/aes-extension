"use strict"

/**
 * AesConductorOutcomeDriver — K10 outcome-attribution scheduler.
 *
 * Walks the per-account fire ring on three triggers:
 *   1. Mount-time foreground tick (so a fresh dashboard mount surfaces
 *      any verdicts that the KPI window has produced since the last tab).
 *   2. `conductor:signal` bus event — opportunistic re-eval so a profit
 *      drop / ratio bump that arrives mid-session updates the chip without
 *      waiting for the periodic tick.
 *   3. 30-min `setInterval` inside the dashboard tab — periodic catch-up
 *      that doesn't depend on signal traffic. (chrome.alarms isn't used
 *      because this is content-script context and the alarm has nothing
 *      to read DOM-side; the dashboard tab's own setInterval is enough.)
 *
 * For each fire whose `outcome.terminal` isn't already true, the driver
 * looks up the scenario's `evaluate(fire, ctx)` and, if the result is
 * non-null and changes the prior outcome, persists via
 * `AesConductorScenarioStore.applyOutcome`. Pure read of the signal-store
 * ring — no scrapes, no POSTs.
 *
 * Defensive: every dependency guarded with `typeof === "undefined"`. A bad
 * evaluator can't kill the driver; one fire's failure logs and skips on.
 *
 * Bus event emitted (for tile auto-refresh):
 *   `conductor:outcome:applied {fireId, scenarioId, outcome}`
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorOutcomeDriver) return

    const TICK_MS = 30 * 60 * 1000

    let _running   = false
    let _intervalId = 0

    function _bus() {
        return (typeof window !== "undefined" && window.CentralHubBus) || null
    }

    /** Resolve {server, airline} via AES globals — same pattern signal-layer
     *  uses. Returns null when not on a host page. */
    function _resolveHost() {
        if (typeof AES === "undefined") return null
        let server = ""
        try { server = AES.getServerName ? (AES.getServerName() || "") : "" } catch (_) { server = "" }
        if (!server) return null
        let airline = ""
        try {
            const code = AES.getAirlineCode ? AES.getAirlineCode() : null
            airline = (code && code.code) ? code.code : ""
        } catch (_) { airline = "" }
        if (!airline && AES.getAirlineIdentity) {
            try { airline = AES.getAirlineIdentity() || "" } catch (_) { airline = "" }
        }
        return {server, airline}
    }

    function _scenarioById(id) {
        if (typeof window.AesConductorScenarios === "undefined") return null
        try {
            const all = window.AesConductorScenarios.all() || []
            return all.find(s => s && s.id === id) || null
        } catch (_) { return null }
    }

    /** Has the prior outcome's verdict changed?  Compares favourable +
     *  terminal + reason; observed/expected deltas can drift continuously
     *  during the open window so they aren't part of the equality check. */
    function _outcomeChanged(prior, next) {
        if (!next) return false
        if (!prior) return true
        return prior.favourable !== next.favourable
            || prior.terminal   !== next.terminal
            || prior.reason     !== next.reason
    }

    /** Build the evaluator ctx. Caches per-type signal lookups across all
     *  fires in one tick so we read the signal-store ring once. */
    function _makeCtx(host) {
        const cache = new Map()
        return {
            now: Date.now(),
            host,
            byType: (type) => {
                if (cache.has(type)) return cache.get(type)
                const ssp = window.AesConductorSignalStore
                if (!ssp || typeof ssp.byType !== "function") {
                    cache.set(type, []); return []
                }
                // byType is async; we run a sync stand-in by reading from
                // the cache after the first await landed in tickOnce. The
                // evaluator runs inside an async pass so this is awaited
                // there; here we return a lazily-resolved promise wrapper.
                return cache.get(type) || []
            }
        }
    }

    /** Run one full pass over the fire ring. Single-flight via _running. */
    async function tickOnce(opts) {
        opts = opts || {}
        if (_running && !opts.force) return
        _running = true
        try {
            const host = _resolveHost()
            if (!host) return
            const store = window.AesConductorScenarioStore
            if (!store || typeof store.all !== "function") return
            const fires = await store.all(host)
            if (!Array.isArray(fires) || !fires.length) return

            // Pre-fetch every signal type any active evaluator might want.
            // The bundled evaluators only read three types; pre-fetching
            // them once keeps per-fire eval pure-sync.
            const sigStore = window.AesConductorSignalStore
            const wanted   = ["maintenance.ratio.changed",
                              "maintenance.condition.changed",
                              "route.profit.changed",
                              "ors.rank.changed"]
            const cache = new Map()
            if (sigStore && typeof sigStore.byType === "function") {
                for (const t of wanted) {
                    try { cache.set(t, await sigStore.byType(host, t, 200)) }
                    catch (_) { cache.set(t, []) }
                }
            } else {
                for (const t of wanted) cache.set(t, [])
            }

            // K14.1 — prefetch the user/drift threshold overlay once per
            // tick and reshape it into a per-scenario map. Pure-sync ctx
            // reads on the evaluator hot path; defaults kick in if the
            // store is missing or empty.
            const thresholds = {}
            try {
                const tStore = window.AesConductorThresholdStore
                if (tStore && typeof tStore.load === "function") {
                    const blob = await tStore.load(host) || {}
                    for (const composite of Object.keys(blob)) {
                        const e = blob[composite]
                        if (!e || typeof e.value !== "number" || !isFinite(e.value)) continue
                        const dot = composite.indexOf(".")
                        if (dot <= 0) continue
                        const sid = composite.slice(0, dot)
                        const key = composite.slice(dot + 1)
                        if (!thresholds[sid]) thresholds[sid] = {}
                        thresholds[sid][key] = e.value
                    }
                }
            } catch (_) { /* noop — defaults */ }

            // K13/K15 — prefetch baselines + forecasts so evaluators can
            // read sync via `ctx.baselines[<metric>:<scope>:<id>]` etc.
            let baselines = {}
            let forecasts = {}
            try {
                const bs = window.AesConductorBaselineStore
                if (bs && typeof bs.loadCached === "function") baselines = await bs.loadCached(host) || {}
            } catch (_) { /* noop */ }
            try {
                const fs = window.AesConductorForecastStore
                if (fs && typeof fs.loadCached === "function") forecasts = await fs.loadCached(host) || {}
            } catch (_) { /* noop */ }

            const ctx = {
                now:        Date.now(),
                host:       host,
                byType:     (t) => cache.get(t) || [],
                thresholds: thresholds,
                baselines:  baselines,
                forecasts:  forecasts
            }

            let applied = 0
            for (const fire of fires) {
                if (!fire || !fire.id) continue
                if (fire.outcome && fire.outcome.terminal) continue
                const scenario = _scenarioById(fire.scenarioId)
                if (!scenario || typeof scenario.evaluate !== "function") continue
                if (!scenario.kpiWindowMs) continue                  // not instrumented
                let next = null
                try { next = scenario.evaluate(fire, ctx) }
                catch (e) {
                    console.warn("[AES Conductor K10] evaluator threw", scenario.id, e)
                    continue
                }
                if (!next) continue
                if (!_outcomeChanged(fire.outcome, next)) continue
                try { await store.applyOutcome(host, fire.id, next) }
                catch (_) { continue }
                applied++
                const b = _bus()
                if (b && typeof b.emit === "function") {
                    try {
                        b.emit("conductor:outcome:applied", {
                            fireId:     fire.id,
                            scenarioId: fire.scenarioId,
                            outcome:    next
                        })
                    } catch (_) { /* noop */ }
                }
            }
            return {applied, scanned: fires.length}
        } catch (e) {
            console.warn("[AES Conductor K10] tickOnce threw", e)
            return null
        } finally {
            _running = false
        }
    }

    /** Wire bus + interval. Idempotent. */
    function attach() {
        if (_intervalId) return
        const b = _bus()
        if (b && typeof b.on === "function") {
            // Opportunistic re-eval when a fresh signal could change a verdict.
            b.on("conductor:signal", (sig) => {
                if (!sig || !sig.type) return
                const T = sig.type
                if (T !== "maintenance.ratio.changed"
                 && T !== "maintenance.condition.changed"
                 && T !== "route.profit.changed"
                 && T !== "ors.rank.changed") return
                tickOnce().catch(() => {})
            })
        }
        // Periodic catch-up — captures verdicts whose KPI window closed
        // without any new signal (e.g. a maintenance fire that simply
        // never recovered).
        _intervalId = setInterval(() => { tickOnce().catch(() => {}) }, TICK_MS)
        // First mount tick fires shortly after attach so the user sees
        // outcomes on the very first dashboard render.
        setTimeout(() => { tickOnce().catch(() => {}) }, 1500)
    }

    window.AesConductorOutcomeDriver = {tickOnce, attach}

    // Self-attach when CentralHubBus is ready (matches the pattern in
    // schedule-broadcaster). Falls back to a short rAF loop.
    if (typeof window.CentralHubBus !== "undefined") {
        attach()
    } else {
        let tries = 0
        const poll = () => {
            tries++
            if (typeof window.CentralHubBus !== "undefined") { attach(); return }
            if (tries < 120) requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
    }
})()
