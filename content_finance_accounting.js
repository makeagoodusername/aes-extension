"use strict"

/**
 * Entrypoint for the Accounting feature on `/app/finance/accounting/{0,1,2}`.
 *
 * Captures the active tab on mount and persists it to chrome.storage.local
 * via AccountingSnapshotStore, then renders the AES Accounting panel after
 * the existing AS panel on the page. Re-mounts on Wicket DOM swaps (tab
 * switches) so each tab visit gets captured.
 *
 * Mirrors `content_fleetHub.js`'s MutationObserver pattern: wait for the
 * page's anchor element to settle, then run; fall back to a hard timeout
 * so a partial render still gets the panel.
 */
;(function () {
    const HARD_TIMEOUT_MS = 5000

    function findAnchor() {
        return document.querySelector(".income-statement")
            || document.querySelector(".tab-content .tab-pane.active table")
            || document.querySelector("h1 + .as-panel")
    }

    function start() {
        const panel = new AccountingPanel()
        panel.mount().catch(err => {
            console.warn("[AES Accounting] mount failed", err)
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
