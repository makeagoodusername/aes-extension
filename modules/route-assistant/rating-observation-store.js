"use strict"

/**
 * Per-route per-class rating-price observation store (slice 2c).
 *
 * Logs one record per ORS scrape — observed prices (from the markets-page
 * ownPricing snapshot) joined with observed ratings (from the freshly-saved
 * ORS record's `byClass.<cls>.ourTopRating`). The demand-derivator regresses
 * these over time to produce a per-route per-class rating-price elasticity
 * (`α_price`) that replaces the global default in the ORS Sandbox model.
 *
 * Storage:
 *   routeAssistant:ratingObservations:<HUB>-<DEST>
 *     → {hub, dest, observations: [{
 *           at:                    <ms>,
 *           prices:                {Y, C, F},
 *           ratings:               {Y, C, F},
 *           ownConnections:        {Y, C, F},
 *           competitorConnections: {Y, C, F},
 *           comfortLevel:          <int|null>,
 *           pricingScrapedAt:      <ms>,
 *           orsScrapedAt:          <ms>
 *       }, …]}
 *
 * Pair key is **directional** — fares and ratings are direction-specific.
 *
 * Lifecycle:
 *   - `add` is read-modify-write under one storage call. Concurrent writes
 *     from a bulk ORS scrape are serialised by the scraper's concurrency=2
 *     plus stagger; race-tolerant for our usage.
 *   - Observations older than `MAX_AGE_MS` are pruned on every read.
 *   - The newest `MAX_OBS` observations are kept (FIFO trim).
 *   - Records with empty observation arrays after pruning are removed
 *     so storage doesn't fill with tombstones.
 */
class RouteAssistantRatingObservationStore {
    static PREFIX     = "routeAssistant:ratingObservations:"
    static MAX_OBS    = 50
    static MAX_AGE_MS = 90 * 86400000

