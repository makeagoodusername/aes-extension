"use strict"

/**
 * AFP Dashboard — headless candidate + wave-build pipeline.
 *
 * Wraps `AesAfpRouteCandidates.compute` and `AesAfpWaveApplier.buildFromCandidates`
 * so the Fleet Hub dashboard can produce a multi-leg build for a remote
 * aircraft (the user is on `/app/fleets*`, not on the aircraft's own page).
 *
 * Both wrapped modules' static APIs are headless-safe: compute() takes opts
 * directly and the bus-emit on `candidates:updated` is guarded by
 * `if (window.AesAfp && AesAfp.bus)` (route-candidates.js:152), and
 * buildFromCandidates() never touches a DOM slot. We never call
 * `AesAfpRouteCandidates.render()` or `AesAfpWaveApplier.renderPreview()`
 * from here — those need slots that don't exist on the dashboard.
 *
 * Public API:
 *   const pipeline = new AesAfpCandidatePipeline({server, airlineCode})
 *   const build    = await pipeline.generateBuild({aircraftId, formContext, presetId, typeId})
 *   // → {ok: true, build}  | {ok: false, error}
 */
class AesAfpCandidatePipeline {
    constructor(opts) {
        const o = opts || {}
        this.server      = o.server      || ""
        this.airlineCode = o.airlineCode || ""
    }

