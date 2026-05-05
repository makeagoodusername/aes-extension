/**
 * F slice 2 — Wave Route Fitter (Plan-as-Lens).
 *
 * Was: Wave View showed a Gantt of routes the bucket-greedy assigned, and
 * everything else dropped into an unstyled "Unplaced" strip with no
 * indication of whether it was OOR, low-fit, or just bucket-saturated.
 * Routes lived in the Table view; waves lived in Wave view; the user had to
 * mentally cross-reference both to manage their route list.
 *
 * Now: a pure scorer that ranks every scored row against an active plan and
 * categorises it as `in-plan` / `candidate` / `no-fit` / `oor`. Each row
 * carries a 0-100 fitScore + reason list + suggested wave id, so the
 * panel can render a three-column workspace where the user promotes /
 * demotes / pins routes against the plan without leaving Wave View.
 *
 * Pure functions only — no DOM, no I/O. Reuses `build.placements` and
 * `build.preset.waves[].composition` as the only sources of truth for
 * "what's in the plan" and "what capacity is spare".
 */
class RouteAssistantWaveRouteFitter {

    /**
     * Score one route's fit against the active plan.
     *
     * @param {object} row - one scoredRow from RA panel
     * @param {object} plan - output of RouteAssistantWaveOverlay.buildSchedule
     * @param {object} ctx
     *   - selectedSpec: aircraft spec (may be null)
     *   - fleetSpecs:   array of fleet specs (may be null)
     *   - hubIata:      hub
     *   - placedDests:  Set<destIata>          - routes already in plan
     *   - spareByWave:  Map<waveId, {short, medium, long}>  - capacity remaining
     *   - forcedDests:  Set<destIata>          - routes pinned to a wave
     *   - excludedDests: Set<destIata>         - routes demoted from this plan
     *   - profitMax:    number                  - top profitPerWeek across rows
     *   - rangeBuckets: object                  - preset's rangeBuckets factor
     * @returns {{
     *   fitScore: number,        // 0-100
     *   category: "in-plan"|"candidate"|"no-fit"|"oor",
     *   reasons:  Array<string>, // human-readable
     *   suggestedWaveId: string|null,
     *   bucket: string|null,
     *   breakdown: {
     *     bucketCapacity, profitPotential, demandSignal,
     *     connectionPotential, aircraftViability
     *   }
     * }}
     */
    static scoreRouteFit(row, plan, ctx) {
        const c = ctx || {}
        const result = {
            fitScore: 0,
            category: "no-fit",
            reasons:  [],
            suggestedWaveId: null,
            bucket:   null,
            breakdown: {
                bucketCapacity: 0, profitPotential: 0, demandSignal: 0,
                connectionPotential: 0, aircraftViability: 0
            },
            forced:   false,
            excluded: false
        }
        if (!row || !row.destIata) {
            result.reasons.push("missing route metadata")
            return result
        }
        const destU = String(row.destIata).toUpperCase()
        result.forced = !!(c.forcedDests && c.forcedDests.has(destU))
        result.excluded = !!(c.excludedDests && c.excludedDests.has(destU))
        const bucket = (typeof ScheduleFactors !== "undefined" && c.rangeBuckets)
            ? ScheduleFactors.bucketize(row.distanceKm
                ? ScheduleFactors.kmToNm(row.distanceKm) : 0, c.rangeBuckets)
            : null
        result.bucket = bucket

        // OOR short-circuit. The wave-overlay drops these before the
        // build runs, so the user can't easily see why; we surface the
        // reason in the route-fit panel.
        if (row.aircraftFit === "oor") {
            result.category = "oor"
            result.reasons.push("Out of range for picked aircraft.")
            result.breakdown.aircraftViability = 0
            return result
        }

        // ---- In-plan check ----
        if (c.placedDests && c.placedDests.has(destU)) {
            result.category = "in-plan"
        }

        // ---- 1. Bucket capacity (does any wave have spare slots in
        //         this route's bucket, or any spare slot for an override?) ----
        let bestSpareWaveId = null
        let bucketSpareCount = 0
        let totalSpareCount = 0
        if (bucket && c.spareByWave) {
            for (const [waveId, spare] of c.spareByWave.entries()) {
                if (spare[bucket] > 0) {
                    bucketSpareCount += spare[bucket]
                    if (!bestSpareWaveId) bestSpareWaveId = waveId
                }
                totalSpareCount += (spare.shortHaul + spare.mediumHaul + spare.longHaul)
            }
        }
        if (!bucket) {
            result.breakdown.bucketCapacity = 0
            result.reasons.push("Distance not in any range bucket.")
        } else if (bucketSpareCount > 0) {
            result.breakdown.bucketCapacity = 100
            result.suggestedWaveId = bestSpareWaveId
        } else if (totalSpareCount > 0) {
            // Plan has spare slots but not in this bucket — overrideable
            // but reduces fit.
            result.breakdown.bucketCapacity = 35
            result.reasons.push(bucket + " buckets are full in every wave.")
        } else {
            result.breakdown.bucketCapacity = 0
            result.reasons.push("Plan has no spare capacity.")
        }

        // ---- 2. Profit potential ----
        const prof = Number(row.profitPerWeek)
        if (isFinite(prof) && prof > 0 && c.profitMax > 0) {
            result.breakdown.profitPotential = Math.max(0, Math.min(100,
                Math.round((prof / c.profitMax) * 100)))
        } else if (isFinite(prof) && prof > 0) {
            result.breakdown.profitPotential = 60
        } else if (!c.selectedSpec && (!c.fleetSpecs || !c.fleetSpecs.length)) {
            // No fleet context → can't estimate profit. Use paxScore as a
            // neutral proxy so the score doesn't bottom out.
            result.breakdown.profitPotential = 50
        } else {
            result.breakdown.profitPotential = 0
            result.reasons.push("No profit estimate at current frequency.")
        }

        // ---- 3. Demand signal ----
        const pax = Number(row.paxScore)
        const cgo = Number(row.cargoScore)
        let demandComposite = 0
        if (isFinite(pax)) demandComposite = Math.max(demandComposite, pax * 10)
        if (isFinite(cgo)) demandComposite = Math.max(demandComposite, cgo * 8)
        result.breakdown.demandSignal = Math.max(0, Math.min(100, demandComposite))
        if (result.breakdown.demandSignal < 20 && (isFinite(pax) || isFinite(cgo))) {
            result.reasons.push("Demand signal is low (paxScore "
                + (isFinite(pax) ? pax : "—") + ").")
        }

        // ---- 4. Connection potential ----
        // v1 heuristic: if the plan has multiple waves with this bucket
        // open, the route could create connections; if only one wave is
        // viable, no in-plan transfer; if zero, low value.
        let waveCount = 0
        if (bucket && c.spareByWave) {
            for (const spare of c.spareByWave.values()) {
                if (spare[bucket] > 0) waveCount++
            }
        }
        if (result.category === "in-plan") {
            // Already placed — the connection potential is whatever the
            // build computed; assume moderate-to-high to reward
            // staying-in-plan.
            result.breakdown.connectionPotential = 70
        } else if (waveCount >= 2) {
            result.breakdown.connectionPotential = 80
        } else if (waveCount === 1) {
            result.breakdown.connectionPotential = 50
        } else {
            result.breakdown.connectionPotential = 25
        }

        // ---- 5. Aircraft viability ----
        if (row.aircraftFit === "optimal") {
            result.breakdown.aircraftViability = 100
        } else if (row.aircraftFit === "falloff") {
            result.breakdown.aircraftViability = 65
            result.reasons.push("Aircraft sized below optimal for this distance.")
        } else if (row.aircraftFit === null || row.aircraftFit === undefined) {
            // No fleet picked OR fit unknown — neutral.
            result.breakdown.aircraftViability = 55
        } else {
            result.breakdown.aircraftViability = 25
        }

        // ---- Weighted aggregate ----
        const b = result.breakdown
        result.fitScore = Math.round(
            b.bucketCapacity      * 0.20
          + b.profitPotential     * 0.30
          + b.demandSignal        * 0.15
          + b.connectionPotential * 0.15
          + b.aircraftViability   * 0.20
        )

        // ---- Categorisation ----
        if (result.category === "in-plan") {
            // already set
        } else if (result.fitScore >= 60 && result.suggestedWaveId) {
            result.category = "candidate"
        } else if (result.fitScore < 40 || !bucket) {
            result.category = "no-fit"
            if (!result.reasons.length) result.reasons.push("Low aggregate fit.")
        } else {
            // Bucket-saturated mid-fit routes are still no-fit (user can
            // pin via override; the panel surfaces that).
            result.category = "no-fit"
        }

        // Add a positive reason if fit is high and we don't have a
        // disqualifier — keeps the reasons column from looking empty.
        if (result.category !== "no-fit" && !result.reasons.length) {
            if (b.profitPotential >= 70) result.reasons.push("Strong profit signal.")
            else if (b.demandSignal >= 70) result.reasons.push("High demand.")
            else if (b.bucketCapacity === 100) result.reasons.push("Open slot in plan.")
        }
        if (result.excluded) result.reasons.unshift("Demoted from this wave plan.")
        if (result.forced && result.category === "in-plan") {
            result.reasons.unshift("Pinned to this wave plan.")
        }

        return result
    }

