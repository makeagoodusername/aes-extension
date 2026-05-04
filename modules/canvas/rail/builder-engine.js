"use strict"

/**
 * CanvasBuilderEngine — proposes wave-aligned schedule plans for the
 * active hub.
 *
 * V1 ships a heuristic engine, not the full auto-scheduler:
 *
 *   1. **Demand fill** — for each (aircraft, wave) cell that's currently
 *      empty, pick the highest-paxScore destination from the hub's
 *      `routeAssistant:topRoutes:<HUB>` cache that fits the aircraft.
 *      "Fits" today is just `weeklyFlights >= 1` (an actual route exists).
 *   2. **Range trim** — when an aircraft's spec is in
 *      `route-assistant/fleet-store.js`, drop destinations beyond its
 *      effective range.
 *   3. **Composition match** — when a wave declares a composition (S/M/L
 *      counts), bias picks toward the haul band that's still under-filled.
 *
 * Produces 2–3 proposals seeded from different demand-cutoff heuristics
 * (top-3 demand, top route diversity, lease-favoring), each delivered
 * via the bus event `canvas:builder-proposal`.
 *
 * The full AesAfpAutoScheduler.run() path is reserved for surfaces that
 * already have route candidates + spec resolved (the AFP page). When the
 * canvas eventually mounts on AFP surfaces or seeds candidates on demand,
 * a second engine variant can replace this one. Plumbed via the same
 * proposal contract so the rail UI doesn't change.
 *
 * Contract:
 *   - propose({hub, fleet, schedules, preset, demandRows, server, airlineCode}) → Promise<void>
 *   - Emits `canvas:builder-proposal` per candidate, then `canvas:builder-done`.
 *   - Each proposal: {proposalId, name, rationale, scoreDelta, plan: {edits[]}}.
 *   - Edit shape: {kind: "addRoute", aircraftId, waveId, presetId, destIata,
 *                  destName, hub, paxScore, stationStatus, dayMask: [bool x7]}.
 */
class CanvasBuilderEngine {

    static MAX_FILLS_PER_AIRCRAFT = 3
    static MAX_PROPOSALS = 3

    constructor() {
        this._busy = false
        this._stationCache = new Map()
    }

    /**
     * Run the heuristic and emit proposals on the bus.
     */
    async propose(input) {
        if (this._busy) return
        this._busy = true
        try {
            const {hub, fleet, schedules, preset} = input || {}
            const diagnostics = this._baseDiagnostics(hub)
            if (!hub || !preset || !Array.isArray(fleet) || !fleet.length) {
                diagnostics.reason = !hub ? "missing hub"
                    : !preset ? "missing wave preset"
                    : "no fleet rows"
                this._emitNoPlan(hub, diagnostics)
                this._emitDone()
                return
            }
            const demandRows = await this._loadDemandRows(hub, input && input.demandRows, {
                server:      input && input.server,
                airlineCode: input && input.airlineCode
            })
            diagnostics.demandRows = demandRows.length
            if (!demandRows || !demandRows.length) {
                this._emitNoDemand(hub, diagnostics)
                return
            }
            const stationState = await this._loadStationState(input || {})
            diagnostics.stationSource = stationState.source
            diagnostics.stationKnown = !!stationState.known
            diagnostics.openStationCount = stationState.set ? stationState.set.size : null
            diagnostics.totalFleetCount = fleet.length
            diagnostics.hubFleetCount = fleet.filter(r => r && this._rowHub(r) === String(hub).toUpperCase()).length
            diagnostics.waveCount = preset && Array.isArray(preset.waves)
                ? preset.waves.filter(w => w && !w.archivedAt).length : 0
            const waveCtx = await this._loadWaveContext({
                hub, fleet, preset, demandRows, stationState,
                server:      input && input.server,
                airlineCode: input && input.airlineCode
            })
            if (waveCtx) {
                diagnostics.waveScore = waveCtx.readiness && waveCtx.readiness.score
                diagnostics.waveBlockers = ((waveCtx.readiness && waveCtx.readiness.blockers) || [])
                    .map(b => b.message || b.code || String(b))
                diagnostics.underfilledWaveIds = (waveCtx.capacity && waveCtx.capacity.underfilledWaveIds || []).slice()
                diagnostics.unplacedCount = waveCtx.capacity && waveCtx.capacity.unplaced || 0
            }
            this._logDiagnostics("inputs", diagnostics)

            const variants = [
                {key: "top-demand",  name: "Top demand fill",   rationaleLead: "Adds the highest-paxScore destinations across empty wave cells.",
                 sort: (a, b) => (b.paxScore || 0) - (a.paxScore || 0)},
                {key: "diversify",   name: "Diversify destinations", rationaleLead: "Spreads coverage across more destinations rather than re-running the same one.",
                 sort: (a, b) => (b.score || 0) - (a.score || 0), uniqueDests: true},
                {key: "high-profit", name: "Profit-first fill", rationaleLead: "Prioritises destinations with the highest projected weekly profit.",
                 sort: (a, b) => (b.profitPerWeek || 0) - (a.profitPerWeek || 0)}
            ]

            let emitted = 0
            let lastDiagnostics = diagnostics
            for (const v of variants) {
                const proposal = this._buildProposal({
                    hub, fleet, schedules, preset, demandRows, variant: v,
                    stationState, waveCtx
                })
                if (proposal && proposal.diagnostics) lastDiagnostics = proposal.diagnostics
                if (proposal && proposal.plan && proposal.plan.edits.length) {
                    this._emitProposal(proposal)
                    emitted++
                }
            }
            if (!emitted) this._emitNoPlan(hub, lastDiagnostics)
            if (!emitted) this._logDiagnostics("no-plan", lastDiagnostics)
            this._emitDone()
        } catch (e) {
            console.warn("[AES Canvas Builder] propose failed", e)
            this._emitDone()
        } finally {
            this._busy = false
        }
    }

