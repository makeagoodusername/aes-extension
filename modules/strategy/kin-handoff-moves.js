"use strict"

/**
 * Letter M slice M1 — kin-handoff proposer (preview-only).
 *
 * Wraps `AesCanopyInterlineGapDetector` output as `KinProposal[]` so the
 * Strategy / Family briefing surfaces consume one canonical proposer
 * shape (mirrors `rebalance-moves.js`, `price-moves.js` etc).
 *
 * Public API:
 *   AesStrategy.proposeKinHandoffMoves(snapshot?, settings?)
 *     → Promise<KinProposal[]>
 *
 * KinProposal:
 *   {
 *     proposerId:   "kin-handoff",          // identifies the source proposer
 *     kind:         "interline-first",      // pattern label
 *     id:           string,                 // stable per gap for dedup / journal
 *     accountIds?:  string[],               // future: registry mapping
 *     kinIds:       [sourceKinId, partnerKinId],
 *     hubs:         [sourceHub, partnerHub],
 *     destIata:     string,
 *     gapKind:      "via-hub" | "shared-airport",
 *     viaHub?:      string,
 *     predicted: {
 *       familyDeltaPerWeek: number,         // rough $/wk advisory
 *       demandSignal:        number          // 0..1
 *     },
 *     payload: {
 *       suggestion: "Sign IL agreement and align waves at <viaHub>" |
 *                   "Codeshare existing service at <sharedHub>",
 *       gap:        KinGap                  // raw detector output
 *     },
 *     rationale: string[]                   // human-readable per-line
 *   }
 *
 * Settings (under `settings.canopy.coord.ilFirst`):
 *   enabled               default true
 *   maxProposalsPerCall   default 5
 *   minDemandPool         default 50
 *
 * Per-pattern toggleable (invariant M-F): when `enabled === false` this
 * proposer returns []. The single-kin code path stays valid since the
 * detector also returns [] when fewer than 2 self-classified kin exist.
 *
 * v1: PREVIEW-ONLY — no APPLY path. The Family tile / future briefing
 * surface the proposals as advisory cards. M2/M3+ shipping schedule and
 * IL-form-fill actuators will wire the apply gates per invariant M-A.
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeKinHandoffMoves === "function") return

    function _readSetting(settings, path, fallback) {
        try {
            const parts = path.split(".")
            let cur = settings || {}
            for (const p of parts) {
                if (cur == null) return fallback
                cur = cur[p]
            }
            return cur != null ? cur : fallback
        } catch (_) { return fallback }
    }

    function _stableId(gap) {
        const parts = [
            "kh",
            gap.sourceKinId,
            gap.sourceHub,
            gap.partnerKinId,
            gap.partnerHub,
            gap.destIata,
            gap.gapKind
        ]
        return parts.join(":")
    }

    function _gapToProposal(gap) {
        const isShared = gap.gapKind === "shared-airport"
        const suggestion = isShared
            ? `Codeshare existing service at ${gap.sourceHub}; aligned waves cut split exposure`
            : `Sign IL agreement and align waves at ${gap.viaHub || gap.partnerHub}`
        return {
            proposerId:   "kin-handoff",
            kind:         "interline-first",
            id:           _stableId(gap),
            accountIds:   [],   // populated in v2 once registry mapping lands
            kinIds:       [gap.sourceKinId, gap.partnerKinId],
            hubs:         [gap.sourceHub, gap.partnerHub],
            destIata:     gap.destIata,
            gapKind:      gap.gapKind,
            viaHub:       gap.viaHub || null,
            predicted: {
                familyDeltaPerWeek: gap.estimatedFamilyDelta || 0,
                demandSignal:       gap.demandSignal || 0
            },
            payload: {
                suggestion,
                gap
            },
            rationale: gap.rationale.slice(0, 5)
        }
    }

    /**
     * Run the proposer. Resolves with the cap-respecting top KinProposal[].
     * Returns [] when the pattern is disabled OR the detector yields no gaps.
     */
    async function proposeKinHandoffMoves(_snapshot, settings) {
        const enabled = _readSetting(settings, "canopy.coord.ilFirst.enabled", true) !== false
        if (!enabled) return []
        if (!window.AesCanopyInterlineGapDetector) return []

        const cap = Number(_readSetting(settings, "canopy.coord.ilFirst.maxProposalsPerCall", 5)) || 5
        const minDemandPool = Number(_readSetting(settings, "canopy.coord.ilFirst.minDemandPool", 50)) || 50

        let result
        try {
            result = await window.AesCanopyInterlineGapDetector.detectGapsLive({
                options: {minDemandPool, maxGapsPerKin: cap}
            })
        } catch (_) {
            return []
        }

        const gaps = (result && result.gaps) || []
        const proposals = gaps.slice(0, cap).map(_gapToProposal)
        return proposals
    }

    /**
     * Diagnostics path — same as proposeKinHandoffMoves but also returns
     * the detector's `diagnostics` so a UI surface can explain the empty
     * state ("Need ≥2 self-classified kin" / "no two kin have populated
     * topRoutes caches yet" etc).
     */
    async function proposeKinHandoffMovesWithDiagnostics(_snapshot, settings) {
        const proposals = await proposeKinHandoffMoves(_snapshot, settings)
        let diagnostics = null
        try {
            const r = await window.AesCanopyInterlineGapDetector.detectGapsLive({
                options: {minDemandPool: Number(_readSetting(settings, "canopy.coord.ilFirst.minDemandPool", 50)) || 50}
            })
            diagnostics = r && r.diagnostics
        } catch (_) {}
        return {proposals, diagnostics}
    }

    ns.proposeKinHandoffMoves = proposeKinHandoffMoves
    ns.proposeKinHandoffMovesWithDiagnostics = proposeKinHandoffMovesWithDiagnostics
})()
