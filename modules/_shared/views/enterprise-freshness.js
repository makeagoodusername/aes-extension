"use strict"

/**
 * Canonical view: `enterprise:freshness`
 *
 * Aggregates "when did each major data class last update?" into one shape so
 * the dashboard can render a single freshness indicator instead of per-tile
 * staleness probes. Reads scrapedAt timestamps from the canonical stores;
 * never modifies state.
 *
 * Per-class staleness TTLs are declared inline so a future settings UI can
 * surface them.
 *
 * Replaces ad-hoc probes in:
 *   - modules/central-hub/tiles/data-flow-inspector-tile.js
 *   - modules/central-hub/activity-strip.js (future)
 *   - modules/central-hub/hero-strip.js (future)
 *
 * Output shape (per class):
 *   {at: number | null, ageMs: number | null, isStale: bool}
 *
 * Top-level fields: ors, markets, accounting, fleet, fuel, scanner,
 *                   worstAt, worstAgeMs, scrapedAt.
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AesView || !window.AesDataBus) return
    if (window.__aesViewEnterpriseFreshnessDeclared) return
    window.__aesViewEnterpriseFreshnessDeclared = true

    const STALE_TTL_MS = {
        ors:        4  * 60 * 60 * 1000,
        markets:    6  * 60 * 60 * 1000,
        accounting: 8  * 24 * 60 * 60 * 1000,
        fleet:      24 * 60 * 60 * 1000,
        fuel:       4  * 60 * 60 * 1000,
        scanner:    24 * 60 * 60 * 1000
    }

    AesView.declare({
        name:       "enterprise:freshness",
        deps:       [
            "data:accounting:weekly:saved",
            "data:route-assistant:fuel-price:updated",
            "data:route-assistant:markets:updated",
            "data:route-assistant:ors:updated",
            "data:scanner:scan:saved",
            "data:afp:maintenance:updated",
            "data:account:bootstrapped"
        ],
        debounceMs: 200,
        compute:    async () => {
            const ctx = pickCtx()
            const now = Date.now()
            const out = {scrapedAt: now}

            out.accounting = makeEntry("accounting", await readAccountingAt(ctx), now)
            out.fuel       = makeEntry("fuel",       await readFuelAt(),         now)
            out.fleet      = makeEntry("fleet",      await readFleetAt(ctx),     now)
            out.scanner    = makeEntry("scanner",    await readScannerAt(ctx),   now)
            out.markets    = makeEntry("markets",    await readMarketsAt(ctx),   now)
            out.ors        = makeEntry("ors",        await readOrsAt(ctx),       now)

            let worstAt = null, worstAgeMs = -1
            for (const cls of Object.keys(STALE_TTL_MS)) {
                const e = out[cls]
                if (!e || e.at == null) continue
                if (e.ageMs != null && e.ageMs > worstAgeMs) {
                    worstAgeMs = e.ageMs; worstAt = e.at
                }
            }
            out.worstAt    = worstAt
            out.worstAgeMs = worstAt == null ? null : worstAgeMs
            return out
        }
    })

    function makeEntry(cls, at, now) {
        if (!Number.isFinite(at) || at <= 0) {
            return {at: null, ageMs: null, isStale: true}
        }
        const ageMs = now - at
        return {at: at, ageMs: ageMs, isStale: ageMs > STALE_TTL_MS[cls]}
    }

    async function readAccountingAt(ctx) {
        if (!ctx.server || !ctx.airline) return null
        const key = ctx.server + ctx.airline + "accounting:index"
        const blob = await safeGet([key])
        const idx = Array.isArray(blob[key]) ? blob[key] : null
        if (!idx || !idx.length) return null
        // index entries carry weekClosesAt (week boundary). Use the newest
        // bank record's scrapedAt if available; fall back to weekClosesAt.
        const head = idx[0]
        const week = head.weekId || head.weekClosesAt
        if (week) {
            const bankKey = ctx.server + ctx.airline + "accounting:bank:" + week
            const bb = await safeGet([bankKey])
            const rec = bb[bankKey]
            if (rec && Number.isFinite(rec.scrapedAt)) return Number(rec.scrapedAt)
        }
        return Number(head.scrapedAt) || Number(head.weekClosesAt) || null
    }

    async function readFuelAt() {
        const cached = AesDataBus.last("data:route-assistant:fuel-price:updated")
        if (cached && Number.isFinite(cached.scrapedAt)) return Number(cached.scrapedAt)
        if (typeof RouteAssistantFuelPriceScraper === "undefined") return null
        try {
            const rec = await RouteAssistantFuelPriceScraper.getCached()
            return rec && Number.isFinite(rec.scrapedAt) ? Number(rec.scrapedAt) : null
        } catch (_) { return null }
    }

    async function readFleetAt(ctx) {
        // Fleet "freshness" uses the most recent maintenance scrape across the
        // fleet (proxy for the wear-rollup view's scrapedAt).
        const view = AesView.get("fleet:wear-rollup")
        if (view && Number.isFinite(view.scrapedAt)) return Number(view.scrapedAt)
        // Fallback — read a coarse hint from FleetRoster's own scrapedAt if any.
        if (typeof window.AesFleetRoster === "undefined") return null
        try {
            const r = await window.AesFleetRoster.load(ctx.server, ctx.airline)
            return r && Number.isFinite(r.scrapedAt) ? Number(r.scrapedAt) : null
        } catch (_) { return null }
    }

    async function readScannerAt(ctx) {
        const view = AesView.get("scanner:current-deals")
        if (view && Number.isFinite(view.scrapedAt)) return Number(view.scrapedAt)
        return null
    }

    async function readMarketsAt(ctx) {
        if (!ctx.server) return null
        // Scan the storage prefix for the newest scrapedAt without loading the
        // full record set; one chrome.storage.local.get(null) is acceptable
        // because freshness recomputes are debounced + on-demand only.
        try {
            const all = await chrome.storage.local.get(null)
            const prefix = "routeAssistant:markets:"
            let newest = 0
            for (const k in all) {
                if (k.indexOf(prefix) !== 0) continue
                const rec = all[k]
                if (rec && Number.isFinite(rec.scrapedAt) && rec.scrapedAt > newest) {
                    newest = rec.scrapedAt
                }
            }
            return newest || null
        } catch (_) { return null }
    }

    async function readOrsAt(ctx) {
        try {
            const all = await chrome.storage.local.get(null)
            const prefix = "routeAssistant:ors:"
            let newest = 0
            for (const k in all) {
                if (k.indexOf(prefix) !== 0) continue
                const rec = all[k]
                if (rec && Number.isFinite(rec.scrapedAt) && rec.scrapedAt > newest) {
                    newest = rec.scrapedAt
                }
            }
            return newest || null
        } catch (_) { return null }
    }

    async function safeGet(keys) {
        try {
            if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return {}
            return await chrome.storage.local.get(keys)
        } catch (_) { return {} }
    }

    function pickCtx() {
        let server = "", airline = ""
        try {
            if (typeof AES !== "undefined") {
                if (AES.getServer)          server  = AES.getServer() || ""
                if (AES.getAirlineIdentity) airline = AES.getAirlineIdentity() || ""
            }
        } catch (_) {}
        return {server: server, airline: airline}
    }

    // Expose TTLs for diagnostics + future settings UI.
    window.AES_FRESHNESS_TTL_MS = STALE_TTL_MS
})()
