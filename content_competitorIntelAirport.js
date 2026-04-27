"use strict"

/**
 * Entrypoint for the Competitor Intelligence airport panel on
 * `/app/info/airports/<id>`. Mounts an idempotent panel that reads RA's
 * airport-overview cache, enriches it with weekly-departures + interlining
 * + officeId, and renders a carriers table after AS's own Stations block.
 *
 * Mirrors `content_finance_accounting.js` MutationObserver shape: wait for
 * the anchor element, mount once, fall back to a hard timeout.
 *
 * Coexists with `content_stationOpen.js` (which targets the same URL) by
 * using a distinct DOM node and `aes-competitor-*` class namespace.
 */
;(function () {
    const HARD_TIMEOUT_MS = 5000

    function findAnchor() {
        return document.querySelector(".as-page .container-fluid .as-panel")
            || document.querySelector("h1 + .as-panel")
            || document.querySelector(".container-fluid .as-panel")
    }

    function start() {
        if (typeof AesCompetitorAirportHost === "undefined") {
            console.warn("[AES competitor-intel] airport host not loaded")
            return
        }
        const host = new AesCompetitorAirportHost()
        host.mount().catch(err => {
            console.warn("[AES competitor-intel] airport mount failed", err)
        })
    }

    if (findAnchor()) { start(); return }

    let done = false
    const finish = () => {
        if (done) return
        done = true
        try { observer.disconnect() } catch (_) { /* noop */ }
        clearTimeout(timeout)
        start()
    }

    const observer = new MutationObserver(() => {
        if (findAnchor()) finish()
    })
    observer.observe(document.body, {childList: true, subtree: true})

    const timeout = setTimeout(finish, HARD_TIMEOUT_MS)
})()
