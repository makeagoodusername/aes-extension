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
     * @param {number} [opts.dedupWindowMin=5] — collapse identical fingerprints
     *   within this many minutes (instance default; per-call override via
     *   `add(..., {dedupWindowMs})` still wins).
     */
    constructor(opts) {
        opts = opts || {}
        this.limit          = isFinite(opts.limit)          ? Math.max(20, opts.limit)          : RouteAssistantPricingApplyLog.DEFAULT_LIMIT
        this.perRouteLimit  = isFinite(opts.perRouteLimit)  ? Math.max(5,  opts.perRouteLimit)  : RouteAssistantPricingApplyLog.PER_ROUTE_LIMIT
        this.dedupWindowMin = isFinite(opts.dedupWindowMin) ? Math.max(0,  opts.dedupWindowMin) : 5
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _routeKey(hub, dest) {
        return RouteAssistantPricingApplyLog.PER_ROUTE_PREFIX
            + RouteAssistantPricingApplyLog._pairKey(hub, dest)
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
        const dedupWindowMs = isFinite(opts.dedupWindowMs)
            ? opts.dedupWindowMs
            : (this.dedupWindowMin * 60 * 1000)
        const ts = record && record.ts ? record.ts : Date.now()
        const fingerprint = (record && record.fingerprint) || null

        const cleaned = RouteAssistantPricingApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || RouteAssistantPricingApplyLog._newId(ts)

        const routeKey = RouteAssistantPricingApplyLog._routeKey(cleaned.hub, cleaned.dest)
        const got = await chrome.storage.local.get([
            RouteAssistantPricingApplyLog.GLOBAL_KEY,
            routeKey
        ])

        // ----- Global timeline -----
        const globalRec = (got && got[RouteAssistantPricingApplyLog.GLOBAL_KEY]) || {entries: [], updatedAt: 0}
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
        const routeRec = (got && got[routeKey]) || {hub: cleaned.hub, dest: cleaned.dest, entries: [], updatedAt: 0}
        let routeEntries = Array.isArray(routeRec.entries) ? routeRec.entries.slice() : []
        // Per-route does NOT dedup — every attempt for this route is
        // worth seeing, including back-to-back identical attempts.
        routeEntries.unshift(cleaned)
        if (routeEntries.length > this.perRouteLimit) routeEntries = routeEntries.slice(0, this.perRouteLimit)

        const updatedAt = ts
        const writes = {
            [RouteAssistantPricingApplyLog.GLOBAL_KEY]: {entries, updatedAt},
            [routeKey]: {hub: cleaned.hub, dest: cleaned.dest, entries: routeEntries, updatedAt}
        }
        await chrome.storage.local.set(writes)
        return cleaned
    }

    /**
     * Update an existing entry by id (e.g., to flip a `posted` status
     * to `verified` after a delayed verify pass). No-op if the id
     * isn't found in either store.
     */
    async update(id, patch) {
        if (!id || !patch) return null
        // We don't know the route key without scanning. Walk the global
        // log first; if we find it, derive the per-route key from the
        // record's hub+dest and patch both atomically.
        const got = await chrome.storage.local.get([RouteAssistantPricingApplyLog.GLOBAL_KEY])
        const globalRec = got[RouteAssistantPricingApplyLog.GLOBAL_KEY]
        if (!globalRec || !Array.isArray(globalRec.entries)) return null
        const idx = globalRec.entries.findIndex(e => e && e.id === id)
        if (idx < 0) return null
        const merged = Object.assign({}, globalRec.entries[idx], patch)
        const newEntries = globalRec.entries.slice()
        newEntries[idx] = merged

        const routeKey = RouteAssistantPricingApplyLog._routeKey(merged.hub, merged.dest)
        const got2 = await chrome.storage.local.get([routeKey])
        const routeRec = got2[routeKey]
        let routeEntries = routeRec && Array.isArray(routeRec.entries) ? routeRec.entries.slice() : []
        const ridx = routeEntries.findIndex(e => e && e.id === id)
        if (ridx >= 0) routeEntries[ridx] = Object.assign({}, routeEntries[ridx], patch)

        const ts = Date.now()
        const writes = {
            [RouteAssistantPricingApplyLog.GLOBAL_KEY]: {entries: newEntries, updatedAt: ts}
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
    async getRecent(n) {
        const got = await chrome.storage.local.get([RouteAssistantPricingApplyLog.GLOBAL_KEY])
        const rec = got[RouteAssistantPricingApplyLog.GLOBAL_KEY] || {entries: [], updatedAt: 0}
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
    async getForRoute(hub, dest, n) {
        const routeKey = RouteAssistantPricingApplyLog._routeKey(hub, dest)
        const got = await chrome.storage.local.get([routeKey])
        const rec = got[routeKey] || {hub: String(hub || "").toUpperCase(), dest: String(dest || "").toUpperCase(), entries: [], updatedAt: 0}
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
    async getLastSuccessAt(hub, dest) {
        const r = await this.getForRoute(hub, dest)
        for (const e of r.entries) {
            if (!e) continue
            if (e.status === "verified" || e.status === "posted") return e.ts || null
        }
        return null
    }

    /**
     * Tier 3.2 — global "any successful apply across all routes" timestamp.
     * Drives the cross-route cooldown so a rapid-fire chain of writes
     * (script loop, accidental key-repeat) gets throttled even when no
     * single route has fired twice. Walks the global timeline once;
     * dry-run + failed entries skipped — same rule as the per-route
     * variant. Returns null when no successful write has ever landed.
     */
    async getLastSuccessGlobal() {
        const r = await this.getRecent()
        for (const e of r.entries) {
            if (!e) continue
            if (e.status === "verified" || e.status === "posted") return e.ts || null
        }
        return null
    }

    /**
     * Count silent-auto applies (verified | posted) in arbitrary windows
     * over the global timeline. `windows` is `{name: sinceMs}` — each
     * window's count is returned under the same name. One walk per call
     * so the daily + hourly cap reconciliation is a single storage
     * round-trip + one linear pass.
     *
     * Failed + dry-run + aborted entries are excluded — the cap is on
     * REAL writes that landed, mirroring the per-route cooldown gate.
     *
     * Dedup'd entries (collapsed by `add()`'s 5-min fingerprint window)
     * count toward their merged `count` so each distinct POST shows up.
     */
    async countSilentAutoIn(windows) {
        const w = windows || {}
        const counts = {}
        for (const k in w) counts[k] = 0
        const r = await this.getRecent()
        for (const e of r.entries) {
            if (!e) continue
            if (e.source !== "silent-auto") continue
            if (e.status !== "verified" && e.status !== "posted") continue
            if (!isFinite(e.ts)) continue
            const inc = isFinite(e.count) ? Math.max(1, e.count) : 1
            for (const k in w) {
                if (e.ts >= w[k]) counts[k] += inc
            }
        }
        return counts
    }

    /**
     * Single-window convenience kept for callers that only need one
     * count. Implemented as a thin wrapper over `countSilentAutoIn` so
     * the underlying scan stays in one place.
     */
    async countSilentAutoSince(sinceTs) {
        const since = isFinite(sinceTs) ? sinceTs : (Date.now() - 24 * 3600 * 1000)
        const c = await this.countSilentAutoIn({n: since})
        return c.n
    }

    /**
     * Bulk-load the last-success timestamps for many routes. Drives the
     * "is cooldown active?" preflight in a single combined fetch when
     * the bulk apply modal is opening across N rows.
     */
    async getLastSuccessMap(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const keys = pairs.map(p => {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            return RouteAssistantPricingApplyLog._routeKey(h, d)
        })
        const got = await chrome.storage.local.get(keys)
        const out = new Map()
        for (const k in got) {
            const rec = got[k]
            if (!rec || !Array.isArray(rec.entries)) continue
            const pair = k.substring(RouteAssistantPricingApplyLog.PER_ROUTE_PREFIX.length)
            for (const e of rec.entries) {
                if (e && (e.status === "verified" || e.status === "posted")) {
                    out.set(pair, e.ts || null)
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
    async prune(newLimit) {
        const lim = isFinite(newLimit) ? Math.max(20, newLimit) : this.limit
        const rec = await this.getRecent()
        if (!rec.entries.length || rec.entries.length <= lim) return rec
        const sliced = rec.entries.slice(0, lim)
        await chrome.storage.local.set({
            [RouteAssistantPricingApplyLog.GLOBAL_KEY]: {entries: sliced, updatedAt: Date.now()}
        })
        return {entries: sliced, updatedAt: Date.now()}
    }

    /**
     * Remove the entire log (both stores for every touched route).
     * Returns the number of route-keys cleared. Manual-reset CTA in
     * the settings drawer.
     */
    async clear() {
        const all = await chrome.storage.local.get(null)
        const keys = [RouteAssistantPricingApplyLog.GLOBAL_KEY]
        for (const k in all) {
            if (k.startsWith(RouteAssistantPricingApplyLog.PER_ROUTE_PREFIX)) keys.push(k)
        }
        if (keys.length) await chrome.storage.local.remove(keys)
        return keys.length
    }

    // ------------------------------------------------------------------
    // Tier 3.4 helpers — observability primitives.
    //   - getEntryById  : single-entry lookup for the audit modal +
    //                     undo flow
    //   - markUndone    : flag an entry as superseded by an undo apply;
    //                     cosmetic only (the actual price restore is a
    //                     fresh apply by the caller)
    //   - getLastEntry  : most-recent per-route ring entry (any status)
    //                     for the route-row badge; passive query, no
    //                     filtering — caller decides what to render
    //   - getBatch      : pull every entry sharing a `batchId` for the
    //                     bulk-apply group view in the audit modal
    // ------------------------------------------------------------------

    /**
     * Lookup a single entry by id. Walks the global timeline first (the
     * larger store), then per-route rings as a fallback for entries that
     * have aged out of the global cap. Returns null when not found.
     */
    async getEntryById(id) {
        if (!id) return null
        const got = await chrome.storage.local.get([RouteAssistantPricingApplyLog.GLOBAL_KEY])
        const globalRec = got[RouteAssistantPricingApplyLog.GLOBAL_KEY]
        if (globalRec && Array.isArray(globalRec.entries)) {
            const hit = globalRec.entries.find(e => e && e.id === id)
            if (hit) return hit
        }
        // Fallback: scan per-route rings. Only triggers when an entry has
        // aged out of the 200-cap global log; the typical audit-modal flow
        // hits the global log path above.
        const all = await chrome.storage.local.get(null)
        for (const k in all) {
            if (!k.startsWith(RouteAssistantPricingApplyLog.PER_ROUTE_PREFIX)) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.entries)) continue
            const hit = rec.entries.find(e => e && e.id === id)
            if (hit) return hit
        }
        return null
    }

    /**
     * Flag the entry as undone — cosmetic mark surfaced in the audit
     * modal (struck through, "↺ Undone" badge). The actual price restore
     * is a separate fresh apply by the caller; this is the bookkeeping.
     */
    async markUndone(id) {
        return await this.update(id, {undone: true, undoneAt: Date.now()})
    }

    /**
     * Return the most-recent entry for a route (any status) — drives the
     * inline route-row status badge. No filtering by status; the caller
     * decides how to render `status`, `dryRun`, `undone`, etc.
     */
    async getLastEntry(hub, dest) {
        const r = await this.getForRoute(hub, dest, 1)
        return (r.entries && r.entries[0]) || null
    }

    /**
     * Pull every entry sharing a `batchId`, newest-first. Used by the
     * audit modal's bulk-group expander. Walks the global timeline only
     * — bulk applies are recent by design and the global log holds the
     * full batch (cap 200, per-route ring is too small to span batches).
     */
    async getBatch(batchId) {
        if (!batchId) return []
        const got = await chrome.storage.local.get([RouteAssistantPricingApplyLog.GLOBAL_KEY])
        const globalRec = got[RouteAssistantPricingApplyLog.GLOBAL_KEY]
        if (!globalRec || !Array.isArray(globalRec.entries)) return []
        return globalRec.entries.filter(e => e && e.batchId === batchId)
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
            preApplySync:     RouteAssistantPricingApplyLog._cleanPreApplySync(r.preApplySync),
            preflight:        RouteAssistantPricingApplyLog._cleanPreflight(r.preflight),
            error:            r.error ? Object.assign({}, r.error) : null,
            warning:          r.warning ? String(r.warning).slice(0, 240) : null,
            bodyPreview:      r.bodyPreview ? String(r.bodyPreview).slice(0, 1500) : null,
            dryRun:           !!r.dryRun,
            count:            isFinite(r.count) ? r.count : 1,
            // Tier 3.4 — observability fields. All optional; legacy entries
            // without these read as `undefined` and the UI treats them as
            // ungrouped/non-undone.
            batchId:          r.batchId  ? String(r.batchId).slice(0, 64) : null,
            batchSize:        isFinite(r.batchSize) ? r.batchSize : null,
            undoOf:           r.undoOf   ? String(r.undoOf).slice(0, 64)  : null,
            undone:           r.undone === true ? true : null,
            undoneAt:         isFinite(r.undoneAt) ? r.undoneAt : null,
            proposerStrategy: r.proposerStrategy ? String(r.proposerStrategy).slice(0, 64) : null,
            rationale:        Array.isArray(r.rationale)
                                ? r.rationale.slice(0, 12).map(s => String(s).slice(0, 240))
                                : null,
            objective:        r.objective ? Object.assign({}, r.objective) : null,
            // Endpoint targeting — present only when this apply went via
            // `/app/com/numbers/<flightNumberId>/<legIndex>`. The audit
            // modal shows "via FN <id>/<leg>" when these are non-null.
            // The legacy markets-page apply omits all three; downstream
            // readers MUST treat absence as "markets" for backward compat.
            endpoint:         r.endpoint === "flightNumbers" ? "flightNumbers" : null,
            flightNumberId:   r.endpoint === "flightNumbers" && r.flightNumberId != null
                                ? String(r.flightNumberId).slice(0, 32)
                                : null,
            legIndex:         r.endpoint === "flightNumbers" && isFinite(r.legIndex)
                                ? r.legIndex
                                : null
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

    /**
     * Records the orchestrator pre-flight pass that ran before this apply.
     * `scheduleAt` / `orsAt` are scrape timestamps from the orchestrator's
     * per-route result (`schedule.scrapedAt` / `ors.scrapedAt`); either
     * may be null if that scraper failed or was skipped by the freshness
     * gate. `halted: true` marks routes that were skipped because the
     * orchestrator's circuit breaker tripped before reaching them — those
     * apply-log entries land with `status: "skipped"` and no POST.
     */
    static _cleanPreApplySync(s) {
        if (!s) return null
        const out = {
            scheduleAt: isFinite(s.scheduleAt) ? s.scheduleAt : null,
            orsAt:      isFinite(s.orsAt)      ? s.orsAt      : null,
            halted:     !!s.halted
        }
        if (out.scheduleAt == null && out.orsAt == null && !out.halted) return null
        return out
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantPricingApplyLog = RouteAssistantPricingApplyLog
}
