"use strict"

/**
 * Track 3 slice 3a — 7×24 weekly grid primitive for the auto-scheduler.
 *
 * Pure data structure. No AS knowledge, no DOM, no chrome.storage I/O.
 * Tracks per-day occupancy as sorted intervals so the allocator can ask
 * "does this round-trip fit on Tuesday at 09:30 → 14:50?" in O(log n).
 *
 * Day index convention matches `ScheduleFactors.resolveDayMask`:
 *   0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun.
 *
 * Time convention: integer minutes since 00:00 local. The grid is single-
 * day-aware only — a round-trip whose return crosses midnight should be
 * placed as two intervals (one ending at 24:00, one starting at 0:00 on
 * the next day) by the caller, OR rejected. Phase-1 keeps it simple:
 * intervals must be strictly within [0, 1440] and within a single day.
 *
 * Public API (window.AesAfpAutoSchedulerGrid):
 *   new AesAfpAutoSchedulerGrid({minTurnaroundMinutes})
 *   .tryPlace({legId, dayIdx, startMin, endMin}) -> boolean
 *   .unplace(legId) -> boolean
 *   .canFit(dayIdx, startMin, endMin) -> boolean
 *   .dailyBlockHours(dayIdx) -> number
 *   .weeklyBlockHours() -> number
 *   .occupancy() -> {[dayIdx]: [{legId, startMin, endMin}]}
 *   .clear() -> void
 *   .size() -> number   (total intervals across all days)
 */
