/**
 * Composite deal scoring + Steal/Great/Good/Fair/Pass classification.
 *
 * Replaces the relative "normalize within visible set" scoring in
 * results-table.js (`_scoreRows`) for callers that want absolute deal
 * judgement — the score for the same offer should be the same whether the
 * user is looking at the panel right after a scan or at a CSV from last week.
 *
 * Per-type historical percentiles (from MarketScanPriceHistory) anchor the
 * primary signals. When a typeId has too few historical samples, the
 * classifier falls back to within-scan percentile so cold-start users still
 * get useful relative scores instead of a flat blank field.
 *
 * The blend (default weights — fully user-tunable via presets-store
 * `classifierWeights`):
 *   pricePerSeat    — historical percentile  (35%)
 *   seatKmYearCost  — historical percentile  (15%)
 *   fuelEfficiency  — fuel $/seat-km %ile    (20%)
 *   condition       — conditionPct ÷ 100     (10%)
 *   age             — (LIFE − age) ÷ LIFE    (10%)
 *   expiry          — urgency curve          ( 5%)
 *   fleetSynergy    — binary bonus           ( 5%)
 *   routeFit        — fitCount ÷ total       (10%)
 *
 * pricePerSeat reads `row.priceBasis` ("lease" | "purchase") from
 * MarketScanDealMetrics.decorate to pick the right percentile bucket —
 * lease offers are scored against the lease history of the same typeId,
 * not mixed with purchase prices (apples vs oranges otherwise).
 *
 * Each component contributes (norm × weight) to the score and (weight) to
 * the divisor only when its inputs were available — so a row missing
 * routeFit context isn't penalised, the score just renormalises across the
 * components that did produce a value.
 *
 * Deal-class buckets layer on top of the composite. Steal needs both a high
 * score AND specific hard floors (cheap on history, decent condition, not
 * geriatric). Pass is forced for deal-breakers (very poor condition or near
 * design-life retirement) regardless of how the blend would have ranked it.
 */
class MarketScanDealClassifier {
    // Single source of truth for deal-class metadata. Filter chips, badges,
    // and best-case cards all read from here so a colour or label change
    // flows everywhere automatically. `filterable` excludes Pass from the
    // chip bar (showing "only Pass" deals isn't a useful filter).
    static CLASSES = [
        {key: "steal", label: "Steal", color: "#B8472A", filterable: true},
        {key: "great", label: "Great", color: "#2F5F3F", filterable: true},
        {key: "good",  label: "Good",  color: "#3656A8", filterable: true},
        {key: "fair",  label: "Fair",  color: "#B8861F", filterable: true},
        {key: "pass",  label: "Pass",  color: "#7A6F66", filterable: false}
    ]

    static classMeta(key) {
        return MarketScanDealClassifier.CLASSES.find(c => c.key === key) || null
    }

    /**
     * Mode-specific default weight bundles. The two bundles share the same
     * keys, but the lease bundle pushes more weight onto operational signals
     * (fuel, route fit) since the lease-vs-buy decision flattens out the
     * upfront-cost dimension. Both bundles are normalised by the classifier
     * (weights are relative shares) so absolute numbers don't have to match.
     */
    static MODE_WEIGHTS = {
        buy: {
            pricePerSeat:   35,
            seatKmYearCost: 15,
            fuelEfficiency: 20,
            condition:      10,
            age:            10,
            expiry:          5,
            fleetSynergy:    5,
            routeFit:       10
        },
        lease: {
            pricePerSeat:   30,
            seatKmYearCost: 10,
            fuelEfficiency: 25,
            condition:      10,
            age:             5,
            expiry:          5,
            fleetSynergy:    5,
            routeFit:       20
        }
    }
    // Back-compat: existing callers reading DEFAULT_WEIGHTS get the buy
    // bundle (which is the pre-rework set).
    static DEFAULT_WEIGHTS = MarketScanDealClassifier.MODE_WEIGHTS.buy

    static DEFAULT_ENABLED = {
        pricePerSeat: true, seatKmYearCost: true, fuelEfficiency: true,
        condition: true, age: true, expiry: true, fleetSynergy: true, routeFit: true
    }

    static MAX_LIFE_YEARS = 25
    static EXPIRY_HARD_HOURS = 6
    static EXPIRY_SOFT_DAYS = 7

    /** Valid scoring modes. */
    static MODES = {LEASE: "lease", BUY: "buy"}

