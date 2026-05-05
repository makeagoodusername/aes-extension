"use strict"

/**
 * Competitor Outline runner — Refresh-button entry point for the
 * outline panel. Refreshes the deepest cached layer that's available
 * in the current page context, then signals the panel to rebuild.
 *
 * Two execution modes:
 *
 *   1. Page has heavy scrapers loaded (any competitor-intel page):
 *      walk tracked enterprises and re-scrape each via
 *      `AesCompetitorEnterpriseScraper` so the fleetByType, hubs, and
 *      routeFootprint get refreshed.
 *
 *   2. Page only has the dashboard scope (most common, since the tile
 *      lives on /app/enterprise/dashboard*): the rebuild step alone is
 *      enough — the aggregator picks up whatever the user has
 *      scraped on other pages. The runner becomes effectively a no-op
 *      pass-through, with a console hint pointing the user to the
 *      competitor-intel pages where the heavy scrapers live.
 */
class AesCompetitorOutlineRunner {
    /**
     * @param {object} args
     * @param {string} args.server
     * @param {Array<string>} [args.enterpriseIds] subset to refresh
     * @param {function}     [args.onProgress]
     */
    static async runForServer(args) {
        const server = args && args.server
        if (!server) return {success: false, reason: "no server"}
        const onProgress = typeof (args && args.onProgress) === "function"
            ? args.onProgress
            : null

        if (typeof AesCompetitorEnterpriseScraper === "undefined") {
            // Heavy scrapers absent — nothing to do beyond signalling
            // that the cached aggregator output should rebuild.
            console.info("[AES competitor-outline] runner: scraper not loaded on this page; "
                + "panel will rebuild from cached storage. Visit /app/info/enterprises/* "
                + "to scrape fresh data.")
            return {success: true, refreshed: 0, mode: "cache-only"}
        }

        // Walk cached enterprises and refresh in bulk. When the caller
        // passes explicit ids that's a force-refresh; when we discover ids
        // ourselves, only re-scrape records past the deep TTL so a refresh
        // click on a fresh dataset doesn't replay every fetch.
        let ids
        if (args && Array.isArray(args.enterpriseIds) && args.enterpriseIds.length) {
            ids = args.enterpriseIds
        } else {
            const settings = (typeof AesCompetitorSettings !== "undefined")
                ? await AesCompetitorSettings.load() : null
            const ttlMs = (typeof AesCompetitorSettings !== "undefined")
                ? AesCompetitorSettings.enterpriseDeepTtlMs(settings) : 0
            ids = await AesCompetitorOutlineRunner._listEnterpriseIds(server, ttlMs)
        }
        if (!ids.length) return {success: true, refreshed: 0, mode: "no-cache"}

        const scraper = new AesCompetitorEnterpriseScraper(server)
        let refreshed = 0
        try {
            await scraper.bulkScrape(ids, {
                concurrency: 2,
                staggerMs:   1000,
                onProgress: (p) => {
                    refreshed = p.done || refreshed
                    if (onProgress) {
                        try { onProgress(p) } catch (e) { /* noop */ }
                    }
                }
            })
        } catch (e) {
            console.warn("[AES competitor-outline] runner: bulkScrape failed", e)
            return {success: false, reason: String(e), refreshed}
        }
        return {success: true, refreshed: refreshed || ids.length, mode: "deep"}
    }

    static async _listEnterpriseIds(server, staleTtlMs) {
        const all = await chrome.storage.local.get(null)
        const prefix = "competitorIntel:enterprise:" + server + ":"
        const out = []
        const filterStale = staleTtlMs > 0 && typeof AesCompetitorStore !== "undefined"
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const id = k.substring(prefix.length)
            if (!id) continue
            if (filterStale && !AesCompetitorStore.isExpired(all[k], staleTtlMs)) continue
            out.push(id)
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.AesCompetitorOutlineRunner = AesCompetitorOutlineRunner
}
