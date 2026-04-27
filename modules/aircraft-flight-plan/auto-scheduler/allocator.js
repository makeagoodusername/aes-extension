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
 *   AesAfpAutoScheduler.run({aircraftId?, presetId?, candidates?, spec?,
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

    const ALGO = "phase-1-greedy+swap"
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
        const candidates = Array.isArray(o.candidates) ? o.candidates
            : (window.AesAfpRouteCandidates && AesAfpRouteCandidates.last) || null
        if (!candidates || !candidates.length) {
            return _fail("no candidates — run AesAfpRouteCandidates.compute first", null)
        }

        // Preset.
        const presets = await _loadPresetsSafe()
        const preset = _resolvePreset(presets, o.presetId, settings, ctx)
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

        // Hub — preset's hub takes precedence over ctx (allows ferry plans).
        const hub = (preset.hub || ctx.currentLocationIata || "").toUpperCase()

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
        const w = settings.autoScheduler.weights
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
        const budgetCeiling = budget.maxWeeklyBlockHours * 1.05
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
                const slots = _enumerateSlots(wave.departureWindow, w.slotResolutionMin)
                if (!slots.length) continue
                const waveCap = (wave.composition.shortHaul | 0)
                              + (wave.composition.mediumHaul | 0)
                              + (wave.composition.longHaul   | 0)
                let placedThisWave = 0

                // Repeatedly score every (candidate × slot) pair and place
                // the best-fitting one until no fit / budget / soft cap.
                while (true) {
                    if (waveCap > 0 && placedThisWave >= waveCap) break
                    if (flightOnlyWeeklyHours() >= budgetCeiling) {
                        budgetExhausted = true
                        break
                    }

                    let best = null
                    for (const cs of candidateState) {
                        if (cs.placed >= cs.maxPlacements) continue
                        const cand = cs.candidate
                        const distanceKm = Number(cand.distanceKm)
                        const distanceNm = Number(cand.distanceNm)
                            || (isFinite(distanceKm) ? ScheduleFactors.kmToNm(distanceKm) : 0)
                        if (!distanceKm || !distanceNm) continue
                        if (aircraftRangeNm && !ScheduleFactors.aircraftCanFly(aircraftRangeNm, distanceNm)) continue

                        const flightMin = (distanceKm / cruiseKmh) * 60 + Number(w.cycleMinutes || 0)
                        const turnaround = turnaroundFor(cand.destIata)
                        const blockMin = 2 * flightMin + turnaround
                        if (!isFinite(blockMin) || blockMin <= 0) continue

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
                            const total = result.total
                            if (!isFinite(total)) continue
                            // Don't filter on sign — fuelCost is in AS$ but
                            // gross is demand-weighted seats, so the absolute
                            // total is unit-mismatched. Relative ranking is
                            // what drives placement; the budget hard-stop
                            // (weeklyBlockHours × 1.05) bounds runaway loops.
                            if (!best || total > best.score) {
                                best = {
                                    score:       total,
                                    parts:       result.parts,
                                    cs:          cs,
                                    distanceKm:  distanceKm,
                                    distanceNm:  distanceNm,
                                    flightMin:   flightMin,
                                    blockMin:    blockMin,
                                    turnaround:  turnaround,   // Track 7d
                                    startMin:    startMin,
                                    endMin:      endMin,
                                    dayIdx:      dayIdx,
                                    wave:        wave
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
                const distanceKm = Number(cand.distanceKm)
                const distanceNm = Number(cand.distanceNm)
                    || (isFinite(distanceKm) ? ScheduleFactors.kmToNm(distanceKm) : 0)
                if (!distanceKm || !distanceNm) continue
                if (aircraftRangeNm && !ScheduleFactors.aircraftCanFly(aircraftRangeNm, distanceNm)) continue

                const flightMin = (distanceKm / cruiseKmh) * 60 + Number(w.cycleMinutes || 0)
                const turnaround = turnaroundFor(cand.destIata)
                const blockMin = 2 * flightMin + turnaround
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
                if (result.total <= target.score) continue   // must strictly improve
                if (!bestSwap || result.total > bestSwap.score) {
                    bestSwap = {
                        score:       result.total,
                        parts:       result.parts,
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
        if (preset.hub && ctx.currentLocationIata && preset.hub !== String(ctx.currentLocationIata).toUpperCase()) {
            build.warnings.push({seq: 0, type: "ferryPreset",
                message: "preset hub " + preset.hub + " differs from aircraft location " + ctx.currentLocationIata})
        }

        build.metadata = {
            algo:                       ALGO,
            iterations:                 iterations,
            swaps:                      swaps,
            placedRoundTrips:           placements.length,
            totalScore:                 flightTotalScore,
            budgetUsedHours:            grid.weeklyBlockHours(),
            flightOnlyHoursUsed:        flightOnlyWeeklyHours(),
            budgetMaxHours:             budget.maxWeeklyBlockHours,
            maintenanceHoursReserved:   maintenanceHoursReserved,   // Track 7d
            maintenanceWindowsApplied:  maintenanceWindows.length,  // Track 7d
            perStationTurnaroundUsed:   _summarisePerStationTA(placements), // Track 7d
            fuelPriceASc:               fuelPriceASc,
            fuelCostPerKg:              fuelCostPerKg,
            cruiseSpeedKmh:             cruiseKmh,
            generatedAt:                Date.now()
        }

        if (persist) {
            try {
                if (typeof AesAfpActiveDraftStore !== "undefined") {
                    await AesAfpActiveDraftStore.setFlights(ctx.server || "", String(aircraftId), {
                        hub:      hub,
                        presetId: preset.id,
                        flights:  build.flights
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
                        weeklyFlightsDivisor:       4
                    }
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

    function _resolvePreset(presetsBlock, explicitId, settings, ctx) {
        const list = (presetsBlock && Array.isArray(presetsBlock.presets)) ? presetsBlock.presets : []
        if (!list.length) return null
        const wanted = explicitId
            || (settings && settings.lastSelectedPresetId)
            || (presetsBlock && presetsBlock.defaultPresetId)
            || null
        let preset = wanted ? list.find(p => p && p.id === wanted) : null
        if (preset) return preset
        // Hub-matching fallback so the diagnostics console doesn't have to
        // hunt for a presetId by hand.
        const iata = ctx && ctx.currentLocationIata
            ? String(ctx.currentLocationIata).toUpperCase() : null
        if (iata) preset = list.find(p => p && String(p.hub).toUpperCase() === iata) || null
        return preset || list[0]
    }

    function _fallbackBudget(settings) {
        const a = (settings && settings.autoScheduler) || {}
        const maxWeekly = Number(a.fallbackMaxWeeklyBlockHours) || 80
        const maxDaily  = Number(a.fallbackMaxDailyBlockHours)  || 14
        return {
            maxWeeklyBlockHours:        maxWeekly,
            maxDailyBlockHours:         maxDaily,
            mandatoryGroundHoursPerDay: 4,
            ratioForecast:              null,
            source:                     "settings-fallback"
        }
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

    function _maxPlacementsForCandidate(cand, weights) {
        const wkly = Number(cand.weeklyFlights)
        const div  = Math.max(1, Number(weights.weeklyFlightsDivisor) || 4)
        if (!isFinite(wkly) || wkly <= 0) return 1
        return Math.max(1, Math.min(7, Math.floor(wkly / div)))
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
