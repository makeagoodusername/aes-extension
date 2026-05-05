"use strict"

/**
 * Track 6 slice 6b — schedule diff engine.
 * Track 7 slice 7e — flightId-precedence pass + locked bucket.
 *
 * Pure compare function. No DOM, no chrome.storage, no AS knowledge —
 * the caller hands in two arrays of legs (current and proposed) and
 * gets back a {keep, delete, add, moveTime, locked} bucketing.
 *
 * Match resolution order (7e):
 *   1. flightId-exact: when both sides expose `flightId`, an exact
 *      match wins regardless of time delta. This is the canonical
 *      identity AS hands us via the .block.flight overlay link
 *      (`vfp-reader` populates it; ScheduleBuilder propagates it on
 *      proposed legs that originated from a current schedule).
 *   2. (origin, destination, depTime ±15) — the legacy 6b heuristic.
 *      Used for proposed legs born from auto-build (no flightId yet).
 *
 * The flightId pass runs first so an exact identity always beats a
 * time-shaped neighbour: a leg the user moved by 30 minutes is still
 * the same leg, not a delete+add.
 *
 * Locked legs (7e): when a CURRENT leg's `modifiers.locked === true`
 * fails to match anything proposed, it goes into `result.locked`
 * instead of `result.delete`. apply-batch refuses to delete locked
 * legs without explicit override; this bucket lets callers (the
 * confirmation modal, the schedule-mgmt diff toggle) surface the
 * conflict separately.
 *
 * Phase 1 simplification: when a current leg's origin+dest match a
 * proposed leg but the depTime delta is OUTSIDE ±15 min, this slice
 * does NOT emit a moveTime entry — the pair gets split into a delete
 * + an add. The moveTime field is therefore always [] in Phase 1; it
 * stays in the return shape so slice 6e (transactional wipe-then-
 * rebuild) can later flip the heuristic without breaking callers.
 *
 * Day-of-week handling: this slice compares legs as-passed; it does
 * NOT expand a `dayMask` on proposed (ScheduleBuilder-shaped) legs.
 * Callers that pass in template legs and currentLegs from
 * `AesAfp.getCurrentSchedule()` (per-day expanded) should expand the
 * proposed side first.
 *
 * Multiple-match disambiguation: if more than one proposed leg
 * matches a current leg's (origin, dest, depTime±15) box, the diff
 * picks the proposed with the smallest absolute time delta. Each
 * proposed leg is claimed at most once per compare call.
 *
 * Unmatchable legs (missing origin / destination / depTimeLocal) on
 * the CURRENT side go into `delete` — they can't be kept (or `locked`
 * when modifiers.locked). On the PROPOSED side they go into `add`.
 *
 * Public API (window.AesAfpScheduleDiff):
 *   .compare(currentLegs, proposedLegs, opts?)
 *     → {keep:[{currentSeq, proposedSeq, deltaMin, matchedBy:"flightId"|"time"}],
 *        delete:[currentLeg], add:[proposedLeg], moveTime:[], locked:[currentLeg]}
 *   .timeDeltaMin(aHHMM, bHHMM)
 *     → absolute minute-distance between two HH:MM strings, taking the
 *       midnight-wrap shorter side (e.g. 23:50 vs 00:10 → 20)
 *   .isMatchable(leg) → boolean
 *   .TOLERANCE_MIN  (15)
 */
