"use strict"

/**
 * Letter L slice L5 — DNA-fit scorer + pill renderer.
 *
 * Pure-function core: every scoring path is `(dna, candidate) → {score, breakdown}`
 * with zero storage reads and zero DOM. The pill helper at the bottom is the
 * one DOM-touching surface; it renders the glyph + tooltip and lives here so
 * downstream consumers (Family tile, UAS family grid, DNA editor, drift tile)
 * have a single source of truth for visuals.
 *
 * Score shape: `{score: 0..1, breakdown: {[dimName]: {weight, contribution, why}}}`
 * where `weight` is the dim's coefficient from `WEIGHTS`, `contribution` is the
 * dim's 0..1 alignment, and `why` is a one-line human-readable rationale.
 *
 * If a dim has no observable counterpart on the candidate (e.g. enum dims on an
 * aircraft candidate), it's skipped and its weight is redistributed across the
 * remaining dims so the final score stays normalized 0..1.
 */
;(function () {
    if (window.AesCanopyDnaFit) return

    const RISK_RANK = {"conservative": 0, "balanced": 1, "aggressive": 2}

    function _clamp01(x) {
        if (!isFinite(x)) return 0
        if (x < 0) return 0
        if (x > 1) return 1
        return x
    }

    function _enumMatch(target, observed) {
        if (target == null || observed == null) return null
        return target === observed ? 1 : 0
    }

    function _riskMatch(target, observed) {
        const a = RISK_RANK[target], b = RISK_RANK[observed]
        if (a == null || b == null) return null
        const d = Math.abs(a - b)
        return d === 0 ? 1 : (d === 1 ? 0.5 : 0)
    }

    // 1 − Σ|target − observed| / 2 — symmetric distance for distributions.
    // For shares that don't sum to 1 (manufacturerPrefs, growthPosture leaves
    // that aren't shares), we just sum |target − observed| and clamp.
    function _shareDistance(target, observed) {
        const keys = Object.keys(target || {})
        if (!keys.length) return null
        let sum = 0
        let any = false
        for (const k of keys) {
            const tv = Number(target[k])
            if (!isFinite(tv)) continue
            const ov = Number(observed && observed[k])
            if (!isFinite(ov)) continue
            sum += Math.abs(tv - ov)
            any = true
        }
        if (!any) return null
        return _clamp01(1 - sum / 2)
    }

    function _numberDistance(target, observed, span) {
        if (!isFinite(target) || !isFinite(observed)) return null
        const denom = span > 0 ? span : Math.max(Math.abs(target), 1)
        return _clamp01(1 - Math.abs(target - observed) / denom)
    }

    function _growthPostureMatch(target, observed) {
        if (!target) return null
        if (!observed) return null
        const a = _numberDistance(target.newRoutesPerWeekTarget, observed.newRoutesPerWeekTarget, 5)
        const b = _numberDistance(target.fleetGrowthRatePerYear, observed.fleetGrowthRatePerYear, 0.5)
        const parts = [a, b].filter(x => x != null)
        if (!parts.length) return null
        return parts.reduce((s, x) => s + x, 0) / parts.length
    }

    /**
     * Generic scorer — dispatches per-dim based on `dna.DIMENSIONS` shape.
     * Candidate provides observed values keyed by the same dim names. Dims
     * with no observable counterpart are skipped; weights are redistributed.
     */
    function dnaFitScore(dna, candidate) {
        if (!dna || !candidate) return {score: 0, breakdown: {}}
        const W = (window.AesCanopyDnaStore && window.AesCanopyDnaStore.WEIGHTS) || {}
        const DIMS = (window.AesCanopyDnaStore && window.AesCanopyDnaStore.DIMENSIONS) || []
        const breakdown = {}
        let weightUsed = 0
        let weightedSum = 0

        for (const d of DIMS) {
            const w = Number(W[d.key]) || 0
            const target = dna[d.key]
            const observed = candidate[d.key]
            let contribution = null
            let why = ""

            if (d.kind === "enum") {
                if (d.key === "riskProfile") {
                    contribution = _riskMatch(target, observed)
                    why = (contribution === 1) ? "match" :
                          (contribution === 0.5) ? "adjacent" :
                          (contribution === 0) ? "opposite" : "no observation"
                } else {
                    contribution = _enumMatch(target, observed)
                    why = contribution === 1 ? "match" : (contribution === 0 ? "differs" : "no observation")
                }
            } else if (d.kind === "number") {
                contribution = _numberDistance(target, observed, 0.6)
                if (contribution != null) why = "Δ " + (Math.abs(target - observed)).toFixed(2)
            } else if (d.kind === "object") {
                if (d.key === "growthPosture") {
                    contribution = _growthPostureMatch(target, observed)
                } else {
                    contribution = _shareDistance(target, observed)
                }
                if (contribution != null) why = "share-fit " + Math.round(contribution * 100) + "%"
            }

            if (contribution == null) {
                breakdown[d.key] = {weight: w, contribution: null, why: "no observation"}
                continue
            }
            breakdown[d.key] = {weight: w, contribution: _clamp01(contribution), why}
            weightUsed += w
            weightedSum += w * _clamp01(contribution)
        }

        const score = weightUsed > 0 ? weightedSum / weightUsed : 0
        return {score: _clamp01(score), breakdown}
    }

    // Aircraft adapter: maps an aircraft candidate to the observable subset.
    //   {familyName, manufacturer, sizeClass, isCargo}
    // sizeClass ∈ "regional"|"narrowbody"|"widebody"
    function dnaFitScoreAircraft(dna, aircraft) {
        if (!dna || !aircraft) return {score: 0, breakdown: {}}
        const observed = {}

        // manufacturerPrefs — observed = {[mfg]: 1, others: 0}
        if (aircraft.manufacturer) {
            const mfg = _normManufacturer(aircraft.manufacturer)
            observed.manufacturerPrefs = _onehot(["Boeing", "Airbus", "Embraer", "Other"], mfg)
        }
        // sizeMixTargets — observed = {[sizeClass]: 1, others: 0}
        if (aircraft.sizeClass) {
            observed.sizeMixTargets = _onehot(["regional", "narrowbody", "widebody"], aircraft.sizeClass)
        }
        // cargoEmphasis — observed = 1 if cargo aircraft, 0 otherwise. Only
        // contributes meaningfully for cargo-heavy DNA; for pax-heavy DNA a
        // cargo aircraft scores low on this dim, which is correct.
        if (typeof aircraft.isCargo === "boolean") {
            observed.cargoEmphasis = aircraft.isCargo ? 1 : 0
        }
        return dnaFitScore(dna, observed)
    }

    // Route adapter — for L6/L7 opportunity rows. v1 mostly skips this path.
    //   {originIata, destIata, distanceKm, originCountry, destCountry, classMix?}
    function dnaFitScoreRoute(dna, route) {
        if (!dna || !route) return {score: 0, breakdown: {}}
        const observed = {}
        if (route.classMix) observed.serviceMix = route.classMix
        if (route.originCountry && route.destCountry) {
            const sameCountry = route.originCountry === route.destCountry
            // Crude continental check — fine for v1; L8 geography refines.
            const sameContinent = sameCountry || (route.originContinent && route.originContinent === route.destContinent)
            observed.countryFocus = {
                domesticShare:     sameCountry ? 1 : 0,
                continentalShare:  (!sameCountry && sameContinent) ? 1 : 0,
                intercontShare:    !sameContinent ? 1 : 0
            }
        }
        return dnaFitScore(dna, observed)
    }

    // Account-state adapter — feeds the drift detector. Observed shape mirrors
    // DNA shape exactly; pass through with a defensive normalize.
    function dnaFitScoreAccountState(dna, observed) {
        if (!dna || !observed) return {score: 0, breakdown: {}}
        return dnaFitScore(dna, observed)
    }

    function _normManufacturer(raw) {
        const s = String(raw || "").toLowerCase()
        if (s.indexOf("boeing")  >= 0) return "Boeing"
        if (s.indexOf("airbus")  >= 0) return "Airbus"
        if (s.indexOf("embraer") >= 0) return "Embraer"
        return "Other"
    }

    function _onehot(keys, hit) {
        const out = {}
        for (const k of keys) out[k] = (k === hit ? 1 : 0)
        return out
    }

    // Pill renderer ----------------------------------------------------------

    function pillFor(score) {
        const s = _clamp01(score)
        if (s >= 0.7) return {glyph: "◉", color: "#10b981", label: "Strong fit"}
        if (s >= 0.4) return {glyph: "◐", color: "#f59e0b", label: "Mixed fit"}
        return {glyph: "◯", color: "#94a3b8", label: "Weak fit"}
    }

    function _formatBreakdown(breakdown) {
        const DIMS = (window.AesCanopyDnaStore && window.AesCanopyDnaStore.DIMENSIONS) || []
        const lines = []
        for (const d of DIMS) {
            const b = breakdown && breakdown[d.key]
            if (!b) continue
            const pct = (b.contribution == null) ? "—" : Math.round(b.contribution * 100) + "%"
            lines.push(d.label + ": " + pct + (b.why ? " (" + b.why + ")" : ""))
        }
        return lines.join("\n")
    }

    /**
     * Render a pill into `parent`. Returns the element. `score` may be a
     * number (0..1) OR a `{score, breakdown}` shape (from `dnaFitScore`).
     */
    function renderInto(parent, score, opts) {
        const result = (score && typeof score === "object" && "score" in score) ? score : {score: Number(score) || 0, breakdown: null}
        const p = pillFor(result.score)
        const span = document.createElement("span")
        span.className = "aes-dna-fit-pill"
        span.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "gap:3px",
            "padding:1px 6px",
            "border-radius:999px",
            "font-size:10px",
            "font-family:ui-monospace,monospace",
            "background:rgba(148,163,184,0.10)",
            "color:" + p.color,
            "border:1px solid " + p.color,
            "cursor:default"
        ].join(";")
        span.textContent = p.glyph + " " + result.score.toFixed(2)
        const tooltipBase = (opts && opts.label) || p.label
        const tooltipBody = result.breakdown ? _formatBreakdown(result.breakdown) : ""
        span.title = tooltipBase + (tooltipBody ? "\n\n" + tooltipBody : "")
        if (parent) parent.appendChild(span)
        return span
    }

    window.AesCanopyDnaFit = {
        dnaFitScore,
        dnaFitScoreAircraft,
        dnaFitScoreRoute,
        dnaFitScoreAccountState,
        pillFor,
        renderInto
    }
})()