    /**
     * Coerce a raw mode value to a known mode. Unknown / undefined values
     * collapse to `fallback` (default "lease" — the scanner's primary use
     * case is finding planes to lease).
     */
    static normalizeMode(m, fallback) {
        if (m === "lease" || m === "buy") return m
        return fallback === "buy" ? "buy" : "lease"
    }

    /**
     * Resolve the active mode from constructor opts. Explicit `opts.mode`
     * wins; otherwise read `leaseConfig.mode`. Anything else collapses to
     * "buy" — back-compat for pre-rework callers that don't pass a mode.
     */
    static _resolveMode(opts) {
        const m = opts && (opts.mode || (opts.leaseConfig && opts.leaseConfig.mode))
        return MarketScanDealClassifier.normalizeMode(m, "buy")
    }

    constructor(opts) {
        opts = opts || {}
        this.histories       = opts.histories || new Map()
        this.withinScanByType = opts.withinScanByType || new Map()
        this.mode            = MarketScanDealClassifier._resolveMode(opts)
        const baseWeights    = MarketScanDealClassifier.MODE_WEIGHTS[this.mode]
        this.weights         = Object.assign({}, baseWeights, opts.weights || {})
        this.enabled         = Object.assign({},
            MarketScanDealClassifier.DEFAULT_ENABLED, opts.enabled || {})
        this.leaseConfig     = opts.leaseConfig || null
    }

    _isEnabled(field) {
        return this.enabled[field] !== false
    }

    /**
     * Builds a classifier ready to score `rows`. Loads per-type histories
     * for every typeId in the input set in one storage call, and computes
     * within-scan distributions as a fallback for cold-start typeIds.
     *
     * Rows must already be decorated by MarketScanDealMetrics.decorate so
     * fleet synergy / route fit signals are present on the row. The
     * classifier reads those decorated fields rather than re-resolving.
     */
    static async build(server, rows, opts) {
        opts = opts || {}
        const typeIds = []
        const seen = new Set()
        for (const r of rows) {
            if (!r || !r.typeId) continue
            if (seen.has(r.typeId)) continue
            seen.add(r.typeId)
            typeIds.push(r.typeId)
        }
        const histories = await MarketScanPriceHistory.loadForTypes(server, typeIds)
        const withinScanByType = MarketScanDealClassifier._bucketByType(rows)
        return new MarketScanDealClassifier({
            histories:        histories,
            withinScanByType: withinScanByType,
            mode:             opts.mode,
            weights:          opts.weights,
            enabled:          opts.enabled,
            leaseConfig:      opts.leaseConfig
        })
    }

    static _bucketByType(rows) {
        const byType = new Map()
        for (const r of rows) {
            if (!r || !r.typeId) continue
            if (!byType.has(r.typeId)) {
                byType.set(r.typeId, {ppsLease: [], ppsPurchase: [], skm: [], fuel: []})
            }
            const slot = byType.get(r.typeId)
            const pps = Number(r.pricePerSeat)
            if (isFinite(pps) && pps > 0) {
                if (r.priceBasis === "lease") slot.ppsLease.push(pps)
                else                          slot.ppsPurchase.push(pps)
            }
            const skm = Number(r.seatKmYearCost)
            if (isFinite(skm) && skm > 0) slot.skm.push(skm)
            const fuel = Number(r.fuelPerSeatKm)
            if (isFinite(fuel) && fuel > 0) slot.fuel.push(fuel)
        }
        return byType
    }

    /**
     * Returns {percentile, source} where source is "history" (sample-rich
     * historical record) or "within-scan" (cold-start fallback) or null
     * when neither has enough samples to call.
     *
     * For pricePerSeat the lookup is basis-scoped: lease rows are scored
     * against history entries also stored at lease basis, purchase against
     * purchase. Legacy entries with no priceBasis tag are treated as
     * "purchase" (matches the pre-rework world). For fuelPerSeatKm and
     * seatKmYearCost the basis filter does not apply — the metrics are
     * basis-independent.
     */
    _percentile(typeId, field, value, basis) {
        const v = Number(value)
        if (!isFinite(v)) return {percentile: null, source: null}
        const fallbackKey = field === "pricePerSeat" ? (basis === "lease" ? "ppsLease" : "ppsPurchase")
                          : field === "fuelPerSeatKm" ? "fuel"
                          : "skm"
        const hist = this.histories.get(typeId)
        if (hist) {
            const filtered = field === "pricePerSeat"
                ? hist.filter(e => (e && (e.priceBasis || "purchase")) === (basis || "purchase"))
                : hist
            const p = MarketScanPriceHistory.percentile(filtered, field, v)
            if (p !== null) return {percentile: p, source: "history"}
        }
        const fallback = this.withinScanByType.get(typeId)
        if (fallback && fallback[fallbackKey] && fallback[fallbackKey].length >= 4) {
            let below = 0
            for (const s of fallback[fallbackKey]) if (s < v) below++
            return {percentile: below / fallback[fallbackKey].length, source: "within-scan"}
        }
        return {percentile: null, source: null}
    }

