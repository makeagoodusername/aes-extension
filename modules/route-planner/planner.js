"use strict"

/**
 * Route Planner — pure schedule recommendation and submit orchestration.
 *
 * The dashboard UI uses this module to build an editable mock schedule before
 * applying legs through the existing AesAfpSubmitBridge. A "flight" here is
 * one AS flight-number leg: origin, destination, dayMask, departure, optional
 * flight-number text, and the aircraft that should receive it.
 */
class AesRoutePlanner {
    static DAY_NAMES = Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])

    static DEFAULTS = Object.freeze({
        pattern:           "out-and-back",
        flightCount:       6,
        startFlightNumber: null,
        startTime:         "09:00",
        turnMin:           45,
        defaultBlockMin:   120,
        cruiseKmh:         760,
        longFlightMin:     300,
        pricePct:          100,
        service:           "",
        applyDelayMs:      2500
    })

    static normalizeIataList(input) {
        const raw = Array.isArray(input) ? input.join(" ") : String(input || "")
        const seen = new Set()
        const out = []
        raw.toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(/\s+/).forEach(token => {
            if (!/^[A-Z0-9]{3}$/.test(token) || seen.has(token)) return
            seen.add(token)
            out.push(token)
        })
        return out
    }

    static normalizeAircraftList(input) {
        const raw = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/)
        const out = []
        const seen = new Set()
        raw.forEach(item => {
            const rec = AesRoutePlanner._normaliseAircraft(item)
            if (!rec || seen.has(rec.aircraftId)) return
            seen.add(rec.aircraftId)
            out.push(rec)
        })
        return out
    }

    static airportsFromSchedule(scheduleData) {
        const latest = AesRoutePlanner.latestScheduleDate(scheduleData)
        const routes = latest && scheduleData && scheduleData.date && scheduleData.date[latest]
            ? scheduleData.date[latest].schedule || [] : []
        const counts = {}
        routes.forEach(route => {
            const o = AesRoutePlanner._iata(route && route.origin)
            const d = AesRoutePlanner._iata(route && route.destination)
            if (o) counts[o] = (counts[o] || 0) + 1
            if (d) counts[d] = (counts[d] || 0) + 1
        })
        return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    }

    static latestScheduleDate(scheduleData) {
        const dates = []
        if (scheduleData && scheduleData.date) {
            Object.keys(scheduleData.date).forEach(date => {
                if (Number.isInteger(parseInt(date, 10))) dates.push(date)
            })
        }
        dates.sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
        return dates[0] || ""
    }

    static suggestNextFlightNumber(scheduleData) {
        const used = new Set()
        if (scheduleData && scheduleData.date) {
            Object.keys(scheduleData.date).forEach(date => {
                const routes = scheduleData.date[date] && scheduleData.date[date].schedule || []
                routes.forEach(route => {
                    Object.keys(route && route.flightNumber || {}).forEach(n => {
                        const parsed = parseInt(n, 10)
                        if (Number.isFinite(parsed)) used.add(parsed)
                    })
                })
            })
        }
        for (let i = 1; i <= 9999; i++) {
            if (!used.has(i)) return i
        }
        return null
    }

    static generatePlan(options) {
        const opts = AesRoutePlanner._normaliseOptions(options || {})
        const errors = []
        if (!opts.hub) errors.push("hub")
        if (opts.airports.length < 2) errors.push("airports")
        if (!opts.aircraft.length) errors.push("aircraft")
        if (!Number.isFinite(opts.flightCount) || opts.flightCount < 1) errors.push("flightCount")
        if (AesRoutePlanner._parseMin(opts.startTime) == null) errors.push("startTime")
        if (errors.length) return {ok: false, errors, flights: [], summary: null}

        const states = opts.aircraft.map((aircraft, idx) => ({
            aircraft,
            location: AesRoutePlanner._iata(aircraft.hub) || opts.hub,
            nextAbsMin: AesRoutePlanner._parseMin(opts.startTime) + (idx * opts.waveSpacingMin)
        }))
        const routeCursor = {destIndex: 0, chainIndex: 0}
        const flights = []

        while (flights.length < opts.flightCount) {
            const state = AesRoutePlanner._pickAircraftState(states, flights.length)
            const route = AesRoutePlanner._nextRoute(opts, state, routeCursor, flights)
            if (!route) break
            const seq = flights.length + 1
            const meta = AesRoutePlanner._routeMeta(opts.routeMeta, route.origin, route.destination)
            const blockMin = AesRoutePlanner.estimateBlockMinutes(meta && meta.distanceKm, opts)
            const depAbsMin = AesRoutePlanner._snapAbsMinute(state.nextAbsMin, blockMin, seq, opts.longFlightMin)
            const arrAbsMin = depAbsMin + blockMin
            const dayIdx = AesRoutePlanner._dayIndex(depAbsMin)
            const nextGap = opts.turnMin + AesRoutePlanner._irregularTurnOffset(blockMin, seq, opts.longFlightMin)
            const flightNumber = opts.startFlightNumber == null ? null : opts.startFlightNumber + flights.length

            flights.push({
                id: "rp-" + Date.now().toString(36) + "-" + seq,
                seq,
                aircraftId: state.aircraft.aircraftId,
                registration: state.aircraft.registration || "",
                origin: route.origin,
                destination: route.destination,
                depTimeLocal: AesRoutePlanner.formatHHMM(depAbsMin),
                arrTimeLocal: AesRoutePlanner.formatHHMM(arrAbsMin),
                dayIdx,
                dayName: AesRoutePlanner.DAY_NAMES[dayIdx],
                dayMask: AesRoutePlanner.dayMask(dayIdx),
                flightNumberText: flightNumber == null ? "" : String(flightNumber),
                blockMin,
                turnMin: opts.turnMin,
                nextGapMin: nextGap,
                distanceKm: meta && meta.distanceKm || null,
                score: meta && Number.isFinite(meta.score) ? meta.score : null,
                pricePct: opts.pricePct,
                service: opts.service,
                pattern: opts.pattern,
                note: AesRoutePlanner._flightNote(blockMin, nextGap)
            })

            state.location = route.destination
            state.nextAbsMin = arrAbsMin + nextGap
        }

        return {
            ok: flights.length > 0,
            errors: flights.length ? [] : ["noRoutes"],
            warnings: AesRoutePlanner._warnings(opts, flights),
            options: opts,
            flights,
            summary: AesRoutePlanner.summarize(flights)
        }
    }

    static applyEdits(plan, edits) {
        const src = plan || {}
        const bySeq = new Map()
        ;(Array.isArray(edits) ? edits : []).forEach(edit => {
            const seq = parseInt(edit && edit.seq, 10)
            if (Number.isFinite(seq)) bySeq.set(seq, edit)
        })
        const flights = (src.flights || []).map(flight => {
            const edit = bySeq.get(flight.seq)
            if (!edit) return Object.assign({}, flight)
            const next = Object.assign({}, flight)
            let depChanged = false
            if (edit.depTimeLocal && AesRoutePlanner._parseMin(edit.depTimeLocal) != null) {
                next.depTimeLocal = AesRoutePlanner.formatHHMM(AesRoutePlanner._parseMin(edit.depTimeLocal))
                depChanged = true
            }
            if (edit.dayIdx != null) {
                const d = Math.max(0, Math.min(6, parseInt(edit.dayIdx, 10)))
                next.dayIdx = d
                next.dayName = AesRoutePlanner.DAY_NAMES[d]
                next.dayMask = AesRoutePlanner.dayMask(d)
            }
            if (edit.flightNumberText != null) {
                next.flightNumberText = String(edit.flightNumberText).replace(/[^0-9]/g, "").slice(0, 4)
            }
            if (edit.aircraftId != null) next.aircraftId = String(edit.aircraftId).trim()
            if (edit.registration != null) next.registration = String(edit.registration).trim()
            if (edit.pricePct != null) {
                const pct = parseInt(edit.pricePct, 10)
                if (Number.isFinite(pct) && pct >= 50 && pct <= 200) next.pricePct = pct
            }
            if (edit.service != null) next.service = String(edit.service)
            if (edit.selected != null) next.selected = !!edit.selected
            if (depChanged && Number.isFinite(next.blockMin)) {
                next.arrTimeLocal = AesRoutePlanner.formatHHMM(AesRoutePlanner._parseMin(next.depTimeLocal) + next.blockMin)
            }
            return next
        })
        return Object.assign({}, src, {flights, summary: AesRoutePlanner.summarize(flights)})
    }

    static buildSubmitPayload(flight, ctx) {
        const f = flight || {}
        const c = ctx || {}
        return {
            server:     String(c.server || ""),
            aircraftId: String(f.aircraftId || ""),
            hub:        f.origin || null,
            leg: {
                origin:           f.origin,
                destination:      f.destination,
                depTimeLocal:     f.depTimeLocal,
                depTime:          f.depTimeLocal,
                dayMask:          Array.isArray(f.dayMask) ? f.dayMask.slice(0, 7) : AesRoutePlanner.dayMask(f.dayIdx || 0),
                pricePct:         Number.isFinite(f.pricePct) ? f.pricePct : AesRoutePlanner.DEFAULTS.pricePct,
                service:          typeof f.service === "string" ? f.service : "",
                flightNumberText: f.flightNumberText || ""
            }
        }
    }

    static async applyPlan(plan, ctx) {
        const p = plan || {}
        const c = ctx || {}
        const bridge = c.submitBridge || (typeof window !== "undefined" && window.AesAfpSubmitBridge)
        if (!bridge || typeof bridge.submitLegInBackground !== "function") {
            return {ok: false, error: "AesAfpSubmitBridge is not available", results: []}
        }
        const flights = (p.flights || []).filter(f => f && f.selected !== false)
        const results = []
        for (let i = 0; i < flights.length; i++) {
            const flight = flights[i]
            const payload = AesRoutePlanner.buildSubmitPayload(flight, c)
            if (!payload.server || !payload.aircraftId || !payload.leg.origin || !payload.leg.destination) {
                results.push({ok: false, seq: flight.seq, error: "missing server / aircraft / route"})
                continue
            }
            if (typeof c.onProgress === "function") c.onProgress({phase: "submitting", index: i, total: flights.length, flight})
            let resp
            try {
                resp = await bridge.submitLegInBackground(payload)
            } catch (e) {
                resp = {ok: false, error: (e && e.message) || String(e)}
            }
            results.push(Object.assign({seq: flight.seq, flight}, resp || {}))
            if (typeof c.onProgress === "function") c.onProgress({phase: "submitted", index: i, total: flights.length, flight, response: resp})
            if (c.stopOnError !== false && (!resp || !resp.ok)) break
            const delay = Number.isFinite(c.applyDelayMs) ? c.applyDelayMs : AesRoutePlanner.DEFAULTS.applyDelayMs
            if (delay > 0 && i < flights.length - 1) await AesRoutePlanner.sleep(delay)
        }
        return {
            ok: results.length === flights.length && results.every(r => r && r.ok),
            results
        }
    }

    static summarize(flights) {
        const list = Array.isArray(flights) ? flights : []
        const aircraft = new Set()
        const airports = new Set()
        let longFlights = 0
        list.forEach(f => {
            if (f.aircraftId) aircraft.add(f.aircraftId)
            if (f.origin) airports.add(f.origin)
            if (f.destination) airports.add(f.destination)
            if (f.blockMin >= AesRoutePlanner.DEFAULTS.longFlightMin) longFlights++
        })
        return {
            flightCount: list.length,
            aircraftCount: aircraft.size,
            airportCount: airports.size,
            longFlights
        }
    }

    static estimateBlockMinutes(distanceKm, opts) {
        const o = opts || {}
        const fallback = Number.isFinite(o.defaultBlockMin) ? o.defaultBlockMin : AesRoutePlanner.DEFAULTS.defaultBlockMin
        const dist = Number(distanceKm)
        if (!Number.isFinite(dist) || dist <= 0) return AesRoutePlanner._roundTo(Math.max(45, fallback), 5)
        const cruise = Number.isFinite(o.cruiseKmh) && o.cruiseKmh > 0 ? o.cruiseKmh : AesRoutePlanner.DEFAULTS.cruiseKmh
        const taxiClimbMin = dist > 4500 ? 55 : dist > 1800 ? 45 : 35
        return AesRoutePlanner._roundTo(Math.max(45, (dist / cruise) * 60 + taxiClimbMin), 5)
    }

    static dayMask(dayIdx) {
        const idx = Math.max(0, Math.min(6, parseInt(dayIdx, 10) || 0))
        return AesRoutePlanner.DAY_NAMES.map((_, i) => i === idx)
    }

    static dayMaskText(mask) {
        const m = Array.isArray(mask) ? mask : AesRoutePlanner.dayMask(0)
        return AesRoutePlanner.DAY_NAMES.map((_, i) => m[i] ? String(i + 1) : "_").join("")
    }

    static formatHHMM(absMin) {
        const day = 24 * 60
        const minute = ((Math.round(absMin) % day) + day) % day
        return String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0")
    }

    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    static _normaliseOptions(options) {
        const D = AesRoutePlanner.DEFAULTS
        const airports = AesRoutePlanner.normalizeIataList(options.airports || options.airportText || [])
        const hub = AesRoutePlanner._iata(options.hub) || airports[0] || ""
        const count = parseInt(options.flightCount, 10)
        const startNum = options.startFlightNumber == null || options.startFlightNumber === ""
            ? null : parseInt(options.startFlightNumber, 10)
        const turn = parseInt(options.turnMin, 10)
        const price = parseInt(options.pricePct, 10)
        const wave = parseInt(options.waveSpacingMin, 10)
        return {
            pattern: AesRoutePlanner._pattern(options.pattern || D.pattern),
            airports,
            hub,
            aircraft: AesRoutePlanner.normalizeAircraftList(options.aircraft || options.aircraftText || []),
            flightCount: Number.isFinite(count) ? Math.max(1, Math.min(200, count)) : D.flightCount,
            startFlightNumber: Number.isFinite(startNum) && startNum >= 1 && startNum <= 9999 ? startNum : null,
            startTime: AesRoutePlanner._normaliseTime(options.startTime) || D.startTime,
            turnMin: Number.isFinite(turn) ? Math.max(0, Math.min(240, turn)) : D.turnMin,
            waveSpacingMin: Number.isFinite(wave) ? Math.max(0, Math.min(720, wave)) : 30,
            defaultBlockMin: Number(options.defaultBlockMin) || D.defaultBlockMin,
            cruiseKmh: Number(options.cruiseKmh) || D.cruiseKmh,
            longFlightMin: Number(options.longFlightMin) || D.longFlightMin,
            routeMeta: options.routeMeta || {},
            pricePct: Number.isFinite(price) && price >= 50 && price <= 200 ? price : D.pricePct,
            service: typeof options.service === "string" ? options.service : D.service
        }
    }

    static _normaliseAircraft(item) {
        if (!item) return null
        if (typeof item === "object") {
            const id = String(item.aircraftId || item.id || item.value || "").trim()
            if (!id) return null
            return {
                aircraftId: id,
                registration: String(item.registration || item.tail || item.label || "").trim(),
                hub: AesRoutePlanner._iata(item.hub || item.location || item.base) || ""
            }
        }
        const token = String(item).trim()
        if (!token) return null
        return {aircraftId: token, registration: token, hub: ""}
    }

    static _pattern(value) {
        const v = String(value || "").toLowerCase()
        return ["out-and-back", "chain", "hub-spokes"].indexOf(v) !== -1 ? v : "out-and-back"
    }

    static _nextRoute(opts, state, cursor, flights) {
        const airports = opts.airports
        if (opts.pattern === "chain") {
            const origin = state.location || airports[cursor.chainIndex % airports.length]
            let nextIdx = airports.indexOf(origin) + 1
            if (nextIdx <= 0) nextIdx = cursor.chainIndex + 1
            let dest = airports[nextIdx % airports.length]
            if (dest === origin) dest = airports[(nextIdx + 1) % airports.length]
            cursor.chainIndex++
            return dest && dest !== origin ? {origin, destination: dest} : null
        }

        const destinations = AesRoutePlanner._rankDestinations(opts)
        if (!destinations.length) return null

        if (opts.pattern === "hub-spokes") {
            const dest = destinations[cursor.destIndex % destinations.length]
            cursor.destIndex++
            return {origin: opts.hub, destination: dest}
        }

        if (state.location && state.location !== opts.hub) {
            return {origin: state.location, destination: opts.hub}
        }
        const dest = destinations[cursor.destIndex % destinations.length]
        cursor.destIndex++
        return {origin: opts.hub, destination: dest}
    }

    static _rankDestinations(opts) {
        const hub = opts.hub
        return opts.airports.filter(iata => iata !== hub).sort((a, b) => {
            const ma = AesRoutePlanner._routeMeta(opts.routeMeta, hub, a) || {}
            const mb = AesRoutePlanner._routeMeta(opts.routeMeta, hub, b) || {}
            const sa = Number.isFinite(ma.score) ? ma.score : 0
            const sb = Number.isFinite(mb.score) ? mb.score : 0
            return (sb - sa) || a.localeCompare(b)
        })
    }

    static _pickAircraftState(states, seq) {
        states.sort((a, b) => a.nextAbsMin - b.nextAbsMin)
        if (!states.length) return null
        const soonest = states[0].nextAbsMin
        const tied = states.filter(s => s.nextAbsMin === soonest)
        return tied[seq % tied.length] || states[0]
    }

    static _routeMeta(routeMeta, origin, dest) {
        if (!routeMeta) return null
        const keys = [
            String(origin || "") + "-" + String(dest || ""),
            String(origin || "") + String(dest || ""),
            String(dest || "") + "-" + String(origin || ""),
            String(dest || "") + String(origin || "")
        ]
        for (const key of keys) {
            if (routeMeta[key]) return routeMeta[key]
        }
        return null
    }

    static _snapAbsMinute(absMin, blockMin, seq, longFlightMin) {
        const threshold = Number(longFlightMin) || AesRoutePlanner.DEFAULTS.longFlightMin
        const step = blockMin >= threshold ? 5 : 10
        const jitter = blockMin >= threshold ? ((seq * 17) % 45) : ((seq % 3) * 5)
        return AesRoutePlanner._roundTo(absMin + jitter, step)
    }

    static _irregularTurnOffset(blockMin, seq, longFlightMin) {
        const threshold = Number(longFlightMin) || AesRoutePlanner.DEFAULTS.longFlightMin
        if (blockMin < threshold) return (seq % 2) * 5
        return 15 + ((seq * 23) % 55)
    }

    static _flightNote(blockMin, gapMin) {
        if (blockMin >= AesRoutePlanner.DEFAULTS.longFlightMin) {
            return "long leg: sequential gap +" + gapMin + "m"
        }
        return "standard turn"
    }

    static _warnings(opts, flights) {
        const out = []
        if (flights.length < opts.flightCount) out.push("Generated fewer flights than requested.")
        if (!Object.keys(opts.routeMeta || {}).length) out.push("No distance cache found; fallback block times used.")
        return out
    }

    static _iata(value) {
        const m = String(value || "").toUpperCase().match(/\b([A-Z0-9]{3})\b/)
        return m ? m[1] : ""
    }

    static _normaliseTime(value) {
        const min = AesRoutePlanner._parseMin(value)
        return min == null ? "" : AesRoutePlanner.formatHHMM(min)
    }

    static _parseMin(value) {
        const m = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        const h = parseInt(m[1], 10)
        const mn = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return null
        return h * 60 + mn
    }

    static _dayIndex(absMin) {
        return ((Math.floor(absMin / (24 * 60)) % 7) + 7) % 7
    }

    static _roundTo(value, step) {
        return Math.round(value / step) * step
    }
}

if (typeof window !== "undefined") {
    window.AesRoutePlanner = AesRoutePlanner
}
