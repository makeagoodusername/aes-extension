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
    const MIN_INTERVAL_MS = 60_000          // safety floor: 1 minute
    const TOPK_PER_TICK   = 25              // bound rank-target solver work

    let _intervalHandle        = null
    let _lastSuccessfulTickAt  = 0
    let _ticking               = false

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
     * High-confidence predicate — kept identical to
     * `command-center.js:_strategyHighConfDecisions` so the user's
     * "Quick-apply N" count and the auto-tick agree on what's eligible.
     */
    function _highConfDecisions(diff, settings) {
        const ns = window.AesStrategySettings
        if (!diff || !Array.isArray(diff.decisions) || !ns) return []
        return diff.decisions.filter(d => {
            if (!d || !d.applicable) return false
            if (typeof ns.canApply !== "function") return false
            try { if (!ns.canApply(settings, d.domain)) return false }
            catch (_) { return false }
            const im = d._impact
            if (!im || im.unit !== "$/wk") return false
            return Number(im.value) > 0
        })
    }

    async function _finish(startedAt, payload) {
        const env = Object.assign(
            {at: startedAt, durationMs: _now() - startedAt},
            payload
        )
        await _writeEnvelope(env, env.accountId || null)
        return env
    }

    async function _tickOnce(opts) {
        if (_ticking) return {skippedReason: "concurrent"}
        _ticking = true
        const startedAt = _now()
        try {
            // 1. Settings + tier gate
            if (!window.AesStrategySettings
                    || typeof window.AesStrategySettings.load !== "function") {
                return _finish(startedAt, {skippedReason: "settings-missing"})
            }
            const settings = await window.AesStrategySettings.load()
            const tier = window.AesStrategySettings.resolveTier(settings)
            if (tier !== "apply-auto") {
                return _finish(startedAt, {tier: tier, skippedReason: "tier-gate"})
            }

            // 2. Master kill switch
            const auto = (settings && settings.autoTick) || {}
            if (auto.enabled === false) {
                return _finish(startedAt, {tier: tier, skippedReason: "disabled"})
            }

            // 3. Cooldown (bypassed for manual tickNow)
            const cooldownMs = Math.max(0, Number(auto.cooldownMin) || 0) * 60_000
            if (!opts || !opts.bypassCooldown) {
                if (cooldownMs > 0 && _lastSuccessfulTickAt
                        && (startedAt - _lastSuccessfulTickAt) < cooldownMs) {
                    return _finish(startedAt, {tier: tier, skippedReason: "cooldown"})
                }
            }

            // 3a. Velvet Cascade · PR 3 — first-activation ack gate. Block
            // the tick when the user hasn't confirmed apply-auto for the
            // current settingsHash. Skip envelope tells the diagnostics
            // tile (PR 1B) to surface the prompt.
            const ack = await _readAck()
            const expectedHash = _settingsHash(settings)
            if (!ack || ack.settingsHash !== expectedHash) {
                return _finish(startedAt, {
                    tier: tier,
                    skippedReason: "first-activation-required",
                    expectedHash:  expectedHash,
                    storedHash:    ack && ack.settingsHash || null
                })
            }

            // 3b. Silent-auto cap-window — drop the over-cap domains rather
            // than aborting the whole tick (other domains can still fire).
            const capStat = await _capStatus(settings)

            // 4. Compose plan via the same chain Command Center uses
            const ns = window.AesStrategy
            if (!ns || typeof ns.snapshot !== "function"
                    || typeof ns.scoreRoutes !== "function"
                    || typeof ns.allocateFleet !== "function"
                    || typeof ns.diffPlan !== "function") {
                return _finish(startedAt, {tier: tier, skippedReason: "strategy-missing"})
            }

            let snapshot, plan, diff, acctId = null
            try {
                snapshot = await ns.snapshot({})
                acctId = (snapshot && snapshot.accountId) || null
                let weights = null
                if (window.AesStrategyLearn
                        && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
                    try { weights = await window.AesStrategyLearn.getCurrentWeights(acctId) }
                    catch (_) { weights = null }
                }
                const scored = ns.scoreRoutes(snapshot, weights || undefined)
                plan = ns.allocateFleet(snapshot, scored, {})
                diff = ns.diffPlan(plan, snapshot, {})
            } catch (e) {
                return _finish(startedAt, {tier: tier,
                    error: "compose-failed: " + ((e && e.message) || String(e))})
            }

            // 5. Filter to high-conf, then per-domain auto-tick gate, then cap
            let candidates = _highConfDecisions(diff, settings)
            const domainGates = (auto.domains && typeof auto.domains === "object")
                ? auto.domains : {}
            candidates = candidates.filter(d => domainGates[d.domain] !== false)
            // PR 3 — drop domains that have hit the silent-auto 24h cap.
            const droppedByCap = []
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
            const cap = Math.max(0, Number(auto.maxDecisionsPerTick) || 0)
            if (cap > 0 && candidates.length > cap) candidates = candidates.slice(0, cap)
            if (!candidates.length) {
                return _finish(startedAt, {tier: tier,
                    skippedReason: droppedByCap.length ? "all-domains-capped" : "no-decisions",
                    decisionCount:  (diff.decisions || []).length,
                    droppedByCap:   droppedByCap.length ? droppedByCap : undefined,
                    capStatus:      capStat})
            }

            // 6. Apply through existing pipeline (re-checks tier internally)
            if (typeof ns.apply !== "function") {
                return _finish(startedAt, {tier: tier, skippedReason: "pipeline-missing"})
            }
            const ids = candidates.map(d => d.id).filter(Boolean)
            let report
            try {
                report = await ns.apply(plan, {
                    selected: ids,
                    snapshot: snapshot,
                    source:   "auto-driver"
                })
            } catch (e) {
                return _finish(startedAt, {tier: tier,
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
            return _finish(startedAt, {
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
                failedDecisions: failedDecisions.length ? failedDecisions : undefined
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

    async function start() {
        if (_intervalHandle !== null) return
        const ms = await _readIntervalMs()
        _intervalHandle = setInterval(() => {
            _tickOnce().catch(err => console.warn("[AES auto-driver] tick error", err))
        }, ms)
    }

    function stop() {
        if (_intervalHandle === null) return
        clearInterval(_intervalHandle)
        _intervalHandle = null
    }

    async function tickNow() {
        return _tickOnce({bypassCooldown: true})
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
        ENVELOPE_KEY: ENVELOPE_KEY,
        ACK_KEY:      ACK_KEY,
        TOPK_PER_TICK: TOPK_PER_TICK
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof window.AesStrategyAutoDriver.start === "function",
                "[smoke] start() exposed")
            console.assert(window.AesStrategyAutoDriver.isRunning() === false,
                "[smoke] not running on load")
            console.assert(window.AesStrategyAutoDriver.ENVELOPE_KEY === "aesStrategy:autoTick:last",
                "[smoke] envelope key stable")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
