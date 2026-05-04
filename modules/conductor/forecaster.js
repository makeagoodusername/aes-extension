"use strict"

/**
 * AesConductorForecaster — K15 pure-function short-horizon forecasters.
 *
 * Three primitives, each operating on a sample series and returning a
 * uniform envelope:
 *   {
 *     model:    "linear" | "ewma" | "markov",
 *     n:        number,                 // input sample count
 *     horizon:  number,                 // horizon argument echoed
 *     p10:      number | null,
 *     p50:      number | null,
 *     p90:      number | null,
 *     fit:      object,                 // model-specific diagnostics
 *     reason:   string                  // brief one-liner for UI tooltips
 *   }
 *
 * Sample shapes:
 *   - linear / ewma: [{t: epochMs, v: number}, …]   newest-last
 *   - markov:        [string, …]   ordered states; horizon counts steps
 *
 * Pure & deterministic. No I/O. Time arithmetic uses millisecond timestamps;
 * `horizonDays` is converted internally so callers don't need to think in ms.
 *
 * CI heuristic: residual std-dev × 1.2816 → P10/P90 (one-tailed normal).
 * For markov, mass per state is the forecast — p10/p50/p90 collapse to the
 * top-state probability triplet (lower/median/upper of the distribution).
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorForecaster) return

    const DAY_MS = 24 * 3600 * 1000
    const Z_80   = 1.2816                 // one-sided 80% CI multiplier

    function _num(v) { return (typeof v === "number" && isFinite(v)) ? v : null }

    function _empty(model, horizon, reason) {
        return {model, n: 0, horizon, p10: null, p50: null, p90: null, fit: {}, reason: reason || "no data"}
    }

    /** Weighted least-squares slope+intercept. Weights are 1 by default; the
     *  forecaster uses uniform weights for simplicity (extension point: pass
     *  exp-decay weights for recency bias).
     *  Returns null when degenerate (n<2 or zero variance in t). */
    function _wls(samples) {
        const n = samples.length
        if (n < 2) return null
        let sumW = 0, sumWt = 0, sumWv = 0, sumWtt = 0, sumWtv = 0
        for (const s of samples) {
            const t = _num(s && s.t), v = _num(s && s.v)
            if (t == null || v == null) continue
            const w = 1
            sumW += w; sumWt += w * t; sumWv += w * v
            sumWtt += w * t * t; sumWtv += w * t * v
        }
        if (sumW < 2) return null
        const denom = sumWtt - (sumWt * sumWt) / sumW
        if (denom === 0 || !isFinite(denom)) return null
        const slope = (sumWtv - (sumWt * sumWv) / sumW) / denom
        const intercept = (sumWv - slope * sumWt) / sumW
        return {slope, intercept}
    }

    function _residualSd(samples, fit) {
        let sse = 0, n = 0
        for (const s of samples) {
            const t = _num(s && s.t), v = _num(s && s.v)
            if (t == null || v == null) continue
            const yHat = fit.intercept + fit.slope * t
            const r = v - yHat
            sse += r * r
            n += 1
        }
        if (n < 2) return 0
        return Math.sqrt(sse / (n - 1))
    }

    /** Linear extrapolation forecaster.
     *  @param samples  [{t,v}, …] (any order; values copied internally)
     *  @param horizonDays  forecast offset from the most recent sample's t.
     *  @returns envelope */
    function forecastLinear(samples, horizonDays) {
        if (!Array.isArray(samples) || !samples.length) return _empty("linear", horizonDays, "no samples")
        const horizonMs = (typeof horizonDays === "number" ? horizonDays : 7) * DAY_MS
        const fit = _wls(samples)
        if (!fit) return _empty("linear", horizonDays, "insufficient variance")
        let tMax = -Infinity
        for (const s of samples) { const t = _num(s && s.t); if (t != null && t > tMax) tMax = t }
        if (!isFinite(tMax)) return _empty("linear", horizonDays, "no timestamps")
        const tHat = tMax + horizonMs
        const p50  = fit.intercept + fit.slope * tHat
        const sd   = _residualSd(samples, fit)
        const band = sd * Z_80
        return {
            model:   "linear",
            n:       samples.length,
            horizon: horizonDays,
            p10:     p50 - band,
            p50:     p50,
            p90:     p50 + band,
            fit:     {slope: fit.slope, intercept: fit.intercept, sd: sd},
            reason:  "linear extrapolation; sd=" + sd.toFixed(2)
        }
    }

    /** EWMA forward-projection. The forecaster computes EWMA + a trend term
     *  (slope of the last-half mean vs first-half mean) and projects the
     *  trend across the horizon. Residual sd from the smoothed series. */
    function forecastEWMA(samples, horizonDays, alpha) {
        if (!Array.isArray(samples) || !samples.length) return _empty("ewma", horizonDays, "no samples")
        if (typeof alpha !== "number" || !isFinite(alpha) || alpha <= 0 || alpha >= 1) alpha = 0.3
        const sorted = samples.slice().filter(s => _num(s && s.t) != null && _num(s && s.v) != null)
            .sort((a, b) => a.t - b.t)
        if (!sorted.length) return _empty("ewma", horizonDays, "no usable samples")
        let mean = sorted[0].v
        const smooth = [mean]
        for (let i = 1; i < sorted.length; i++) {
            mean = alpha * sorted[i].v + (1 - alpha) * mean
            smooth.push(mean)
        }
        let sse = 0
        for (let i = 0; i < sorted.length; i++) {
            const r = sorted[i].v - smooth[i]
            sse += r * r
        }
        const sd = Math.sqrt(sse / Math.max(sorted.length - 1, 1))
        const half = Math.floor(sorted.length / 2)
        let trendPerMs = 0
        if (half >= 1 && sorted.length - half >= 1) {
            let firstSum = 0, firstT = 0, lastSum = 0, lastT = 0
            for (let i = 0; i < half; i++)             { firstSum += sorted[i].v; firstT += sorted[i].t }
            for (let i = half; i < sorted.length; i++) { lastSum  += sorted[i].v; lastT  += sorted[i].t }
            const firstMean = firstSum / half
            const lastMean  = lastSum  / (sorted.length - half)
            const firstTAvg = firstT   / half
            const lastTAvg  = lastT    / (sorted.length - half)
            const dt = lastTAvg - firstTAvg
            trendPerMs = dt > 0 ? (lastMean - firstMean) / dt : 0
        }
        const horizonMs = (typeof horizonDays === "number" ? horizonDays : 7) * DAY_MS
        const p50 = mean + trendPerMs * horizonMs
        const band = sd * Z_80
        return {
            model:   "ewma",
            n:       sorted.length,
            horizon: horizonDays,
            p10:     p50 - band,
            p50:     p50,
            p90:     p50 + band,
            fit:     {alpha, mean, trendPerMs, sd},
            reason:  "EWMA α=" + alpha + " trend=" + trendPerMs.toExponential(2) + "/ms"
        }
    }

    /** Markov first-order forecaster over a categorical series. Returns the
     *  state-probability vector at `horizonSteps` and folds it into the same
     *  envelope (p10/p50/p90 = 0.1/0.5/0.9 quantiles of the most-likely state
     *  probability). `topState` exposed in `fit` for callers that need the
     *  argmax. */
    function forecastMarkov(stateSeries, horizonSteps) {
        if (!Array.isArray(stateSeries) || stateSeries.length < 2) {
            return _empty("markov", horizonSteps, "need ≥2 states")
        }
        const states = []
        const indexOf = new Map()
        for (const s of stateSeries) {
            const id = String(s)
            if (!indexOf.has(id)) { indexOf.set(id, states.length); states.push(id) }
        }
        const k = states.length
        const counts = []
        for (let i = 0; i < k; i++) {
            counts.push(new Array(k).fill(0))
        }
        for (let i = 1; i < stateSeries.length; i++) {
            const a = indexOf.get(String(stateSeries[i - 1]))
            const b = indexOf.get(String(stateSeries[i]))
            counts[a][b] += 1
        }
        const T = []
        for (let i = 0; i < k; i++) {
            const row = counts[i]
            let sum = 0
            for (let j = 0; j < k; j++) sum += row[j]
            const next = new Array(k).fill(0)
            if (sum > 0) {
                for (let j = 0; j < k; j++) next[j] = row[j] / sum
            } else {
                next[i] = 1
            }
            T.push(next)
        }
        const last = indexOf.get(String(stateSeries[stateSeries.length - 1]))
        let dist = new Array(k).fill(0); dist[last] = 1
        const steps = (typeof horizonSteps === "number" && horizonSteps > 0) ? horizonSteps : 1
        for (let step = 0; step < steps; step++) {
            const nextDist = new Array(k).fill(0)
            for (let i = 0; i < k; i++) {
                const pi = dist[i]
                if (!pi) continue
                for (let j = 0; j < k; j++) nextDist[j] += pi * T[i][j]
            }
            dist = nextDist
        }
        let topIdx = 0, topP = -1
        for (let i = 0; i < k; i++) if (dist[i] > topP) { topP = dist[i]; topIdx = i }
        const sortedP = dist.slice().sort((a, b) => a - b)
        const q = (frac) => sortedP[Math.min(k - 1, Math.max(0, Math.floor(frac * k)))]
        return {
            model:    "markov",
            n:        stateSeries.length,
            horizon:  horizonSteps,
            p10:      q(0.1),
            p50:      q(0.5),
            p90:      q(0.9),
            fit:      {states, distribution: dist, topState: states[topIdx], topProbability: topP, transitions: T},
            reason:   "Markov order-1; top=" + states[topIdx] + " p=" + topP.toFixed(2)
        }
    }

    window.AesConductorForecaster = {
        forecastLinear, forecastEWMA, forecastMarkov,
        DAY_MS, Z_80
    }
})()
