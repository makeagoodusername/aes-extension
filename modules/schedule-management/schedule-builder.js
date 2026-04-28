/**
 * Turns a preset + a list of candidate routes into a concrete schedule.
 *
 * The builder is split into three phases so each is independently testable:
 *
 *   1. validatePreset()  — preset internal consistency (windows order,
 *      composition counts ≥ 0, slot window valid, etc.)
 *   2. assignRoutes()    — bucket routes by haul length, then place them
 *      into waves up to each wave's composition count
 *   3. evaluateFlights() — walk the placed flights and emit warnings for
 *      each factor violation (range, slot window, transfer gap)
 *
 * Phase 2's algorithm is deliberately greedy in this foundation: routes are
 * sorted by distance descending and dropped into the first wave that still
 * has capacity for that bucket. Smarter optimisers (linear programming,
 * connection-graph maximisation) can replace it later without touching
 * phases 1 or 3.
 */
class ScheduleBuilder {
    /**
     * @param {object} preset - a SchedulePresets record
     * @param {object} context - {server, airlineCode}
     */
    constructor(preset, context) {
        this.preset = preset
        this.context = context || {}
    }

    /**
     * Returns an array of human-readable strings describing structural
     * problems in the preset. Empty array = preset is OK to build with.
     */
    validatePreset() {
        const errs = []
        const p = this.preset
        if (!p) { errs.push("preset is missing"); return errs }
        if (!p.hub) errs.push("hub is not set")
        if (!Array.isArray(p.waves) || !p.waves.length) {
            errs.push("preset has no waves")
        } else {
            p.waves.forEach((w, i) => {
                const arr = ScheduleFactors.minutesBetween(w.arrivalWindow.start, w.arrivalWindow.end)
                const dep = ScheduleFactors.minutesBetween(w.departureWindow.start, w.departureWindow.end)
                if (isNaN(arr) || arr < 0) errs.push(`wave ${i+1}: arrival window is invalid`)
                if (isNaN(dep) || dep < 0) errs.push(`wave ${i+1}: departure window is invalid`)
                const gap = ScheduleFactors.minutesBetween(w.arrivalWindow.end, w.departureWindow.start)
                if (gap < (p.factors.minTransferMinutes || 0)) {
                    errs.push(`wave ${i+1}: connection gap (${gap}m) is below minTransferMinutes (${p.factors.minTransferMinutes}m)`)
                }
                for (const bucket in w.composition) {
                    if ((w.composition[bucket] | 0) < 0) {
                        errs.push(`wave ${i+1}: composition.${bucket} cannot be negative`)
                    }
                }
            })
        }
        return errs
    }

    /**
     * Greedy bucket-then-fill assignment.
     *
     * Slice E — `opts.overrides` is a `{destIata: waveId}` map (or a
     * Map). Routes named in overrides are pulled out of the haul bucket
     * and force-assigned to the named wave first, *bypassing* that
     * wave's composition capacity. The greedy fill then runs against
     * the leftover routes as before. Forced placements carry
     * `placement.forced = true` so the renderer can mark them.
     *
     * Overrides pointing at a wave id that no longer exists silently
     * fall through to the bucket — no surprise placement, no error.
     *
     * H slice 3 — `opts.optimize === true` swaps the greedy fill for
     * the connection-graph-maximising hill-climb in
     * `optimizeAssignment`. Forced overrides are still honoured first.
     *
     * @param {Array} routes - [{destination, distanceNm, aircraftType?, aircraftRangeNm?, turnaroundMinutes?}]
     * @param {object} [opts]
     *   - overrides: {destIata: waveId} map of forced placements
     *   - optimize:  boolean — switch to connection-maximising placement
     * @returns {object} {placements: [{waveId, route, direction, forced?}], unplaced, shortfall, forcedDests, optimised?, optimiseIters?, optimiseScore?}
     */
    assignRoutes(routes, opts) {
        const o = opts || {}
        if (o.mode === "profit") return this._assignRoutesProfit(routes, o)
        if (o.optimize)          return this.optimizeAssignment(routes, o)
        return this._assignRoutesGreedy(routes, o)
    }

