"use strict"

/**
 * AES Strategy — outcome recorder (Slice 5).
 *
 * Records "before" and "after" measurement snapshots tied to applied
 * plans so `learn.js` can attribute observed deltas (profit, ORS,
 * load-factor) back to weight choices and adjust them.
 *
 * Storage:
 *   aesStrategy:learn:outcomes   ← ring buffer of outcome records
 *                                  (cap 100; oldest evicted on overflow)
 *
 * Outcome shape:
 *   {
 *     outcomeId:   "out-<base36-ts>-<rand>",
 *     planId:      string,                    // matches ApplyReport.planId
 *     applyTs:     number,                    // ms epoch when apply ran
 *     server:      string,
 *     airlineCode: string,
 *     before:      Measurement,                 // captured at apply time
 *     after:       Measurement | null,          // captured ≥ window-hours later
 *     afterTs:     number | null,
 *     weights:     {<weight-key>: number, ...}  // weight set in effect at apply
 *   }
 *
 * Measurement is intentionally small — we don't archive whole snapshots
 * because the strategy storage budget is 1 MB. We pull only fields that
 * Slice 5's gradient estimator needs and that survive cross-page mounts:
 *
 *   {ts, cashBalance, weeklyResult, fleetCount, legCount, orsAvgY,
 *    perRouteCount, paxLfMean, predictedWeeklyProfit?, predictedOrsAvg?}
 *
 * Pure-function helpers (`measure(snapshot, plan?)`) are exposed so the
 * strategy panel can preview a measurement without persisting.
 *
 * Public API (window.AesStrategyOutcomes):
 *   record({planId, applyTs, before, weights, server, airlineCode}) → Promise<outcome>
 *   tryCaptureAfter({minWindowHours, snapshot, plan?}) → Promise<{captured: number}>
 *   loadAll() → Promise<outcome[]>
 *   countReady(minWindowHours?) → Promise<{recorded, ready, attributed}>
 *   measure(snapshot, plan?) → Measurement                  // pure
 *   clear() → Promise<void>
 *
 * `tryCaptureAfter` walks the ring; for each outcome with `after === null`
 * AND `now - applyTs >= minWindowHours × 3600 × 1000`, captures the current
 * snapshot's measurement as the `after` field. Returns the number of
 * outcomes that gained an `after`. Idempotent — running twice in a row
 * with no new windows expiring is a no-op.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyOutcomes) return

    const KEY      = "aesStrategy:learn:outcomes"
    const RING_CAP = 100
    const HOUR_MS  = 3600 * 1000
    const DEFAULT_WINDOW_HOURS = 24

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    /**
     * Per-account scoping (Slice 11). The outcomes ring is per-airline so
     * one busy sister can't starve another's learning history (the cap
     * is per-key, 100 each). The legacy unscoped key is read on first
     * load when the scoped one is empty so prior outcomes still attribute
     * back through learn.js.
     */
    function _scopedKey(accountId) {
        return accountId ? KEY + ":acct:" + accountId : KEY
    }
    async function _accountIdFor(server, airlineCode) {
        if (!server || !airlineCode) return null
        if (!window.AesAccountRegistry || typeof window.AesAccountRegistry.computeId !== "function") return null
        try { return await window.AesAccountRegistry.computeId(server, airlineCode) }
        catch (_) { return null }
    }

    function _outcomeId() {
        return "out-" + Date.now().toString(36) + "-"
            + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
    }

    /**
     * Pure measurement extractor. Reads the snapshot + optional plan and
     * builds a small numeric record the gradient estimator can diff.
     * Defensive of every missing field — anything unknown becomes null.
     */
    function measure(snapshot, plan) {
        const out = {
            ts:                       Date.now(),
            cashBalance:              null,
            weeklyResult:             null,
            fleetCount:               null,
            legCount:                 null,
            orsAvgY:                  null,
            perRouteCount:            null,
            paxLfMean:                null,
            predictedWeeklyProfit:    null,
            predictedOrsAvg:          null,
            // Velvet Cascade · PR 2 — per-route rank attribution. Populated
            // from snapshot.hubs[].byRoute[].orsByClass when the snapshot
            // carries ORS data (attached by `_attachOrsCache` in PR 1A).
            // Map<"<HUB>-<DEST>", {rankAny, rankFirstLegOurs, ourTopRating,
            // ratingGapToTop}>. Stored compactly so the closed-loop diff
            // can compare per-route rank deltas after each apply window.
            byRoute:                  {},
            // Network-wide rank averages — null when no per-class records
            // observed; otherwise the mean across `rankAny`-bearing routes.
            rankAvgAny:               null,
            rankRoutesObserved:       null,
            // Wave Mechanics Expansion · Lane C closed-loop attribution.
            // Populated when window.AesStrategyFleetUtilization is loaded
            // (Phase-1 read-only analytics module). Null otherwise so this
            // file works on pages that don't load the optimizer namespace.
            fleetAvgRatioForecast14d: null,
            fleetAvgUtilizationPct:   null,
            fleetTargetAvgRatio:      null,
            ratioGapHeadlinePct:      null
        }
        if (!snapshot || typeof snapshot !== "object") return out

        const cash = snapshot.cash || {}
        if (typeof cash.bankBalance  === "number") out.cashBalance  = cash.bankBalance
        if (typeof cash.weeklyResult === "number") out.weeklyResult = cash.weeklyResult

        const fleet = Array.isArray(snapshot.fleet) ? snapshot.fleet : []
        out.fleetCount = fleet.length

        // Aggregate route-level stats across hubs.
        let routeCount = 0
        let lfSum = 0, lfN = 0
        let scheduledLegCount = 0
        let rankSum = 0, rankN = 0
        for (const h of (snapshot.hubs || [])) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                if (!r) continue
                routeCount++
                if (r.alreadyScheduled && _num(r.weeklyFlights, 0) > 0) {
                    scheduledLegCount += _num(r.weeklyFlights, 0) * 2  // outbound + return
                }
                if (r.override && typeof r.override.paxLF === "number") {
                    lfSum += r.override.paxLF
                    lfN++
                }
                // Per-route rank capture (PR 2). Reads ECONOMY by default
                // (Y-anchored, which is the demand pool's dominant class).
                if (r.dest && r.orsByClass) {
                    const cls = r.orsByClass.ECONOMY || null
                    if (cls) {
                        const rankAny = _num(cls.rankAny, null)
                        const rec = {
                            rankAny:             rankAny,
                            rankFirstLegOurs:    _num(cls.rankFirstLegOurs, null),
                            ourTopRating:        _num(cls.ourTopRating, null),
                            ratingGapToTop:      _num(cls.ratingGapToTop, null)
                        }
                        out.byRoute[h.iata + "-" + r.dest] = rec
                        if (rankAny != null) {
                            rankSum += rankAny
                            rankN++
                        }
                    }
                }
            }
        }
        out.perRouteCount = routeCount
        out.legCount      = scheduledLegCount
        out.paxLfMean     = lfN > 0 ? lfSum / lfN : null
        out.rankAvgAny    = rankN > 0 ? rankSum / rankN : null
        out.rankRoutesObserved = rankN

        const profiles = snapshot.serviceProfiles || []
        const ys = profiles
            .map(p => p && p.classScore && _num(p.classScore.Y, NaN))
            .filter(v => isFinite(v))
        out.orsAvgY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null

        // Prediction figures live on plan.summary when supplied.
        if (plan && plan.summary) {
            if (typeof plan.summary.predictedWeeklyProfit === "number")
                out.predictedWeeklyProfit = plan.summary.predictedWeeklyProfit
            if (typeof plan.summary.predictedOrsAvg === "number")
                out.predictedOrsAvg = plan.summary.predictedOrsAvg
        }

        // Lane C fleet-utilization rollup. Defensive: aggregator may be
        // absent (pages that don't load the strategy namespace), or its
        // pure compute may return null (e.g. when fleet wear samples are
        // missing). Either way we leave the four fields as null —
        // closed-loop drift detection then ignores the row gracefully.
        try {
            if (window.AesStrategyFleetUtilization
                && typeof window.AesStrategyFleetUtilization.compute === "function") {
                const summary = window.AesStrategyFleetUtilization.compute({
                    snapshot, fleetPlan: plan || null,
                    settings: null, schedules: null, regions: null
                })
                if (summary && summary.rollups) {
                    if (isFinite(summary.rollups.fleetAvgRatioForecast14d))
                        out.fleetAvgRatioForecast14d = summary.rollups.fleetAvgRatioForecast14d
                    if (isFinite(summary.rollups.fleetAvgUtilizationPct))
                        out.fleetAvgUtilizationPct = summary.rollups.fleetAvgUtilizationPct
                    if (isFinite(summary.rollups.fleetTargetAvgRatio))
                        out.fleetTargetAvgRatio = summary.rollups.fleetTargetAvgRatio
                    if (isFinite(summary.rollups.ratioGapHeadlinePct))
                        out.ratioGapHeadlinePct = summary.rollups.ratioGapHeadlinePct
                }
            }
        } catch (_) { /* aggregator missing or threw — leave fields null */ }

        return out
    }

    async function loadAll(accountId) {
        try {
            const key = _scopedKey(accountId)
            const data = await chrome.storage.local.get([key])
            const ring = Array.isArray(data[key]) ? data[key].slice() : []
            if (ring.length || !accountId) return ring
            // Scoped miss → read legacy ring once so prior outcomes still
            // surface for the active account during the rollout window.
            const fb = await chrome.storage.local.get([KEY])
            return Array.isArray(fb[KEY]) ? fb[KEY].slice() : []
        } catch (e) {
            console.warn("[AesStrategyOutcomes] loadAll failed", e)
            return []
        }
    }

    async function _save(ring, accountId) {
        try {
            const writes = {[KEY]: ring}
            if (accountId) writes[_scopedKey(accountId)] = ring
            await chrome.storage.local.set(writes)
        } catch (e) { console.warn("[AesStrategyOutcomes] save failed", e) }
    }

    async function record(opts) {
        const o = opts || {}
        if (!o.planId || !o.before) throw new Error("AesStrategyOutcomes.record: planId + before required")
        const accountId = o.accountId || await _accountIdFor(o.server, o.airlineCode)
        const outcome = {
            outcomeId:   _outcomeId(),
            planId:      String(o.planId),
            applyTs:     _num(o.applyTs, Date.now()),
            server:      o.server || null,
            airlineCode: o.airlineCode || null,
            accountId:   accountId,
            before:      o.before,
            after:       null,
            afterTs:     null,
            weights:     o.weights || null
        }
        const ring = await loadAll(accountId)
        ring.unshift(outcome)
        if (ring.length > RING_CAP) ring.length = RING_CAP
        await _save(ring, accountId)
        return outcome
    }

    async function tryCaptureAfter(opts) {
        const o = opts || {}
        const windowMs = _num(o.minWindowHours, DEFAULT_WINDOW_HOURS) * HOUR_MS
        const snapshot = o.snapshot
        const plan     = o.plan || null
        if (!snapshot) return {captured: 0, reason: "no-snapshot"}
        const accountId = o.accountId
            || await _accountIdFor(snapshot.server, snapshot.airlineCode)
            || (typeof window !== "undefined" && window.__aesAccountId) || null

        const ring = await loadAll(accountId)
        const now = Date.now()
        let captured = 0
        const after = measure(snapshot, plan)
        for (const outc of ring) {
            if (outc.after) continue
            if (now - _num(outc.applyTs, 0) < windowMs) continue
            outc.after   = after
            outc.afterTs = now
            captured++
        }
        if (captured > 0) await _save(ring, accountId)
        return {captured: captured}
    }

    async function countReady(minWindowHours, accountId) {
        const windowMs = _num(minWindowHours, DEFAULT_WINDOW_HOURS) * HOUR_MS
        const id = accountId || (typeof window !== "undefined" && window.__aesAccountId) || null
        const ring = await loadAll(id)
        const now = Date.now()
        let attributed = 0
        let ready = 0
        for (const outc of ring) {
            if (outc.after) {
                attributed++
            } else if (now - _num(outc.applyTs, 0) >= windowMs) {
                ready++
            }
        }
        return {recorded: ring.length, ready: ready, attributed: attributed}
    }

    async function clear(accountId) {
        try {
            const keys = [KEY]
            if (accountId) keys.push(_scopedKey(accountId))
            await chrome.storage.local.remove(keys)
        } catch (e) { console.warn("[AesStrategyOutcomes] clear failed", e) }
    }

    window.AesStrategyOutcomes = {
        record:           record,
        tryCaptureAfter:  tryCaptureAfter,
        loadAll:          loadAll,
        countReady:       countReady,
        measure:          measure,
        clear:            clear,
        KEY:              KEY,
        RING_CAP:         RING_CAP
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // measure() with empty snapshot
            const m0 = measure(null)
            console.assert(m0.fleetCount === null && m0.cashBalance === null,
                "[smoke outcomes] null snapshot → null fields")
            const m1 = measure({
                cash: {bankBalance: 5e6, weeklyResult: 4.2e5},
                fleet: [{aircraftId: "1"}, {aircraftId: "2"}],
                hubs: [{iata: "ATL", byRoute: [
                    {dest: "MCO", weeklyFlights: 7, alreadyScheduled: true,
                     override: {paxLF: 0.85}},
                    {dest: "BOS", weeklyFlights: 0, alreadyScheduled: false}
                ]}],
                serviceProfiles: [{classScore: {Y: 0.7}}, {classScore: {Y: 0.6}}]
            }, {summary: {predictedWeeklyProfit: 1e5}})
            console.assert(m1.fleetCount === 2,                              "[smoke outcomes] fleet count")
            console.assert(m1.legCount === 14,                                "[smoke outcomes] scheduled legs counted RT")
            console.assert(m1.perRouteCount === 2,                            "[smoke outcomes] route count")
            console.assert(Math.abs(m1.orsAvgY - 0.65) < 1e-9,                "[smoke outcomes] orsAvgY mean")
            console.assert(Math.abs(m1.paxLfMean - 0.85) < 1e-9,              "[smoke outcomes] paxLfMean mean")
            console.assert(m1.predictedWeeklyProfit === 1e5,                  "[smoke outcomes] predictedWeeklyProfit picked")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
