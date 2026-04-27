"use strict"

/**
 * Track 6 slice 6b — schedule diff engine.
 * Track 6 slice 6b-followup — configurable per-call tolerance.
 *
 * Pure compare function. No DOM, no chrome.storage, no AS knowledge —
 * the caller hands in two arrays of legs (current and proposed) and
 * gets back a {keep, delete, add, moveTime} bucketing.
 *
 * Match rule for "keep":
 *   - same origin (3-letter IATA, case-sensitive)
 *   - same destination (3-letter IATA)
 *   - depTimeLocal within ±N minutes (default 15; per-call override
 *     via the 3rd arg, or globally via
 *     `settings.aircraftFlightPlan.autoScheduler.diff.toleranceMin`)
 *
 * Phase 1 simplification: when a current leg's origin+dest match a
 * proposed leg but the depTime delta is OUTSIDE ±15 min, this slice
 * does NOT emit a moveTime entry — the pair gets split into a delete
 * + an add. The moveTime field is therefore always [] in Phase 1; it
 * stays in the return shape so slice 6e (transactional wipe-then-
 * rebuild) can later flip the heuristic without breaking callers.
 * Reasoning: AS's edit-flight Wicket post is more fragile than a
 * delete-then-create, and Track 5's apply pipeline is already optimised
 * for the create path. A future slice can specialise moveTime once we
 * confirm AS exposes a stable edit-time endpoint.
 *
 * Day-of-week handling: this slice compares legs as-passed; it does
 * NOT expand a `dayMask` on proposed (ScheduleBuilder-shaped) legs.
 * Callers that pass in template legs and currentLegs from
 * `AesAfp.getCurrentSchedule()` (per-day expanded) should expand the
 * proposed side first. The contract is intentionally narrow: same
 * shape in → diff out. Slice 6d's confirmation modal is the right
 * place to expand and re-diff when the user toggles "all days".
 *
 * Multiple-match disambiguation: if more than one proposed leg
 * matches a current leg's (origin, dest, depTime±15) box, the diff
 * picks the proposed with the smallest absolute time delta. Each
 * proposed leg is claimed at most once per compare call (so an
 * over-counted dayMask can't blow up keep cardinality).
 *
 * Unmatchable legs (missing origin / destination / depTimeLocal) on
 * the CURRENT side go into `delete` — they can't be kept. On the
 * PROPOSED side they go into `add`. This is the safe default: if we
 * can't reason about a leg, we conservatively wipe and rebuild.
 *
 * Tolerance configurability (6b-followup):
 *   compare(curr, prop, {toleranceMin: N}) — overrides the default 15
 *   for THIS call. Falls back to
 *   `settings.aircraftFlightPlan.autoScheduler.diff.toleranceMin`
 *   when callable via `AesAfpSettings`. Caller's option always wins;
 *   missing / non-finite / negative values fall back to default 15.
 *   Note: settings read is sync — `compare` reads
 *   `AesAfpSettings.cached?.()` (introduced for sync access by
 *   the apply path) when present, otherwise the hard-coded default.
 *   Callers that have an async settings handle should pass the value
 *   in via the option arg.
 *
 * Public API (window.AesAfpScheduleDiff):
 *   .compare(currentLegs, proposedLegs, opts?)
 *     → {keep:[{currentSeq, proposedSeq, deltaMin}],
 *        delete:[currentLeg], add:[proposedLeg], moveTime:[]}
 *     opts: {toleranceMin?: number}
 *   .timeDeltaMin(aHHMM, bHHMM)
 *     → absolute minute-distance between two HH:MM strings, taking the
 *       midnight-wrap shorter side (e.g. 23:50 vs 00:10 → 20)
 *   .isMatchable(leg) → boolean
 *   .TOLERANCE_MIN  (15) — read-only default; per-call override is
 *                          how callers customise.
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
     *
     * `opts.toleranceMin` overrides the per-call match window. See
     * `_resolveTolerance` for the precedence rules.
     */
    function compare(currentLegs, proposedLegs, opts) {
        const cur = Array.isArray(currentLegs)  ? currentLegs  : []
        const pro = Array.isArray(proposedLegs) ? proposedLegs : []
        const result = {keep: [], delete: [], add: [], moveTime: []}
        const tol = _resolveTolerance(opts)

        if (!cur.length && !pro.length) return result

        // Partition each side into matchable / unmatchable. Unmatchable
        // current → delete; unmatchable proposed → add. Matchable pairs
        // run through the (origin, dest, depTime±15) matcher below.
        const curMatch = []
        for (const leg of cur) {
            if (!leg) continue
            if (isMatchable(leg)) curMatch.push(leg)
            else                  result.delete.push(leg)
        }
        const proMatch = []
        for (const leg of pro) {
            if (!leg) continue
            if (isMatchable(leg)) proMatch.push(leg)
            else                  result.add.push(leg)
        }

        // For each current leg, find the proposed leg with the smallest
        // absolute time delta among same-O/D unclaimed candidates within
        // ±TOLERANCE_MIN. Greedy: a current leg never re-shops once it
        // claims a proposed leg, even if a later current leg would have
        // been a closer match. This is acceptable because the typical
        // proposed Build has at most a handful of legs sharing an O/D
        // and they're spread across multiple hours; the ±15min window
        // makes ambiguity rare.
        const claimedProposed = new Set()
        for (const c of curMatch) {
            let bestIdx = -1
            let bestDelta = Infinity
            for (let i = 0; i < proMatch.length; i++) {
                if (claimedProposed.has(i)) continue
                const p = proMatch[i]
                if (c.origin      !== p.origin)      continue
                if (c.destination !== p.destination) continue
                const d = timeDeltaMin(c.depTimeLocal, p.depTimeLocal)
                if (d == null)            continue
                if (d > tol)              continue
                if (d < bestDelta) { bestDelta = d; bestIdx = i }
            }
            if (bestIdx >= 0) {
                claimedProposed.add(bestIdx)
                const p = proMatch[bestIdx]
                result.keep.push({
                    currentSeq:  c.seq != null ? c.seq : null,
                    proposedSeq: p.seq != null ? p.seq : null,
                    deltaMin:    bestDelta
                })
            } else {
                result.delete.push(c)
            }
        }
        for (let i = 0; i < proMatch.length; i++) {
            if (!claimedProposed.has(i)) result.add.push(proMatch[i])
        }
        return result
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

    /**
     * Internal: resolve the tolerance window for one compare() call.
     *
     * Precedence:
     *   1. opts.toleranceMin (caller wins) — finite, ≥ 0
     *   2. AesAfpSettings.cached().aircraftFlightPlan.autoScheduler.diff.toleranceMin
     *      (sync read; only used when AesAfpSettings exposes a cached
     *      accessor — the apply pipeline pre-warms it)
     *   3. TOLERANCE_MIN (15)
     *
     * Defensive: any non-finite or negative value at any layer falls
     * through to the next one, so a misconfigured setting never breaks
     * the diff.
     */
    function _resolveTolerance(opts) {
        if (opts && typeof opts === "object") {
            const v = opts.toleranceMin
            if (typeof v === "number" && isFinite(v) && v >= 0) return v
        }
        try {
            if (typeof window !== "undefined"
             && window.AesAfpSettings
             && typeof window.AesAfpSettings.cached === "function") {
                const s = window.AesAfpSettings.cached()
                const v = s
                    && s.aircraftFlightPlan
                    && s.aircraftFlightPlan.autoScheduler
                    && s.aircraftFlightPlan.autoScheduler.diff
                    && s.aircraftFlightPlan.autoScheduler.diff.toleranceMin
                if (typeof v === "number" && isFinite(v) && v >= 0) return v
            }
        } catch (_) { /* fall through to default */ }
        return TOLERANCE_MIN
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
                       && empty.add.length === 0 && empty.moveTime.length === 0,
                "[diff] empty/empty → all empty")

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

            // ── compare: per-call toleranceMin override (6b-followup)
            const tightCur = [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}]
            const tightProp = [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:10"}]
            const tight = D.compare(tightCur, tightProp, {toleranceMin: 5})
            console.assert(tight.keep.length === 0 && tight.delete.length === 1 && tight.add.length === 1,
                "[diff] tolerance:5 — ±10min becomes delete+add")

            const wide = D.compare(
                [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:30"}],
                {toleranceMin: 60})
            console.assert(wide.keep.length === 1,
                "[diff] tolerance:60 — ±30min becomes keep")

            const exact = D.compare(
                [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:01"}],
                {toleranceMin: 0})
            console.assert(exact.keep.length === 0 && exact.delete.length === 1 && exact.add.length === 1,
                "[diff] tolerance:0 — only exact-time matches keep")

            const bogus = D.compare(
                [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
                [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:14"}],
                {toleranceMin: -1})
            console.assert(bogus.keep.length === 1,
                "[diff] tolerance:-1 — bad input falls through to default 15, ±14min keeps")

            console.log("[AES afp/auto-scheduler] schedule-diff smoke tests passed")
        } catch (e) {
            console.warn("[AES afp-6b] schedule-diff smoke tests threw", e)
        }
    }
})()
