"use strict"

/**
 * AesStrategyInterventionTypes — Slice 21 schema definitions.
 *
 * Each intervention is a tagged object the snapshot-fork applies to a
 * forked snapshot before forward-simulator runs. Pure schema + validators;
 * no state. Validators return {ok, reason} so consumer (snapshot-fork)
 * can fail-fast with a user-readable error.
 *
 * Supported in v1:
 *   {kind: "setWeight",  name, value}            — adjust DECIDE weight
 *   {kind: "addAircraft", typeId, count, hub?}   — add N tails of typeId at hub
 *   {kind: "dropRoute",  hub, dest}              — disable a hub→dest route
 *   {kind: "flipDna",    dimension, value}       — flip a DNA dimension override
 *
 * Future v2 (deferred): chained interventions, stochastic params,
 * competitor-reaction simulation.
 */
;(function () {
    if (typeof window === "undefined" || window.AesStrategyInterventionTypes) return

    const SUPPORTED_WEIGHTS = [
        "profitWeight", "demandWeight", "competitorWeight", "orsWeight",
        "connectivityWeight", "maintenancePenalty", "cashPenalty"
    ]

    const SUPPORTED_DNA_DIMS = [
        "fleetMix", "networkShape", "cargoEmphasis", "tempo", "brandStance",
        "riskProfile", "serviceMix"
    ]

    const KINDS = ["setWeight", "addAircraft", "dropRoute", "flipDna"]

    function _isFiniteNum(v) { return typeof v === "number" && isFinite(v) }

    function validate(intervention) {
        if (!intervention || typeof intervention !== "object") {
            return {ok: false, reason: "intervention must be an object"}
        }
        const kind = intervention.kind
        if (KINDS.indexOf(kind) < 0) {
            return {ok: false, reason: "unsupported kind: " + kind}
        }
        switch (kind) {
            case "setWeight": {
                if (typeof intervention.name !== "string"
                    || SUPPORTED_WEIGHTS.indexOf(intervention.name) < 0) {
                    return {ok: false, reason: "setWeight.name must be one of " + SUPPORTED_WEIGHTS.join(",")}
                }
                if (!_isFiniteNum(intervention.value) || intervention.value < 0 || intervention.value > 2) {
                    return {ok: false, reason: "setWeight.value must be in [0, 2]"}
                }
                return {ok: true}
            }
            case "addAircraft": {
                if (typeof intervention.typeId !== "string" || !intervention.typeId) {
                    return {ok: false, reason: "addAircraft.typeId required"}
                }
                if (!_isFiniteNum(intervention.count) || intervention.count < 1 || intervention.count > 50) {
                    return {ok: false, reason: "addAircraft.count must be 1..50"}
                }
                return {ok: true}
            }
            case "dropRoute": {
                if (typeof intervention.hub !== "string" || !intervention.hub) {
                    return {ok: false, reason: "dropRoute.hub required"}
                }
                if (typeof intervention.dest !== "string" || !intervention.dest) {
                    return {ok: false, reason: "dropRoute.dest required"}
                }
                return {ok: true}
            }
            case "flipDna": {
                if (typeof intervention.dimension !== "string"
                    || SUPPORTED_DNA_DIMS.indexOf(intervention.dimension) < 0) {
                    return {ok: false, reason: "flipDna.dimension must be one of " + SUPPORTED_DNA_DIMS.join(",")}
                }
                return {ok: true}
            }
        }
        return {ok: false, reason: "unhandled kind: " + kind}
    }

    function summarize(intervention) {
        const v = validate(intervention)
        if (!v.ok) return "invalid: " + v.reason
        switch (intervention.kind) {
            case "setWeight":   return "setWeight " + intervention.name + " = " + intervention.value
            case "addAircraft": return "addAircraft " + intervention.typeId + " ×" + intervention.count
                                       + (intervention.hub ? " @ " + intervention.hub : "")
            case "dropRoute":   return "dropRoute " + intervention.hub + "→" + intervention.dest
            case "flipDna":     return "flipDna " + intervention.dimension + " → " + JSON.stringify(intervention.value)
        }
        return "?"
    }

    window.AesStrategyInterventionTypes = {
        validate, summarize, KINDS, SUPPORTED_WEIGHTS, SUPPORTED_DNA_DIMS
    }
})()
