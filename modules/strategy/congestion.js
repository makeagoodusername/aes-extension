"use strict"

/**
 * AES Strategy — route congestion signal (Slice S1).
 *
 * Pure function. Derives a per-route congestion index from already-cached
 * data (ORS connection list + aggregator row) so the proposers can tilt
 * the objective without adding new scrapers:
 *   - many operators on a route → favor service differentiation over
 *     price, since price-cutting attracts a passing nod from ORS but
 *     gets matched within hours
 *   - few operators / sole-operator → favor price-leadership since the
 *     market is willing to pay
 *
 * `routeRow` shape (from RouteAssistantAggregator.buildRouteRows):
 *   {airlineCount, weeklyFlights, ownTotalFreq, ...}
 *
 * `orsRecord` shape (from RouteAssistantOrsScraper output, optional):
 *   {byClass: {ECONOMY: {totalConnections, connections: [...]}}}
 *
 * Returns:
 *   {operatorCount,           — distinct competing carriers (1..)
 *    ourFrequencyShare,        — own freq / total weekly flights (0..1)
 *    totalWeeklyCapacity,      — sum of weekly flights (route load)
 *    congestionIndex}          — 0 = uncontested, 1 = saturated
 *
 * Index formula (deliberately simple):
 *   - operator term = clamp((operatorCount - 1) / 5, 0, 1)
 *     0 ops alone, 6+ ops fully saturated
 *   - flight density = clamp(weeklyFlights / 100, 0, 1)
 *     100+ weekly flights = max density
 *   - own-share penalty = (1 - ourFrequencyShare) so dominating reduces
 *     perceived congestion (we ARE the market)
 *   - index = 0.5 * operatorTerm + 0.3 * flightDensity + 0.2 * ownSharePenalty
 *
 * Public API (window.AesStrategyCongestion):
 *   computeCongestion(routeRow, orsRecord?) → {…}
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyCongestion) return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }
    function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

    function _operatorCountFromOrs(orsRecord) {
        const econ = orsRecord && orsRecord.byClass && orsRecord.byClass.ECONOMY
        if (!econ || !Array.isArray(econ.connections)) return null
        const carriers = new Set()
        for (const c of econ.connections) {
            const legs = (c && c.legs) || []
            for (const l of legs) {
                if (!l || l.isGround) continue
                const code = l.flightCode || l.carrier || null
                if (code) carriers.add(String(code).slice(0, 3).toUpperCase())
            }
        }
        return carriers.size || null
    }

    function computeCongestion(routeRow, orsRecord) {
        const operatorCount = _num(routeRow && routeRow.airlineCount, null)
            ?? _operatorCountFromOrs(orsRecord)
            ?? 0
        const weeklyFlights = Math.max(0, _num(routeRow && routeRow.weeklyFlights, 0))
        const ownFreq       = Math.max(0, _num(routeRow && (routeRow.ownTotalFreq || routeRow.ownPaxFreq), 0))
        const ourFrequencyShare = weeklyFlights > 0
            ? _clamp(ownFreq / weeklyFlights, 0, 1)
            : (ownFreq > 0 ? 1 : 0)

        const operatorTerm = _clamp((operatorCount - 1) / 5, 0, 1)
        const flightDensity = _clamp(weeklyFlights / 100, 0, 1)
        const ownSharePenalty = 1 - ourFrequencyShare

        const congestionIndex = _clamp(
            0.5 * operatorTerm
            + 0.3 * flightDensity
            + 0.2 * ownSharePenalty,
            0, 1
        )

        return {
            operatorCount:       operatorCount,
            ourFrequencyShare:   ourFrequencyShare,
            totalWeeklyCapacity: weeklyFlights,
            congestionIndex:     congestionIndex
        }
    }

    window.AesStrategyCongestion = {
        computeCongestion: computeCongestion
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const empty = computeCongestion({}, null)
            console.assert(empty.operatorCount === 0,    "[smoke cong] empty row → 0 ops")
            console.assert(empty.congestionIndex === 0,  "[smoke cong] empty row → 0 index")

            const heavy = computeCongestion({airlineCount: 8, weeklyFlights: 120, ownTotalFreq: 7})
            console.assert(heavy.operatorCount === 8,            "[smoke cong] 8 ops captured")
            console.assert(heavy.congestionIndex > 0.7,          "[smoke cong] heavy → high index")

            const sole = computeCongestion({airlineCount: 1, weeklyFlights: 14, ownTotalFreq: 14})
            console.assert(sole.ourFrequencyShare === 1,         "[smoke cong] sole-op share = 1")
            console.assert(sole.congestionIndex < 0.2,           "[smoke cong] sole-op → low index")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
