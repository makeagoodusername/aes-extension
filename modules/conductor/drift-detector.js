"use strict"

/**
 * AesConductorDriftDetector — pure CUSUM drift test for K14.
 *
 * Maintains per-stream rolling residual state and runs a two-sided CUSUM
 * test (Page 1954). Inputs are residuals `r = observedDelta − expectedDelta`
 * pulled from K10 verdicts. Outputs whether the stream is currently in a
 * drift state and which polarity (positive bias = scenario over-predicted
 * problem; negative bias = scenario under-predicted problem). The driver
 * (drift-driver.js) owns the bus + storage; this module is pure state.
 *
 * Tunables:
 *   k = 0.5σ  reference value (half a target shift)
 *   h = 5σ    decision interval — drift declared when cumsum exceeds it
 * σ is estimated from the rolling window's empirical std (with a floor at
 * 1e-6 to avoid div-by-zero on streams that haven't varied).
 *
 * Storage shape (read/written by drift-driver):
 *   {
 *     window:     number[]       // last 50 residuals, oldest-first
 *     mean:       number          // running mean (read-only debug)
 *     stddev:     number          // running stddev (read-only debug)
 *     cusumPos:   number          // positive-side cumsum (resets on cross)
 *     cusumNeg:   number          // negative-side cumsum (resets on cross)
 *     drifted:    boolean         // true between trip and reset
 *     polarity:   "pos"|"neg"|null
 *     magnitude:  number          // cusum value at trip time
 *     lastAt:     number          // ms timestamp of last update
 *     trippedAt:  number|null     // ms timestamp of latest trip (null before any)
 *   }
 *
 * The detector self-resets on `_resetClean(state)` once 20 consecutive
 * post-trip residuals come in with cusum drained back near 0 — that's the
 * "clean window" the K11 ceiling clamp watches for.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorDriftDetector) return

    const WINDOW_CAP   = 50
    const K_FACTOR     = 0.5
    const H_FACTOR     = 5
    const CLEAN_WINDOW = 20
    const STDDEV_FLOOR = 1e-6

    function _empty() {
        return {
            window:    [],
            mean:      0,
            stddev:    0,
            cusumPos:  0,
            cusumNeg:  0,
            drifted:   false,
            polarity:  null,
            magnitude: 0,
            lastAt:    0,
            trippedAt: null
        }
    }

    function _stats(arr) {
        const n = arr.length
        if (!n) return {mean: 0, stddev: STDDEV_FLOOR}
        let sum = 0
        for (let i = 0; i < n; i++) sum += arr[i]
        const mean = sum / n
        let s2 = 0
        for (let i = 0; i < n; i++) {
            const d = arr[i] - mean
            s2 += d * d
        }
        const stddev = Math.sqrt(s2 / Math.max(1, n - 1))
        return {mean, stddev: stddev > STDDEV_FLOOR ? stddev : STDDEV_FLOOR}
    }

    function _normalize(raw) {
        const e = _empty()
        if (!raw || typeof raw !== "object") return e
        if (Array.isArray(raw.window)) e.window = raw.window.filter(v => typeof v === "number" && isFinite(v)).slice(-WINDOW_CAP)
        if (typeof raw.cusumPos === "number" && isFinite(raw.cusumPos)) e.cusumPos = Math.max(0, raw.cusumPos)
        if (typeof raw.cusumNeg === "number" && isFinite(raw.cusumNeg)) e.cusumNeg = Math.max(0, raw.cusumNeg)
        if (typeof raw.drifted === "boolean") e.drifted = raw.drifted
        if (raw.polarity === "pos" || raw.polarity === "neg") e.polarity = raw.polarity
        if (typeof raw.magnitude === "number" && isFinite(raw.magnitude)) e.magnitude = raw.magnitude
        if (typeof raw.lastAt === "number" && isFinite(raw.lastAt))  e.lastAt    = raw.lastAt
        if (typeof raw.trippedAt === "number") e.trippedAt = raw.trippedAt
        const s = _stats(e.window)
        e.mean   = s.mean
        e.stddev = s.stddev
        return e
    }

    /** Pure transform — returns {next, transition}. transition is one of
     *  null | "tripped-pos" | "tripped-neg" | "cleared".
     *  tripped-* fires once at the moment the cusum crosses h*σ; cleared
     *  fires once when the post-trip clean window completes. */
    function update(prevState, residual) {
        const next = _normalize(prevState)
        if (typeof residual !== "number" || !isFinite(residual)) {
            return {next, transition: null}
        }
        next.window.push(residual)
        if (next.window.length > WINDOW_CAP) next.window.splice(0, next.window.length - WINDOW_CAP)
        const stats = _stats(next.window)
        next.mean   = stats.mean
        next.stddev = stats.stddev
        const k = K_FACTOR * stats.stddev
        const h = H_FACTOR * stats.stddev
        next.cusumPos = Math.max(0, next.cusumPos + (residual - k))
        next.cusumNeg = Math.max(0, next.cusumNeg + (-residual - k))
        next.lastAt = Date.now()

        let transition = null
        if (!next.drifted) {
            if (next.cusumPos > h) {
                next.drifted   = true
                next.polarity  = "pos"
                next.magnitude = next.cusumPos
                next.trippedAt = next.lastAt
                transition = "tripped-pos"
            } else if (next.cusumNeg > h) {
                next.drifted   = true
                next.polarity  = "neg"
                next.magnitude = next.cusumNeg
                next.trippedAt = next.lastAt
                transition = "tripped-neg"
            }
        } else {
            // clean window: count residuals since trippedAt where cusum stays near 0
            const since = next.window.filter((_, i) => {
                // approximate — use the last CLEAN_WINDOW residuals
                return i >= next.window.length - CLEAN_WINDOW
            })
            const drained = (next.cusumPos < (h * 0.2)) && (next.cusumNeg < (h * 0.2))
            if (drained && since.length >= CLEAN_WINDOW) {
                next.drifted   = false
                next.polarity  = null
                next.magnitude = 0
                next.cusumPos  = 0
                next.cusumNeg  = 0
                transition = "cleared"
            }
        }
        return {next, transition}
    }

    function emptyState()        { return _empty() }
    function normalizeState(raw) { return _normalize(raw) }

    window.AesConductorDriftDetector = {
        update, emptyState, normalizeState,
        WINDOW_CAP, K_FACTOR, H_FACTOR, CLEAN_WINDOW
    }
})()
