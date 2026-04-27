/**
 * Per-route override store for the Route Assistant.
 *
 * AS in-game demand 0–10 is too coarse for a specific route the user has
 * actually flown and measured. This store lets the user pin a per-route
 * load-factor / yield value that the profit estimator reads before falling
 * back to the demand-driven LF curve and configured base yield.
 *
 * Keyed directionally as <HUB>-<DEST>: outbound-different-from-inbound is
 * uncommon in AS but cheap to support, and matches the schedule extractor's
 * directional record shape.
 *
 *   routeAssistant:override:<HUB>-<DEST>  →
 *     {hub, dest, paxLF?, cargoLF?, yieldPerKm?, cargoYieldPerKgKm?,
 *      note?, expiresAt?, createdAt, updatedAt}
 *
 * Any field on the override is optional — a partial override only changes
 * the keys that are set and leaves the rest to fall through to the
 * demand-driven defaults. Removing a route's override clears the key
 * entirely.
 *
 * Q3 expiration — `expiresAt` is an optional unix-ms timestamp. When
 * present and in the past, callers should treat the override as expired
 * (skip applying its numeric fields) but keep the record in storage so
 * the user can see it expired in the editor and choose to renew or
 * clear. Records WITHOUT `expiresAt` never expire (default behaviour).
 */
class RouteAssistantRouteOverridesStore {
    static PREFIX = "routeAssistant:override:"

    // Legacy (un-scoped) key. Kept as a read-fallback so caches written
    // before Slice L2 stay readable until the user touches the route.
    static _legacyKey(hub, dest) {
        return RouteAssistantRouteOverridesStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    // Account-scoped key. Falls back to the legacy form when accountId is
    // null/empty (helper not loaded, or off-AS-page caller — preserves
    // single-account behaviour during the L1→L2 migration window).
    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantRouteOverridesStore._legacyKey(hub, dest)
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
     * Returns the override record for a single (hub, dest) pair, or null.
     * Reads the account-scoped key first, falls back to the legacy
     * (un-scoped) key when the namespaced one misses — supports caches
     * written before Slice L2 without forcing an explicit migration.
     */
    static async get(hub, dest, opts) {
        const acctId = RouteAssistantRouteOverridesStore._resolveAccountId(opts)
        const scoped = RouteAssistantRouteOverridesStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRouteOverridesStore._legacyKey(hub, dest)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        return out[scoped] || out[legacy] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs. Returns
     * Map<pairKey, override> where pairKey is "<HUB>-<DEST>".
     * Per-pair legacy fallback so pre-L2 keys still resolve.
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId = RouteAssistantRouteOverridesStore._resolveAccountId(opts)
        const PREFIX = RouteAssistantRouteOverridesStore.PREFIX
        const scopedKeys = []
        const legacyKeys = []
        const pairList   = []
        for (const [h, d] of pairs) {
            scopedKeys.push(RouteAssistantRouteOverridesStore._key(h, d, acctId))
            legacyKeys.push(RouteAssistantRouteOverridesStore._legacyKey(h, d))
            pairList.push(RouteAssistantRouteOverridesStore._pairKey(h, d))
        }
        const reqKeys = acctId
            ? scopedKeys.concat(legacyKeys)
            : scopedKeys
        const out = await chrome.storage.local.get(reqKeys)
        const map = new Map()
        for (let i = 0; i < pairList.length; i++) {
            const rec = out[scopedKeys[i]] || out[legacyKeys[i]] || null
            if (rec) map.set(pairList[i], rec)
        }
        return map
    }

    /**
     * Persist an override. Pass null/undefined for any field to clear it.
     * Returns the stored record. Pass an empty fields object to clear the
     * override entirely (delegates to remove()).
     */
    static async save(hub, dest, fields, opts) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        const acctId = RouteAssistantRouteOverridesStore._resolveAccountId(opts)

        const cleaned = RouteAssistantRouteOverridesStore._clean(fields || {})
        if (!RouteAssistantRouteOverridesStore._hasAnyValue(cleaned)) {
            await RouteAssistantRouteOverridesStore.remove(hubU, destU, {accountId: acctId})
            return null
        }

        const key = RouteAssistantRouteOverridesStore._key(hubU, destU, acctId)
        const legacy = RouteAssistantRouteOverridesStore._legacyKey(hubU, destU)
        const reqKeys = key === legacy ? [key] : [key, legacy]
        const existingMap = await chrome.storage.local.get(reqKeys)
        const existing = existingMap[key] || existingMap[legacy] || null
        const now = Date.now()
        // The editor shows every field, so save() takes the full new state:
        // fields not in `cleaned` were intentionally cleared and must NOT
        // carry over from `existing`. Only createdAt is preserved.
        const record = Object.assign(
            {hub: hubU, dest: destU, createdAt: (existing && existing.createdAt) || now},
            cleaned,
            {hub: hubU, dest: destU, updatedAt: now}
        )
        await chrome.storage.local.set({[key]: record})
        return record
    }

