'use strict';

/**
 * ScrapeTabPool — service-worker-side hidden-tab pool for the
 * "Scrape everything" orchestrator.
 *
 * Loaded via importScripts from background.js. Mirrors the proven AFP
 * apply-batch tab-orchestration pattern (background.js _afpRunSubmit /
 * _waitForTabComplete) but generalises the lifecycle so any AS page
 * can be visited and confirmed-via-storage-key.
 *
 * Public surface (attached to globalThis):
 *   ScrapeTabPool.startRun(plan)         → starts an orchestrator run
 *   ScrapeTabPool.abortRun()             → cancels in-flight run
 *   ScrapeTabPool.getStatus()            → snapshot for resume / status query
 *   ScrapeTabPool.onProgress(handler)    → subscribes to progress events
 *
 * A "plan" is an array of jobs:
 *   [
 *     {jobId, phaseId, url, expectStorageKeyPrefix, settleMs, timeoutMs},
 *     …
 *   ]
 * Concurrency cap, stagger, and circuit-breaker thresholds are global
 * pool defaults but can be overridden per-job. The pool runs jobs in
 * the order they appear; the content-side orchestrator is responsible
 * for ordering by phase.
 */
;(function () {
    if (typeof globalThis === 'undefined') return;
    if (globalThis.ScrapeTabPool) return;

    // ---------------------------------------------------------------
    // Tunables (mirrors route-sync-orchestrator + ors-scraper defaults)
    // ---------------------------------------------------------------
    const DEFAULT_CONCURRENCY      = 3;
    const DEFAULT_STAGGER_MS       = 1500;
    const DEFAULT_SETTLE_MS        = 1500;
    const DEFAULT_LOAD_TIMEOUT_MS  = 20000;
    // AS scrapers wait for Wicket DOM mutations (up to 5s anchor-wait) before
    // they begin scraping, so the write happens 5–10s after page load. 18s
    // gives them headroom without dragging out failure paths.
    const DEFAULT_STORAGE_POLL_MS  = 18000;
    const STORAGE_POLL_INTERVAL_MS = 250;
    const BREAKER_FAIL_THRESHOLD   = 3;
    const BREAKER_COOLDOWN_MS      = 10 * 60 * 1000;

    // Persistence: chrome.storage.local key for orphan-tab recovery on
    // MV3 service-worker idle eviction. Only enough state is persisted
    // to close orphan tabs and broadcast `run-done` so wedged content-side
    // awaits resolve. The plan is intentionally NOT persisted — restart
    // by user click is preferable to silent resume of a partial run.
    const RUN_STATE_KEY            = 'scrapeOrchestrator:runState';

    // ---------------------------------------------------------------
    // Run state — only one orchestrator run at a time
    // ---------------------------------------------------------------
    const state = {
        running:              false,
        runId:                null,
        plan:                 [],
        completedJobs:        new Map(),     // jobId → {ok, durationMs, error?}
        failedJobs:           [],            // [{jobId, phaseId, url, error, durationMs}]
        activeTabs:           new Map(),     // tabId → jobId
        consecutiveFailures:  0,
        breakerTrippedAt:     0,
        haltReason:           null,
        startedAt:            0,
        progressHandlers:     [],
        senderTabId:          null,
        abortFlag:            false,
        concurrency:          DEFAULT_CONCURRENCY,
        staggerMs:            DEFAULT_STAGGER_MS,
        lastDispatchAt:       0
    };

    // ---------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------
    async function startRun(plan, opts) {
        if (state.running) {
            return {ok: false, reason: 'already-running', runId: state.runId};
        }
        if (!Array.isArray(plan) || !plan.length) {
            return {ok: false, reason: 'empty-plan'};
        }
        if (state.breakerTrippedAt && Date.now() - state.breakerTrippedAt < BREAKER_COOLDOWN_MS) {
            const remainingSec = Math.ceil((BREAKER_COOLDOWN_MS - (Date.now() - state.breakerTrippedAt)) / 1000);
            return {ok: false, reason: 'circuit-breaker', cooldownRemainingSec: remainingSec};
        }
        state.running             = true;
        state.runId               = 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
        state.plan                = plan.slice();
        state.completedJobs       = new Map();
        state.failedJobs          = [];
        state.consecutiveFailures = 0;
        state.haltReason          = null;
        state.startedAt           = Date.now();
        state.senderTabId         = (opts && opts.senderTabId) || null;
        state.abortFlag           = false;
        state.concurrency         = (opts && opts.concurrency) || DEFAULT_CONCURRENCY;
        state.staggerMs           = (opts && opts.staggerMs)   || DEFAULT_STAGGER_MS;
        state.lastDispatchAt      = 0;
        _persistState();

        _broadcastProgress({type: 'run-start', runId: state.runId, totalJobs: plan.length});

        // Run dispatch loop without awaiting — startRun returns immediately
        // so the content-side caller can subscribe to progress events.
        _runDispatchLoop().catch((err) => {
            console.warn('[scrape-orchestrator] dispatch loop threw:', err);
            _finishRun({reason: 'dispatch-threw', error: (err && err.message) || String(err)});
        });

        return {ok: true, runId: state.runId, totalJobs: plan.length};
    }

    function abortRun() {
        if (!state.running) return {ok: false, reason: 'not-running'};
        state.abortFlag = true;
        // Closing live tabs interrupts any in-flight _waitForTabComplete /
        // pollForStorageWrite waits.
        for (const tabId of state.activeTabs.keys()) {
            try { chrome.tabs.remove(tabId); } catch (_) { /* noop */ }
        }
        return {ok: true, runId: state.runId};
    }

    function getStatus() {
        const totalJobs = state.plan.length;
        const completed = state.completedJobs.size;
        const succeeded = Array.from(state.completedJobs.values()).filter(r => r.ok).length;
        const failed    = completed - succeeded;
        return {
            running:             state.running,
            runId:               state.runId,
            totalJobs:           totalJobs,
            completed:           completed,
            succeeded:           succeeded,
            failed:              failed,
            failedJobs:          state.failedJobs.slice(),
            activeTabs:          state.activeTabs.size,
            haltReason:          state.haltReason,
            consecutiveFailures: state.consecutiveFailures,
            breakerTrippedAt:    state.breakerTrippedAt,
            startedAt:           state.startedAt
        };
    }

    function onProgress(handler) {
        if (typeof handler !== 'function') return () => {};
        state.progressHandlers.push(handler);
        return () => {
            const i = state.progressHandlers.indexOf(handler);
            if (i >= 0) state.progressHandlers.splice(i, 1);
        };
    }

    // ---------------------------------------------------------------
    // Dispatch loop — drains state.plan honouring concurrency + stagger
    // ---------------------------------------------------------------
    async function _runDispatchLoop() {
        const inflight = new Set();
        let cursor = 0;

        while (cursor < state.plan.length || inflight.size) {
            if (state.abortFlag) {
                _finishRun({reason: 'aborted'});
                return;
            }
            if (state.haltReason) {
                // Drain in-flight; do not start new jobs
                if (!inflight.size) {
                    _finishRun({reason: state.haltReason});
                    return;
                }
            }

            // Dispatch up to concurrency, respecting stagger
            while (
                !state.abortFlag &&
                !state.haltReason &&
                inflight.size < state.concurrency &&
                cursor < state.plan.length
            ) {
                const sinceLast = Date.now() - state.lastDispatchAt;
                if (state.lastDispatchAt && sinceLast < state.staggerMs) {
                    await _sleep(state.staggerMs - sinceLast);
                    if (state.abortFlag || state.haltReason) break;
                }
                const job = state.plan[cursor++];
                state.lastDispatchAt = Date.now();
                _broadcastProgress({type: 'job-start', jobId: job.jobId, phaseId: job.phaseId, url: job.url});
                const promise = _runJob(job).then((result) => {
                    inflight.delete(promise);
                    state.completedJobs.set(job.jobId, result);
                    _onJobResult(job, result);
                });
                inflight.add(promise);
            }

            // Wait for at least one job to settle before reconsidering dispatch
            if (inflight.size) {
                await Promise.race(inflight);
            }
        }

        _finishRun({reason: state.haltReason || 'done'});
    }

    function _onJobResult(job, result) {
        if (result.ok) {
            state.consecutiveFailures = 0;
            _broadcastProgress({
                type:       'job-done',
                jobId:      job.jobId,
                phaseId:    job.phaseId,
                durationMs: result.durationMs,
                completed:  state.completedJobs.size,
                total:      state.plan.length
            });
        } else {
            state.consecutiveFailures++;
            state.failedJobs.push({
                jobId:      job.jobId,
                phaseId:    job.phaseId,
                url:        job.url,
                error:      result.error,
                durationMs: result.durationMs
            });
            console.warn('[scrape-orchestrator] job failed',
                {jobId: job.jobId, phaseId: job.phaseId, url: job.url, error: result.error});
            _broadcastProgress({
                type:      'job-fail',
                jobId:     job.jobId,
                phaseId:   job.phaseId,
                url:       job.url,
                error:     result.error,
                completed: state.completedJobs.size,
                total:     state.plan.length
            });
            if (state.consecutiveFailures >= BREAKER_FAIL_THRESHOLD) {
                state.haltReason       = 'circuit-breaker';
                state.breakerTrippedAt = Date.now();
                _broadcastProgress({
                    type:        'breaker-trip',
                    cooldownMs:  BREAKER_COOLDOWN_MS,
                    failures:    state.consecutiveFailures,
                    recentFails: state.failedJobs.slice(-BREAKER_FAIL_THRESHOLD)
                });
            }
        }
    }

    function _finishRun({reason, error}) {
        const status = getStatus();
        _broadcastProgress({
            type:      'run-done',
            reason:    reason,
            error:     error,
            durationMs: Date.now() - state.startedAt,
            ...status
        });
        state.running     = false;
        state.activeTabs  = new Map();
        state.lastDispatchAt = 0;
        _clearPersistedState();
    }

    // ---------------------------------------------------------------
    // Per-job lifecycle: open hidden tab → wait load → settle → confirm
    // storage write → close tab
    // ---------------------------------------------------------------
    async function _runJob(job) {
        const start = Date.now();
        const settleMs       = (job.settleMs       != null ? job.settleMs       : DEFAULT_SETTLE_MS);
        const loadTimeoutMs  = (job.timeoutMs      != null ? job.timeoutMs      : DEFAULT_LOAD_TIMEOUT_MS);
        const storagePollMs  = (job.storagePollMs  != null ? job.storagePollMs  : DEFAULT_STORAGE_POLL_MS);

        // Detect storage WRITES (any set, even idempotent ones that re-write
        // identical data) rather than only value changes. Several scrapers
        // omit a per-call timestamp, so a re-scrape after dashboard boot
        // produces a byte-identical record — value-diff polling would never
        // see it. The onChanged event fires regardless.
        let storageWrote = false;
        const onChanged = (changes, area) => {
            if (area !== 'local' || !job.expectStorageKeyPrefix) return;
            for (const k in changes) {
                if (k.indexOf(job.expectStorageKeyPrefix) >= 0) { storageWrote = true; return; }
            }
        };
        if (job.expectStorageKeyPrefix) chrome.storage.onChanged.addListener(onChanged);

        let tab = null;
        try {
            const beforeKeys = await _snapshotStorageKeys(job.expectStorageKeyPrefix);

            tab = await _createTab(job.url);
            state.activeTabs.set(tab.id, job.jobId);
            _persistState();

            await _waitForTabComplete(tab.id, loadTimeoutMs);
            if (state.abortFlag) throw new Error('aborted');

            await _sleep(settleMs);
            if (state.abortFlag) throw new Error('aborted');

            // Skip storage-write polling if no expected key was specified —
            // some pages just exist to bootstrap modules (e.g. dashboard
            // boot) without writing any specific key.
            if (job.expectStorageKeyPrefix) {
                const wrote = await _pollForStorageWrite(
                    job.expectStorageKeyPrefix, beforeKeys, storagePollMs, () => storageWrote
                );
                if (!wrote) throw new Error('storage-key-never-appeared');
            }
            return {ok: true, durationMs: Date.now() - start};
        } catch (err) {
            return {ok: false, durationMs: Date.now() - start, error: (err && err.message) || String(err)};
        } finally {
            if (job.expectStorageKeyPrefix) {
                try { chrome.storage.onChanged.removeListener(onChanged); } catch (_) { /* noop */ }
            }
            if (tab && tab.id != null) {
                state.activeTabs.delete(tab.id);
                _persistState();
                try { chrome.tabs.remove(tab.id); } catch (_) { /* noop */ }
            }
        }
    }

    function _createTab(url) {
        return new Promise((resolve, reject) => {
            try {
                chrome.tabs.create({url: url, active: false}, (t) => {
                    const lastErr = chrome.runtime.lastError;
                    if (lastErr) return reject(new Error(lastErr.message || 'tabs.create failed'));
                    resolve(t);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Mirror of background.js:_waitForTabComplete. Inlined here so the pool
     * doesn't depend on the AFP-specific helper file's load order, and so a
     * future refactor can swap implementations without touching afp paths.
     */
    function _waitForTabComplete(tabId, timeoutMs) {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (err) => {
                if (done) return;
                done = true;
                try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) { /* noop */ }
                try { chrome.tabs.onRemoved.removeListener(removed); } catch (_) { /* noop */ }
                clearTimeout(timer);
                if (err) reject(err); else resolve();
            };
            const listener = (updatedId, changeInfo) => {
                if (updatedId !== tabId) return;
                if (changeInfo && changeInfo.status === 'complete') finish(null);
            };
            const removed = (closedId) => {
                if (closedId === tabId) finish(new Error('tab closed before load completed'));
            };
            const timer = setTimeout(() => finish(new Error('tab load timeout')), timeoutMs);
            chrome.tabs.onUpdated.addListener(listener);
            chrome.tabs.onRemoved.addListener(removed);
        });
    }

    async function _snapshotStorageKeys(prefix) {
        if (!prefix) return new Map();
        const all = await new Promise((resolve) => {
            chrome.storage.local.get(null, (blob) => resolve(blob || {}));
        });
        const out = new Map();
        for (const k in all) {
            // Substring match — scrapers prefix keys with `<server><airline>`
            // where airline mangling differs across scrapers (sanitised name
            // vs raw nav-text vs IATA code). The phase-supplied fragment
            // identifies the canonical suffix; matching anywhere in the key
            // tolerates whichever airline form a given scraper writes.
            if (k.indexOf(prefix) >= 0) {
                try {
                    const v = all[k];
                    // Full-string signature — stringified length collides when
                    // only a timestamp changes ("scrapedAt":<ms> → same length).
                    const sig = (typeof v === 'object' && v) ? JSON.stringify(v) : String(v);
                    out.set(k, sig);
                } catch (_) { out.set(k, '?'); }
            }
        }
        return out;
    }

    async function _pollForStorageWrite(prefix, beforeKeys, timeoutMs, wroteFn) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (state.abortFlag) return false;
            if (wroteFn && wroteFn()) return true;
            const now = await _snapshotStorageKeys(prefix);
            for (const [k, sig] of now) {
                const before = beforeKeys.get(k);
                if (before === undefined || before !== sig) return true;
            }
            await _sleep(STORAGE_POLL_INTERVAL_MS);
        }
        return wroteFn ? !!wroteFn() : false;
    }

    function _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function _broadcastProgress(event) {
        // 1) in-process subscribers (background-side)
        for (const h of state.progressHandlers) {
            try { h(event); } catch (e) { console.warn('[scrape-orchestrator] handler threw', e); }
        }
        // 2) content-script subscribers (the originating tab + any other
        //    listeners). Use chrome.tabs.sendMessage to the originating tab
        //    if known, plus chrome.runtime.sendMessage as a broadcast
        //    fallback (catches dashboard tabs that mounted after the run
        //    started, e.g. on resume).
        // Event types ('job-start', 'run-done', etc.) live nested under
        // .event.type so they don't collide with the runtime envelope's
        // own .type field.
        const message = {type: 'aes:scrape-all:progress', event: event};
        if (state.senderTabId != null) {
            try {
                chrome.tabs.sendMessage(state.senderTabId, message, () => {
                    // swallow lastError — the originating tab may have closed
                    void chrome.runtime.lastError;
                });
            } catch (_) { /* noop */ }
        }
        try {
            chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
        } catch (_) { /* noop */ }
    }

    // ---------------------------------------------------------------
    // Manual breaker reset (for the progress modal's Override button)
    // ---------------------------------------------------------------
    function resetBreaker() {
        state.breakerTrippedAt    = 0;
        state.consecutiveFailures = 0;
        state.haltReason          = null;
        return {ok: true};
    }

    // ---------------------------------------------------------------
    // Persistence — survives MV3 service-worker idle eviction
    // ---------------------------------------------------------------
    // Writes a small snapshot of the run's identifying state (NOT the
    // plan, NOT the per-job results) so that on the next SW boot we can
    // detect a half-dead run, close orphan tabs, and broadcast a
    // synthetic `run-done` to unwedge any content-side awaits. Fire-and-
    // forget; failures are non-fatal because the live in-memory state
    // remains the source of truth while the SW is alive.
    function _persistState() {
        try {
            const snap = {
                running:     state.running,
                runId:       state.runId,
                activeTabIds: Array.from(state.activeTabs.keys()),
                senderTabId: state.senderTabId,
                startedAt:   state.startedAt,
                persistedAt: Date.now()
            };
            chrome.storage.local.set({[RUN_STATE_KEY]: snap}, () => {
                void chrome.runtime.lastError;
            });
        } catch (_) { /* noop */ }
    }

    function _clearPersistedState() {
        try {
            chrome.storage.local.remove(RUN_STATE_KEY, () => {
                void chrome.runtime.lastError;
            });
        } catch (_) { /* noop */ }
    }

    // On module load — i.e. each SW boot, since this file is loaded via
    // importScripts from background.js — reconcile any persisted run
    // state. Presence of `running: true` means the previous SW died
    // mid-run; close any orphan tabs from that run, emit a synthetic
    // `run-done` so wedged content-side `await _runPhaseJobs(...)` calls
    // resolve, and clear the persisted record.
    function _recoverFromCrash() {
        try {
            chrome.storage.local.get([RUN_STATE_KEY], (blob) => {
                void chrome.runtime.lastError;
                const prev = blob && blob[RUN_STATE_KEY];
                if (!prev || !prev.running) {
                    if (prev) _clearPersistedState();
                    return;
                }
                const orphanTabIds = Array.isArray(prev.activeTabIds) ? prev.activeTabIds : [];
                for (const tabId of orphanTabIds) {
                    try { chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; }); }
                    catch (_) { /* noop */ }
                }
                // Synthetic run-done so any content-side listener awaiting
                // a real one (orchestrator._runPhaseJobs) can resolve and
                // release its `_busy` flag instead of hanging forever.
                const recovered = {
                    type:        'run-done',
                    reason:      'sw-evicted',
                    runId:       prev.runId,
                    durationMs:  prev.startedAt ? (Date.now() - prev.startedAt) : 0,
                    running:     false,
                    totalJobs:   0,
                    completed:   0,
                    succeeded:   0,
                    failed:      0,
                    failedJobs:  [],
                    activeTabs:  0,
                    haltReason:  'sw-evicted',
                    startedAt:   prev.startedAt || 0,
                    orphanTabsClosed: orphanTabIds.length
                };
                const message = {type: 'aes:scrape-all:progress', event: recovered};
                if (prev.senderTabId != null) {
                    try { chrome.tabs.sendMessage(prev.senderTabId, message, () => { void chrome.runtime.lastError; }); }
                    catch (_) { /* noop */ }
                }
                try { chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; }); }
                catch (_) { /* noop */ }
                _clearPersistedState();
            });
        } catch (_) { /* noop */ }
    }
    _recoverFromCrash();

    globalThis.ScrapeTabPool = {
        startRun:     startRun,
        abortRun:     abortRun,
        getStatus:    getStatus,
        onProgress:   onProgress,
        resetBreaker: resetBreaker
    };
})();
