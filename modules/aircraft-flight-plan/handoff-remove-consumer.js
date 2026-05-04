"use strict"

/**
 * Slice D1 — AFP-side consumer for handoff records with kind:"removeRoute"
 * or kind:"moveRoute". Mounts on the aircraft-flight-plan page (same scope
 * as wave-applier).
 *
 * Behaviour:
 *   - On AesAfp.ctx ready, peek the handoff store. If the top record's
 *     `aircraftId` matches and its `kind` is removeRoute/moveRoute, claim
 *     it via consume(aircraftId).
 *   - For removeRoute: locate the matching flight(s) in the active VFP
 *     parse via AesAfpVfpReader (preferred) or the wave-applier's last
 *     build (fallback). Surface a preview line in the AFP overview rail.
 *   - For moveRoute: same removeRoute handling, then enqueue an addRoute
 *     for `targetAircraftId` via AesHandoffQueue so the next page load
 *     resumes the move.
 *   - Live writer: when settings.aircraftFlightPlan.apply.enabled === true
 *     AND settings.aircraftFlightPlan.apply.dryRunOnly !== true AND
 *     AesAfpAutoFlightDeleter is available with autoScheduler tier
 *     "apply-on-confirm", invoke deleter.start with the resolved flightIds.
 *     Otherwise, dry-run: log to AesAfpAutoApplyLog only and toast.
 *
 * Inviolable rule audit:
 *   1. No new POST path. Live writes route through the existing
 *      AesAfpAutoFlightDeleter pipeline.
 *   2. No new storage prefix. Reuses _shared:handoff:wave-designer (via
 *      AesHandoffStore.consume) and AesAfpAutoApplyLog.
 *   3. apply.enabled + apply.dryRunOnly default false → no live behaviour
 *      change without an explicit user opt-in.
 */
