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
 *   routeAssistant:statusHistory:<HUB>-<DEST>  →                   (legacy)
 *   routeAssistant:statusHistory:acct:<id>:<HUB>-<DEST>  →         (L2+)
 *     {hub, dest, transitions: [{from, to, at}, …], updatedAt}
 *
 * Each entry: `from` is the prior status the panel saw (or null for the
 * very first observation), `to` is the new one, `at` is unix-ms.
 *
 * Append-only with dedup-on-no-change: `appendTransition` is a no-op when
 * `from === to`. Transitions are pruned to the most recent
 * `MAX_TRANSITIONS` so a long-running game doesn't accumulate unbounded
 * storage per route.
 *
 * L2 — namespaced key + legacy fallback. Single appender, so no
 * accountId round-trip needed (status drift is observed live in the
 * current page lifecycle, not deferred-restored like an Undo).
 */
class RouteAssistantStatusHistoryStore {
    static LEGACY_PREFIX = "routeAssistant:statusHistory:"
    static SCOPE_PREFIX  = "routeAssistant:statusHistory"
    static MAX_TRANSITIONS = 20

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantStatusHistoryStore.SCOPE_PREFIX,
            RouteAssistantStatusHistoryStore._pairKey(hub, dest))
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantStatusHistoryStore.LEGACY_PREFIX
            + RouteAssistantStatusHistoryStore._pairKey(hub, dest)
    }

    static async get(hub, dest) {
        const ns = RouteAssistantStatusHistoryStore._key(hub, dest)
        const lg = RouteAssistantStatusHistoryStore._legacyKey(hub, dest)
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            return out[ns] || null
        }
        const out = await chrome.storage.local.get([ns, lg])
        if (out[ns] !== undefined) return out[ns]
        return out[lg] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs. Returns
     * `Map<pairKey, record>` where `pairKey` is "<HUB>-<DEST>" uppercased.
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantStatusHistoryStore._pairKey(h, d))
            nsKeys.push(RouteAssistantStatusHistoryStore._key(h, d))
            lgKeys.push(RouteAssistantStatusHistoryStore._legacyKey(h, d))
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
            if (rec) map.set(pairKeys[i], rec)
        }
        return map
    }

    /**
     * Append a transition to the route's log when `toStatus` differs from
     * the prior `to`. No-op when status hasn't moved.
     *
     * Returns the updated record, or null when no transition was recorded
     * (status unchanged or `toStatus` is empty). Reads via legacy fallback
     * so a pre-L2 history continues forward into the namespaced slot
     * with the next live transition.
     */
    static async appendTransition(hub, dest, toStatus, atMs) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        if (!toStatus || typeof toStatus !== "string") return null
        const at = (typeof atMs === "number" && isFinite(atMs)) ? atMs : Date.now()

        // Read both keys so a pre-L2 history seeds the namespaced
        // record on the next live transition.
        const ns = RouteAssistantStatusHistoryStore._key(hubU, destU)
        const lg = RouteAssistantStatusHistoryStore._legacyKey(hubU, destU)
        const reads = (ns === lg) ? [ns] : [ns, lg]
        const out = await chrome.storage.local.get(reads)
        const existing = out[ns] !== undefined ? out[ns] : (out[lg] || null)

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
        await chrome.storage.local.set({[ns]: record})
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

    static async remove(hub, dest) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return
        const ns = RouteAssistantStatusHistoryStore._key(hubU, destU)
        const lg = RouteAssistantStatusHistoryStore._legacyKey(hubU, destU)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
    }

    /** L2 deprecated — preserve for any reader still doing key arithmetic. */
    static get PREFIX() { return RouteAssistantStatusHistoryStore.LEGACY_PREFIX }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantStatusHistoryStore
}
