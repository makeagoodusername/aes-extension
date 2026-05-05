"use strict"

/**
 * Per-route per-class manual rating-price α overrides (slice 2c).
 *
 * Sibling to `route-overrides-store.js` but kept SEPARATE because:
 *   - `route-overrides-store._clean` uses full-replace semantics; five
 *     other callers save() without passing α fields, which would silently
 *     erase a manual α whenever any other override field was edited.
 *   - α is a single concept (rating-shift sensitivity per class) with a
 *     small range and clear semantics; mixing it into the LF/yield
 *     editor pollutes that surface.
 *   - The α expander UI lives inside the ORS Sandbox results card, not
 *     the override editor, so users see the override next to where the
 *     model consumes it.
 *
 * Storage:
 *   routeAssistant:ratingAlpha:<HUB>-<DEST>  →                     (legacy)
 *   routeAssistant:ratingAlpha:acct:<id>:<HUB>-<DEST>  →           (L2+)
 *     {hub, dest, Y?, C?, F?, createdAt, updatedAt}
 *
 * α is stored as a **positive magnitude** in `[0, 50]`. A value of `0`
 * means "rating doesn't respond to price on this class for this route" —
 * preserved verbatim. The model reads with `Number.isFinite`, never `||`.
 *
 * Pair key is **directional** — fares and ratings are direction-specific.
 *
 * L2 — full-replace + accountId round-trip (HANDOVER §10):
 *   - `_key` routes through `acctKey()`; reads fall back to legacy.
 *   - `saveAt(accountId, …)` is the explicit-account API for Undo.
 */
class RouteAssistantRatingAlphaStore {
    static LEGACY_PREFIX = "routeAssistant:ratingAlpha:"
    static SCOPE_PREFIX  = "routeAssistant:ratingAlpha"
    static ALPHA_LO = 0
    static ALPHA_HI = 50

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantRatingAlphaStore.SCOPE_PREFIX,
            RouteAssistantRatingAlphaStore._pairKey(hub, dest))
    }

    static _keyForAccount(accountId, hub, dest) {
        const pair = RouteAssistantRatingAlphaStore._pairKey(hub, dest)
        if (!accountId) return RouteAssistantRatingAlphaStore.LEGACY_PREFIX + pair
        return RouteAssistantRatingAlphaStore.SCOPE_PREFIX + ":acct:" + accountId + ":" + pair
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantRatingAlphaStore.LEGACY_PREFIX
            + RouteAssistantRatingAlphaStore._pairKey(hub, dest)
    }

    /** Returns `{hub, dest, Y?, C?, F?, createdAt, updatedAt}` or null. */
    static async get(hub, dest) {
        const ns = RouteAssistantRatingAlphaStore._key(hub, dest)
        const lg = RouteAssistantRatingAlphaStore._legacyKey(hub, dest)
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            return out[ns] || null
        }
        const out = await chrome.storage.local.get([ns, lg])
        if (out[ns] !== undefined) return out[ns]
        return out[lg] || null
    }

    /**
     * Bulk read for [hub, dest] pairs.
     * Returns Map<pairKey, record>.
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantRatingAlphaStore._pairKey(h, d))
            nsKeys.push(RouteAssistantRatingAlphaStore._key(h, d))
            lgKeys.push(RouteAssistantRatingAlphaStore._legacyKey(h, d))
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
     * Persist a per-class α override under the current account scope.
     * `fields` is `{Y?, C?, F?}` — pass null/undefined/"" for any class
     * to clear that class. When the cleaned record has no α set, the
     * entire row is removed. Returns the stored record (or null when
     * cleared).
     */
    static async save(hub, dest, fields) {
        return RouteAssistantRatingAlphaStore.saveAt(
            currentAccountIdSync(), hub, dest, fields
        )
    }

    static async saveAt(accountId, hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantRatingAlphaStore._clean(fields || {})
        if (!RouteAssistantRatingAlphaStore._hasAnyValue(cleaned)) {
            await RouteAssistantRatingAlphaStore.removeAt(accountId, hubU, destU)
            return null
        }

        const key = RouteAssistantRatingAlphaStore._keyForAccount(accountId, hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
        const now = Date.now()
        // Editor shows every class — fields not in cleaned were
        // intentionally cleared and must NOT carry over from existing.
        const record = Object.assign(
            {hub: hubU, dest: destU, createdAt: (existing && existing.createdAt) || now},
            cleaned,
            {hub: hubU, dest: destU, updatedAt: now}
        )
        await chrome.storage.local.set({[key]: record})
        return record
    }

    static async remove(hub, dest) {
        return RouteAssistantRatingAlphaStore.removeAt(
            currentAccountIdSync(), hub, dest
        )
    }

    static async removeAt(accountId, hub, dest) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return
        const ns = RouteAssistantRatingAlphaStore._keyForAccount(accountId, hubU, destU)
        const lg = RouteAssistantRatingAlphaStore._legacyKey(hubU, destU)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
    }

    /**
     * Coerce to positive magnitude in [0, 50]. Empty / non-finite /
     * out-of-range values are dropped (treated as "not set"). 0 is
     * preserved verbatim — it is a valid override meaning "no rating
     * shift on price for this class on this route."
     */
    static _clean(fields) {
        const out = {}
        const lo = RouteAssistantRatingAlphaStore.ALPHA_LO
        const hi = RouteAssistantRatingAlphaStore.ALPHA_HI
        for (const cls of ["Y", "C", "F"]) {
            const v = fields[cls]
            if (v === null || v === undefined || v === "") continue
            const n = Number(v)
            if (!isFinite(n)) continue
            if (n < lo || n > hi) continue
            out[cls] = n
        }
        return out
    }

    static _hasAnyValue(cleaned) {
        return Number.isFinite(cleaned.Y)
            || Number.isFinite(cleaned.C)
            || Number.isFinite(cleaned.F)
    }

    /** L2 deprecated — preserve for any reader still doing key arithmetic. */
    static get PREFIX() { return RouteAssistantRatingAlphaStore.LEGACY_PREFIX }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantRatingAlphaStore
}
