"use strict"

/**
 * AES Strategy — Multi-Game-World Federation (Slice 18).
 *
 * Aggregates a per-world portfolio across every (server, airline) the
 * user has played. Each world's snapshot stays sandboxed — this module
 * never reads from one world to inform another. The output is a flat
 * list of WorldSummary records plus a single sentence recommending
 * where free cash should go next.
 *
 * Account discovery routes through `AesAccountRegistry.list()` (L1 —
 * the canonical canopy registry). Per-server snapshot composition uses
 * the existing `AesStrategy.snapshot({server, airlineCode, accountId})`.
 *
 * Public API:
 *   window.AesStrategyMultiWorldPortfolio = {build, listWorlds}
 *   window.AesStrategy.getPortfolio  ← registered on namespace
 *
 * Storage:
 *   aesStrategy:portfolio:multiWorld   ring-of-1, ~5 KB, 1 h TTL
 */
;(function () {
    if (window.AesStrategyMultiWorldPortfolio) return

    const STORAGE_KEY = "aesStrategy:portfolio:multiWorld"
    const TTL_MS      = 60 * 60 * 1000   // 1 h real-time

    /**
     * One row per server (server = AS game world). When the user owns
     * multiple airlines on the same server we pick the most-recently-seen
     * one to represent that world.
     */
    async function listWorlds() {
        if (!window.AesAccountRegistry || typeof window.AesAccountRegistry.list !== "function") return []
        const accounts = await window.AesAccountRegistry.list()
        const byServer = new Map()
        for (const a of accounts) {
            if (!a || !a.server) continue
            const existing = byServer.get(a.server)
            if (!existing || (a.lastSeenAt || 0) > (existing.lastSeenAt || 0)) {
                byServer.set(a.server, a)
            }
        }
        return Array.from(byServer.values())
            .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    }

    async function build(opts) {
        opts = opts || {}
        if (!opts.force) {
            const cached = await _loadCache()
            if (cached && (Date.now() - cached.builtAt) < TTL_MS) return cached
        }

        const heads = await listWorlds()
        if (!heads.length) {
            return _empty("No registered accounts yet — visit a world's dashboard so AES can register it.")
        }

        const worlds = []
        for (const head of heads) {
            const world = await _summarizeWorld(head)
            if (world) worlds.push(world)
        }

        if (!worlds.length) {
            return _empty("Account registry has worlds but no snapshots could be composed.")
        }

        const totals = _totals(worlds)
        const recommendation = _recommend(worlds, totals)

        const out = {
            worlds:         worlds,
            totals:         totals,
            recommendation: recommendation,
            builtAt:        Date.now()
        }
        await _saveCache(out)
        _emit("strategy:portfolio:rebuilt", {
            worldCount: worlds.length,
            totalProfit: totals.profitWeekly,
            builtAt: out.builtAt
        })
        return out
    }

    async function _summarizeWorld(account) {
        const ns = window.AesStrategy
        if (!ns || typeof ns.snapshot !== "function") return null
        let snap = null
        try {
            snap = await ns.snapshot({
                server:      account.server,
                airlineCode: account.airlineIdentity || null,
                accountId:   account.id
            })
        } catch (e) {
            console.warn("[AES portfolio] snapshot failed for", account.server, e)
        }

        const cash = (snap && snap.cash) || {}
        const fleet = (snap && Array.isArray(snap.fleet)) ? snap.fleet : []
        const profitWeekly = _num(cash.weeklyResult)
        const bankBalance  = _num(cash.bankBalance)
        const runwayWeeks  = _num(cash.runwayWeeks)
        const tailCount    = fleet.length
        const seatTotal    = _seatTotal(fleet)
        const growthScore  = _growth(profitWeekly, runwayWeeks, tailCount)

        return {
            server:           account.server,
            accountId:        account.id,
            airlineIdentity:  account.airlineIdentity || null,
            displayName:      account.displayName || account.airlineIdentity || account.server,
            lastSeenAt:       account.lastSeenAt || null,
            profitWeekly:     profitWeekly,
            bankBalance:      bankBalance,
            cashRunwayWeeks:  runwayWeeks,
            tailCount:        tailCount,
            seatTotal:        seatTotal,
            growthScore:      growthScore,
            allocationPriority: 0,        // filled in by _totals → _ranked
            snapshotAvailable: !!snap,
            missing:          (snap && snap.missing) || []
        }
    }

    function _totals(worlds) {
        let profit = 0, cash = 0, tails = 0
        for (const w of worlds) {
            if (isFinite(w.profitWeekly)) profit += w.profitWeekly
            if (isFinite(w.bankBalance))  cash   += w.bankBalance
            if (isFinite(w.tailCount))    tails  += w.tailCount
        }
        // Allocation priority: rank by growthScore * tailCount, normalized 0..1.
        const ranked = worlds
            .map(w => ({w, raw: (w.growthScore || 0) * Math.max(1, w.tailCount || 0)}))
            .sort((a, b) => b.raw - a.raw)
        const max = ranked[0] ? ranked[0].raw : 0
        for (let i = 0; i < ranked.length; i++) {
            ranked[i].w.allocationPriority = max > 0 ? +(ranked[i].raw / max).toFixed(3) : 0
        }
        return {
            worldCount:    worlds.length,
            profitWeekly:  profit,
            bankBalance:   cash,
            tailCount:     tails
        }
    }

    function _recommend(worlds, totals) {
        if (!worlds.length) return "No worlds to compare."
        const profitable = worlds.filter(w => w.profitWeekly > 0)
        const stretched  = worlds.filter(w => w.cashRunwayWeeks != null && w.cashRunwayWeeks < 4)

        if (stretched.length) {
            const w = stretched.sort((a, b) => a.cashRunwayWeeks - b.cashRunwayWeeks)[0]
            return "Inject cash into " + w.server
                + " — runway " + w.cashRunwayWeeks.toFixed(1) + "w; protect operations before expanding elsewhere."
        }
        if (!profitable.length) {
            const w = worlds.sort((a, b) => (b.growthScore || 0) - (a.growthScore || 0))[0]
            return "All worlds at a loss. Focus consolidation on " + w.server
                + " — best growth signal across the portfolio."
        }
        const top = profitable.sort((a, b) => b.allocationPriority - a.allocationPriority)[0]
        return "Direct free cash to " + top.server
            + " — leading allocation priority " + top.allocationPriority.toFixed(2)
            + " on profit " + _fmtMoney(top.profitWeekly) + "/wk."
    }

    function _empty(reason) {
        return {
            worlds:         [],
            totals:         {worldCount: 0, profitWeekly: 0, bankBalance: 0, tailCount: 0},
            recommendation: reason,
            builtAt:        Date.now()
        }
    }

    function _seatTotal(fleet) {
        let s = 0
        for (const a of fleet) {
            const seats = _num(a && a.seats)
            if (isFinite(seats) && seats > 0) s += seats
        }
        return s
    }

    function _growth(profit, runway, tails) {
        // Simple proxy: positive profit + adequate runway + reasonable scale.
        const profitTerm = profit > 0 ? Math.min(1, profit / 100000) : 0
        const runwayTerm = isFinite(runway)
            ? (runway >= 12 ? 1 : Math.max(0, runway / 12))
            : 0.5
        const scaleTerm = tails > 0 ? Math.min(1, Math.log10(tails + 1) / 2) : 0
        return +(0.5 * profitTerm + 0.3 * runwayTerm + 0.2 * scaleTerm).toFixed(3)
    }

    function _num(v) {
        const n = Number(v)
        return isFinite(n) ? n : 0
    }

    function _fmtMoney(v) {
        if (!isFinite(v)) return "—"
        const abs = Math.abs(v)
        if (abs >= 1e9) return (v < 0 ? "−$" : "$") + (abs / 1e9).toFixed(2) + "B"
        if (abs >= 1e6) return (v < 0 ? "−$" : "$") + (abs / 1e6).toFixed(1) + "M"
        if (abs >= 1e3) return (v < 0 ? "−$" : "$") + (abs / 1e3).toFixed(0) + "k"
        return (v < 0 ? "−$" : "$") + Math.round(abs)
    }

    async function _loadCache() {
        try {
            const got = await chrome.storage.local.get([STORAGE_KEY])
            return got[STORAGE_KEY] || null
        } catch (_) { return null }
    }

    async function _saveCache(record) {
        try { await chrome.storage.local.set({[STORAGE_KEY]: record}) }
        catch (_) {}
    }

    function _emit(name, payload) {
        try { if (window.AesDataBus && window.AesDataBus.emit) window.AesDataBus.emit(name, payload) } catch (_) {}
        try { if (window.CentralHubBus && window.CentralHubBus.emit) window.CentralHubBus.emit(name, payload) } catch (_) {}
    }

    window.AesStrategyMultiWorldPortfolio = {build, listWorlds}

    const ns = window.AesStrategy || (window.AesStrategy = {})
    ns.getPortfolio = build
})()
