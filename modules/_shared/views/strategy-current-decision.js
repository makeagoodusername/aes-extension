"use strict"

/**
 * Canonical view: `strategy:current-decision`
 *
 * Composes the in-flight pending dispatch (`aesStrategy:dispatchPending`) with
 * the most recent applied plan envelope (`aesStrategy:plan:applied`) into one
 * shape that says "what is the user about to do, vs what just shipped".
 *
 * Replaces the dual storage probes in:
 *   - modules/central-hub/tiles/strategy-briefing-tile.js
 *   - modules/central-hub/tiles/weekly-review-tile.js  (future)
 *   - modules/central-hub/tiles/strategy-tile.js (already on hub:strategy:applied)
 *
 * Output shape:
 *   {
 *     pending:    {decisionId, domain, payload, requestedAt, source} | null,
 *     applied:    {planId, ts, server, airlineCode, tier, totalOk, totalFailed} | null,
 *     inFlight:   bool,
 *     nextAction: "awaiting-user-apply" | "awaiting-modal-open" | "already-applied" | "idle"
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AesView || !window.AesDataBus) return
    if (window.__aesViewStrategyCurrentDecisionDeclared) return
    window.__aesViewStrategyCurrentDecisionDeclared = true

    const PENDING_KEY = "aesStrategy:dispatchPending"
    const APPLIED_KEY = "aesStrategy:plan:applied"

    AesView.declare({
        name:       "strategy:current-decision",
        deps:       [
            "data:strategy:dispatch:pending",
            "data:strategy:dispatch:applied",
            "data:strategy:applied:saved",
            "data:account:bootstrapped"
        ],
        debounceMs: 80,
        compute:    async () => {
            const pending = await readPending()
            const applied = await readApplied()
            const pendingAt = pending && Number(pending.requestedAt) || 0
            const appliedAt = applied && Number(applied.ts) || 0
            const inFlight = !!pending && (!appliedAt || pendingAt > appliedAt)
            return {
                pending:    pending,
                applied:    appliedShape(applied),
                inFlight:   inFlight,
                nextAction: deriveNextAction(pending, applied, inFlight)
            }
        }
    })

    async function readPending() {
        try {
            const data = await chrome.storage.local.get([PENDING_KEY])
            const rec = data[PENDING_KEY]
            if (!rec || typeof rec !== "object") return null
            return {
                decisionId:  rec.decisionId || rec.id || null,
                domain:      rec.domain || null,
                payload:     rec.payload || null,
                requestedAt: Number(rec.requestedAt) || Number(rec.at) || null,
                source:      rec.source || null
            }
        } catch (_) { return null }
    }

    async function readApplied() {
        try {
            if (window.AesStrategy && typeof window.AesStrategy.getApplied === "function") {
                const id = window.__aesAccountId || null
                const rec = await window.AesStrategy.getApplied(id)
                if (rec) return rec
            }
            const data = await chrome.storage.local.get([APPLIED_KEY])
            return data[APPLIED_KEY] || null
        } catch (_) { return null }
    }

    function appliedShape(rec) {
        if (!rec || typeof rec !== "object") return null
        return {
            planId:      rec.planId || rec.id || null,
            ts:          Number(rec.ts) || Number(rec.appliedAt) || null,
            server:      rec.server || null,
            airlineCode: rec.airlineCode || rec.airline || null,
            tier:        rec.tier || null,
            totalOk:     Number.isFinite(rec.totalOk)     ? rec.totalOk     : null,
            totalFailed: Number.isFinite(rec.totalFailed) ? rec.totalFailed : null
        }
    }

    function deriveNextAction(pending, applied, inFlight) {
        if (inFlight) {
            // Pending newer than (or without) applied — user has a move to act on.
            // We can't tell from storage alone whether the modal is open, so
            // default to awaiting-user-apply; tile UI can refine if it knows.
            return "awaiting-user-apply"
        }
        if (applied) return "already-applied"
        return "idle"
    }
})()
