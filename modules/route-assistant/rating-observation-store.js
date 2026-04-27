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
 *   routeAssistant:ratingObservations:<HUB>-<DEST>                  (legacy)
 *   routeAssistant:ratingObservations:acct:<id>:<HUB>-<DEST>        (L3+)
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
 * L3 — Class B refactor: namespaced via `acctKey()`. Observations are
 * scoped per account because the model fits a regression on the user's
 * own pricing/rating combinations — mixing across accounts blends two
 * different airlines' service-mix decisions and produces meaningless
 * elasticity estimates.
 */
class RouteAssistantRatingObservationStore {
    static LEGACY_PREFIX = "routeAssistant:ratingObservations:"
    static SCOPE_PREFIX  = "routeAssistant:ratingObservations"
    static MAX_OBS    = 50
    static MAX_AGE_MS = 90 * 86400000

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantRatingObservationStore.SCOPE_PREFIX,
            RouteAssistantRatingObservationStore._pairKey(hub, dest))
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantRatingObservationStore.LEGACY_PREFIX
            + RouteAssistantRatingObservationStore._pairKey(hub, dest)
    }

    /** Returns `{hub, dest, observations: [...]}` or null. Pruned on read. */
    static async get(hub, dest) {
        const ns = RouteAssistantRatingObservationStore._key(hub, dest)
        const lg = RouteAssistantRatingObservationStore._legacyKey(hub, dest)
        let rec = null
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            rec = out[ns] || null
        } else {
            const out = await chrome.storage.local.get([ns, lg])
            rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
        }
        if (!rec) return null
        rec.observations = RouteAssistantRatingObservationStore._prune(rec.observations || [])
        return rec
    }

    /**
     * Bulk read for [hub, dest] pairs. Returns Map<pairKey, record>. Each
     * record is pruned on read; pairs with no record (or pruned to empty)
     * are absent from the map.
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantRatingObservationStore._pairKey(h, d))
            nsKeys.push(RouteAssistantRatingObservationStore._key(h, d))
            lgKeys.push(RouteAssistantRatingObservationStore._legacyKey(h, d))
        }
        const all = []
        for (const k of nsKeys) all.push(k)
        for (const k of lgKeys) if (all.indexOf(k) < 0) all.push(k)
        const out = await chrome.storage.local.get(all)
        const map = new Map()
        for (let i = 0; i < pairs.length; i++) {
            const ns = nsKeys[i]
            const lg = lgKeys[i]
            const rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
            if (!rec) continue
            const pruned = RouteAssistantRatingObservationStore._prune(rec.observations || [])
            if (!pruned.length) continue
            map.set(pairKeys[i], Object.assign({}, rec, {observations: pruned}))
        }
        return map
    }

    /**
     * Append one observation. Read-modify-write — pulls the existing
     * record (if any, with legacy fallback so pre-L3 history seeds the
     * namespaced record on the next observation), prunes by age, appends
     * the new entry, FIFO-trims to `MAX_OBS`, and writes back to the
     * namespaced slot. Silently no-ops on invalid input.
     */
    static async add(hub, dest, observation) {
        if (!RouteAssistantRatingObservationStore._isValidObservation(observation)) return
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return

        const ns = RouteAssistantRatingObservationStore._key(hubU, destU)
        const lg = RouteAssistantRatingObservationStore._legacyKey(hubU, destU)
        const reads = (ns === lg) ? [ns] : [ns, lg]
        const out = await chrome.storage.local.get(reads)
        const existing = out[ns] !== undefined ? out[ns] : (out[lg] || null)
        const prior = existing && Array.isArray(existing.observations) ? existing.observations : []
        const pruned = RouteAssistantRatingObservationStore._prune(prior)
        pruned.push(observation)
        const capped = pruned.length > RouteAssistantRatingObservationStore.MAX_OBS
            ? pruned.slice(pruned.length - RouteAssistantRatingObservationStore.MAX_OBS)
            : pruned

        const record = {
            hub:          hubU,
            dest:         destU,
            observations: capped,
            updatedAt:    Date.now()
        }
        await chrome.storage.local.set({[ns]: record})
    }

    static async clear(hub, dest) {
        const ns = RouteAssistantRatingObservationStore._key(hub, dest)
        const lg = RouteAssistantRatingObservationStore._legacyKey(hub, dest)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
    }

    /**
     * Wipe every observation record for the CURRENT account, plus any
     * legacy records (which can't unambiguously be assigned to another
     * account post-L3). Other accounts' namespaced records are preserved.
     */
    static async clearAll() {
        const id = (typeof currentAccountIdSync === "function") ? currentAccountIdSync() : null
        const myNs = id ? RouteAssistantRatingObservationStore.SCOPE_PREFIX + ":acct:" + id + ":" : null
        const all = await chrome.storage.local.get(null)
        const toRemove = []
        for (const k of Object.keys(all)) {
            if (!k.startsWith(RouteAssistantRatingObservationStore.LEGACY_PREFIX)) continue
            if (myNs && k.startsWith(myNs)) {
                toRemove.push(k)
            } else if (k.indexOf(":acct:") === -1) {
                // Legacy (no :acct: marker) — clear it too.
                toRemove.push(k)
            }
            // else: another account's namespaced — skip.
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
        return toRemove.length
    }

    /**
     * Count total observations across this account's records (namespaced
     * for the current account, plus legacy as fallback). Other accounts'
     * data is excluded.
     */
    static async count() {
        const id = (typeof currentAccountIdSync === "function") ? currentAccountIdSync() : null
        const myNs = id ? RouteAssistantRatingObservationStore.SCOPE_PREFIX + ":acct:" + id + ":" : null
        const all = await chrome.storage.local.get(null)
        const cutoff = Date.now() - RouteAssistantRatingObservationStore.MAX_AGE_MS
        const seenSuffix = new Set()
        let routes = 0
        let observations = 0

        // Pass 1 — namespaced for current account.
        if (myNs) {
            for (const k of Object.keys(all)) {
                if (!k.startsWith(myNs)) continue
                const rec = all[k]
                if (!rec || !Array.isArray(rec.observations)) continue
                const fresh = rec.observations.filter(o => o && typeof o.at === "number" && o.at >= cutoff)
                if (!fresh.length) continue
                seenSuffix.add(k.substring(myNs.length))
                routes += 1
                observations += fresh.length
            }
        }
        // Pass 2 — legacy fallback for suffixes the current account hasn't
        // yet written. Skip entries that are clearly another account's
        // namespaced via the :acct: marker.
        for (const k of Object.keys(all)) {
            if (!k.startsWith(RouteAssistantRatingObservationStore.LEGACY_PREFIX)) continue
            if (k.indexOf(":acct:") !== -1) continue
            const suffix = k.substring(RouteAssistantRatingObservationStore.LEGACY_PREFIX.length)
            if (seenSuffix.has(suffix)) continue
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

    /** L3 deprecated — preserve for any reader still doing key arithmetic. */
    static get PREFIX() { return RouteAssistantRatingObservationStore.LEGACY_PREFIX }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantRatingObservationStore
}
