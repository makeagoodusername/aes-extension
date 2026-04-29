"use strict"

/**
 * Service-experiment adapter for the cross-domain change log.
 *
 * Walks the `aesStrategy:serviceExperiments[:acct:<id>]` ring + emits one
 * UnifiedEntry per recorded state transition (spawn, conclusion,
 * consolidation, rollback). The aggregator merges these alongside
 * pricing/service-profile/strategy entries so users see experiment
 * lifecycle in the same audit modal.
 *
 * Public surface: `window.AesServiceExperimentChangeLogAdapter.load(opts)`.
 * Wired into the aggregator's ADAPTERS map under the domain key
 * `"service-experiment"`.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesServiceExperimentChangeLogAdapter) return

    const KEY_BASE = "aesStrategy:serviceExperiments"

    const STATE_STATUS = {
        "active":        "posted",
        "concluded":     "verified",
        "consolidated":  "verified",
        "rolled-back":   "failed",
        "cancelled":     "skipped"
    }

    function _summariseExperiment(exp, historyEntry) {
        const base = exp.baseProfileName || ("#" + exp.baseProfileId)
        const partition = (exp.assignedRouteKeys || []).length
            + "/" + ((exp.assignedRouteKeys || []).length + (exp.controlRouteKeys || []).length)
        const transitionStr = (historyEntry && historyEntry.transition) || null
        if (transitionStr) {
            if (transitionStr.indexOf("concluded") >= 0 && exp.outcome) {
                const w = exp.outcome.winner || "tie"
                const c = exp.outcome.confidence || "low"
                return "S7 " + base + " · " + partition + " split · " + w + " (" + c + " conf.)"
            }
            return "S7 " + base + " · " + transitionStr + " · " + partition + " split"
        }
        return "S7 " + base + " · " + (exp.state || "active") + " · " + partition + " split"
    }

    /**
     * Walk every keyed slot (legacy + per-account scopes) and emit one
     * entry per history transition + one envelope for the current state
     * if no transition history exists. Each entry has a stable id derived
     * from the experiment id and transition timestamp so re-aggregation
     * is idempotent.
     */
    async function load(opts) {
        opts = opts || {}
        const since = isFinite(opts.sinceMs) ? opts.sinceMs : 0
        let all
        try { all = await chrome.storage.local.get(null) }
        catch (_) { return [] }
        const out = []
        for (const k in all) {
            if (k !== KEY_BASE && k.indexOf(KEY_BASE + ":acct:") !== 0) continue
            const ring = Array.isArray(all[k]) ? all[k] : []
            for (const exp of ring) {
                if (!exp || !exp.experimentId) continue
                const history = Array.isArray(exp.history) ? exp.history : []
                if (history.length) {
                    for (const h of history) {
                        const ts = Number(h.ts) || Number(exp.startedAt) || 0
                        if (since > 0 && ts < since) continue
                        const stateAfter = (h.transition || "").split("→").pop()
                            ? (h.transition || "").split("→").pop().trim()
                            : exp.state
                        out.push({
                            id:      "se:" + exp.experimentId + ":" + ts + ":" + (h.transition || "spawn"),
                            ts:      ts,
                            domain:  "service-experiment",
                            source:  "service-experiment",
                            scope:   {
                                profileId:      exp.baseProfileId != null ? Number(exp.baseProfileId) : null,
                                experimentId:   exp.experimentId,
                                accountId:      exp.accountId || null,
                                server:         exp.server || null,
                                airlineCode:    exp.airlineCode || null
                            },
                            status:  STATE_STATUS[stateAfter] || "posted",
                            summary: _summariseExperiment(exp, h),
                            prev:    null,
                            next:    {
                                perturbationChanges: exp.perturbationChanges || null,
                                outcome:             (h.transition && h.transition.indexOf("concluded") >= 0)
                                                        ? exp.outcome : null
                            },
                            reason:  h.reason || null,
                            dryRun:  false,
                            count:   1,
                            raw:     {experimentId: exp.experimentId, history: h}
                        })
                    }
                } else {
                    const ts = Number(exp.startedAt) || 0
                    if (since > 0 && ts < since) continue
                    out.push({
                        id:      "se:" + exp.experimentId + ":" + ts + ":bootstrap",
                        ts:      ts,
                        domain:  "service-experiment",
                        source:  "service-experiment",
                        scope:   {
                            profileId:    exp.baseProfileId != null ? Number(exp.baseProfileId) : null,
                            experimentId: exp.experimentId,
                            accountId:    exp.accountId || null,
                            server:       exp.server || null,
                            airlineCode:  exp.airlineCode || null
                        },
                        status:  STATE_STATUS[exp.state] || "posted",
                        summary: _summariseExperiment(exp, null),
                        prev:    null,
                        next:    {perturbationChanges: exp.perturbationChanges || null},
                        reason:  null,
                        dryRun:  false,
                        count:   1,
                        raw:     {experimentId: exp.experimentId}
                    })
                }
            }
        }
        return out
    }

    window.AesServiceExperimentChangeLogAdapter = {
        load: load,
        KEY_BASE: KEY_BASE
    }
})()
