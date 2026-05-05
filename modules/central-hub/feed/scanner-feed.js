"use strict"

/**
 * HubFeed slice: `hub:scanner:deals` — thin passthrough on the
 * `scanner:current-deals` view, so consuming tiles get HubFeed's freshness
 * dot + a consistent surface alongside `hub:cash:weekly` / `hub:strategy:*`.
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof window.HubFeed === "undefined" || typeof window.AesView === "undefined") return
    if (window.__aesScannerFeedDeclared) return
    window.__aesScannerFeedDeclared = true

    HubFeed.declare({
        name:       "hub:scanner:deals",
        deps:       ["view:scanner:current-deals:computed", "data:account:bootstrapped"],
        ttlMs:      24 * 60 * 60 * 1000,
        debounceMs: 80,
        getScrapedAt: (v) => v && Number.isFinite(v.scrapedAt) ? v.scrapedAt : null,
        compute:    async () => {
            // The view-engine guarantees the underlying view recomputes when
            // its own deps fire; we just expose the current snapshot.
            const v = AesView.get("scanner:current-deals")
            if (v !== undefined) return v
            // Cold start — invalidate to force a first compute, then await it.
            AesView.invalidate("scanner:current-deals")
            return await new Promise((resolve) => {
                const off = AesView.subscribe("scanner:current-deals", (e) => {
                    if (!e || !e.hasValue) return
                    off(); resolve(e.value)
                })
            })
        }
    })
})()
