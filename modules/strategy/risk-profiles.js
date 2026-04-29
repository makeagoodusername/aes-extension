"use strict"

/**
 * AES Strategy — Risk Profiles (Slice 17).
 *
 * Three named bundles of strategy weights + thresholds:
 *   conservative — capital-preserving, slow learning, low price moves.
 *   balanced     — DEFAULT_WEIGHTS + default thresholds. The shipping default.
 *   aggressive   — yield-seeking, faster learning, wider price-move window.
 *
 * What profiles touch:
 *   • settings.weights              — partial override of DEFAULT_WEIGHTS keys
 *   • settings.maxPriceMovePerWindow
 *   • settings.priceDeadband
 *   • settings.routeCreationThreshold
 *   • settings.learningStepSize
 *   • settings.riskProfile          — name of the active profile
 *
 * What profiles DO NOT touch:
 *   • settings.tier                 — user's "off" intent (§4.1 two-gate)
 *   • settings.{domain}Enabled      — every per-domain enable flag stays a
 *     user opt-in. Picking "Aggressive" never silently flips an apply path
 *     ON. §4.18 forbids silent default flips for user-visible numbers.
 *
 * Public API (window.AesStrategyRiskProfiles):
 *   PROFILES                                   → object keyed by name
 *   names()                                    → ["conservative", ...]
 *   apply(profileName, currentSettings)        → settings patch (deep-merged
 *                                                with currentSettings by caller)
 *   detect(settings)                           → name string ("custom" if
 *                                                settings.riskProfile is unset
 *                                                or unknown)
 *   describe(profileName)                      → {label, blurb} for UI
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyRiskProfiles) return

    const PROFILES = {
        conservative: {
            label: "Conservative",
            blurb: "Capital-preserving. Smaller price moves, slower learning, higher route bar.",
            weights: {
                profitWeight:       0.50,
                demandWeight:       0.15,
                competitorWeight:   0.15,
                orsWeight:          0.10,
                maintenancePenalty: 0.40,
                cashPenalty:        0.50
            },
            settings: {
                maxPriceMovePerWindow:  5,
                priceDeadband:          7,
                routeCreationThreshold: 0.75,
                learningStepSize:       0.02
            }
        },
        balanced: {
            label: "Balanced",
            blurb: "Defaults. Even weighting across profit, demand, competition, ORS.",
            weights: {
                profitWeight:       0.40,
                demandWeight:       0.20,
                competitorWeight:   0.20,
                orsWeight:          0.10,
                maintenancePenalty: 0.30,
                cashPenalty:        0.30
            },
            settings: {
                maxPriceMovePerWindow:  10,
                priceDeadband:          5,
                routeCreationThreshold: 0.60,
                learningStepSize:       0.05
            }
        },
        aggressive: {
            label: "Aggressive",
            blurb: "Yield-seeking. Wider price moves, faster learning, lower route bar.",
            weights: {
                profitWeight:       0.50,
                demandWeight:       0.30,
                competitorWeight:   0.30,
                orsWeight:          0.15,
                maintenancePenalty: 0.20,
                cashPenalty:        0.15
            },
            settings: {
                maxPriceMovePerWindow:  15,
                priceDeadband:          3,
                routeCreationThreshold: 0.45,
                learningStepSize:       0.10
            }
        }
    }

    function names() {
        return Object.keys(PROFILES)
    }

    function describe(profileName) {
        const p = PROFILES[profileName]
        if (!p) return {label: "Custom", blurb: "User-tuned weights and thresholds."}
        return {label: p.label, blurb: p.blurb}
    }

    /**
     * Build the settings patch for a named profile. Caller is responsible
     * for passing the result to AesStrategySettings.save() — this function
     * is pure.
     *
     * Weights merge: profile's weights are deep-merged INTO the current
     * weights so non-profile weights (cargoWeightInDemand, profitNormalizer,
     * etc.) survive a profile switch. The user's manual tweaks to those
     * non-blend weights aren't blown away by picking a profile.
     */
    function apply(profileName, currentSettings) {
        const p = PROFILES[profileName]
        if (!p) return null
        const cur = currentSettings || {}
        const curWeights = (cur.weights && typeof cur.weights === "object") ? cur.weights : {}
        const nextWeights = Object.assign({}, curWeights, p.weights)
        return Object.assign({}, p.settings, {
            riskProfile: profileName,
            weights:     nextWeights
        })
    }

    function detect(settings) {
        if (!settings || typeof settings.riskProfile !== "string") return "custom"
        if (PROFILES[settings.riskProfile]) return settings.riskProfile
        return "custom"
    }

    window.AesStrategyRiskProfiles = {
        PROFILES: PROFILES,
        names:    names,
        describe: describe,
        apply:    apply,
        detect:   detect
    }
})()
