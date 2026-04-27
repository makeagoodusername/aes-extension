"use strict"

/**
 * Entrypoint for the Fleet Hub feature on the AS fleet management page
 * (`/app/fleets*`). Gates on `.as-page-fleet-management` so the per-aircraft
 * detail subpages (`/app/fleets/aircraft/<id>/...`) — which share the URL
 * prefix in the manifest match — don't accidentally trigger.
 *
 * Waits for content_fleetManagement.js to finish its display pass (signaled
 * by the AES summary panel containing "Currently N aircrafts stored")
 * before mounting; otherwise we'd race the chrome.storage.local write that
 * the aggregator depends on. Uses a MutationObserver instead of a poll loop
 * so we wake up exactly once per relevant DOM change.
 */
;(function () {
    const root = document.querySelector(".as-page-fleet-management")
    if (!root) return

    const HARD_TIMEOUT_MS = 5000

    function start() {
        const host = new FleetHubHost()
        host.mount().catch(err => {
            console.warn("[AES Fleet Hub] mount failed", err)
        })
    }

    if (FleetHubHost._findFltmngPanel()) { start(); return }

    let done = false
    const finish = () => {
        if (done) return
        done = true
        try { observer.disconnect() } catch (_) { /* noop */ }
        clearTimeout(timeout)
        start()
    }

    const observer = new MutationObserver(() => {
        if (FleetHubHost._findFltmngPanel()) finish()
    })
    observer.observe(root, {childList: true, subtree: true})

    // Late-mount fallback: an empty fleet means fltmng_display() never runs
    // (the AES panel is never injected). Mount anyway after a hard cap so
    // the user still gets the Loc/Plan/Sched columns when rows arrive later.
    const timeout = setTimeout(finish, HARD_TIMEOUT_MS)
})()
