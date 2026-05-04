"use strict"

/**
 * ORS Playstyle Context — orchestration helper around the existing
 * `RouteAssistantOrsCompetitionAdjuster` (modules/route-assistant/ors-competition-adjuster.js).
 *
 * The competition adjuster already classifies routes into monopoly /
 * duopoly / competitive / saturated tiers and emits per-tier weight
 * envelopes (rank, rating, service, elasticity) — including a `playstyle`
 * settings axis ("adaptive"/"balanced"/"monopoly"/"competitive"/"premium")
 * that scales tier weights. This module fills in the orchestration gaps:
 *
 *   1. `buildContext({orsRecord?, marketRecord?, settings?})` — auto-derives
 *      `competitorCount` + `ourPaxShare` from raw scrape data so callers
 *      don't have to count carriers themselves. Falls through:
 *         marketRecord.competitorEntries  (preferred — scraped airline list)
 *         marketRecord.competitorCount    (already-counted)
 *         orsRecord.byClass.connections   (count distinct carrier prefixes)
 *         orsRecord.totalConnections      (coarse fallback)
 *
 *   2. `composite(orsComposite, marketRecord, settings?)` — fuses an
 *      `ors-intelligence` composite (rankAny, ratingGapToTop, …) with the
 *      derived context, so price-move proposers get a single envelope that
 *      already carries the playstyle classification + weighted ratingGap.
 *
 *   3. `refineByShare(classification, ourPaxShare)` — bumps the tier when
 *      our pax share is very high (≥0.65 → demote toward monopoly, since
 *      we functionally OWN the route) or very low (≤0.10 → promote toward
 *      saturated, every advantage matters when we're the small player).
 *
 * The actual tier classification + per-tier rank/rating/service weights
 * stay in `ors-competition-adjuster.js` — this module is an additive
 * layer, not a reimplementation. Tests in
 * `audit-jihwan/tests/ors-playstyle-adjuster.test.js` validate the
 * orchestration contract; the underlying adjuster has its own suite at
 * `audit/tests/route-assistant/ors-competition-adjuster.test.js`.
 *
 * Public API (window.AesRouteAssistantOrsPlaystyleContext):
 *   buildContext({orsRecord, marketRecord, settings})
 *     → {competitorCount, ourPaxShare, totalConnections, source, weights}
 *   composite(orsComposite, marketRecord, settings)
 *     → orsComposite + {playstyle, weights, weightedRatingGap, rationale}
 *   refineByShare(weights, ourPaxShare, settings)
 *     → weights with playstyle bumped up/down by share
 *
 *   The legacy `classify({competitorCount, ourPaxShare, settings})` and
 *   `adjustOrsScore` entry points are preserved for callers/tests that
 *   were written against the standalone version of this module — they
 *   delegate to the underlying competition adjuster + this share refinement.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesRouteAssistantOrsPlaystyleContext) return

    const SHARE_DEMOTE_THRESHOLD  = 0.65
    const SHARE_PROMOTE_THRESHOLD = 0.10
    const TIER_ORDER = ["monopoly", "duopoly", "competitive", "saturated"]

    function _num(v, fallback) {
        const n = Number(v)
        return Number.isFinite(n) ? n : fallback
    }

    function _normaliseShare(rawShare) {
        if (rawShare == null || rawShare === "") return null
        const n = Number(rawShare)
        return Number.isFinite(n) ? n : null
    }

    function _competitionAdjuster() {
        if (typeof window !== "undefined" && window.RouteAssistantOrsCompetitionAdjuster) {
            return window.RouteAssistantOrsCompetitionAdjuster
        }
        return null
    }

    /**
     * Refine a tier classification by the user's measured pax share. The
     * underlying competition adjuster only sees competitor count; share
     * captures market dominance independently. A 5-carrier route where we
     * hold 80% behaves like a duopoly for our flights — competitors are
     * present but not effective. Conversely, a 2-carrier route where we
     * hold 5% needs to fight as if it were saturated.
     */
    function refineByShare(weights, ourPaxShare /* settings */) {
        const share = _normaliseShare(ourPaxShare)
        if (share == null) return weights
        const tier = String(weights && weights.classification || "")
        const idx = TIER_ORDER.indexOf(tier)
        if (idx < 0) return weights
        let nextIdx = idx
        const notes = []
        if (share >= SHARE_DEMOTE_THRESHOLD && idx > 0) {
            nextIdx = idx - 1
            notes.push("ourPaxShare=" + share.toFixed(2) + " ≥ "
                + SHARE_DEMOTE_THRESHOLD + " → demoted " + tier + " → " + TIER_ORDER[nextIdx])
        } else if (share <= SHARE_PROMOTE_THRESHOLD && idx < TIER_ORDER.length - 1) {
            nextIdx = idx + 1
            notes.push("ourPaxShare=" + share.toFixed(2) + " ≤ "
                + SHARE_PROMOTE_THRESHOLD + " → promoted " + tier + " → " + TIER_ORDER[nextIdx])
        }
        if (nextIdx === idx) return weights
        const nextTier = TIER_ORDER[nextIdx]
        const next = Object.assign({}, weights, {
            classification: nextTier,
            shareRefined:   true,
            shareRefinementNotes: notes
        })
        // Re-pull tier-specific weights from the underlying adjuster output
        // (it emits all tier rates as top-level fields). For each weight key
        // ending in "RankWeight"/"RatingWeight"/"ServiceWeight"/"elasticityScale*"
        // we keep the same envelope, but downstream consumers should read the
        // refined classification, not the raw weights.
        return next
    }

    /**
     * Distinct competing carriers from raw ORS connection data. Filters
     * out our own carrier prefixes (passed in or read from the record).
     */
    function _carriersFromOrs(orsRecord) {
        if (!orsRecord || !orsRecord.byClass) return new Set()
        const ourPrefixes = new Set(
            (orsRecord.ourCarrierPrefixes || []).map(s => String(s).toUpperCase())
        )
        const carriers = new Set()
        for (const cls in orsRecord.byClass) {
            const c = orsRecord.byClass[cls]
            if (!c || !Array.isArray(c.connections)) continue
            for (const conn of c.connections) {
                if (!conn || !Array.isArray(conn.legs)) continue
                for (const leg of conn.legs) {
                    const code = String((leg && (leg.flightCode || leg.carrier)) || "").toUpperCase()
                    const m = code.match(/^([A-Z]{2,3})/)
                    if (!m) continue
                    if (ourPrefixes.has(m[1])) continue
                    carriers.add(m[1])
                }
            }
        }
        return carriers
    }

    /**
     * Auto-derive competitor count + share from raw scrape records.
     * Returns the context envelope plus the underlying adjuster's weights
     * (after share refinement) so callers can score in one call.
     */
    function buildContext(input) {
        const i = input || {}
        const orsRecord = i.orsRecord || null
        const market    = i.marketRecord || null
        const settings  = i.settings || null

        const out = {
            competitorCount:  0,
            ourPaxShare:      null,
            totalConnections: null,
            source:           "none"
        }

        // Source 1: marketRecord competitor entries (richest — names + counts)
        if (market && Array.isArray(market.competitorEntries)) {
            const myPrefixes = new Set(
                (market.ourCarrierPrefixes || []).map(s => String(s).toUpperCase())
            )
            let count = 0
            for (const e of market.competitorEntries) {
                if (!e) continue
                const pre = String(e.airlineCode || e.carrier || e.code || "").toUpperCase()
                if (pre && myPrefixes.has(pre)) continue
                count++
            }
            out.competitorCount = count
            out.source = "marketRecord.competitorEntries"
        // Source 2: pre-counted competitor count
        } else if (market && Number.isFinite(Number(market.competitorCount))) {
            out.competitorCount = Number(market.competitorCount)
            out.source = "marketRecord.competitorCount"
        // Source 3: distinct carrier prefixes from ORS connections
        } else if (orsRecord && orsRecord.byClass) {
            out.competitorCount = _carriersFromOrs(orsRecord).size
            out.source = "orsRecord.byClass.connections"
        // Source 4: coarse from totalConnections
        } else if (orsRecord && Number.isFinite(Number(orsRecord.totalConnections))) {
            out.totalConnections = Number(orsRecord.totalConnections)
            out.competitorCount  = orsRecord.totalConnections > 10 ? 2 : 0
            out.source = "orsRecord.totalConnections (coarse)"
        }

        if (market && Number.isFinite(Number(market.ourPaxShare))) {
            out.ourPaxShare = Number(market.ourPaxShare)
        }

        const adj = _competitionAdjuster()
        if (adj && typeof adj.adjust === "function") {
            const weights = adj.adjust({
                competitorCount: out.competitorCount,
                hub:             i.hub  || (orsRecord && orsRecord.hub)  || (market && market.hub),
                dest:            i.dest || (orsRecord && orsRecord.dest) || (market && market.dest),
                settings:        settings && (settings.routeAssistant
                    && settings.routeAssistant.orsCompetition || settings.orsCompetition || settings)
            })
            out.weights = refineByShare(weights, out.ourPaxShare, settings)
            out.classification = out.weights.classification
        }
        return out
    }

    /**
     * Fuse an ors-intelligence composite (`{rankAny, ratingGapToTop, ...}`)
     * with the playstyle context so proposers get a single envelope. The
     * composite output adds:
     *   - playstyle classification (after share refinement)
     *   - weights envelope from the competition adjuster
     *   - weightedRatingGap = ratingGapToTop × weights.orsRatingWeight
     *     (so a 30-pt gap in monopoly counts as ~3pt, but in saturated as ~27pt)
     */
    function composite(orsComposite, marketRecord, settings) {
        const ctx = buildContext({marketRecord, settings})
        const out = Object.assign({}, orsComposite || {})
        const w = ctx.weights || {}
        const rgAny = (out.ratingGapToTop != null && isFinite(Number(out.ratingGapToTop)))
            ? Number(out.ratingGapToTop) : null
        const ratingW = _num(w.orsRatingWeight,
            _num(w[ctx.classification + "RatingWeight"], 1))
        return Object.assign(out, {
            playstyle:                  ctx.classification || null,
            competitorCount:            ctx.competitorCount,
            ourPaxShare:                ctx.ourPaxShare,
            weights:                    w,
            orsWeightMultiplier:        _num(w.orsRankWeight,
                _num(w[ctx.classification + "RankWeight"], 1)),
            serviceProfileWeightMultiplier: _num(w.serviceProfileWeight,
                _num(w[ctx.classification + "ServiceWeight"], 1)),
            weightedRatingGap:          rgAny != null ? rgAny * ratingW : null,
            rationale:                  w.rationale ? [w.rationale] : []
        })
    }

    // ─────────────────────────────────────────────────────────────────
    // Backwards-compatible shims: classify + adjustOrsScore.
    //
    // Earlier iterations of this module classified competitor count
    // independently with bands {monopoly:≤1, duopoly:≤2, competitive:≤5,
    // fragmented:>5}. The competition adjuster uses sharper buckets
    // (monopoly:0, duopoly:1, competitive:2..4, saturated:≥5). We delegate
    // to the adjuster but preserve the old return shape for legacy callers.
    // ─────────────────────────────────────────────────────────────────

    function classify(input) {
        const i = input || {}
        const adj = _competitionAdjuster()
        if (!adj || typeof adj.adjust !== "function") {
            return {
                playstyle:                       "competitive",
                competitorCount:                 _num(i.competitorCount, 0),
                ourPaxShare:                     _normaliseShare(i.ourPaxShare),
                orsWeightMultiplier:             1,
                serviceProfileWeightMultiplier:  1,
                recommendedServiceTier:          "standard",
                rationale:                       ["competition-adjuster module not loaded"]
            }
        }
        const w = adj.adjust({
            competitorCount: _num(i.competitorCount, 0),
            hub:             i.hub,
            dest:             i.dest,
            settings:        i.settings && (
                i.settings.routeAssistant && i.settings.routeAssistant.orsCompetition
                || i.settings.orsCompetition
                || i.settings
            )
        })
        const refined = refineByShare(w, _normaliseShare(i.ourPaxShare), i.settings)
        const tier = String(refined.classification || "competitive")
        const out = {
            playstyle:                       tier,
            competitorCount:                 _num(i.competitorCount, 0),
            ourPaxShare:                     _normaliseShare(i.ourPaxShare),
            orsWeightMultiplier:             _num(refined[tier + "RankWeight"],
                _num(refined.orsRankWeight, 1)),
            serviceProfileWeightMultiplier:  _num(refined[tier + "ServiceWeight"],
                _num(refined.serviceProfileWeight, 1)),
            recommendedServiceTier:          _recommendedTierFor(tier),
            rationale:                       []
        }
        out.rationale.push("competitorCount=" + out.competitorCount + " → tier=" + tier)
        if (refined.shareRefined && Array.isArray(refined.shareRefinementNotes)) {
            for (const n of refined.shareRefinementNotes) out.rationale.push(n)
        }
        return out
    }

    function _recommendedTierFor(playstyle) {
        switch (playstyle) {
            case "monopoly":    return "minimum"
            case "duopoly":     return "standard"
            case "competitive": return "premium"
            case "saturated":   return "maximum"
        }
        return "standard"
    }

    function adjustOrsScore(rawRank, competitorCount, settings) {
        const c = classify({competitorCount, settings})
        return {
            effectiveRank: _num(rawRank, null),
            multiplier:    c.orsWeightMultiplier,
            playstyle:     c.playstyle
        }
    }

    window.AesRouteAssistantOrsPlaystyleContext = {
        buildContext,
        composite,
        refineByShare,
        // Back-compat shims:
        classify,
        adjustOrsScore,
        TIER_ORDER:                TIER_ORDER.slice(),
        SHARE_DEMOTE_THRESHOLD,
        SHARE_PROMOTE_THRESHOLD
    }

    // Legacy alias — earlier callers/tests used this name; keep both
    // pointing at the same surface so nothing breaks.
    window.AesRouteAssistantOrsPlaystyleAdjuster = window.AesRouteAssistantOrsPlaystyleContext
})()