    /**
     * Categorise + rank every scoredRow against the active plan.
     *
     * @param {Array}  scoredRows
     * @param {object} plan - output of buildSchedule
     * @param {object} ctx  - {selectedSpec, fleetSpecs, hubIata, topN}
     * @returns {{
     *   inPlan:      Array<{row, fit}>,
     *   candidates:  Array<{row, fit}>,
     *   noFit:       Array<{row, fit}>,
     *   oor:         Array<{row, fit}>,
     *   spareByWave: Map<waveId, {shortHaul, mediumHaul, longHaul}>,
     *   placedDests: Set<destIata>,
     *   profitMax:   number
     * }}
     */
    static rankRoutesByPlanFit(scoredRows, plan, ctx) {
        const c = ctx || {}
        const out = {
            inPlan: [], candidates: [], noFit: [], oor: [],
            spareByWave: new Map(),
            placedDests: new Set(),
            profitMax:   0
        }
        if (!plan || !plan.preset) return out

        // Build placed/forced/excluded sets + spare-by-wave map ONCE.
        const forcedDests = new Set((plan.forcedDests || [])
            .map(d => String(d || "").toUpperCase()).filter(Boolean))
        const excludedDests = new Set((plan.excludedDests || [])
            .map(d => String(d || "").toUpperCase()).filter(Boolean))
        for (const p of (plan.placements || [])) {
            const d = String(p.route && p.route.destination || "").toUpperCase()
            if (d) out.placedDests.add(d)
            if (d && p.forced) forcedDests.add(d)
        }

        const placementCountByWaveBucket = new Map()  // "waveId:bucket" → count
        const buckets = (plan.preset.factors && plan.preset.factors.rangeBuckets) || {}
        const seenPlacement = new Set()  // dedupe outbound+inbound pair
        for (const p of (plan.placements || [])) {
            const d = String(p.route && p.route.destination || "").toUpperCase()
            const k = p.waveId + ":" + d
            if (seenPlacement.has(k)) continue
            seenPlacement.add(k)
            const bucket = (typeof ScheduleFactors !== "undefined")
                ? ScheduleFactors.bucketize(p.route.distanceNm, buckets)
                : null
            if (!bucket) continue
            const key = p.waveId + ":" + bucket
            placementCountByWaveBucket.set(key,
                (placementCountByWaveBucket.get(key) || 0) + 1)
        }
        for (const w of (plan.preset.waves || [])) {
            const comp = w.composition || {shortHaul: 0, mediumHaul: 0, longHaul: 0}
            const used = {
                shortHaul:  placementCountByWaveBucket.get(w.id + ":shortHaul")  || 0,
                mediumHaul: placementCountByWaveBucket.get(w.id + ":mediumHaul") || 0,
                longHaul:   placementCountByWaveBucket.get(w.id + ":longHaul")   || 0
            }
            out.spareByWave.set(w.id, {
                shortHaul:  Math.max(0, (comp.shortHaul  || 0) - used.shortHaul),
                mediumHaul: Math.max(0, (comp.mediumHaul || 0) - used.mediumHaul),
                longHaul:   Math.max(0, (comp.longHaul   || 0) - used.longHaul)
            })
        }

        // Profit anchor — top profitPerWeek across all rows.
        for (const row of (scoredRows || [])) {
            const p = row && Number(row.profitPerWeek)
            if (isFinite(p) && p > out.profitMax) out.profitMax = p
        }

        const fitCtx = {
            selectedSpec: c.selectedSpec,
            fleetSpecs:   c.fleetSpecs,
            hubIata:      c.hubIata,
            placedDests:  out.placedDests,
            forcedDests:  forcedDests,
            excludedDests: excludedDests,
            spareByWave:  out.spareByWave,
            profitMax:    out.profitMax,
            rangeBuckets: buckets
        }

        const topN = Math.max(1, Math.min(200, Number(c.topN) || (scoredRows || []).length || 50))
        const subset = (scoredRows || []).slice(0, topN)
        for (const row of subset) {
            const fit = RouteAssistantWaveRouteFitter.scoreRouteFit(row, plan, fitCtx)
            const entry = {row, fit}
            if      (fit.category === "in-plan")    out.inPlan.push(entry)
            else if (fit.category === "candidate")  out.candidates.push(entry)
            else if (fit.category === "oor")        out.oor.push(entry)
            else                                    out.noFit.push(entry)
        }

        // Sort each bucket by fitScore descending.
        const byScore = (a, b) => b.fit.fitScore - a.fit.fitScore
        out.inPlan.sort(byScore)
        out.candidates.sort(byScore)
        out.noFit.sort(byScore)
        out.oor.sort(byScore)
        return out
    }

    /** Convenience — color hint for a fit score (CSS hex). */
    static colorForFit(score) {
        if (score >= 75) return "#10b981"
        if (score >= 60) return "#22c55e"
        if (score >= 45) return "#fbbf24"
        if (score >= 30) return "#f97316"
        return "#ef4444"
    }

    /** Convenience — coarse label. */
    static labelForFit(score) {
        if (score >= 75) return "Excellent"
        if (score >= 60) return "Good"
        if (score >= 45) return "Fair"
        if (score >= 30) return "Weak"
        return "Poor"
    }
}
