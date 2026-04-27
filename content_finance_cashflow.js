"use strict"

/**
 * Captures `/action/enterprise/schedule` (cash-flow page) into the
 * `accounting:cashflow` sister record. The endpoint may return either HTML
 * (rendered as a normal AS page) or JSON (XHR consumer); we branch on
 * `Content-Type` is unavailable from a content script, so we instead test for
 * any parseable HTML structure first and fall back to capturing the raw text
 * if the body is non-HTML JSON. Sharper parsing once a capture is taken.
 */
;(function () {
    const HARD_TIMEOUT_MS = 5000

    function findAnchor() {
        return document.querySelector(".tab-pane.active table")
            || document.querySelector("table.table")
            || document.querySelector("h1 + .as-panel")
            || document.querySelector("body > pre")
            || document.body
    }

    async function start() {
        try {
            const server = AES.getServerName()
            const airline = AES.getAirlineIdentity()
            if (!server || !airline) return

            let scraped = AccountingSisterScraper.scrape("cashflow")
            if (!scraped) {
                const pre = document.querySelector("body > pre")
                const text = pre ? pre.textContent : (document.body?.innerText || "")
                if (!text || text.trim().length < 2) return
                scraped = {
                    type: "cashflow",
                    rawText: text.slice(0, 100000),
                    isJson: text.trim().startsWith("{") || text.trim().startsWith("["),
                    tables: [],
                    scrapedAt: Date.now()
                }
            }
            await AccountingSnapshotStore.saveSister(server, airline, "cashflow", scraped)
        } catch (err) {
            console.warn("[AES Accounting] cashflow capture failed", err)
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
