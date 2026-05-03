"use strict"

/**
 * AES Strategy — decision dispatch handoff (v1).
 *
 * Thin pub-sub stub. The Pricing Compass (and any future surface) calls
 * `composeMove({hub, dest, classKey, toPct, source})` to ask the strategy
 * panel to scroll to the matching decision row and pre-select it.
 *
 * v1 just persists the request to `chrome.storage.local["aesStrategy:dispatchPending"]`
 * and emits an `AesDataBus` event. The user opens the strategy panel
 * manually; the panel's existing render checks the pending key and acts
 * on it. No direct apply path here — apply still goes through the user's
 * normal pipeline. v2 wires apply directly.
 *
 * Key design choice: the storage key is the source of truth (survives
 * page reload), the bus event is the fast-path nudge for an already-open
 * panel. The strategy panel must clear the storage key after consuming
 * it so the next page-load doesn't re-trigger the same selection.
 *
 * Public API:
 *   AesStrategyDecisionDispatch.composeMove({hub, dest, classKey, toPct, source})
 *   AesStrategyDecisionDispatch.composeFromIntervention(intervention, {originForkId, reason})
 *   AesStrategyDecisionDispatch.readPending() → Promise<payload | null>
 *   AesStrategyDecisionDispatch.readPendingIntervention() → Promise<payload | null>
 *   AesStrategyDecisionDispatch.clearPending() → Promise<void>
 *   AesStrategyDecisionDispatch.clearPendingIntervention() → Promise<void>
 *   AesStrategyDecisionDispatch.KEY        (price-move pending storage key)
 *   AesStrategyDecisionDispatch.KEY_INTV   (Slice 21 intervention pending key)
 *   AesStrategyDecisionDispatch.TOPIC      (price-move pending bus topic)
 *   AesStrategyDecisionDispatch.TOPIC_INTV (intervention pending bus topic)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyDecisionDispatch) return

    const KEY           = "aesStrategy:dispatchPending"
    const TOPIC         = "data:strategy:dispatch:pending"
    const APPLIED_TOPIC = "data:strategy:dispatch:applied"

    // K11.2 — Slice 21 fork→dispatch adapter writes to a sibling slot so the
    // change-log aggregator's price-move projection (change-log-aggregator.js
    // §dispatchPending) keeps reading the canonical {hub, dest, classKey,
    // toPct} shape, while intervention payloads (setWeight / addAircraft /
    // dropRoute / flipDna) flow through their own pending key.
    const KEY_INTV   = "aesStrategy:interventionPending"
    const TOPIC_INTV = "data:strategy:intervention:pending"

    function _now() { return Date.now() }

    /**
     * Persist the request and emit the bus event. The bus payload is
     * intentionally tiny — subscribers re-read the storage key via
     * readPending() so the canonical state lives in one place.
     */
    async function composeMove(input) {
        const i = input || {}
        if (!i.hub || !i.dest || !i.classKey) return null
        const payload = {
            hub:       String(i.hub).toUpperCase(),
            dest:      String(i.dest).toUpperCase(),
            classKey:  String(i.classKey),
            toPct:     isFinite(Number(i.toPct)) ? Number(i.toPct) : null,
            source:    String(i.source || "unknown"),
            requestedAt: _now()
        }
        try {
            await chrome.storage.local.set({[KEY]: payload})
        } catch (e) {
            console.warn("[AES decision-dispatch] storage write failed", e)
            return null
        }
        try {
            if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit(TOPIC, {
                    hub: payload.hub, dest: payload.dest,
                    classKey: payload.classKey, source: payload.source
                })
            }
        } catch (_) { /* bus failure must not break the storage path */ }
        return payload
    }

    async function readPending() {
        try {
            const out = await chrome.storage.local.get([KEY])
            return out[KEY] || null
        } catch (_) { return null }
    }

    async function clearPending() {
        try { await chrome.storage.local.remove([KEY]) }
        catch (_) { /* best-effort */ }
    }

    /**
     * Phase D1 — direct-apply path. Reconstructs a one-decision plan from
     * the pending payload and routes it through AesStrategy.apply (same
     * call shape used by auto-driver). Idempotent: marks `applied: true`
     * on the storage payload BEFORE calling apply, so a double-click
     * cannot fire two POSTs.
     *
     * On failure, sets `failed: <reason>` so the panel can offer a retry
     * verb. On success, emits `data:strategy:dispatch:applied` and clears
     * the pending key.
     *
     * Returns `{ok: bool, status: "applied"|"already-applied"|"no-move"
     *           |"pipeline-missing"|"snapshot-missing"|"error", error?, report?}`.
     */
    async function applyPending() {
        const pending = await readPending()
        if (!pending) return {ok: false, status: "no-pending"}
        if (pending.applied) return {ok: true,  status: "already-applied"}
        if (pending.failed)  return {ok: false, status: "failed", error: pending.failed}

        const ns = window.AesStrategy
        if (!ns || typeof ns.apply !== "function" || typeof ns.snapshot !== "function") {
            return {ok: false, status: "pipeline-missing"}
        }
        if (typeof ns.proposePriceMoves !== "function") {
            return {ok: false, status: "pipeline-missing"}
        }

        // Persist applied=true BEFORE invoking the pipeline so a concurrent
        // applyPending() / readPending() sees the in-progress state and
        // short-circuits via the already-applied branch above.
        const stamped = Object.assign({}, pending, {applied: true, appliedAt: _now()})
        try { await chrome.storage.local.set({[KEY]: stamped}) }
        catch (e) { return {ok: false, status: "storage-write-failed", error: String(e)} }

        let snapshot, moves
        try {
            snapshot = await ns.snapshot({})
        } catch (e) {
            await _markFailed(pending, "snapshot-failed: " + String(e))
            return {ok: false, status: "snapshot-missing", error: String(e)}
        }
        if (!snapshot) {
            await _markFailed(pending, "snapshot-empty")
            return {ok: false, status: "snapshot-missing"}
        }
        try {
            moves = ns.proposePriceMoves(snapshot, {
                restrictTo: {hub: pending.hub, dest: pending.dest}
            })
        } catch (e) {
            await _markFailed(pending, "proposer-failed: " + String(e))
            return {ok: false, status: "error", error: String(e)}
        }
        const move = (moves || []).find(m => m && m.classKey === pending.classKey)
        if (!move) {
            await _markFailed(pending, "no-move-for-class")
            return {ok: false, status: "no-move"}
        }
        const decisionId = "price:" + pending.hub + "-" + pending.dest + ":" + pending.classKey
        const plan = {decisions: [{
            id:         decisionId,
            kind:       "price",
            domain:     "price",
            payload:    move,
            applicable: true,
            rationale:  Array.isArray(move.rationale) ? move.rationale.slice() : []
        }]}

        let report
        try {
            report = await ns.apply(plan, {
                selected: [decisionId],
                snapshot: snapshot,
                source:   "decision-dispatch"
            })
        } catch (e) {
            await _markFailed(pending, "apply-failed: " + String(e))
            return {ok: false, status: "error", error: String(e)}
        }

        try {
            if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit(APPLIED_TOPIC, {
                    hub:        pending.hub,
                    dest:       pending.dest,
                    classKey:   pending.classKey,
                    decisionId: decisionId,
                    appliedAt:  stamped.appliedAt
                })
            }
        } catch (_) { /* bus failures must not roll back a successful apply */ }
        await clearPending()
        return {ok: true, status: "applied", report}
    }

    async function _markFailed(pending, reason) {
        try {
            const next = Object.assign({}, pending, {
                applied: false, failed: reason, failedAt: _now()
            })
            await chrome.storage.local.set({[KEY]: next})
        } catch (_) { /* best-effort */ }
    }

    /**
     * K11.2 — fork→dispatch adapter. fork-store.promote() calls this with
     * the fork's first intervention plus provenance. We validate against
     * the intervention-types catalogue, stamp a deterministic dispatchId
     * (so re-promotes on the same fork+timestamp collide rather than fan
     * out duplicate slots), persist to KEY_INTV, and ring the bus.
     *
     * Return shape:
     *   string  — dispatchId on success
     *   null    — validation failed, storage write failed, or types
     *             namespace missing. fork-store.promote distinguishes
     *             null from throw to surface a meaningful reason.
     *
     * Two-gate model is preserved: this method only stages a pending
     * intervention; user (or a future Apply UI) still drives the actual
     * AS-side write through the existing apply pipeline.
     */
    async function composeFromIntervention(intervention, ctx) {
        const types = window.AesStrategyInterventionTypes
        if (!types || typeof types.validate !== "function") return null
        const v = types.validate(intervention)
        if (!v.ok) return null

        const c = ctx || {}
        const requestedAt = _now()
        const originForkId = String(c.originForkId || "anon")
        const dispatchId = "intv:" + originForkId + ":" + requestedAt
        const payload = {
            dispatchId:   dispatchId,
            intervention: JSON.parse(JSON.stringify(intervention)),
            summary:      types.summarize(intervention),
            originForkId: originForkId,
            reason:       String(c.reason || ""),
            source:       "counterfactual-lab",
            requestedAt:  requestedAt,
            applied:      false
        }
        try {
            await chrome.storage.local.set({[KEY_INTV]: payload})
        } catch (e) {
            console.warn("[AES decision-dispatch] intervention storage write failed", e)
            return null
        }
        try {
            if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit(TOPIC_INTV, {
                    dispatchId:   dispatchId,
                    kind:         intervention.kind,
                    originForkId: originForkId,
                    source:       payload.source
                })
            }
        } catch (_) { /* bus failure must not break the storage path */ }
        return dispatchId
    }

    async function readPendingIntervention() {
        try {
            const out = await chrome.storage.local.get([KEY_INTV])
            return out[KEY_INTV] || null
        } catch (_) { return null }
    }

    async function clearPendingIntervention() {
        try { await chrome.storage.local.remove([KEY_INTV]) }
        catch (_) { /* best-effort */ }
    }

    window.AesStrategyDecisionDispatch = {
        composeMove:              composeMove,
        composeFromIntervention:  composeFromIntervention,
        readPending:              readPending,
        readPendingIntervention:  readPendingIntervention,
        clearPending:             clearPending,
        clearPendingIntervention: clearPendingIntervention,
        applyPending:             applyPending,
        KEY:                      KEY,
        KEY_INTV:                 KEY_INTV,
        TOPIC:                    TOPIC,
        TOPIC_INTV:               TOPIC_INTV,
        APPLIED_TOPIC:            APPLIED_TOPIC
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof composeMove === "function",
                "[smoke dispatch] composeMove exposed")
            console.assert(KEY === "aesStrategy:dispatchPending",
                "[smoke dispatch] storage key stable")
            console.assert(TOPIC === "data:strategy:dispatch:pending",
                "[smoke dispatch] bus topic stable")
            // Round-trip — write then read.
            ;(async () => {
                const payload = await composeMove({hub: "fra", dest: "jfk",
                    classKey: "Y", toPct: 100, source: "smoke"})
                console.assert(payload && payload.hub === "FRA" && payload.dest === "JFK",
                    "[smoke dispatch] hub/dest upper-cased")
                const read = await readPending()
                console.assert(read && read.classKey === "Y" && read.toPct === 100,
                    "[smoke dispatch] readPending returns last write")
                await clearPending()
                const cleared = await readPending()
                console.assert(cleared === null,
                    "[smoke dispatch] clearPending zeroes the slot")

                // K11.2 round-trip — composeFromIntervention path.
                if (window.AesStrategyInterventionTypes) {
                    const id = await composeFromIntervention(
                        {kind: "setWeight", name: "profitWeight", value: 0.5},
                        {originForkId: "fk-smoke", reason: "smoke"}
                    )
                    console.assert(typeof id === "string" && /^intv:fk-smoke:/.test(id),
                        "[smoke dispatch] composeFromIntervention returns intv:<fork>:<ts>")
                    const intvRead = await readPendingIntervention()
                    console.assert(intvRead && intvRead.applied === false
                        && intvRead.intervention && intvRead.intervention.kind === "setWeight",
                        "[smoke dispatch] readPendingIntervention round-trips payload")
                    await clearPendingIntervention()
                    const intvCleared = await readPendingIntervention()
                    console.assert(intvCleared === null,
                        "[smoke dispatch] clearPendingIntervention zeroes the slot")
                }
            })()
        }
    } catch (_) { /* smoke must never break the page */ }
})()
