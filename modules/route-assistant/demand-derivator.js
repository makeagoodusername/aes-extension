"use strict"

/**
 * Pure-function demand derivation for the Route Assistant — Letter K.
 *
 * Reads cached markets historic + inventory + ownPricing records and
 * produces derived scalars per route + per class. No I/O. No Chrome
 * APIs. Returns null fields when inputs are missing so callers can
 * cleanly fall back to em-dashes.
 *
 * Derivations:
 *   - paxDemandPool / cargoDemandPool  — average bookings/week across
 *                                        last N periods (capacities series)
 *   - paxAvgPrice / cargoAvgPrice      — last-N-period mean fare
 *   - paxElasticity / cargoElasticity  — log-log regression slope of
 *                                        quantity~price across the same
 *                                        window. Bounded [-3, 0]; outliers
 *                                        flagged in derivationNotes.
 *   - rmTightness                      — soldSeats / totalSeats averaged
 *                                        across the inventory's forward
 *                                        departures (0–1)
 *
 * Sourcing rules:
 *   - PAX series: prefer `byPayload.PAX` if present; otherwise sum
 *     ECONOMY + BUSINESS + FIRST per period when all three are
 *     captured. Fall back to ECONOMY alone when only one class is in
 *     the cache.
 *   - CARGO series: `byPayload.CARGO` only.
 *   - Elasticity needs at least 4 valid (capacity, price) pairs with
 *     non-zero values on both sides; otherwise null + a note.
 */
class RouteAssistantDemandDerivator {

    /** Default analysis window — last N periods of the historic series. */
    static DEFAULT_WINDOW = 12

    /** Elasticity slope is clipped to this range; values outside flag. */
    static ELASTICITY_CLIP = [-3, 0]

    /**
     * Main entry. Inputs are the cache records (or null when missing).
     *   historic: routeAssistant:markets:historic:<HUB>-<DEST>
     *   inventory: routeAssistant:inventory:<HUB>-<DEST>
     *   ownPricing: routeAssistant:markets:ownPricing:<HUB>-<DEST>
     *
     * Returns:
     *   {paxDemandPool, cargoDemandPool, paxAvgPrice, cargoAvgPrice,
     *    paxElasticity, cargoElasticity, rmTightness, derivationNotes,
     *    scrapedAt}
     */
    static derive(historic, inventory, ownPricing, opts) {
        opts = opts || {}
        const window = Math.max(2, Math.min(52, opts.window || RouteAssistantDemandDerivator.DEFAULT_WINDOW))
        const notes = []

        const out = {
            paxDemandPool:   null,
            cargoDemandPool: null,
            paxAvgPrice:     null,
            cargoAvgPrice:   null,
            paxElasticity:   null,
            cargoElasticity: null,
            rmTightness:     null,
            derivationNotes: null,
            scrapedAt:       RouteAssistantDemandDerivator._latestTimestamp(historic, inventory, ownPricing)
        }

        // ---------- Historic-derived (pool, avg price, elasticity) ----------
        const paxSeries   = RouteAssistantDemandDerivator._pickPaxSeries(historic, notes)
        const cargoSeries = RouteAssistantDemandDerivator._pickCargoSeries(historic)

        if (paxSeries) {
            const pooled = RouteAssistantDemandDerivator._averageWindow(paxSeries.capacities, window)
            const avgFare = RouteAssistantDemandDerivator._averageWindow(paxSeries.prices, window)
            out.paxDemandPool = pooled !== null ? Math.round(pooled) : null
            out.paxAvgPrice   = avgFare !== null ? Math.round(avgFare) : null
            const elast = RouteAssistantDemandDerivator._elasticity(paxSeries.capacities, paxSeries.prices, window, notes, "pax")
            out.paxElasticity = elast
        } else {
            notes.push("no pax historic series")
        }

        if (cargoSeries) {
            const pooled = RouteAssistantDemandDerivator._averageWindow(cargoSeries.capacities, window)
            const avgFare = RouteAssistantDemandDerivator._averageWindow(cargoSeries.prices, window)
            out.cargoDemandPool = pooled !== null ? Math.round(pooled) : null
            out.cargoAvgPrice   = avgFare !== null ? Math.round(avgFare) : null
            out.cargoElasticity = RouteAssistantDemandDerivator._elasticity(
                cargoSeries.capacities, cargoSeries.prices, window, notes, "cargo"
            )
        } else {
            notes.push("no cargo historic series")
        }

        // ---------- Inventory-derived (RM tightness) ----------
        out.rmTightness = RouteAssistantDemandDerivator._rmTightness(inventory, notes)

        out.derivationNotes = notes.length ? notes.join("; ") : null
        return out
    }

    static _latestTimestamp(...recs) {
        let max = null
        for (const r of recs) {
            if (r && typeof r.scrapedAt === "number" && (max === null || r.scrapedAt > max)) {
                max = r.scrapedAt
            }
        }
        return max
    }

