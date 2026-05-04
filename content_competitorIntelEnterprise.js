"use strict"

/**
 * Entrypoint for the Competitor Intelligence enterprise panel on
 * `/app/info/enterprises/<id>`. Mounts an idempotent panel showing the
 * competitor's profile card (banner, alliance, base country), fleet summary,
 * hubs grouped by country, and top routes derived from RA market records.
 *
 * Coexists with the legacy `content_enterpriseOverview.js` (which writes the
 * `<server><airlineId>competitorMonitoring` storage key) by mounting under a
 * distinct DOM node. The legacy script's anchor is `.container-fluid:eq(2)
 * h2`; our panel mounts after the same heading via `:scope` selectors but
 * inserts a sibling node that the legacy module won't touch.
 */
;(function () {
    const HARD_TIMEOUT_MS = 5000

    function findAnchor() {
        const all = document.querySelectorAll(".container-fluid")
        if (all.length >= 3) {
            const heading = all[2].querySelector("h2")
            if (heading) return heading
        }
        return document.querySelector("h1 + .as-panel")
            || document.querySelector(".container-fluid .as-panel")
    }

    function start() {
        if (typeof AesCompetitorEnterpriseHost === "undefined") {
            console.warn("[AES competitor-intel] enterprise host not loaded")
            return
        }
        const host = new AesCompetitorEnterpriseHost()
        host.mount().catch(err => {
            console.warn("[AES competitor-intel] enterprise mount failed", err)
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
