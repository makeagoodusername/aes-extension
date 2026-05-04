"use strict"

/**
 * AES Strategy — remote data refresh.
 *
 * Content-side helper for the strategy panel. It builds a small scrape plan
 * and sends it to the service-worker ScrapeTabPool so Refresh can seed the
 * stores strategy depends on without forcing the user through every AS tab.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyRemoteRefresh) return

    const FOUNDATION_TARGETS = [
        {path: "/app/fleets",                      key: "aircraftFleet"},
        {path: "/app/finance/accounting/0",        key: "accounting:income:"},
        {path: "/app/finance/accounting/1",        key: "accounting:balance:"},
        {path: "/app/finance/accounting/2",        key: "accounting:bank:"},
        {path: "/app/finance/leasing",             key: "accounting:leasing"},
        {path: "/app/finance/capital",             key: "accounting:capital"},
        {path: "/app/finance/assets",              key: "accounting:assets"},
        {path: "/app/alliance",                    key: "alliance:overview"},
        {path: "/action/enterprise/staffPilots",   key: "crewMgmt:pilots"},
        {path: "/action/enterprise/staffOverview", key: "crewMgmt:staffOverview:latest"}
    ]

    const PHASES = {
        foundation:   {label: "Foundation", concurrency: 3, staggerMs: 1200},
        "per-hub":    {label: "Hub routes", concurrency: 2, staggerMs: 1200},
        "per-aircraft": {label: "Aircraft schedules", concurrency: 2, staggerMs: 1200},
        "per-route":  {label: "Route markets", concurrency: 2, staggerMs: 1200}
    }
    const STATUS_POLL_MS = 2500
    const PLACEHOLDER_SERVERS = /^(test|mock|example|localhost|local|127|0)$/i

    function _looksLikeAirlineSimServer(server) {
        const s = String(server || "").trim()
        return /^[a-z0-9][a-z0-9-]*$/i.test(s) && !PLACEHOLDER_SERVERS.test(s)
    }

    function _server(opts) {
        if (opts && opts.server) return String(opts.server)
        try { if (window.AES && AES.getServerName) return AES.getServerName() || "" } catch (_) {}
        try { if (window.AES && AES.getServer) return AES.getServer() || "" } catch (_) {}
        const host = location && location.hostname || ""
        const m = host.match(/^([^.]+)\.airlinesim\.aero$/)
        return m ? m[1] : ""
    }

    function _airline(opts) {
        if (opts && opts.airline) return String(opts.airline)
        if (opts && opts.airlineCode) return String(opts.airlineCode)
        try {
            const code = window.AES && AES.getAirlineCode && AES.getAirlineCode()
            if (code && code.code) return String(code.code)
        } catch (_) {}
        try { if (window.AES && AES.getAirlineIdentity) return AES.getAirlineIdentity() || "" } catch (_) {}
        return ""
    }

    function _origin(server) {
        const host = location && location.hostname || ""
        if (/\.airlinesim\.aero$/.test(host)) return location.protocol + "//" + host
        return "https://" + server + ".airlinesim.aero"
    }

    function _uc(value) { return String(value || "").toUpperCase() }

    function _routeKey(hub, dest) {
        const h = _uc(hub)
        const d = _uc(dest)
        return h && d && h !== d ? h + "-" + d : ""
    }

    async function _storageAll() {
        try { return await chrome.storage.local.get(null) }
        catch (_) { return {} }
    }

    function _matchFleetRecord(rec, airline) {
        if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) return false
        if (!airline) return true
        const a = String(airline)
        return String(rec.airline || "") === a
            || String(rec.airlineCode || "") === a
            || String(rec.displayName || "") === a
            || String(rec.name || "") === a
    }

    async function _enumerateAircraft(server, airline) {
        const all = await _storageAll()
        let chosen = null
        let best = 0
        for (const key of Object.keys(all)) {
            if (server && key.indexOf(server) !== 0) continue
            if (!/aircraftFleet$/.test(key)) continue
            const rec = all[key]
            if (!_matchFleetRecord(rec, airline) && airline) continue
            if (_matchFleetRecord(rec, airline) || !chosen || rec.fleet.length > best) {
                chosen = rec
                best = rec.fleet.length
                if (airline && _matchFleetRecord(rec, airline)) break
            }
        }
        return ((chosen && chosen.fleet) || []).filter(a => a && a.aircraftId).map(a => ({
            aircraftId:   String(a.aircraftId),
            registration: a.registration || a.reg || "",
            location:     _uc(a.location || a.hub || a.station || a.currentLocationIata),
            equipment:    a.equipment || a.type || ""
        }))
    }

    async function _enumerateHubs(server, airline, opts) {
        const out = new Set()
        for (const r of (opts && opts.routes) || []) {
            if (r && r.hub) out.add(_uc(r.hub))
        }
        for (const a of await _enumerateAircraft(server, airline)) {
            if (a.location) out.add(a.location)
        }
        const all = await _storageAll()
        const recent = all.settings && all.settings.routeAssistant && all.settings.routeAssistant.recentHubs
        if (!out.size && Array.isArray(recent)) {
            for (const h of recent) if (h) out.add(_uc(h))
        }
        return Array.from(out).filter(Boolean).sort()
    }

    function _routesFromSchedules(currentSchedules, add) {
        if (!currentSchedules || typeof currentSchedules.forEach !== "function") return
        currentSchedules.forEach(legs => {
            if (!Array.isArray(legs)) {
                if (legs && Array.isArray(legs.legs)) legs = legs.legs
                else return
            }
            for (const leg of legs) add(leg && leg.origin, leg && leg.destination)
        })
    }

    async function _enumerateRoutes(server, opts) {
        const seen = new Set()
        const out = []
        const add = (hub, dest) => {
            const key = _routeKey(hub, dest)
            if (!key || seen.has(key)) return
            seen.add(key)
            const parts = key.split("-")
            out.push({hub: parts[0], dest: parts[1]})
        }

        for (const r of (opts && opts.routes) || []) add(r && r.hub, r && r.dest)
        _routesFromSchedules(opts && opts.currentSchedules, add)

        const all = await _storageAll()
        for (const key of Object.keys(all)) {
            if (key.indexOf("routeAssistant:topRoutes:") !== 0 && key.indexOf("topRoutes:") < 0) continue
            const blob = all[key]
            if (!blob || !Array.isArray(blob.rows)) continue
            if (server && blob.server && String(blob.server) !== String(server)) continue
            const hub = _uc(blob.hub || key.split(":").pop())
            for (const row of blob.rows) add(hub, row && (row.destIata || row.dest))
        }
        return out.sort((a, b) => (a.hub + a.dest).localeCompare(b.hub + b.dest))
    }

    function _job(jobId, phaseId, url, key, settleMs, storagePollMs) {
        const out = {
            jobId,
            phaseId,
            url,
            settleMs: settleMs == null ? 1600 : settleMs,
            acceptExistingStorage: true
        }
        if (key) out.expectStorageKeyPrefix = key
        if (storagePollMs != null) out.storagePollMs = storagePollMs
        return out
    }

    async function _buildJobs(phaseId, ctx, opts) {
        const origin = ctx.origin
        if (phaseId === "foundation") {
            return FOUNDATION_TARGETS.map((t, idx) =>
                _job("strategy-foundation-" + idx, "strategy-foundation",
                    origin + t.path, t.key, 1600, 20000))
        }
        if (phaseId === "per-hub") {
            const hubs = await _enumerateHubs(ctx.server, ctx.airline, opts)
            return hubs.map(hub => _job("strategy-hub-" + hub, "strategy-per-hub",
                origin + "/app/com/scheduling/" + encodeURIComponent(hub),
                "topRoutes:" + hub, 2200, 30000))
        }
        if (phaseId === "per-aircraft") {
            const aircraft = Array.isArray(opts.aircraft) && opts.aircraft.length
                ? opts.aircraft
                : await _enumerateAircraft(ctx.server, ctx.airline)
            const jobs = []
            for (const a of aircraft) {
                const id = String(a.aircraftId || a.id || "")
                if (!id) continue
                jobs.push(_job("strategy-aircraft-" + id + "-plan", "strategy-per-aircraft",
                    origin + "/app/fleets/aircraft/" + encodeURIComponent(id) + "/0",
                    "aircraftFlightPlan:maintenance:" + ctx.server + ":" + id, 1800, 25000))
                jobs.push(_job("strategy-aircraft-" + id + "-flights", "strategy-per-aircraft",
                    origin + "/app/fleets/aircraft/" + encodeURIComponent(id) + "/1",
                    "aircraftFlights" + id, 1600, 20000))
            }
            return jobs
        }
        if (phaseId === "per-route") {
            const routes = await _enumerateRoutes(ctx.server, opts)
            const jobs = []
            for (const r of routes) {
                const pair = _uc(r.hub) + _uc(r.dest)
                const label = _uc(r.hub) + "-" + _uc(r.dest)
                if (pair.length !== 6) continue
                jobs.push(_job("strategy-markets-" + label, "strategy-per-route",
                    origin + "/app/com/markets/" + encodeURIComponent(pair),
                    "markets:competitors:" + label, 1900, 25000))
                jobs.push(_job("strategy-inventory-" + label, "strategy-per-route",
                    origin + "/app/com/inventory/" + encodeURIComponent(pair),
                    "inventory:" + label, 1600, 20000))
            }
            return jobs
        }
        return []
    }

    function _sendRuntime(message) {
        return new Promise(resolve => {
            try {
                chrome.runtime.sendMessage(message, resp => {
                    void chrome.runtime.lastError
                    resolve(resp || null)
                })
            } catch (e) {
                resolve({ok: false, error: (e && e.message) || String(e)})
            }
        })
    }

    function _runJobs(phaseId, jobs, phaseCfg, onProgress) {
        if (!jobs.length) {
            if (onProgress) onProgress({stage: "phase-done", phaseId, total: 0, ok: 0, failed: 0, skipped: true})
            return Promise.resolve({total: 0, ok: 0, failed: 0, skipped: true})
        }
        return new Promise(resolve => {
            let done = 0
            let ok = 0
            let failed = 0
            let settled = false
            let watchdog = null
            let statusPoll = null
            let started = false
            let runId = null

            const finish = result => {
                if (settled) return
                settled = true
                if (watchdog) clearTimeout(watchdog)
                if (statusPoll) clearInterval(statusPoll)
                try { chrome.runtime.onMessage.removeListener(listener) } catch (_) {}
                resolve(result)
            }
            const arm = () => {
                if (watchdog) clearTimeout(watchdog)
                watchdog = setTimeout(() => {
                    finish({total: jobs.length, ok, failed, haltReason: "background-disconnect"})
                }, 15 * 60 * 1000)
            }
            const listener = msg => {
                if (!msg || msg.type !== "aes:scrape-all:progress" || !msg.event) return
                const ev = msg.event
                arm()
                if (ev.type === "run-start" && ev.runId) runId = ev.runId
                if (ev.type === "job-done") { done++; ok++ }
                else if (ev.type === "job-fail") { done++; failed++ }
                if (onProgress) {
                    onProgress({
                        stage: "progress",
                        phaseId,
                        label: phaseCfg.label,
                        event: ev,
                        done,
                        total: jobs.length,
                        ok,
                        failed
                    })
                }
                if (ev.type === "run-done") {
                    finish({total: jobs.length, ok, failed, haltReason: ev.reason && ev.reason !== "done" ? ev.reason : null})
                }
            }
            const pollStatus = async () => {
                if (settled || !started) return
                const resp = await _sendRuntime({type: "aes:scrape-all:status"})
                if (settled || !resp || !resp.ok || !resp.status) return
                const st = resp.status
                if (runId && st.runId && st.runId !== runId) return
                if (Number(st.succeeded) > ok) ok = Number(st.succeeded)
                if (Number(st.failed) > failed) failed = Number(st.failed)
                done = Math.max(done, ok + failed)
                if (st.running === false) {
                    finish({
                        total: jobs.length,
                        ok,
                        failed,
                        haltReason: st.haltReason || (done < jobs.length ? "run-done-missed" : null)
                    })
                    return
                }
                if (Number(st.completed) >= jobs.length) {
                    finish({
                        total: jobs.length,
                        ok,
                        failed,
                        haltReason: st.haltReason || null
                    })
                }
            }
            const startStatusPoll = () => {
                if (statusPoll) return
                statusPoll = setInterval(() => { pollStatus().catch(() => {}) }, STATUS_POLL_MS)
            }
            try { chrome.runtime.onMessage.addListener(listener) } catch (_) {}
            arm()
            _sendRuntime({
                type: "aes:scrape-all:start",
                plan: jobs,
                concurrency: phaseCfg.concurrency,
                staggerMs: phaseCfg.staggerMs
            }).then(resp => {
                if (!resp || !resp.ok) {
                    finish({total: jobs.length, ok: 0, failed: jobs.length,
                        haltReason: (resp && (resp.reason || resp.error)) || "start-failed"})
                } else {
                    started = true
                    runId = resp.runId || runId
                    startStatusPoll()
                }
            })
        })
    }

    async function run(opts, onProgress) {
        const o = opts || {}
        const server = _server(o)
        if (!server) throw new Error("Strategy remote refresh needs a server")
        if (!_looksLikeAirlineSimServer(server)) {
            const phases = Array.isArray(o.phases) && o.phases.length
                ? o.phases.map(String)
                : ["foundation", "per-hub", "per-aircraft", "per-route"]
            const report = {
                ok: true,
                skipped: true,
                skipReason: "non-live-server",
                phases: [],
                totalJobs: 0,
                okJobs: 0,
                failedJobs: 0
            }
            if (onProgress) {
                onProgress({stage: "start", phases})
                onProgress({stage: "done", report})
            }
            return report
        }
        const ctx = {
            server,
            airline: _airline(o),
            origin: o.origin || _origin(server)
        }
        const phases = Array.isArray(o.phases) && o.phases.length
            ? o.phases.map(String)
            : ["foundation", "per-hub", "per-aircraft", "per-route"]
        const report = {ok: true, phases: [], totalJobs: 0, okJobs: 0, failedJobs: 0}
        if (onProgress) onProgress({stage: "start", phases})
        for (const phaseId of phases) {
            const cfg = PHASES[phaseId]
            if (!cfg) continue
            if (onProgress) onProgress({stage: "phase-start", phaseId, label: cfg.label})
            const jobs = await _buildJobs(phaseId, ctx, o)
            if (onProgress) onProgress({stage: "phase-jobs", phaseId, label: cfg.label, total: jobs.length})
            const result = await _runJobs(phaseId, jobs, cfg, onProgress)
            report.phases.push(Object.assign({phaseId, label: cfg.label}, result))
            report.totalJobs += result.total || 0
            report.okJobs += result.ok || 0
            report.failedJobs += result.failed || 0
            if (result.haltReason && result.haltReason !== "done") {
                report.ok = false
                report.haltReason = result.haltReason
                break
            }
        }
        if (onProgress) onProgress({stage: "done", report})
        return report
    }

    window.AesStrategyRemoteRefresh = {
        run,
        _internals: {
            FOUNDATION_TARGETS,
            _enumerateAircraft,
            _enumerateHubs,
            _enumerateRoutes,
            _looksLikeAirlineSimServer,
            _buildJobs
        }
    }
})()
