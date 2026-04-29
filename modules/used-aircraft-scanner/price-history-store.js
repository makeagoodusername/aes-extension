/**
 * Per-type rolling price observations recorded on every successful scan.
 *
 * The deal classifier uses these tuples to compute percentiles — "is this
 * $/seat at the 12th percentile of what we've seen for Boeing 737-800 in the
 * last 90 days?" That's how a "Steal" gets called a steal in absolute terms
 * rather than only relative to the current visible result set.
 *
 * Storage:
 *   <server>marketScan:history:<typeId>
 *     → {typeId, entries: [{pricePerSeat, priceBasis, leasePerSeat,
 *                            seatKmYearCost, fuelPerSeatKm, conditionPct,
 *                            ageYears, observedAt}],
 *        lastUpdatedAt}
 *
 * pricePerSeat carries the basis chosen at decorate time (lease vs
 * purchase) and `priceBasis` tags it. Legacy entries from before the
 * lease-first rework lack `priceBasis`; the classifier treats them as
 * "purchase" since that's what the prior world wrote.
 *
 * One key per typeId so a write to one family does not read-modify-write the
 * histories of every other type the user has ever scanned.
 *
 * Caps:
 *   - 500 entries per typeId (ringbuffer — oldest dropped first)
 *   - 90-day TTL per entry (cleaned on write + on explicit cleanup())
 *
 * Cold-start: when a typeId has no history (or fewer than MIN_SAMPLES), the
 * classifier falls back to within-scan percentile. Surface degrades quietly.
 */
class MarketScanPriceHistory {
    static MAX_ENTRIES_PER_TYPE = 500
    static MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
    static MIN_SAMPLES = 8
    static KEY_PREFIX_SUFFIX = "marketScan:history:"

    static _key(server, typeId) {
        return server + MarketScanPriceHistory.KEY_PREFIX_SUFFIX + typeId
    }

    static _isValidObservation(o) {
        if (!o) return false
        if (!o.typeId) return false
        const pps   = Number(o.pricePerSeat)
        const lease = Number(o.leasePerSeat)
        // Either a usable pricePerSeat (any basis) OR a lease price is
        // enough to make the entry useful for percentile lookups. Without
        // both we have nothing to score against.
        if ((!isFinite(pps) || pps <= 0) && (!isFinite(lease) || lease <= 0)) return false
        return true
    }

    static _trim(entries) {
        // Slice-1 foundation: delegate to shared trimEntries when loaded
        // (modules/_shared/ttl-cache.js); fall back to inline math otherwise
        // so this file stays usable in isolation. Behaviour identical.
        if (typeof trimEntries !== "undefined") {
            return trimEntries(entries, {
                maxEntries:     MarketScanPriceHistory.MAX_ENTRIES_PER_TYPE,
                ttlMs:          MarketScanPriceHistory.MAX_AGE_MS,
                freshnessField: "observedAt"
            })
        }
        const cutoff = Date.now() - MarketScanPriceHistory.MAX_AGE_MS
        const fresh = entries.filter(e => e && e.observedAt >= cutoff)
        if (fresh.length <= MarketScanPriceHistory.MAX_ENTRIES_PER_TYPE) return fresh
        return fresh.slice(fresh.length - MarketScanPriceHistory.MAX_ENTRIES_PER_TYPE)
    }

    /**
     * Bulk-record observations from a scan's rows. Skips rows missing a
     * usable pricePerSeat (the classifier's primary signal). De-dupes by
     * (typeId, registration) within a single recordRows call so one offer
     * appearing in two variants of the same scan still only contributes
     * one tuple.
     */
    static async recordRows(server, rows) {
        if (!Array.isArray(rows) || !rows.length) return
        const observedAt = Date.now()
        const seen = new Set()
        const byType = new Map()
        for (const r of rows) {
            if (!r) continue
            const typeId = r.typeId
            if (!typeId) continue
            const dedupKey = typeId + "|" + (r.registration || "")
            if (seen.has(dedupKey)) continue
            seen.add(dedupKey)
            const obs = {
                typeId:         typeId,
                pricePerSeat:   Number(r.pricePerSeat),
                priceBasis:     r.priceBasis || null,
                leasePerSeat:   Number(r.leasePerSeat),
                seatKmYearCost: Number(r.seatKmYearCost),
                fuelPerSeatKm:  Number(r.fuelPerSeatKm),
                conditionPct:   Number(r.conditionPct),
                ageYears:       Number(r.ageYears),
                observedAt:     observedAt
            }
            if (!MarketScanPriceHistory._isValidObservation(obs)) continue
            if (!byType.has(typeId)) byType.set(typeId, [])
            byType.get(typeId).push(obs)
        }
        if (!byType.size) return

        const keys = []
        for (const typeId of byType.keys()) keys.push(MarketScanPriceHistory._key(server, typeId))
        const data = await chrome.storage.local.get(keys)
        const writes = {}
        for (const [typeId, observations] of byType) {
            const key = MarketScanPriceHistory._key(server, typeId)
            const existing = data[key] || {typeId: typeId, entries: [], lastUpdatedAt: 0}
            const merged = MarketScanPriceHistory._trim(existing.entries.concat(observations))
            writes[key] = {typeId: typeId, entries: merged, lastUpdatedAt: observedAt}
        }
        await chrome.storage.local.set(writes)
        if (typeof AesDataBus !== "undefined") {
            AesDataBus.emit("data:scanner:price-history:appended", {
                server:  server,
                typeIds: Array.from(byType.keys())
            })
        }
    }

