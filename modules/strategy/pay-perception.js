"use strict"

/**
 * AES Strategy — pay-perception model (Slice 8).
 *
 * Pure module. Models the AS pay-tier ↔ recruitment / retention relationship
 * as a TESTABLE HYPOTHESIS rather than a calibrated curve — there's no
 * historical pay-vs-applicant data attached to the snapshot today, so the
 * proposer publishes a falsifiable claim ("raise pay 10pp → +N recruits/wk
 * over 4 weeks") that the next scrape can confirm or refute.
 *
 * The two-direction recommendation:
 *   - chronic missing AND dry market → raise pay (proportional to severity)
 *   - reserve >> required AND profit-tilted → cut pay (savings test)
 *   - otherwise → hold
 *
 * Public API (window.AesStrategyPayPerception):
 *   evaluate({skillSlot, weights, opts?}) →
 *     {
 *       action:                 "raisePay" | "cutPay" | "hold",
 *       amountPp:               number,           // signed pp delta (raise = +)
 *       hypothesis:             string,           // user-facing testable claim
 *       predictedRecruitDelta:  number | null,    // applicants/wk if action ≠ hold
 *       confidence:             "high"|"medium"|"low",
 *       inputs:                 {missing, reserve, required, marketAvailable, profitWeight}
 *     }
 *
 * Tunable knobs (`opts`, all optional):
 *   {
 *     missingThreshold:        1,    // missing > N triggers raise consideration
 *     reserveExcessRatio:      1.5,  // reserve ≥ required × ratio → cut candidate
 *     basePayRaisePp:          5,    // baseline raise magnitude
 *     payRaiseCeilingPp:       20,   // hard cap on a single raise
 *     basePayCutPp:            3,    // baseline cut magnitude
 *     payCutFloorPp:          -10,   // hard cap on a single cut (negative)
 *     recruitsPerPpRaiseEst:   0.4   // testable assumption: +1pp pay → +0.4 applicants/wk
 *   }
 *
 * The recruits-per-pp coefficient is the *testable* part — it's an a-priori
 * guess until the calibration loop measures it. Surface it in the hypothesis
 * so the user (and a future LEARN slice) can audit it against reality.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyPayPerception) return

    const DEFAULTS = Object.freeze({
        missingThreshold:        1,
        reserveExcessRatio:      1.5,
        basePayRaisePp:          5,
        payRaiseCeilingPp:       20,
        basePayCutPp:            3,
        payCutFloorPp:          -10,
        recruitsPerPpRaiseEst:   0.4
    })

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    function _resolveOpts(opts) {
        const o = opts || {}
        return {
            missingThreshold:      _num(o.missingThreshold,      DEFAULTS.missingThreshold),
            reserveExcessRatio:    _num(o.reserveExcessRatio,    DEFAULTS.reserveExcessRatio),
            basePayRaisePp:        _num(o.basePayRaisePp,        DEFAULTS.basePayRaisePp),
            payRaiseCeilingPp:     _num(o.payRaiseCeilingPp,     DEFAULTS.payRaiseCeilingPp),
            basePayCutPp:          _num(o.basePayCutPp,          DEFAULTS.basePayCutPp),
            payCutFloorPp:         _num(o.payCutFloorPp,         DEFAULTS.payCutFloorPp),
            recruitsPerPpRaiseEst: _num(o.recruitsPerPpRaiseEst, DEFAULTS.recruitsPerPpRaiseEst)
        }
    }

    function _hold(slot, weights, reason) {
        return {
            action:                "hold",
            amountPp:              0,
            hypothesis:            "[hold] " + reason,
            predictedRecruitDelta: null,
            confidence:            "high",
            inputs:                _inputsSummary(slot, weights)
        }
    }

    function _inputsSummary(slot, weights) {
        return {
            missing:         _num(slot && slot.missing,         0),
            reserve:         _num(slot && slot.reserve,         0),
            required:        _num(slot && slot.required,        0),
            marketAvailable: _num(slot && slot.marketAvailable, 0),
            profitWeight:    _num(weights && weights.profitWeight, 0)
        }
    }

    /**
     * Confidence ladder — "high" when the signal is unambiguous (very dry
     * market, very high missing OR clear overstaff), "low" when we're
     * straddling thresholds. Drives whether the proposer recommends action
     * or just surfaces the data.
     */
    function _confidenceForRaise(slot, opts) {
        const missing = _num(slot.missing, 0)
        const market  = _num(slot.marketAvailable, 0)
        if (missing >= opts.missingThreshold * 3 && market === 0) return "high"
        if (missing >= opts.missingThreshold * 2 && market < missing) return "medium"
        return "low"
    }

    function _confidenceForCut(slot, opts, weights) {
        const reserve  = _num(slot.reserve, 0)
        const required = Math.max(1, _num(slot.required, 0))
        const ratio    = reserve / required
        const profit   = _num(weights && weights.profitWeight, 0)
        if (ratio >= opts.reserveExcessRatio * 1.5 && profit >= 0.7) return "high"
        if (ratio >= opts.reserveExcessRatio && profit > 0.5)        return "medium"
        return "low"
    }

    /**
     * Raise-pay hypothesis. Magnitude scales with the missing severity
     * (linearly), capped by `payRaiseCeilingPp`. The recruits prediction
     * is the testable claim — `recruitsPerPpRaiseEst` is an a-priori guess
     * surfaced in the hypothesis so the user can audit it against actual
     * recruitment over the next 4 weeks.
     */
    function _proposeRaise(slot, opts) {
        const missing = _num(slot.missing, 0)
        const market  = _num(slot.marketAvailable, 0)
        // Severity multiplier: 1.0 when missing == threshold, scales up to
        // 4× when missing >> threshold. Bounded so a single pulse doesn't
        // spike pay 50pp.
        const severity = Math.max(1, Math.min(4, missing / Math.max(1, opts.missingThreshold)))
        const amountPp = Math.round(Math.min(opts.payRaiseCeilingPp,
            opts.basePayRaisePp * severity))
        const predictedRecruitDelta = _round(opts.recruitsPerPpRaiseEst * amountPp, 2)
        const hypothesis = "[hypothesis] raise pay +" + amountPp
            + "pp → expected ~+" + predictedRecruitDelta
            + " recruits/wk over the next 4-week cycle"
            + " (missing " + missing + ", market " + market
            + " — testable: re-scrape staffPilots in 4wk and compare marketAvailable + missing trend)"
        return {amountPp: amountPp, predictedRecruitDelta: predictedRecruitDelta, hypothesis: hypothesis}
    }

    /**
     * Cut-pay hypothesis. Magnitude scales with reserve excess; we check
     * the "reserve covers attrition" condition so the cut doesn't risk
     * creating a missing pulse before the next eval cycle. Predicted
     * recruitment delta is negative (mirror of the raise coefficient,
     * conservative ÷2 because crew leaving is stickier than joining).
     */
    function _proposeCut(slot, opts) {
        const reserve  = _num(slot.reserve, 0)
        const required = Math.max(1, _num(slot.required, 0))
        const excess   = reserve - required * opts.reserveExcessRatio
        const severity = Math.max(1, Math.min(3, excess / Math.max(1, required * 0.5)))
        // payCutFloorPp is the most-negative cap (e.g. -10), so the actual
        // cut is bounded by Math.max(floor, basePayCut * severity * -1).
        const amountPp = Math.round(Math.max(opts.payCutFloorPp,
            -opts.basePayCutPp * severity))
        const predictedRecruitDelta = _round((opts.recruitsPerPpRaiseEst / 2) * amountPp, 2)
        const hypothesis = "[hypothesis] cut pay " + amountPp
            + "pp → expected ~" + predictedRecruitDelta
            + " recruits/wk (reserve " + reserve + " covers required " + required
            + " × " + opts.reserveExcessRatio + " — testable: monitor reserve drop + missing climb at next scrape)"
        return {amountPp: amountPp, predictedRecruitDelta: predictedRecruitDelta, hypothesis: hypothesis}
    }

    function evaluate(input) {
        const slot    = input && input.skillSlot
        const weights = input && input.weights
        const opts    = _resolveOpts(input && input.opts)
        if (!slot) return _hold(null, weights, "no crew snapshot for this skill")

        const missing  = _num(slot.missing,         0)
        const reserve  = _num(slot.reserve,         0)
        const required = Math.max(0, _num(slot.required, 0))
        const market   = _num(slot.marketAvailable, 0)
        const profit   = _num(weights && weights.profitWeight, 0)

        // Raise wins when missing exceeds threshold AND market can't cover.
        if (missing >= opts.missingThreshold && market < missing) {
            const conf = _confidenceForRaise(slot, opts)
            if (conf === "low") {
                return _hold(slot, weights,
                    "missing " + missing + " borderline — defer pay raise (confidence low)")
            }
            const r = _proposeRaise(slot, opts)
            return {
                action:                "raisePay",
                amountPp:              r.amountPp,
                hypothesis:            r.hypothesis,
                predictedRecruitDelta: r.predictedRecruitDelta,
                confidence:            conf,
                inputs:                _inputsSummary(slot, weights)
            }
        }

        // Cut wins when overstaffed AND user is profit-tilted.
        if (required > 0 && reserve >= required * opts.reserveExcessRatio && profit > 0.5) {
            const conf = _confidenceForCut(slot, opts, weights)
            if (conf === "low") {
                return _hold(slot, weights,
                    "reserve " + reserve + "/req " + required
                    + " borderline — defer pay cut (confidence low)")
            }
            const c = _proposeCut(slot, opts)
            return {
                action:                "cutPay",
                amountPp:              c.amountPp,
                hypothesis:            c.hypothesis,
                predictedRecruitDelta: c.predictedRecruitDelta,
                confidence:            conf,
                inputs:                _inputsSummary(slot, weights)
            }
        }

        return _hold(slot, weights,
            "no shortfall (missing=" + missing + "), reserve healthy ("
            + reserve + "/" + required + "), goal=" + (profit > 0.5 ? "profit-tilt" : "balanced/share-tilt"))
    }

    window.AesStrategyPayPerception = {
        evaluate: evaluate,
        DEFAULTS: DEFAULTS
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Raise path — chronic missing, dry market.
            const dry = evaluate({
                skillSlot: {missing: 4, marketAvailable: 0, reserve: 1, required: 8, skillId: 12},
                weights:   {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
            })
            console.assert(dry.action === "raisePay",
                "[smoke pay] dry market + chronic missing → raisePay")
            console.assert(dry.amountPp >= 5,
                "[smoke pay] raise magnitude scales with severity")
            console.assert(/raise pay/.test(dry.hypothesis),
                "[smoke pay] raise hypothesis surfaces the testable claim")

            // Cut path — overstaffed AND profit-tilted.
            const fat = evaluate({
                skillSlot: {missing: 0, marketAvailable: 5, reserve: 18, required: 8, skillId: 13},
                weights:   {shareWeight: 0.1, profitWeight: 0.8, rankWeight: 0.1}
            })
            console.assert(fat.action === "cutPay",
                "[smoke pay] overstaff + profit-tilt → cutPay")
            console.assert(fat.amountPp < 0,
                "[smoke pay] cut magnitude is negative")

            // Overstaffed but balanced goal — no cut.
            const fatBalanced = evaluate({
                skillSlot: {missing: 0, marketAvailable: 5, reserve: 18, required: 8, skillId: 13},
                weights:   {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
            })
            console.assert(fatBalanced.action === "hold",
                "[smoke pay] overstaff without profit-tilt → hold (don't cut on balanced goal)")

            // Healthy slot — hold path.
            const ok = evaluate({
                skillSlot: {missing: 0, marketAvailable: 4, reserve: 6, required: 8, skillId: 14},
                weights:   {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
            })
            console.assert(ok.action === "hold",
                "[smoke pay] healthy slot → hold")
            console.assert(ok.predictedRecruitDelta === null,
                "[smoke pay] hold path carries no recruit prediction")

            // Missing slot — hold with explanation.
            const noSlot = evaluate({skillSlot: null, weights: {profitWeight: 0.4}})
            console.assert(noSlot.action === "hold",
                "[smoke pay] missing slot → hold")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