;(function () {
    if (window.AesAfpScheduleDiff) return

    const TOLERANCE_MIN = 15
    const IATA_RE = /^[A-Z]{3}$/
    const HHMM_RE = /^(\d{1,2}):(\d{2})$/

    /**
     * Diff two leg arrays. Returns the four buckets described in the
     * module header. Both arguments default to [] on bad input — the
     * caller never has to pre-validate.
     */
    function compare(currentLegs, proposedLegs, opts) {
        const cur = Array.isArray(currentLegs)  ? currentLegs  : []
        const pro = Array.isArray(proposedLegs) ? proposedLegs : []
        const result = {keep: [], delete: [], add: [], moveTime: [], locked: []}
        const toleranceMin = (opts && isFinite(Number(opts.toleranceMin)) && Number(opts.toleranceMin) >= 0)
            ? Number(opts.toleranceMin)
            : TOLERANCE_MIN

        if (!cur.length && !pro.length) return result

        // Partition each side into matchable / unmatchable. Unmatchable
        // current → delete (or locked); unmatchable proposed → add.
        // Matchable pairs run through the flightId-precedence pass and
        // then the (origin, dest, depTime±15) matcher below.
        const curMatch = []
        const curUnmatched = []
        for (const leg of cur) {
            if (!leg) continue
            if (isMatchable(leg)) curMatch.push(leg)
            else                  curUnmatched.push(leg)
        }
        const proMatch = []
        for (const leg of pro) {
            if (!leg) continue
            if (isMatchable(leg)) proMatch.push(leg)
            else                  result.add.push(leg)
        }

        const claimedProposed = new Set()
        const claimedCurrent  = new Set()

        // Pass 1 (7e): exact flightId match wins regardless of time
        // delta. AS hands us a stable per-leg id via the .block.flight
        // overlay; ScheduleBuilder propagates it onto proposed legs that
        // were carried forward from current. A leg the user shifted by
        // 30 minutes is still the same leg.
        const proByFlightId = new Map()
        for (let i = 0; i < proMatch.length; i++) {
            const fid = _flightIdOf(proMatch[i])
            if (fid != null) proByFlightId.set(fid, i)
        }
        for (let ci = 0; ci < curMatch.length; ci++) {
            const c = curMatch[ci]
            const fid = _flightIdOf(c)
            if (fid == null) continue
            const pi = proByFlightId.get(fid)
            if (pi == null || claimedProposed.has(pi)) continue
            const p = proMatch[pi]
            const d = timeDeltaMin(c.depTimeLocal, p.depTimeLocal)
            claimedProposed.add(pi)
            claimedCurrent.add(ci)
            result.keep.push({
                currentSeq:  c.seq != null ? c.seq : null,
                proposedSeq: p.seq != null ? p.seq : null,
                deltaMin:    d == null ? null : d,
                matchedBy:   "flightId"
            })
        }

        // Pass 2: for each remaining current leg, find the proposed leg
        // with the smallest absolute time delta among same-O/D unclaimed
        // candidates within ±toleranceMin. Greedy: a current leg never
        // re-shops once it claims a proposed leg.
        for (let ci = 0; ci < curMatch.length; ci++) {
            if (claimedCurrent.has(ci)) continue
            const c = curMatch[ci]
            let bestIdx = -1
            let bestDelta = Infinity
            for (let i = 0; i < proMatch.length; i++) {
                if (claimedProposed.has(i)) continue
                const p = proMatch[i]
                if (c.origin      !== p.origin)      continue
                if (c.destination !== p.destination) continue
                const d = timeDeltaMin(c.depTimeLocal, p.depTimeLocal)
                if (d == null)            continue
                if (d > toleranceMin)     continue
                if (d < bestDelta) { bestDelta = d; bestIdx = i }
            }
            if (bestIdx >= 0) {
                claimedProposed.add(bestIdx)
                claimedCurrent.add(ci)
                const p = proMatch[bestIdx]
                result.keep.push({
                    currentSeq:  c.seq != null ? c.seq : null,
                    proposedSeq: p.seq != null ? p.seq : null,
                    deltaMin:    bestDelta,
                    matchedBy:   "time"
                })
            }
        }

        // Route remaining current legs to delete or locked.
        for (let ci = 0; ci < curMatch.length; ci++) {
            if (claimedCurrent.has(ci)) continue
            _routeUnmatchedCurrent(curMatch[ci], result)
        }
        for (const leg of curUnmatched) {
            _routeUnmatchedCurrent(leg, result)
        }

        for (let i = 0; i < proMatch.length; i++) {
            if (!claimedProposed.has(i)) result.add.push(proMatch[i])
        }
        return result
    }

    function _flightIdOf(leg) {
        if (!leg) return null
        const v = leg.flightId
        if (v == null) return null
        const s = String(v).trim()
        return s ? s : null
    }

    function _routeUnmatchedCurrent(leg, result) {
        if (!leg) return
        if (leg.modifiers && leg.modifiers.locked === true) result.locked.push(leg)
        else                                                result.delete.push(leg)
    }

    /**
     * Absolute minute distance between two HH:MM strings, using the
     * shorter-around-midnight side. Returns null if either parses bad.
     * Examples:
     *   "09:00", "09:10" →  10
     *   "23:50", "00:10" →  20  (midnight wrap)
     *   "06:00", "18:00" → 720  (max distance is 720 = 12h)
     */
    function timeDeltaMin(a, b) {
        const am = _hhmmToMin(a)
        const bm = _hhmmToMin(b)
        if (am == null || bm == null) return null
        let d = Math.abs(am - bm)
        if (d > 720) d = 1440 - d
        return d
    }

    /** True if a leg has the three fields needed for matching. */
    function isMatchable(leg) {
        if (!leg) return false
        if (typeof leg.origin !== "string"      || !IATA_RE.test(leg.origin))      return false
        if (typeof leg.destination !== "string" || !IATA_RE.test(leg.destination)) return false
        if (typeof leg.depTimeLocal !== "string" || !HHMM_RE.test(leg.depTimeLocal)) return false
        return true
    }

    /** Internal: parse "HH:MM" → 0..1439, or null on bad input. */
    function _hhmmToMin(s) {
        if (typeof s !== "string") return null
        const m = s.match(HHMM_RE)
        if (!m) return null
        const h  = parseInt(m[1], 10)
        const mm = parseInt(m[2], 10)
        if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
        return h * 60 + mm
    }

    window.AesAfpScheduleDiff = {
        compare,
        timeDeltaMin,
        isMatchable,
        TOLERANCE_MIN
    }

    // ── Smoke tests (run in-page when ?aes-debug is on; project
    // convention — no test runner). console.assert keeps each
    // assertion line cheap; failures show up red in DevTools.
    if (typeof window !== "undefined"
        && typeof window.location !== "undefined"
        && /[?&]aes-debug\b/.test(window.location.search || "")) {
        try {
            const D = window.AesAfpScheduleDiff

            // ── timeDeltaMin
            console.assert(D.timeDeltaMin("09:00", "09:00") === 0,    "[diff] same time → 0")
            console.assert(D.timeDeltaMin("09:00", "09:10") === 10,   "[diff] +10 min")
            console.assert(D.timeDeltaMin("23:50", "00:10") === 20,   "[diff] midnight wrap → 20")
            console.assert(D.timeDeltaMin("06:00", "18:00") === 720,  "[diff] 12h apart → 720")
            console.assert(D.timeDeltaMin("bad",   "09:00") === null, "[diff] bad input → null")

            // ── isMatchable
            console.assert(D.isMatchable({origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}) === true,
                "[diff] full leg matchable")
            console.assert(D.isMatchable({origin:"jfk", destination:"LAX", depTimeLocal:"06:00"}) === false,
                "[diff] lowercase IATA rejected")
            console.assert(D.isMatchable({origin:"JFK", destination:"LAX", depTimeLocal:null}) === false,
                "[diff] null depTime rejected")
            console.assert(D.isMatchable(null) === false,
                "[diff] null leg rejected")

            // ── compare: empty inputs
            const empty = D.compare([], [])
            console.assert(empty.keep.length === 0 && empty.delete.length === 0
                       && empty.add.length === 0 && empty.moveTime.length === 0
                       && empty.locked.length === 0,
                "[diff] empty/empty → all empty (incl. locked)")

            // ── compare: identical lists
            const aJFKLAX = {seq: 1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}
            const aLAXJFK = {seq: 2, origin:"LAX", destination:"JFK", depTimeLocal:"14:00"}
            const bJFKLAX = {seq: 11, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}
            const bLAXJFK = {seq: 12, origin:"LAX", destination:"JFK", depTimeLocal:"14:00"}
            const same = D.compare([aJFKLAX, aLAXJFK], [bJFKLAX, bLAXJFK])
            console.assert(same.keep.length === 2,    "[diff] same lists → 2 keeps")
            console.assert(same.delete.length === 0,  "[diff] same lists → 0 deletes")
            console.assert(same.add.length === 0,     "[diff] same lists → 0 adds")
            console.assert(same.moveTime.length === 0,"[diff] same lists → 0 moveTime")
            console.assert(same.keep[0].currentSeq === 1 && same.keep[0].proposedSeq === 11,
                "[diff] keep carries seq pair")

            // ── compare: ±15 min tolerance
            const within = D.compare(
                [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:14"}])
            console.assert(within.keep.length === 1, "[diff] +14 min → keep")
            console.assert(within.keep[0].deltaMin === 14, "[diff] keep records 14-min delta")

            const beyond = D.compare(
                [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:30"}])
            console.assert(beyond.keep.length === 0,   "[diff] +30 min → no keep")
            console.assert(beyond.delete.length === 1, "[diff] +30 min → delete current")
            console.assert(beyond.add.length === 1,    "[diff] +30 min → add proposed")
            console.assert(beyond.moveTime.length === 0,
                "[diff] Phase-1: even O/D match outside ±15 stays as delete+add (moveTime []) ")

            // ── compare: pure delete (current with no proposed match)
            const delOnly = D.compare(
                [{seq:1, origin:"JFK", destination:"BOS", depTimeLocal:"08:00"}],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"08:00"}])
            console.assert(delOnly.delete.length === 1 && delOnly.add.length === 1,
                "[diff] different dest → 1 del + 1 add")

            // ── compare: unmatchable current goes to delete
            const badCur = D.compare(
                [{seq:1, origin:"jfk", destination:"LAX", depTimeLocal:"06:00"}],   // bad case
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}])
            console.assert(badCur.delete.length === 1, "[diff] unmatchable current → delete")
            console.assert(badCur.add.length === 1,    "[diff] proposed has no claim → add")

            // ── compare: multiple proposed candidates → closest wins
            const ambiguous = D.compare(
                [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [
                    {seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:14"},  // 14-min delta
                    {seq:12, origin:"JFK", destination:"LAX", depTimeLocal:"06:05"},  // 5-min delta — wins
                    {seq:13, origin:"JFK", destination:"LAX", depTimeLocal:"06:13"}   // 13-min delta
                ])
            console.assert(ambiguous.keep.length === 1, "[diff] ambiguous → 1 keep")
            console.assert(ambiguous.keep[0].proposedSeq === 12, "[diff] closest-time wins")
            console.assert(ambiguous.add.length === 2, "[diff] losing proposals → adds")

            // ── compare: each proposed claimed at most once
            const dupCurrent = D.compare(
                [
                    {seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"},
                    {seq:2, origin:"JFK", destination:"LAX", depTimeLocal:"06:05"}
                ],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}])
            console.assert(dupCurrent.keep.length === 1,   "[diff] only one current claims the proposal")
            console.assert(dupCurrent.delete.length === 1, "[diff] the other current → delete")

            // ── compare: midnight wrap respected
            const wrap = D.compare(
                [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"23:55"}],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"00:05"}])
            console.assert(wrap.keep.length === 1,
                "[diff] 23:55 vs 00:05 (10 min across midnight) → keep")

            // ── 7e: flightId-exact match beats time delta (>15min OK)
            const fidMatch = D.compare(
                [{seq:1, flightId:"f-42", origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [{seq:11, flightId:"f-42", origin:"JFK", destination:"LAX", depTimeLocal:"08:00"}])
            console.assert(fidMatch.keep.length === 1,
                "[diff/7e] flightId match keeps even with 120-min delta")
            console.assert(fidMatch.keep[0].matchedBy === "flightId",
                "[diff/7e] keep records matchedBy:flightId")
            console.assert(fidMatch.delete.length === 0 && fidMatch.add.length === 0,
                "[diff/7e] flightId match clears delete/add")

            // ── 7e: flightId match beats a same-O/D time-close neighbour
            const fidPriority = D.compare(
                [{seq:1, flightId:"f-7", origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [
                    {seq:11,                origin:"JFK", destination:"LAX", depTimeLocal:"06:05"},
                    {seq:12, flightId:"f-7", origin:"JFK", destination:"LAX", depTimeLocal:"06:30"}
                ])
            console.assert(fidPriority.keep.length === 1,
                "[diff/7e] flightId-precedence: 1 keep")
            console.assert(fidPriority.keep[0].matchedBy === "flightId"
                        && fidPriority.keep[0].proposedSeq === 12,
                "[diff/7e] flightId pass beats time-close neighbour")
            console.assert(fidPriority.add.length === 1 && fidPriority.add[0].seq === 11,
                "[diff/7e] losing time-neighbour goes to add")

            // ── 7e: locked bucket — unmatched locked current leg
            const lockedNoMatch = D.compare(
                [{seq:1, flightId:"f-9", origin:"JFK", destination:"LAX",
                  depTimeLocal:"06:00", modifiers:{locked:true}}],
                [{seq:11, origin:"JFK", destination:"BOS", depTimeLocal:"06:00"}])
            console.assert(lockedNoMatch.locked.length === 1,
                "[diff/7e] unmatched locked → locked bucket")
            console.assert(lockedNoMatch.delete.length === 0,
                "[diff/7e] locked never goes to delete")

            // ── 7e: locked + matched still goes to keep, not locked
            const lockedMatched = D.compare(
                [{seq:1, flightId:"f-9", origin:"JFK", destination:"LAX",
                  depTimeLocal:"06:00", modifiers:{locked:true}}],
                [{seq:11, flightId:"f-9", origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}])
            console.assert(lockedMatched.keep.length === 1,
                "[diff/7e] locked+matched → keep")
            console.assert(lockedMatched.locked.length === 0,
                "[diff/7e] locked+matched leaves locked empty")

            // ── 7e: unmatchable locked current also goes to locked
            const lockedBadCur = D.compare(
                [{seq:1, origin:"jfk", destination:"LAX", depTimeLocal:"06:00",
                  modifiers:{locked:true}}],
                [])
            console.assert(lockedBadCur.locked.length === 1
                        && lockedBadCur.delete.length === 0,
                "[diff/7e] unmatchable locked still goes to locked, not delete")

            console.log("[AES afp/auto-scheduler] schedule-diff smoke tests passed")
        } catch (e) {
            console.warn("[AES afp-6b] schedule-diff smoke tests threw", e)
        }
    }
})()