    /**
     * Score and classify one row. Returns:
     *   {score, classification, label, color, breakdown, reasons}
     *
     * `breakdown` lists every component that contributed (with raw, weight,
     * weighted) so the panel's "why" tooltip can name them in plain words.
     * `reasons` is a short array of human-readable strings for the Best
     * Cases card chips ("$/seat at 12th pct of history", "Fleet match",
     * "Bid in <6h").
     */
    classify(row) {
        const components = []
        const reasons = []
        const basis = (row && row.priceBasis) || null
        const priceLabel = basis === "lease" ? "lease/seat" : "$/seat"

        if (this._isEnabled("pricePerSeat") && row && row.typeId && isFiniteNumber(Number(row.pricePerSeat))) {
            const p = this._percentile(row.typeId, "pricePerSeat", row.pricePerSeat, basis)
            if (p.percentile !== null) {
                const norm = 1 - p.percentile
                components.push({field: "pricePerSeat", weight: this.weights.pricePerSeat,
                                 norm: norm, raw: p.percentile, source: p.source, basis: basis})
                if (p.percentile <= 0.25) reasons.push(_pctReason(priceLabel, p))
                else if (p.percentile <= 0.40) reasons.push(_pctReason(priceLabel, p, "decent"))
            }
        }
        if (this._isEnabled("seatKmYearCost") && row && row.typeId && isFiniteNumber(Number(row.seatKmYearCost))) {
            const p = this._percentile(row.typeId, "seatKmYearCost", row.seatKmYearCost)
            if (p.percentile !== null) {
                const norm = 1 - p.percentile
                components.push({field: "seatKmYearCost", weight: this.weights.seatKmYearCost,
                                 norm: norm, raw: p.percentile, source: p.source})
                if (p.percentile <= 0.25) reasons.push("Cheap lifecycle ratio")
            }
        }
        if (this._isEnabled("fuelEfficiency") && row && row.typeId && isFiniteNumber(Number(row.fuelPerSeatKm))) {
            const p = this._percentile(row.typeId, "fuelPerSeatKm", row.fuelPerSeatKm)
            if (p.percentile !== null) {
                const norm = 1 - p.percentile
                components.push({field: "fuelEfficiency", weight: this.weights.fuelEfficiency,
                                 norm: norm, raw: p.percentile, source: p.source})
                if (p.percentile <= 0.25) reasons.push(_pctReason("fuel/seat-km", p))
            }
        }

        const cond = numOrNull(row && row.conditionPct)
        if (this._isEnabled("condition") && cond !== null) {
            const norm = Math.max(0, Math.min(1, cond / 100))
            components.push({field: "condition", weight: this.weights.condition,
                             norm: norm, raw: cond})
            if (cond >= 90) reasons.push("Pristine condition")
        }

        const age = numOrNull(row && row.ageYears)
        if (this._isEnabled("age") && age !== null) {
            const remaining = Math.max(0,
                MarketScanDealClassifier.MAX_LIFE_YEARS - age)
            const norm = remaining / MarketScanDealClassifier.MAX_LIFE_YEARS
            components.push({field: "age", weight: this.weights.age,
                             norm: norm, raw: age})
            if (age <= 4) reasons.push("Young airframe")
        }

        const bidMs = numOrNull(row && row.bidIntervalMs)
        if (this._isEnabled("expiry") && bidMs !== null && bidMs >= 0) {
            const hours = bidMs / (60 * 60 * 1000)
            let norm
            if (hours <= MarketScanDealClassifier.EXPIRY_HARD_HOURS) norm = 1
            else {
                const days = hours / 24
                norm = Math.max(0, 1 - (days / MarketScanDealClassifier.EXPIRY_SOFT_DAYS))
            }
            components.push({field: "expiry", weight: this.weights.expiry,
                             norm: norm, raw: hours})
            if (hours <= MarketScanDealClassifier.EXPIRY_HARD_HOURS) reasons.push("Closing soon")
        }

        // Fleet synergy reads `row.fleetOwned` populated by
        // MarketScanDealMetrics.decorate. When fleet context is unavailable
        // that decoration leaves the field null, and we skip the component
        // entirely (instead of penalising the row for missing data).
        if (this._isEnabled("fleetSynergy") && row && row.fleetOwned !== null && row.fleetOwned !== undefined) {
            const norm = row.fleetOwned ? 1 : 0
            components.push({field: "fleetSynergy", weight: this.weights.fleetSynergy,
                             norm: norm, raw: !!row.fleetOwned})
            if (row.fleetOwned) reasons.push("Fleet match")
        }

        const fitCount = numOrNull(row && row.routeFitCount)
        const fitTotal = numOrNull(row && row.routeFitTotal)
        if (this._isEnabled("routeFit") && fitCount !== null && fitTotal !== null && fitTotal > 0) {
            const norm = Math.max(0, Math.min(1, fitCount / fitTotal))
            components.push({field: "routeFit", weight: this.weights.routeFit,
                             norm: norm, raw: {fit: fitCount, total: fitTotal}})
            if (fitCount >= Math.max(3, fitTotal * 0.5)) {
                reasons.push("Fits " + fitCount + "/" + fitTotal + " top routes")
            }
        }

        let weightedSum = 0, weightTotal = 0
        for (const c of components) {
            if (!isFinite(c.weight) || c.weight <= 0) continue
            weightedSum += c.norm * c.weight
            weightTotal += c.weight
        }
        const score = weightTotal > 0
            ? Math.round((weightedSum / weightTotal) * 100)
            : null

        const classification = MarketScanDealClassifier._bucket(score, row, components)
        const meta = MarketScanDealClassifier.classMeta(classification)
        return {
            score:          score,
            classification: classification,
            label:          meta && meta.label,
            color:          meta && meta.color,
            breakdown:      components,
            reasons:        reasons
        }
    }

