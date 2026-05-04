"use strict"

/**
 * Outline aggregator for the Competitor Intelligence module.
 *
 * Joins the four competitor-data stores into a single competitor-centric
 * tree the outline panel renders directly:
 *
 *   competitorIntel:enterprise:<server>:<id>          — identity, alliance,
 *                                                       fleet, fleetByType,
 *                                                       routeFootprint
 *   competitorIntel:edge:<server>:<HUB>-<DEST>        — per-pair shares
 *   routeAssistant:markets:competitors:<HUB>-<DEST>   — per-flight price/type
 *   routeAssistant:markets:marketShare:<HUB>-<DEST>   — share leaderboard
 *   routeAssistant:markets:ownPricing:<HUB>-<DEST>    — our prices on the lane
 *   routeAssistant:ors:<HUB>-<DEST>                   — ORS leaderboard
 *
 * For each competitor × route the aggregator produces:
 *   {
 *     hub, dest, distanceKm,
 *     ours:   { hasFlights, price, freq, ors, estProfitPerWeek },
 *     theirs: { price, freq, seats, aircraftType, aircraftAgeMonths,
 *               marketSharePct, ors, estProfitPerWeek, freshness },
 *     counter: AesCounterAircraft.recommend(...)
 *   }
 *
 * Counter-aircraft recommendation is delegated to `AesCounterAircraft`;
 * income estimation uses `RouteAssistantCompetitorIncome`. Both are
 * called per-route. All storage I/O is batched.
 */
class AesCompetitorOutlineAggregator {
    /**
     * Build the outline view payload.
     *
     * @param {object} args
     * @param {string} args.server                — current AS server.
     * @param {Array<string>} [args.enterpriseIds] — optional subset; defaults
     *                                               to every cached competitor
     *                                               on the server.
     * @param {object} [args.economics]           — RA economics block; falls
     *                                               back to RouteAssistantSettingsStore
     *                                               defaults when omitted.
     * @param {Array<object>} [args.ourFleet]     — optional pre-enriched fleet
     *                                               rows; otherwise loaded
     *                                               via FleetHubAircraftAggregator.
     * @returns {Promise<object>}
     */
    static async build(args) {
        const server = args && args.server
        if (!server) {
            return AesCompetitorOutlineAggregator._emptyResult(server, "no server")
        }

        // 1. Resolve which enterprises to include.
        const enterpriseRecords = await AesCompetitorOutlineAggregator
            ._loadEnterpriseRecords(server, args && args.enterpriseIds)
        if (!enterpriseRecords.length) {
            const empty = AesCompetitorOutlineAggregator._emptyResult(server, "no competitor records cached")
            const airline = args && args.airline ? String(args.airline) : ""
            empty.airline = airline
            if (airline) {
                const ourFinancials = await AesCompetitorOutlineAggregator
                    ._loadOurFinancials(server, airline)
                if (ourFinancials) empty.ourFinancials = ourFinancials
            }
            return empty
        }

        const relationshipById = await AesCompetitorOutlineAggregator
            ._loadRelationships(enterpriseRecords)

        // 2. Enumerate every observed (enterprise, hub, dest) we'll need to
        //    look up. Partner/self rows are retained in the payload with
        //    includedAsRival=false so the panel can explain exclusions.
        const pairKeys = new Set()
        for (const enterprise of enterpriseRecords) {
            const footprint = enterprise.routeFootprint || []
            for (const r of footprint) {
                if (!r || !r.hub || !r.dest) continue
                pairKeys.add(_pairKey(r.hub, r.dest))
            }
        }

        // 3. Bulk-load all RA + edge keys in one round-trip.
        const storageBundle = await AesCompetitorOutlineAggregator
            ._bulkLoadRouteData(server, pairKeys)

        // 4. Build the spec resolver lookup. typeIds come from the markets
        //    record's competitor flights, so we collect those first.
        const typeIdSet = new Set()
        for (const rec of Object.values(storageBundle.competitors)) {
            if (!rec || !Array.isArray(rec.competitors)) continue
            for (const c of rec.competitors) {
                if (c && c.typeId != null) typeIdSet.add(String(c.typeId))
            }
        }
        const specsByTypeId = await AesCompetitorOutlineAggregator
            ._loadTypeSpecs(typeIdSet)

        // 5. Distance lookups for every pair (cached on RA's airport meta).
        const distanceByPair = await AesCompetitorOutlineAggregator
            ._loadDistances(pairKeys)

        // 5b. Per-route paxScore (from RA's topRoutes cache) so the counter
        //     recommender can score candidates against the lane's actual
        //     demand instead of the neutral default.
        const paxScoreByPair = await AesCompetitorOutlineAggregator
            ._loadPaxScoreByPair(pairKeys)

        // 6. Our fleet (for the counter scorer's existing-tail pass).
        const ourFleetEnriched = Array.isArray(args && args.ourFleet)
            ? args.ourFleet
            : await AesCompetitorOutlineAggregator._loadOurFleet(server)

        // 7. Economics.
        const economics = args && args.economics
            ? args.economics
            : await AesCompetitorOutlineAggregator._loadEconomics()

        const airline = args && args.airline
            ? String(args.airline)
            : ""
        const ourFinancials = airline
            ? await AesCompetitorOutlineAggregator._loadOurFinancials(server, airline)
            : null

        // 8. Walk the tree.
        const competitors = []
        for (const enterprise of enterpriseRecords) {
            const eid = String(enterprise.enterpriseId || "")
            const competitorRow = AesCompetitorOutlineAggregator._buildCompetitorRow({
                server,
                enterprise,
                relationship: relationshipById.get(eid)
                    || AesCompetitorOutlineAggregator._relationshipFromAffiliation(null, eid),
                storageBundle,
                specsByTypeId,
                distanceByPair,
                paxScoreByPair,
                ourFleetEnriched,
                economics
            })
            if (competitorRow) competitors.push(competitorRow)
        }

        // 9. Threat scoreboard sort, with included rivals first.
        competitors.sort((a, b) => {
            const ar = AesCompetitorOutlineAggregator._isIncludedRivalRow(a) ? 1 : 0
            const br = AesCompetitorOutlineAggregator._isIncludedRivalRow(b) ? 1 : 0
            if (ar !== br) return br - ar
            const t = (b.summary.threatScore || 0) - (a.summary.threatScore || 0)
            if (t !== 0) return t
            return String(a.name || "").localeCompare(String(b.name || ""))
        })

        const rivals = competitors.filter(c =>
            AesCompetitorOutlineAggregator._isIncludedRivalRow(c))
        const excluded = competitors.length - rivals.length
        const result = {
            scrapedAt:    Date.now(),
            server:       String(server),
            airline:      airline,
            competitors:  competitors,
            observedCount: competitors.length,
            rivalCount:    rivals.length,
            excludedCount: excluded,
            totalRoutes:  rivals.reduce((s, c) => s + c.summary.totalRoutes, 0),
            totalObservedRoutes: competitors.reduce((s, c) => s + c.summary.totalRoutes, 0),
            uncontested:  rivals.reduce((s, c) =>
                s + (c.summary.uncontestedRoutes || 0), 0)
        }
        if (ourFinancials) result.ourFinancials = ourFinancials
        return result
    }

