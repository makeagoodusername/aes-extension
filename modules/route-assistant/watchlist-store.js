/**
 * Watchlist store for the Route Assistant — stub.
 *
 * Per-row star toggle. Long-running games accumulate routes the user is
 * actively monitoring (competitor entered, freshly opened, pending
 * reschedule). Starring pins a route into a watchlist so it can be
 * surfaced above unstarred rows and optionally flagged when its diff vs
 * last visit shows a "worse" change in any tracked field.
 *
 * Storage layout — single global key, non-directional:
 *
 *   routeAssistant:watchlist  →
 *     {server, routes: {[<HUB>-<DEST>]: {addedAt, note?}}}
 *
 * Bound to a single record because watchlists are typically dozens of
 * routes, not hundreds, and reads happen on every panel render — bulk
 * load is ~free at this size.
 *
 * Triggers (the diff-vs-last-visit fields that produce a red dot when
 * `settings.routeAssistant.watchlist.showAlertBadges` is on) are exposed
 * as a static const so the panel can both walk them and render badges
 * without duplicating the list. Add tracked fields here when extending.
 */
class RouteAssistantWatchlistStore {
    static CACHE_KEY = "routeAssistant:watchlist"

    static _scopedKey(accountId) {
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(
                RouteAssistantWatchlistStore.CACHE_KEY, accountId)
        }
        return RouteAssistantWatchlistStore.CACHE_KEY
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

    /**
     * Fields whose "worse" delta (per the Diff-against-last-visit feature)
     * triggers the red alert dot on a starred row. Each entry is
     * `{field, worseDirection}` where `worseDirection` is "down" when
     * "less is better" (score, profit) or "up" when "more is bad"
     * (airlineCount, competitorCount, ratingGapToTop sign-flipped).
     */
    static TRIGGERS = [
        {field: "score",                 worseDirection: "down"},
        {field: "paxScore",              worseDirection: "down"},
        {field: "cargoScore",            worseDirection: "down"},
        {field: "ourPaxShare",           worseDirection: "down"},
        {field: "orsRatingGapToTop",     worseDirection: "down"},
        {field: "competitorCount",       worseDirection: "up"},
        {field: "airlineCount",          worseDirection: "up"},
        {field: "rmTightness",           worseDirection: "up"}
    ]

    static _routeKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    /**
     * Read the entire watchlist as a Map<routeKey, {addedAt, note?}>.
     * Returns an empty Map when the cache hasn't been written yet so
     * callers can iterate without null-checks.
     */
    static async loadAll(opts) {
        const acctId = RouteAssistantWatchlistStore._resolveAccountId(opts)
        const blob = await RouteAssistantWatchlistStore._loadBlob(acctId)
        const m = new Map()
        if (blob && blob.routes && typeof blob.routes === "object") {
            for (const k in blob.routes) m.set(k, blob.routes[k])
        }
        return m
    }

    /**
     * Convenience — Set<routeKey> for fast membership checks during render.
     */
    static async loadKeys(opts) {
        const map = await RouteAssistantWatchlistStore.loadAll(opts)
        return new Set(map.keys())
    }

    static async has(hub, dest, opts) {
        const set = await RouteAssistantWatchlistStore.loadKeys(opts)
        return set.has(RouteAssistantWatchlistStore._routeKey(hub, dest))
    }

    /**
     * Toggle a route's starred state. Returns the new state (true =
     * starred). Note (free text, optional) is preserved when toggling
     * back on after a remove.
     */
    static async toggle(hub, dest, opts) {
        const acctId = RouteAssistantWatchlistStore._resolveAccountId(opts)
        const key = RouteAssistantWatchlistStore._routeKey(hub, dest)
        const blob = await RouteAssistantWatchlistStore._loadBlob(acctId)
        if (blob.routes[key]) {
            delete blob.routes[key]
            await RouteAssistantWatchlistStore._saveBlob(blob, acctId)
            return false
        }
        blob.routes[key] = {
            addedAt: Date.now(),
            note:    (opts && typeof opts.note === "string") ? opts.note.trim().substring(0, 200) : null
        }
        await RouteAssistantWatchlistStore._saveBlob(blob, acctId)
        return true
    }

    /**
     * Pin/unpin without toggling. Pass `state = true` to add, `false` to
     * remove. Returns true if the call changed anything.
     */
    static async set(hub, dest, state, opts) {
        const acctId = RouteAssistantWatchlistStore._resolveAccountId(opts)
        const key = RouteAssistantWatchlistStore._routeKey(hub, dest)
        const blob = await RouteAssistantWatchlistStore._loadBlob(acctId)
        const has = !!blob.routes[key]
        if (state && !has) {
            blob.routes[key] = {
                addedAt: Date.now(),
                note:    (opts && typeof opts.note === "string") ? opts.note.trim().substring(0, 200) : null
            }
            await RouteAssistantWatchlistStore._saveBlob(blob, acctId)
            return true
        }
        if (!state && has) {
            delete blob.routes[key]
            await RouteAssistantWatchlistStore._saveBlob(blob, acctId)
            return true
        }
        return false
    }

    static async _loadBlob(accountId) {
        const scoped = RouteAssistantWatchlistStore._scopedKey(accountId)
        const legacy = RouteAssistantWatchlistStore.CACHE_KEY
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        const blob = out[scoped] || out[legacy] || null
        return blob && blob.routes
            ? blob
            : {server: null, routes: {}, updatedAt: null}
    }

    static async _saveBlob(blob, accountId) {
        blob.updatedAt = Date.now()
        const scoped = RouteAssistantWatchlistStore._scopedKey(accountId)
        await chrome.storage.local.set({[scoped]: blob})
    }
}
