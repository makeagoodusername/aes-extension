"use strict"

/**
 * AESScrapeHost — singleton mount on /app/enterprise/dashboard*.
 *
 * Owns the lifecycle of the "Scrape everything" feature:
 *   1. open()     — entry from the central-hub button. Decides whether to
 *                   show the ToS modal, the resume banner, or jump straight
 *                   into a progress modal.
 *   2. _runStart  — instantiate the orchestrator + progress modal, wire
 *                   their callbacks, kick off the run.
 *   3. _runResume — re-attach to a run that's already in progress in the
 *                   background (e.g. after a tab refresh).
 *
 * This module is idempotent — loaded twice on the same page it no-ops.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AESScrapeHost) return

    let _busy = false        // protects against double-clicks while a modal is open
    let _modal = null        // active progress modal instance, if any
    let _orchestrator = null // active orchestrator instance, if any

    async function open() {
        if (_busy) return
        _busy = true

        const running = await window.ScrapeOrchestrator.isRunning()
        if (running) {
            await _runResume()
            return    // _busy stays true until _teardown
        }

        const estimate = await window.ScrapeOrchestrator.estimate()
        if (!estimate) {
            _toast("Scrape: server/airline context not ready — try again in a moment.", "warn")
            _busy = false
            return
        }

        const accepted = await window.ScrapeTosConfirmation.hasAccepted()
        let opts
        if (accepted) {
            opts = {includePerCompetitor: false, includeDemandSeed: false, includeFlightsFrom: false}
        } else {
            const result = await window.ScrapeTosConfirmation.show(estimate)
            if (!result || !result.confirmed) {
                _busy = false
                return
            }
            opts = {
                includePerCompetitor: !!result.includePerCompetitor,
                includeDemandSeed:    !!result.includeDemandSeed,
                includeFlightsFrom:   !!result.includeFlightsFrom
            }
        }

        _runStart(opts)
        // _busy released when modal tears down
    }

    async function _runStart(opts) {
        const phases = window.ScrapeOrchestratorPhases.all().filter(p =>
            !p.optional
            || (p.id === "per-competitor" && opts.includePerCompetitor)
            || (p.id === "demand-seed"    && opts.includeDemandSeed)
            || (p.id === "flightsfrom"    && opts.includeFlightsFrom)
        )

        const summary = {
            runId:       null,
            source:      "manual",
            startedAt:   Date.now(),
            completedAt: null,
            durationMs:  0,
            aborted:     false,
            perPhase:    {},
            failedJobs:  []
        }

        _modal = new window.ScrapeProgressModal()
        _modal.mount()
        _modal.setPhases(phases.map(p => ({id: p.id, label: p.label})))
        _modal.onCancel = () => { if (_orchestrator) _orchestrator.abort() }
        _modal.onClose  = () => _teardown()

        _orchestrator = new window.ScrapeOrchestrator({
            onPhaseStart: (e) => _modal && _modal.onPhaseStart(e),
            onPhaseDone:  (e) => {
                summary.perPhase[e.phaseId] = {
                    label:     (phases.find(p => p.id === e.phaseId) || {}).label || e.phaseId,
                    total:     e.total     || 0,
                    succeeded: e.succeeded || 0,
                    failed:    e.failed    || 0,
                    skipped:   !!e.skipped
                }
                if (_modal) _modal.onPhaseDone(e)
            },
            onProgress:   (e) => {
                if (e && e.type === "job-fail") {
                    summary.failedJobs.push({
                        phaseId: e.phaseId,
                        jobId:   e.jobId,
                        url:     e.url || "",
                        error:   e.error || ""
                    })
                }
                if (_modal) _modal.onProgress(e)
            },
            onError:      (e) => _modal && _modal.onError(e),
            onDone:       (e) => {
                summary.runId       = (e && e.runId) || summary.runId
                summary.completedAt = Date.now()
                summary.durationMs  = summary.completedAt - summary.startedAt
                summary.aborted     = !!(e && e.aborted)
                try {
                    chrome.storage.local.set({"scrapeOrchestrator:lastRun": summary})
                } catch (_) { /* noop */ }
                if (_modal) _modal.onDone(e)
                if (!summary.aborted) _toast("Scrape complete.", "ok")
            }
        })

        try {
            await _orchestrator.start(Object.assign({}, opts, {source: "manual"}))
        } catch (e) {
            if (_modal) _modal.onError({message: (e && e.message) || String(e), phase: null})
        }
    }

    async function _runResume() {
        if (_modal) return    // already attached
        const status = await window.ScrapeOrchestrator.getStatus()
        if (!status || !status.running) { _busy = false; return }

        _busy = true
        const allPhases = window.ScrapeOrchestratorPhases.all()
        _modal = new window.ScrapeProgressModal()
        _modal.mount()
        _modal.setPhases(allPhases.map(p => ({id: p.id, label: p.label})))
        _modal.onCancel = () => {
            chrome.runtime.sendMessage({type: "aes:scrape-all:abort"}, () => {
                void chrome.runtime.lastError
            })
        }
        _modal.onClose = () => _teardown()
        _modal._showBanner("Resumed — re-attached to in-flight scrape.", "info", false)

        const handler = (msg) => {
            if (!msg || msg.type !== "aes:scrape-all:progress" || !msg.event) return
            if (!_modal) return
            _modal.onProgress(msg.event)
            if (msg.event.type === "run-done") {
                _modal.onDone({aborted: msg.event.reason === "aborted"})
                try { chrome.runtime.onMessage.removeListener(handler) } catch (_) {}
            }
        }
        chrome.runtime.onMessage.addListener(handler)
    }

    function _teardown() {
        if (_modal) { try { _modal.unmount() } catch (_) {} }
        _modal = null
        _orchestrator = null
        _busy = false
        // Reset the circuit breaker on teardown so a halted run doesn't
        // gate the next user-initiated retry behind a 10-minute cooldown.
        try { window.ScrapeOrchestrator.resetBreaker() } catch (_) {}
    }

    function _toast(text, kind) {
        const typeMap = {ok: "success", info: "info", warn: "warn", err: "error"}
        const type = typeMap[kind] || "info"
        try {
            if (window.RouteAssistantToast && typeof window.RouteAssistantToast.show === "function") {
                window.RouteAssistantToast.show(text, {type: type})
                return
            }
        } catch (_) { /* fall through */ }
        try { console.log("[AES Scrape]", text) } catch (_) {}
    }

    window.AESScrapeHost = {open: open}

    // Auto-resume: on dashboard mount, if a run is already active in the
    // background, surface the progress modal without waiting for the user
    // to click the button again.
    function _autoResumeIfActive() {
        if (typeof window.ScrapeOrchestrator !== "function") return
        // Skip auto-resume when the active run was started silently by the
        // background auto-driver — surfacing a progress modal for a scrape
        // the user didn't initiate is jarring.
        chrome.storage.local.get(["aesAutoDrive:silentRunActive"], (blob) => {
            void chrome.runtime.lastError
            if (blob && blob["aesAutoDrive:silentRunActive"]) return
            window.ScrapeOrchestrator.isRunning().then((running) => {
                if (running && !_modal) _runResume().catch(() => {})
            }).catch(() => {})
        })
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _autoResumeIfActive, {once: true})
    } else {
        setTimeout(_autoResumeIfActive, 500)
    }
})()
