"use strict"

/**
 * Phase 2 Lane B keystone — pure cross-account fleet aggregator.
 *
 * Reads (each is graceful-null if its store is missing on this page):
 *   AesAccountRegistry.list()             — registered accounts
 *   AesFleetRoster.load(server, airline)  — per-account aircraft list
 *   FleetHubAircraftAggregator.enrich()   — state+hub join
 *   AesAfpScheduleStore.load(s, id)       — per-aircraft Schedule
 *   AesAfpMaintenanceStore.load(s, id)    — per-aircraft maintenance
 *   AesCanopyOrgsStore.listOrgs()         — orgs map (Lane B Phase 1)
 *   AesCanopyRegionsStore.list()          — regions map (Lane B Phase 1)
 *   AesCanopyGeographyBase                — continent fallback
 *   AesCanopyRegionResolver               — pure resolver
 *   RouteAssistantDemandStore.get(iata)   — country lookup for region resolve
 *   AesStrategyFleetUtilization.compute() — Lane C overlay (optional)
 *
 * Returns FleetCommandView:
 *   {
 *     tails:    TailRow[],
 *     byOrg:    {[orgId]:    {orgId, orgName, count, tails:[idx]}},
 *     byHub:    {[hub]:      {hub,            count, tails:[idx]}},
 *     byType:   {[typeId]:   {typeId, name,   count, tails:[idx]}},
 *     byRegion: {[regionId]: {regionId, name, count, tails:[idx]}},
 *     totals:   {tails, accounts, orgs, hubs, types, regions, withRatio, withSchedule}
 *   }
 *
 * TailRow shape:
 *   {accountId, server, airlineCode, aircraftId, registration, equipment, typeId,
 *    hub, locIata, locName,
 *    orgId, orgName, regionId, regionName,
 *    maintRatio, ratioStatus, scrapedAt,
 *    legCount, weeklyBlockHours, hubIata,
 *    utilizationPct, ratioForecast14d, classification, targetWeeklyHours}
 *
 * Cross-account scope: §B.6. Reads through `acctKeyForAccount` where the
 * underlying store is per-account. Today, AfpScheduleStore and
 * AfpMaintenanceStore key by (server, aircraftId) — not per-account — so
 * the bridge isn't needed for them yet. The hook is in place for future
 * stores that move per-account (L2).
 *
 * Memoization: keyed on (accountIds.join, registry.lastSeenAt sum,
 * orgsBlock.updatedAt, regionsBlock.updatedAt). Calls inside a 5s TTL with
 * the same key return the cached view.
 */
