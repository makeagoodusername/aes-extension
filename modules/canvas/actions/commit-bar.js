"use strict"

/**
 * CanvasCommitBar — turns the rail's staged edits into real writes.
 *
 * The rail-controller collects edits in memory; when the user hits Apply
 * we route each edit by `kind`:
 *
 *   applyPricing  → RouteAssistantPricingApplier.apply() per route. Honours
 *                   the user's pricing.apply.{enabled,dryRunOnly} gates from
 *                   RouteAssistantSettings — gates off ⇒ dry-run, gates on ⇒
 *                   real POST + verification path. Identical to the path the
 *                   RA panel uses.
 *
 *   addRoute      → the Fleet Schedule Grid background-tab submit pipeline.
 *                   This posts AS's New Flight Number form from hidden
 *                   aircraft Flight Plan tabs and refreshes the affected
 *                   aircraft schedules afterward.
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
        this.getInputs   = typeof d.getInputs === "function" ? d.getInputs : (() => ({}))
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
            deferred:  0,    // edits whose writer is intentionally not live yet
            handedOff: 0,    // single addRoute that wrote to AesHandoffStore
            rescraped:  0
        }

        try {
            // Group by kind. Pricing applies run sequentially (the applier's
            // own circuit-breaker assumes serial calls); schedule adds use
            // the same background-tab submit path as the actual schedule grid.
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

            if (addEdits.length) {
                const addPayloads = addEdits.map(e => this._normaliseAddPayload(e)).filter(Boolean)
                summary.failed += addEdits.length - addPayloads.length
                const applied = await this._runScheduleAdds(addPayloads)
                if (applied && applied.ran) {
                    summary.ok += applied.succeeded
                    summary.failed += applied.failed
                    summary.rescraped += applied.rescraped
                } else {
                    summary.failed += addPayloads.length
                }
            }

            // Move + Remove: still deferred (no AS-side write path yet) but
            // we now enqueue the records via AesHandoffQueue so the queue
            // plumbing is in place. The AFP page consumer doesn't yet act
            // on `kind: "removeRoute"` / `"moveRoute"` records — they sit
            // in the active slot until TTL. Future slice wires the gated
            // delete writer; the queue already provides sequencing.
            summary.deferred += moveEdits.length + removeEdits.length
            const queuedRecords = removeEdits.concat(moveEdits)
                .map(e => this._normaliseDeferredHandoff(e)).filter(Boolean)
            if (queuedRecords.length && typeof window !== "undefined" && window.AesHandoffQueue) {
                try {
                    summary.queued = await window.AesHandoffQueue.enqueue(queuedRecords)
                } catch (e) {
                    console.warn("[AES Canvas] handoff-queue enqueue failed", e)
                }
            }

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
                window.RouteAssistantToast.show("Apply error — see console.",
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
        const p = this._payloadOf(edit)
        if (!p || !p.hub || !p.dest || !p.prices) return null
        const built = await this._buildApplierContext()
        const applier = built && built.applier
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
                proposerStrategy: p.proposerStrategy || null,
                classGates:   built.classGates || null
            })
            return r
        } catch (e) {
            console.warn("[AES Canvas] pricing apply failed", e, edit)
            return {status: "failed", error: e && e.message || String(e)}
        }
    }

    async _buildApplier() {
        const built = await this._buildApplierContext()
        return built && built.applier
    }

    async _buildApplierContext() {
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
        return {
            applier: new window.RouteAssistantPricingApplier(this.server, {
                dryRunOnly:           cfg.dryRunOnly === true,
                applyEnabled:         cfg.enabled !== false,
                liveScopes:           cfg.liveScopes || {},
                cooldownMinPerRoute:  cfg.cooldownMinPerRoute,
                cooldownMinGlobal:    cfg.cooldownMinGlobal,
                warnAboveDeltaPct:    cfg.warnAboveDeltaPct,
                applyLog:             log
            }),
            classGates: cfg.classes || null
        }
    }

    async _handoffSingleAdd(edit) {
        const p = this._normaliseAddPayload(edit)
        if (!p || !p.aircraftId || !p.destIata) return false
        if (typeof window === "undefined" || typeof window.AesHandoffStore === "undefined") return false
        try {
            await window.AesHandoffStore.set({
                aircraftId: p.aircraftId,
                destIata:   p.destIata,
                hub:        p.hub || null,
                dropMin:    p.dropMin != null && isFinite(p.dropMin) ? p.dropMin : null,
                depTime:    p.depTime || null,
                flightNumberText: p.flightNumberText || "",
                pricePct:   p.pricePct,
                service:    p.service || "",
                dayMask:    Array.isArray(p.dayMask) ? p.dayMask.slice(0, 7).map(Boolean) : null,
                fillForm:   true,
                source:     "dnd-grid"
            })
            return true
        } catch (e) {
            console.warn("[AES Canvas] handoff failed", e)
            return false
        }
    }

    _payloadOf(edit) {
        if (!edit || typeof edit !== "object") return null
        if (edit.payload && typeof edit.payload === "object") return edit.payload
        return edit
    }

    _safeInputs() {
        try { return this.getInputs() || {} }
        catch (_) { return {} }
    }

    _normaliseAddPayload(edit) {
        const p = this._payloadOf(edit)
        if (!p || typeof p !== "object") return null
        const aircraftId = p.aircraftId != null ? String(p.aircraftId) : ""
        const destIata = String(p.destIata || p.destination || "").toUpperCase()
        if (!aircraftId || !/^[A-Z]{3}$/.test(destIata)) return null
        const inputs = this._safeInputs()
        const preset = inputs && inputs.preset
        const wave = this._findWave(p.waveId, preset)
        const hub = String(p.hub || (inputs && inputs.hub) || (preset && preset.hub) || "").toUpperCase()
        const dropMin = p.dropMin != null && isFinite(p.dropMin) ? Number(p.dropMin) : null
        const pricePct = Number(p.pricePct)
        const flightNumberText = String(p.flightNumberText || "")
            .replace(/[^0-9]/g, "").slice(0, 4)
        const depTime = p.depTime || p.depTimeLocal
            || (dropMin != null ? _minToHHMM(dropMin) : null)
            || (wave && wave.departureWindow && wave.departureWindow.start)
            || "09:00"
        const dayMask = Array.isArray(p.dayMask) && p.dayMask.length >= 7
            ? p.dayMask.slice(0, 7).map(Boolean)
            : null
        return {
            aircraftId,
            destIata,
            destName: p.destName || "",
            hub,
            waveId: p.waveId || null,
            dropMin,
            depTime,
            pricePct: Number.isFinite(pricePct) && pricePct > 0 ? pricePct : 100,
            service:  typeof p.service === "string" ? p.service : "",
            flightNumberText,
            dayMask,
            fares:    (p.fares && typeof p.fares === "object") ? p.fares : {},
            sourceEdit: edit
        }
    }

    /**
     * Convert a moveRoute / removeRoute staged edit to the
     * AesHandoffStore.set() record shape. Returns null when required
     * fields are missing.
     */
    _normaliseDeferredHandoff(edit) {
        const p = this._payloadOf(edit)
        if (!p) return null
        const kind = (edit && edit.kind) === "moveRoute" ? "moveRoute"
            : (edit && edit.kind) === "removeRoute" ? "removeRoute" : null
        if (!kind) return null
        const aircraftId = p.aircraftId != null ? String(p.aircraftId) : ""
        const destIata = String(p.destIata || p.destination || "").toUpperCase()
        if (!aircraftId || !/^[A-Z]{3}$/.test(destIata)) return null
        const out = {
            kind,
            aircraftId,
            destIata,
            source: "canvas-deferred"
        }
        if (p.hub) out.hub = String(p.hub).toUpperCase()
        if (p.flightNumberText != null) out.flightNumberText = String(p.flightNumberText)
        if (kind === "moveRoute") {
            if (!p.targetAircraftId) return null
            out.targetAircraftId = String(p.targetAircraftId)
        }
        return out
    }

    _findWave(waveId, preset) {
        if (!waveId || !preset || !Array.isArray(preset.waves)) return null
        return preset.waves.find(w => w && String(w.id) === String(waveId)) || null
    }

    async _runScheduleAdds(addPayloads) {
        if (!addPayloads || !addPayloads.length) return {ran: false}
        const gate = await this._scheduleApplyGate(addPayloads.length)
        if (!gate.ok) {
            if (typeof window !== "undefined" && window.RouteAssistantToast) {
                window.RouteAssistantToast.show("Route apply blocked: " + gate.reason + ".",
                    {type: "warn", duration: 6000})
            }
            return {ran: false, reason: gate.reason}
        }
        if (typeof window !== "undefined" && window.RouteAssistantToast) {
            window.RouteAssistantToast.show("Applying " + addPayloads.length
                + " route" + (addPayloads.length === 1 ? "" : "s")
                + " through AirlineSim Flight Plan tabs…",
                {type: "info", duration: 4000})
        }
        const byAircraft = new Map()
        for (const p of addPayloads) {
            if (!byAircraft.has(p.aircraftId)) byAircraft.set(p.aircraftId, [])
            byAircraft.get(p.aircraftId).push({
                origin:      p.hub || "",
                destination: p.destIata,
                depTime:     p.depTime,
                dayMask:     Array.isArray(p.dayMask) ? p.dayMask.slice(0, 7).map(Boolean) : null,
                pricePct:    p.pricePct,
                service:     p.service,
                flightNumberText: p.flightNumberText || ""
            })
        }
        const runs = Array.from(byAircraft.entries()).map(([aircraftId, legs]) => ({aircraftId, legs}))
        let result = null
        try {
            result = await window.AesAfpFleetApplyOrchestrator.start({
                runs,
                ctx:    {server: this.server},
                source: "canvas"
            })
        } catch (e) {
            console.warn("[AES Canvas] schedule apply failed", e)
            return {ran: true, succeeded: 0, failed: addPayloads.length, rescraped: 0}
        }
        const succeeded = Number(result && result.totalSucceeded) || 0
        const failed = Math.max(0, addPayloads.length - succeeded)
        const rescraped = succeeded ? await this._rescrapeAircrafts(Array.from(byAircraft.keys())) : 0
        return {ran: true, succeeded, failed, rescraped, result}
    }

    async _scheduleApplyGate(count) {
        if (typeof window === "undefined" || !window.AesAfpFleetApplyOrchestrator) {
            return {ok: false, reason: "fleet apply module not loaded"}
        }
        if (!this.server) return {ok: false, reason: "server missing"}
        let cap = 28
        try {
            if (typeof window.AesAfpSettings !== "undefined") {
                const s = await window.AesAfpSettings.load()
                const a = (s && s.autoScheduler) || {}
                cap = Number(a.maxLegsPerApply) || cap
            }
            if (count > cap) return {ok: false, reason: "too many legs for maxLegsPerApply"}
            return {ok: true}
        } catch (e) {
            if (count > cap) return {ok: false, reason: "too many legs for maxLegsPerApply"}
            return {ok: true}
        }
    }

    async _rescrapeAircrafts(aircraftIds) {
        if (typeof FleetScheduleGridScraper === "undefined") return 0
        let ok = 0
        for (const aircraftId of aircraftIds || []) {
            try {
                const scraper = new FleetScheduleGridScraper(this.server, {maxConcurrency: 1})
                const res = await scraper.scrapeOne(aircraftId, {force: true})
                if (res && res.ok && res.schedule) ok++
            } catch (e) {
                console.warn("[AES Canvas] post-commit rescrape failed", aircraftId, e)
            }
        }
        return ok
    }

    _toastSummary(s) {
        if (typeof window === "undefined" || !window.RouteAssistantToast) return
        const parts = []
        if (s.ok)        parts.push(s.ok + " applied")
        if (s.dryRun)    parts.push(s.dryRun + " dry-run")
        if (s.rescraped)  parts.push(s.rescraped + " schedule refresh")
        if (s.deferred)  parts.push(s.deferred + " deferred")
        if (s.queued)    parts.push(s.queued + " queued")
        if (s.failed)    parts.push(s.failed + " failed")
        const summaryText = parts.length ? parts.join(" · ") : "No edits"
        const type = s.failed ? "warn" : (s.deferred && !s.ok && !s.handedOff ? "info" : "success")
        let detail = ""
        if (s.deferred) {
            detail = " Open Aircraft Flight Plan to apply the remaining schedule edits"
                + (s.queued ? " (apply path pending)." : ".")
        }
        window.RouteAssistantToast.show("Apply: " + summaryText + "." + detail,
            {type, duration: 6000})
    }
}

function _minToHHMM(min) {
    if (min == null || !isFinite(min)) return null
    const m = Math.max(0, Math.min(1439, Math.round(min)))
    const h = Math.floor(m / 60)
    const mm = m % 60
    return (h < 10 ? "0" + h : h) + ":" + (mm < 10 ? "0" + mm : mm)
}

if (typeof window !== "undefined") {
    window.CanvasCommitBar = CanvasCommitBar
}
