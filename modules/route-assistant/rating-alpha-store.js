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
 *   routeAssistant:ratingAlpha:<HUB>-<DEST>
 *     → {hub, dest, Y?, C?, F?, createdAt, updatedAt}
 *
 * α is stored as a **positive magnitude** in `[0, 50]`. A value of `0`
 * means "rating doesn't respond to price on this class for this route" —
 * preserved verbatim. The model reads with `Number.isFinite`, never `||`.
 *
 * Pair key is **directional** — fares and ratings are direction-specific.
 */
class RouteAssistantRatingAlphaStore {
    static PREFIX  = "routeAssistant:ratingAlpha:"
    static ALPHA_LO = 0
    static ALPHA_HI = 50

    static _legacyKey(hub, dest) {
        return RouteAssistantRatingAlphaStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantRatingAlphaStore._legacyKey(hub, dest)
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

    /** Returns `{hub, dest, Y?, C?, F?, createdAt, updatedAt}` or null. */
    static async get(hub, dest, opts) {
        const acctId = RouteAssistantRatingAlphaStore._resolveAccountId(opts)
        const scoped = RouteAssistantRatingAlphaStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRatingAlphaStore._legacyKey(hub, dest)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        return out[scoped] || out[legacy] || null
    }

    /**
     * Bulk read for [hub, dest] pairs.
     * Returns Map<pairKey, record>.
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId = RouteAssistantRatingAlphaStore._resolveAccountId(opts)
        const scopedKeys = []
        const legacyKeys = []
        const pairList   = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            scopedKeys.push(RouteAssistantRatingAlphaStore._key(h, d, acctId))
            legacyKeys.push(RouteAssistantRatingAlphaStore._legacyKey(h, d))
            pairList.push(RouteAssistantRatingAlphaStore._pairKey(h, d))
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
     * Persist a per-class α override. `fields` is `{Y?, C?, F?}` —
     * pass null/undefined/"" for any class to clear that class. When
     * the cleaned record has no α set, the entire row is removed.
     * Returns the stored record (or null when cleared).
     */
    static async save(hub, dest, fields, opts) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        const acctId = RouteAssistantRatingAlphaStore._resolveAccountId(opts)

        const cleaned = RouteAssistantRatingAlphaStore._clean(fields || {})
        if (!RouteAssistantRatingAlphaStore._hasAnyValue(cleaned)) {
            await RouteAssistantRatingAlphaStore.remove(hubU, destU, {accountId: acctId})
            return null
        }

        const key = RouteAssistantRatingAlphaStore._key(hubU, destU, acctId)
        const legacy = RouteAssistantRatingAlphaStore._legacyKey(hubU, destU)
        const reqKeys = key === legacy ? [key] : [key, legacy]
        const existingMap = await chrome.storage.local.get(reqKeys)
        const existing = existingMap[key] || existingMap[legacy] || null
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

    static async remove(hub, dest, opts) {
        const acctId = RouteAssistantRatingAlphaStore._resolveAccountId(opts)
        const key = RouteAssistantRatingAlphaStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRatingAlphaStore._legacyKey(hub, dest)
        const toRemove = key === legacy ? [key] : [key, legacy]
        await chrome.storage.local.remove(toRemove)
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
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantRatingAlphaStore
}
