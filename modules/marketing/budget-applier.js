"use strict"

/**
 * AES Marketing — per-region budget applier (Slice 19, v1 stub).
 *
 * v1 stub: same shape as the inventory + service-profile appliers, but
 * the actual POST stays gated behind `applyEnabled` AND a "form-shape-
 * mapped" probe. Until an AS marketing-page sample lands, every apply
 * call returns `{status: "noop", reason: "form-shape-not-yet-mapped"}`.
 *
 * Public API (window.AesMarketingBudgetApplier):
 *   apply({server, regionId, newBudgetAS, dryRun?, source?}) → Promise<envelope>
 *
 * Envelope:
 *   {status: "noop"|"dry-run"|"posted"|"verified"|"failed",
 *    regionId, server, prevBudgetAS, newBudgetAS, ts, reason?, error?}
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesMarketingBudgetApplier) return

    const URL_PATH = "/app/enterprise/marketing"

    async function apply(opts) {
        const o = opts || {}
        const env = {
            ts:           Date.now(),
            regionId:     o.regionId || null,
            server:       o.server   || null,
            newBudgetAS:  Number(o.newBudgetAS) || null,
            prevBudgetAS: null,
            source:       o.source || "manual"
        }
        if (!env.server || !env.regionId || env.newBudgetAS == null) {
            env.status = "failed"
            env.error  = "server, regionId, newBudgetAS all required"
            return env
        }
        if (o.dryRun) {
            env.status = "dry-run"
            env.reason = "dryRun=true"
            return env
        }
        // v1 form-shape-not-yet-mapped — return noop until parser lands.
        env.status = "noop"
        env.reason = "form-shape-not-yet-mapped"
        return env
    }

    window.AesMarketingBudgetApplier = {
        apply:    apply,
        URL_PATH: URL_PATH
    }
})()
