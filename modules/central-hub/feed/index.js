"use strict"

/**
 * HubFeed boot — registers `AesDataBus.bridgeStorage` entries that translate
 * legacy producer storage writes into bus topics the feed views depend on.
 * This is the single migration anchor: as a producer module adds an explicit
 * `AesDataBus.publish(...)` call, the corresponding bridge here can be
 * removed. Until then, the feed views recompute via the storage echo so the
 * hub always renders fresh values.
 *
 * Bridges installed:
 *   accounting:bank|income|index       → data:accounting:weekly:saved
 *   aesStrategy:plan:applied           → data:strategy:applied:saved
 *   settings (RA strategy lives there) → data:strategy:settings:saved
 *
 * Account bootstrap signal: `__aesAccountId` flips from null to a stable id
 * once `AesAccountRegistry.computeId()` resolves. The shell pings the bus
 * once after mount so account-scoped feeds re-compute with the right id.
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof window.AesDataBus === "undefined") return
    if (window.__aesHubFeedBooted) return
    window.__aesHubFeedBooted = true

    // accounting → cash feed. Accounting writes are server+airline-prefixed
    // (e.g. "ZB:1234:accounting:index"), so a startsWith bridge would miss
    // them — we wire a substring matcher directly here. The slice's compute
    // reads only the keys for the current airline ctx.
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            for (const key in changes) {
                if (key.indexOf("accounting:") < 0) continue
                AesDataBus.emit("data:accounting:weekly:saved", {key: key})
                return  // dedupe — one emit per onChanged batch
            }
        })
    } catch (_) { /* chrome.storage unavailable — bus stays in-tab only */ }

    // strategy applied — bridge the bare key (legacy) AND server-scoped
    // writes via the same substring matcher pattern as accounting.
    AesDataBus.bridgeStorage({
        prefix: "aesStrategy:plan:applied",
        topic:  "data:strategy:applied:saved"
    })

    // strategy settings: written into the shared `settings` blob.
    AesDataBus.bridgeStorage({
        prefix: "settings",
        single: true,
        topic:  "data:strategy:settings:saved"
    })

    // `data:account:bootstrapped`: the central-hub shell emits this once
    // AesAccountRegistry resolves, but the shell only mounts on
    // /app/enterprise/dashboard. Tabs that mount tile-style panels on
    // bridge.html or under /app/* (fleet-overlay, accounting-pane, etc.)
    // still need the signal so account-scoped feed slices recompute. Mirror
    // the shell's emit here, gated on a one-time flag (__aesAccountBootstrapEmitted)
    // so we don't double-fire when the shell ALSO mounts.
    function _emitAccountBootstrapped() {
        if (window.__aesAccountBootstrapEmitted) return
        window.__aesAccountBootstrapEmitted = true
        try {
            AesDataBus.emit("data:account:bootstrapped", {
                accountId: window.__aesAccountId || null,
                at:        Date.now()
            })
        } catch (_) { /* bus is best-effort */ }
    }

    // helpers.js bootstraps __aesAccountId on a setTimeout(0). Poll for
    // AES.getAirlineIdentity() to resolve to a non-empty string before
    // emitting — slices like hub:cash:weekly key off the airline name and
    // would otherwise compute against an empty identity (yielding a
    // permanent "no airline" value because deps don't fire again on
    // first-load). Cap the wait so login / pre-DOM flows still emit.
    function _waitForAirlineThenEmit() {
        const startedAt = Date.now()
        const MAX_WAIT_MS = 6000
        const POLL_MS = 100
        function tick() {
            if (window.__aesAccountBootstrapEmitted) return
            let airline = ""
            try {
                if (typeof AES !== "undefined" && typeof AES.getAirlineIdentity === "function") {
                    airline = AES.getAirlineIdentity() || ""
                }
            } catch (_) { /* swallow — emit will fall through on timeout */ }
            if (airline) return _emitAccountBootstrapped()
            if (Date.now() - startedAt >= MAX_WAIT_MS) return _emitAccountBootstrapped()
            setTimeout(tick, POLL_MS)
        }
        tick()
    }
    setTimeout(_waitForAirlineThenEmit, 50)
})()