;(function () {
    if (window.AesFleetCommand) return

    const TTL_MS = 5000
    let _cache = null  // {key, view, builtAt}

    async function build(opts) {
        opts = opts || {}
        const accounts = await _resolveAccounts(opts)
        const orgsBlock    = await _safe(() => window.AesCanopyOrgsStore && window.AesCanopyOrgsStore.load(), null)
        const regionsBlock = await _safe(() => window.AesCanopyRegionsStore && window.AesCanopyRegionsStore.load(), null)
        const geoBase      = (typeof window.AesGeographyBase === "object") ? window.AesGeographyBase : null
        const orgsList     = orgsBlock ? Object.values(orgsBlock.orgs || {})
            .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)) : []

        const memoKey = _memoKey(accounts, orgsBlock, regionsBlock)
        if (_cache && _cache.key === memoKey && (Date.now() - _cache.builtAt) < TTL_MS) {
            return _cache.view
        }

        const tails = []
        for (const acct of accounts) {
            const rows = await _enrichAccount(acct)
            for (const r of rows) {
                tails.push(await _buildRow(r, acct, orgsBlock, orgsList, regionsBlock, geoBase))
            }
        }

        // Optional Lane C overlay — graceful-null per §4.8.
        try {
            if (window.AesStrategyFleetUtilization && typeof window.AesStrategyFleetUtilization.compute === "function") {
                _overlayUtilization(tails)
            }
        } catch (_) { /* non-fatal */ }

        const view = _rollup(tails, accounts.length)
        _cache = {key: memoKey, view, builtAt: Date.now()}
        return view
    }

    async function _resolveAccounts(opts) {
        if (!window.AesAccountRegistry) return []
        const list = await _safe(() => window.AesAccountRegistry.list(), [])
        if (!Array.isArray(list) || !list.length) return []
        if (opts.accountIds && opts.accountIds.length) {
            const want = new Set(opts.accountIds.map(String))
            return list.filter(a => want.has(String(a.accountId || a.id)))
        }
        if (opts.servers && opts.servers.length) {
            const want = new Set(opts.servers.map(s => String(s).toLowerCase()))
            return list.filter(a => want.has(String(a.server || "").toLowerCase()))
        }
        return list
    }

    function _memoKey(accounts, orgsBlock, regionsBlock) {
        const acctSig = accounts
            .map(a => (a.accountId || a.id || "?") + ":" + (a.lastSeenAt || 0))
            .sort().join("|")
        const orgsTs    = orgsBlock    ? (orgsBlock.updatedAt    || JSON.stringify(orgsBlock).length)    : 0
        const regionsTs = regionsBlock ? (regionsBlock.updatedAt || JSON.stringify(regionsBlock).length) : 0
        return acctSig + "@" + orgsTs + "@" + regionsTs
    }

    async function _enrichAccount(acct) {
        const server      = acct.server || ""
        const airlineCode = acct.airlineIdentity || acct.airlineCode || ""
        const accountId   = acct.accountId || acct.id || ""
        if (!window.AesFleetRoster || !server) return []

        const roster = await _safe(
            () => window.AesFleetRoster.load(server, airlineCode), {aircraft: []})
        const fleet = Array.isArray(roster.aircraft) ? roster.aircraft : []
        if (!fleet.length) return []

        let enriched = fleet.map(a => ({
            aircraftId:   a.aircraftId,
            registration: a.registration || "",
            equipment:    a.equipment    || "",
            typeId:       a.typeId       || null,
            hub:          null,
            locIata:      null,
            locName:      null,
            rosterMaint:  (typeof a.maintanance === "number") ? a.maintanance : null
        }))

        if (window.FleetHubAircraftAggregator && typeof window.FleetHubAircraftAggregator.enrich === "function") {
            try {
                enriched = await window.FleetHubAircraftAggregator.enrich({
                    server, airlineCode, fleet
                })
            } catch (_) { /* fall back to raw roster */ }
        }

        return enriched.map(r => ({
            ...r,
            _accountId:   accountId,
            _server:      server,
            _airlineCode: airlineCode,
            _displayName: acct.displayName || airlineCode || ""
        }))
    }

    async function _buildRow(r, acct, orgsBlock, orgsList, regionsBlock, geoBase) {
        const server      = r._server
        const aircraftId  = r.aircraftId
        const accountId   = r._accountId
        const airlineCode = r._airlineCode

        // Maintenance — pure read, single key per tail.
        let maintRatio = null, ratioStatus = null, scrapedAt = null
        if (window.AesAfpMaintenanceStore) {
            const m = await _safe(
                () => window.AesAfpMaintenanceStore.load(server, aircraftId), null)
            if (m) {
                maintRatio  = m.ratio
                ratioStatus = m.ratioStatus
                scrapedAt   = m.scrapedAt
            }
        }
        if (maintRatio == null && typeof r.rosterMaint === "number") {
            maintRatio = r.rosterMaint
        }

        // Schedule — leg count and rough weekly block hours.
        let legCount = null, weeklyBlockHours = null, scheduleHubIata = null
        if (window.AesAfpScheduleStore) {
            const sched = await _safe(
                () => window.AesAfpScheduleStore.load(server, aircraftId), null)
            if (sched && Array.isArray(sched.legs)) {
                legCount = sched.legs.length
                scheduleHubIata = sched.hubIata || null
                let totalMin = 0
                for (const leg of sched.legs) {
                    const dur = Number(leg.durationMin || leg.blockMin || 0)
                    if (isFinite(dur) && dur > 0) totalMin += dur
                }
                weeklyBlockHours = totalMin > 0 ? Math.round((totalMin / 60) * 10) / 10 : null
            }
        }

        const hub = r.hub || scheduleHubIata || null

        // Org resolution — inline scan against the pre-sorted org list so we
        // make zero extra storage reads per tail. Mirrors the canonical
        // logic in AesCanopyOrgsStore.resolveOrgIdForTail.
        let orgId = null, orgName = null
        if (orgsList && orgsList.length) {
            for (const org of orgsList) {
                let hit = false
                for (const m of (org.members || [])) {
                    if (m.accountId !== accountId) continue
                    if (m.server      && server      && m.server      !== server)      continue
                    if (m.airlineCode && airlineCode && m.airlineCode !== airlineCode) continue
                    if (m.aircraftIds == null) { hit = true; break }
                    if (Array.isArray(m.aircraftIds)
                        && m.aircraftIds.indexOf(String(aircraftId)) >= 0) { hit = true; break }
                }
                if (hit) { orgId = org.id; orgName = org.name || org.id; break }
            }
        }

        // Region resolution.
        let regionId = null, regionName = null
        if (hub && window.AesCanopyRegionResolver && regionsBlock) {
            const demand = await _safe(
                () => window.RouteAssistantDemandStore && window.RouteAssistantDemandStore.get
                    ? window.RouteAssistantDemandStore.get(hub) : null, null)
            const countryIdMap = await _safe(() => _loadCountryIdMap(server), null)
            const resolved = window.AesCanopyRegionResolver.resolve({
                iata: hub, demand, countryIdMap, regionsBlock, geographyBase: geoBase
            })
            if (resolved && resolved.regionId) {
                regionId = resolved.regionId
                regionName = resolved.regionName || regionId
            }
        }

        return {
            accountId, server, airlineCode,
            displayName: r._displayName,
            aircraftId, registration: r.registration, equipment: r.equipment, typeId: r.typeId,
            hub, locIata: r.locIata || null, locName: r.locName || null,
            orgId, orgName,
            regionId, regionName,
            maintRatio, ratioStatus, scrapedAt,
            legCount, weeklyBlockHours, hubIata: scheduleHubIata,
            // Lane C overlays — populated by _overlayUtilization, else null.
            utilizationPct:    null,
            ratioForecast14d:  null,
            classification:    null,
            targetWeeklyHours: null
        }
    }

    async function _loadCountryIdMap(server) {
        if (!server || typeof chrome === "undefined" || !chrome.storage) return null
        const key = "aesCanopy:geography:countryIdMap:" + server
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        return (rec && rec.byCountryId) ? rec : null
    }

    function _overlayUtilization(tails) {
        // Lane C is dormant by default — best effort. Build a minimal
        // snapshot it can chew on; if compute() throws, skip silently.
        const snapshot = {ts: Date.now(), tails: tails.map(t => ({
            aircraftId: t.aircraftId, hub: t.hub, typeId: t.typeId,
            currentRatio: t.maintRatio, weeklyHoursPlanned: t.weeklyBlockHours
        }))}
        let summary
        try {
            summary = window.AesStrategyFleetUtilization.compute({snapshot, settings: null})
        } catch (_) { return }
        if (!summary || !Array.isArray(summary.perAircraft)) return
        const byId = new Map()
        for (const r of summary.perAircraft) byId.set(String(r.aircraftId), r)
        for (const t of tails) {
            const r = byId.get(String(t.aircraftId))
            if (!r) continue
            t.utilizationPct    = (r.utilizationPct    != null) ? r.utilizationPct    : null
            t.ratioForecast14d  = (r.ratioForecast14d  != null) ? r.ratioForecast14d  : null
            t.classification    = r.classification     || null
            t.targetWeeklyHours = (r.targetWeeklyHours != null) ? r.targetWeeklyHours : null
        }
    }

    function _rollup(tails, accountCount) {
        const byOrg    = {}
        const byHub    = {}
        const byType   = {}
        const byRegion = {}
        let withRatio    = 0
        let withSchedule = 0

        tails.forEach((t, i) => {
            if (t.maintRatio       != null) withRatio++
            if (t.weeklyBlockHours != null) withSchedule++

            const orgKey = t.orgId || "_unassigned"
            const oG = byOrg[orgKey] || (byOrg[orgKey] = {
                orgId: t.orgId, orgName: t.orgName || "Unassigned",
                count: 0, tails: []
            })
            oG.count++; oG.tails.push(i)

            if (t.hub) {
                const hG = byHub[t.hub] || (byHub[t.hub] = {hub: t.hub, count: 0, tails: []})
                hG.count++; hG.tails.push(i)
            }

            if (t.typeId) {
                const key = String(t.typeId)
                const tG = byType[key] || (byType[key] = {
                    typeId: t.typeId, name: t.equipment || ("type " + t.typeId),
                    count: 0, tails: []
                })
                tG.count++; tG.tails.push(i)
            }

            const regKey = t.regionId || "_unassigned"
            const rG = byRegion[regKey] || (byRegion[regKey] = {
                regionId: t.regionId, name: t.regionName || "Unassigned",
                count: 0, tails: []
            })
            rG.count++; rG.tails.push(i)
        })

        return {
            tails,
            byOrg, byHub, byType, byRegion,
            totals: {
                tails:        tails.length,
                accounts:     accountCount,
                orgs:         Object.keys(byOrg).filter(k => k !== "_unassigned").length,
                hubs:         Object.keys(byHub).length,
                types:        Object.keys(byType).length,
                regions:      Object.keys(byRegion).filter(k => k !== "_unassigned").length,
                withRatio,
                withSchedule
            }
        }
    }

    async function _safe(fn, fallback) {
        try {
            const out = fn()
            return (out && typeof out.then === "function") ? await out : out
        } catch (_) {
            return fallback
        }
    }

    function invalidate() { _cache = null }

    window.AesFleetCommand = {build, invalidate}

    // Cache invalidation on any of the upstream blocks changing.
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            if (changes.aesAccounts || changes["aesCanopy:orgs"] || changes["aesCanopy:regions"]) {
                _cache = null
            }
        })
    }
})()
