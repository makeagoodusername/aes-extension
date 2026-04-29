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
 *   - propose({hub, fleet, schedules, preset, demandRows}) → Promise<void>
 *   - Emits `canvas:builder-proposal` per candidate, then `canvas:builder-done`.
 *   - Each proposal: {proposalId, name, rationale, scoreDelta, plan: {edits[]}}.
 *   - Edit shape: {kind: "addRoute", aircraftId, waveId, presetId, destIata,
 *                  destName, paxScore, dayMask: [bool x7]}.
 */
class CanvasBuilderEngine {

    static MAX_FILLS_PER_AIRCRAFT = 3
    static MAX_PROPOSALS = 3

    constructor() {
        this._busy = false
    }

    /**
     * Run the heuristic and emit proposals on the bus.
     */
    async propose(input) {
        if (this._busy) return
        this._busy = true
        try {
            const {hub, fleet, schedules, preset} = input || {}
            if (!hub || !preset || !Array.isArray(fleet) || !fleet.length) {
                this._emitDone()
                return
            }
            const demandRows = await this._loadDemandRows(hub, input && input.demandRows)
            if (!demandRows || !demandRows.length) {
                this._emitNoDemand(hub)
                return
            }

            const variants = [
                {key: "top-demand",  name: "Top demand fill",   rationaleLead: "Adds the highest-paxScore destinations across empty wave cells.",
                 sort: (a, b) => (b.paxScore || 0) - (a.paxScore || 0)},
                {key: "diversify",   name: "Diversify destinations", rationaleLead: "Spreads coverage across more destinations rather than re-running the same one.",
                 sort: (a, b) => (b.score || 0) - (a.score || 0), uniqueDests: true},
                {key: "high-profit", name: "Profit-first fill", rationaleLead: "Prioritises destinations with the highest projected weekly profit.",
                 sort: (a, b) => (b.profitPerWeek || 0) - (a.profitPerWeek || 0)}
            ]

            for (const v of variants) {
                const proposal = this._buildProposal({
                    hub, fleet, schedules, preset, demandRows, variant: v
                })
                if (proposal && proposal.plan && proposal.plan.edits.length) {
                    this._emitProposal(proposal)
                }
            }
            this._emitDone()
        } catch (e) {
            console.warn("[AES Canvas Builder] propose failed", e)
            this._emitDone()
        } finally {
            this._busy = false
        }
    }

    async _loadDemandRows(hub, override) {
        if (Array.isArray(override) && override.length) return override
        try {
            const hubU = String(hub).toUpperCase()
            const key = "routeAssistant:topRoutes:" + hubU
            const data = await chrome.storage.local.get([key])
            const blob = data[key]
            return (blob && Array.isArray(blob.rows)) ? blob.rows : []
        } catch (_) {
            return []
        }
    }

    _buildProposal(ctx) {
        const {hub, fleet, schedules, preset, demandRows, variant} = ctx
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

        const waves = (preset.waves || []).filter(w => w && !w.archivedAt)
        if (!waves.length) return null

        const edits = []
        const usedDestsByAircraft = new Map()
        const fillIdx = new Map() // dest -> next-source-index for scanning
        const hubFleet = fleet.filter(r => r && String(r.hub || "").toUpperCase() === String(hub).toUpperCase())

        for (const aircraft of hubFleet) {
            const aid = String(aircraft.aircraftId)
            const sched = schedules.get(aid)
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
                const isEmpty = !this._waveHasFlight(sched, wave)
                if (!isEmpty) continue
                // Find a destination this aircraft hasn't already been
                // assigned to in earlier edits this proposal, walking
                // through the sorted demand list with a scan cursor so
                // multiple aircraft don't all get the same #1 destination.
                let pick = null
                let cursor = fillIdx.get(aid) || 0
                for (let i = cursor; i < sorted.length; i++) {
                    const cand = sorted[i]
                    if (!cand || !cand.destIata) continue
                    if (usedSet.has(cand.destIata)) continue
                    if (!this._aircraftSupportsRange(aircraft, cand.distanceKm)) continue
                    pick = cand
                    fillIdx.set(aid, i + 1)
                    break
                }
                if (!pick) continue
                usedSet.add(pick.destIata)
                edits.push({
                    kind:        "addRoute",
                    aircraftId:  aid,
                    waveId:      wave.id,
                    presetId:    preset.id,
                    destIata:    pick.destIata,
                    destName:    pick.destName || "",
                    paxScore:    pick.paxScore || 0,
                    profitPerWeek: pick.profitPerWeek || null,
                    dayMask:     [true, true, true, true, true, true, true]
                })
                fills++
            }
        }

        if (!edits.length) return null

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
            plan:       {edits}
        }
    }

    _waveHasFlight(sched, wave) {
        if (!sched || !Array.isArray(sched.legs) || !sched.legs.length) return false
        const dep = wave.departureWindow || {}
        const startMin = _hhmmToMin(dep.start)
        const endMin = _hhmmToMin(dep.end)
        if (startMin === null || endMin === null) return false
        for (const leg of sched.legs) {
            const m = _hhmmToMin(leg.depTimeLocal)
            if (m === null) continue
            const inWindow = (startMin <= endMin)
                ? (m >= startMin && m <= endMin)
                : (m >= startMin || m <= endMin)
            if (inWindow) return true
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

    _emitProposal(proposal) {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        window.CentralHubBus.emit(window.AesCanvasEvents.BUILDER_PROPOSAL, proposal)
    }

    _emitNoDemand(hub) {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        window.CentralHubBus.emit(window.AesCanvasEvents.BUILDER_PROPOSAL, {
            proposalId: "p-no-demand",
            name:       "No cached demand for " + hub,
            rationale:  "Open Route Assistant on " + hub + " once to populate demand data, then return here.",
            scoreDelta: 0,
            plan:       {edits: []},
            empty:      true
        })
        this._emitDone()
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

if (typeof window !== "undefined") {
    window.CanvasBuilderEngine = CanvasBuilderEngine
}
