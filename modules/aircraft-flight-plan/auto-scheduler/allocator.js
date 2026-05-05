"use strict"

/**
 * Track 3 — Auto-scheduler entry point. Slices 3c (greedy pass), 3d
 * (round-robin balancer), and 3e (Build adapter + persistence).
 *
 * Mounts on `/app/fleets/aircraft/<id>/0` via the AFP family content-script
 * block. Pure function exposed on `window.AesAfpAutoScheduler.run` — Track 5
 * will wire up the Apply-all UI; Phase-1 ships invokable from the diagnostics
 * console.
 *
 * Public API:
 *   AesAfpAutoScheduler.run({aircraftId?, presetId?, hubIata?, candidates?, spec?,
 *                            budget?, persist?,
 *                            maintenanceWindows?, perStationTurnaroundMin?}) -> Promise<Build>
 *   AesAfpAutoScheduler.last -> Build | null
 *
 * Track 7 slice 7d additions:
 *   - `maintenanceWindows: {dayIdx, startMin, endMin}[]` — pre-seeds the
 *     grid with synthetic placements so the allocator avoids overlapping
 *     real maintenance bars on the AFP page. Sourced by preview-panel
 *     from `AesAfpScheduleStore.load(...)` block kind === "maintenance".
 *   - `perStationTurnaroundMin: {[iata]: number}` — per-destination
 *     turnaround override (median of `schedule.legs[].turnaroundBeforeMin/
 *     turnaroundAfterMin` from the cached schedule). Falls back to the
 *     preset's `factors.minTransferMinutes` per-route.
 *
 * Build shape (matches RouteAssistantWaveOverlay.buildSchedule output so
 * Track 5's preview panel can render it for free):
 *   {validation, routes, flights, warnings, placements, unplaced,
 *    shortfall, skipped, connections, preset, metadata}
 *
 * Reuses (read-only):
 *   ScheduleFactors, ScheduleBuilder      — turnaround math, range checks,
 *                                           preset validation, leg shape
 *   RouteAssistantFuelBurn                — per-leg fuel cost
 *   RouteAssistantFuelPriceScraper        — current fuel price (defensive)
 *   AesAfpAutoSchedulerGrid                — slice 3a primitive
 *   AesAfpAutoSchedulerObjective           — slice 3b scoring
 *   AesAfpRouteCandidates.last             — Slice C scored candidates
 *   AesAfpSpecResolver.last                — aircraft spec
 *   AesAfpSettings.load                    — autoScheduler weights + budget
 *   SchedulePresets.load                   — wave preset
 *   AesAfpActiveDraftStore.setFlights      — persistence (when persist=true)
 *
 * Bus contract:
 *   in:  (none — pulled, not pushed)
 *   out: auto-schedule:built {build}
 */
