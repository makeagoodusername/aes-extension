/**
 * Per-destination demand cache for the Route Assistant.
 *
 * Records are keyed by IATA and hold the AS pax/cargo demand scores (0-10)
 * that CountryScraper extracts, plus the airportId / countryId we needed to
 * fetch them. The scheduling-page panel reads from this cache; the
 * parallel-scanner writes to it.
 *
 *   routeAssistant:demand:<IATA> → {iata, name?, airportId?, countryId?,
 *                                    paxScore, cargoScore, scrapedAt}
 *
 * Country-level lookups (every airport in country X) are written in bulk via
 * `saveCountryAirports()` so a single CountryScraper run populates dozens of
 * destinations at once. Stale entries (older than `MAX_AGE_MS`) are not
 * served by `get()`; callers should treat a miss as "needs rescrape".
 *
 * Slice-1 foundation: TTL/freshness logic now flows through the shared
 * `createTtlCache` factory (modules/_shared/ttl-cache.js) — public API is
 * preserved bit-for-bit (`get(iata, {includeStale})`, `getMany`, `save`,
 * `saveCountryAirports`, `clearAll`) so callers don't change. Cleanup is
 * registered with AesCleanup so a single boot-time + alarm-driven sweep
 * replaces the prior "no centralised pruning" gap.
 */
class RouteAssistantDemandStore {
    static KEY_PREFIX = "routeAssistant:demand:"
    static MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days; demand bars change very slowly

    static _cache() {
        if (!RouteAssistantDemandStore._cacheInst) {
            if (typeof createTtlCache === "undefined") return null
            RouteAssistantDemandStore._cacheInst = createTtlCache({
                prefix:         RouteAssistantDemandStore.KEY_PREFIX,
                ttlMs:          RouteAssistantDemandStore.MAX_AGE_MS,
                freshnessField: "scrapedAt"
            })
        }
        return RouteAssistantDemandStore._cacheInst
    }

    static _key(iata) {
        return RouteAssistantDemandStore.KEY_PREFIX + String(iata || "").toUpperCase()
    }

    /**
     * Returns a demand record for `iata`, or null if absent or stale.
     * Pass `{includeStale: true}` to bypass the freshness check.
     */
    static async get(iata, opts) {
        if (!iata) return null
        const cache = RouteAssistantDemandStore._cache()
        if (cache) return cache.get(String(iata).toUpperCase(), opts)
        // Fallback when ttl-cache isn't loaded (defensive — should not happen
        // under the slice-1 manifest but keeps this file usable in isolation).
        const key = RouteAssistantDemandStore._key(iata)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec) return null
        if (!(opts && opts.includeStale)) {
            if (!rec.scrapedAt || Date.now() - rec.scrapedAt > RouteAssistantDemandStore.MAX_AGE_MS) {
                return null
            }
        }
        return rec
    }

    /**
     * Bulk read for many destinations at once. Returns a Map<IATA, record>
     * containing only fresh hits.
     */
    static async getMany(iatas) {
        if (!iatas || !iatas.length) return new Map()
        const cache = RouteAssistantDemandStore._cache()
        if (cache) {
            const upper = iatas.map(s => String(s).toUpperCase())
            return cache.bulkGet(upper)
        }
        const keys = iatas.map(RouteAssistantDemandStore._key)
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        const cutoff = Date.now() - RouteAssistantDemandStore.MAX_AGE_MS
        for (const k in out) {
            const rec = out[k]
            if (!rec || !rec.iata || !rec.scrapedAt || rec.scrapedAt < cutoff) continue
            map.set(rec.iata, rec)
        }
        return map
    }

    /**
     * Writes a single airport's demand record. Caller-supplied fields beyond
     * the standard shape are preserved (the parallel scanner attaches the
     * countryId so subsequent lookups in the same scan don't re-resolve).
     */
    static async save(record) {
        if (!record || !record.iata) throw new Error("save: iata required")
        const iata = String(record.iata).toUpperCase()
        const toStore = Object.assign({scrapedAt: Date.now()}, record, {iata: iata})
        const cache = RouteAssistantDemandStore._cache()
        if (cache) await cache.set(iata, toStore)
        else if (typeof AesWriteThrough !== "undefined") {
            await AesWriteThrough.put(RouteAssistantDemandStore._key(iata), toStore)
        } else {
            await chrome.storage.local.set({[RouteAssistantDemandStore._key(iata)]: toStore})
        }
        RouteAssistantDemandStore._emitSaved({iata: iata, count: 1})
        return toStore
    }

    /**
     * Bulk-save every airport returned by a single CountryScraper run.
     * `airports` is the array shape {iata, name, airportId, paxScore,
     * cargoScore} — all entries share the same `countryId`.
     *
     * Coalesces to ONE bus emit with the count, not N — see the coalescing
     * rule documented in modules/_shared/data-bus-topics.js.
     */
    static async saveCountryAirports(countryId, airports) {
        if (!airports || !airports.length) return
        const writes = {}
        const now = Date.now()
        let count = 0
        for (const a of airports) {
            if (!a || !a.iata) continue
            const iata = String(a.iata).toUpperCase()
            writes[RouteAssistantDemandStore.KEY_PREFIX + iata] = {
                iata:       iata,
                name:       a.name || null,
                airportId:  a.airportId || null,
                countryId:  countryId || null,
                paxScore:   typeof a.paxScore   === "number" ? a.paxScore   : null,
                cargoScore: typeof a.cargoScore === "number" ? a.cargoScore : null,
                scrapedAt:  now
            }
            count++
        }
        if (count) {
            const hint = {
                countryId: countryId || null,
                count:     count
            }
            if (typeof AesWriteThrough !== "undefined") {
                await AesWriteThrough.set(writes, {
                    topic: "data:route-assistant:demand:saved",
                    hint:  hint
                })
            } else {
                await chrome.storage.local.set(writes)
                RouteAssistantDemandStore._emitSaved(hint)
            }
        }
    }

    /**
     * Drops every demand record. Useful from DevTools when debugging.
     */
    static async clearAll() {
        const all = await chrome.storage.local.get(null)
        const drop = []
        for (const k in all) {
            if (k.indexOf(RouteAssistantDemandStore.KEY_PREFIX) === 0) drop.push(k)
        }
        if (drop.length) {
            const hint = {cleared: true, count: drop.length}
            if (typeof AesWriteThrough !== "undefined") {
                await AesWriteThrough.remove(drop, {
                    topic: "data:route-assistant:demand:saved",
                    hint:  hint
                })
            } else {
                await chrome.storage.local.remove(drop)
                RouteAssistantDemandStore._emitSaved(hint)
            }
        }
        return drop.length
    }

    static _emitSaved(hint) {
        if (typeof AesDataBus !== "undefined" && typeof AesDataBus.emit === "function") {
            AesDataBus.emit("data:route-assistant:demand:saved", hint || {})
        }
    }
}

// Slice-1 foundation: register the TTL sweep with the shared cleanup
// registry so a single boot-time + alarm-driven pass handles it instead
// of the prior "nobody calls cleanup" gap. Defensive guards: noop when
// the registry is absent (loaded into older content_scripts blocks).
;(function () {
    if (typeof AesCleanup === "undefined") return
    AesCleanup.register("route-assistant:demand", async () => {
        const cache = RouteAssistantDemandStore._cache()
        if (cache && cache.cleanup) return cache.cleanup()
        return {removed: 0, kept: 0}
    }, {everyMs: 24 * 3600e3})
})()

if (typeof window !== "undefined") {
    window.RouteAssistantDemandStore = RouteAssistantDemandStore
}
