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

    static _key(hub, dest) {
        return RouteAssistantRatingObservationStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    /**
     * Returns `{hub, dest, observations: [...]}` or null. Pruned on read.
     */
    static async get(hub, dest) {
        const key = RouteAssistantRatingObservationStore._key(hub, dest)
        const out = await chrome.storage.local.get([key])
        const rec = out[key] || null
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
        const keys = pairs.map(p => {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            return RouteAssistantRatingObservationStore._key(h, d)
        })
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            const pruned = RouteAssistantRatingObservationStore._prune(rec.observations || [])
            if (!pruned.length) continue
            const pair = k.substring(RouteAssistantRatingObservationStore.PREFIX.length)
            map.set(pair, Object.assign({}, rec, {observations: pruned}))
        }
        return map
    }

    /**
     * Append one observation. Read-modify-write — pulls the existing
     * record (if any), prunes by age, appends the new entry, FIFO-trims
     * to `MAX_OBS`, and writes back. Silently no-ops on invalid input.
     */
    static async add(hub, dest, observation) {
        if (!RouteAssistantRatingObservationStore._isValidObservation(observation)) return
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return

        const key = RouteAssistantRatingObservationStore._key(hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
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
        await chrome.storage.local.set({[key]: record})
    }

    static async clear(hub, dest) {
        const key = RouteAssistantRatingObservationStore._key(hub, dest)
        await chrome.storage.local.remove([key])
    }

    /**
     * Wipe every observation record across all routes. Used by the
     * settings-drawer "Reset all observations" button.
     */
    static async clearAll() {
        const all = await chrome.storage.local.get(null)
        const toRemove = Object.keys(all).filter(k => k.startsWith(RouteAssistantRatingObservationStore.PREFIX))
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
        return toRemove.length
    }

    /**
     * Count total observations across every cached route — used by the
     * settings-drawer status line.
     * Returns `{routes, observations}`.
     */
    static async count() {
        const all = await chrome.storage.local.get(null)
        let routes = 0
        let observations = 0
        const cutoff = Date.now() - RouteAssistantRatingObservationStore.MAX_AGE_MS
        for (const k in all) {
            if (!k.startsWith(RouteAssistantRatingObservationStore.PREFIX)) continue
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
