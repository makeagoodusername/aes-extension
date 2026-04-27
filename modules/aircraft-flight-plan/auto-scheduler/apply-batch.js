"use strict"

/**
 * Track 5 slice 5c — content-side orchestrator for the Apply-all batch
 * pipeline. Mounts on `/app/fleets/aircraft/<id>/0` via the AFP family
 * content-script block. The actual per-leg fill+submit work runs in a
 * hidden tab driven by `background.js:_afpRunBatchSubmit`; this module
 * is the page-side bridge that:
 *
 *   1. Sends the `aes:afp:apply-batch` message to background.js with
 *      the materialised leg list from the preview panel.
 *   2. Listens for `aes:afp:apply-batch:progress` runtime messages and
 *      re-emits them onto the AesAfp bus as `auto-apply:progress`.
 *   3. Mirrors per-leg outcomes into `AesAfpActiveDraftStore.appliedLegs`
 *      so the Fleet Hub overlay tab shows applied legs in green within
 *      ~200ms of each background completion.
 *   4. Surfaces a flat `state` snapshot for slice 5d's progress UI to
 *      poll (or for diagnostics).
 *
 * Public API (window.AesAfpAutoApplyBatch):
 *   .start(payload)   → begin a batch (payload from preview-panel
 *                        `_applyAll`). At most one in-flight batch
 *                        per page.
 *   .abort()          → fire the abort message to background.js. The
 *                        background closes the hidden tab; the
 *                        in-flight `start()` Promise resolves with
 *                        `{aborted: true}`.
 *   .state            → live snapshot {batchId, total, completed,
 *                        succeeded, failed, aborted, startedAt,
 *                        finishedAt, lastError, results}
 *
 * Bus contract (out — observed by slice 5d UI + slice 5e audit log):
 *   auto-apply:start    {batchId, total, ctx, legs, startedAt}
 *   auto-apply:progress {batchId, phase, legIdx?, seq?, ok?, error?, ...}
 *   auto-apply:done     {batchId, ok, results, succeeded, failed, finishedAt}
 *   auto-apply:aborted  {batchId, completed}
 *   auto-apply:error    {batchId, error}
 *
 * Tier gate posture: this module is reachable ONLY through the preview
 * panel's confirmation modal (slice 5b), which already enforces the
 * `autoScheduler.enabled === true && tier === "apply-on-confirm"`
 * tier gate. Defensive: `start()` re-checks the gate via a settings
 * fetch and bails with `{skipped: true, reason: ...}` if disabled.
 */
