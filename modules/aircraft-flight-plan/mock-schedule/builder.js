"use strict"

/**
 * Mock Schedule Builder — pure compute, no DOM, no chrome.storage.
 *
 * Given an aircraft spec (seats / range / cruise speed), a hub, a list of
 * candidate destinations (with distanceKm), and a target total weekly flight
 * count, produce a recommended schedule of legs ready for the existing
 * AesAfpSubmitBridge.submitLegInBackground apply path.
 *
 * Distance + speed drive a per-destination round-trip duration. Short-haul
 * (RT ≤ 12h) destinations can absorb multiple departures per day; medium
 * (12–36h) get one alternating-day cycle; long-haul (>36h) get 1–3 per week
 * with explicit day pinning so the aircraft is at the hub for departure.
 *
 * Output leg shape matches what AesAfpFormDriver.normaliseLeg consumes:
 *   {origin, destination, depTime: "HH:MM", dayMask: [Mon..Sun bools],
 *    pricePct, service, flightNumberText, sequenceGroup, sequenceOrder, kind,
 *    distanceKm, oneWayH, roundTripH, classification}
 *
 * sequenceGroup links outbound + inbound on long-haul so the GUI / apply
 * pipeline can render them together; sequenceOrder is 0 (out) or 1 (in).
 *
 * Pure function — no I/O. The browser bundle assigns the namespace at the
 * bottom; the Node test runner pulls the same exports via module.exports.
 */
