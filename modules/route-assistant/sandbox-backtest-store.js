"use strict"

/**
 * Per-route back-test logging for the ORS Sandbox (Letter I — slice 3b).
 *
 * Each user calibration of T (and, when Tier 3 ships, each price write-back)
 * persists the projection that drove the decision. Subsequent markets-page
 * scrapes back-fill the entry's `observed.share` from the leaderboard so
 * the user can compare projected vs. actual share over time.
 *
 * The accumulated record drives the sandbox UI's model-fit metrics
 * (slice 3c — bias + RMSE in the settings drawer) so the user can tell
 * whether their α_price / α_comfort / T tunes are improving or drifting.
 *
 *   routeAssistant:sandboxBacktest:<HUB>-<DEST>  →
 *     {hub, dest, entries: [<Entry>, …], updatedAt}
 *
 * Entry shape:
 *   {
 *     ts:           ms epoch (when the projection was made),
 *     trigger:      "calibrate" | "tier3-apply",
 *     scenario:     {priceMultipliers: {Y, C, F}, cargoMultiplier, frequency, comfortDelta},
 *     modelParams:  {T, source, ratingPriceElasticity, ratingComfortLift},
 *     projected:    {share, paxPerWeek, revenuePerWeek, profitPerWeek},
 *     observed?:    {share, paxPerWeek?, period},   // back-filled later
 *     backfilledAt?: ms epoch
 *   }
 *
 * Pair key is **directional** to match the orientation of every other
 * per-route store (overrides, notes, ORS, markets, watchlist, yield).
 *
 * Cap is `MAX_PER_ROUTE` entries via shift() — back-test data is
 * disposable; the user's authored content sits in other stores.
 */
class RouteAssistantSandboxBacktestStore {
    static PREFIX = "routeAssistant:sandboxBacktest:"
    static MAX_PER_ROUTE = 50

    /** Entries within this window before a marketShare scrape are
     *  back-fillable from that scrape. ~one period (8 days) — slightly
     *  larger than the 7-day default `shareMaxAgeDays` so a calibration
     *  done just before a scrape lands still matches. */
    static BACKFILL_WINDOW_MS = 8 * 86400 * 1000

