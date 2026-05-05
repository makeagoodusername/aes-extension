"use strict"

/**
 * AesConductorSignalLayer — derives typed signals from existing storage
 * writes and dispatches them to AesConductorSignalStore + CentralHubBus.
 *
 * Conductor Slice K1 — no scenario engine yet, no routine state machines,
 * no learning. Just: watch chrome.storage.onChanged across well-known
 * prefixes (and accept direct emits from in-page modules like the auto-
 * driver), normalise each change into a typed signal, ring-buffer it, and
 * broadcast on `conductor:signal`. K2 (scenario engine) will subscribe.
 *
 * Extractors:
 *   - aircraftFlightPlan:maintenance:<server>:<id>          → maintenance.ratio.changed
 *                                                              maintenance.condition.changed
 *   - aircraftFlightPlan:schedule:<server>:<id>             → schedule.scraped
 *   - scrapeOrchestrator:phase:<server>:<airline>:<phaseId> → scrape.phase.completed
 *   - markets:competitors:<route>                           → competitor.changed
 *   - <server><airline>accounting:bank:<weekId>             → cash.balance.changed
 *   - routeAssistant:ors:[acct:<id>:]<HUB>-<DEST>           → ors.rank.changed
 *   - routeAssistant:topRoutes:<HUB>                        → route.profit.changed (per-route diff)
 *   - direct emit from auto-driver                          → auto-drive.ticked
 *
 * All "*.changed" payloads carry `direction` + `delta` so K2 patterns can
 * filter without re-deriving. Self-installs on script load.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorSignalLayer) return

    let _counter = 0
    function _signalId(firedAt) { return String(firedAt) + "-" + (++_counter) }

    function _resolveHost() {
        let server = ""
        let airline = ""
        try { if (typeof AES !== "undefined") server = AES.getServerName() || "" } catch (_) {}
        try {
            if (typeof AES !== "undefined") {
                const code = AES.getAirlineCode()
                airline = (code && code.code) || ""
                if (!airline) airline = AES.getAirlineIdentity() || ""
            }
        } catch (_) {}
        return server ? {server, airline} : null
    }

    async function emit(spec) {
        if (!spec || !spec.type) return null
        const host = _resolveHost()
        if (!host) return null
        const firedAt = Date.now()
        const signal = {
            id:      _signalId(firedAt),
            type:    String(spec.type),
            server:  host.server,
            airline: host.airline,
            payload: spec.payload || {},
            firedAt: firedAt
        }
        try { await window.AesConductorSignalStore.append(host, signal) } catch (_) { /* noop */ }
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("conductor:signal", signal)
            }
        } catch (_) { /* noop */ }
        return signal
    }

    function _num(v) { return (typeof v === "number" && isFinite(v)) ? v : null }
    function _direction(from, to) {
        if (from == null || to == null) return "step"
        if (to < from) return "drop"
        if (to > from) return "rise"
        return "flat"
    }

    function _onMaintenanceChange(key, change) {
        const oldV = change && change.oldValue
        const newV = change && change.newValue
        if (!newV || typeof newV !== "object") return
        const tail = String(key.split(":").pop() || "")
        const oRatio = _num(oldV && oldV.ratio)
        const nRatio = _num(newV.ratio)
        if (oRatio !== nRatio) {
            emit({
                type:    "maintenance.ratio.changed",
                payload: {
                    aircraftId: tail,
                    from:       oRatio,
                    to:         nRatio,
                    delta:      (oRatio != null && nRatio != null) ? +(nRatio - oRatio).toFixed(3) : null,
                    direction:  _direction(oRatio, nRatio),
                    statusFrom: (oldV && oldV.ratioStatus) || null,
                    statusTo:   newV.ratioStatus || null
                }
            }).catch(() => {})
        }
        const oCond = _num(oldV && oldV.condition)
        const nCond = _num(newV.condition)
        if (oCond !== nCond) {
            emit({
                type:    "maintenance.condition.changed",
                payload: {
                    aircraftId: tail,
                    from:       oCond,
                    to:         nCond,
                    delta:      (oCond != null && nCond != null) ? +(nCond - oCond).toFixed(3) : null,
                    direction:  _direction(oCond, nCond),
                    statusFrom: (oldV && oldV.conditionStatus) || null,
                    statusTo:   newV.conditionStatus || null
                }
            }).catch(() => {})
        }
    }

    function _onScheduleChange(key, change) {
        const newV = change && change.newValue
        if (!newV || typeof newV !== "object") return
        const tail = String(key.split(":").pop() || "")
        const summary = newV.summary || {}
        emit({
            type:    "schedule.scraped",
            payload: {
                aircraftId:         tail,
                weeklyBlockMinutes: _num(summary.weeklyBlockMinutes),
                flightCount:        _num(summary.flightCount),
                scrapedAt:          _num(newV.scrapedAt)
            }
        }).catch(() => {})
    }

    function _onPhaseChange(key, change) {
        const newV = change && change.newValue
        if (!newV || typeof newV !== "object") return
        emit({
            type:    "scrape.phase.completed",
            payload: {
                phaseId:     newV.phaseId || String(key.split(":").pop() || ""),
                succeeded:   _num(newV.succeeded) || 0,
                total:       _num(newV.total)     || 0,
                failed:      _num(newV.failed)    || 0,
                completedAt: _num(newV.completedAt)
            }
        }).catch(() => {})
    }

    function _aggPrice(arr) {
        let min = Infinity, max = -Infinity
        for (const c of arr) {
            const pmin = _num(c && c.priceMin)
            const pmax = _num(c && c.priceMax)
            if (pmin != null && pmin < min) min = pmin
            if (pmax != null && pmax > max) max = pmax
        }
        return {
            priceMin: isFinite(min) ? min : null,
            priceMax: isFinite(max) ? max : null
        }
    }

    function _onCompetitorChange(key, change) {
        const oldV = change && change.oldValue
        const newV = change && change.newValue
        if (!newV) return
        const oldArr = Array.isArray(oldV && oldV.competitors) ? oldV.competitors : (Array.isArray(oldV) ? oldV : [])
        const newArr = Array.isArray(newV.competitors) ? newV.competitors : (Array.isArray(newV) ? newV : [])
        const before = oldArr.length
        const after  = newArr.length
        const routeKey = key.replace(/^markets:competitors:/, "")

        if (before !== after) {
            const delta = after - before
            emit({
                type:    "competitor.changed",
                payload: {
                    routeKey, before, after, delta,
                    direction: delta > 0 ? "entry" : "exit"
                }
            }).catch(() => {})
            return
        }

        // F-9227-007: count unchanged but aggregate price may have moved.
        // Surface price-only events so CompetitorEntry/Exit scenarios and
        // competitor-response classifier can react to a price war that
        // didn't add/remove operators.
        const oldP = _aggPrice(oldArr)
        const newP = _aggPrice(newArr)
        const minMoved = (oldP.priceMin !== newP.priceMin)
        const maxMoved = (oldP.priceMax !== newP.priceMax)
        if (!minMoved && !maxMoved) return
        const minDelta = (newP.priceMin != null && oldP.priceMin != null)
            ? newP.priceMin - oldP.priceMin : null
        let direction = "flat"
        if (minDelta != null) {
            direction = minDelta < 0 ? "priceCut" : (minDelta > 0 ? "priceHike" : "flat")
        } else if (oldP.priceMin == null && newP.priceMin != null) {
            direction = "step"
        }
        emit({
            type:    "competitor.changed",
            payload: {
                routeKey, before, after, delta: 0,
                priceMinFrom: oldP.priceMin, priceMinTo: newP.priceMin,
                priceMaxFrom: oldP.priceMax, priceMaxTo: newP.priceMax,
                priceDelta:   minDelta,
                direction:    direction
            }
        }).catch(() => {})
    }

    /** F-9227-001: AccountingSnapshotStore.saveTab wraps each scrape as
     *  \`{weekId, type, scrapedAt, payload}\` — the BANK tab's payload carries
     *  \`cashBalance\` (the headline navbar balance, see bank-scraper.js).
     *  Original code read newValue.balance/cash off the top level, which is
     *  the legacy hand-seed shape; both paths are kept for back-compat. */
    function _extractCashBalance(v) {
        if (!v || typeof v !== "object") return null
        if (v.payload && v.payload.cashBalance != null) return _num(v.payload.cashBalance)
        if (v.balance != null) return _num(v.balance)
        if (v.cash != null) return _num(v.cash)
        return null
    }

    function _onBankCashChange(key, change) {
        const oldBal = _extractCashBalance(change && change.oldValue)
        const newBal = _extractCashBalance(change && change.newValue)
        if (oldBal === newBal) return
        if (newBal == null) return
        const delta = oldBal != null ? newBal - oldBal : null
        emit({
            type:    "cash.balance.changed",
            payload: {
                from: oldBal, to: newBal, delta,
                direction: _direction(oldBal, newBal)
            }
        }).catch(() => {})
    }

    function _onOrsChange(key, change) {
        const oldV = change && change.oldValue
        const newV = change && change.newValue
        if (!newV || typeof newV !== "object") return
        const oldClasses = (oldV && oldV.byClass) || {}
        const newClasses = newV.byClass || {}
        const hub  = String(newV.hub  || "").toUpperCase()
        const dest = String(newV.dest || "").toUpperCase()
        if (!hub || !dest) return
        const out = []
        for (const cls in newClasses) {
            const o = oldClasses[cls]
            const n = newClasses[cls]
            if (!n || typeof n !== "object") continue
            const fr = _num(o && o.rankAny)
            const to = _num(n.rankAny)
            if (fr === to) continue
            out.push({
                payload:    cls,
                rankFrom:   fr,
                rankTo:     to,
                rankDelta:  (fr != null && to != null) ? to - fr : null,
                direction:  fr == null ? "step" : (to < fr ? "improved" : (to > fr ? "worsened" : "flat"))
            })
        }
        if (!out.length) return
        let overall = "flat"
        let worst = 0
        for (const c of out) {
            if (c.direction === "worsened" && c.rankDelta != null && c.rankDelta > worst) worst = c.rankDelta
            if (overall === "flat") overall = c.direction
            else if (c.direction !== overall && c.direction !== "flat") overall = "mixed"
        }
        emit({
            type:    "ors.rank.changed",
            payload: {hub, dest, classes: out, direction: overall, worstRegression: worst || null}
        }).catch(() => {})
    }

    const ROUTE_PROFIT_DELTA_MIN = 5000          // $/wk noise floor
    const ROUTE_PROFIT_PCT_MIN   = 0.25          // OR 25% of base

    function _onTopRoutesChange(key, change) {
        const oldV = change && change.oldValue
        const newV = change && change.newValue
        if (!newV || typeof newV !== "object") return
        const oldRows = Array.isArray(oldV && oldV.rows) ? oldV.rows : []
        const newRows = Array.isArray(newV.rows) ? newV.rows : []
        if (!newRows.length) return
        const hub = String(newV.hub || key.replace(/^routeAssistant:topRoutes:/, "") || "").toUpperCase()
        const oldByDest = new Map()
        for (const r of oldRows) if (r && r.destIata) oldByDest.set(r.destIata, r)
        for (const n of newRows) {
            if (!n || !n.destIata) continue
            const o = oldByDest.get(n.destIata)
            if (!o) continue                              // newly visible — not a profit move
            const oP = _num(o.profitPerWeek)
            const nP = _num(n.profitPerWeek)
            if (oP == null || nP == null) continue
            const delta = nP - oP
            const base  = Math.max(Math.abs(oP), 1)
            if (Math.abs(delta) < ROUTE_PROFIT_DELTA_MIN && Math.abs(delta) / base < ROUTE_PROFIT_PCT_MIN) continue
            emit({
                type:    "route.profit.changed",
                payload: {
                    hub,
                    dest:       String(n.destIata).toUpperCase(),
                    from:       oP,
                    to:         nP,
                    delta:      Math.round(delta),
                    pct:        +(delta / base).toFixed(3),
                    direction:  delta < 0 ? "drop" : "recovery"
                }
            }).catch(() => {})
        }
    }

    function _route(key, change) {
        if (key.indexOf("aircraftFlightPlan:maintenance:") === 0) return _onMaintenanceChange(key, change)
        if (key.indexOf("aircraftFlightPlan:schedule:") === 0)    return _onScheduleChange(key, change)
        if (key.indexOf("scrapeOrchestrator:phase:") === 0)        return _onPhaseChange(key, change)
        if (key.indexOf("markets:competitors:") === 0)             return _onCompetitorChange(key, change)
        if (key.indexOf("accounting:bank:") !== -1)                 return _onBankCashChange(key, change)
        if (key.indexOf("routeAssistant:ors:") === 0 && key.indexOf("-") !== -1) return _onOrsChange(key, change)
        if (/^routeAssistant:topRoutes:[A-Z]{3,4}$/.test(key))     return _onTopRoutesChange(key, change)
    }

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local" || !changes) return
            for (const k in changes) {
                try { _route(k, changes[k]) } catch (e) { console.warn("[AES Conductor] extractor threw", k, e) }
            }
        })
    }

    window.AesConductorSignalLayer = {emit}
})()
