"use strict"

/**
 * ORS competition-density weighting — pure function, no DOM, no I/O.
 *
 * Rationale: in AS, the customer ORS picks a flight from the available
 * options for a route. When there's only one operator (monopoly), the
 * customer has nowhere else to go — ORS rank/rating barely affects the
 * booking decision. When there are five competitors, the customer
 * actually evaluates rating + price + connections and picks the best,
 * so ORS quality matters a lot more.
 *
 * The autopricer's control-variable damper currently treats every
 * "weak ORS rank" the same — it always damps upward moves. That's
 * wrong on monopoly routes: there's no upside to fighting for ORS
 * quality on a route where you have no competition. Conversely on
 * highly-contested routes (5+ operators flying the same pair) we
 * should *amplify* the importance of ORS so the autopricer rewards
 * service-profile investments.
 *
 * Two outputs:
 *
 *   weightFromCompetitorCount(n) → number in [0..1]
 *     - n = 0         → 0.20  (monopoly, ORS barely matters)
 *     - n = 1         → 0.85  (duopoly/direct competitor, ORS matters)
 *     - n = 2         → 0.90
 *     - n = 3         → 0.95
 *     - n = 4         → 1.00
 *     - n >= 5        → 1.00  (saturated competition)
 *
 *   serviceProfileEmphasis(n) → number in [0..1]
 *     The complementary signal — for the strategy/service-profile
 *     module. Pushes service profile *higher* when contested, *lower*
 *     when monopoly. Saturates at n>=5 with 1.0.
 *
 * Pure — no I/O, no Chrome. Safe to load on any page.
 *
 * Public API:
 *   window.AesOrsCompetitionWeight = {
 *     weightFromCompetitorCount(n),
 *     serviceProfileEmphasis(n),
 *     applyToComposite(composite, competitorCount, opts?)
 *   }
 */
;(function () {
    /**
     * Anchor table — competitorCount → ORS importance multiplier.
     * Values picked so the curve is smooth and conservative:
     *   monopoly (0)      → 0.20 (ORS damper barely fires)
     *   duopoly (1 rival) → 0.85
     *   triopoly (2)      → 0.90
     *   crowded (3)       → 0.95
     *   crowded (4)       → 1.00
     *   saturated (5+)    → 1.00
     *
     * Override by passing `opts.curve = {1:0.x, 2:0.x, ...}` — keeps
     * the same monotone shape; values not in the override fall back
     * to the default. opts.cap (defaults 1.0) is the saturation
     * ceiling when n >= cap-anchor; this lets a strategy mode push
     * the cap above 1.0 for very contested routes if needed.
     */
    const DEFAULT_CURVE = {0: 0.20, 1: 0.85, 2: 0.90, 3: 0.95, 4: 1.00}
    const SATURATION_AT = 5

    function _num(v, fallback) {
        if (v === null || v === undefined || v === "") return fallback
        const n = Number(v)
        return Number.isFinite(n) ? n : fallback
    }

    function _clamp01(x) {
        return Math.max(0, Math.min(1, x))
    }

    /**
     * @param {number} competitorCount   number of distinct operators on a route
     * @param {object} [opts]
     * @param {object} [opts.curve]      override per-count anchors
     * @param {number} [opts.cap]        saturation ceiling (default 1.0)
     * @returns {number} ORS importance multiplier in [0..1] (or up to opts.cap)
     */
    function weightFromCompetitorCount(competitorCount, opts) {
        const o = opts || {}
        const curve = Object.assign({}, DEFAULT_CURVE, o.curve || {})
        const cap = _num(o.cap, 1)
        const n = Math.max(0, Math.floor(_num(competitorCount, 0)))
        if (n >= SATURATION_AT) return cap
        const anchor = curve[n]
        return _clamp01(_num(anchor, 0.20))
    }

    /**
     * Complement for the service-profile module: when contested, lift
     * the recommended service-profile target; when monopoly, lower it
     * (no point spending on ground service nobody compares).
     *
     * Symmetric with weightFromCompetitorCount but exposed separately
     * so callers don't have to know the curve is the same — the two
     * could diverge later (e.g. service-profile might saturate later
     * than the autopricer damper).
     */
    function serviceProfileEmphasis(competitorCount, opts) {
        return weightFromCompetitorCount(competitorCount, opts)
    }

    /**
     * Take an ORS composite (the object getComposite() returns) and
     * scale `ratingGapToTop` by the competition weight, returning a
     * NEW object with `effectiveRatingGapToTop` + `competitionWeight`
     * fields added. Original fields untouched. Caller decides whether
     * to use the effective gap (recommended for the autopricer
     * damper) or the raw gap (for surfacing to the user).
     *
     * The effective gap shrinks toward zero as competitorCount
     * approaches monopoly: a +25 raw gap becomes effectively +5 on a
     * monopoly route, about +21 with one direct competitor, and +25 on
     * a saturated one.
     *
     * @param {object} composite              the ors composite
     * @param {number} competitorCount        n distinct operators
     * @param {object} [opts]
     * @returns {object} new composite with extra fields
     */
    function applyToComposite(composite, competitorCount, opts) {
        const c = composite || {}
        const w = weightFromCompetitorCount(competitorCount, opts)
        const out = Object.assign({}, c, {
            competitionWeight: w,
            effectiveRatingGapToTop: c.ratingGapToTop != null
                ? c.ratingGapToTop * w
                : null
        })
        return out
    }

    const api = {
        weightFromCompetitorCount,
        serviceProfileEmphasis,
        applyToComposite,
        DEFAULT_CURVE,
        SATURATION_AT
    }

    if (typeof window !== "undefined") {
        window.AesOrsCompetitionWeight = api
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api
    }
})()
