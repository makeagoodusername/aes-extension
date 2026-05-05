"use strict"

/**
 * Host for the Competitor Intelligence enterprise panel — runs the
 * passive-scrape lifecycle on `/app/info/enterprises/<id>` and mounts
 * `AesCompetitorEnterprisePanel`.
 *
 * Coexists with the legacy `content_enterpriceOverview.js` (which writes
 * `<server><airlineId>competitorMonitoring`). Distinct DOM container, no
 * shared storage keys.
 */
class AesCompetitorEnterpriseHost {
    constructor() {
        this._panel = null
        this._enterpriseId = null
        this._server = null
        this._settings = null
    }

    async mount() {
        this._enterpriseId = AesCompetitorEnterpriseHost._extractEnterpriseId()
        if (!this._enterpriseId) {
            console.warn("[AES competitor-intel] no enterpriseId in URL; skipping")
            return
        }
        this._server = AES.getServerName()
        if (!this._server) {
            console.warn("[AES competitor-intel] no server name; skipping")
            return
        }

        this._settings = await AesCompetitorSettings.load()
        const settings = this._settings
        const ttlMs = AesCompetitorSettings.enterpriseDeepTtlMs(settings)
        let cached = await AesCompetitorStore.loadEnterprise(this._server, this._enterpriseId)
        const stale = !cached || AesCompetitorStore.isExpired(cached, ttlMs)

        if (stale && settings.autoScrapeOnVisit) {
            try {
                cached = await this._scrapeAndSave()
            } catch (err) {
                // Don't write a stub: a `{hubs: [], routeFootprint: []}`
                // record stamped with a fresh `scrapedAt` would survive the
                // deep TTL and suppress every retry until then. Leaving
                // `cached` null lets the next visit retry; the aggregator's
                // null-safe profile is already what the panel renders here.
                console.warn("[AES competitor-intel] enterprise scrape failed:", err)
            }
        }

        const profile = await AesCompetitorAggregator.buildCompetitorProfile({
            server: this._server,
            enterpriseId: this._enterpriseId
        })

        this._panel = new AesCompetitorEnterprisePanel({
            host: this,
            settings
        })
        this._panel.render(profile)
    }

    async resync() {
        try {
            await this._scrapeAndSave()
            const profile = await AesCompetitorAggregator.buildCompetitorProfile({
                server: this._server,
                enterpriseId: this._enterpriseId
            })
            if (this._panel) this._panel.render(profile)
            return profile
        } catch (err) {
            console.warn("[AES competitor-intel] resync failed:", err)
            return null
        }
    }

    async _scrapeAndSave() {
        const scraper = new AesCompetitorEnterpriseScraper(this._server)
        return await scraper.scrape(this._enterpriseId)
    }

    /**
     * Bulk Sync now: refresh this enterprise (meta + deep) AND every hub
     * airport in its `hubs[]` not already fresh per the airport TTL. Hub
     * airports are scraped through the airport-host helper so the saved
     * record is the same shape as a passive visit.
     */
    bulkSync(onProgress) {
        const settings = this._settings
        const concurrency = (settings && settings.scan && settings.scan.concurrency) || 3
        const staggerMs   = (settings && settings.scan && settings.scan.staggerMs) || 800
        const scanner = new AesCompetitorBulkScanner({concurrency, staggerMs})

        const promise = (async () => {
            const enterpriseRec = await this._scrapeAndSave()
            const hubs = (enterpriseRec && enterpriseRec.hubs) || []

            const airportIds = []
            for (const h of hubs) {
                if (h.airportId) airportIds.push(h.airportId)
            }

            const airportTtlMs = AesCompetitorSettings.airportTtlMs(settings)
            const cached = await AesCompetitorStore.bulkLoadAirports(this._server, airportIds)
            const stale = airportIds.filter(id => {
                const rec = cached.get(String(id))
                return !rec || AesCompetitorStore.isExpired(rec, airportTtlMs)
            })

            const jobs = stale.map(id => ({
                label: "airport #" + id,
                run: () => AesCompetitorAirportHost._scrapeAndSave(this._server, id)
            }))

            await scanner.run(jobs, onProgress)

            const profile = await AesCompetitorAggregator.buildCompetitorProfile({
                server: this._server,
                enterpriseId: this._enterpriseId
            })
            if (this._panel) this._panel.render(profile)
            return profile
        })()

        return {scanner, promise}
    }

    static _extractEnterpriseId() {
        const m = /\/app\/info\/enterprises\/(\d+)/.exec(window.location.pathname)
        return m ? m[1] : null
    }
}
