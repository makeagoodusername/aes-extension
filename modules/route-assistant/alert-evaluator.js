"use strict"

/**
 * Pure-function alert evaluator (Daily-driver QoL — Active Prompts).
 *
 * Given a list of alert rules + the panel's already-decorated scoredRows
 * (which carry `_diff.<field>` scalars from the diff-against-last-visit
 * system + base `row.<field>` properties from the aggregator), return
 * the list of triggered alerts.
 *
 * No DOM access. No I/O. The panel calls `evaluate(rules, rows, ctx)`
 * after `_decorateRowsWithDiffs` and before drawing the table; for each
 * triggered alert it fires a toast + records the fire timestamp via the
 * rules store.
 *
 * Operator semantics:
 *   - "increased_by"  → row._diff[field] != null && row._diff[field] >  threshold
 *   - "decreased_by"  → row._diff[field] != null && row._diff[field] < -threshold
 *   - "above"         → row[field]        != null && row[field]       >  threshold
 *   - "below"         → row[field]        != null && row[field]       <  threshold
 *
 * Scope:
 *   - "watchlist"  → only rows with `row._starred === true`
 *   - "all"        → every visible row
 *
 * Cooldown: per-rule, per-route. If `rule.lastFiredByRoute[<HUB>-<DEST>]`
 * is within `rule.cooldownHours` of now, the alert is silently
 * skipped — keeps repeat noise down on subsequent renders within a
 * cooldown window.
 */
class RouteAssistantAlertEvaluator {

    /**
     * @param {Array} rules — list of normalised RuleRecords
     * @param {Array} rows  — `panel.scoredRows` post-diff-decoration
     * @param {object} ctx  — {hubIata, now}
     * @returns {Array<TriggeredAlert>}
     *   TriggeredAlert = {ruleId, label, severity, hub, dest, routeKey,
     *                     field, operator, threshold, observedDelta?,
     *                     observedValue?, message}
     */
    static evaluate(rules, rows, ctx) {
        if (!Array.isArray(rules) || !rules.length) return []
        if (!Array.isArray(rows)  || !rows.length)  return []
        const hub = ctx && ctx.hubIata ? String(ctx.hubIata).toUpperCase() : ""
        const now = (ctx && ctx.now) || Date.now()
        const out = []

        for (const rule of rules) {
            if (!rule || rule.enabled === false) continue
            const cooldownMs = (Number(rule.cooldownHours) || 0) * 3600 * 1000
            const lastByRoute = rule.lastFiredByRoute || {}

            for (const row of rows) {
                if (!row || !row.destIata) continue
                if (rule.scope === "watchlist" && !row._starred) continue
                const routeKey = hub + "-" + String(row.destIata).toUpperCase()
                const lastFired = lastByRoute[routeKey]
                if (cooldownMs > 0 && lastFired && (now - Number(lastFired)) < cooldownMs) continue

                const triggered = RouteAssistantAlertEvaluator._evalOnRow(rule, row)
                if (!triggered) continue
                out.push(Object.assign({
                    ruleId:    rule.id,
                    label:     rule.label,
                    severity:  rule.severity || "warn",
                    hub:       hub,
                    dest:      String(row.destIata).toUpperCase(),
                    routeKey:  routeKey,
                    field:     rule.field,
                    operator:  rule.operator,
                    threshold: rule.threshold
                }, triggered, {
                    message:   RouteAssistantAlertEvaluator._formatMessage(rule, row, triggered)
                }))
            }
        }
        return out
    }

    /**
     * Apply a single rule to a single row. Returns null when the rule
     * doesn't match, or a partial record `{observedDelta?, observedValue?}`
     * when it does.
     */
    static _evalOnRow(rule, row) {
        const field = rule.field
        const op    = rule.operator
        const t     = Number(rule.threshold)
        if (!isFinite(t)) return null
        if (op === "increased_by" || op === "decreased_by") {
            const diff = row._diff && Object.prototype.hasOwnProperty.call(row._diff, field)
                ? row._diff[field]
                : null
            if (diff == null || !isFinite(diff)) return null
            if (op === "increased_by" && diff >  t) return {observedDelta: diff}
            if (op === "decreased_by" && diff < -t) return {observedDelta: diff}
            return null
        }
        if (op === "above" || op === "below") {
            const val = (row[field] != null && isFinite(row[field])) ? Number(row[field]) : null
            if (val == null) return null
            if (op === "above" && val > t) return {observedValue: val}
            if (op === "below" && val < t) return {observedValue: val}
            return null
        }
        return null
    }

    /** Compose the toast message — caller can use as-is or override. */
    static _formatMessage(rule, row, triggered) {
        const base = "⚠ " + (rule.label || rule.field)
            + " · " + String(row.destIata || "").toUpperCase()
        if (triggered.observedDelta != null) {
            const sign = triggered.observedDelta > 0 ? "+" : ""
            return base + " (Δ " + sign + RouteAssistantAlertEvaluator._formatNumber(triggered.observedDelta) + ")"
        }
        if (triggered.observedValue != null) {
            return base + " (now " + RouteAssistantAlertEvaluator._formatNumber(triggered.observedValue) + ")"
        }
        return base
    }

    static _formatNumber(v) {
        if (v == null || !isFinite(v)) return "—"
        const abs = Math.abs(v)
        if (abs >= 1000)  return Math.round(v).toLocaleString()
        if (abs >= 100)   return String(Math.round(v))
        if (abs >= 10)    return (Math.round(v * 10) / 10).toString()
        if (abs >= 1)     return (Math.round(v * 100) / 100).toString()
        return (Math.round(v * 1000) / 1000).toString()
    }

    /**
     * Convenience: list every field name that's a valid alert target.
     * Pulled from the panel's RA_DIFF_TRACKED + a small set of always-
     * available row fields. Settings UI uses this for the dropdown.
     */
    static availableFields() {
        return [
            // Diff-tracked (operators "increased_by" / "decreased_by" / "above" / "below" all valid):
            {field: "score",            label: "Score"},
            {field: "paxScore",         label: "Pax demand (0–10)"},
            {field: "cargoScore",       label: "Cargo demand (0–10)"},
            {field: "weeklyFlights",    label: "Weekly flights (real-world)"},
            {field: "airlineCount",     label: "Real-world airline count"},
            {field: "competitorCount",  label: "AS competitor count"},
            {field: "paxDemandPool",    label: "Pax demand pool (bookings/wk)"},
            {field: "cargoDemandPool",  label: "Cargo demand pool"},
            {field: "ourPaxShare",      label: "Our pax share %"},
            {field: "orsRatingGapToTop", label: "ORS rating gap to top"},
            {field: "rmTightness",      label: "RM tightness (0–1)"},
            // Always-available row fields (operators "above" / "below" only):
            {field: "profitPerWeek",    label: "Profit / week"},
            {field: "actualProfitPerWeek", label: "Actual profit / week"}
        ]
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantAlertEvaluator
}
