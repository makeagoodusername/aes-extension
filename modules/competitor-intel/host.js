"use strict"

/**
 * Competitor Intel Hub — entry point.
 *
 * `AesCompetitorIntelHost.open(serverId?)` mounts the hub-shell modal,
 * loads server-scoped competitor data (enterprises, snapshots, edges, ORS,
 * own-fleet flight numbers), and hands it to the shell to render. The
 * shell owns the UI lifecycle; this module owns data discovery + the
 * single open() call.
 *
 * Servers are discovered by scanning `competitorIntel:enterprise:` keys —
 * any server with at least one cached enterprise shows up in the picker.
 * Defaults to the current page's server when present.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelHost) return

    const ENTERPRISE_PREFIX = "competitorIntel:enterprise:"
    const EDGE_PREFIX       = "competitorIntel:edge:"
    const ORS_LEGACY_PREFIX = "routeAssistant:ors:"
    const ORS_ACCT_PREFIX   = "routeAssistant:ors:acct:"

    async function discoverServers() {
        const all = await chrome.storage.local.get(null)
        const servers = new Set()
        for (const k in all) {
            if (!k.startsWith(ENTERPRISE_PREFIX)) continue
            const rest = k.slice(ENTERPRISE_PREFIX.length)
            const colon = rest.indexOf(":")
            if (colon > 0) servers.add(rest.slice(0, colon))
        }
        for (const k in all) {
            const rec = all[k]
            if (!rec || typeof rec !== "object") continue
            if (rec.type !== "competitorMonitoring") continue
            if (!rec.tracking) continue
            if (rec.server) servers.add(String(rec.server))
        }
        // Always include the current server so an empty cache still has a
        // valid picker entry.
        const current = currentServer()
        if (current) servers.add(current)
        return Array.from(servers).sort()
    }

    function currentServer() {
        try {
            if (typeof AES !== "undefined" && AES.getServerName) {
                return AES.getServerName() || null
            }
        } catch (_) {}
        return null
    }

    async function loadServerData(server) {
        if (!server) return _emptyData(server)
        const all = await chrome.storage.local.get(null)
        const enterprises = new Map()
        const snapshots   = new Map()
        const edges       = new Map()
        const orsRoutes   = new Map()

        const entPrefix = ENTERPRISE_PREFIX + server + ":"
        const edgPrefix = EDGE_PREFIX + server + ":"
        const snapPrefix = "competitorIntel:snapshots:" + server + ":"

        for (const k in all) {
            const v = all[k]
            if (!v || typeof v !== "object") continue
            if (k.startsWith(entPrefix)) {
                if (v.enterpriseId) enterprises.set(String(v.enterpriseId), v)
            } else if (k.startsWith(edgPrefix)) {
                const key = (v.hub && v.dest) ? (v.hub + "-" + v.dest) : k.slice(edgPrefix.length)
                edges.set(key, v)
            } else if (k.startsWith(snapPrefix)) {
                if (v.enterpriseId && Array.isArray(v.snapshots)) {
                    snapshots.set(String(v.enterpriseId), v.snapshots)
                }
            } else if (k.startsWith(ORS_ACCT_PREFIX) || k.startsWith(ORS_LEGACY_PREFIX)) {
                if (!v.hub || !v.dest) continue
                const key = String(v.hub).toUpperCase() + "-" + String(v.dest).toUpperCase()
                // Prefer the most recently scraped record per route; account-
                // scoped wins ties because it's the canonical post-L1 path.
                const prior = orsRoutes.get(key)
                const isAcct = k.startsWith(ORS_ACCT_PREFIX)
                if (!prior
                        || (isAcct && !prior._isAcct)
                        || ((v.scrapedAt || 0) > (prior.scrapedAt || 0))) {
                    orsRoutes.set(key, Object.assign({_isAcct: isAcct, _key: k}, v))
                }
            }
        }
        if (window.RouteAssistantOrsIntelligence
                && typeof window.RouteAssistantOrsIntelligence.listCachedRoutes === "function") {
            try {
                const facadeRoutes = await window.RouteAssistantOrsIntelligence.listCachedRoutes(server)
                facadeRoutes.forEach((rec, key) => {
                    const prior = orsRoutes.get(key)
                    if (!prior || ((rec.scrapedAt || 0) > (prior.scrapedAt || 0)) || (rec._isAcct && !prior._isAcct)) {
                        orsRoutes.set(key, rec)
                    }
                })
            } catch (e) {
                console.warn("[AES competitor-intel] ORS facade load failed", e)
            }
        }

        _mergeLegacyMonitoring({server, all, enterprises, snapshots, edges})
        _mergeEnterpriseFootprintEdges({server, enterprises, edges})
        _mergeMarketsCompetitorEdges({server, all, edges})

        const ourHubs = await _resolveOurHubs(server)
        return {
            server, enterprises, snapshots, edges, orsRoutes, ourHubs,
            scannedAt: Date.now()
        }
    }

    /**
     * Merge competitor data scraped by Route Assistant's markets-page-scraper
     * (`routeAssistant:markets:competitors:<HUB>-<DEST>`) into the edges Map.
     *
     * Why: most accounts have hundreds of these records from regular RA work,
     * but never run a dedicated competitor-intel scrape. Surfacing them as
     * edges means the Map tab + Routes tab populate without an extra sync
     * step. Existing competitorIntel:edge entries always win on conflict —
     * they're richer (sharePctPax, weeklySeats, etc.).
     *
     * Pair key uses the directional `<HUB>-<DEST>` form (matches existing
     * edges Map). Account-scoped keys (`acct:<id>:`) only apply when their
     * account matches the current page. Unscoped legacy keys are accepted
     * unconditionally (they're per-server, not per-airline).
     */
    function _mergeMarketsCompetitorEdges(input) {
        const server = input && input.server
        const all = input && input.all
        const edges = input && input.edges
        if (!server || !all || !edges) return
        const PREFIX = "routeAssistant:markets:competitors:"
        const acctId = (typeof window !== "undefined" && window.__aesAccountId) || null
        for (const key in all) {
            if (key.indexOf(PREFIX) !== 0) continue
            const rec = all[key]
            if (!rec || typeof rec !== "object") continue
            if (rec.server && rec.server !== server) continue
            if (key.indexOf(":acct:") !== -1) {
                if (!acctId || key.indexOf(":acct:" + acctId + ":") < 0) continue
            }
            const hub = rec.hub && String(rec.hub).toUpperCase()
            const dest = rec.dest && String(rec.dest).toUpperCase()
            if (!hub || !dest) continue
            const pair = hub + "-" + dest
            if (edges.has(pair) && edges.get(pair).source !== "marketsCompetitors") continue

            // The markets-page-scraper writes one entry PER FLIGHT (departure
            // row), not per airline. Group by carrier IATA pulled from the
            // flightCode prefix ("BA0123" → BA, "OS123" → OS) and synthesise
            // an airline-level record. Weekly-flights = count over a 7-day
            // window.
            const byCarrier = new Map()
            const seenFlightIds = new Set()
            const sevenDaysAgoMs = Date.now() - 7 * 86400000
            const totalsSeats = {pax: 0, cargo: 0}
            for (const c of (rec.competitors || [])) {
                if (!c || c.isOurs) continue
                // Dedupe — a recurring AS flight publishes one row per departure,
                // we want a per-airline weekly count, not a per-leg one.
                const fid = c.flightId != null ? String(c.flightId) : null
                if (fid && seenFlightIds.has(fid + ":" + (c.depTimeUtc || ""))) continue
                if (fid) seenFlightIds.add(fid + ":" + (c.depTimeUtc || ""))

                const code = String(c.flightCode || c.flightNumber || "").trim()
                let iata = null
                // AS flightCode shapes: "BA 164" (space-delimited),
                // "BA0164" (compact), "WWW 83" (3-letter prefix).
                const m = /^([A-Z]{2,3})\s*\d/i.exec(code)
                if (m) iata = m[1].toUpperCase()
                else if (c.iata) iata = String(c.iata).toUpperCase()
                else continue

                const slot = byCarrier.get(iata) || {
                    enterpriseId: null,        // unknown without enterprise scrape
                    name: null,
                    iata,
                    weeklyFlights: 0,
                    seatsAvailable: 0,
                    sharePctPax: null,
                    sharePctCargo: null,
                    source: "marketsCompetitors",
                    flightCodes: new Set()
                }
                // Count flights within the last 7d if dep dates are present;
                // otherwise count everything (better than dropping data).
                const depMs = c.depDateUtc
                    ? Date.parse(c.depDateUtc + "T" + (c.depTimeUtc || "00:00") + "Z")
                    : NaN
                if (!isFinite(depMs) || depMs >= sevenDaysAgoMs) slot.weeklyFlights += 1
                if (Number.isFinite(Number(c.availability))) {
                    slot.seatsAvailable += Number(c.availability)
                }
                if (code) slot.flightCodes.add(code)
                byCarrier.set(iata, slot)
            }

            const competitors = []
            for (const slot of byCarrier.values()) {
                competitors.push({
                    enterpriseId: slot.enterpriseId,
                    name: slot.name || (slot.iata + " (synth)"),
                    iata: slot.iata,
                    weeklyFlights: slot.weeklyFlights,
                    seatsAvailable: slot.seatsAvailable || null,
                    flightCodes: Array.from(slot.flightCodes).slice(0, 8),
                    source: "marketsCompetitors"
                })
            }
            const totalWeekly = competitors.reduce((s, c) => s + (Number(c.weeklyFlights) || 0), 0)
            edges.set(pair, {
                server, hub, dest,
                scrapedAt: rec.scrapedAt || 0,
                competitors,
                totals: {totalWeeklyFlights: totalWeekly, totalSeats: null},
                source: "marketsCompetitors"
            })
        }
    }

    function _mergeEnterpriseFootprintEdges(input) {
        const server = input && input.server
        const enterprises = input && input.enterprises
        const edges = input && input.edges
        if (!server || !enterprises || !edges) return

        for (const [enterpriseId, rec] of enterprises) {
            const footprint = Array.isArray(rec && rec.routeFootprint)
                ? rec.routeFootprint
                : []
            if (!footprint.length) continue

            for (const route of footprint) {
                const pair = _normaliseFootprintPair(route)
                if (!pair) continue
                const weeklyFlights = _normaliseWeeklyFlights(route)
                const edge = {
                    server,
                    hub: pair.hub,
                    dest: pair.dest,
                    scrapedAt: rec.scrapedAt || Date.now(),
                    competitors: [{
                        enterpriseId: String((rec && rec.enterpriseId) || enterpriseId),
                        name: (rec && rec.name) || ("#" + String(enterpriseId)),
                        iata: rec && rec.iata ? String(rec.iata).toUpperCase() : null,
                        sharePctPax: null,
                        sharePctCargo: null,
                        weeklyFlights: weeklyFlights || null,
                        weeklySeats: null,
                        source: "enterpriseRouteFootprint"
                    }],
                    totals: {totalWeeklyFlights: weeklyFlights, totalSeats: null},
                    source: "enterpriseRouteFootprint"
                }
                _mergeFootprintEdge(edges, edge)
            }
        }
    }

    function _normaliseFootprintPair(route) {
        if (!route || typeof route !== "object") return null
        const hub = _normaliseIata(route.hub || route.origin || route.originIata
            || route.from || route.fromIata || route.hubIata)
        const dest = _normaliseIata(route.dest || route.destination || route.destinationIata
            || route.destIata || route.to || route.toIata)
        if (!hub || !dest || hub === dest) return null
        return {hub, dest}
    }

    function _normaliseIata(value) {
        const m = /\b([A-Z]{3})\b/.exec(String(value || "").toUpperCase())
        return m ? m[1] : null
    }

    function _normaliseWeeklyFlights(route) {
        const raw = route && (
            route.weeklyFlights != null ? route.weeklyFlights :
            route.frequency != null ? route.frequency :
            route.flightsPerWeek != null ? route.flightsPerWeek :
            route.weeklyDepartures
        )
        const n = Number(raw)
        return Number.isFinite(n) && n > 0 ? n : 0
    }

    function _mergeFootprintEdge(edges, edge) {
        if (!edges || !edge || !edge.hub || !edge.dest) return
        const key = String(edge.hub).toUpperCase() + "-" + String(edge.dest).toUpperCase()
        const existing = edges.get(key)
        if (!existing) {
            edges.set(key, edge)
            return
        }

        const merged = Object.assign({}, existing)
        const competitors = Array.isArray(existing.competitors)
            ? existing.competitors.slice()
            : []
        let addedFlights = 0

        for (const candidate of (edge.competitors || [])) {
            const id = candidate && candidate.enterpriseId ? String(candidate.enterpriseId) : null
            const iata = candidate && candidate.iata ? String(candidate.iata).toUpperCase() : null
            const name = candidate && candidate.name ? String(candidate.name) : null
            const found = competitors.find(c => {
                if (!c) return false
                if (id && c.enterpriseId && String(c.enterpriseId) === id) return true
                if (iata && c.iata && String(c.iata).toUpperCase() === iata) return true
                if (name && c.name && String(c.name) === name) return true
                return false
            })
            if (found) {
                if (found.weeklyFlights == null && candidate.weeklyFlights != null) {
                    found.weeklyFlights = candidate.weeklyFlights
                }
                if (!found.source) found.source = candidate.source
            } else {
                competitors.push(candidate)
                addedFlights += Number(candidate.weeklyFlights) || 0
            }
        }

        merged.competitors = competitors
        if ((edge.scrapedAt || 0) > (merged.scrapedAt || 0)) merged.scrapedAt = edge.scrapedAt

        const totals = Object.assign({}, existing.totals || {})
        const currentFlights = Number(totals.totalWeeklyFlights)
        const shouldAccumulate =
            addedFlights > 0
            && (existing.source === "enterpriseRouteFootprint"
                || existing.source === "mixedRouteFootprint"
                || existing.source === "legacyCompetitorMonitoring"
                || !Number.isFinite(currentFlights)
                || currentFlights === 0)
        if (shouldAccumulate) {
            totals.totalWeeklyFlights = (Number.isFinite(currentFlights) ? currentFlights : 0) + addedFlights
        }
        merged.totals = totals
        if (!merged.source) merged.source = "mixedRouteFootprint"
        else if (merged.source !== "enterpriseRouteFootprint") merged.source = "mixed"
        edges.set(key, merged)
    }

    function _mergeLegacyMonitoring(input) {
        const server = input && input.server
        const all = (input && input.all) || {}
        const enterprises = input && input.enterprises
        const snapshots = input && input.snapshots
        const edges = input && input.edges
        if (!server || !enterprises || typeof AesCompetitorStore === "undefined"
                || typeof AesCompetitorStore.projectLegacyMonitoring !== "function") {
            return
        }

        for (const k in all) {
            const legacy = all[k]
            if (!legacy || typeof legacy !== "object") continue
            if (legacy.type !== "competitorMonitoring") continue
            if (legacy.server && legacy.server !== server) continue
            if (!legacy.tracking) continue

            let code = null
            if (typeof AesCompetitorStore._legacyCarrierCode === "function") {
                code = AesCompetitorStore._legacyCarrierCode(legacy)
            }
            const schedule = code ? all[String(server) + code + "schedule"] : null
            const projected = AesCompetitorStore.projectLegacyMonitoring(legacy, {schedule})
            if (!projected || !projected.enterpriseId) continue

            const id = String(projected.enterpriseId)
            const existing = enterprises.get(id)
            if (!existing) {
                enterprises.set(id, projected)
            } else {
                const merged = Object.assign({}, existing)
                merged.legacyTracking = true
                merged.legacyKey = projected.legacyKey || merged.legacyKey || null
                if ((!Array.isArray(merged.hubs) || !merged.hubs.length)
                        && projected.hubs && projected.hubs.length) {
                    merged.hubs = projected.hubs
                }
                if ((!Array.isArray(merged.routeFootprint) || !merged.routeFootprint.length)
                        && projected.routeFootprint && projected.routeFootprint.length) {
                    merged.routeFootprint = projected.routeFootprint
                }
                if (!merged.fleet && projected.fleet) merged.fleet = projected.fleet
                enterprises.set(id, merged)
            }

            if (snapshots && !snapshots.has(id)
                    && typeof AesCompetitorStore.projectLegacyMonitoringSnapshots === "function") {
                const projectedSnaps = AesCompetitorStore
                    .projectLegacyMonitoringSnapshots(legacy, {schedule})
                if (projectedSnaps && projectedSnaps.length) {
                    snapshots.set(id, projectedSnaps)
                }
            }

            if (edges && typeof AesCompetitorStore.projectLegacyMonitoringEdges === "function") {
                const projectedEdges = AesCompetitorStore
                    .projectLegacyMonitoringEdges(legacy, {schedule, projected})
                for (const edge of projectedEdges) {
                    _mergeLegacyEdge(edges, edge)
                }
            }
        }
    }

    function _mergeLegacyEdge(edges, edge) {
        if (!edges || !edge || !edge.hub || !edge.dest) return
        const key = String(edge.hub).toUpperCase() + "-" + String(edge.dest).toUpperCase()
        const existing = edges.get(key)
        if (!existing) {
            edges.set(key, edge)
            return
        }

        const merged = Object.assign({}, existing)
        const competitors = Array.isArray(existing.competitors)
            ? existing.competitors.slice()
            : []
        for (const candidate of (edge.competitors || [])) {
            const id = candidate && candidate.enterpriseId ? String(candidate.enterpriseId) : null
            const iata = candidate && candidate.iata ? String(candidate.iata).toUpperCase() : null
            const found = competitors.find(c => {
                if (!c) return false
                if (id && c.enterpriseId && String(c.enterpriseId) === id) return true
                if (iata && c.iata && String(c.iata).toUpperCase() === iata) return true
                return false
            })
            if (found) {
                if (found.weeklyFlights == null && candidate.weeklyFlights != null) {
                    found.weeklyFlights = candidate.weeklyFlights
                }
                if (!found.source) found.source = candidate.source
            } else {
                competitors.push(candidate)
            }
        }
        merged.competitors = competitors
        merged.legacyTracking = true
        if (!merged.source) merged.source = "mixed"
        if ((edge.scrapedAt || 0) > (merged.scrapedAt || 0)) merged.scrapedAt = edge.scrapedAt

        const totals = Object.assign({}, existing.totals || {})
        const currentFlights = Number(totals.totalWeeklyFlights)
        const legacyFlights = Number(edge.totals && edge.totals.totalWeeklyFlights) || 0
        if (existing.source === "legacyCompetitorMonitoring"
                || !Number.isFinite(currentFlights)
                || currentFlights === 0) {
            totals.totalWeeklyFlights = (Number.isFinite(currentFlights) ? currentFlights : 0) + legacyFlights
        }
        merged.totals = totals
        edges.set(key, merged)
    }

    async function _resolveOurHubs(server) {
        const set = new Set()
        try {
            const data = await chrome.storage.local.get(["settings"])
            const ra = data.settings && data.settings.routeAssistant
            if (ra && Array.isArray(ra.recentHubs)) {
                for (const h of ra.recentHubs) {
                    if (typeof h === "string" && /^[A-Z]{3}$/.test(h)) set.add(h)
                }
            }
        } catch (_) {}
        // Also include any hubs the current account's own enterprise records
        // expose via the contractual-partners cache (best-effort).
        try {
            const all = await chrome.storage.local.get(null)
            for (const k in all) {
                if (!k.startsWith("routeAssistant:ticketPrice")) continue
                const v = all[k]
                if (v && v.hub && /^[A-Z]{3}$/.test(String(v.hub).toUpperCase())) {
                    set.add(String(v.hub).toUpperCase())
                }
            }
        } catch (_) {}
        return set
    }

    function _emptyData(server) {
        return {
            server: server || null,
            enterprises: new Map(),
            snapshots:   new Map(),
            edges:       new Map(),
            orsRoutes:   new Map(),
            ourHubs:     new Set(),
            scannedAt:   Date.now()
        }
    }

    /**
     * Open the hub modal. Idempotent — calling while already open swaps
     * the active server if `serverId` differs.
     */
    function _normaliseOpenArgs(arg) {
        if (!arg || typeof arg === "string") return {serverId: arg || null}
        if (typeof arg === "object") {
            return {
                serverId:  arg.serverId || arg.server || null,
                tab:       arg.tab || arg.initialTab || null,
                search:    arg.search || arg.initialSearch || "",
                airlineId: arg.airlineId || arg.initialAirlineId
                    || arg.enterpriseId || null
            }
        }
        return {serverId: null}
    }

    async function open(serverId) {
        if (!window.AesCompetitorIntelShell) {
            console.warn("[AES competitor-intel] hub-shell not loaded")
            return
        }
        const openOpts = _normaliseOpenArgs(serverId)
        const servers = await discoverServers()
        const server = openOpts.serverId || currentServer() || servers[0] || null
        const data = await loadServerData(server)
        const ctx = {
            server,
            servers,
            data,
            initialTab:       openOpts.tab || null,
            initialSearch:    openOpts.search || "",
            initialAirlineId: openOpts.airlineId
                ? String(openOpts.airlineId) : null,
            reload: async (nextServerId) => {
                const s = nextServerId || server
                const d = await loadServerData(s)
                return {server: s, data: d}
            }
        }
        window.AesCompetitorIntelShell.open(ctx)
    }

    window.AesCompetitorIntelHost = {
        open,
        discoverServers,
        loadServerData,
        currentServer
    }
})()
