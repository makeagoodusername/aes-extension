"use strict"

/**
 * AES Strategy — apply pipeline (Slice 4 — first writing PR).
 *
 * Marshals an applied `FleetPlan` (or a user-sliced subset) through every
 * existing actuator. Strategy never POSTs directly; this module is the
 * single entry point that calls existing appliers in a fixed order:
 *
 *      schedules → service moves → price moves → crew moves
 *      → route creations → alliance / IL → slot bids
 *
 * Tier gate is the first short-circuit. `tier === "preview-only"` blocks
 * every actuator regardless of per-domain enable flags. After tier
 * clears, each domain's `*Enabled` flag (`scheduleApplyEnabled`,
 * `serviceMovesEnabled`, …) gates its sub-pipeline independently. A
 * decision whose domain is gated off is logged in the audit envelope as
 * `skipped: "domain-gate"` so the user can see why nothing happened.
 *
 * Apply atomicity: any *fatal* failure inside the schedule sub-pipeline
 * (which is the most disruptive) aborts the rest of the plan. Service /
 * price / crew sub-pipelines are independent — failure on one does NOT
 * abort the next, but does record the error to audit. The user re-applies
 * a fresh plan to retry.
 *
 * Storage:
 *   aesStrategy:audit         ← ring buffer of every applied decision
 *                                bundle (cap 500). Same shape Slice 5
 *                                will read for outcome attribution.
 *   aesStrategy:plan:applied  ← most recent applied plan envelope
 *                                {planId, ts, server, airlineCode,
 *                                 plan, applyReport}.
 *
 * Public API (window.AesStrategy):
 *   AesStrategy.apply(plan, opts?) → Promise<ApplyReport>
 *
 * opts shape:
 *   {
 *     selected?: Set<string> | string[],   // decision-ids to apply
 *                                           //   (omit → apply every applicable
 *                                           //    decision in the plan)
 *     diff?:    {decisions: Array},        // reviewed decision set from
 *                                           //   the strategy panel
 *     ctx?:     {server, airlineCode},     // override snapshot context
 *     source?:  string,                    // audit tag — default "strategy"
 *     onProgress?: fn(event)               // {kind, decisionId, …}
 *   }
 *
 * ApplyReport shape:
 *   {
 *     planId, ts, source, tier,
 *     applied:  [{decisionId, domain, ok, result, error?}],
 *     skipped:  [{decisionId, domain, reason: "tier-gate"
 *                                          | "domain-gate"
 *                                          | "advisory"
 *                                          | "actuator-missing"
 *                                          | "deselected"}],
 *     totals:   {ok, failed, skipped},
 *     aborted:  bool,
 *     abortReason?: string,
 *     audit:    string                     // audit-log id
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})

    // Tiny shared bus on the AesStrategy namespace. ~12 emit sites across
    // canopy stores, layered family/division/fleet, fleet-optimizer-settings,
    // rebalance-applier, and strategy-briefing-tile guard on
    // `window.AesStrategy && window.AesStrategy.bus` and silently no-op
    // when the bus is missing. Nothing was instantiating it. Mirror the
    // shape from `aircraft-flight-plan/host.js` and `journal-store.js`.
    if (!ns.bus) {
        const _handlers = new Map()
        ns.bus = {
            on(name, h) {
                if (typeof h !== "function") return
                let set = _handlers.get(name)
                if (!set) { set = new Set(); _handlers.set(name, set) }
                set.add(h)
            },
            off(name, h) {
                const set = _handlers.get(name)
                if (set) set.delete(h)
            },
            emit(name, payload) {
                const set = _handlers.get(name)
                if (!set) return
                for (const h of Array.from(set)) {
                    try { h(payload) }
                    catch (e) { console.warn("[AesStrategy.bus] handler threw for '" + name + "'", e) }
                }
            }
        }
    }

    if (typeof ns.apply === "function") return

    const AUDIT_KEY     = "aesStrategy:audit"
    const APPLIED_KEY   = "aesStrategy:plan:applied"
    const AUDIT_RING    = 500

    /**
     * Per-account scoping (Slice 11). When a (server, airlineCode) pair
     * resolves to an accountId via AesAccountRegistry, the apply state
     * lives at `<base>:acct:<accountId>` in addition to the legacy
     * unscoped key. Mirroring keeps existing callers (older tile build,
     * the ?aes-debug audit dump) reading without breakage during rollout
     * — but the SCOPED copy is the new source of truth, and per-airline
     * readers (portfolio table, last-apply badge per sister) only read
     * the scoped key.
     *
     * The legacy keys still get written so a fresh install reading the
     * unscoped key sees the most recent apply across all accounts (the
     * old behaviour). Once the dust settles we can drop the legacy mirror.
     */
    function _scopedKey(base, accountId) {
        if (!accountId) return null
        return base + ":acct:" + accountId
    }

    async function _accountIdFor(server, airlineCode) {
        if (!server || !airlineCode) return null
        if (!window.AesAccountRegistry || typeof window.AesAccountRegistry.computeId !== "function") return null
        try { return await window.AesAccountRegistry.computeId(server, airlineCode) }
        catch (_) { return null }
    }

    function _settings() { return window.AesStrategySettings }
    function _diff()     { return ns.diffPlan }
    function _now()      { return Date.now() }

    async function _routeAssistantPricingApplyConfig() {
        const safe = {enabled: false, dryRunOnly: true}
        const loader = window.RouteAssistantSettings
        if (!loader || typeof loader.load !== "function") return safe
        try {
            const settings = await loader.load()
            const apply = settings && settings.pricing && settings.pricing.apply
            if (!apply || typeof apply !== "object") return safe
            return {
                enabled:    apply.enabled === true,
                dryRunOnly: apply.dryRunOnly !== false
            }
        } catch (_) {
            return safe
        }
    }

    function _selectedSet(opts) {
        const sel = opts && opts.selected
        if (!sel) return null
        if (sel instanceof Set) return sel
        if (Array.isArray(sel)) return new Set(sel)
        return null
    }

    function _emit(opts, event) {
        if (opts && typeof opts.onProgress === "function") {
            try { opts.onProgress(event) } catch (e) { console.warn("[AES strategy/apply] onProgress threw", e) }
        }
    }

    /**
     * Public bus emit so other modules (RA panel apply-badge cache,
     * strategy-tile, diagnostics-tile) can react to strategy-driven
     * applies without polling storage. Defensive: if CentralHubBus isn't
     * loaded on this page, skip silently — the apply path must never
     * break on a missing listener channel.
     */
    function _busEmit(domain, info) {
        try {
            if (typeof window === "undefined") return
            if (typeof window.CentralHubBus === "undefined") return
            if (!window.CentralHubBus || typeof window.CentralHubBus.emit !== "function") return
            window.CentralHubBus.emit("strategy:decision-applied", {
                decisionId: info && info.decisionId,
                domain:     domain,
                hub:        (info && info.hub)  || null,
                dest:       (info && info.dest) || null,
                ok:         !!(info && info.ok),
                source:     "strategy"
            })
        } catch (_) { /* bus emit must never break apply path */ }
    }

    /**
     * Fire-and-forget diagnostics write. When the AesPriceDiagnostics
     * store isn't loaded on the current page (e.g. apply triggered from
     * a non-RA host), the call is a no-op. Never awaited from the apply
     * loop — diagnostics must never delay or break the applier path.
     */
    function _recordPriceDiagnostic(kind, info) {
        try {
            if (typeof window === "undefined" || !window.AesPriceDiagnostics) return
            const d = window.AesPriceDiagnostics
            if (kind === "skip"     && typeof d.recordSkip     === "function") d.recordSkip(info)
            else if (kind === "proposed" && typeof d.recordProposal === "function") d.recordProposal(info)
            else if (kind === "apply"    && typeof d.recordApply    === "function") d.recordApply(info)
        } catch (_) { /* diagnostics writes must never break apply path */ }
    }

    async function _persistAudit(entry, accountId) {
        try {
            const scopedKey = _scopedKey(AUDIT_KEY, accountId)
            // Read whichever ring this account already owns; if scoped is
            // empty (first apply for a new airline) we DON'T inherit the
            // legacy ring — its entries belong to whoever last applied
            // before scoping went live.
            const readKey = scopedKey || AUDIT_KEY
            const cur = await chrome.storage.local.get([readKey])
            const ring = Array.isArray(cur[readKey]) ? cur[readKey].slice() : []
            ring.unshift(entry)
            if (ring.length > AUDIT_RING) ring.length = AUDIT_RING
            // F-9227-008: when scoping is active the scoped key is the source
            // of truth — DON'T trample the legacy AUDIT_KEY with this
            // account's ring (every cross-account apply would clobber it).
            // Legacy installs without an accountId still write AUDIT_KEY.
            const writes = scopedKey
                ? {[scopedKey]: ring}
                : {[AUDIT_KEY]: ring}
            await chrome.storage.local.set(writes)
        } catch (e) {
            console.warn("[AES strategy/apply] audit persist failed", e)
        }
    }

    async function _persistApplied(envelope, accountId) {
        try {
            // F-9227-008: see _persistAudit. Scoped key is source of truth
            // when accountId resolves; don't trample the legacy APPLIED_KEY
            // on every cross-account apply.
            const scopedKey = _scopedKey(APPLIED_KEY, accountId)
            const writes = scopedKey
                ? {[scopedKey]: envelope}
                : {[APPLIED_KEY]: envelope}
            await chrome.storage.local.set(writes)
        } catch (e) { console.warn("[AES strategy/apply] applied persist failed", e) }
    }

    /**
     * Public read APIs for per-account history. Tile + portfolio call
     * these; if `accountId` is omitted, falls back to the legacy global
     * key so single-account installs see the same data as before.
     */
    async function getApplied(accountId) {
        try {
            const key = accountId ? _scopedKey(APPLIED_KEY, accountId) : APPLIED_KEY
            const data = await chrome.storage.local.get([key])
            const rec  = data[key]
            if (rec) return rec
            // Scoped miss — fall back to legacy so existing tiles still
            // surface SOMETHING for the current account during rollout.
            if (accountId) {
                const fb = await chrome.storage.local.get([APPLIED_KEY])
                return fb[APPLIED_KEY] || null
            }
            return null
        } catch (_) { return null }
    }

    async function getAudit(accountId, limit) {
        try {
            const key = accountId ? _scopedKey(AUDIT_KEY, accountId) : AUDIT_KEY
            const data = await chrome.storage.local.get([key])
            const ring = Array.isArray(data[key]) ? data[key] : []
            const n = Number(limit) > 0 ? Math.min(Number(limit), ring.length) : ring.length
            return ring.slice(0, n)
        } catch (_) { return [] }
    }

    // ── Sub-pipelines ────────────────────────────────────────────────────

    /**
     * Schedule sub-pipeline. Calls the existing fleet-apply-orchestrator
     * with one run per aircraft. The orchestrator already serialises per
     * aircraft and threads through the AFP tier gate — strategy doesn't
     * re-implement that. Returns a single result envelope for the entire
     * fleet apply (the orchestrator is monolithic by design).
     */
    async function _applySchedules(decisions, ctx, applied, skipped, opts) {
        if (!decisions.length) return {ok: true, ranOrchestrator: false}

        if (typeof window.AesAfpFleetApplyOrchestrator === "undefined"
                || typeof window.AesAfpFleetApplyOrchestrator.start !== "function") {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "schedule", reason: "actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "schedule", reason: "actuator-missing"})
            }
            return {ok: true, ranOrchestrator: false, missingActuator: true}
        }

        const runs = decisions
            .filter(d => d.payload && d.payload.aircraftId
                      && Array.isArray(d.payload.legs) && d.payload.legs.length)
            .map(d => ({
                aircraftId: String(d.payload.aircraftId),
                legs:       d.payload.legs,
                hub:        d.payload.hub
            }))
        if (!runs.length) return {ok: true, ranOrchestrator: false}

        _emit(opts, {kind: "schedule-start", aircraftCount: runs.length})
        let result = null
        try {
            result = await window.AesAfpFleetApplyOrchestrator.start({
                runs:   runs,
                ctx:    {server: ctx && ctx.server},
                source: (opts && opts.source) || "aesStrategy"
            })
        } catch (e) {
            const err = (e && e.message) || String(e)
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "schedule", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "schedule", ok: false, error: err})
                _busEmit("schedule", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: null, ok: false})
            }
            return {ok: false, error: err, fatal: true}
        }
        _emit(opts, {kind: "schedule-done", result: result})

        // Map per-aircraft results back to decision ids.
        const perAircraft = (result && result.perAircraft) || []
        const byId = new Map()
        for (const r of perAircraft) byId.set(String(r.aircraftId), r)
        for (const d of decisions) {
            const tail = byId.get(String(d.payload && d.payload.aircraftId))
            const ok   = !!(tail && tail.ok)
            applied.push({
                decisionId: d.id, domain: "schedule",
                ok: ok, result: tail || null,
                error: tail && tail.error ? tail.error : (ok ? null : "no orchestrator result")
            })
            _emit(opts, {kind: "result", decisionId: d.id, domain: "schedule", ok: ok})
            _busEmit("schedule", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: null, ok: ok})
        }

        // Aborted == orchestrator decided to bail (e.g. tier-gate dormant);
        // we propagate that as fatal so price/crew don't run on stale state.
        if (result && result.aborted) {
            return {ok: false, fatal: true, error: "fleet-apply orchestrator aborted"}
        }
        return {ok: true, result: result}
    }

    /**
     * Service-profile sub-pipeline. v1 service moves only carry per-class
     * targets (`changes` is empty); decisions whose `applicable === false`
     * are pre-filtered above. The applier is constructed per call so each
     * domain run starts with a clean slate.
     */
    async function _applyServiceMoves(decisions, ctx, applied, skipped, opts) {
        if (!decisions.length) return {ok: true}
        if (typeof window.RouteAssistantServiceProfileApplier !== "function") {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "service", reason: "actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "service", reason: "actuator-missing"})
            }
            return {ok: true, missingActuator: true}
        }
        const server = ctx && ctx.server
        if (!server) {
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "service", ok: false, error: "missing server context"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "service", ok: false, error: "missing server"})
                _busEmit("service", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: d.payload && d.payload.dest, ok: false})
            }
            return {ok: false, error: "missing server"}
        }
        // Resolve service-profile dry-run from strategy settings; defaults
        // to dryRunOnly=true so accidental wires can't push real changes.
        const settingsLoader = _settings()
        let serviceApply = {dryRunOnly: true}
        if (settingsLoader && typeof settingsLoader.load === "function") {
            try {
                const s = await settingsLoader.load()
                if (s && s.serviceApply) serviceApply = s.serviceApply
            } catch (_) { /* fall back to safe default */ }
        }

        const Applier = window.RouteAssistantServiceProfileApplier
        let applyLog = null
        if (typeof window.RouteAssistantServiceProfileApplyLog === "function") {
            try { applyLog = new window.RouteAssistantServiceProfileApplyLog() }
            catch (_) { applyLog = null }
        }
        let applier
        try {
            applier = new Applier(server, {
                applyEnabled: true,
                dryRunOnly:   !!serviceApply.dryRunOnly,
                applyLog:     applyLog
            })
        }
        catch (e) {
            const err = (e && e.message) || String(e)
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "service", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "service", ok: false, error: err})
                _busEmit("service", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: d.payload && d.payload.dest, ok: false})
            }
            return {ok: false, error: err}
        }
        let allOk = true
        for (const d of decisions) {
            const p = d.payload || {}
            try {
                const r = await applier.apply(p.profileId, p.changes || {}, {source: (opts && opts.source) || "strategy"})
                const ok = !!(r && (r.status === "posted" || r.status === "noop" || r.status === "dry-run"))
                if (!ok) allOk = false
                applied.push({decisionId: d.id, domain: "service", ok: ok,
                              result: r,
                              error: ok ? null : (r && r.error && r.error.message) || "unknown"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "service", ok: ok})
                _busEmit("service", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: ok})
            } catch (e) {
                allOk = false
                const err = (e && e.message) || String(e)
                applied.push({decisionId: d.id, domain: "service", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "service", ok: false, error: err})
                _busEmit("service", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: false})
            }
        }
        return {ok: allOk}
    }

    /**
     * Price sub-pipeline. The strategy proposer outputs `toPct` (markets-
     * page percent display); the existing applier `RouteAssistantPricingApplier`
     * accepts absolute prices. Reads the cached own-prices from the
     * canonical markets-page-scraper store (`routeAssistant:markets:ownPricing:HUB-DEST`,
     * with account-scoped fallback) and scales by `toPct/100` to derive
     * an absolute new price. When missing, the caller will trigger a
     * one-shot warm via `applier.warmCache()` and re-read.
     *
     * Falls back to the legacy `routeAssistant:ticketPrice:` key (used
     * here historically) if the markets-page record is absent — both
     * shapes carry `rec.prices[classKey]` in production after the
     * markets-page scraper landed; pre-markets installs may still have
     * the legacy shape so we keep the fallback for one release.
     */
    async function _readCachedPrice(server, hub, dest, classKey) {
        try {
            const pair = String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
            const candidates = ["routeAssistant:markets:ownPricing:" + pair]
            if (typeof window !== "undefined" && window.AesAccountKey
                    && typeof window.AesAccountKey.acctKey === "function") {
                const scoped = window.AesAccountKey.acctKey("routeAssistant:markets:ownPricing", pair)
                if (candidates.indexOf(scoped) < 0) candidates.unshift(scoped)
            }
            candidates.push("routeAssistant:ticketPrice:" + pair)
            const data = await chrome.storage.local.get(candidates)
            for (const k of candidates) {
                const rec = data[k]
                if (!rec || !rec.prices) continue
                const v = rec.prices[classKey]
                if (typeof v === "number" && isFinite(v) && v > 0) return v
            }
            return null
        } catch (_) { return null }
    }

    function _computeAbsolutePrice(current, pct, classKey) {
        const cur = Number(current)
        const p = Number(pct)
        if (!isFinite(cur) || !isFinite(p) || cur <= 0) return cur
        const raw = cur * (p / 100)
        if (classKey === "Cargo" || Math.abs(cur) < 10 || Math.abs(raw) < 10) {
            return Math.max(0.01, Math.round(raw * 100) / 100)
        }
        return Math.max(1, Math.round(raw))
    }

    /**
     * Build a HUB-DEST → cacheAge index from a snapshot once, so the
     * inner loop avoids O(routes×decisions) lookups.
     */
    function _indexCacheAges(snapshot) {
        const idx = new Map()
        const hubs = snapshot && snapshot.hubs
        if (!Array.isArray(hubs)) return idx
        for (const h of hubs) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                if (!r || !r.dest || !r.cacheAge) continue
                const key = String(h.iata).toUpperCase() + "-" + String(r.dest).toUpperCase()
                idx.set(key, r.cacheAge)
            }
        }
        return idx
    }

    async function _applyPriceMoves(decisions, ctx, applied, skipped, opts, snapshot) {
        if (!decisions.length) return {ok: true}
        if (typeof window.RouteAssistantPricingApplier !== "function") {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "price", reason: "actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "price", reason: "actuator-missing"})
            }
            return {ok: true, missingActuator: true}
        }
        const server = ctx && ctx.server
        if (!server) {
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "price", ok: false, error: "missing server context"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: false, error: "missing server"})
                _busEmit("price", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: d.payload && d.payload.dest, ok: false})
            }
            return {ok: false, error: "missing server"}
        }
        const Applier = window.RouteAssistantPricingApplier
        const raApply = await _routeAssistantPricingApplyConfig()
        if (!raApply.enabled) {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "price", reason: "route-assistant-pricing-disabled"})
                _emit(opts, {
                    kind: "skipped",
                    decisionId: d.id,
                    domain: "price",
                    reason: "route-assistant-pricing-disabled"
                })
                _recordPriceDiagnostic("skip", {
                    hub: d.payload && d.payload.hub,
                    dest: d.payload && d.payload.dest,
                    reason: "routeAssistantPricingDisabled"
                })
            }
            return {ok: true, pricingGate: true}
        }
        let applier
        try {
            applier = new Applier(server, {
                applyEnabled: raApply.enabled,
                dryRunOnly:   raApply.dryRunOnly
            })
        }
        catch (e) {
            const err = (e && e.message) || String(e)
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "price", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: false, error: err})
                _busEmit("price", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: d.payload && d.payload.dest, ok: false})
            }
            return {ok: false, error: err}
        }

        const maxCacheAgeMs = (opts && Number(opts.maxCacheAgeMin) > 0)
            ? Number(opts.maxCacheAgeMin) * 60000 : null
        const cacheAgeIdx = (maxCacheAgeMs && snapshot) ? _indexCacheAges(snapshot) : null

        let allOk = true
        for (const d of decisions) {
            const p   = d.payload || {}
            const cls = p.classKey || "Y"
            // Optional freshness gate — skip routes whose underlying
            // signals are older than `opts.maxCacheAgeMin`. Default unset
            // = legacy behaviour. The applier handles its own per-route
            // cooldown; this gate is about *snapshot* staleness driving
            // a stale proposal, not about apply throttling.
            if (cacheAgeIdx) {
                const pair = String(p.hub).toUpperCase() + "-" + String(p.dest).toUpperCase()
                const ages = cacheAgeIdx.get(pair)
                if (ages && isFinite(ages.maxMs) && ages.maxMs > maxCacheAgeMs) {
                    const reason = "stale-cache (>" + Math.round(maxCacheAgeMs / 60000)
                                 + "min · max=" + Math.round(ages.maxMs / 60000) + "min)"
                    skipped.push({decisionId: d.id, domain: "price", reason: reason,
                                  hub: p.hub, dest: p.dest})
                    _emit(opts, {kind: "skipped", decisionId: d.id, domain: "price", reason: reason})
                    _recordPriceDiagnostic("skip", {hub: p.hub, dest: p.dest, reason: reason})
                    continue
                }
            }
            let cached = await _readCachedPrice(server, p.hub, p.dest, cls)
            // Auto-seed: when the markets-page scrape hasn't run for this
            // route, do one warm GET via the applier and re-read. Bounded
            // (one extra GET per missing-cache route per pipeline run);
            // failures fall through to the existing skip path.
            if (cached == null && typeof applier.warmCache === "function") {
                try {
                    const warm = await applier.warmCache(p.hub, p.dest)
                    if (warm && warm.ok) cached = await _readCachedPrice(server, p.hub, p.dest, cls)
                } catch (_) { /* never let warm errors abort the loop */ }
            }
            if (cached == null) {
                const errMsg = "no cached own-price after warm attempt — try a manual scrape on /app/com/markets/" + p.hub + p.dest
                applied.push({decisionId: d.id, domain: "price", ok: false, error: errMsg})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: false,
                             error: "no cached own-price"})
                _busEmit("price", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: false})
                _recordPriceDiagnostic("skip", {hub: p.hub, dest: p.dest, reason: "noCachedOwnPrice"})
                allOk = false
                continue
            }
            const newPrice = _computeAbsolutePrice(cached, p.toPct, cls)
            const prices   = {[cls]: newPrice}
            // Thread the price-move's `impactWeekly` (projected weekly profit
            // delta from price-moves.js) into the applier as `projectedDelta`
            // so it lands on the apply-log entry. Strategy-tile's recent-
            // applies aggregate reads this back to show "+ $N/wk projected".
            const impact = Number(p.impactWeekly)
            try {
                const r = await applier.apply(p.hub, p.dest, prices, {
                    scope:  {airportPair: true},
                    source: (opts && opts.source) || "strategy",
                    projectedDelta: isFinite(impact) ? {profitPerWeek: impact} : null
                })
                const ok = !!(r && (r.status === "verified" || r.status === "posted"
                    || (raApply.dryRunOnly && r.status === "dry-run")))
                if (!ok) allOk = false
                const logId = (r && r.logId) || null
                applied.push({decisionId: d.id, domain: "price", ok: ok,
                              result: r,
                              logId: logId,
                              error: ok ? null : (r && r.error && r.error.message) || "unknown"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: ok})
                _busEmit("price", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: ok})
                _recordPriceDiagnostic("apply", {hub: p.hub, dest: p.dest, ok: ok, logId: logId})
            } catch (e) {
                allOk = false
                const err = (e && e.message) || String(e)
                applied.push({decisionId: d.id, domain: "price", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: false, error: err})
                _busEmit("price", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: false})
                _recordPriceDiagnostic("apply", {hub: p.hub, dest: p.dest, ok: false})
            }
        }
        return {ok: allOk}
    }

    /**
     * Route-creation sub-pipeline (Slice 6). Hands each decision off to
     * `AesStrategyRouteCreationApplier` which picks a tail, builds legs,
     * and calls the existing fleet-apply orchestrator. Independent of
     * subsequent — failure on one creation does NOT abort the rest.
     *
     * Requires the snapshot so the applier can consult `snapshot.fleet`
     * for aircraft picking. Pipeline composes one when missing.
     */
    async function _applyRouteCreations(decisions, ctx, snapshot, applied, skipped, opts) {
        if (!decisions.length) return {ok: true}
        if (typeof window.AesStrategyRouteCreationApplier === "undefined"
                || typeof window.AesStrategyRouteCreationApplier.apply !== "function") {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "routeCreation", reason: "actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "routeCreation", reason: "actuator-missing"})
            }
            return {ok: true, missingActuator: true}
        }
        const server = ctx && ctx.server
        if (!server) {
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "routeCreation", ok: false, error: "missing server context"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "routeCreation", ok: false, error: "missing server"})
                _busEmit("routeCreation", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: d.payload && d.payload.dest, ok: false})
            }
            return {ok: false, error: "missing server"}
        }
        if (!snapshot) {
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "routeCreation", ok: false, error: "missing snapshot"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "routeCreation", ok: false, error: "missing snapshot"})
                _busEmit("routeCreation", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: d.payload && d.payload.dest, ok: false})
            }
            return {ok: false, error: "missing snapshot"}
        }
        const Applier = window.AesStrategyRouteCreationApplier
        let allOk = true
        for (const d of decisions) {
            const creation = d.payload || null
            if (!creation || !creation.hub || !creation.dest) {
                allOk = false
                applied.push({decisionId: d.id, domain: "routeCreation", ok: false, error: "creation payload missing hub/dest"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "routeCreation", ok: false, error: "bad payload"})
                _busEmit("routeCreation", {decisionId: d.id, hub: creation && creation.hub, dest: creation && creation.dest, ok: false})
                continue
            }
            try {
                const r = await Applier.apply(creation, snapshot, {
                    server: server,
                    source: (opts && opts.source) || "aesStrategy-routeCreation"
                })
                const ok = !!(r && r.ok)
                if (!ok) allOk = false
                applied.push({decisionId: d.id, domain: "routeCreation", ok: ok,
                              result: r,
                              error: ok ? null : (r && r.error) || "unknown"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "routeCreation", ok: ok})
                _busEmit("routeCreation", {decisionId: d.id, hub: creation.hub, dest: creation.dest, ok: ok})
            } catch (e) {
                allOk = false
                const err = (e && e.message) || String(e)
                applied.push({decisionId: d.id, domain: "routeCreation", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "routeCreation", ok: false, error: err})
                _busEmit("routeCreation", {decisionId: d.id, hub: creation.hub, dest: creation.dest, ok: false})
            }
        }
        return {ok: allOk}
    }

    /**
     * Slice 12 — alliance & IL request sub-pipeline.
     *
     * IL requests are bilateral; the engine sends a request and the
     * partner has to accept on their side. This sub-pipeline drives only
     * the *send* path via `AllianceIlRequestApplier`, which has its own
     * two-gate model (applyEnabled + dryRunOnly, default dryRunOnly=true).
     * Strategy's tier + domain gates have already cleared by the time we
     * get here; we still re-apply the per-applier kill switches because
     * the user can have, for instance, `allianceMovesEnabled:true` on the
     * pipeline while keeping dryRunOnly:true on the applier itself.
     *
     * `alliance-join` decisions never reach this sub-pipeline because they
     * carry `applicable:false` — diff-plan filters them into the advisory
     * skip path upstream. Defensive filter here too.
     */
    async function _applyAllianceMoves(decisions, ctx, applied, skipped, opts) {
        if (!decisions.length) return {ok: true}
        if (typeof window.AllianceIlRequestApplier !== "function") {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "alliance", reason: "actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "alliance", reason: "actuator-missing"})
            }
            return {ok: true, missingActuator: true}
        }
        const server = ctx && ctx.server
        if (!server) {
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "alliance", ok: false, error: "missing server context"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "alliance", ok: false, error: "missing server"})
                _busEmit("alliance", {decisionId: d.id, hub: null, dest: null, ok: false})
            }
            return {ok: false, error: "missing server"}
        }

        const settingsLoader = _settings()
        const settings = settingsLoader ? await settingsLoader.load() : null
        const allianceCfg = (settings && settings.alliance && settings.alliance.apply) || {}
        const applyLog = (typeof window.AllianceIlRequestApplyLog === "function")
            ? new window.AllianceIlRequestApplyLog()
            : null
        const applier = new window.AllianceIlRequestApplier(server, {
            applyLog:     applyLog,
            applyEnabled: allianceCfg.enabled    !== false,
            dryRunOnly:   allianceCfg.dryRunOnly !== false
        })

        let allOk = true
        for (const d of decisions) {
            const p = d.payload || {}
            // Defensive: alliance-join leaks here only via a malformed
            // decision (diff-plan marks them advisory). Skip explicitly.
            if (p.kind && p.kind !== "il-request") {
                skipped.push({decisionId: d.id, domain: "alliance", reason: "advisory",
                              note: "alliance-join is advisory-only — no AS join API"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "alliance", reason: "advisory"})
                continue
            }
            if (!p.partnerEnterpriseId) {
                applied.push({decisionId: d.id, domain: "alliance", ok: false,
                              error: "missing partnerEnterpriseId"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "alliance", ok: false,
                             error: "missing partnerEnterpriseId"})
                _busEmit("alliance", {decisionId: d.id, hub: p.hub || null, dest: null, ok: false})
                allOk = false
                continue
            }
            try {
                const env = await applier.apply(p.partnerEnterpriseId, {
                    source:      opts && opts.source ? opts.source : "strategy",
                    partnerName: p.partnerName || null,
                    requestType: p.requestType || "INTERLINING"
                })
                // Treat dry-run as success — the user opted into preview-mode
                // explicitly and a "what'd post" envelope is the value here.
                const ok = env && (env.status === "verified"
                                || env.status === "posted"
                                || env.status === "dry-run")
                if (!ok) allOk = false
                applied.push({
                    decisionId: d.id,
                    domain:     "alliance",
                    ok:         ok,
                    result:     env,
                    error:      ok ? null : (env && env.error && env.error.message) || (env && env.warning) || "unknown",
                    logId:      env && env.logId || null
                })
                _emit(opts, {kind: "result", decisionId: d.id, domain: "alliance", ok: ok})
                _busEmit("alliance", {decisionId: d.id, hub: p.hub || null, dest: null, ok: ok})
            } catch (e) {
                allOk = false
                const err = (e && e.message) || String(e)
                applied.push({decisionId: d.id, domain: "alliance", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "alliance", ok: false, error: err})
                _busEmit("alliance", {decisionId: d.id, hub: p.hub || null, dest: null, ok: false})
            }
        }
        return {ok: allOk}
    }

    /**
     * Slice 20 — slot bid sub-pipeline.
     *
     * The live AS bid form is not mapped yet, so Strategy deliberately
     * routes this as a dry-run queue/logging path. AesSlotBidder still
     * records the attempt to AesSlotStore, which gives the Strategy menu
     * a real, inspectable action without risking a live slot write.
     */
    async function _applySlotBids(decisions, ctx, applied, skipped, opts) {
        if (!decisions.length) return {ok: true}
        if (!window.AesSlotBidder || typeof window.AesSlotBidder.apply !== "function") {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "slotBid", reason: "actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "slotBid", reason: "actuator-missing"})
            }
            return {ok: true, missingActuator: true}
        }

        let allOk = true
        for (const d of decisions) {
            const p = d.payload || {}
            const bidAmount = Number(p.suggestedBid || p.minBid || p.currentBid)
            const req = {
                server:    p.server || (ctx && ctx.server) || null,
                iata:      p.iata || p.airport || null,
                slotId:    p.slotId || null,
                bidAmount: bidAmount,
                dryRun:    true
            }
            try {
                const r = await window.AesSlotBidder.apply(req)
                const ok = !!(r && r.ok)
                if (!ok) allOk = false
                applied.push({
                    decisionId: d.id,
                    domain:     "slotBid",
                    ok:         ok,
                    result:     r,
                    error:      ok ? null : (r && (r.reason || r.error)) || "unknown"
                })
                _emit(opts, {kind: "result", decisionId: d.id, domain: "slotBid", ok: ok})
                _busEmit("slotBid", {decisionId: d.id, hub: null, dest: req.iata, ok: ok})
            } catch (e) {
                allOk = false
                const err = (e && e.message) || String(e)
                applied.push({decisionId: d.id, domain: "slotBid", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "slotBid", ok: false, error: err})
                _busEmit("slotBid", {decisionId: d.id, hub: null, dest: req.iata, ok: false})
            }
        }
        return {ok: allOk}
    }

    /**
     * Crew sub-pipeline. Plain form-encoded POST per call.
     */
    async function _applyCrewMoves(decisions, ctx, applied, skipped, opts, settings) {
        if (!decisions.length) return {ok: true}
        const server = ctx && ctx.server
        if (!server) {
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "crew", ok: false, error: "missing server context"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "crew", ok: false, error: "missing server"})
                _busEmit("crew", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: null, ok: false})
            }
            return {ok: false, error: "missing server"}
        }
        const pilotApplier = typeof window.CrewMgmtStaffPilotsApplier === "function"
            ? new window.CrewMgmtStaffPilotsApplier()
            : null
        const payCfg = settings && settings.crewPay && settings.crewPay.apply || {}
        const payApplier = typeof window.CrewMgmtPayTierApplier === "function"
            ? new window.CrewMgmtPayTierApplier(server, {
                applyLog:     typeof window.CrewMgmtPayTierApplyLog === "function"
                    ? new window.CrewMgmtPayTierApplyLog() : null,
                applyEnabled: payCfg.enabled !== false,
                dryRunOnly:   payCfg.dryRunOnly !== false
            })
            : null
        let allOk = true
        for (const d of decisions) {
            const p = d.payload || {}
            const isPay = p.action === "raisePay" || p.action === "cutPay"
            if (isPay && !payApplier) {
                skipped.push({decisionId: d.id, domain: "crew", reason: "pay-actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "crew", reason: "pay-actuator-missing"})
                continue
            }
            if (!isPay && !pilotApplier) {
                skipped.push({decisionId: d.id, domain: "crew", reason: "pilot-actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "crew", reason: "pilot-actuator-missing"})
                continue
            }
            try {
                const r = isPay
                    ? await payApplier.apply(p.positionId, p.recommendedSalary, {
                        source:    opts.source || "strategy",
                        label:     p.skillLabel || p.group || null,
                        payTierPp: p.amount
                    })
                    : await pilotApplier.hireOrTrain({
                        server:  server,
                        skillId: p.skillId,
                        amount:  p.amount,
                        mode:    p.action
                    })
                const ok = isPay
                    ? r && (r.status === "verified" || r.status === "posted"
                            || r.status === "dry-run" || r.status === "noop")
                    : r && r.status === "posted"
                if (!ok) allOk = false
                applied.push({decisionId: d.id, domain: "crew", ok: ok,
                              result: r,
                              error: ok ? null : (r && r.error && r.error.message) || "unknown"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "crew", ok: ok})
                _busEmit("crew", {decisionId: d.id, hub: p.hub, dest: null, ok: ok})
            } catch (e) {
                allOk = false
                const err = (e && e.message) || String(e)
                applied.push({decisionId: d.id, domain: "crew", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "crew", ok: false, error: err})
                _busEmit("crew", {decisionId: d.id, hub: p.hub, dest: null, ok: false})
            }
        }
        return {ok: allOk}
    }

    // ── Public ──────────────────────────────────────────────────────────

    async function apply(plan, opts) {
        const o = opts || {}
        const ctx = {
            server:      (o.ctx && o.ctx.server)      || (plan && plan.server),
            airlineCode: (o.ctx && o.ctx.airlineCode) || (plan && plan.airlineCode)
        }
        // Resolve accountId once up-front and thread it through the
        // persist calls so audit/applied land in this airline's slice.
        const accountId = await _accountIdFor(ctx.server, ctx.airlineCode)

        const settingsLoader = _settings()
        if (!settingsLoader) {
            return {planId: plan && plan.planId, ts: _now(),
                    aborted: true, abortReason: "AesStrategySettings not loaded",
                    applied: [], skipped: [], totals: {ok: 0, failed: 0, skipped: 0}}
        }
        const settings = await settingsLoader.load()
        const tier = settingsLoader.resolveTier(settings)

        const diffFn = _diff()
        const reviewedDiff = o.diff && Array.isArray(o.diff.decisions) ? o.diff : null
        const diff = reviewedDiff || (diffFn ? diffFn(plan, (o && o.snapshot) || null) : {decisions: [], summary: {}})
        const allDecisions = diff.decisions || []
        const sel = _selectedSet(o)

        const applied = []
        const skipped = []

        // ── Tier gate (master) ───────────────────────────────────────────
        if (tier === "preview-only") {
            for (const d of allDecisions) {
                skipped.push({decisionId: d.id, domain: d.domain, reason: "tier-gate"})
            }
            const report = {
                planId:      plan && plan.planId,
                ts:          _now(),
                source:      o.source || "strategy",
                tier:        tier,
                applied:     applied,
                skipped:     skipped,
                totals:      {ok: 0, failed: 0, skipped: skipped.length},
                aborted:     true,
                abortReason: "tier === preview-only — flip to apply-on-confirm in settings"
            }
            await _persistAudit({planId: plan && plan.planId, ts: report.ts,
                                  source: report.source, report: report,
                                  server: ctx.server, airlineCode: ctx.airlineCode}, accountId)
            return report
        }

        // ── Pre-bucket selected, applicable decisions per domain ─────────
        const buckets = {
            schedule: [], service: [], price: [], crew: [],
            routeCreation: [], alliance: [], slotBid: []
        }
        for (const d of allDecisions) {
            if (sel && !sel.has(d.id)) {
                skipped.push({decisionId: d.id, domain: d.domain, reason: "deselected"})
                continue
            }
            if (!d.applicable) {
                skipped.push({decisionId: d.id, domain: d.domain, reason: "advisory",
                              note: d.applicableNote})
                continue
            }
            // Defensive: a domain that lands in the diff but doesn't yet
            // have an actuator wired here. Surface as actuator-missing
            // rather than crashing on `buckets[d.domain].push`.
            if (!buckets[d.domain]) {
                skipped.push({decisionId: d.id, domain: d.domain, reason: "actuator-missing"})
                continue
            }
            // Per-domain enable flag.
            if (!settingsLoader.canApply(settings, d.domain)) {
                skipped.push({decisionId: d.id, domain: d.domain, reason: "domain-gate"})
                continue
            }
            buckets[d.domain].push(d)
        }

        let aborted = false
        let abortReason = null

        // 1. Schedules first — failure aborts.
        if (buckets.schedule.length) {
            _emit(o, {kind: "domain-start", domain: "schedule", count: buckets.schedule.length})
            const r = await _applySchedules(buckets.schedule, ctx, applied, skipped, o)
            if (r && r.fatal) {
                aborted = true
                abortReason = "schedule sub-pipeline aborted: " + (r.error || "unknown")
                _emit(o, {kind: "abort", reason: abortReason})
            }
        }

        // 2. Service moves — independent of subsequent.
        if (!aborted && buckets.service.length) {
            _emit(o, {kind: "domain-start", domain: "service", count: buckets.service.length})
            await _applyServiceMoves(buckets.service, ctx, applied, skipped, o)
        }

        // Shared snapshot — composed lazily on demand. Price moves use it
        // for the optional `maxCacheAgeMin` cache-staleness gate; route
        // creations use it for aircraft picking. Composing once keeps the
        // one extra `chrome.storage.local.get` to a single round trip
        // when both sub-pipelines need it.
        let snapshotForApply = (o && o.snapshot) || null
        async function _ensureSnapshot() {
            if (snapshotForApply) return snapshotForApply
            if (!window.AesStrategy || typeof window.AesStrategy.snapshot !== "function") return null
            try { snapshotForApply = await window.AesStrategy.snapshot({}) }
            catch (_) { snapshotForApply = null }
            return snapshotForApply
        }

        // 3. Price moves. Snapshot composed only when the optional cache-
        //    staleness gate is turned on; legacy (no opt) skips composition.
        if (!aborted && buckets.price.length) {
            _emit(o, {kind: "domain-start", domain: "price", count: buckets.price.length})
            let snapshotForPrice = snapshotForApply
            if (!snapshotForPrice && Number(o && o.maxCacheAgeMin) > 0) {
                snapshotForPrice = await _ensureSnapshot()
            }
            await _applyPriceMoves(buckets.price, ctx, applied, skipped, o, snapshotForPrice)
        }

        // 4. Crew moves.
        if (!aborted && buckets.crew.length) {
            _emit(o, {kind: "domain-start", domain: "crew", count: buckets.crew.length})
            await _applyCrewMoves(buckets.crew, ctx, applied, skipped, o, settings)
        }

        // 5. Route creations (Slice 6) — last so a partial schedule failure
        //    earlier doesn't risk creating new routes on a half-applied plan.
        //    Needs the snapshot for aircraft picking — compose lazily when
        //    not provided.
        if (!aborted && buckets.routeCreation.length) {
            const snapshotForCreations = await _ensureSnapshot()
            _emit(o, {kind: "domain-start", domain: "routeCreation", count: buckets.routeCreation.length})
            await _applyRouteCreations(buckets.routeCreation, ctx, snapshotForCreations, applied, skipped, o)
        }

        // 6. Alliance & IL requests (Slice 12) — last because they're
        //    bilateral and slow-moving; failure here doesn't compromise
        //    upstream applies.
        if (!aborted && buckets.alliance.length) {
            _emit(o, {kind: "domain-start", domain: "alliance", count: buckets.alliance.length})
            await _applyAllianceMoves(buckets.alliance, ctx, applied, skipped, o)
        }

        // 7. Slot bids (Slice 20) — dry-run queue/logging until the AS
        //    bid form POST shape is mapped.
        if (!aborted && buckets.slotBid.length) {
            _emit(o, {kind: "domain-start", domain: "slotBid", count: buckets.slotBid.length})
            await _applySlotBids(buckets.slotBid, ctx, applied, skipped, o)
        }

        // ── Aborted — anything still in a bucket counts as not-attempted ──
        if (aborted) {
            for (const dom of ["service", "price", "crew", "routeCreation", "alliance", "slotBid"]) {
                for (const d of buckets[dom]) {
                    if (!applied.find(a => a.decisionId === d.id)
                        && !skipped.find(s => s.decisionId === d.id)) {
                        skipped.push({decisionId: d.id, domain: d.domain, reason: "aborted-upstream"})
                    }
                }
            }
        }

        const okCount   = applied.filter(a => a.ok).length
        const failCount = applied.filter(a => !a.ok).length
        const ts        = _now()
        const report = {
            planId:      plan && plan.planId,
            ts:          ts,
            source:      o.source || "strategy",
            tier:        tier,
            objective:   (settings && settings.objective) || null,
            applied:     applied,
            skipped:     skipped,
            totals:      {ok: okCount, failed: failCount, skipped: skipped.length},
            aborted:     aborted,
            abortReason: abortReason
        }

        // Audit + applied envelope (per-account scoped, with legacy mirror)
        await _persistAudit({planId: plan && plan.planId, ts: ts, source: report.source, report: report,
                              server: ctx.server, airlineCode: ctx.airlineCode, accountId: accountId}, accountId)
        await _persistApplied({
            planId:      plan && plan.planId,
            ts:          ts,
            server:      ctx.server,
            airlineCode: ctx.airlineCode,
            accountId:   accountId,
            plan:        plan,
            applyReport: report
        }, accountId)

        // ── Slice 5 — outcome recording ──────────────────────────────────
        // Capture a "before" measurement so `learn.js` can attribute the
        // observed delta back to weights once the user reopens the panel
        // ≥ window-hours later. Skip when learning is paused so the ring
        // doesn't fill with no-attribution-coming records.
        // Recorded BEFORE journaling so Slice 26 Phase 2 can stamp the
        // resulting outcomeId onto each journal entry's `outcomeRef`,
        // letting lesson-miner.js join journal × outcomes per decision.
        let outcomeIdForJournal = null
        try {
            const learningEnabled = !!(settings && settings.learningEnabled)
            if (!aborted && okCount > 0 && learningEnabled
                    && window.AesStrategyOutcomes
                    && typeof window.AesStrategyOutcomes.record === "function") {
                // Reuse snapshotForApply when an upstream sub-pipeline
                // already composed one — saves a third snapshot fetch on
                // a busy apply.
                let snapForMeasure = (o && o.snapshot) || snapshotForApply || null
                if (!snapForMeasure && window.AesStrategy
                                    && typeof window.AesStrategy.snapshot === "function") {
                    try { snapForMeasure = await window.AesStrategy.snapshot({}) }
                    catch (_) { snapForMeasure = null }
                }
                const before = window.AesStrategyOutcomes.measure(snapForMeasure, plan)
                let weightsAtApply = null
                if (window.AesStrategyLearn
                        && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
                    try { weightsAtApply = await window.AesStrategyLearn.getCurrentWeights(accountId) }
                    catch (_) { weightsAtApply = null }
                }
                const outcome = await window.AesStrategyOutcomes.record({
                    planId:      plan && plan.planId,
                    applyTs:     ts,
                    before:      before,
                    weights:     weightsAtApply,
                    server:      ctx.server,
                    airlineCode: ctx.airlineCode,
                    accountId:   accountId
                })
                if (outcome && outcome.outcomeId) outcomeIdForJournal = outcome.outcomeId
            }
        } catch (e) {
            console.warn("[AES strategy/apply] outcome record failed", e)
        }

        // ── Slice 26 — journal record per applied decision ───────────────
        // Active recording (vs passive subscription) because the audit
        // ring's rationale strings would be lost on a 500-deep oldValue/
        // newValue diff. One journal entry per decision in `applied[]`,
        // route + rationale pulled from the original diff list.
        try {
            if (window.AesStrategyJournal
                    && typeof window.AesStrategyJournal.record === "function") {
                const byId = new Map()
                for (const d of allDecisions) byId.set(d.id, d)
                for (const a of applied) {
                    const d = byId.get(a.decisionId) || {}
                    const route = (d.payload && d.payload.hub && d.payload.dest)
                        ? (d.payload.hub + "-" + d.payload.dest)
                        : null
                    await window.AesStrategyJournal.record({
                        action:    "apply-decision",
                        accountId: accountId,
                        server:    ctx.server,
                        airline:   ctx.airlineCode,
                        route:     route,
                        before:    null,
                        after: {
                            decisionId: a.decisionId,
                            domain:     a.domain,
                            ok:         a.ok,
                            error:      a.error || null,
                            logId:      a.logId || null,
                            rationale:  Array.isArray(d.rationale) ? d.rationale.slice(0, 4) : [],
                            // Cluster keys for Slice 26 Phase 2 lesson-miner.
                            distanceKm:     (d.payload && Number(d.payload.distanceKm)) || null,
                            incumbentCount: (d.payload && Number(d.payload.incumbentCount)) || null,
                            equipFamily:    (d.payload && d.payload.equipFamily)        || null
                        },
                        source:     "apply-pipeline",
                        ts:         ts,
                        outcomeRef: outcomeIdForJournal
                    })
                }
            }
        } catch (e) {
            console.warn("[AES strategy/apply] journal record failed", e)
        }

        _emit(o, {kind: "done", report: report})
        return report
    }

    /**
     * Slice 12 — single-decision dispatch for the per-card UX.
     *
     * The Strategy panel renders alliance proposals one row per partner;
     * each row has a "Send IL request" button that drives only that one
     * decision through the apply pipeline. Shares every gate the bulk
     * `apply()` enforces (tier → applicable → per-domain flag → applier's
     * own two gates) and writes one audit envelope with `planId: null`.
     *
     * v1 dispatches `domain === "alliance"` only; other domains continue
     * to flow through bulk `apply()`. Adding a domain here is one switch
     * arm + matching sub-pipeline.
     */
    async function applyDecision(decision, opts) {
        const o = opts || {}
        if (!decision || !decision.id) {
            return {applied: [], skipped: [], totals: {ok: 0, failed: 0, skipped: 0},
                    aborted: true, abortReason: "decision required"}
        }
        const ctx = {
            server:      (o.ctx && o.ctx.server)      || o.server      || null,
            airlineCode: (o.ctx && o.ctx.airlineCode) || o.airlineCode || null
        }
        const accountId = await _accountIdFor(ctx.server, ctx.airlineCode)
        const settingsLoader = _settings()
        if (!settingsLoader) {
            return {applied: [], skipped: [], totals: {ok: 0, failed: 0, skipped: 0},
                    aborted: true, abortReason: "AesStrategySettings not loaded"}
        }
        const settings = await settingsLoader.load()
        const tier = settingsLoader.resolveTier(settings)
        const applied = []
        const skipped = []

        if (tier === "preview-only") {
            skipped.push({decisionId: decision.id, domain: decision.domain, reason: "tier-gate"})
            const report = {ts: _now(), source: o.source || "strategy-card", tier,
                            applied, skipped, totals: {ok: 0, failed: 0, skipped: 1},
                            aborted: true,
                            abortReason: "tier === preview-only — flip to apply-on-confirm in settings"}
            await _persistAudit({planId: null, ts: report.ts, source: report.source, report,
                                  server: ctx.server, airlineCode: ctx.airlineCode, accountId}, accountId)
            return report
        }
        if (!decision.applicable) {
            skipped.push({decisionId: decision.id, domain: decision.domain,
                          reason: "advisory", note: decision.applicableNote})
            return {ts: _now(), source: o.source || "strategy-card", tier,
                    applied, skipped, totals: {ok: 0, failed: 0, skipped: 1}}
        }
        if (!settingsLoader.canApply(settings, decision.domain)) {
            skipped.push({decisionId: decision.id, domain: decision.domain, reason: "domain-gate"})
            return {ts: _now(), source: o.source || "strategy-card", tier,
                    applied, skipped, totals: {ok: 0, failed: 0, skipped: 1}}
        }

        const subOpts = Object.assign({}, o, {source: o.source || "strategy-card"})
        if (decision.domain === "alliance") {
            await _applyAllianceMoves([decision], ctx, applied, skipped, subOpts)
        } else {
            return {applied: [], skipped: [], totals: {ok: 0, failed: 0, skipped: 0},
                    aborted: true,
                    abortReason: "applyDecision: domain '" + decision.domain
                        + "' not supported — use AesStrategy.apply(plan) for bulk apply"}
        }

        const ts        = _now()
        const okCount   = applied.filter(a => a.ok).length
        const failCount = applied.filter(a => !a.ok).length
        const report = {
            planId:  null,
            ts:      ts,
            source:  subOpts.source,
            tier:    tier,
            applied: applied,
            skipped: skipped,
            totals:  {ok: okCount, failed: failCount, skipped: skipped.length},
            aborted: false
        }
        await _persistAudit({planId: null, ts, source: report.source, report,
                              server: ctx.server, airlineCode: ctx.airlineCode, accountId}, accountId)
        return report
    }

    ns.apply       = apply
    ns.applyDecision = applyDecision
    ns.getApplied  = getApplied
    ns.getAudit    = getAudit
    ns.computeAccountId = _accountIdFor

    // ── ?aes-debug smoke (offline, no AS calls) ──────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Tier-gate short-circuit smoke — relies on default-settings being
            // loaded; if not, this assertion is benign (preview-only is default).
            (async function () {
                const r = await apply({planId: "smoke", perAircraft: [], priceMoves: [],
                                        serviceMoves: [], crewMoves: [], routeCreations: []})
                console.assert(r && r.aborted === true,
                    "[smoke strategy/apply] empty plan with default settings → aborted preview-only")
            })().catch(() => {})
        }
    } catch (_) { /* never let smoke break the page */ }
})()