    /**
     * Run the full pipeline for one aircraft.
     *
     * Inputs:
     *   aircraftId  — AS internal id (from fleet roster)
     *   formContext — pre-fetched via AesAfpProxyPageFetcher; carries hub
     *                 (currentLocationIata), typeId, and the existing-FN
     *                 dest set to seed scheduledDestSet.
     *   presetId    — schedule preset to drive the wave build
     *   typeId      — aircraft type (when formContext didn't surface it)
     *
     * Returns the build object straight from
     * `RouteAssistantWaveOverlay.buildSchedule` plus the candidate list
     * that fed it (so the panel can show both per-leg apply rows and the
     * scored candidate table side-by-side).
     */
    async generateBuild(opts) {
        const o = opts || {}
        const aircraftId  = String(o.aircraftId || "")
        const formContext = o.formContext || null
        const presetId    = o.presetId || null
        if (!aircraftId)  return {ok: false, error: {code: "noAircraftId",   message: "aircraftId required"}}
        if (!formContext) return {ok: false, error: {code: "noFormContext",  message: "formContext required (proxy GET first)"}}

        const hub = String(formContext.currentLocationIata || "").toUpperCase()
        if (!hub || !/^[A-Z]{3}$/.test(hub)) {
            return {ok: false, error: {
                code:    "noHub",
                message: "Aircraft has no resolvable current location IATA — open the aircraft in AS once so AFP records its hub."
            }}
        }

        // Required modules. The fleet-hub manifest entry preloads these
        // (see manifest.json /app/fleets* block + the dashboard expansion).
        const missing = []
        if (typeof AesAfpRouteCandidates       === "undefined") missing.push("AesAfpRouteCandidates")
        if (typeof AesAfpWaveApplier           === "undefined") missing.push("AesAfpWaveApplier")
        if (typeof RouteAssistantSettings      === "undefined") missing.push("RouteAssistantSettings")
        if (typeof RouteAssistantTypeSpecsStore === "undefined") missing.push("RouteAssistantTypeSpecsStore")
        if (typeof SchedulePresets             === "undefined") missing.push("SchedulePresets")
        if (missing.length) {
            return {ok: false, error: {
                code:    "missingDependency",
                message: "Modules not loaded on /app/fleets*: " + missing.join(", ")
            }}
        }

        // Spec — needed for range filtering inside compute(). When typeId
        // is unknown we still try compute() (range-classify falls back to
        // "unknown" which keeps the candidate visible).
        const typeId = o.typeId || formContext.typeId || null
        let spec = null
        if (typeId) {
            try {
                spec = await RouteAssistantTypeSpecsStore.get(typeId)
            } catch (e) { /* non-fatal — spec stays null */ }
        }

        const settings = await RouteAssistantSettings.load()

        // Already-scheduled set: read from the form context's VFP parse
        // (cheaper than a second round-trip + matches what the user sees
        // on the AFP page itself).
        const scheduledDestSet = new Set(
            (formContext.existingFlightNumberDests || [])
                .map(s => String(s || "").toUpperCase())
                .filter(Boolean)
        )
        let scheduleLegs = []
        if (typeof AesAfpScheduleStore !== "undefined"
                && typeof AesAfpScheduleStore.load === "function") {
            try {
                const sched = await AesAfpScheduleStore.load(this.server, aircraftId)
                scheduleLegs = sched && Array.isArray(sched.legs) ? sched.legs : []
            } catch (_) { scheduleLegs = [] }
        }

        // Compute candidates. AesAfpRouteCandidates.compute is async + bus-
        // safe (the emit is guarded). We don't store the result on
        // RouteCandidates.last because there's no AFP slot to render to.
        let candidates = []
        try {
            candidates = await AesAfpRouteCandidates.compute({
                originIata: hub,
                spec,
                settings,
                scheduledDestSet,
                scheduleLegs
            })
        } catch (e) {
            return {ok: false, error: {
                code:    "candidatesThrew",
                message: "RouteCandidates.compute threw: " + ((e && e.message) || String(e))
            }}
        }
        if (!candidates || !candidates.length) {
            return {ok: false, error: {
                code:    "noCandidates",
                message: "No candidates produced — has FlightsFrom data been seeded for " + hub + "? Visit flightsfrom.com/" + hub + " in another tab to populate."
            }}
        }

        // Resolve preset. Falls back to the default-preset-for-this-hub
        // when the panel didn't pre-select one.
        const presetBlock = await SchedulePresets.load()
        const presets = (presetBlock && Array.isArray(presetBlock.presets)) ? presetBlock.presets : []
        let preset = null
        if (presetId) preset = presets.find(p => p.id === presetId) || null
        if (!preset) {
            // Prefer presets hub-stamped to this aircraft's hub. Match
            // wave-applier's `_visiblePresets` filter.
            preset = presets.find(p => String((p && p.hub) || "").toUpperCase() === hub)
                  || (presetBlock.defaultPresetId
                        ? presets.find(p => p.id === presetBlock.defaultPresetId)
                        : null)
                  || presets[0]
                  || null
        }
        if (!preset) {
            return {ok: false, error: {
                code:    "noPreset",
                message: "No schedule preset configured. Create one on the AES dashboard → Schedule Management."
            }}
        }

        // Build the wave plan. ctx mirrors what wave-applier.buildFromCandidates
        // expects; we synthesise the bits an AFP page would normally provide.
        const ctx = {
            server:               this.server,
            airlineCode:          this.airlineCode,
            aircraftId,
            registration:         formContext.registration || null,
            equipment:            formContext.equipment    || null,
            currentLocationIata:  hub
        }

        let build
        try {
            build = AesAfpWaveApplier.buildFromCandidates({preset, candidates, ctx, spec})
            this._applyScheduleConflictValidation(build, scheduleLegs)
        } catch (e) {
            return {ok: false, error: {
                code:    "buildThrew",
                message: "WaveApplier.buildFromCandidates threw: " + ((e && e.message) || String(e))
            }}
        }
        return {ok: true, build, candidates, preset, hub, spec}
    }

