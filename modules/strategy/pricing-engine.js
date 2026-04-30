"use strict"

/**
 * AES Strategy — pricing engine (Slice 9).
 *
 * Wraps the existing `proposePriceMoves` ranking with three Slice-9
 * elevations:
 *
 *   1. Time-decayed competitor weighting — older competitor band readings
 *      lose weight (half-life 7 days by default), so a competitor's
 *      one-week dump three weeks ago can't anchor today's response.
 *   2. Logistic yield-curve fit — when the route has ≥4 historical
 *      `(pricePct, lf)` tuples spanning ≥5pp of price, fit a logistic
 *      and target the elasticity midpoint instead of the deadband
 *      midpoint. Falls back gracefully (engine output is null) when
 *      depth insufficient.
 *   3. Marginal-cost floor — `costPerSeat × 1.05` from the accounting
 *      cash/cost rollup; never let an elasticity-driven move land below.
 *
 * Pure compute: returns advisory `EngineRecommendation` records that the
 * caller (price-moves consumer, panel, or auto-driver) merges with the
 * deadband-driven proposer output. The proposer remains the source of
 * truth for the actual `priceMove` envelopes pushed through apply-pipeline;
 * this engine annotates them with elasticity-aware targets when the data
 * supports it.
 *
 * Public API (window.AesStrategyPricingEngine):
 *   computeRecommendations(snapshot, opts?)         → Promise<EngineRecommendation[]>
 *   timeDecayCompetitorBand(historic, opts?)        → {priceMin, priceMax, samples, decayHalfLifeMs}
 *   marginalCostFloor(snapshot, hub, dest)          → number | null   (price pct or null)
 *
 * EngineRecommendation shape:
 *   {
 *     hub, dest, classKey,
 *     elasticity: null | {ok, midpoint, slope, confidence, samples, residual},
 *     suggestedPricePctElasticity: number | null,
 *     suggestedPricePctLfTarget:   number | null,
 *     decayedCompetitorBand:       {priceMin, priceMax} | null,
 *     marginalCostFloorPct:        number | null,
 *     advisory:                    string[]
 *   }
 *
 * Storage namespace consulted (read-only):
 *   routeAssistant:yieldHistory[:acct:<id>]:<HUB>-<DEST>      via RouteAssistantYieldHistoryStore
 *   routeAssistant:markets:historic:<HUB>-<DEST>              via RouteAssistantMarketsPageScraper
 *   accounting:income:<weekId>                                  via AccountingSnapshotStore (best-effort)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyPricingEngine) return

    const DEFAULTS = {
        decayHalfLifeMs:    7 * 24 * 3600 * 1000,
        elasticityHalfLife: 14 * 24 * 3600 * 1000,
        floorMultiplier:    1.05,
        targetLfWhenFitOk:  0.78,
        maxClassesPerRoute: 4
    }

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    /**
     * Compute time-decayed min/max from a per-week historic competitor
     * record. Older weeks weight `0.5^(ageWeeks/halfLifeWeeks)`. Shape
     * accepted: `{byPayload: Map|object, weeks: [...], ...}` — we
     * defensively pull `priceMin/priceMax` per row when present.
     */
    function timeDecayCompetitorBand(historic, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const halfLifeMs = _num(o.decayHalfLifeMs, DEFAULTS.decayHalfLifeMs)
        const now = _num(o.now, Date.now())
        const rows = []
        if (historic && Array.isArray(historic.weeks)) {
            for (const w of historic.weeks) {
                if (!w) continue
                const ts = _num(w.timestamp, _num(w.weekTs, null))
                const pmin = _num(w.priceMin, _num(w.minPrice, NaN))
                const pmax = _num(w.priceMax, _num(w.maxPrice, NaN))
                if (isFinite(pmin) || isFinite(pmax)) rows.push({ts: ts, pmin: pmin, pmax: pmax})
            }
        }
        if (historic && historic.byPayload && typeof historic.byPayload === "object") {
            const obj = historic.byPayload
            const keys = (obj instanceof Map) ? Array.from(obj.keys()) : Object.keys(obj)
            for (const k of keys) {
                const v = (obj instanceof Map) ? obj.get(k) : obj[k]
                if (!v || typeof v !== "object") continue
                const ts = _num(v.timestamp, _num(v.scrapedAt, null))
                const pmin = _num(v.priceMin, NaN)
                const pmax = _num(v.priceMax, NaN)
                if (isFinite(pmin) || isFinite(pmax)) rows.push({ts: ts, pmin: pmin, pmax: pmax})
            }
        }
        if (!rows.length) return null
        let totalW = 0, sumMin = 0, sumMax = 0, samples = 0
        for (const r of rows) {
            const ts = isFinite(r.ts) ? r.ts : now
            const ageMs = Math.max(0, now - ts)
            const w = halfLifeMs > 0 ? Math.pow(0.5, ageMs / halfLifeMs) : 1
            if (isFinite(r.pmin)) { sumMin += r.pmin * w; totalW += w; samples++ }
            if (isFinite(r.pmax)) { sumMax += r.pmax * w }
        }
        if (totalW === 0) return null
        return {
            priceMin:        sumMin / totalW,
            priceMax:        totalW > 0 ? sumMax / totalW : null,
            samples:         samples,
            decayHalfLifeMs: halfLifeMs
        }
    }

    /**
     * Build (pricePct, lf, ts) tuples from the union of:
     *   - markets:historic:<HUB>-<DEST> rows (when carrying ownPricePct + lf)
     *   - orsHistory rows on the snapshot route (when present, structured as
     *     `[{ts, ownPricePct, classLf}, ...]`)
     *   - yield-history snapshots that carry pricePct + lf
     *
     * Different shapes coexist in storage; we accept any row that yields
     * both a pricePct in [50,200] and an lf in [0,1].
     */
    async function _gatherTuples(snapshot, hub, dest, classKey) {
        const out = []
        const route = _findRoute(snapshot, hub, dest)
        if (route && Array.isArray(route.orsHistory)) {
            for (const h of route.orsHistory) {
                if (!h) continue
                const p = _num(h.ownPricePct, _num(h.pricePct, NaN))
                const lfRaw = (h.classLf && classKey && h.classLf[classKey] != null)
                    ? _num(h.classLf[classKey], NaN)
                    : _num(h.lf, _num(h.paxLf, NaN))
                if (isFinite(p) && isFinite(lfRaw)) {
                    out.push({pricePct: p, lf: lfRaw, ts: _num(h.ts, null)})
                }
            }
        }
        if (typeof RouteAssistantYieldHistoryStore !== "undefined"
                && typeof RouteAssistantYieldHistoryStore.loadRecord === "function") {
            try {
                const rec = await RouteAssistantYieldHistoryStore.loadRecord(hub, dest)
                if (rec && Array.isArray(rec.snapshots)) {
                    for (const s of rec.snapshots) {
                        if (!s) continue
                        const p = _num(s.pricePct, _num(s.priceP, NaN))
                        const lfV = _num(s.loadFactor, _num(s.lf, NaN))
                        if (isFinite(p) && isFinite(lfV)) {
                            out.push({pricePct: p, lf: lfV, ts: _num(s.timestamp, null)})
                        }
                    }
                }
            } catch (_) { /* yield-history-store unavailable */ }
        }
        // F-9227-005: dedupe by (day-bucket, pricePct rounded to 0.1pp) so
        // observations duplicated across orsHistory + yield-history-store
        // don't bias the logistic fit. Timestamp-less rows collapse together
        // under a 'no-ts' bucket (rare path; keyspace stays disjoint from
        // real-timestamped data).
        const seen = new Set()
        const deduped = []
        for (const t of out) {
            const dayBucket = isFinite(t.ts) ? Math.floor(t.ts / 86400000) : "no-ts"
            const k = dayBucket + ":" + (Math.round(t.pricePct * 10) / 10)
            if (seen.has(k)) continue
            seen.add(k)
            deduped.push(t)
        }
        return deduped
    }

    function _findRoute(snapshot, hub, dest) {
        const wH = String(hub || "").toUpperCase()
        const wD = String(dest || "").toUpperCase()
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) {
            if (String(h && h.iata || "").toUpperCase() !== wH) continue
            for (const r of (h.byRoute || [])) {
                if (String(r && r.dest || "").toUpperCase() === wD) return r
            }
        }
        return null
    }

    /**
     * Read accounting snapshot to estimate cost-per-seat-km. Returns
     * a price-pct floor: `(costPerSeat * floorMultiplier) / referenceFare * 100`
     * when both are available; null when accounting data is missing.
     *
     * Reference fare is the route's `competitor.priceMin` when present,
     * else the route's `ownPricing.prices.Y` (which is itself a pct of
     * the AS reference). Result is in pct space, matching the rest of
     * the pricing pipeline.
     */
    function marginalCostFloor(snapshot, hub, dest, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const route = _findRoute(snapshot, hub, dest)
        if (!route) return null
        const cash = (snapshot && snapshot.cash) || {}
        const costPerSeat = _num(cash.weeklyCostPerSeat, _num(cash.costPerSeat, NaN))
        if (!isFinite(costPerSeat) || costPerSeat <= 0) return null
        const compMin = route.competitor && _num(route.competitor.priceMin, NaN)
        const ownY = route.ownPricing && route.ownPricing.prices
            && _num(route.ownPricing.prices.Y, NaN)
        const reference = isFinite(compMin) && compMin > 0
            ? compMin
            : (isFinite(ownY) && ownY > 0 ? ownY : null)
        if (!reference) return null
        const floorAbs = costPerSeat * _num(o.floorMultiplier, 1.05)
        const floorPct = (floorAbs / reference) * 100
        if (!isFinite(floorPct) || floorPct <= 0) return null
        return Math.max(50, Math.min(200, floorPct))
    }

    /**
     * Per-route, per-class engine recommendation. Returns one record
     * per (hub, dest, classKey) where the elasticity fit succeeded OR
     * a marginal-cost floor was resolvable. Records with neither are
     * suppressed — the deadband proposer stands on its own.
     */
    async function _recommendForRoute(snapshot, hub, dest, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const route = _findRoute(snapshot, hub, dest)
        if (!route) return []
        const fitter = window.AesStrategyElasticityFit
        const recommendations = []
        const classKeys = ["Y", "C", "F", "Cargo"]

        // Time-decayed competitor band — read from snapshot when attached
        // (pricing-compass already does this), else from markets:historic
        // through best-effort storage read.
        let decayedBand = null
        const histAttached = route.competitor && route.competitor.historic
        if (histAttached) {
            decayedBand = timeDecayCompetitorBand(histAttached,
                {decayHalfLifeMs: o.decayHalfLifeMs})
        }

        const floorPct = marginalCostFloor(snapshot, hub, dest, o)

        for (const classKey of classKeys) {
            const tuples = await _gatherTuples(snapshot, hub, dest, classKey)
            let elast = null
            let elastPct = null
            let lfTargetPct = null
            const advisory = []
            if (tuples.length >= 4 && fitter && typeof fitter.fit === "function") {
                elast = fitter.fit(tuples, {
                    halfLifeMs: o.elasticityHalfLife,
                    now:        _num(o.now, Date.now())
                })
                if (elast && elast.ok) {
                    elastPct = fitter.suggestPriceForElasticityMidpoint(elast)
                    lfTargetPct = fitter.suggestPriceForLfTarget(elast, o.targetLfWhenFitOk)
                    advisory.push("elasticity-midpoint=" + Math.round(elastPct)
                        + "% (slope " + (elast.slope < 0 ? "" : "+") + elast.slope.toFixed(3)
                        + ", " + elast.samples + " samples, " + elast.confidence + " conf.)")
                } else if (elast) {
                    advisory.push("elasticity-skipped: " + (elast.reason || "unknown"))
                }
            }
            if (decayedBand && classKey === "Y") {
                advisory.push("decayed-competitor-band ["
                    + Math.round(_num(decayedBand.priceMin, 0)) + "→"
                    + Math.round(_num(decayedBand.priceMax, 0)) + "] (n="
                    + decayedBand.samples + ")")
            }
            if (floorPct != null) {
                advisory.push("marginal-cost-floor=" + Math.round(floorPct) + "%")
                if (elastPct != null && elastPct < floorPct) {
                    advisory.push("elasticity-midpoint clipped to floor")
                    elastPct = floorPct
                }
                if (lfTargetPct != null && lfTargetPct < floorPct) {
                    lfTargetPct = floorPct
                }
            }

            if (elast && elast.ok || (floorPct != null && classKey === "Y")) {
                recommendations.push({
                    hub:                            hub,
                    dest:                           dest,
                    classKey:                       classKey,
                    elasticity:                     elast || null,
                    suggestedPricePctElasticity:    elastPct,
                    suggestedPricePctLfTarget:      lfTargetPct,
                    decayedCompetitorBand:          decayedBand,
                    marginalCostFloorPct:           floorPct,
                    advisory:                       advisory
                })
            }
        }
        return recommendations
    }

    /**
     * Walk every route in the snapshot, return one EngineRecommendation
     * envelope per (hub, dest, classKey) where elasticity OR floor info
     * is available. Caller decides how to merge with the deadband
     * proposer's PriceMove[]: typical pattern is to override `toPct`
     * when `suggestedPricePctElasticity` is closer to the proposer's
     * intended direction (toward elasticity midpoint when raising,
     * toward LF-target when lowering), keeping the proposer's rationale.
     */
    async function computeRecommendations(snapshot, opts) {
        const out = []
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                if (!r || !r.dest) continue
                try {
                    const recs = await _recommendForRoute(snapshot, h.iata || h.code, r.dest, opts)
                    for (const rec of recs) out.push(rec)
                } catch (e) {
                    console.warn("[AesStrategyPricingEngine] route failed",
                                 h && h.iata, r && r.dest, e)
                }
            }
        }
        return out
    }

    window.AesStrategyPricingEngine = {
        computeRecommendations:    computeRecommendations,
        timeDecayCompetitorBand:   timeDecayCompetitorBand,
        marginalCostFloor:         marginalCostFloor,
        DEFAULTS:                  Object.assign({}, DEFAULTS)
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Time-decay smoke
            const band = timeDecayCompetitorBand({
                weeks: [
                    {timestamp: Date.now() - 3 * 86400000,  priceMin: 100, priceMax: 130},
                    {timestamp: Date.now() - 28 * 86400000, priceMin: 70,  priceMax: 90}
                ]
            }, {decayHalfLifeMs: 7 * 86400000})
            console.assert(band && band.priceMin > 70 && band.priceMin < 100,
                "[smoke s9-engine] decayed band closer to recent week")

            // Marginal-cost floor smoke
            const floor = marginalCostFloor({
                cash: {weeklyCostPerSeat: 95},
                hubs: [{iata: "FRA", byRoute: [{
                    dest: "LHR",
                    competitor: {priceMin: 100},
                    ownPricing: {prices: {Y: 100}}
                }]}]
            }, "FRA", "LHR")
            console.assert(floor != null && floor > 95 && floor < 110,
                "[smoke s9-engine] marginal-cost floor scales above 95% of reference")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
