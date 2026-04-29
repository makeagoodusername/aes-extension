"use strict"

/**
 * Lane A Phase 2 — schedule-apply orchestrator.
 *
 * Thin wrapper between drag-to-schedule (G9) and form-driver. Reads
 * settings.aircraftFlightPlan.dragSubmitMode + dragSubmit.dryRunOnly to
 * decide which form-driver entry point to use:
 *
 *   "manual"     → fill() only (default — preserves §4.2 invariant)
 *   "confirmed"  → fill() + toast → on confirm, message background tab to fillAndSubmit
 *   "auto"       → not yet wired (Phase 5 stretch)
 *
 * The form-driver UI invariant (form-driver.js:18-22) holds: the
 * orchestrator only ever calls fill() from foreground UI. Submission
 * routes through the existing background-tab path the AS Wave Apply
 * pipeline already uses.
 *
 * Public API:
 *   AesAfpScheduleApplyOrchestrator.applyDrop(drop) → Promise<{ok, mode, leg, message?}>
 *
 * `drop` shape (built by drag-to-schedule):
 *   {
 *     candidate: {destIata, blockMin, distanceKm, ...},
 *     waveId: string|null,
 *     dropMinute: int 0..1439,
 *     hubIata: string,
 *     presetId: string|null
 *   }
 */
;(function () {
    if (window.AesAfpScheduleApplyOrchestrator) return

    async function applyDrop(drop) {
        if (!drop || !drop.candidate || !drop.candidate.destIata) {
            return {ok: false, message: "Drop missing candidate destIata"}
        }
        const settings = (typeof window.AesAfpSettings !== "undefined")
            ? await window.AesAfpSettings.load() : {}
        const dryRunOnly = !!(settings.dragSubmit && settings.dragSubmit.dryRunOnly === true)
        const mode = (settings.dragSubmitMode === "confirmed" || settings.dragSubmitMode === "auto")
            ? settings.dragSubmitMode : "manual"

        const leg = _normaliseDropToLeg(drop)

        // Dry-run kill-switch: regardless of mode, never even pre-fill.
        if (dryRunOnly && mode !== "manual") {
            return _toast("Drag preview-only — disable dragSubmit.dryRunOnly to apply.")
                && {ok: true, mode: "preview", leg}
        }

        if (typeof window.AesAfpFormDriver === "undefined"
            || typeof window.AesAfpFormDriver.fill !== "function") {
            return {ok: false, mode, leg,
                message: "Form-driver not loaded on this page — cannot pre-fill."}
        }

        let r = null
        try { r = await window.AesAfpFormDriver.fill(leg) }
        catch (err) {
            return {ok: false, mode, leg, message: String(err && err.message || err)}
        }

        if (mode === "manual") {
            _toast("Pre-filled " + leg.destination + " · " + (leg.depTime || "—")
                + " · click AS Apply to submit")
            return {ok: !!(r && r.ok !== false), mode, leg, set: r && r.set, missed: r && r.missed}
        }

        if (mode === "confirmed") {
            // Fill happened above. Phase 2 stops here — confirmed-mode
            // submit goes through the existing background-tab path the
            // wave applier already uses (`aes:afp:fill-and-submit`),
            // wired via toast button rather than auto-firing. See
            // AesAfpFormDriver.fillAndSubmit at form-driver.js:456.
            _toast("Pre-filled. Click ✓ in the toast to submit, or AS Apply.")
            return {ok: true, mode, leg, set: r && r.set, missed: r && r.missed}
        }

        return {ok: false, mode, leg,
            message: "dragSubmitMode=auto is reserved for a later phase."}
    }

    function _normaliseDropToLeg(drop) {
        const c = drop.candidate || {}
        const dropMin = isFinite(drop.dropMinute) ? Number(drop.dropMinute) : null
        const depTime = (dropMin != null) ? _hhmm(dropMin) : null
        const blockMin = isFinite(c.blockMin) ? Number(c.blockMin) : null
        const arrTime = (depTime != null && blockMin != null) ? _hhmm(dropMin + blockMin) : null
        return {
            origin:      drop.hubIata || c.originIata || c.origin || "",
            destination: c.destIata,
            depTime,
            arrTime,
            blockMin,
            distanceKm: c.distanceKm || null,
            distanceNm: c.distanceNm || null,
            // Hint to form-driver that this came from drag — it can ignore
            // the dropMinute if the destination's preset gates require a
            // different timeslot.
            source: "drag-to-schedule",
            // Wave context — form-driver doesn't use these today, but
            // schedule-broadcaster + audit logs can attach the linkage.
            _waveId:    drop.waveId   || null,
            _presetId:  drop.presetId || null,
            _dropMin:   dropMin
        }
    }

    function _hhmm(min) {
        const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(min) || 0)))
        const h = Math.floor(m / 60)
        const mm = m % 60
        return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0")
    }

    function _toast(msg) {
        if (window.RouteAssistantToast && typeof window.RouteAssistantToast.info === "function") {
            try { window.RouteAssistantToast.info(msg) } catch (_) {}
            return true
        }
        try { console.info("[AES drag-to-schedule]", msg) } catch (_) {}
        return false
    }

    window.AesAfpScheduleApplyOrchestrator = {applyDrop}
})()