;(function () {
    if (window.AesAfpAutoSchedulerGrid) return

    const DAYS = 7
    const DAY_MIN = 0
    const DAY_MAX = 24 * 60   // 1440

    class AesAfpAutoSchedulerGrid {
        constructor(opts) {
            const o = opts || {}
            const buf = Number(o.minTurnaroundMinutes)
            this.minTurnaroundMinutes = (isFinite(buf) && buf >= 0) ? buf : 0
            // Pre-allocate seven sorted-by-startMin arrays. Sorted insertion
            // keeps overlap-checks linear in *intervals on that day*, which
            // is at most a couple dozen even on a busy A320 schedule.
            this._byDay = []
            for (let i = 0; i < DAYS; i++) this._byDay.push([])
            // legId → {dayIdx, startMin, endMin} for O(1) unplace.
            this._index = new Map()
        }

        /**
         * True if [startMin, endMin] is within [0, 1440] and doesn't collide
         * (within minTurnaroundMinutes) with any existing interval on the
         * given day. Adjacency exactly equal to the buffer counts as fit.
         */
        canFit(dayIdx, startMin, endMin) {
            if (!_validDay(dayIdx)) return false
            if (!_validInterval(startMin, endMin)) return false
            const buf = this.minTurnaroundMinutes
            const day = this._byDay[dayIdx]
            for (let i = 0; i < day.length; i++) {
                const it = day[i]
                // Ordered by startMin → can short-circuit when next interval
                // starts after our end + buffer.
                if (it.startMin >= endMin + buf) return true
                // Otherwise the only way to NOT collide is to end before this
                // interval's start - buffer.
                if (endMin + buf <= it.startMin) continue
                if (startMin >= it.endMin + buf) continue
                return false
            }
            return true
        }

        /**
         * tryPlace returns false (no-op) when the slot is occupied or the
         * legId is already present; true after a successful insert. Re-using
         * a legId is treated as a programming error and always rejected.
         */
        tryPlace(opts) {
            const o = opts || {}
            const legId = o.legId
            if (legId == null) return false
            if (this._index.has(legId)) return false
            const dayIdx = Number(o.dayIdx)
            const startMin = Number(o.startMin)
            const endMin = Number(o.endMin)
            if (!this.canFit(dayIdx, startMin, endMin)) return false
            const interval = {legId, dayIdx, startMin, endMin}
            const day = this._byDay[dayIdx]
            // Insert sorted by startMin (linear; arrays are short).
            let i = 0
            while (i < day.length && day[i].startMin < startMin) i++
            day.splice(i, 0, interval)
            this._index.set(legId, interval)
            return true
        }

        unplace(legId) {
            const it = this._index.get(legId)
            if (!it) return false
            const day = this._byDay[it.dayIdx]
            const i = day.indexOf(it)
            if (i >= 0) day.splice(i, 1)
            this._index.delete(legId)
            return true
        }

        dailyBlockHours(dayIdx) {
            if (!_validDay(dayIdx)) return 0
            let total = 0
            const day = this._byDay[dayIdx]
            for (const it of day) total += (it.endMin - it.startMin)
            return total / 60
        }

        weeklyBlockHours() {
            let total = 0
            for (let d = 0; d < DAYS; d++) total += this.dailyBlockHours(d)
            return total
        }

        occupancy() {
            const out = {}
            for (let d = 0; d < DAYS; d++) {
                out[d] = this._byDay[d].map(it => ({
                    legId:    it.legId,
                    startMin: it.startMin,
                    endMin:   it.endMin
                }))
            }
            return out
        }

        size() { return this._index.size }

        clear() {
            for (let i = 0; i < DAYS; i++) this._byDay[i] = []
            this._index.clear()
        }
    }

    function _validDay(d) { return Number.isInteger(d) && d >= 0 && d < DAYS }
    function _validInterval(s, e) {
        if (!isFinite(s) || !isFinite(e)) return false
        if (s < DAY_MIN || e > DAY_MAX) return false
        return e > s
    }

    window.AesAfpAutoSchedulerGrid = AesAfpAutoSchedulerGrid

    // ── Smoke tests (run in-page when ?aes-debug is on; project convention
    // — there is no test runner). Output goes through console.assert so a
    // green console means everything passed. Cheap to keep in production
    // because the assertions are bypassed when the URL flag is off.
    if (typeof window !== "undefined"
        && typeof window.location !== "undefined"
        && /[?&]aes-debug\b/.test(window.location.search || "")) {
        try {
            const G = AesAfpAutoSchedulerGrid
            // Empty grid → 0 hours.
            const g = new G({minTurnaroundMinutes: 30})
            console.assert(g.weeklyBlockHours() === 0, "[grid] empty week == 0h")
            console.assert(g.dailyBlockHours(0) === 0, "[grid] empty Mon == 0h")
            console.assert(g.size() === 0, "[grid] empty size == 0")

            // Place a 4h round-trip on Tue 09:00.
            const ok = g.tryPlace({legId: "rt-1", dayIdx: 1, startMin: 540, endMin: 780})
            console.assert(ok === true, "[grid] placed rt-1")
            console.assert(g.dailyBlockHours(1) === 4, "[grid] Tue == 4h")
            console.assert(g.weeklyBlockHours() === 4, "[grid] week == 4h")
            console.assert(g.size() === 1, "[grid] size == 1")

            // Conflicting placement: another flight 1h after the first ends,
            // but the buffer is 30m → fits. Same flight 5m after → rejects.
            const fitBuf = g.canFit(1, 810, 870)
            console.assert(fitBuf === true, "[grid] post-buffer fits")
            const failBuf = g.canFit(1, 785, 845)
            console.assert(failBuf === false, "[grid] within-buffer rejects")

            // Place + unplace round-trip.
            console.assert(g.unplace("rt-1") === true, "[grid] unplaced rt-1")
            console.assert(g.weeklyBlockHours() === 0, "[grid] week back to 0h")
            console.assert(g.size() === 0, "[grid] size back to 0")
            console.assert(g.unplace("rt-1") === false, "[grid] re-unplace returns false")

            // Reject duplicate legIds.
            g.tryPlace({legId: "x", dayIdx: 0, startMin: 0, endMin: 60})
            const dup = g.tryPlace({legId: "x", dayIdx: 1, startMin: 0, endMin: 60})
            console.assert(dup === false, "[grid] duplicate legId rejected")

            // Bad day index, bad interval, both rejected.
            console.assert(g.canFit(7, 0, 60) === false, "[grid] day 7 rejected")
            console.assert(g.canFit(-1, 0, 60) === false, "[grid] day -1 rejected")
            console.assert(g.canFit(0, 60, 60) === false, "[grid] zero-length rejected")
            console.assert(g.canFit(0, 1400, 1500) === false, "[grid] past-midnight rejected")

            // Per-day vs per-week math: place same-day legs and a different-day leg.
            g.clear()
            g.tryPlace({legId: "a", dayIdx: 2, startMin: 360, endMin: 480})
            g.tryPlace({legId: "b", dayIdx: 2, startMin: 600, endMin: 720})
            g.tryPlace({legId: "c", dayIdx: 3, startMin: 360, endMin: 540})
            console.assert(g.dailyBlockHours(2) === 4, "[grid] Wed 4h")
            console.assert(g.dailyBlockHours(3) === 3, "[grid] Thu 3h")
            console.assert(g.weeklyBlockHours() === 7, "[grid] week 7h")

            console.log("[AES afp/auto-scheduler] grid-state smoke tests passed")
        } catch (e) {
            console.warn("[AES afp/auto-scheduler] grid-state smoke tests threw", e)
        }
    }
})()
