"use strict"

/**
 * CanvasCommitBar — turns the rail's staged edits into real writes.
 *
 * The rail-controller collects edits in memory; when the user hits Commit
 * we route each edit by `kind`:
 *
 *   applyPricing  → RouteAssistantPricingApplier.apply() per route. Honours
 *                   the user's pricing.apply.{enabled,dryRunOnly} gates from
 *                   RouteAssistantSettings — gates off ⇒ dry-run, gates on ⇒
 *                   real POST + verification path. Identical to the path the
 *                   RA panel uses.
 *
 *   addRoute      → handoff via AesHandoffStore (`source: "dnd-grid"`). The
 *                   AFP page's wave-applier consumes the record on mount and
 *                   pre-selects the candidate row. The store holds ONE
 *                   pending handoff at a time, so multi-route batches drop a
 *                   toast nudging the user to open the AFP tab once per leg.
 *
 *   moveRoute     → emitted on the bus + recorded in the apply log as a
 *                   `dry-run` placeholder. AS's per-flight-edit POST is
 *                   fragile (Wicket page-version IDs don't survive a tab
 *                   that doesn't first GET the edit page), so the canonical
 *                   path is delete-then-add via the AFP page. Phase 7 stages
 *                   the intent; Phase 8+ will materialise it.
 *
 *   removeRoute   → same as moveRoute — emitted + toasted, no in-process
 *                   write yet. Removing a flight in AS requires the
 *                   per-flight Wicket page; out of scope for this slice.
 *
 * The bar replaces the rail-shell footer wholesale (the shell's built-in
 * footer is a placeholder). Caller passes in the rail-shell instance plus
 * the staged-edits list (live reference; the bar reads at click time).
 */
class CanvasCommitBar {

    constructor(deps) {
        const d = deps || {}
        this.server      = d.server || ""
        this.airlineCode = d.airlineCode || ""
        this.getStaged   = typeof d.getStaged === "function" ? d.getStaged : (() => [])
        this.clearStaged = typeof d.clearStaged === "function" ? d.clearStaged : (() => {})
        this.onCount     = typeof d.onCount === "function" ? d.onCount : null
        this._busy = false
    }

    setStagedCount(n) {
        if (this.onCount) this.onCount(Number(n) || 0)
    }

