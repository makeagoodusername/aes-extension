"use strict"

/**
 * AES Marketing — per-region budget scraper (Slice 19, v1 stub).
 *
 * v1 ships an enrichment-friendly stub: the public surface matches the
 * shape the tuner consumes, but the actual page-parse path returns
 * `{ok: false, reason: "form-shape-not-yet-mapped"}` until an AS HTML
 * sample lets us write a confident parser.
 *
 * Why ship the stub now:
 *   - lays down `window.AesMarketingBudgetScraper` so the tuner can call
 *     it without breaking when the parser arrives.
 *   - provides `record(rec)` — accepts a record built from the page
 *     manually (DevTools paste) so the user can hand-seed budget data
 *     today and let the tuner work without a fully wired scraper.
 *   - documents the expected request shape so the parser's author has
 *     a target.
 *
 * Public API (window.AesMarketingBudgetScraper):
 *   fetchAndStore(ctx)  → Promise<{ok, record?, reason?}>
 *   parseHtml(html)     → record | null  (stub returns null in v1)
 *   record(rec, ctx?)   → Promise<record>  (manual hand-seed path)
 *
 * Expected page (per Slice 19 spec):
 *   /app/enterprise/marketing  — per-region budget table with weekly
 *   spend per region. AS may expose this only when marketing module is
 *   enabled in the world's settings; the scraper detects and surfaces
 *   reason="not-exposed" in that case.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesMarketingBudgetScraper) return

    const URL_PATH = "/app/enterprise/marketing"

    function _baseUrl(server) {
        return "https://" + server + ".airlinesim.aero"
    }

    async function fetchAndStore(ctx) {
        ctx = ctx || {}
        const server = ctx.server
        if (!server) return {ok: false, reason: "no-server"}
        let html
        try {
            const resp = await fetch(_baseUrl(server) + URL_PATH, {credentials: "include"})
            if (!resp.ok) return {ok: false, reason: "http-" + resp.status}
            html = await resp.text()
        } catch (e) {
            return {ok: false, reason: "fetch-threw: " + (e && e.message || String(e))}
        }
        if (/<form[^>]+action=["'][^"']*\/login/i.test(html)) {
            return {ok: false, reason: "not-logged-in"}
        }
        const parsed = parseHtml(html)
        if (!parsed) return {ok: false, reason: "form-shape-not-yet-mapped"}
        if (window.AesMarketingBudgetStore) {
            const saved = await window.AesMarketingBudgetStore.save(parsed, ctx)
            return {ok: true, record: saved}
        }
        return {ok: true, record: parsed}
    }

    /**
     * Parser stub. Returns null in v1 — the actual table parse needs
     * an HTML sample to map column → field. When the sample lands,
     * replace this with: walk `<table>` rows, for each row pull
     * `data-region`, current weekly budget input value, and (if shown)
     * the demand-bar level.
     */
    function parseHtml(/* html */) {
        return null
    }

    /**
     * Manual hand-seed. The user can paste a budget record (built from
     * DevTools snooping or from the AS page directly) and have the
     * tuner work against it today, ahead of the parser landing.
     */
    async function record(rec, ctx) {
        if (!window.AesMarketingBudgetStore) {
            throw new Error("record: AesMarketingBudgetStore not loaded")
        }
        return window.AesMarketingBudgetStore.save(rec, ctx)
    }

    window.AesMarketingBudgetScraper = {
        fetchAndStore: fetchAndStore,
        parseHtml:     parseHtml,
        record:        record,
        URL_PATH:      URL_PATH
    }
})()
