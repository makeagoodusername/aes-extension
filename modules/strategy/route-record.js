"use strict"

/**
 * AES Strategy — per-route record stitcher (Velvet Cascade · PR 1B).
 *
 * Read-only async aggregator. Joins the data scattered across stores into
 * a single per-route view: live ORS state, recent ORS snapshots (the
 * before/after pairs that turn into a calibration dataset), price + service
 * apply-log entries that touched this route, the strategy audit ring
 * filtered to entries that mention this hub-dest, the outcomes ring filtered
 * by planId, the demand + yield-history time series, and computed
 * staleness markers so the diagnostics surface knows which signals are
 * trustworthy.
 *
 * Pure with respect to persistence — no new chrome.storage keys are
 * written; every read joins existing ones (§4.10 budget invariant).
 *
 * Public API:
 *   AesStrategy.routeRecord(hub, dest, opts?) → Promise<Record>
 *
 * Opts:
 *   {accountId?, snapshotLimit?: 4, applyLimit?: 8, recentTimelineLimit?: 20}
 *
 * Output (omits null branches when irrelevant):
 *   {
 *     hub, dest, accountId,
 *     current: {
 *       ors:       {byClass, scrapedAt, ageSec},
 *       ownPricing:{prices, scrapedAt, ageSec},
 *       demand:    {paxScore, cargoScore, scrapedAt, ageSec},
 *       yield:     {snapshots: [...], latestSnapshot},
 *       note:      {text, updatedAt}
 *     },
 *     priceApplies:    [<RouteAssistantPricingApplyLog entry>...],
 *     serviceApplies:  [<RouteAssistantServiceProfileApplyLog entry>...],
 *     orsSnapshots:    [<RouteAssistantOrsSnapshotStore summary>...],
 *     audit:           [<aesStrategy:audit entry>...],
 *     outcomes:        [<aesStrategy:learn:outcome>...],
 *     recentTimeline:  [{ts, kind, payload, source}, ...],     // unified, newest-first
 *     staleness:       {orsAgeSec, priceAgeSec, demandAgeSec, yieldAgeSec, snapshotAgeSec},
 *     warnings:        [<short message>...]
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.routeRecord === "function") return

    const STALE_ORS_DAYS    = 7
    const STALE_PRICE_DAYS  = 14
    const STALE_DEMAND_DAYS = 7

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _ageSec(ts) {
        if (!ts || !isFinite(Number(ts))) return null
        return Math.max(0, Math.round((Date.now() - Number(ts)) / 1000))
    }

    function _has(name) { return typeof window[name] !== "undefined" }

    function _matchesPair(rec, hub, dest) {
        if (!rec) return false
        const h = String(hub || "").toUpperCase()
        const d = String(dest || "").toUpperCase()
        if (rec.hub && rec.dest) {
            return String(rec.hub).toUpperCase() === h
                && String(rec.dest).toUpperCase() === d
        }
        if (rec.payload && rec.payload.hub && rec.payload.dest) {
            return String(rec.payload.hub).toUpperCase() === h
                && String(rec.payload.dest).toUpperCase() === d
        }
        return false
    }

    async function _loadCurrentOrs(hub, dest) {
        if (!_has("RouteAssistantOrsScraper")) return null
        try {
            const rec = await window.RouteAssistantOrsScraper.loadRecord(hub, dest)
            if (!rec) return null
            return {
                byClass:        rec.byClass || null,
                classesScraped: rec.classesScraped || null,
                scrapedAt:      rec.scrapedAt || null,
                ageSec:         _ageSec(rec.scrapedAt)
            }
        } catch (_) { return null }
    }

    async function _loadOwnPricing(hub, dest) {
        if (!_has("RouteAssistantMarketsPageScraper")) return null
        try {
            const blob = await window.RouteAssistantMarketsPageScraper
                .bulkLoadCache([[hub, dest]], {})
            if (!blob || typeof blob.get !== "function") return null
            const fam = blob.get(String(hub).toUpperCase() + "-" + String(dest).toUpperCase())
            if (!fam || !fam.ownPricing || !fam.ownPricing.prices) return null
            return {
                prices:    Object.assign({}, fam.ownPricing.prices),
                scrapedAt: fam.ownPricing.scrapedAt || null,
                ageSec:    _ageSec(fam.ownPricing.scrapedAt)
            }
        } catch (_) { return null }
    }

    async function _loadDemand(hub, dest) {
        if (!_has("RouteAssistantDemandStore")) return null
        try {
            const rec = await window.RouteAssistantDemandStore.get(dest, {includeStale: true})
            if (!rec) return null
            return {
                paxScore:   rec.paxScore   != null ? rec.paxScore   : null,
                cargoScore: rec.cargoScore != null ? rec.cargoScore : null,
                scrapedAt:  rec.scrapedAt || null,
                ageSec:     _ageSec(rec.scrapedAt)
            }
        } catch (_) { return null }
    }

    async function _loadYield(hub, dest) {
        if (!_has("RouteAssistantYieldHistoryStore")) return null
        try {
            const rec = await window.RouteAssistantYieldHistoryStore.loadRecord(hub, dest)
            if (!rec) return null
            const snapshots = Array.isArray(rec.snapshots) ? rec.snapshots.slice() : []
            const latest = window.RouteAssistantYieldHistoryStore.latestSnapshot
                ? window.RouteAssistantYieldHistoryStore.latestSnapshot(rec) : (snapshots[0] || null)
            return {
                snapshots:        snapshots.slice(0, 6),
                latestSnapshot:   latest || null,
                latestScrapedAt:  latest ? (latest.scrapedAt || latest.ts || null) : null,
                ageSec:           latest ? _ageSec(latest.scrapedAt || latest.ts) : null
            }
        } catch (_) { return null }
    }

    async function _loadNote(hub, dest) {
        if (!_has("RouteAssistantRouteNoteStore")) return null
        try {
            const recs = await window.RouteAssistantRouteNoteStore.getMany([[hub, dest]])
            if (!recs || typeof recs.get !== "function") return null
            const k = String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
            const rec = recs.get(k)
            if (!rec || !rec.text) return null
            return {text: String(rec.text).slice(0, 240), updatedAt: rec.updatedAt || null}
        } catch (_) { return null }
    }

    async function _loadPriceApplies(hub, dest, n) {
        if (!_has("RouteAssistantPricingApplyLog")) return []
        try {
            const log = new window.RouteAssistantPricingApplyLog()
            const r = await log.getForRoute(hub, dest, n)
            return Array.isArray(r.entries) ? r.entries : []
        } catch (_) { return [] }
    }

    async function _loadServiceAppliesForProfile(profileId, n) {
        if (profileId == null || !_has("RouteAssistantServiceProfileApplyLog")) return []
        try {
            const log = new window.RouteAssistantServiceProfileApplyLog()
            const r = await log.getRecent()
            const want = Number(profileId)
            const out = []
            for (const e of r.entries) {
                if (!e || Number(e.profileId) !== want) continue
                out.push(e)
                if (out.length >= n) break
            }
            return out
        } catch (_) { return [] }
    }

    async function _loadOrsSnapshots(hub, dest, n) {
        if (!_has("RouteAssistantOrsSnapshotStore")) return []
        try {
            const list = await window.RouteAssistantOrsSnapshotStore.list(hub, dest)
            return list.slice(0, n)
        } catch (_) { return [] }
    }

    async function _loadAudit(hub, dest, accountId) {
        if (typeof ns.getAudit !== "function") return []
        try {
            const ring = await ns.getAudit(accountId, 200)
            const out = []
            for (const entry of ring) {
                if (!entry) continue
                // Audit entries carry a list of decisions in `applied[]` —
                // include the entry when at least one decision touched our pair.
                const matched = (entry.applied || []).some(d => _matchesPair(d, hub, dest))
                if (matched) out.push(entry)
                if (out.length >= 10) break
            }
            return out
        } catch (_) { return [] }
    }

    async function _loadOutcomes(accountId) {
        if (!window.AesStrategyOutcomes
            || typeof window.AesStrategyOutcomes.loadAll !== "function") return []
        try {
            const ring = await window.AesStrategyOutcomes.loadAll(accountId)
            return Array.isArray(ring) ? ring.slice(0, 20) : []
        } catch (_) { return [] }
    }

    /**
     * Resolve which serviceProfile id this route uses. Today the snapshot
     * doesn't carry a per-route profile mapping; we degrade to "all
     * profiles" by returning null and letting `_loadServiceAppliesForProfile`
     * skip the filter. Future PR can attach `route.serviceProfileId` from
     * a fleet→profile lookup.
     */
    function _resolveProfileId(opts) {
        if (opts && opts.profileId != null) return Number(opts.profileId)
        return null
    }

    /**
     * Merge price/service applies, ORS snapshots, and audit entries into
     * a single newest-first timeline. Each row is `{ts, kind, source,
     * payload}` where kind ∈ {"apply-price", "apply-service",
     * "ors-snapshot", "audit"}.
     */
    function _buildTimeline(parts, limit) {
        const rows = []
        for (const e of parts.priceApplies)   if (e && e.ts) rows.push({ts: e.ts, kind: "apply-price",   source: "pricingApplyLog",          payload: e})
        for (const e of parts.serviceApplies) if (e && e.ts) rows.push({ts: e.ts, kind: "apply-service", source: "serviceProfileApplyLog",   payload: e})
        for (const e of parts.orsSnapshots)   if (e && e.ts) rows.push({ts: e.ts, kind: "ors-snapshot",  source: "orsSnapshotStore",         payload: e})
        for (const e of parts.audit)          if (e && e.ts) rows.push({ts: e.ts, kind: "audit",        source: "aesStrategy:audit",         payload: e})
        rows.sort((a, b) => b.ts - a.ts)
        return rows.slice(0, limit)
    }

    function _stalenessAndWarnings(current, priceApplies, orsSnapshots) {
        const warnings = []
        const orsAgeSec    = current.ors        ? current.ors.ageSec        : null
        const priceAgeSec  = current.ownPricing ? current.ownPricing.ageSec : null
        const demandAgeSec = current.demand     ? current.demand.ageSec     : null
        const yieldAgeSec  = current.yield      ? current.yield.ageSec      : null
        const snapshotAgeSec = (orsSnapshots && orsSnapshots.length)
            ? _ageSec(orsSnapshots[0].ts) : null

        if (orsAgeSec == null) warnings.push("no ORS scrape on file — open /app/info/ors to seed")
        else if (orsAgeSec > STALE_ORS_DAYS * 86400) warnings.push("ORS scrape is "
            + Math.round(orsAgeSec / 86400) + "d old (cap " + STALE_ORS_DAYS + "d)")
        if (priceAgeSec == null) warnings.push("no own-price cache — open /app/com/markets/<HUB><DEST> to seed")
        else if (priceAgeSec > STALE_PRICE_DAYS * 86400) warnings.push("own pricing cache is "
            + Math.round(priceAgeSec / 86400) + "d old (cap " + STALE_PRICE_DAYS + "d)")
        if (demandAgeSec != null && demandAgeSec > STALE_DEMAND_DAYS * 86400) warnings.push("demand "
            + Math.round(demandAgeSec / 86400) + "d old (cap " + STALE_DEMAND_DAYS + "d)")
        if (priceApplies.length) {
            const failed = priceApplies.filter(e => e && e.status === "failed")
            if (failed.length) warnings.push(failed.length + " failed price-apply(s) on this route")
        }

        return {
            staleness: {orsAgeSec, priceAgeSec, demandAgeSec, yieldAgeSec, snapshotAgeSec},
            warnings:  warnings
        }
    }

    async function routeRecord(hub, dest, opts) {
        const o = opts || {}
        const snapshotLimit = _num(o.snapshotLimit, 4)
        const applyLimit    = _num(o.applyLimit, 8)
        const timelineLimit = _num(o.recentTimelineLimit, 20)
        const accountId     = o.accountId
            || (typeof window !== "undefined" && window.__aesAccountId) || null
        const profileId     = _resolveProfileId(o)

        const [
            ors, ownPricing, demand, yieldHist, note,
            priceApplies, serviceApplies, orsSnapshots, audit, outcomesAll
        ] = await Promise.all([
            _loadCurrentOrs(hub, dest),
            _loadOwnPricing(hub, dest),
            _loadDemand(hub, dest),
            _loadYield(hub, dest),
            _loadNote(hub, dest),
            _loadPriceApplies(hub, dest, applyLimit),
            _loadServiceAppliesForProfile(profileId, applyLimit),
            _loadOrsSnapshots(hub, dest, snapshotLimit),
            _loadAudit(hub, dest, accountId),
            _loadOutcomes(accountId)
        ])

        // Filter outcomes by planId from audit entries that touched this route.
        const planIds = new Set()
        for (const a of audit) if (a && a.planId) planIds.add(String(a.planId))
        const outcomes = outcomesAll.filter(o => o && planIds.has(String(o.planId)))

        const current = {
            ors:        ors,
            ownPricing: ownPricing,
            demand:     demand,
            yield:      yieldHist,
            note:       note
        }

        const stale = _stalenessAndWarnings(current, priceApplies, orsSnapshots)
        const recentTimeline = _buildTimeline({
            priceApplies, serviceApplies, orsSnapshots, audit
        }, timelineLimit)

        return {
            hub:             String(hub  || "").toUpperCase(),
            dest:            String(dest || "").toUpperCase(),
            accountId:       accountId,
            current:         current,
            priceApplies:    priceApplies,
            serviceApplies:  serviceApplies,
            orsSnapshots:    orsSnapshots,
            audit:           audit,
            outcomes:        outcomes,
            recentTimeline:  recentTimeline,
            staleness:       stale.staleness,
            warnings:        stale.warnings
        }
    }

    ns.routeRecord = routeRecord
})()