    /**
     * Run the staged-edit batch. Returns a summary `{ok, failed, dryRun,
     * deferred}` describing the per-kind disposition. Toast'd to the user
     * via RouteAssistantToast for visible feedback.
     */
    async commit() {
        if (this._busy) return null
        const staged = (this.getStaged() || []).slice()
        if (!staged.length) return null
        this._busy = true
        const summary = {
            ok:        0,    // pricing applies that succeeded (posted or dry-run accepted)
            failed:    0,
            dryRun:    0,
            deferred:  0,    // schedule edits that need an AFP-page hand-off
            handedOff: 0     // single addRoute that wrote to AesHandoffStore
        }

        try {
            // Group by kind. Pricing applies run sequentially (the applier's
            // own circuit-breaker assumes serial calls); schedule edits are
            // logged + handed off.
            const pricingEdits = staged.filter(e => e && e.kind === "applyPricing")
            const addEdits     = staged.filter(e => e && e.kind === "addRoute")
            const moveEdits    = staged.filter(e => e && e.kind === "moveRoute")
            const removeEdits  = staged.filter(e => e && e.kind === "removeRoute")

            for (const edit of pricingEdits) {
                const r = await this._runPricingApply(edit)
                if (!r) { summary.failed++; continue }
                if (r.status === "dry-run") summary.dryRun++
                else if (r.status === "posted" || r.status === "verified") summary.ok++
                else summary.failed++
            }

            // Single-leg add via the existing handoff store: pre-select the
            // candidate row in the AFP page so the user only has to click
            // Submit once. Bulk adds toast a count and ask the user to open
            // each aircraft's plan tab.
            if (addEdits.length === 1) {
                const handed = await this._handoffSingleAdd(addEdits[0])
                if (handed) summary.handedOff++
                else summary.deferred++
            } else if (addEdits.length > 1) {
                summary.deferred += addEdits.length
            }

            // Move + Remove: deferred to AFP-page; just count for the toast.
            summary.deferred += moveEdits.length + removeEdits.length

            const batchId = "c-" + Date.now().toString(36)
            if (typeof window !== "undefined" && window.CentralHubBus) {
                window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_COMMITTED, {
                    batchId,
                    edits: staged.slice(),
                    summary
                })
            }

            this.clearStaged()
            this.setStagedCount(0)
            this._toastSummary(summary)
        } catch (err) {
            console.warn("[AES Canvas] commit threw", err)
            if (typeof window !== "undefined" && window.RouteAssistantToast) {
                window.RouteAssistantToast.show("Commit error — see console.",
                    {type: "error", duration: 5000})
            }
        } finally {
            this._busy = false
        }
        return summary
    }

    discard() {
        const staged = (this.getStaged() || []).slice()
        const batchId = "d-" + Date.now().toString(36)
        this.clearStaged()
        this.setStagedCount(0)
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_DISCARDED, {batchId, count: staged.length})
        }
    }

    async _runPricingApply(edit) {
        const p = edit && edit.payload
        if (!p || !p.hub || !p.dest || !p.prices) return null
        const applier = await this._buildApplier()
        if (!applier) {
            if (typeof window !== "undefined" && window.RouteAssistantToast) {
                window.RouteAssistantToast.show(
                    "Pricing applier not loaded — refresh the page and try again.",
                    {type: "warn", duration: 5000})
            }
            return null
        }
        try {
            const r = await applier.apply(p.hub, p.dest, p.prices, {
                scope:        p.scope || undefined,
                source:       p.source || "canvas",
                reason:       p.reason || "Schedule Canvas commit",
                submitButton: p.submitButton || undefined,
                rationale:    Array.isArray(p.rationale) ? p.rationale : null,
                proposerStrategy: p.proposerStrategy || null
            })
            return r
        } catch (e) {
            console.warn("[AES Canvas] pricing apply failed", e, edit)
            return {status: "failed", error: e && e.message || String(e)}
        }
    }

    async _buildApplier() {
        if (typeof window === "undefined") return null
        if (typeof window.RouteAssistantPricingApplier === "undefined") return null
        if (!this.server) return null
        let cfg = {}
        let log = null
        try {
            if (typeof window.RouteAssistantSettings !== "undefined") {
                const settings = await window.RouteAssistantSettings.load()
                cfg = (settings && settings.pricing && settings.pricing.apply) || {}
            }
        } catch (_) {}
        try {
            if (typeof window.RouteAssistantPricingApplyLog !== "undefined") {
                log = new window.RouteAssistantPricingApplyLog({
                    limit:         cfg.pricingApplyLogLimit  || 200,
                    perRouteLimit: cfg.perRouteApplyLogLimit || 20
                })
            }
        } catch (_) {}
        return new window.RouteAssistantPricingApplier(this.server, {
            dryRunOnly:           cfg.dryRunOnly !== false,
            applyEnabled:         !!cfg.enabled,
            cooldownMinPerRoute:  cfg.cooldownMinPerRoute,
            cooldownMinGlobal:    cfg.cooldownMinGlobal,
            warnAboveDeltaPct:    cfg.warnAboveDeltaPct,
            applyLog:             log
        })
    }

    async _handoffSingleAdd(edit) {
        const p = edit && edit.payload
        if (!p || !p.aircraftId || !p.destIata) return false
        if (typeof window === "undefined" || typeof window.AesHandoffStore === "undefined") return false
        try {
            await window.AesHandoffStore.set({
                aircraftId: p.aircraftId,
                destIata:   p.destIata,
                hub:        p.hub || null,
                dropMin:    isFinite(p.dropMin) ? p.dropMin : null,
                source:     "dnd-grid"
            })
            return true
        } catch (e) {
            console.warn("[AES Canvas] handoff failed", e)
            return false
        }
    }

    _toastSummary(s) {
        if (typeof window === "undefined" || !window.RouteAssistantToast) return
        const parts = []
        if (s.ok)        parts.push(s.ok + " applied")
        if (s.dryRun)    parts.push(s.dryRun + " dry-run")
        if (s.handedOff) parts.push(s.handedOff + " staged for AFP")
        if (s.deferred)  parts.push(s.deferred + " deferred")
        if (s.failed)    parts.push(s.failed + " failed")
        const summaryText = parts.length ? parts.join(" · ") : "No edits"
        const type = s.failed ? "warn" : (s.deferred && !s.ok && !s.handedOff ? "info" : "success")
        let detail = ""
        if (s.handedOff) {
            detail = " Open the aircraft's Flight Plan tab to submit the staged leg."
        } else if (s.deferred && !s.handedOff) {
            detail = " Open Aircraft Flight Plan to apply the remaining schedule edits."
        }
        window.RouteAssistantToast.show("Commit: " + summaryText + "." + detail,
            {type, duration: 6000})
    }
}

if (typeof window !== "undefined") {
    window.CanvasCommitBar = CanvasCommitBar
}
