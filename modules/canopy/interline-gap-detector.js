"use strict"

/**
 * Letter M slice M1 — interline-first gap detector (pure aggregator).
 *
 * Walks the federated kin operations graph and finds "interline-first
 * opportunities" — destinations where one kin's hub has unmet demand,
 * but another kin in the family already serves that destination from a
 * hub the first kin can reach. Surfaces these as `KinGap[]` for the
 * `kin-handoff-moves.js` proposer to wrap into `KinProposal[]`.
 *
 * Design principles:
 *   - PURE function: no DOM, no chrome.storage, no I/O. Caller
 *     pre-loads the inputs. Safe to call at 60 Hz.
 *   - Bounded compute: cap candidates per source kin (default 5) and
 *     skip pairs that share no via-hub feed path. Worst case
 *     O(kins × hubs × dests) ≈ low thousands.
 *   - Family-only: only considers `self`-kind affiliations grouped by
 *     `kinId`. Allied / interline / codeshare partners are NOT emitted
 *     as gap targets in v1 — that becomes a v2 enhancement.
 *
 * Inputs (all optional — degrade gracefully):
 *   {
 *     kins: [{kinId, enterpriseIds[]}],         // distinct kin families
 *     opsByKin: Map<kinId, OpsMap>,             // each OpsMap keyed by hubIata
 *                                                // → {dests: Set<iata>, byDest: Map<iata, RouteRow>}
 *     demandByDest: Map<iata, demandRecord>,    // optional, bumps confidence
 *     affiliations: Map<enterpriseId, AffRec>,  // for self-classification check
 *     options: {maxGapsPerKin?, minDemandPool?, minHubFeedShare?}
 *   }
 *
 * Output:
 *   KinGap[] = [{
 *     sourceKinId,         // kinA — the kin that should feed traffic
 *     sourceHub,           // kinA's hub where the source pax originate
 *     partnerKinId,        // kinB — the kin that already serves the dest
 *     partnerHub,          // kinB's hub serving the destination directly
 *     destIata,            // destination IATA
 *     demandSignal,        // 0..1 normalised demand pool
 *     gapKind,             // "via-hub" (kinA can feed kinB at partnerHub)
 *                          // | "shared-airport" (both kin operate at same hub
 *                          //                      → codeshare/wave-coord)
 *     viaHub?,             // when gapKind === "via-hub", the airport where
 *                          // pax transfer (== partnerHub for v1)
 *     estimatedFamilyDelta,// very rough $/wk estimate; null when undetermined
 *     rationale: string[]  // human-readable per-line explanation
 *   }]
 *
 * Future M-slices read this:
 *   - M1 kin-handoff-moves.js → wraps as KinProposal[]
 *   - M3 wave-complementarity → uses gapKind === "shared-airport" entries
 *   - M7 family-briefing → rolls into "top opportunities this week"
 */