    async _loadDemandRows(hub, override, ctx) {
        if (Array.isArray(override) && override.length) return this._normaliseDemandRows(override, hub)
        try {
            const hubU = String(hub).toUpperCase()
            const keys = []
            if (typeof acctKey === "function") {
                const scoped = acctKey("routeAssistant:topRoutes", hubU)
                if (scoped) keys.push(scoped)
            }
            keys.push("routeAssistant:topRoutes:" + hubU, "routeAssistant:topRoutes")
            const data = await chrome.storage.local.get(Array.from(new Set(keys)))
            const server = ctx && ctx.server ? String(ctx.server) : ""
            const airlineCode = ctx && ctx.airlineCode ? String(ctx.airlineCode) : ""
            for (const key of keys) {
                const blob = data[key]
                if (!blob || !Array.isArray(blob.rows)) continue
                if (String(blob.hub || "").toUpperCase() !== hubU) continue
                if (server && blob.server && String(blob.server) !== server) continue
                if (airlineCode && blob.airlineCode && String(blob.airlineCode) !== airlineCode) continue
                return this._normaliseDemandRows(blob.rows, hubU)
            }
            return []
        } catch (_) {
            return []
        }
    }

    async _loadWaveContext(args) {
        if (typeof window.AesWaveAutomationContext === "undefined"
                || typeof window.AesWaveAutomationContext.buildForHub !== "function") {
            return null
        }
        try {
            return await window.AesWaveAutomationContext.buildForHub({
                hub:         args && args.hub,
                server:      args && args.server,
                airlineCode: args && args.airlineCode,
                rows:        args && args.fleet,
                preset:      args && args.preset,
                demandRows:  args && args.demandRows,
                stationState: args && args.stationState
            })
        } catch (err) {
            console.warn("[AES Canvas Builder] wave context failed", err)
            return null
        }
    }