    _assignRoutesGreedy(routes, opts) {
        const buckets = this.preset.factors.rangeBuckets
        const byBucket = {}
        for (const key in buckets) byBucket[key] = []

        for (const route of routes) {
            const bucket = ScheduleFactors.bucketize(route.distanceNm, buckets)
            if (!bucket) continue
            byBucket[bucket].push(route)
        }
        for (const key in byBucket) {
            byBucket[key].sort((a, b) => b.distanceNm - a.distanceNm)
        }

        const placements = []
        const unplaced = []
        const remaining = {}
        const forcedDests = []   // dest IATAs that took the override path

        // Slice E — forced placements from overrides. Process before the
        // greedy fill so they don't compete with capacity counts. We
        // accept either a Map or a plain object.
        const o = opts || {}
        const overrideEntries = ScheduleBuilder._coerceOverrides(o.overrides)
        if (overrideEntries.length) {
            const validWaveIds = new Set(this.preset.waves.map(w => w.id))
            for (const [destU, waveId] of overrideEntries) {
                if (!validWaveIds.has(waveId)) continue
                // Pull the route out of whichever bucket it's in.
                let pulled = null
                for (const key in byBucket) {
                    const idx = byBucket[key].findIndex(
                        r => String(r.destination || "").toUpperCase() === destU)
                    if (idx >= 0) {
                        pulled = byBucket[key].splice(idx, 1)[0]
                        break
                    }
                }
                if (!pulled) continue
                placements.push({waveId, route: pulled, direction: "outbound", forced: true})
                placements.push({waveId, route: pulled, direction: "inbound",  forced: true})
                forcedDests.push(destU)
            }
        }

        for (const wave of this.preset.waves) {
            for (const bucket in wave.composition) {
                const wantedCount = wave.composition[bucket] | 0
                for (let i = 0; i < wantedCount; i++) {
                    const route = (byBucket[bucket] || []).shift()
                    if (!route) {
                        remaining[wave.id + ":" + bucket] = (remaining[wave.id + ":" + bucket] || 0) + 1
                        continue
                    }
                    placements.push({waveId: wave.id, route: route, direction: "outbound"})
                    placements.push({waveId: wave.id, route: route, direction: "inbound"})
                }
            }
        }

        for (const key in byBucket) {
            for (const route of byBucket[key]) unplaced.push(route)
        }

        return {placements, unplaced, shortfall: remaining, forcedDests}
    }

