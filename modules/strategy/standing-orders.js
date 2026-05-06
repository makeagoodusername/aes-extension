"use strict"

/**
 * AES Strategy — Standing Orders Engine (Slice 24).
 *
 * Evaluates active rules against the current snapshot and generates
 * automated decisions. Composes with risk profiles (Slice 17).
 *
 * It is invoked during plan compilation. It produces decisions sourced
 * as "rule:<id>" so the audit trail distinguishes them from the
 * primary strategy engine proposals.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyStandingOrders) return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    /**
     * Evaluates a list of rules against the snapshot and generates decisions.
     */
    async function evaluateRules(snapshot, rules) {
        if (!snapshot || !snapshot.hubs) return []
        if (!Array.isArray(rules) || !rules.length) return []

        const decisions = []

        for (const rule of rules) {
            if (!rule.enabled) continue

            for (const hub of snapshot.hubs) {
                // Check rule scope (hub filter)
                if (rule.scope && rule.scope.hub && rule.scope.hub !== hub.iata) continue

                if (!Array.isArray(hub.byRoute)) continue

                for (const route of hub.byRoute) {
                    if (!route || !route.dest) continue

                    const decision = _evaluateRuleOnRoute(rule, hub.iata, route, snapshot)
                    if (decision) {
                        decisions.push(decision)
                    }
                }
            }
        }

        return decisions
    }

    function _evaluateRuleOnRoute(rule, hubIata, route, snapshot) {
        if (!rule.trigger || !rule.action) return null

        let triggered = false
        let rationale = []

        // --- Trigger Evaluation ---
        if (rule.trigger.type === "lf-drop") {
            const currentLf = _num(route.paxLfMean, _num(route.lf, null))
            if (currentLf !== null && currentLf < (rule.trigger.threshold / 100)) {
                triggered = true
                rationale.push("[rule:" + rule.id + "] triggered: LF " + Math.round(currentLf * 100) + "% < " + rule.trigger.threshold + "%")
            }
        }
        else if (rule.trigger.type === "competitor-entry") {
            if (route.competitor && route.competitor.incumbentCount > 1) { // Simplistic check for testing
                // If we have historic data, we can detect an actual new entry
                if (route.competitor.historic && route.competitor.historic.weeks && route.competitor.historic.weeks.length > 1) {
                    const recent = route.competitor.historic.weeks[0]
                    const older = route.competitor.historic.weeks[1]
                    if (recent.competitors && older.competitors && recent.competitors.length > older.competitors.length) {
                        triggered = true
                        rationale.push("[rule:" + rule.id + "] triggered: competitor entry detected")
                    }
                }
            }
        }

        if (!triggered) return null

        // --- Action Generation ---
        if (rule.action.type === "price-cut") {
            const currentPriceY = route.ownPricing && route.ownPricing.prices && route.ownPricing.prices.Y
            if (!currentPriceY) return null

            // Avoid pushing below marginal cost
            let floorPct = 50
            if (window.AesStrategyPricingEngine && window.AesStrategyPricingEngine.marginalCostFloor) {
                floorPct = _num(window.AesStrategyPricingEngine.marginalCostFloor(snapshot, hubIata, route.dest, {}, "Y"), 50)
            }

            const targetPct = Math.max(floorPct, 100 - rule.action.value)
            if (targetPct >= 100) return null // Floor is too high to cut

            return {
                id: "rule-" + rule.id + "-" + hubIata + "-" + route.dest + "-" + Date.now(),
                domain: "price",
                applicable: true,
                payload: {
                    hub: hubIata,
                    dest: route.dest,
                    classKey: "Y",
                    toPct: targetPct,
                    impactWeekly: 0 // Simplification
                },
                rationale: rationale.concat(["Action: apply " + rule.action.value + "% price cut"])
            }
        }

        return null
    }

    window.AesStrategyStandingOrders = {
        evaluateRules
    }
})()
