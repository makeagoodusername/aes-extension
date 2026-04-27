"use strict"

/**
 * AES Strategy — service-profile move proposer (Slice 3 + 7).
 *
 * Pure function. Given a snapshot, identifies service profiles whose
 * Y-class score lags the best available profile and proposes upgrades
 * that maximize ORS lift per cost. v1 uses a simple "lift gap to median
 * of upper profiles" heuristic; Slice 7 replaces with a per-category
 * elasticity model.
 *
 * NO POSTs. Slice 4 (`apply()`) routes through
 * RouteAssistantServiceProfileApplier.apply(profileId, changes).
 *
 * Public API:
 *   AesStrategy.proposeServiceMoves(snapshot, opts?) → ServiceMove[]
 *
 * ServiceMove shape:
 *   {profileId, profileName, currentClassScore: {Y, C, F},
 *    targetClassScore: {Y, C, F},
 *    changes: {<categoryKey>: {Y?: level, C?: level, F?: level}},
 *    predictedOrsDelta: number, rationale: string[]}
 *
 * NOTE: in v1 we do NOT have category-level granularity in the snapshot
 * (Slice 1 only synthesizes class scores per profile). So this v1 emits
 * coarse "upgrade profile X toward Y baseline" recommendations without
 * the per-category change keys filled — `changes` is left as an empty
 * object to be filled in by Slice 7's deeper service-tuner. The
 * predictedOrsDelta is reported so the UI can rank without per-category
 * detail.
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeServiceMoves === "function") return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    function _classScore(p, key) {
        return p && p.classScore && _num(p.classScore[key], NaN)
    }

    function proposeServiceMoves(snapshot, opts) {
        const o = opts || {}
        const minLift = _num(o.minPredictedLift, 0.05)   // 5pt ORS lift floor
        const profiles = (snapshot && snapshot.serviceProfiles) || []
        if (profiles.length < 2) return []

        // Compute the "upper-half" baseline for each class.
        const ys = profiles.map(p => _classScore(p, "Y")).filter(isFinite).sort((a, b) => b - a)
        const cs = profiles.map(p => _classScore(p, "C")).filter(isFinite).sort((a, b) => b - a)
        const fs = profiles.map(p => _classScore(p, "F")).filter(isFinite).sort((a, b) => b - a)
        if (!ys.length) return []

        const upperMedY = ys[Math.floor(ys.length / 4)]   // top quartile median
        const upperMedC = cs.length ? cs[Math.floor(cs.length / 4)] : null
        const upperMedF = fs.length ? fs[Math.floor(fs.length / 4)] : null

        const moves = []
        for (const p of profiles) {
            if (!p) continue
            const yNow = _classScore(p, "Y")
            const cNow = _classScore(p, "C")
            const fNow = _classScore(p, "F")
            if (!isFinite(yNow)) continue

            const yGap = upperMedY - yNow
            if (yGap < minLift) continue

            const target = {
                Y: _round(yNow + yGap, 3),
                C: isFinite(cNow) && upperMedC != null ? _round(Math.max(cNow, upperMedC), 3) : cNow,
                F: isFinite(fNow) && upperMedF != null ? _round(Math.max(fNow, upperMedF), 3) : fNow
            }

            const rationale = [
                "[gap] Y-score " + _round(yNow, 3) + " vs. top-quartile median "
                    + _round(upperMedY, 3) + " (lift +" + _round(yGap, 3) + ")",
                "[note] v1 emits coarse profile recommendation — Slice 7 produces per-category change set"
            ]
            if (p.scrapedAt) {
                const ageDays = (Date.now() - p.scrapedAt) / (24 * 3600 * 1000)
                if (ageDays > 14) rationale.push("[stale] profile detail scraped " + Math.round(ageDays) + "d ago")
            }

            moves.push({
                profileId:         p.id,
                profileName:       p.name || ("#" + p.id),
                currentClassScore: {Y: yNow, C: cNow, F: fNow},
                targetClassScore:  target,
                changes:           {},   // filled by Slice 7
                predictedOrsDelta: yGap,
                rationale:         rationale
            })
        }

        moves.sort((a, b) => (b.predictedOrsDelta || 0) - (a.predictedOrsDelta || 0))
        return moves
    }

    ns.proposeServiceMoves = proposeServiceMoves
})()