    _buildProposal(ctx) {
        const {hub, fleet, schedules, preset, demandRows, variant, stationState, waveCtx} = ctx
        const diagnostics = this._baseDiagnostics(hub)
        diagnostics.variant = variant && variant.key || null
        diagnostics.demandRows = demandRows.length
        diagnostics.stationKnown = !!(stationState && stationState.known)
        diagnostics.stationSource = stationState && stationState.source || "unknown"
        diagnostics.openStationCount = stationState && stationState.set ? stationState.set.size : null
        if (waveCtx) {
            diagnostics.waveScore = waveCtx.readiness && waveCtx.readiness.score
            diagnostics.waveBlockers = ((waveCtx.readiness && waveCtx.readiness.blockers) || [])
                .map(b => b.message || b.code || String(b))
            diagnostics.underfilledWaveIds = (waveCtx.capacity && waveCtx.capacity.underfilledWaveIds || []).slice()
            diagnostics.unplacedCount = waveCtx.capacity && waveCtx.capacity.unplaced || 0
        }
        const sorted = demandRows.slice().sort(variant.sort)
        if (variant.uniqueDests) {
            // Drop duplicate destinations so the diversify variant doesn't
            // recommend filling 5 cells with the same destIata.
            const seen = new Set()
            for (let i = sorted.length - 1; i >= 0; i--) {
                const d = sorted[i] && sorted[i].destIata
                if (!d) { sorted.splice(i, 1); continue }
                if (seen.has(d)) { sorted.splice(i, 1); continue }
                seen.add(d)
            }
        }

        const underfilled = new Set((waveCtx && waveCtx.capacity
            && waveCtx.capacity.underfilledWaveIds || []).map(String))
        const waves = (preset.waves || [])
            .filter(w => w && !w.archivedAt)
            .sort((a, b) => {
                const au = underfilled.has(String(a.id)) ? 1 : 0
                const bu = underfilled.has(String(b.id)) ? 1 : 0
                return (bu - au)
            })
        diagnostics.waveCount = waves.length
        if (!waves.length) {
            diagnostics.reason = "no active waves in preset"
            return {diagnostics}
        }

        const edits = []
        const usedDestsByAircraft = new Map()
        const fillIdx = new Map() // cursor name -> next source index for scanning
        const hubFleet = fleet.filter(r => r && this._rowHub(r) === String(hub).toUpperCase())
        diagnostics.hubFleetCount = hubFleet.length
        diagnostics.totalFleetCount = fleet.length
        if (!hubFleet.length) {
            diagnostics.reason = "no aircraft assigned to " + String(hub).toUpperCase()
            return {diagnostics}
        }

        for (const aircraft of hubFleet) {
            const aid = String(aircraft.aircraftId)
            const sched = schedules && typeof schedules.get === "function" ? schedules.get(aid) : null
            const usedSet = new Set()
            usedDestsByAircraft.set(aid, usedSet)
            // Seed used set with current legs' destinations so the engine
            // doesn't re-add a destination this aircraft already serves.
            if (sched && Array.isArray(sched.legs)) {
                for (const leg of sched.legs) if (leg && leg.destination) usedSet.add(leg.destination)
            }

            let fills = 0
            for (const wave of waves) {
                if (fills >= CanvasBuilderEngine.MAX_FILLS_PER_AIRCRAFT) break
                const isEmpty = !this._waveHasFlight(sched, wave, aircraft, hub)
                if (!isEmpty) continue
                diagnostics.emptyCells++
                // Find a destination this aircraft hasn't already been
                // assigned to in earlier edits this proposal, walking
                // through the sorted demand list with a scan cursor so
                // multiple aircraft don't all get the same #1 destination.
                let pick = null
                let pickIdx = -1
                let missingFallback = null
                let missingFallbackIdx = -1
                let cursor = fillIdx.get("global") || 0
                for (let i = cursor; i < sorted.length; i++) {
                    const cand = sorted[i]
                    if (!cand || !cand.destIata) continue
                    if (usedSet.has(cand.destIata)) {
                        diagnostics.skippedDuplicate++
                        continue
                    }
                    if (!this._aircraftSupportsRange(aircraft, cand.distanceKm)) {
                        diagnostics.skippedRange++
                        continue
                    }
                    const stationStatus = this._stationStatus(cand.destIata, stationState)
                    const allowMissing = cand.allowMissingStation === true
                        || cand.includeMissingStation === true
                    if (stationStatus === "missing" && !allowMissing) {
                        if (!missingFallback) {
                            missingFallback = cand
                            missingFallbackIdx = i
                        }
                        continue
                    }
                    pick = cand
                    pickIdx = i
                    break
                }
                if (!pick && missingFallback) {
                    pick = missingFallback
                    pickIdx = missingFallbackIdx
                }
                if (!pick) continue
                if (pickIdx >= 0) fillIdx.set("global", pickIdx + 1)
                usedSet.add(pick.destIata)
                const stationStatus = this._stationStatus(pick.destIata, stationState)
                if (stationStatus === "open") diagnostics.stationOpenEdits++
                else if (stationStatus === "missing") diagnostics.stationMissingEdits++
                else diagnostics.stationUnknownEdits++
                edits.push({
                    kind:        "addRoute",
                    aircraftId:  aid,
                    waveId:      wave.id,
                    presetId:    preset.id,
                    hub:         String(hub).toUpperCase(),
                    destIata:    pick.destIata,
                    destName:    pick.destName || "",
                    paxScore:    pick.paxScore || 0,
                    cargoScore:  pick.cargoScore || null,
                    score:       pick.score || null,
                    distanceKm:  pick.distanceKm || null,
                    airportId:   pick.airportId || null,
                    countryId:   pick.countryId || null,
                    profitPerWeek: pick.profitPerWeek || null,
                    stationStatus,
                    needsStation: stationStatus === "missing",
                    depTime:     wave.departureWindow && wave.departureWindow.start || null,
                    dayMask:     [true, true, true, true, true, true, true]
                })
                fills++
            }
        }

        diagnostics.editCount = edits.length
        if (!edits.length) {
            diagnostics.reason = diagnostics.emptyCells
                ? "empty cells found, but no demand rows fit range/duplicates"
                : "no empty wave cells"
            return {diagnostics}
        }

        // Rationale: top-3 destinations + counts.
        const destCounts = new Map()
        for (const e of edits) destCounts.set(e.destIata, (destCounts.get(e.destIata) || 0) + 1)
        const topDests = Array.from(destCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
        const rationale = [
            variant.rationaleLead,
            topDests.map(([d, n]) => d + (n > 1 ? " ×" + n : "")).join(", ")
        ].join(" — ")

        // Score delta: rough sum of paxScore across edits as a quick "how
        // much demand are we capturing" signal. Real allocator would
        // compute revenue minus fuel cost.
        const scoreDelta = edits.reduce((s, e) => s + (e.paxScore || 0), 0)

        return {
            proposalId: "p-" + Date.now().toString(36) + "-" + variant.key,
            name:       variant.name,
            rationale:  rationale,
            scoreDelta: scoreDelta,
            plan:       {edits},
            diagnostics
        }
    }

    _waveHasFlight(sched, wave, aircraft, hub) {
        if (!sched || !Array.isArray(sched.legs) || !sched.legs.length) return false
        const dep = wave.departureWindow || {}
        const arr = wave.arrivalWindow || {}
        const depStartMin = _hhmmToMin(dep.start)
        const depEndMin = _hhmmToMin(dep.end)
        const arrStartMin = _hhmmToMin(arr.start)
        const arrEndMin = _hhmmToMin(arr.end)
        if ((depStartMin === null || depEndMin === null)
                && (arrStartMin === null || arrEndMin === null)) return false
        const hubU = String(hub || (aircraft && (aircraft.hub || aircraft.locIata)) || sched.hubIata || "").toUpperCase()
        for (const leg of sched.legs) {
            const origin = String(leg.origin || "").toUpperCase()
            const dest = String(leg.destination || "").toUpperCase()
            const depOk = _minInWindow(_hhmmToMin(leg.depTimeLocal), depStartMin, depEndMin)
            const arrOk = _minInWindow(_hhmmToMin(leg.arrTimeLocal), arrStartMin, arrEndMin)
            if (hubU && origin === hubU && depOk) return true
            if (hubU && dest === hubU && arrOk) return true
            if (!hubU && (depOk || arrOk)) return true
            if (hubU && (depOk || arrOk) && (origin === hubU || dest === hubU)) return true
        }
        return false
    }

    _aircraftSupportsRange(aircraft, distanceKm) {
        if (!isFinite(distanceKm) || distanceKm <= 0) return true  // unknown — let it through
        // Spec might be in fleet-store; if not, accept by default. Conservative:
        // if a `range` field is on the row (kg / km), check it.
        const r = Number(aircraft && aircraft.range)
        if (isFinite(r) && r > 0) return distanceKm <= r * 1.05
        return true
    }

    _baseDiagnostics(hub) {
        return {
            hub: String(hub || "").toUpperCase() || null,
            reason: null,
            variant: null,
            demandRows: 0,
            waveCount: 0,
            totalFleetCount: 0,
            hubFleetCount: 0,
            emptyCells: 0,
            editCount: 0,
            skippedDuplicate: 0,
            skippedRange: 0,
            stationKnown: false,
            stationSource: "unknown",
            openStationCount: null,
            stationOpenEdits: 0,
            stationMissingEdits: 0,
            stationUnknownEdits: 0,
            waveScore: null,
            waveBlockers: [],
            underfilledWaveIds: [],
            unplacedCount: 0
        }
    }

    _normaliseDemandRows(rows, hub) {
        const hubU = String(hub || "").toUpperCase()
        const seen = new Set()
        const out = []
        for (const row of rows || []) {
            const n = this._normaliseDemandRow(row)
            if (!n || !n.destIata || n.destIata === hubU) continue
            if (seen.has(n.destIata)) continue
            seen.add(n.destIata)
            out.push(n)
        }
        return out
    }

    _normaliseDemandRow(row) {
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
            paxScore:      _num(row.paxScore != null ? row.paxScore : demand.paxScore),
            cargoScore:    _num(row.cargoScore != null ? row.cargoScore : demand.cargoScore),
            weeklyFlights: _num(row.weeklyFlights),
            profitPerWeek: _num(row.profitPerWeek),
            ourPaxShare:   _num(row.ourPaxShare)
        }
    }

