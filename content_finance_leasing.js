"use strict"

/**
 * Captures `/app/finance/leasing` into the `accounting:leasing` sister record.
 * Slice 2 ships a generic table-extractor; once a leasing-page capture is
 * taken, this can be replaced by a typed lease-contract parser.
 */
;(function () {
    const HARD_TIMEOUT_MS = 5000

    function findAnchor() {
        return document.querySelector(".tab-pane.active table")
            || document.querySelector("table.table")
            || document.querySelector("h1 + .as-panel")
    }

    async function start() {
        try {
            const server = AES.getServerName()
            const airline = AES.getAirlineIdentity()
            if (!server || !airline) return
            const scraped = AccountingSisterScraper.scrape("leasing")
            if (!scraped) return
            await AccountingSnapshotStore.saveSister(server, airline, "leasing", scraped)
        } catch (err) {
            console.warn("[AES Accounting] leasing capture failed", err)
        }
    }

    if (findAnchor()) { start(); return }
    let done = false
    const finish = () => {
        if (done) return
        done = true
        try { observer.disconnect() } catch (_) {}
        clearTimeout(timeout)
        start()
    }
    const observer = new MutationObserver(() => { if (findAnchor()) finish() })
    observer.observe(document.body, {childList: true, subtree: true})
    const timeout = setTimeout(finish, HARD_TIMEOUT_MS)
})()