    /**
     * H slice 3 — connection-graph-maximising placement.
     *
     * Replaces the greedy fill with a hill-climb over per-(wave, bucket)
     * route counts. The objective is the bilinear form
     *
     *     C = Σ_{(wa, wb) | A[wa][wb]} count(wa) × count(wb)
     *
     * where `count(w)` is the total routes (across all buckets) placed
     * in wave w, and `A[wa][wb] = 1` iff the gap from wa's arrival
     * midpoint to wb's departure midpoint lies in
     * [minTransferMinutes, maxTransferMinutes]. Both directions are
     * checked — most realistic presets have only forward (later-wave)
     * connections valid, but the formula degrades cleanly when a wave
     * pair is asymmetrically reachable.
     *
     * Algorithm:
     *   1. Apply forced overrides first (pinned, never moved).
     *   2. Seed with a greedy fill (matches `_assignRoutesGreedy`'s
     *      ordering: waves in preset order, buckets in composition
     *      order, routes by distance descending).
     *   3. Hill-climb: at each iteration, try moving exactly one
     *      non-forced route from (waveA, bucket) → (waveB, bucket)
     *      where waveB has spare bucket capacity. Accept the first
     *      improving move and restart the scan. Halt at local optimum
     *      or `MAX_ITERS = 200`.
     *   4. Reconstruct placements from the final per-(wave, bucket)
     *      counts.
     *
     * Approximation: scoring uses wave window MIDPOINTS for the gap
     * computation (not per-flight spread positions). The actual
     * connection count returned by `computeConnections` on the final
     * placement may differ by 5–15% — usually slightly lower because
     * spread brings some intra-wave pairs outside [minXfr, maxXfr] —
     * but the hill-climb's relative ranking is preserved.
     *
     * Capacity contract: composition counts are CAPS, not floors. The
     * optimiser may leave a wave below its `wave.composition[bucket]`
     * if moving routes elsewhere lifts the connection score. Per-wave
     * shortfall is reported only when the bucket queue exhausted before
     * total bucket capacity was reached (true "couldn't fill"); waves
     * intentionally drained to feed a higher-scoring wave do NOT show
     * shortfall. Unplaced routes (no bucket / queue overflow) still
     * surface via `unplaced[]`.
     *
     * @param {Array} routes
     * @param {object} [opts]
     *   - overrides: {destIata: waveId} forced-placement map
     *   - maxIters:  override for the hill-climb cap (default 200)
     * @returns {object} {placements, unplaced, shortfall, forcedDests,
     *   optimised: true, optimiseIters, optimiseScore}
     */
    optimizeAssignment(routes, opts) {
        const o = opts || {}
        const buckets = this.preset.factors.rangeBuckets
            || ScheduleFactors.defaultRangeBuckets()
        const bucketKeys = Object.keys(buckets)
        const waves = this.preset.waves || []

        // Bucket the input routes; sort within bucket by distanceNm
        // descending to mirror the greedy ordering.
        const queues = {}
        for (const k of bucketKeys) queues[k] = []
        for (const route of routes || []) {
            const b = ScheduleFactors.bucketize(route.distanceNm, buckets)
            if (b) queues[b].push(route)
        }
        for (const k in queues) queues[k].sort((a, b) => b.distanceNm - a.distanceNm)

        const counts = {}
        for (const wave of waves) {
            counts[wave.id] = {}
            for (const k of bucketKeys) counts[wave.id][k] = 0
        }

        const placements = []
        const forcedDests = []

        // Forced overrides — pinned, not movable by the hill-climb.
        const overrideEntries = ScheduleBuilder._coerceOverrides(o.overrides)
        if (overrideEntries.length) {
            const validWaveIds = new Set(waves.map(w => w.id))
            for (const [destU, waveId] of overrideEntries) {
                if (!validWaveIds.has(waveId)) continue
                let pulled = null
                let pulledBucket = null
                for (const k of bucketKeys) {
                    const idx = queues[k].findIndex(r =>
                        String(r.destination || "").toUpperCase() === destU)
                    if (idx >= 0) {
                        pulled = queues[k].splice(idx, 1)[0]
                        pulledBucket = k
                        break
                    }
                }
                if (!pulled) continue
                counts[waveId][pulledBucket]++
                placements.push({waveId, route: pulled, direction: "outbound", forced: true})
                placements.push({waveId, route: pulled, direction: "inbound",  forced: true})
                forcedDests.push(destU)
            }
        }

        // Greedy seed for the remaining routes. Track movables so we can
        // re-bind their wave assignment after the hill-climb finishes.
        // Each entry is [waveId, bucket, route].
        const movables = []
        for (const wave of waves) {
            for (const k of bucketKeys) {
                const wantedTotal = (wave.composition && wave.composition[k]) | 0
                const want = Math.max(0, wantedTotal - counts[wave.id][k])
                for (let i = 0; i < want; i++) {
                    const route = queues[k].shift()
                    if (!route) break
                    counts[wave.id][k]++
                    movables.push([wave.id, k, route])
                }
            }
        }
        const queueExhaustedFor = {}
        for (const k of bucketKeys) {
            queueExhaustedFor[k] = (queues[k].length === 0)
        }

        // Wave-pair adjacency over arrival/departure midpoints.
        const minXfr = Number(this.preset.factors.minTransferMinutes) || 0
        const maxXfr = Number(this.preset.factors.maxTransferMinutes) || 240
        const midpoint = (window) => {
            if (!window) return NaN
            const s = ScheduleFactors.parseHHMM(window.start)
            const e = ScheduleFactors.parseHHMM(window.end)
            return (isFinite(s) && isFinite(e)) ? (s + e) / 2 : NaN
        }
        const A = {}
        for (const wa of waves) {
            A[wa.id] = {}
            const arrMid = midpoint(wa.arrivalWindow)
            for (const wb of waves) {
                const depMid = midpoint(wb.departureWindow)
                if (!isFinite(arrMid) || !isFinite(depMid)) {
                    A[wa.id][wb.id] = 0
                    continue
                }
                const gap = depMid - arrMid
                A[wa.id][wb.id] = (gap >= minXfr && gap <= maxXfr) ? 1 : 0
            }
        }

        const totalCount = (waveId) => {
            const c = counts[waveId]
            let t = 0
            for (const k of bucketKeys) t += c[k] || 0
            return t
        }
        const scoreCounts = () => {
            let s = 0
            for (const wa of waves) {
                const a = totalCount(wa.id)
                if (!a) continue
                for (const wb of waves) {
                    if (A[wa.id][wb.id]) s += a * totalCount(wb.id)
                }
            }
            return s
        }

        const findMovable = (waveId, bucket) => {
            for (let i = 0; i < movables.length; i++) {
                if (movables[i][0] === waveId && movables[i][1] === bucket) return i
            }
            return -1
        }

        const MAX_ITERS = (typeof o.maxIters === "number" && o.maxIters > 0)
            ? o.maxIters : 200
        let bestScore = scoreCounts()
        let improved = true
        let iters = 0
        while (improved && iters < MAX_ITERS) {
            improved = false
            outer: for (const waveA of waves) {
                for (const k of bucketKeys) {
                    if (counts[waveA.id][k] === 0) continue
                    if (findMovable(waveA.id, k) < 0) continue   // only forced here — leave alone
                    for (const waveB of waves) {
                        if (waveB.id === waveA.id) continue
                        const capB = (waveB.composition && waveB.composition[k]) | 0
                        if (counts[waveB.id][k] >= capB) continue
                        counts[waveA.id][k]--
                        counts[waveB.id][k]++
                        const newScore = scoreCounts()
                        if (newScore > bestScore) {
                            bestScore = newScore
                            const idx = findMovable(waveA.id, k)
                            if (idx >= 0) movables[idx][0] = waveB.id
                            improved = true
                            break outer
                        }
                        counts[waveA.id][k]++
                        counts[waveB.id][k]--
                    }
                }
            }
            iters++
        }

        // Materialise placements from the final movable bindings.
        for (const [waveId, , route] of movables) {
            placements.push({waveId, route, direction: "outbound"})
            placements.push({waveId, route, direction: "inbound"})
        }

        const unplaced = []
        for (const k of bucketKeys) for (const r of queues[k]) unplaced.push(r)

        // Shortfall — only flag waves whose bucket couldn't be filled
        // because the QUEUE WAS EXHAUSTED, not because the optimiser
        // moved routes elsewhere. We detect "queue exhausted" via the
        // pre-optimise snapshot above; if the bucket queue ran out
        // during the greedy seed and the optimiser couldn't have
        // sourced more routes, the user genuinely needed more routes
        // of that haul-length.
        const shortfall = {}
        for (const wave of waves) {
            for (const k of bucketKeys) {
                if (!queueExhaustedFor[k]) continue
                const wanted = (wave.composition && wave.composition[k]) | 0
                const got = counts[wave.id][k]
                if (got < wanted) {
                    shortfall[wave.id + ":" + k] = wanted - got
                }
            }
        }

        return {
            placements, unplaced, shortfall, forcedDests,
            optimised:      true,
            optimiseIters:  iters,
            optimiseScore:  bestScore
        }
    }

