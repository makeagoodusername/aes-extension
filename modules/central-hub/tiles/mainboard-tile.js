"use strict"

/**
 * Mainboard tile — one compact readiness view for the dashboard.
 *
 * Read-only by default. It joins existing scrape cadence records, the scrape
 * run archive/last-run summary, strategy snapshot readiness, and cache
 * timestamps. Buttons delegate to existing scrape hosts only.
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    const PHASES = [
        {id: "foundation",     label: "Foundation",             optional: false},
        {id: "per-hub",        label: "Per-hub scheduling",     optional: false},
        {id: "per-aircraft",   label: "Per-aircraft plan/logs", optional: false},
        {id: "per-route",      label: "Per-route markets",      optional: false},
        {id: "ors-rank",       label: "ORS rank refresh",       optional: false},
        {id: "per-competitor", label: "Competitor enrichment",  optional: true},
        {id: "flightsfrom",    label: "FlightsFrom",            optional: true}
    ]

    const DEFAULT_CADENCE_MS = {
        "foundation":     2 * 60 * 60 * 1000,
        "per-hub":        6 * 60 * 60 * 1000,
        "per-aircraft":  12 * 60 * 60 * 1000,
        "per-route":     24 * 60 * 60 * 1000,
        "ors-rank":       4 * 60 * 60 * 1000,
        "per-competitor": 2 * 24 * 60 * 60 * 1000,
        "flightsfrom":    7 * 24 * 60 * 60 * 1000
    }

    const PHASE_OWNER = {
        hubs:         {phase: "per-hub",      label: "Run per-hub scheduling"},
        routes:       {phase: "per-hub",      label: "Run per-hub scheduling"},
        schedule:     {phase: "per-hub",      label: "Run per-hub scheduling"},
        ors:          {phase: "ors-rank",     label: "Run ORS rank refresh"},
        markets:      {phase: "per-route",    label: "Run per-route markets"},
        fleet:        {phase: "foundation",   label: "Run foundation"},
        aircraftPlan: {phase: "per-aircraft", label: "Run per-aircraft plan/logs"},
        flightLog:    {phase: "per-aircraft", label: "Run per-aircraft plan/logs"},
        finance:      {phase: "foundation",   label: "Run foundation"}
    }

    class CentralHubMainboardTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "mainboard"
            this.title = "Mainboard"
            this.section = "fleet"
            this.priority = 0
            this.requiresAirline = false
            this.cardKind = "wide"
            this._readinessCache = null
        }

        watchedStorageKeys(ctx) {
            const host = this._host(ctx)
            const scoped = host.server && host.airline ? (host.server + host.airline) : ""
            return [
                "scrapeOrchestrator:",
                "aesAutoDrive:",
                "routeAssistant:topRoutes",
                "routeAssistant:ors:",
                "routeAssistant:markets:",
                "routeAssistant:inventory:",
                "aircraftFlightPlan:schedule:",
                "aircraftFlightPlan:maintenance:",
                "aircraftFlightPlan:flightLog:",
                scoped ? scoped + "accounting:" : "",
                scoped ? scoped + "aircraftFleet" : "",
                host.server ? host.server + "aircraftFlights" : ""
            ].filter(Boolean)
        }

        async refresh() {
            this._readinessCache = null
            await super.refresh()
        }

        async loadStatus(ctx) {
            const KIND = (window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND) || {}
            const data = await this._loadReadiness(ctx, {allowCache: true})
            const issueRows = this._issueRows(data)
            const failed = issueRows.filter(r => r.status === "failed").length
            const missing = issueRows.filter(r => r.status === "missing").length
            const stale = issueRows.filter(r => r.status === "stale").length

            let badge = "OK"
            let kind = KIND.OK || "ok"
            if (failed) {
                badge = failed + " FAILED"
                kind = KIND.ALERT || "alert"
            } else if (missing || stale) {
                badge = String(missing + stale)
                kind = missing ? (KIND.WARN || "warn") : (KIND.INFO || "info")
            } else if (!data.host.server) {
                badge = "NO HOST"
                kind = KIND.MUTED || "muted"
            }

            const network = data.network && data.network.summary || "network unknown"
            const phases = data.phaseSummary || "phases unknown"
            const run = data.scraper && data.scraper.lastRunText || "no scrape run"
            return {
                badge,
                badgeKind: kind,
                summary: network + " · " + phases + " · " + run
            }
        }

        async renderBody(ctx, hostEl) {
            const T = window.AESTokens
            const data = await this._loadReadiness(ctx, {allowCache: true})

            hostEl.textContent = ""
            hostEl.style.cssText = [
                "padding:" + T.sp[3],
                "display:flex",
                "flex-direction:column",
                "gap:" + T.sp[3],
                "font-family:" + T.font.display
            ].join(";")

            hostEl.appendChild(this._renderActionBar(data, T))
            hostEl.appendChild(this._renderSummaryStrip(data, T))
            hostEl.appendChild(this._renderGroup("Network readiness", data.network.rows, T))
            hostEl.appendChild(this._renderGroup("Fleet readiness", data.fleet.rows, T))
            hostEl.appendChild(this._renderGroup("Finance readiness", data.finance.rows, T))
            hostEl.appendChild(this._renderGroup("Scraper health", data.scraper.rows, T))
            hostEl.appendChild(this._renderPhaseGrid(data.phases, T))
        }

        async _loadReadiness(ctx, opts) {
            const now = Date.now()
            if (opts && opts.allowCache && this._readinessCache
                    && now - this._readinessCache.at < 2500) {
                return this._readinessCache.data
            }

            const host = this._host(ctx)
            const [storageAll, phases, lastRun, snapshot, accounting, autoDrive] = await Promise.all([
                this._loadStorageAll(),
                this._loadPhaseStates(host),
                this._loadLastRun(host),
                this._loadStrategySnapshot(host),
                this._loadAccounting(host),
                this._loadAutoDrive()
            ])

            const data = {
                host,
                phases,
                phaseSummary: this._phaseSummary(phases),
                network: this._buildNetworkReadiness(snapshot, storageAll, phases, now),
                fleet: this._buildFleetReadiness(snapshot, storageAll, phases, now, host),
                finance: this._buildFinanceReadiness(accounting, phases, now),
                scraper: this._buildScraperHealth(lastRun, phases, autoDrive, now)
            }
            this._readinessCache = {at: now, data}
            return data
        }

        _host(ctx) {
            return {
                server:  String((ctx && ctx.server) || ""),
                airline: String((ctx && ctx.airline) || "")
            }
        }

        async _loadStorageAll() {
            try {
                if (!chrome || !chrome.storage || !chrome.storage.local) return {}
                return await chrome.storage.local.get(null) || {}
            } catch (_) {
                return {}
            }
        }

        async _loadPhaseStates(host) {
            const store = window.AesPhaseCadenceStore
            const cadence = Object.assign({},
                DEFAULT_CADENCE_MS,
                store && store.DEFAULT_CADENCE_MS ? store.DEFAULT_CADENCE_MS : {})
            let records = {}
            if (store && typeof store.loadAll === "function" && host.server) {
                try {
                    records = await store.loadAll(host, PHASES.map(p => p.id)) || {}
                } catch (_) {
                    records = {}
                }
            }

            const now = Date.now()
            return PHASES.map(spec => {
                const rec = records[spec.id] || null
                const cad = cadence[spec.id]
                const ageMs = rec && rec.completedAt ? Math.max(0, now - Number(rec.completedAt)) : Infinity
                const failed = !!(rec && ((Number(rec.failed) || 0) > 0 || rec.haltReason))
                let status
                if (!rec || !rec.completedAt) status = spec.optional ? "optional" : "missing"
                else if (failed) status = "failed"
                else if (Number.isFinite(cad) && ageMs >= cad) status = "stale"
                else status = "fresh"
                return {
                    id: spec.id,
                    label: spec.label,
                    optional: !!spec.optional,
                    record: rec,
                    cadenceMs: cad,
                    ageMs,
                    overdueRatio: Number.isFinite(ageMs) && Number.isFinite(cad) && cad > 0 ? ageMs / cad : Infinity,
                    status,
                    detail: rec && rec.completedAt
                        ? this._fmtAge(ageMs) + " old · " + (rec.succeeded || 0) + "/" + (rec.total || 0) + " ok"
                            + ((rec.failed || rec.haltReason) ? " · " + ((rec.failed || 0) + " failed") : "")
                        : (spec.optional ? "optional; not run yet" : "never run")
                }
            })
        }

        async _loadLastRun(host) {
            if (window.AesScrapeRunArchiveStore && typeof window.AesScrapeRunArchiveStore.list === "function") {
                try {
                    const runs = await window.AesScrapeRunArchiveStore.list({host, limit: 1})
                    if (runs && runs[0]) return runs[0]
                } catch (_) {}
            }
            try {
                const blob = await chrome.storage.local.get(["scrapeOrchestrator:lastRun"])
                return blob && blob["scrapeOrchestrator:lastRun"] || null
            } catch (_) {
                return null
            }
        }

        async _loadStrategySnapshot(host) {
            if (!window.AesStrategy || typeof window.AesStrategy.snapshot !== "function") return null
            try {
                return await window.AesStrategy.snapshot({
                    server: host.server || undefined,
                    airlineCode: host.airline || undefined,
                    includeStaleDemand: true
                })
            } catch (_) {
                return null
            }
        }

        async _loadAccounting(host) {
            const out = {latest: null, sisters: null}
            if (!host.server || !host.airline || !window.AccountingSnapshotStore) return out
            try { out.latest = await window.AccountingSnapshotStore.loadLatest(host.server, host.airline) }
            catch (_) { out.latest = null }
            try { out.sisters = await window.AccountingSnapshotStore.loadAllSisters(host.server, host.airline) }
            catch (_) { out.sisters = null }
            return out
        }

        async _loadAutoDrive() {
            try {
                const blob = await chrome.storage.local.get(["aesAutoDrive:enabled", "aesAutoDrive:silentRunActive"])
                return {
                    enabled: blob["aesAutoDrive:enabled"] == null ? true : !!blob["aesAutoDrive:enabled"],
                    active:  !!blob["aesAutoDrive:silentRunActive"]
                }
            } catch (_) {
                return {enabled: false, active: false}
            }
        }

        _buildNetworkReadiness(snapshot, storageAll, phases, now) {
            const rows = []
            const hubs = Array.isArray(snapshot && snapshot.hubs) ? snapshot.hubs : []
            const routes = []
            for (const h of hubs) {
                for (const r of (h && h.byRoute) || []) routes.push({hub: h.iata, route: r})
            }

            const fallbackTopRoutes = this._topRoutesFromStorage(storageAll)
            const hubCount = hubs.length || fallbackTopRoutes.hubCount
            const routeCount = routes.length || fallbackTopRoutes.routeCount

            rows.push(this._row({
                label: "Hubs and routes",
                status: routeCount > 0 ? "fresh" : "missing",
                detail: routeCount > 0
                    ? hubCount + " hubs · " + routeCount + " routes cached"
                    : "No route snapshots found",
                owner: PHASE_OWNER.routes
            }))

            const perHubCadence = this._phaseCadence(phases, "per-hub")
            const scheduleStats = this._timestampStats(
                routes.map(x => x.route && x.route.snapshotAt).concat(fallbackTopRoutes.timestamps),
                perHubCadence,
                now
            )
            scheduleStats.missing = Math.max(0, routeCount - scheduleStats.present)
            rows.push(this._row({
                label: "Schedule cache",
                status: routeCount > 0
                    ? this._statusForStats(scheduleStats, routeCount)
                    : "missing",
                detail: routeCount > 0
                    ? this._statsDetail(scheduleStats, routeCount)
                    : "Missing route schedule snapshots",
                owner: PHASE_OWNER.schedule
            }))

            const orsCadence = this._phaseCadence(phases, "ors-rank")
            const orsStats = this._timestampStats(routes.map(x => x.route && x.route.orsScrapedAt), orsCadence, now)
            rows.push(this._row({
                label: "ORS rank cache",
                status: routeCount > 0
                    ? this._statusForStats(orsStats, routeCount)
                    : "missing",
                detail: routeCount > 0
                    ? this._statsDetail(orsStats, routeCount)
                    : "No routes available for ORS coverage",
                owner: PHASE_OWNER.ors
            }))

            const missing = Array.isArray(snapshot && snapshot.missing) ? snapshot.missing : []
            const routeModelMissing = missing.filter(m => /route|demand|distance|market|inventory|ors|type|fleet/i.test(String(m || "")))
            rows.push(this._row({
                label: "Route model sources",
                status: snapshot ? (routeModelMissing.length ? "missing" : "fresh") : "missing",
                detail: snapshot
                    ? (routeModelMissing.length
                        ? routeModelMissing.length + " source gaps: " + routeModelMissing.slice(0, 3).join(", ")
                        : "Strategy snapshot has route/model inputs")
                    : "AesStrategy snapshot unavailable",
                owner: PHASE_OWNER.markets
            }))

            return {
                rows,
                summary: routeCount > 0
                    ? "network " + hubCount + " hubs/" + routeCount + " routes"
                    : "network missing"
            }
        }

        _buildFleetReadiness(snapshot, storageAll, phases, now, host) {
            const rows = []
            const fleet = Array.isArray(snapshot && snapshot.fleet) ? snapshot.fleet : []
            const fallbackFleet = this._fleetFromStorage(storageAll, host)
            const aircraft = fleet.length ? fleet : fallbackFleet.aircraft
            const aircraftIds = aircraft.map(a => String(a && a.aircraftId || "")).filter(Boolean)
            const fleetAge = fallbackFleet.scrapedAt ? now - fallbackFleet.scrapedAt : null
            const foundationCadence = this._phaseCadence(phases, "foundation")
            const perAircraftCadence = this._phaseCadence(phases, "per-aircraft")

            rows.push(this._row({
                label: "Fleet roster",
                status: aircraftIds.length
                    ? (fleetAge != null && fleetAge >= foundationCadence ? "stale" : "fresh")
                    : "missing",
                detail: aircraftIds.length
                    ? aircraftIds.length + " aircraft" + (fleetAge != null ? " · " + this._fmtAge(fleetAge) + " old" : " · age unknown")
                    : "No fleet roster cached",
                owner: PHASE_OWNER.fleet
            }))

            const planStats = this._cacheStatsForIds(
                storageAll,
                "aircraftFlightPlan:maintenance:" + host.server + ":",
                aircraftIds,
                perAircraftCadence,
                now
            )
            rows.push(this._row({
                label: "Aircraft plan cache",
                status: aircraftIds.length ? this._statusForStats(planStats, aircraftIds.length) : "missing",
                detail: aircraftIds.length ? this._statsDetail(planStats, aircraftIds.length) : "No aircraft to check",
                owner: PHASE_OWNER.aircraftPlan
            }))

            const logStats = this._cacheStatsForIds(
                storageAll,
                "aircraftFlightPlan:flightLog:" + host.server + ":",
                aircraftIds,
                perAircraftCadence,
                now
            )
            rows.push(this._row({
                label: "Flight-log cache",
                status: aircraftIds.length ? this._statusForStats(logStats, aircraftIds.length) : "missing",
                detail: aircraftIds.length ? this._statsDetail(logStats, aircraftIds.length) : "No aircraft to check",
                owner: PHASE_OWNER.flightLog
            }))

            const scheduleStats = this._cacheStatsForIds(
                storageAll,
                "aircraftFlightPlan:schedule:" + host.server + ":",
                aircraftIds,
                perAircraftCadence,
                now
            )
            rows.push(this._row({
                label: "Visual schedule cache",
                status: aircraftIds.length ? this._statusForStats(scheduleStats, aircraftIds.length) : "optional",
                detail: aircraftIds.length ? this._statsDetail(scheduleStats, aircraftIds.length) : "No aircraft to check",
                owner: PHASE_OWNER.aircraftPlan
            }))

            return {rows}
        }

        _buildFinanceReadiness(accounting, phases, now) {
            const rows = []
            const cadence = this._phaseCadence(phases, "foundation")
            const latest = accounting && accounting.latest || {}
            const sisters = accounting && accounting.sisters || {}
            rows.push(this._financeRow("Accounting income", latest.income, cadence, now))
            rows.push(this._financeRow("Balance sheet", latest.balance, cadence, now))
            rows.push(this._financeRow("Cash and bank", latest.bank || (sisters && sisters.cashflow), cadence, now))
            return {rows}
        }

        _buildScraperHealth(lastRun, phases, autoDrive, now) {
            const rows = []
            const failedJobs = Array.isArray(lastRun && lastRun.failedJobs) ? lastRun.failedJobs.length : 0
            const perPhase = lastRun && lastRun.perPhase && typeof lastRun.perPhase === "object" ? lastRun.perPhase : {}
            let failedPhases = 0
            for (const id of Object.keys(perPhase)) {
                if ((Number(perPhase[id] && perPhase[id].failed) || 0) > 0) failedPhases++
            }
            const completedAt = lastRun && lastRun.completedAt
            const runFailed = !!(lastRun && (lastRun.aborted || lastRun.haltReason || failedJobs || failedPhases))
            rows.push(this._row({
                label: "Last scrape run",
                status: !lastRun ? "missing" : (runFailed ? "failed" : "fresh"),
                detail: !lastRun
                    ? "No scrape run recorded"
                    : this._lastRunText(lastRun, now)
                        + (completedAt ? " · " + this._fmtAge(now - Number(completedAt)) + " old" : ""),
                owner: {phase: "all", label: "Open full scrape"}
            }))
            rows.push(this._row({
                label: "Failed jobs",
                status: failedJobs || failedPhases ? "failed" : "fresh",
                detail: failedJobs || failedPhases
                    ? failedJobs + " failed jobs · " + failedPhases + " phases with failures"
                    : "No failed jobs in the latest run",
                owner: {phase: "archive", label: "Open scrape cache"}
            }))

            const stale = phases.filter(p => p.status === "stale").length
            const missing = phases.filter(p => p.status === "missing").length
            rows.push(this._row({
                label: "Stale mandatory phases",
                status: stale || missing ? (missing ? "missing" : "stale") : "fresh",
                detail: missing + " missing · " + stale + " stale",
                owner: this._nextPhase(phases) ? {phase: this._nextPhase(phases).id, label: "Run next overdue phase"} : null
            }))

            rows.push(this._row({
                label: "Silent auto-drive",
                status: autoDrive && autoDrive.active ? "running" : (autoDrive && autoDrive.enabled ? "fresh" : "stale"),
                detail: autoDrive && autoDrive.active
                    ? "Silent scrape is active"
                    : (autoDrive && autoDrive.enabled ? "Enabled; dashboard tick will run overdue phases" : "Disabled"),
                owner: {phase: "auto", label: "AesScrapeAutoDriver.tick"}
            }))

            return {
                rows,
                lastRunText: lastRun ? this._lastRunText(lastRun, now) : "no scrape run"
            }
        }

        _financeRow(label, rec, cadence, now) {
            const ts = rec && (rec.scrapedAt || rec.updatedAt || rec.completedAt)
            const age = ts ? Math.max(0, now - Number(ts)) : Infinity
            return this._row({
                label,
                status: !ts ? "missing" : (age >= cadence ? "stale" : "fresh"),
                detail: ts ? this._fmtAge(age) + " old" : "No cache found",
                owner: PHASE_OWNER.finance
            })
        }

        _row(input) {
            return {
                label: String(input.label || ""),
                status: String(input.status || "muted"),
                detail: String(input.detail || ""),
                owner: input.owner || null
            }
        }

        _topRoutesFromStorage(storageAll) {
            const timestamps = []
            let hubCount = 0
            let routeCount = 0
            for (const key of Object.keys(storageAll || {})) {
                if (key.indexOf("routeAssistant:topRoutes:") !== 0) continue
                if (key.indexOf(":perClass:") >= 0) continue
                const rec = storageAll[key]
                if (!rec || !Array.isArray(rec.rows)) continue
                hubCount++
                routeCount += rec.rows.length
                if (rec.scrapedAt || rec.snapshotAt) timestamps.push(rec.scrapedAt || rec.snapshotAt)
            }
            return {hubCount, routeCount, timestamps}
        }

        _fleetFromStorage(storageAll, host) {
            const out = {aircraft: [], scrapedAt: null}
            for (const key of Object.keys(storageAll || {})) {
                if (!host.server || key.indexOf(host.server) !== 0) continue
                if (key.lastIndexOf("aircraftFleet") !== key.length - "aircraftFleet".length) continue
                const rec = storageAll[key]
                if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) continue
                if (host.airline && rec.airline && String(rec.airline) !== host.airline) continue
                out.aircraft = rec.fleet
                out.scrapedAt = rec.scrapedAt || rec.updatedAt || this._parseServerDate(rec.fleet[0])
                break
            }
            return out
        }

        _parseServerDate(row) {
            if (!row || !row.date) return null
            const s = String(row.date)
            const t = String(row.time || "00:00")
            const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
            const hm = /^(\d{1,2}):(\d{2})$/.exec(t)
            if (!m) return null
            const hh = hm ? Number(hm[1]) : 0
            const mm = hm ? Number(hm[2]) : 0
            return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm)
        }

        _timestampStats(timestamps, maxAgeMs, now) {
            const finite = (timestamps || [])
                .map(v => Number(v))
                .filter(v => Number.isFinite(v) && v > 0)
            const stale = finite.filter(ts => now - ts >= maxAgeMs).length
            const newest = finite.length ? Math.max.apply(null, finite) : null
            return {
                present: finite.length,
                missing: Math.max(0, (timestamps || []).length - finite.length),
                stale,
                newestAt: newest,
                newestAgeMs: newest ? now - newest : Infinity
            }
        }

        _cacheStatsForIds(storageAll, prefix, ids, maxAgeMs, now) {
            const byId = new Map()
            for (const key of Object.keys(storageAll || {})) {
                if (key.indexOf(prefix) !== 0) continue
                const id = key.slice(prefix.length)
                if (!id) continue
                const rec = storageAll[key]
                const ts = rec && (rec.scrapedAt || rec.updatedAt || rec.createdAt)
                byId.set(String(id), Number(ts) || null)
            }
            const timestamps = ids.map(id => byId.get(String(id)) || null)
            const stats = this._timestampStats(timestamps, maxAgeMs, now)
            stats.missing = Math.max(0, ids.length - stats.present)
            return stats
        }

        _statusForStats(stats, expected) {
            if (!expected) return "missing"
            if (!stats || !stats.present) return "missing"
            if (stats.missing > 0) return "missing"
            if (stats.stale > 0) return "stale"
            return "fresh"
        }

        _statsDetail(stats, expected) {
            if (!stats || !expected) return "No records"
            const fresh = Math.max(0, stats.present - stats.stale)
            const parts = [
                fresh + " fresh",
                stats.stale + " stale",
                stats.missing + " missing"
            ]
            if (Number.isFinite(stats.newestAgeMs)) parts.push("newest " + this._fmtAge(stats.newestAgeMs) + " old")
            return parts.join(" · ")
        }

        _phaseCadence(phases, phaseId) {
            const row = (phases || []).find(p => p.id === phaseId)
            return row && Number.isFinite(row.cadenceMs) ? row.cadenceMs : DEFAULT_CADENCE_MS[phaseId]
        }

        _nextPhase(phases) {
            const candidates = (phases || []).filter(p =>
                !p.optional && (p.status === "missing" || p.status === "stale" || p.status === "failed"))
            if (!candidates.length) return null
            candidates.sort((a, b) => {
                const ar = Number.isFinite(a.overdueRatio) ? a.overdueRatio : 999
                const br = Number.isFinite(b.overdueRatio) ? b.overdueRatio : 999
                return br - ar
            })
            return candidates[0]
        }

        _phaseSummary(phases) {
            const mandatory = (phases || []).filter(p => !p.optional)
            const fresh = mandatory.filter(p => p.status === "fresh").length
            const stale = mandatory.filter(p => p.status === "stale").length
            const missing = mandatory.filter(p => p.status === "missing").length
            const failed = mandatory.filter(p => p.status === "failed").length
            return "phases " + fresh + " fresh/" + stale + " stale/" + missing + " missing/" + failed + " failed"
        }

        _lastRunText(run, now) {
            if (!run) return "no scrape run"
            const status = run.status || (run.aborted ? "aborted" : (run.haltReason ? "halted" : "done"))
            const failed = Array.isArray(run.failedJobs) ? run.failedJobs.length : 0
            const completed = run.completedAt ? this._fmtAge(now - Number(run.completedAt)) + " ago" : "not completed"
            return status + " · " + completed + (failed ? " · " + failed + " failed" : "")
        }

        _issueRows(data) {
            const all = []
            for (const key of ["network", "fleet", "finance", "scraper"]) {
                const group = data && data[key]
                if (group && Array.isArray(group.rows)) all.push.apply(all, group.rows)
            }
            for (const p of (data && data.phases) || []) {
                if (!p.optional) all.push(p)
            }
            return all.filter(r => r && (r.status === "missing" || r.status === "stale" || r.status === "failed"))
        }

        _renderActionBar(data, T) {
            const wrap = document.createElement("div")
            wrap.style.cssText = [
                "display:flex",
                "align-items:center",
                "gap:" + T.sp[2],
                "flex-wrap:wrap"
            ].join(";")

            wrap.appendChild(this._button("Open full scrape", T, "primary", () => {
                if (window.AESScrapeHost && typeof window.AESScrapeHost.open === "function") {
                    window.AESScrapeHost.open()
                } else {
                    console.warn("[AES Mainboard] AESScrapeHost not loaded")
                }
            }))

            wrap.appendChild(this._button("Open scrape cache", T, "ghost", () => {
                if (window.ScrapeArchiveModal && typeof window.ScrapeArchiveModal.open === "function") {
                    window.ScrapeArchiveModal.open(data.host)
                } else {
                    console.warn("[AES Mainboard] ScrapeArchiveModal not loaded")
                }
            }))

            const next = this._nextPhase(data.phases)
            const tick = this._button(
                next ? ("Run next phase: " + next.id) : "No overdue phase",
                T,
                next ? "accent" : "disabled",
                async (btn) => {
                    if (!next) return
                    if (!window.AesScrapeAutoDriver || typeof window.AesScrapeAutoDriver.tick !== "function") {
                        console.warn("[AES Mainboard] AesScrapeAutoDriver not loaded")
                        return
                    }
                    btn.disabled = true
                    btn.textContent = "Ticking..."
                    try { await window.AesScrapeAutoDriver.tick("mainboard") }
                    catch (err) { console.warn("[AES Mainboard] auto tick failed", err) }
                    this._readinessCache = null
                    await this.refresh()
                }
            )
            if (!next) tick.disabled = true
            wrap.appendChild(tick)

            const hint = document.createElement("span")
            hint.textContent = next
                ? "Fix target: " + next.label
                : "All mandatory phases are inside cadence."
            hint.style.cssText = [
                "color:" + T.color.slate,
                "font-size:" + T.fs.small,
                "font-family:" + T.font.display
            ].join(";")
            wrap.appendChild(hint)
            return wrap
        }

        _renderSummaryStrip(data, T) {
            const strip = document.createElement("div")
            strip.style.cssText = [
                "display:grid",
                "grid-template-columns:repeat(auto-fit,minmax(150px,1fr))",
                "gap:" + T.sp[2]
            ].join(";")
            const items = [
                ["Network", data.network.summary],
                ["Fleet", this._compactGroupSummary(data.fleet.rows)],
                ["Finance", this._compactGroupSummary(data.finance.rows)],
                ["Scraper", data.phaseSummary]
            ]
            for (const item of items) {
                const cell = document.createElement("div")
                cell.style.cssText = [
                    "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                    "background:" + T.color.bone2,
                    "padding:" + T.sp[2],
                    "min-width:0"
                ].join(";")
                const label = document.createElement("div")
                label.textContent = item[0]
                label.style.cssText = [
                    "color:" + T.color.slate,
                    "font-size:" + T.fs.micro,
                    "font-family:" + T.font.mono,
                    "letter-spacing:" + T.track.mono,
                    "text-transform:uppercase"
                ].join(";")
                const value = document.createElement("div")
                value.textContent = item[1]
                value.style.cssText = [
                    "margin-top:" + T.sp[1],
                    "color:" + T.color.oxide,
                    "font-size:" + T.fs.body,
                    "white-space:nowrap",
                    "overflow:hidden",
                    "text-overflow:ellipsis"
                ].join(";")
                value.title = item[1]
                cell.append(label, value)
                strip.appendChild(cell)
            }
            return strip
        }

        _compactGroupSummary(rows) {
            const total = (rows || []).length
            const issues = (rows || []).filter(r => r.status === "missing" || r.status === "stale" || r.status === "failed").length
            return issues ? (issues + "/" + total + " need attention") : (total + "/" + total + " ready")
        }

        _renderGroup(title, rows, T) {
            const sec = document.createElement("section")
            sec.style.cssText = [
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "background:" + T.color.bone,
                "padding:" + T.sp[3],
                "display:flex",
                "flex-direction:column",
                "gap:" + T.sp[2]
            ].join(";")
            const h = document.createElement("h4")
            h.textContent = title
            h.style.cssText = [
                "margin:0",
                "color:" + T.color.oxide,
                "font-size:" + T.fs.lead,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps
            ].join(";")
            sec.appendChild(h)
            for (const row of rows || []) sec.appendChild(this._renderReadinessRow(row, T))
            return sec
        }

        _renderReadinessRow(row, T) {
            const el = document.createElement("div")
            el.style.cssText = [
                "display:grid",
                "grid-template-columns:minmax(120px,0.8fr) auto minmax(180px,1.4fr) minmax(120px,0.8fr)",
                "gap:" + T.sp[2],
                "align-items:center",
                "font-size:" + T.fs.body,
                "min-width:0"
            ].join(";")

            const label = document.createElement("div")
            label.textContent = row.label
            label.style.cssText = "font-weight:" + T.fw.display + ";color:" + T.color.oxide + ";min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"

            const badge = this._statusPill(row.status, T)

            const detail = document.createElement("div")
            detail.textContent = row.detail || ""
            detail.title = row.detail || ""
            detail.style.cssText = "color:" + T.color.oxide2 + ";min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"

            const owner = document.createElement("div")
            owner.textContent = row.owner && row.owner.phase ? ("phase: " + row.owner.phase) : ""
            owner.title = row.owner && row.owner.label || ""
            owner.style.cssText = [
                "color:" + T.color.slate,
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.micro,
                "letter-spacing:" + T.track.mono,
                "text-transform:uppercase",
                "min-width:0",
                "overflow:hidden",
                "text-overflow:ellipsis",
                "white-space:nowrap"
            ].join(";")

            el.append(label, badge, detail, owner)
            return el
        }

        _renderPhaseGrid(phases, T) {
            const sec = this._renderGroup("Phase freshness", [], T)
            const grid = document.createElement("div")
            grid.style.cssText = [
                "display:grid",
                "grid-template-columns:repeat(auto-fit,minmax(180px,1fr))",
                "gap:" + T.sp[2]
            ].join(";")
            for (const phase of phases || []) {
                const cell = document.createElement("div")
                cell.style.cssText = [
                    "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                    "background:" + T.color.bone2,
                    "padding:" + T.sp[2],
                    "min-width:0"
                ].join(";")
                const top = document.createElement("div")
                top.style.cssText = "display:flex;align-items:center;gap:" + T.sp[2] + ";min-width:0;"
                const label = document.createElement("strong")
                label.textContent = phase.label
                label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:" + T.color.oxide + ";"
                top.append(label, this._statusPill(phase.status, T))
                const detail = document.createElement("div")
                detail.textContent = phase.detail
                detail.style.cssText = "margin-top:" + T.sp[1] + ";color:" + T.color.slate + ";font-size:" + T.fs.small + ";"
                cell.append(top, detail)
                grid.appendChild(cell)
            }
            sec.appendChild(grid)
            return sec
        }

        _statusPill(status, T) {
            const labelMap = {
                fresh: "fresh",
                stale: "stale",
                missing: "missing",
                failed: "failed",
                optional: "optional",
                running: "running",
                muted: "info"
            }
            const color = this._statusColors(status, T)
            const el = document.createElement("span")
            el.textContent = labelMap[status] || status || "info"
            el.style.cssText = [
                "display:inline-block",
                "padding:1px " + T.sp[2],
                "border:" + T.geom.bw1 + " solid " + color.border,
                "background:" + color.bg,
                "color:" + color.fg,
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.micro,
                "letter-spacing:" + T.track.mono,
                "text-transform:uppercase",
                "white-space:nowrap"
            ].join(";")
            return el
        }

        _statusColors(status, T) {
            const map = {
                fresh:    {bg: T.color.mossSoft,   fg: T.color.moss,    border: T.color.moss},
                stale:    {bg: T.color.amberSoft,  fg: T.color.amber,   border: T.color.amber},
                missing:  {bg: T.color.amberSoft,  fg: T.color.amber,   border: T.color.amber},
                failed:   {bg: T.color.rustSoft,   fg: T.color.rust,    border: T.color.rust},
                optional: {bg: "transparent",      fg: T.color.slate,   border: T.color.paperRule},
                running:  {bg: T.color.cobaltSoft, fg: T.color.cobalt,  border: T.color.cobalt},
                muted:    {bg: "transparent",      fg: T.color.slate,   border: T.color.paperRule}
            }
            return map[status] || map.muted
        }

        _button(text, T, kind, handler) {
            const colors = {
                primary:  {bg: T.color.oxide,    fg: T.color.bone,  border: T.color.oxide},
                ghost:    {bg: "transparent",    fg: T.color.oxide, border: T.color.oxide},
                accent:   {bg: T.color.cobalt,   fg: T.color.bone,  border: T.color.cobalt},
                disabled: {bg: T.color.bone2,    fg: T.color.slate, border: T.color.paperRule}
            }[kind] || {}
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = text
            btn.style.cssText = [
                "background:" + colors.bg,
                "color:" + colors.fg,
                "border:" + T.geom.bw1 + " solid " + colors.border,
                "border-radius:" + T.geom.radius,
                "padding:" + T.sp[1] + " " + T.sp[3],
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "cursor:" + (kind === "disabled" ? "default" : "pointer")
            ].join(";")
            if (handler) {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation()
                    handler(btn)
                })
            }
            return btn
        }

        _fmtAge(ms) {
            if (!Number.isFinite(ms)) return "never"
            const value = Math.max(0, ms)
            if (value < 60 * 1000) return "just now"
            if (value < 60 * 60 * 1000) return Math.floor(value / 60000) + "m"
            if (value < 24 * 60 * 60 * 1000) return Math.floor(value / 3600000) + "h"
            return Math.floor(value / 86400000) + "d"
        }
    }

    window.CentralHubMainboardTile = CentralHubMainboardTile
    if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register({
            id: "mainboard",
            section: "fleet",
            priority: 0,
            cardKind: "wide",
            salienceDomains: ["scrape", "cache", "data-readiness", "cash-low", "maintenance"],
            factory: () => new CentralHubMainboardTile()
        })
    }
})()
