"use strict"

/**
 * AesConductorScenarioEngine — subscribes to conductor:signal, runs each
 * active scenario's match() against the incoming signal, persists fires to
 * AesConductorScenarioStore, and dispatches conductor:scenario on the
 * CentralHubBus.
 *
 * Thin K2 slice — single-signal matches only (no time-window patterns,
 * no snapshot-predicate conditions). The bundled scenario library lives
 * in AesConductorScenarios.all(); user-defined scenarios will land in K19.
 *
 * Self-installs at load time. Idempotent.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorScenarioEngine) return

    let _counter = 0
    function _fireId(firedAt) { return String(firedAt) + "-" + (++_counter) }

    function _activeScenarios() {
        if (typeof window.AesConductorScenarios === "undefined") return []
        try { return window.AesConductorScenarios.all() || [] }
        catch (_) { return [] }
    }

    /** K11 — resolve current trust + tier-gate decision for this scenario.
     *  Defensive: missing trust-store / tier-gate / globalMax setting all
     *  collapse to "alert" + a no-op reason so the engine never blocks. */
    async function _resolveTier(scenario, host) {
        const fallback = {tier: "alert", reason: "trust stack not loaded"}
        try {
            const ts = window.AesConductorTrustStore
            const tg = window.AesConductorTierGate
            if (!ts || !tg || typeof ts.get !== "function" || typeof tg.gate !== "function") return fallback
            const entry = await ts.get(host, scenario.id)
            const settings = (window.AesConductorTrustSettings && window.AesConductorTrustSettings.read)
                ? (await window.AesConductorTrustSettings.read(host)) : {}
            const decision = tg.gate(scenario, entry, settings)
            return {tier: decision.tier, reason: decision.reason}
        } catch (_) { return fallback }
    }

    /** K14.1 — load the user/drift threshold overlay for this host and
     *  reshape the flat `<scenarioId>.<key>` blob into a per-scenario map
     *  the scenarios can read sync from `ctx.thresholds[id][key]`. Empty
     *  blob (or store missing) returns an empty object — scenarios fall
     *  back to their DEFAULT_* values. */
    async function _loadThresholdsForHost(host) {
        const out = {}
        try {
            const ts = window.AesConductorThresholdStore
            if (!ts || typeof ts.load !== "function") return out
            const blob = await ts.load(host) || {}
            for (const composite of Object.keys(blob)) {
                const e = blob[composite]
                if (!e || typeof e.value !== "number" || !isFinite(e.value)) continue
                const dot = composite.indexOf(".")
                if (dot <= 0) continue
                const sid = composite.slice(0, dot)
                const key = composite.slice(dot + 1)
                if (!out[sid]) out[sid] = {}
                out[sid][key] = e.value
            }
        } catch (_) { /* noop — fall through to defaults */ }
        return out
    }

    /** K13 — load the per-host EWMA baseline blob once per tick so
     *  scenarios can read sync from `ctx.baselines[<metric>:<scope>:<id>]`.
     *  Empty blob (or store missing) returns {} — scenarios fall back to
     *  shipped DEFAULT_* constants via _zThreshold's `def` arg. */
    async function _loadBaselinesForHost(host) {
        try {
            const bs = window.AesConductorBaselineStore
            if (!bs || typeof bs.loadCached !== "function") return {}
            return await bs.loadCached(host) || {}
        } catch (_) { return {} }
    }

    /** K15 — read the cached forecast blob, same shape as baselines but
     *  populated by AesConductorForecastStore. Scenarios use
     *  `ctx.forecasts[<metric>:<scope>:<id>]` to reach a P10/P50/P90 record. */
    async function _loadForecastsForHost(host) {
        try {
            const fs = window.AesConductorForecastStore
            if (!fs || typeof fs.loadCached !== "function") return {}
            return await fs.loadCached(host) || {}
        } catch (_) { return {} }
    }

    async function _runOne(scenario, signal) {
        const host = {server: signal.server, airline: signal.airline}
        const thresholds = await _loadThresholdsForHost(host)
        const baselines  = await _loadBaselinesForHost(host)
        const forecasts  = await _loadForecastsForHost(host)
        const ctx = {now: Date.now(), host, thresholds, baselines, forecasts}
        let result = null
        try { result = scenario.match(signal, ctx) }
        catch (e) { console.warn("[AES Conductor] scenario match threw", scenario.id, e); return }
        if (!result) return

        const firedAt = Date.now()
        const tierDecision = await _resolveTier(scenario, host)

        const fire = {
            id:              _fireId(firedAt),
            scenarioId:      scenario.id,
            label:           scenario.label || scenario.id,
            severity:        scenario.severity || "info",
            server:          signal.server,
            airline:         signal.airline,
            firedAt:         firedAt,
            rationale:       String(result.rationale || ""),
            payload:         result.payload || {},
            signalIds:       [signal.id],
            // K10 — every fire ships in the open state with no outcome yet.
            // The outcome-driver fills `outcome` when the KPI window allows
            // a verdict; the user's Open / Dismiss buttons drive
            // acceptanceState forward.
            acceptanceState: "open",
            acceptedAt:      null,
            outcome:         null,
            outcomeAt:       null,
            // K11 — tier the engine is allowed to operate at, derived from
            // current trust-store posterior + tier-gate clamps. Stamped here
            // (not later) so consumers see a stable tier for the fire's
            // lifetime; trust changes update K11 tile + new fires only.
            tier:            tierDecision.tier,
            tierReason:      tierDecision.reason
        }

        try { await window.AesConductorScenarioStore.append(host, fire) } catch (_) { /* noop */ }
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("conductor:scenario", fire)
            }
        } catch (_) { /* noop */ }
    }

    function _onSignal(signal) {
        if (!signal || !signal.type) return
        const scenarios = _activeScenarios()
        for (const s of scenarios) {
            if (!s || typeof s.match !== "function") continue
            _runOne(s, signal).catch(() => {})
        }
    }

    if (typeof window.CentralHubBus !== "undefined" && typeof window.CentralHubBus.on === "function") {
        window.CentralHubBus.on("conductor:signal", _onSignal)
    }

    window.AesConductorScenarioEngine = {
        evaluate: _onSignal,
        scenarios: _activeScenarios
    }
})()