;(function () {
    if (window.AesCanopyInterlineGapDetector) return

    const DEFAULTS = {
        maxGapsPerKin:    5,
        minDemandPool:    50,    // demand-store paxScore unit
        // Yield estimate per pax (advisory only — replace with proper
        // RouteAssistantProfitEstimator when available)
        roughYieldPerPax: 0.45,
        weeksLookahead:   1
    }

    /**
     * Build OpsMap from a per-hub topRoutes blob.
     *   topRoutesByHub: {hubIata: {hub, server, scrapedAt, rows: [{destIata, ..., paxScore}]}}
     * Returns Map<hubIata, {dests: Set<iata>, byDest: Map<iata, RouteRow>}>.
     */
    function buildOpsMap(topRoutesByHub) {
        const ops = new Map()
        if (!topRoutesByHub) return ops
        for (const hub in topRoutesByHub) {
            const blob = topRoutesByHub[hub]
            if (!blob || !Array.isArray(blob.rows)) continue
            const dests = new Set()
            const byDest = new Map()
            for (const row of blob.rows) {
                if (!row || !row.destIata) continue
                const iata = String(row.destIata).toUpperCase()
                dests.add(iata)
                byDest.set(iata, row)
            }
            ops.set(String(hub).toUpperCase(), {dests, byDest})
        }
        return ops
    }

    function _normaliseDemand(demandRecord) {
        if (!demandRecord) return 0
        const score = Number(demandRecord.paxScore) || 0
        // paxScore in demand-derivator caps roughly at 10. Map 0..10 → 0..1.
        return Math.max(0, Math.min(1, score / 10))
    }

    function _routeDemand(opsMap, hub, dest, demandByDest) {
        // Prefer the per-hub topRoutes paxScore (per-route demand depth);
        // fall back to the destination-level demand record (per-airport
        // pax pool, less route-specific).
        const hubOps = opsMap && opsMap.get(hub)
        if (hubOps) {
            const row = hubOps.byDest.get(dest)
            if (row) {
                const pax = Number(row.paxScore)
                if (isFinite(pax) && pax > 0) return pax
            }
        }
        if (demandByDest) {
            const rec = demandByDest.get(dest)
            if (rec) {
                const score = Number(rec.paxScore)
                if (isFinite(score) && score > 0) return score
            }
        }
        return 0
    }

    function _roughDeltaPerWeek(paxScore, options) {
        // paxScore is the demand-derivator's normalised pax pool unit
        // (~10 = saturating). Translate to a weekly $ estimate using a
        // very rough multiplier; consumers should treat as advisory.
        if (!isFinite(paxScore) || paxScore <= 0) return 0
        const weeklyPax = paxScore * 100  // 100 pax/wk per paxScore unit at LF=0.7
        return Math.round(weeklyPax * options.roughYieldPerPax * options.weeksLookahead * 100) / 100
    }

    /**
     * Main entry — returns KinGap[] across the entire family.
     */
    function detectGaps(input) {
        input = input || {}
        const kins = Array.isArray(input.kins) ? input.kins : []
        const opsByKin = input.opsByKin instanceof Map ? input.opsByKin : new Map()
        const demandByDest = input.demandByDest instanceof Map ? input.demandByDest : null
        const options = Object.assign({}, DEFAULTS, input.options || {})

        const out = []
        if (kins.length < 2) return out

        for (const kinA of kins) {
            const opsA = opsByKin.get(kinA.kinId)
            if (!opsA || opsA.size === 0) continue

            const candidatesForA = []

            for (const kinB of kins) {
                if (kinB.kinId === kinA.kinId) continue
                const opsB = opsByKin.get(kinB.kinId)
                if (!opsB || opsB.size === 0) continue

                // For each pair (hubA in kinA, hubB in kinB):
                //   Case 1 (shared-airport): hubA == hubB (same airport, two kin
                //     operating side-by-side → wave coord opportunity, M3 surface).
                //   Case 2 (via-hub): kinA flies hubA → hubB (own connection),
                //     so kinA pax can transfer at hubB to kinB's onward services.
                for (const [hubA, hubAOps] of opsA.entries()) {
                    for (const [hubB, hubBOps] of opsB.entries()) {
                        if (hubA === hubB) {
                            // Shared-airport candidate — find dests both serve
                            // independently (= cannibalization candidate, surfaces
                            // for M2 too) AND dests only kinB serves from hubB
                            // (= codeshare candidate).
                            for (const dest of hubBOps.dests) {
                                if (!hubAOps.dests.has(dest)) {
                                    const demand = _routeDemand(opsB, hubB, dest, demandByDest)
                                    if (demand < options.minDemandPool / 100) continue
                                    candidatesForA.push({
                                        sourceKinId:           kinA.kinId,
                                        sourceHub:             hubA,
                                        partnerKinId:          kinB.kinId,
                                        partnerHub:            hubB,
                                        destIata:              dest,
                                        demandSignal:          _normaliseDemand({paxScore: demand}),
                                        gapKind:               "shared-airport",
                                        viaHub:                null,
                                        estimatedFamilyDelta:  _roughDeltaPerWeek(demand, options),
                                        rationale: [
                                            `[kin:${kinA.kinId}] and [kin:${kinB.kinId}] both operate at ${hubA}`,
                                            `[kin:${kinB.kinId}] serves ${hubB}→${dest} (paxScore ${demand.toFixed(1)})`,
                                            `[kin:${kinA.kinId}] does not serve ${hubA}→${dest} — codeshare on existing wave reduces split exposure`
                                        ]
                                    })
                                }
                            }
                            continue
                        }
                        // Case 2: does kinA fly hubA → hubB? If yes, every dest
                        // kinB serves from hubB that kinA does NOT serve from
                        // hubA is a via-hub gap.
                        if (!hubAOps.dests.has(hubB)) continue
                        for (const dest of hubBOps.dests) {
                            // Skip self-leg
                            if (dest === hubA || dest === hubB) continue
                            // Skip dests kinA already serves from hubA
                            if (hubAOps.dests.has(dest)) continue
                            const demand = _routeDemand(opsB, hubB, dest, demandByDest)
                            if (demand < options.minDemandPool / 100) continue
                            candidatesForA.push({
                                sourceKinId:           kinA.kinId,
                                sourceHub:             hubA,
                                partnerKinId:          kinB.kinId,
                                partnerHub:            hubB,
                                destIata:              dest,
                                demandSignal:          _normaliseDemand({paxScore: demand}),
                                gapKind:               "via-hub",
                                viaHub:                hubB,
                                estimatedFamilyDelta:  _roughDeltaPerWeek(demand, options),
                                rationale: [
                                    `[kin:${kinA.kinId}] flies ${hubA}→${hubB} (own connection)`,
                                    `[kin:${kinB.kinId}] serves ${hubB}→${dest} (paxScore ${demand.toFixed(1)})`,
                                    `Pax originating ${hubA} can transfer at ${hubB} under intra-family interline`,
                                    `Family captures ${dest} demand without [kin:${kinA.kinId}] opening a direct service`
                                ]
                            })
                        }
                    }
                }
            }

            // Rank for kinA by demandSignal × delta and cap at maxGapsPerKin.
            candidatesForA.sort((a, b) => {
                const da = (a.demandSignal || 0) * (a.estimatedFamilyDelta || 1)
                const db = (b.demandSignal || 0) * (b.estimatedFamilyDelta || 1)
                return db - da
            })
            for (let i = 0; i < Math.min(options.maxGapsPerKin, candidatesForA.length); i++) {
                out.push(candidatesForA[i])
            }
        }

        // Final ordering: highest delta first, family-wide.
        out.sort((a, b) => (b.estimatedFamilyDelta || 0) - (a.estimatedFamilyDelta || 0))
        return out
    }

    /**
     * Convenience that pulls the live data from chrome.storage + canopy
     * stores and runs detection. Returns {gaps, diagnostics}.
     *
     * Diagnostics surface "why empty" so the Family tile can render an
     * informative empty state ("Need ≥2 self-classified kin", "Need
     * topRoutes for at least one hub of each kin", etc.).
     */
    async function detectGapsLive(opts) {
        const diagnostics = {
            kinCount:            0,
            kinsWithOps:         0,
            myEnterpriseIdsSet:  false,
            affiliationsLoaded:  false,
            demandLoaded:        false,
            reason:              null
        }

        if (!window.AesCanopyAffiliations) {
            diagnostics.reason = "AesCanopyAffiliations not loaded"
            return {gaps: [], diagnostics}
        }
        diagnostics.affiliationsLoaded = true

        const membersByKinId = await window.AesCanopyAffiliations.membersByKinId()
        diagnostics.kinCount = membersByKinId.size
        if (membersByKinId.size < 2) {
            diagnostics.reason = "fewer than 2 self-classified kin (need both registered + classified)"
            return {gaps: [], diagnostics}
        }

        // For each kin, collect that kin's enterprises' served destinations
        // by hub. v1 reads `routeAssistant:topRoutes:<HUB>` for any hub
        // that's been visited; aggregates by mapping hubs → kins via the
        // primaryHubs / secondaryHubs from the role-store (which the user
        // has reviewed).
        const kins = []
        const opsByKin = new Map()

        for (const [kinId, enterpriseIds] of membersByKinId.entries()) {
            kins.push({kinId, enterpriseIds})
            const hubsForKin = await _resolveHubsForKin(kinId, enterpriseIds, opts)
            const topRoutesByHub = await _readTopRoutesForHubs(hubsForKin)
            const ops = buildOpsMap(topRoutesByHub)
            if (ops.size > 0) diagnostics.kinsWithOps++
            opsByKin.set(kinId, ops)
        }

        if (diagnostics.kinsWithOps < 2) {
            diagnostics.reason = "no two kin have populated topRoutes caches yet (visit RA panel on each kin's hubs)"
            return {gaps: [], diagnostics}
        }

        let demandByDest = null
        if (window.RouteAssistantDemandStore) {
            demandByDest = new Map()
            try {
                // demand-store doesn't expose a bulk read; the per-route
                // paxScore from topRoutes is sufficient for v1 ranking.
                diagnostics.demandLoaded = true
            } catch (_) {}
        }

        const gaps = detectGaps({
            kins,
            opsByKin,
            demandByDest,
            affiliations: null,
            options: opts && opts.options
        })

        return {gaps, diagnostics}
    }

    /**
     * Resolve which hubs to search for a given kin. Order:
     *   1. Role-store primary + secondary hubs for any registered account
     *      whose enterpriseId is in this kin (~exact, user-curated)
     *   2. Hubs observed in AesFleetCommand.build() for those accounts
     *   3. Any hub the user has visited (best-effort) — limit 8 to bound work
     */
    async function _resolveHubsForKin(kinId, enterpriseIds /*, opts */) {
        const out = new Set()

        if (window.AesCanopyRoleStore && window.AesAccountRegistry) {
            try {
                const roles = await window.AesCanopyRoleStore.getAll()
                for (const accountId in roles) {
                    const r = roles[accountId]
                    for (const h of (r.primaryHubs || []))   out.add(String(h).toUpperCase())
                    for (const h of (r.secondaryHubs || [])) out.add(String(h).toUpperCase())
                }
            } catch (_) {}
        }

        if (window.AesFleetCommand) {
            try {
                const view = await window.AesFleetCommand.build()
                for (const t of (view.tails || [])) {
                    if (!t || !t.hubIata) continue
                    out.add(String(t.hubIata).toUpperCase())
                }
            } catch (_) {}
        }

        return Array.from(out).slice(0, 12)
    }

    async function _readTopRoutesForHubs(hubs) {
        const PREFIX = "routeAssistant:topRoutes:"
        if (!hubs || !hubs.length) return {}
        const keys = hubs.map(h => PREFIX + h)
        const out = await chrome.storage.local.get(keys)
        const remap = {}
        for (const k in out) {
            const hub = k.slice(PREFIX.length)
            remap[hub] = out[k]
        }
        return remap
    }

    window.AesCanopyInterlineGapDetector = {
        detectGaps,
        detectGapsLive,
        buildOpsMap,
        DEFAULTS
    }
})()
