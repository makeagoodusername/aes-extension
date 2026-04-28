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
        const include = {
            "per-competitor": !!opts.includePerCompetitor,
            "flightsfrom":    !!opts.includeFlightsFrom
        }

        const host = await this._buildHost()
        if (!host) {
            this.onError({message: "no server/airline context", phase: null})
            return
        }

        const phases = window.ScrapeOrchestratorPhases.all().filter(p =>
            !p.optional || include[p.id]
        )
        this._phasePlanCache = phases

        this._attachProgressListener()

        for (const phase of phases) {
            if (this._aborted) break

            this.onPhaseStart({phaseId: phase.id, label: phase.label})
            let jobs
            try {
                jobs = await phase.buildJobs(host)
            } catch (e) {
                this.onError({message: "buildJobs threw: " + ((e && e.message) || String(e)), phase: phase.id})
                continue
            }

            if (!jobs.length) {
                this.onPhaseDone({phaseId: phase.id, total: 0, succeeded: 0, failed: 0, skipped: true})
                continue
            }

            const result = await this._runPhaseJobs(phase, jobs)
            this.onPhaseDone({phaseId: phase.id, ...result})

            if (result.haltReason) {
                this.onError({message: "halted: " + result.haltReason, phase: phase.id})
                break
            }

            if (typeof phase.postRun === "function" && !this._aborted) {
                try {
                    const postOut = await phase.postRun(host)
                    this.onProgress({type: "phase-post-run", phaseId: phase.id, result: postOut})
                } catch (e) {
                    this.onProgress({type: "phase-post-run-failed", phaseId: phase.id, error: (e && e.message) || String(e)})
                }
            }
        }

        this._detachProgressListener()
        this.onDone({aborted: this._aborted})
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
        return new Promise((resolve) => {
            let succeeded = 0
            let failed    = 0
            let haltReason = null

            const handler = (msg) => {
                if (!msg || msg.type !== "aes:scrape-all:progress" || !msg.event) return
                const event = msg.event
                this.onProgress(event)

                if (event.type === "job-done")  succeeded++
                if (event.type === "job-fail")  failed++
                if (event.type === "breaker-trip") haltReason = "circuit-breaker"
                if (event.type === "run-done") {
                    if (event.reason && event.reason !== "done") {
                        haltReason = haltReason || event.reason
                    }
                    chrome.runtime.onMessage.removeListener(handler)
                    resolve({
                        total:      jobs.length,
                        succeeded:  succeeded,
                        failed:     failed,
                        haltReason: haltReason
                    })
                }
            }
            chrome.runtime.onMessage.addListener(handler)

            chrome.runtime.sendMessage({
                type:        "aes:scrape-all:start",
                plan:        jobs,
                concurrency: phase.concurrency,
                staggerMs:   phase.staggerMs
            }, (resp) => {
                void chrome.runtime.lastError
                if (!resp || !resp.ok) {
                    chrome.runtime.onMessage.removeListener(handler)
                    resolve({
                        total:      jobs.length,
                        succeeded:  0,
                        failed:     jobs.length,
                        haltReason: (resp && resp.reason) || "start-failed"
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
