"use strict"

/**
 * Canonical view: `scanner:current-deals`
 *
 * Composes the newest market-scan session + its decorated per-type results
 * into a single "best deal right now" shape, replacing the per-tile re-walks
 * in:
 *   - modules/central-hub/tiles/used-aircraft-scanner-tile.js
 *   - modules/central-hub/tiles/aircraft-profitability-tile.js (future)
 *
 * Output shape:
 *   {
 *     scanId, server, presetName,
 *     status:      "running" | "done" | "error" | "idle",
 *     startedAt, finishedAt,
 *     bestDeal:    {type, family, familyCategory, acquisitionPrice,
 *                   leaseRate, seatKmYearCost, breakEvenDays,
 *                   synergy: {owned, count}, scrapedAt} | null,
 *     dealsCount:  number,
 *     scrapedAt:   number | null
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AesView || !window.AesDataBus) return
    if (window.__aesViewScannerCurrentDealsDeclared) return
    window.__aesViewScannerCurrentDealsDeclared = true

    AesView.declare({
        name:       "scanner:current-deals",
        deps:       [
            "data:scanner:price-history:appended",
            "data:scanner:scan:saved",
            "data:account:bootstrapped"
        ],
        debounceMs: 150,
        compute:    async () => {
            const server = pickServer()
            if (!server) return inert()
            if (typeof window.MarketScanSession === "undefined") return inert()

            const session = await findNewestSession(server)
            if (!session) return inert()

            let results = {}
            try { results = await window.MarketScanSession.loadResults(server, session.scanId) }
            catch (_) { results = {} }

            const rows = collectRows(results)
            const best = pickBestDeal(rows)
            const newestRowAt = rows.reduce((m, r) =>
                Math.max(m, Number(r.scrapedAt) || 0), 0) || null

            return {
                scanId:      session.scanId,
                server:      server,
                presetName:  session.presetName || "",
                status:      session.status || "idle",
                startedAt:   Number(session.startedAt)  || null,
                finishedAt:  Number(session.finishedAt) || null,
                bestDeal:    best,
                dealsCount:  rows.length,
                scrapedAt:   Number(session.finishedAt) || newestRowAt
            }
        }
    })

    function inert() {
        return {
            scanId: null, server: null, presetName: "", status: "idle",
            startedAt: null, finishedAt: null,
            bestDeal: null, dealsCount: 0, scrapedAt: null
        }
    }

    async function findNewestSession(server) {
        try {
            const all = await chrome.storage.local.get(null)
            const prefix = server + "marketScan:"
            let newest = null
            for (const k in all) {
                if (k.indexOf(prefix) !== 0) continue
                if (k.indexOf(":r:") >= 0) continue   // skip per-type result blobs
                const rec = all[k]
                if (!rec || !rec.scanId) continue
                if (!newest || (Number(rec.startedAt) || 0) > (Number(newest.startedAt) || 0)) {
                    newest = rec
                }
            }
            return newest
        } catch (_) { return null }
    }

    function collectRows(results) {
        const out = []
        if (!results || typeof results !== "object") return out
        for (const t in results) {
            const blob = results[t]
            if (!blob || !Array.isArray(blob.rows)) continue
            for (const r of blob.rows) {
                if (!r) continue
                out.push(Object.assign({type: blob.type, scrapedAt: blob.scrapedAt}, r))
            }
        }
        return out
    }

    function pickBestDeal(rows) {
        if (!rows.length) return null
        // Best = lowest non-null seatKmYearCost; fall back to lowest breakEvenDays;
        // fall back to lowest acquisitionPrice.
        const score = (r) => {
            if (Number.isFinite(r.seatKmYearCost)) return [0, r.seatKmYearCost]
            if (Number.isFinite(r.breakEvenDays))  return [1, r.breakEvenDays]
            if (Number.isFinite(r.acquisitionPrice)) return [2, r.acquisitionPrice]
            return [3, Infinity]
        }
        let best = null, bestScore = null
        for (const r of rows) {
            const s = score(r)
            if (!bestScore || s[0] < bestScore[0] || (s[0] === bestScore[0] && s[1] < bestScore[1])) {
                best = r; bestScore = s
            }
        }
        if (!best) return null
        return {
            type:             best.type             || null,
            family:           best.family           || null,
            familyCategory:   best.familyCategory   || null,
            acquisitionPrice: Number.isFinite(best.acquisitionPrice) ? best.acquisitionPrice : null,
            leaseRate:        Number.isFinite(best.leaseRate)        ? best.leaseRate        : null,
            seatKmYearCost:   Number.isFinite(best.seatKmYearCost)   ? best.seatKmYearCost   : null,
            breakEvenDays:    Number.isFinite(best.breakEvenDays)    ? best.breakEvenDays    : null,
            synergy:          best.synergy || null,
            scrapedAt:        Number.isFinite(best.scrapedAt) ? best.scrapedAt : null
        }
    }

    function pickServer() {
        try {
            if (typeof AES !== "undefined" && AES.getServer) return AES.getServer() || ""
        } catch (_) {}
        return ""
    }
})()
