"use strict"

/**
 * Canonical view: `enterprise:financial-rollup`
 *
 * Multi-week trend + runway extension to the single-week `hub:cash:weekly`.
 * Reads the accounting index + last 6 bank/income blobs and derives runway
 * (weeks of cash at the current burn rate) and a coarse burnTrend slope.
 *
 * Replaces the manual index walks in:
 *   - modules/central-hub/tiles/accounting-tile.js
 *   - modules/central-hub/tiles/strategy-briefing-tile.js (cash-low salience)
 *   - modules/central-hub/tiles/weekly-review-tile.js (cash-low domain)
 *
 * `hub:cash:weekly` keeps its single-week role (hero strip uses it); this view
 * adds the multi-week shape.
 *
 * Output shape:
 *   {
 *     weekId,
 *     netCash:     number | null,
 *     weeklyNet:   number | null,
 *     trend:       [{weekId, netCash, weeklyNet}],   // last 6 weeks newest-first
 *     runwayWeeks: number | null,                    // null when surplus
 *     burnTrend:   "improving" | "stable" | "worsening" | null,
 *     scrapedAt:   number | null
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AesView || !window.AesDataBus) return
    if (window.__aesViewEnterpriseFinancialRollupDeclared) return
    window.__aesViewEnterpriseFinancialRollupDeclared = true

    const TREND_DEPTH = 6  // weeks to load; runway uses min(3, available)

    AesView.declare({
        name:       "enterprise:financial-rollup",
        deps:       [
            "data:accounting:weekly:saved",
            "data:account:bootstrapped"
        ],
        debounceMs: 120,
        compute:    async () => {
            const ctx = pickCtx()
            if (!ctx.server || !ctx.airline) return inert()
            const indexKey = ctx.server + ctx.airline + "accounting:index"
            const blob = await safeGet([indexKey])
            const index = Array.isArray(blob[indexKey]) ? blob[indexKey] : []
            if (!index.length) return inert()

            const weeks = index.slice(0, TREND_DEPTH)
            const keys  = []
            for (const w of weeks) {
                const week = w.weekId || w.weekClosesAt
                if (!week) continue
                keys.push(ctx.server + ctx.airline + "accounting:bank:"   + week)
                keys.push(ctx.server + ctx.airline + "accounting:income:" + week)
            }
            const recs = await safeGet(keys)

            const trend = []
            let scrapedAt = 0
            for (const w of weeks) {
                const week = w.weekId || w.weekClosesAt
                if (!week) continue
                const bankRec   = recs[ctx.server + ctx.airline + "accounting:bank:"   + week]
                const incomeRec = recs[ctx.server + ctx.airline + "accounting:income:" + week]
                const bank   = bankRec   && bankRec.payload
                const income = incomeRec && incomeRec.payload
                const netCash = bank && Number.isFinite(bank.cashBalance) ? Number(bank.cashBalance) : null
                let weeklyNet = null
                if (income && income.totals) {
                    const ebt  = income.totals.ebt  && income.totals.ebt.current
                    const ebit = income.totals.ebit && income.totals.ebit.current
                    if (Number.isFinite(ebt)) weeklyNet = Number(ebt)
                    else if (Number.isFinite(ebit)) weeklyNet = Number(ebit)
                }
                trend.push({weekId: week, netCash: netCash, weeklyNet: weeklyNet})
                const candAt = Math.max(
                    Number(bankRec   && bankRec.scrapedAt)   || 0,
                    Number(incomeRec && incomeRec.scrapedAt) || 0
                )
                if (candAt > scrapedAt) scrapedAt = candAt
            }

            const head = trend[0] || {}
            const runway = computeRunway(head.netCash, trend)
            return {
                weekId:      head.weekId      || null,
                netCash:     head.netCash     != null ? head.netCash   : null,
                weeklyNet:   head.weeklyNet   != null ? head.weeklyNet : null,
                trend:       trend,
                runwayWeeks: runway,
                burnTrend:   computeBurnTrend(trend),
                scrapedAt:   scrapedAt || null
            }
        }
    })

    function computeRunway(netCash, trend) {
        if (!Number.isFinite(netCash) || netCash <= 0) return null
        const recent = trend.slice(0, 3).map(w => w.weeklyNet).filter(v => Number.isFinite(v))
        if (!recent.length) return null
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length
        if (avg >= 0) return null   // not burning
        const burn = Math.abs(avg)
        return Math.floor(netCash / burn)
    }

    function computeBurnTrend(trend) {
        const series = trend.map(w => w.weeklyNet).filter(v => Number.isFinite(v))
        if (series.length < 4) return null
        const recent = series.slice(0, 3)
        const prior  = series.slice(3, 6)
        if (!prior.length) return null
        const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length
        const avgPrior  = prior.reduce((a, b)  => a + b, 0) / prior.length
        const delta     = avgRecent - avgPrior
        const scale     = Math.max(1, Math.abs(avgPrior))
        if (Math.abs(delta) / scale < 0.05) return "stable"
        return delta > 0 ? "improving" : "worsening"
    }

    function inert() {
        return {
            weekId: null, netCash: null, weeklyNet: null,
            trend: [], runwayWeeks: null, burnTrend: null, scrapedAt: null
        }
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
})()
