"use strict"

/**
 * AES Strategy — Markets Gossip driver (Slice 27).
 *
 * Subscribes to chrome.storage.onChanged, runs every matching detector
 * via `AesStrategyGossipDetectors.runAll`, persists the resulting
 * GossipEvent records into `AesStrategyGossipStore`, and emits
 * `data:strategy:gossip:event` on the bus per recorded event.
 *
 * High-severity events also fire chrome.notifications.create() (already
 * granted via the manifest's `notifications` permission) so the user
 * sees a desktop toast for the worst gossip without opening the dashboard.
 *
 * Single subscriber per page load via the `_attached` guard.
 *
 * Public API (window.AesStrategyGossipDriver):
 *   .init()        → void   (idempotent; auto-runs at module load)
 *   .processOnce(key, oldV, newV, host) → Promise<event[]>   (testable)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyGossipDriver) return

    function _resolveHost() {
        try {
            if (typeof AES === "undefined") return null
            const server  = (AES.getServerName && AES.getServerName()) || ""
            const codeRec = (AES.getAirlineCode && AES.getAirlineCode()) || null
            const airline = (codeRec && codeRec.code) || ""
            if (!server || !airline) return null
            return {server, airline}
        } catch (_) { return null }
    }

    async function processOnce(key, oldV, newV, hostArg) {
        const detectors = window.AesStrategyGossipDetectors
        const store     = window.AesStrategyGossipStore
        if (!detectors || !store) return []
        const host = hostArg || _resolveHost()
        if (!host) return []
        const events = detectors.runAll(key, oldV, newV)
        if (!events.length) return []
        // Pre-filter against the seen set so re-firing is idempotent within
        // the LRU window. The detector already produces fresh eventIds, but
        // the seen set covers user-acknowledged events to prevent surfacing
        // them again after a re-scrape.
        const seen = await store.loadSeen(host)
        const filtered = events.filter(e => !seen.has(e.eventId))
        if (!filtered.length) return []
        await store.append(host, filtered)
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                for (const ev of filtered) {
                    window.CentralHubBus.emit("data:strategy:gossip:event", ev)
                }
            }
        } catch (_) {}
        // Desktop notifications for high severity. Best-effort — silently
        // skipped when chrome.notifications is missing or denied.
        try {
            if (typeof chrome !== "undefined" && chrome.notifications
                    && typeof chrome.notifications.create === "function") {
                for (const ev of filtered) {
                    if (ev.severity !== "high") continue
                    chrome.notifications.create(ev.eventId, {
                        type:    "basic",
                        iconUrl: chrome.runtime && chrome.runtime.getURL
                            ? chrome.runtime.getURL("img/icon-32.png") : "",
                        title:   "AES — gossip",
                        message: ev.summary || "Market anomaly detected"
                    })
                }
            }
        } catch (_) {}
        return filtered
    }

    let _attached = false
    function init() {
        if (_attached) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                const ch = changes[key] || {}
                processOnce(key, ch.oldValue, ch.newValue).catch(e =>
                    console.warn("[AesStrategyGossipDriver] processOnce threw", e))
            }
        })
        _attached = true
    }

    window.AesStrategyGossipDriver = {
        init:        init,
        processOnce: processOnce
    }

    init()
})()
