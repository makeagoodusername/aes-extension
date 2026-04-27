"use strict"

/**
 * Track 8 slice 8a — fleet-wide apply orchestrator.
 *
 * Loops `aes:afp:apply-batch` per aircraft serially, aggregating per-leg
 * progress into a single fleet-level event stream. Standalone (does NOT
 * call `AesAfpAutoApplyBatch`) so it works on pages where the AFP-page
 * batch shim isn't loaded — i.e. the route-assistant Wave View on
 * `/app/com/scheduling/<HUB>` can fire fleet apply directly.
 *
 * The background `_afpRunBatchSubmit` pipeline already serialises per
 * aircraft via `_afpEnqueueOnAircraft` and uses hidden tabs; this
 * orchestrator just sequences N aircraft in turn so any single hidden
 * tab is the only one open at a time.
 *
 * Audit: each per-aircraft outcome is logged via `AesAfpAutoApplyLog`
 * (Track 5e) when present, so the existing audit log surfaces fleet
 * apply runs alongside per-aircraft applies.
 *
 * Public API (window.AesAfpFleetApplyOrchestrator):
 *   .start(opts) → Promise<{ok, perAircraft, aborted, totalSucceeded,
 *                            totalFailed, runId}>
 *   .abort()    → bool — abort the in-flight aircraft + cancel queued
 *   .state      → live snapshot
 *
 * opts shape:
 *   {
 *     runs:    [{aircraftId, legs[], hub?, currentLockedStays?}],
 *     ctx:     {server},
 *     source:  string                  // 'wave-designer-fleet' | 'wave-applier-fleet' | …
 *     forceReplaceLocked: bool         // when true, prepend delete-batch for currentLockedStays
 *     onAircraftStart?:    function    // optional callback (audit / UI hooks)
 *     onAircraftDone?:     function
 *   }
 *
 * Bus events (window.AesAfp.bus when loaded; also chrome.runtime broadcast):
 *   fleet-apply:start          {runId, total, runs}
 *   fleet-apply:aircraft-start {runId, aircraftId, idx, total}
 *   fleet-apply:aircraft-progress {runId, aircraftId, idx, msg} — mirror of leg progress
 *   fleet-apply:aircraft-done  {runId, aircraftId, idx, ok, succeeded, failed}
 *   fleet-apply:aborted        {runId, completed, total}
 *   fleet-apply:done           {runId, perAircraft}
 *
 * Tier-gate posture: relies on the per-aircraft apply-batch's tier
 * check (`autoScheduler.enabled === true && tier === "apply-on-confirm"`).
 * The orchestrator does not re-check itself; if the gate is dormant the
 * first aircraft will fail with `{skipped: true}` and the orchestrator
 * propagates that to all queued aircraft (short-circuits with `aborted`).
 */
