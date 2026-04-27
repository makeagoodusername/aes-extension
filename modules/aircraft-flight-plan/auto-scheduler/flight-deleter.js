"use strict"

/**
 * Track 6 slice 6c — content-side orchestrator for the flight-deleter
 * batch pipeline. Mounts on /app/fleets/aircraft/<id>/0 via the AFP
 * family content-script block. The actual per-flight POST work runs in
 * a hidden tab driven by background.js:_afpRunDeleteBatch; this module
 * is the page-side bridge that:
 *
 *   1. Sends `aes:afp:delete-batch` to background with the flightIds
 *      to delete (typically computed from a schedule-diff result).
 *   2. Listens for `aes:afp:delete-batch:progress` runtime messages
 *      and re-emits them onto the AesAfp bus as `auto-delete:progress`.
 *   3. Mirrors per-flight outcomes into the audit log via
 *      AesAfpAutoApplyLog (source: "flight-deleter").
 *   4. Surfaces a flat `state` snapshot for slice 6d's confirmation
 *      modal (or for diagnostics).
 *
 * Public API (window.AesAfpAutoFlightDeleter):
 *   .start(payload)   → begin a batch. payload shape:
 *                         {ctx, flights[], source?}
 *                       At most one in-flight batch per page.
 *   .abort()          → fire the abort message to background. The
 *                       background closes the hidden tab; the
 *                       in-flight start() Promise resolves with
 *                       {aborted: true}.
 *   .state            → live snapshot {batchId, total, completed,
 *                       succeeded, failed, aborted, startedAt,
 *                       finishedAt, lastError, results, inFlight}
 *
 * Bus contract (out — observed by slice 6d UI + slice 6e wipe pipeline):
 *   auto-delete:start    {batchId, total, ctx, flights, startedAt}
 *   auto-delete:progress {batchId, phase, flightIdx?, flightId?, ok?, error?, ...}
 *   auto-delete:done     {batchId, ok, results, succeeded, failed, finishedAt}
 *   auto-delete:aborted  {batchId, completed}
 *   auto-delete:error    {batchId, error}
 *
 * Tier-gate posture: shares the apply-batch tier gate. The deleter is
 * dormant unless `autoScheduler.enabled === true && tier ===
 * "apply-on-confirm"`. Defensive re-check at start() bails with
 * `{skipped: true, reason: ...}` if disabled.
 */