    _rowHub(row) {
        return String(row && (row.hub || row.gravityHub || row.locIata) || "").toUpperCase()
    }

    async _loadStationState(input) {
        if (input && input.existingStations instanceof Set) {
            return {known: true, source: "input", set: input.existingStations}
        }
        if (input && Array.isArray(input.existingStations)) {
            return {known: true, source: "input", set: new Set(input.existingStations.map(_iata).filter(Boolean))}
        }
        const server = String(input && input.server || "")
        if (!server || typeof chrome === "undefined") {
            return {known: false, source: "unavailable", set: null}
        }
        const cached = this._stationCache.get(server)
        if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
            return {known: true, source: cached.source + ":cache", set: cached.set}
        }
        try {
            if (typeof CountryScraper !== "undefined"
                    && typeof CountryScraper.loadExistingStationIatas === "function") {
                const set = await CountryScraper.loadExistingStationIatas(server)
                this._stationCache.set(server, {at: Date.now(), source: "CountryScraper", set})
                return {known: true, source: "CountryScraper", set}
            }
        } catch (e) {
            console.warn("[AES Canvas Builder] station scrape via CountryScraper failed", e)
        }
        try {
            const set = await this._fetchExistingStationIatas(server)
            this._stationCache.set(server, {at: Date.now(), source: "ops/stations", set})
            return {known: true, source: "ops/stations", set}
        } catch (e) {
            console.warn("[AES Canvas Builder] station scrape failed", e)
            return {known: false, source: "fetch-failed", set: null}
        }
    }

    async _fetchExistingStationIatas(server) {
        const resp = await fetch("https://" + server + ".airlinesim.aero/app/ops/stations",
            {credentials: "include"})
        if (!resp.ok) throw new Error("stations HTTP " + resp.status)
        const html = await resp.text()
        const doc = new DOMParser().parseFromString(html, "text/html")
        const iatas = new Set()
        for (const a of doc.querySelectorAll("a[href*='/ops/stations/'], a[href*='ops/stations/']")) {
            const m = (a.getAttribute("href") || "").match(/\/stations\/([A-Za-z]{3})(?:[/?#]|$)/)
            if (m) iatas.add(m[1].toUpperCase())
        }
        for (const table of doc.querySelectorAll("table")) {
            const head = (table.querySelector("thead")?.textContent || table.querySelector("tr")?.textContent || "").toLowerCase()
            if (!head.includes("iata") && !head.includes("station") && !head.includes("code")) continue
            for (const td of table.querySelectorAll("td")) {
                const txt = (td.textContent || "").trim().toUpperCase()
                if (/^[A-Z]{3}$/.test(txt)) iatas.add(txt)
            }
        }
        return iatas
    }

    _stationStatus(destIata, stationState) {
        if (!stationState || !stationState.known || !stationState.set) return "unknown"
        return stationState.set.has(String(destIata || "").toUpperCase()) ? "open" : "missing"
    }

    _emitProposal(proposal) {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        this._logDiagnostics("proposal " + (proposal.name || ""), proposal.diagnostics)
        window.CentralHubBus.emit(window.AesCanvasEvents.BUILDER_PROPOSAL, proposal)
    }

    _emitNoDemand(hub, diagnostics) {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        window.CentralHubBus.emit(window.AesCanvasEvents.BUILDER_PROPOSAL, {
            proposalId: "p-no-demand",
            name:       "No cached demand for " + hub,
            rationale:  "Open Route Assistant on " + hub + " once to populate demand data, then return here.",
            scoreDelta: 0,
            plan:       {edits: []},
            empty:      true,
            diagnostics: diagnostics || this._baseDiagnostics(hub)
        })
        this._emitDone()
    }

    _emitNoPlan(hub, diagnostics) {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        const d = diagnostics || this._baseDiagnostics(hub)
        this._logDiagnostics("diagnostics", d)
        window.CentralHubBus.emit(window.AesCanvasEvents.BUILDER_PROPOSAL, {
            proposalId: "p-no-plan-" + Date.now().toString(36),
            name:       "Builder diagnostics for " + (hub || "hub"),
            rationale:  d.reason || "No route edits could be generated from the current fleet, preset, and cached demand.",
            scoreDelta: 0,
            plan:       {edits: []},
            empty:      true,
            diagnostics: d
        })
    }

    _logDiagnostics(label, d) {
        if (typeof console === "undefined" || !d) return
        try {
            console.info("[AES Canvas Builder] " + label, {
                hub: d.hub,
                demandRows: d.demandRows,
                aircraft: d.hubFleetCount + "/" + d.totalFleetCount,
                waves: d.waveCount,
                emptyCells: d.emptyCells,
                edits: d.editCount,
                stationKnown: d.stationKnown,
                stationSource: d.stationSource,
                openStations: d.openStationCount,
                stationOpenEdits: d.stationOpenEdits,
                stationMissingEdits: d.stationMissingEdits,
                stationUnknownEdits: d.stationUnknownEdits,
                waveScore: d.waveScore,
                waveBlockers: d.waveBlockers,
                underfilledWaveIds: d.underfilledWaveIds,
                unplacedCount: d.unplacedCount,
                reason: d.reason
            })
        } catch (_) {}
    }

    _emitDone() {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        window.CentralHubBus.emit(window.AesCanvasEvents.BUILDER_DONE, {})
    }
}

function _hhmmToMin(s) {
    if (typeof s !== "string") return null
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const h = +m[1], min = +m[2]
    if (h < 0 || h > 23 || min < 0 || min > 59) return null
    return h * 60 + min
}

function _minInWindow(value, start, end) {
    if (value === null || start === null || end === null) return false
    return (start <= end)
        ? (value >= start && value <= end)
        : (value >= start || value <= end)
}

function _iata(value) {
    const s = String(value || "").trim().toUpperCase()
    return /^[A-Z]{3}$/.test(s) ? s : null
}

function _num(value) {
    const n = Number(value)
    return isFinite(n) ? n : null
}

if (typeof window !== "undefined") {
    window.CanvasBuilderEngine = CanvasBuilderEngine
}
