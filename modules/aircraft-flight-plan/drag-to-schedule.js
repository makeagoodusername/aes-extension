"use strict"

/**
 * Lane A Phase 2 — drag-to-schedule (G9).
 *
 * Wires the candidate-row "⋮⋮" handle (route-candidates.js) through the
 * AesDragArbiter to the schedule-apply orchestrator. On drop:
 *
 *   1. Compute (waveId, dropMinute) via AesAfpWaveStrip.coordsToWave
 *      and coordsToMinute.
 *   2. Hand off to AesAfpScheduleApplyOrchestrator.applyDrop, which
 *      reads dragSubmitMode + dragSubmit.dryRunOnly and drives form-
 *      driver.fill() (or no-ops in pure preview).
 *
 * Two-gate compliance (§4.1):
 *   * Tier-gate:  dragSubmit.dryRunOnly === false (default true → preview)
 *   * Domain-gate: orchestrator's dragSubmitMode (default "manual" → fill only)
 *
 * The §4.2 form-driver UI invariant holds because the orchestrator only
 * calls fill() — never fillAndSubmit — from a foreground UI gesture.
 * Future phases that auto-submit have to thread through the background-
 * tab path (`aes:afp:fill-and-submit`) just like the wave applier already
 * does.
 *
 * Bus contract (joins existing dragschedule:* events from the arbiter):
 *   in:  AesDragArbiter on mouseup → effect()
 *   out: dragschedule:applied {gestureId, effect: {kind: "g9", drop}}
 */
;(function () {
    if (window.AesAfpDragToSchedule) return

    let _gestureRegistered = false

    function _ensureGesture() {
        if (_gestureRegistered) return
        if (!window.AesDragArbiter) return
        _gestureRegistered = true
        window.AesDragArbiter.register({
            id:       "afp.candidate.toLane",
            surface:  "afp",
            priority: 90,                   // below band drag (100), above scrollers
            matches:  (e, c) => !!(c && c.kind === "afp.candidate.toLane"),
            governedBy: {
                settingPath:    "settings.aircraftFlightPlan.dragSubmitMode",
                requiredValue:  "manual",
                tier:           "apply-on-confirm"
            },
            feedback: {
                buildGhost: (ctx) => ({
                    label: ctx.candidate.destIata + (ctx.candidate.blockMin
                        ? "  ·  " + ctx.candidate.blockMin + "min"
                        : ""),
                    tint:  "rgba(59,130,246,0.92)"
                }),
                onMove:   (ev, c) => _arbMove(ev, c),
                onCancel: (c, info) => _arbCancel(c, info)
            },
            effect:   (drop) => _arbDrop(drop)
        })
    }

    function startCandidateDrag(event, candidate, lastCtx) {
        if (!event || !candidate) return false
        _ensureGesture()
        if (!window.AesDragArbiter) return false
        const stripRoot = _findStripRoot()
        const arbCtx = {
            kind:       "afp.candidate.toLane",
            candidate,
            hubIata:    (lastCtx && lastCtx.originIata) || (candidate.origin) || "",
            stripRoot,
            lastHover:  null
        }
        return window.AesDragArbiter.startManual(event, arbCtx)
    }

    function _findStripRoot() {
        // F-9228-900: previously we did `lanes[0].closest("div")` which
        // returns the lane element itself (the lane IS a div with the
        // matching attribute). coordsToWave then queried within ONE lane
        // and found zero descendant lanes — every drop fell through to
        // "Drop outside wave-strip" and the dashed-outline hover affordance
        // never appeared. wave-strip.js now stamps `data-aes-wave-strip="1"`
        // on the wrap; address the wrap so coordsToWave sees every lane.
        const wrap = document.querySelector('[data-aes-wave-strip="1"]')
        if (wrap) return wrap
        // Back-compat for older wave-strip builds: walk up from the first
        // lane to its common ancestor (parentElement.parentElement = wrap).
        const lanes = document.querySelectorAll('[data-aes-wave-strip-lane="1"]')
        if (!lanes.length) return null
        const parent = lanes[0].parentElement
        return (parent && parent.parentElement) || parent || null
    }

    function _arbMove(ev, c) {
        if (!c.stripRoot) return
        const hit = window.AesAfpWaveStrip
            && typeof window.AesAfpWaveStrip.coordsToWave === "function"
            ? window.AesAfpWaveStrip.coordsToWave(c.stripRoot, ev.clientY)
            : null
        // Outline the lane under the pointer, clear the previously-hovered
        // lane's outline. Pure visual feedback; arbiter owns ghost+ESC.
        if (c.lastHover && c.lastHover.lane && c.lastHover.lane !== (hit && hit.lane)) {
            c.lastHover.lane.style.outline = ""
            c.lastHover.lane.style.outlineOffset = ""
        }
        if (hit && hit.lane) {
            hit.lane.style.outline = "2px dashed #60a5fa"
            hit.lane.style.outlineOffset = "-2px"
        }
        c.lastHover = hit
    }

    function _arbCancel(c) {
        if (c.lastHover && c.lastHover.lane) {
            c.lastHover.lane.style.outline = ""
            c.lastHover.lane.style.outlineOffset = ""
        }
    }

    async function _arbDrop(drop) {
        const c = drop.ctx
        if (c.lastHover && c.lastHover.lane) {
            c.lastHover.lane.style.outline = ""
            c.lastHover.lane.style.outlineOffset = ""
        }
        // Compute final drop target from the actual mouseup coordinates —
        // the lastHover lane mirrors the last move event but the user
        // might have released between move callbacks.
        const stripRoot = c.stripRoot
        if (!stripRoot) {
            return {ok: false, message: "Wave-strip not present — drop ignored."}
        }
        const waveHit = (typeof window.AesAfpWaveStrip.coordsToWave === "function")
            ? window.AesAfpWaveStrip.coordsToWave(stripRoot, drop.clientY) : null
        const lane = waveHit && waveHit.lane
        const waveId = waveHit && waveHit.waveId
        const dropMin = (lane && typeof window.AesAfpWaveStrip.coordsToMinute === "function")
            ? window.AesAfpWaveStrip.coordsToMinute(lane, drop.clientX) : null

        if (!lane) {
            return {ok: false, message: "Drop outside wave-strip — release on a lane to schedule."}
        }

        const presetId = (window.AesAfpWaveStrip && window.AesAfpWaveStrip.activePresetId) || null
        const orchestratorDrop = {
            candidate:  c.candidate,
            waveId:     waveId,
            dropMinute: dropMin,
            hubIata:    c.hubIata,
            presetId:   presetId
        }

        let result = null
        if (window.AesAfpScheduleApplyOrchestrator) {
            try { result = await window.AesAfpScheduleApplyOrchestrator.applyDrop(orchestratorDrop) }
            catch (err) {
                return {ok: false, message: String(err && err.message || err)}
            }
        } else {
            return {ok: false,
                message: "Schedule-apply orchestrator not loaded on this page."}
        }

        return {
            ok: !!(result && result.ok !== false),
            audit: {
                kind:    "g9-drag-to-schedule",
                mode:    result && result.mode,
                dest:    c.candidate && c.candidate.destIata,
                waveId,
                dropMin,
                preset:  presetId
            },
            message: result && result.message
        }
    }

    window.AesAfpDragToSchedule = {startCandidateDrag, _ensureGesture}
})()
