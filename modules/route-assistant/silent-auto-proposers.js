"use strict"

/**
 * Route Assistant — silent-auto proposer registry.
 *
 * Extracts the per-route price proposal logic out of panel.js so new
 * strategies can plug in without touching the loop. The default proposer is
 * `per-class-elasticity`, which prices Y / C / F / Cargo independently; the
 * legacy `competitor-median` Y-only strategy remains available explicitly.
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

    const PRICE_CLASSES = ["Y", "C", "F", "Cargo"]
    const DEFAULT_STRATEGY = "per-class-elasticity"

    function _num(v, fallback) {
        if (v === null || v === undefined || v === "") return fallback
        const n = Number(v)
        return isFinite(n) ? n : fallback
    }

    function _formatPrice(cls, v) {
        const n = Number(v)
        if (!isFinite(n)) return "?"
        return cls === "Cargo" && Math.abs(n) < 10
            ? n.toFixed(2).replace(/\.?0+$/, "")
            : String(Math.round(n))
    }

    function _summarisePriceChanges(prev, next) {
        const out = []
        const p = prev || {}
        const n = next || {}
        for (const cls of PRICE_CLASSES) {
            if (n[cls] == null) continue
            const oldVal = p[cls]
            const newVal = n[cls]
            if (oldVal == null) {
                out.push(cls + " → " + _formatPrice(cls, newVal))
                continue
            }
            const oldNum = Number(oldVal)
            const newNum = Number(newVal)
            const same = cls === "Cargo"
                ? Math.abs(newNum - oldNum) < 0.005
                : Math.round(newNum) === Math.round(oldNum)
            if (same) continue
            out.push(cls + " " + _formatPrice(cls, oldNum) + " → " + _formatPrice(cls, newNum))
        }
        return out
    }

    function _classCap(cfg, cls) {
        const perClass = cfg && cfg.silentAutoPerClassMaxStepPct || {}
        const applyGate = cfg && cfg.applyClassGates && cfg.applyClassGates[cls]
        const candidates = []
        if (perClass[cls] !== null && perClass[cls] !== undefined && perClass[cls] !== "") {
            const v = Number(perClass[cls])
            if (isFinite(v) && v >= 0) candidates.push(v)
        }
        if (applyGate && applyGate.maxMove !== null
                && applyGate.maxMove !== undefined && applyGate.maxMove !== "") {
            const v = Number(applyGate.maxMove)
            if (isFinite(v) && v > 0) candidates.push(v)
        }
        if (candidates.length) return Math.min.apply(null, candidates)
        const global = Number(cfg && cfg.silentAutoMaxStepPct)
        return isFinite(global) && global >= 0 ? global : 10
    }

    function _classEnabled(cfg, cls) {
        const applyGate = cfg && cfg.applyClassGates && cfg.applyClassGates[cls]
        if (applyGate && applyGate.enabled === false) return false
        const perClass = cfg && cfg.silentAutoPerClassEnabled
        if (perClass && Object.prototype.hasOwnProperty.call(perClass, cls)) {
            return perClass[cls] !== false
        }
        return true
    }

    function _roundPriceForClass(cls, current, deltaPct) {
        const raw = current * (1 + deltaPct / 100)
        const scale = cls === "Cargo" && current < 10 ? 100 : 1
        const rounded = deltaPct > 0
            ? Math.floor(raw * scale) / scale
            : deltaPct < 0
                ? Math.ceil(raw * scale) / scale
                : Math.round(raw * scale) / scale
        return Math.max(scale === 1 ? 1 : 1 / scale, rounded)
    }

    function _samePrice(cls, a, b) {
        const tolerance = cls === "Cargo" && Math.min(Math.abs(a), Math.abs(b)) < 10 ? 0.005 : 0.5
        return Math.abs(Number(a) - Number(b)) < tolerance
    }

    function _proposalFromPctMove(cls, mv, prices, cfg) {
        if (!mv) return null
        if (!_classEnabled(cfg, cls)) return null
        const cur = Number(prices && prices[cls])
        if (!isFinite(cur) || cur <= 0) return null
        const fromPct = Number(mv.fromPct)
        const toPct = Number(mv.toPct)
        if (!isFinite(fromPct) || fromPct <= 0 || !isFinite(toPct) || toPct <= 0) return null
        const rawDeltaPct = (toPct / fromPct - 1) * 100
        const minDelta = cfg.silentAutoMinDeltaPct || 3
        if (Math.abs(rawDeltaPct) < minDelta) return null
        const cap = _classCap(cfg, cls)
        const clamped = Math.max(-cap, Math.min(cap, rawDeltaPct))
        const next = _roundPriceForClass(cls, cur, clamped)
        if (_samePrice(cls, next, cur)) return null
        return {
            cls,
            mv,
            current: cur,
            next,
            rawDeltaPct,
            deltaPct: clamped,
            cap
        }
    }

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
        cfg = cfg || {}
        const dest = String(route.destIata || "").toUpperCase()
        if (!_classEnabled(cfg, "Y")) {
            return {ok: false, dest, skipReason: "Y disabled by per-class apply gate"}
        }
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

        const cap = _classCap(cfg, "Y")
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

        const key = (hub ? String(hub).toUpperCase() : "") + "-" + dest
        const moves = ctx.strategyMovesByPair.get(key)
        // Slice E1 — `strategyMovesByPair` is now a Map<pair, {Y,C,F,Cargo}>
        // where each value is the per-class PriceMove (or null). Back-compat
        // shim: if a single PriceMove slipped through (older context build),
        // promote it to a per-class bucket keyed by its own classKey.
        let bucket = moves
        if (moves && moves.classKey) {
            bucket = {Y: null, C: null, F: null, Cargo: null}
            bucket[moves.classKey] = moves
        }

        const classMoves = []
        for (const cls of PRICE_CLASSES) {
            const rec = _proposalFromPctMove(cls, bucket && bucket[cls], prices, cfg || {})
            if (rec) classMoves.push(rec)
        }
        if (!classMoves.length) {
            return {ok: false, dest,
                    skipReason: "no strategy class-move for " + key + " (deadband / objective unmet / no current price)"}
        }
        // Keep Y as the headline when it moved, but do not require it.
        // Cargo-only or premium-cabin-only moves should still flow through.
        const headline = classMoves.find(m => m.cls === "Y") || classMoves[0]
        const nextPrices = {}
        const perClassDeltas = {}
        for (const rec of classMoves) {
            nextPrices[rec.cls] = rec.next
            perClassDeltas[rec.cls] = rec.deltaPct
        }

        // Build the result envelope. Carry strategy rationale + objective
        // forward so the audit modal can render *why* this move was chosen
        // — that's the whole point of using strategy-objective over
        // competitor-median.
        const classBreakdown = Object.keys(perClassDeltas)
            .map(c => c + " " + (perClassDeltas[c] >= 0 ? "+" : "") + perClassDeltas[c].toFixed(1) + "%")
            .join(", ")
        const reasonPieces = ["silent-auto · strategy-objective"]
        if (headline.mv.objective && headline.mv.objective.kind) {
            reasonPieces.push("goal " + headline.mv.objective.kind)
        }
        reasonPieces.push(headline.cls + " "
            + _formatPrice(headline.cls, headline.current) + " → "
            + _formatPrice(headline.cls, headline.next) + " (Δ "
            + headline.deltaPct.toFixed(1) + "%)")
        if (Object.keys(nextPrices).length > 1) {
            reasonPieces.push("classes " + classBreakdown)
        }

        // Combine rationale arrays from every class so the audit log shows
        // why each price moved, not just Y.
        const rationale = []
        for (const cls of PRICE_CLASSES) {
            const mv = bucket[cls]
            if (!mv || !Array.isArray(mv.rationale)) continue
            for (const r of mv.rationale.slice(0, 4)) rationale.push("[" + cls + "] " + r)
        }

        const ourY = Number(prices && prices.Y)
        const prevY = isFinite(ourY) && ourY > 0 ? Math.round(ourY) : null
        const newY = nextPrices.Y != null ? nextPrices.Y : prevY
        return {
            ok:        true,
            dest,
            prices:    nextPrices,
            deltaPct:  headline.deltaPct,
            prevY,
            newY,
            reason:    reasonPieces.join(" · "),
            rationale: rationale.length ? rationale.slice(0, 16) : null,
            objective: (headline.mv.objective) || null,
            perClassDeltas
        }
    }

    // ------------------------------------------------------------------
    // ors-elasticity — adapter over RouteAssistantOrsModel.scanPriceCurve.
    //
    // For each route we call scanPriceCurve(lo:0.7, hi:1.3, step:0.05)
    // which sweeps a passenger price multiplier and returns the
    // profit-optimal multiplier. We pick that multiplier, scale all enabled
    // current price classes, let Cargo use its own demand branch when the
    // per-class proposer is loaded, and re-apply silent-auto's caps. Skips when:
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
        const readiness = fullRoute && fullRoute.orsReadiness
        if (readiness && readiness.usable === false) {
            const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : []
            return {ok: false, dest, skipReason: "ORS not ready"
                + (warnings.length ? ": " + warnings[0] : "")}
        }
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
        const cap = _classCap(cfg || {}, "Y")
        const clamped = Math.max(-cap, Math.min(cap, rawDeltaPct))
        const appliedMultiplier = 1 + clamped / 100
        const nextPrices = {}
        const perClassDeltas = {}
        for (const cls of PRICE_CLASSES) {
            if (!_classEnabled(cfg || {}, cls)) continue
            const current = Number(prices && prices[cls])
            if (isFinite(current) && current > 0) {
                if (cls === "Cargo" && window.RouteAssistantPerClassProposer
                        && typeof window.RouteAssistantPerClassProposer._computeClass === "function") {
                    const cargoMove = window.RouteAssistantPerClassProposer._computeClass(cls, current, fullRoute, cfg || {})
                    if (cargoMove && cargoMove.newPrice != null) {
                        nextPrices[cls] = cargoMove.newPrice
                        perClassDeltas[cls] = cargoMove.deltaPct
                        continue
                    }
                    // No class-specific cargo signal available; fall back to
                    // the ORS multiplier so Cargo still participates instead
                    // of disappearing from mixed-class apply proposals.
                }
                const clsCap = _classCap(cfg || {}, cls)
                const clsClamped = Math.max(-clsCap, Math.min(clsCap, rawDeltaPct))
                const next = _roundPriceForClass(cls, current, clsClamped)
                if (!_samePrice(cls, next, current)) {
                    nextPrices[cls] = next
                    perClassDeltas[cls] = clsClamped
                }
            }
        }
        const headlineCls = nextPrices.Y != null
            ? "Y"
            : Object.keys(nextPrices)[0]
        if (!headlineCls) {
            return {ok: false, dest, skipReason: "after clamp + round, no class changed price"}
        }
        const headlineCurrent = Number(prices && prices[headlineCls])
        const headlineNew = nextPrices[headlineCls]
        const newY = nextPrices.Y != null ? nextPrices.Y : Math.round(ourY)

        const projected = (scan.optimal.deltaProfit != null && isFinite(scan.optimal.deltaProfit))
            ? Math.round(scan.optimal.deltaProfit) : null
        const appliedMultLabel = Math.abs(clamped - rawDeltaPct) > 0.01
            ? ", applied mult " + appliedMultiplier.toFixed(2) : ""
        const reason = "silent-auto · ors-elasticity · " + headlineCls + " "
                     + _formatPrice(headlineCls, headlineCurrent) + " → "
                     + _formatPrice(headlineCls, headlineNew)
                     + " (Δ " + (perClassDeltas[headlineCls] || clamped).toFixed(1) + "%, optimal mult "
                     + scan.optimal.multiplier.toFixed(2)
                     + appliedMultLabel
                     + (projected != null ? ", proj +$" + projected + "/wk" : "")
                     + ")"
        return {
            ok:        true,
            dest,
            prices:    nextPrices,
            deltaPct:  perClassDeltas[headlineCls] || clamped,
            prevY:     Math.round(ourY),
            newY,
            reason,
            rationale: [
                "[ors] curve sweep " + (scan.points ? scan.points.length : "?") + " points · optimal mult "
                    + scan.optimal.multiplier.toFixed(2),
                Object.keys(nextPrices).length > 1
                    ? "[price] applying ORS pax move plus per-class caps to " + Object.keys(nextPrices).join("/")
                    : null,
                projected != null ? "[profit] optimal projects +$" + projected + "/wk" : null,
                "[clamp] silent-auto cap ±" + cap + "% applied · raw Δ " + rawDeltaPct.toFixed(1) + "% → "
                    + clamped.toFixed(1) + "%"
            ].filter(Boolean),
            projectedDelta: (projected != null) ? {profitPerWeek: projected} : null,
            perClassDeltas
        }
    }

    // ------------------------------------------------------------------
    // Registry + dispatch.
    //
    // Registered proposers must conform to the contract above. The order
    // of `list()` is the order shown in the strategy picker; keep the
    // demand-aware Y/C/F/Cargo strategy first because it is the default.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // per-class-elasticity — delegates to RouteAssistantPerClassProposer.
    //
    // Prices Y / C / F / Cargo *independently* using per-class elasticity,
    // demand pool, load factor, and (when available) per-class competitor
    // median. Falls under the same gates + caps as the other proposers; the
    // only structural difference is that the output `prices` map can carry
    // up to four entries instead of just Y. The applier already handles
    // multi-class price maps (see pricing-applier.js FIELD_NAMES.prices).
    //
    // Skips this strategy entirely when the per-class proposer module
    // hasn't loaded — manifest order should keep that from happening, but
    // we degrade gracefully rather than crashing the silent-auto loop.
    // ------------------------------------------------------------------
    function _perClassElasticity(route, prices, cfg, ctx) {
        const dest = String((route && route.destIata) || "").toUpperCase()
        if (typeof window === "undefined" || !window.RouteAssistantPerClassProposer
            || typeof window.RouteAssistantPerClassProposer.propose !== "function") {
            return {ok: false, dest, skipReason: "RouteAssistantPerClassProposer not loaded"}
        }
        return window.RouteAssistantPerClassProposer.propose(route, prices, cfg || {}, ctx || {})
    }

    const PROPOSERS = {
        "per-class-elasticity": {
            fn: _perClassElasticity,
            label: "Per-class elasticity (Y / C / F / Cargo)",
            description: "Price each cabin (and cargo) independently using class-specific elasticity, demand pool, load factor, and per-class competitor median when available. Cargo joins the loop on its own demand curve."
        },
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
            description: "Sweep ORS passenger multipliers and apply the capped profit move to enabled Y / C / F / Cargo prices. Requires a recent ORS scrape per route."
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
            strategy: arg.strategy || DEFAULT_STRATEGY
        }
    }

    /**
     * Compute the worst-of cache age for a route as the silent-auto loop
     * sees it. We look at the strategy snapshot's `cacheAge.maxMs` when
     * present (preferred — reflects the same view the strategy proposers
     * use) and fall back to the route's per-source `scrapedAt` fields the
     * panel populates. Returns null when no age signal exists.
     */
    function _routeMaxCacheAgeMs(route, ctx) {
        const now = (ctx && ctx.now) || Date.now()
        let max = null
        // Prefer the strategy snapshot's pre-computed cacheAge.
        if (ctx && ctx.routesByDest && route && route.destIata) {
            const full = ctx.routesByDest.get(String(route.destIata).toUpperCase())
            if (full && full.cacheAge && isFinite(full.cacheAge.maxMs)) return full.cacheAge.maxMs
        }
        const fields = []
        if (route && route.competitorScrapedAt) fields.push(route.competitorScrapedAt)
        if (route && route.orsScrapedAt)        fields.push(route.orsScrapedAt)
        if (route && route.ownPricingScrapedAt) fields.push(route.ownPricingScrapedAt)
        for (const ts of fields) {
            const age = now - ts
            if (isFinite(age) && (max == null || age > max)) max = age
        }
        return max
    }

    /**
     * Fire-and-forget skip diagnostic. The store is loaded by RA hosts
     * but apply / strategy hosts may not have it; defensively guard.
     */
    function _recordSkip(hub, dest, reason) {
        try {
            if (typeof window === "undefined" || !window.AesPriceDiagnostics) return
            if (typeof window.AesPriceDiagnostics.recordSkip !== "function") return
            window.AesPriceDiagnostics.recordSkip({hub: hub, dest: dest, reason: reason})
        } catch (_) { /* never break dispatch on a diagnostics write */ }
    }

    /**
     * Dispatch to the named proposer. Returns a uniform skip envelope
     * when the strategy is unknown so the caller can record it in the
     * tick trace without crashing.
     *
     * Optional `cfg.silentAutoMaxCacheAgeMin` — when set, routes whose
     * worst-of cache age exceeds the threshold are skipped before the
     * proposer runs. Default unset = legacy behaviour.
     */
    function dispatch(strategy, route, prices, cfg, ctx) {
        const dest = String((route && route.destIata) || "").toUpperCase()
        const hub  = String((route && route.hub) || (ctx && ctx.hub) || "").toUpperCase()
        const key  = strategy || DEFAULT_STRATEGY
        const entry = PROPOSERS[key]
        if (!entry || typeof entry.fn !== "function") {
            const skipReason = "unknown strategy '" + key + "'"
            _recordSkip(hub, dest, skipReason)
            return {ok: false, dest, skipReason}
        }

        // Snapshot freshness gate (opt-in via cfg.silentAutoMaxCacheAgeMin).
        const maxAgeMin = Number(cfg && cfg.silentAutoMaxCacheAgeMin)
        if (isFinite(maxAgeMin) && maxAgeMin > 0) {
            const ageMs = _routeMaxCacheAgeMs(route, ctx)
            if (isFinite(ageMs) && ageMs > maxAgeMin * 60000) {
                const skipReason = "cache stale (>" + maxAgeMin + " min · max="
                                + Math.round(ageMs / 60000) + " min)"
                _recordSkip(hub, dest, skipReason)
                return {ok: false, dest, skipReason}
            }
        }

        let result
        try {
            result = entry.fn(route, prices, cfg || {}, ctx || {})
        } catch (e) {
            const skipReason = "proposer '" + key + "' threw: " + (e && e.message || String(e))
            _recordSkip(hub, dest, skipReason)
            return {ok: false, dest, skipReason}
        }
        if (result && result.ok === false && result.skipReason) {
            _recordSkip(hub, dest, result.skipReason)
        }
        return result
    }

    /**
     * Schedule Canvas hook — runs `dispatch()` and, on a positive proposal,
     * also emits a `canvas:advisor-suggestion` so the rail surfaces the
     * proposer's intent instead of the silent loop applying it
     * blindly. The Advisor card's primary action stages an `applyPricing`
     * edit; the user commits it via the rail footer (which honors the
     * pricing.apply gates the same way silent-auto does).
     *
     * Caller still receives the proposer's result object — the surface
     * decision is purely additive. Existing silent-loop callers can keep
     * using `dispatch()` directly when they don't want the user-visible
     * card.
     *
     * @param {string} strategy
     * @param {object} route
     * @param {object} prices
     * @param {object} cfg
     * @param {object} ctx
     * @returns {object} same envelope as dispatch()
     */
    function surface(strategy, route, prices, cfg, ctx) {
        const result = dispatch(strategy, route, prices, cfg, ctx)
        if (!result || result.ok !== true) return result
        if (typeof window === "undefined" || !window.CentralHubBus || !window.AesCanvasEvents) {
            return result
        }
        const hub  = String((route && route.hub) || (ctx && ctx.hub) || "").toUpperCase()
        const dest = String(result.dest || (route && route.destIata) || "").toUpperCase()
        if (!hub || !dest) return result
        const changes = _summarisePriceChanges(prices, result.prices)
        const changeText = changes.length ? changes.join(", ") : "no price change"
        const deltaPct = isFinite(result.deltaPct) ? Number(result.deltaPct).toFixed(1) : null
        const reason = result.reason || strategy
        const message = "Auto-proposer (" + (strategy || "?") + ") suggests "
            + changeText
            + " for " + hub + " · " + dest
            + (deltaPct != null ? " (Δ " + deltaPct + "%)" : "")
            + (reason && reason !== strategy ? ". " + reason : ".")
        const suggestionId = "s-prop-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5)
        // Emit. Advisor card's Apply button stages an applyPricing edit
        // carrying the new prices + rationale; the canvas commit-bar will
        // route that through RouteAssistantPricingApplier.apply().
        window.CentralHubBus.emit(window.AesCanvasEvents.ADVISOR_SUGGESTION, {
            id:        suggestionId,
            kind:      "auto-proposer",
            severity:  "info",
            // dedupe per (strategy, route) so dismissing a proposer's
            // recommendation suppresses repeats for an hour.
            dedupeKey: "auto-proposer:" + (strategy || "?") + ":" + hub + "-" + dest,
            signature: hub + "-" + dest + ":" + (strategy || "?"),
            message,
            action: {
                label: "Apply price changes",
                run:   () => {
                    if (typeof window === "undefined" || !window.CentralHubBus) return
                    window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_STAGED, {
                        kind:    "applyPricing",
                        payload: {
                            hub,
                            dest,
                            prices:           result.prices || {},
                            source:           "silent-auto",
                            reason:           reason,
                            proposerStrategy: strategy,
                            rationale:        Array.isArray(result.rationale)
                                                ? result.rationale.slice(0, 12)
                                                : null,
                            projectedDelta:   result.projectedDelta || null
                        }
                    })
                }
            }
        })
        return result
    }

    window.RouteAssistantSilentAutoProposers = {
        list,
        dispatch,
        surface,
        buildContext,
        // Internal — exposed for Phase 3 tests / future strategy registration.
        _proposers: PROPOSERS
    }
})()
