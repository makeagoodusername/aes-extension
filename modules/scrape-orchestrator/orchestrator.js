"use strict"

/**
 * ScrapeOrchestrator — content-side state machine. Runs in the
 * dashboard tab; computes the phase plan from current storage,
 * dispatches each phase to the background-side ScrapeTabPool, and
 * relays progress to a UI handler (typically the progress modal).
 *
 * One run can re-evaluate buildJobs between phases so per-aircraft /
 * per-route fan-out reflects fresh storage written by earlier phases.
 *
 * Lifecycle:
 *   const orch = new ScrapeOrchestrator({onProgress, onPhaseStart, onDone, onError})
 *   await orch.start({includePerCompetitor: true, includeFlightsFrom: false})
 *   orch.abort()                    // mid-run cancel
 */
class ScrapeOrchestrator {
    constructor(opts) {
        opts = opts || {}
        this.onProgress    = opts.onProgress    || (() => {})
        this.onPhaseStart  = opts.onPhaseStart  || (() => {})
        this.onPhaseDone   = opts.onPhaseDone   || (() => {})
        this.onDone        = opts.onDone        || (() => {})
        this.onError       = opts.onError       || (() => {})
        this._aborted      = false
        this._runtimeMessageHandler = null
        this._phasePlanCache = null
    }

    async start(opts) {
        opts = opts || {}
        const source = String(opts.source || "manual")
        const include = {
            "per-competitor": !!opts.includePerCompetitor,
            "flightsfrom":    !!opts.includeFlightsFrom
        }
        const phaseFilter = Array.isArray(opts.phaseFilter) && opts.phaseFilter.length
            ? new Set(opts.phaseFilter.map(String))
            : null

        const host = await this._buildHost()
        if (!host) {
            this.onError({message: "no server/airline context", phase: null})
            return
        }

        const phases = window.ScrapeOrchestratorPhases.all().filter(p => {
            if (phaseFilter && !phaseFilter.has(p.id)) return false
            return !p.optional || include[p.id]
        })
        this._phasePlanCache = phases
        const archiveRecord = this._createArchiveRecord(host, phases, opts, source)
        await this._saveArchive(archiveRecord, false)

        this._attachProgressListener()

        try {
            for (const phase of phases) {
                if (this._aborted) break

                const phaseStartedAt = Date.now()
                this._archivePhaseStart(archiveRecord, phase, phaseStartedAt)
                await this._saveArchive(archiveRecord, false)
                this.onPhaseStart({phaseId: phase.id, label: phase.label})
                let jobs
                try {
                    jobs = await phase.buildJobs(host)
                } catch (e) {
                    const message = "buildJobs threw: " + ((e && e.message) || String(e))
                    this._archivePhaseDone(archiveRecord, phase, {
                        total: 0, succeeded: 0, failed: 0, skipped: true, haltReason: "buildJobs-threw"
                    })
                    archiveRecord.failedJobs.push({phaseId: phase.id, jobId: "buildJobs", url: "", error: message})
                    await this._saveArchive(archiveRecord, false)
                    this.onError({message: message, phase: phase.id})
                    continue
                }

                if (!jobs.length) {
                    const skipped = {total: 0, succeeded: 0, failed: 0, skipped: true}
                    this.onPhaseDone({phaseId: phase.id, ...skipped})
                    this._archivePhaseDone(archiveRecord, phase, skipped)
                    await this._saveArchive(archiveRecord, false)
                    this._recordCadence(host, phase.id, {startedAt: phaseStartedAt, total: 0, succeeded: 0, failed: 0})
                    // Pure-postRun phases (e.g. ors-rank) intentionally
                    // return [] from buildJobs — the entire payload is the
                    // postRun callback. Run it before continuing so those
                    // phases aren't gated on tab-fan-out activity.
                    if (typeof phase.postRun === "function" && !this._aborted) {
                        try {
                            const postOut = await this._capturePostRunStorage(() => phase.postRun(host))
                            this._archivePostRun(archiveRecord, phase.id, postOut)
                            await this._saveArchive(archiveRecord, false)
                            this.onProgress({type: "phase-post-run", phaseId: phase.id, result: postOut})
                        } catch (e) {
                            const errText = (e && e.message) || String(e)
                            this._archivePostRun(archiveRecord, phase.id, {ok: false, error: errText})
                            await this._saveArchive(archiveRecord, false)
                            this.onProgress({type: "phase-post-run-failed", phaseId: phase.id, error: errText})
                        }
                    }
                    continue
                }

                const result = await this._runPhaseJobs(phase, jobs)
                this.onPhaseDone({phaseId: phase.id, ...result})
                this._archivePhaseDone(archiveRecord, phase, result)
                await this._saveArchive(archiveRecord, false)
                this._recordCadence(host, phase.id, {...result, startedAt: phaseStartedAt})

                if (result.haltReason) {
                    archiveRecord.haltReason = result.haltReason
                    this.onError({message: "halted: " + result.haltReason, phase: phase.id})
                    break
                }

                if (typeof phase.postRun === "function" && !this._aborted) {
                    try {
                        const postOut = await this._capturePostRunStorage(() => phase.postRun(host))
                        this._archivePostRun(archiveRecord, phase.id, postOut)
                        await this._saveArchive(archiveRecord, false)
                        this.onProgress({type: "phase-post-run", phaseId: phase.id, result: postOut})
                    } catch (e) {
                        const errText = (e && e.message) || String(e)
                        this._archivePostRun(archiveRecord, phase.id, {ok: false, error: errText})
                        await this._saveArchive(archiveRecord, false)
                        this.onProgress({type: "phase-post-run-failed", phaseId: phase.id, error: errText})
                    }
                }
            }
        } catch (e) {
            archiveRecord.haltReason = (e && e.message) || String(e)
            await this._saveArchive(archiveRecord, false)
            throw e
        } finally {
            this._detachProgressListener()
            archiveRecord.completedAt = Date.now()
            archiveRecord.durationMs = archiveRecord.completedAt - archiveRecord.startedAt
            archiveRecord.aborted = this._aborted
            archiveRecord.status = this._aborted ? "aborted" : (archiveRecord.haltReason ? "halted" : "done")
            await this._saveArchive(archiveRecord, true)
            this.onDone({aborted: this._aborted, runId: archiveRecord.runId})
        }
    }

