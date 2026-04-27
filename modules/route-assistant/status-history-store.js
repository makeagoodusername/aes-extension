"use strict"

/**
 * Per-route status-transition log for the Route Assistant.
 *
 * The panel's per-route status (NEW / OK / UNDER / OVER / OOR) reflects
 * how the user's current schedule + demand match up. It changes over
 * time — a route that started OK can drift into UNDER as competitors
 * enter, or pop into OVER after a frequency increase. This store keeps
 * an append-only timestamped log of those transitions so the panel can
 * surface "OVER since 12d · was OK before" on the St cell tooltip.
 *
 * Pair key is **directional** to match `RouteAssistantRouteOverridesStore`,
 * `RouteAssistantRouteNoteStore`, etc. — status can drift independently
 * by direction (cargo-heavy outbound, pax-heavy inbound).
 *
 *   routeAssistant:statusHistory:<HUB>-<DEST>  →
 *     {hub, dest, transitions: [{from, to, at}, …], updatedAt}
 *
 * Each entry: `from` is the prior status the panel saw (or null for the
 * very first observation), `to` is the new one, `at` is unix-ms.
 *
 * Append-only with dedup-on-no-change: `appendTransition` is a no-op when
 * `from === to`. Transitions are pruned to the most recent
 * `MAX_TRANSITIONS` so a long-running game doesn't accumulate unbounded
 * storage per route.
 */
class RouteAssistantStatusHistoryStore {
    static PREFIX = "routeAssistant:statusHistory:"
    static MAX_TRANSITIONS = 20

    static _legacyKey(hub, dest) {
        return RouteAssistantStatusHistoryStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantStatusHistoryStore._legacyKey(hub, dest)
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
        const acctId = RouteAssistantStatusHistoryStore._resolveAccountId(opts)
        const scoped = RouteAssistantStatusHistoryStore._key(hub, dest, acctId)
        const legacy = RouteAssistantStatusHistoryStore._legacyKey(hub, dest)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        return out[scoped] || out[legacy] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs. Returns
     * `Map<pairKey, record>` where `pairKey` is "<HUB>-<DEST>" uppercased.
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId = RouteAssistantStatusHistoryStore._resolveAccountId(opts)
        const scopedKeys = []
        const legacyKeys = []
        const pairList   = []
        for (const [h, d] of pairs) {
            scopedKeys.push(RouteAssistantStatusHistoryStore._key(h, d, acctId))
            legacyKeys.push(RouteAssistantStatusHistoryStore._legacyKey(h, d))
            pairList.push(RouteAssistantStatusHistoryStore._pairKey(h, d))
        }
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const out = await chrome.storage.local.get(reqKeys)
        const map = new Map()
        for (let i = 0; i < pairList.length; i++) {
            const rec = out[scopedKeys[i]] || out[legacyKeys[i]] || null
            if (rec) map.set(pairList[i], rec)
        }
        return map
    }

    /**
     * Append a transition to the route's log when `toStatus` differs from
     * the prior `to`. No-op when status hasn't moved.
     *
     * Returns the updated record, or null when no transition was recorded
     * (status unchanged or `toStatus` is empty).
     */
    static async appendTransition(hub, dest, toStatus, atMs, opts) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        if (!toStatus || typeof toStatus !== "string") return null
        const at = (typeof atMs === "number" && isFinite(atMs)) ? atMs : Date.now()
        const acctId = RouteAssistantStatusHistoryStore._resolveAccountId(opts)

        const key = RouteAssistantStatusHistoryStore._key(hubU, destU, acctId)
        const legacy = RouteAssistantStatusHistoryStore._legacyKey(hubU, destU)
        const reqKeys = key === legacy ? [key] : [key, legacy]
        const existingMap = await chrome.storage.local.get(reqKeys)
        const existing = existingMap[key] || existingMap[legacy] || null
        const transitions = (existing && Array.isArray(existing.transitions))
            ? existing.transitions.slice()
            : []
        const last = transitions.length ? transitions[transitions.length - 1] : null
        const fromStatus = last ? last.to : null
        // Dedup: if the latest entry's `to` already matches the new status,
        // do nothing. Don't tick `updatedAt` either — the user-facing
        // "since X days" should reflect the actual transition timestamp,
        // not the last time we observed the same status.
        if (last && last.to === toStatus) return null

        transitions.push({from: fromStatus, to: toStatus, at: at})
        // Cap to most recent N. The very first transition (`from: null`,
        // `to: <whatever>`) is dropped in favour of the next transition,
        // which is fine — its information is just "we saw this status
        // first" and that's preserved by the next entry's `from`.
        if (transitions.length > RouteAssistantStatusHistoryStore.MAX_TRANSITIONS) {
            transitions.splice(0, transitions.length - RouteAssistantStatusHistoryStore.MAX_TRANSITIONS)
        }

        const record = {
            hub:         hubU,
            dest:        destU,
            transitions: transitions,
            updatedAt:   at
        }
        await chrome.storage.local.set({[key]: record})
        return record
    }

    /**
     * Convenience accessor — returns the last transition entry or null.
     * The St cell tooltip uses this to render "X since {at}".
     */
    static latestTransition(record) {
        if (!record || !Array.isArray(record.transitions) || !record.transitions.length) return null
        return record.transitions[record.transitions.length - 1]
    }

    static async remove(hub, dest, opts) {
        const acctId = RouteAssistantStatusHistoryStore._resolveAccountId(opts)
        const key = RouteAssistantStatusHistoryStore._key(hub, dest, acctId)
        const legacy = RouteAssistantStatusHistoryStore._legacyKey(hub, dest)
        const toRemove = key === legacy ? [key] : [key, legacy]
        await chrome.storage.local.remove(toRemove)
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantStatusHistoryStore
}
