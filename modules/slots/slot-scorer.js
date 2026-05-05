"use strict"

/**
 * AES Slots — slot scorer (Slice 20).
 *
 * Pure compute. Given a SlotRecord and a Snapshot, returns a 0..1
 * score plus a breakdown and rationale array. No I/O. The score blends:
 *
 *   routeFit       — how well does this slot's airport fit our network?
 *                    1 when iata is one of our hubs OR an existing dest;
 *                    0.5 when it's a competitor hub we've eyed; 0 else.
 *   hubProximity   — distance from this airport to our nearest hub,
 *                    normalized against fleet median range.
 *                    1 inside median range; 0 beyond max range.
 *   demandSignal   — best-effort: paxScore from snapshot.hubs[].byRoute
 *                    that touches this airport, normalized to 0..10 → 0..1.
 *   bidEconomics   — when minBid + currentBid are present, derives
 *                    (minBid / (currentBid+1)) clamped 0..1 — lower
 *                    relative bid → higher economics signal.
 *
 *   score = 0.40 * routeFit + 0.30 * hubProximity
 *         + 0.20 * demandSignal + 0.10 * bidEconomics
 *
 * Public API (window.AesSlotScorer):
 *   score(slot, snapshot, opts?) → {score, breakdown, rationale[]}
 */
;(function () {
    if (window.AesSlotScorer) return

    function score(slot, snapshot, opts) {
        opts = opts || {}
        const components = {
            routeFit:     _routeFit(slot, snapshot),
            hubProximity: _hubProximity(slot, snapshot),
            demandSignal: _demandSignal(slot, snapshot),
            bidEconomics: _bidEconomics(slot)
        }
        const blended = 0.40 * components.routeFit
                      + 0.30 * components.hubProximity
                      + 0.20 * components.demandSignal
                      + 0.10 * components.bidEconomics
        return {
            score:     +blended.toFixed(4),
            breakdown: _round(components),
            rationale: _rationale(slot, components)
        }
    }

    function _routeFit(slot, snapshot) {
        if (!slot || !slot.iata || !snapshot) return 0
        const iata = String(slot.iata).toUpperCase()
        const hubs = (snapshot.hubs || []).map(h => String(h && h.iata || "").toUpperCase())
        if (hubs.includes(iata)) return 1
        for (const h of (snapshot.hubs || [])) {
            for (const r of (h && h.byRoute || [])) {
                if (r && String(r.dest || "").toUpperCase() === iata) return 0.85
            }
        }
        for (const rival of (snapshot.rivals || [])) {
            const rh = (rival && rival.hubs) || []
            if (rh.some(h => String(h).toUpperCase() === iata)) return 0.5
        }
        return 0
    }

    function _hubProximity(slot, snapshot) {
        if (!slot || !slot.iata || !snapshot) return 0
        const fleet  = (snapshot.fleet || [])
        const ranges = fleet.map(a => Number(a && a.rangeKm)).filter(r => isFinite(r) && r > 0)
        if (!ranges.length) return 0.5
        const medianRange = _median(ranges)
        const hubs = snapshot.hubs || []
        if (!hubs.length) return 0
        let best = Infinity
        for (const h of hubs) {
            for (const r of (h.byRoute || [])) {
                if (!r) continue
                const dest = String(r.dest || "").toUpperCase()
                if (dest === String(slot.iata).toUpperCase() && isFinite(r.distanceKm)) {
                    if (r.distanceKm < best) best = r.distanceKm
                }
            }
        }
        if (!isFinite(best)) return 0
        if (best <= medianRange) return 1
        const maxRange = Math.max.apply(null, ranges)
        if (best >= maxRange) return 0
        return Math.max(0, Math.min(1, 1 - (best - medianRange) / (maxRange - medianRange)))
    }

    function _demandSignal(slot, snapshot) {
        if (!slot || !slot.iata || !snapshot) return 0
        const iata = String(slot.iata).toUpperCase()
        let best = 0
        for (const h of (snapshot.hubs || [])) {
            for (const r of (h && h.byRoute || [])) {
                if (!r) continue
                if (String(r.dest || "").toUpperCase() !== iata) continue
                const v = Number(r.paxScore)
                if (isFinite(v) && v > best) best = v
            }
        }
        return Math.max(0, Math.min(1, best / 10))
    }

    function _bidEconomics(slot) {
        if (!slot) return 0
        const min = Number(slot.minBid)
        const cur = Number(slot.currentBid)
        if (!isFinite(min) || min <= 0) return 0
        if (!isFinite(cur) || cur <= 0) return 1
        return Math.max(0, Math.min(1, min / (cur + 1)))
    }

    function _rationale(slot, c) {
        const lines = []
        if (c.routeFit >= 0.85)     lines.push("airport already in our network")
        else if (c.routeFit >= 0.5) lines.push("competitor hub — entry-cost payoff")
        else                        lines.push("airport new to our network")
        if (c.hubProximity >= 0.8)  lines.push("inside fleet median range from our nearest hub")
        else if (c.hubProximity <= 0.2) lines.push("range-stressed for current fleet")
        if (c.demandSignal >= 0.5)  lines.push("strong inbound demand signal")
        if (slot && isFinite(slot.weeklyOps)) lines.push(slot.weeklyOps + " weekly ops attached to this slot")
        if (slot && isFinite(slot.minBid) && isFinite(slot.currentBid))
            lines.push("min bid $" + Math.round(slot.minBid).toLocaleString()
                + " vs current $" + Math.round(slot.currentBid).toLocaleString())
        return lines
    }

    function _round(o) {
        const out = {}
        for (const k of Object.keys(o)) out[k] = +(Number(o[k]) || 0).toFixed(4)
        return out
    }

    function _median(arr) {
        const s = arr.slice().sort((x, y) => x - y)
        const n = s.length
        if (!n) return 0
        return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])
    }

    window.AesSlotScorer = {score}
})()
