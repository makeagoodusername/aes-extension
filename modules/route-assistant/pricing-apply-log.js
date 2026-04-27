"use strict"

/**
 * Auto-Pricing Tier 3 — apply-log store.
 *
 * Persists every apply attempt (dry-run, verified, posted-but-unverified,
 * failed, aborted) to two stores:
 *
 *   1. Global timeline   `routeAssistant:pricingApplyLog`
 *      → {entries: [...], updatedAt}
 *      Capped at `limit` (default 200) — newest first; oldest pop off the
 *      tail. Single key drives the panel's "Recent applies" list under
 *      the Auto-Pricing expander.
 *
 *   2. Per-route ring   `routeAssistant:pricingApplyLog:<HUB>-<DEST>`
 *      → {hub, dest, entries: [...], updatedAt}
 *      Capped at 20 entries per route. The override editor + sandbox
 *      card use this as the audit trail for one route without scanning
 *      the full timeline. Per-route cooldown enforcement reads from here.
 *
 * Why both: the global timeline lets the user see "what changed across
 * the network this week"; the per-route ring lets us answer "have I
 * touched this route recently?" without unbounded scans. Each apply
 * writes both stores in a single chrome.storage.local.set.
 *
 * Pruning is mostly handled by the cap on add() but a top-up `prune()`
 * exists for migrating older blobs that lived under a different cap.
 *
 * Tier 3.1 ships this with full read/write — even dry-run entries land
 * here so the user can review what would have happened. Tier 3.2 just
 * starts producing `verified` / `posted` / `failed` entries instead of
 * `dry-run`.
 */
class RouteAssistantPricingApplyLog {
    static GLOBAL_KEY        = "routeAssistant:pricingApplyLog"
    static PER_ROUTE_PREFIX  = "routeAssistant:pricingApplyLog:"
    static PER_ROUTE_LIMIT   = 20
    static DEFAULT_LIMIT     = 200

    /**
     * @param {object} [opts]
     * @param {number} [opts.limit=200]   — global timeline cap
     * @param {number} [opts.perRouteLimit=20]
     * @param {string} [opts.accountId]   — sticky account scope for this instance
     */
    constructor(opts) {
        opts = opts || {}
        this.limit         = isFinite(opts.limit)         ? Math.max(20, opts.limit)         : RouteAssistantPricingApplyLog.DEFAULT_LIMIT
        this.perRouteLimit = isFinite(opts.perRouteLimit) ? Math.max(5,  opts.perRouteLimit) : RouteAssistantPricingApplyLog.PER_ROUTE_LIMIT
        this._accountId    = (typeof opts.accountId === "string" && opts.accountId) || null
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _legacyRouteKey(hub, dest) {
        return RouteAssistantPricingApplyLog.PER_ROUTE_PREFIX
            + RouteAssistantPricingApplyLog._pairKey(hub, dest)
    }

    static _routeKey(hub, dest, accountId) {
        const legacy = RouteAssistantPricingApplyLog._legacyRouteKey(hub, dest)
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(legacy, accountId)
        }
        return legacy
    }

    static _legacyGlobalKey() {
        return RouteAssistantPricingApplyLog.GLOBAL_KEY
    }

