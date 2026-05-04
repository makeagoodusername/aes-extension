"use strict"

/**
 * HubFeed slices for the enterprise rollup + freshness views:
 *   hub:enterprise:financial — multi-week trend + runway from `enterprise:financial-rollup`
 *   hub:enterprise:freshness — per-data-class staleness map from `enterprise:freshness`
 *
 * Both are thin passthroughs so consuming tiles get HubFeed's freshness dot
 * and a consistent surface; the underlying compute lives in the view files.
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof window.HubFeed === "undefined" || typeof window.AesView === "undefined") return
    if (window.__aesEnterpriseFeedDeclared) return
    window.__aesEnterpriseFeedDeclared = true

    declarePassthrough({
        name:        "hub:enterprise:financial",
        viewName:    "enterprise:financial-rollup",
        ttlMs:       8 * 24 * 60 * 60 * 1000,    // weekly cadence
        debounceMs:  100,
        getScrapedAt: (v) => v && Number.isFinite(v.scrapedAt) ? v.scrapedAt : null
    })

    declarePassthrough({
        name:        "hub:enterprise:freshness",
        viewName:    "enterprise:freshness",
        ttlMs:       0,                           // self-stale logic lives in the value
        debounceMs:  200,
        getScrapedAt: (v) => v && Number.isFinite(v.scrapedAt) ? v.scrapedAt : null
    })

    function declarePassthrough(opts) {
        HubFeed.declare({
            name:        opts.name,
            deps:        ["view:" + opts.viewName + ":computed", "data:account:bootstrapped"],
            ttlMs:       opts.ttlMs,
            debounceMs:  opts.debounceMs,
            getScrapedAt: opts.getScrapedAt,
            compute:     async () => {
                const v = AesView.get(opts.viewName)
                if (v !== undefined) return v
                AesView.invalidate(opts.viewName)
                return await new Promise((resolve) => {
                    const off = AesView.subscribe(opts.viewName, (e) => {
                        if (!e || !e.hasValue) return
                        off(); resolve(e.value)
                    })
                })
            }
        })
    }
})()
