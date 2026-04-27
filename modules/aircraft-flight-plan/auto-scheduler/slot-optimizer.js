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

    // ── Slice 4b — slot proposal heuristic ─────────────────────────────

    /**
     * Generate up to 16 tweaked-wave proposals from a preset by trying
     * three heuristics:
     *
     *   1. shift  — slide each wave's start by ±N×30min (capped at ±2h)
     *               toward the demand peak nearest to its current centre.
     *   2. split  — when a wave's window contains a demand valley, split
     *               it into two narrower waves straddling the valley.
     *   3. merge  — when two adjacent thin waves both sit on or near the
     *               same demand peak, merge them into one wider wave.
     *
     * Per-wave shifts are capped at ±MAX_SHIFT_MIN minutes so we don't
     * blow up the user's hand-tuned intent. Total proposals capped at
     * MAX_PROPOSALS (16) — quality over enumeration; slice 4d only has
     * a small allocator-runs budget anyway.
     *
     * @param {object} args
     * @param {object} args.preset SchedulePresets record (read-only)
     * @param {DemandHour[]} args.demandProfile slice 4a output
     * @returns {Proposal[]} fresh objects; caller may mutate them safely
     */
    function proposeAdjustments(args) {
        const a = args || {}
        const preset = a.preset
        const demand = Array.isArray(a.demandProfile) ? a.demandProfile : null
        if (!preset || !Array.isArray(preset.waves) || !preset.waves.length) return []
        if (!demand || demand.length !== HOURS_PER_DAY) return []

        const proposals = []

        // 1) SHIFT — for each wave, generate ±step proposals up to ±cap.
        // Each proposal shifts ONE wave; the others stay put. We also
        // emit a "shift all toward nearest peak" composite proposal so
        // the optimizer can find a uniform-translation winner cheaply.
        for (let i = 0; i < preset.waves.length; i++) {
            const wave = preset.waves[i]
            const centreMin = _waveCentreMin(wave)
            if (!isFinite(centreMin)) continue
            const peakHour = _nearestPeakHour(demand, centreMin / 60)
            const targetMin = peakHour * 60
            const rawDelta = targetMin - centreMin
            // Quantise toward step + clamp to ±cap.
            const direction = (rawDelta >= 0) ? 1 : -1
            const absDelta = Math.min(Math.abs(rawDelta), MAX_SHIFT_MIN)
            // Try every step from SHIFT_STEP_MIN up to absDelta in this
            // direction. Skip 0-shift (would equal the original).
            for (let d = SHIFT_STEP_MIN; d <= absDelta; d += SHIFT_STEP_MIN) {
                if (proposals.length >= MAX_PROPOSALS) break
                const shifted = _shiftWaveBy(wave, direction * d)
                if (!shifted) continue
                const waves = preset.waves.slice()
                waves[i] = shifted
                proposals.push({
                    waves: waves,
                    source: "shift",
                    deltaDescription: "shifted " + (direction > 0 ? "+" : "−")
                        + d + "min toward "
                        + ScheduleFactors.formatHHMM(targetMin)
                        + " (" + (wave.label || ("wave " + (i + 1))) + ")"
                })
            }
            if (proposals.length >= MAX_PROPOSALS) break
        }

        // 2) SPLIT — find waves whose departureWindow straddles a valley
        // (demandWeight clearly below both edge hours), split into two
        // halves around the valley.
        for (let i = 0; i < preset.waves.length && proposals.length < MAX_PROPOSALS; i++) {
            const wave = preset.waves[i]
            const split = _splitWaveAcrossValley(wave, demand)
            if (!split) continue
            const waves = preset.waves.slice()
            waves.splice(i, 1, split.first, split.second)
            proposals.push({
                waves: waves,
                source: "split",
                deltaDescription: "split " + (wave.label || ("wave " + (i + 1)))
                    + " around valley at "
                    + ScheduleFactors.formatHHMM(split.valleyMin)
            })
        }

        // 3) MERGE — find adjacent wave pairs whose departure windows
        // both sit within ±2h of the SAME demand peak, merge into one
        // wider wave.
        for (let i = 0; i + 1 < preset.waves.length && proposals.length < MAX_PROPOSALS; i++) {
            const a = preset.waves[i]
            const b = preset.waves[i + 1]
            const merged = _mergeWavesIfStraddlingPeak(a, b, demand)
            if (!merged) continue
            const waves = preset.waves.slice()
            waves.splice(i, 2, merged.wave)
            proposals.push({
                waves: waves,
                source: "merge",
                deltaDescription: "merged "
                    + (a.label || ("wave " + (i + 1))) + " + "
                    + (b.label || ("wave " + (i + 2)))
                    + " around peak at "
                    + ScheduleFactors.formatHHMM(merged.peakMin)
            })
        }

        return proposals.slice(0, MAX_PROPOSALS)
    }

    /** Centre of a wave's departure window in minutes since midnight. */
    function _waveCentreMin(wave) {
        if (!wave || !wave.departureWindow) return NaN
        const s = ScheduleFactors.parseHHMM(wave.departureWindow.start)
        const e = ScheduleFactors.parseHHMM(wave.departureWindow.end)
        if (!isFinite(s) || !isFinite(e)) return NaN
        return (s + e) / 2
    }

    /**
     * Returns the integer hour 0..23 of the demand-histogram bucket with
     * the highest weight nearest the supplied hour. Ties broken by
     * absolute weight (then by closeness, then by lower hour) so the
     * choice is deterministic.
     */
    function _nearestPeakHour(demand, fromHour) {
        let best = -1
        let bestScore = -Infinity
        for (let h = 0; h < HOURS_PER_DAY; h++) {
            const w = demand[h].demandWeight
            if (!isFinite(w) || w <= 0) continue
            // Score peaks higher when both heavy and close.
            const dist = Math.abs(h - fromHour)
            const score = w - dist * 0.5
            if (score > bestScore) {
                bestScore = score
                best = h
            }
        }
        return (best >= 0) ? best : Math.round(fromHour) % HOURS_PER_DAY
    }

    /**
     * Returns a clone of `wave` with arrival + departure windows shifted
     * by `deltaMin` minutes. Returns null if either resulting window
     * would cross 00:00 / 24:00 (Phase-1: no day-wrap).
     */
    function _shiftWaveBy(wave, deltaMin) {
        if (!wave || !wave.departureWindow || !wave.arrivalWindow) return null
        const dS = ScheduleFactors.parseHHMM(wave.departureWindow.start)
        const dE = ScheduleFactors.parseHHMM(wave.departureWindow.end)
        const aS = ScheduleFactors.parseHHMM(wave.arrivalWindow.start)
        const aE = ScheduleFactors.parseHHMM(wave.arrivalWindow.end)
        if (![dS, dE, aS, aE].every(isFinite)) return null
        const newDS = dS + deltaMin
        const newDE = dE + deltaMin
        const newAS = aS + deltaMin
        const newAE = aE + deltaMin
        if (newDS < 0 || newDE > 1440) return null
        if (newAS < 0 || newAE > 1440) return null
        const clone = JSON.parse(JSON.stringify(wave))
        clone.departureWindow = {
            start: ScheduleFactors.formatHHMM(newDS),
            end:   ScheduleFactors.formatHHMM(newDE)
        }
        clone.arrivalWindow = {
            start: ScheduleFactors.formatHHMM(newAS),
            end:   ScheduleFactors.formatHHMM(newAE)
        }
        return clone
    }

    /**
     * If the wave's departure window contains a demand valley (a single
     * hour whose weight is <0.5× the average of the window's edge hours),
     * return two narrower waves split at that hour. Returns null when no
     * usable valley is found or the window is too narrow to halve.
     */
    function _splitWaveAcrossValley(wave, demand) {
        if (!wave || !wave.departureWindow) return null
        const dS = ScheduleFactors.parseHHMM(wave.departureWindow.start)
        const dE = ScheduleFactors.parseHHMM(wave.departureWindow.end)
        const aS = ScheduleFactors.parseHHMM(wave.arrivalWindow.start)
        const aE = ScheduleFactors.parseHHMM(wave.arrivalWindow.end)
        if (![dS, dE, aS, aE].every(isFinite)) return null
        if (dE - dS < 60) return null   // need ≥1h to halve

        const startHr = Math.floor(dS / 60)
        const endHr   = Math.ceil(dE / 60)
        if (endHr - startHr < 2) return null
        const edgeAvg = (demand[Math.max(0, Math.min(23, startHr))].demandWeight
                       + demand[Math.max(0, Math.min(23, endHr - 1))].demandWeight) / 2
        if (edgeAvg <= 0) return null

        let valleyHour = -1
        let valleyWeight = Infinity
        for (let h = startHr + 1; h < endHr - 1; h++) {
            const hh = Math.max(0, Math.min(23, h))
            const w = demand[hh].demandWeight
            if (w < edgeAvg * 0.5 && w < valleyWeight) {
                valleyWeight = w
                valleyHour = hh
            }
        }
        if (valleyHour < 0) return null

        const valleyMin = valleyHour * 60
        const halfWidth = Math.floor((dE - dS) / 4)   // each split half-window
        const aHalf = Math.max(15, Math.floor((aE - aS) / 4))

        const firstDS = dS
        const firstDE = Math.max(dS + 30, valleyMin - halfWidth)
        const secondDS = Math.min(dE - 30, valleyMin + halfWidth)
        const secondDE = dE
        if (firstDE <= firstDS + 15 || secondDE <= secondDS + 15) return null

        // Arrival windows: scaled in the same proportion to keep the
        // arrival-vs-departure relationship intact.
        const firstAS = aS
        const firstAE = Math.max(aS + 15, aS + Math.max(15, aHalf))
        const secondAS = Math.min(aE - 15, aE - Math.max(15, aHalf))
        const secondAE = aE
        if (firstAE <= firstAS + 10 || secondAE <= secondAS + 10) return null

        const compHalf = _halveComposition(wave.composition)
        const labelBase = wave.label || "Wave"
        const first = {
            id: wave.id + "a",
            label: labelBase + " (a)",
            arrivalWindow:   {start: ScheduleFactors.formatHHMM(firstAS),  end: ScheduleFactors.formatHHMM(firstAE)},
            departureWindow: {start: ScheduleFactors.formatHHMM(firstDS),  end: ScheduleFactors.formatHHMM(firstDE)},
            composition: compHalf.first
        }
        const second = {
            id: wave.id + "b",
            label: labelBase + " (b)",
            arrivalWindow:   {start: ScheduleFactors.formatHHMM(secondAS), end: ScheduleFactors.formatHHMM(secondAE)},
            departureWindow: {start: ScheduleFactors.formatHHMM(secondDS), end: ScheduleFactors.formatHHMM(secondDE)},
            composition: compHalf.second
        }
        return {first, second, valleyMin}
    }

    /**
     * If two waves' departure windows BOTH sit within ±2h of the same
     * demand-peak hour AND their windows are each <60min wide (i.e.
     * "thin"), return a merged wave that spans them. Returns null
     * otherwise.
     */
    function _mergeWavesIfStraddlingPeak(a, b, demand) {
        if (!a || !b || !a.departureWindow || !b.departureWindow) return null
        const aS = ScheduleFactors.parseHHMM(a.departureWindow.start)
        const aE = ScheduleFactors.parseHHMM(a.departureWindow.end)
        const bS = ScheduleFactors.parseHHMM(b.departureWindow.start)
        const bE = ScheduleFactors.parseHHMM(b.departureWindow.end)
        if (![aS, aE, bS, bE].every(isFinite)) return null
        if (aE - aS >= 60 || bE - bS >= 60) return null   // both must be thin

        // Find the highest-demand hour in the union span.
        const lo = Math.min(aS, bS)
        const hi = Math.max(aE, bE)
        if (hi - lo > MAX_SHIFT_MIN * 2) return null   // span too wide
        const startHr = Math.max(0, Math.floor(lo / 60))
        const endHr   = Math.min(HOURS_PER_DAY - 1, Math.ceil(hi / 60))
        let peakHr = -1, peakW = -Infinity
        for (let h = startHr; h <= endHr; h++) {
            const w = demand[h].demandWeight
            if (w > peakW) { peakW = w; peakHr = h }
        }
        if (peakHr < 0 || !isFinite(peakW) || peakW <= 0) return null

        const peakMin = peakHr * 60
        if (Math.abs(peakMin - (aS + aE) / 2) > MAX_SHIFT_MIN) return null
        if (Math.abs(peakMin - (bS + bE) / 2) > MAX_SHIFT_MIN) return null

        // Arrival windows similarly merged.
        const aAS = ScheduleFactors.parseHHMM(a.arrivalWindow.start)
        const aAE = ScheduleFactors.parseHHMM(a.arrivalWindow.end)
        const bAS = ScheduleFactors.parseHHMM(b.arrivalWindow.start)
        const bAE = ScheduleFactors.parseHHMM(b.arrivalWindow.end)
        if (![aAS, aAE, bAS, bAE].every(isFinite)) return null

        const composition = _addCompositions(a.composition, b.composition)
        const wave = {
            id: a.id + "-" + b.id,
            label: (a.label || "Wave") + " + " + (b.label || "Wave"),
            arrivalWindow:   {
                start: ScheduleFactors.formatHHMM(Math.min(aAS, bAS)),
                end:   ScheduleFactors.formatHHMM(Math.max(aAE, bAE))
            },
            departureWindow: {
                start: ScheduleFactors.formatHHMM(lo),
                end:   ScheduleFactors.formatHHMM(hi)
            },
            composition: composition
        }
        return {wave, peakMin}
    }

    function _halveComposition(comp) {
        const c = comp || {}
        const sh = (c.shortHaul  | 0)
        const md = (c.mediumHaul | 0)
        const lg = (c.longHaul   | 0)
        return {
            first:  {shortHaul: Math.ceil(sh / 2),  mediumHaul: Math.ceil(md / 2),  longHaul: Math.ceil(lg / 2)},
            second: {shortHaul: Math.floor(sh / 2), mediumHaul: Math.floor(md / 2), longHaul: Math.floor(lg / 2)}
        }
    }

    function _addCompositions(a, b) {
        const aa = a || {}, bb = b || {}
        return {
            shortHaul:  (aa.shortHaul  | 0) + (bb.shortHaul  | 0),
            mediumHaul: (aa.mediumHaul | 0) + (bb.mediumHaul | 0),
            longHaul:   (aa.longHaul   | 0) + (bb.longHaul   | 0)
        }
    }

    // ── Slice 4c — turnaround-feasibility filter ───────────────────────

    /**
     * Drop proposals where preset validation or per-leg turnaround/range
     * checks fail, then discard the worst quartile by feasibility-score
     * (the count of warnings each surviving proposal accrued).
     *
     * The feasibility check rebuilds each proposal's preset against the
     * supplied candidate set via the existing `ScheduleBuilder` so we
     * use the same warning catalogue (`rangeExceeded`, `slotViolation`,
     * `presetInvalid`, etc.) the user already sees in the panel.
     *
     * @param {Proposal[]} proposals
     * @param {object} ctx
     * @param {object} ctx.selectedSpec aircraft spec ({range, typeName, ...})
     * @param {Array} ctx.candidates Slice C records (need `distanceNm`/`destIata`)
     * @param {object} ctx.basePreset preset whose `factors` block + `hub`
     *   anchor every proposal; required because Proposal carries only `waves`
     * @returns {Proposal[]} survivors with `_meta.feasibilityScore` attached
     */
    function filterFeasible(proposals, ctx) {
        if (!Array.isArray(proposals) || !proposals.length) return []
        const c = ctx || {}
        const basePreset = c.basePreset
        if (!basePreset || !basePreset.factors) {
            console.warn("[AES auto-4c] filterFeasible: basePreset.factors required — bailing")
            return proposals.slice()
        }
        if (typeof ScheduleBuilder === "undefined" || typeof ScheduleFactors === "undefined") {
            console.warn("[AES auto-4c] ScheduleBuilder unavailable — bailing")
            return proposals.slice()
        }

        const candidates = Array.isArray(c.candidates) ? c.candidates : []
        const spec = c.selectedSpec || {}
        const aircraftRangeNm = (Number(spec.range) > 0)
            ? ScheduleFactors.kmToNm(Number(spec.range)) : null

        // Build the canonical "routes" array once — every proposal sees
        // the same candidate set; only the wave windows vary.
        const routes = []
        for (const cand of candidates) {
            if (!cand) continue
            const distanceNm = Number(cand.distanceNm)
                || (isFinite(Number(cand.distanceKm))
                    ? ScheduleFactors.kmToNm(Number(cand.distanceKm)) : null)
            if (!distanceNm) continue
            // Feasibility-only — drop OOR routes here so per-proposal
            // builds don't waste cycles on warnings we already know.
            if (aircraftRangeNm && !ScheduleFactors.aircraftCanFly(aircraftRangeNm, distanceNm)) continue
            routes.push({
                destination:        String(cand.destIata || "").toUpperCase(),
                distanceNm:         distanceNm,
                aircraftType:       spec.typeName || spec.name || null,
                aircraftRangeNm:    aircraftRangeNm,
                turnaroundMinutes:  Number(basePreset.factors.minTransferMinutes) || 45
            })
        }

        const scored = []
        for (const prop of proposals) {
            const synth = _composeSynthPreset(basePreset, prop.waves)
            // Cheap reject: validatePreset() flags structural breaks.
            const builder = new ScheduleBuilder(synth, {server: "", airlineCode: ""})
            const validation = builder.validatePreset()
            if (validation.length) {
                // Hard fail — drop entirely.
                continue
            }

            // Run a build to surface per-leg warnings (range / slot /
            // turnaround). The builder is greedy; it emits one warning
            // per failure with a stable `type`. We weight the types so
            // a single rangeExceeded hurts more than a slotViolation
            // (range failures mean the aircraft can't actually fly the
            // leg, which is strictly worse than a curfew bump).
            const built = builder.build(routes)
            const warnings = built.warnings || []
            let warnScore = 0
            for (const w of warnings) {
                if      (w.type === "presetInvalid") warnScore += 10
                else if (w.type === "rangeExceeded") warnScore += 4
                else if (w.type === "shortfall")     warnScore += 2
                else                                 warnScore += 1
            }
            const meta = Object.assign({}, prop._meta || {}, {
                feasibilityScore: warnScore,
                warningCount:     warnings.length,
                warningTypes:     warnings.map(w => w.type)
            })
            scored.push(Object.assign({}, prop, {_meta: meta}))
        }

        if (!scored.length) return []
        // Discard the worst quartile by feasibility score (lower = better).
        scored.sort((a, b) => (a._meta.feasibilityScore - b._meta.feasibilityScore))
        const keep = Math.max(1, Math.ceil(scored.length * 0.75))
        return scored.slice(0, keep)
    }

    /**
     * Compose a full preset by cloning the base's factors/hub/etc. but
     * substituting the supplied wave list. Caller-supplied waves win;
     * everything else falls through.
     */
    function _composeSynthPreset(base, waves) {
        return {
            id:        base.id || "synth",
            name:      (base.name || "synth") + " · proposal",
            hub:       base.hub || "",
            waves:     Array.isArray(waves) ? waves : (base.waves || []),
            factors:   JSON.parse(JSON.stringify(base.factors)),
            createdAt: Date.now(),
            updatedAt: Date.now()
        }
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
        demandProfile:      demandProfile,
        proposeAdjustments: proposeAdjustments,
        filterFeasible:     filterFeasible,
        // Slices 4d-4e populate these as they ship.
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

        // 4b — proposeAdjustments smoke tests.
        try {
            // Build a synthetic demand profile with a clear peak at 09:00
            // and a valley at 12:00 (single-peak shape).
            const dp = []
            for (let h = 0; h < 24; h++) dp.push({hour: h, demandWeight: 0})
            dp[8].demandWeight  = 5
            dp[9].demandWeight  = 10    // peak
            dp[10].demandWeight = 5
            dp[16].demandWeight = 8     // secondary peak
            dp[17].demandWeight = 12    // primary peak (later in day)

            // A mistuned preset whose wave is at 14:00 — should propose
            // shifts of ±30/60/90/120 min toward 17:00 (nearest peak).
            const preset = {
                id: "p-test",
                hub: "MCO",
                waves: [{
                    id: "w1", label: "Mid",
                    arrivalWindow:   {start: "13:00", end: "13:30"},
                    departureWindow: {start: "14:00", end: "14:30"},
                    composition: {shortHaul: 2, mediumHaul: 1, longHaul: 0}
                }],
                factors: {
                    minTransferMinutes: 45, maxTransferMinutes: 240,
                    rangeBuckets: ScheduleFactors.defaultRangeBuckets(),
                    dayPattern: "daily", dayMask: [1,1,1,1,1,1,1]
                }
            }
            const props = SlotOptimizer.proposeAdjustments({preset, demandProfile: dp})
            console.assert(Array.isArray(props), "[auto-4b] returns an array")
            console.assert(props.length > 0, "[auto-4b] generates at least one proposal for mistuned preset")
            console.assert(props.length <= 16, "[auto-4b] cap respected")
            console.assert(props.every(p => p.source === "shift" || p.source === "split" || p.source === "merge"),
                "[auto-4b] every proposal carries source")
            console.assert(props.every(p => Array.isArray(p.waves) && p.waves.length >= 1),
                "[auto-4b] every proposal carries waves")
            console.assert(props.some(p => p.source === "shift" && /\+\d+min toward 17:00/.test(p.deltaDescription)),
                "[auto-4b] at least one shift proposal targets 17:00 peak")

            // Empty preset → empty proposals.
            const propsEmpty = SlotOptimizer.proposeAdjustments({preset: {waves: []}, demandProfile: dp})
            console.assert(propsEmpty.length === 0, "[auto-4b] empty preset → empty proposals")

            // Bad demand profile → empty proposals.
            const propsBadDp = SlotOptimizer.proposeAdjustments({preset, demandProfile: null})
            console.assert(propsBadDp.length === 0, "[auto-4b] missing demand profile → empty proposals")

            // No-shift case: wave already centred on the peak → no
            // shift proposals (other heuristics may still fire).
            const onPeakPreset = {
                id: "p2", hub: "MCO",
                waves: [{
                    id: "w2", label: "Peak",
                    arrivalWindow:   {start: "16:00", end: "16:30"},
                    departureWindow: {start: "17:00", end: "17:30"},
                    composition: {shortHaul: 1, mediumHaul: 0, longHaul: 0}
                }],
                factors: preset.factors
            }
            const propsOnPeak = SlotOptimizer.proposeAdjustments({preset: onPeakPreset, demandProfile: dp})
            const shiftCount = propsOnPeak.filter(p => p.source === "shift").length
            console.assert(shiftCount === 0,
                "[auto-4b] wave already on peak → no shift proposals (got " + shiftCount + ")")

            console.log("[AES afp/auto-scheduler] slot-optimizer 4b smoke tests passed")
        } catch (e) {
            console.warn("[AES auto-4b] smoke tests threw", e)
        }

        // 4c — filterFeasible smoke tests.
        try {
            // Build a valid base preset + a few proposals; expect all to pass.
            // Connection gap (arr end → dep start) is 60min so we sit safely
            // above the default 45min minTransferMinutes; tightening past the
            // floor is what the bad-proposal sub-test exercises.
            const factors = ScheduleFactors.defaultFactors()
            const basePreset = {
                id: "p-base", hub: "MCO", name: "MCO base",
                waves: [{
                    id: "w1", label: "Mid",
                    arrivalWindow:   {start: "13:00", end: "13:30"},
                    departureWindow: {start: "14:30", end: "15:00"},
                    composition: {shortHaul: 1, mediumHaul: 0, longHaul: 0}
                }],
                factors: factors
            }
            const goodProposals = [
                {waves: basePreset.waves.slice(), source: "shift", deltaDescription: "noop"},
                {waves: [Object.assign({}, basePreset.waves[0], {
                    arrivalWindow:   {start: "12:00", end: "12:30"},
                    departureWindow: {start: "13:30", end: "14:00"}
                })], source: "shift", deltaDescription: "−60min"}
            ]
            const candidates = [
                {destIata: "JFK", distanceNm: 900,  paxScore: 10, cargoScore: 4, weeklyFlights: 7},
                {destIata: "BOS", distanceNm: 1100, paxScore: 8,  cargoScore: 2, weeklyFlights: 5}
            ]
            const spec = {range: 5000, typeName: "A320"}    // km
            const filtered = SlotOptimizer.filterFeasible(goodProposals, {
                basePreset:   basePreset,
                candidates:   candidates,
                selectedSpec: spec
            })
            console.assert(Array.isArray(filtered), "[auto-4c] returns an array")
            console.assert(filtered.length >= 1, "[auto-4c] at least one valid proposal survives")
            console.assert(filtered.every(p => p._meta && typeof p._meta.feasibilityScore === "number"),
                "[auto-4c] survivors carry _meta.feasibilityScore")

            // A structurally broken proposal (gap < minTransferMinutes) →
            // must be hard-filtered out.
            const badProposal = {
                waves: [{
                    id: "wbad", label: "Bad",
                    arrivalWindow:   {start: "13:00", end: "13:50"},
                    departureWindow: {start: "13:55", end: "14:00"},   // 5min gap, < 45min minTransfer
                    composition: {shortHaul: 1, mediumHaul: 0, longHaul: 0}
                }],
                source: "shift", deltaDescription: "broken gap"
            }
            const filteredBad = SlotOptimizer.filterFeasible([badProposal], {
                basePreset:   basePreset,
                candidates:   candidates,
                selectedSpec: spec
            })
            console.assert(filteredBad.length === 0,
                "[auto-4c] structurally invalid proposal filtered out (got " + filteredBad.length + ")")

            // Empty input → empty output.
            const filteredEmpty = SlotOptimizer.filterFeasible([], {
                basePreset:   basePreset, candidates: candidates, selectedSpec: spec
            })
            console.assert(filteredEmpty.length === 0, "[auto-4c] empty in → empty out")

            // Worst-quartile cull: 4 valid proposals with different warning
            // counts → drop the worst (count = 4 → keep 3).
            const fourProps = [
                goodProposals[0], goodProposals[1],
                {waves: basePreset.waves.slice(), source: "shift", deltaDescription: "dup1"},
                {waves: basePreset.waves.slice(), source: "shift", deltaDescription: "dup2"}
            ]
            const culled = SlotOptimizer.filterFeasible(fourProps, {
                basePreset:   basePreset, candidates: candidates, selectedSpec: spec
            })
            console.assert(culled.length === 3,
                "[auto-4c] worst quartile dropped: 4 in → 3 out (got " + culled.length + ")")

            console.log("[AES afp/auto-scheduler] slot-optimizer 4c smoke tests passed")
        } catch (e) {
            console.warn("[AES auto-4c] smoke tests threw", e)
        }
    }
})()
