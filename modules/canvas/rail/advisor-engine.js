"use strict"

/**
 * CanvasAdvisorEngine — reaction-feed engine for staged edits.
 *
 * Subscribes to `canvas:edit-staged` and runs a check pipeline against
 * the proposed edit. Each check returns 0 or more suggestion objects
 * which the engine emits on `canvas:advisor-suggestion`. The rail then
 * renders one Advisor card per suggestion.
 *
 * V1 ships four checks:
 *   1. Maintenance conflict (synthetic — flagged when any aircraft has a
 *      maintenance window in the next 7 days; we don't yet check the
 *      specific wave overlap because per-day positioning isn't computed
 *      in V1).
 *   2. Demand sanity (does cached demand actually mention this dest at
 *      all? high paxScore = quiet; low/missing = warn).
 *   3. Wave composition fit (does the wave's composition allow another
 *      route of any length? If composition counts are all 0, we can't
 *      bias — emit info only).
 *   4. Duplicate destination (this aircraft already has the same dest
 *      in another wave — note as info; not always wrong).
 *
 * Suggestions debounce per (kind, route signature) using
 * `AesCanvasStateStore.advisorPrefs.debouncedSuggestions` so dismissed
 * advice doesn't re-fire on every drag.
 */
class CanvasAdvisorEngine {

    static SEVERITY_INFO  = "info"
    static SEVERITY_WARN  = "warn"
    static SEVERITY_ERROR = "error"

    constructor(deps) {
        const d = deps || {}
        this.getInputs = typeof d.getInputs === "function" ? d.getInputs : (() => ({}))
        // dispatch is an object {stage, unstage} from the rail controller —
        // checks call into it from their action.run() to stage replacement
        // edits or unstage problematic ones. Optional; checks fall through
        // to action-less suggestions when dispatch is missing (older callers).
        this.dispatch  = (d.dispatch && typeof d.dispatch === "object") ? d.dispatch : null
        this._busOff = []
    }

    start() {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        const off = window.CentralHubBus.on(window.AesCanvasEvents.EDIT_STAGED, (e) => this._onEditStaged(e))
        this._busOff.push(off)
    }

    stop() {
        for (const off of this._busOff) { try { off() } catch (_) {} }
        this._busOff = []
    }