    /**
     * F slice 3 — Per-slot profit assignment (greedy-best-marginal).
     *
     * Given a (route × wave-slot) scoring matrix from
     * `RouteAssistantWaveSlotScorer.scoreSlotFit`, walk all viable cells
     * in score-descending order, placing each route in its highest-score
     * still-available slot. Forced overrides are pinned first. Backwards
     * compatible with the rest of the pipeline — returns the same shape
     * as `_assignRoutesGreedy` plus `optimised: "profit"`.
     *
     * Composition counts are CAPS, not floors: a wave/bucket may end
     * under-filled when the route pool runs out of profitable candidates.
     * Unplaced routes (no viable slot, or scored zero) flow through the
     * normal `unplaced[]` channel so the panel's renderer surfaces them.
     *
     * Falls back to `_assignRoutesGreedy` cleanly when the scorer module
     * isn't loaded — the caller has already validated typeof
     * RouteAssistantWaveSlotScorer before passing `mode: "profit"`,
     * but the guard is here too as belt-and-braces.
     *
     * @param {Array} routes
     * @param {object} [opts]
     *   - overrides:    {destIata: waveId} forced-placement map
     *   - selectedSpec: aircraft spec (for range / availability)
     *   - fleetSpecs:   array of fleet specs
     *   - demandHourMap: optional {hour → 0-1} from Track 4's slot-optimizer
     *   - minScore:     minimum score to accept a placement (default 25)
     * @returns {object} {placements, unplaced, shortfall, forcedDests,
     *   optimised: "profit", profitScore, profitPlaced}
     */
    _assignRoutesProfit(routes, opts) {
        if (typeof RouteAssistantWaveSlotScorer === "undefined") {
            return this._assignRoutesGreedy(routes, opts)
        }
        const o = opts || {}
        const buckets = (this.preset.factors && this.preset.factors.rangeBuckets)
            || ScheduleFactors.defaultRangeBuckets()
        const bucketKeys = Object.keys(buckets)
        const waves = this.preset.waves || []
        const minScore = (typeof o.minScore === "number") ? o.minScore : 25

        const placements = []
        const forcedDests = []
        const placedDests = new Set()

        const scoringCtx = RouteAssistantWaveSlotScorer.buildScoringContext(
            this.preset, routes, {
                selectedSpec:  o.selectedSpec,
                fleetSpecs:    o.fleetSpecs,
                demandHourMap: o.demandHourMap
            }
        )

        // Forced overrides first — pin and consume the slot. Bucket-aware
        // so waveSlotsRemaining stays consistent with greedy semantics.
        const overrideEntries = ScheduleBuilder._coerceOverrides(o.overrides)
        const forcedRouteByDest = new Map()
        if (overrideEntries.length) {
            const validWaveIds = new Set(waves.map(w => w.id))
            for (const route of routes || []) {
                const destU = String(route.destination || "").toUpperCase()
                if (!destU) continue
                forcedRouteByDest.set(destU, route)
            }
            for (const [destU, waveId] of overrideEntries) {
                if (!validWaveIds.has(waveId)) continue
                const route = forcedRouteByDest.get(destU)
                if (!route) continue
                const bucket = ScheduleFactors.bucketize(route.distanceNm, buckets)
                if (!bucket) continue
                placements.push({waveId, route, direction: "outbound", forced: true})
                placements.push({waveId, route, direction: "inbound",  forced: true})
                forcedDests.push(destU)
                placedDests.add(destU)
                RouteAssistantWaveSlotScorer.consumeSlot(scoringCtx, waveId, bucket)
            }
        }

        // Score every (route, wave) pair once; sort by score descending;
        // walk in order, skipping cells whose route or slot is already
        // taken. This is the greedy-best-marginal v1.
        const cells = []
        for (const route of (routes || [])) {
            const destU = String(route.destination || "").toUpperCase()
            if (placedDests.has(destU)) continue   // forced — skip scoring
            for (const wave of waves) {
                const fit = RouteAssistantWaveSlotScorer.scoreSlotFit(
                    route, wave, scoringCtx)
                if (!fit.viable || fit.score < minScore) continue
                cells.push({
                    destU:  destU,
                    waveId: wave.id,
                    bucket: fit.bucket,
                    score:  fit.score,
                    route:  route,
                    fit:    fit
                })
            }
        }
        cells.sort((a, b) => b.score - a.score)

        let placedTotalScore = 0
        let placedCount = 0
        for (const cell of cells) {
            if (placedDests.has(cell.destU)) continue
            const spare = scoringCtx.waveSlotsRemaining.get(cell.waveId)
            if (!spare || spare[cell.bucket] <= 0) continue
            placements.push({waveId: cell.waveId, route: cell.route, direction: "outbound"})
            placements.push({waveId: cell.waveId, route: cell.route, direction: "inbound"})
            placedDests.add(cell.destU)
            RouteAssistantWaveSlotScorer.consumeSlot(scoringCtx, cell.waveId, cell.bucket)
            placedTotalScore += cell.score
            placedCount++
        }

        // Unplaced — every input route that didn't make it onto the
        // placement list (either no viable wave or all viable waves were
        // saturated by higher-scoring routes).
        const unplaced = []
        for (const route of (routes || [])) {
            const destU = String(route.destination || "").toUpperCase()
            if (!placedDests.has(destU)) unplaced.push(route)
        }

        // Shortfall — gap between desired composition and what we placed.
        // F slice 3 semantics: profit-mode treats compositions as caps,
        // and may leave waves under-filled when the route pool can't
        // produce profitable candidates. We still report shortfall, but
        // the caller can distinguish from greedy via `optimised: "profit"`.
        const placementCounts = {}
        for (const p of placements) {
            const destU = String(p.route && p.route.destination || "").toUpperCase()
            const k = p.waveId + ":" + destU
            if (placementCounts[k]) continue
            placementCounts[k] = true
            const bucket = ScheduleFactors.bucketize(p.route.distanceNm, buckets)
            if (!bucket) continue
            const wkey = p.waveId + ":" + bucket + ":count"
            placementCounts[wkey] = (placementCounts[wkey] || 0) + 1
        }
        const shortfall = {}
        for (const wave of waves) {
            for (const k of bucketKeys) {
                const wanted = (wave.composition && wave.composition[k]) | 0
                const got    = placementCounts[wave.id + ":" + k + ":count"] || 0
                if (got < wanted) shortfall[wave.id + ":" + k] = wanted - got
            }
        }

        return {
            placements, unplaced, shortfall, forcedDests,
            optimised:    "profit",
            profitScore:  placedCount > 0 ? Math.round(placedTotalScore / placedCount) : 0,
            profitPlaced: placedCount
        }
    }