    static _legacyKey(hub, dest) {
        return RouteAssistantRatingObservationStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantRatingObservationStore._legacyKey(hub, dest)
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

    /**
     * Returns `{hub, dest, observations: [...]}` or null. Pruned on read.
     * Account-scoped first; falls back to the legacy un-scoped key.
     */
    static async get(hub, dest, opts) {
        const acctId = RouteAssistantRatingObservationStore._resolveAccountId(opts)
        const scoped = RouteAssistantRatingObservationStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRatingObservationStore._legacyKey(hub, dest)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        const rec = out[scoped] || out[legacy] || null
        if (!rec) return null
        rec.observations = RouteAssistantRatingObservationStore._prune(rec.observations || [])
        return rec
    }

    /**
     * Bulk read for [hub, dest] pairs. Returns Map<pairKey, record>. Each
     * record is pruned on read; pairs with no record (or pruned to empty)
     * are absent from the map. Account-scoped first; per-pair legacy
     * fallback in the same combined `get()`.
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId = RouteAssistantRatingObservationStore._resolveAccountId(opts)
        const pairList   = []
        const scopedKeys = []
        const legacyKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairList.push(RouteAssistantRatingObservationStore._pairKey(h, d))
            scopedKeys.push(RouteAssistantRatingObservationStore._key(h, d, acctId))
            legacyKeys.push(RouteAssistantRatingObservationStore._legacyKey(h, d))
        }
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const out     = await chrome.storage.local.get(reqKeys)
        const map     = new Map()
        for (let i = 0; i < pairList.length; i++) {
            const rec = out[scopedKeys[i]] || out[legacyKeys[i]] || null
            if (!rec) continue
            const pruned = RouteAssistantRatingObservationStore._prune(rec.observations || [])
            if (!pruned.length) continue
            map.set(pairList[i], Object.assign({}, rec, {observations: pruned}))
        }
        return map
    }

    /**
     * Append one observation. Read-modify-write — pulls the existing
     * record (if any), prunes by age, appends the new entry, FIFO-trims
     * to `MAX_OBS`, and writes back. Silently no-ops on invalid input.
     * Reads scoped+legacy so existing accumulated history continues
     * after the migration; writes the scoped key only.
     */
    static async add(hub, dest, observation, opts) {
        if (!RouteAssistantRatingObservationStore._isValidObservation(observation)) return
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return

        const acctId = RouteAssistantRatingObservationStore._resolveAccountId(opts)
        const scoped = RouteAssistantRatingObservationStore._key(hubU, destU, acctId)
        const legacy = RouteAssistantRatingObservationStore._legacyKey(hubU, destU)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const fetched = await chrome.storage.local.get(reqKeys)
        const existing = fetched[scoped] || fetched[legacy] || null
        const prior = existing && Array.isArray(existing.observations) ? existing.observations : []
        const pruned = RouteAssistantRatingObservationStore._prune(prior)
        pruned.push(observation)
        // FIFO cap — newest MAX_OBS retained.
        const capped = pruned.length > RouteAssistantRatingObservationStore.MAX_OBS
            ? pruned.slice(pruned.length - RouteAssistantRatingObservationStore.MAX_OBS)
            : pruned

        const record = {
            hub:          hubU,
            dest:         destU,
            observations: capped,
            updatedAt:    Date.now()
        }
        await chrome.storage.local.set({[scoped]: record})
    }

    static async clear(hub, dest, opts) {
        const acctId = RouteAssistantRatingObservationStore._resolveAccountId(opts)
        const scoped = RouteAssistantRatingObservationStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRatingObservationStore._legacyKey(hub, dest)
        const toRemove = scoped === legacy ? [scoped] : [scoped, legacy]
        await chrome.storage.local.remove(toRemove)
    }

    /**
     * Wipe every observation record across all routes. Used by the
     * settings-drawer "Reset all observations" button. Account-aware:
     * with an `opts.accountId` (or session account) drops only that
     * account's keys + legacy keys; without scope, drops everything.
     */
    static async clearAll(opts) {
        const acctId = RouteAssistantRatingObservationStore._resolveAccountId(opts)
        const all = await chrome.storage.local.get(null)
        const PREFIX = RouteAssistantRatingObservationStore.PREFIX
        const acctMarker = acctId ? "acct:" + acctId + ":" : null
        const toRemove = []
        for (const k of Object.keys(all)) {
            if (!k.startsWith(PREFIX)) continue
            if (acctMarker) {
                const remainder = k.substring(PREFIX.length)
                if (remainder.startsWith("acct:") && !remainder.startsWith(acctMarker)) continue
            }
            toRemove.push(k)
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
        return toRemove.length
    }

    /**
     * Count total observations across cached routes — used by the
     * settings-drawer status line. Account-aware: counts only the active
     * account's keys plus legacy un-scoped keys, mirroring `getMany` /
     * derivator semantics. Returns `{routes, observations}`.
     */
    static async count(opts) {
        const acctId = RouteAssistantRatingObservationStore._resolveAccountId(opts)
        const all = await chrome.storage.local.get(null)
        const PREFIX = RouteAssistantRatingObservationStore.PREFIX
        const acctMarker = acctId ? "acct:" + acctId + ":" : null
        let routes = 0
        let observations = 0
        const cutoff = Date.now() - RouteAssistantRatingObservationStore.MAX_AGE_MS
        for (const k in all) {
            if (!k.startsWith(PREFIX)) continue
            if (acctMarker) {
                const remainder = k.substring(PREFIX.length)
                if (remainder.startsWith("acct:") && !remainder.startsWith(acctMarker)) continue
            }
            const rec = all[k]
            if (!rec || !Array.isArray(rec.observations)) continue
            const fresh = rec.observations.filter(o => o && typeof o.at === "number" && o.at >= cutoff)
            if (!fresh.length) continue
            routes += 1
            observations += fresh.length
        }
        return {routes, observations}
    }

    /**
     * An observation is valid when at least one class has a finite positive
     * price AND at least one class has a finite positive rating. Partial
     * cross-class data is fine — the derivator filters per class anyway.
     */
    static _isValidObservation(obs) {
        if (!obs || typeof obs !== "object") return false
        if (typeof obs.at !== "number" || !isFinite(obs.at) || obs.at <= 0) return false
        const prices  = obs.prices  || {}
        const ratings = obs.ratings || {}
        const hasPrice  = ["Y", "C", "F"].some(c => isFinite(Number(prices[c]))  && Number(prices[c])  > 0)
        const hasRating = ["Y", "C", "F"].some(c => isFinite(Number(ratings[c])) && Number(ratings[c]) > 0)
        return hasPrice && hasRating
    }

    static _prune(observations) {
        if (!Array.isArray(observations) || !observations.length) return []
        const cutoff = Date.now() - RouteAssistantRatingObservationStore.MAX_AGE_MS
        const fresh = observations.filter(o => o && typeof o.at === "number" && o.at >= cutoff)
        if (fresh.length <= RouteAssistantRatingObservationStore.MAX_OBS) return fresh
        return fresh.slice(fresh.length - RouteAssistantRatingObservationStore.MAX_OBS)
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantRatingObservationStore
}