    /**
     * Load history for a set of typeIds in one chrome.storage call. Returns
     * a Map<typeId, entries[]> for fast lookup during scoring. Missing types
     * are absent from the map (caller treats that as cold-start).
     */
    static async loadForTypes(server, typeIds) {
        const out = new Map()
        if (!Array.isArray(typeIds) || !typeIds.length) return out
        const unique = Array.from(new Set(typeIds.filter(Boolean)))
        if (!unique.length) return out
        const keys = unique.map(t => MarketScanPriceHistory._key(server, t))
        const data = await chrome.storage.local.get(keys)
        for (const t of unique) {
            const rec = data[MarketScanPriceHistory._key(server, t)]
            if (rec && Array.isArray(rec.entries) && rec.entries.length) {
                out.set(t, rec.entries)
            }
        }
        return out
    }

    /**
     * Percentile of `value` within `entries` on `field`. Returns the fraction
     * (0..1) of entries strictly less than value — so a low pricePerSeat
     * yields a low percentile (cheap = good).
     *
     * Returns null when there aren't enough samples to be meaningful (under
     * MIN_SAMPLES). Caller falls back to within-scan percentile in that case.
     */
    static percentile(entries, field, value) {
        if (!Array.isArray(entries)) return null
        const v = Number(value)
        if (!isFinite(v)) return null
        const samples = []
        for (const e of entries) {
            if (!e) continue
            const n = Number(e[field])
            if (isFinite(n)) samples.push(n)
        }
        if (samples.length < MarketScanPriceHistory.MIN_SAMPLES) return null
        let below = 0
        for (const s of samples) if (s < v) below++
        return below / samples.length
    }

    /**
     * Removes entries older than MAX_AGE_MS across every per-type history
     * for `server`. Empty histories are deleted. Called on scanner startup.
     *
     * Uses chrome.storage.local.getKeys() (Chrome 130+) to scope the scan
     * to our prefix without pulling every other module's storage blobs.
     * Falls back to the legacy full-read on older Chromes.
     */
    static async cleanup(server) {
        // When called without a server arg (e.g. from AesCleanup.runAll), match
        // every history key across every server. The substring is unique
        // enough that we won't collide with other modules' storage.
        const matchPrefix = server
            ? (server + MarketScanPriceHistory.KEY_PREFIX_SUFFIX)
            : null
        const matches = (k) => matchPrefix
            ? k.indexOf(matchPrefix) === 0
            : k.indexOf(MarketScanPriceHistory.KEY_PREFIX_SUFFIX) >= 0
        let ours = []
        if (chrome.storage.local.getKeys) {
            const allKeys = await chrome.storage.local.getKeys()
            ours = allKeys.filter(matches)
            if (!ours.length) return {removed: 0, kept: 0}
        }
        const all = ours.length
            ? await chrome.storage.local.get(ours)
            : await chrome.storage.local.get(null)
        const toRemove = []
        const toUpdate = {}
        let kept = 0
        for (const k in all) {
            if (!matches(k)) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.entries)) { toRemove.push(k); continue }
            const trimmed = MarketScanPriceHistory._trim(rec.entries)
            if (!trimmed.length) toRemove.push(k)
            else {
                kept++
                if (trimmed.length !== rec.entries.length) {
                    toUpdate[k] = {typeId: rec.typeId, entries: trimmed,
                                   lastUpdatedAt: rec.lastUpdatedAt || Date.now()}
                }
            }
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
        if (Object.keys(toUpdate).length) await chrome.storage.local.set(toUpdate)
        return {removed: toRemove.length, kept: kept}
    }
}

// Slice-1 foundation: register the cross-server sweep with the shared
// cleanup registry. Inline `cleanup(server)` calls (e.g. from the scanner
// panel/controller) keep working unchanged — they pass the server explicitly
// when they want a server-scoped pass.
;(function () {
    if (typeof AesCleanup === "undefined") return
    AesCleanup.register("scanner:price-history",
        () => MarketScanPriceHistory.cleanup(),
        {everyMs: 24 * 3600e3})
})()

if (typeof module !== "undefined" && module.exports) module.exports = MarketScanPriceHistory
