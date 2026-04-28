"use strict"

/**
 * Route Assistant — silent-auto proposer registry.
 *
 * Extracts the per-route price proposal logic out of panel.js so new
 * strategies can plug in without touching the loop. v1 ships
 * `competitor-median` (behaviour preserved from panel.js); Phase 3 adds
 * `strategy-objective` and `ors-elasticity`.
 *
 * Public API:
 *   RouteAssistantSilentAutoProposers.list()
 *     → [{key, label, description}]   // for the strategy picker UI
 *
 *   RouteAssistantSilentAutoProposers.dispatch(strategy, route, prices, cfg, ctx)
 *     → ProposalResult
 *
 *   RouteAssistantSilentAutoProposers.buildContext({strategy, settings, ...})
 *     → ctx                            // shared per-tick state (e.g. cached
 *                                      //   strategy snapshot)
 *
 * Proposer contract:
 *   inputs:
 *     route   — eligible-route record from _silentAutoEligibleRoutes:
 *               {hub, destIata, competitorMedianPriceY, competitorYsCount,
 *                ourPaxShare, profitPerWeek, congestionIndex, override, ...}
 *     prices  — {Y, C, F, Cargo} cached current prices for the route
 *     cfg     — flattened settings.pricing slice (silentAutoMinDeltaPct,
 *               silentAutoMaxStepPct, silentAutoCompetitorMinCount, ...)
 *     ctx     — proposer-specific shared state from buildContext()
 *   output (ProposalResult):
 *     {ok: true,  dest, prices: {Y?,C?,F?,Cargo?}, deltaPct, prevY, newY,
 *                 reason, rationale?, projectedDelta?}
 *     {ok: false, dest, skipReason}
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.RouteAssistantSilentAutoProposers) return

    // ------------------------------------------------------------------
    // competitor-median — verbatim port of
    // panel.js:_silentAutoProposeCompetitorMedian. Kept here as the
    // canonical home; panel.js delegates via dispatch().
    //
    // The single deviation from the original: `silentAutoCompetitorMinCount`
    // is read from cfg with a default of 2 (was hardcoded `< 2`). Defaults
    // to 2 so existing setups keep current behaviour.
    // ------------------------------------------------------------------
    function _competitorMedian(route, prices, cfg) {
        const dest = String(route.destIata || "").toUpperCase()
        const ourY = prices && prices.Y
        if (!isFinite(ourY) || ourY <= 0) {
            return {ok: false, dest, skipReason: "no own Y price cached"}
        }

        const median = route.competitorMedianPriceY
        const count  = isFinite(route.competitorYsCount) ? route.competitorYsCount : 0
        const minCount = isFinite(cfg.silentAutoCompetitorMinCount) && cfg.silentAutoCompetitorMinCount > 0
            ? cfg.silentAutoCompetitorMinCount : 2
        if (!isFinite(median) || median <= 0) {
            return {ok: false, dest, skipReason: "no competitor Y median scraped"}
        }
        if (count < minCount) {
            return {ok: false, dest,
                    skipReason: "only " + count + " competitor"
                                + (count === 1 ? "" : "s") + " (need ≥" + minCount + " for median)"}
        }

        const rawDeltaPct = ((median - ourY) / ourY) * 100
        if (!isFinite(rawDeltaPct)) {
            return {ok: false, dest, skipReason: "Δ% computation produced non-finite"}
        }
        const minDelta = cfg.silentAutoMinDeltaPct || 3
        if (Math.abs(rawDeltaPct) < minDelta) {
            return {ok: false, dest,
                    skipReason: "|Δ%| " + rawDeltaPct.toFixed(1) + " < min " + minDelta + "% (proposer noise floor)"}
        }

        const cap = Math.max(0, cfg.silentAutoMaxStepPct || 10)
        const clamped = Math.max(-cap, Math.min(cap, rawDeltaPct))
        const newY = Math.max(1, Math.round(ourY * (1 + clamped / 100)))
        if (newY === Math.round(ourY)) {
            return {ok: false, dest,
                    skipReason: "after clamp + round, newY equals current ourY"}
        }

        return {
            ok:        true,
            dest,
            prices:    {Y: newY},
            deltaPct:  clamped,
            prevY:     Math.round(ourY),
            newY,
            reason:    "silent-auto · track competitor median Y · "
                       + ourY + " → " + newY + " (Δ " + clamped.toFixed(1) + "%, median " + median + " across " + count + " competitors)"
        }
    }

    // ------------------------------------------------------------------
    // strategy-objective — adapter over AesStrategy.proposePriceMoves.
    //
    // Reads `ctx.strategyMovesByPair` (Map<HUB-DEST, PriceMove>), built
    // once per tick by panel.js's `_silentAutoBuildProposerContext`. The
    // strategy proposer's own deadband + maxMove guardrails are applied
    // upstream during snapshot → moves; we re-apply silent-auto's caps
    // here so the user's silent-auto config wins over the strategy
    // module's defaults.
    //
    // Surfaces objective.kind + weights and the rationale array so the
    // audit log row reads as a strategy-level decision rather than a
    // mystery delta.
    // ------------------------------------------------------------------
    function _strategyObjective(route, prices, cfg, ctx) {
        const dest = String(route.destIata || "").toUpperCase()
        const hub  = String(route.hub || (ctx && ctx.hub) || "").toUpperCase()
        // Hub falls back to ctx — a panel always passes its hub via the
        // route record, but we defensive-default for unit-test paths.
        if (!ctx || !ctx.strategyMovesByPair) {
            return {ok: false, dest, skipReason: "AesStrategy snapshot unavailable (module not loaded?)"}
        }
        const ourY = prices && prices.Y
        if (!isFinite(ourY) || ourY <= 0) {
            return {ok: false, dest, skipReason: "no own Y price cached"}
        }

        const key = (hub ? String(hub).toUpperCase() : "") + "-" + dest
        const move = ctx.strategyMovesByPair.get(key)
        if (!move) {
            return {ok: false, dest, skipReason: "no strategy move for " + key + " (deadband / objective unmet)"}
        }
        const fromPct = Number(move.fromPct)
        const toPct   = Number(move.toPct)
        if (!isFinite(fromPct) || fromPct <= 0 || !isFinite(toPct) || toPct <= 0) {
            return {ok: false, dest, skipReason: "strategy move has non-positive pct (skipped)"}
        }
        // Convert percent-of-default → absolute price. The strategy module
        // works in pct space; current Y price corresponds to fromPct so a
        // move from fromPct to toPct scales currentY by the same ratio.
        const ratio = toPct / fromPct
        const rawDeltaPct = (ratio - 1) * 100
        const minDelta = cfg.silentAutoMinDeltaPct || 3
        if (Math.abs(rawDeltaPct) < minDelta) {
            return {ok: false, dest,
                    skipReason: "strategy Δ% " + rawDeltaPct.toFixed(1) + " < silent-auto min " + minDelta + "%"}
        }
        const cap = Math.max(0, cfg.silentAutoMaxStepPct || 10)
        const clamped = Math.max(-cap, Math.min(cap, rawDeltaPct))
        const newY = Math.max(1, Math.round(ourY * (1 + clamped / 100)))
        if (newY === Math.round(ourY)) {
            return {ok: false, dest, skipReason: "after clamp + round, newY equals current ourY"}
        }

        // Build the result envelope. Carry strategy rationale + objective
        // forward so the audit modal can render *why* this move was chosen
        // — that's the whole point of using strategy-objective over
        // competitor-median.
        const reasonPieces = ["silent-auto · strategy-objective"]
        if (move.objective && move.objective.kind) {
            reasonPieces.push("goal " + move.objective.kind)
        }
        reasonPieces.push(ourY + " → " + newY + " (Δ " + clamped.toFixed(1) + "%)")
        return {
            ok:        true,
            dest,
            prices:    {Y: newY},
            deltaPct:  clamped,
            prevY:     Math.round(ourY),
            newY,
            reason:    reasonPieces.join(" · "),
            rationale: Array.isArray(move.rationale) ? move.rationale.slice(0, 12) : null,
            objective: move.objective || null
        }
    }

    // ------------------------------------------------------------------
    // ors-elasticity — adapter over RouteAssistantOrsModel.scanPriceCurve.
    //
    // For each route we call scanPriceCurve(lo:0.7, hi:1.3, step:0.05)
    // which sweeps Y/C/F price multipliers uniformly and returns the
    // profit-optimal multiplier. We pick that multiplier, scale the
    // route's current Y, and re-apply silent-auto's caps. Skips when:
    //   - ORS cache for this dest is older than `silentAutoOrsMaxAgeMin`
    //     (default 60 min); confidence in the projection drops fast
    //   - the optimal multiplier is exactly 1 (model says "don't move")
    //   - the resulting |Δ%| is below the noise floor
    //
    // Surfaces `projectedDelta` from the optimal point so the audit log
    // can show "+$X profit/wk projected" alongside the price change.
    // ------------------------------------------------------------------
    function _orsElasticity(route, prices, cfg, ctx) {
        const dest = String(route.destIata || "").toUpperCase()
        if (typeof window === "undefined" || !window.RouteAssistantOrsModel
            || typeof window.RouteAssistantOrsModel.scanPriceCurve !== "function") {
            return {ok: false, dest, skipReason: "RouteAssistantOrsModel not loaded"}
        }
        const ourY = prices && prices.Y
        if (!isFinite(ourY) || ourY <= 0) {
            return {ok: false, dest, skipReason: "no own Y price cached"}
        }
        // ctx may carry a richer route record (with orsByClass etc.) than
        // the silent-auto eligible-row's `r` shape; prefer it when present.
        const fullRoute = (ctx && ctx.routesByDest && ctx.routesByDest.get(dest)) || route
        const orsByClass = fullRoute && fullRoute.orsByClass
        const ownPricing = fullRoute && fullRoute.ownPricing
        if (!orsByClass || typeof orsByClass !== "object") {
            return {ok: false, dest, skipReason: "no ORS cache for route (run an ORS scrape)"}
        }
        // Staleness gate — derive freshness from any class's scrapedAt.
        const maxAgeMin = isFinite(cfg.silentAutoOrsMaxAgeMin)
            ? Math.max(0, cfg.silentAutoOrsMaxAgeMin) : 60
        if (maxAgeMin > 0) {
            let freshest = 0
            for (const k in orsByClass) {
                const rec = orsByClass[k]
                if (rec && isFinite(rec.scrapedAt) && rec.scrapedAt > freshest) freshest = rec.scrapedAt
            }
            if (!freshest) {
                return {ok: false, dest, skipReason: "ORS cache has no scrapedAt timestamps"}
            }
            const ageMin = (Date.now() - freshest) / 60000
            if (ageMin > maxAgeMin) {
                return {ok: false, dest,
                        skipReason: "ORS cache " + Math.round(ageMin) + " min old > max " + maxAgeMin + " min"}
            }
        }

        let scan = null
        try {
            scan = window.RouteAssistantOrsModel.scanPriceCurve({
                route:              fullRoute,
                modelParams:        (ctx && ctx.modelParams) || {},
                economics:          (ctx && ctx.economics)   || {},
                useRealDemandForLF: !!(ctx && ctx.useRealDemandForLF),
                scan:               {lo: 0.7, hi: 1.3, step: 0.05}
            })
        } catch (e) {
            return {ok: false, dest, skipReason: "scanPriceCurve threw: " + (e && e.message || String(e))}
        }
        if (!scan || !scan.optimal || !isFinite(scan.optimal.multiplier)) {
            return {ok: false, dest, skipReason: "scanPriceCurve produced no optimal point"}
        }
        if (scan.optimal.multiplier === 1) {
            return {ok: false, dest, skipReason: "ors-elasticity says hold (optimal multiplier = 1.0)"}
        }
        const rawDeltaPct = (scan.optimal.multiplier - 1) * 100
        const minDelta = cfg.silentAutoMinDeltaPct || 3
        if (Math.abs(rawDeltaPct) < minDelta) {
            return {ok: false, dest,
                    skipReason: "ors-elasticity Δ% " + rawDeltaPct.toFixed(1) + " < min " + minDelta + "%"}
        }
        const cap = Math.max(0, cfg.silentAutoMaxStepPct || 10)
        const clamped = Math.max(-cap, Math.min(cap, rawDeltaPct))
        const newY = Math.max(1, Math.round(ourY * (1 + clamped / 100)))
        if (newY === Math.round(ourY)) {
            return {ok: false, dest, skipReason: "after clamp + round, newY equals current ourY"}
        }

        const projected = (scan.optimal.deltaProfit != null && isFinite(scan.optimal.deltaProfit))
            ? Math.round(scan.optimal.deltaProfit) : null
        const reason = "silent-auto · ors-elasticity · " + ourY + " → " + newY
                     + " (Δ " + clamped.toFixed(1) + "%, optimal mult "
                     + scan.optimal.multiplier.toFixed(2)
                     + (projected != null ? ", proj +$" + projected + "/wk" : "")
                     + ")"
        return {
            ok:        true,
            dest,
            prices:    {Y: newY},
            deltaPct:  clamped,
            prevY:     Math.round(ourY),
            newY,
            reason,
            rationale: [
                "[ors] curve sweep " + (scan.points ? scan.points.length : "?") + " points · optimal mult "
                    + scan.optimal.multiplier.toFixed(2),
                projected != null ? "[profit] optimal projects +$" + projected + "/wk" : null,
                "[clamp] silent-auto cap ±" + cap + "% applied · raw Δ " + rawDeltaPct.toFixed(1) + "% → "
                    + clamped.toFixed(1) + "%"
            ].filter(Boolean),
            projectedDelta: (projected != null) ? {profitPerWeek: projected} : null
        }
    }

    // ------------------------------------------------------------------
    // Registry + dispatch.
    //
    // Registered proposers must conform to the contract above. The order
    // of `list()` is the order shown in the strategy picker — keep
    // `competitor-median` first so it remains the safe default.
    // ------------------------------------------------------------------
    const PROPOSERS = {
        "competitor-median": {
            fn: _competitorMedian,
            label: "Competitor median (Y only)",
            description: "Track the median competitor Y price. Conservative — needs ≥N competitors and stays below max step."
        },
        "strategy-objective": {
            fn: _strategyObjective,
            label: "Strategy objective (share / profit / rank)",
            description: "Use the network strategy snapshot's objective weights to target the competitor band. Surfaces rationale + weights in the audit log."
        },
        "ors-elasticity": {
            fn: _orsElasticity,
            label: "ORS elasticity (profit-optimal sweep)",
            description: "Sweep Y multipliers via the ORS demand model and pick the profit-optimal price. Requires a recent ORS scrape per route."
        }
    }

    function list() {
        return Object.keys(PROPOSERS).map(k => ({
            key:         k,
            label:       PROPOSERS[k].label,
            description: PROPOSERS[k].description
        }))
    }

    /**
     * Build shared per-tick context. Called once at the top of a silent-auto
     * tick (or before a single-route dry-run preview); the returned object
     * is threaded into every dispatch() call within the tick.
     *
     * Intent: proposers that need expensive per-tick state (e.g. the strategy
     * snapshot, a bulk ORS cache load) build it here once instead of N
     * times. v1 returns just `{now}`; Phase 3 fills in `strategySnapshot`
     * and `orsCacheByPair` keyed off `arg.strategy`.
     */
    function buildContext(arg) {
        arg = arg || {}
        return {
            now: Date.now(),
            strategy: arg.strategy || "competitor-median"
        }
    }

    /**
     * Dispatch to the named proposer. Returns a uniform skip envelope
     * when the strategy is unknown so the caller can record it in the
     * tick trace without crashing.
     */
    function dispatch(strategy, route, prices, cfg, ctx) {
        const dest = String((route && route.destIata) || "").toUpperCase()
        const key  = strategy || "competitor-median"
        const entry = PROPOSERS[key]
        if (!entry || typeof entry.fn !== "function") {
            return {ok: false, dest, skipReason: "unknown strategy '" + key + "'"}
        }
        try {
            return entry.fn(route, prices, cfg || {}, ctx || {})
        } catch (e) {
            return {ok: false, dest,
                    skipReason: "proposer '" + key + "' threw: " + (e && e.message || String(e))}
        }
    }

    window.RouteAssistantSilentAutoProposers = {
        list,
        dispatch,
        buildContext,
        // Internal — exposed for Phase 3 tests / future strategy registration.
        _proposers: PROPOSERS
    }
})()
