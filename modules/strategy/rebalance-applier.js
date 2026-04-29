"use strict"

/**
 * Phase 4 — fleet-rebalance applier.
 *
 * Closes the loop on Phase 3's preview-only proposers
 * (`AesStrategy.proposeRebalanceMoves` in `rebalance-moves.js`). Takes a
 * `RebalanceProposal` and either applies it via the existing schedule-
 * presets store (for the two wave-shape kinds) or returns advisory when
 * the kind isn't yet wireable end-to-end.
 *
 * Two-gate model (§4.1):
 *   apply.enabled       — kill switch (user opt-in). Default false →
 *                         applier returns {status: "skipped",
 *                         reason: "apply.enabled=false"}.
 *   apply.dryRunOnly    — slice-readiness gate. Default true → mutations
 *                         skipped; returns {status: "dry-run", preview}.
 *   BOTH must be off-default-false flipped before any real write.
 *
 * Anti-spiral (§4.17):
 *   apply.cooldownMinutes  — minimum gap between successful applies.
 *   apply.maxAppliesPer24h — daily cap on `applied` status entries.
 *   The proposer itself caps at maxRebalancesPerWindow per call; this
 *   layer guards against repeated user clicks creating runaway changes.
 *
 * Public API:
 *   AesStrategyRebalanceApplier.apply(proposal, opts?) → ApplyResult
 *
 * ApplyResult:
 *   {
 *     status:     "applied"|"dry-run"|"skipped"|"failed"|"advisory",
 *     proposalId: string,
 *     kind:       string,
 *     hubIata:    string|null,
 *     presetId?:  string,    // when known
 *     waveId?:    string,    // when known
 *     reason?:    string,    // when status in skipped/advisory
 *     error?:     string,    // when status === "failed"
 *     preview?:   object,    // dry-run preview of what WOULD change
 *     ts:         number,
 *     logId:      string|null
 *   }
 *
 * Bus events emitted on success/dry-run:
 *   "fleet-optimizer:proposal-applied" (CentralHubBus + AesStrategy.bus)
 *
 * Outcomes (LEARN — §4.5):
 *   On `applied` status the applier records a before-snapshot via
 *   AesStrategyOutcomes.record({...}) so the existing learn cycle can
 *   attribute fleet-ratio drift back to the rebalance bundle. Failures
 *   in outcome recording must never block the apply path.
 *
 * Dependencies:
 *   - AesStrategyFleetOptimizerSettings (settings + two-gate)
 *   - AesStrategyRebalanceApplyLog (audit ring)
 *   - SchedulePresets (existing CRUD over settings.scheduleManagement)
 *   - AesStrategyOutcomes (best-effort closed-loop attribution)
 *   - CentralHubBus / AesStrategy.bus (best-effort observability)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyRebalanceApplier) return

    const ns = {}

    function _settingsLoader() { return window.AesStrategyFleetOptimizerSettings }
    function _now() { return Date.now() }

    function _emitBus(event, info) {
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit(event, info)
            }
            if (window.AesStrategy && window.AesStrategy.bus
                    && typeof window.AesStrategy.bus.emit === "function") {
                window.AesStrategy.bus.emit(event, info)
            }
        } catch (_) { /* never break apply on a bus listener throw */ }
    }

    async function _logEntry(record) {
        if (typeof window.AesStrategyRebalanceApplyLog !== "function") return null
        try {
            const log = new window.AesStrategyRebalanceApplyLog()
            const saved = await log.add(record)
            return saved && saved.id || null
        } catch (e) {
            console.warn("[AES rebalance-applier] log failed:", e)
            return null
        }
    }

    /**
     * Best-effort outcome recording for the LEARN loop. Snapshot is
     * fetched lazily so dry-run paths can skip the work entirely.
     */
    async function _recordOutcome(proposal, ctx) {
        try {
            if (!window.AesStrategyOutcomes
                    || typeof window.AesStrategyOutcomes.record !== "function") return
            if (!window.AesStrategy || typeof window.AesStrategy.snapshot !== "function") return
            const snap = await window.AesStrategy.snapshot({})
            if (!snap) return
            const before = (typeof window.AesStrategyOutcomes.measure === "function")
                ? window.AesStrategyOutcomes.measure(snap, null) : null
            const planId = "rebalance-" + (proposal.id || _now().toString(36))
            await window.AesStrategyOutcomes.record({
                planId:    planId,
                applyTs:   _now(),
                before:    before,
                weights:   null,
                server:    ctx && ctx.server,
                airlineCode: ctx && ctx.airlineCode,
                rebalance: {
                    kind:    proposal.kind,
                    hubIata: proposal.hubIata,
                    payload: proposal.payload || null
                }
            })
        } catch (e) {
            console.warn("[AES rebalance-applier] outcome record failed:", e)
        }
    }

    /**
     * Find a SchedulePresets entry for the hub. Picks the first preset
     * where `preset.hub` matches; null if none. Caller decides whether
     * to create a starter.
     */
    async function _findPresetForHub(hubIata) {
        if (typeof SchedulePresets === "undefined" || !SchedulePresets.load) return null
        const block = await SchedulePresets.load()
        const presets = (block && block.presets) || []
        const hub = String(hubIata || "").toUpperCase()
        for (const p of presets) {
            if (String(p.hub || "").toUpperCase() === hub) return p
        }
        return null
    }

    async function _createStarterPresetForHub(hubIata, wave) {
        const hub = String(hubIata || "").toUpperCase()
        return await SchedulePresets.create({
            name:  "Wave plan for " + hub,
            hub:   hub,
            waves: [wave]
        })
    }

    /**
     * Build a fresh wave from the proposer's payload — composition and
     * arrival/departure times derived from `suggestedTime` (HH:MM). The
     * departure window sits 75 minutes after arrival start to match the
     * editor's starter conventions (45-min ground gap + 30-min window).
     */
    function _waveFromWaveAddPayload(payload) {
        const time = String(payload && payload.suggestedTime || "09:30")
        const m = /^(\d{1,2}):(\d{2})$/.exec(time)
        const arrStartMin = m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60 + 30
        const fmt = (mm) => {
            const v = Math.max(0, Math.min(24 * 60 - 1, Math.round(mm)))
            return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0")
        }
        const w = SchedulePresets.newWave("Wave " + fmt(arrStartMin))
        w.arrivalWindow   = {start: fmt(arrStartMin),       end: fmt(arrStartMin + 30)}
        w.departureWindow = {start: fmt(arrStartMin + 75),  end: fmt(arrStartMin + 105)}
        const c = (payload && payload.suggestedComposition) || {}
        w.composition = {
            shortHaul:  Math.max(0, Math.min(99, Math.floor(Number(c.shortHaul)  || 0))),
            mediumHaul: Math.max(0, Math.min(99, Math.floor(Number(c.mediumHaul) || 0))),
            longHaul:   Math.max(0, Math.min(99, Math.floor(Number(c.longHaul)   || 0))),
            byDay:      null
        }
        return w
    }

    async function _doWaveAdd(proposal, dryRun) {
        const hub = String(proposal.hubIata || "").toUpperCase()
        if (!hub) return {ok: false, error: "wave-add: no hubIata in proposal"}
        if (typeof SchedulePresets === "undefined" || !SchedulePresets.load) {
            return {ok: false, error: "wave-add: SchedulePresets not loaded on this page"}
        }
        let preset = await _findPresetForHub(hub)
        const willCreatePreset = !preset
        const wave = _waveFromWaveAddPayload(proposal.payload || {})
        const preview = {
            hub,
            willCreatePreset,
            presetId: preset && preset.id || null,
            wave: {
                label: wave.label,
                arrivalWindow: wave.arrivalWindow,
                departureWindow: wave.departureWindow,
                composition: wave.composition
            }
        }
        if (dryRun) return {ok: true, dryRun: true, preview}

        if (!preset) {
            preset = await _createStarterPresetForHub(hub, wave)
            return {ok: true, presetId: preset.id, waveId: wave.id, preview}
        }
        preset.waves = (preset.waves || []).concat(wave)
        const updated = await SchedulePresets.update(preset.id, {waves: preset.waves})
        if (!updated) return {ok: false, error: "wave-add: SchedulePresets.update returned null"}
        return {ok: true, presetId: preset.id, waveId: wave.id, preview}
    }

    async function _doWaveDensify(proposal, dryRun) {
        const p = proposal.payload || {}
        const presetId = String(p.presetId || "")
        const waveId   = String(p.waveId   || "")
        const delta    = Math.max(1, Math.floor(Number(p.deltaShortHaul) || 1))
        if (!presetId || !waveId) {
            return {ok: false, error: "wave-densify: missing presetId/waveId in payload"}
        }
        if (typeof SchedulePresets === "undefined" || !SchedulePresets.load) {
            return {ok: false, error: "wave-densify: SchedulePresets not loaded on this page"}
        }
        const block = await SchedulePresets.load()
        const preset = (block.presets || []).find(x => x.id === presetId)
        if (!preset) return {ok: false, error: "wave-densify: preset " + presetId + " missing"}
        const wave = (preset.waves || []).find(x => x.id === waveId)
        if (!wave)   return {ok: false, error: "wave-densify: wave " + waveId + " missing"}
        const cur = (wave.composition && Number(wave.composition.shortHaul)) || 0
        const next = Math.max(0, Math.min(99, cur + delta))
        const preview = {
            hub: proposal.hubIata,
            presetId, waveId,
            shortHaul: {before: cur, after: next, delta}
        }
        if (dryRun) return {ok: true, dryRun: true, preview}

        wave.composition = Object.assign(
            {shortHaul: 0, mediumHaul: 0, longHaul: 0, byDay: null},
            wave.composition || {},
            {shortHaul: next}
        )
        const updated = await SchedulePresets.update(presetId, {waves: preset.waves})
        if (!updated) return {ok: false, error: "wave-densify: SchedulePresets.update returned null"}
        return {ok: true, presetId, waveId, preview}
    }

    /**
     * service-profile-promote stays advisory in Phase 4. The proposer
     * payload has `profileFromKey: "auto"` / `profileToKey: "auto"`; AS
     * profile-id mapping isn't determined by snapshot data alone. A future
     * slice can wire this through `RouteAssistantServiceProfileApplier`
     * once a per-tail "current profile id → next profile id" mapping
     * lands. For now we surface the rationale and direct the user to the
     * AS profiles page.
     */
    function _doServicePromote(_proposal) {
        return {
            ok: false,
            advisory: true,
            reason: "service-profile-promote stays advisory in Phase 4 — no profile-id mapping yet"
        }
    }

    async function apply(proposal, opts) {
        const o = opts || {}
        const ts = _now()
        const baseRecord = {
            ts,
            proposalId:  proposal && proposal.id || null,
            kind:        proposal && proposal.kind || null,
            hubIata:     proposal && proposal.hubIata || null,
            aircraftIds: proposal && Array.isArray(proposal.aircraftIds) ? proposal.aircraftIds : null,
            predicted:   proposal && proposal.predicted || null,
            payload:     proposal && proposal.payload   || null,
            rationale:   proposal && Array.isArray(proposal.rationale) ? proposal.rationale : null,
            source:      o.source || "manual"
        }

        if (!proposal || !proposal.kind) {
            const logId = await _logEntry(Object.assign({}, baseRecord,
                {status: "failed", error: "missing proposal/kind"}))
            return {status: "failed", error: "missing proposal/kind", ts, logId}
        }

        // ── Two-gate (§4.1) ─────────────────────────────────────────────
        const loader = _settingsLoader()
        if (!loader || typeof loader.load !== "function") {
            const logId = await _logEntry(Object.assign({}, baseRecord,
                {status: "skipped", reason: "fleet-optimizer-settings not loaded"}))
            return {status: "skipped", reason: "fleet-optimizer-settings not loaded",
                    proposalId: proposal.id, kind: proposal.kind, hubIata: proposal.hubIata,
                    ts, logId}
        }
        const settings = await loader.load()
        const ag = (settings && settings.apply) || {}

        if (ag.enabled !== true) {
            const logId = await _logEntry(Object.assign({}, baseRecord,
                {status: "skipped", reason: "apply.enabled=false"}))
            return {status: "skipped", reason: "apply.enabled=false",
                    proposalId: proposal.id, kind: proposal.kind, hubIata: proposal.hubIata,
                    ts, logId}
        }

        // ── Anti-spiral cap (§4.17) ─────────────────────────────────────
        // Only gate on cooldown/cap when a live write is about to happen —
        // dry-runs and skipped paths don't count toward the cap (the log
        // counters already filter to status === "applied", so this is the
        // outer optimization that skips the whole DB read on dry-run).
        if (typeof window.AesStrategyRebalanceApplyLog === "function" && !ag.dryRunOnly) {
            try {
                const log = new window.AesStrategyRebalanceApplyLog()
                const sinceDay = ts - 24 * 3600 * 1000
                const day = await log.countSince(sinceDay)
                if (isFinite(ag.maxAppliesPer24h) && ag.maxAppliesPer24h > 0
                        && day >= ag.maxAppliesPer24h) {
                    const reason = "anti-spiral: " + day + " applies in 24h ≥ cap "
                                 + ag.maxAppliesPer24h
                    const logId = await _logEntry(Object.assign({}, baseRecord,
                        {status: "skipped", reason}))
                    return {status: "skipped", reason,
                            proposalId: proposal.id, kind: proposal.kind, hubIata: proposal.hubIata,
                            ts, logId}
                }
                const lastTs = await log.getLastSuccessAt()
                const cooldownMs = (Number(ag.cooldownMinutes) || 0) * 60 * 1000
                if (lastTs && cooldownMs > 0 && (ts - lastTs) < cooldownMs) {
                    const minsLeft = Math.ceil((cooldownMs - (ts - lastTs)) / 60000)
                    const reason = "cooldown: " + minsLeft + " min remaining"
                    const logId = await _logEntry(Object.assign({}, baseRecord,
                        {status: "skipped", reason}))
                    return {status: "skipped", reason,
                            proposalId: proposal.id, kind: proposal.kind, hubIata: proposal.hubIata,
                            ts, logId}
                }
            } catch (_) { /* fall through — log issues never block apply */ }
        }

        const dryRun = ag.dryRunOnly === true

        // ── Sub-router ──────────────────────────────────────────────────
        let r = null
        if (proposal.kind === "wave-add") {
            r = await _doWaveAdd(proposal, dryRun)
        } else if (proposal.kind === "wave-densify") {
            r = await _doWaveDensify(proposal, dryRun)
        } else if (proposal.kind === "service-profile-promote") {
            r = await _doServicePromote(proposal)
        } else {
            r = {ok: false, error: "unknown proposal kind: " + proposal.kind}
        }

        if (r.advisory) {
            const logId = await _logEntry(Object.assign({}, baseRecord,
                {status: "advisory", reason: r.reason || ""}))
            return {status: "advisory", reason: r.reason,
                    proposalId: proposal.id, kind: proposal.kind, hubIata: proposal.hubIata,
                    ts, logId}
        }
        if (!r.ok) {
            const logId = await _logEntry(Object.assign({}, baseRecord,
                {status: "failed", error: r.error || "unknown"}))
            return {status: "failed", error: r.error,
                    proposalId: proposal.id, kind: proposal.kind, hubIata: proposal.hubIata,
                    ts, logId}
        }

        const status = r.dryRun ? "dry-run" : "applied"
        const presetId = r.presetId || null
        const waveId   = r.waveId   || null
        const logId = await _logEntry(Object.assign({}, baseRecord, {
            status,
            presetId,
            waveId,
            payload: Object.assign({}, baseRecord.payload || {}, {preview: r.preview || null}),
            dryRun:  !!r.dryRun
        }))

        _emitBus("fleet-optimizer:proposal-applied", {
            proposalId: proposal.id,
            kind:       proposal.kind,
            hubIata:    proposal.hubIata,
            status,
            presetId,
            waveId
        })

        if (status === "applied") {
            await _recordOutcome(proposal, o.ctx || {})
        }

        return {
            status, proposalId: proposal.id, kind: proposal.kind, hubIata: proposal.hubIata,
            presetId, waveId, preview: r.preview || null, ts, logId
        }
    }

    ns.apply = apply
    window.AesStrategyRebalanceApplier = ns
})()
