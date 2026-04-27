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

    static _legacyKey(hub, dest) {
        return RouteAssistantSandboxBacktestStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantSandboxBacktestStore._legacyKey(hub, dest)
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(legacy, accountId)
        }
        return legacy
    }

    static _resolveAccountId(opts) {
        if (opts && typeof opts.accountId === "string" && opts.accountId) return opts.accountId
        if (typeof globalThis !== "undefined"
            && globalThis.AesAccountScopedKey
            && typeof globalThis.AesAccountScopedKey.currentAccountIdSync === "function") {
            return globalThis.AesAccountScopedKey.currentAccountIdSync()
        }
        return null
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static async get(hub, dest, opts) {
        const acctId = RouteAssistantSandboxBacktestStore._resolveAccountId(opts)
        const scoped = RouteAssistantSandboxBacktestStore._key(hub, dest, acctId)
        const legacy = RouteAssistantSandboxBacktestStore._legacyKey(hub, dest)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        return out[scoped] || out[legacy] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs (or {hub, dest} objects).
     * Returns Map<pairKey, record> where pairKey is "<HUB>-<DEST>".
     * Account-scoped first with a legacy-key fallback.
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId = RouteAssistantSandboxBacktestStore._resolveAccountId(opts)
        const pairList   = []
        const scopedKeys = []
        const legacyKeys = []
        for (const p of pairs) {
            const h = Array.isArray(p) ? p[0] : p.hub
            const d = Array.isArray(p) ? p[1] : p.dest
            pairList.push(RouteAssistantSandboxBacktestStore._pairKey(h, d))
            scopedKeys.push(RouteAssistantSandboxBacktestStore._key(h, d, acctId))
            legacyKeys.push(RouteAssistantSandboxBacktestStore._legacyKey(h, d))
        }
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const out     = await chrome.storage.local.get(reqKeys)
        const map     = new Map()
        for (let i = 0; i < pairList.length; i++) {
            const rec = out[scopedKeys[i]] || out[legacyKeys[i]] || null
            if (!rec) continue
            map.set(pairList[i], rec)
        }
        return map
    }

    /**
     * Scan every record in chrome.storage.local with this PREFIX. Used
     * by the model-fit summary (slice 3c) which aggregates across the
     * user's full back-test history. Heavier than `getMany` — only call
     * from the settings drawer / explicit refresh.
     *
     * Account-aware: when `opts.accountId` (or the bootstrapped session
     * accountId) is present, returns only entries scoped to that account
     * PLUS legacy un-scoped entries (which the migration step will
     * eventually adopt into the right account).
     */
    static async loadAll(opts) {
        const acctId = RouteAssistantSandboxBacktestStore._resolveAccountId(opts)
        const all = await chrome.storage.local.get(null)
        const map = new Map()
        const PREFIX = RouteAssistantSandboxBacktestStore.PREFIX
        const acctMarker = acctId ? "acct:" + acctId + ":" : null
        for (const k in all) {
            if (!k.startsWith(PREFIX)) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.entries)) continue
            // Restrict to the active account when scoping is in effect:
            // include legacy keys (no `acct:` segment after PREFIX) +
            // matching `acct:<id>:` keys; drop other accounts'.
            const remainder = k.substring(PREFIX.length)
            if (acctMarker) {
                if (remainder.startsWith("acct:")) {
                    if (!remainder.startsWith(acctMarker)) continue
                }
            }
            // Use the route pair (last segment after the optional `acct:`)
            // as the map key so the caller's pair-keyed lookups still work.
            const pair = remainder.startsWith("acct:")
                ? remainder.substring(remainder.indexOf(":", 5) + 1)
                : remainder
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Append a back-test entry. Caps at MAX_PER_ROUTE via shift()
     * (oldest first). Returns the stored record, or null on invalid
     * input (no projected.share AND no projected.paxPerWeek).
     */
    static async log(hub, dest, entry, opts) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        const cleaned = RouteAssistantSandboxBacktestStore._normaliseEntry(entry || {})
        if (!cleaned) return null

        const acctId = RouteAssistantSandboxBacktestStore._resolveAccountId(opts)
        const scoped = RouteAssistantSandboxBacktestStore._key(hubU, destU, acctId)
        const legacy = RouteAssistantSandboxBacktestStore._legacyKey(hubU, destU)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const fetched = await chrome.storage.local.get(reqKeys)
        const existing = fetched[scoped] || fetched[legacy] || null
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
        await chrome.storage.local.set({[scoped]: record})
        return record
    }

    static async remove(hub, dest, opts) {
        const acctId = RouteAssistantSandboxBacktestStore._resolveAccountId(opts)
        const scoped = RouteAssistantSandboxBacktestStore._key(hub, dest, acctId)
        const legacy = RouteAssistantSandboxBacktestStore._legacyKey(hub, dest)
        const toRemove = scoped === legacy ? [scoped] : [scoped, legacy]
        await chrome.storage.local.remove(toRemove)
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
    static async backfillManyFromMarketShares(pairs, marketSharesByPair, ourEnterpriseId, opts) {
        const result = {filled: 0, scanned: 0, skipped: 0}
        if (!pairs || !pairs.length) return result
        if (ourEnterpriseId == null) return result

        const acctId = RouteAssistantSandboxBacktestStore._resolveAccountId(opts)
        const normPairs = pairs.map(p => {
            const h = Array.isArray(p) ? p[0] : p.hub
            const d = Array.isArray(p) ? p[1] : p.dest
            return [h, d]
        })
        const scopedKeys = normPairs.map(([h, d]) => RouteAssistantSandboxBacktestStore._key(h, d, acctId))
        const legacyKeys = normPairs.map(([h, d]) => RouteAssistantSandboxBacktestStore._legacyKey(h, d))
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const stored = await chrome.storage.local.get(reqKeys)
        const writes = {}
        const now = Date.now()
        const targetEnterpriseId = Number(ourEnterpriseId)

        for (let i = 0; i < normPairs.length; i++) {
            const [h, d] = normPairs[i]
            const writeKey = scopedKeys[i]
            const rec = stored[writeKey] || stored[legacyKeys[i]] || null
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
                writes[writeKey] = rec
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
