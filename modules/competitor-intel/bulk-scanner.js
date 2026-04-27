"use strict"

/**
 * Generic bulk-scan orchestrator for the Competitor Intelligence Sync now
 * flows. Caller supplies a list of async thunks (jobs); the scanner runs
 * them with concurrency, stagger, progress callbacks, and a soft abort
 * (in-flight jobs finish, no new dispatch).
 *
 * Mirrors the orchestration shape used by RA's airport-overview /
 * enterprise-meta scrapers so the progress UI is consistent across the
 * extension.
 */
class AesCompetitorBulkScanner {
    constructor(opts) {
        opts = opts || {}
        const cap = AesCompetitorSettings.CONCURRENCY_MAX
        this.concurrency = Math.max(1, Math.min(cap, opts.concurrency || 3))
        this.staggerMs   = Math.max(0, opts.staggerMs || 800)
        this._aborted    = false
    }

    abort() { this._aborted = true }
    get aborted() { return this._aborted }

    /**
     * @param {Array<{label?: string, run: () => Promise<*>}>} jobs
     * @param {(progress: {phase: string, done: number, total: number, currentLabel?: string}) => void} [onProgress]
     * @returns {Promise<Array<*|null>>}
     */
    async run(jobs, onProgress) {
        const total = jobs.length
        const results = new Array(total)
        if (!total) return results

        let cursor = 0
        let inflight = 0
        let done = 0
        let lastDispatchAt = 0

        return new Promise(resolve => {
            const tryDispatch = () => {
                if (this._aborted) {
                    if (inflight === 0) resolve(results)
                    return
                }
                while (inflight < this.concurrency && cursor < total) {
                    if (this._aborted) {
                        if (inflight === 0) resolve(results)
                        return
                    }
                    const sinceLast = Date.now() - lastDispatchAt
                    if (sinceLast < this.staggerMs) {
                        setTimeout(tryDispatch, this.staggerMs - sinceLast)
                        return
                    }
                    const idx = cursor++
                    const job = jobs[idx]
                    inflight++
                    lastDispatchAt = Date.now()
                    const finish = (rec) => {
                        results[idx] = rec
                        inflight--
                        done++
                        if (onProgress) {
                            try {
                                onProgress({
                                    phase: "scan",
                                    done,
                                    total,
                                    currentLabel: job && job.label
                                })
                            } catch (e) { /* noop */ }
                        }
                        if (this._aborted && inflight === 0) {
                            resolve(results)
                            return
                        }
                        if (done >= total) resolve(results)
                        else tryDispatch()
                    }
                    Promise.resolve()
                        .then(() => job.run())
                        .then(finish)
                        .catch(err => {
                            console.warn("[AES competitor-intel] bulk job failed:", job && job.label, err)
                            finish(null)
                        })
                }
            }
            tryDispatch()
        })
    }
}
