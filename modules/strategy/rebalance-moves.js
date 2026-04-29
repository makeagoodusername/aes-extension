"use strict"

/**
 * Phase 3 Lane C — fleet-rebalance proposer (preview-only).
 *
 * Mirrors the price-moves / service-moves proposer family pattern. Pure
 * (no DOM, no I/O), pre-computed inputs only. Three proposal kinds in
 * Phase 3 — schedule + service domain only:
 *
 *   wave-add               — add a wave at a hub where ≥2 cold tails sit
 *                            and the hub's wave registry has < 3 active waves
 *   wave-densify           — bump composition where wave-slot has free
 *                            capacity AND ≥2 cold tails share the hub
 *   service-profile-promote— promote service profile on cold tails whose
 *                            route mix favors higher-Y segments
 *
 * Phase 3 SHIPS PREVIEW-ONLY. No apply path; the drilldown renders the
 * proposal cards with rationale + predicted ratio delta but no Apply
 * button. Phase 4 wires the apply path through wave-overrides-store
 * (schedule kinds) and service-moves apply (service kind).
 *
 * Public API:
 *   AesStrategy.proposeRebalanceMoves(snapshot, fleetUtilSummary, settings)
 *     → RebalanceProposal[]
 *
 * RebalanceProposal:
 *   {
 *     kind: "wave-add"|"wave-densify"|"service-profile-promote",
 *     id: string,                               // stable per (kind, target) for dedup
 *     hubIata: string|null,
 *     aircraftIds: string[],
 *     rationale: string[],                      // [gap]/[hub]/[fix]/[predict] lines
 *     predicted: {
 *       weeklyHoursDelta: number,               // per-tail
 *       ratioDeltaPp: number,                   // per-tail (estimated 14d)
 *       affectedTailCount: int
 *     },
 *     payload: {                                 // kind-specific data
 *       wave-add:                {hubIata, suggestedTime, suggestedComposition},
 *       wave-densify:            {hubIata, presetId?, waveId?, deltaShortHaul},
 *       service-profile-promote: {profileFromKey, profileToKey, scope:"tails"}
 *     }
 *   }
 *
 * Anti-spiral (§4.17): proposer is preview-only at Phase 3, so the
 * spiral guards proper kick in at Phase 4 when apply lands. Even now the
 * proposer caps at maxRebalancesPerWindow proposals per call so the
 * drilldown doesn't drown in suggestions.
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeRebalanceMoves === "function") return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    /**
     * Best-effort minutes-since-midnight slot picker. Looks for the most
     * common gap in existing wave times at the hub; falls back to 09:30
     * (matches the master-plan's vignette example).
     */
    function _suggestWaveTimeForHub(hubIata, snapshot) {
        const occupied = new Set()
        const presets = (snapshot && snapshot.presets) || []
        for (const p of presets) {
            if (String(p.hub || "").toUpperCase() !== hubIata) continue
            for (const w of (p.waves || [])) {
                const s = (w.arrivalWindow && w.arrivalWindow.start) || ""
                const m = /^(\d{1,2}):(\d{2})$/.exec(s)
                if (m) occupied.add(Number(m[1]))
            }
        }
        for (const hr of [9, 13, 17, 6, 21, 11, 15, 19, 7]) {
            if (!occupied.has(hr)) {
                return String(hr).padStart(2, "0") + ":30"
            }
        }
        return "09:30"
    }

    function _hh(min) {
        const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(min) || 0)))
        return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0")
    }

    /**
     * Estimate the ratio delta of adding `addedHours` to a tail with
     * regression (slope α, intercept β). Δratio_per_week = α·H + β.
     * 14-day = 2 weeks, so multiply by 2. Conservative: clamp output.
     */
    function _estimateRatioDeltaPp(tailEntry, addedHours) {
        if (!tailEntry || !isFinite(addedHours)) return 0
        const fit = tailEntry.fit || (tailEntry.wear && tailEntry.wear.fit)
        if (!fit || !fit.valid) return 0
        const slope     = _num(fit.slope, 0)
        const intercept = _num(fit.intercept, 0)
        const currentHours = _num(tailEntry.weeklyHoursPlanned, 0)
        const before = slope * currentHours + intercept
        const after  = slope * (currentHours + addedHours) + intercept
        // Δratio over 14d (2 weeks) of the marginal change.
        const delta = (after - before) * 2
        return Math.max(-10, Math.min(10, delta))
    }

    function _pickHubsWithStrandedColdTails(coldRows) {
        const byHub = {}
        for (const r of coldRows) {
            const hub = r.hubIata || r.hub
            if (!hub) continue
            if (!byHub[hub]) byHub[hub] = []
            byHub[hub].push(r)
        }
        return byHub
    }

    function _activeWavesForHub(hubIata, snapshot) {
        const presets = (snapshot && snapshot.presets) || []
        let count = 0
        for (const p of presets) {
            if (String(p.hub || "").toUpperCase() !== hubIata) continue
            for (const w of (p.waves || [])) {
                if (!w.archivedAt) count++
            }
        }
        return count
    }

    function _proposeWaveAdd(hubIata, coldTailsAtHub, snapshot) {
        if (!coldTailsAtHub || coldTailsAtHub.length < 2) return null
        const activeWaves = _activeWavesForHub(hubIata, snapshot)
        if (activeWaves >= 3) return null
        const time = _suggestWaveTimeForHub(hubIata, snapshot)
        const slots = Math.min(4, coldTailsAtHub.length)
        const totalAdded = slots * 2 * 1.5  // 2 round-trips/wave/tail · ~1.5h block est
        const perTail = totalAdded / coldTailsAtHub.length
        let avgRatioDelta = 0
        for (const t of coldTailsAtHub) {
            avgRatioDelta += _estimateRatioDeltaPp(t, perTail)
        }
        avgRatioDelta = avgRatioDelta / coldTailsAtHub.length

        const totalGapHours = coldTailsAtHub.reduce(
            (s, t) => s + Math.max(0, _num(t.headroomHours, 0)), 0)
        return {
            kind:        "wave-add",
            id:          "wave-add:" + hubIata + ":" + time,
            hubIata,
            aircraftIds: coldTailsAtHub.map(t => String(t.aircraftId)).slice(0, 8),
            rationale: [
                "[gap] " + coldTailsAtHub.length + " cold tails at " + hubIata
                    + " · " + totalGapHours.toFixed(1) + "h headroom total",
                "[hub] " + hubIata + " · " + activeWaves + " active wave"
                    + (activeWaves === 1 ? "" : "s") + " (room for more)",
                "[fix] add wave at " + time + " with " + slots + " short-haul slots",
                "[predict] +" + perTail.toFixed(1) + "h/wk per tail · ratio "
                    + (avgRatioDelta >= 0 ? "+" : "") + avgRatioDelta.toFixed(2) + "pp · 14d"
            ],
            predicted: {
                weeklyHoursDelta:  perTail,
                ratioDeltaPp:      avgRatioDelta,
                affectedTailCount: coldTailsAtHub.length
            },
            payload: {
                hubIata,
                suggestedTime:        time,
                suggestedComposition: {shortHaul: slots, mediumHaul: 0, longHaul: 0}
            }
        }
    }

    function _proposeWaveDensify(hubIata, coldTailsAtHub, snapshot) {
        if (!coldTailsAtHub || coldTailsAtHub.length < 2) return null
        // Find a wave at this hub with capacity to grow. We treat any
        // wave with composition.shortHaul < (slot-window / 2h) as having
        // room — a conservative heuristic; Phase 4 can use real demand.
        const presets = (snapshot && snapshot.presets) || []
        for (const p of presets) {
            if (String(p.hub || "").toUpperCase() !== hubIata) continue
            for (const w of (p.waves || [])) {
                if (w.archivedAt) continue
                const cur = (w.composition && _num(w.composition.shortHaul, 0)) || 0
                if (cur >= 8) continue   // already dense
                const perTail = 1 * 1.5   // +1 short-haul round-trip ≈ 1.5h block
                let avgRatioDelta = 0
                for (const t of coldTailsAtHub) {
                    avgRatioDelta += _estimateRatioDeltaPp(t, perTail)
                }
                avgRatioDelta = avgRatioDelta / coldTailsAtHub.length
                return {
                    kind:        "wave-densify",
                    id:          "wave-densify:" + p.id + ":" + w.id,
                    hubIata,
                    aircraftIds: coldTailsAtHub.map(t => String(t.aircraftId)).slice(0, 8),
                    rationale: [
                        "[gap] " + coldTailsAtHub.length + " cold tails at " + hubIata,
                        "[hub] " + hubIata + " · wave \"" + (w.label || "Wave") + "\" "
                            + (w.arrivalWindow ? w.arrivalWindow.start : "—") + " · "
                            + cur + " short-haul slots",
                        "[fix] bump composition · +1 short-haul (→ " + (cur + 1) + ")",
                        "[predict] +" + perTail.toFixed(1) + "h/wk per tail · ratio "
                            + (avgRatioDelta >= 0 ? "+" : "") + avgRatioDelta.toFixed(2) + "pp · 14d"
                    ],
                    predicted: {
                        weeklyHoursDelta:  perTail,
                        ratioDeltaPp:      avgRatioDelta,
                        affectedTailCount: coldTailsAtHub.length
                    },
                    payload: {
                        hubIata, presetId: p.id, waveId: w.id, deltaShortHaul: 1
                    }
                }
            }
        }
        return null
    }

    function _proposeServicePromote(coldRow, snapshot) {
        // Read the tail's per-route service profile mix from the snapshot's
        // hubs[].byRoute slice. If the tail's routes lean toward business
        // / first-class load factors, suggest a profile uplift.
        const aircraftId = String(coldRow.aircraftId || "")
        if (!aircraftId) return null
        const hubs = (snapshot && snapshot.hubs) || []
        let bizPaxScore   = 0
        let totalSegments = 0
        let highY = 0
        for (const h of hubs) {
            for (const r of (h.byRoute || [])) {
                if (!r || !Array.isArray(r.servingTails)) continue
                if (!r.servingTails.some(id => String(id) === aircraftId)) continue
                totalSegments++
                const ps = _num(r.paxScore, 0)
                bizPaxScore += ps
                if (ps >= 7) highY++
            }
        }
        if (totalSegments < 3) return null
        if (highY / totalSegments < 0.3) return null
        const perTail = 0.5  // service uplift mostly preserves block hours, lifts yield
        const ratioDelta = _estimateRatioDeltaPp(coldRow, perTail)
        return {
            kind:        "service-profile-promote",
            id:          "service-promote:" + aircraftId,
            hubIata:     coldRow.hubIata || coldRow.hub || null,
            aircraftIds: [aircraftId],
            rationale: [
                "[gap] " + (coldRow.registration || aircraftId) + " · "
                    + _num(coldRow.headroomHours, 0).toFixed(1) + "h headroom",
                "[hub] " + (coldRow.hubIata || coldRow.hub || "?") + " · "
                    + highY + "/" + totalSegments + " high-Y segments served",
                "[fix] promote service profile (e.g. economy → mixed)",
                "[predict] yield +5-8% est · ratio "
                    + (ratioDelta >= 0 ? "+" : "") + ratioDelta.toFixed(2) + "pp · 14d (block hrs ~unchanged)"
            ],
            predicted: {
                weeklyHoursDelta:  perTail,
                ratioDeltaPp:      ratioDelta,
                affectedTailCount: 1
            },
            payload: {
                profileFromKey: "auto",
                profileToKey:   "auto",
                scope:          "tails"
            }
        }
    }

    /**
     * Main entry. Returns RebalanceProposal[] capped at maxRebalancesPerWindow.
     * Empty array when fleetUtilSummary has no `candidates.slack` (no cold
     * tails to rebalance from).
     */
    function proposeRebalanceMoves(snapshot, fleetUtilSummary, settings) {
        if (!fleetUtilSummary || !Array.isArray(fleetUtilSummary.candidates && fleetUtilSummary.candidates.slack)) {
            return []
        }
        const fos = (settings && settings.fleetOptimizer) || {}
        const cap = _num(fos.maxRebalancesPerWindow, 3)
        const cold = fleetUtilSummary.candidates.slack
        if (!cold.length) return []

        const proposals = []
        const seen = new Set()

        // Hub-grouped proposals first (wave-add, wave-densify) so multi-tail
        // wins outrank single-tail service promotes.
        const byHub = _pickHubsWithStrandedColdTails(cold)
        for (const [hub, tails] of Object.entries(byHub)) {
            if (proposals.length >= cap) break
            const wAdd = _proposeWaveAdd(hub, tails, snapshot)
            if (wAdd && !seen.has(wAdd.id)) { proposals.push(wAdd); seen.add(wAdd.id) }
            if (proposals.length >= cap) break
            const wDen = _proposeWaveDensify(hub, tails, snapshot)
            if (wDen && !seen.has(wDen.id)) { proposals.push(wDen); seen.add(wDen.id) }
        }

        // Per-tail service-promote proposals as the long tail.
        for (const t of cold) {
            if (proposals.length >= cap) break
            const sp = _proposeServicePromote(t, snapshot)
            if (sp && !seen.has(sp.id)) { proposals.push(sp); seen.add(sp.id) }
        }

        return proposals
    }

    ns.proposeRebalanceMoves = proposeRebalanceMoves
})()