    _createArchiveRecord(host, phases, opts, source) {
        const runId = "run-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36)
        return {
            runId:       runId,
            server:      host.server,
            airline:     host.airline,
            source:      source,
            status:      "running",
            startedAt:   Date.now(),
            completedAt: null,
            durationMs:  0,
            aborted:     false,
            haltReason:  null,
            phaseFilter: Array.isArray(opts.phaseFilter) ? opts.phaseFilter.map(String) : [],
            options: {
                includePerCompetitor: !!opts.includePerCompetitor,
                includeFlightsFrom:   !!opts.includeFlightsFrom
            },
            perPhase: phases.reduce((out, p) => {
                out[p.id] = {
                    label: p.label,
                    startedAt: null,
                    completedAt: null,
                    total: 0,
                    succeeded: 0,
                    failed: 0,
                    skipped: false,
                    haltReason: null,
                    storageKeys: [],
                    jobs: []
                }
                return out
            }, {}),
            failedJobs:  [],
            storageKeys: []
        }
    }

    async _saveArchive(record, writeLastRun) {
        if (!record || typeof window.AesScrapeRunArchiveStore === "undefined") return null
        try { return await window.AesScrapeRunArchiveStore.save(record, {writeLastRun: !!writeLastRun}) }
        catch (_) { return null }
    }

    _archivePhaseStart(record, phase, startedAt) {
        if (!record || !phase) return
        record.perPhase = record.perPhase || {}
        record.perPhase[phase.id] = record.perPhase[phase.id] || {label: phase.label, jobs: [], storageKeys: []}
        record.perPhase[phase.id].label = phase.label
        record.perPhase[phase.id].startedAt = startedAt || Date.now()
        record.perPhase[phase.id].completedAt = null
        record.perPhase[phase.id].skipped = false
    }

