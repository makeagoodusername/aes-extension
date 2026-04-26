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
     * @param {Array} routes - [{destination, distanceNm, aircraftType?, aircraftRangeNm?, turnaroundMinutes?}]
     * @returns {object} {placements: [{waveId, route, direction}], unplaced: [route]}
     */
    assignRoutes(routes) {
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

        return {placements, unplaced, shortfall: remaining}
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
            depTimeLocal: timeHHMM,
            distanceNm: route.distanceNm,
            rangeBucket: ScheduleFactors.bucketize(route.distanceNm, this.preset.factors.rangeBuckets),
            dayMask: dayMask.slice()
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
