"use strict"

/**
 * Track 4 — Slot optimizer for the AFP auto-scheduler.
 *
 * Mounts on `/app/fleets/aircraft/<id>/0` via the AFP family content-script
 * block. Pure module — no DOM, no chrome.storage I/O of its own (presets
 * are read/written through `SchedulePresets`, the existing CRUD wrapper).
 *
 * The optimizer takes a wave preset whose wave windows may not match this
 * hub's demand peaks and produces a *tweaked* preset where wave start
 * times have been shifted to fit the demand profile derived from the
 * candidate set. The tweaked preset feeds into Track 3's allocator
 * (`AesAfpAutoScheduler.run`) and ships behind the same `autoScheduler`
 * tier gate.
 *
 * Public API (window.SlotOptimizer):
 *   .demandProfile({candidates, hubIata}) → Array<{hour, demandWeight}>
 *   .proposeAdjustments({preset, demandProfile}) → Array<TweakedPreset>
 *   .filterFeasible(proposals, {selectedSpec, candidates}) → Array<TweakedPreset>
 *   .selectBest(proposals, {candidates, spec, ctx, budget}) → Promise<Selection>
 *   .optimize({aircraftId, presetId, candidates, spec, ctx, budget})
 *     → Promise<{savedPresetId, beforeWaves, afterWaves, scoreDelta} |
 *                {skipped: true, reason: string}>
 *
 * Tier gate:
 *   `optimize()` returns `{skipped: true, reason: "autoScheduler disabled"}`
 *   when `settings.aircraftFlightPlan.autoScheduler.enabled !== true`.
 *   The other helpers are pure — diagnostics-callable while disabled.
 *
 * Reuses (read-only):
 *   ScheduleFactors                — parseHHMM / formatHHMM / window math
 *   ScheduleBuilder                — preset validatePreset() (slice 4c)
 *   FlightsFromStore               — per-route metadata (no per-hour freq
 *                                     in current scrape; see _hourBuckets)
 *   AesAfpAutoScheduler.run        — slice 4d scoring runs
 *   SchedulePresets                — slice 4e save tweaked variant
 *   AesAfpSettings                 — autoScheduler.enabled gate
 */

/**
 * @typedef {object} DemandHour
 * @property {number} hour 0..23 (local hour at hub)
 * @property {number} demandWeight aggregated weighted demand for that hour
 */

/**
 * @typedef {object} Wave
 * @property {string} id
 * @property {string} label
 * @property {{start:string,end:string}} arrivalWindow
 * @property {{start:string,end:string}} departureWindow
 * @property {{shortHaul:number,mediumHaul:number,longHaul:number}} composition
 */

/**
 * @typedef {object} Proposal
 * @property {Wave[]} waves modified wave list (shallow-cloned from original)
 * @property {"shift"|"split"|"merge"} source which heuristic generated it
 * @property {string} deltaDescription human-readable summary
 * @property {object} [_meta] internal scoring annotations (added by 4c/4d)
 */