    /**
     * Slice E — coerce an overrides Map / object into a [destU, waveId][]
     * array with normalised destination IATAs. Tolerates undefined input.
     */
    static _coerceOverrides(input) {
        if (!input) return []
        const out = []
        if (input instanceof Map) {
            for (const [k, v] of input.entries()) {
                if (k && v) out.push([String(k).toUpperCase(), String(v)])
            }
        } else if (typeof input === "object") {
            for (const k in input) {
                if (k && input[k]) out.push([String(k).toUpperCase(), String(input[k])])
            }
        }
        return out
    }

    /**
     * Walks the placements and produces full flight records + factor warnings.
     * Times are derived by spreading flights evenly across the wave's
     * arrival/departure windows.
     *
     * @param {Array} placements - output of assignRoutes()
     */
    evaluateFlights(placements) {
        const flights = []
        const warnings = []
        const factors = this.preset.factors
        const dayMask = ScheduleFactors.resolveDayMask(factors.dayPattern, factors.dayMask)
        let seq = 0

        const byWave = {}
        for (const p of placements) {
            (byWave[p.waveId] = byWave[p.waveId] || []).push(p)
        }

        for (const wave of this.preset.waves) {
            const list = byWave[wave.id] || []
            const inbound  = list.filter(p => p.direction === "inbound")
            const outbound = list.filter(p => p.direction === "outbound")

            const arrTimes = this._spreadAcrossWindow(wave.arrivalWindow,   inbound.length)
            const depTimes = this._spreadAcrossWindow(wave.departureWindow, outbound.length)

            inbound.forEach((p, i) => {
                seq++
                const flight = this._makeFlight(seq, wave, p, arrTimes[i], dayMask)
                flights.push(flight)
                this._collectWarnings(flight, p.route, factors, warnings)
            })
            outbound.forEach((p, i) => {
                seq++
                const flight = this._makeFlight(seq, wave, p, depTimes[i], dayMask)
                flights.push(flight)
                this._collectWarnings(flight, p.route, factors, warnings)
            })
        }

        return {flights, warnings}
    }