    static async remove(hub, dest, opts) {
        const acctId = RouteAssistantRouteOverridesStore._resolveAccountId(opts)
        const key = RouteAssistantRouteOverridesStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRouteOverridesStore._legacyKey(hub, dest)
        // Drop the legacy mirror too so a removed override doesn't
        // resurrect on the next read via the legacy fallback path.
        const toRemove = key === legacy ? [key] : [key, legacy]
        await chrome.storage.local.remove(toRemove)
    }

    /**
     * Strip non-numeric / out-of-range fields. `note` keeps its string form;
     * everything else is coerced through Number and dropped if not finite or
     * out of plausible bounds.
     */
    static _clean(fields) {
        const out = {}
        const numField = (k, lo, hi) => {
            const v = fields[k]
            if (v === null || v === undefined || v === "") return
            const n = Number(v)
            if (!isFinite(n)) return
            if (n < lo || n > hi) return
            out[k] = n
        }
        numField("paxLF",             0, 1)
        numField("cargoLF",           0, 1)
        numField("yieldPerKm",        0, 100)
        numField("cargoYieldPerKgKm", 0, 100)
        if (typeof fields.note === "string" && fields.note.trim() !== "") {
            out.note = fields.note.trim().substring(0, 200)
        }
        // Q3 — optional expiry timestamp. Must be a positive number; we
        // don't reject past values (a record with an expired-already
        // expiresAt is valid — callers will skip applying it, but the
        // record stays in storage for the user to see and clear).
        if (fields.expiresAt !== undefined && fields.expiresAt !== null && fields.expiresAt !== "") {
            const ts = Number(fields.expiresAt)
            if (isFinite(ts) && ts > 0) out.expiresAt = ts
        }
        return out
    }

    static _hasAnyValue(cleaned) {
        return cleaned.paxLF !== undefined
            || cleaned.cargoLF !== undefined
            || cleaned.yieldPerKm !== undefined
            || cleaned.cargoYieldPerKgKm !== undefined
            || cleaned.note !== undefined
            || cleaned.expiresAt !== undefined
    }

    /**
     * Q3 — true when the override has an `expiresAt` in the past.
     * Records without `expiresAt` never expire. `nowMs` defaults to
     * Date.now() but the panel passes its own `_renderRows` timestamp
     * so a single render's check is consistent across rows.
     */
    static isExpired(record, nowMs) {
        if (!record || record.expiresAt == null) return false
        const exp = Number(record.expiresAt)
        if (!isFinite(exp) || exp <= 0) return false
        const now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now()
        return exp <= now
    }

    /**
     * Q3 — days remaining until the override expires. Negative means
     * already expired (number of days in the past). Returns null when
     * the record has no `expiresAt`.
     */
    static daysUntilExpiry(record, nowMs) {
        if (!record || record.expiresAt == null) return null
        const exp = Number(record.expiresAt)
        if (!isFinite(exp) || exp <= 0) return null
        const now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now()
        return (exp - now) / 86400000
    }
}
