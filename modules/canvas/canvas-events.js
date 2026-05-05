"use strict"

/**
 * Bus event names for the Schedule Canvas.
 *
 * All events ride on the existing `window.CentralHubBus` (modules/central-hub/bus.js).
 * Emit/subscribe go through `CentralHubBus.emit(EVT.HUB_CHANGED, payload)` and
 * `CentralHubBus.on(EVT.HUB_CHANGED, handler)` so we never sprinkle bare
 * strings across the canvas modules.
 *
 * Why a constants file: the bus accepts arbitrary event names, so a typo
 * silently fails to subscribe. Centralising every name we use here means a
 * misspelt import is a runtime error, not a missed event.
 *
 * Payload shapes are documented inline next to each constant.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCanvasEvents) return

    const EVT = {
        // {hub: string}                     — hub picker selected a new hub
        HUB_CHANGED:               "canvas:hub-changed",
        // {view: "waves"|"timeline"}        — wave-spine vs. legacy timeline
        VIEW_CHANGED:              "canvas:view-changed",
        // {mode: "builder"|"advisor"}       — assistant rail flipped modes
        RAIL_MODE_CHANGED:         "canvas:rail-mode-changed",
        // {open: boolean}                   — rail visibility toggle
        RAIL_OPEN_CHANGED:         "canvas:rail-open-changed",
        // {aircraftId: string}              — row click; null clears focus
        FOCUS_AIRCRAFT:            "canvas:focus-aircraft",
        // {presetId: string, waveId: string}— wave-column header click
        FOCUS_WAVE:                "canvas:focus-wave",

        // Builder engine outputs
        // {proposalId, plan, rationale, scoreDelta}
        BUILDER_PROPOSAL:          "canvas:builder-proposal",
        // {proposalId} — builder finished streaming all candidates
        BUILDER_DONE:              "canvas:builder-done",

        // Advisor engine outputs
        // {id, kind, severity: "info"|"warn"|"error", message, action?: {label, run}}
        ADVISOR_SUGGESTION:        "canvas:advisor-suggestion",
        // {id, accepted: boolean}
        ADVISOR_SUGGESTION_RESOLVED: "canvas:advisor-suggestion-resolved",

        // Edit lifecycle (drag/drop, builder adopt, advisor accept, etc.)
        // {kind: "moveRoute"|"addRoute"|"removeRoute"|"applyPricing", payload, batchId?}
        EDIT_STAGED:               "canvas:edit-staged",
        // {batchId, edits: [{kind, payload}]}
        EDIT_COMMITTED:            "canvas:edit-committed",
        // {batchId} — discard staged edits without committing
        EDIT_DISCARDED:            "canvas:edit-discarded"
    }

    window.AesCanvasEvents = Object.freeze(EVT)
})()
