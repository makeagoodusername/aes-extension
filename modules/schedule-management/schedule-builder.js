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
     * @param {Array} routes - [{destination, distanceNm, aircraftType?, aircraftRangeNm?, turnaroundMinutes?}]
     * @param {object} [opts]
     *   - overrides: {destIata: waveId} map of forced placements
     * @returns {object} {placements: [{waveId, route, direction, forced?}], unplaced, shortfall, forcedDests}
     */
    assignRoutes(routes, opts) {
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
