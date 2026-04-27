"use strict"

/**
 * Track 7 slice 7c — Schedule broadcaster.
 *
 * The bridge between the synchronous DOM readers (vfp-reader,
 * planning-matrix-reader, turnaround-popover-reader) and the persistent
 * `AesAfpScheduleStore`. Runs on every `ctx:ready` (host.js fires this
 * on first mount and on every Wicket-triggered re-mount via the
 * MutationObserver at host.js:644).
 *
 * Pipeline:
 *   ctx:ready  →  vfp-reader.read()  →  schedule-store.save()
 *                                          ↓ (only on content change —
 *                                             store does its own hash-gate)
 *                                       chrome.storage.local.set
 *                                          ↓
 *                              chrome.storage.onChanged
 *                                          ↓
 *                  cross-tab consumers (Fleet Hub overlay, RA panel, …)
 *                                          ↓
 *                  AesAfp.bus.emit("schedule:updated", {…})
 *                                          ↓
 *                  in-page consumers (preview-panel, route-candidates, …)
 *
 * Order matters: chrome.storage.local.set fires `chrome.storage.onChanged`
 * AFTER its promise resolves, so we await the save and then emit on the
 * bus. Other-tab consumers see the storage event; this-tab consumers can
 * subscribe to either signal — the bus emit is a same-tick convenience.
 *
 * Defensive: every step wrapped in try/catch. A reader throw doesn't
 * stop the broadcaster from re-running on the next ctx:ready.
 *
 * No-op when:
 *   - aircraftId or server is missing from ctx (shouldn't happen on the
 *     AFP page but handles bad mounts)
 *   - vfp-reader / schedule-store / schedule-model isn't loaded
 *     (defensive guards on every call)
 *   - the scrape produced an empty Schedule (no .as-panel.visual-flight-plan
 *     in DOM and no planning-matrix form) — saving that would clobber
 *     a previous valid schedule. We only save when at least ONE of
 *     `legs.length > 0` or `planningMatrix.isPresent` is true.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesAfpScheduleBroadcaster) return

    let _attached = false
    let _lastSavedAt = 0
    let _inFlight = false
    const MIN_INTERVAL_MS = 250   // throttle: don't re-scrape more than 4×/sec

    /**
     * Run one scrape + save cycle. Returns the saved Schedule (or null if
     * the save was skipped). Idempotent — safe to call multiple times in
     * a row; the store's hash-gate collapses redundant writes.
     */
    async function refresh(opts) {
        opts = opts || {}
        if (_inFlight && !opts.force) return null
        const now = Date.now()
        if (!opts.force && (now - _lastSavedAt) < MIN_INTERVAL_MS) return null

        if (typeof window.AesAfpVfpReader     === "undefined") return null
        if (typeof window.AesAfpScheduleStore === "undefined") return null
        if (typeof window.AesAfpScheduleModel === "undefined") return null

        const ctx = (window.AesAfp && AesAfp.ctx) ? AesAfp.ctx : null
        if (!ctx || !ctx.server || !ctx.aircraftId) return null

        _inFlight = true
        try {
            const schedule = window.AesAfpVfpReader.read({
                server:     ctx.server,
                aircraftId: ctx.aircraftId,
                hubIata:    ctx.currentLocationIata || null
            })
            // Don't clobber a stored schedule with an empty scrape — that
            // happens transiently while Wicket re-renders the form panel.
            const isEmpty = (schedule.legs.length === 0)
                         && !(schedule.planningMatrix && schedule.planningMatrix.isPresent)
            if (isEmpty) return null

            const saved = await window.AesAfpScheduleStore.save(
                ctx.server, ctx.aircraftId, schedule
            )

            if (saved && window.AesAfp && AesAfp.bus) {
                try {
                    AesAfp.bus.emit("schedule:updated", {
                        server:     ctx.server,
                        aircraftId: ctx.aircraftId,
                        scrapedAt:  saved.scrapedAt,
                        schedule:   saved
                    })
                } catch (e) {
                    console.warn("[AES AFP] schedule-broadcaster bus.emit threw", e)
                }
            }
            _lastSavedAt = Date.now()
            return saved
        } catch (e) {
            console.warn("[AES AFP] schedule-broadcaster.refresh threw", e)
            return null
        } finally {
            _inFlight = false
        }
    }

    /** Subscribe to AesAfp.bus.on("ctx:ready") so every mount + re-mount
     *  triggers a fresh scrape. Idempotent — called twice does nothing
     *  the second time. */
    function attach() {
        if (_attached) return
        if (!window.AesAfp || !AesAfp.bus) return
        try {
            AesAfp.bus.on("ctx:ready", () => {
                // Defer one tick so other ctx:ready subscribers (the
                // existing slice F handlers) finish their setup before
                // we sample the DOM.
                setTimeout(() => { refresh().catch(() => {}) }, 0)
            })
            _attached = true
        } catch (e) {
            console.warn("[AES AFP] schedule-broadcaster.attach threw", e)
        }
    }

    if (typeof window !== "undefined") {
        window.AesAfpScheduleBroadcaster = { attach, refresh }
    }

    // Auto-attach when host.js publishes window.AesAfp. host.js runs ahead
    // of us in the manifest, so this hits on first import.
    if (window.AesAfp && window.AesAfp.bus) {
        attach()
    } else {
        // Fall back: poll for AesAfp's appearance once per animation frame
        // for up to ~2s (host.js mount runs synchronously on script load,
        // but if it ever becomes async we won't miss it).
        let tries = 0
        const poll = () => {
            tries++
            if (window.AesAfp && window.AesAfp.bus) { attach(); return }
            if (tries < 120) requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
    }
})()
