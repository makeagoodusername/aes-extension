"use strict"

/**
 * Content-script wrapper that refreshes the alliance:overview cache
 * whenever the user visits /app/alliance. Mirrors the live-capture
 * pattern used by content_markets.js (markets-page-scraper).
 */
;(function aesAllianceLiveCapture() {
    if (typeof AllianceOverviewScraper === "undefined") return
    let server = ""
    try { server = AES.getServerName() } catch (_) { /* noop */ }
    if (!server) return

    setTimeout(() => {
        try {
            new AllianceOverviewScraper(server).scrape().catch(err => {
                console.warn("[AES alliance] scrape rejected:", err)
            })
        } catch (e) {
            console.warn("[AES alliance] scrape threw:", e)
        }
    }, 1500)
})()
