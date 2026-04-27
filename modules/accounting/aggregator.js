/**
 * Reads every chrome.storage.local source the accounting calculator needs and
 * returns a normalised ledger. Pure-function side: no calculations, only data
 * fetch + shape coercion. Profitability cuts in `profitability-cuts.js`
 * consume the ledger.
 *
 * Data sources, all already persisted by other AES modules:
 *
 *   - `routeAssistant:topRoutes:<HUB>` — slim row snapshot auto-published by
 *     route-assistant on every panel render (panel.js `_publishTopRoutes`).
 *     Carries destIata, distanceKm, weeklyFlights, profitPerWeek, status,
 *     paxScore, cargoScore, ourPaxShare per route. One blob per hub the user
 *     has visited. We read every key matching the prefix, indexed by HUB.
 *   - `<server><airline>aircraftFlights<aircraftId>` — per-tail cumulative
 *     profit + flight list, written by content_aircraftFlights.js.
 *   - `<server><airline>accounting:income:<weekId>` (latest only) — actual
 *     income statement totals from slice 1.
 *   - `<server><airline>accounting:{leasing,capital,assets,cashflow}` — slice
 *     2 sister-page records (table-shaped, one blob per page).
 *
 * Missing primitives that would unlock more cuts (deferred to a later slice):
 *   - perClass (Y/C/F/Cargo) breakdowns are not in topRoutes — needs a
 *     `routeAssistant:topRoutes:perClass:<HUB>` companion snapshot.
 *   - Aircraft type per route (for hub × type joins) — needs the same.
 *   - Aircraft-to-route mapping for byTail RASK needs schedule + fleet.
 *
 * The aggregator silently absorbs missing sources: a ledger with zero hubs
 * or zero tails is still a valid input to the cuts (they emit empty cards
 * with "no data yet" messages).
 */
class AccountingAggregator {
    static TOP_ROUTES_PREFIX = "routeAssistant:topRoutes:"

    /**
     * @param {string} server
     * @param {string} airline
     * @returns {Promise<object>} {hubs, routes, aircraft, periodActuals, sisters, scrapedAt}
     */
    static async loadUnifiedLedger(server, airline) {
        const ledger = {
            scrapedAt: Date.now(),
            hubs: [],
            routes: [],
            aircraft: [],
            periodActuals: null,
            sisters: {leasing: null, capital: null, assets: null, cashflow: null}
        }
        if (!server || !airline) return ledger

        const allKeys = await AccountingAggregator._listAllKeys()

        const topRouteKeys = allKeys.filter(k =>
            k.startsWith(AccountingAggregator.TOP_ROUTES_PREFIX) &&
            k !== "routeAssistant:topRoutes"
        )
        const aircraftKeys = allKeys.filter(k =>
            k.startsWith(server + airline) && k.includes("aircraftFlights") &&
            !k.includes("accounting:")
        )

        const [topRouteData, aircraftData, latestPeriod, sisters, index] = await Promise.all([
            AccountingAggregator._readKeys(topRouteKeys),
            AccountingAggregator._readKeys(aircraftKeys),
            AccountingSnapshotStore.loadLatest(server, airline),
            AccountingSnapshotStore.loadAllSisters(server, airline),
            AccountingSnapshotStore.loadIndex(server, airline)
        ])
        ledger.snapshotIndexCount = index.length

        for (const [key, blob] of Object.entries(topRouteData)) {
            if (!blob || !Array.isArray(blob.rows)) continue
            const hub = key.substring(AccountingAggregator.TOP_ROUTES_PREFIX.length)
            ledger.hubs.push({
                hub,
                server: blob.server || null,
                scrapedAt: blob.scrapedAt || null,
                count: blob.rows.length
            })
            for (const r of blob.rows) {
                ledger.routes.push({
                    hub,
                    destIata: r.destIata || null,
                    destName: r.destName || null,
                    distanceKm: AccountingAggregator._numOrNull(r.distanceKm),
                    weeklyFlights: AccountingAggregator._numOrNull(r.weeklyFlights),
                    profitPerWeek: AccountingAggregator._numOrNull(r.profitPerWeek),
                    paxScore: AccountingAggregator._numOrNull(r.paxScore),
                    cargoScore: AccountingAggregator._numOrNull(r.cargoScore),
                    ourPaxShare: AccountingAggregator._numOrNull(r.ourPaxShare),
                    status: r.status || null,
                    score: AccountingAggregator._numOrNull(r.score),
                    snapshotAt: blob.scrapedAt || null
                })
            }
        }

        for (const [, rec] of Object.entries(aircraftData)) {
            if (!rec || !rec.aircraftId) continue
            ledger.aircraft.push({
                aircraftId: rec.aircraftId,
                registration: rec.registration || null,
                equipment: rec.equipment || null,
                profit: AccountingAggregator._numOrNull(rec.profit),
                flightCount: Array.isArray(rec.flights) ? rec.flights.length : null,
                finishedFlights: AccountingAggregator._numOrNull(rec.finishedFlights),
                totalFlights: AccountingAggregator._numOrNull(rec.totalFlights),
                date: rec.date || null
            })
        }

        if (latestPeriod && latestPeriod.income?.payload?.totals) {
            ledger.periodActuals = {
                weekId: latestPeriod.weekId,
                totals: latestPeriod.income.payload.totals,
                rows: latestPeriod.income.payload.rows || [],
                scrapedAt: latestPeriod.income.scrapedAt
            }
            ledger._latestIncomeRows = latestPeriod.income.payload.rows || []
        }
        ledger.sisters = sisters || ledger.sisters

        return ledger
    }

    static async _listAllKeys() {
        const all = await chrome.storage.local.get(null)
        return Object.keys(all || {})
    }

    static async _readKeys(keys) {
        if (!keys.length) return {}
        return await chrome.storage.local.get(keys)
    }

    static _numOrNull(v) {
        const n = Number(v)
        return Number.isFinite(n) ? n : null
    }
}
