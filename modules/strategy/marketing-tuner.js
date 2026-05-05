"use strict"

/**
 * AES Strategy — marketing budget tuner (Slice 19).
 *
 * Pure compute. Given the user's stored marketing budget record, the
 * snapshot's per-region demand+capacity profile, and a rough $-to-LF
 * elasticity, propose per-region budget shifts that move spend toward
 * regions where the engine's other moves are demand-constrained.
 *
 * Algorithm:
 *
 *   1. For each region with a current budget, compute:
 *        currentBudget   — $/wk
 *        observedDemand  — demand-bar value (when scrape has it; else
 *                          fall back to network-level demand on the
 *                          snapshot for that region's hubs)
 *        capacityHeadroom — fraction of weekly seats unused on routes
 *                           originating from hubs in this region (1
 *                           when full, 0 when starved)
 *        priceLatitude    — clamp((1 − maxMovePct/100), 0, 1) — rough
 *                           proxy for "can we still move price here?"
 *                           Lower = capped out.
 *        constraintScore = 1 − (priceLatitude × serviceLatitude
 *                              × capacityHeadroom)
 *      regions where constraintScore is high are the ones where pulling
 *      another lever (price/service/capacity) is least available — so
 *      marketing has the most slack to lift demand.
 *
 *   2. Allocate a fraction of the global budget to each region in
 *      proportion to constraintScore × elasticity. Apply per-region
 *      delta caps (default ±25% per move).
 *
 * Pure: no storage I/O, no DOM, no POST. Reads the budget record from
 * `AesMarketingBudgetStore` only when the caller doesn't pass one.
 *
 * Public API (window.AesStrategyMarketingTuner):
 *   computeProposals({snapshot, budgetRecord?, opts?}) → Promise<Decision[]>
 *
 * Decision shape (matches diff-plan domain conventions):
 *   {
 *     id:       "marketing:<regionId>",
 *     domain:   "marketing",
 *     kind:     "budget-shift",
 *     title:    "<region> · $<old>→$<new> (Δ <±%>)",
 *     subtitle: "constraint <0..1>",
 *     rationale: [...],
 *     payload:  {regionId, currentBudgetAS, suggestedBudgetAS, deltaPct, ...},
 *     applicable:     false,
 *     applicableNote: "advisory only (Slice 19 v1 — applier stub)"
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyMarketingTuner) return

    const DEFAULTS = {
        elasticityLfPerDollar: 1e-6,   // 1 dollar of marketing → 1e-6 LF
                                       //   (placeholder; calibrated via outcomes)
        maxDeltaPct:           25,
        minMovePct:            5,
        constraintFloor:       0.30,
        topN:                  6
    }

    const ADVISORY_NOTE = "advisory only (Slice 19 v1 — applier stub)"

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    /**
     * Heuristic: use the snapshot to estimate per-region constraint slack.
     * Without a hub→region mapping in the snapshot today, we group hubs
     * by their `region` field when present, else by country-prefix
     * fallback. Returns Map<regionId, {capacityHeadroom, hubCount,
     * sampleRoutes}>.
     */
    function _regionSlack(snapshot) {
        const out = new Map()
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) {
            const region = h && (h.region || h.continent || h.country || h.iata)
            if (!region) continue
            const slot = out.get(region) || {capacityHeadroom: 0, hubCount: 0,
                                              sampleRoutes: 0, sumLf: 0}
            slot.hubCount++
            for (const r of (h.byRoute || [])) {
                if (!r) continue
                const lf = _num(r.lf, _num(r.paxLf, NaN))
                if (isFinite(lf)) {
                    slot.sumLf += lf
                    slot.sampleRoutes++
                }
            }
            out.set(region, slot)
        }
        for (const v of out.values()) {
            v.capacityHeadroom = v.sampleRoutes > 0
                ? Math.max(0, Math.min(1, 1 - (v.sumLf / v.sampleRoutes)))
                : 0
        }
        return out
    }

    /**
     * Room remaining on the price lever. High when the engine can still
     * move price further (large `maxPriceMovePerWindow`); low when price
     * adjustments are tightly capped. Marketing helps most when this is
     * LOW — price can't pull the lever, so a different one must.
     */
    function _priceLeverRoom(snapshot) {
        const s = (snapshot && snapshot.strategySettings) || {}
        const maxMove = _num(s.maxPriceMovePerWindow, 10)
        return Math.max(0, Math.min(1, maxMove / 50))
    }

    /**
     * Room remaining on the service lever. High when service moves are
     * enabled and not yet maxed out; low when disabled. Marketing helps
     * most when this is LOW.
     */
    function _serviceLeverRoom(snapshot) {
        const s = (snapshot && snapshot.strategySettings) || {}
        return s.serviceMovesEnabled ? 0.7 : 0.05
    }

    /**
     * Build per-region proposals. Returns ranked Decision array.
     */
    async function computeProposals(input) {
        const inp = input || {}
        const snapshot = inp.snapshot
        const opts = Object.assign({}, DEFAULTS, inp.opts || {})
        let budgetRecord = inp.budgetRecord || null
        if (!budgetRecord && window.AesMarketingBudgetStore) {
            try {
                const ctx = {
                    accountId: snapshot && snapshot.accountId,
                    server:    snapshot && snapshot.server,
                    airline:   snapshot && snapshot.airlineCode
                }
                budgetRecord = await window.AesMarketingBudgetStore.load(ctx)
            } catch (_) { /* keep null */ }
        }
        if (!budgetRecord || !Array.isArray(budgetRecord.regions)
                || !budgetRecord.regions.length) {
            return []
        }
        const slackByRegion = _regionSlack(snapshot)
        const priceRoom   = _priceLeverRoom(snapshot)
        const serviceRoom = _serviceLeverRoom(snapshot)

        // Marketing is most useful where (a) capacity has slack to absorb
        // new demand AND (b) the other levers can no longer pull. The
        // amplifier ranges 0.5..1.0 — even with both other levers wide
        // open, marketing still gets *some* weight on capacity-rich
        // regions (it just won't dominate the allocation).
        const leverExhaustion = (1 - priceRoom) * (1 - serviceRoom)
        const exhaustionAmp = 0.5 + 0.5 * leverExhaustion

        const enriched = []
        for (const r of budgetRecord.regions) {
            if (!r || !r.regionId) continue
            const cur = _num(r.currentBudgetAS, NaN)
            if (!isFinite(cur)) continue
            const slack = slackByRegion.get(r.regionId)
                || slackByRegion.get((r.regionName || "").toLowerCase())
                || {capacityHeadroom: 0.3, hubCount: 0}
            const constraint = slack.capacityHeadroom * exhaustionAmp
            enriched.push({region: r, slack: slack, constraint: constraint,
                            priceRoom: priceRoom, serviceRoom: serviceRoom})
        }
        if (!enriched.length) return []

        // Allocate: split a fixed-sum budget shift proportional to
        // `constraint × elasticity`. Total move bounded by sum of
        // currentBudget × maxDeltaPct.
        const totalConstraint = enriched.reduce((s, e) => s + e.constraint, 0) || 1
        const out = []
        for (const e of enriched) {
            if (e.constraint < opts.constraintFloor) continue
            const share = e.constraint / totalConstraint
            const cur = _num(e.region.currentBudgetAS, 0)
            const targetDelta = cur * (share - 1 / enriched.length) * 2  // amplify
            const cappedDelta = Math.max(-cur * opts.maxDeltaPct / 100,
                Math.min(cur * opts.maxDeltaPct / 100, targetDelta))
            const newBudget = Math.max(0, Math.round(cur + cappedDelta))
            const deltaPct = cur > 0 ? Math.round((cappedDelta / cur) * 100) : 0
            if (Math.abs(deltaPct) < opts.minMovePct) continue
            out.push({
                id:    "marketing:" + e.region.regionId,
                domain: "marketing",
                kind:   "budget-shift",
                title:  (e.region.regionName || e.region.regionId)
                        + " · $" + cur.toLocaleString() + "→$" + newBudget.toLocaleString()
                        + " (" + (deltaPct >= 0 ? "+" : "") + deltaPct + "%)",
                subtitle: "constraint " + e.constraint.toFixed(2),
                rationale: [
                    "[demand-slack] capacity headroom " + e.slack.capacityHeadroom.toFixed(2)
                        + " (" + (e.slack.sampleRoutes || 0) + " routes)",
                    "[other-levers] price-room " + priceRoom.toFixed(2)
                        + " · service-room " + serviceRoom.toFixed(2)
                        + " · exhaustion-amp " + exhaustionAmp.toFixed(2),
                    "[score] " + e.constraint.toFixed(2),
                    "[share] " + (share * 100).toFixed(1) + "% of "
                        + enriched.length + "-region marketing pool",
                    "[move] " + (cappedDelta >= 0 ? "+" : "") + Math.round(cappedDelta).toLocaleString()
                        + " AS$/wk (capped at ±" + opts.maxDeltaPct + "%)"
                ],
                payload: {
                    regionId:           e.region.regionId,
                    regionName:         e.region.regionName || null,
                    currentBudgetAS:    cur,
                    suggestedBudgetAS:  newBudget,
                    deltaPct:           deltaPct,
                    constraintScore:    e.constraint,
                    capacityHeadroom:   e.slack.capacityHeadroom
                },
                applicable:     false,
                applicableNote: ADVISORY_NOTE
            })
        }
        out.sort((a, b) =>
            Math.abs(b.payload.deltaPct || 0) - Math.abs(a.payload.deltaPct || 0))
        return out.slice(0, opts.topN)
    }

    window.AesStrategyMarketingTuner = {
        computeProposals:  computeProposals,
        DEFAULTS:          Object.assign({}, DEFAULTS),
        ADVISORY_NOTE:     ADVISORY_NOTE,
        _regionSlack:      _regionSlack,
        _priceLeverRoom:   _priceLeverRoom,
        _serviceLeverRoom: _serviceLeverRoom
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            ;(async function () {
                const out = await computeProposals({
                    snapshot: {
                        strategySettings: {maxPriceMovePerWindow: 10, serviceMovesEnabled: false},
                        hubs: [
                            {iata: "FRA", region: "europe", byRoute: [
                                {lf: 0.95}, {lf: 0.93}
                            ]},
                            {iata: "JFK", region: "north-america", byRoute: [
                                {lf: 0.55}, {lf: 0.60}
                            ]}
                        ]
                    },
                    budgetRecord: {regions: [
                        {regionId: "europe",        regionName: "Europe",        currentBudgetAS: 50000},
                        {regionId: "north-america", regionName: "North America", currentBudgetAS: 50000}
                    ]}
                })
                console.assert(out.length >= 1,
                    "[smoke s19] tuner emits at least one proposal")
                const europe = out.find(d => d.payload.regionId === "europe")
                if (europe) {
                    // Europe is capacity-constrained (LF~0.94) — should be
                    // suppressed entirely (below constraintFloor) or cut.
                    console.assert(europe.payload.deltaPct <= 0,
                        "[smoke s19] capacity-constrained region not boosted")
                }
                const na = out.find(d => d.payload.regionId === "north-america")
                if (na) {
                    // NA has LF~0.575 → demand-constrained → should be boosted.
                    console.assert(na.payload.deltaPct >= 0,
                        "[smoke s19] demand-constrained region is boosted")
                }
            })().catch(e => console.warn("[smoke s19] threw", e))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