;(function () {
    if (window.AesAfpAutoApplyBatch) return

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
        legs:       [],
        ctx:        null,
        progressListener: null,
        startResolve:     null
    }

    function _emit(name, payload) {
        const bus = window.AesAfp && window.AesAfp.bus
        if (bus && typeof bus.emit === "function") {
            try { bus.emit("auto-apply:" + name, payload) }
            catch (e) { console.warn("[AES auto-5c] bus emit threw", e) }
        }
    }

    /**
     * Slice 5e — write a single audit-log entry. Defensive against
     * AesAfpAutoApplyLog being absent (manifest order regression);
     * never throws, never blocks the pipeline.
     */
    function _logEntry(record) {
        const log = window.AesAfpAutoApplyLog
        if (!log || typeof log.add !== "function") return
        try {
            log.add(record).catch(err =>
                console.warn("[AES auto-5e] log.add rejected", err))
        } catch (e) {
            console.warn("[AES auto-5e] log.add threw", e)
        }
    }

    /**
     * Resolve a leg's metadata (origin, dest, depTime, …) from `_state.legs`
     * by index for audit-log enrichment. Falls back to seq lookup when
     * legIdx isn't present. Returns an empty object when nothing matches.
     */
    function _legMetaForIdx(legIdx, seq) {
        const legs = _state.legs || []
        if (typeof legIdx === "number" && legs[legIdx]) {
            return legs[legIdx]
        }
        if (seq != null) {
            const found = legs.find(l => l && l.seq != null && String(l.seq) === String(seq))
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
        _state.batchId    = null
        _state.startResolve = null
    }

    /**
     * Backdate the cached Schedule's scrapedAt by 1h so consumers' isFresh
     * checks fall through to a live read until the next AFP page scrape.
     * Called on every batch settle (success / partial / abort / error).
     */
    function _markScheduleStale(ctx) {
        try {
            if (typeof AesAfpScheduleStore === "undefined") return
            if (!ctx || !ctx.server || !ctx.aircraftId) return
            AesAfpScheduleStore.markStale(ctx.server, ctx.aircraftId)
                .catch(err => console.warn("[AES auto-7e] markStale failed", err))
        } catch (e) {
            console.warn("[AES auto-7e] markStale threw", e)
        }
    }

    /**
     * Mirror a successful leg into the active draft so the Fleet Hub
     * overlay tab repaints via chrome.storage.onChanged within ~200ms.
     * Read-modify-write through the store helper so concurrent edits
     * (manual leg apply on a different tab) merge correctly.
     */
    function _markAppliedInDraft(seq) {
        if (seq == null) return
        const ctx = _state.ctx || {}
        if (!ctx.server || !ctx.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        AesAfpActiveDraftStore.setApplied(ctx.server, ctx.aircraftId, seq, Date.now())
            .catch(err => console.warn("[AES auto-5c] mark-applied persist failed", err))
    }

    function _onProgressMessage(msg /*, sender, sendResponse */) {
        if (!msg || msg.type !== "aes:afp:apply-batch:progress") return
        if (msg.batchId !== _state.batchId) return
        if (msg.phase === "leg-done") {
            _state.completed++
            if (msg.ok) {
                _state.succeeded++
                _markAppliedInDraft(msg.seq)
            } else {
                _state.failed++
                if (msg.error && !_state.lastError) _state.lastError = msg.error
            }
            _state.results.push({
                legIdx: msg.legIdx,
                seq:    msg.seq,
                ok:     !!msg.ok,
                error:  msg.error || null,
                at:     Date.now()
            })
            // Slice 5e — persist per-leg outcome for the retry queue.
            const meta = _legMetaForIdx(msg.legIdx, msg.seq)
            _logEntry({
                batchId:    _state.batchId,
                server:     _state.ctx && _state.ctx.server,
                aircraftId: _state.ctx && _state.ctx.aircraftId,
                hub:        _state.ctx && _state.ctx.currentLocationIata,
                status:     msg.ok ? "ok" : "failed",
                legIdx:     msg.legIdx,
                seq:        msg.seq,
                origin:     meta.origin,
                dest:       meta.destination,
                depTime:    meta.depTime,
                pricePct:   meta.pricePct,
                service:    meta.service,
                direction:  meta.direction,
                waveLabel:  meta.waveLabel,
                error:      msg.ok ? null : msg.error,
                source:     "apply-batch"
            })
        }
        _emit("progress", msg)
    }

    /**
     * Begin a batch. Idempotent against double-clicks: if a batch is
     * already in flight on this page, returns a rejection-shaped
     * `{ok: false, error: "batch already in flight"}` without firing.
     *
     * The returned promise resolves when the background pipeline
     * settles (success, abort, timeout, or error); the per-leg results
     * are also surfaced via `auto-apply:progress` events.
     */
    async function start(payload) {
        if (_state.batchId) {
            return {ok: false, error: "batch already in flight (id " + _state.batchId + ")"}
        }
        const p = payload || {}
        const ctxR = (p.ctx && typeof p.ctx === "object")
            ? p.ctx
            : ((window.AesAfp && AesAfp.ctx) || {})
        const rawLegs = Array.isArray(p.legs) ? p.legs : []
        // Track 7 slice 7e — never delete or overwrite a locked leg.
        // Locked = the AS UI surfaced an immutable marker on the .block.flight
        // (e.g. system-managed legs we don't own). The diff engine routes
        // unmatched locked legs to result.locked instead of result.delete;
        // here we belt-and-braces filter them out of the apply payload too.
        const skippedLocked = []
        const legs = []
        for (const leg of rawLegs) {
            if (leg && leg.modifiers && leg.modifiers.locked === true) {
                skippedLocked.push(leg)
            } else {
                legs.push(leg)
            }
        }
        if (skippedLocked.length) {
            console.warn("[AES auto-7e] apply-batch: skipped " + skippedLocked.length
                + " locked leg(s) — they're owned by AS, not us")
        }
        if (!ctxR.aircraftId) {
            const err = "start: missing ctx.aircraftId"
            _emit("error", {error: err})
            return {ok: false, error: err}
        }
        if (!legs.length) {
            const err = skippedLocked.length
                ? "start: legs[] empty after skipping " + skippedLocked.length + " locked leg(s)"
                : "start: legs[] empty"
            _emit("error", {error: err})
            return {ok: false, error: err}
        }

        // Defensive tier-gate re-check (slice 5b also enforces).
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
                // Soft cap — also enforced in preview-panel; double-check.
                const cap = Number(a.maxLegsPerApply) || 28
                if (legs.length > cap) {
                    const reason = "legs.length " + legs.length + " > maxLegsPerApply " + cap
                    _emit("error", {error: reason})
                    return {ok: false, error: reason, skipped: true}
                }
            } catch (e) {
                console.warn("[AES auto-5c] settings re-check failed; proceeding", e)
            }
        }

        // Reset state for the new batch.
        _state.batchId    = null   // assigned post-dispatch
        _state.total      = legs.length
        _state.completed  = 0
        _state.succeeded  = 0
        _state.failed     = 0
        _state.aborted    = false
        _state.startedAt  = Date.now()
        _state.finishedAt = null
        _state.lastError  = null
        _state.results    = []
        _state.legs       = legs.slice()
        _state.ctx        = {
            server:               ctxR.server               || "",
            aircraftId:           String(ctxR.aircraftId    || ""),
            currentLocationIata:  ctxR.currentLocationIata  || ""
        }

        const generatedBatchId = "b-" + Date.now().toString(36)
            + "-" + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        _state.batchId = generatedBatchId

        // Attach progress listener BEFORE dispatch so we don't drop the
        // first 'queued' / 'tab-opened' progress message.
        _state.progressListener = _onProgressMessage
        chrome.runtime.onMessage.addListener(_state.progressListener)

        _emit("start", {
            batchId:   generatedBatchId,
            total:     _state.total,
            ctx:       _state.ctx,
            legs:      _state.legs.slice(),
            startedAt: _state.startedAt
        })
        // Slice 5e — open the audit-log batch lifecycle entry.
        _logEntry({
            ts:         _state.startedAt,
            batchId:    generatedBatchId,
            server:     _state.ctx.server,
            aircraftId: _state.ctx.aircraftId,
            hub:        _state.ctx.currentLocationIata,
            status:     "started",
            total:      _state.total,
            source:     (p.source && String(p.source).slice(0, 32)) || "preview-panel"
        })

        // Dispatch to background.js. The promise the caller gets back
        // resolves on completion; per-leg progress flows through the
        // separate progress listener.
        return new Promise((resolve) => {
            _state.startResolve = resolve
            try {
                chrome.runtime.sendMessage({
                    type:       "aes:afp:apply-batch",
                    aircraftId: _state.ctx.aircraftId,
                    batchId:    generatedBatchId,
                    legs:       _state.legs
                }, (resp) => {
                    const lastErr = chrome.runtime.lastError
                    _state.finishedAt = Date.now()
                    if (lastErr) {
                        _state.lastError = lastErr.message || "runtime error"
                        _emit("error", {batchId: generatedBatchId, error: _state.lastError})
                        _markScheduleStale(_state.ctx)
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
                        batchId:   generatedBatchId,
                        ok:        ok,
                        results:   _state.results.slice(),
                        succeeded: _state.succeeded,
                        failed:    _state.failed,
                        aborted:   _state.aborted,
                        error:     _state.lastError,
                        finishedAt: _state.finishedAt
                    })
                    // Slice 5e — close out the batch lifecycle entry.
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
                        source:     "apply-batch"
                    })
                    const out = Object.assign({},
                        resp || {ok: false},
                        {batchId: generatedBatchId, results: _state.results.slice()})
                    _markScheduleStale(_state.ctx)
                    _resetForNextBatch()
                    resolve(out)
                })
            } catch (e) {
                _state.lastError = (e && e.message) || String(e)
                _state.finishedAt = Date.now()
                _emit("error", {batchId: generatedBatchId, error: _state.lastError})
                _markScheduleStale(_state.ctx)
                const out = {ok: false, error: _state.lastError, batchId: generatedBatchId,
                             results: _state.results.slice(), total: _state.total}
                _resetForNextBatch()
                resolve(out)
            }
        })
    }

    /**
     * Abort the in-flight batch. Sends `aes:afp:apply-batch:abort` to
     * background.js, which closes the hidden tab. The original `start`
     * promise resolves shortly after with `{aborted: true}`. Returns
     * `false` if no batch is in flight.
     */
    function abort() {
        if (!_state.batchId) return false
        _state.aborted = true
        try {
            chrome.runtime.sendMessage({
                type:    "aes:afp:apply-batch:abort",
                batchId: _state.batchId
            }, () => { void chrome.runtime.lastError })
        } catch (e) {
            console.warn("[AES auto-5c] abort sendMessage threw", e)
        }
        _emit("aborted", {batchId: _state.batchId, completed: _state.completed})
        return true
    }

    /**
     * Live snapshot for slice 5d's progress UI. Returns a defensive copy
     * — callers can't mutate internal state by holding the reference.
     */
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

    window.AesAfpAutoApplyBatch = {
        start:  start,
        abort:  abort,
        get state() { return snapshot() }
    }

    // ── ?aes-debug smoke tests (no test runner — project convention) ───
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof window.AesAfpAutoApplyBatch.start === "function",
                "[AES auto-5c smoke] start() exposed")
            console.assert(typeof window.AesAfpAutoApplyBatch.abort === "function",
                "[AES auto-5c smoke] abort() exposed")
            console.assert(typeof window.AesAfpAutoApplyBatch.state === "object"
                && window.AesAfpAutoApplyBatch.state.inFlight === false,
                "[AES auto-5c smoke] initial state.inFlight === false")
            // Empty-payload bail-path.
            window.AesAfpAutoApplyBatch.start({ctx: {aircraftId: "0"}, legs: []})
                .then(r => console.assert(!r.ok && /empty/.test(r.error || ""),
                    "[AES auto-5c smoke] empty legs rejected"))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