;(function () {
    const HOURS_PER_DAY = 24
    const HOURS_PER_WEEK = 168
    const DAYS_PER_WEEK = 7

    const DEFAULTS = {
        groundTimeHubH:        2,        // turnaround at the hub
        groundTimeRemoteH:     1,        // turnaround at the remote airport
        workingHoursLocal:     {start: 6, end: 22},
        shortHaulCutoffH:      12,
        longHaulCutoffH:       36,
        defaultPricePct:       100,
        defaultService:        "",
        // SaberJet B-737 ~ 2h, B-767 ~ 1h, B-787 ~ 1h, A-380 ~ 1h
        // We let callers override per-spec but keep one default.
        minDepartureGapMin:    20        // floor between two same-day departures
    }

    /**
     * Classify a route by round-trip duration.
     *   SHORT  — RT ≤ shortHaulCutoffH (default 12h). Multiple per day OK.
     *   MEDIUM — shortHaul < RT ≤ longHaulCutoffH (default 36h). One per
     *            day, alternating with a return on the next morning.
     *   LONG   — RT > longHaulCutoffH. 1-3 per week, pinned to specific
     *            days so the aircraft is at the hub for the outbound.
     */
    function _classify(roundTripH, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        if (!isFinite(roundTripH) || roundTripH <= 0) return "UNKNOWN"
        if (roundTripH <= o.shortHaulCutoffH) return "SHORT"
        if (roundTripH <= o.longHaulCutoffH) return "MEDIUM"
        return "LONG"
    }

    function _oneWayHours(distanceKm, cruiseSpeedKmh) {
        const d = Number(distanceKm)
        const s = Number(cruiseSpeedKmh)
        if (!isFinite(d) || !isFinite(s) || s <= 0 || d <= 0) return null
        return d / s
    }

    function _roundTripHours(oneWayH, opts) {
        if (oneWayH == null) return null
        const o = Object.assign({}, DEFAULTS, opts || {})
        return 2 * oneWayH + o.groundTimeRemoteH + o.groundTimeHubH
    }

    /**
     * Theoretical weekly capacity per destination — how many round trips
     * the aircraft can do in 168h, leaving the hub turnaround in. Used as
     * a hard cap when distributing the flightsTarget; the user can ask
     * for fewer flights, never more than this.
     */
    function _maxWeeklyFlights(roundTripH, opts) {
        if (!isFinite(roundTripH) || roundTripH <= 0) return 0
        const o = Object.assign({}, DEFAULTS, opts || {})
        const cls = _classify(roundTripH, o)
        if (cls === "SHORT") {
            // SHORT routes don't need full back-to-back — they typically
            // stick to the working window. Cap at floor(workingDayLength / RT)
            // × 7 so a 4h RT in a 16h window gives 4×7 = 28 max per week.
            const dayLen = Math.max(1, o.workingHoursLocal.end - o.workingHoursLocal.start)
            return Math.max(1, Math.floor(dayLen / roundTripH)) * DAYS_PER_WEEK
        }
        if (cls === "MEDIUM") {
            return Math.max(1, Math.floor(HOURS_PER_WEEK / roundTripH))
        }
        // LONG
        return Math.max(1, Math.floor((HOURS_PER_WEEK - o.groundTimeHubH) / roundTripH))
    }

    /** Format hours-of-day (float) → "HH:MM" snapping to nearest 5 min. */
    function _formatHHMM(hourFloat) {
        let h = Math.floor(hourFloat)
        let m = Math.round((hourFloat - h) * 60 / 5) * 5
        if (m === 60) { h += 1; m = 0 }
        h = ((h % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY
        const pad = (n) => (n < 10 ? "0" + n : "" + n)
        return pad(h) + ":" + pad(m)
    }

    function _allDays() { return [true, true, true, true, true, true, true] }
    function _zeroDays() { return [false, false, false, false, false, false, false] }

    /**
     * Build short-haul departures. We want N flights/week over a chosen
     * subset of days. If perDayCount × 7 ≥ N, distribute as perDay × 7;
     * otherwise drop down to fewer days. Times spread across the working
     * window so the aircraft can complete consecutive round trips.
     */
    function _shortHaulLegs(hub, dest, count, oneWayH, roundTripH, opts, group) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const dayLen = Math.max(1, o.workingHoursLocal.end - o.workingHoursLocal.start)
        const perDayCap = Math.max(1, Math.floor(dayLen / roundTripH))
        const days = Math.min(DAYS_PER_WEEK, Math.max(1, Math.ceil(count / perDayCap)))
        const perDay = Math.min(perDayCap, Math.max(1, Math.ceil(count / days)))
        const dayMask = _zeroDays()
        for (let i = 0; i < days; i++) dayMask[i] = true

        const legs = []
        let assigned = 0
        for (let slot = 0; slot < perDay && assigned < count; slot++) {
            const depHour = o.workingHoursLocal.start + slot * roundTripH
            if (depHour + oneWayH > o.workingHoursLocal.end) break
            const stillToAssign = Math.min(days, count - assigned)
            const slotMask = _zeroDays()
            for (let i = 0; i < stillToAssign; i++) slotMask[i] = true
            legs.push({
                origin:           hub,
                destination:      dest.iata,
                depTime:          _formatHHMM(depHour),
                dayMask:          slotMask,
                pricePct:         o.defaultPricePct,
                service:          o.defaultService,
                flightNumberText: "",
                sequenceGroup:    group,
                sequenceOrder:    slot,
                kind:             "outbound",
                distanceKm:       dest.distanceKm,
                oneWayH,
                roundTripH,
                classification:   "SHORT",
                weekOccurrences:  stillToAssign
            })
            assigned += stillToAssign
        }
        if (assigned < count) {
            // Couldn't fit `count` in the window; cap silently and let the
            // caller raise a warning.
            legs.warningMessage = "short-haul " + dest.iata + " capped at "
                + assigned + "/" + count + " (working window " + dayLen + "h, RT " + roundTripH.toFixed(1) + "h)"
        }
        return legs
    }

    /**
     * Build medium-haul legs — aircraft does one outbound on day N, returns
     * day N+1. We schedule departures on alternating days starting Mon, Wed,
     * Fri up to count or 4 (which is the max with a 36h ceiling and one
     * aircraft).
     */
    function _mediumHaulLegs(hub, dest, count, oneWayH, roundTripH, opts, group) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const cap = Math.min(count, _maxWeeklyFlights(roundTripH, o))
        // Pick alternating days: 0, 2, 4, 6, then 1, 3, 5 if needed
        const order = [0, 2, 4, 6, 1, 3, 5].slice(0, cap)
        const legs = []
        // Aim for an early-morning departure so the inbound the next day
        // also lands in working hours at the hub.
        const depHour = Math.max(o.workingHoursLocal.start, 7)
        for (let i = 0; i < order.length; i++) {
            const dayIdx = order[i]
            const dayMask = _zeroDays()
            dayMask[dayIdx] = true
            legs.push({
                origin:           hub,
                destination:      dest.iata,
                depTime:          _formatHHMM(depHour),
                dayMask,
                pricePct:         o.defaultPricePct,
                service:          o.defaultService,
                flightNumberText: "",
                sequenceGroup:    group,
                sequenceOrder:    i,
                kind:             "outbound",
                distanceKm:       dest.distanceKm,
                oneWayH,
                roundTripH,
                classification:   "MEDIUM",
                weekOccurrences:  1,
                pinnedDay:        dayIdx
            })
        }
        return legs
    }

    /**
     * Build long-haul legs — pin to specific days where the aircraft is
     * guaranteed to be at the hub. Stagger departures so two consecutive
     * outbounds don't collide with a still-inbound previous trip.
     */
    function _longHaulLegs(hub, dest, count, oneWayH, roundTripH, opts, group) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const cap = Math.min(count, _maxWeeklyFlights(roundTripH, o))
        // Each round-trip eats roundTripH hours. Place outbounds at integer
        // multiples of (roundTripH + slack) starting Monday 06:00 local.
        const slack = 1
        const stride = roundTripH + slack
        const legs = []
        for (let i = 0; i < cap; i++) {
            const startH = i * stride + o.workingHoursLocal.start
            const dayIdx = Math.min(DAYS_PER_WEEK - 1, Math.floor(startH / HOURS_PER_DAY))
            const hourOfDay = startH - dayIdx * HOURS_PER_DAY
            // Ensure the departure is within working hours; if it spills into
            // the night, push it forward to the next morning.
            let pinnedHour = hourOfDay
            let pinnedDay = dayIdx
            if (pinnedHour > o.workingHoursLocal.end) {
                pinnedDay = (pinnedDay + 1) % DAYS_PER_WEEK
                pinnedHour = o.workingHoursLocal.start
            }
            const dayMask = _zeroDays()
            dayMask[pinnedDay] = true
            legs.push({
                origin:           hub,
                destination:      dest.iata,
                depTime:          _formatHHMM(pinnedHour),
                dayMask,
                pricePct:         o.defaultPricePct,
                service:          o.defaultService,
                flightNumberText: "",
                sequenceGroup:    group,
                sequenceOrder:    i,
                kind:             "outbound",
                distanceKm:       dest.distanceKm,
                oneWayH,
                roundTripH,
                classification:   "LONG",
                weekOccurrences:  1,
                pinnedDay,
                irregularTime:    true
            })
        }
        return legs
    }

    /**
     * Distribute total flights across destinations, capped per-dest by the
     * weekly maximum derived from round-trip duration. Leftover after caps
     * gets re-assigned to the most permissive (shortest RT) dests.
     */
    function _distributeFlights(destinations, flightsTarget, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {})
        const N = destinations.length
        if (!N || flightsTarget <= 0) return []
        // Sort: ascending by roundTripH so short-haul gets the leftover.
        const sorted = destinations.slice().sort((a, b) => a.roundTripH - b.roundTripH)
        const equalShare = Math.ceil(flightsTarget / N)
        const allocs = sorted.map(d => ({d, want: Math.min(equalShare, d.maxWeekly), got: 0}))
        let placed = 0
        for (const a of allocs) {
            const give = Math.min(a.want, flightsTarget - placed)
            a.got = give
            placed += give
        }
        // Re-distribute remainder to short-haul dests with capacity.
        let i = 0
        while (placed < flightsTarget && i < allocs.length * 4) {
            const slot = allocs[i % allocs.length]
            if (slot.got < slot.d.maxWeekly) {
                slot.got += 1
                placed += 1
            }
            i++
        }
        return allocs
    }

    /**
     * Public entry. See file header for full contract.
     */
    function recommend(input) {
        const i = input || {}
        const opts = Object.assign({}, DEFAULTS, i.opts || {})
        const hub = String(i.hub || "").toUpperCase()
        const spec = i.spec || {}
        const flightsTarget = Math.max(0, Math.floor(Number(i.flightsTarget) || 0))
        const speed = Number(spec.cruiseSpeedKmh)
        const range = Number(spec.range)
        const warnings = []

        if (!hub) warnings.push("hub missing")
        if (!isFinite(speed) || speed <= 0) warnings.push("aircraft cruise speed missing or invalid")
        if (!isFinite(range) || range <= 0) warnings.push("aircraft range missing or invalid")

        const dests = (i.destinations || [])
            .map(d => {
                const iata = String(d.iata || "").toUpperCase()
                const dist = Number(d.distanceKm)
                if (!iata || !isFinite(dist) || dist <= 0) return null
                if (isFinite(range) && dist > range) {
                    warnings.push(iata + " out of range (" + Math.round(dist) + " km > " + range + " km)")
                    return null
                }
                const oneWayH = _oneWayHours(dist, speed)
                const roundTripH = _roundTripHours(oneWayH, opts)
                const cls = _classify(roundTripH, opts)
                return {
                    iata,
                    distanceKm: dist,
                    oneWayH,
                    roundTripH,
                    classification: cls,
                    maxWeekly: _maxWeeklyFlights(roundTripH, opts)
                }
            })
            .filter(Boolean)

        if (!dests.length) {
            return {legs: [], warnings: warnings.concat(["no usable destinations"]), totals: _emptyTotals()}
        }
        if (flightsTarget === 0) {
            return {legs: [], warnings: warnings.concat(["flightsTarget is 0"]), totals: _emptyTotals()}
        }

        const totalCapacity = dests.reduce((s, d) => s + d.maxWeekly, 0)
        if (flightsTarget > totalCapacity) {
            warnings.push("flightsTarget " + flightsTarget + " exceeds aircraft weekly capacity "
                + totalCapacity + " across selected destinations; capping")
        }

        const allocs = _distributeFlights(dests, Math.min(flightsTarget, totalCapacity), opts)
        const legs = []
        for (const a of allocs) {
            if (a.got <= 0) continue
            const group = "mock-" + a.d.iata
            let perDestLegs = []
            if (a.d.classification === "SHORT") {
                perDestLegs = _shortHaulLegs(hub, a.d, a.got, a.d.oneWayH, a.d.roundTripH, opts, group)
            } else if (a.d.classification === "MEDIUM") {
                perDestLegs = _mediumHaulLegs(hub, a.d, a.got, a.d.oneWayH, a.d.roundTripH, opts, group)
            } else if (a.d.classification === "LONG") {
                perDestLegs = _longHaulLegs(hub, a.d, a.got, a.d.oneWayH, a.d.roundTripH, opts, group)
            } else {
                warnings.push(a.d.iata + " classification UNKNOWN — skipped")
                continue
            }
            if (perDestLegs.warningMessage) warnings.push(perDestLegs.warningMessage)
            for (const leg of perDestLegs) legs.push(leg)
        }

        return {
            legs,
            warnings,
            totals: _summarise(legs, dests, flightsTarget)
        }
    }

    function _emptyTotals() {
        return {scheduledFlights: 0, byDest: {}, longHaulCount: 0, mediumHaulCount: 0, shortHaulCount: 0}
    }

    function _summarise(legs, dests, target) {
        const out = _emptyTotals()
        out.requested = target
        for (const l of legs) {
            const occ = l.weekOccurrences || 1
            out.scheduledFlights += occ
            out.byDest[l.destination] = (out.byDest[l.destination] || 0) + occ
            if (l.classification === "LONG") out.longHaulCount += occ
            else if (l.classification === "MEDIUM") out.mediumHaulCount += occ
            else if (l.classification === "SHORT") out.shortHaulCount += occ
        }
        out.byClassification = {
            SHORT: out.shortHaulCount,
            MEDIUM: out.mediumHaulCount,
            LONG: out.longHaulCount
        }
        return out
    }

    const api = {
        recommend,
        DEFAULTS,
        _internal: {
            _classify,
            _oneWayHours,
            _roundTripHours,
            _maxWeeklyFlights,
            _formatHHMM,
            _shortHaulLegs,
            _mediumHaulLegs,
            _longHaulLegs,
            _distributeFlights
        }
    }

    if (typeof window !== "undefined") {
        window.AesAfpMockScheduleBuilder = api
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api
    }
})()
