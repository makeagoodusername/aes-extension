"use strict"

/**
 * HubFeed slice for the strategy decision-dispatch surface (Slice E1).
 *
 *   hub:strategy:dispatch — coalesced state of pending price-moves +
 *                           pending interventions + last applied dispatch.
 *
 * Inputs (deps):
 *   data:strategy:dispatch:pending     (price-move staged via composeMove)
 *   data:strategy:dispatch:applied     (apply pipeline succeeded)
 *   data:strategy:intervention:pending (K11.2 fork→dispatch staged)
 *   data:strategy:fork:promoted        (mirror; relevant when promote()
 *                                       chains into composeFromIntervention)
 *
 * Output value:
 *   {
 *     pendingMove:         {hub, dest, classKey, source, requestedAt} | null,
 *     pendingIntervention: {dispatchId, kind, summary, originForkId, applied,
 *                           requestedAt} | null,
 *     lastApplied:         {hub, dest, classKey, decisionId, appliedAt} | null,
 *     count:               number   // pending-only: 0..2 ("how much is in flight")
 *   }
 *
 * Surfaces using this slice:
 *   - strategy-briefing-tile (Decision dispatch sub-section, Slice E1)
 *   - counterfactual-lab tile already reads readPendingIntervention directly,
 *     so this slice is purely for the briefing/hero surface
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof window.HubFeed === "undefined") {
        console.warn("[AES dispatch-feed] HubFeed missing — slice not declared")
        return
    }
    if (window.__aesDispatchFeedDeclared) return
    window.__aesDispatchFeedDeclared = true

    HubFeed.declare({
        name:       "hub:strategy:dispatch",
        deps: [
            "data:strategy:dispatch:pending",
            "data:strategy:dispatch:applied",
            "data:strategy:intervention:pending",
            "data:strategy:fork:promoted"
        ],
        ttlMs:      6 * 3600 * 1000,
        debounceMs: 80,
        compute:    async () => {
            const out = {pendingMove: null, pendingIntervention: null, lastApplied: null, count: 0}
            try {
                const dd = window.AesStrategyDecisionDispatch
                if (dd && typeof dd.readPending === "function") {
                    const p = await dd.readPending().catch(() => null)
                    if (p && !p.applied) {
                        out.pendingMove = {
                            hub:         p.hub,
                            dest:        p.dest,
                            classKey:    p.classKey,
                            source:      p.source,
                            requestedAt: p.requestedAt || null
                        }
                        out.count++
                    } else if (p && p.applied) {
                        out.lastApplied = {
                            hub:        p.hub,
                            dest:       p.dest,
                            classKey:   p.classKey,
                            decisionId: p.decisionId || null,
                            appliedAt:  p.appliedAt || null
                        }
                    }
                }
                if (dd && typeof dd.readPendingIntervention === "function") {
                    const i = await dd.readPendingIntervention().catch(() => null)
                    if (i) {
                        out.pendingIntervention = {
                            dispatchId:   i.dispatchId,
                            kind:         i.intervention && i.intervention.kind,
                            summary:      i.summary,
                            originForkId: i.originForkId,
                            applied:      !!i.applied,
                            requestedAt:  i.requestedAt || null
                        }
                        if (!i.applied) out.count++
                    }
                }
            } catch (_) { /* best-effort — return whatever we resolved */ }
            return out
        }
    })
})()
