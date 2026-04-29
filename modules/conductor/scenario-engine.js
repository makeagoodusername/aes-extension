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

    async function _runOne(scenario, signal) {
        let result = null
        try { result = scenario.match(signal) }
        catch (e) { console.warn("[AES Conductor] scenario match threw", scenario.id, e); return }
        if (!result) return

        const firedAt = Date.now()
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
            outcomeAt:       null
        }

        const host = {server: signal.server, airline: signal.airline}
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