    static _emptyResult(server, reason) {
        return {
            scrapedAt:   Date.now(),
            server:      String(server || ""),
            competitors: [],
            observedCount: 0,
            rivalCount: 0,
            excludedCount: 0,
            totalRoutes: 0,
            totalObservedRoutes: 0,
            uncontested: 0,
            note:        reason || null
        }
    }

    // ------------------------------------------------------------------
    // Storage loaders
    // ------------------------------------------------------------------

    static async _loadEnterpriseRecords(server, ids) {
        const all = await chrome.storage.local.get(null)
        const prefix = "competitorIntel:enterprise:" + server + ":"
        const byId = new Map()
        const wantSet = (Array.isArray(ids) && ids.length)
            ? new Set(ids.map(String))
            : null
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (!rec || typeof rec !== "object") continue
            const id = String(rec.enterpriseId || k.slice(prefix.length))
            if (wantSet && !wantSet.has(id)) continue
            byId.set(id, rec.enterpriseId ? rec : Object.assign({}, rec, {enterpriseId: id}))
        }
        if (typeof AesCompetitorStore !== "undefined"
                && typeof AesCompetitorStore.loadLegacyMonitoring === "function") {
            const legacy = await AesCompetitorStore.loadLegacyMonitoring(server, all)
            for (const rec of legacy) {
                if (!rec || !rec.enterpriseId) continue
                const id = String(rec.enterpriseId)
                if (wantSet && !wantSet.has(id)) continue
                if (byId.has(id)) {
                    byId.set(id, AesCompetitorOutlineAggregator
                        ._mergeEnterpriseRecords(byId.get(id), rec))
                } else {
                    byId.set(id, rec)
                }
            }
        }
        const out = Array.from(byId.values())
        // Stable order: name asc when known, then enterpriseId.
        out.sort((a, b) => {
            const na = String(a.name || "").toLowerCase()
            const nb = String(b.name || "").toLowerCase()
            if (na !== nb) return na < nb ? -1 : 1
            return String(a.enterpriseId).localeCompare(String(b.enterpriseId))
        })
        return out
    }

    static _mergeEnterpriseRecords(primary, secondary) {
        if (!primary) return secondary || null
        if (!secondary) return primary
        const merged = Object.assign({}, secondary, primary)

        const fleet = Object.assign({},
            secondary.fleet && typeof secondary.fleet === "object" ? secondary.fleet : {},
            primary.fleet && typeof primary.fleet === "object" ? primary.fleet : {})
        merged.fleet = Object.keys(fleet).length ? fleet : (primary.fleet || secondary.fleet || null)

        merged.fleetByType = AesCompetitorOutlineAggregator
            ._preferNonEmptyArray(primary.fleetByType, secondary.fleetByType)
        merged.hubs = AesCompetitorOutlineAggregator
            ._mergeHubs(primary.hubs, secondary.hubs)
        merged.routeFootprint = AesCompetitorOutlineAggregator
            ._mergeRouteFootprints(primary.routeFootprint, secondary.routeFootprint)

        const sources = []
        for (const src of [primary.source, secondary.source]) {
            if (src && sources.indexOf(src) < 0) sources.push(src)
        }
        if (sources.length > 1) {
            merged.source = sources.join("+")
            merged.sources = sources
        } else if (sources.length === 1) {
            merged.source = sources[0]
        }
        merged.legacyTracking = !!(primary.legacyTracking || secondary.legacyTracking)
        merged.scrapedAt = Math.max(
            Number(primary.scrapedAt) || 0,
            Number(secondary.scrapedAt) || 0
        ) || primary.scrapedAt || secondary.scrapedAt || null

        const notes = []
        for (const n of [primary.parserNotes, secondary.parserNotes]) {
            if (n && notes.indexOf(n) < 0) notes.push(n)
        }
        if (notes.length) merged.parserNotes = notes.join("; ")

        return merged
    }

    static _preferNonEmptyArray(primary, secondary) {
        if (Array.isArray(primary) && primary.length) return primary
        if (Array.isArray(secondary) && secondary.length) return secondary
        if (Array.isArray(primary)) return primary
        if (Array.isArray(secondary)) return secondary
        return []
    }

    static _mergeHubs(primary, secondary) {
        const map = new Map()
        const add = (rows) => {
            for (const h of rows || []) {
                if (!h) continue
                const id = String(h.iata || h.airportIata || h.airportId || "").toUpperCase()
                if (!id) continue
                map.set(id, Object.assign({}, map.get(id) || {}, h))
            }
        }
        add(secondary)
        add(primary)
        return Array.from(map.values())
            .sort((a, b) => (b.weeklyDepartures || 0) - (a.weeklyDepartures || 0))
    }

    static _mergeRouteFootprints(primary, secondary) {
        const map = new Map()
        const add = (rows) => {
            for (const r of rows || []) {
                if (!r || !r.hub || !r.dest) continue
                const key = _pairKey(r.hub, r.dest)
                const prev = map.get(key) || {}
                const next = Object.assign({}, prev, r, {
                    hub: String(r.hub).toUpperCase(),
                    dest: String(r.dest).toUpperCase()
                })
                if (!isFinite(next.weeklyFlights) && isFinite(prev.weeklyFlights)) {
                    next.weeklyFlights = prev.weeklyFlights
                }
                map.set(key, next)
            }
        }
        add(secondary)
        add(primary)
        return Array.from(map.values())
            .sort((a, b) => (b.weeklyFlights || 0) - (a.weeklyFlights || 0))
    }

    static async _loadRelationships(enterpriseRecords) {
        const ids = (enterpriseRecords || [])
            .map(e => e && e.enterpriseId != null ? String(e.enterpriseId) : "")
            .filter(Boolean)
        const map = new Map()
        if (!ids.length) return map

        let byEnterpriseId = null
        let classifiedMany = null
        const store = (typeof AesCanopyAffiliations !== "undefined" && AesCanopyAffiliations)
            || (typeof window !== "undefined" && window.AesCanopyAffiliations)
            || null
        if (store) {
            try {
                if (typeof store.load === "function") {
                    const block = await store.load()
                    byEnterpriseId = block && block.byEnterpriseId || {}
                } else if (typeof store.classifyMany === "function") {
                    classifiedMany = await store.classifyMany(ids)
                }
            } catch (e) {
                console.warn("[AES competitor-intel] affiliation classification failed", e)
            }
        }

        for (const id of ids) {
            let rec = null
            if (byEnterpriseId && byEnterpriseId[id]) rec = byEnterpriseId[id]
            else if (classifiedMany && typeof classifiedMany.get === "function") rec = classifiedMany.get(id)
            map.set(id, AesCompetitorOutlineAggregator._relationshipFromAffiliation(rec, id))
        }
        return map
    }

    static async _bulkLoadRouteData(server, pairKeys) {
        const out = {edges: {}, competitors: {}, marketShare: {}, ownPricing: {}, ors: {}}
        if (!pairKeys || !pairKeys.size) return out
        const keys = []
        for (const pk of pairKeys) {
            keys.push("competitorIntel:edge:" + server + ":" + pk)
            keys.push("routeAssistant:markets:competitors:" + pk)
            keys.push("routeAssistant:markets:marketShare:" + pk)
            keys.push("routeAssistant:markets:ownPricing:" + pk)
            keys.push("routeAssistant:ors:" + pk)
        }
        const data = await chrome.storage.local.get(keys)
        for (const pk of pairKeys) {
            out.edges[pk]       = data["competitorIntel:edge:" + server + ":" + pk] || null
            out.competitors[pk] = data["routeAssistant:markets:competitors:" + pk] || null
            out.marketShare[pk] = data["routeAssistant:markets:marketShare:" + pk] || null
            out.ownPricing[pk]  = data["routeAssistant:markets:ownPricing:" + pk]  || null
            out.ors[pk]         = data["routeAssistant:ors:" + pk]                 || null
        }
        try {
            const routes = Array.from(pairKeys).map(pk => {
                const parts = String(pk).split("-")
                return {hub: parts[0], dest: parts[1]}
            }).filter(r => r.hub && r.dest)
            if (typeof RouteAssistantOrsIntelligence !== "undefined"
                    && typeof RouteAssistantOrsIntelligence.bulkLoadRecords === "function") {
                const map = await RouteAssistantOrsIntelligence.bulkLoadRecords(routes, {maxAgeDays: null})
                map.forEach((rec, pk) => { if (rec) out.ors[pk] = rec })
            } else if (typeof RouteAssistantOrsScraper !== "undefined"
                    && typeof RouteAssistantOrsScraper.bulkLoadCache === "function") {
                const map = await RouteAssistantOrsScraper.bulkLoadCache(routes, {maxAgeDays: null})
                map.forEach((rec, pk) => { if (rec) out.ors[pk] = rec })
            }
        } catch (e) {
            console.warn("[AES competitor-intel] ORS facade fallback failed", e)
        }
        return out
    }

    static async _loadTypeSpecs(typeIdSet) {
        const map = new Map()
        if (!typeIdSet || !typeIdSet.size) return map
        // Prefer RA's persistent type-specs cache when available.
        if (typeof RouteAssistantTypeSpecsStore !== "undefined"
            && typeof RouteAssistantTypeSpecsStore.bulkLoad === "function") {
            try {
                const ids = Array.from(typeIdSet)
                const cached = await RouteAssistantTypeSpecsStore.bulkLoad(ids)
                if (cached && typeof cached.forEach === "function") {
                    cached.forEach((spec, id) => { if (spec) map.set(String(id), spec) })
                }
            } catch (e) {
                console.warn("[AES competitor-intel] type-specs bulk load failed", e)
            }
        }
        // Fall back to chrome.storage.local under the legacy key shape used
        // by RA when the bulkLoad helper is missing.
        if (map.size < typeIdSet.size) {
            const missingKeys = []
            const idForKey = {}
            for (const id of typeIdSet) {
                if (map.has(String(id))) continue
                const k = "routeAssistant:typeSpecs:" + id
                missingKeys.push(k)
                idForKey[k] = String(id)
            }
            if (missingKeys.length) {
                const out = await chrome.storage.local.get(missingKeys)
                for (const k in out) {
                    const rec = out[k]
                    if (rec && typeof rec === "object" && rec.range != null) {
                        map.set(idForKey[k], rec)
                    }
                }
            }
        }
        return map
    }

    static async _loadDistances(pairKeys) {
        const map = new Map()
        if (!pairKeys || !pairKeys.size) return map
        // Distances live on RouteAssistantDistanceResolver under
        // routeAssistant:distance:<HUB>-<DEST>. They're directional.
        const keys = []
        for (const pk of pairKeys) keys.push("routeAssistant:distance:" + pk)
        const data = await chrome.storage.local.get(keys)
        for (const pk of pairKeys) {
            const rec = data["routeAssistant:distance:" + pk]
            if (rec && typeof rec.distanceKm === "number") map.set(pk, rec.distanceKm)
        }
        return map
    }

    static async _loadOurFleet(server) {
        if (typeof FleetHubAircraftAggregator === "undefined") return []
        try {
            // Pull the airline's stored fleet roster — pattern used by
            // fleet-hub itself: `<server><airlineCode>aircraftFleet` records.
            const all = await chrome.storage.local.get(null)
            const candidates = []
            const suffix = "aircraftFleet"
            for (const k in all) {
                if (!k.endsWith(suffix)) continue
                if (k.indexOf(server) !== 0) continue
                const rec = all[k]
                if (rec && Array.isArray(rec.fleet)) candidates.push({key: k, rec: rec})
            }
            if (!candidates.length) return []
            // Heuristic: take the largest fleet (the airline the user is
            // currently logged into typically has the most tails). Multi-
            // account users get the right tail set most of the time.
            candidates.sort((a, b) => (b.rec.fleet.length || 0) - (a.rec.fleet.length || 0))
            const winner = candidates[0]
            // Recover airlineCode from the storage key.
            const airlineCode = winner.key.substring(server.length, winner.key.length - suffix.length)
            return await FleetHubAircraftAggregator.enrich({
                server: server,
                airlineCode: airlineCode,
                fleet: winner.rec.fleet
            })
        } catch (e) {
            console.warn("[AES competitor-intel] our-fleet load failed", e)
            return []
        }
    }

    static async _loadEconomics() {
        try {
            if (typeof RouteAssistantSettingsStore !== "undefined"
                && typeof RouteAssistantSettingsStore.load === "function") {
                const settings = await RouteAssistantSettingsStore.load()
                if (settings && settings.economics) return settings.economics
            }
        } catch (e) {
            console.warn("[AES competitor-intel] economics load failed", e)
        }
        // Conservative defaults — match profit-estimator's hardcoded fallbacks.
        return {
            loadFactor:      0.75,
            loadFactorMin:   0.50,
            loadFactorMax:   0.95,
            yieldPerKm:      0.10,
            fuelCostPerHour: 2500,
            falloffYieldMultiplier: 0.85
        }
    }

    static async _loadOurFinancials(server, airline) {
        const agg = (typeof AccountingAggregator !== "undefined" && AccountingAggregator)
            || (typeof window !== "undefined" && window.AccountingAggregator)
            || null
        if (!agg || typeof agg.loadUnifiedLedger !== "function") return null
        try {
            const ledger = await agg.loadUnifiedLedger(server, airline)
            return AesCompetitorOutlineAggregator
                ._buildOurFinancialsFromLedger(server, airline, ledger)
        } catch (e) {
            console.warn("[AES competitor-intel] own accounting load failed", e)
            return null
        }
    }

    static _buildOurFinancialsFromLedger(server, airline, ledger) {
        if (!ledger || typeof ledger !== "object") return null
        const hasSnapshots = (Number(ledger.snapshotIndexCount) || 0) > 0
            || !!ledger.periodActuals
            || !!ledger.bankActuals
            || !!ledger.balanceActuals
            || AesCompetitorOutlineAggregator._hasAnySisterSnapshot(ledger.sisters)
        if (!hasSnapshots) return null

        const totals = (ledger.periodActuals && ledger.periodActuals.totals) || {}
        const revenue = AesCompetitorOutlineAggregator._totalCurrent(totals.revenue)
        const ebit = AesCompetitorOutlineAggregator._totalCurrent(totals.ebit)
        const ebt = AesCompetitorOutlineAggregator._totalCurrent(totals.ebt)
        const bankPayload = ledger.bankActuals && ledger.bankActuals.payload || {}
        const bankBalance = AesCompetitorOutlineAggregator._numOrNull(
            ledger.bankActuals && ledger.bankActuals.cashBalance != null
                ? ledger.bankActuals.cashBalance
                : bankPayload.cashBalance
        )
        const cashBalance = bankBalance != null
            ? bankBalance
            : AesCompetitorOutlineAggregator._cashFromSisters(ledger.sisters)

        const routeRows = Array.isArray(ledger.routes) ? ledger.routes : []
        const routeProfitTotal = AesCompetitorOutlineAggregator._sumFinite(
            routeRows.map(r => r && r.profitPerWeek))
        const routeLatestAt = AesCompetitorOutlineAggregator._maxFinite(
            routeRows.map(r => r && r.snapshotAt))

        const aircraftRows = Array.isArray(ledger.aircraft) ? ledger.aircraft : []
        const fleetProfitTotal = AesCompetitorOutlineAggregator._sumFinite(
            aircraftRows.map(r => r && r.profit))
        const fleetFlights = AesCompetitorOutlineAggregator._sumFinite(
            aircraftRows.map(r => r && r.finishedFlights))

        const freshnessAt = AesCompetitorOutlineAggregator._maxFinite([
            ledger.scrapedAt,
            ledger.periodActuals && ledger.periodActuals.scrapedAt,
            ledger.bankActuals && ledger.bankActuals.scrapedAt,
            ledger.balanceActuals && ledger.balanceActuals.scrapedAt,
            routeLatestAt
        ])

        return {
            basis:   "actual",
            label:   "Actual",
            source:  "accounting snapshots",
            server:  String(server || ""),
            airline: String(airline || ""),
            cashBalance: cashBalance,
            cash: {
                bankBalance: bankBalance,
                cashBalance: cashBalance,
                scrapedAt: ledger.bankActuals && ledger.bankActuals.scrapedAt || null,
                source: bankBalance != null ? "bank" : (cashBalance != null ? "cashflow" : "missing")
            },
            latest: {
                weekId: ledger.periodActuals && ledger.periodActuals.weekId || null,
                revenue: revenue,
                ebit: ebit,
                ebt: ebt,
                scrapedAt: ledger.periodActuals && ledger.periodActuals.scrapedAt || null
            },
            routes: {
                count: routeRows.length,
                totalProfitPerWeek: Math.round(routeProfitTotal),
                latestSnapshotAt: routeLatestAt || null
            },
            fleet: {
                aircraftCount: aircraftRows.length,
                totalProfit: Math.round(fleetProfitTotal),
                finishedFlights: Math.round(fleetFlights)
            },
            freshness: {
                snapshotAt: freshnessAt || null,
                incomeAt: ledger.periodActuals && ledger.periodActuals.scrapedAt || null,
                bankAt: ledger.bankActuals && ledger.bankActuals.scrapedAt || null,
                routesAt: routeLatestAt || null
            }
        }
    }

    static _hasAnySisterSnapshot(sisters) {
        if (!sisters || typeof sisters !== "object") return false
        return !!(sisters.leasing || sisters.capital || sisters.assets || sisters.cashflow)
    }

    static _relationshipFromAffiliation(rec, enterpriseId) {
        const known = ["self", "allied", "interline", "codeshare", "neutral", "adversary"]
        const kind = rec && known.indexOf(rec.kind) >= 0
            ? rec.kind
            : "unclassified"
        const includedAsRival = AesCompetitorOutlineAggregator._kindIncludedAsRival(kind)
        const label = AesCompetitorOutlineAggregator._relationshipLabel(kind)
        return {
            kind: kind,
            label: label,
            source: rec && rec.source ? String(rec.source) : "unclassified",
            includedAsRival: includedAsRival
        }
    }

    static _relationshipLabel(kind) {
        const store = (typeof AesCanopyAffiliations !== "undefined" && AesCanopyAffiliations)
            || (typeof window !== "undefined" && window.AesCanopyAffiliations)
            || null
        if (store && typeof store.kindLabel === "function" && kind !== "unclassified") {
            try { return store.kindLabel(kind) } catch (_) {}
        }
        return ({
            self:         "Kin",
            allied:       "Allied",
            interline:    "Interline",
            codeshare:    "Codeshare",
            neutral:      "Neutral",
            adversary:    "Adversary",
            unclassified: "Unclassified"
        })[kind] || "Unclassified"
    }

    static _kindIncludedAsRival(kind) {
        return kind === "neutral" || kind === "adversary" || kind === "unclassified"
    }

    static _isIncludedRivalRow(row) {
        return !!(row && row.relationship && row.relationship.includedAsRival)
    }

    // ------------------------------------------------------------------
    // Per-competitor row builder
    // ------------------------------------------------------------------

    static _buildCompetitorRow(input) {
        const enterprise = input.enterprise
        if (!enterprise) return null

        const carrierIata = enterprise.iata
            ? String(enterprise.iata).toUpperCase()
            : null
        const carrierPrefix = AesCompetitorOutlineAggregator
            ._extractCarrierPrefix(input.server, enterprise, input.storageBundle)

        const fleetByType = enterprise.fleetByType || []
        const dominantTypes = fleetByType.slice(0, 3)
            .map(f => f.typeCode + (f.count > 1 ? "×" + f.count : ""))
            .join(", ")

        const footprint = enterprise.routeFootprint || []
        const routes = []
        let weeklyFlightSum = 0
        let theirProfitLeadSum = 0
        let uncontestedRoutes = 0
        let counterableRoutes = 0
        let weAlreadyWinRoutes = 0

        for (const r of footprint) {
            if (!r || !r.hub || !r.dest) continue
            weeklyFlightSum += r.weeklyFlights || 0
            const row = AesCompetitorOutlineAggregator._buildRouteRow({
                server:        input.server,
                enterpriseId:  enterprise.enterpriseId,
                carrierIata:   carrierIata,
                carrierPrefix: carrierPrefix,
                hub:           r.hub,
                dest:          r.dest,
                weeklyFlights: r.weeklyFlights,
                fleetByType:   fleetByType,
                storageBundle: input.storageBundle,
                specsByTypeId: input.specsByTypeId,
                distanceByPair: input.distanceByPair,
                paxScoreByPair: input.paxScoreByPair,
                ourFleetEnriched: input.ourFleetEnriched,
                economics:     input.economics
            })
            if (!row) continue
            routes.push(row)

            const verdict = row.counter && row.counter.verdict
            if (verdict === "we-already-win") weAlreadyWinRoutes++
            if (verdict === "tail-available" || verdict === "buy-needed") counterableRoutes++
            if (verdict === "uncontested" && !row.ours.hasFlights) uncontestedRoutes++

            const theirP = row.theirs && row.theirs.estProfitPerWeek
            const oursP  = row.ours   && row.ours.estProfitPerWeek
            if (isFinite(theirP) && theirP > 0) {
                if (isFinite(oursP)) theirProfitLeadSum += Math.max(0, theirP - oursP)
                else                 theirProfitLeadSum += theirP
            }
        }

        // Sort routes: largest threat first (their lead vs. us, descending).
        routes.sort((a, b) => {
            const tlA = AesCompetitorOutlineAggregator._theirLead(a)
            const tlB = AesCompetitorOutlineAggregator._theirLead(b)
            return tlB - tlA
        })

        const threatScore = Math.round(theirProfitLeadSum / 1000) + uncontestedRoutes * 2
        const oldestEnterprise = enterprise.scrapedAt || null
        const oldestEdge = AesCompetitorOutlineAggregator
            ._oldestEdgeAt(input.storageBundle, footprint)
        const financials = AesCompetitorOutlineAggregator
            ._buildRivalFinancials(enterprise, routes, weeklyFlightSum)

        return {
            enterpriseId: String(enterprise.enterpriseId || ""),
            name:         enterprise.name || enterprise.enterpriseId || "",
            code:         carrierIata,
            alliance:     enterprise.alliance || null,
            baseCountry:  enterprise.baseCountry || null,
            relationship: input.relationship
                || AesCompetitorOutlineAggregator._relationshipFromAffiliation(null, enterprise.enterpriseId),
            fleet: {
                totalCount: enterprise.fleet && enterprise.fleet.aircraftCount || null,
                byType:     fleetByType
            },
            financials: financials,
            routes: routes,
            summary: {
                totalRoutes:        routes.length,
                totalWeeklyFlights: weeklyFlightSum,
                dominantTypes:      dominantTypes,
                threatScore:        threatScore,
                theirProfitLeadSum: Math.round(theirProfitLeadSum),
                uncontestedRoutes:  uncontestedRoutes,
                counterableRoutes:  counterableRoutes,
                weAlreadyWinRoutes: weAlreadyWinRoutes,
                freshness: {
                    enterpriseAt: oldestEnterprise,
                    oldestEdgeAt: oldestEdge
                },
                estimatedWeeklyProfit: financials.totalEstimatedWeeklyProfit,
                estimatedWeeklyRevenue: financials.estimatedWeeklyRouteRevenue
            }
        }
    }

    static _buildRivalFinancials(enterprise, routes, weeklyFlightSum) {
        const fleet = enterprise && enterprise.fleet && typeof enterprise.fleet === "object"
            ? enterprise.fleet
            : {}
        const publicFacts = {
            aircraft:        AesCompetitorOutlineAggregator._numOrNull(fleet.aircraftCount),
            stations:        AesCompetitorOutlineAggregator._numOrNull(fleet.stationsCount),
            employees:       AesCompetitorOutlineAggregator._numOrNull(fleet.employeeCount),
            passengers:      AesCompetitorOutlineAggregator._numOrNull(fleet.paxCarried),
            cargo:           AesCompetitorOutlineAggregator._numOrNull(fleet.cargoCarried),
            operatedFlights: AesCompetitorOutlineAggregator._numOrNull(fleet.operatedFlights),
            seatsOffered:    AesCompetitorOutlineAggregator._numOrNull(fleet.seatsOffered),
            cargoOffered:    AesCompetitorOutlineAggregator._numOrNull(fleet.cargoOffered),
            sko:             AesCompetitorOutlineAggregator._firstNum([
                fleet.sko, fleet.SKO, fleet.seatKilometersOffered, fleet.seatKmOffered
            ]),
            fko:             AesCompetitorOutlineAggregator._firstNum([
                fleet.fko, fleet.FKO, fleet.freightKilometersOffered, fleet.freightKmOffered
            ]),
            rating:          fleet.rating || null,
            weeklyFlights:   Number(weeklyFlightSum) || 0
        }

        const topProfitLanes = []
        let estimatedWeeklyRouteRevenue = 0
        let totalEstimatedWeeklyProfit = 0
        let estimatedCount = 0
        const confidenceRanks = {missing: 0, low: 1, med: 2, high: 3}
        let confidenceRank = 3
        const freshnessValues = []

        for (const r of routes || []) {
            const them = r && r.theirs || {}
            const profit = AesCompetitorOutlineAggregator._numOrNull(them.estProfitPerWeek)
            const revenue = AesCompetitorOutlineAggregator._numOrNull(them.estRevenuePerWeek)
            if (revenue != null) estimatedWeeklyRouteRevenue += revenue
            if (profit != null) {
                totalEstimatedWeeklyProfit += profit
                estimatedCount++
                topProfitLanes.push({
                    hub: r.hub,
                    dest: r.dest,
                    estimatedWeeklyProfit: Math.round(profit),
                    estimatedWeeklyRevenue: revenue != null ? Math.round(revenue) : null,
                    confidence: them.incomeConfidence || "low"
                })
            }
            const rank = confidenceRanks[them.incomeConfidence || "missing"] || 0
            if (rank < confidenceRank) confidenceRank = rank
            if (Number.isFinite(Number(them.freshnessAt))) freshnessValues.push(Number(them.freshnessAt))
        }
        topProfitLanes.sort((a, b) =>
            (b.estimatedWeeklyProfit || 0) - (a.estimatedWeeklyProfit || 0))

        const confidence = estimatedCount > 0
            ? (confidenceRank >= 3 ? "high" : confidenceRank >= 2 ? "med" : "low")
            : "missing"
        const freshnessAt = freshnessValues.length
            ? Math.min.apply(null, freshnessValues)
            : (enterprise && enterprise.scrapedAt || null)

        return {
            basis:  "estimated",
            label:  "Estimated",
            source: "public operating facts and route-derived estimates",
            publicFacts: publicFacts,
            estimatedWeeklyRouteRevenue: Math.round(estimatedWeeklyRouteRevenue),
            estimatedWeeklyRouteProfit:  Math.round(totalEstimatedWeeklyProfit),
            totalEstimatedWeeklyProfit:  Math.round(totalEstimatedWeeklyProfit),
            routeEstimateCount: estimatedCount,
            topProfitLanes: topProfitLanes.slice(0, 5),
            confidence: confidence,
            freshness: {
                enterpriseAt: enterprise && enterprise.scrapedAt || null,
                routeAt: freshnessAt
            },
            estimates: {
                estimatedWeeklyRouteRevenue: Math.round(estimatedWeeklyRouteRevenue),
                estimatedWeeklyRouteProfit:  Math.round(totalEstimatedWeeklyProfit),
                totalEstimatedWeeklyProfit:  Math.round(totalEstimatedWeeklyProfit),
                routeCountWithEstimates: estimatedCount,
                topProfitLanes: topProfitLanes.slice(0, 5),
                confidence: confidence,
                freshnessAt: freshnessAt
            }
        }
    }

    static _buildRouteRow(input) {
        const pk = _pairKey(input.hub, input.dest)
        const competitorsRec = input.storageBundle.competitors[pk]
        const marketShareRec = input.storageBundle.marketShare[pk]
        const ownPricingRec  = input.storageBundle.ownPricing[pk]
        const orsRec         = input.storageBundle.ors[pk]
        const distanceKm     = input.distanceByPair.get(pk) || null

        const theirFlights = AesCompetitorOutlineAggregator
            ._theirFlights(competitorsRec, input.carrierIata, input.carrierPrefix)
        const sharePct = AesCompetitorOutlineAggregator
            ._theirSharePct(marketShareRec, input.enterpriseId, input.carrierIata)

        // Frequency: prefer the markets-page count (it's per-direction and
        // up-to-date), but fall back to the routeFootprint count from the
        // enterprise schedule tab when markets data is missing — keeps the
        // counter-aircraft logic from misclassifying a known-active lane
        // as "uncontested".
        const observedFreq = theirFlights.length > 0
            ? theirFlights.length
            : (Number(input.weeklyFlights) > 0 ? Number(input.weeklyFlights) : 0)

        // Pick the dominant aircraft on the lane: the type that operates
        // the most flights (out of theirFlights). Ties → first seen.
        let dominantType = null
        if (theirFlights.length) {
            const byType = new Map()
            for (const f of theirFlights) {
                if (!f.typeId) continue
                const k = String(f.typeId)
                const e = byType.get(k) || {typeId: f.typeId, typeCode: f.typeCode, count: 0, totalSeats: 0, prices: []}
                e.count += 1
                if (f.availability && f.availability.totalSeats) e.totalSeats += f.availability.totalSeats
                if (isFinite(f.price)) e.prices.push(f.price)
                byType.set(k, e)
            }
            let best = null
            for (const v of byType.values()) {
                if (!best || v.count > best.count) best = v
            }
            dominantType = best
        }

        // Their displayed price = mean of observed prices on dominant type;
        // if no dominant type, use the observed price across all flights.
        let theirPrice = null
        if (dominantType && dominantType.prices.length) {
            const sum = dominantType.prices.reduce((s, p) => s + p, 0)
            theirPrice = Math.round(sum / dominantType.prices.length)
        } else if (theirFlights.length) {
            const prices = theirFlights.map(f => f.price).filter(p => isFinite(p))
            if (prices.length) {
                const sum = prices.reduce((s, p) => s + p, 0)
                theirPrice = Math.round(sum / prices.length)
            }
        }

        const theirSeatsPerFlight = dominantType && dominantType.count > 0
            ? Math.round(dominantType.totalSeats / dominantType.count)
            : null

        // Aircraft age: best signal is enterprise.fleetByType matching the
        // dominant typeId. When the competitor flies multiple types on the
        // route, we use the dominant type's fleet-wide avg age as the
        // proxy for THIS lane.
        let aircraftAgeMonths = null
        if (dominantType && dominantType.typeId) {
            const fleetEntry = (input.fleetByType || [])
                .find(f => String(f.typeId) === String(dominantType.typeId))
            if (fleetEntry && fleetEntry.avgAgeMonths != null) {
                aircraftAgeMonths = fleetEntry.avgAgeMonths
            }
        }

        // Their ORS rating — look up by carrierPrefix.
        const theirOrs = AesCompetitorOutlineAggregator
            ._theirOrs(orsRec, input.carrierPrefix, input.carrierIata)

        // Spec for income estimate.
        const theirSpec = dominantType && dominantType.typeId
            ? input.specsByTypeId.get(String(dominantType.typeId)) || null
            : null

        // Their estimated income.
        let theirIncome = {estRevenuePerWeek: null, estProfitPerWeek: null, confidence: "low"}
        if (theirSpec && distanceKm && theirPrice && observedFreq > 0) {
            theirIncome = window.RouteAssistantCompetitorIncome
                ? window.RouteAssistantCompetitorIncome.estimate({
                    distanceKm:        distanceKm,
                    seats:             theirSeatsPerFlight,
                    price:             theirPrice,
                    frequency:         observedFreq,
                    aircraftSpec:      theirSpec,
                    observedSharePct:  sharePct,
                    economics:         input.economics
                })
                : theirIncome
        }

        // Our presence on the lane.
        const ours = AesCompetitorOutlineAggregator._buildOursRow({
            ownPricingRec, orsRec, competitorsRec,
            distanceKm, economics: input.economics
        })

        // Counter-aircraft recommendation.
        let counter = {verdict: "no-data"}
        if (typeof AesCounterAircraft !== "undefined") {
            try {
                counter = AesCounterAircraft.recommend({
                    distanceKm:    distanceKm,
                    hub:           input.hub,
                    dest:          input.dest,
                    theirSpec:     theirSpec,
                    theirEstProfit: theirIncome.estProfitPerWeek,
                    theirSeats:    theirSeatsPerFlight,
                    theirPrice:    theirPrice,
                    theirFreq:     observedFreq,
                    theirHasMarketsData: theirFlights.length > 0,
                    sharePct:      sharePct,
                    paxScore:      (input.paxScoreByPair && input.paxScoreByPair[pk] != null)
                        ? input.paxScoreByPair[pk]
                        : null,
                    ourFleetEnriched: input.ourFleetEnriched,
                    specsByTypeId: input.specsByTypeId,
                    economics:     input.economics,
                    oursHasFlights: ours.hasFlights,
                    oursEstProfit: ours.estProfitPerWeek
                })
            } catch (e) {
                console.warn("[AES competitor-intel] counter-aircraft scoring failed", e)
                counter = {verdict: "no-data", error: String(e)}
            }
        }

        const freshnessAt = competitorsRec && competitorsRec.scrapedAt
            ? competitorsRec.scrapedAt
            : (orsRec && orsRec.scrapedAt) || null

        return {
            hub:        String(input.hub).toUpperCase(),
            dest:       String(input.dest).toUpperCase(),
            distanceKm: distanceKm,
            ours:       ours,
            theirs: {
                price:             theirPrice,
                freq:              observedFreq,
                seats:             theirSeatsPerFlight,
                aircraftType:      dominantType && dominantType.typeCode || null,
                aircraftTypeId:    dominantType && dominantType.typeId || null,
                aircraftAgeMonths: aircraftAgeMonths,
                marketSharePct:    sharePct,
                ors:               theirOrs,
                estRevenuePerWeek: theirIncome.estRevenuePerWeek,
                estProfitPerWeek:  theirIncome.estProfitPerWeek,
                incomeConfidence:  theirIncome.confidence,
                freshnessAt:       freshnessAt
            },
            counter: counter
        }
    }

    static _buildOursRow(input) {
        const op = input.ownPricingRec
        const ors = input.orsRec
        const compsRec = input.competitorsRec
        let hasFlights = false
        let price = null
        let freq = 0
        let oursOrs = null

        if (op && op.prices) {
            const y = Number(op.prices.Y)
            if (isFinite(y) && y > 0) price = y
            // Frequency: ownPricing snapshots typically include the count.
            if (isFinite(op.frequency)) freq = Number(op.frequency)
        }
        if (compsRec && Array.isArray(compsRec.competitors)) {
            // Cross-check freq / hasFlights from the competitors-list since
            // ownPricing may be absent on routes the user just opened.
            const ourCount = compsRec.competitors.filter(c => c && c.isOurs).length
            if (ourCount > 0) {
                hasFlights = true
                if (!freq) freq = ourCount
                if (price === null) {
                    const prices = compsRec.competitors
                        .filter(c => c && c.isOurs && isFinite(c.price))
                        .map(c => c.price)
                    if (prices.length) {
                        price = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length)
                    }
                }
            }
        }
        if (ors) {
            // Pick the highest of byClass.<X>.ourBestNonstopRating.
            const byClass = ors.byClass || {}
            for (const cls in byClass) {
                const cr = byClass[cls]
                if (!cr) continue
                const r = cr.ourBestNonstopRating != null ? cr.ourBestNonstopRating : cr.ourTopRating
                if (r != null && (oursOrs === null || r > oursOrs)) oursOrs = r
            }
            if (oursOrs === null && ors.ourTopRating != null) oursOrs = ors.ourTopRating
        }

        // Estimated profit. We deliberately reuse the same income helper so
        // ours and theirs are scored on the same yardstick.
        let estProfitPerWeek = null
        let estRevenuePerWeek = null
        if (hasFlights && price && freq && input.distanceKm
            && typeof window.RouteAssistantCompetitorIncome !== "undefined") {
            const oursSpec = AesCompetitorOutlineAggregator._oursSpecFromOpRec(op)
            if (oursSpec) {
                const est = window.RouteAssistantCompetitorIncome.estimate({
                    distanceKm:   input.distanceKm,
                    seats:        oursSpec.seats,
                    price:        price,
                    frequency:    freq,
                    aircraftSpec: oursSpec,
                    economics:    input.economics
                })
                estProfitPerWeek  = est.estProfitPerWeek
                estRevenuePerWeek = est.estRevenuePerWeek
            }
        }

        return {
            hasFlights:        hasFlights,
            price:             price,
            freq:              freq || null,
            ors:               oursOrs,
            estRevenuePerWeek: estRevenuePerWeek,
            estProfitPerWeek:  estProfitPerWeek
        }
    }

    static _oursSpecFromOpRec(op) {
        // ownPricing may carry an `aircraft` block when the markets-page
        // scraper captured it. Otherwise we don't have a spec for ours;
        // returning null lets the income helper short-circuit.
        if (!op || !op.aircraft) return null
        const a = op.aircraft
        if (!isFinite(a.range) || !isFinite(a.speed)) return null
        return {
            seats:         a.seats,
            range:         a.range,
            speed:         a.speed,
            cargoCapacity: a.cargoCapacity || 0
        }
    }

    static _theirFlights(competitorsRec, carrierIata, carrierPrefix) {
        if (!competitorsRec || !Array.isArray(competitorsRec.competitors)) return []
        const out = []
        for (const c of competitorsRec.competitors) {
            if (!c || c.isOurs) continue
            const code = (c.flightCode || "").toUpperCase()
            const prefix = code.replace(/\s.*$/, "")
            const matchesPrefix = carrierPrefix && (prefix === carrierPrefix
                || code.indexOf(carrierPrefix + " ") === 0)
            const matchesIata   = carrierIata && (prefix === carrierIata
                || code.indexOf(carrierIata + " ") === 0)
            if (matchesPrefix || matchesIata) out.push(c)
        }
        return out
    }

    static _theirSharePct(marketShareRec, enterpriseId, carrierIata) {
        if (!marketShareRec || !Array.isArray(marketShareRec.pax)) return null
        for (const r of marketShareRec.pax) {
            const idMatch = enterpriseId && r.enterpriseId
                && String(r.enterpriseId) === String(enterpriseId)
            const codeMatch = carrierIata && r.code
                && String(r.code).toUpperCase() === carrierIata
            if (idMatch || codeMatch) return r.sharePct
        }
        return null
    }

    static _theirOrs(orsRec, carrierPrefix, carrierIata) {
        if (!orsRec) return null
        const candidates = []
        const byClass = orsRec.byClass || {}
        for (const cls in byClass) {
            const cr = byClass[cls]
            if (!cr || !cr.competitorRatings) continue
            for (const k in cr.competitorRatings) {
                const v = cr.competitorRatings[k]
                if (v == null) continue
                if (carrierPrefix && k.toUpperCase() === carrierPrefix.toUpperCase()) candidates.push(v)
                else if (carrierIata && k.toUpperCase() === carrierIata.toUpperCase()) candidates.push(v)
            }
        }
        if (!candidates.length) return null
        return candidates.reduce((m, v) => v > m ? v : m, 0)
    }

    static _extractCarrierPrefix(server, enterprise, storageBundle) {
        // Strategy 1: enterprise IATA (uppercased) — works for most rivals
        // because ORS flight codes are typically the IATA prefix.
        if (enterprise.iata) return String(enterprise.iata).toUpperCase()

        // Strategy 2: walk markets:competitors records on this competitor's
        // routeFootprint and pull the most common carrier prefix that
        // matches by enterprise name.
        const footprint = enterprise.routeFootprint || []
        const counter = new Map()
        for (const r of footprint) {
            const pk = _pairKey(r.hub, r.dest)
            const compsRec = storageBundle.competitors[pk]
            if (!compsRec || !Array.isArray(compsRec.competitors)) continue
            for (const c of compsRec.competitors) {
                if (!c || c.isOurs) continue
                const code = String(c.flightCode || "").toUpperCase()
                const prefix = code.replace(/\s.*$/, "")
                if (!prefix) continue
                // Match either by enterpriseId on the flight (when present
                // — rare in markets-page records) or by enterprise name.
                const idMatch = c.enterpriseId
                    && String(c.enterpriseId) === String(enterprise.enterpriseId)
                if (idMatch) {
                    counter.set(prefix, (counter.get(prefix) || 0) + 1)
                }
            }
        }
        let best = null
        let bestCount = 0
        for (const [k, n] of counter.entries()) {
            if (n > bestCount) { best = k; bestCount = n }
        }
        return best
    }

    static _theirLead(routeRow) {
        const them = routeRow.theirs && routeRow.theirs.estProfitPerWeek
        const us   = routeRow.ours   && routeRow.ours.estProfitPerWeek
        if (!isFinite(them)) return -1
        if (!isFinite(us))   return them
        return them - us
    }

    static _oldestEdgeAt(storageBundle, footprint) {
        let oldest = null
        for (const r of footprint || []) {
            const pk = _pairKey(r.hub, r.dest)
            const e = storageBundle.edges[pk]
            if (e && typeof e.scrapedAt === "number") {
                if (oldest === null || e.scrapedAt < oldest) oldest = e.scrapedAt
            }
        }
        return oldest
    }

    static _numOrNull(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
    }

    static _firstNum(values) {
        for (const v of values || []) {
            const n = AesCompetitorOutlineAggregator._numOrNull(v)
            if (n != null) return n
        }
        return null
    }

    static _sumFinite(values) {
        let sum = 0
        for (const v of values || []) {
            const n = Number(v)
            if (Number.isFinite(n)) sum += n
        }
        return sum
    }

    static _maxFinite(values) {
        let max = null
        for (const v of values || []) {
            const n = Number(v)
            if (!Number.isFinite(n)) continue
            if (max === null || n > max) max = n
        }
        return max
    }

    static _totalCurrent(total) {
        if (!total || typeof total !== "object") return null
        return AesCompetitorOutlineAggregator._numOrNull(total.current)
    }

    static _cashFromSisters(sisters) {
        const cashflow = sisters && sisters.cashflow && sisters.cashflow.payload
        if (!cashflow || !Array.isArray(cashflow.tables)) return null
        for (const table of cashflow.tables) {
            const rows = table && Array.isArray(table.rows) ? table.rows : []
            for (const row of rows) {
                if (!row || !/cash|balance/i.test(String(row.label || ""))) continue
                const n = AesCompetitorOutlineAggregator._numOrNull(row.value)
                if (n != null) return n
            }
        }
        return null
    }

    static async _loadPaxScoreByPair(pairKeys) {
        const out = {}
        if (!pairKeys || !pairKeys.size) return out
        const hubs = new Set()
        for (const pk of pairKeys) {
            const idx = pk.indexOf("-")
            if (idx > 0) hubs.add(pk.slice(0, idx))
        }
        if (!hubs.size) return out
        const keys = Array.from(hubs).map(h => "routeAssistant:topRoutes:" + h)
        const data = await chrome.storage.local.get(keys)
        for (const hub of hubs) {
            const blob = data["routeAssistant:topRoutes:" + hub]
            if (!blob || !Array.isArray(blob.rows)) continue
            for (const row of blob.rows) {
                if (!row || !row.destIata) continue
                if (!isFinite(row.paxScore)) continue
                const pk = hub + "-" + String(row.destIata).toUpperCase()
                if (!(pk in out)) out[pk] = Number(row.paxScore)
            }
        }
        return out
    }

}

function _pairKey(hub, dest) {
    return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
}

if (typeof window !== "undefined") {
    window.AesCompetitorOutlineAggregator = AesCompetitorOutlineAggregator
}
