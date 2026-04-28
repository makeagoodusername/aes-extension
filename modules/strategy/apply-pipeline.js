"use strict"

/**
 * AES Strategy — apply pipeline (Slice 4 — first writing PR).
 *
 * Marshals an applied `FleetPlan` (or a user-sliced subset) through every
 * existing actuator. Strategy never POSTs directly; this module is the
 * single entry point that calls existing appliers in a fixed order:
 *
 *      schedules → service moves → price moves → crew moves
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
            const writes = {[AUDIT_KEY]: ring}
            if (scopedKey) writes[scopedKey] = ring
            await chrome.storage.local.set(writes)
        } catch (e) {
            console.warn("[AES strategy/apply] audit persist failed", e)
        }
    }

    async function _persistApplied(envelope, accountId) {
        try {
            const writes = {[APPLIED_KEY]: envelope}
            const scopedKey = _scopedKey(APPLIED_KEY, accountId)
            if (scopedKey) writes[scopedKey] = envelope
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
     * accepts absolute prices. v1 reads the cached own-prices for the
     * route from `routeAssistant:ticketPrice:<HUB>-<DEST>` and scales by
     * `toPct/100` to derive an absolute new price. When the cache is
     * missing we skip with a clear note so the user knows to seed it.
     */
    async function _readCachedPrice(server, hub, dest, classKey) {
        try {
            const key = "routeAssistant:ticketPrice:" + String(hub).toUpperCase()
                       + "-" + String(dest).toUpperCase()
            const data = await chrome.storage.local.get([key])
            const rec  = data[key]
            if (!rec || !rec.prices) return null
            const v = rec.prices[classKey]
            return (typeof v === "number" && isFinite(v) && v > 0) ? v : null
        } catch (_) { return null }
    }

    async function _applyPriceMoves(decisions, ctx, applied, skipped, opts) {
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
        let applier
        try { applier = new Applier(server, {applyEnabled: true, dryRunOnly: false}) }
        catch (e) {
            const err = (e && e.message) || String(e)
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "price", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: false, error: err})
                _busEmit("price", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: d.payload && d.payload.dest, ok: false})
            }
            return {ok: false, error: err}
        }

        let allOk = true
        for (const d of decisions) {
            const p   = d.payload || {}
            const cls = p.classKey || "Y"
            const cached = await _readCachedPrice(server, p.hub, p.dest, cls)
            if (cached == null) {
                applied.push({decisionId: d.id, domain: "price", ok: false,
                              error: "no cached own-price — open /app/com/scheduling/" + p.hub + p.dest + " to seed"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: false,
                             error: "no cached own-price"})
                _busEmit("price", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: false})
                allOk = false
                continue
            }
            const newPrice = Math.max(1, Math.round(cached * (Number(p.toPct) / 100)))
            const prices   = {[cls]: newPrice}
            try {
                const r = await applier.apply(p.hub, p.dest, prices, {
                    scope:  {airportPair: true},
                    source: (opts && opts.source) || "strategy"
                })
                const ok = !!(r && (r.status === "verified" || r.status === "posted"))
                if (!ok) allOk = false
                applied.push({decisionId: d.id, domain: "price", ok: ok,
                              result: r,
                              error: ok ? null : (r && r.error && r.error.message) || "unknown"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: ok})
                _busEmit("price", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: ok})
            } catch (e) {
                allOk = false
                const err = (e && e.message) || String(e)
                applied.push({decisionId: d.id, domain: "price", ok: false, error: err})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "price", ok: false, error: err})
                _busEmit("price", {decisionId: d.id, hub: p.hub, dest: p.dest, ok: false})
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
     * Crew sub-pipeline. Plain form-encoded POST per call.
     */
    async function _applyCrewMoves(decisions, ctx, applied, skipped, opts) {
        if (!decisions.length) return {ok: true}
        if (typeof window.CrewMgmtStaffPilotsApplier !== "function") {
            for (const d of decisions) {
                skipped.push({decisionId: d.id, domain: "crew", reason: "actuator-missing"})
                _emit(opts, {kind: "skipped", decisionId: d.id, domain: "crew", reason: "actuator-missing"})
            }
            return {ok: true, missingActuator: true}
        }
        const server = ctx && ctx.server
        if (!server) {
            for (const d of decisions) {
                applied.push({decisionId: d.id, domain: "crew", ok: false, error: "missing server context"})
                _emit(opts, {kind: "result", decisionId: d.id, domain: "crew", ok: false, error: "missing server"})
                _busEmit("crew", {decisionId: d.id, hub: d.payload && d.payload.hub, dest: null, ok: false})
            }
            return {ok: false, error: "missing server"}
        }
        const applier = new window.CrewMgmtStaffPilotsApplier()
        let allOk = true
        for (const d of decisions) {
            const p = d.payload || {}
            try {
                const r = await applier.hireOrTrain({
                    server:  server,
                    skillId: p.skillId,
                    amount:  p.amount,
                    mode:    p.action
                })
                const ok = r && r.status === "posted"
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
        const diff = diffFn ? diffFn(plan, null) : {decisions: [], summary: {}}
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
        const buckets = {schedule: [], service: [], price: [], crew: [], routeCreation: []}
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

        // 3. Price moves.
        if (!aborted && buckets.price.length) {
            _emit(o, {kind: "domain-start", domain: "price", count: buckets.price.length})
            await _applyPriceMoves(buckets.price, ctx, applied, skipped, o)
        }

        // 4. Crew moves.
        if (!aborted && buckets.crew.length) {
            _emit(o, {kind: "domain-start", domain: "crew", count: buckets.crew.length})
            await _applyCrewMoves(buckets.crew, ctx, applied, skipped, o)
        }

        // 5. Route creations (Slice 6) — last so a partial schedule failure
        //    earlier doesn't risk creating new routes on a half-applied plan.
        //    Needs the snapshot for aircraft picking — compose lazily when
        //    not provided.
        let snapshotForCreations = (o && o.snapshot) || null
        if (!aborted && buckets.routeCreation.length) {
            if (!snapshotForCreations
                    && window.AesStrategy && typeof window.AesStrategy.snapshot === "function") {
                try { snapshotForCreations = await window.AesStrategy.snapshot({}) }
                catch (_) { snapshotForCreations = null }
            }
            _emit(o, {kind: "domain-start", domain: "routeCreation", count: buckets.routeCreation.length})
            await _applyRouteCreations(buckets.routeCreation, ctx, snapshotForCreations, applied, skipped, o)
        }

        // ── Aborted — anything still in a bucket counts as not-attempted ──
        if (aborted) {
            for (const dom of ["service", "price", "crew", "routeCreation"]) {
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
                            rationale:  Array.isArray(d.rationale) ? d.rationale.slice(0, 4) : []
                        },
                        source: "apply-pipeline",
                        ts:     ts
                    })
                }
            }
        } catch (e) {
            console.warn("[AES strategy/apply] journal record failed", e)
        }

        // ── Slice 5 — outcome recording ──────────────────────────────────
        // Capture a "before" measurement so `learn.js` can attribute the
        // observed delta back to weights once the user reopens the panel
        // ≥ window-hours later. Skip when learning is paused so the ring
        // doesn't fill with no-attribution-coming records.
        try {
            const learningEnabled = !!(settings && settings.learningEnabled)
            if (!aborted && okCount > 0 && learningEnabled
                    && window.AesStrategyOutcomes
                    && typeof window.AesStrategyOutcomes.record === "function") {
                // Reuse snapshotForCreations when route-creation already
                // composed one — saves a third snapshot fetch on a busy apply.
                let snapForMeasure = (o && o.snapshot) || snapshotForCreations || null
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
                await window.AesStrategyOutcomes.record({
                    planId:      plan && plan.planId,
                    applyTs:     ts,
                    before:      before,
                    weights:     weightsAtApply,
                    server:      ctx.server,
                    airlineCode: ctx.airlineCode,
                    accountId:   accountId
                })
            }
        } catch (e) {
            console.warn("[AES strategy/apply] outcome record failed", e)
        }

        _emit(o, {kind: "done", report: report})
        return report
    }

    ns.apply       = apply
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