    async _onEditStaged(event) {
        if (!event || !event.payload) return
        const ctx = this._safeInputs()
        const checks = [
            (e) => this._checkMaintenance(e, ctx),
            (e) => this._checkDemandSanity(e, ctx),
            (e) => this._checkComposition(e, ctx),
            (e) => this._checkDuplicate(e, ctx)
        ]
        for (const fn of checks) {
            let result = null
            try { result = fn(event.payload) }
            catch (err) { console.warn("[AES Canvas] advisor check threw", err); continue }
            if (!result) continue
            const arr = Array.isArray(result) ? result : [result]
            for (const s of arr) {
                if (!s || !s.message) continue
                const suggestion = Object.assign(
                    {id: "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)},
                    s)
                if (await this._isDebounced(suggestion)) continue
                this._emit(suggestion)
            }
        }
    }

    _emit(s) {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        window.CentralHubBus.emit(window.AesCanvasEvents.ADVISOR_SUGGESTION, s)
    }

    async _isDebounced(s) {
        try {
            const state = (typeof window !== "undefined" && window.AesCanvasStateStore)
                ? await window.AesCanvasStateStore.load() : null
            if (!state || !state.advisorPrefs) return false
            const key = s.dedupeKey || (s.kind + ":" + (s.signature || ""))
            const ts = state.advisorPrefs.debouncedSuggestions && state.advisorPrefs.debouncedSuggestions[key]
            if (!ts) return false
            // 1 hour debounce window — long enough that a session of edits
            // doesn't keep nagging, short enough that real changes resurface.
            return (Date.now() - ts) < 60 * 60 * 1000
        } catch (_) { return false }
    }

    _safeInputs() {
        try { return this.getInputs() || {} }
        catch (_) { return {} }
    }

    _checkMaintenance(edit, ctx) {
        const aid = edit && edit.aircraftId
        if (!aid) return null
        const map = ctx && ctx.maintenance instanceof Map ? ctx.maintenance : null
        if (!map) return null
        const rec = map.get(String(aid))
        if (!rec) return null
        // Fire when *any* maintenance window is within 7 days from now —
        // the precise per-day check needs allocator output we don't have
        // in this surface.
        const nowDays = Math.floor(Date.now() / 86400000)
        const windows = (rec && Array.isArray(rec.windows)) ? rec.windows : []
        let near = null
        for (const w of windows) {
            if (!w || !isFinite(w.startDay)) continue
            const delta = w.startDay - nowDays
            if (delta >= 0 && delta <= 7) {
                if (!near || w.startDay < near.startDay) near = w
            }
        }
        if (!near) return null
        const alt = (edit.kind === "addRoute" && this.dispatch)
            ? this._findAltAircraft(aid, edit.hub || (ctx && ctx.hub), ctx) : null
        const action = alt
            ? {
                label: "Re-route to " + (alt.registration || alt.aircraftId),
                run: () => {
                    this.dispatch.unstage({matchKind: "addRoute", aircraftId: aid, destIata: edit.destIata})
                    this.dispatch.stage({
                        kind:    "addRoute",
                        payload: Object.assign({}, edit, {aircraftId: alt.aircraftId, source: "advisor-reroute"})
                    })
                }
            }
            : null
        return {
            kind:        "maintenance-near",
            severity:    CanvasAdvisorEngine.SEVERITY_WARN,
            signature:   aid + ":" + near.startDay,
            message:     "Aircraft " + aid + " has a maintenance window in the next week. Adding flights may push the schedule into it.",
            action
        }
    }

    _checkDemandSanity(edit, ctx) {
        if (edit.kind !== "addRoute") return null
        const score = Number(edit.paxScore) || 0
        if (score >= 30) return null  // healthy demand
        const hub = edit.hub || (ctx && ctx.hub) || ""
        const dest = edit.destIata || ""
        const action = (typeof window !== "undefined" && window.CentralHubBus && hub && dest)
            ? {
                label: "Open in RA",
                run: () => window.CentralHubBus.emit("focus-route", {hub, dest, source: "advisor"})
            }
            : null
        if (score === 0) {
            return {
                kind:      "demand-missing",
                severity:  CanvasAdvisorEngine.SEVERITY_INFO,
                signature: (edit.aircraftId || "?") + ":" + (dest || "?"),
                message:   "Adding " + (dest || "?") + " — no demand score in cache. Open Route Assistant to refresh demand for this hub.",
                action
            }
        }
        return {
            kind:      "demand-thin",
            severity:  CanvasAdvisorEngine.SEVERITY_INFO,
            signature: (edit.aircraftId || "?") + ":" + (dest || "?"),
            message:   (dest || "?") + " has paxScore " + score + " — below typical 30+ threshold. May not pay back.",
            action
        }
    }

    _checkComposition(edit, ctx) {
        if (edit.kind !== "addRoute") return null
        const preset = ctx && ctx.preset
        const wave = preset && Array.isArray(preset.waves)
            ? preset.waves.find(w => w && w.id === edit.waveId) : null
        if (!wave) return null
        const comp = wave.composition || {}
        const total = (comp.shortHaul || 0) + (comp.mediumHaul || 0) + (comp.longHaul || 0)
        if (total > 0) return null
        const hub = preset.hub || (ctx && ctx.hub) || ""
        const action = (typeof window !== "undefined")
            ? {
                label: "Open Wave Editor",
                run: () => {
                    if (window.RouteAssistantWaveEditor && typeof window.RouteAssistantWaveEditor.open === "function") {
                        try { window.RouteAssistantWaveEditor.open({hub, presetId: preset.id}); return }
                        catch (_) {}
                    }
                    if (window.CentralHubBus) {
                        window.CentralHubBus.emit("open-tile", {
                            tileId: "fleet-schedule-canvas",
                            filter: {hub, view: "wave-editor"}
                        })
                    }
                }
            }
            : null
        return {
            kind:      "composition-unset",
            severity:  CanvasAdvisorEngine.SEVERITY_INFO,
            signature: (preset.id || "?") + ":" + (wave.id || "?"),
            message:   "Wave \"" + (wave.label || wave.id) + "\" has no composition set. Allocator hints will be weak — consider setting S/M/L counts.",
            action
        }
    }

    _checkDuplicate(edit, ctx) {
        if (edit.kind !== "addRoute") return null
        const sched = ctx && ctx.schedules instanceof Map
            ? ctx.schedules.get(String(edit.aircraftId)) : null
        if (!sched || !Array.isArray(sched.legs)) return null
        for (const leg of sched.legs) {
            if (leg && leg.destination === edit.destIata) {
                const action = this.dispatch
                    ? {
                        label: "Discard duplicate",
                        run: () => this.dispatch.unstage({
                            matchKind: "addRoute",
                            aircraftId: edit.aircraftId,
                            destIata:   edit.destIata
                        })
                    }
                    : null
                return {
                    kind:      "duplicate-dest",
                    severity:  CanvasAdvisorEngine.SEVERITY_INFO,
                    signature: edit.aircraftId + ":" + edit.destIata,
                    message:   "Aircraft " + edit.aircraftId + " already serves " + edit.destIata + " in another wave. Confirm this is the desired second daily.",
                    action
                }
            }
        }
        return null
    }

    /**
     * Find another aircraft on the same hub with no maintenance window in
     * the next 7 days. Used by `_checkMaintenance` to power the "Re-route"
     * remediation. Returns the fleet row (carries `aircraftId` + optional
     * `registration`) or null when no clean alternative exists.
     */
    _findAltAircraft(currentAircraftId, hub, ctx) {
        const fleet = ctx && Array.isArray(ctx.fleet) ? ctx.fleet : null
        if (!fleet || !fleet.length) return null
        const HUB = String(hub || "").toUpperCase()
        const map = ctx && ctx.maintenance instanceof Map ? ctx.maintenance : null
        const nowDays = Math.floor(Date.now() / 86400000)
        for (const row of fleet) {
            if (!row || row.aircraftId == null) continue
            if (String(row.aircraftId) === String(currentAircraftId)) continue
            if (HUB) {
                const rowHub = String(row.hub || row.locIata || "").toUpperCase()
                if (rowHub && rowHub !== HUB) continue
            }
            if (map) {
                const rec = map.get(String(row.aircraftId))
                const windows = (rec && Array.isArray(rec.windows)) ? rec.windows : []
                let conflict = false
                for (const w of windows) {
                    if (!w || !isFinite(w.startDay)) continue
                    const delta = w.startDay - nowDays
                    if (delta >= 0 && delta <= 7) { conflict = true; break }
                }
                if (conflict) continue
            }
            return row
        }
        return null
    }
}

if (typeof window !== "undefined") {
    window.CanvasAdvisorEngine = CanvasAdvisorEngine
}
