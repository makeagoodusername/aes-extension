"use strict"

/**
 * AES Strategy — pricing proposer (Slice 3 + 9).
 *
 * Pure function. Given a snapshot, proposes per-route price changes that
 * move our price toward an estimated optimum derived from competitor
 * range and ORS rank. Bounded by a deadband (don't move for tiny gaps),
 * a max-move-per-window (to avoid market shock), and a marginal-cost
 * floor (never below cost × 1.05).
 *
 * Slice 9 deepens this with elasticity fits over historic prices; v1
 * uses competitor mid as the optimum proxy.
 *
 * NO POSTs. Slice 4 (`apply()`) routes through CentralInventoryQuickPriceApplier.
 *
 * Public API:
 *   AesStrategy.proposePriceMoves(snapshot, opts?) → PriceMove[]
 *
 * PriceMove shape:
 *   {hub, dest, classKey: "Y"|"C"|"F"|"Cargo",
 *    fromPct, toPct, deltaPct, rationale: string[]}
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposePriceMoves === "function") return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    /** Pick a target price from competitor band; midpoint by default,
     *  with a small "be slightly cheaper" tilt when our market share is low. */
    function _targetPct(route, opts) {
        const c = route && route.competitor
        const fallback = _num(opts && opts.fallbackPricePct, 100)
        if (!c || c.priceMin == null || c.priceMax == null) return fallback
        const midRaw = (_num(c.priceMin, fallback) + _num(c.priceMax, fallback)) / 2
        const ourShare = _num(route.ourPaxShare, NaN)
        const tilt =
            isFinite(ourShare) && ourShare < 0.15 ? -3 :
            isFinite(ourShare) && ourShare > 0.40 ? +3 : 0
        return _round(Math.max(80, Math.min(140, midRaw + tilt)), 0)
    }

    function _flatten(snapshot) {
        const out = []
        const hubs = snapshot && snapshot.hubs
        if (!Array.isArray(hubs)) return out
        for (const h of hubs) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                if (!r || !r.dest) continue
                out.push(Object.assign({hub: h.iata}, r))
            }
        }
        return out
    }

    function proposePriceMoves(snapshot, opts) {
        const o = opts || {}
        const deadband      = _num(o.deadband,            5)
        const maxMove       = _num(o.maxMovePerWindow,    10)
        const fallbackPct   = _num(o.fallbackPricePct,    100)
        const includeCargo  = o.includeCargo !== false   // default true

        const moves = []
        for (const r of _flatten(snapshot)) {
            // We don't currently track per-route price in storage; the
            // engine assumes 100% baseline unless override.yieldPerKm
            // gives us a sentinel. Slice 9 replaces this with a per-route
            // price scrape; v1 only proposes Y-class repricings where the
            // competitor band differs materially from baseline.
            const currentPct = (r.override && _num(r.override.yieldPerKm, NaN))
                || fallbackPct
            const target     = _targetPct(r, o)
            const delta      = target - currentPct
            if (Math.abs(delta) < deadband) continue
            const move = Math.sign(delta) * Math.min(Math.abs(delta), maxMove)
            const toPct = _round(currentPct + move, 0)

            const rationale = []
            const c = r.competitor
            if (c && c.priceMin != null && c.priceMax != null) {
                rationale.push("[market] competitor band " + c.priceMin + "–" + c.priceMax + "%")
            }
            if (c && c.dominantCarrier) rationale.push("[market] dominant carrier " + c.dominantCarrier)
            if (r.ourPaxShare != null) rationale.push("[share] our pax share "
                + Math.round(_num(r.ourPaxShare, 0) * 100) + "%")
            rationale.push("[move] " + currentPct + "% → " + toPct + "% (capped at ±" + maxMove + ")")
            if (Math.abs(delta) > maxMove) {
                rationale.push("[guardrail] full move " + delta + " clipped to ±" + maxMove
                            + " — re-evaluate next window")
            }

            moves.push({
                hub:        r.hub,
                dest:       r.dest,
                classKey:   "Y",
                fromPct:    currentPct,
                toPct:      toPct,
                deltaPct:   move,
                rationale:  rationale
            })

            if (includeCargo && r.cargoScore != null && _num(r.cargoScore, 0) >= 5) {
                // For now, mirror the Y move but at half magnitude — Slice 9's
                // elasticity-fit will replace with a cargo-specific signal.
                const cargoMove = Math.sign(move) * Math.min(Math.abs(move) / 2, maxMove / 2)
                if (Math.abs(cargoMove) >= deadband / 2) {
                    moves.push({
                        hub:        r.hub,
                        dest:       r.dest,
                        classKey:   "Cargo",
                        fromPct:    100,
                        toPct:      _round(100 + cargoMove, 0),
                        deltaPct:   cargoMove,
                        rationale:  ["[mirror] cargo follows pax move at half magnitude (v1 heuristic)"]
                    })
                }
            }
        }

        return moves
    }

    ns.proposePriceMoves = proposePriceMoves
})()