    _applyScheduleConflictValidation(build, scheduleLegs) {
        if (!build || !Array.isArray(build.flights) || !build.flights.length) return
        if (!Array.isArray(scheduleLegs) || !scheduleLegs.length) return
        const conflicts = this._findScheduleConflicts(build.flights, scheduleLegs)
        if (!conflicts.length) return

        const samples = conflicts.slice(0, 4).map(c => {
            return c.proposed.day + " " + c.proposed.route + " " + c.proposed.time
                + " overlaps " + c.current.route + " " + c.current.time
        })
        const more = conflicts.length > samples.length ? " +" + (conflicts.length - samples.length) + " more" : ""
        build.validation = Array.isArray(build.validation) ? build.validation.slice() : []
        build.validation.push(
            "Generated wave plan overlaps the current aircraft schedule: "
            + samples.join("; ") + more
            + ". Adjust the wave windows or pick a less-busy aircraft before dry-running these legs."
        )
        build.metadata = Object.assign({}, build.metadata || {}, {
            scheduleConflictCount: conflicts.length
        })
    }

    _findScheduleConflicts(proposedFlights, scheduleLegs) {
        const current = []
        for (const leg of scheduleLegs) {
            const interval = this._intervalFromScheduleLeg(leg)
            if (interval) current.push(interval)
        }
        if (!current.length) return []

        const conflicts = []
        for (const f of proposedFlights) {
            const intervals = this._intervalsFromProposedFlight(f)
            for (const p of intervals) {
                const hit = current.find(c => p.start < c.end && c.start < p.end)
                if (hit) conflicts.push({proposed: p, current: hit})
            }
        }
        return conflicts
    }

    _intervalFromScheduleLeg(leg) {
        if (!leg || !Number.isInteger(leg.dayIdx)) return null
        const dep = this._parseHHMM(leg.depTimeLocal || leg.depTime)
        const arr = this._parseHHMM(leg.arrTimeLocal || leg.arrTime)
        if (dep == null || arr == null) return null
        let start = leg.dayIdx * 1440 + dep
        let end = leg.dayIdx * 1440 + arr
        if (leg.spansIntoNext || end <= start) end += 1440
        return {
            start,
            end,
            day: this._dayName(leg.dayIdx),
            route: this._routeLabel(leg),
            time: this._fmtInterval(dep, arr)
        }
    }

    _intervalsFromProposedFlight(flight) {
        if (!flight) return []
        const dep = this._parseHHMM(flight.depTimeLocal || flight.depTime)
        const arr = this._parseHHMM(flight.arrTimeLocal || flight.arrTime)
        if (dep == null || arr == null) return []
        const days = this._dayMaskIndices(flight.dayMask)
        const out = []
        for (const dayIdx of days) {
            let start = dayIdx * 1440 + dep
            let end = dayIdx * 1440 + arr
            if (end <= start) end += 1440
            out.push({
                start,
                end,
                day: this._dayName(dayIdx),
                route: this._routeLabel(flight),
                time: this._fmtInterval(dep, arr)
            })
        }
        return out
    }

    _dayMaskIndices(mask) {
        if (Array.isArray(mask) && mask.length) {
            const out = []
            for (let i = 0; i < Math.min(mask.length, 7); i++) {
                if (mask[i]) out.push(i)
            }
            return out.length ? out : [0, 1, 2, 3, 4, 5, 6]
        }
        return [0, 1, 2, 3, 4, 5, 6]
    }

    _parseHHMM(v) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim())
        if (!m) return null
        const h = Number(m[1])
        const min = Number(m[2])
        if (!isFinite(h) || !isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null
        return h * 60 + min
    }

    _fmtInterval(depMin, arrMin) {
        return this._fmtHHMM(depMin) + "-" + this._fmtHHMM(arrMin)
    }

    _fmtHHMM(min) {
        const m = Math.max(0, Math.min(1439, Number(min) || 0))
        return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0")
    }

    _routeLabel(leg) {
        const origin = String((leg && leg.origin) || "?").toUpperCase()
        const dest = String((leg && leg.destination) || "?").toUpperCase()
        return origin + "->" + dest
    }

    _dayName(idx) {
        return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][idx] || ("D" + idx)
    }
}

if (typeof window !== "undefined") {
    window.AesAfpCandidatePipeline = AesAfpCandidatePipeline
}