    static _globalKey(accountId) {
        const legacy = RouteAssistantPricingApplyLog.GLOBAL_KEY
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(legacy, accountId)
        }
        return legacy
    }

    _resolveAccountId(opts) {
        if (opts && typeof opts.accountId === "string" && opts.accountId) return opts.accountId
        if (this._accountId) return this._accountId
        if (typeof globalThis !== "undefined"
            && globalThis.AesAccountScopedKey
            && typeof globalThis.AesAccountScopedKey.currentAccountIdSync === "function") {
            return globalThis.AesAccountScopedKey.currentAccountIdSync()
        }
        return null
    }

    static _newId(ts) {
        // Compact, sortable, collision-safe id. ts in base36 + 4 random base36 chars.
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    /**
     * Persist one apply record. Slim duplication-guard: if the most
     * recent global entry has the same fingerprint AND was within
     * `dedupWindowMs` (default 5 min) AND the same status, we update
     * the existing entry's `count` instead of adding a new one. This
     * stops a misclick on "Apply" from polluting the audit trail with
     * back-to-back identical entries while still keeping the user-
     * facing log truthful (the timestamp shows the latest fire).
     *
     * Returns the saved record (with its assigned `id`).
     */
    async add(record, opts) {
        opts = opts || {}
        const acctId = this._resolveAccountId(opts)
        const dedupWindowMs = isFinite(opts.dedupWindowMs) ? opts.dedupWindowMs : 5 * 60 * 1000
        const ts = record && record.ts ? record.ts : Date.now()
        const fingerprint = (record && record.fingerprint) || null

        const cleaned = RouteAssistantPricingApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || RouteAssistantPricingApplyLog._newId(ts)

        const globalKey   = RouteAssistantPricingApplyLog._globalKey(acctId)
        const legacyGlobal = RouteAssistantPricingApplyLog._legacyGlobalKey()
        const routeKey    = RouteAssistantPricingApplyLog._routeKey(cleaned.hub, cleaned.dest, acctId)
        const legacyRoute = RouteAssistantPricingApplyLog._legacyRouteKey(cleaned.hub, cleaned.dest)
        const reqKeys = [globalKey, routeKey]
        if (acctId && globalKey !== legacyGlobal) reqKeys.push(legacyGlobal)
        if (acctId && routeKey  !== legacyRoute)  reqKeys.push(legacyRoute)
        const got = await chrome.storage.local.get(reqKeys)

        // ----- Global timeline -----
        const globalRec = got[globalKey] || got[legacyGlobal] || {entries: [], updatedAt: 0}
        let entries = Array.isArray(globalRec.entries) ? globalRec.entries.slice() : []

        let merged = false
        if (fingerprint && entries.length) {
            const head = entries[0]
            if (head
                && head.fingerprint === fingerprint
                && head.status === cleaned.status
                && (ts - head.ts) < dedupWindowMs) {
                head.ts    = ts
                head.count = (head.count || 1) + 1
                cleaned.id = head.id      // reflect the original id back to caller
                merged = true
            }
        }
        if (!merged) entries.unshift(cleaned)
        if (entries.length > this.limit) entries = entries.slice(0, this.limit)

        // ----- Per-route ring -----
        const routeRec = got[routeKey] || got[legacyRoute] || {hub: cleaned.hub, dest: cleaned.dest, entries: [], updatedAt: 0}
        let routeEntries = Array.isArray(routeRec.entries) ? routeRec.entries.slice() : []
        // Per-route does NOT dedup — every attempt for this route is
        // worth seeing, including back-to-back identical attempts.
        routeEntries.unshift(cleaned)
        if (routeEntries.length > this.perRouteLimit) routeEntries = routeEntries.slice(0, this.perRouteLimit)

        const updatedAt = ts
        const writes = {
            [globalKey]: {entries, updatedAt},
            [routeKey]:  {hub: cleaned.hub, dest: cleaned.dest, entries: routeEntries, updatedAt}
        }
        await chrome.storage.local.set(writes)
        return cleaned
    }

    /**
     * Update an existing entry by id (e.g., to flip a `posted` status
     * to `verified` after a delayed verify pass). No-op if the id
     * isn't found in either store.
     */
    async update(id, patch, opts) {
        if (!id || !patch) return null
        const acctId = this._resolveAccountId(opts)
        // We don't know the route key without scanning. Walk the global
        // log first; if we find it, derive the per-route key from the
        // record's hub+dest and patch both atomically.
        const globalKey   = RouteAssistantPricingApplyLog._globalKey(acctId)
        const legacyGlobal = RouteAssistantPricingApplyLog._legacyGlobalKey()
        const reqKeys = globalKey === legacyGlobal ? [globalKey] : [globalKey, legacyGlobal]
        const got = await chrome.storage.local.get(reqKeys)
        const globalRec = got[globalKey] || got[legacyGlobal] || null
        if (!globalRec || !Array.isArray(globalRec.entries)) return null
        const idx = globalRec.entries.findIndex(e => e && e.id === id)
        if (idx < 0) return null
        const merged = Object.assign({}, globalRec.entries[idx], patch)
        const newEntries = globalRec.entries.slice()
        newEntries[idx] = merged

        const routeKey    = RouteAssistantPricingApplyLog._routeKey(merged.hub, merged.dest, acctId)
        const legacyRoute = RouteAssistantPricingApplyLog._legacyRouteKey(merged.hub, merged.dest)
        const routeReqKeys = routeKey === legacyRoute ? [routeKey] : [routeKey, legacyRoute]
        const got2 = await chrome.storage.local.get(routeReqKeys)
        const routeRec = got2[routeKey] || got2[legacyRoute] || null
        let routeEntries = routeRec && Array.isArray(routeRec.entries) ? routeRec.entries.slice() : []
        const ridx = routeEntries.findIndex(e => e && e.id === id)
        if (ridx >= 0) routeEntries[ridx] = Object.assign({}, routeEntries[ridx], patch)

        const ts = Date.now()
        const writes = {
            [globalKey]: {entries: newEntries, updatedAt: ts}
        }
        if (ridx >= 0) {
            writes[routeKey] = {hub: merged.hub, dest: merged.dest, entries: routeEntries, updatedAt: ts}
        }
        await chrome.storage.local.set(writes)
        return merged
    }

    /**
     * Read the global timeline. Returns the raw record or a
     * synthesised-empty one. Pass `n` to slice off the head.
     */
    async getRecent(n, opts) {
        const acctId = this._resolveAccountId(opts)
        const globalKey   = RouteAssistantPricingApplyLog._globalKey(acctId)
        const legacyGlobal = RouteAssistantPricingApplyLog._legacyGlobalKey()
        const reqKeys = globalKey === legacyGlobal ? [globalKey] : [globalKey, legacyGlobal]
        const got = await chrome.storage.local.get(reqKeys)
        const rec = got[globalKey] || got[legacyGlobal] || {entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return {
            entries:   isFinite(n) && n > 0 ? entries.slice(0, n) : entries,
            updatedAt: rec.updatedAt || 0
        }
    }

    /**
     * Read the per-route ring for one (hub, dest). Always returns a record
     * shape; entries empty when the route has never been touched.
     */
    async getForRoute(hub, dest, n, opts) {
        const acctId = this._resolveAccountId(opts)
        const routeKey    = RouteAssistantPricingApplyLog._routeKey(hub, dest, acctId)
        const legacyRoute = RouteAssistantPricingApplyLog._legacyRouteKey(hub, dest)
        const reqKeys = routeKey === legacyRoute ? [routeKey] : [routeKey, legacyRoute]
        const got = await chrome.storage.local.get(reqKeys)
        const rec = got[routeKey] || got[legacyRoute]
            || {hub: String(hub || "").toUpperCase(), dest: String(dest || "").toUpperCase(), entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return Object.assign({}, rec, {
            entries: isFinite(n) && n > 0 ? entries.slice(0, n) : entries
        })
    }

    /**
     * Convenience for cooldown enforcement — returns the timestamp of
     * the most recent terminal-success entry on this route (verified
     * OR posted), or null. Dry-run + failed entries are excluded so
     * the cooldown only fires off real writes.
     */
    async getLastSuccessAt(hub, dest, opts) {
        const r = await this.getForRoute(hub, dest, null, opts)
        for (const e of r.entries) {
            if (!e) continue
            if (e.status === "verified" || e.status === "posted") return e.ts || null
        }
        return null
    }

    /**
     * Bulk-load the last-success timestamps for many routes. Drives the
     * "is cooldown active?" preflight in a single combined fetch when
     * the bulk apply modal is opening across N rows. Account-scoped
     * with legacy-key fallback.
     */
    async getLastSuccessMap(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId = this._resolveAccountId(opts)
        const pairList   = []
        const scopedKeys = []
        const legacyKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairList.push(RouteAssistantPricingApplyLog._pairKey(h, d))
            scopedKeys.push(RouteAssistantPricingApplyLog._routeKey(h, d, acctId))
            legacyKeys.push(RouteAssistantPricingApplyLog._legacyRouteKey(h, d))
        }
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const got = await chrome.storage.local.get(reqKeys)
        const out = new Map()
        for (let i = 0; i < pairList.length; i++) {
            const rec = got[scopedKeys[i]] || got[legacyKeys[i]] || null
            if (!rec || !Array.isArray(rec.entries)) continue
            for (const e of rec.entries) {
                if (e && (e.status === "verified" || e.status === "posted")) {
                    out.set(pairList[i], e.ts || null)
                    break
                }
            }
        }
        return out
    }

    /**
     * Hard prune (used when the user lowers `limit` mid-session). Walks
     * the global timeline and slices to the new cap. Per-route rings are
     * left alone; their cap is constant.
     */
    async prune(newLimit, opts) {
        const acctId = this._resolveAccountId(opts)
        const lim = isFinite(newLimit) ? Math.max(20, newLimit) : this.limit
        const rec = await this.getRecent(null, {accountId: acctId})
        if (!rec.entries.length || rec.entries.length <= lim) return rec
        const sliced = rec.entries.slice(0, lim)
        const globalKey = RouteAssistantPricingApplyLog._globalKey(acctId)
        await chrome.storage.local.set({
            [globalKey]: {entries: sliced, updatedAt: Date.now()}
        })
        return {entries: sliced, updatedAt: Date.now()}
    }

    /**
     * Remove the entire log (both stores for every touched route).
     * Returns the number of route-keys cleared. Manual-reset CTA in
     * the settings drawer. Account-aware: with `opts.accountId` (or the
     * current session account) only that account's keys are dropped.
     * Without an accountId scope, drops both legacy and scoped variants
     * (the unconditional clear path).
     */
    async clear(opts) {
        const acctId = this._resolveAccountId(opts)
        const all = await chrome.storage.local.get(null)
        const keys = []
        const PREFIX = RouteAssistantPricingApplyLog.PER_ROUTE_PREFIX
        const GLOBAL = RouteAssistantPricingApplyLog.GLOBAL_KEY
        const acctMarker = acctId ? "acct:" + acctId + ":" : null
        for (const k in all) {
            const isGlobal = k === GLOBAL || (k.startsWith(GLOBAL) && k.indexOf(":acct:") >= 0 && !k.startsWith(PREFIX))
            const isRoute  = k.startsWith(PREFIX)
            if (!isGlobal && !isRoute) continue
            if (acctMarker) {
                if (k.indexOf(acctMarker) < 0 && k !== GLOBAL && !k.startsWith(PREFIX + acctMarker)) {
                    // not this account's key, skip
                    if (k.indexOf(":acct:") >= 0) continue
                    // legacy keys (no acct: marker) belong to no specific
                    // account; we leave them in place so other accounts'
                    // historic data still falls back to them
                    continue
                }
            }
            keys.push(k)
        }
        if (keys.length) await chrome.storage.local.remove(keys)
        return keys.length
    }

    /**
     * Strip stuff we don't want stored — function references, oversized
     * `bodyPreview` strings, anything that wouldn't deserialise. Keeps
     * the log shape stable across versions.
     */
    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:               r.id || null,
            ts:               r.ts || Date.now(),
            hub:              String(r.hub || "").toUpperCase(),
            dest:             String(r.dest || "").toUpperCase(),
            status:           r.status || "unknown",
            source:           r.source || "manual",
            scope:            r.scope ? Object.assign({}, r.scope) : null,
            submitButton:     r.submitButton || null,
            prevPrices:       r.prevPrices ? Object.assign({}, r.prevPrices) : null,
            newPrices:        r.newPrices  ? Object.assign({}, r.newPrices)  : null,
            requestedPrices:  r.requestedPrices ? Object.assign({}, r.requestedPrices) : null,
            verifiedPrices:   r.verifiedPrices  ? Object.assign({}, r.verifiedPrices)  : null,
            verifyAt:         r.verifyAt || null,
            httpStatus:       r.httpStatus || null,
            fingerprint:      r.fingerprint || null,
            reason:           r.reason ? String(r.reason).slice(0, 240) : null,
            sandboxScenario:  r.sandboxScenario ? Object.assign({}, r.sandboxScenario) : null,
            projectedDelta:   r.projectedDelta  ? Object.assign({}, r.projectedDelta)  : null,
            preflight:        RouteAssistantPricingApplyLog._cleanPreflight(r.preflight),
            error:            r.error ? Object.assign({}, r.error) : null,
            warning:          r.warning ? String(r.warning).slice(0, 240) : null,
            bodyPreview:      r.bodyPreview ? String(r.bodyPreview).slice(0, 1500) : null,
            dryRun:           !!r.dryRun,
            count:            isFinite(r.count) ? r.count : 1
        }
        // Drop nulls to keep storage small.
        for (const k in out) {
            if (out[k] == null) delete out[k]
        }
        return out
    }

    static _cleanPreflight(pf) {
        if (!pf) return null
        return {
            blockers:      Array.isArray(pf.blockers)      ? pf.blockers.slice(0, 10).map(b => Object.assign({}, b)) : [],
            warnings:      Array.isArray(pf.warnings)      ? pf.warnings.slice(0, 10).map(w => Object.assign({}, w)) : [],
            deltas:        pf.deltas        ? Object.assign({}, pf.deltas)        : {},
            percentDeltas: pf.percentDeltas ? Object.assign({}, pf.percentDeltas) : {}
        }
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantPricingApplyLog = RouteAssistantPricingApplyLog
}