    static _key(hub, dest) {
        return RouteAssistantSandboxBacktestStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static async get(hub, dest) {
        const key = RouteAssistantSandboxBacktestStore._key(hub, dest)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs (or {hub, dest} objects).
     * Returns Map<pairKey, record> where pairKey is "<HUB>-<DEST>".
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const keys = pairs.map(p => {
            const h = Array.isArray(p) ? p[0] : p.hub
            const d = Array.isArray(p) ? p[1] : p.dest
            return RouteAssistantSandboxBacktestStore._key(h, d)
        })
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            const pair = k.substring(RouteAssistantSandboxBacktestStore.PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Scan every record in chrome.storage.local with this PREFIX. Used
     * by the model-fit summary (slice 3c) which aggregates across the
     * user's full back-test history. Heavier than `getMany` — only call
     * from the settings drawer / explicit refresh.
     */
    static async loadAll() {
        const all = await chrome.storage.local.get(null)
        const map = new Map()
        for (const k in all) {
            if (!k.startsWith(RouteAssistantSandboxBacktestStore.PREFIX)) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.entries)) continue
            const pair = k.substring(RouteAssistantSandboxBacktestStore.PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Append a back-test entry. Caps at MAX_PER_ROUTE via shift()
     * (oldest first). Returns the stored record, or null on invalid
     * input (no projected.share AND no projected.paxPerWeek).
     */
    static async log(hub, dest, entry) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        const cleaned = RouteAssistantSandboxBacktestStore._normaliseEntry(entry || {})
        if (!cleaned) return null

        const key = RouteAssistantSandboxBacktestStore._key(hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
        const entries = (existing && Array.isArray(existing.entries))
            ? existing.entries.slice()
            : []
        entries.push(cleaned)
        while (entries.length > RouteAssistantSandboxBacktestStore.MAX_PER_ROUTE) entries.shift()
        const now = Date.now()
        const record = {
            hub:       hubU,
            dest:      destU,
            entries:   entries,
            updatedAt: now
        }
        await chrome.storage.local.set({[key]: record})
        return record
    }

    static async remove(hub, dest) {
        const key = RouteAssistantSandboxBacktestStore._key(hub, dest)
        await chrome.storage.local.remove([key])
    }

    /**
     * Back-fill `observed.share` for entries that were logged within
     * `BACKFILL_WINDOW_MS` before a fresh marketShare scrape. Mutates
     * matched records in storage; returns `{filled, scanned, skipped}`
     * so the caller can report.
     *
     * Caller already has the marketShare records keyed by pair (from
     * `marketsScraper.bulkLoadCache(pairs, {families: ["marketShare"]})`
     * → unwrap the per-pair `bucket.marketShare` first).
     */
    static async backfillManyFromMarketShares(pairs, marketSharesByPair, ourEnterpriseId) {
        const result = {filled: 0, scanned: 0, skipped: 0}
        if (!pairs || !pairs.length) return result
        if (ourEnterpriseId == null) return result

        const normPairs = pairs.map(p => {
            const h = Array.isArray(p) ? p[0] : p.hub
            const d = Array.isArray(p) ? p[1] : p.dest
            return [h, d]
        })
        const keys = normPairs.map(([h, d]) => RouteAssistantSandboxBacktestStore._key(h, d))
        const stored = await chrome.storage.local.get(keys)
        const writes = {}
        const now = Date.now()
        const targetEnterpriseId = Number(ourEnterpriseId)

        for (const [h, d] of normPairs) {
            const k = RouteAssistantSandboxBacktestStore._key(h, d)
            const rec = stored[k]
            if (!rec || !Array.isArray(rec.entries) || !rec.entries.length) continue
            const pair = RouteAssistantSandboxBacktestStore._pairKey(h, d)
            const ms = (marketSharesByPair && typeof marketSharesByPair.get === "function")
                ? marketSharesByPair.get(pair)
                : (marketSharesByPair && marketSharesByPair[pair])
            if (!ms || !ms.scrapedAt) continue
            const ourRow = (Array.isArray(ms.pax) ? ms.pax : []).find(r =>
                r && Number(r.enterpriseId) === targetEnterpriseId
            )
            if (!ourRow || ourRow.sharePct == null) continue
            const observedShare = Number(ourRow.sharePct) / 100
            if (!isFinite(observedShare)) continue

            const winLo = Number(ms.scrapedAt) - RouteAssistantSandboxBacktestStore.BACKFILL_WINDOW_MS
            const winHi = Number(ms.scrapedAt)
            let touched = false
            for (const e of rec.entries) {
                result.scanned++
                if (e.observed && e.observed.share != null) continue
                if (!isFinite(e.ts) || e.ts < winLo || e.ts > winHi) {
                    result.skipped++
                    continue
                }
                e.observed = {
                    share:  observedShare,
                    period: ms.period || null
                }
                e.backfilledAt = now
                touched = true
                result.filled++
            }
            if (touched) {
                rec.updatedAt = now
                writes[k] = rec
            }
        }
        if (Object.keys(writes).length) await chrome.storage.local.set(writes)
        return result
    }

    /**
     * Coerce a logged entry into the canonical shape. Returns null
     * for malformed input (no `projected.share` AND no `projected.paxPerWeek`).
     */
    static _normaliseEntry(e) {
        const ts = Number(e.ts) || Date.now()
        const proj = e.projected || {}
        if (proj.share == null && proj.paxPerWeek == null) return null
        const num = (v) => (v != null && isFinite(Number(v)) ? Number(v) : null)
        const out = {
            ts:        ts,
            trigger:   String(e.trigger || "calibrate"),
            scenario:  RouteAssistantSandboxBacktestStore._normaliseScenario(e.scenario),
            modelParams: {
                T:                     num(e.modelParams && e.modelParams.T),
                source:                (e.modelParams && e.modelParams.source) || "global",
                ratingPriceElasticity: num(e.modelParams && e.modelParams.ratingPriceElasticity),
                ratingComfortLift:     num(e.modelParams && e.modelParams.ratingComfortLift)
            },
            projected: {
                share:          num(proj.share),
                paxPerWeek:     num(proj.paxPerWeek),
                revenuePerWeek: num(proj.revenuePerWeek),
                profitPerWeek:  num(proj.profitPerWeek)
            }
        }
        if (e.observed && (e.observed.share != null || e.observed.paxPerWeek != null)) {
            out.observed = {
                share:      num(e.observed.share),
                paxPerWeek: num(e.observed.paxPerWeek),
                period:     e.observed.period || null
            }
            if (e.backfilledAt != null) out.backfilledAt = num(e.backfilledAt)
        }
        return out
    }

    static _normaliseScenario(s) {
        s = s || {}
        const pm = s.priceMultipliers || {}
        const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d)
        return {
            priceMultipliers: {
                Y: num(pm.Y, 1),
                C: num(pm.C, 1),
                F: num(pm.F, 1)
            },
            cargoMultiplier: num(s.cargoMultiplier, 1),
            frequency:       s.frequency != null ? num(s.frequency, null) : null,
            comfortDelta:    num(s.comfortDelta, 0)
        }
    }
}
