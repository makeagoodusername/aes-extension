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
     *   observations: routeAssistant:ratingObservations:<HUB>-<DEST>
     *                 — `{observations: [...]}` or null. Slice 2c — feeds
     *                 the per-route per-class rating-price elasticity
     *                 regression. Pass null when no observation log exists.
     *
     * Returns:
     *   {paxDemandPool, cargoDemandPool, paxAvgPrice, cargoAvgPrice,
     *    paxElasticity, cargoElasticity, rmTightness,
     *    ratingPriceElasticityByClass: {Y, C, F},     // null when not derivable
     *    ratingObservationCounts:      {Y, C, F},     // post-filter survivors
     *    ratingDerivationNotes:        [...],         // per-class skip/clip reasons
     *    derivationNotes, scrapedAt}
     *
     * Backwards-compat: when called with the legacy 4-arg signature
     * (historic, inventory, ownPricing, opts), the 4th argument is
     * detected as opts (no `observations` array) and the rating
     * regression returns nulls. The legacy demand-depth fields stay
     * exactly as they were.
     */
    static derive(historic, inventory, ownPricing, observations, opts) {
        // Backwards-compat: legacy 4-arg call `derive(h, i, o, opts)`.
        // The observation-store record shape ALWAYS carries `.observations`
        // as an array. Anything else with no `.observations` array is opts.
        if (opts === undefined
            && observations
            && typeof observations === "object"
            && !Array.isArray(observations.observations)) {
            opts = observations
            observations = null
        }
        opts = opts || {}
        const window = Math.max(2, Math.min(52, opts.window || RouteAssistantDemandDerivator.DEFAULT_WINDOW))
        const notes = []
        const ratingNotes = []

        const out = {
            paxDemandPool:   null,
            cargoDemandPool: null,
            paxAvgPrice:     null,
            cargoAvgPrice:   null,
            paxElasticity:   null,
            cargoElasticity: null,
            rmTightness:     null,
            demandPoolByClass:     {Y: null, C: null, F: null, Cargo: null},
            avgPriceByClass:       {Y: null, C: null, F: null, Cargo: null},
            priceElasticityByClass: {Y: null, C: null, F: null, Cargo: null},
            rmTightnessByClass:    {Y: null, C: null, F: null, Cargo: null},
            ratingPriceElasticityByClass: {Y: null, C: null, F: null},
            ratingObservationCounts:      {Y: 0,    C: 0,    F: 0},
            ratingDerivationNotes:        ratingNotes,
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
            out.cargoAvgPrice   = avgFare !== null ? RouteAssistantDemandDerivator._roundAvgPrice("Cargo", avgFare) : null
            out.cargoElasticity = RouteAssistantDemandDerivator._elasticity(
                cargoSeries.capacities, cargoSeries.prices, window, notes, "cargo"
            )
        } else {
            notes.push("no cargo historic series")
        }

        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const series = RouteAssistantDemandDerivator._pickClassSeries(historic, cls)
            if (!series) continue
            const pooled = RouteAssistantDemandDerivator._averageWindow(series.capacities, window)
            const avgFare = RouteAssistantDemandDerivator._averageWindow(series.prices, window)
            out.demandPoolByClass[cls] = pooled !== null ? Math.round(pooled) : null
            out.avgPriceByClass[cls] = avgFare !== null ? RouteAssistantDemandDerivator._roundAvgPrice(cls, avgFare) : null
            out.priceElasticityByClass[cls] = RouteAssistantDemandDerivator._elasticity(
                series.capacities,
                series.prices,
                window,
                notes,
                "class " + cls
            )
        }
        if (out.demandPoolByClass.Cargo == null && out.cargoDemandPool != null) {
            out.demandPoolByClass.Cargo = out.cargoDemandPool
        }
        if (out.avgPriceByClass.Cargo == null && out.cargoAvgPrice != null) {
            out.avgPriceByClass.Cargo = out.cargoAvgPrice
        }
        if (out.priceElasticityByClass.Cargo == null && out.cargoElasticity != null) {
            out.priceElasticityByClass.Cargo = out.cargoElasticity
        }

        // ---------- Inventory-derived (RM tightness) ----------
        out.rmTightness = RouteAssistantDemandDerivator._rmTightness(inventory, notes)
        out.rmTightnessByClass = RouteAssistantDemandDerivator._rmTightnessByClass(inventory)

        // ---------- Observation-derived rating-price elasticity (slice 2c) ----------
        // Pure function of the observation log — runs the per-class
        // confounder-filter pipeline, the priceDev range + bucket gates,
        // OLS via _linregSlope, slope→magnitude negation, clip, and
        // non-monotone reject. One pass per class.
        const obsList = (observations && Array.isArray(observations.observations))
            ? observations.observations : []
        const minObs = Math.max(2, Math.min(50, Number(opts.minObservations) || 4))
        const rangeGate = (typeof opts.priceDevRangeGate === "number" && isFinite(opts.priceDevRangeGate))
            ? opts.priceDevRangeGate : 0.08
        const bucketsRequired = Math.max(2, Math.min(10, Number(opts.distinctBucketsRequired) || 2))
        for (const cls of ["Y", "C", "F"]) {
            const result = RouteAssistantDemandDerivator._ratingPriceElasticity(
                obsList, cls, ratingNotes, {minObs, rangeGate, bucketsRequired}
            )
            out.ratingPriceElasticityByClass[cls] = result.alpha
            out.ratingObservationCounts[cls]      = result.usedCount
        }

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

    static _pickClassSeries(historic, cls) {
        if (!historic || !historic.byPayload) return null
        const payload = ({Y: "ECONOMY", C: "BUSINESS", F: "FIRST", Cargo: "CARGO"})[cls]
        if (!payload) return null
        const s = historic.byPayload[payload]
        if (!s || !Array.isArray(s.periods) || !s.periods.length) return null
        return s
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

    static _rmTightnessByClass(inventory) {
        const out = {Y: null, C: null, F: null, Cargo: null}
        if (!inventory) return out
        if (inventory.classes) {
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const slot = inventory.classes[cls]
                if (!slot) continue
                const total = Number(slot.totalSeats)
                const sold = Number(slot.soldSeats)
                if (isFinite(total) && total > 0 && isFinite(sold)) {
                    out[cls] = Math.round((sold / total) * 1000) / 1000
                }
            }
        }
        if (Array.isArray(inventory.departures) && inventory.departures.length) {
            const acc = {Y: {sold: 0, total: 0}, C: {sold: 0, total: 0}, F: {sold: 0, total: 0}, Cargo: {sold: 0, total: 0}}
            for (const d of inventory.departures) {
                const byClass = d && d.classBreakdown
                if (!byClass) continue
                for (const cls of ["Y", "C", "F", "Cargo"]) {
                    const slot = byClass[cls]
                    if (!slot) continue
                    const total = Number(slot.totalSeats)
                    const sold = Number(slot.sold)
                    if (isFinite(total) && total > 0 && isFinite(sold)) {
                        acc[cls].total += total
                        acc[cls].sold += sold
                    }
                }
            }
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                if (out[cls] != null) continue
                if (acc[cls].total > 0) {
                    out[cls] = Math.round((acc[cls].sold / acc[cls].total) * 1000) / 1000
                }
            }
        }
        return out
    }

    /**
     * Slice 2c — derive a per-class rating-price elasticity α from the
     * observation log. Returns `{alpha: <number|null>, usedCount: <int>}`.
     *
     * Pipeline:
     *   1. Coerce observations into per-class (price, rating) pairs;
     *      drop any pair with a non-finite or non-positive value on
     *      either side.
     *   2. Reject obs where pricingScrapedAt and orsScrapedAt differ by
     *      >24h — fare may not match the rating snapshot.
     *   3. Reject obs where comfortLevel changed vs the prior surviving
     *      obs (comfort confounds rating shift).
     *   4. Reject obs where ownConnections[cls] changed by ≥1 vs prior
     *      (own-frequency confounds rating shift).
     *   5. Reject obs where competitorConnections[cls] jumped by >20%
     *      vs prior (competitor structure churn).
     *   6. Need ≥minObs surviving pairs; else null.
     *   7. Need range(priceDev%) ≥ rangeGate; else null + note
     *      "insufficient price variation".
     *   8. Need ≥bucketsRequired distinct priceDev% buckets at 1%
     *      rounding; else null + note.
     *   9. OLS of ratings on priceDev via _linregSlope.
     *  10. magnitude = -slope; reject when negative ("non-monotone").
     *  11. Clip to [0, 50]; note when clipped.
     *
     * Notes are pushed to `ratingNotes` as
     * `"class <cls>: <message>"` so the panel's notes footer can
     * surface every skip / clip reason per class.
     */
    static _ratingPriceElasticity(observations, cls, ratingNotes, opts) {
        opts = opts || {}
        const minObs = Math.max(2, Math.min(50, opts.minObs || 4))
        const rangeGate = (typeof opts.rangeGate === "number" && isFinite(opts.rangeGate))
            ? opts.rangeGate : 0.08
        const bucketsRequired = Math.max(2, Math.min(10, opts.bucketsRequired || 2))
        const result = {alpha: null, usedCount: 0}

        if (!Array.isArray(observations) || !observations.length) return result

        // Sort by `at` ascending so confounder filters can compare to
        // the prior surviving obs in time order.
        const sorted = observations.slice()
            .filter(o => o && typeof o.at === "number" && isFinite(o.at))
            .sort((a, b) => a.at - b.at)

        // Step 1 — extract per-class valid (price, rating) pairs.
        let dropStale = 0, dropComfort = 0, dropOwnFreq = 0, dropCompChurn = 0
        const pairs = []
        let prior = null
        for (const o of sorted) {
            const price  = Number((o.prices  || {})[cls])
            const rating = Number((o.ratings || {})[cls])
            if (!isFinite(price) || price  <= 0) continue
            if (!isFinite(rating) || rating <= 0) continue

            // Step 2 — pricing/ORS scrape time gap.
            const ps = Number(o.pricingScrapedAt)
            const os = Number(o.orsScrapedAt)
            if (isFinite(ps) && isFinite(os) && Math.abs(os - ps) > 24 * 3600 * 1000) {
                dropStale++
                continue
            }

            const own = Number(((o.ownConnections        || {})[cls]))
            const cmp = Number(((o.competitorConnections || {})[cls]))
            const comfort = (o.comfortLevel == null) ? null : Number(o.comfortLevel)

            // Steps 3 / 4 / 5 — confounder filters vs prior surviving obs.
            if (prior) {
                if (comfort != null && prior.comfort != null && comfort !== prior.comfort) {
                    dropComfort++
                    continue
                }
                if (isFinite(own) && isFinite(prior.own) && Math.abs(own - prior.own) >= 1) {
                    dropOwnFreq++
                    continue
                }
                if (isFinite(cmp) && isFinite(prior.cmp) && prior.cmp > 0) {
                    const churn = Math.abs(cmp - prior.cmp) / prior.cmp
                    if (churn > 0.20) {
                        dropCompChurn++
                        continue
                    }
                }
            }
            pairs.push({price, rating})
            prior = {own, cmp, comfort}
        }

        if (dropStale)     ratingNotes.push("class " + cls + ": " + dropStale + " obs dropped (pricing/ORS gap > 24h)")
        if (dropComfort)   ratingNotes.push("class " + cls + ": " + dropComfort + " obs dropped (comfort changed)")
        if (dropOwnFreq)   ratingNotes.push("class " + cls + ": " + dropOwnFreq + " obs dropped (own-freq changed)")
        if (dropCompChurn) ratingNotes.push("class " + cls + ": " + dropCompChurn + " obs dropped (competitor count churn > 20%)")

        result.usedCount = pairs.length

        // Step 6 — sample-size floor.
        if (pairs.length < minObs) {
            if (pairs.length > 0) {
                ratingNotes.push("class " + cls + ": only " + pairs.length + "/" + minObs + " usable observations — using fallback α")
            }
            return result
        }

        // Step 7 — priceDev range gate.
        const meanPrice = pairs.reduce((s, p) => s + p.price, 0) / pairs.length
        if (meanPrice <= 0) return result
        const priceDevs = pairs.map(p => (p.price - meanPrice) / meanPrice)
        const range = RouteAssistantDemandDerivator._priceDevRange(priceDevs)
        if (range < rangeGate) {
            ratingNotes.push("class " + cls + ": insufficient price variation (range "
                + (range * 100).toFixed(1) + "% < gate "
                + (rangeGate * 100).toFixed(0) + "%)")
            return result
        }

        // Step 8 — distinct-bucket gate.
        const buckets = RouteAssistantDemandDerivator._distinctBuckets(priceDevs)
        if (buckets < bucketsRequired) {
            ratingNotes.push("class " + cls + ": only " + buckets
                + " distinct priceDev bucket(s) — needed " + bucketsRequired)
            return result
        }

        // Step 9 — OLS slope.
        const ratings = pairs.map(p => p.rating)
        const slope = RouteAssistantDemandDerivator._linregSlope(priceDevs, ratings)
        if (slope === null || !isFinite(slope)) {
            ratingNotes.push("class " + cls + ": regression failed (degenerate input)")
            return result
        }

        // Step 10 — negate ONCE; slope is naturally negative on
        // well-behaved routes. Positive slope = rating increases with
        // price = non-monotone, which the model can't represent.
        const magnitude = -slope
        if (magnitude < 0) {
            ratingNotes.push("class " + cls + ": rating increases with price ("
                + magnitude.toFixed(2) + ", non-monotone — regression rejected)")
            return result
        }

        // Step 11 — clip to [0, 50]. The model uses positive magnitude.
        if (magnitude > 50) {
            ratingNotes.push("class " + cls + ": α=" + magnitude.toFixed(2)
                + " clipped to 50 (extreme price sensitivity)")
            result.alpha = 50
            return result
        }

        result.alpha = Math.round(magnitude * 100) / 100
        ratingNotes.push("class " + cls + ": α=" + result.alpha
            + " (derived from " + pairs.length + " observation"
            + (pairs.length === 1 ? "" : "s") + ")")
        return result
    }

    /** Range = max - min of an array. Returns 0 on empty / single-element. */
    static _priceDevRange(devs) {
        if (!Array.isArray(devs) || devs.length < 2) return 0
        let lo = Infinity, hi = -Infinity
        for (const v of devs) {
            if (!isFinite(v)) continue
            if (v < lo) lo = v
            if (v > hi) hi = v
        }
        if (!isFinite(lo) || !isFinite(hi)) return 0
        return hi - lo
    }

    /** Count distinct priceDev buckets at 1% (0.01) rounding granularity. */
    static _distinctBuckets(devs) {
        if (!Array.isArray(devs) || !devs.length) return 0
        const set = new Set()
        for (const v of devs) {
            if (!isFinite(v)) continue
            set.add(Math.round(v * 100))
        }
        return set.size
    }

    static _roundAvgPrice(cls, value) {
        const n = Number(value)
        if (!isFinite(n)) return null
        return cls === "Cargo" && Math.abs(n) < 10
            ? Math.round(n * 100) / 100
            : Math.round(n)
    }
}

if (typeof globalThis !== "undefined") {
    globalThis.RouteAssistantDemandDerivator = RouteAssistantDemandDerivator
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantDemandDerivator
}