    /**
     * Maps a score + row to a deal class. Steal requires high score AND a
     * cheap historical percentile (no inflated "everything is a steal in
     * cold-start" failures), AND decent condition + age. Pass forces deal-
     * breakers regardless of score blend (broken or geriatric airframes
     * never deserve a green light).
     */
    static _bucket(score, row, components) {
        const cond = numOrNull(row && row.conditionPct)
        const age  = numOrNull(row && row.ageYears)
        if (cond !== null && cond < 50) return "pass"
        if (age  !== null && age >= MarketScanDealClassifier.MAX_LIFE_YEARS) return "pass"
        if (score === null) return "fair"

        if (score >= 85) {
            // Steal floor demands a *historical* cheap-percentile on the
            // matching basis bucket — within-scan or cross-basis percentiles
            // are too noisy to mint a Steal from. Falls through to "great"
            // when history is sparse on the row's basis.
            const pps = components.find(c => c.field === "pricePerSeat")
            const cheap = pps && pps.source === "history" && pps.raw <= 0.25
            const condOk = cond === null || cond >= 80
            const ageOk  = age  === null || age  <= 8
            if (cheap && condOk && ageOk) return "steal"
        }
        if (score >= 70) return "great"
        if (score >= 55) return "good"
        if (score >= 40) return "fair"
        return "pass"
    }

    /**
     * Decorate every row in `rows` with {dealScore, dealClass, dealLabel,
     * dealColor, dealReasons, dealBreakdown}. Mutates the rows so the
     * results-table can sort/render off these fields directly.
     */
    decorateAll(rows) {
        if (!Array.isArray(rows)) return rows
        for (const r of rows) {
            const c = this.classify(r)
            r.dealScore     = c.score
            r.dealClass     = c.classification
            r.dealLabel     = c.label
            r.dealColor     = c.color
            r.dealReasons   = c.reasons
            r.dealBreakdown = c.breakdown
        }
        return rows
    }
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v)
}

function _pctReason(label, p, qualifier) {
    const pct = Math.round(p.percentile * 100)
    const tag = qualifier ? (qualifier + " ") : "Cheap "
    const src = p.source === "within-scan" ? " (this scan)" : ""
    return tag + label + " (" + pct + "th pct" + src + ")"
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketScanDealClassifier
