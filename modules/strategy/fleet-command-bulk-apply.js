"use strict"

/**
 * Phase 4 Lane B keystone — bulk wave-plan apply across federated tails.
 *
 * Not a new actuator. Builds a single wave plan from a chosen preset +
 * the matching hub's topRoutes cache, then dispatches per-tail runs to
 * AesAfpFleetApplyOrchestrator (the existing serial-per-aircraft
 * apply pipeline). The orchestrator owns the two-gate per-aircraft
 * tier-gate; this module enforces hub-match preflight on top.
 *
 * §B.5 contract: bulk apply changes *schedule* but never changes *hub*.
 * Mismatched tails are reported with a "switch hub" advisory; never
 * auto-ferried.
 *
 * Public API (window.AesFleetCommandBulkApply):
 *   .preview({tails, presetId, ctx?})  → Promise<PreviewResult>
 *   .execute({tails, presetId, ctx, source?, dryRun?}) → Promise<ExecuteResult>
 *   .loadAuditLog()                    → Promise<BatchEntry[]>
 *   .clearAuditLog()                   → Promise<void>
 *
 * PreviewResult:
 *   {
 *     preset, presetHub,
 *     eligible: TailRow[],
 *     skipped:  [{tail, reason}],
 *     scoredRows, build, flightCount,
 *     readiness: {ok, gates: {presetLoaded, scoredRowsLoaded, orchestratorLoaded,
 *                              flightsBuilt}, blockers: string[]}
 *   }
 *
 * ExecuteResult:
 *   {
 *     batchId, runId,
 *     eligibleCount, skippedCount,
 *     succeeded, failed, aborted,
 *     perAircraft, elapsedMs, source
 *   }
 *
 * Audit ring at `aesCanopy:bulkApply:log` (cap 50 entries, ~3-5 KB):
 *   {
 *     schemaVersion: 1,
 *     entries: [BatchEntry, …]      // newest first, max 50
 *   }
 *   BatchEntry = {batchId, ts, presetId, presetName, presetHub, source,
 *                 eligibleCount, skippedCount, succeeded, failed, aborted,
 *                 elapsedMs, server, accountIds[]}
 */
;(function () {
    if (window.AesFleetCommandBulkApply) return

    const AUDIT_KEY = "aesCanopy:bulkApply:log"
    const AUDIT_CAP = 50
    const TOP_ROUTES_PREFIX = "routeAssistant:topRoutes:"

    function _normaliseHub(h) {
        return String(h || "").toUpperCase().trim()
    }

    function _newBatchId() {
        return "bb-" + Date.now().toString(36)
            + "-" + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
    }

    async function _loadPreset(presetId) {
        if (typeof SchedulePresets === "undefined") return null
        try {
            const block = await SchedulePresets.load()
            const list = (block && Array.isArray(block.presets)) ? block.presets : []
            return list.find(p => p && p.id === presetId) || null
        } catch (e) {
            console.warn("[fleet-command-bulk-apply] preset load failed", e)
            return null
        }
    }

    async function _loadTopRoutes(hubIata) {
        if (!hubIata || typeof chrome === "undefined") return []
        const keys = []
        try {
            if (typeof acctKey === "function") {
                const scoped = acctKey("routeAssistant:topRoutes", hubIata)
                if (scoped) keys.push(scoped)
            }
        } catch (_) {}
        keys.push(TOP_ROUTES_PREFIX + hubIata)
        try {
            const out = await chrome.storage.local.get(Array.from(new Set(keys)))
            for (const key of keys) {
                const blob = out && out[key]
                if (!blob || !Array.isArray(blob.rows)) continue
                if (String(blob.hub || "").toUpperCase() !== _normaliseHub(hubIata)) continue
                return blob.rows
            }
            return []
        } catch (e) {
            console.warn("[fleet-command-bulk-apply] topRoutes load failed", e)
            return []
        }
    }

    function _topRouteToScoredRow(r) {
        if (!r) return null
        return {
            destIata:      r.destIata || null,
            destName:      r.destName || null,
            distanceKm:    typeof r.distanceKm === "number" ? r.distanceKm : null,
            paxScore:      typeof r.paxScore === "number" ? r.paxScore : null,
            cargoScore:    typeof r.cargoScore === "number" ? r.cargoScore : null,
            weeklyFlights: typeof r.weeklyFlights === "number" ? r.weeklyFlights : null,
            airlineCount:  null,
            score:         typeof r.score === "number" ? r.score : null,
            // aircraftFit is per-tail; we don't filter at preview time. The
            // wave-overlay's range filtering still works via distanceKm × the
            // selectedSpec when wave-applier dispatches per-tail later.
            aircraftFit:   null
        }
    }

    function _splitByHub(tails, presetHub) {
        const eligible = []
        const skipped  = []
        for (const t of tails || []) {
            if (!t || !t.aircraftId) {
                skipped.push({tail: t, reason: "missing aircraftId"})
                continue
            }
            const tailHub = _normaliseHub(t.hub || t.locIata)
            if (presetHub && tailHub !== presetHub) {
                skipped.push({tail: t, reason: "hub " + (tailHub || "?") + " ≠ preset hub " + presetHub})
                continue
            }
            eligible.push(t)
        }
        return {eligible, skipped}
    }

    /**
     * Build the wave plan once for the chosen preset + the preset hub's
     * cached topRoutes. The same flights[] is fanned out to every eligible
     * tail. This is consistent with how wave-applier _onApplyToFleet ships
     * a single build to N aircraft (legs are dest-only at fan-out time;
     * each tail's per-aircraft path resolves origin/wave-time from the
     * leg seq + waveId).
     */
    function _buildWavePlan(preset, scoredRows, ctxOverride) {
        if (typeof RouteAssistantWaveOverlay === "undefined") {
            return {
                validation: ["RouteAssistantWaveOverlay not loaded"],
                flights: [], routes: [], warnings: [], placements: [],
                unplaced: [], shortfall: {}, skipped: [], connections: [],
                preset
            }
        }
        const ctx = Object.assign({
            server:      "",
            airlineCode: "",
            hubIata:     _normaliseHub(preset && preset.hub),
            selectedSpec: null,
            topN:        20
        }, ctxOverride || {})
        try {
            return RouteAssistantWaveOverlay.buildSchedule(preset, scoredRows || [], ctx)
        } catch (e) {
            console.warn("[fleet-command-bulk-apply] buildSchedule threw", e)
            return {
                validation: ["buildSchedule threw: " + ((e && e.message) || String(e))],
                flights: [], routes: [], warnings: [], placements: [],
                unplaced: [], shortfall: {}, skipped: [], connections: [],
                preset
            }
        }
    }

    function _readinessFor(preset, scoredRows, build) {
        const blockers = []
        const gates = {
            presetLoaded:        !!preset,
            scoredRowsLoaded:    Array.isArray(scoredRows) && scoredRows.length > 0,
            orchestratorLoaded:  typeof window.AesAfpFleetApplyOrchestrator !== "undefined",
            flightsBuilt:        !!(build && Array.isArray(build.flights) && build.flights.length)
        }
        if (!gates.presetLoaded)
            blockers.push("preset not found")
        if (!gates.scoredRowsLoaded)
            blockers.push("no topRoutes cached for preset hub — visit /app/com/scheduling/<HUB> first")
        if (!gates.orchestratorLoaded)
            blockers.push("AesAfpFleetApplyOrchestrator not loaded on this page (manifest order?)")
        if (gates.presetLoaded && gates.scoredRowsLoaded && !gates.flightsBuilt) {
            const valid = build && Array.isArray(build.validation) ? build.validation : []
            if (valid.length) blockers.push("preset validation: " + valid[0])
            else              blockers.push("wave plan produced no flights")
        }
        return {ok: blockers.length === 0, gates, blockers}
    }

    async function preview(opts) {
        const o = opts || {}
        const tails = Array.isArray(o.tails) ? o.tails : []
        const preset = await _loadPreset(o.presetId)
        const presetHub = preset ? _normaliseHub(preset.hub) : ""
        const {eligible, skipped} = _splitByHub(tails, presetHub)

        const topRoutes = presetHub ? await _loadTopRoutes(presetHub) : []
        const scoredRows = topRoutes.map(_topRouteToScoredRow).filter(Boolean)

        const ctxOverride = Object.assign({}, o.ctx || {}, {
            hubIata: presetHub || (o.ctx && o.ctx.hubIata) || ""
        })
        const build = preset
            ? _buildWavePlan(preset, scoredRows, ctxOverride)
            : null

        const readiness = _readinessFor(preset, scoredRows, build)
        return {
            preset, presetHub,
            eligible, skipped,
            scoredRows, build,
            flightCount: build && Array.isArray(build.flights) ? build.flights.length : 0,
            readiness
        }
    }

    /**
     * Group eligible tails by (server, airlineCode) so the orchestrator
     * runs each account's tails together. The orchestrator itself only
     * loops aircraft (not accounts) — but per-account legs share an
     * AS server which matters for cookie/session isolation.
     */
    function _runsFromTails(eligible, build) {
        const flights = (build && Array.isArray(build.flights)) ? build.flights : []
        if (!flights.length) return []
        return eligible.map(t => ({
            aircraftId: String(t.aircraftId),
            legs:       flights.slice(),
            hub:        _normaliseHub(t.hub || t.locIata)
        }))
    }

    async function execute(opts) {
        const o = opts || {}
        const ctx = (o.ctx && typeof o.ctx === "object") ? o.ctx : {}
        const source = (o.source && String(o.source).slice(0, 40)) || "fleet-command-bulk"
        const dryRun = !!o.dryRun
        const startedAt = Date.now()

        const prev = await preview({tails: o.tails, presetId: o.presetId, ctx})
        const batchId = _newBatchId()

        if (!prev.readiness.ok) {
            const entry = {
                batchId, ts: startedAt,
                presetId:    o.presetId || null,
                presetName:  prev.preset ? (prev.preset.name || null) : null,
                presetHub:   prev.presetHub || null,
                source,
                eligibleCount: prev.eligible.length,
                skippedCount:  prev.skipped.length,
                succeeded:   0,
                failed:      0,
                aborted:     true,
                elapsedMs:   Date.now() - startedAt,
                server:      ctx.server || null,
                accountIds:  _accountIdsFor(prev.eligible),
                blockers:    prev.readiness.blockers.slice(),
                dryRun
            }
            await _appendAudit(entry)
            return Object.assign({
                runId: null, batchId,
                eligibleCount: prev.eligible.length,
                skippedCount:  prev.skipped.length,
                succeeded: 0, failed: 0, aborted: true,
                perAircraft: [], elapsedMs: entry.elapsedMs,
                source, blockers: prev.readiness.blockers,
                preview: prev
            })
        }

        if (dryRun) {
            const entry = {
                batchId, ts: startedAt,
                presetId:    o.presetId || null,
                presetName:  prev.preset.name || null,
                presetHub:   prev.presetHub || null,
                source,
                eligibleCount: prev.eligible.length,
                skippedCount:  prev.skipped.length,
                succeeded:   0,
                failed:      0,
                aborted:     false,
                elapsedMs:   Date.now() - startedAt,
                server:      ctx.server || null,
                accountIds:  _accountIdsFor(prev.eligible),
                dryRun:      true
            }
            await _appendAudit(entry)
            return {
                runId: null, batchId,
                eligibleCount: prev.eligible.length,
                skippedCount:  prev.skipped.length,
                succeeded: 0, failed: 0, aborted: false,
                perAircraft: [], elapsedMs: entry.elapsedMs,
                source, dryRun: true,
                preview: prev
            }
        }

        const runs = _runsFromTails(prev.eligible, prev.build)
        let result = null
        try {
            result = await window.AesAfpFleetApplyOrchestrator.start({
                runs,
                ctx:    {server: ctx.server || ""},
                source: source
            })
        } catch (e) {
            console.warn("[fleet-command-bulk-apply] orchestrator threw", e)
            result = {
                ok: false, aborted: true,
                runId: null, totalSucceeded: 0, totalFailed: runs.length,
                perAircraft: [], elapsedMs: 0,
                error: (e && e.message) || String(e)
            }
        }

        const entry = {
            batchId,
            runId:        result.runId || null,
            ts:           startedAt,
            presetId:     o.presetId || null,
            presetName:   prev.preset.name || null,
            presetHub:    prev.presetHub || null,
            source,
            eligibleCount: prev.eligible.length,
            skippedCount:  prev.skipped.length,
            succeeded:    result.totalSucceeded || 0,
            failed:       result.totalFailed || 0,
            aborted:      !!result.aborted,
            elapsedMs:    result.elapsedMs || (Date.now() - startedAt),
            server:       ctx.server || null,
            accountIds:   _accountIdsFor(prev.eligible)
        }
        await _appendAudit(entry)

        return {
            runId: result.runId || null,
            batchId,
            eligibleCount: prev.eligible.length,
            skippedCount:  prev.skipped.length,
            succeeded:     result.totalSucceeded || 0,
            failed:        result.totalFailed || 0,
            aborted:       !!result.aborted,
            perAircraft:   result.perAircraft || [],
            elapsedMs:     entry.elapsedMs,
            source,
            preview:       prev
        }
    }

    function _accountIdsFor(tails) {
        const set = new Set()
        for (const t of tails || []) if (t && t.accountId) set.add(t.accountId)
        return Array.from(set)
    }

    // ── Audit ring ────────────────────────────────────────────────────

    async function _readAudit() {
        if (typeof chrome === "undefined") return _emptyAudit()
        try {
            const out = await chrome.storage.local.get([AUDIT_KEY])
            const blob = out && out[AUDIT_KEY]
            if (!blob || !Array.isArray(blob.entries)) return _emptyAudit()
            return blob
        } catch (_) {
            return _emptyAudit()
        }
    }

    function _emptyAudit() {
        return {schemaVersion: 1, entries: []}
    }

    async function _appendAudit(entry) {
        if (typeof chrome === "undefined") return
        try {
            const blob = await _readAudit()
            const next = (blob.entries || []).slice()
            next.unshift(entry)
            if (next.length > AUDIT_CAP) next.length = AUDIT_CAP
            await chrome.storage.local.set({[AUDIT_KEY]: {
                schemaVersion: 1,
                entries: next
            }})
        } catch (e) {
            console.warn("[fleet-command-bulk-apply] audit append failed", e)
        }
    }

    async function loadAuditLog() {
        const blob = await _readAudit()
        return Array.isArray(blob.entries) ? blob.entries.slice() : []
    }

    async function clearAuditLog() {
        if (typeof chrome === "undefined") return
        try { await chrome.storage.local.remove([AUDIT_KEY]) }
        catch (e) { console.warn("[fleet-command-bulk-apply] audit clear failed", e) }
    }

    // ── Public namespace ──────────────────────────────────────────────

    window.AesFleetCommandBulkApply = {
        preview,
        execute,
        loadAuditLog,
        clearAuditLog,
        AUDIT_KEY,
        AUDIT_CAP
    }
})()
