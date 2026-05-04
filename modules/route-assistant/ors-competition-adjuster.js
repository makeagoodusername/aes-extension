"use strict"

/**
 * ORS competition-aware adjuster.
 *
 * The pricing engine and route planner both consume an "ORS weight" — how
 * heavily ORS rank/share/rating should influence price moves and recommended
 * service profiles. In the AS economy:
 *
 *   • Monopoly (0 competitors): ORS rank is uninformative — there's nothing
 *     to rank against. Service profile + comfort gains marginal pax. Pricing
 *     can charge max-band without ORS resistance.
 *   • Duopoly (1 competitor): ORS rank is the dominant signal. Beating the
 *     competitor's rank by even 1 captures a disproportionate share.
 *   • Saturated (≥3 competitors): ORS rank + service profile + price all
 *     interact. Service profile differentiation matters more (the only way
 *     to stand out from a crowd of similar offerings).
 *
 * This module emits a `weights` envelope:
 *
 *   {
 *     orsRankWeight:        0..1   (how much ORS rank affects pricing moves)
 *     orsRatingWeight:      0..1   (how much rating gap drives service-profile recommendations)
 *     serviceProfileWeight: 0..1   (how much service profile matters)
 *     priceElasticityScale: 0..2   (multiplier on price elasticity — high-comp routes are more elastic)
 *     classification:       "monopoly" | "duopoly" | "competitive" | "saturated"
 *     rationale:            string  (one-line explanation for the audit log)
 *   }
 *
 * Tunable via settings.routeAssistant.orsCompetition (all optional):
 *
 *   {
 *     monopolyRankWeight:        0     (default — ORS off entirely when no competitors)
 *     monopolyRatingWeight:      0.10  (still nudge service profile a bit)
 *     duopolyRankWeight:         0.85  (ORS dominant)
 *     saturatedRankWeight:       0.55
 *     saturatedServiceWeight:    0.85  (service profile differentiation matters most)
 *     competitiveCountThreshold: 3     (≥3 = saturated)
 *     elasticityScaleMonopoly:   0.5   (50% of base — pax less price-sensitive)
 *     elasticityScaleSaturated:  1.4   (140% — pax very price-sensitive)
 *     overrides:                 {<HUB>-<DEST>: {...}}   per-route override
 *   }
 *
 * Pure function — no DOM, no chrome.*, no I/O. Output is deterministic for a
 * given (competitorCount, settings) tuple.
 *
 * Public API (window.RouteAssistantOrsCompetitionAdjuster):
 *   adjust({competitorCount, hub?, dest?, settings?, route?}) → weights
 *   classify(competitorCount, threshold?) → string
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.RouteAssistantOrsCompetitionAdjuster) return

    const DEFAULTS = {
        // Rank weights by competition tier.
        monopolyRankWeight:        0.00,   // ORS rank meaningless when alone
        duopolyRankWeight:         0.85,
        competitiveRankWeight:     0.70,
        saturatedRankWeight:       0.55,

        // Rating (per-leg ORS rating, 0-9 scale) weights.
        monopolyRatingWeight:      0.10,
        duopolyRatingWeight:       0.60,
        competitiveRatingWeight:   0.75,
        saturatedRatingWeight:     0.90,

        // Service profile weight — how much should the recommended service
        // tier (catering/comfort) be nudged toward "premium" by competition?
        monopolyServiceWeight:     0.20,
        duopolyServiceWeight:      0.55,
        competitiveServiceWeight:  0.70,
        saturatedServiceWeight:    0.85,

        // Elasticity scale — multiplier applied to the route's measured
        // price elasticity. >1 means more price-sensitive (saturated markets);
        // <1 means less (monopoly).
        elasticityScaleMonopoly:    0.50,
        elasticityScaleDuopoly:     1.00,
        elasticityScaleCompetitive: 1.20,
        elasticityScaleSaturated:   1.40,

        // Tier thresholds.
        competitiveCountThreshold: 3,   // 3+ competitors classified competitive
        saturatedCountThreshold:   5,   // 5+ classified saturated

        overrides: null
    }

    function _num(v, fallback) {
        const n = Number(v)
        return Number.isFinite(n) ? n : fallback
    }

    function _clamp01(n) {
        if (!Number.isFinite(n)) return 0
        return Math.max(0, Math.min(1, n))
    }

    function _clampRange(v, min, max, fallback) {
        const n = Number(v)
        if (!Number.isFinite(n)) return fallback
        return Math.max(min, Math.min(max, n))
    }

    function _scaleTierWeights(out, tier, factor) {
        if (!Number.isFinite(factor) || Math.abs(factor - 1) < 1e-9) return
        const keys = [
            tier + "RankWeight",
            tier + "RatingWeight",
            tier + "ServiceWeight"
        ]
        for (const k of keys) out[k] = _clamp01(_num(out[k], 0) * factor)
    }

    function _applyPlaystyle(out, s) {
        if (!s || typeof s !== "object") return
        const raw = String(s.playstyle || "").toLowerCase()
        const mode = /^(adaptive|balanced|monopoly|competitive|premium)$/.test(raw)
            ? raw : "adaptive"
        if (mode === "balanced") return

        const mono = _clampRange(s.monopolyOrsMultiplier, 0, 2, 0.35)
        const comp = _clampRange(s.competitiveOrsMultiplier, 0, 3, 1.35)

        if (mode === "monopoly") {
            for (const tier of ["monopoly", "duopoly", "competitive", "saturated"]) {
                _scaleTierWeights(out, tier, mono)
            }
            out.playstyle = mode
            return
        }

        if (mode === "competitive" || mode === "premium") {
            for (const tier of ["monopoly", "duopoly", "competitive", "saturated"]) {
                _scaleTierWeights(out, tier, comp)
            }
            out.playstyle = mode
            return
        }

        // Adaptive: suppress ORS/service pressure on monopoly lanes, leave
        // duopoly at baseline, and push contested lanes toward the user's
        // competitive multiplier. This mirrors settings.ors playstyle while
        // still preserving the tier-specific rank/service shape.
        _scaleTierWeights(out, "monopoly", mono)
        _scaleTierWeights(out, "competitive", comp)
        _scaleTierWeights(out, "saturated", comp)
        out.playstyle = mode
    }

    function _mergeSettings(s) {
        const out = Object.assign({}, DEFAULTS)
        if (!s || typeof s !== "object") return out
        _applyPlaystyle(out, s)
        for (const k of Object.keys(DEFAULTS)) {
            if (k === "overrides") continue
            if (s[k] != null) {
                const n = Number(s[k])
                if (Number.isFinite(n)) out[k] = n
            }
        }
        if (s.overrides && typeof s.overrides === "object") out.overrides = s.overrides
        return out
    }

    /**
     * Classify by competitor count. "monopoly" when there's no competitor on
     * the route; "duopoly" with exactly 1; "competitive" with 2 up to the
     * saturated threshold; "saturated" beyond that.
     */
    function classify(competitorCount, opts) {
        const o = _mergeSettings(opts)
        const n = Math.max(0, Math.floor(_num(competitorCount, 0)))
        if (n === 0) return "monopoly"
        if (n === 1) return "duopoly"
        if (n >= o.saturatedCountThreshold) return "saturated"
        if (n >= o.competitiveCountThreshold) return "competitive"
        return "competitive"  // 2 also competitive (just below threshold)
    }

    function _ratesForTier(tier, o) {
        switch (tier) {
            case "monopoly":    return {
                rank:    o.monopolyRankWeight,
                rating:  o.monopolyRatingWeight,
                service: o.monopolyServiceWeight,
                elast:   o.elasticityScaleMonopoly
            }
            case "duopoly":     return {
                rank:    o.duopolyRankWeight,
                rating:  o.duopolyRatingWeight,
                service: o.duopolyServiceWeight,
                elast:   o.elasticityScaleDuopoly
            }
            case "saturated":   return {
                rank:    o.saturatedRankWeight,
                rating:  o.saturatedRatingWeight,
                service: o.saturatedServiceWeight,
                elast:   o.elasticityScaleSaturated
            }
            default:            return {   // competitive
                rank:    o.competitiveRankWeight,
                rating:  o.competitiveRatingWeight,
                service: o.competitiveServiceWeight,
                elast:   o.elasticityScaleCompetitive
            }
        }
    }

    /**
     * Public entry. Accepts:
     *   competitorCount: number (preferred; defaults to 0)
     *   hub, dest:       string (used to look up per-route overrides)
     *   settings:        object (partial override of DEFAULTS)
     *   route:           object (optional — when present, prefers
     *                    route.competitorYsCount over competitorCount arg)
     *
     * Returns a weights envelope (see top-of-file for shape).
     */
    function adjust(input) {
        const i = input || {}
        const merged = _mergeSettings(i.settings)
        // Per-route overrides take precedence over global merged settings.
        let oForRoute = merged
        if (i.hub && i.dest && merged.overrides) {
            const key = String(i.hub).toUpperCase() + "-" + String(i.dest).toUpperCase()
            const ov  = merged.overrides[key]
            if (ov && typeof ov === "object") oForRoute = _mergeSettings(Object.assign({}, merged, ov))
        }
        // Prefer route record's count when provided (more authoritative —
        // sourced from the markets-page scrape).
        let count = _num(i.competitorCount, 0)
        const classKey = i.classKey || i.cls || i.cabinClass || null
        const byClass = i.route && i.route.competitorCountsByClass
        if (classKey && byClass && typeof byClass === "object"
                && _num(byClass[classKey], null) != null) {
            count = _num(byClass[classKey], count)
        } else if (i.route && _num(i.route.competitorYsCount, null) != null) {
            count = _num(i.route.competitorYsCount, count)
        }
        const tier = classify(count, oForRoute)
        const r    = _ratesForTier(tier, oForRoute)
        const out  = {
            competitorCount:      count,
            classification:       tier,
            playstyle:            oForRoute.playstyle || null,
            orsRankWeight:        _clamp01(r.rank),
            orsRatingWeight:      _clamp01(r.rating),
            serviceProfileWeight: _clamp01(r.service),
            priceElasticityScale: Math.max(0.1, Math.min(3, _num(r.elast, 1))),
            rationale:            _rationale(tier, count, r)
        }
        return out
    }

    function _rationale(tier, count, r) {
        const pieces = []
        pieces.push(tier + " (" + count + " competitor" + (count === 1 ? "" : "s") + ")")
        pieces.push("rank=" + r.rank.toFixed(2))
        pieces.push("rating=" + r.rating.toFixed(2))
        pieces.push("service=" + r.service.toFixed(2))
        pieces.push("elastScale=" + r.elast.toFixed(2))
        if (tier === "monopoly") pieces.push("ORS suppressed (no competitors)")
        if (tier === "saturated") pieces.push("service profile maximised")
        return pieces.join(" · ")
    }

    /**
     * Convenience: apply weights to an existing ORS-derived signal. Multiplies
     * the input signal by the appropriate weight. Used by consumers that want
     * to dampen ORS contributions without writing weight-application logic
     * themselves.
     *
     *   applyToSignal(signal, weights, kind?)  → adjusted signal
     *
     * kind: "rank" | "rating" | "service" (default "rank")
     */
    function applyToSignal(signal, weights, kind) {
        if (!Number.isFinite(signal)) return signal
        if (!weights) return signal
        const k = String(kind || "rank")
        const w = k === "rating"  ? _num(weights.orsRatingWeight, 1)
                : k === "service" ? _num(weights.serviceProfileWeight, 1)
                :                   _num(weights.orsRankWeight, 1)
        return signal * w
    }

    /**
     * Apply elasticity scale to a measured elasticity. Both inputs are
     * negative numbers (price elasticity is typically -0.5 to -3). Result
     * preserves sign.
     */
    function applyElasticityScale(elasticity, weights) {
        if (!Number.isFinite(elasticity)) return elasticity
        if (!weights || !Number.isFinite(weights.priceElasticityScale)) return elasticity
        return elasticity * weights.priceElasticityScale
    }

    window.RouteAssistantOrsCompetitionAdjuster = {
        adjust,
        classify,
        applyToSignal,
        applyElasticityScale,
        DEFAULTS
    }
})()