    /**
     * Slice 2 — compute valid inbound→outbound connections at the hub.
     *
     * For every (inbound, outbound) pair where the outbound's depTimeLocal
     * lies in [inbound.arrTimeLocal + minTransfer, inbound.arrTimeLocal +
     * maxTransfer], emit a record. The classifier callback sorts each pair
     * into "own" / "interline" / "alliance" — pairs the classifier rejects
     * (returns null) are dropped so the SVG overlay stays readable.
     *
     * Pure: no DOM, no I/O. Day-wrap (inbound 23:30 → outbound next-day
     * 01:00) is OUT OF SCOPE for slice 2; minutesBetween returns a
     * negative delta and the pair is dropped. A future slice 3+ can add
     * multi-day awareness.
     *
     * @param {Array} flights - output of evaluateFlights()
     * @param {object} opts
     *   - carrierClassifier: (flight) => "own"|"interline"|"alliance"|null
     *     Optional; when undefined, every pair classifies as "own" so the
     *     graph still renders for users who haven't synced partner data.
     * @returns {Array} list of {inboundSeq, outboundSeq, inboundOrigin,
     *   outboundDest, transferMinutes, classification} records, plus an
     *   optional final {overflow:true, count} sentinel when capped.
     */
    computeConnections(flights, opts) {
        const o = opts || {}
        const factors = this.preset && this.preset.factors
        if (!factors) return []
        const minXfr = Number(factors.minTransferMinutes) || 0
        const maxXfr = Number(factors.maxTransferMinutes) || 240
        const idealMid = (minXfr + maxXfr) / 2
        const classifier = typeof o.carrierClassifier === "function"
            ? o.carrierClassifier
            : (() => "own")

        const inbounds  = []
        const outbounds = []
        for (const f of flights || []) {
            if (f.direction === "inbound" && f.arrTimeLocal) inbounds.push(f)
            else if (f.direction === "outbound" && f.depTimeLocal) outbounds.push(f)
        }

        const candidates = []
        for (const inb of inbounds) {
            const arrMin = ScheduleFactors.parseHHMM(inb.arrTimeLocal)
            if (!isFinite(arrMin)) continue
            for (const out of outbounds) {
                const depMin = ScheduleFactors.parseHHMM(out.depTimeLocal)
                if (!isFinite(depMin)) continue
                const transfer = depMin - arrMin
                if (transfer < minXfr || transfer > maxXfr) continue
                const cls = classifier(out)
                if (!cls) continue
                candidates.push({
                    inboundSeq:      inb.seq,
                    outboundSeq:     out.seq,
                    inboundOrigin:   inb.origin,
                    outboundDest:    out.destination,
                    transferMinutes: transfer,
                    classification:  cls
                })
            }
        }

        // Sort by closest-to-ideal-mid; cap at 100 to keep the SVG legible.
        candidates.sort((a, b) =>
            Math.abs(a.transferMinutes - idealMid) - Math.abs(b.transferMinutes - idealMid)
        )
        const CAP = 100
        if (candidates.length > CAP) {
            const overflow = candidates.length - CAP
            const out = candidates.slice(0, CAP)
            out.push({overflow: true, count: overflow})
            return out
        }
        return candidates
    }