;(function () {
    if (window.AesAfpAutoScheduler) return

    const ALGO = "phase-2-dense-maintenance-greedy+swap"
    const SWAP_ITERATIONS_MAX = 50

    // ── Public API ─────────────────────────────────────────────────────

    async function run(opts) {
        const o = opts || {}
        const persist = (o.persist !== false)

        const settings = await _loadSettings()
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        const aircraftId = o.aircraftId || ctx.aircraftId
        if (!aircraftId) return _fail("aircraftId not resolved (open the AFP page first)", null)

        // Spec — Slice B's resolver caches the live spec; allocator can run
        // without it but will fall back to seats=1 / speed=800 (warned).
        const spec = o.spec
            || (window.AesAfpSpecResolver && AesAfpSpecResolver.last)
            || null

        // Candidates — Slice C must have run. Phase-1 doesn't auto-trigger
        // a recompute (would bypass the user's chip filters); we surface a
        // validation error instead.
        let candidates = Array.isArray(o.candidates) ? o.candidates
            : (window.AesAfpRouteCandidates && AesAfpRouteCandidates.last) || null
        if (!candidates || !candidates.length) {
            return _fail("no candidates — run AesAfpRouteCandidates.compute first", null)
        }

        // Preset.
        const presets = await _loadPresetsSafe()
        const preset = _resolvePreset(presets, o.presetId, settings, ctx, o)
        if (!preset) return _fail("no preset selected (set settings.lastSelectedPresetId or pass presetId)", null)

        // Validate preset structure first; bail before doing any expensive
        // work if the preset itself is broken.
        const builder = (typeof ScheduleBuilder !== "undefined")
            ? new ScheduleBuilder(preset, {server: ctx.server || "", airlineCode: ctx.airlineCode || ""})
            : null
        const validation = builder ? builder.validatePreset() : []
        if (validation.length) {
            return _fail(null, preset, {validation})
        }

        // Hub — candidates are normally computed from the aircraft's live
        // station, so that must be the emitted flight origin. Explicit
        // hubIata/hub remains available for intentional ferry/what-if runs.
        const hubPick = _resolveScheduleHub(o, preset, ctx)
        const hub = hubPick.hub
        if (!hub) return _fail("hub not resolved (aircraft location and preset hub are both missing)", preset)
        const formFilter = _filterCandidatesForFlightForm(candidates, hub)
        candidates = formFilter.candidates
        if (!candidates.length) {
            return _fail("no candidates selectable in the AS flight-number form for hub " + hub, preset)
        }
        const distanceHydration = await _hydrateCandidateDistances(candidates, hub, ctx.server || o.server || "", 8)
        candidates = distanceHydration.candidates

        // Fuel burn (per spec, constant per aircraft).
        let fuelBurn = null
        if (spec && typeof RouteAssistantFuelBurn !== "undefined") {
            try { fuelBurn = RouteAssistantFuelBurn.estimate({
                typeId:        spec.typeId,
                seats:         spec.seats,
                cargoCapacity: spec.cargoCapacity,
                speed:         spec.cruiseSpeedKmh
            }) }
            catch (_) { /* non-fatal — fuelCost goes to 0 */ }
        }

        // Fuel price (current AS fuel index). Defensive — Phase-1 falls
        // back to the settings-supplied AS$/kg constant when scraping
        // isn't ready (no scraper, network fail, fresh install).
        let fuelPriceASc = null
        if (typeof RouteAssistantFuelPriceScraper !== "undefined") {
            try {
                const scraper = new RouteAssistantFuelPriceScraper(ctx.server || "")
                if (scraper && typeof scraper.loadCached === "function") {
                    const cached = await scraper.loadCached()
                    if (cached && isFinite(cached.value) && cached.value > 0) {
                        fuelPriceASc = cached.value
                    }
                }
            } catch (_) { /* non-fatal */ }
        }
        const fallbackFuelCostPerKg = Number(settings.autoScheduler.fallbackFuelCostPerKg) || 0.4
        const fuelCostPerKg = (fuelPriceASc != null
            && window.AesAfpAutoSchedulerObjective
            && window.AesAfpAutoSchedulerObjective.fuelCostPerKgFromASc(fuelPriceASc))
                || fallbackFuelCostPerKg

        // Budget — defaults to settings fallback until Track 2 ships.
        const budget = o.budget || _fallbackBudget(settings)

        // ── Greedy pass (slice 3c) ─────────────────────────────────────
        // Lane C Phase 2 — overlay underUtilWeight from fleet-optimizer
        // settings when the user has opted in. Default 0 → bit-for-bit
        // identical to pre-Phase-2 allocator output.
        const w = Object.assign({}, settings.autoScheduler.weights)
        try {
            const fos = (typeof window !== "undefined" && window.AesStrategyFleetOptimizerSettings)
                ? await window.AesStrategyFleetOptimizerSettings.load() : null
            if (fos && fos.targetingEnabled === true && isFinite(fos.underUtilWeight)) {
                w.underUtilWeight = Number(fos.underUtilWeight)
            }
        } catch (_) { /* dormant fallback */ }
        const fillToBudget = (typeof o.fillToBudget === "boolean")
            ? o.fillToBudget
            : (settings.autoScheduler.fillToBudget !== false)
        const slotStepMin = _effectiveSlotResolution(w)
        const budgetOverrunPct = isFinite(Number(settings.autoScheduler.budgetOverrunPct))
            ? Math.max(0, Number(settings.autoScheduler.budgetOverrunPct)) : 0.5
        const presetTurnaround = Number((preset.factors && preset.factors.minTransferMinutes)) || 45
        const perStationTA = (o.perStationTurnaroundMin && typeof o.perStationTurnaroundMin === "object")
            ? o.perStationTurnaroundMin : {}
        // Per-destination turnaround minutes — Track 7 slice 7d uses real
        // observed turnarounds from the cached Schedule when available;
        // otherwise the preset's minTransferMinutes (45 default).
        function turnaroundFor(destIata) {
            const key = String(destIata || "").toUpperCase()
            const v = Number(perStationTA[key])
            return (isFinite(v) && v > 0) ? v : presetTurnaround
        }
        const grid = new AesAfpAutoSchedulerGrid({minTurnaroundMinutes: 0})
        // Note: grid uses 0-buffer because we encode the full round-trip
        // (outbound + ground + inbound) as one interval, so consecutive
        // round-trips already include their own ground gap implicitly.

        // ── Pre-seed maintenance windows (Track 7 slice 7d) ─────────────
        // Real `.block.maintenance` bars from the live schedule become
        // synthetic placements so the allocator never proposes a flight
        // overlapping a planned maintenance window. Hours reserved are
        // also subtracted from the budget ceiling so the greedy pass
        // doesn't try to place legs on top of unavailable time.
        const maintenanceWindows = Array.isArray(o.maintenanceWindows) ? o.maintenanceWindows : []
        let maintenanceMinutesReserved = 0
        for (let i = 0; i < maintenanceWindows.length; i++) {
            const m = maintenanceWindows[i]
            if (!m || !Number.isInteger(m.dayIdx) || m.dayIdx < 0 || m.dayIdx > 6) continue
            const sm = Number(m.startMin)
            const em = Number(m.endMin)
            if (!isFinite(sm) || !isFinite(em) || em <= sm) continue
            // Clamp to single-day range; the cached schedule sometimes
            // returns endMin > 1440 for windows that span midnight (the
            // `spansIntoNext` flag carries the rest).
            const clampedStart = Math.max(0, Math.min(1440, sm))
            const clampedEnd   = Math.max(0, Math.min(1440, em))
            if (clampedEnd <= clampedStart) continue
            if (grid.tryPlace({
                legId:    "maint-" + i,
                dayIdx:   m.dayIdx,
                startMin: clampedStart,
                endMin:   clampedEnd
            })) {
                maintenanceMinutesReserved += (clampedEnd - clampedStart)
            }
        }

        const dayMask = ScheduleFactors.resolveDayMask(
            preset.factors.dayPattern,
            preset.factors.dayMask
        )

        // Pricing default — Slice F setting governs the per-leg pricePct
        // when no per-leg edit overrides it.
        const pricePct = Number(settings.defaultPricePct) || 100

        // Per-candidate state. `placed` counts placements; `maxPlacements`
        // caps them based on weeklyFlights so a hot-demand route doesn't
        // get repeated until the budget is empty.
        const candidateState = candidates.map(c => ({
            candidate: c,
            placed:    0,
            maxPlacements: _maxPlacementsForCandidate(c, w)
        }))

        const aircraftRangeNm = (spec && Number(spec.range))
            ? ScheduleFactors.kmToNm(Number(spec.range))
            : null
        const cruiseKmh = (spec && Number(spec.cruiseSpeedKmh) > 0)
            ? Number(spec.cruiseSpeedKmh)
            : 800   // sensible jet default; warned via metadata

        const placements = []   // {legId, candidate, leg (round-trip params), score}
        let nextLegId = 1
        const maintenanceHoursReserved = maintenanceMinutesReserved / 60
        const budgetCeiling = budget.maxWeeklyBlockHours * (1 + budgetOverrunPct / 100)
        // Maintenance hours are pre-seeded in the grid above; flight-only
        // hours = grid.weeklyBlockHours() - maintenanceHoursReserved.
        // The comparison subtracts the reserved hours so a busy maintenance
        // window doesn't masquerade as flight utilisation.
        function flightOnlyWeeklyHours() {
            return Math.max(0, grid.weeklyBlockHours() - maintenanceHoursReserved)
        }
        let budgetExhausted = false

        for (let dayIdx = 0; dayIdx < 7 && !budgetExhausted; dayIdx++) {
            if (!dayMask[dayIdx]) continue
            for (const wave of (preset.waves || [])) {
                if (budgetExhausted) break
                const slots = _enumerateWaveSlots(wave, preset, slotStepMin, fillToBudget)
                if (!slots.length) continue
                const waveCap = (wave.composition.shortHaul | 0)
                              + (wave.composition.mediumHaul | 0)
                              + (wave.composition.longHaul   | 0)
                let placedThisWave = 0

                // Repeatedly score every (candidate × slot) pair and place
                // the best-fitting one until no fit / budget / soft cap.
                while (true) {
                    if (waveCap > 0 && placedThisWave >= waveCap && !fillToBudget) break
                    if (flightOnlyWeeklyHours() >= budgetCeiling) {
                        budgetExhausted = true
                        break
                    }

                    let best = null
                    for (const cs of candidateState) {
                        if (cs.placed >= cs.maxPlacements) continue
                        const cand = cs.candidate
                        if (_knownNonPositiveProfit(cand)) continue
                        if (_isSelfRouteCandidate(cand, hub)) continue
                        const distanceKm = Number(cand.distanceKm)
                        const distanceNm = Number(cand.distanceNm)
                            || (isFinite(distanceKm) ? ScheduleFactors.kmToNm(distanceKm) : 0)
                        if (!distanceKm || !distanceNm) continue
                        if (aircraftRangeNm && !ScheduleFactors.aircraftCanFly(aircraftRangeNm, distanceNm)) continue

                        const flightMin = Math.max(1, Math.round((distanceKm / cruiseKmh) * 60 + Number(w.cycleMinutes || 0)))
                        const turnaround = turnaroundFor(cand.destIata)
                        const blockMin = 2 * flightMin + turnaround
                        if (!isFinite(blockMin) || blockMin <= 0) continue
                        if (flightOnlyWeeklyHours() + blockMin / 60 > budgetCeiling) continue

                        for (const startMin of slots) {
                            const endMin = startMin + blockMin
                            if (endMin > 24 * 60) continue   // Phase-1: no day-wrap
                            if (!grid.canFit(dayIdx, startMin, endMin)) continue

                            const slotWindow = (preset.factors && preset.factors.slotWindow) || null
                            if (slotWindow) {
                                const arrAtHub = ScheduleFactors.formatHHMM(endMin)
                                const depAtHub = ScheduleFactors.formatHHMM(startMin)
                                if (!ScheduleFactors.withinWindow(depAtHub, slotWindow.start, slotWindow.end)) continue
                                if (!ScheduleFactors.withinWindow(arrAtHub, slotWindow.start, slotWindow.end)) continue
                            }

                            const result = AesAfpAutoSchedulerObjective.score({
                                candidate:    cand,
                                leg:          {dayIdx, depMin: startMin, arrMin: endMin,
                                               distanceNm, distanceKm, blockMinutes: blockMin},
                                gridState:    grid,
                                budget:       budget,
                                weights:      w,
                                spec:         spec || {},
                                pricePct:     pricePct,
                                fuelBurn:     fuelBurn,
                                fuelCostPerKg: fuelCostPerKg
                            })
                            const packing = _packingMetrics(grid, dayIdx, startMin, endMin)
                            const packingScore = _packingScore(packing, w)
                            const total = result.total + packingScore
                            if (!isFinite(total)) continue
                            // Don't filter on sign — fuelCost is in AS$ but
                            // gross is demand-weighted seats, so the absolute
                            // total is unit-mismatched. Relative ranking is
                            // what drives placement; the budget hard-stop
                            // (weeklyBlockHours × 1.05) bounds runaway loops.
                            if (!best || total > best.score) {
                                best = {
                                    score:       total,
                                    rawScore:    result.total,
                                    parts:       Object.assign({}, result.parts, {
                                        packingScore: packingScore,
                                        gapBeforeMin: packing.beforeGapMin,
                                        gapAfterMin:  packing.afterGapMin
                                    }),
                                    cs:          cs,
                                    distanceKm:  distanceKm,
                                    distanceNm:  distanceNm,
                                    flightMin:   flightMin,
                                    blockMin:    blockMin,
                                    turnaround:  turnaround,   // Track 7d
                                    startMin:    startMin,
                                    endMin:      endMin,
                                    dayIdx:      dayIdx,
                                    wave:        wave,
                                    capacityOverflow: waveCap > 0 && placedThisWave >= waveCap
                                }
                            }
                        }
                    }
                    if (!best) break

                    const legId = "rt-" + (nextLegId++)
                    if (!grid.tryPlace({legId, dayIdx: best.dayIdx, startMin: best.startMin, endMin: best.endMin})) {
                        // Race-equivalent shouldn't happen (we just verified
                        // canFit) but keep us safe from accidental dupes.
                        break
                    }
                    best.legId = legId
                    placements.push(best)
                    best.cs.placed++
                    placedThisWave++

                    // Budget post-placement check — once we cross the ceiling
                    // we set the global flag so subsequent waves don't keep
                    // placing under runaway slack penalties.
                    if (flightOnlyWeeklyHours() >= budgetCeiling) {
                        budgetExhausted = true
                        break
                    }
                }
            }
        }

        // ── Round-robin balancer (slice 3d) ────────────────────────────
        let swaps = 0
        let iterations = 0
        for (iterations = 0; iterations < SWAP_ITERATIONS_MAX && placements.length > 0; iterations++) {
            // Pick the lowest-scoring placement and try to find a swap that
            // beats it. Deterministic (lowest first) so re-runs are stable.
            const sortedAsc = placements.slice().sort((a, b) => a.score - b.score)
            const target = sortedAsc[0]
            const targetIdx = placements.indexOf(target)
            if (targetIdx < 0) break

            // Free the slot.
            grid.unplace(target.legId)
            target.cs.placed--

            let bestSwap = null
            for (const cs of candidateState) {
                if (cs === target.cs) continue
                if (cs.placed >= cs.maxPlacements) continue
                const cand = cs.candidate
                if (_knownNonPositiveProfit(cand)) continue
                if (_isSelfRouteCandidate(cand, hub)) continue
                const distanceKm = Number(cand.distanceKm)
                const distanceNm = Number(cand.distanceNm)
                    || (isFinite(distanceKm) ? ScheduleFactors.kmToNm(distanceKm) : 0)
                if (!distanceKm || !distanceNm) continue
                if (aircraftRangeNm && !ScheduleFactors.aircraftCanFly(aircraftRangeNm, distanceNm)) continue

                const flightMin = Math.max(1, Math.round((distanceKm / cruiseKmh) * 60 + Number(w.cycleMinutes || 0)))
                const turnaround = turnaroundFor(cand.destIata)
                const blockMin = 2 * flightMin + turnaround
                if (flightOnlyWeeklyHours() + blockMin / 60 > budgetCeiling) continue
                const endMin = target.startMin + blockMin
                if (endMin > 24 * 60) continue
                if (!grid.canFit(target.dayIdx, target.startMin, endMin)) continue

                const result = AesAfpAutoSchedulerObjective.score({
                    candidate:    cand,
                    leg:          {dayIdx: target.dayIdx, depMin: target.startMin, arrMin: endMin,
                                   distanceNm, distanceKm, blockMinutes: blockMin},
                    gridState:    grid,
                    budget:       budget,
                    weights:      w,
                    spec:         spec || {},
                    pricePct:     pricePct,
                    fuelBurn:     fuelBurn,
                    fuelCostPerKg: fuelCostPerKg
                })
                if (!isFinite(result.total)) continue
                const packing = _packingMetrics(grid, target.dayIdx, target.startMin, endMin)
                const packingScore = _packingScore(packing, w)
                const total = result.total + packingScore
                if (total <= target.score) continue   // must strictly improve
                if (!bestSwap || total > bestSwap.score) {
                    bestSwap = {
                        score:       total,
                        rawScore:    result.total,
                        parts:       Object.assign({}, result.parts, {
                            packingScore: packingScore,
                            gapBeforeMin: packing.beforeGapMin,
                            gapAfterMin:  packing.afterGapMin
                        }),
                        cs:          cs,
                        distanceKm:  distanceKm,
                        distanceNm:  distanceNm,
                        flightMin:   flightMin,
                        blockMin:    blockMin,
                        turnaround:  turnaround,   // Track 7d
                        startMin:    target.startMin,
                        endMin:      endMin,
                        dayIdx:      target.dayIdx,
                        wave:        target.wave
                    }
                }
            }

            if (!bestSwap) {
                // No improvement available — restore target and stop.
                if (grid.tryPlace({legId: target.legId, dayIdx: target.dayIdx,
                                   startMin: target.startMin, endMin: target.endMin})) {
                    target.cs.placed++
                }
                break
            }

            // Commit the swap.
            const legId = "rt-" + (nextLegId++)
            grid.tryPlace({legId, dayIdx: bestSwap.dayIdx, startMin: bestSwap.startMin, endMin: bestSwap.endMin})
            bestSwap.legId = legId
            bestSwap.cs.placed++
            placements.splice(targetIdx, 1, bestSwap)
            swaps++
        }

        // ── Output adapter (slice 3e) ──────────────────────────────────
        const build = _emptyBuild(preset)
        build.skipped = []
        build.routes = []
        const routeIndex = new Map()   // destIata → routes[] index
        let seq = 0
        const flightTotalScore = placements.reduce((s, p) => s + p.score, 0)
        const rawFlightTotalScore = placements.reduce((s, p) => s + (isFinite(p.rawScore) ? p.rawScore : p.score), 0)
        const warningSeen = new Set()

        for (const p of placements) {
            const cand = p.cs.candidate
            const destIata = String(cand.destIata || "").toUpperCase()
            // Build the per-route record once (shape mirrors what
            // RouteAssistantWaveOverlay.buildRoutesFromScoredRows produces).
            let routeIdx = routeIndex.get(destIata)
            if (routeIdx == null) {
                routeIdx = build.routes.length
                routeIndex.set(destIata, routeIdx)
                build.routes.push({
                    destination:        destIata,
                    distanceNm:         p.distanceNm,
                    aircraftType:       (spec && (spec.typeName || spec.name)) || null,
                    aircraftRangeNm:    aircraftRangeNm,
                    turnaroundMinutes:  p.turnaround,   // Track 7d — per-station
                    _scoredRow:         cand
                })
            }
            const route = build.routes[routeIdx]

            // Outbound leg.
            seq++
            const outDepHHMM = ScheduleFactors.formatHHMM(p.startMin)
            const outArrHHMM = ScheduleFactors.formatHHMM(p.startMin + p.flightMin)
            const dayMaskBit = _singleDayMask(p.dayIdx)
            const rangeBucket = ScheduleFactors.bucketize(p.distanceNm, preset.factors.rangeBuckets)
            const outbound = {
                seq:            seq,
                waveId:         p.wave.id,
                waveLabel:      p.wave.label,
                direction:      "outbound",
                origin:         hub,
                destination:    destIata,
                aircraftType:   route.aircraftType,
                depTimeLocal:   outDepHHMM,
                arrTimeLocal:   outArrHHMM,
                distanceNm:     p.distanceNm,
                rangeBucket:    rangeBucket,
                dayMask:        dayMaskBit.slice()
            }
            build.flights.push(outbound)
            build.placements.push({waveId: p.wave.id, route: route, direction: "outbound"})

            // Inbound leg. Uses the per-placement turnaround so the gap
            // between outbound arrival at destIata and inbound departure
            // matches the real station turnaround Track 7d derived from
            // the cached schedule.
            seq++
            const inDepMin = p.startMin + p.flightMin + p.turnaround
            const inArrMin = p.endMin
            const inbound = {
                seq:            seq,
                waveId:         p.wave.id,
                waveLabel:      p.wave.label,
                direction:      "inbound",
                origin:         destIata,
                destination:    hub,
                aircraftType:   route.aircraftType,
                depTimeLocal:   ScheduleFactors.formatHHMM(inDepMin),
                arrTimeLocal:   ScheduleFactors.formatHHMM(inArrMin),
                distanceNm:     p.distanceNm,
                rangeBucket:    rangeBucket,
                dayMask:        dayMaskBit.slice()
            }
            build.flights.push(inbound)
            build.placements.push({waveId: p.wave.id, route: route, direction: "inbound"})

            // Defensive warnings — _collectWarnings would also flag these,
            // but the allocator already filters by range so we just emit a
            // single info-level note when something unusual sneaks through.
            if (aircraftRangeNm && p.distanceNm > aircraftRangeNm * 0.95) {
                const key = "rangeNear:" + destIata
                if (!warningSeen.has(key)) {
                    warningSeen.add(key)
                    build.warnings.push({
                        seq: outbound.seq, type: "rangeMargin",
                        message: hub + "→" + destIata + ": " + p.distanceNm + "nm uses ≥95% of aircraft range"
                    })
                }
            }
        }

        // unplaced — candidates whose maxPlacements > 0 but no slot fit them.
        for (const cs of candidateState) {
            if (cs.placed === 0 && cs.maxPlacements > 0) {
                build.unplaced.push({
                    destination: String(cs.candidate.destIata || ""),
                    distanceNm:  Number(cs.candidate.distanceNm)
                                  || ScheduleFactors.kmToNm(Number(cs.candidate.distanceKm) || 0),
                    _scoredRow:  cs.candidate
                })
            }
        }

        if (!fuelBurn) {
            build.warnings.push({seq: 0, type: "fuelBurnUnavailable",
                message: "fuel burn estimate unavailable for spec; fuel cost treated as 0 in objective"})
        }
        if (!spec || !isFinite(Number(spec.cruiseSpeedKmh))) {
            build.warnings.push({seq: 0, type: "cruiseSpeedDefault",
                message: "cruise speed defaulted to 800 km/h (spec missing or unresolved)"})
        }
        if (hubPick.presetHub && hubPick.presetHub !== hub) {
            build.warnings.push({seq: 0, type: "ferryPreset",
                message: "using schedule origin " + hub
                    + "; selected preset hub " + hubPick.presetHub + " differs"})
        }

        const projectedMaintenanceRatio = _projectMaintenanceRatio(budget, flightOnlyWeeklyHours())
        const targetMaintenanceRatio = isFinite(Number(budget.targetMaintenanceRatio))
            ? Number(budget.targetMaintenanceRatio)
            : (isFinite(Number(settings.autoScheduler.minMaintenanceRatio))
                ? Number(settings.autoScheduler.minMaintenanceRatio) : null)
        if (projectedMaintenanceRatio != null && targetMaintenanceRatio != null
                && projectedMaintenanceRatio < targetMaintenanceRatio) {
            build.warnings.push({seq: 0, type: "maintenanceTargetMiss",
                message: "projected maintenance ratio "
                    + projectedMaintenanceRatio.toFixed(1) + "% is below target "
                    + targetMaintenanceRatio.toFixed(1) + "%"})
        }

        const packingStats = _summarisePacking(placements, Number(w.gapTargetMinutes))
        build.metadata = {
            algo:                       ALGO,
            iterations:                 iterations,
            swaps:                      swaps,
            placedRoundTrips:           placements.length,
            totalScore:                 flightTotalScore,
            rawTotalScore:              rawFlightTotalScore,
            budgetUsedHours:            flightOnlyWeeklyHours(),
            flightOnlyHoursUsed:        flightOnlyWeeklyHours(),
            occupiedHoursUsed:          grid.weeklyBlockHours(),
            budgetMaxHours:             budget.maxWeeklyBlockHours,
            budgetOverrunPct:           budgetOverrunPct,
            maintenanceHoursReserved:   maintenanceHoursReserved,   // Track 7d
            maintenanceWindowsApplied:  maintenanceWindows.length,  // Track 7d
            registeredMaintenanceWindows: _summariseMaintenanceWindows(maintenanceWindows),
            registeredWaveWindows:      _summariseWaveWindows(preset.waves),
            perStationTurnaroundUsed:   _summarisePerStationTA(placements), // Track 7d
            slotResolutionMin:          slotStepMin,
            fillToBudget:               fillToBudget,
            packing:                    packingStats,
            targetMaintenanceRatio:     targetMaintenanceRatio,
            maintenanceWaitDays:        isFinite(Number(budget.maintenanceWaitDays))
                ? Number(budget.maintenanceWaitDays)
                : (isFinite(Number(settings.autoScheduler.maintenanceWaitDays))
                    ? Number(settings.autoScheduler.maintenanceWaitDays) : null),
            projectedMaintenanceRatio:  projectedMaintenanceRatio,
            maintenanceRatioGap:        (projectedMaintenanceRatio != null && targetMaintenanceRatio != null)
                ? projectedMaintenanceRatio - targetMaintenanceRatio : null,
            candidateFormSelectableFiltered: formFilter.filtered,
            candidateDistancesHydrated: distanceHydration.hydrated,
            fuelPriceASc:               fuelPriceASc,
            fuelCostPerKg:              fuelCostPerKg,
            cruiseSpeedKmh:             cruiseKmh,
            scheduleOriginIata:         hub,
            scheduleOriginSource:       hubPick.source,
            generatedAt:                Date.now()
        }

        if (persist) {
            try {
                if (typeof AesAfpActiveDraftStore !== "undefined") {
                    await AesAfpActiveDraftStore.setFlights(ctx.server || "", String(aircraftId), {
                        hub:      hub,
                        presetId: preset.id,
                        flights:  build.flights,
                        // Persist the metadata snapshot so a returning user
                        // sees WEEKLY (budgetUsedHours) + SCORE (totalScore)
                        // immediately on page load — without it the preview
                        // shows LEGS=N but WEEKLY/SCORE=— until the user
                        // re-runs Auto-build.
                        metadata: build.metadata
                    })
                }
            } catch (e) {
                console.warn("[AES afp/auto-scheduler] persist failed", e)
                build.warnings.push({seq: 0, type: "persistFailed",
                    message: "AesAfpActiveDraftStore.setFlights threw: " + ((e && e.message) || e)})
            }
        }

        AesAfpAutoScheduler.last = build
        if (window.AesAfp && AesAfp.bus) {
            try { AesAfp.bus.emit("auto-schedule:built", {build}) }
            catch (e) { console.warn("[AES afp/auto-scheduler] bus emit failed", e) }
        }
        return build
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    async function _loadSettings() {
        // Defensive: AesAfpSettings is loaded earlier in the manifest, but
        // the diagnostics console lets users invoke run() before the page
        // settles — make sure we fall back cleanly.
        if (typeof AesAfpSettings === "undefined") {
            return {
                defaultPricePct: 100,
                autoScheduler: {
                    enabled: false,
                    fallbackMaxWeeklyBlockHours: 80,
                    fallbackMaxDailyBlockHours:  14,
                    fallbackFuelCostPerKg:       0.4,
                    targetUtilisationPct:        90,
                    weights: {
                        cargoWeight:                0.5,
                        grossWeight:                1.0,
                        fuelWeight:                 0.05,
                        distanceSaturationNm:       2500,
                        distanceFloor:              0.2,
                        slackPenaltyPerHour:        5000,
                        dailyOverrunPenaltyPerHour: 10000,
                        cycleMinutes:               30,
                        slotResolutionMin:          5,
                        tightSlotResolutionMin:     1,
                        weeklyFlightsDivisor:       4,
                        maxPlacementsPerCandidate:  28,
                        minPlacementsPerCandidate:  2,
                        denseRepeatMultiplier:      2,
                        efficiencyWeight:           0.25,
                        gapTargetMinutes:           1,
                        gapPenaltyPerMinute:        25
                    },
                    fillToBudget:                true,
                    budgetOverrunPct:            0.5,
                    minMaintenanceRatio:         100,
                    maintenanceWaitDays:         3
                }
            }
        }
        return await AesAfpSettings.load()
    }

    async function _loadPresetsSafe() {
        if (typeof SchedulePresets === "undefined") return null
        try { return await SchedulePresets.load() }
        catch (_) { return null }
    }

    /** Track 7d — summarise per-destination turnaround minutes used during
     *  this build, so the metadata + Track 5 preview-panel debug output
     *  can show "JFK: 56 min, ATL: 45 min, …" instead of the single
     *  preset default. */
    function _summarisePerStationTA(placements) {
        const out = {}
        for (const p of placements) {
            if (!p) continue
            const cand = p.cs && p.cs.candidate
            const dest = String((cand && cand.destIata) || "").toUpperCase()
            if (!dest) continue
            const ta = Number(p.turnaround)
            if (!isFinite(ta) || ta <= 0) continue
            out[dest] = ta   // identical for every placement to the same dest
        }
        return out
    }

    function _resolvePreset(presetsBlock, explicitId, settings, ctx, opts) {
        const list = (presetsBlock && Array.isArray(presetsBlock.presets)) ? presetsBlock.presets : []
        if (!list.length) return null
        // Hub Plan Workbench — per-hub active pointer wins over the legacy
        // global `lastSelectedPresetId` so multi-hub airlines route each
        // aircraft to the plan pinned for its current station.
        const requestedHub = _normaliseIata(opts && (opts.hubIata || opts.hub || opts.originIata))
        const iata = requestedHub || (ctx && ctx.currentLocationIata
            ? String(ctx.currentLocationIata).toUpperCase() : null)
        const hubMap = (settings && settings.activePresetIdByHub) || {}
        const hubActiveId = iata ? hubMap[iata] : null
        const wanted = explicitId
            || hubActiveId
            || (settings && settings.lastSelectedPresetId)
            || (presetsBlock && presetsBlock.defaultPresetId)
            || null
        let preset = wanted ? list.find(p => p && p.id === wanted) : null
        if (preset) return preset
        // Hub-matching fallback so the diagnostics console doesn't have to
        // hunt for a presetId by hand.
        if (iata) preset = list.find(p => p && String(p.hub).toUpperCase() === iata) || null
        return preset || list[0]
    }

    async function _hydrateCandidateDistances(candidates, hub, server, limit) {
        const list = Array.isArray(candidates) ? candidates : []
        if (!list.length) return {candidates: list, hydrated: 0}
        if (!hub || !server || typeof RouteAssistantDistanceResolver === "undefined") {
            return {candidates: list, hydrated: 0}
        }

        const missing = []
        const seen = new Set()
        const max = Math.max(1, Number(limit) || 24)
        for (const cand of list) {
            if (_candidateDistanceKm(cand) > 0) continue
            const dest = _normaliseIata(cand && cand.destIata)
            if (!dest || dest === hub || seen.has(dest)) continue
            seen.add(dest)
            missing.push(dest)
            if (missing.length >= max) break
        }
        if (!missing.length) return {candidates: list, hydrated: 0}

        let resolver = null
        try { resolver = new RouteAssistantDistanceResolver(server) }
        catch (_) { return {candidates: list, hydrated: 0} }
        if (!resolver || typeof resolver.resolve !== "function") {
            return {candidates: list, hydrated: 0}
        }

        const resolved = new Map()
        for (const dest of missing) {
            try {
                const rec = await resolver.resolve(hub, dest)
                const km = rec && Number(rec.distanceKm)
                if (isFinite(km) && km > 0) resolved.set(dest, km)
            } catch (_) { /* non-fatal; next candidate may still resolve */ }
        }
        if (!resolved.size) return {candidates: list, hydrated: 0}

        const hydrated = list.map(cand => {
            if (_candidateDistanceKm(cand) > 0) return cand
            const dest = _normaliseIata(cand && cand.destIata)
            const km = resolved.get(dest)
            if (!km) return cand
            return Object.assign({}, cand, {
                distanceKm: km,
                distanceNm: ScheduleFactors.kmToNm(km)
            })
        })
        return {candidates: hydrated, hydrated: resolved.size}
    }

    function _candidateDistanceKm(cand) {
        const km = Number(cand && cand.distanceKm)
        return (isFinite(km) && km > 0) ? km : 0
    }

    function _filterCandidatesForFlightForm(candidates, hub) {
        const list = Array.isArray(candidates) ? candidates : []
        const availability = _flightFormAvailability()
        if (!availability) return {candidates: list, filtered: 0}
        const h = _normaliseIata(hub)
        const hubOk = h && availability.origin.has(h) && availability.destination.has(h)
        if (!hubOk) return {candidates: [], filtered: list.length}

        const filtered = []
        for (const cand of list) {
            const dest = _normaliseIata(cand && cand.destIata)
            if (!dest || dest === h) continue
            if (!availability.origin.has(dest) || !availability.destination.has(dest)) continue
            filtered.push(cand)
        }
        return {candidates: filtered, filtered: list.length - filtered.length}
    }

    function _flightFormAvailability() {
        try {
            const form = window.AesAfp && typeof window.AesAfp.getNewFlightForm === "function"
                ? window.AesAfp.getNewFlightForm()
                : null
            if (!form || !form.originSelect || !form.destSelect) return null
            const origin = _iataSetFromSelect(form.originSelect)
            const destination = _iataSetFromSelect(form.destSelect)
            if (!origin.size || !destination.size) return null
            return {origin, destination}
        } catch (_) {
            return null
        }
    }

    function _iataSetFromSelect(select) {
        const set = new Set()
        const opts = select && select.options ? Array.from(select.options) : []
        for (const opt of opts) {
            const text = String((opt && opt.textContent) || "")
            const m = /\(([A-Z]{3})\)/.exec(text)
            if (m) set.add(m[1])
        }
        return set
    }

    function _fallbackBudget(settings) {
        const a = (settings && settings.autoScheduler) || {}
        const maxWeekly = Number(a.fallbackMaxWeeklyBlockHours) || 80
        const maxDaily  = Number(a.fallbackMaxDailyBlockHours)  || 14
        return {
            maxWeeklyBlockHours:        maxWeekly,
            maxDailyBlockHours:         maxDaily,
            mandatoryGroundHoursPerDay: 4,
            targetWeeklyHours:          maxWeekly,
            ratioForecast:              null,
            source:                     "settings-fallback"
        }
    }

    function _effectiveSlotResolution(weights) {
        const w = weights || {}
        const loose = Number(w.slotResolutionMin)
        const tight = Number(w.tightSlotResolutionMin)
        const a = (isFinite(loose) && loose > 0) ? loose : 5
        const b = (isFinite(tight) && tight > 0) ? tight : 1
        return Math.max(1, Math.min(a, b))
    }

    function _enumerateSlots(window, stepMin) {
        const out = []
        if (!window) return out
        const start = ScheduleFactors.parseHHMM(window.start)
        const end   = ScheduleFactors.parseHHMM(window.end)
        if (!isFinite(start) || !isFinite(end) || end < start) return out
        const step = Math.max(1, Number(stepMin) || 5)
        for (let t = start; t <= end; t += step) out.push(t)
        return out
    }

    function _enumerateWaveSlots(wave, preset, stepMin, fillToBudget) {
        const primary = _enumerateSlots(wave && wave.departureWindow, stepMin)
        if (!fillToBudget) return primary

        const factors = (preset && preset.factors) || {}
        const fallbackWindow = factors.slotWindow || {start: "00:00", end: "23:59"}
        const fallback = _enumerateSlots(fallbackWindow, stepMin)
        if (!fallback.length) return primary

        const seen = new Set(primary)
        for (const t of fallback) {
            if (!seen.has(t)) {
                seen.add(t)
                primary.push(t)
            }
        }
        primary.sort((a, b) => a - b)
        return primary
    }

    function _maxPlacementsForCandidate(cand, weights) {
        const wkly = Number(cand.weeklyFlights)
        const div  = Math.max(1, Number(weights.weeklyFlightsDivisor) || 4)
        const hardMax = Math.max(1, Number(weights.maxPlacementsPerCandidate) || 28)
        const denseMin = Math.max(1, Math.min(hardMax, Number(weights.minPlacementsPerCandidate) || 2))
        const repeatMultiplier = Math.max(1, Number(weights.denseRepeatMultiplier) || 2)
        if (!isFinite(wkly) || wkly <= 0) return denseMin
        return Math.max(denseMin, Math.min(hardMax, Math.ceil((wkly / div) * repeatMultiplier)))
    }

    function _knownNonPositiveProfit(cand) {
        if (!cand) return false
        const raw = cand.profitPerWeek
        if (raw === null || raw === undefined || raw === "") return false
        const v = Number(raw)
        return isFinite(v) && v <= 0
    }

    function _normaliseIata(value) {
        const s = String(value || "").trim().toUpperCase()
        return s || ""
    }

    function _resolveScheduleHub(opts, preset, ctx) {
        const o = opts || {}
        const requested = _normaliseIata(o.hubIata || o.hub || o.originIata)
        const current = _normaliseIata(ctx && ctx.currentLocationIata)
        const presetHub = _normaliseIata(preset && preset.hub)
        if (requested) {
            return {hub: requested, source: "explicit", presetHub}
        }
        if (current) {
            return {hub: current, source: "aircraft-location", presetHub}
        }
        return {hub: presetHub, source: "preset", presetHub}
    }

    function _isSelfRouteCandidate(cand, hub) {
        const dest = _normaliseIata(cand && cand.destIata)
        return !!dest && !!hub && dest === hub
    }

    function _packingMetrics(grid, dayIdx, startMin, endMin) {
        const occ = grid && typeof grid.occupancy === "function" ? grid.occupancy() : null
        const day = occ && Array.isArray(occ[dayIdx]) ? occ[dayIdx] : []
        let before = null
        let after = null
        for (const it of day) {
            if (!it) continue
            if (it.endMin <= startMin) {
                const gap = startMin - it.endMin
                before = (before == null) ? gap : Math.min(before, gap)
            } else if (it.startMin >= endMin) {
                const gap = it.startMin - endMin
                after = (after == null) ? gap : Math.min(after, gap)
            }
        }
        return {beforeGapMin: before, afterGapMin: after}
    }

    function _packingScore(metrics, weights) {
        const m = metrics || {}
        const w = weights || {}
        const target = Math.max(0, Number(w.gapTargetMinutes) || 1)
        const penaltyPerMin = Math.max(0, Number(w.gapPenaltyPerMinute) || 0)
        if (!penaltyPerMin) return 0
        let penalty = 0
        if (m.beforeGapMin != null) penalty += Math.max(0, m.beforeGapMin - target)
        if (m.afterGapMin  != null) penalty += Math.max(0, m.afterGapMin  - target)
        return -penalty * penaltyPerMin
    }

    function _projectMaintenanceRatio(budget, weeklyBlockHours) {
        if (!budget || !budget.fit || !budget.fit.valid) return null
        const current = Number(budget.currentRatio)
        const slope = Number(budget.fit.slope)
        const intercept = Number(budget.fit.intercept)
        const waitDays = Number(budget.maintenanceWaitDays)
        if (!isFinite(current) || !isFinite(slope) || !isFinite(intercept)
                || !isFinite(waitDays) || waitDays <= 0) return null
        const weeks = waitDays / 7
        const next = current + (slope * Number(weeklyBlockHours || 0) + intercept) * weeks
        return Math.max(0, Math.min(200, next))
    }

    function _summarisePacking(placements, targetGapMin) {
        const byDay = {}
        for (const p of placements || []) {
            if (!p || !Number.isInteger(p.dayIdx)) continue
            ;(byDay[p.dayIdx] = byDay[p.dayIdx] || []).push(p)
        }
        const gaps = []
        for (const d of Object.keys(byDay)) {
            const arr = byDay[d].slice().sort((a, b) => a.startMin - b.startMin)
            for (let i = 1; i < arr.length; i++) {
                const gap = arr[i].startMin - arr[i - 1].endMin
                if (isFinite(gap) && gap >= 0) gaps.push(gap)
            }
        }
        const target = Math.max(0, Number(targetGapMin) || 1)
        const tight = gaps.filter(g => g <= target + 1).length
        const sum = gaps.reduce((s, g) => s + g, 0)
        return {
            targetGapMin:       target,
            gapCount:           gaps.length,
            averageFlightGapMin: gaps.length ? sum / gaps.length : null,
            maxFlightGapMin:    gaps.length ? Math.max.apply(Math, gaps) : null,
            tightGapSharePct:   gaps.length ? (tight / gaps.length) * 100 : null,
            overflowPlacements: (placements || []).filter(p => p && p.capacityOverflow).length
        }
    }

    function _summariseMaintenanceWindows(windows) {
        return (windows || []).map(w => ({
            dayIdx: Number(w.dayIdx),
            startMin: Number(w.startMin),
            endMin: Number(w.endMin)
        })).filter(w => Number.isInteger(w.dayIdx)
            && isFinite(w.startMin) && isFinite(w.endMin) && w.endMin > w.startMin)
    }

    function _summariseWaveWindows(waves) {
        return (waves || []).map(w => ({
            id: w && w.id || null,
            label: w && w.label || null,
            departureWindow: w && w.departureWindow
                ? {start: w.departureWindow.start, end: w.departureWindow.end} : null,
            arrivalWindow: w && w.arrivalWindow
                ? {start: w.arrivalWindow.start, end: w.arrivalWindow.end} : null
        }))
    }

    function _singleDayMask(dayIdx) {
        const m = [0, 0, 0, 0, 0, 0, 0]
        if (Number.isInteger(dayIdx) && dayIdx >= 0 && dayIdx < 7) m[dayIdx] = 1
        return m
    }

    function _emptyBuild(preset) {
        return {
            validation: [], routes: [], flights: [], warnings: [],
            placements: [], unplaced: [], shortfall: {}, skipped: [],
            connections: [],
            preset: preset || null,
            metadata: null
        }
    }

    function _fail(message, preset, extras) {
        const build = _emptyBuild(preset)
        if (extras && Array.isArray(extras.validation)) {
            build.validation = extras.validation.slice()
        }
        if (message) build.validation.push(message)
        AesAfpAutoScheduler.last = build
        return build
    }

    // ── Singleton export ────────────────────────────────────────────────

    const AesAfpAutoScheduler = {
        run:  run,
        last: null
    }
    window.AesAfpAutoScheduler = AesAfpAutoScheduler
})()