    /**
     * PAX series — prefer the explicit `byPayload.PAX` series; fall
     * back to summing per-period ECONOMY + BUSINESS + FIRST when all
     * three are captured; finally ECONOMY alone. Returns
     * `{periods, capacities, prices}` or null.
     */
    static _pickPaxSeries(historic, notes) {
        if (!historic) return null
        const bp = historic.byPayload
        if (!bp || typeof bp !== "object") return null
        if (bp.PAX && Array.isArray(bp.PAX.periods) && bp.PAX.periods.length) return bp.PAX
        const eco = bp.ECONOMY
        const bus = bp.BUSINESS
        const fst = bp.FIRST
        if (eco && bus && fst
            && Array.isArray(eco.periods) && eco.periods.length
            && Array.isArray(bus.periods) && bus.periods.length === eco.periods.length
            && Array.isArray(fst.periods) && fst.periods.length === eco.periods.length) {
            const cap = eco.periods.map((p, i) =>
                (eco.capacities[i] || 0) + (bus.capacities[i] || 0) + (fst.capacities[i] || 0)
            )
            // Capacity-weighted average price across the three classes.
            const price = eco.periods.map((p, i) => {
                const ecoCap = eco.capacities[i] || 0
                const busCap = bus.capacities[i] || 0
                const fstCap = fst.capacities[i] || 0
                const tot = ecoCap + busCap + fstCap
                if (!tot) return 0
                return Math.round(
                    ((eco.prices[i] || 0) * ecoCap +
                     (bus.prices[i] || 0) * busCap +
                     (fst.prices[i] || 0) * fstCap) / tot
                )
            })
            return {periods: eco.periods, capacities: cap, prices: price}
        }
        if (eco && Array.isArray(eco.periods) && eco.periods.length) {
            notes && notes.push("pax pool from ECONOMY only (no PAX/B/F captured)")
            return eco
        }
        return null
    }

    /** CARGO series straight off byPayload. */
    static _pickCargoSeries(historic) {
        if (!historic || !historic.byPayload || !historic.byPayload.CARGO) return null
        const c = historic.byPayload.CARGO
        if (!Array.isArray(c.periods) || !c.periods.length) return null
        return c
    }

    /**
     * Average the last N entries of a numeric array. Returns null when
     * the array is empty / all zeros.
     */
    static _averageWindow(arr, window) {
        if (!Array.isArray(arr) || !arr.length) return null
        const slice = arr.slice(Math.max(0, arr.length - window))
        let sum = 0
        let n = 0
        for (const v of slice) {
            const num = Number(v)
            if (!isFinite(num) || num === 0) continue
            sum += num
            n++
        }
        if (!n) return null
        return sum / n
    }

    /**
     * Log-log regression slope of `quantity ~ price` over the last N
     * (capacity, price) pairs. Drops rows where either side is 0 or
     * non-finite. Slope is clipped to `ELASTICITY_CLIP`; clipped or
     * small-N results are flagged in `notes`.
     *
     * Returns null when fewer than 4 valid pairs survive — too sparse
     * to estimate.
     */
    static _elasticity(capArr, priceArr, window, notes, sideLabel) {
        if (!Array.isArray(capArr) || !Array.isArray(priceArr)) return null
        const len = Math.min(capArr.length, priceArr.length)
        if (!len) return null
        const start = Math.max(0, len - window)
        const xs = []   // log(price)
        const ys = []   // log(capacity)
        for (let i = start; i < len; i++) {
            const cap = Number(capArr[i])
            const prc = Number(priceArr[i])
            if (!isFinite(cap) || !isFinite(prc) || cap <= 0 || prc <= 0) continue
            xs.push(Math.log(prc))
            ys.push(Math.log(cap))
        }
        if (xs.length < 4) {
            notes && notes.push(sideLabel + " elasticity skipped (only " + xs.length + " valid points)")
            return null
        }
        const slope = RouteAssistantDemandDerivator._linregSlope(xs, ys)
        if (slope === null || !isFinite(slope)) return null
        const [lo, hi] = RouteAssistantDemandDerivator.ELASTICITY_CLIP
        if (slope < lo) {
            notes && notes.push(sideLabel + " elasticity clipped from " + slope.toFixed(2))
            return lo
        }
        if (slope > hi) {
            notes && notes.push(sideLabel + " elasticity clipped from " + slope.toFixed(2))
            return hi
        }
        return Math.round(slope * 100) / 100
    }

    /** Ordinary-least-squares slope of y on x. Returns null on degenerate input. */
    static _linregSlope(xs, ys) {
        const n = xs.length
        if (n < 2) return null
        let sx = 0, sy = 0
        for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i] }
        const mx = sx / n
        const my = sy / n
        let num = 0
        let den = 0
        for (let i = 0; i < n; i++) {
            const dx = xs[i] - mx
            num += dx * (ys[i] - my)
            den += dx * dx
        }
        if (den === 0) return null
        return num / den
    }

    /**
     * Average soldSeats / totalSeats across the inventory's forward
     * departures. Skips rows where either side is missing/zero.
     * Returns null when the inventory record has no usable rows.
     */
    static _rmTightness(inventory, notes) {
        if (!inventory) return null
        // Per-class summary first — coarser but every route has it
        // when any class table parsed.
        if (inventory.classes) {
            let totalCap = 0
            let totalSold = 0
            for (const cls in inventory.classes) {
                const slot = inventory.classes[cls]
                if (!slot) continue
                if (typeof slot.totalSeats === "number" && typeof slot.soldSeats === "number"
                    && slot.totalSeats > 0) {
                    totalCap  += slot.totalSeats
                    totalSold += slot.soldSeats
                }
            }
            if (totalCap > 0) return Math.round((totalSold / totalCap) * 1000) / 1000
        }
        // Fallback to per-departure rows.
        if (Array.isArray(inventory.departures) && inventory.departures.length) {
            let n = 0
            let sum = 0
            for (const d of inventory.departures) {
                if (d && typeof d.totalSeats === "number" && typeof d.sold === "number"
                    && d.totalSeats > 0) {
                    sum += d.sold / d.totalSeats
                    n++
                }
            }
            if (n) return Math.round((sum / n) * 1000) / 1000
        }
        notes && notes.push("rm tightness unavailable (no class summary or departure list)")
        return null
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantDemandDerivator
}
