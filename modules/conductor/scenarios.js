"use strict"

/**
 * AesConductorScenarios — bundled scenario library for K2 + K10.
 *
 * A scenario is a plain JS object exposing:
 *   {
 *     id:        "ProfitDecay",
 *     label:     "Route profit decay",
 *     severity:  "info" | "warn" | "alert",
 *     tier:      "alert" | "suggest" | "apply-confirm" | "apply-auto",
 *     match:     (signal) => null | {rationale: string, payload?: object},
 *     // K10 (optional — null/absent disables outcome attribution):
 *     kpiWindowMs: number | null,        // window after firedAt where outcome is evaluated
 *     evaluate:    (fire, ctx) => outcome | null,
 *     openUrl:     (fire) => string | null
 *   }
 *
 * Tier defaults to "alert" per CONDUCTOR-ROADMAP Part VI — every scenario
 * starts read-only. Promotion to suggest / apply-confirm / apply-auto is
 * gated by K11 trust quotient (future slice). The engine ignores the tier
 * field today; it lives on the record so K6 surfaces (tile, briefing) can
 * show it and so K11 has a place to read the user-set override.
 *
 * `match` is the K2-thin contract — single-signal, returns null or a fire
 * spec. Window-spanning patterns (e.g. MaintenanceCascade — "2+ tails fire
 * within 7 days") need engine-side ring buffer queries; those land in a
 * K2.1 follow-up. Snapshot-predicate conditions (e.g. CashCrunchForecast)
 * need the future K15 forecaster.
 *
 * `evaluate` is the K10 contract — pure read of recent signals via
 * `ctx.byType(type)`, returns an outcome shape:
 *   {
 *     observedDelta:  number | null,
 *     expectedDelta:  number | null,
 *     favourable:     boolean | null,    // null = no decision yet
 *     terminal:       boolean,           // true = stop evaluating this fire
 *     reason:         string             // one-line user-readable verdict
 *   }
 * Returning `null` means "no change — leave the prior outcome alone." The
 * driver re-runs evaluators on every tick until `terminal:true` lands.
 *
 * Six of the ten bundled scenarios carry evaluators (maintenance/condition
 * watch, profit decay/recovery, ORS regression/recovery). The four
 * informational scenarios (competitor entry/exit, cash step, auto-drive
 * activity) leave the chip at "no signal" — they're surface-level
 * telemetry, not recoverable conditions.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorScenarios) return

    // K14.1 — defaults are preserved as named DEFAULT_* constants. Scenarios
    // read live values from `ctx.thresholds.<scenarioId>.<KEY> ?? default`
    // so user / drift overlays in AesConductorThresholdStore take effect with
    // zero behavioural change when no overlay is set. The scenario-engine
    // (match) and outcome-driver (evaluate) prefetch the overlay blob once
    // per tick and inject it via ctx — keeping match/evaluate pure-sync.
    const DEFAULT_RATIO_FLOOR        = 105        // % — AS maintenance floor
    const CONDITION_FLOOR            = 60         // % — AS condition rough floor
    const CASH_STEP_FLOOR            = 100_000    // AS$ — minimum cash move worth surfacing
    const DEFAULT_PROFIT_DECAY_PCT   = 0.25       // 25% drop vs prior snapshot
    const PROFIT_RECOVER_PCT         = 0.25       // 25% rise vs prior snapshot
    const ORS_RANK_DROP_MIN          = 2          // ranks worsened in any class

    /** Pull a threshold from the per-tick ctx overlay, falling back to the
     *  shipped default. ctx may be undefined (legacy callers) or lack
     *  `thresholds` (engine couldn't load the overlay this tick). */
    function _threshold(ctx, scenarioId, key, def) {
        if (!ctx || !ctx.thresholds) return def
        const bag = ctx.thresholds[scenarioId]
        if (!bag) return def
        const v = bag[key]
        return (typeof v === "number" && isFinite(v)) ? v : def
    }

    /** K13 — return baseline.mean + zSigma·sd when a baseline exists with at
     *  least PRIOR_N0 samples; else fall back to the hand-tuned `def`. The
     *  caller picks `zSigma` (e.g. -2 for "two-sigma below mean → fire"). The
     *  shipped default still wins when the user/drift overlay set a value via
     *  `_threshold` — call sites should resolve the user overlay first and
     *  pass that as `def` so the precedence is user > drift > learned > shipped. */
    function _zThreshold(ctx, metric, scope, scopeId, zSigma, def) {
        if (!ctx || !ctx.baselines) return def
        const composite = String(metric) + ":" + String(scope || "global") + ":" + String(scopeId || "")
        const e = ctx.baselines[composite]
        if (!e || typeof e.n !== "number" || e.n < 4) return def
        const sd = Math.sqrt(Math.max(e.var || 0, 1e-9))
        if (!isFinite(sd) || sd === 0) return def
        const out = e.mean + zSigma * sd
        return isFinite(out) ? out : def
    }

    /** K15 — read a forecast envelope from ctx; null when the cache lacks
     *  the metric. Shape: {p10, p50, p90, model, n, fit}. */
    function _forecast(ctx, metric, scope, scopeId) {
        if (!ctx || !ctx.forecasts) return null
        const composite = String(metric) + ":" + String(scope || "global") + ":" + String(scopeId || "")
        const e = ctx.forecasts[composite]
        return (e && typeof e === "object") ? e : null
    }

    // K10 evaluator constants — recovery thresholds and per-scenario KPI windows.
    const DAY_MS                  = 24 * 3600 * 1000
    const KPI_MAINT_MS            = 14 * DAY_MS
    const KPI_CONDITION_MS        = 14 * DAY_MS
    const KPI_PROFIT_DECAY_MS     = 21 * DAY_MS
    const KPI_PROFIT_RECOVERY_MS  = 28 * DAY_MS
    const KPI_ORS_REGRESSION_MS   = 28 * DAY_MS
    const KPI_ORS_RECOVERY_MS     = 28 * DAY_MS
    const MAINT_RECOVER_BUFFER    = 5             // % above floor to count as recovered
    const CONDITION_RECOVER_BUFFER = 5            // % above floor
    const PROFIT_RECOVER_RATIO    = 0.85          // recovered if `to` ≥ 85% of pre-decay baseline
    const RECOVERY_HOLD_PCT       = 0.25          // a recovery is "lost" if next drop ≥ 25%

    function _num(v) { return (typeof v === "number" && isFinite(v)) ? v : null }

    /** Filter a list of signals to those strictly after `fromTs`. */
    function _afterTs(signals, fromTs) {
        if (!Array.isArray(signals) || !fromTs) return []
        const out = []
        for (const s of signals) {
            if (!s || typeof s.firedAt !== "number") continue
            if (s.firedAt > fromTs) out.push(s)
        }
        return out
    }

    /** Filter signals whose payload field equals the fire's same-named field. */
    function _byField(signals, field, value) {
        if (value == null) return []
        const out = []
        for (const s of signals) {
            const p = s && s.payload
            if (p && p[field] === value) out.push(s)
        }
        return out
    }

    /** Filter signals matching {hub, dest} pair on payload. */
    function _byRoute(signals, hub, dest) {
        if (!hub || !dest) return []
        const out = []
        for (const s of signals) {
            const p = s && s.payload
            if (p && p.hub === hub && p.dest === dest) out.push(s)
        }
        return out
    }

    /** Convenience — has the fire's KPI window closed at the eval time? */
    function _windowClosed(fire, kpiMs, now) {
        if (!fire || !fire.firedAt || !kpiMs) return false
        return (now - fire.firedAt) >= kpiMs
    }

    /** Build a v1 outcome record. `terminal:true` stops re-evaluation. */
    function _outcome(observedDelta, expectedDelta, favourable, terminal, reason) {
        return {
            observedDelta: observedDelta == null ? null : observedDelta,
            expectedDelta: expectedDelta == null ? null : expectedDelta,
            favourable:    favourable == null ? null : !!favourable,
            terminal:      !!terminal,
            reason:        String(reason || "")
        }
    }

    const MaintenanceWatch = {
        id:       "MaintenanceWatch",
        label:    "Maintenance watch",
        severity: "warn",
        tier:     "alert",
        defaultTierCap: "apply-confirm",
        match: (signal, ctx) => {
            if (!signal || signal.type !== "maintenance.ratio.changed") return null
            const p = signal.payload || {}
            const to = _num(p.to)
            const from = _num(p.from)
            const floor = _threshold(ctx, "MaintenanceWatch", "RATIO_FLOOR", DEFAULT_RATIO_FLOOR)
            if (to == null || to >= floor) return null
            const dropped = (from != null && to < from)

            // K13 — anomaly check vs learned maintenance.ratio baseline per tail.
            if (p.aircraftId && ctx && ctx.baselines) {
                const e = ctx.baselines["maintenance.ratio:tail:" + p.aircraftId]
                if (e && typeof e.n === "number" && e.n >= 4 && isFinite(to)) {
                    const sd = Math.sqrt(Math.max(e.var || 0, 1e-9))
                    const z = sd > 0 ? (to - e.mean) / sd : 0
                    if (z > -1.5) return null // Requires z <= -1.5σ (a significant drop relative to this tail's normal variance)
                }
            }

            return {
                rationale: (p.aircraftId || "?") + " maintenance ratio at "
                    + to.toFixed(1) + "%"
                    + (dropped && from != null ? " (was " + from.toFixed(1) + "%)" : "")
                    + " — below " + floor + "% floor",
                payload: {aircraftId: p.aircraftId, ratio: to, prior: from, floor: floor}
            }
        },
        kpiWindowMs: KPI_MAINT_MS,
        evaluate: (fire, ctx) => {
            const p = (fire && fire.payload) || {}
            if (!p.aircraftId) return _outcome(null, null, null, true, "No aircraft id on fire")
            // Prefer the floor stamped onto the fire (captures the value in
            // effect at fire time); fall back to ctx overlay then default.
            const floor = (typeof p.floor === "number" && isFinite(p.floor))
                ? p.floor
                : _threshold(ctx, "MaintenanceWatch", "RATIO_FLOOR", DEFAULT_RATIO_FLOOR)
            const recoverAt = floor + MAINT_RECOVER_BUFFER
            const after = _byField(_afterTs(ctx.byType("maintenance.ratio.changed"), fire.firedAt),
                                   "aircraftId", p.aircraftId)
            const expected = floor - (p.ratio || 0)
            if (!after.length) {
                return _windowClosed(fire, KPI_MAINT_MS, ctx.now)
                    ? _outcome(null, expected, false, true, "No ratio updates in 14d — assumed unrecovered")
                    : _outcome(null, expected, null, false, "Awaiting ratio updates")
            }
            const latest = after[0]                            // byType returns newest-first
            const latestTo = _num(latest && latest.payload && latest.payload.to)
            const observed = (latestTo != null) ? (latestTo - (p.ratio || 0)) : null
            for (const s of after) {
                const t = _num(s.payload && s.payload.to)
                if (t != null && t >= recoverAt) {
                    return _outcome(observed, expected, true, true,
                        "Ratio recovered to " + t.toFixed(1) + "% (≥ " + recoverAt + "%)")
                }
            }
            if (_windowClosed(fire, KPI_MAINT_MS, ctx.now)) {
                return _outcome(observed, expected, false, true,
                    "14d closed; latest ratio " + (latestTo != null ? latestTo.toFixed(1) + "%" : "?")
                        + " < " + recoverAt + "%")
            }
            return _outcome(observed, expected, null, false,
                "Latest " + (latestTo != null ? latestTo.toFixed(1) + "%" : "?") + " — within window")
        },
        openUrl: (fire) => {
            const id = fire && fire.payload && fire.payload.aircraftId
            return id ? "/app/fleets/aircraft/" + encodeURIComponent(id) + "/0" : null
        }
    }

    const ConditionWatch = {
        id:       "ConditionWatch",
        label:    "Aircraft condition watch",
        severity: "warn",
        tier:     "alert",
        defaultTierCap: "apply-confirm",
        match: (signal, ctx) => {
            if (!signal || signal.type !== "maintenance.condition.changed") return null
            const p = signal.payload || {}
            const to = _num(p.to)
            const from = _num(p.from)
            const floor = _threshold(ctx, "ConditionWatch", "CONDITION_FLOOR", CONDITION_FLOOR)
            if (to == null || to >= floor) return null

            // K13 — anomaly check vs learned maintenance.condition baseline per tail.
            if (p.aircraftId && ctx && ctx.baselines) {
                const e = ctx.baselines["maintenance.condition:tail:" + p.aircraftId]
                if (e && typeof e.n === "number" && e.n >= 4 && isFinite(to)) {
                    const sd = Math.sqrt(Math.max(e.var || 0, 1e-9))
                    const z = sd > 0 ? (to - e.mean) / sd : 0
                    if (z > -1.5) return null
                }
            }

            return {
                rationale: (p.aircraftId || "?") + " condition at " + to.toFixed(1) + "%"
                    + (from != null ? " (was " + from.toFixed(1) + "%)" : "")
                    + " — below " + floor + "% floor",
                payload: {aircraftId: p.aircraftId, condition: to, prior: from, floor: floor}
            }
        },
        kpiWindowMs: KPI_CONDITION_MS,
        evaluate: (fire, ctx) => {
            const p = (fire && fire.payload) || {}
            if (!p.aircraftId) return _outcome(null, null, null, true, "No aircraft id on fire")
            const conditionFloor = (typeof p.floor === "number" && isFinite(p.floor))
                ? p.floor
                : _threshold(ctx, "ConditionWatch", "CONDITION_FLOOR", CONDITION_FLOOR)
            const recoverAt = conditionFloor + CONDITION_RECOVER_BUFFER
            const after = _byField(_afterTs(ctx.byType("maintenance.condition.changed"), fire.firedAt),
                                   "aircraftId", p.aircraftId)
            const expected = conditionFloor - (p.condition || 0)
            if (!after.length) {
                return _windowClosed(fire, KPI_CONDITION_MS, ctx.now)
                    ? _outcome(null, expected, false, true, "No condition updates in 14d — assumed unrecovered")
                    : _outcome(null, expected, null, false, "Awaiting condition updates")
            }
            const latest = after[0]
            const latestTo = _num(latest && latest.payload && latest.payload.to)
            const observed = (latestTo != null) ? (latestTo - (p.condition || 0)) : null
            for (const s of after) {
                const t = _num(s.payload && s.payload.to)
                if (t != null && t >= recoverAt) {
                    return _outcome(observed, expected, true, true,
                        "Condition recovered to " + t.toFixed(1) + "% (≥ " + recoverAt + "%)")
                }
            }
            if (_windowClosed(fire, KPI_CONDITION_MS, ctx.now)) {
                return _outcome(observed, expected, false, true,
                    "14d closed; latest condition " + (latestTo != null ? latestTo.toFixed(1) + "%" : "?")
                        + " < " + recoverAt + "%")
            }
            return _outcome(observed, expected, null, false,
                "Latest " + (latestTo != null ? latestTo.toFixed(1) + "%" : "?") + " — within window")
        },
        openUrl: (fire) => {
            const id = fire && fire.payload && fire.payload.aircraftId
            return id ? "/app/fleets/aircraft/" + encodeURIComponent(id) + "/0" : null
        }
    }

    const CompetitorEntry = {
        id:       "CompetitorEntry",
        label:    "Competitor entered market",
        severity: "info",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "competitor.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "entry") return null
            const delta = _num(p.delta)
            if (delta == null || delta <= 0) return null
            return {
                rationale: (p.routeKey || "?") + " — " + delta + " competitor"
                    + (delta === 1 ? "" : "s") + " entered (" + p.before + " → " + p.after + ")",
                payload: {routeKey: p.routeKey, delta, before: p.before, after: p.after}
            }
        }
    }

    const CompetitorExit = {
        id:       "CompetitorExit",
        label:    "Competitor exited market",
        severity: "info",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "competitor.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "exit") return null
            const delta = _num(p.delta)
            if (delta == null || delta >= 0) return null
            const n = Math.abs(delta)
            return {
                rationale: (p.routeKey || "?") + " — " + n + " competitor"
                    + (n === 1 ? "" : "s") + " exited (" + p.before + " → " + p.after + ")",
                payload: {routeKey: p.routeKey, delta, before: p.before, after: p.after}
            }
        }
    }

    const CashStep = {
        id:       "CashStep",
        label:    "Cash step",
        severity: "info",
        tier:     "alert",
        match: (signal, ctx) => {
            if (!signal || signal.type !== "cash.balance.changed") return null
            const p = signal.payload || {}
            const delta = _num(p.delta)
            const floor = _threshold(ctx, "CashStep", "CASH_STEP_FLOOR", CASH_STEP_FLOOR)
            if (delta == null || Math.abs(delta) < floor) return null

            // K13 — anomaly check vs learned cash.balance baseline.
            // If we have a baseline, we can suppress normal variance.
            if (ctx && ctx.baselines) {
                const e = ctx.baselines["cash.balance:global:"]
                if (e && typeof e.n === "number" && e.n >= 4 && isFinite(p.to)) {
                    const sd = Math.sqrt(Math.max(e.var || 0, 1e-9))
                    const z = sd > 0 ? (p.to - e.mean) / sd : 0
                    // Fire only if the drop or jump is > 1.5σ away from the rolling mean
                    if (Math.abs(z) < 1.5) return null
                }
            }

            const sign = delta > 0 ? "+" : ""
            return {
                rationale: "Cash balance moved " + sign + Math.round(delta).toLocaleString()
                    + " (now " + (p.to != null ? Math.round(p.to).toLocaleString() : "?") + ")",
                payload: {delta, from: p.from, to: p.to, direction: p.direction}
            }
        }
    }

    // K15 — CashCrunchForecast: fires when the linear forecast of cash
    // balance crosses below `cashFloor` within the horizon. Pulls the
    // P50/P10 envelope from `ctx.forecasts` (populated by ForecastStore).
    // Defaults: cashFloor = 1M AS$, horizon = 4 weeks. Re-fires at most
    // once per 24h via a payload-time check on prior fires (engine layer
    // dedup is left for K2.1; we keep the rationale stable so the user-
    // visible row collapses across re-fires until horizon shifts).
    const DEFAULT_CASH_FLOOR_FORECAST = 1_000_000
    const CashCrunchForecast = {
        id:       "CashCrunchForecast",
        label:    "Cash runway forecast",
        severity: "alert",
        tier:     "alert",
        forecast: [{metric: "cash.balance", scope: "global", scopeId: "", horizonDays: 28, model: "linear"}],
        match: (signal, ctx) => {
            if (!signal || signal.type !== "cash.balance.changed") return null
            const f = _forecast(ctx, "cash.balance", "global", "")
            if (!f) return null
            const floor = _threshold(ctx, "CashCrunchForecast", "CASH_FLOOR", DEFAULT_CASH_FLOOR_FORECAST)
            const p50 = _num(f.p50)
            const p10 = _num(f.p10)
            if (p50 == null) return null
            if (p50 >= floor && (p10 == null || p10 >= floor)) return null
            const days = (typeof f.horizon === "number" ? f.horizon : 28)
            const triggered = p50 < floor ? "P50" : "P10"
            return {
                rationale: "Cash forecast " + triggered + " in " + days + "d ≈ "
                    + Math.round((triggered === "P50" ? p50 : p10) / 1000).toLocaleString() + "k"
                    + " — below " + Math.round(floor / 1000).toLocaleString() + "k floor",
                payload: {
                    floor: floor,
                    horizonDays: days,
                    p10: p10, p50: p50, p90: _num(f.p90),
                    model: f.model || "linear",
                    triggered: triggered
                }
            }
        }
    }

    const ProfitDecay = {
        id:       "ProfitDecay",
        label:    "Route profit decay",
        severity: "warn",
        tier:     "alert",
        defaultTierCap: "apply-confirm",
        forecast: [{metric: "route.profit", scope: "route", scopeId: "*", horizonDays: 28, model: "linear"}],
        match: (signal, ctx) => {
            if (!signal || signal.type !== "route.profit.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "drop") return null
            const pct = _num(p.pct)
            const decayPct = _threshold(ctx, "ProfitDecay", "PROFIT_DECAY_PCT", DEFAULT_PROFIT_DECAY_PCT)
            if (pct == null || pct > -decayPct) return null   // pct is signed (negative = drop)
            // K13 — anomaly check vs learned route.profit baseline. Once a
            // baseline has ≥4 samples, require z ≤ -1.5σ before firing — this
            // suppresses noise dips on routes with inherently volatile profit.
            // Routes with no baseline yet still fire on the pct trigger alone.
            const rk = (p.hub && p.dest) ? (String(p.hub).toUpperCase() + "-" + String(p.dest).toUpperCase()) : null
            if (rk && ctx && ctx.baselines) {
                const e = ctx.baselines["route.profit:route:" + rk]
                if (e && typeof e.n === "number" && e.n >= 4 && typeof p.to === "number" && isFinite(p.to)) {
                    const sd = Math.sqrt(Math.max(e.var || 0, 1e-9))
                    const z = sd > 0 ? (p.to - e.mean) / sd : 0
                    if (z > -1.5) return null
                }
            }
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " profit "
                    + Math.round(pct * 100) + "% (now ≈" + Math.round((p.to || 0) / 1000) + "k/wk, "
                    + "was ≈" + Math.round((p.from || 0) / 1000) + "k/wk)",
                payload: {hub: p.hub, dest: p.dest, from: p.from, to: p.to, pct, delta: p.delta}
            }
        },
        kpiWindowMs: KPI_PROFIT_DECAY_MS,
        evaluate: (fire, ctx) => {
            const p = (fire && fire.payload) || {}
            if (!p.hub || !p.dest) return _outcome(null, null, null, true, "No route on fire")
            const baseline = _num(p.from)
            const dipTo    = _num(p.to)
            if (baseline == null) return _outcome(null, null, null, true, "No baseline on fire")
            const recoverFloor = baseline * _threshold(ctx, "ProfitDecay", "PROFIT_RECOVER_RATIO", PROFIT_RECOVER_RATIO)
            const after = _byRoute(_afterTs(ctx.byType("route.profit.changed"), fire.firedAt),
                                   p.hub, p.dest)
            const expected = baseline - (dipTo || 0)
            if (!after.length) {
                return _windowClosed(fire, KPI_PROFIT_DECAY_MS, ctx.now)
                    ? _outcome(null, expected, false, true, "No profit updates in 21d")
                    : _outcome(null, expected, null, false, "Awaiting profit updates")
            }
            const latest = after[0]
            const latestTo = _num(latest && latest.payload && latest.payload.to)
            const observed = (latestTo != null) ? (latestTo - (dipTo || 0)) : null
            for (const s of after) {
                const t = _num(s.payload && s.payload.to)
                if (t != null && t >= recoverFloor) {
                    return _outcome(observed, expected, true, true,
                        "Profit recovered to ≈" + Math.round(t / 1000) + "k/wk (≥ "
                            + Math.round(recoverFloor / 1000) + "k)")
                }
            }
            if (_windowClosed(fire, KPI_PROFIT_DECAY_MS, ctx.now)) {
                return _outcome(observed, expected, false, true,
                    "21d closed; latest ≈" + (latestTo != null ? Math.round(latestTo / 1000) + "k" : "?")
                        + " < " + Math.round(recoverFloor / 1000) + "k recovery floor")
            }
            return _outcome(observed, expected, null, false, "Within 21d window")
        },
        openUrl: (fire) => {
            const p = fire && fire.payload
            if (!p || !p.hub) return null
            return "/app/com/scheduling?origin=" + encodeURIComponent(p.hub)
        }
    }

    const ProfitRecovery = {
        id:       "ProfitRecovery",
        label:    "Route profit recovery",
        severity: "info",
        tier:     "alert",
        defaultTierCap: "suggest",
        match: (signal, ctx) => {
            if (!signal || signal.type !== "route.profit.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "recovery") return null
            const pct = _num(p.pct)
            if (pct == null || pct < _threshold(ctx, "ProfitRecovery", "PROFIT_RECOVER_PCT", PROFIT_RECOVER_PCT)) return null
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " profit +"
                    + Math.round(pct * 100) + "% (now ≈" + Math.round((p.to || 0) / 1000) + "k/wk)",
                payload: {hub: p.hub, dest: p.dest, from: p.from, to: p.to, pct, delta: p.delta}
            }
        },
        kpiWindowMs: KPI_PROFIT_RECOVERY_MS,
        evaluate: (fire, ctx) => {
            const p = (fire && fire.payload) || {}
            if (!p.hub || !p.dest) return _outcome(null, null, null, true, "No route on fire")
            const recoverTo = _num(p.to)
            if (recoverTo == null) return _outcome(null, null, null, true, "No recovery level on fire")
            const after = _byRoute(_afterTs(ctx.byType("route.profit.changed"), fire.firedAt),
                                   p.hub, p.dest)
            if (!after.length) {
                return _windowClosed(fire, KPI_PROFIT_RECOVERY_MS, ctx.now)
                    ? _outcome(null, null, true, true, "No drop within 28d — recovery held")
                    : _outcome(null, null, null, false, "Awaiting profit updates")
            }
            for (const s of after) {
                const sp = s && s.payload
                if (sp && sp.direction === "drop") {
                    const dropPct = _num(sp.pct)
                    if (dropPct != null && dropPct <= -_threshold(ctx, "ProfitRecovery", "RECOVERY_HOLD_PCT", RECOVERY_HOLD_PCT)) {
                        const observed = _num(sp.to) != null ? (_num(sp.to) - recoverTo) : null
                        return _outcome(observed, 0, false, true,
                            "Recovery lost: profit dropped " + Math.round(dropPct * 100) + "%")
                    }
                }
            }
            if (_windowClosed(fire, KPI_PROFIT_RECOVERY_MS, ctx.now)) {
                return _outcome(0, 0, true, true, "Recovery held for 28d")
            }
            return _outcome(null, null, null, false, "Within 28d window")
        },
        openUrl: (fire) => {
            const p = fire && fire.payload
            if (!p || !p.hub) return null
            return "/app/com/scheduling?origin=" + encodeURIComponent(p.hub)
        }
    }

    /** Inspect an ors.rank.changed payload — return the maximum
     *  improvement (positive minutes-of-rank improved, ≥1 means a class got
     *  better by N ranks) or null when nothing improved. */
    function _bestOrsImprovement(p) {
        if (!p || !Array.isArray(p.classes)) return null
        let best = null
        for (const cls of p.classes) {
            if (!cls || cls.direction !== "improved" || cls.rankDelta == null) continue
            const improved = -cls.rankDelta                    // rankDelta is negative when improved
            if (improved > 0 && (best == null || improved > best)) best = improved
        }
        return best
    }

    const OrsRegression = {
        id:       "OrsRegression",
        label:    "ORS rank regression",
        severity: "warn",
        tier:     "alert",
        defaultTierCap: "apply-confirm",
        match: (signal, ctx) => {
            if (!signal || signal.type !== "ors.rank.changed") return null
            const p = signal.payload || {}
            const worst = _num(p.worstRegression)
            if (worst == null || worst < _threshold(ctx, "OrsRegression", "ORS_RANK_DROP_MIN", ORS_RANK_DROP_MIN)) return null

            // K13 — anomaly check vs learned ors.rank.avg baseline per route.
            const rk = (p.hub && p.dest) ? (String(p.hub).toUpperCase() + "-" + String(p.dest).toUpperCase()) : null
            if (rk && ctx && ctx.baselines) {
                // Rank increases numerically when worsened (e.g., rank 1 -> rank 4).
                const e = ctx.baselines["ors.rank.avg:route:" + rk]
                // We check against the avg rank in the payload. Note that signal may not have avg directly here,
                // but we can compute it or just use `worst` as a heuristic if avg isn't available.
                // Alternatively, we rely on the baseline-driver's storage of ors.rank.avg.
                let avgTo = null
                if (Array.isArray(p.classes)) {
                    let sum = 0, cnt = 0
                    for (const c of p.classes) { if (_num(c.rankTo) != null) { sum += c.rankTo; cnt++ } }
                    if (cnt > 0) avgTo = sum / cnt
                }

                if (avgTo != null && e && typeof e.n === "number" && e.n >= 4) {
                    const sd = Math.sqrt(Math.max(e.var || 0, 1e-9))
                    const z = sd > 0 ? (avgTo - e.mean) / sd : 0
                    // Since lower rank number is better, an increase in numerical rank is bad.
                    // We only fire if the rank is significantly worse than the baseline (z > 1.5).
                    if (z < 1.5) return null
                }
            }

            const cls = (Array.isArray(p.classes) ? p.classes : [])
                .find(c => c && c.direction === "worsened" && c.rankDelta === worst)
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " ORS rank dropped "
                    + worst + (cls && cls.payload ? " (" + cls.payload + ")" : "")
                    + (cls ? " — rank " + cls.rankFrom + " → " + cls.rankTo : ""),
                payload: {hub: p.hub, dest: p.dest, worstRegression: worst, classes: p.classes}
            }
        },
        kpiWindowMs: KPI_ORS_REGRESSION_MS,
        evaluate: (fire, ctx) => {
            const p = (fire && fire.payload) || {}
            if (!p.hub || !p.dest) return _outcome(null, null, null, true, "No route on fire")
            const expected = _num(p.worstRegression)
            const after = _byRoute(_afterTs(ctx.byType("ors.rank.changed"), fire.firedAt),
                                   p.hub, p.dest)
            if (!after.length) {
                return _windowClosed(fire, KPI_ORS_REGRESSION_MS, ctx.now)
                    ? _outcome(null, expected, false, true, "No ORS updates in 28d")
                    : _outcome(null, expected, null, false, "Awaiting ORS updates")
            }
            // Recovery: any later signal where best class regained ≥ worstRegression - 1 ranks
            for (const s of after) {
                const improved = _bestOrsImprovement(s && s.payload)
                if (improved != null && expected != null && improved >= (expected - 1)) {
                    return _outcome(improved, expected, true, true,
                        "ORS rank recovered " + improved + " of " + expected + " lost ranks")
                }
            }
            if (_windowClosed(fire, KPI_ORS_REGRESSION_MS, ctx.now)) {
                return _outcome(0, expected, false, true, "28d closed; no rank recovery observed")
            }
            return _outcome(null, expected, null, false, "Within 28d window")
        },
        openUrl: (fire) => {
            const p = fire && fire.payload
            if (!p || !p.hub) return null
            return "/app/com/scheduling?origin=" + encodeURIComponent(p.hub)
        }
    }

    const OrsRecovery = {
        id:       "OrsRecovery",
        label:    "ORS rank recovery",
        severity: "info",
        tier:     "alert",
        defaultTierCap: "suggest",
        match: (signal, ctx) => {
            if (!signal || signal.type !== "ors.rank.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "improved") return null
            const cls = (Array.isArray(p.classes) ? p.classes : [])
                .find(c => c && c.direction === "improved" && c.rankDelta != null)
            if (!cls || cls.rankDelta == null || cls.rankDelta > -_threshold(ctx, "OrsRecovery", "ORS_RANK_DROP_MIN", ORS_RANK_DROP_MIN)) return null
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " ORS rank improved "
                    + Math.abs(cls.rankDelta) + " (" + cls.payload + " " + cls.rankFrom
                    + " → " + cls.rankTo + ")",
                payload: {hub: p.hub, dest: p.dest, classes: p.classes}
            }
        },
        kpiWindowMs: KPI_ORS_RECOVERY_MS,
        evaluate: (fire, ctx) => {
            const p = (fire && fire.payload) || {}
            if (!p.hub || !p.dest) return _outcome(null, null, null, true, "No route on fire")
            const after = _byRoute(_afterTs(ctx.byType("ors.rank.changed"), fire.firedAt),
                                   p.hub, p.dest)
            if (!after.length) {
                return _windowClosed(fire, KPI_ORS_RECOVERY_MS, ctx.now)
                    ? _outcome(null, null, true, true, "No regressions within 28d — recovery held")
                    : _outcome(null, null, null, false, "Awaiting ORS updates")
            }
            for (const s of after) {
                const sp = s && s.payload
                const worst = _num(sp && sp.worstRegression)
                if (worst != null && worst >= _threshold(ctx, "OrsRecovery", "ORS_RANK_DROP_MIN", ORS_RANK_DROP_MIN)) {
                    return _outcome(-worst, 0, false, true,
                        "Recovery lost: ORS rank dropped " + worst + " ranks again")
                }
            }
            if (_windowClosed(fire, KPI_ORS_RECOVERY_MS, ctx.now)) {
                return _outcome(0, 0, true, true, "Recovery held for 28d")
            }
            return _outcome(null, null, null, false, "Within 28d window")
        },
        openUrl: (fire) => {
            const p = fire && fire.payload
            if (!p || !p.hub) return null
            return "/app/com/scheduling?origin=" + encodeURIComponent(p.hub)
        }
    }

    const AutoDriveActivity = {
        id:       "AutoDriveActivity",
        label:    "Auto-drive activity",
        severity: "info",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "auto-drive.ticked") return null
            const p = signal.payload || {}
            if (!p.ranPhase) return null
            return {
                rationale: "Auto-drive ran phase '" + p.ranPhase + "' (" + (p.reason || "?") + ")",
                payload: {ranPhase: p.ranPhase, reason: p.reason}
            }
        }
    }

    const ALL = [
        MaintenanceWatch, ConditionWatch,
        CompetitorEntry, CompetitorExit,
        CashStep, CashCrunchForecast,
        ProfitDecay, ProfitRecovery,
        OrsRegression, OrsRecovery,
        AutoDriveActivity
    ]

    window.AesConductorScenarios = {
        all: () => ALL.slice(),
        MaintenanceWatch, ConditionWatch,
        CompetitorEntry, CompetitorExit,
        CashStep, CashCrunchForecast,
        ProfitDecay, ProfitRecovery,
        OrsRegression, OrsRecovery,
        AutoDriveActivity
    }
})()
