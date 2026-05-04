"use strict"

/**
 * AesScrapeRunArchiveStore — storage-backed history for manual and silent
 * scrape-orchestrator runs.
 *
 * Storage:
 *   scrapeOrchestrator:archive:index
 *      -> newest-first summaries, capped
 *   scrapeOrchestrator:archive:<server>:<airline>:<runId>
 *      -> full run record with per-phase counts, failures, and touched cache keys
 *
 * The archive stores a manifest of scrape activity, not a duplicate copy of
 * every scraped payload. The scraped data remains in its normal cache keys;
 * clearBefore(..., {includeCache: true}) can remove those touched keys when
 * the user explicitly requests cache cleanup.
 */
;(function () {
    if (typeof window === "undefined" || window.AesScrapeRunArchiveStore) return

    const SCHEMA_VERSION = 1
    const INDEX_KEY = "scrapeOrchestrator:archive:index"
    const PREFIX = "scrapeOrchestrator:archive:"
    const LAST_RUN_KEY = "scrapeOrchestrator:lastRun"
    const MAX_INDEX_ENTRIES = 240
    const MAX_JOBS_PER_PHASE = 500
    const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

    const CACHE_PREFIXES = [
        "flightsFrom:",
        "routeAssistant:demand:",
        "routeAssistant:distance:",
        "routeAssistant:fuelPriceIndex",
        "routeAssistant:typeSpec:",
        "routeAssistant:ticketPrice:",
        "routeAssistant:yieldHistory:",
        "routeAssistant:topRoutes",
        "routeAssistant:lastSnapshot:",
        "routeAssistant:carriers:",
        "routeAssistant:enterpriseMeta:",
        "routeAssistant:contractualPartners:",
        "routeAssistant:markets:",
        "routeAssistant:inventory:",
        "routeAssistant:ors:",
        "accounting:",
        "alliance:overview",
        "crewMgmt:",
        "aircraftFlightPlan:schedule:",
        "aircraftFlightPlan:flightLog:",
        "aircraftFlightPlan:maintenance:"
    ]
    const CACHE_FRAGMENTS = [
        "accounting:",
        "alliance:overview",
        "aircraftFleet",
        "aircraftFlights",
        "crewMgmt:",
        "marketScan:",
        "stationAutomationRun:"
    ]

    function _host(host) {
        return {
            server:  String((host && host.server) || ""),
            airline: String((host && host.airline) || "")
        }
    }

    function _key(server, airline, runId) {
        return PREFIX + String(server || "") + ":" + String(airline || "") + ":" + String(runId || "")
    }

    function _recordKey(record) {
        return _key(record.server, record.airline, record.runId)
    }

    function _array(v) {
        return Array.isArray(v) ? v : []
    }

    function _uniqueStrings(values) {
        const seen = new Set()
        const out = []
        for (const v of _array(values)) {
            const s = String(v || "").trim()
            if (!s || seen.has(s)) continue
            seen.add(s)
            out.push(s)
        }
        return out
    }

    function isScrapeCacheKey(key) {
        const s = String(key || "")
        if (!s || s.indexOf("scrapeOrchestrator:") === 0) return false
        for (const p of CACHE_PREFIXES) {
            if (s.indexOf(p) === 0) return true
        }
        for (const f of CACHE_FRAGMENTS) {
            if (s.indexOf(f) >= 0) return true
        }
        return false
    }

    function filterCacheKeys(keys) {
        return _uniqueStrings(keys).filter(isScrapeCacheKey)
    }

    function startOfToday() {
        const d = new Date()
        d.setHours(0, 0, 0, 0)
        return d.getTime()
    }

    function _normalisePhase(phaseId, raw) {
        const p = raw && typeof raw === "object" ? raw : {}
        const jobs = _array(p.jobs).map(j => ({
            jobId:      String((j && j.jobId) || ""),
            status:     (j && j.status === "failed") ? "failed" : "ok",
            url:        String((j && j.url) || ""),
            durationMs: Number((j && j.durationMs) || 0) || 0,
            error:      (j && j.error) ? String(j.error) : "",
            storageKeys: filterCacheKeys(j && j.storageKeys)
        })).filter(j => j.jobId || j.url)
        const keptJobs = jobs.slice(0, MAX_JOBS_PER_PHASE)

        return {
            label:           String(p.label || phaseId || ""),
            startedAt:       Number(p.startedAt) || null,
            completedAt:     Number(p.completedAt) || null,
            total:           Number(p.total) || 0,
            succeeded:       Number(p.succeeded) || 0,
            failed:          Number(p.failed) || 0,
            skipped:         !!p.skipped,
            haltReason:      p.haltReason ? String(p.haltReason) : null,
            postRun:         p.postRun || null,
            storageKeys:     filterCacheKeys([].concat(p.storageKeys || [], jobs.flatMap(j => j.storageKeys || []))),
            jobs:            keptJobs,
            omittedJobCount: Math.max(0, jobs.length - keptJobs.length)
        }
    }

    function _computeTotals(record) {
        const totals = {
            phases:       0,
            total:        0,
            succeeded:    0,
            failed:       0,
            skipped:      0,
            storageKeys:  0
        }
        const keys = new Set()
        const perPhase = record.perPhase || {}
        for (const id of Object.keys(perPhase)) {
            const p = perPhase[id] || {}
            totals.phases++
            totals.total += Number(p.total) || 0
            totals.succeeded += Number(p.succeeded) || 0
            totals.failed += Number(p.failed) || 0
            if (p.skipped) totals.skipped++
            for (const k of filterCacheKeys(p.storageKeys)) keys.add(k)
        }
        totals.storageKeys = keys.size
        return totals
    }

    function normalise(record) {
        const r = record && typeof record === "object" ? record : {}
        const host = _host(r)
        const perPhase = {}
        const rawPhases = r.perPhase || {}
        for (const id of Object.keys(rawPhases)) {
            perPhase[id] = _normalisePhase(id, rawPhases[id])
        }
        const storageKeys = new Set(filterCacheKeys(r.storageKeys))
        for (const id of Object.keys(perPhase)) {
            for (const k of perPhase[id].storageKeys) storageKeys.add(k)
        }
        const out = {
            schemaVersion: SCHEMA_VERSION,
            runId:        String(r.runId || ("run-" + Date.now().toString(36))),
            server:       host.server,
            airline:      host.airline,
            source:       String(r.source || "manual"),
            status:       String(r.status || (r.completedAt ? "done" : "running")),
            startedAt:    Number(r.startedAt) || Date.now(),
            completedAt:  Number(r.completedAt) || null,
            durationMs:   Number(r.durationMs) || 0,
            aborted:      !!r.aborted,
            haltReason:   r.haltReason ? String(r.haltReason) : null,
            phaseFilter:  _uniqueStrings(r.phaseFilter),
            options:      r.options && typeof r.options === "object" ? r.options : {},
            perPhase:     perPhase,
            failedJobs:   _array(r.failedJobs).map(f => ({
                phaseId: String((f && f.phaseId) || ""),
                jobId:   String((f && f.jobId) || ""),
                url:     String((f && f.url) || ""),
                error:   String((f && f.error) || "")
            })).slice(0, 200),
            storageKeys:  Array.from(storageKeys),
            updatedAt:    Date.now()
        }
        out.totals = _computeTotals(out)
        return out
    }

    function _summary(record) {
        const r = normalise(record)
        return {
            key:          _recordKey(r),
            runId:        r.runId,
            server:       r.server,
            airline:      r.airline,
            source:       r.source,
            status:       r.status,
            startedAt:    r.startedAt,
            completedAt:  r.completedAt,
            durationMs:   r.durationMs,
            aborted:      r.aborted,
            haltReason:   r.haltReason,
            total:        r.totals.total,
            succeeded:    r.totals.succeeded,
            failed:       r.totals.failed,
            storageKeys:  r.totals.storageKeys,
            phaseCount:   r.totals.phases
        }
    }

    function _lastRunShape(record) {
        const r = normalise(record)
        const perPhase = {}
        for (const id of Object.keys(r.perPhase)) {
            const p = r.perPhase[id]
            perPhase[id] = {
                label:     p.label || id,
                total:     p.total,
                succeeded: p.succeeded,
                failed:    p.failed,
                skipped:   !!p.skipped
            }
        }
        return {
            runId:       r.runId,
            source:      r.source,
            startedAt:   r.startedAt,
            completedAt: r.completedAt,
            durationMs:  r.durationMs,
            aborted:     r.aborted,
            haltReason:  r.haltReason,
            perPhase:    perPhase,
            failedJobs:  r.failedJobs
        }
    }

    async function loadIndex() {
        try {
            const blob = await chrome.storage.local.get([INDEX_KEY])
            return _array(blob[INDEX_KEY]).filter(e => e && e.key && e.runId)
        } catch (_) {
            return []
        }
    }

    async function _writeIndex(entries) {
        const seen = new Set()
        const next = []
        for (const e of _array(entries).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))) {
            if (!e || !e.key || seen.has(e.key)) continue
            seen.add(e.key)
            next.push(e)
        }
        const kept = next.slice(0, MAX_INDEX_ENTRIES)
        await chrome.storage.local.set({[INDEX_KEY]: kept})
        const overflow = next.slice(MAX_INDEX_ENTRIES).map(e => e.key).filter(Boolean)
        if (overflow.length) await chrome.storage.local.remove(overflow)
        return kept
    }

    async function save(record, opts) {
        const rec = normalise(record)
        const key = _recordKey(rec)
        const index = await loadIndex()
        const nextIndex = [_summary(rec)].concat(index.filter(e => e.key !== key))
        await chrome.storage.local.set({[key]: rec})
        await _writeIndex(nextIndex)
        if (opts && opts.writeLastRun && rec.completedAt) {
            await chrome.storage.local.set({[LAST_RUN_KEY]: _lastRunShape(rec)})
        }
        return rec
    }

    async function list(opts) {
        opts = opts || {}
        const host = _host(opts.host || opts)
        const sinceMs = Number(opts.sinceMs) || 0
        const limit = Number(opts.limit) || 50
        const index = await loadIndex()
        const filtered = index.filter(e => {
            if (host.server && e.server !== host.server) return false
            if (host.airline && e.airline !== host.airline) return false
            if (sinceMs && (Number(e.startedAt) || 0) < sinceMs) return false
            return true
        }).slice(0, limit)
        const keys = filtered.map(e => e.key)
        if (!keys.length) return []
        let blob = {}
        try { blob = await chrome.storage.local.get(keys) } catch (_) {}
        return keys.map(k => blob[k]).filter(Boolean).map(normalise)
    }

    async function load(runId, hostLike) {
        const host = _host(hostLike || {})
        if (!runId || !host.server) return null
        const key = _key(host.server, host.airline, runId)
        try {
            const blob = await chrome.storage.local.get([key])
            return blob[key] ? normalise(blob[key]) : null
        } catch (_) { return null }
    }

    async function clearBefore(cutoffMs, opts) {
        opts = opts || {}
        const includeCache = !!opts.includeCache
        const host = _host(opts.host || opts)
        const cutoff = Number(cutoffMs)
        const clearAll = !isFinite(cutoff)
        const index = await loadIndex()
        const target = []
        const keep = []
        for (const e of index) {
            const matchesHost = (!host.server || e.server === host.server)
                && (!host.airline || e.airline === host.airline)
            const ts = Number(e.completedAt || e.startedAt) || 0
            if (matchesHost && (clearAll || ts < cutoff)) target.push(e)
            else keep.push(e)
        }
        if (!target.length) return {removedRecords: 0, removedCacheKeys: 0}

        const targetKeys = target.map(e => e.key).filter(Boolean)
        const keepKeys = keep.map(e => e.key).filter(Boolean)
        const removeKeys = targetKeys.slice()
        let removedCacheKeys = 0

        if (includeCache) {
            let targetBlob = {}
            let keepBlob = {}
            try { targetBlob = await chrome.storage.local.get(targetKeys) } catch (_) {}
            try { keepBlob = keepKeys.length ? await chrome.storage.local.get(keepKeys) : {} } catch (_) {}

            const candidateCache = new Set()
            const protectedCache = new Set()
            for (const k of targetKeys) {
                const rec = targetBlob[k] ? normalise(targetBlob[k]) : null
                if (!rec) continue
                for (const cacheKey of filterCacheKeys(rec.storageKeys)) candidateCache.add(cacheKey)
            }
            for (const k of keepKeys) {
                const rec = keepBlob[k] ? normalise(keepBlob[k]) : null
                if (!rec) continue
                for (const cacheKey of filterCacheKeys(rec.storageKeys)) protectedCache.add(cacheKey)
            }
            for (const cacheKey of candidateCache) {
                if (protectedCache.has(cacheKey)) continue
                removeKeys.push(cacheKey)
                removedCacheKeys++
            }
        }

        await chrome.storage.local.remove(_uniqueStrings(removeKeys))
        await _writeIndex(keep)
        await _refreshLastRunAfterClear(keep)
        return {removedRecords: target.length, removedCacheKeys}
    }

    async function _refreshLastRunAfterClear(indexEntries) {
        try {
            if (!indexEntries.length) {
                await chrome.storage.local.remove([LAST_RUN_KEY])
                return
            }
            const newest = indexEntries.slice().sort((a, b) => (b.completedAt || b.startedAt || 0) - (a.completedAt || a.startedAt || 0))[0]
            if (!newest || !newest.key) return
            const blob = await chrome.storage.local.get([newest.key])
            if (blob[newest.key]) {
                await chrome.storage.local.set({[LAST_RUN_KEY]: _lastRunShape(blob[newest.key])})
            }
        } catch (_) { /* noop */ }
    }

    async function cleanup() {
        return clearBefore(Date.now() - DEFAULT_RETENTION_MS, {includeCache: false})
    }

    const api = {
        INDEX_KEY,
        PREFIX,
        LAST_RUN_KEY,
        DEFAULT_RETENTION_MS,
        normalise,
        save,
        list,
        load,
        clearBefore,
        cleanup,
        startOfToday,
        isScrapeCacheKey,
        filterCacheKeys
    }

    window.AesScrapeRunArchiveStore = api

    if (window.AesCleanup && typeof window.AesCleanup.register === "function") {
        try {
            window.AesCleanup.register("scrape-orchestrator-archive", cleanup, {everyMs: 6 * 60 * 60 * 1000})
        } catch (_) { /* noop */ }
    }
})()