    _archivePhaseDone(record, phase, result) {
        if (!record || !phase) return
        const p = record.perPhase[phase.id] || {label: phase.label, jobs: [], storageKeys: []}
        p.completedAt = Date.now()
        p.total       = (result && result.total) || 0
        p.succeeded   = (result && result.succeeded) || 0
        p.failed      = (result && result.failed) || 0
        p.skipped     = !!(result && result.skipped)
        p.haltReason  = (result && result.haltReason) || null
        p.jobs        = Array.isArray(result && result.jobs) ? result.jobs : (p.jobs || [])
        p.storageKeys = this._mergeStorageKeys(p.storageKeys, result && result.storageKeys)
        record.perPhase[phase.id] = p
        record.storageKeys = this._mergeStorageKeys(record.storageKeys, p.storageKeys)
        if (Array.isArray(result && result.jobs)) {
            for (const j of result.jobs) {
                if (!j || j.status !== "failed") continue
                record.failedJobs.push({
                    phaseId: phase.id,
                    jobId:   j.jobId || "",
                    url:     j.url || "",
                    error:   j.error || ""
                })
            }
        }
    }

    _archivePostRun(record, phaseId, postOut) {
        if (!record || !phaseId) return
        const p = record.perPhase && record.perPhase[phaseId]
        if (!p) return
        p.postRun = postOut || null
        p.storageKeys = this._mergeStorageKeys(p.storageKeys, postOut && postOut.storageKeys)
        record.storageKeys = this._mergeStorageKeys(record.storageKeys, p.storageKeys)
    }

    async _capturePostRunStorage(fn) {
        const keys = new Set()
        const handler = (changes, area) => {
            if (area !== "local" || !changes) return
            for (const k in changes) {
                if (window.AesScrapeRunArchiveStore
                        && !window.AesScrapeRunArchiveStore.isScrapeCacheKey(k)) continue
                keys.add(k)
            }
        }
        try { chrome.storage.onChanged.addListener(handler) } catch (_) {}
        try {
            const out = await fn()
            if (!keys.size) return out
            const filtered = window.AesScrapeRunArchiveStore
                ? window.AesScrapeRunArchiveStore.filterCacheKeys(Array.from(keys))
                : Array.from(keys)
            return Object.assign({}, out || {}, {storageKeys: filtered})
        } finally {
            try { chrome.storage.onChanged.removeListener(handler) } catch (_) {}
        }
    }

    _mergeStorageKeys(a, b) {
        const out = []
        const seen = new Set()
        const add = (arr) => {
            if (!Array.isArray(arr)) return
            for (const k of arr) {
                const s = String(k || "")
                if (!s || seen.has(s)) continue
                if (window.AesScrapeRunArchiveStore
                        && !window.AesScrapeRunArchiveStore.isScrapeCacheKey(s)) continue
                seen.add(s)
                out.push(s)
            }
        }
        add(a)
        add(b)
        return out
    }

    _recordCadence(host, phaseId, result) {
        if (typeof window.AesPhaseCadenceStore === "undefined") return
        try { window.AesPhaseCadenceStore.record(host, phaseId, result) } catch (_) { /* noop */ }
    }

    abort() {
        this._aborted = true
        try {
            chrome.runtime.sendMessage({type: "aes:scrape-all:abort"}, () => {
                void chrome.runtime.lastError
            })
        } catch (_) { /* noop */ }
    }

