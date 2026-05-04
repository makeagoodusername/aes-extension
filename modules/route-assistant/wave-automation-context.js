"use strict"

/**
 * Wave automation context.
 *
 * Read-only join over the wave template store, recent Route Assistant demand
 * cache, existing fleet rows, optional station state, and the canonical wave
 * build/diagnostic helpers. This is the shared "can automation use this wave
 * plan right now?" facade for Fleet Hub, Canvas Builder, and strategy-adjacent
 * wave actions.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesWaveAutomationContext) return

    const TOP_N = 50
    const DEFAULT_FRESH_MS = 6 * 60 * 60 * 1000

    async function buildForHub(opts) {
        const o = opts || {}
        const hub = _iata(o.hub)
        const out = _emptyContext(hub)
        if (!hub) {
            _block(out, "invalidHub", "Choose a valid three-letter hub.")
            return _finalise(out)
        }

        const block = o.presetsBlock || await _loadPresetsBlock()
        const presets = block && Array.isArray(block.presets) ? block.presets : []
        out.preset = await _resolvePreset(hub, presets, block, o)
        out.fleetSummary = _fleetSummary(hub, o.rows || o.fleet || [])

        if (!out.preset) {
            _block(out, "noPreset", "No wave preset exists for " + hub + ".")
            out.actions.createStarter.enabled = true
            out.actions.createStarter.reason = "Create a starter preset for " + hub + "."
            return _finalise(out)
        }

        out.capacity = _capacitySummary(out.preset)
        if (!out.capacity.activeWaves) {
            _block(out, "noActiveWaves", "The selected preset has no active waves.")
        }
        if (!out.capacity.totalSlots) {
            _block(out, "noCapacity", "The selected preset has no short, medium, or long-haul capacity.")
        }
        if (out.fleetSummary.total === 0) {
            _block(out, "noAircraft", "No aircraft are currently parked at " + hub + ".")
        }

        out.topRoutes = await _loadTopRoutes(hub, o)
        if (!out.topRoutes.rows.length) {
            _block(out, "noTopRoutes", "No cached Route Assistant top-routes snapshot for " + hub + ".")
        } else if (out.topRoutes.ageMs != null && out.topRoutes.ageMs > (o.topRoutesFreshMs || DEFAULT_FRESH_MS)) {
            out.readiness.warnings.push({
                code: "staleTopRoutes",
                message: "Top-routes cache is " + _ageText(out.topRoutes.ageMs) + " old."
            })
        }

        const stationState = await _resolveStationState(o)
        out.stationSummary = _stationSummary(out.topRoutes.rows, stationState)
        if (out.stationSummary.known && out.stationSummary.missing > 0) {
            out.readiness.warnings.push({
                code: "missingStations",
                message: out.stationSummary.missing + " cached destination(s) do not have an open station."
            })
        }

        if (out.preset && out.topRoutes.rows.length
                && typeof window.RouteAssistantWaveOverlay !== "undefined"
                && typeof window.RouteAssistantWaveOverlay.buildSchedule === "function") {
            try {
                out.build = window.RouteAssistantWaveOverlay.buildSchedule(
                    out.preset,
                    out.topRoutes.rows,
                    {
                        hubIata:     hub,
                        topN:        Math.max(1, Math.min(TOP_N, out.topRoutes.rows.length)),
                        selectedSpec: o.selectedSpec || null,
                        fleetSpecs:   o.fleetSpecs || null
                    }
                )
                if (out.build && Array.isArray(out.build.validation) && out.build.validation.length) {
                    _block(out, "presetValidation", "Preset validation: " + out.build.validation[0])
                }
                if (!out.build || !Array.isArray(out.build.flights) || !out.build.flights.length) {
                    if (out.topRoutes.rows.length && out.capacity.totalSlots) {
                        _block(out, "noFlightsBuilt", "Wave build produced no flights from the cached route list.")
                    }
                }
            } catch (err) {
                _block(out, "buildFailed", "Wave build failed: " + _errText(err))
            }
        } else if (out.topRoutes.rows.length) {
            out.readiness.warnings.push({
                code: "diagnosticsUnavailable",
                message: "Wave build modules are not loaded on this page."
            })
        }

        if (out.build && typeof window.RouteAssistantWavePlanDiagnostics !== "undefined"
                && typeof window.RouteAssistantWavePlanDiagnostics.scorePlan === "function") {
            try {
                out.diagnostics = window.RouteAssistantWavePlanDiagnostics.scorePlan(
                    out.build,
                    out.topRoutes.rows,
                    {hubIata: hub, selectedSpec: o.selectedSpec || null, fleetSpecs: o.fleetSpecs || null,
                     fleetCount: Math.max(1, out.fleetSummary.total)}
                )
                _mergeDiagnostics(out)
            } catch (err) {
                out.readiness.warnings.push({
                    code: "diagnosticsFailed",
                    message: "Wave diagnostics failed: " + _errText(err)
                })
            }
        }

        _deriveActions(out)
        return _finalise(out)
    }

    function _emptyContext(hub) {
        return {
            hub: hub || "",
            preset: null,
            build: null,
            diagnostics: null,
            topRoutes: {
                rows: [],
                count: 0,
                sourceKey: null,
                scrapedAt: null,
                ageMs: null,
                fresh: false
            },
            fleetSummary: {total: 0, drafted: 0, undrafted: 0},
            stationSummary: {known: false, source: "unknown", open: 0, missing: 0, unknown: 0},
            capacity: {
                activeWaves: 0,
                totalWaves: 0,
                totalSlots: 0,
                usedSlots: 0,
                unplaced: 0,
                underfilledWaveIds: []
            },
            readiness: {
                ok: false,
                status: "blocked",
                score: null,
                grade: "n/a",
                blockers: [],
                warnings: []
            },
            actions: {
                createStarter: {enabled: false, reason: ""},
                diagnose:      {enabled: false, reason: ""},
                buildPreview:  {enabled: false, reason: ""},
                openCanvas:    {enabled: false, reason: ""},
                applyToFleet:  {enabled: false, reason: ""}
            }
        }
    }

    async function _loadPresetsBlock() {
        try {
            if (typeof window.SchedulePresets !== "undefined"
                    && typeof window.SchedulePresets.load === "function") {
                return await window.SchedulePresets.load()
            }
        } catch (_) {}
        return {presets: [], defaultPresetId: null}
    }

    async function _resolvePreset(hub, presets, block, opts) {
        if (opts && opts.preset && typeof opts.preset === "object") {
            const presetHub = String(opts.preset.hub || "").toUpperCase()
            if (!presetHub || presetHub === hub) return opts.preset
        }
        const explicitId = opts && opts.presetId ? String(opts.presetId) : ""
        if (explicitId) {
            const p = presets.find(x => x && String(x.id) === explicitId)
            if (p) return p
        }

        try {
            if (window.AesWaveRegistry && typeof window.AesWaveRegistry.build === "function") {
                const view = await window.AesWaveRegistry.build()
                const id = view && view.defaults && typeof view.defaults.forHub === "function"
                    ? view.defaults.forHub(hub)
                    : null
                if (id) {
                    const p = presets.find(x => x && String(x.id) === String(id))
                    if (p) return p
                }
            }
        } catch (_) {}

        const matching = presets.filter(p => p && String(p.hub || "").toUpperCase() === hub)
        if (matching.length) {
            matching.sort((a, b) => {
                const ap = a.pinned ? 1 : 0
                const bp = b.pinned ? 1 : 0
                if (ap !== bp) return bp - ap
                return (Number(b.templateRevision) || 0) - (Number(a.templateRevision) || 0)
            })
            return matching[0]
        }

        if (opts && opts.allowGlobalDefault && block && block.defaultPresetId) {
            return presets.find(p => p && p.id === block.defaultPresetId) || null
        }
        return null
    }

    async function _loadTopRoutes(hub, opts) {
        if (Array.isArray(opts.demandRows)) {
            const rows = _normaliseRows(opts.demandRows, hub)
            return {
                rows,
                count: rows.length,
                sourceKey: "input",
                scrapedAt: null,
                ageMs: null,
                fresh: true
            }
        }

        const keys = []
        try {
            if (typeof window.acctKey === "function") {
                const scoped = window.acctKey("routeAssistant:topRoutes", hub)
                if (scoped) keys.push(scoped)
            } else if (typeof acctKey === "function") {
                const scoped = acctKey("routeAssistant:topRoutes", hub)
                if (scoped) keys.push(scoped)
            }
        } catch (_) {}
        keys.push("routeAssistant:topRoutes:" + hub, "routeAssistant:topRoutes")

        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            return _emptyTopRoutes()
        }
        try {
            const data = await chrome.storage.local.get(Array.from(new Set(keys)))
            for (const key of keys) {
                const blob = data && data[key]
                if (!blob || !Array.isArray(blob.rows)) continue
                if (String(blob.hub || "").toUpperCase() !== hub) continue
                if (opts.server && blob.server && String(blob.server) !== String(opts.server)) continue
                if (opts.airlineCode && blob.airlineCode && String(blob.airlineCode) !== String(opts.airlineCode)) continue
                const rows = _normaliseRows(blob.rows, hub)
                const scrapedAt = Number(blob.scrapedAt || blob.updatedAt || 0) || null
                const ageMs = scrapedAt ? Math.max(0, Date.now() - scrapedAt) : null
                return {
                    rows,
                    count: rows.length,
                    sourceKey: key,
                    scrapedAt,
                    ageMs,
                    fresh: ageMs == null ? false : ageMs <= (opts.topRoutesFreshMs || DEFAULT_FRESH_MS)
                }
            }
        } catch (_) {}
        return _emptyTopRoutes()
    }

    function _emptyTopRoutes() {
        return {rows: [], count: 0, sourceKey: null, scrapedAt: null, ageMs: null, fresh: false}
    }

    function _normaliseRows(rows, hub) {
        const hubU = _iata(hub)
        const seen = new Set()
        const out = []
        for (const row of rows || []) {
            const n = _normaliseRow(row)
            if (!n || !n.destIata || n.destIata === hubU) continue
            if (seen.has(n.destIata)) continue
            seen.add(n.destIata)
            out.push(n)
        }
        return out
    }

    function _normaliseRow(row) {
        if (!row || typeof row !== "object") return null
        const destIata = _iata(row.destIata || row.dest || row.iata || row.destination || row.airportIata)
        if (!destIata) return null
        const demand = row.demand && typeof row.demand === "object" ? row.demand : {}
        return {
            destIata,
            destName:      row.destName || row.name || row.airportName || "",
            airportId:     row.airportId || row.stationId || null,
            countryId:     row.countryId || null,
            distanceKm:    _num(row.distanceKm != null ? row.distanceKm : row.distance),
            score:         _num(row.score),
            status:        row.status || null,
            aircraftFit:   row.aircraftFit || null,
            paxScore:      _num(row.paxScore != null ? row.paxScore : demand.paxScore),
            cargoScore:    _num(row.cargoScore != null ? row.cargoScore : demand.cargoScore),
            weeklyFlights: _num(row.weeklyFlights),
            profitPerWeek: _num(row.profitPerWeek),
            classBreakdown: row.classBreakdown || null
        }
    }

    async function _resolveStationState(opts) {
        const o = opts || {}
        if (o.stationState && o.stationState.known) return o.stationState
        if (o.existingStations instanceof Set) {
            return {known: true, source: "input", set: o.existingStations}
        }
        if (Array.isArray(o.existingStations)) {
            return {known: true, source: "input", set: new Set(o.existingStations.map(_iata).filter(Boolean))}
        }
        if (!o.fetchStations || !o.server) return {known: false, source: "unknown", set: null}
        try {
            if (typeof window.CountryScraper !== "undefined"
                    && typeof window.CountryScraper.loadExistingStationIatas === "function") {
                const set = await window.CountryScraper.loadExistingStationIatas(o.server)
                return {known: true, source: "CountryScraper", set}
            }
        } catch (_) {}
        return {known: false, source: "unavailable", set: null}
    }

    function _stationSummary(rows, stationState) {
        const out = {known: !!(stationState && stationState.known), source: stationState && stationState.source || "unknown",
                     open: 0, missing: 0, unknown: 0}
        if (!out.known || !stationState.set) {
            out.unknown = rows.length
            return out
        }
        for (const row of rows) {
            if (!row || !row.destIata) continue
            if (stationState.set.has(row.destIata)) out.open++
            else out.missing++
        }
        return out
    }

    function _fleetSummary(hub, rows) {
        const out = {total: 0, drafted: 0, undrafted: 0}
        for (const r of rows || []) {
            const rowHub = String(r && (r.hub || r.gravityHub || r.locIata) || "").toUpperCase()
            if (rowHub !== hub) continue
            out.total++
            if (r.hasDraftedPlan) out.drafted++
        }
        out.undrafted = Math.max(0, out.total - out.drafted)
        return out
    }

    function _capacitySummary(preset) {
        const waves = Array.isArray(preset && preset.waves) ? preset.waves : []
        const active = waves.filter(w => w && !w.archivedAt)
        let totalSlots = 0
        for (const w of active) totalSlots += _waveSlots(w)
        return {
            activeWaves: active.length,
            totalWaves: waves.length,
            totalSlots,
            usedSlots: 0,
            unplaced: 0,
            underfilledWaveIds: active.map(w => w.id).filter(Boolean)
        }
    }

    function _waveSlots(wave) {
        const c = (wave && wave.composition) || {}
        return (Number(c.shortHaul) || 0) + (Number(c.mediumHaul) || 0) + (Number(c.longHaul) || 0)
    }

    function _mergeDiagnostics(out) {
        const d = out.diagnostics
        if (!d) return
        const score = Number(d.planScore)
        out.readiness.score = isFinite(score) ? score : null
        out.readiness.grade = d.planGrade || "n/a"
        out.capacity.usedSlots = 0
        out.capacity.underfilledWaveIds = []
        for (const pw of d.perWave || []) {
            out.capacity.usedSlots += Number(pw.slotsUsed) || 0
            if ((Number(pw.slotsTotal) || 0) > (Number(pw.slotsUsed) || 0) && pw.waveId) {
                out.capacity.underfilledWaveIds.push(pw.waveId)
            }
        }
        out.capacity.unplaced = d.unplaceable && Number(d.unplaceable.count) || 0
        if (out.capacity.unplaced > 0) {
            out.readiness.warnings.push({
                code: "unplacedRoutes",
                message: out.capacity.unplaced + " route(s) could not be placed in the current waves."
            })
        }
        for (const w of d.warnings || []) {
            if (!w || !w.message) continue
            out.readiness.warnings.push({
                code: w.source || "diagnostic",
                message: w.message,
                severity: w.severity || "warn",
                waveId: w.waveId || null
            })
        }
    }

    function _deriveActions(out) {
        out.actions.diagnose.enabled = !!out.preset
        out.actions.diagnose.reason = out.preset ? "Show wave readiness and per-wave diagnostics." : "Create a preset first."

        out.actions.openCanvas.enabled = !!(out.preset && out.fleetSummary.total > 0)
        out.actions.openCanvas.reason = out.actions.openCanvas.enabled
            ? "Open Schedule Canvas in Builder mode for " + out.hub + "."
            : "Needs a preset and at least one aircraft at the hub."

        const buildReady = !!(out.preset && out.topRoutes.rows.length && out.capacity.totalSlots && out.fleetSummary.total)
        out.actions.buildPreview.enabled = buildReady
        out.actions.buildPreview.reason = buildReady
            ? "Build a gated preview from cached demand and this wave preset."
            : "Needs preset capacity, cached demand, and hub aircraft."

        const hasFlights = !!(out.build && Array.isArray(out.build.flights) && out.build.flights.length)
        out.actions.applyToFleet.enabled = buildReady && hasFlights && out.readiness.blockers.length === 0
        out.actions.applyToFleet.reason = out.actions.applyToFleet.enabled
            ? "Run existing dry-run/confirmation fleet apply for this preset."
            : "Resolve blockers before fleet apply."
    }

    function _block(out, code, message) {
        out.readiness.blockers.push({code, message})
    }

    function _finalise(out) {
        out.readiness.ok = out.readiness.blockers.length === 0
        out.readiness.status = out.readiness.blockers.length
            ? "blocked"
            : out.readiness.warnings.length ? "attention" : "ready"
        if (!out.actions.createStarter.reason) out.actions.createStarter.reason = "A preset already exists for this hub."
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("waves:diagnostics-built", {
                    hub: out.hub,
                    presetId: out.preset && out.preset.id || null,
                    status: out.readiness.status,
                    score: out.readiness.score
                })
            }
        } catch (_) {}
        return out
    }

    function _iata(value) {
        const s = String(value || "").trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : ""
    }

    function _num(value) {
        const n = Number(value)
        return isFinite(n) ? n : null
    }

    function _errText(err) {
        return (err && err.message) ? err.message : String(err || "unknown error")
    }

    function _ageText(ms) {
        const min = Math.max(0, Math.round(ms / 60000))
        if (min < 90) return min + "m"
        const hr = Math.round(min / 60)
        if (hr < 48) return hr + "h"
        return Math.round(hr / 24) + "d"
    }

    window.AesWaveAutomationContext = {
        buildForHub,
        _normaliseRows: _normaliseRows
    }
})()
