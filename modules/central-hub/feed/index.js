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

    // The `data:account:bootstrapped` signal is emitted by the shell once
    // AesAccountRegistry resolves. It's a local emit; no storage bridge.
})()
