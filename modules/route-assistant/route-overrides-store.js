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
 *   routeAssistant:override:<HUB>-<DEST>  →                         (legacy)
 *   routeAssistant:override:acct:<id>:<HUB>-<DEST>  →               (L2+)
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
 *
 * L2 — full-replace + accountId round-trip (HANDOVER §10):
 *   - `_key` routes through `acctKey()` so writes land in the
 *     account-namespaced slot once `window.__aesAccountId` is set.
 *   - `get` / `getMany` read the namespaced key first, then fall back
 *     to the legacy key. Migration is additive; legacy stays live as
 *     fallback through L7.
 *   - `saveAt(accountId, …)` is the explicit-account API. Callers that
 *     capture `prev` for Undo MUST also capture the accountId at write
 *     time so a mid-session account-chip switch (L4+) doesn't restore
 *     into the wrong account. `save()` is a thin wrapper that captures
 *     `currentAccountIdSync()` and delegates.
 *   - `remove` clears BOTH the namespaced AND legacy key — explicit
 *     user removes are intentionally absolute, distinct from the
 *     "additive migration never deletes legacy" invariant.
 */
class RouteAssistantRouteOverridesStore {
    static LEGACY_PREFIX = "routeAssistant:override:"
    static SCOPE_PREFIX  = "routeAssistant:override"

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantRouteOverridesStore.SCOPE_PREFIX,
            RouteAssistantRouteOverridesStore._pairKey(hub, dest))
    }

    static _keyForAccount(accountId, hub, dest) {
        const pair = RouteAssistantRouteOverridesStore._pairKey(hub, dest)
        if (!accountId) return RouteAssistantRouteOverridesStore.LEGACY_PREFIX + pair
        return RouteAssistantRouteOverridesStore.SCOPE_PREFIX + ":acct:" + accountId + ":" + pair
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantRouteOverridesStore.LEGACY_PREFIX
            + RouteAssistantRouteOverridesStore._pairKey(hub, dest)
    }

    /**
     * Returns the override record for a single (hub, dest) pair, or null.
     * Reads namespaced first; falls back to legacy when namespaced is
     * missing — covers pre-migration data and the bootstrap window.
     */
    static async get(hub, dest) {
        const ns = RouteAssistantRouteOverridesStore._key(hub, dest)
        const lg = RouteAssistantRouteOverridesStore._legacyKey(hub, dest)
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
     * Map<pairKey, override> where pairKey is "<HUB>-<DEST>".
     * Namespaced wins per pair; legacy fills gaps.
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantRouteOverridesStore._pairKey(h, d))
            nsKeys.push(RouteAssistantRouteOverridesStore._key(h, d))
            lgKeys.push(RouteAssistantRouteOverridesStore._legacyKey(h, d))
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
     * Persist an override using the current account scope. Pass
     * null/undefined for any field to clear it. Returns the stored
     * record; pass an empty fields object to clear via remove().
     *
     * Captures `currentAccountIdSync()` once and delegates to
     * `saveAt()`. Callers that need to restore an Undo capture under
     * a specific accountId should call `saveAt()` directly.
     */
    static async save(hub, dest, fields) {
        return RouteAssistantRouteOverridesStore.saveAt(
            currentAccountIdSync(), hub, dest, fields
        )
    }

    /**
     * Persist an override under the explicitly named account. Use this
     * for Undo restore where the accountId at write time may differ
     * from the current chip. Pass `null` for accountId to write to the
     * legacy key shape (pre-bootstrap or off-AS-page callers).
     */
    static async saveAt(accountId, hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantRouteOverridesStore._clean(fields || {})
        if (!RouteAssistantRouteOverridesStore._hasAnyValue(cleaned)) {
            await RouteAssistantRouteOverridesStore.removeAt(accountId, hubU, destU)
            return null
        }

        const key = RouteAssistantRouteOverridesStore._keyForAccount(accountId, hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
        const now = Date.now()
        // Editor shows every field — fields not in `cleaned` were
        // intentionally cleared and must NOT carry over from `existing`.
        // Only createdAt is preserved.
        const record = Object.assign(
            {hub: hubU, dest: destU, createdAt: (existing && existing.createdAt) || now},
            cleaned,
            {hub: hubU, dest: destU, updatedAt: now}
        )
        await chrome.storage.local.set({[key]: record})
        return record
    }

    /**
     * Remove the override under the current account scope. Clears both
     * the namespaced key AND the legacy key — explicit user removes
     * are absolute, regardless of the additive-migration invariant.
     */
    static async remove(hub, dest) {
        return RouteAssistantRouteOverridesStore.removeAt(
            currentAccountIdSync(), hub, dest
        )
    }

    static async removeAt(accountId, hub, dest) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return
        const ns = RouteAssistantRouteOverridesStore._keyForAccount(accountId, hubU, destU)
        const lg = RouteAssistantRouteOverridesStore._legacyKey(hubU, destU)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
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
        numField("pricePin",          50, 200)
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
            || cleaned.pricePin !== undefined
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

    /**
     * L2 deprecated — `PREFIX` is preserved for any reader still doing
     * key-shape arithmetic. Prefer the explicit `_key` / `_legacyKey`
     * helpers above.
     */
    static get PREFIX() { return RouteAssistantRouteOverridesStore.LEGACY_PREFIX }
}

if (typeof window !== "undefined") {
    window.RouteAssistantRouteOverridesStore = RouteAssistantRouteOverridesStore
}