;(function () {
    if (typeof window === "undefined" || window.AesAfpHandoffRemoveConsumer) return

    const _state = {consumed: false, lastRecord: null}

    function _bus() { return (window.AesAfp && window.AesAfp.bus) || null }
    function _ctx() { return (window.AesAfp && window.AesAfp.ctx) || null }

    function _toast(level, msg) {
        try {
            if (typeof window.RouteAssistantToast === "undefined") return
            const fn = (level === "warn") ? window.RouteAssistantToast.warn
                     : (level === "error") ? window.RouteAssistantToast.error
                     : window.RouteAssistantToast.info
            if (typeof fn === "function") fn(msg)
        } catch (_) { /* never break on a toast failure */ }
    }

    function _readSettings() {
        try {
            const s = window.AesAfpSettings && typeof window.AesAfpSettings.cached === "function"
                ? window.AesAfpSettings.cached() : null
            return (s && s.aircraftFlightPlan) ? s.aircraftFlightPlan : null
        } catch (_) { return null }
    }

    function _gatesAllowLive() {
        const s = _readSettings()
        if (!s || !s.apply) return false
        return s.apply.enabled === true && s.apply.dryRunOnly !== true
    }

    /** Find flight(s) on the current aircraft heading to `destIata`.
     *  Uses AesAfpVfpReader if it exposes a parsed list; otherwise falls
     *  back to the wave-applier's last build. Returns an array of
     *  `{flightId, destination, depTimeLocal}` records. Empty when no
     *  matches or the readers aren't loaded yet. */
    function _resolveMatchingFlights(record) {
        const dest = String(record && record.destIata || "").toUpperCase()
        if (!dest) return []
        const out = []
        try {
            const reader = window.AesAfpVfpReader
            if (reader && typeof reader.lastLegs === "function") {
                const legs = reader.lastLegs() || []
                for (const leg of legs) {
                    if (!leg || String(leg.destination || "").toUpperCase() !== dest) continue
                    if (leg.flightId == null) continue
                    out.push({flightId: leg.flightId, destination: leg.destination, depTimeLocal: leg.depTimeLocal})
                }
            }
        } catch (_) { /* noop — fall through to next resolver */ }
        if (out.length) return out
        try {
            const draft = window.AesAfpActiveDraftStore
            const ctx = _ctx()
            if (draft && typeof draft.getFlights === "function" && ctx) {
                const list = draft.getFlights(ctx.server, ctx.aircraftId) || []
                for (const f of list) {
                    if (!f || String(f.destination || "").toUpperCase() !== dest) continue
                    if (f.flightId == null) continue
                    out.push({flightId: f.flightId, destination: f.destination, depTimeLocal: f.depTimeLocal})
                }
            }
        } catch (_) { /* noop */ }
        return out
    }

    async function _logAudit(record, outcome, extra) {
        try {
            const log = window.AesAfpAutoApplyLog
            if (!log || typeof log.add !== "function") return
            const ctx = _ctx() || {}
            await log.add({
                action:     record && record.kind === "moveRoute" ? "handoff-move" : "handoff-remove",
                ts:         Date.now(),
                server:     ctx.server || null,
                aircraftId: ctx.aircraftId || null,
                hub:        record && record.hub || null,
                dest:       record && record.destIata || null,
                source:     "handoff-remove-consumer",
                outcome:    outcome,
                ...extra
            }).catch(() => {})
        } catch (_) { /* noop */ }
    }

    /** Stage the AS-side delete batch via the existing flight-deleter, but
     *  only when the gates allow. Returns `{ok, status, reason?}`. */
    async function _runLive(record, flights) {
        const deleter = window.AesAfpAutoFlightDeleter
        if (!deleter || typeof deleter.start !== "function") {
            return {ok: false, status: "deleter-missing"}
        }
        const ctx = _ctx() || {}
        try {
            const r = await deleter.start({
                ctx,
                flights,
                source: "handoff-remove-consumer:" + (record.kind || "removeRoute")
            })
            return {ok: !!(r && r.ok !== false), status: (r && r.aborted) ? "aborted" : "started", report: r}
        } catch (e) {
            return {ok: false, status: "deleter-threw", reason: String(e && e.message || e)}
        }
    }

    async function _consume() {
        if (_state.consumed) return
        const ctx = _ctx()
        if (!ctx || !ctx.aircraftId) return
        const store = window.AesHandoffStore
        if (!store || typeof store.peek !== "function") return
        let rec = null
        try { rec = await store.peek() } catch (_) { return }
        if (!rec) return
        const kind = rec.kind || "addRoute"
        if (kind !== "removeRoute" && kind !== "moveRoute") return       // wave-applier owns addRoute / dnd-grid
        if (String(rec.aircraftId) !== String(ctx.aircraftId)) return    // not for this aircraft
        let consumed = null
        try { consumed = await store.consume(ctx.aircraftId) } catch (_) { return }
        if (!consumed) return
        _state.consumed = true
        _state.lastRecord = consumed

        // Defer the resolver step until VFP / draft has populated; readers
        // are async and we may have raced ahead of mount. Single retry at
        // 1.5s catches the typical mount latency without busy-looping.
        let flights = _resolveMatchingFlights(consumed)
        if (!flights.length) {
            await new Promise(r => setTimeout(r, 1500))
            flights = _resolveMatchingFlights(consumed)
        }

        const live = _gatesAllowLive()
        if (!flights.length) {
            _toast("warn", "Handoff " + kind + " for " + (consumed.destIata || "?")
                + " — no matching flights on this aircraft.")
            await _logAudit(consumed, "no-match", {flightCount: 0, live})
        } else if (!live) {
            _toast("info", "Pending " + kind + ": " + flights.length + " × "
                + (consumed.destIata || "?") + ". Apply via Settings (apply.enabled + apply.dryRunOnly off) to commit.")
            await _logAudit(consumed, "dry-run", {flightCount: flights.length, live: false})
        } else {
            const r = await _runLive(consumed, flights)
            const status = r && r.status || "unknown"
            const ok = r && r.ok
            await _logAudit(consumed, ok ? "live-applied" : "live-failed", {
                flightCount: flights.length, live: true, status,
                reason: r && r.reason
            })
            _toast(ok ? "info" : "error",
                (ok ? "Removed " : "Remove failed: ")
                + flights.length + " × " + (consumed.destIata || "?")
                + (ok ? "" : " (" + status + ")"))
        }

        // moveRoute — chain an addRoute onto the queue for the target aircraft.
        // Fire-and-forget; the queue's auto-advance listener wakes when the
        // active slot is consumed.
        if (kind === "moveRoute" && consumed.targetAircraftId && window.AesHandoffQueue) {
            try {
                // Synthesise an addRoute targeting the move destination on
                // the recipient aircraft. dnd-grid is the source channel
                // that handoff-store accepts for presetId-less addRoutes
                // (route-candidates.js consumes it on the AFP page mount).
                await window.AesHandoffQueue.enqueue([{
                    aircraftId: consumed.targetAircraftId,
                    destIata:   consumed.destIata,
                    hub:        consumed.hub,
                    kind:       "addRoute",
                    flightNumberText: consumed.flightNumberText,
                    source:     "dnd-grid"
                }])
            } catch (_) { /* noop */ }
        }
    }

    function _attach() {
        const bus = _bus()
        if (!bus || typeof bus.on !== "function") return false
        bus.on("ctx:ready", () => { _consume().catch(() => {}) })
        // ctx may already be ready by the time we attach.
        if (_ctx() && _ctx().aircraftId) { _consume().catch(() => {}) }
        return true
    }

    if (!_attach()) {
        let tries = 0
        const poll = () => {
            tries++
            if (_attach()) return
            if (tries < 120) requestAnimationFrame(poll)
        }
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(poll)
    }

    window.AesAfpHandoffRemoveConsumer = {
        _consume, _resolveMatchingFlights, _gatesAllowLive,
        get _state() { return _state }
    }
})()
