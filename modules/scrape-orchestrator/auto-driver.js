"use strict"

/**
 * AesScrapeAutoDriver — background drip-style runner for the scrape
 * orchestrator. Mounts on the dashboard tab. On each tick (chrome.alarms
 * relay or local self-tick), picks the most-overdue mandatory phase from
 * AesPhaseCadenceStore and runs ScrapeOrchestrator silently — no modal,
 * no toast.
 *
 * Why dashboard-only: the orchestrator already lives here, so the auto
 * driver reuses the same plumbing. Tiles on the dashboard re-render via
 * storage.onChanged the moment new data lands, so the user perceives a
 * live page without ever clicking "Scrape everything".
 *
 * Gates (any one fails → tick is a no-op):
 *   1. master toggle  (storage key  aesAutoDrive:enabled, default true)
 *   2. ToS accepted   (ScrapeTosConfirmation.hasAccepted)
 *   3. nothing already running in the background pool
 *   4. server/airline context resolved
 *   5. at least one mandatory phase past its cadence
 */
;(function () {
    if (typeof window === "undefined" || window.AesScrapeAutoDriver) return

    const SELF_TICK_MS  = 5 * 60 * 1000
    const MIN_GAP_MS    = 60 * 1000
    const BOOT_DELAY_MS = 4000
    // `ors-rank` is mandatory + the cheapest-to-run mandatory phase (no
     // hidden tabs, postRun-only). Ordering doesn't matter — pickStalest
     // selects by overdue-ratio, not list position. Including it here lets
     // the auto-driver refresh ORS competitive data on its 4h cadence
     // independently of the heavier per-route scrape.
    const MANDATORY_PHASES = ["foundation", "per-hub", "per-aircraft", "per-route", "ors-rank"]

    let _selfTimer  = null
    let _lastTickAt = 0
    let _busy       = false

    function _emitTickSignal(out) {
        if (typeof window.AesConductorSignalLayer === "undefined") return
        try {
            window.AesConductorSignalLayer.emit({
                type:    "auto-drive.ticked",
                payload: {reason: out.reason, ranPhase: out.ranPhase, skipped: out.skipped}
            }).catch(() => {})
        } catch (_) { /* noop */ }
    }

    async function tick(reason) {
        const out = await _doTick(reason)
        _emitTickSignal(out)
        return out
    }

    async function _doTick(reason) {
        const out = {reason: reason || "manual", ranPhase: null, skipped: null}
        if (_busy) { out.skipped = "busy"; return out }
        const now = Date.now()
        if (now - _lastTickAt < MIN_GAP_MS) { out.skipped = "min-gap"; return out }
        _lastTickAt = now

        if (!await _isEnabled())             { out.skipped = "disabled";         return out }
        if (!await _isTosAccepted())         { out.skipped = "tos-not-accepted"; return out }
        if (await _isOrchestratorRunning())  { out.skipped = "running";          return out }

        const host = await _buildHost()
        if (!host) { out.skipped = "no-context"; return out }
        if (!window.AesPhaseCadenceStore) { out.skipped = "cadence-store-missing"; return out }

        const phaseId = await window.AesPhaseCadenceStore.pickStalest(host, MANDATORY_PHASES)
        if (!phaseId) { out.skipped = "nothing-stale"; return out }

        _busy = true
        try {
            try { await chrome.storage.local.set({"aesAutoDrive:silentRunActive": true}) } catch (_) {}
            const orch = new window.ScrapeOrchestrator({})
            await orch.start({phaseFilter: [phaseId], source: "auto"})
            out.ranPhase = phaseId
        } catch (e) {
            console.warn("[AES auto-drive] phase", phaseId, "threw", (e && e.message) || e)
            out.skipped = "threw"
        } finally {
            _busy = false
            try { await chrome.storage.local.set({"aesAutoDrive:silentRunActive": false}) } catch (_) {}
        }
        return out
    }

    async function _isEnabled() {
        try {
            const blob = await chrome.storage.local.get(["aesAutoDrive:enabled"])
            const v = blob["aesAutoDrive:enabled"]
            return v == null ? true : !!v
        } catch (_) { return false }
    }

    async function _isTosAccepted() {
        if (!window.ScrapeTosConfirmation) return false
        try { return !!(await window.ScrapeTosConfirmation.hasAccepted()) }
        catch (_) { return false }
    }

    async function _isOrchestratorRunning() {
        if (!window.ScrapeOrchestrator) return false
        try { return !!(await window.ScrapeOrchestrator.isRunning()) }
        catch (_) { return false }
    }

    async function _buildHost() {
        try {
            let server = ""
            let airline = ""
            try { if (typeof AES !== "undefined") server = AES.getServerName() || "" } catch (_) {}
            try {
                if (typeof AES !== "undefined") {
                    const code = AES.getAirlineCode()
                    airline = (code && code.code) || ""
                    if (!airline) airline = AES.getAirlineIdentity() || ""
                }
            } catch (_) {}
            if (!server) return null
            return {server, airline}
        } catch (_) { return null }
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== "aes:auto-drive:tick") return false
        tick("alarm").then((res) => {
            try { sendResponse(res || {}) } catch (_) {}
        }).catch(() => { try { sendResponse({error: true}) } catch (_) {} })
        return true
    })

    function _startSelfTimer() {
        if (_selfTimer) return
        _selfTimer = setInterval(() => { tick("self").catch(() => {}) }, SELF_TICK_MS)
    }

    function _bootstrap() {
        _startSelfTimer()
        setTimeout(() => { tick("boot").catch(() => {}) }, BOOT_DELAY_MS)
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _bootstrap, {once: true})
    } else {
        setTimeout(_bootstrap, 200)
    }

    window.AesScrapeAutoDriver = {tick}
})()
