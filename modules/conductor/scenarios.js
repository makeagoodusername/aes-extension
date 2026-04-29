"use strict"

/**
 * AesConductorScenarios — bundled scenario library for K2.
 *
 * A scenario is a plain JS object exposing:
 *   {
 *     id:        "ProfitDecay",
 *     label:     "Route profit decay",
 *     severity:  "info" | "warn" | "alert",
 *     tier:      "alert" | "suggest" | "apply-confirm" | "apply-auto",
 *     match:     (signal) => null | {rationale: string, payload?: object}
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
 * Ten bundled scenarios (sources covered: maintenance ratio + condition,
 * competitor entry/exit, cash step, route profit drop/recovery, ORS rank
 * regression/recovery, auto-drive activity).
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorScenarios) return

    const RATIO_FLOOR        = 105                // % — AS maintenance floor
    const CONDITION_FLOOR    = 60                 // % — AS condition rough floor
    const CASH_STEP_FLOOR    = 100_000            // AS$ — minimum cash move worth surfacing
    const PROFIT_DECAY_PCT   = 0.25               // 25% drop vs prior snapshot
    const PROFIT_RECOVER_PCT = 0.25               // 25% rise vs prior snapshot
    const ORS_RANK_DROP_MIN  = 2                  // ranks worsened in any class

    function _num(v) { return (typeof v === "number" && isFinite(v)) ? v : null }

    const MaintenanceWatch = {
        id:       "MaintenanceWatch",
        label:    "Maintenance watch",
        severity: "warn",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "maintenance.ratio.changed") return null
            const p = signal.payload || {}
            const to = _num(p.to)
            const from = _num(p.from)
            if (to == null || to >= RATIO_FLOOR) return null
            const dropped = (from != null && to < from)
            return {
                rationale: (p.aircraftId || "?") + " maintenance ratio at "
                    + to.toFixed(1) + "%"
                    + (dropped && from != null ? " (was " + from.toFixed(1) + "%)" : "")
                    + " — below " + RATIO_FLOOR + "% floor",
                payload: {aircraftId: p.aircraftId, ratio: to, prior: from, floor: RATIO_FLOOR}
            }
        }
    }

    const ConditionWatch = {
        id:       "ConditionWatch",
        label:    "Aircraft condition watch",
        severity: "warn",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "maintenance.condition.changed") return null
            const p = signal.payload || {}
            const to = _num(p.to)
            const from = _num(p.from)
            if (to == null || to >= CONDITION_FLOOR) return null
            return {
                rationale: (p.aircraftId || "?") + " condition at " + to.toFixed(1) + "%"
                    + (from != null ? " (was " + from.toFixed(1) + "%)" : "")
                    + " — below " + CONDITION_FLOOR + "% floor",
                payload: {aircraftId: p.aircraftId, condition: to, prior: from, floor: CONDITION_FLOOR}
            }
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
        match: (signal) => {
            if (!signal || signal.type !== "cash.balance.changed") return null
            const p = signal.payload || {}
            const delta = _num(p.delta)
            if (delta == null || Math.abs(delta) < CASH_STEP_FLOOR) return null
            const sign = delta > 0 ? "+" : ""
            return {
                rationale: "Cash balance moved " + sign + Math.round(delta).toLocaleString()
                    + " (now " + (p.to != null ? Math.round(p.to).toLocaleString() : "?") + ")",
                payload: {delta, from: p.from, to: p.to, direction: p.direction}
            }
        }
    }

    const ProfitDecay = {
        id:       "ProfitDecay",
        label:    "Route profit decay",
        severity: "warn",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "route.profit.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "drop") return null
            const pct = _num(p.pct)
            if (pct == null || pct > -PROFIT_DECAY_PCT) return null   // pct is signed (negative = drop)
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " profit "
                    + Math.round(pct * 100) + "% (now ≈" + Math.round((p.to || 0) / 1000) + "k/wk, "
                    + "was ≈" + Math.round((p.from || 0) / 1000) + "k/wk)",
                payload: {hub: p.hub, dest: p.dest, from: p.from, to: p.to, pct, delta: p.delta}
            }
        }
    }

    const ProfitRecovery = {
        id:       "ProfitRecovery",
        label:    "Route profit recovery",
        severity: "info",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "route.profit.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "recovery") return null
            const pct = _num(p.pct)
            if (pct == null || pct < PROFIT_RECOVER_PCT) return null
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " profit +"
                    + Math.round(pct * 100) + "% (now ≈" + Math.round((p.to || 0) / 1000) + "k/wk)",
                payload: {hub: p.hub, dest: p.dest, from: p.from, to: p.to, pct, delta: p.delta}
            }
        }
    }

    const OrsRegression = {
        id:       "OrsRegression",
        label:    "ORS rank regression",
        severity: "warn",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "ors.rank.changed") return null
            const p = signal.payload || {}
            const worst = _num(p.worstRegression)
            if (worst == null || worst < ORS_RANK_DROP_MIN) return null
            const cls = (Array.isArray(p.classes) ? p.classes : [])
                .find(c => c && c.direction === "worsened" && c.rankDelta === worst)
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " ORS rank dropped "
                    + worst + (cls && cls.payload ? " (" + cls.payload + ")" : "")
                    + (cls ? " — rank " + cls.rankFrom + " → " + cls.rankTo : ""),
                payload: {hub: p.hub, dest: p.dest, worstRegression: worst, classes: p.classes}
            }
        }
    }

    const OrsRecovery = {
        id:       "OrsRecovery",
        label:    "ORS rank recovery",
        severity: "info",
        tier:     "alert",
        match: (signal) => {
            if (!signal || signal.type !== "ors.rank.changed") return null
            const p = signal.payload || {}
            if (p.direction !== "improved") return null
            const cls = (Array.isArray(p.classes) ? p.classes : [])
                .find(c => c && c.direction === "improved" && c.rankDelta != null)
            if (!cls || cls.rankDelta == null || cls.rankDelta > -ORS_RANK_DROP_MIN) return null
            return {
                rationale: (p.hub || "?") + "→" + (p.dest || "?") + " ORS rank improved "
                    + Math.abs(cls.rankDelta) + " (" + cls.payload + " " + cls.rankFrom
                    + " → " + cls.rankTo + ")",
                payload: {hub: p.hub, dest: p.dest, classes: p.classes}
            }
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
        CashStep,
        ProfitDecay, ProfitRecovery,
        OrsRegression, OrsRecovery,
        AutoDriveActivity
    ]

    window.AesConductorScenarios = {
        all: () => ALL.slice(),
        MaintenanceWatch, ConditionWatch,
        CompetitorEntry, CompetitorExit,
        CashStep,
        ProfitDecay, ProfitRecovery,
        OrsRegression, OrsRecovery,
        AutoDriveActivity
    }
})()