;(function () {
    if (window.AesAfpAutoFlightDeleter) return

    const _state = {
        batchId:    null,
        total:      0,
        completed:  0,
        succeeded:  0,
        failed:     0,
        aborted:    false,
        startedAt:  null,
        finishedAt: null,
        lastError:  null,
        results:    [],
        flights:    [],
        ctx:        null,
        progressListener: null,
        startResolve:     null
    }

    function _emit(name, payload) {
        const bus = window.AesAfp && window.AesAfp.bus
        if (bus && typeof bus.emit === "function") {
            try { bus.emit("auto-delete:" + name, payload) }
            catch (e) { console.warn("[AES auto-6c] bus emit threw", e) }
        }
    }

    function _logEntry(record) {
        const log = window.AesAfpAutoApplyLog
        if (!log || typeof log.add !== "function") return
        try {
            log.add(record).catch(err =>
                console.warn("[AES auto-6c] log.add rejected", err))
        } catch (e) {
            console.warn("[AES auto-6c] log.add threw", e)
        }
    }

    /**
     * Resolve a flight's metadata from `_state.flights` by index for
     * audit-log enrichment. Falls back to flightId match when the index
     * misses. Returns an empty object when nothing matches.
     */
    function _flightMetaForIdx(flightIdx, flightId) {
        const flights = _state.flights || []
        if (typeof flightIdx === "number" && flights[flightIdx]) {
            return flights[flightIdx]
        }
        if (flightId != null) {
            const found = flights.find(f =>
                f && f.flightId != null && String(f.flightId) === String(flightId))
            if (found) return found
        }
        return {}
    }

    function _resetForNextBatch() {
        if (_state.progressListener) {
            try { chrome.runtime.onMessage.removeListener(_state.progressListener) }
            catch (_) { /* noop */ }
            _state.progressListener = null
        }
        _state.batchId      = null
        _state.startResolve = null
    }

    function _onProgressMessage(msg /*, sender, sendResponse */) {
        if (!msg || msg.type !== "aes:afp:delete-batch:progress") return
        if (msg.batchId !== _state.batchId) return
        if (msg.phase === "flight-done") {
            _state.completed++
            if (msg.ok) {
                _state.succeeded++
            } else {
                _state.failed++
                if (msg.error && !_state.lastError) _state.lastError = msg.error
            }
            _state.results.push({
                flightIdx: msg.flightIdx,
                flightId:  msg.flightId,
                ok:        !!msg.ok,
                error:     msg.error || null,
                at:        Date.now()
            })
            const meta = _flightMetaForIdx(msg.flightIdx, msg.flightId)
            _logEntry({
                batchId:    _state.batchId,
                server:     _state.ctx && _state.ctx.server,
                aircraftId: _state.ctx && _state.ctx.aircraftId,
                hub:        _state.ctx && _state.ctx.currentLocationIata,
                status:     msg.ok ? "ok" : "failed",
                flightIdx:  msg.flightIdx,
                flightId:   msg.flightId,
                origin:     meta.origin,
                dest:       meta.destination,
                depTime:    meta.depTimeLocal || meta.depTime,
                flightCode: meta.flightCode,
                error:      msg.ok ? null : msg.error,
                source:     "flight-deleter"
            })
        }
        _emit("progress", msg)
    }

    /**
     * Begin a delete batch. Idempotent against double-clicks: if a
     * batch is already in flight on this page, returns
     * {ok: false, error: "batch already in flight"} without firing.
     *
     * The returned promise resolves when the background pipeline
     * settles (success, abort, timeout, or error); per-flight results
     * also surface via `auto-delete:progress` events.
     */
    async function start(payload) {
        if (_state.batchId) {
            return {ok: false, error: "batch already in flight (id " + _state.batchId + ")"}
        }
        const p = payload || {}
        const ctxR = (p.ctx && typeof p.ctx === "object")
            ? p.ctx
            : ((window.AesAfp && AesAfp.ctx) || {})
        const flights = Array.isArray(p.flights) ? p.flights.filter(f => f && f.flightId != null) : []
        if (!ctxR.aircraftId) {
            const err = "start: missing ctx.aircraftId"
            _emit("error", {error: err})
            return {ok: false, error: err}
        }
        if (!flights.length) {
            const err = "start: flights[] empty"
            _emit("error", {error: err})
            return {ok: false, error: err}
        }

        // Defensive tier-gate re-check (mirrors apply-batch).
        if (typeof AesAfpSettings !== "undefined") {
            try {
                const s = await AesAfpSettings.load()
                const a = s && s.autoScheduler
                if (!a || a.enabled !== true || a.tier !== "apply-on-confirm") {
                    const reason = "autoScheduler tier gate dormant"
                        + " (enabled=" + ((a && a.enabled) ? "true" : "false")
                        + ", tier=" + ((a && a.tier) || "?") + ")"
                    _emit("error", {error: reason})
                    return {ok: false, error: reason, skipped: true}
                }
                const cap = Number(a.maxLegsPerApply) || 28
                if (flights.length > cap) {
                    const reason = "flights.length " + flights.length + " > maxLegsPerApply " + cap
                    _emit("error", {error: reason})
                    return {ok: false, error: reason, skipped: true}
                }
            } catch (e) {
                console.warn("[AES auto-6c] settings re-check failed; proceeding", e)
            }
        }

        _state.batchId    = null
        _state.total      = flights.length
        _state.completed  = 0
        _state.succeeded  = 0
        _state.failed     = 0
        _state.aborted    = false
        _state.startedAt  = Date.now()
        _state.finishedAt = null
        _state.lastError  = null
        _state.results    = []
        _state.flights    = flights.slice()
        _state.ctx        = {
            server:               ctxR.server               || "",
            aircraftId:           String(ctxR.aircraftId    || ""),
            currentLocationIata:  ctxR.currentLocationIata  || ""
        }

        const generatedBatchId = "del-" + Date.now().toString(36)
            + "-" + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        _state.batchId = generatedBatchId

        _state.progressListener = _onProgressMessage
        chrome.runtime.onMessage.addListener(_state.progressListener)

        _emit("start", {
            batchId:   generatedBatchId,
            total:     _state.total,
            ctx:       _state.ctx,
            flights:   _state.flights.slice(),
            startedAt: _state.startedAt
        })
        _logEntry({
            ts:         _state.startedAt,
            batchId:    generatedBatchId,
            server:     _state.ctx.server,
            aircraftId: _state.ctx.aircraftId,
            hub:        _state.ctx.currentLocationIata,
            status:     "started",
            total:      _state.total,
            source:     (p.source && String(p.source).slice(0, 32)) || "flight-deleter"
        })

        return new Promise((resolve) => {
            _state.startResolve = resolve
            try {
                chrome.runtime.sendMessage({
                    type:       "aes:afp:delete-batch",
                    aircraftId: _state.ctx.aircraftId,
                    batchId:    generatedBatchId,
                    flights:    _state.flights
                }, (resp) => {
                    const lastErr = chrome.runtime.lastError
                    _state.finishedAt = Date.now()
                    if (lastErr) {
                        _state.lastError = lastErr.message || "runtime error"
                        _emit("error", {batchId: generatedBatchId, error: _state.lastError})
                        const out = {ok: false, error: _state.lastError, batchId: generatedBatchId,
                                     results: _state.results.slice(), total: _state.total}
                        _resetForNextBatch()
                        resolve(out)
                        return
                    }
                    const ok = !!(resp && resp.ok)
                    if (resp && resp.error && !_state.lastError) _state.lastError = resp.error
                    if (resp && resp.aborted) _state.aborted = true
                    _emit(_state.aborted ? "aborted" : "done", {
                        batchId:    generatedBatchId,
                        ok:         ok,
                        results:    _state.results.slice(),
                        succeeded:  _state.succeeded,
                        failed:     _state.failed,
                        aborted:    _state.aborted,
                        error:      _state.lastError,
                        finishedAt: _state.finishedAt
                    })
                    _logEntry({
                        ts:         _state.finishedAt,
                        batchId:    generatedBatchId,
                        server:     _state.ctx && _state.ctx.server,
                        aircraftId: _state.ctx && _state.ctx.aircraftId,
                        hub:        _state.ctx && _state.ctx.currentLocationIata,
                        status:     _state.aborted ? "aborted"
                                  : _state.lastError ? "error"
                                  : "done",
                        total:      _state.total,
                        succeeded:  _state.succeeded,
                        failed:     _state.failed,
                        elapsedMs:  _state.finishedAt - _state.startedAt,
                        error:      _state.lastError || null,
                        source:     "flight-deleter"
                    })
                    const out = Object.assign({},
                        resp || {ok: false},
                        {batchId: generatedBatchId, results: _state.results.slice()})
                    _resetForNextBatch()
                    resolve(out)
                })
            } catch (e) {
                _state.lastError = (e && e.message) || String(e)
                _state.finishedAt = Date.now()
                _emit("error", {batchId: generatedBatchId, error: _state.lastError})
                const out = {ok: false, error: _state.lastError, batchId: generatedBatchId,
                             results: _state.results.slice(), total: _state.total}
                _resetForNextBatch()
                resolve(out)
            }
        })
    }

    /**
     * Abort the in-flight batch. Sends `aes:afp:delete-batch:abort` to
     * background.js, which closes the hidden tab. The original start
     * promise resolves shortly after with `{aborted: true}`. Returns
     * `false` if no batch is in flight.
     */
    function abort() {
        if (!_state.batchId) return false
        _state.aborted = true
        try {
            chrome.runtime.sendMessage({
                type:    "aes:afp:delete-batch:abort",
                batchId: _state.batchId
            }, () => { void chrome.runtime.lastError })
        } catch (e) {
            console.warn("[AES auto-6c] abort sendMessage threw", e)
        }
        _emit("aborted", {batchId: _state.batchId, completed: _state.completed})
        return true
    }

    function snapshot() {
        return {
            batchId:    _state.batchId,
            total:      _state.total,
            completed:  _state.completed,
            succeeded:  _state.succeeded,
            failed:     _state.failed,
            aborted:    _state.aborted,
            startedAt:  _state.startedAt,
            finishedAt: _state.finishedAt,
            lastError:  _state.lastError,
            results:    _state.results.slice(),
            inFlight:   _state.batchId != null
        }
    }

    window.AesAfpAutoFlightDeleter = {
        start: start,
        abort: abort,
        get state() { return snapshot() }
    }

    // ── ?aes-debug smoke tests (no test runner — project convention) ───
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof window.AesAfpAutoFlightDeleter.start === "function",
                "[AES auto-6c smoke] start() exposed")
            console.assert(typeof window.AesAfpAutoFlightDeleter.abort === "function",
                "[AES auto-6c smoke] abort() exposed")
            console.assert(typeof window.AesAfpAutoFlightDeleter.state === "object"
                && window.AesAfpAutoFlightDeleter.state.inFlight === false,
                "[AES auto-6c smoke] initial state.inFlight === false")
            console.assert(window.AesAfpAutoFlightDeleter.abort() === false,
                "[AES auto-6c smoke] abort() returns false when no batch in flight")
            // Bail-paths (both return before any audit-log write or
            // sendMessage dispatch — pure validation).
            window.AesAfpAutoFlightDeleter.start({ctx: {aircraftId: "0"}, flights: []})
                .then(r => console.assert(!r.ok && /empty/.test(r.error || ""),
                    "[AES auto-6c smoke] empty flights[] rejected"))
            window.AesAfpAutoFlightDeleter.start({ctx: {}, flights: [{flightId: "1"}]})
                .then(r => console.assert(!r.ok && /aircraftId/.test(r.error || ""),
                    "[AES auto-6c smoke] missing aircraftId rejected"))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