;(function () {
    if (window.SlotOptimizer) return

    const MAX_PROPOSALS  = 16
    const MAX_SHIFT_MIN  = 120     // ±2h cap per the plan's 4b spec
    const SHIFT_STEP_MIN = 30
    const HOURS_PER_DAY  = 24

    // ── Slice 4a — demand profile per hour ─────────────────────────────

    /**
     * Aggregate the candidate set into a 24-hour demand histogram. Each
     * candidate contributes `paxScore + 0.5 × cargoScore` weighted by
     * `weeklyFlights` (or 1 when missing), distributed across hours via
     * the FlightsFromStore per-route `frequency` field if present —
     * today's scrape only exposes `weeklyFlights`, so we fall back to
     * a flat distribution `weight / 24`.
     *
     * Output is always a length-24 array indexed by local hour, even when
     * the candidate set is empty (downstream slices iterate it directly).
     *
     * @param {object} args
     * @param {Array} args.candidates Slice C candidate records
     * @param {string} [args.hubIata] reserved for future per-hub priors;
     *   currently unused but accepted so the public API matches the plan
     * @returns {DemandHour[]}
     */
    function demandProfile(args) {
        const out = []
        for (let h = 0; h < HOURS_PER_DAY; h++) out.push({hour: h, demandWeight: 0})
        const a = args || {}
        const candidates = Array.isArray(a.candidates) ? a.candidates : []
        if (!candidates.length) return out

        for (const cand of candidates) {
            if (!cand || typeof cand !== "object") continue
            const pax    = _num(cand.paxScore,   0)
            const cargo  = _num(cand.cargoScore, 0)
            const baseW  = pax + 0.5 * cargo
            if (!isFinite(baseW) || baseW <= 0) continue
            const wkly = _num(cand.weeklyFlights, 1)
            const weight = baseW * (wkly > 0 ? wkly : 1)

            const buckets = _hourBuckets(cand)   // length-24 distribution or null
            if (buckets) {
                let sum = 0
                for (let h = 0; h < HOURS_PER_DAY; h++) sum += buckets[h]
                if (sum > 0) {
                    for (let h = 0; h < HOURS_PER_DAY; h++) {
                        out[h].demandWeight += (buckets[h] / sum) * weight
                    }
                    continue
                }
            }
            // Flat fallback — FlightsFromStore today doesn't expose a per-route
            // `frequency` field with hour breakdowns. When it does, _hourBuckets
            // will return a non-null distribution above.
            const flat = weight / HOURS_PER_DAY
            for (let h = 0; h < HOURS_PER_DAY; h++) out[h].demandWeight += flat
        }
        return out
    }

    /**
     * Look for a per-route hourly-frequency field on the candidate's source
     * record. Returns a length-24 array of weights, or null when no per-hour
     * data is available. Defensive against shape drift — if a future scrape
     * adds `frequency` (Array<24>) or `hourMask` (Array<24>) we'll pick
     * either up automatically without code changes elsewhere.
     */
    function _hourBuckets(cand) {
        // Direct on candidate.
        const arrA = _coerce24(cand && cand.frequency)
        if (arrA) return arrA
        const arrB = _coerce24(cand && cand.hourMask)
        if (arrB) return arrB
        // Sometimes the underlying flightsfrom row is preserved as ._raw or
        // ._scoredRow.frequency; check both defensively.
        const raw = cand && (cand._raw || cand._scoredRow)
        if (raw) {
            const arrC = _coerce24(raw.frequency)
            if (arrC) return arrC
            const arrD = _coerce24(raw.hourMask)
            if (arrD) return arrD
        }
        return null
    }

    function _coerce24(v) {
        if (!Array.isArray(v) || v.length !== HOURS_PER_DAY) return null
        const out = new Array(HOURS_PER_DAY)
        for (let h = 0; h < HOURS_PER_DAY; h++) {
            const n = Number(v[h])
            out[h] = (isFinite(n) && n >= 0) ? n : 0
        }
        return out
    }

    // ── Helpers shared across slices 4b-4e ─────────────────────────────

    function _num(v, fallback) {
        const n = Number(v)
        return isFinite(n) ? n : fallback
    }

    function _cloneWaves(waves) {
        return (waves || []).map(w => JSON.parse(JSON.stringify(w)))
    }

    // ── Singleton export ────────────────────────────────────────────────

    const SlotOptimizer = {
        demandProfile:     demandProfile,
        // Slices 4b-4e populate these as they ship.
        proposeAdjustments: null,
        filterFeasible:     null,
        selectBest:         null,
        optimize:           null,
        // Internals exposed for diagnostics + tests; do not depend on these
        // from production callers.
        _internal: {
            MAX_PROPOSALS:   MAX_PROPOSALS,
            MAX_SHIFT_MIN:   MAX_SHIFT_MIN,
            SHIFT_STEP_MIN:  SHIFT_STEP_MIN,
            HOURS_PER_DAY:   HOURS_PER_DAY,
            _cloneWaves:     _cloneWaves
        }
    }
    window.SlotOptimizer = SlotOptimizer

    // ── Smoke tests (run when ?aes-debug is on; project convention,
    // mirrors grid-state.js:152). Output goes through console.assert so a
    // green console means everything passed. Cheap to keep in production
    // because the assertions are skipped when the URL flag is off.
    if (typeof window !== "undefined"
        && typeof window.location !== "undefined"
        && /[?&]aes-debug\b/.test(window.location.search || "")) {
        try {
            // Empty input → length-24 zeros.
            const empty = SlotOptimizer.demandProfile({candidates: []})
            console.assert(Array.isArray(empty) && empty.length === 24,
                "[auto-4a] empty profile is length-24")
            console.assert(empty.every(b => b.demandWeight === 0),
                "[auto-4a] empty profile is all zeros")
            console.assert(empty[0].hour === 0 && empty[23].hour === 23,
                "[auto-4a] hour indexing is 0..23")

            // Single candidate w/ no per-hour data → flat distribution.
            const one = SlotOptimizer.demandProfile({candidates: [
                {destIata: "JFK", paxScore: 10, cargoScore: 4, weeklyFlights: 7}
            ]})
            const expected = (10 + 0.5 * 4) * 7 / 24
            const drift = Math.abs(one[0].demandWeight - expected)
            console.assert(drift < 1e-9, "[auto-4a] flat fallback weight matches formula")
            const allEqual = one.every(b => Math.abs(b.demandWeight - expected) < 1e-9)
            console.assert(allEqual, "[auto-4a] flat fallback uniform across all 24 hours")

            // weeklyFlights missing → defaults to 1.
            const two = SlotOptimizer.demandProfile({candidates: [
                {destIata: "BOS", paxScore: 24, cargoScore: 0}   // weight = 24, /24 = 1 per hour
            ]})
            console.assert(Math.abs(two[5].demandWeight - 1) < 1e-9,
                "[auto-4a] weeklyFlights default = 1")

            // Per-hour buckets → respects shape.
            const buckets = new Array(24).fill(0); buckets[9] = 1; buckets[17] = 1
            const three = SlotOptimizer.demandProfile({candidates: [
                {destIata: "MCO", paxScore: 20, cargoScore: 0, weeklyFlights: 1, frequency: buckets}
            ]})
            console.assert(three[0].demandWeight === 0 && three[12].demandWeight === 0,
                "[auto-4a] off-bucket hours stay 0")
            console.assert(Math.abs(three[9].demandWeight - 10) < 1e-9
                       && Math.abs(three[17].demandWeight - 10) < 1e-9,
                "[auto-4a] per-hour buckets distribute weight (20 split over 2 hours)")

            // Bad input → defensive zeros, no throw.
            const bad = SlotOptimizer.demandProfile({candidates: [null, undefined, "junk", {}]})
            console.assert(bad.every(b => b.demandWeight === 0),
                "[auto-4a] bad candidates ignored")

            console.log("[AES afp/auto-scheduler] slot-optimizer 4a smoke tests passed")
        } catch (e) {
            console.warn("[AES auto-4a] smoke tests threw", e)
        }
    }
})()
