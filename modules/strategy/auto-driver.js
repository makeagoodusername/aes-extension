"use strict"

/**
 * AES Strategy — auto-apply driver (Slice S2 of strategy execution).
 *
 * Turns the `apply-auto` tier from a label into a behavior. On a configurable
 * interval, recomposes the strategy plan, filters to high-confidence
 * decisions, and routes them through the existing `AesStrategy.apply()`
 * pipeline. Reuses every existing applier; this module adds no actuator code.
 *
 * Tier gates (read each tick — settings changes apply immediately):
 *   tier === "apply-auto"      → driver fires
 *   tier === "apply-on-confirm" → driver no-ops
 *   tier === "preview-only"    → driver no-ops
 *
 * Per-domain auto-tick gates (`settings.autoTick.domains.{schedule|service|
 * price|crew|routeCreation}`) layer on top of the existing
 * `AesStrategySettings.canApply()` per-domain enable so a user can keep
 * `priceMovesEnabled = true` for manual applies but opt out of price auto-firing.
 *
 * Public API (window.AesStrategyAutoDriver):
 *   .start()      Idempotent. Installs setInterval if not running.
 *   .stop()       Clears the interval.
 *   .tickNow()    One-shot manual fire (bypasses cooldown). Returns envelope.
 *   .isRunning()  Bool.
 *
 * Last-tick envelope persisted to chrome.storage.local["aesStrategy:autoTick:last"]:
 *   {at, durationMs, tier, applied, failed, skipped, decisionCount,
 *    skippedReason?, error?, aborted?, abortReason?}
 *
 * Command Center reads this envelope to render an "Auto · last tick X · applied N"
 * row on the strategy strip.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyAutoDriver) return

    const ENVELOPE_KEY    = "aesStrategy:autoTick:last"
    const ACK_KEY         = "aesStrategy:autoTick:firstActivationAck"
    const GAME_DAY_KEY    = "aesStrategy:autoTick:lastAppliedGameDate"
    const MIN_INTERVAL_MS = 60_000          // safety floor: 1 minute
    const TOPK_PER_TICK   = 25              // bound rank-target solver work

    let _intervalHandle        = null
    let _lastSuccessfulTickAt  = 0
    let _ticking               = false
    let _lastFuelContextAt     = 0   // bumped on routes:fuel-context recompute
    let _fuelContextOff        = null
    let _gameDayOff            = null   // unsubscribe from AesGameTimeWatcher

    /**
     * Subscribe to the canonical `routes:fuel-context` view so the next tick
     * envelope can record fuel multiplier + basis without re-reading
     * RA settings + fuel-price storage. Idempotent — start() calls this once.
     * The view is updated by the fuel scraper (`AesDataBus.publish`) and by
     * RA settings saves; we just observe.
     */
    function _attachFuelContext() {
        if (_fuelContextOff) return
        if (typeof window.AesView === "undefined") return
        _fuelContextOff = window.AesView.subscribe("routes:fuel-context", (e) => {
            if (!e || e.error) return
            _lastFuelContextAt = e.at || _now()
        })
    }

    function _readFuelContextSnapshot() {
        if (typeof window.AesView === "undefined") return null
        const v = window.AesView.get("routes:fuel-context")
        if (!v || !v.effective) return null
        return {
            seenAt:     _lastFuelContextAt || null,
            basis:      v.effective.basis || "unset",
            multiplier: typeof v.effective.multiplier === "number" ? v.effective.multiplier : 1,
            unit:       v.fuelPrice ? v.fuelPrice.unit : null
        }
    }

    function _now() { return Date.now() }

    function _scopedKey(accountId) {
        return accountId ? ENVELOPE_KEY + ":acct:" + accountId : ENVELOPE_KEY
    }

    /**
     * Per-account scoping (Slice 11). The last-tick envelope used to be
     * one global key, so when a user switched between sisters the
     * Command Center showed whichever sister fired last. Now we mirror
     * to a scoped key so each sister gets her own envelope and the
     * legacy global stays current too (Command Center reads scoped if
     * present, falls back to legacy).
     */
    async function _writeEnvelope(env, accountId) {
        try {
            const obj = {[ENVELOPE_KEY]: env}
            const scoped = _scopedKey(accountId)
            if (scoped !== ENVELOPE_KEY) obj[scoped] = env
            await chrome.storage.local.set(obj)
        } catch (e) {
            console.warn("[AES auto-driver] envelope write failed", e)
        }
    }

    /**
     * Velvet Cascade · PR 3 — first-activation ack gate. Returns the
     * stored ack record `{ts, settingsHash}` or null. The driver requires
     * an ack matching the current settings hash before any apply-auto
     * tick fires (§4.18 — first activation of any user-visible default
     * flip prompts a confirm). Missing ack ⇒ tick is skipped with reason.
     */
    async function _readAck() {
        try {
            const got = await chrome.storage.local.get([ACK_KEY])
            return got[ACK_KEY] || null
        } catch (_) { return null }
    }

    /**
     * Hash of the auto-tick configuration that's user-visible. Re-prompt
     * the first-activation modal when the surface changes (a new domain
     * gets enabled, the cap rises). Stable, deterministic, plain JS.
     */
    function _settingsHash(settings) {
        const auto = (settings && settings.autoTick) || {}
        const dom  = auto.domains || {}
        const parts = [
            "tier=" + ((settings && settings.tier) || ""),
            "interval=" + (auto.intervalMin || 0),
            "cap=" + (auto.maxDecisionsPerTick || 0),
            "silentCap24h=" + (auto.silentAutoCap24h || 0),
            "domains:" + ["schedule","service","price","crew","routeCreation"]
                .map(k => k + "=" + (dom[k] !== false ? "1" : "0")).join(",")
        ]
        return parts.join("|")
    }

    /**
     * Velvet Cascade · PR 3 — silent-auto cap-window enforcement.
     * Counts `verified|posted` source="silent-auto" entries in last 24h
     * across both pricing and service apply logs. Returns
     * `{priceCount, serviceCount, capExceeded: {price, service}}` so
     * `_tickOnce` can drop just the over-cap domains, not the whole tick.
     */
    async function _capStatus(settings) {
        const cap = Math.max(0, Number(settings && settings.autoTick
                              && settings.autoTick.silentAutoCap24h) || 10)
        const since = _now() - 24 * 3600 * 1000
        const out = {priceCount: 0, serviceCount: 0, capExceeded: {price: false, service: false}, cap: cap}
        try {
            if (window.RouteAssistantPricingApplyLog) {
                const log = new window.RouteAssistantPricingApplyLog()
                const counts = await log.countSilentAutoIn({n: since})
                out.priceCount = counts.n || 0
                if (out.priceCount >= cap) out.capExceeded.price = true
            }
        } catch (_) {}
        try {
            if (window.RouteAssistantServiceProfileApplyLog
                && typeof window.RouteAssistantServiceProfileApplyLog === "function") {
                const log = new window.RouteAssistantServiceProfileApplyLog()
                const counts = await log.countSilentAutoIn({n: since})
                out.serviceCount = counts.n || 0
                if (out.serviceCount >= cap) out.capExceeded.service = true
            }
        } catch (_) {}
        return out
    }

    /**
     * Snapshot health summary. When the tick produces 0 proposed decisions,
     * the strategy tile shows these counts so the user can see the most
     * common root cause at a glance — empty fleet, empty hub list, or no
     * routes opened on this airline.
     */
    function _summariseSnapshot(snapshot) {
        const out = {hubs: 0, routes: 0, fleet: 0,
                     routesWithProfit: 0, routesWithBand: 0,
                     routesWithOwnPrice: 0, routesScheduled: 0}
        if (!snapshot) return out
        out.fleet = Array.isArray(snapshot.fleet) ? snapshot.fleet.length : 0
        const hubs = snapshot.hubs
        if (!Array.isArray(hubs)) return out
        out.hubs = hubs.length
        for (const h of hubs) {
            for (const r of (h && h.byRoute) || []) {
                if (!r || !r.dest) continue
                out.routes++
                if (Number(r.profitPerWeek) > 0) out.routesWithProfit++
                if (r.competitor && r.competitor.priceMin != null
                                  && r.competitor.priceMax != null) out.routesWithBand++
                if (r.ownPricing && r.ownPricing.prices) out.routesWithOwnPrice++
                if (r.alreadyScheduled) out.routesScheduled++
            }
        }
        return out
    }

    /**
     * Count routes whose worst-of cache age exceeds the freshen threshold.
     * Used by the tick to compute "freshened N routes" telemetry.
     */
    function _countStaleRoutes(snapshot, auto) {
        const ageMs = (Number(auto && auto.freshenAgeMin) || 360) * 60_000
        let n = 0
        for (const h of (snapshot && snapshot.hubs) || []) {
            for (const r of (h && h.byRoute) || []) {
                const ms = r && r.cacheAge && r.cacheAge.maxMs
                if (isFinite(ms) && ms > ageMs) n++
            }
        }
        return n
    }

    /**
     * Pre-tick scrape orchestration. Before applying, freshen the
     * markets-page cache for routes whose data is older than
     * `freshenAgeMin` (default 6 hours = 360 min). Bounded at
     * `maxRoutesToFreshen` per tick (default 25) to keep the rate-limit
     * envelope predictable. Picks the highest-profit stale routes first.
     *
     * Re-snapshots after freshening so the proposer / applier see the
     * new data. Best-effort — any scrape failure leaves that route's
     * stale cache in place; the apply pipeline's per-route gates
     * decide whether to skip.
     *
     * Returns the freshened snapshot, or the input snapshot when no
     * freshening was needed / the markets scraper isn't loaded.
     */
    async function _freshenStaleRoutes(snapshot, settings, ctxServer) {
        if (!snapshot || !ctxServer) return snapshot
        if (typeof window.RouteAssistantMarketsPageScraper !== "function") return snapshot
        const auto = (settings && settings.autoTick) || {}
        const ageMin    = Math.max(0, Number(auto.freshenAgeMin)        || 360)
        const maxRoutes = Math.max(0, Number(auto.maxRoutesToFreshen)   || 25)
        if (ageMin <= 0 || maxRoutes <= 0) return snapshot
        const ageMs = ageMin * 60_000
        const stale = []
        for (const h of (snapshot.hubs || [])) {
            for (const r of (h && h.byRoute) || []) {
                if (!r || !r.dest) continue
                const ages = r.cacheAge || {}
                const max = isFinite(ages.maxMs) ? ages.maxMs : (ages.maxMs === null ? Infinity : 0)
                if (max <= ageMs) continue
                stale.push({hub: h.iata, dest: r.dest,
                            ageMs: max,
                            profit: Number(r.profitPerWeek) || 0})
            }
        }
        if (!stale.length) return snapshot
        // Pick highest-profit-stale first; ties broken by oldest-first.
        stale.sort((a, b) => (b.profit - a.profit) || (b.ageMs - a.ageMs))
        const picks = stale.slice(0, maxRoutes)
        try {
            const scraper = new window.RouteAssistantMarketsPageScraper(ctxServer)
            await scraper.bulkScrape(picks.map(p => ({hub: p.hub, dest: p.dest})), {
                concurrency: 3,
                staggerMs:   1000
            })
        } catch (e) {
            console.warn("[AES auto-driver] pre-tick freshen failed", e)
            return snapshot
        }
        // Re-snapshot so the rest of the pipeline sees the freshly-
        // scraped data. The compose call shares no state with the prior
        // snapshot — it just re-reads chrome.storage.
        try {
            const ns = window.AesStrategy
            if (ns && typeof ns.snapshot === "function") {
                return await ns.snapshot({})
            }
        } catch (_) { /* fall through */ }
        return snapshot
    }

    /**
     * Eligibility filter — kept aligned with
     * `command-center.js:_strategyHighConfDecisions` so the user's
     * "Quick-apply N" count and the auto-tick agree on what's eligible.
     *
     * Price-domain nuance: the proposer's `impactWeekly` is a linear-revenue
     * heuristic that doesn't model share/volume gains. A profit-tilted
     * undercut (price -5pp on a profitable route to grab share) computes
     * to negative $/wk under that model even though the move is exactly
     * what the chosen objective asked for. So for non-profit-max
     * objectives we trust the proposer (it's already deadband + max-move
     * + anti-spiral + elasticity vetted) and accept any non-zero impact.
     * Profit-max stays strict — a user who picked profit-max wants to
     * see only revenue-up moves.
     *
     * Returns `{candidates, drops}` rather than a bare array so the tick
     * can populate a transparent funnel in the envelope: which proposer
     * decisions were filtered, and why. Drop reasons are mutually
     * exclusive (first-match wins) and counted per category:
     *   - notApplicable      → proposer marked it not-applicable
     *   - domainBlocked      → current tier doesn't allow this domain
     *   - nonPositiveImpact  → no $/wk impact, or strict-mode impact <= 0
     */
    function _impactPasses(d) {
        const im = d._impact
        if (!im || im.unit !== "$/wk") return false
        const v = Number(im.value)
        if (!isFinite(v) || v === 0) return false
        if (d.domain !== "price") return v > 0
        // Trust the proposer's competitor-band/objective logic for non-
        // profit-max objectives. Missing objective metadata falls back to
        // strict so an upstream change that drops the field can't silently
        // loosen safety.
        const objKind = d.payload && d.payload.objective && d.payload.objective.kind
        const trustProposer = objKind === "maxShare"
                           || objKind === "balanced"
                           || objKind === "custom"
        return trustProposer ? true : v > 0
    }

    function _filterEligibleDecisions(diff, settings) {
        const ns = window.AesStrategySettings
        const drops = {notApplicable: 0, domainBlocked: 0, nonPositiveImpact: 0}
        if (!diff || !Array.isArray(diff.decisions) || !ns) return {candidates: [], drops}
        const candidates = []
        for (const d of diff.decisions) {
            if (!d || !d.applicable) { drops.notApplicable++; continue }
            let allowed = false
            if (typeof ns.canApply === "function") {
                try { allowed = !!ns.canApply(settings, d.domain) }
                catch (_) { allowed = false }
            }
            if (!allowed) { drops.domainBlocked++; continue }
            if (!_impactPasses(d)) { drops.nonPositiveImpact++; continue }
            candidates.push(d)
        }
        return {candidates, drops}
    }

    async function _finish(startedAt, trigger, payload) {
        const env = Object.assign(
            {at: startedAt, durationMs: _now() - startedAt, trigger: trigger},
            payload || {}
        )
        await _writeEnvelope(env, env.accountId || null)
        return env
    }

    /**
     * Per-tick lifecycle emitter — broadcasts stage transitions on
     * CentralHubBus("strategy:auto-tick-stage") so the Strategy tile
     * (and any future observer) can render a live progress log instead
     * of staring at a silent button. The bus is best-effort: if it isn't
     * loaded on this page (e.g. content script load order), the emit
     * is a no-op and the tick path is unchanged.
     */
    function _emitStage(stage, trigger, payload) {
        try {
            if (typeof window === "undefined") return
            const bus = window.CentralHubBus
            if (!bus || typeof bus.emit !== "function") return
            bus.emit("strategy:auto-tick-stage", Object.assign(
                {stage: stage, trigger: trigger, at: _now()},
                payload || {}
            ))
        } catch (_) { /* never let progress signal break the tick */ }
    }

    async function _tickOnce(opts) {
        if (_ticking) return {skippedReason: "concurrent"}
        _ticking = true
        const startedAt = _now()
        // Hoisted so every _finish() / _emitStage() call sees the same
        // value, including early-skip paths. Without this, skip envelopes
        // landed without a trigger field and the diagnostic card showed
        // "interval" even after a manual click.
        const triggeredBy = (opts && opts.trigger) || "interval"
        _emitStage("start", triggeredBy)
        try {
            // 1. Settings + tier gate
            if (!window.AesStrategySettings
                    || typeof window.AesStrategySettings.load !== "function") {
                _emitStage("done", triggeredBy, {skippedReason: "settings-missing"})
                return _finish(startedAt, triggeredBy, {skippedReason: "settings-missing"})
            }
            const settings = await window.AesStrategySettings.load()
            const tier = window.AesStrategySettings.resolveTier(settings)
            _emitStage("tier-checked", triggeredBy, {tier: tier})
            if (tier !== "apply-auto") {
                _emitStage("done", triggeredBy, {tier: tier, skippedReason: "tier-gate"})
                return _finish(startedAt, triggeredBy, {tier: tier, skippedReason: "tier-gate"})
            }

            // 2. Master kill switch
            const auto = (settings && settings.autoTick) || {}
            if (auto.enabled === false) {
                _emitStage("done", triggeredBy, {tier: tier, skippedReason: "disabled"})
                return _finish(startedAt, triggeredBy, {tier: tier, skippedReason: "disabled"})
            }

            // 3. Cooldown (bypassed for manual tickNow)
            const cooldownMs = Math.max(0, Number(auto.cooldownMin) || 0) * 60_000
            if (!opts || !opts.bypassCooldown) {
                if (cooldownMs > 0 && _lastSuccessfulTickAt
                        && (startedAt - _lastSuccessfulTickAt) < cooldownMs) {
                    _emitStage("done", triggeredBy, {tier: tier, skippedReason: "cooldown"})
                    return _finish(startedAt, triggeredBy, {tier: tier, skippedReason: "cooldown"})
                }
            }

            // 3.5 Game-day budget. The user's stated intent is one
            // automated price apply per AS world-day. When a rollover/
            // catch-up tick has already committed today's date, the
            // wall-clock setInterval gets a free skip. Manual tickNow
            // and trigger="game-day-*" paths bypass this gate so the
            // user / rollover can override.
            if (!triggeredBy || triggeredBy === "interval") {
                const curDate = (opts && opts.gameDate) || _currentGameDate()
                if (curDate) {
                    const lastApplied = await _readLastAppliedGameDate()
                    if (lastApplied && lastApplied >= curDate) {
                        _emitStage("done", triggeredBy, {
                            tier: tier,
                            skippedReason: "already-applied-this-game-day",
                            gameDate: curDate
                        })
                        return _finish(startedAt, triggeredBy, {
                            tier: tier,
                            skippedReason: "already-applied-this-game-day",
                            gameDate: curDate,
                            lastAppliedGameDate: lastApplied
                        })
                    }
                }
            }
            _emitStage("gameday-checked", triggeredBy)

            // 3a. Velvet Cascade · PR 3 — first-activation ack gate. Block
            // the tick when the user hasn't confirmed apply-auto for the
            // current settingsHash. Skip envelope tells the diagnostics
            // tile (PR 1B) to surface the prompt.
            const ack = await _readAck()
            const expectedHash = _settingsHash(settings)
            if (!ack || ack.settingsHash !== expectedHash) {
                _emitStage("done", triggeredBy, {tier: tier, skippedReason: "first-activation-required"})
                return _finish(startedAt, triggeredBy, {
                    tier: tier,
                    skippedReason: "first-activation-required",
                    expectedHash:  expectedHash,
                    storedHash:    ack && ack.settingsHash || null
                })
            }
            _emitStage("ack-checked", triggeredBy)

            // 3b. Silent-auto cap-window — drop the over-cap domains rather
            // than aborting the whole tick (other domains can still fire).
            const capStat = await _capStatus(settings)

            // 4. Compose plan via the same chain Command Center uses
            const ns = window.AesStrategy
            if (!ns || typeof ns.snapshot !== "function"
                    || typeof ns.scoreRoutes !== "function"
                    || typeof ns.allocateFleet !== "function"
                    || typeof ns.diffPlan !== "function") {
                _emitStage("done", triggeredBy, {tier: tier, skippedReason: "strategy-missing"})
                return _finish(startedAt, triggeredBy, {tier: tier, skippedReason: "strategy-missing"})
            }

            let snapshot, plan, diff, acctId = null
            let freshenedRoutes = 0
            try {
                snapshot = await ns.snapshot({})
                acctId = (snapshot && snapshot.accountId) || null
                {
                    const hubsCount = (snapshot && snapshot.hubs && snapshot.hubs.length) || 0
                    let routesCount = 0
                    for (const h of (snapshot && snapshot.hubs) || []) {
                        routesCount += (h && h.byRoute && h.byRoute.length) || 0
                    }
                    _emitStage("snapshot-composed", triggeredBy,
                        {hubs: hubsCount, routes: routesCount})
                }
                // Pre-tick freshen — scrape stale routes' markets pages so
                // proposers run on fresh competitor + own-pricing data.
                // Game-day rollover ticks always freshen; interval ticks
                // freshen too unless the user opts out via
                // `autoTick.skipFreshen=true`. Bounded by maxRoutesToFreshen.
                const wantFreshen = !auto.skipFreshen
                                  && (triggeredBy === "game-day-rollover"
                                      || triggeredBy === "game-day-catchup"
                                      || triggeredBy === "manual"
                                      || triggeredBy === "interval")
                if (wantFreshen) {
                    const before = (snapshot && snapshot.hubs) || []
                    let staleBefore = 0
                    for (const h of before) for (const r of (h && h.byRoute) || []) {
                        const ms = r && r.cacheAge && r.cacheAge.maxMs
                        if (isFinite(ms) && ms > (Number(auto.freshenAgeMin) || 360) * 60_000) staleBefore++
                    }
                    if (staleBefore > 0) {
                        _emitStage("freshening", triggeredBy, {staleBefore: staleBefore})
                    }
                    snapshot = await _freshenStaleRoutes(snapshot, settings, snapshot && snapshot.server)
                    freshenedRoutes = Math.max(0, staleBefore - _countStaleRoutes(snapshot, auto))
                    if (snapshot && !acctId) acctId = snapshot.accountId || null
                    _emitStage("freshen-done", triggeredBy,
                        {freshened: freshenedRoutes, staleBefore: staleBefore})
                } else {
                    _emitStage("freshen-skipped", triggeredBy)
                }
                let weights = null
                if (window.AesStrategyLearn
                        && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
                    try { weights = await window.AesStrategyLearn.getCurrentWeights(acctId) }
                    catch (_) { weights = null }
                }
                const scored = ns.scoreRoutes(snapshot, weights || undefined)
                plan = await ns.allocateFleet(snapshot, scored, {})
                diff = ns.diffPlan(plan, snapshot, {})
                _emitStage("planned", triggeredBy,
                    {proposed: (diff && diff.decisions && diff.decisions.length) || 0})
            } catch (e) {
                _emitStage("done", triggeredBy, {tier: tier, error: "compose-failed"})
                return _finish(startedAt, triggeredBy, {tier: tier,
                    error: "compose-failed: " + ((e && e.message) || String(e))})
            }

            // 5. Filter to high-conf, then per-domain auto-tick gate, then cap.
            //    Per-stage drop counts are captured so the envelope's `funnel`
            //    can show the user exactly where decisions are being filtered
            //    out (proposer → eligible → applied), which is otherwise opaque.
            const proposedCount = (diff.decisions || []).length
            // Per-domain proposer counts so the tile can show "0 price moves
            // proposed" specifically — important when the user has only one
            // domain enabled and the diff total is dominated by other kinds.
            const byDomain = {schedule: 0, service: 0, price: 0, crew: 0,
                              routeCreation: 0, competitorReaction: 0}
            for (const d of (diff.decisions || [])) {
                if (d && d.domain) byDomain[d.domain] = (byDomain[d.domain] || 0) + 1
            }
            // Snapshot health stats. Surfaces the most common "no-decisions"
            // root cause: the airline has no routes / fleet / hubs to act on.
            const snapStats = _summariseSnapshot(snapshot)
            const eligible = _filterEligibleDecisions(diff, settings)
            let candidates = eligible.candidates
            const dropCounts = Object.assign(
                {userDisabled: 0, capDropped: 0, overTickCap: 0},
                eligible.drops
            )
            const domainGates = (auto.domains && typeof auto.domains === "object")
                ? auto.domains : {}
            const beforeUserDisabled = candidates.length
            candidates = candidates.filter(d => domainGates[d.domain] !== false)
            dropCounts.userDisabled = beforeUserDisabled - candidates.length
            // PR 3 — drop domains that have hit the silent-auto 24h cap.
            const droppedByCap = []
            const beforeCap = candidates.length
            candidates = candidates.filter(d => {
                if (d.domain === "price" && capStat.capExceeded.price) {
                    droppedByCap.push({id: d.id, domain: "price", reason: "silent-auto-cap-24h"})
                    return false
                }
                if (d.domain === "service" && capStat.capExceeded.service) {
                    droppedByCap.push({id: d.id, domain: "service", reason: "silent-auto-cap-24h"})
                    return false
                }
                return true
            })
            dropCounts.capDropped = beforeCap - candidates.length
            const cap = Math.max(0, Number(auto.maxDecisionsPerTick) || 0)
            if (cap > 0 && candidates.length > cap) {
                dropCounts.overTickCap = candidates.length - cap
                candidates = candidates.slice(0, cap)
            }
            const funnel = Object.assign(
                {proposed: proposedCount, eligible: candidates.length,
                 byDomain: byDomain, snapshotStats: snapStats},
                dropCounts
            )
            _emitStage("filtered", triggeredBy,
                {funnel: funnel, candidates: candidates.length})
            if (!candidates.length) {
                const skippedReason = droppedByCap.length ? "all-domains-capped" : "no-decisions"
                _emitStage("done", triggeredBy,
                    {tier: tier, skippedReason: skippedReason, funnel: funnel})
                return _finish(startedAt, triggeredBy, {tier: tier,
                    skippedReason: skippedReason,
                    decisionCount:  proposedCount,
                    droppedByCap:   droppedByCap.length ? droppedByCap : undefined,
                    capStatus:      capStat,
                    funnel:         funnel})
            }

            // 6. Apply through existing pipeline (re-checks tier internally)
            if (typeof ns.apply !== "function") {
                _emitStage("done", triggeredBy, {tier: tier, skippedReason: "pipeline-missing"})
                return _finish(startedAt, triggeredBy, {tier: tier, skippedReason: "pipeline-missing"})
            }
            const ids = candidates.map(d => d.id).filter(Boolean)
            _emitStage("applying", triggeredBy, {candidates: ids.length})
            let report
            try {
                report = await ns.apply(plan, {
                    selected: ids,
                    snapshot: snapshot,
                    source:   "auto-driver"
                })
            } catch (e) {
                _emitStage("done", triggeredBy,
                    {tier: tier, error: "apply-failed", candidates: candidates.length})
                return _finish(startedAt, triggeredBy, {tier: tier,
                    error: "apply-failed: " + ((e && e.message) || String(e)),
                    decisionCount: candidates.length})
            }
            const totals = (report && report.totals) || {ok: 0, failed: 0, skipped: 0}
            // Velvet Cascade · PR 3 — surface per-decision failures so the
            // diagnostics tile can list them. The pipeline's `applied` rows
            // carry per-domain ok/error pairs; we flatten the `ok=false`
            // ones into a compact list bounded at 10.
            const failedDecisions = []
            for (const r of (report && report.applied) || []) {
                if (!r || r.ok) continue
                failedDecisions.push({
                    id:     r.decisionId || null,
                    domain: r.domain     || null,
                    error:  (r.error && r.error.message) || (typeof r.error === "string" ? r.error : null)
                })
                if (failedDecisions.length >= 10) break
            }
            _lastSuccessfulTickAt = startedAt
            // Commit today's game-date so subsequent wall-clock ticks
            // skip with "already-applied-this-game-day" until the next
            // rollover. The catch-up / rollover paths also write this,
            // but writing here covers ticks initiated by setInterval or
            // an explicit user tickNow that landed on a fresh game day.
            const tickGameDate = (opts && opts.gameDate) || _currentGameDate()
            if (tickGameDate && Number(totals.ok) > 0) {
                await _writeLastAppliedGameDate(tickGameDate)
            }
            _emitStage("done", triggeredBy, {
                tier:    tier,
                applied: totals.ok,
                failed:  totals.failed,
                skipped: totals.skipped,
                funnel:  funnel
            })
            return _finish(startedAt, triggeredBy, {
                tier:           tier,
                accountId:      acctId,
                server:         snapshot.server || null,
                airlineCode:    snapshot.airlineCode || null,
                applied:        totals.ok,
                failed:         totals.failed,
                skipped:        totals.skipped,
                aborted:        !!(report && report.aborted),
                abortReason:    (report && report.abortReason) || null,
                decisionCount:  candidates.length,
                domains:        domainGates,
                droppedByCap:   droppedByCap.length ? droppedByCap : undefined,
                capStatus:      capStat,
                failedDecisions: failedDecisions.length ? failedDecisions : undefined,
                fuelContext:    _readFuelContextSnapshot(),
                gameDate:       tickGameDate || null,
                freshenedRoutes: freshenedRoutes || 0,
                funnel:         funnel
            })
        } finally {
            _ticking = false
        }
    }

    async function _readIntervalMs() {
        try {
            const settings = await window.AesStrategySettings.load()
            const min = Math.max(0,
                Number(settings && settings.autoTick && settings.autoTick.intervalMin) || 0)
            return Math.max(MIN_INTERVAL_MS, min * 60_000)
        } catch (_) {
            return Math.max(MIN_INTERVAL_MS, 30 * 60_000)
        }
    }

    /**
     * Game-day cadence — fire the auto-tick once per AS world-day, anchored
     * on the bottom-bar clock. The user's intent (per /loop conversation):
     * "per day a price check and execution of the script". The wall-clock
     * setInterval is kept as a safety net, but the *primary* trigger is
     * the rollover signal from AesGameTimeWatcher.
     *
     * `lastAppliedGameDate` persists across tabs/sessions so missed days
     * (app closed during the rollover) fire on the next page load that
     * boots the driver. Lexical compare on `YYYY-MM-DD` strings is safe
     * — AS hub-time is monotonic, no wraps.
     */
    async function _readLastAppliedGameDate() {
        try {
            const out = await chrome.storage.local.get([GAME_DAY_KEY])
            return out[GAME_DAY_KEY] || null
        } catch (_) { return null }
    }

    async function _writeLastAppliedGameDate(date) {
        try { await chrome.storage.local.set({[GAME_DAY_KEY]: date}) }
        catch (_) { /* best-effort */ }
    }

    /**
     * Returns the current game-date observable on this page, or null when
     * the bottom-bar isn't on the page (login flow, error pages, etc.).
     */
    function _currentGameDate() {
        if (typeof window === "undefined" || !window.AesGameTimeWatcher) return null
        try {
            const cur = window.AesGameTimeWatcher.read()
            return (cur && cur.gameDate) || null
        } catch (_) { return null }
    }

    /**
     * Catch-up logic: if the persisted last-applied game-date is older
     * than the date we observe right now, fire one tick immediately.
     * Idempotent — gates on tier inside _tickOnce, so calling this on a
     * preview-only or apply-on-confirm install is a safe no-op.
     */
    async function _maybeCatchUp() {
        const curDate = _currentGameDate()
        if (!curDate) return
        const lastApplied = await _readLastAppliedGameDate()
        if (lastApplied && lastApplied >= curDate) return
        try {
            const env = await _tickOnce({bypassCooldown: true,
                                         trigger: "game-day-catchup",
                                         gameDate: curDate})
            // Only commit the date if the tick actually applied something
            // (or was tier-gated — that's a "valid no-op" we don't want
            // to retry every minute). Failures keep the date stale so a
            // future tick can retry.
            const ok = env && (
                Number(env.applied) > 0
                || env.skippedReason === "tier-gate"
                || env.skippedReason === "disabled"
                || env.skippedReason === "first-activation-required"
            )
            if (ok) await _writeLastAppliedGameDate(curDate)
        } catch (e) {
            console.warn("[AES auto-driver] catch-up tick failed", e)
        }
    }

    /**
     * Subscribe to game-day rollovers. Fires `_tickOnce` immediately when
     * the world-clock advances. Returns a teardown function so stop()
     * can detach. Defensive: missing watcher = no-op (the wall-clock
     * interval still runs as the safety-net path).
     */
    function _attachGameDayTrigger() {
        if (_gameDayOff) return
        if (typeof window === "undefined" || !window.AesGameTimeWatcher) return
        if (typeof window.AesGameTimeWatcher.onRollover !== "function") return
        _gameDayOff = window.AesGameTimeWatcher.onRollover(async (info) => {
            try {
                const env = await _tickOnce({bypassCooldown: true,
                                             trigger: "game-day-rollover",
                                             gameDate: info && info.gameDate})
                const ok = env && (
                    Number(env.applied) > 0
                    || env.skippedReason === "tier-gate"
                    || env.skippedReason === "disabled"
                    || env.skippedReason === "first-activation-required"
                )
                if (ok && info && info.gameDate) {
                    await _writeLastAppliedGameDate(info.gameDate)
                }
            } catch (e) {
                console.warn("[AES auto-driver] rollover tick failed", e)
            }
        })
    }

    async function start() {
        if (_intervalHandle !== null) return
        _attachFuelContext()
        _attachGameDayTrigger()
        const ms = await _readIntervalMs()
        _intervalHandle = setInterval(() => {
            _tickOnce().catch(err => console.warn("[AES auto-driver] tick error", err))
        }, ms)
        // Catch up on missed game-days. Run after the interval is
        // installed so a long catch-up doesn't hold up start().
        _maybeCatchUp().catch(err => console.warn("[AES auto-driver] catch-up failed", err))
    }

    function stop() {
        if (_intervalHandle === null) return
        clearInterval(_intervalHandle)
        _intervalHandle = null
        if (_fuelContextOff) { try { _fuelContextOff() } catch (_) {} _fuelContextOff = null }
        if (_gameDayOff)     { try { _gameDayOff()     } catch (_) {} _gameDayOff     = null }
    }

    async function tickNow(opts) {
        const o = Object.assign({}, opts || {}, {bypassCooldown: true})
        if (!o.trigger) o.trigger = "manual"
        return _tickOnce(o)
    }

    function isRunning() { return _intervalHandle !== null }

    /**
     * Velvet Cascade · PR 3 — first-activation ack writer. Called from
     * the strategy panel's confirm modal once the user accepts. The ack
     * is keyed on the current settings hash so re-enabling a domain
     * (e.g. flipping crewMovesEnabled later) re-prompts.
     */
    async function ackFirstActivation() {
        try {
            const settings = await window.AesStrategySettings.load()
            const rec = {ts: _now(), settingsHash: _settingsHash(settings)}
            await chrome.storage.local.set({[ACK_KEY]: rec})
            return rec
        } catch (e) {
            console.warn("[AES auto-driver] ack write failed", e)
            return null
        }
    }

    async function readAck() { return await _readAck() }

    /**
     * Returns whether the current settings need a first-activation ack.
     * Diagnostics tile + panel use this to decide whether to surface the
     * confirm prompt before the next tick.
     */
    async function needsFirstActivationAck() {
        try {
            const settings = await window.AesStrategySettings.load()
            const tier = window.AesStrategySettings.resolveTier(settings)
            if (tier !== "apply-auto") return false
            const ack = await _readAck()
            const expected = _settingsHash(settings)
            return !ack || ack.settingsHash !== expected
        } catch (_) { return false }
    }

    window.AesStrategyAutoDriver = {
        start:        start,
        stop:         stop,
        tickNow:      tickNow,
        isRunning:    isRunning,
        ackFirstActivation:        ackFirstActivation,
        readAck:                   readAck,
        needsFirstActivationAck:   needsFirstActivationAck,
        readLastAppliedGameDate:   _readLastAppliedGameDate,
        ENVELOPE_KEY:  ENVELOPE_KEY,
        ACK_KEY:       ACK_KEY,
        GAME_DAY_KEY:  GAME_DAY_KEY,
        TOPK_PER_TICK: TOPK_PER_TICK
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    // Smoke runs BEFORE auto-start so isRunning() === false still holds.
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof window.AesStrategyAutoDriver.start === "function",
                "[smoke] start() exposed")
            console.assert(window.AesStrategyAutoDriver.isRunning() === false,
                "[smoke] not running on load")
            console.assert(window.AesStrategyAutoDriver.ENVELOPE_KEY === "aesStrategy:autoTick:last",
                "[smoke] envelope key stable")
            console.assert(window.AesStrategyAutoDriver.GAME_DAY_KEY === "aesStrategy:autoTick:lastAppliedGameDate",
                "[smoke] game-day key stable")
            // Objective-aware impact filter — share-tilted price moves with
            // negative $/wk impact must pass; profit-max strict mode rejects.
            const passShare = _impactPasses({
                domain: "price",
                _impact: {unit: "$/wk", value: -2500},
                payload: {objective: {kind: "maxShare"}}
            })
            const failProfit = _impactPasses({
                domain: "price",
                _impact: {unit: "$/wk", value: -2500},
                payload: {objective: {kind: "maxProfit"}}
            })
            const passBalanced = _impactPasses({
                domain: "price",
                _impact: {unit: "$/wk", value: -1000},
                payload: {objective: {kind: "balanced"}}
            })
            const failZero = _impactPasses({
                domain: "price",
                _impact: {unit: "$/wk", value: 0},
                payload: {objective: {kind: "balanced"}}
            })
            const failSchedule = _impactPasses({
                domain: "schedule",
                _impact: {unit: "$/wk", value: -500}
            })
            const failNoObj = _impactPasses({
                domain: "price",
                _impact: {unit: "$/wk", value: -1000}
                // payload.objective missing — defaults to strict
            })
            console.assert(passShare === true,
                "[smoke] share-tilted negative-impact price move passes filter")
            console.assert(failProfit === false,
                "[smoke] profit-max negative-impact price move rejected")
            console.assert(passBalanced === true,
                "[smoke] balanced negative-impact price move passes (trust proposer)")
            console.assert(failZero === false,
                "[smoke] zero-impact rejected even on share-tilted price")
            console.assert(failSchedule === false,
                "[smoke] non-price domains stay strict on >0 filter")
            console.assert(failNoObj === false,
                "[smoke] missing objective falls back to strict (defensive)")
        }
    } catch (_) { /* never let smoke break the page */ }

    // Auto-start on every page that loads this module — the driver is
    // tier-gated internally and the start() method is idempotent. This
    // replaces ad-hoc start() calls scattered across hosts (fleet-hub
    // already calls start; without auto-start, the dashboard bundle
    // loaded the driver but never booted it).
    //
    // Tier-gating means apply-auto users get auto-apply on every page;
    // other-tier users have a no-op driver running, which is fine —
    // every tick gates on the tier first and exits in microseconds.
    //
    // Defer to the next tick so the rest of the page load (and any
    // dependency module that hasn't finished registering yet) settles
    // before the first tick / catch-up runs.
    try {
        if (typeof setTimeout === "function") {
            setTimeout(() => {
                start().catch(err => console.warn("[AES auto-driver] auto-start failed", err))
            }, 0)
        }
    } catch (_) { /* never let auto-start break the page */ }
})()