    /**
     * Convenience that runs all three phases and returns a schedule record
     * ready to hand to ScheduleStore.save().
     *
     * @param {Array} routes
     */
    build(routes) {
        const validation = this.validatePreset()
        const record = ScheduleStore.newSchedule({
            server: this.context.server,
            airlineCode: this.context.airlineCode,
            presetId: this.preset.id,
            presetName: this.preset.name,
            hub: this.preset.hub
        })
        if (validation.length) {
            record.warnings = validation.map(msg => ({
                seq: 0, type: "presetInvalid", message: msg
            }))
            return record
        }
        const {placements, unplaced, shortfall} = this.assignRoutes(routes || [])
        const {flights, warnings} = this.evaluateFlights(placements)
        record.flights = flights
        record.warnings = warnings
        for (const route of unplaced) {
            record.warnings.push({
                seq: 0, type: "routeUnplaced",
                message: `${route.destination} (${route.distanceNm}nm) — no wave with matching bucket capacity`
            })
        }
        for (const key in shortfall) {
            const [waveId, bucket] = key.split(":")
            record.warnings.push({
                seq: 0, type: "shortfall",
                message: `wave ${waveId} ${bucket}: needs ${shortfall[key]} more route(s) of this haul-length`
            })
        }
        return record
    }

    _spreadAcrossWindow(window, count) {
        if (count <= 0) return []
        const start = ScheduleFactors.parseHHMM(window.start)
        const end   = ScheduleFactors.parseHHMM(window.end)
        if (count === 1) return [ScheduleFactors.formatHHMM(Math.round((start + end) / 2))]
        const step = (end - start) / (count - 1)
        const out = []
        for (let i = 0; i < count; i++) out.push(ScheduleFactors.formatHHMM(start + i * step))
        return out
    }

