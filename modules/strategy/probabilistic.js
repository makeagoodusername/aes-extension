"use strict"

/**
 * AES Strategy — Probabilistic Risk Fanning (Slice 22).
 *
 * Adds risk awareness and variance calculations (Monte Carlo / confidence bands)
 * for pricing decisions.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyProbabilistic) return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    // Use Box-Muller transform to generate normally distributed numbers
    function randomNormal() {
        let u = 0, v = 0;
        while(u === 0) u = Math.random();
        while(v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    /**
     * Given a route and its historic performance, sample its expected weekly profit
     * using Monte Carlo methods to return a probabilistic distribution (P10, P50, P90).
     */
    function sampleRiskProfile(route, snapshot, opts) {
        const iters = (opts && opts.iters) || 1000

        // Use historic yield/LF variation to establish standard deviation
        let stdDevLf = 0.05 // default 5%
        let stdDevYield = 0.05 // default 5%

        if (route.orsHistory && route.orsHistory.length > 2) {
            // Very simplified mock standard deviation from historical ORS context
            const lfs = route.orsHistory.map(h => h.context && h.context.lf || 0.5)
            const meanLf = lfs.reduce((a,b) => a+b, 0) / lfs.length
            const variance = lfs.reduce((a,b) => a + Math.pow(b - meanLf, 2), 0) / lfs.length
            stdDevLf = Math.max(0.02, Math.sqrt(variance))
        }

        const baseProfit = _num(route.profitPerWeek, 0)
        if (baseProfit <= 0) return null

        const samples = new Float32Array(iters)

        for (let i = 0; i < iters; i++) {
            // Apply randomized variation
            const lfVar = 1 + (randomNormal() * stdDevLf)
            const yieldVar = 1 + (randomNormal() * stdDevYield)

            // Re-calculate mock profit
            const simulatedProfit = baseProfit * lfVar * yieldVar
            samples[i] = simulatedProfit
        }

        samples.sort()

        const p10 = samples[Math.floor(iters * 0.10)]
        const p50 = samples[Math.floor(iters * 0.50)]
        const p90 = samples[Math.floor(iters * 0.90)]

        // Calculate risk aversion term (lambda * sigma)
        const mean = samples.reduce((a,b) => a+b, 0) / iters
        const variance = samples.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / iters
        const sigma = Math.sqrt(variance)

        // Default lambda depends on risk profile (conservative=higher penalty)
        const riskProfile = (opts && opts.riskProfile) || "balanced"
        const lambdaMap = {
            "conservative": 1.5,
            "balanced": 1.0,
            "aggressive": 0.5
        }
        const lambda = lambdaMap[riskProfile] || 1.0

        const riskPenalty = lambda * sigma

        return {
            p10,
            p50,
            p90,
            sigma,
            riskPenalty,
            confidenceScore: Math.max(0, 1 - (sigma / Math.abs(p50 || 1))) // basic normalized score
        }
    }

    /**
     * Augments pricing moves with probabilistic risk bounds.
     */
    function augmentPriceMovesWithRisk(moves, snapshot, opts) {
        if (!Array.isArray(moves)) return []

        return moves.map(move => {
            let route = null;
            if (snapshot && snapshot.hubs) {
                for (const h of snapshot.hubs) {
                    if (h.iata === move.hub && Array.isArray(h.byRoute)) {
                        route = h.byRoute.find(r => r.dest === move.dest)
                        if (route) break
                    }
                }
            }

            if (route) {
                const riskProfile = sampleRiskProfile(route, snapshot, opts)
                if (riskProfile) {
                    move.riskProfile = riskProfile

                    if (!move.rationale) move.rationale = []

                    // Format for UI rationale
                    const variancePct = Math.round((riskProfile.sigma / Math.max(1, Math.abs(riskProfile.p50))) * 100)
                    move.rationale.push("[risk] " + variancePct + "% variance (P10:$" + Math.round(riskProfile.p10) + ", P90:$" + Math.round(riskProfile.p90) + ")")

                    // Optional guard: if confidence is extremely low and we are conservative, we might suppress the move.
                    if (riskProfile.confidenceScore < 0.2 && opts && opts.riskProfile === "conservative") {
                        move.applicable = false
                        move.applicableNote = "Suppressed due to high probabilistic risk variance."
                    }
                }
            }
            return move
        })
    }

    window.AesStrategyProbabilistic = {
        sampleRiskProfile,
        augmentPriceMovesWithRisk
    }
})()