;(function () {
    if (window.AesAfpFleetApplyOrchestrator) return

    const _state = {
        runId:           null,
        runs:            [],
        idx:             0,
        ctx:             null,
        source:          null,
        aborted:         false,
        startedAt:       null,
        finishedAt:      null,
        perAircraft:     [],
        currentBatchId:  null,
        currentAircraft: null,
        progressListener: null,
        startResolve:    null
    }

    function _emit(name, payload) {
        const bus = window.AesAfp && window.AesAfp.bus
        if (bus && typeof bus.emit === "function") {
            try { bus.emit("fleet-apply:" + name, payload) }
            catch (e) { console.warn("[AES auto-8a] bus emit threw", e) }
        }
    }

    function _logEntry(record) {
        const log = window.AesAfpAutoApplyLog
        if (!log || typeof log.add !== "function") return
        try {
            log.add(record).catch(err =>
                console.warn("[AES auto-8a] log.add rejected", err))
        } catch (e) {
            console.warn("[AES auto-8a] log.add threw", e)
        }
    }

    function _detachProgress() {
        if (_state.progressListener) {
            try { chrome.runtime.onMessage.removeListener(_state.progressListener) }
            catch (_) { /* noop */ }
            _state.progressListener = null
        }
    }

    function _resetForNextRun() {
        _detachProgress()
        _state.runId           = null
        _state.runs            = []
        _state.idx             = 0
        _state.ctx             = null
        _state.source          = null
        _state.aborted         = false
        _state.currentBatchId  = null
        _state.currentAircraft = null
        _state.startResolve    = null
        // perAircraft survives until next start() so callers can read .state.
    }

    /**
     * Send aes:afp:apply-batch for one aircraft and await background's
     * sendMessage callback. Returns a per-aircraft result regardless of
     * outcome — never throws. Wires a progress listener that filters to
     * this batchId so cross-aircraft progress doesn't leak.
     */
    function _runOneAircraft(run) {
        return new Promise((resolve) => {
            const aircraftId = String(run.aircraftId || "")
            const legs = Array.isArray(run.legs) ? run.legs : []
            if (!aircraftId || !legs.length) {
                resolve({aircraftId, ok: false, succeeded: 0, failed: 0,
                         error: "missing aircraftId or empty legs"})
                return
            }
            const batchId = "fb-" + Date.now().toString(36)
                + "-" + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
            _state.currentBatchId  = batchId
            _state.currentAircraft = aircraftId

            let succeeded = 0
            let failed    = 0
            let lastError = null

            const onProgress = (msg) => {
                if (!msg) return
                if (msg.type !== "aes:afp:apply-batch:progress") return
                if (msg.batchId !== batchId) return
                if (msg.phase === "leg-done") {
                    if (msg.ok) succeeded++
                    else        { failed++; if (msg.error && !lastError) lastError = msg.error }
                }
                _emit("aircraft-progress", {
                    runId:      _state.runId,
                    aircraftId: aircraftId,
                    idx:        _state.idx,
                    msg:        msg
                })
            }
            _state.progressListener = onProgress
            try { chrome.runtime.onMessage.addListener(onProgress) }
            catch (_) { /* noop */ }

            try {
                chrome.runtime.sendMessage({
                    type:       "aes:afp:apply-batch",
                    aircraftId: aircraftId,
                    batchId:    batchId,
                    legs:       legs
                }, (resp) => {
                    _detachProgress()
                    const lastErr = chrome.runtime.lastError
                    if (lastErr) {
                        resolve({aircraftId, ok: false, succeeded, failed,
                                 error: lastErr.message || "runtime error", batchId})
                        return
                    }
                    const ok = !!(resp && resp.ok)
                    if (resp && resp.error && !lastError) lastError = resp.error
                    resolve({aircraftId, ok, succeeded, failed,
                             aborted: !!(resp && resp.aborted),
                             skipped: !!(resp && resp.skipped),
                             error:   lastError || (resp && resp.error) || null,
                             batchId})
                })
            } catch (e) {
                _detachProgress()
                resolve({aircraftId, ok: false, succeeded, failed,
                         error: (e && e.message) || String(e), batchId})
            }
        })
    }

    /**
     * Override path — fire delete-batch for current-locked stays before
     * the apply runs. Best-effort (locked legs may not actually be
     * deletable). Returns a result for audit purposes; caller doesn't
     * branch on it.
     */
    function _runOverrideDelete(aircraftId, ctx, currentLockedStays) {
        return new Promise((resolve) => {
            const flights = (currentLockedStays || [])
                .filter(l => l && l.flightId != null)
                .map(l => ({
                    flightId:    String(l.flightId),
                    origin:      l.origin || "",
                    destination: l.destination || "",
                    depTime:     l.depTimeLocal || ""
                }))
            if (!flights.length) { resolve({ok: true, skipped: true}); return }
            const batchId = "fd-" + Date.now().toString(36)
                + "-" + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
            try {
                chrome.runtime.sendMessage({
                    type:       "aes:afp:delete-batch",
                    aircraftId: aircraftId,
                    batchId:    batchId,
                    flights:    flights
                }, (resp) => {
                    if (chrome.runtime.lastError) {
                        resolve({ok: false, error: chrome.runtime.lastError.message})
                        return
                    }
                    resolve(resp || {ok: false, error: "no response"})
                })
            } catch (e) {
                resolve({ok: false, error: (e && e.message) || String(e)})
            }
        })
    }

    /**
     * Start a fleet apply run. Idempotent against double-clicks.
     */
    async function start(opts) {
        if (_state.runId) {
            return {ok: false, error: "fleet-apply already in flight (id " + _state.runId + ")"}
        }
        const o = opts || {}
        const runs = Array.isArray(o.runs) ? o.runs.filter(r => r && r.aircraftId && Array.isArray(r.legs) && r.legs.length) : []
        if (!runs.length) {
            return {ok: false, error: "runs[] empty (no aircraft × legs to apply)"}
        }
        const ctx = o.ctx && typeof o.ctx === "object" ? o.ctx : {}
        const source = (o.source && String(o.source).slice(0, 32)) || "fleet-apply"
        const forceReplaceLocked = !!o.forceReplaceLocked
        const runId = "fr-" + Date.now().toString(36)
            + "-" + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")

        _state.runId       = runId
        _state.runs        = runs.slice()
        _state.idx         = 0
        _state.ctx         = ctx
        _state.source      = source
        _state.aborted     = false
        _state.startedAt   = Date.now()
        _state.finishedAt  = null
        _state.perAircraft = []

        _emit("start", {runId, total: runs.length,
                        runs: runs.map(r => ({aircraftId: r.aircraftId, legCount: r.legs.length}))})
        _logEntry({
            ts:        _state.startedAt,
            runId:     runId,
            server:    ctx.server || "",
            status:    "started",
            total:     runs.length,
            source:    source
        })

        let totalSucceeded = 0
        let totalFailed    = 0

        for (let i = 0; i < runs.length; i++) {
            if (_state.aborted) break
            const run = runs[i]
            _state.idx = i
            _emit("aircraft-start", {
                runId, aircraftId: run.aircraftId, idx: i, total: runs.length
            })
            if (typeof o.onAircraftStart === "function") {
                try { o.onAircraftStart({aircraftId: run.aircraftId, idx: i, total: runs.length}) }
                catch (e) { console.warn("[AES auto-8a] onAircraftStart threw", e) }
            }

            // Optional override delete pre-step.
            if (forceReplaceLocked && Array.isArray(run.currentLockedStays) && run.currentLockedStays.length) {
                await _runOverrideDelete(run.aircraftId, ctx, run.currentLockedStays)
            }
            if (_state.aborted) break

            const result = await _runOneAircraft(run)
            _state.perAircraft.push(result)
            if (result.aborted) _state.aborted = true
            totalSucceeded += result.succeeded || 0
            totalFailed    += result.failed    || 0

            _emit("aircraft-done", {
                runId, aircraftId: run.aircraftId, idx: i,
                ok: result.ok, succeeded: result.succeeded, failed: result.failed,
                error: result.error || null
            })
            if (typeof o.onAircraftDone === "function") {
                try { o.onAircraftDone({aircraftId: run.aircraftId, idx: i, result: result}) }
                catch (e) { console.warn("[AES auto-8a] onAircraftDone threw", e) }
            }

            // Tier-gate or hard error → don't keep churning queued runs.
            if (result.skipped || (result.error && /tier gate dormant|maxLegsPerApply/i.test(String(result.error)))) {
                _state.aborted = true
                break
            }
        }

        _state.finishedAt = Date.now()
        const done = {
            runId,
            ok:              !_state.aborted,
            aborted:         _state.aborted,
            perAircraft:     _state.perAircraft.slice(),
            totalSucceeded,
            totalFailed,
            elapsedMs:       _state.finishedAt - _state.startedAt
        }
        _emit(_state.aborted ? "aborted" : "done", done)
        _logEntry({
            ts:        _state.finishedAt,
            runId:     runId,
            server:    ctx.server || "",
            status:    _state.aborted ? "aborted" : "done",
            total:     runs.length,
            succeeded: totalSucceeded,
            failed:    totalFailed,
            elapsedMs: done.elapsedMs,
            source:    source
        })
        _resetForNextRun()
        return done
    }

    /**
     * Abort: send the per-aircraft abort message to background AND set
     * _state.aborted so the loop short-circuits before the next aircraft.
     */
    function abort() {
        if (!_state.runId) return false
        _state.aborted = true
        if (_state.currentBatchId) {
            try {
                chrome.runtime.sendMessage({
                    type:    "aes:afp:apply-batch:abort",
                    batchId: _state.currentBatchId
                }, () => { void chrome.runtime.lastError })
            } catch (e) {
                console.warn("[AES auto-8a] abort sendMessage threw", e)
            }
        }
        _emit("aborted", {runId: _state.runId, completed: _state.perAircraft.length,
                          total: _state.runs.length})
        return true
    }

    function snapshot() {
        return {
            runId:           _state.runId,
            inFlight:        _state.runId != null,
            idx:             _state.idx,
            total:           _state.runs.length,
            currentAircraft: _state.currentAircraft,
            startedAt:       _state.startedAt,
            finishedAt:      _state.finishedAt,
            aborted:         _state.aborted,
            perAircraft:     _state.perAircraft.slice()
        }
    }

    window.AesAfpFleetApplyOrchestrator = {
        start: start,
        abort: abort,
        get state() { return snapshot() }
    }

    // ── ?aes-debug smoke tests ────────────────────────────────────────
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof window.AesAfpFleetApplyOrchestrator.start === "function",
                "[AES auto-8a smoke] start() exposed")
            console.assert(typeof window.AesAfpFleetApplyOrchestrator.abort === "function",
                "[AES auto-8a smoke] abort() exposed")
            console.assert(window.AesAfpFleetApplyOrchestrator.state.inFlight === false,
                "[AES auto-8a smoke] initial state.inFlight === false")
            // Empty runs → early bail.
            window.AesAfpFleetApplyOrchestrator.start({runs: [], ctx: {}, source: "smoke"})
                .then(r => console.assert(!r.ok && /empty/.test(r.error || ""),
                    "[AES auto-8a smoke] empty runs rejected"))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
