"use strict"

/**
 * AES Strategy — pricing-elasticity logistic fit (Slice 9).
 *
 * Pure compute. Takes a list of `(pricePct, observedLf)` tuples for one
 * route+class and fits a logistic curve `lf(price) = L / (1 + e^(k(p−p₀)))`
 * where:
 *   L  = saturating LF (e.g. 0.95 — capacity ceiling)
 *   k  = slope (negative when raising price reduces LF — the natural
 *        direction for any non-Giffen good)
 *   p₀ = midpoint (price at which LF = L/2 — the "elasticity midpoint")
 *
 * Why logistic: empirically AS LF curves bend smoothly as price climbs;
 * a logistic captures both the saturated-low-price regime (price small
 * → LF ~ L) and the choked-high-price regime (price large → LF → 0)
 * with a single inflection point.
 *
 * The fit is a low-cost iterative descent over `(L, k, p₀)` — minimises
 * sum of squared residuals on observed LF. No external solver. Falls
 * back to a deadband-driven proposer when:
 *   - tuples < `minSamples` (default 4)
 *   - tuples don't span enough price (≤ 5 pp range)
 *   - residual after fit > `residualMaxAbs` (default 0.15)
 *
 * Public API (window.AesStrategyElasticityFit):
 *   fit(tuples, opts?) → {ok, params, confidence, midpoint, slope, residual,
 *                          samples, range, reason?}
 *
 *   suggestPriceForLfTarget(fit, lfTarget) → pricePct | null
 *   suggestPriceForElasticityMidpoint(fit) → pricePct | null
 *
 * tuples shape:
 *   [{pricePct: number, lf: number, ts?: number, weight?: number}, ...]
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyElasticityFit) return

    const DEFAULTS = {
        minSamples:      4,
        minPriceRange:   5,
        residualMaxAbs:  0.15,
        lTryRange:       [0.85, 0.92, 0.95, 0.98],
        kTryRange:       [-0.40, -0.20, -0.10, -0.06, -0.03, -0.01],
        p0SearchPad:     20,
        iterations:      40,
        confidenceTiers: {high: 0.05, medium: 0.10, low: 0.15}
    }

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _sigmoid(p, params) {
        const z = params.k * (p - params.p0)
        return params.L / (1 + Math.exp(z))
    }

    function _residual(tuples, params) {
        let sse = 0, n = 0, totalW = 0
        for (const t of tuples) {
            const w = _num(t.weight, 1)
            const pred = _sigmoid(t.pricePct, params)
            const err = pred - t.lf
            sse += w * err * err
            n++
            totalW += w
        }
        return n ? Math.sqrt(sse / Math.max(totalW, 1)) : Infinity
    }

    /**
     * Coarse-grid + local refinement. Iterates over a discrete (L, k)
     * grid, picking the p₀ that best matches each (L, k) by analytic
     * approximation, then refines p₀ with a 1-D bracket search. Returns
     * the lowest-residual params overall.
     */
    function _gridSearch(tuples, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const prices = tuples.map(t => _num(t.pricePct, 100))
        const minP = Math.min.apply(null, prices)
        const maxP = Math.max.apply(null, prices)
        const minMid = Math.max(50,  minP - o.p0SearchPad)
        const maxMid = Math.min(200, maxP + o.p0SearchPad)
        let best = null
        for (const L of o.lTryRange) {
            for (const k of o.kTryRange) {
                let bestForK = null
                const step = Math.max(1, (maxMid - minMid) / 20)
                for (let p0 = minMid; p0 <= maxMid; p0 += step) {
                    const params = {L: L, k: k, p0: p0}
                    const res = _residual(tuples, params)
                    if (!bestForK || res < bestForK.residual) {
                        bestForK = {params: params, residual: res}
                    }
                }
                // 1-D refinement around the best p0 for this (L, k).
                if (bestForK) {
                    let lo = bestForK.params.p0 - step
                    let hi = bestForK.params.p0 + step
                    for (let i = 0; i < o.iterations; i++) {
                        const m1 = lo + (hi - lo) / 3
                        const m2 = hi - (hi - lo) / 3
                        const r1 = _residual(tuples, {L: L, k: k, p0: m1})
                        const r2 = _residual(tuples, {L: L, k: k, p0: m2})
                        if (r1 < r2) hi = m2
                        else lo = m1
                    }
                    const finalP0 = (lo + hi) / 2
                    const finalParams = {L: L, k: k, p0: finalP0}
                    const finalRes = _residual(tuples, finalParams)
                    if (!best || finalRes < best.residual) {
                        best = {params: finalParams, residual: finalRes}
                    }
                }
            }
        }
        return best
    }

    function _confidenceFromResidual(residual, opts) {
        const tiers = (opts && opts.confidenceTiers) || DEFAULTS.confidenceTiers
        if (residual <= tiers.high) return "high"
        if (residual <= tiers.medium) return "medium"
        if (residual <= tiers.low) return "low"
        return "very-low"
    }

    /**
     * Apply time-decay weights to tuples — recent samples weight 1.0,
     * older samples decay by `halfLifeMs`. Mutates a copy; original
     * tuples are not touched.
     */
    function _applyTimeDecay(tuples, halfLifeMs, now) {
        if (!halfLifeMs || halfLifeMs <= 0) return tuples.slice()
        const t0 = now || Date.now()
        return tuples.map(t => {
            const ts = _num(t.ts, t0)
            const ageMs = Math.max(0, t0 - ts)
            const decay = Math.pow(0.5, ageMs / halfLifeMs)
            return Object.assign({}, t, {weight: _num(t.weight, 1) * decay})
        })
    }

    function fit(rawTuples, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        if (!Array.isArray(rawTuples) || rawTuples.length < o.minSamples) {
            return {ok: false, reason: "insufficient-samples", samples: rawTuples ? rawTuples.length : 0}
        }
        const cleaned = rawTuples
            .map(t => ({pricePct: _num(t.pricePct, NaN),
                        lf:        _num(t.lf, NaN),
                        ts:        _num(t.ts, null),
                        weight:    _num(t.weight, 1)}))
            .filter(t => isFinite(t.pricePct) && isFinite(t.lf)
                         && t.lf >= 0 && t.lf <= 1
                         && t.pricePct >= 50 && t.pricePct <= 200)
        if (cleaned.length < o.minSamples) {
            return {ok: false, reason: "after-clean-samples-" + cleaned.length, samples: cleaned.length}
        }
        const prices = cleaned.map(t => t.pricePct)
        const minP = Math.min.apply(null, prices)
        const maxP = Math.max.apply(null, prices)
        if ((maxP - minP) < o.minPriceRange) {
            return {ok: false, reason: "narrow-price-range", samples: cleaned.length,
                    range: maxP - minP}
        }
        const tuples = (o.halfLifeMs && o.halfLifeMs > 0)
            ? _applyTimeDecay(cleaned, o.halfLifeMs, o.now)
            : cleaned
        const grid = _gridSearch(tuples, o)
        if (!grid || grid.residual > o.residualMaxAbs) {
            return {ok: false, reason: "residual-too-high",
                    residual: grid ? grid.residual : null, samples: cleaned.length}
        }
        const confidence = _confidenceFromResidual(grid.residual, o)
        return {
            ok:         true,
            params:     grid.params,
            confidence: confidence,
            midpoint:   grid.params.p0,
            slope:      grid.params.k,
            saturatingLf: grid.params.L,
            residual:   grid.residual,
            samples:    cleaned.length,
            range:      {min: minP, max: maxP, span: maxP - minP}
        }
    }

    /**
     * Given a fit, suggest the price that yields a target LF. Inverts
     * the logistic; returns null when target is outside the feasible
     * range (LF > saturating, LF ≤ 0).
     */
    function suggestPriceForLfTarget(f, lfTarget) {
        if (!f || !f.ok || !f.params) return null
        const lf = Number(lfTarget)
        if (!isFinite(lf) || lf <= 0 || lf >= f.params.L) return null
        const ratio = (f.params.L / lf) - 1
        if (ratio <= 0) return null
        const z = Math.log(ratio)
        const p = f.params.p0 + (z / f.params.k)
        if (!isFinite(p)) return null
        return Math.max(50, Math.min(200, p))
    }

    /**
     * The "elasticity midpoint" — where d(lf)/d(price) is maximum (in
     * absolute terms). For a logistic, this is exactly p₀.
     */
    function suggestPriceForElasticityMidpoint(f) {
        if (!f || !f.ok || !f.params) return null
        return Math.max(50, Math.min(200, f.params.p0))
    }

    window.AesStrategyElasticityFit = {
        fit:                              fit,
        suggestPriceForLfTarget:          suggestPriceForLfTarget,
        suggestPriceForElasticityMidpoint: suggestPriceForElasticityMidpoint,
        DEFAULTS:                         Object.assign({}, DEFAULTS),
        _sigmoid:                         _sigmoid,
        _applyTimeDecay:                  _applyTimeDecay
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Synth: logistic with L=0.92, k=-0.05, p0=110 → expected midpoint ≈ 110.
            const synth = []
            const trueParams = {L: 0.92, k: -0.05, p0: 110}
            for (let p = 80; p <= 140; p += 5) {
                synth.push({pricePct: p, lf: _sigmoid(p, trueParams)})
            }
            const f = fit(synth)
            console.assert(f.ok, "[smoke s9-fit] synthetic logistic fits cleanly")
            console.assert(Math.abs(f.midpoint - 110) < 5,
                "[smoke s9-fit] recovered midpoint within 5pp of truth")
            console.assert(f.slope < 0, "[smoke s9-fit] slope is negative")

            // Insufficient samples
            const f2 = fit([{pricePct: 100, lf: 0.7}, {pricePct: 105, lf: 0.65}])
            console.assert(!f2.ok && f2.reason === "insufficient-samples",
                "[smoke s9-fit] rejects too-few samples")

            // Narrow price range
            const f3 = fit([
                {pricePct: 100, lf: 0.7}, {pricePct: 101, lf: 0.69},
                {pricePct: 102, lf: 0.68}, {pricePct: 103, lf: 0.67}
            ])
            console.assert(!f3.ok && f3.reason === "narrow-price-range",
                "[smoke s9-fit] rejects narrow price range")

            // suggestPrice round-trip
            const lfTarget = 0.5
            const suggested = suggestPriceForLfTarget(f, lfTarget)
            console.assert(suggested != null && suggested > 100 && suggested < 130,
                "[smoke s9-fit] suggestPriceForLfTarget returns sane price")

            // Time-decay weighting reduces stale tuple influence
            const decayed = _applyTimeDecay([
                {pricePct: 100, lf: 0.7, ts: Date.now() - 14 * 86400000},
                {pricePct: 100, lf: 0.7, ts: Date.now()}
            ], 7 * 86400000, Date.now())
            console.assert(decayed[0].weight < decayed[1].weight,
                "[smoke s9-fit] time-decay reduces older sample weight")
            console.assert(Math.abs(decayed[0].weight - 0.25) < 0.01,
                "[smoke s9-fit] 14d half-life-7d → weight 0.25")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
