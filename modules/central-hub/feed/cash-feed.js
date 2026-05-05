"use strict"

/**
 * HubFeed slice: `hub:cash:weekly` — newest accounting snapshot reduced to
 * the cash/net rollup the hero strip's "Cash" card displays.
 *
 * Inputs (legacy storage keys):
 *   {server}{airline}accounting:index             — array of {weekId, weekClosesAt, ...}
 *   {server}{airline}accounting:bank:{week}       — {payload: {cashBalance, ...}}
 *   {server}{airline}accounting:income:{week}     — {payload: {totals: {ebt, ebit}}}
 *
 * Output shape:
 *   {
 *     value:       number | null,    // cash balance (preferred) or weekly net (fallback)
 *     label:       string,           // "cash · 2026-W17" / "weekly net · 2026-W17"
 *     kind:        "ok" | "alert" | "muted",
 *     server:      string,
 *     airline:     string,
 *     weekId:      string,
 *     hasSnapshot: boolean
 *   }
 *
 * The feed/index.js bridge translates `accounting:` storage writes into the
 * `data:accounting:weekly:saved` bus topic so this slice recomputes without
 * each consumer attaching its own chrome.storage.onChanged listener.
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof window.HubFeed === "undefined") return
    if (window.__aesCashFeedDeclared) return
    window.__aesCashFeedDeclared = true

    HubFeed.declare({
        name:       "hub:cash:weekly",
        deps:       [
            "data:accounting:weekly:saved",
            "data:account:bootstrapped"
        ],
        ttlMs:      30 * 60 * 1000,
        debounceMs: 100,
        getScrapedAt: (v) => v && Number.isFinite(v.scrapedAt) ? v.scrapedAt : null,
        compute:    async () => {
            const ctx = await pickContextAwait()
            if (!ctx.server || !ctx.airline) {
                return {value: null, label: "no airline", kind: "muted",
                        server: ctx.server, airline: ctx.airline, weekId: "", hasSnapshot: false}
            }
            const indexKey = ctx.server + ctx.airline + "accounting:index"
            const blob  = await storageGet([indexKey])
            const index = Array.isArray(blob[indexKey]) ? blob[indexKey] : []
            if (!index.length) {
                return {value: null, label: "no snapshots", kind: "muted",
                        server: ctx.server, airline: ctx.airline, weekId: "", hasSnapshot: false}
            }
            const newest = index[0]
            const week   = newest.weekId || newest.weekClosesAt || ""
            const keys   = ["bank", "income"].map((t) =>
                ctx.server + ctx.airline + "accounting:" + t + ":" + week)
            const recs   = await storageGet(keys)
            const bankRec   = recs[keys[0]]
            const incomeRec = recs[keys[1]]
            const bank   = bankRec && bankRec.payload
            const income = incomeRec && incomeRec.payload
            const newestScrapedAt = Math.max(
                Number(bankRec && bankRec.scrapedAt) || 0,
                Number(incomeRec && incomeRec.scrapedAt) || 0
            ) || null

            if (bank && Number.isFinite(bank.cashBalance)) {
                return {
                    value:       bank.cashBalance,
                    label:       "cash · " + week,
                    kind:        bank.cashBalance >= 0 ? "ok" : "alert",
                    server:      ctx.server,
                    airline:     ctx.airline,
                    weekId:      week,
                    scrapedAt:   newestScrapedAt,
                    hasSnapshot: true
                }
            }
            if (income && income.totals) {
                const net = (income.totals.ebt && income.totals.ebt.current)
                    ?? (income.totals.ebit && income.totals.ebit.current)
                if (Number.isFinite(net)) {
                    return {
                        value:       net,
                        label:       "weekly net · " + week,
                        kind:        net >= 0 ? "ok" : "alert",
                        server:      ctx.server,
                        airline:     ctx.airline,
                        weekId:      week,
                        scrapedAt:   newestScrapedAt,
                        hasSnapshot: true
                    }
                }
            }
            return {value: null, label: "open /finance/accounting", kind: "muted",
                    server: ctx.server, airline: ctx.airline, weekId: week,
                    scrapedAt: newestScrapedAt, hasSnapshot: false}
        }
    })

    async function storageGet(keys) {
        try {
            if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return {}
            return await chrome.storage.local.get(keys)
        } catch (e) {
            const msg = e && e.message ? e.message : String(e || "")
            if (/Extension context invalidated/i.test(msg)) {
                try { window.AESSiteSkin?.handleInvalidatedContext?.(e) } catch (_) {}
                return {}
            }
            throw e
        }
    }

    async function pickContextAwait() {
        // Eager compute fires at content-script-load, often before the AS
        // top-nav has painted. Poll briefly so the slice lands a real
        // {server, airline} on first compute instead of latching the
        // muted "no airline" value the dashboard then shows for the rest
        // of the page lifetime.
        const startedAt = Date.now()
        const MAX_WAIT_MS = 1500
        const POLL_MS = 100
        for (;;) {
            const ctx = pickContext()
            if (ctx.server && ctx.airline) return ctx
            if (Date.now() - startedAt >= MAX_WAIT_MS) return ctx
            await new Promise((r) => setTimeout(r, POLL_MS))
        }
    }

    function pickContext() {
        let server = "", airline = ""
        try {
            if (typeof AES !== "undefined") {
                if (AES.getServer)            server  = AES.getServer() || ""
                if (AES.getAirlineIdentity)   airline = AES.getAirlineIdentity() || ""
            }
        } catch (_) { /* fall back to empty strings */ }
        return {server: server, airline: airline}
    }
})()
