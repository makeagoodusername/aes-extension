"use strict"

/**
 * AES Strategy — slot-trading tuner (Slice 20).
 *
 * Pure compute. Reads available-slot records from `AesSlotStore`,
 * scores each via `AesSlotScorer`, and emits Decision[] entries that
 * the strategy panel renders alongside other tuner output. Default
 * `applicable: false` (advisory) until the user flips
 * `slotBidApplyEnabled` on a tier ≥ apply-on-confirm — the same
 * two-gate model every tuner uses.
 *
 * Public API (window.AesStrategySlotTuner):
 *   computeProposals({snapshot, opts?}) → Promise<Decision[]>
 *
 * Decision shape:
 *   {id, domain:"slotBid", kind:"slot-bid", title, subtitle,
 *    rationale[], payload, applicable, applicableNote}
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategySlotTuner) return

    const DEFAULTS = {
        minScore:      0.50,
        topN:          6,
        maxBidUSD:     0          // 0 = no auto-bid; user must enter a max
    }

    const ADVISORY_NOTE = "advisory only (Slice 20 v1 — bidder stub)"

    async function computeProposals(args) {
        args = args || {}
        const snapshot = args.snapshot
        const opts = Object.assign({}, DEFAULTS, args.opts || {})
        if (!snapshot) return []
        const server = snapshot.server
        if (!server) return []
        if (!window.AesSlotStore || !window.AesSlotScorer) return []

        const slots = await window.AesSlotStore.loadAvailable(server)
        if (!slots.length) return []

        const settings = await _loadSettings()
        const writeAllowed = _canApplySlotBid(settings)

        const scored = slots.map(slot => {
            const s = window.AesSlotScorer.score(slot, snapshot)
            return Object.assign({slot: slot}, s)
        })
        scored.sort((a, b) => b.score - a.score)

        const out = []
        for (const s of scored) {
            if (s.score < opts.minScore) continue
            if (out.length >= opts.topN) break
            out.push(_buildDecision(s, writeAllowed, opts))
        }
        return out
    }

    function _buildDecision(s, writeAllowed, opts) {
        const slot = s.slot
        const id = "slotBid:" + (slot.iata || "?") + ":" + (slot.slotId || s.score.toFixed(3))
        const title = (slot.iata || "—") + " · score " + s.score.toFixed(2)
        const subtitle = slot.runwayClass
            ? slot.runwayClass + " · " + (slot.weeklyOps || "?") + " weekly ops"
            : (isFinite(slot.minBid) ? "min $" + Math.round(slot.minBid).toLocaleString() : "score-only")

        return {
            id:       id,
            domain:   "slotBid",
            kind:     "slot-bid",
            title:    title,
            subtitle: subtitle,
            rationale: s.rationale.slice(),
            payload: {
                server:      slot.server || null,
                iata:        slot.iata,
                slotId:      slot.slotId || null,
                runwayClass: slot.runwayClass || null,
                weeklyOps:   slot.weeklyOps || null,
                minBid:      slot.minBid    || null,
                currentBid:  slot.currentBid || null,
                suggestedBid: _suggestBid(slot, opts),
                breakdown:   s.breakdown,
                score:       s.score
            },
            applicable:     writeAllowed,
            applicableNote: writeAllowed ? null : ADVISORY_NOTE
        }
    }

    function _suggestBid(slot, opts) {
        const base = isFinite(slot.minBid) ? slot.minBid : 0
        const cur  = isFinite(slot.currentBid) ? slot.currentBid : 0
        const hint = Math.max(base, Math.round(cur * 1.05))
        if (opts.maxBidUSD > 0) return Math.min(hint, opts.maxBidUSD)
        return hint
    }

    async function _loadSettings() {
        try {
            if (window.AesStrategySettings && typeof window.AesStrategySettings.load === "function") {
                return await window.AesStrategySettings.load()
            }
        } catch (_) {}
        return null
    }

    function _canApplySlotBid(settings) {
        if (!settings) return false
        if (window.AesStrategySettings && typeof window.AesStrategySettings.canApply === "function") {
            try { return window.AesStrategySettings.canApply(settings, "slotBid") }
            catch (_) {}
        }
        if (settings.tier === "preview-only") return false
        return !!settings.slotBidApplyEnabled
    }

    window.AesStrategySlotTuner = {computeProposals, DEFAULTS}
})()