    _makeFlight(seq, wave, placement, timeHHMM, dayMask) {
        const route = placement.route
        const isOutbound = placement.direction === "outbound"
        return {
            seq: seq,
            waveId: wave.id,
            waveLabel: wave.label,
            direction: placement.direction,
            origin: isOutbound ? this.preset.hub : route.destination,
            destination: isOutbound ? route.destination : this.preset.hub,
            aircraftType: route.aircraftType || null,
            // Slice 1 contract: depTimeLocal carries the wave-spread time for
            // BOTH directions (renderer reads it as a layout coord regardless
            // of direction). Don't change this without auditing _renderLane.
            depTimeLocal: timeHHMM,
            // Slice 2 — explicit arrival time at the hub for inbound flights;
            // null on outbound. computeConnections reads inbound.arrTimeLocal
            // and outbound.depTimeLocal to derive transfer minutes.
            arrTimeLocal: isOutbound ? null : timeHHMM,
            distanceNm: route.distanceNm,
            rangeBucket: ScheduleFactors.bucketize(route.distanceNm, this.preset.factors.rangeBuckets),
            dayMask: dayMask.slice(),
            // Slice E — true if this placement bypassed bucket capacity
            // because the user explicitly dragged it onto this wave.
            // Renderer surfaces a (forced) badge.
            forced: !!placement.forced
        }
    }

    _collectWarnings(flight, route, factors, warnings) {
        if (route.aircraftRangeNm
            && !ScheduleFactors.aircraftCanFly(route.aircraftRangeNm, route.distanceNm)) {
            warnings.push({
                seq: flight.seq, type: "rangeExceeded",
                message: `${flight.origin}→${flight.destination}: ${route.distanceNm}nm exceeds aircraft range ${route.aircraftRangeNm}nm (5% margin)`
            })
        }
        if (factors.slotWindow
            && !ScheduleFactors.withinWindow(flight.depTimeLocal, factors.slotWindow.start, factors.slotWindow.end)) {
            warnings.push({
                seq: flight.seq, type: "slotViolation",
                message: `${flight.origin}→${flight.destination} at ${flight.depTimeLocal} falls outside hub slot window ${factors.slotWindow.start}–${factors.slotWindow.end}`
            })
        }
    }
}