    /**
     * Returns true if a run is currently active in the background.
     */
    static async isRunning() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({type: "aes:scrape-all:status"}, (resp) => {
                    void chrome.runtime.lastError
                    resolve(!!(resp && resp.ok && resp.status && resp.status.running))
                })
            } catch (_) { resolve(false) }
        })
    }

    static async getStatus() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({type: "aes:scrape-all:status"}, (resp) => {
                    void chrome.runtime.lastError
                    resolve((resp && resp.ok && resp.status) || null)
                })
            } catch (_) { resolve(null) }
        })
    }

    static async resetBreaker() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({type: "aes:scrape-all:reset-breaker"}, (resp) => {
                    void chrome.runtime.lastError
                    resolve(resp || {ok: false})
                })
            } catch (_) { resolve({ok: false}) }
        })
    }

    /**
     * Pre-flight estimate for the ToS modal — counts per-phase jobs
     * without sending any work to the background pool.
     */
    static async estimate() {
        const host = await ScrapeOrchestrator._staticBuildHost()
        if (!host) return null
        return await window.ScrapeOrchestratorPhases.estimate(host)
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------

    async _buildHost() {
        return ScrapeOrchestrator._staticBuildHost()
    }

    static async _staticBuildHost() {
        let server = ""
        let airline = ""
        try { server = AES.getServerName() } catch (_) {}
        try {
            const code = AES.getAirlineCode()
            airline = (code && code.code) || ""
        } catch (_) {}
        if (!airline) {
            try { airline = AES.getAirlineIdentity() || "" } catch (_) {}
        }
        if (!server) return null
        const origin = window.location.protocol + "//" + window.location.host
        return {
            server:      server,
            airline:     airline,
            origin:      origin,
            enumerators: window.ScrapeOrchestratorEnumerators
        }
    }

    _runPhaseJobs(phase, jobs) {
        // Watchdog: 15 min of silence with no progress event = treat the
        // background tab pool as gone. Without this, killing the SW
        // mid-phase (or any other path that drops the run-done relay)
        // leaks the listener and leaves start()'s await pending forever.
        const SILENCE_TIMEOUT_MS = 15 * 60 * 1000
        return new Promise((resolve) => {
            let succeeded = 0
            let failed    = 0
            let haltReason = null
            const jobEvents = []
            const storageKeys = new Set()
            let watchdog = null
            let settled  = false

            const finish = (result) => {
                if (settled) return
                settled = true
                if (watchdog) { clearTimeout(watchdog); watchdog = null }
                chrome.runtime.onMessage.removeListener(handler)
                resolve(result)
            }

            const armWatchdog = () => {
                if (watchdog) clearTimeout(watchdog)
                watchdog = setTimeout(() => {
                    finish({
                        total:      jobs.length,
                        succeeded:  succeeded,
                        failed:     failed,
                        haltReason: "background-disconnect",
                        jobs:       jobEvents,
                        storageKeys: Array.from(storageKeys)
                    })
                }, SILENCE_TIMEOUT_MS)
            }

            const handler = (msg) => {
                if (!msg || msg.type !== "aes:scrape-all:progress" || !msg.event) return
                armWatchdog()
                const event = msg.event
                this.onProgress(event)

                if (Array.isArray(event.storageKeys)) {
                    for (const k of event.storageKeys) storageKeys.add(k)
                }
                if (event.type === "job-done") {
                    succeeded++
                    jobEvents.push({
                        jobId:      event.jobId || "",
                        status:     "ok",
                        url:        event.url || "",
                        durationMs: event.durationMs || 0,
                        storageKeys: Array.isArray(event.storageKeys) ? event.storageKeys : []
                    })
                }
                if (event.type === "job-fail") {
                    failed++
                    jobEvents.push({
                        jobId:      event.jobId || "",
                        status:     "failed",
                        url:        event.url || "",
                        durationMs: event.durationMs || 0,
                        error:      event.error || "",
                        storageKeys: Array.isArray(event.storageKeys) ? event.storageKeys : []
                    })
                }
                if (event.type === "breaker-trip") haltReason = "circuit-breaker"
                if (event.type === "run-done") {
                    if (event.reason && event.reason !== "done") {
                        haltReason = haltReason || event.reason
                    }
                    finish({
                        total:      jobs.length,
                        succeeded:  succeeded,
                        failed:     failed,
                        haltReason: haltReason,
                        jobs:       jobEvents,
                        storageKeys: Array.from(storageKeys)
                    })
                }
            }
            chrome.runtime.onMessage.addListener(handler)
            armWatchdog()

            chrome.runtime.sendMessage({
                type:        "aes:scrape-all:start",
                plan:        jobs,
                concurrency: phase.concurrency,
                staggerMs:   phase.staggerMs
            }, (resp) => {
                void chrome.runtime.lastError
                if (!resp || !resp.ok) {
                    finish({
                        total:      jobs.length,
                        succeeded:  0,
                        failed:     jobs.length,
                        haltReason: (resp && resp.reason) || "start-failed",
                        jobs:       jobEvents,
                        storageKeys: Array.from(storageKeys)
                    })
                }
            })
        })
    }

    _attachProgressListener() {
        // No-op — _runPhaseJobs registers its own per-phase listener that
        // unwraps the envelope and forwards events to onProgress. A
        // global listener at this layer would double-fire.
    }

    _detachProgressListener() {
        if (!this._runtimeMessageHandler) return
        try { chrome.runtime.onMessage.removeListener(this._runtimeMessageHandler) } catch (_) {}
        this._runtimeMessageHandler = null
    }
}

if (typeof window !== "undefined") {
    window.ScrapeOrchestrator = ScrapeOrchestrator
}
