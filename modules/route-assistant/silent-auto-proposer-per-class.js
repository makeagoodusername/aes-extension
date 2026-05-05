"use strict"

/**
 * Silent-auto proposer — per-class elasticity (Y / C / F / Cargo).
 *
 * Why this exists. The legacy `ors-elasticity` proposer is still anchored to
 * a single passenger multiplier returned from a one-axis sweep. That works
 * when the three passenger classes track each other (which they often do not
 * — F load is much more volatile than Y, and cargo is its own demand curve
 * entirely). This proposer prices each enabled class independently using
 * data the demand-derivator + ORS pipeline already produce per-class.
 *
 * Inputs read off the route record (the silent-auto loop populates these
 * from market historics + inventory + own pricing + ORS via the existing
 * pipeline; see central-price-automator.js _deriveDemandControl):
 *
 *   prices.{Y,C,F,Cargo}        — current per-class prices (passed in)
 *   route.paxElasticity         — log-log slope from historic series, ≤ 0
 *   route.cargoElasticity       — same, for cargo only
 *   route.paxDemandPool         — avg bookings/wk over the analysis window
 *   route.cargoDemandPool       — same, cargo
 *   route.rmTightness           — sold seats / total seats forward (0..1)
 *   route.competitorPricesByClass{Y,C,F,Cargo}? — optional median per class
 *
 * Per-class signals (combined linearly, then capped):
 *
 *   loadSignal     ((rmTightness − 0.65) × 30)%    — push up when full,
 *                                                    push down when empty.
 *                                                    Zero at 65% LF.
 *   elasticityScale 1 / (1 + |ε|)                  — attenuate move when
 *                                                    demand is elastic
 *                                                    (customers run away
 *                                                    from price hikes fast
 *                                                    when |ε| is large).
 *   competitorTow   (compMedian − current) / current  — pull towards the
 *                                                    competitor median for
 *                                                    that class when
 *                                                    available; weighted
 *                                                    50/50 with the
 *                                                    elasticity signal.
 *
 *   rawDeltaPct = elasticityScale × loadSignal
 *               (then 0.5 × rawDeltaPct + 0.5 × competitorTow when comp present)
 *
 * Skips for safety:
 *   - class disabled in cfg.silentAutoPerClassEnabled
 *   - no current price for that class
 *   - demand pool below cfg.silentAutoPerClassMinDemandPool[cls]
 *   - |Δ%| < cfg.silentAutoMinDeltaPct (proposer noise floor — same as
 *                                       the other proposers)
 *   - after step cap + round, newPrice == currentPrice
 *
 * Output (ProposalResult — same envelope as the other proposers):
 *   {ok: true, prices: {Y?,C?,F?,Cargo?}, deltaPct, prevY, newY,
 *    reason, rationale[], projectedDelta?}
 *
 * Pure — no I/O, no Chrome, no storage. Same purity contract as
 * silent-auto-proposers.js and ors-model.js.
 *
 * The headline `deltaPct/prevY/newY` mirror the Y move so the audit log,
 * advisor card, and dedup fingerprint behave identically to the existing
 * proposers; the per-class details land in `rationale` + `prices`.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.RouteAssistantPerClassProposer) return

    /** Class order defines iteration + headline fallback ordering. */
    const CLASSES = ["Y", "C", "F", "Cargo"]

    /** Default per-class minimum demand pool (bookings/wk for pax;
     *  units/wk for cargo). Routes with thinner demand can't be priced
     *  reliably from elasticity — too few historic data points. */
    const DEFAULT_MIN_DEMAND = {Y: 50, C: 10, F: 5, Cargo: 1000}

    /** Default per-class enable. Cargo defaults ON because the whole point
     *  of this proposer is to cover cargo — but the user can disable any
     *  class via settings.pricing.silentAutoPerClassEnabled. */
    const DEFAULT_ENABLED = {Y: true, C: true, F: true, Cargo: true}

    function _finiteNumber(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
    }

    /** Load-factor anchor — at this LF, no movement signal. The 65%
     *  number matches the AS Route Assistant's "healthy" cohesion target
     *  (see settings-store.js scoring weights). */
    const LF_ANCHOR = 0.65

    /** Maps a load factor to a pct-delta target. Coefficient sized so that
     *  after elasticity attenuation (typically ~0.4 for ε=-1.5) the signal
     *  clears the default 3% noise floor at LF≥0.80. The silentAuto step
     *  cap (default 10%) then clamps it back down to the per-class user
     *  limit, so the formula says "lean hard" without actually moving
     *  hard. Below LF_ANCHOR (0.65) the sign flips — empty seats push
     *  prices down. */
    function _loadSignal(rmTightness) {
        const numeric = _finiteNumber(rmTightness)
        if (numeric == null) return 0
        const t = Math.max(0, Math.min(1, numeric))
        return (t - LF_ANCHOR) * 80
    }

    /** Elasticity attenuator. ε=0 → 1.0 (no attenuation), ε=-1 → 0.5,
     *  ε=-3 → 0.25. Always finite + positive. Handles missing/zero/positive
     *  ε with a conservative 0.5 fallback. */
    function _elasticityScale(elasticity) {
        const numeric = _finiteNumber(elasticity)
        if (numeric == null || numeric >= 0) return 0.5
        return 1 / (1 + Math.abs(numeric))
    }

    /** Pick the right elasticity per class. Order:
     *    1. ratingPriceElasticityByClass[cls] — per-class rating regression
     *    2. paxElasticity (Y/C/F) or cargoElasticity (Cargo)
     *    3. -1.2 fallback (mild elastic — safe default)
     */
    function _classElasticity(cls, route) {
        const priceByClass = route && route.priceElasticityByClass
        if (priceByClass && typeof priceByClass === "object") {
            const v = _finiteNumber(priceByClass[cls])
            if (v != null && v < 0) return v
        }
        const legacyByClass = route && route.classElasticityByClass
        if (legacyByClass && typeof legacyByClass === "object") {
            const v = _finiteNumber(legacyByClass[cls])
            if (v != null && v < 0) return v
        }
        const byClass = route && route.ratingPriceElasticityByClass
        if (byClass && cls !== "Cargo") {
            const v = _finiteNumber(byClass[cls])
            if (v != null && v < 0) return v
            if (v != null && v > 0) return -v
        }
        if (cls === "Cargo") {
            const v = _finiteNumber(route && route.cargoElasticity)
            if (v != null && v < 0) return v
        } else {
            const v = _finiteNumber(route && route.paxElasticity)
            if (v != null && v < 0) return v
        }
        return -1.2
    }

    /** Pick the right demand pool per class. Cargo uses cargoDemandPool;
     *  passenger classes share paxDemandPool (we don't have a per-class
     *  pax pool from AS — the historic chart aggregates Y/C/F). Returns
     *  null when missing. */
    function _classDemandPool(cls, route) {
        const byClass = route && route.demandPoolByClass
        if (byClass && typeof byClass === "object") {
            const v = _finiteNumber(byClass[cls])
            if (v != null) return v
        }
        if (cls === "Cargo") {
            return _finiteNumber(route && route.cargoDemandPool)
        }
        return _finiteNumber(route && route.paxDemandPool)
    }

    function _classRmTightness(cls, route) {
        const byClass = route && route.rmTightnessByClass
        if (byClass && typeof byClass === "object") {
            const v = _finiteNumber(byClass[cls])
            if (v != null) return v
        }
        return _finiteNumber(route && route.rmTightness)
    }

    /** Pick the per-class competitor median when available. The
     *  competitor scraper currently only writes a single median Y in some
     *  data shapes; a richer per-class shape may be present (Slice K
     *  introduced byClass in markets-page-scraper). Defensive lookup. */
    function _classCompetitorMedian(cls, route) {
        let market = null
        const byCls = route && route.competitorPricesByClass
        if (byCls && typeof byCls === "object") {
            const v = _finiteNumber(byCls[cls])
            if (v != null && v > 0) market = v
        }
        if (market == null && cls === "Y") {
            const v = _finiteNumber(route && route.competitorMedianPriceY)
            if (v != null && v > 0) market = v
        }
        const orsByCls = route && route.orsCompetitorPricesByClass
        let ors = null
        if (orsByCls && typeof orsByCls === "object") {
            const v = _finiteNumber(orsByCls[cls])
            if (v != null && v > 0) ors = v
        }
        if (market != null && ors != null) {
            const blended = market * 0.6 + ors * 0.4
            return cls === "Cargo" && Math.abs(blended) < 10
                ? Math.round(blended * 100) / 100
                : Math.round(blended)
        }
        return market != null ? market : ors
    }

    function _classCompetitorCount(cls, route) {
        let market = null
        const byCls = route && route.competitorCountsByClass
        if (byCls && typeof byCls === "object") {
            const v = _finiteNumber(byCls[cls])
            if (v != null && v >= 0) market = v
        }
        if (market == null && cls === "Y") {
            const y = _finiteNumber(route && route.competitorYsCount)
            if (y != null && y >= 0) market = y
        }
        const orsByCls = route && route.orsCompetitorCountsByClass
        let ors = null
        if (orsByCls && typeof orsByCls === "object") {
            const v = _finiteNumber(orsByCls[cls])
            if (v != null && v >= 0) ors = v
        }
        if (market != null || ors != null) return Math.max(market || 0, ors || 0)
        const legacy = _finiteNumber(route && route.competitorCount)
        return legacy != null && legacy >= 0 ? legacy : 0
    }

    function _buildOrsPricingIndex(route) {
        if (!route || route.orsPricingIndex) return route && route.orsPricingIndex || null
        if (!route.orsByClass || typeof route.orsByClass !== "object") return null
        if (typeof window === "undefined") return null
        const rec = {
            hub: route.hub,
            dest: route.destIata || route.dest,
            byClass: route.orsByClass
        }
        const currentPrices = route.ownPricing && route.ownPricing.prices || {}
        const opts = {
            currentPrices,
            rankTarget: route.orsTargetRank || 3
        }
        try {
            if (window.RouteAssistantOrsPriceIndex
                    && typeof window.RouteAssistantOrsPriceIndex.indexRecord === "function") {
                return window.RouteAssistantOrsPriceIndex.indexRecord(rec, opts)
            }
        } catch (_) {
            return null
        }
        try {
            if (window.RouteAssistantOrsScraper
                    && typeof window.RouteAssistantOrsScraper.buildPricingIndex === "function") {
                return window.RouteAssistantOrsScraper.buildPricingIndex(rec, opts)
            }
        } catch (_) {
            return null
        }
        return null
    }

    function _classOrsSignal(cls, route) {
        const explicit = route && route.orsPressureByClass
        if (explicit && typeof explicit === "object") {
            const v = _finiteNumber(explicit[cls])
            if (v != null) {
                const idx = route && route.orsPricingIndex
                const c = idx && idx.classes && idx.classes[cls] || {}
                return {
                    deltaPct: v,
                    rankAny: c.rankAny,
                    ratingGapToTop: c.ratingGapToTop,
                    source: "ors-index"
                }
            }
        }
        const idx = _buildOrsPricingIndex(route)
        const c = idx && idx.classes && idx.classes[cls]
        const v = _finiteNumber(c && c.pressurePct)
        if (v == null) return null
        return {
            deltaPct: v,
            rankAny: c.rankAny,
            ratingGapToTop: c.ratingGapToTop,
            source: "ors-index"
        }
    }

    /** Marginal-cost floor expressed as an absolute price for this class.
     *  The strategy engine produces a pct-of-reference floor; the central
     *  automator may have already converted it to an absolute via the
     *  current price. We accept either shape:
     *
     *    route.marginalCostFloorByClass[cls]   — absolute price (preferred)
     *    route.marginalCostFloorPctByClass[cls]— pct of currentPrice
     *
     *  Returns the absolute floor in current-price units, or null when the
     *  data is missing. Safety: never let a derived floor exceed the
     *  current price by more than 50% (avoids a stale floor lock-out).
     */
    function _classCostFloor(cls, current, route) {
        const abs = route && route.marginalCostFloorByClass
        if (abs && typeof abs === "object") {
            const v = _finiteNumber(abs[cls])
            if (v != null && v > 0) return Math.min(v, current * 1.5)
        }
        const pct = route && route.marginalCostFloorPctByClass
        if (pct && typeof pct === "object") {
            const p = _finiteNumber(pct[cls])
            if (p != null && p > 0 && isFinite(current) && current > 0) {
                const floor = (current * p) / 100
                return Math.min(floor, current * 1.5)
            }
        }
        return null
    }

    /** Default cap for a class — falls back to silentAutoMaxStepPct. */
    function _classCap(cls, cfg) {
        const map = (cfg && cfg.silentAutoPerClassMaxStepPct) || {}
        const applyGate = cfg && cfg.applyClassGates && cfg.applyClassGates[cls]
        const caps = []
        if (map[cls] === null || map[cls] === undefined || map[cls] === "") {
            // inherit global below
        } else {
            const v = Number(map[cls])
            if (isFinite(v) && v >= 0) caps.push(v)
        }
        if (applyGate && applyGate.maxMove !== null
                && applyGate.maxMove !== undefined && applyGate.maxMove !== "") {
            const v = Number(applyGate.maxMove)
            if (isFinite(v) && v > 0) caps.push(v)
        }
        if (caps.length) return Math.min.apply(null, caps)
        const global = Number(cfg && cfg.silentAutoMaxStepPct)
        if (isFinite(global) && global >= 0) return global
        return 10
    }

    /** Default min-demand for a class. */
    function _classMinDemand(cls, cfg) {
        const map = (cfg && cfg.silentAutoPerClassMinDemandPool) || {}
        if (map[cls] === null || map[cls] === undefined || map[cls] === "") {
            return DEFAULT_MIN_DEMAND[cls] != null ? DEFAULT_MIN_DEMAND[cls] : 0
        }
        const v = Number(map[cls])
        if (isFinite(v) && v >= 0) return v
        return DEFAULT_MIN_DEMAND[cls] != null ? DEFAULT_MIN_DEMAND[cls] : 0
    }

    /** Whether a class is enabled by config.
     *
     *  Two settings keys can disable a class — either disables it:
     *    1. `silentAutoPerClassEnabled.<cls>` — proposer-local toggle
     *    2. `applyClassGates.<cls>.enabled` — global per-class apply gate
     *       (read from `pricing.apply.classes.<cls>.enabled`)
     *
     *  Defense-in-depth: a class disabled at the apply layer should never
     *  be moved by this proposer. The settings UI exposes both knobs; this
     *  function is the single ground truth queried by the dispatch loop.
     */
    function _classEnabled(cls, cfg) {
        const applyGate = cfg && cfg.applyClassGates && cfg.applyClassGates[cls]
        if (applyGate && applyGate.enabled === false) return false
        const map = (cfg && cfg.silentAutoPerClassEnabled) || {}
        if (cls in map) return map[cls] !== false
        return DEFAULT_ENABLED[cls]
    }

    function _formatPrice(v) {
        if (_finiteNumber(v) == null) return "?"
        return Math.abs(v) < 10 ? Number(v).toFixed(2).replace(/\.?0+$/, "") : String(Math.round(v))
    }

    function _roundPriceForClass(cls, current, deltaPct) {
        const raw = current * (1 + deltaPct / 100)
        const scale = cls === "Cargo" && current < 10 ? 100 : 1
        let rounded
        if (deltaPct > 0) {
            rounded = Math.floor(raw * scale) / scale
        } else if (deltaPct < 0) {
            rounded = Math.ceil(raw * scale) / scale
        } else {
            rounded = Math.round(raw * scale) / scale
        }
        const minPrice = scale === 1 ? 1 : 1 / scale
        return Math.max(minPrice, rounded)
    }

    /**
     * Compute one class's proposed price + a one-line rationale.
     * Returns {newPrice|null, deltaPct, rationale, skipReason}.
     */
    function _computeClass(cls, current, route, cfg) {
        if (!isFinite(current) || current <= 0) {
            return {newPrice: null, deltaPct: 0, rationale: null, skipReason: "no current price"}
        }
        let elasticity = _classElasticity(cls, route)
        const demandPool = _classDemandPool(cls, route)
        const minDemand  = _classMinDemand(cls, cfg)
        if (demandPool != null && demandPool <= minDemand) {
            return {newPrice: null, deltaPct: 0, rationale: null,
                    skipReason: "demand pool " + Math.round(demandPool)
                              + " <= min " + minDemand + " (thin data — unreliable)"}
        }

        // Competition-aware adjustment: scale elasticity by tier (monopoly =
        // less price-sensitive, saturated = more). Adjuster module is loaded
        // after this proposer in the manifest, so we look up at call time.
        let competitionWeights = null
        if (typeof window !== "undefined" && window.RouteAssistantOrsCompetitionAdjuster
                && typeof window.RouteAssistantOrsCompetitionAdjuster.adjust === "function") {
            competitionWeights = window.RouteAssistantOrsCompetitionAdjuster.adjust({
                competitorCount: _classCompetitorCount(cls, route),
                classKey:        cls,
                hub:             route && route.hub,
                dest:            route && route.destIata,
                settings:        cfg && cfg.orsCompetition,
                route:           route
            })
            elasticity = window.RouteAssistantOrsCompetitionAdjuster
                .applyElasticityScale(elasticity, competitionWeights)
        }

        // Signal 1: load-factor pressure scaled by class elasticity.
        const eScale  = _elasticityScale(elasticity)
        const rmTightness = _classRmTightness(cls, route)
        const loadDelta = _loadSignal(rmTightness)
        let rawDelta = eScale * loadDelta

        // Signal 2: competitor pull. Weighted 50/50 with the elasticity
        // signal when present.
        const comp = _classCompetitorMedian(cls, route)
        let usedCompetitor = false
        if (comp != null) {
            const compDelta = ((comp - current) / current) * 100
            rawDelta = 0.5 * rawDelta + 0.5 * compDelta
            usedCompetitor = true
        }

        // Signal 3: ORS search pressure. The index converts actual ORS
        // rank/rating gap into a conservative price pressure: weak ORS pulls
        // price down, strong ORS permits a measured lift.
        const orsSignal = _classOrsSignal(cls, route)
        let usedOrs = false
        if (orsSignal && _finiteNumber(orsSignal.deltaPct) != null) {
            const orsDelta = _finiteNumber(orsSignal.deltaPct)
            rawDelta = usedCompetitor
                ? 0.75 * rawDelta + 0.25 * orsDelta
                : 0.65 * rawDelta + 0.35 * orsDelta
            usedOrs = true
        }

        const minDelta = Number(cfg && cfg.silentAutoMinDeltaPct)
        const minD = isFinite(minDelta) && minDelta >= 0 ? minDelta : 3
        if (Math.abs(rawDelta) + 1e-9 < minD) {
            return {newPrice: null, deltaPct: rawDelta, rationale: null,
                    skipReason: "|Δ%| " + rawDelta.toFixed(1) + " < min " + minD + "% (noise floor)"}
        }

        const cap = _classCap(cls, cfg)
        let clamped = Math.max(-cap, Math.min(cap, rawDelta))
        let newPrice = _roundPriceForClass(cls, current, clamped)

        // Marginal-cost floor: never let a downward move price below the
        // class's cost floor (when known). Re-derives delta from the
        // floored price so the rationale + clamped value stay consistent.
        const floor = _classCostFloor(cls, current, route)
        let flooredAtCost = false
        if (floor != null && newPrice < floor) {
            newPrice = _roundPriceForClass(cls, floor, 0)
            if (newPrice < floor) newPrice = floor
            clamped = ((newPrice - current) / current) * 100
            flooredAtCost = true
        }

        const sameAsCurrent = Math.abs(newPrice - current) < (cls === "Cargo" && current < 10 ? 0.005 : 0.5)
        if (sameAsCurrent) {
            return {newPrice: null, deltaPct: clamped, rationale: null,
                    skipReason: flooredAtCost ? "cost-floor pinned to current" : "after clamp + round, no change"}
        }

        const eNum = _finiteNumber(elasticity)
        const rmNum = _finiteNumber(rmTightness)
        const tierTag = competitionWeights
            ? ", " + competitionWeights.classification + " (×" + competitionWeights.priceElasticityScale.toFixed(2) + ")"
            : ""
        const rationale =
            "[" + cls + "] " + _formatPrice(current) + "→" + _formatPrice(newPrice) +
            " (Δ " + clamped.toFixed(1) + "%" +
            ", ε " + (eNum != null ? eNum.toFixed(2) : "?") +
            ", LF " + (rmNum != null ? Math.round(rmNum * 100) + "%" : "?") +
            (usedCompetitor ? ", comp $" + _formatPrice(comp) : "") +
            (usedOrs ? ", ORS Δ " + _finiteNumber(orsSignal.deltaPct).toFixed(1) + "%" : "") +
            (flooredAtCost ? ", floor $" + _formatPrice(floor) : "") +
            tierTag +
            ", cap ±" + cap + "%)"
        return {newPrice, deltaPct: clamped, rationale, skipReason: null}
    }

    /**
     * Main proposer. Conforms to the silent-auto-proposers.js contract:
     *   inputs:  route, prices, cfg, ctx
     *   output:  {ok, dest, prices, deltaPct, prevY, newY, reason, rationale}
     */
    function propose(route, prices, cfg, ctx) {
        const dest = String((route && route.destIata) || "").toUpperCase()
        const fullRoute = (ctx && ctx.routesByDest && ctx.routesByDest.get(dest)) || route || {}
        const proposed = {}
        const rationale = []
        const skips = []

        for (const cls of CLASSES) {
            if (!_classEnabled(cls, cfg)) {
                skips.push("[" + cls + "] disabled by per-class config")
                continue
            }
            const current = prices && Number(prices[cls])
            const r = _computeClass(cls, current, fullRoute, cfg)
            if (r.newPrice == null) {
                if (r.skipReason) skips.push("[" + cls + "] " + r.skipReason)
                continue
            }
            proposed[cls] = r.newPrice
            if (r.rationale) rationale.push(r.rationale)
        }

        if (Object.keys(proposed).length === 0) {
            return {ok: false, dest,
                    skipReason: "no class produced a move (" + (skips[0] || "all classes skipped") + ")"}
        }

        // Headline mirrors Y when present (audit log + dedup fingerprint
        // care about Y); otherwise pick the first proposed class.
        const ourY = prices && Number(prices.Y)
        const headlineCls = proposed.Y != null ? "Y" : Object.keys(proposed)[0]
        const headlineCurrent = headlineCls === "Y" ? ourY : Number(prices && prices[headlineCls])
        const headlineNew = proposed[headlineCls]
        const headlineDelta = (isFinite(headlineCurrent) && headlineCurrent > 0)
            ? ((headlineNew - headlineCurrent) / headlineCurrent) * 100
            : 0

        const reasonClasses = Object.keys(proposed).join("/")
        return {
            ok:        true,
            dest,
            prices:    proposed,
            deltaPct:  headlineDelta,
            prevY:     isFinite(ourY) ? Math.round(ourY) : null,
            newY:      proposed.Y != null ? proposed.Y : (isFinite(ourY) ? Math.round(ourY) : null),
            reason:    "silent-auto · per-class · " + reasonClasses + " · " + headlineCls + " " +
                       _formatPrice(headlineCurrent) + "→" + _formatPrice(headlineNew) + " (Δ " + headlineDelta.toFixed(1) + "%)",
            rationale: rationale.concat(skips).slice(0, 16)
        }
    }

    window.RouteAssistantPerClassProposer = {
        propose,
        // Internal — exposed for unit tests + future composability.
        _computeClass,
        _classElasticity,
        _classDemandPool,
        _classRmTightness,
        _classCompetitorMedian,
        _classCompetitorCount,
        _classOrsSignal,
        _classCostFloor,
        _roundPriceForClass,
        _finiteNumber,
        _loadSignal,
        _elasticityScale,
        DEFAULT_MIN_DEMAND,
        DEFAULT_ENABLED,
        LF_ANCHOR,
        CLASSES
    }
})()
