"use strict"

/**
 * AES Slots — slot-page scraper (Slice 20, v1 stub).
 *
 * Mirrors the Slice 19 marketing-budget-scraper shape: ships a stub
 * that exposes the public API surface so the tuner / bidder / tile can
 * call it without breaking, but the actual HTML parser returns null
 * until an AS sample lets us write a confident parser. The user can
 * hand-seed records via `record(rec)` to drive the tuner today.
 *
 * URL pattern (per Slice 20 spec, verify on the live site):
 *   /app/airport/<IATA>/slots
 *
 * Public API (window.AesSlotScraper):
 *   fetchAndStore(ctx)   → Promise<{ok, record?, reason?}>
 *   parseHtml(html, ctx) → SlotRecord[] | null
 *   record(rec, ctx?)    → Promise<SlotRecord>
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesSlotScraper) return

    const URL_TPL = "/app/airport/{IATA}/slots"

    function _baseUrl(server) { return "https://" + server + ".airlinesim.aero" }

    async function fetchAndStore(ctx) {
        ctx = ctx || {}
        const server = ctx.server
        const iata   = ctx.iata
        if (!server) return {ok: false, reason: "no-server"}
        if (!iata)   return {ok: false, reason: "no-iata"}

        const url = _baseUrl(server) + URL_TPL.replace("{IATA}", encodeURIComponent(iata))
        let html
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return {ok: false, reason: "http-" + resp.status}
            html = await resp.text()
        } catch (e) {
            return {ok: false, reason: "fetch-threw: " + (e && e.message || String(e))}
        }
        if (/<form[^>]+action=["'][^"']*\/login/i.test(html)) {
            return {ok: false, reason: "not-logged-in"}
        }
        const parsed = parseHtml(html, ctx)
        if (!parsed) return {ok: false, reason: "form-shape-not-yet-mapped"}
        if (window.AesSlotStore) {
            const merged = await _mergeIntoStore(server, iata, parsed)
            return {ok: true, count: merged.length}
        }
        return {ok: true, parsed}
    }

    /**
     * Stub. When AS sample HTML is captured, fill in the real parser.
     * Expected output shape per record:
     *   {iata, slotId, runwayClass, weeklyOps, expiresAt?, minBid?, currentBid?}
     */
    function parseHtml(_html, _ctx) {
        return null
    }

    /**
     * Hand-seed path. Writes one or more SlotRecord objects directly to
     * the store; useful when the user pastes data manually while the
     * parser is unmapped.
     */
    async function record(rec, ctx) {
        ctx = ctx || {}
        const server = ctx.server || (rec && rec.server)
        if (!server) throw new Error("record: server required")
        const records = Array.isArray(rec) ? rec : [rec]
        if (!window.AesSlotStore) throw new Error("AesSlotStore not loaded")
        const merged = await _mergeIntoStore(server, ctx.iata || null, records)
        return merged
    }

    async function _mergeIntoStore(server, iata, fresh) {
        const existing = await window.AesSlotStore.loadAvailable(server)
        const byKey = new Map()
        for (const r of existing) {
            if (!r) continue
            byKey.set(_keyOf(r), r)
        }
        for (const r of fresh) {
            if (!r) continue
            const enriched = Object.assign({}, r)
            if (iata && !enriched.iata) enriched.iata = iata
            enriched.observedAt = Date.now()
            byKey.set(_keyOf(enriched), enriched)
        }
        const merged = Array.from(byKey.values())
            .sort((a, b) => (b.observedAt || 0) - (a.observedAt || 0))
        return await window.AesSlotStore.saveAvailable(server, merged)
    }

    function _keyOf(r) {
        return String(r.iata || "_") + "/" + String(r.slotId || r.runwayClass + ":" + (r.minBid || 0))
    }

    window.AesSlotScraper = {fetchAndStore, parseHtml, record}
})()
