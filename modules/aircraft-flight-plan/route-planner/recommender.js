"use strict"

/**
 * Route Planner — recommender (pure).
 *
 * Takes a hub, an aircraft spec, a list of selected destinations (each with
 * distanceKm), and a target total flight count. Returns a leg buffer that
 * can be fed straight into AesAfpFleetApplyOrchestrator via its expected
 * leg shape: {origin, destination, depTime, dayMask[7], pricePct, service}.
 *
 * Allocation rules:
 *   • Each round-trip leg (out + back) consumes block time
 *       blockHrs = 2 * (distanceKm / cruiseSpeedKmh + turnaroundMin/60)
 *     We round up to a whole hour for slot accounting.
 *   • Long routes (one-way ≥ LONG_HAUL_HOURS) are limited to 1–2 frequencies/week,
 *     with sequential day-of-week placement (e.g. Mon+Thu, Tue+Fri) so the
 *     aircraft has a return + turnaround day before the next outbound. The
 *     departure time defaults to 09:00 + (idx * stagger) modulo a 24h day.
 *   • Short routes (one-way ≤ SHORT_HAUL_HOURS) get higher frequency (up to
 *     daily) and may run multiple times per day if the slot budget allows.
 *   • Medium routes get daily-or-near-daily.
 *
 * Pure — no DOM, no chrome.* APIs, no I/O. Output is sorted by destination.
 *
 * Public API (window.AesAfpRoutePlannerRecommender):
 *   recommend({hub, spec, destinations, targetFlightCount, opts?}) → Plan
 *
 * Plan shape:
 *   {
 *     legs:       [{origin, destination, depTime, dayMask, pricePct, service,
 *                   _meta: {distanceKm, blockHrs, freqPerWeek, classification}}],
 *     summary:    {totalLegs, byDestination: {IATA: count}, totalBlockHrs,
 *                  utilizationPct},
 *     warnings:   [string]
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesAfpRoutePlannerRecommender) return

    const DEFAULTS = {
        turnaroundMin:        45,
        cruiseSpeedKmh:       820,
        defaultDepTime:       "09:00",
        defaultPricePct:      100,
        defaultService:       "",
        // Classification thresholds (one-way flight hours, NOT round-trip).
        shortHaulHours:        4,
        longHaulHours:         9,
        // Long-haul frequency cap per week.
        longHaulMaxFreq:       2,
        // Long-haul minimum spacing in days (out + return + buffer).
        longHaulMinSpacingDays: 3,
        // Stagger between rotations on the same day (minutes) — keeps multiple
        // short-haul rotations from colliding on the slot grid.
        intraDayStaggerMin:    180,
        // Total schedulable hours per week (24h × 7d). Used to detect overload.
        weeklyHoursBudget:     168
    }

    function _num(v, f) { const n = Number(v); return Number.isFinite(n) ? n : f }

    function _addMinutesToHHMM(hhmm, addMin) {
        const m = String(hhmm || "00:00").match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return hhmm
        const total = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + Math.round(addMin)) % (24 * 60)
        const h = Math.floor(total / 60), mn = total % 60
        return String(h).padStart(2, "0") + ":" + String(mn).padStart(2, "0")
    }

    function _classify(blockOneWayHrs, opts) {
        if (blockOneWayHrs >= opts.longHaulHours)  return "long"
        if (blockOneWayHrs <= opts.shortHaulHours) return "short"
        return "medium"
    }

    /** Build a 7-element boolean dayMask for a given frequency, using
     *  evenly-spaced days starting at startDay. For freq=2 startDay=0:
     *  Mon + Thu (gap 3). For freq=3 startDay=1: Tue+Thu+Sat. */
    function _spreadDayMask(freqPerWeek, startDay) {
        const mask = [false, false, false, false, false, false, false]
        if (freqPerWeek <= 0) return mask
        if (freqPerWeek >= 7) return [true, true, true, true, true, true, true]
        const step = 7 / freqPerWeek
        for (let i = 0; i < freqPerWeek; i++) {
            const d = Math.floor(((startDay || 0) + i * step) % 7)
            mask[d] = true
        }
        return mask
    }

    /**
     * Allocate the requested flight count across destinations.
     *
     * Strategy:
     *   • Compute each destination's *natural* per-week capacity given the
     *     aircraft block time (how many round-trips fit in 168 hours
     *     dedicated to that route).
     *   • For short/medium routes, scale the natural capacity by a weight
     *     (default 1) so the user can prioritise some destinations.
     *   • For long routes, hard-cap at longHaulMaxFreq regardless of
     *     natural capacity.
     *   • Distribute the target flight count proportionally to each
     *     destination's allocation cap, then round to integers, then
     *     re-balance the rounding error.
     *
     * Returns a Map<IATA, {freq, classification, blockHrs}>.
     */
    function _allocateFrequencies(destinations, target, spec, opts) {
        const speed = _num(spec && spec.cruiseSpeedKmh, opts.cruiseSpeedKmh)
        const turn  = _num(spec && spec.turnaroundMin,  opts.turnaroundMin)
        const items = []
        for (const d of destinations) {
            const dist = _num(d.distanceKm, NaN)
            if (!isFinite(dist) || dist <= 0) continue
            const oneWayHrs = dist / speed + turn / 60
            const blockHrs  = 2 * oneWayHrs   // round-trip incl. turnaround
            const cls       = _classify(oneWayHrs, opts)
            // Capacity = how many rotations per week fit if this route owned
            // the entire week. Floor; never zero (always at least 1 freq if
            // physically possible within 168h).
            const naturalCap = Math.max(1, Math.floor(opts.weeklyHoursBudget / blockHrs))
            // Long-haul hard cap.
            const cap = cls === "long"
                ? Math.min(opts.longHaulMaxFreq, naturalCap)
                : naturalCap
            const weight = _num(d.weight, 1)
            items.push({
                iata: d.iata,
                weight: weight,
                cap: cap,
                blockHrs: blockHrs,
                classification: cls
            })
        }
        if (!items.length) return new Map()
        // Floor allocation: every selected destination gets at least 1 flight
        // (when target permits + capacity allows). The user picked these
        // destinations explicitly, so a small target shouldn't drop one
        // entirely — that would surprise the user.
        const result = new Map()
        let allocated = 0
        const minFloor = Math.min(1, Math.floor(target / Math.max(1, items.length)))
        // Phase 1 — guarantee floor.
        for (const it of items) {
            const f = Math.min(it.cap, Math.max(0, minFloor))
            result.set(it.iata, {freq: f, classification: it.classification,
                                 blockHrs: it.blockHrs, _frac: 0, _cap: it.cap})
            allocated += f
        }
        // If target ≥ N(items), every destination got ≥1. If target < N(items),
        // we'll fall through to phase 2 with a 0-floor; that case is rare
        // (user picked 5 dests and wants 3 flights) — distribute remaining
        // by weight × cap.
        let remaining = target - allocated
        // Phase 2 — proportional distribution of the remainder.
        const sumWeightedCap = items.reduce((s, it) => s + (it.cap * it.weight), 0)
        if (sumWeightedCap > 0 && remaining > 0) {
            for (const it of items) {
                const v = result.get(it.iata)
                const share = (it.cap * it.weight) / sumWeightedCap
                const raw   = share * remaining
                const f     = Math.max(0, Math.min(it.cap - v.freq, Math.floor(raw)))
                v.freq += f
                v._frac = raw - f
                allocated += f
            }
        }
        remaining = target - allocated
        // Phase 3 — distribute leftover (rounding error) by highest frac remainder
        // among destinations not yet at cap.
        if (remaining > 0) {
            const sorted = Array.from(result.entries())
                .filter(([_, v]) => v.freq < v._cap)
                .sort((a, b) => b[1]._frac - a[1]._frac)
            for (const [iata, v] of sorted) {
                if (remaining <= 0) break
                const add = Math.min(remaining, v._cap - v.freq)
                v.freq += add
                remaining -= add
            }
        }
        // Strip helper fields.
        for (const [, v] of result) { delete v._frac; delete v._cap }
        return result
    }

    /**
     * Build the leg buffer from the allocation map. Each (destination, freq)
     * pair becomes ONE leg with a 7-day dayMask. The dayMask spreads the
     * frequency across the week:
     *
     *   • short/medium with freq ≥ 7 → all days
     *   • short/medium with freq < 7 → evenly spread starting at idx % 7
     *   • long → spaced by ≥ longHaulMinSpacingDays
     *
     * Multi-rotation per day for high-frequency short routes is modelled
     * by emitting MULTIPLE legs (each with the same destination but a
     * staggered depTime) — that's how AS represents distinct flight
     * numbers on the same route.
     */
    function _buildLegs(hub, allocation, opts) {
        const legs = []
        let destIdx = 0
        for (const [iata, info] of allocation) {
            if (info.freq <= 0) { destIdx++; continue }
            const cls = info.classification
            // For short/medium with freq > 7, split into multiple flight numbers.
            // Each FN gets a base depTime offset by intraDayStaggerMin.
            if (cls !== "long" && info.freq > 7) {
                const rotations = Math.ceil(info.freq / 7)
                let remaining = info.freq
                for (let r = 0; r < rotations; r++) {
                    const f = Math.min(7, remaining)
                    remaining -= f
                    legs.push(_makeLeg(hub, iata, info, _spreadDayMask(f, destIdx),
                        _addMinutesToHHMM(opts.defaultDepTime, r * opts.intraDayStaggerMin),
                        opts))
                }
            } else if (cls === "long") {
                // Long-haul: single FN, sparse dayMask, depTime staggered per
                // destination so two long flights don't both leave at 09:00.
                const startDay = (destIdx * opts.longHaulMinSpacingDays) % 7
                const mask = _spreadDayMask(Math.min(info.freq, opts.longHaulMaxFreq), startDay)
                const stagger = (destIdx * 90) % (24 * 60)  // 90-min stagger across long-haul dests
                const depTime = _addMinutesToHHMM(opts.defaultDepTime, stagger)
                legs.push(_makeLeg(hub, iata, info, mask, depTime, opts))
            } else {
                // Short/medium with freq ≤ 7: one FN.
                const startDay = destIdx % 7
                const mask = _spreadDayMask(info.freq, startDay)
                const stagger = (destIdx * 30) % (24 * 60)
                const depTime = _addMinutesToHHMM(opts.defaultDepTime, stagger)
                legs.push(_makeLeg(hub, iata, info, mask, depTime, opts))
            }
            destIdx++
        }
        return legs
    }

    function _makeLeg(hub, iata, info, dayMask, depTime, opts) {
        const freqOnMask = dayMask.filter(Boolean).length
        return {
            origin:           hub,
            destination:      iata,
            depTime:          depTime,
            dayMask:          dayMask.slice(),
            pricePct:         opts.defaultPricePct,
            service:          opts.defaultService,
            flightNumberText: "",
            _meta: {
                distanceKm:     null,   // filled in by caller from destination record
                blockHrs:       Math.round(info.blockHrs * 10) / 10,
                freqPerWeek:    freqOnMask,
                classification: info.classification
            }
        }
    }

    /**
     * Public entry — see top-of-file docstring.
     */
    function recommend(input) {
        const i = input || {}
        const opts = Object.assign({}, DEFAULTS, i.opts || {})
        const warnings = []

        const hub = String(i.hub || "").toUpperCase()
        if (!hub || !/^[A-Z]{3}$/.test(hub)) {
            return {legs: [], summary: {totalLegs: 0}, warnings: ["invalid hub: " + i.hub]}
        }
        const spec = i.spec || {}
        if (!_num(spec.cruiseSpeedKmh, 0) || !_num(spec.range, 0)) {
            warnings.push("aircraft spec incomplete (missing cruiseSpeedKmh or range) — using defaults")
        }
        const dests = Array.isArray(i.destinations)
            ? i.destinations.filter(d => d && d.iata && _num(d.distanceKm, 0) > 0)
            : []
        if (!dests.length) {
            return {legs: [], summary: {totalLegs: 0}, warnings: ["no valid destinations provided"]}
        }
        // Filter by aircraft range (one-way).
        const range = _num(spec.range, Infinity)
        const filteredDests = dests.filter(d => {
            if (d.distanceKm > range) {
                warnings.push(d.iata + " out of range (" + Math.round(d.distanceKm)
                    + " km > aircraft range " + Math.round(range) + " km)")
                return false
            }
            return true
        })
        if (!filteredDests.length) {
            return {legs: [], summary: {totalLegs: 0}, warnings: warnings}
        }
        const target = Math.max(1, Math.round(_num(i.targetFlightCount, filteredDests.length)))

        const allocation = _allocateFrequencies(filteredDests, target, spec, opts)
        const legs = _buildLegs(hub, allocation, opts)
        // Backfill distanceKm onto leg meta from the source dest list.
        const distMap = new Map(filteredDests.map(d => [String(d.iata).toUpperCase(), d.distanceKm]))
        for (const l of legs) {
            l._meta.distanceKm = distMap.get(String(l.destination).toUpperCase()) || null
        }

        const byDestination = {}
        let totalBlockHrs = 0
        let totalLegs = 0
        for (const l of legs) {
            const f = l._meta.freqPerWeek
            byDestination[l.destination] = (byDestination[l.destination] || 0) + f
            totalBlockHrs += l._meta.blockHrs * f
            totalLegs     += f
        }
        const utilization = Math.min(1, totalBlockHrs / opts.weeklyHoursBudget)
        if (utilization >= 0.95) {
            warnings.push("aircraft utilization " + Math.round(utilization * 100)
                + "% — consider lowering target flight count or splitting across more aircraft")
        }
        if (totalLegs < target) {
            warnings.push("only " + totalLegs + " legs allocated of requested " + target
                + " (capped by aircraft block time + range)")
        }

        return {
            legs:     legs,
            summary:  {
                totalLegs:        totalLegs,
                byDestination:    byDestination,
                totalBlockHrs:    Math.round(totalBlockHrs * 10) / 10,
                utilizationPct:   Math.round(utilization * 100),
                requestedTarget:  target
            },
            warnings: warnings
        }
    }

    window.AesAfpRoutePlannerRecommender = {
        recommend:           recommend,
        _spreadDayMask:      _spreadDayMask,
        _classify:           _classify,
        _addMinutesToHHMM:   _addMinutesToHHMM,
        _allocateFrequencies: _allocateFrequencies,
        DEFAULTS:            DEFAULTS
    }
})()
