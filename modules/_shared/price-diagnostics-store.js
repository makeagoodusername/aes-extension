"use strict"

/**
 * Price-automation diagnostics and route pricing context.
 *
 * Diagnostics are stored in one chrome.storage.local key:
 *   aesPrice:diagnostics
 *
 * Each route record keeps the latest skip / proposal / apply state so Route
 * Assistant, Route Management, and Aircraft Flights can explain the same
 * pricing decision chain without each page re-implementing storage walking.
 *
 * Public API (window.AesPriceDiagnostics):
 *   recordSkip({hub, dest, reason})
 *   recordProposal({hub, dest, reason?, prices?, context?})
 *   recordApply({hub, dest, ok, logId?, status?, prices?})
 *   recordContext({hub, dest, context})
 *   getAll()
 *   getRoute(hub, dest)
 *   getContext(hub, dest)
 *   buildRouteContext(hub, dest)
 *   clear()
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesPriceDiagnostics) return

    const KEY        = "aesPrice:diagnostics"
    const MAX_ROUTES = 500
    const CLASSES    = ["Y", "C", "F", "Cargo"]

    const PREFIX = {
        ownPricing:  "routeAssistant:markets:ownPricing",
        competitors: "routeAssistant:markets:competitors",
        historic:    "routeAssistant:markets:historic",
        ticketPrice: "routeAssistant:ticketPrice",
        ors:         "routeAssistant:ors",
        yieldHist:   "routeAssistant:yieldHistory"
    }

    const PAYLOAD_BY_CLASS = {
        Y: "ECONOMY",
        C: "BUSINESS",
        F: "FIRST",
        Cargo: "CARGO"
    }

    function _now() { return Date.now() }

    function _u(v) {
        return String(v || "").trim().toUpperCase()
    }

    function _pair(hub, dest) {
        return _u(hub) + "-" + _u(dest)
    }

    function _num(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    function _round(v, digits) {
        const n = _num(v)
        if (n == null) return null
        const d = isFinite(digits) ? Math.max(0, Number(digits)) : 0
        const m = Math.pow(10, d)
        return Math.round(n * m) / m
    }

    function _accountId() {
        try {
            if (typeof currentAccountIdSync === "function") return currentAccountIdSync()
        } catch (_) {}
        try {
            if (window.AesAccountKey && typeof window.AesAccountKey.currentAccountIdSync === "function") {
                return window.AesAccountKey.currentAccountIdSync()
            }
        } catch (_) {}
        return window.__aesAccountId || null
    }

    async function _load() {
        try {
            const out = await chrome.storage.local.get([KEY])
            const m = out[KEY]
            return (m && typeof m === "object") ? m : {}
        } catch (_) { return {} }
    }

    async function _save(map) {
        try { await chrome.storage.local.set({[KEY]: map}) }
        catch (_) { /* best-effort */ }
    }

    function _touchedAt(record) {
        const r = record || {}
        return Math.max(
            Number(r.lastSkipAt)     || 0,
            Number(r.lastProposedAt) || 0,
            Number(r.lastAppliedAt)  || 0,
            Number(r.lastContextAt)  || 0
        )
    }

    function _evict(map) {
        const keys = Object.keys(map)
        if (keys.length <= MAX_ROUTES) return map
        keys.sort((a, b) => _touchedAt(map[a]) - _touchedAt(map[b]))
        for (const k of keys.slice(0, keys.length - MAX_ROUTES)) delete map[k]
        return map
    }

    function _compact(value, depth) {
        if (depth <= 0 || value == null) return value == null ? value : null
        if (typeof value !== "object") return value
        if (Array.isArray(value)) return value.slice(0, 12).map(v => _compact(v, depth - 1))
        const out = {}
        const keys = Object.keys(value).slice(0, 40)
        for (const k of keys) {
            if (typeof value[k] === "function") continue
            out[k] = _compact(value[k], depth - 1)
        }
        return out
    }

    function _mergeRoutePatch(map, info, patch) {
        if (!info || !info.hub || !info.dest) return false
        const k = _pair(info.hub, info.dest)
        const prev = map[k] || {}
        map[k] = Object.assign({}, prev, patch)
        return true
    }

    async function recordSkip(info) {
        const map = await _load()
        if (!_mergeRoutePatch(map, info, {
            lastSkipReason: String(info && info.reason || "unknown").slice(0, 240),
            lastSkipAt:     _now()
        })) return
        await _save(_evict(map))
    }

    async function recordProposal(info) {
        const map = await _load()
        const patch = {
            lastProposedReason: info && info.reason ? String(info.reason).slice(0, 240) : null,
            lastProposedAt:     _now()
        }
        if (info && info.prices) patch.lastProposedPrices = _compact(info.prices, 2)
        if (info && info.context) {
            patch.lastContext = _compact(info.context, 3)
            patch.lastContextAt = patch.lastProposedAt
        }
        if (!_mergeRoutePatch(map, info, patch)) return
        await _save(_evict(map))
    }

    async function recordApply(info) {
        const map = await _load()
        const patch = {
            lastAppliedAt: Date.now(),
            lastAppliedOk: !!(info && info.ok)
        }
        if (info && info.status) patch.lastApplyStatus = String(info.status).slice(0, 48)
        if (info && info.logId) patch.lastLogId = String(info.logId).slice(0, 64)
        if (info && info.prices) patch.lastAppliedPrices = _compact(info.prices, 2)
        if (info && info.context) {
            patch.lastContext = _compact(info.context, 3)
            patch.lastContextAt = patch.lastAppliedAt
        }
        if (patch.lastAppliedOk) {
            patch.lastSkipReason = null
            patch.lastSkipAt     = null
        }
        if (!_mergeRoutePatch(map, info, patch)) return
        await _save(_evict(map))
    }

    async function recordContext(info) {
        const map = await _load()
        const ts = _now()
        if (!_mergeRoutePatch(map, info, {
            lastContext: _compact(info && info.context || null, 3),
            lastContextAt: ts
        })) return
        await _save(_evict(map))
    }

    async function getAll() { return await _load() }

    async function getRoute(hub, dest) {
        const map = await _load()
        return map[_pair(hub, dest)] || null
    }

    function _readFamily(all, prefix, pairKey) {
        if (!all || !prefix || !pairKey) return null
        const acct = _accountId()
        const scoped = acct ? prefix + ":acct:" + acct + ":" + pairKey : null
        const legacy = prefix + ":" + pairKey
        if (scoped && all[scoped]) return all[scoped]
        if (all[legacy]) return all[legacy]

        const suffix = ":" + pairKey
        const scopedPrefix = acct ? prefix + ":acct:" + acct + ":" : null
        let best = null
        for (const k in all) {
            if (k.indexOf(prefix + ":") !== 0 || !k.endsWith(suffix)) continue
            if (k.indexOf(":acct:") !== -1) {
                if (scopedPrefix && k.indexOf(scopedPrefix) === 0) return all[k]
                continue
            }
            const rec = all[k]
            if (!best || ((rec && rec.scrapedAt) || 0) > ((best && best.scrapedAt) || 0)) best = rec
        }
        return best
    }

    function _readDemand(all, dest) {
        if (!all || !dest) return null
        const direct = all["routeAssistant:demand:" + _u(dest)]
        if (direct) return direct
        const suffix = ":" + _u(dest)
        let best = null
        for (const k in all) {
            if (k.indexOf("routeAssistant:demand:") !== 0 || !k.endsWith(suffix)) continue
            const rec = all[k]
            if (!best || ((rec && rec.scrapedAt) || 0) > ((best && best.scrapedAt) || 0)) best = rec
        }
        return best
    }

    function _prices(ownPricing) {
        if (!ownPricing) return null
        const src = ownPricing.prices && typeof ownPricing.prices === "object"
            ? ownPricing.prices : ownPricing
        const out = {}
        for (const cls of CLASSES) {
            const n = _num(src[cls])
            if (n != null) out[cls] = n
        }
        return Object.keys(out).length ? out : null
    }

    function _normaliseClass(raw) {
        const s = String(raw || "").trim().toUpperCase().replace(/\s+/g, " ")
        if (s === "Y" || s === "ECONOMY" || s === "ECONOMY CLASS") return "Y"
        if (s === "C" || s === "BUSINESS" || s === "BUSINESS CLASS") return "C"
        if (s === "F" || s === "FIRST" || s === "FIRST CLASS") return "F"
        if (/^(CARGO|FREIGHT|MAIL|FRACHT)$/.test(s)) return "Cargo"
        return null
    }

    function _competitorPrice(c, cls) {
        if (!c) return null
        const direct = _num(c.price != null ? c.price : c.fare)
        if (direct != null) return direct
        if (c.prices && cls) return _num(c.prices[cls])
        return _num(c.avgPrice != null ? c.avgPrice : c.currentPrice)
    }

    function _median(values, cls) {
        const vals = (values || []).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b)
        if (!vals.length) return null
        const mid = Math.floor(vals.length / 2)
        const raw = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
        return cls === "Cargo" ? _round(raw, raw < 10 ? 2 : 0) : Math.round(raw)
    }

    function _competitorStats(record) {
        const byClass = {Y: [], C: [], F: [], Cargo: []}
        for (const c of (record && record.competitors || [])) {
            if (!c || c.isOurs) continue
            const cls = c.isCargo === true
                ? "Cargo"
                : _normaliseClass(c.serviceClass || c.classKey || c.bookingClass
                    || c.cabin || c.className || c["class"])
            if (!cls) continue
            const price = _competitorPrice(c, cls)
            if (price != null && price > 0) byClass[cls].push(price)
        }
        const medians = {}
        const counts = {}
        for (const cls of CLASSES) {
            const m = _median(byClass[cls], cls)
            if (m != null) medians[cls] = m
            counts[cls] = byClass[cls].length
        }
        return {medians, counts, scrapedAt: record && record.scrapedAt || null}
    }

    function _normaliseOrsPricingIndex(idx) {
        if (!idx || typeof idx !== "object") return null
        const classes = idx.classes || idx.byClass || {}
        const prices = Object.assign({}, idx.competitorPricesByClass || {})
        const counts = Object.assign({}, idx.competitorCountsByClass || {})
        for (const cls of CLASSES) {
            const c = classes && classes[cls]
            if (!c) continue
            const p = _num(c.competitorMedianPrice != null ? c.competitorMedianPrice
                : (c.competitorMedian != null ? c.competitorMedian : c.bestCompetitorPrice))
            const n = _num(c.competitorCount != null ? c.competitorCount : c.competitorConnectionCount)
            if (prices[cls] == null && p != null && p > 0 && (cls !== "Cargo" || p < 10)) {
                prices[cls] = cls === "Cargo" ? _round(p, 2) : Math.round(p)
            }
            if (counts[cls] == null && n != null) counts[cls] = n
        }
        return Object.assign({}, idx, {
            classes,
            byClass: idx.byClass || classes,
            competitorPricesByClass: prices,
            competitorCountsByClass: counts
        })
    }

    function _orsPricingIndex(record) {
        if (!record) return null
        const embedded = _normaliseOrsPricingIndex(record.pricingIndex)
        if (embedded) return embedded
        try {
            if (typeof RouteAssistantOrsScraper !== "undefined"
                    && typeof RouteAssistantOrsScraper.buildPricingIndex === "function") {
                return _normaliseOrsPricingIndex(RouteAssistantOrsScraper.buildPricingIndex(record))
            }
        } catch (_) { /* optional */ }
        return null
    }

    function _mergeOrsCompetitors(competitors, orsIndex) {
        const out = {
            medians: Object.assign({}, competitors && competitors.medians || {}),
            counts: Object.assign({Y: 0, C: 0, F: 0, Cargo: 0}, competitors && competitors.counts || {}),
            scrapedAt: competitors && competitors.scrapedAt || null,
            marketMedians: Object.assign({}, competitors && competitors.medians || {}),
            marketCounts: Object.assign({}, competitors && competitors.counts || {}),
            orsMedians: Object.assign({}, orsIndex && orsIndex.competitorPricesByClass || {}),
            orsCounts: Object.assign({}, orsIndex && orsIndex.competitorCountsByClass || {})
        }
        for (const cls of CLASSES) {
            const p = _num(out.orsMedians[cls])
            const n = _num(out.orsCounts[cls])
            if (out.medians[cls] == null && p != null && p > 0 && (cls !== "Cargo" || p < 10)) {
                out.medians[cls] = cls === "Cargo" ? _round(p, 2) : Math.round(p)
            }
            if (n != null && n > Number(out.counts[cls] || 0)) out.counts[cls] = n
        }
        return out
    }

    function _historicSeries(record, cls) {
        if (!record) return null
        const payload = PAYLOAD_BY_CLASS[cls]
        const byPayload = record.byPayload && typeof record.byPayload === "object"
            ? record.byPayload : null
        if (byPayload && byPayload[payload]) return byPayload[payload]
        if (byPayload && cls === "Y" && byPayload.PAX) return byPayload.PAX
        if (cls === "Y" && Array.isArray(record.periods) && Array.isArray(record.prices)) {
            return record
        }
        return null
    }

    function _latestFinite(arr, beforeIdx) {
        if (!Array.isArray(arr)) return null
        const start = beforeIdx == null ? arr.length - 1 : Math.min(beforeIdx, arr.length - 1)
        for (let i = start; i >= 0; i--) {
            const n = _num(arr[i])
            if (n != null) return {value: n, index: i}
        }
        return null
    }

    function _avg(values) {
        const vals = (values || []).map(_num).filter(v => v != null)
        if (!vals.length) return null
        return vals.reduce((sum, v) => sum + v, 0) / vals.length
    }

    function _seriesStats(series, cls) {
        if (!series || !Array.isArray(series.prices)) return null
        const prices = series.prices
        const caps = Array.isArray(series.capacities) ? series.capacities : []
        const winPrices = prices.slice(Math.max(0, prices.length - 12))
        const winCaps = caps.slice(Math.max(0, caps.length - 12))
        const latestPrice = _latestFinite(prices)
        const prevPrice = latestPrice ? _latestFinite(prices, latestPrice.index - 1) : null
        const latestDemand = _latestFinite(caps)
        const prevDemand = latestDemand ? _latestFinite(caps, latestDemand.index - 1) : null
        const avgPrice = _avg(winPrices)
        const avgDemand = _avg(winCaps)
        const cleanAvgPrice = avgPrice != null && avgPrice > 0 ? avgPrice : null
        const cleanLastPrice = latestPrice && latestPrice.value > 0 ? latestPrice.value : null
        const priceTrendPct = latestPrice && prevPrice && prevPrice.value > 0
            ? ((latestPrice.value - prevPrice.value) / prevPrice.value) * 100
            : null
        const demandTrendPct = latestDemand && prevDemand && prevDemand.value > 0
            ? ((latestDemand.value - prevDemand.value) / prevDemand.value) * 100
            : null
        return {
            avgPrice: cls === "Cargo" ? _round(cleanAvgPrice, cleanAvgPrice != null && cleanAvgPrice < 10 ? 2 : 0) : _round(cleanAvgPrice, 0),
            lastPrice: cls === "Cargo" ? _round(cleanLastPrice, cleanLastPrice != null && cleanLastPrice < 10 ? 2 : 0) : _round(cleanLastPrice, 0),
            priceTrendPct: _round(priceTrendPct, 1),
            avgDemand: _round(avgDemand, 0),
            lastDemand: _round(latestDemand && latestDemand.value, 0),
            demandTrendPct: _round(demandTrendPct, 1),
            observations: Math.max(prices.length || 0, caps.length || 0),
            payload: PAYLOAD_BY_CLASS[cls]
        }
    }

    function _historyByClass(record) {
        const out = {}
        for (const cls of CLASSES) {
            const stats = _seriesStats(_historicSeries(record, cls), cls)
            if (stats) out[cls] = stats
        }
        return out
    }

    function _orsSummary(record) {
        if (!record) return null
        const byClass = record.byClass && typeof record.byClass === "object" ? record.byClass : null
        const primary = byClass && (byClass.ECONOMY || byClass.Y || byClass.BUSINESS || byClass.FIRST)
            || record
        if (!primary) return null
        return {
            rankAny:             _num(primary.rankAny != null ? primary.rankAny : record.rankAny),
            rankNonstop:         _num(primary.rankNonstop != null ? primary.rankNonstop : record.rankNonstop),
            rankBookable:        _num(primary.rankBookable != null ? primary.rankBookable : record.rankBookable),
            ourTopRating:        _num(primary.ourTopRating != null ? primary.ourTopRating : record.ourTopRating),
            topCompetitorRating: _num(primary.topCompetitorRating != null ? primary.topCompetitorRating : record.topCompetitorRating),
            ratingGapToTop:      _num(primary.ratingGapToTop != null ? primary.ratingGapToTop : record.ratingGapToTop),
            totalConnections:    _num(primary.totalConnections != null ? primary.totalConnections : record.totalConnections),
            scrapedAt:           _num(record.scrapedAt != null ? record.scrapedAt : primary.scrapedAt),
            classCount:          byClass ? Object.keys(byClass).filter(k => byClass[k]).length : 0
        }
    }

    function _yieldSummary(record) {
        if (!record || !Array.isArray(record.snapshots) || !record.snapshots.length) return null
        const snapshots = record.snapshots.slice()
            .filter(Boolean)
            .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
        const latest = snapshots[snapshots.length - 1]
        let previous = null
        for (let i = snapshots.length - 2; i >= 0; i--) {
            if (_num(snapshots[i].profitPerFlight) != null) { previous = snapshots[i]; break }
        }
        const last = _num(latest && latest.profitPerFlight)
        const prev = _num(previous && previous.profitPerFlight)
        const recent = snapshots.slice(Math.max(0, snapshots.length - 4))
            .map(s => _num(s.profitPerFlight)).filter(v => v != null)
        const avg = recent.length ? recent.reduce((sum, v) => sum + v, 0) / recent.length : null
        const trendPct = last != null && prev != null && Math.abs(prev) > 1
            ? ((last - prev) / Math.abs(prev)) * 100
            : null
        return {
            sampleCount: snapshots.length,
            lastSnapshotAt: latest && (latest.timestamp || record.lastSnapshotAt) || null,
            latestProfitPerFlight: _round(last, 0),
            avgProfitPerFlight: _round(avg, 0),
            latestProfitPerWeek: _round(latest && latest.profitPerWeek, 0),
            frequency: _round(latest && latest.frequency, 1),
            trendPct: _round(trendPct, 1),
            lossMaking: (last != null && last < 0) || (avg != null && avg < 0),
            profitable: (last != null && last > 0) || (avg != null && avg > 0),
            attributionMode: latest && (latest.attributionMode || latest.mode) || null
        }
    }

    function _scheduleSummary(record) {
        if (!record) return null
        return {
            weeklyFlights: _num(record.weeklyFlights),
            daysPerWeek: _num(record.daysPerWeek),
            departureTime: record.departureTime || null,
            primaryAircraftType: record.primaryAircraftType || null,
            primaryAircraftReg: record.primaryAircraftReg || null,
            flights: Array.isArray(record.flights) ? record.flights.slice(0, 12) : [],
            scrapedAt: record.scrapedAt || null
        }
    }

    function _demandSummary(record, historyByClass) {
        const out = {
            paxDemandPool: _num(record && record.paxDemandPool),
            cargoDemandPool: _num(record && record.cargoDemandPool),
            rmTightness: _num(record && record.rmTightness),
            paxElasticity: _num(record && record.paxElasticity),
            cargoElasticity: _num(record && record.cargoElasticity),
            demandPoolByClass: {},
            rmTightnessByClass: {},
            priceElasticityByClass: {},
            scrapedAt: record && record.scrapedAt || null
        }
        for (const cls of CLASSES) {
            const h = historyByClass && historyByClass[cls]
            const byPool = record && record.demandPoolByClass || {}
            const byRm = record && record.rmTightnessByClass || {}
            const byElasticity = record && record.priceElasticityByClass || {}
            const pool = _num(byPool[cls])
            const rm = _num(byRm[cls])
            const eps = _num(byElasticity[cls])
            if (pool != null || (h && h.avgDemand != null)) out.demandPoolByClass[cls] = pool != null ? pool : h.avgDemand
            if (rm != null) out.rmTightnessByClass[cls] = rm
            if (eps != null) out.priceElasticityByClass[cls] = eps
        }
        return out
    }

    function _classAdvice(cls, currentPrices, competitors, historyByClass, demand, ors) {
        const current = currentPrices && _num(currentPrices[cls])
        const comp = competitors && competitors.medians && _num(competitors.medians[cls])
        const hist = historyByClass && historyByClass[cls] || null
        const histAvg = hist && _num(hist.avgPrice)
        const classRm = demand && demand.rmTightnessByClass && _num(demand.rmTightnessByClass[cls])
        const rm = classRm != null ? classRm : (demand && _num(demand.rmTightness))
        let score = 0
        const reasons = []
        if (rm != null) {
            if (rm >= 0.85) { score += 1; reasons.push("tight load") }
            else if (rm < 0.50) { score -= 1; reasons.push("low load") }
        }
        let compDeltaPct = null
        if (current != null && current > 0 && comp != null) {
            compDeltaPct = ((comp - current) / current) * 100
            if (compDeltaPct >= 5) { score += 1; reasons.push("below competitor median") }
            else if (compDeltaPct <= -5) { score -= 1; reasons.push("above competitor median") }
        }
        let historyDeltaPct = null
        if (current != null && current > 0 && histAvg != null) {
            historyDeltaPct = ((histAvg - current) / current) * 100
            if (historyDeltaPct >= 8) { score += 0.5; reasons.push("below historic average") }
            else if (historyDeltaPct <= -8) { score -= 0.5; reasons.push("above historic average") }
        }
        if (cls !== "Cargo" && ors && ors.rankAny != null) {
            if (ors.rankAny >= 8 && score > 0) {
                score -= 0.75
                reasons.push("weak ORS position")
            } else if (ors.rankAny <= 3 && score < 0) {
                score += 0.5
                reasons.push("strong ORS position")
            }
        }
        return {
            current,
            competitorMedian: comp,
            competitorDeltaPct: _round(compDeltaPct, 1),
            historicalAvgPrice: histAvg,
            historicalLastPrice: hist && hist.lastPrice != null ? hist.lastPrice : null,
            historyDeltaPct: _round(historyDeltaPct, 1),
            rmTightness: rm,
            score: _round(score, 2),
            stance: score >= 1 ? "raise" : (score <= -1 ? "lower" : "hold"),
            reasons: reasons.slice(0, 4)
        }
    }

    function _signals(ctx) {
        const labels = []
        if (ctx.currentPrices) labels.push("current")
        if (Object.keys(ctx.historyByClass || {}).length || ctx.yieldHistory) labels.push("history")
        if (ctx.competitors && Object.keys(ctx.competitors.medians || {}).length) labels.push("competition")
        if (ctx.ors) labels.push("ORS")
        if (ctx.schedule && ctx.schedule.weeklyFlights) labels.push("schedule")
        if (ctx.diagnostics && (ctx.diagnostics.lastSkipReason
                || ctx.diagnostics.lastProposedAt || ctx.diagnostics.lastAppliedAt)) labels.push("activity")
        return {
            labels,
            current: labels.indexOf("current") >= 0,
            history: labels.indexOf("history") >= 0,
            competition: labels.indexOf("competition") >= 0,
            ors: labels.indexOf("ORS") >= 0,
            schedule: labels.indexOf("schedule") >= 0,
            activity: labels.indexOf("activity") >= 0
        }
    }

    function _buildRouteContextFromAll(all, hub, dest) {
        const h = _u(hub)
        const d = _u(dest)
        if (!h || !d) return null
        const pairKey = _pair(h, d)
        const diagnosticsMap = all[KEY] && typeof all[KEY] === "object" ? all[KEY] : {}
        const ownPricing = _readFamily(all, PREFIX.ownPricing, pairKey)
        const competitorRec = _readFamily(all, PREFIX.competitors, pairKey)
        const historicRec = _readFamily(all, PREFIX.historic, pairKey)
        const orsRec = _readFamily(all, PREFIX.ors, pairKey)
        const yieldRec = _readFamily(all, PREFIX.yieldHist, pairKey)
        const scheduleRec = _readFamily(all, PREFIX.ticketPrice, pairKey)
        const historyByClass = _historyByClass(historicRec)
        const orsPricingIndex = _orsPricingIndex(orsRec)
        const competitors = _mergeOrsCompetitors(_competitorStats(competitorRec), orsPricingIndex)
        const currentPrices = _prices(ownPricing)
        const demand = _demandSummary(_readDemand(all, d), historyByClass)
        const ctx = {
            hub: h,
            dest: d,
            pair: pairKey,
            builtAt: _now(),
            currentPrices,
            currentScrapedAt: ownPricing && ownPricing.scrapedAt || null,
            competitors,
            historyByClass,
            historicScrapedAt: historicRec && historicRec.scrapedAt || null,
            demand,
            ors: _orsSummary(orsRec),
            orsPricingIndex,
            yieldHistory: _yieldSummary(yieldRec),
            schedule: _scheduleSummary(scheduleRec),
            diagnostics: diagnosticsMap[pairKey] || null,
            adviceByClass: {}
        }
        for (const cls of CLASSES) {
            ctx.adviceByClass[cls] = _classAdvice(
                cls,
                currentPrices,
                competitors,
                historyByClass,
                demand,
                ctx.ors
            )
        }
        ctx.signals = _signals(ctx)
        return ctx
    }

    async function buildRouteContext(hub, dest) {
        let all = {}
        try { all = await chrome.storage.local.get(null) || {} }
        catch (_) { return null }
        return _buildRouteContextFromAll(all, hub, dest)
    }

    async function buildManyRouteContexts(routes) {
        const list = Array.isArray(routes) ? routes : []
        let all = {}
        try { all = await chrome.storage.local.get(null) || {} }
        catch (_) { return list.map(() => null) }
        return list.map(route => _buildRouteContextFromAll(
            all,
            route && (route.hub || route.origin),
            route && (route.dest || route.destination)
        ))
    }

    async function getContext(hub, dest) {
        return await buildRouteContext(hub, dest)
    }

    async function clear() {
        try { await chrome.storage.local.remove([KEY]) }
        catch (_) { /* best-effort */ }
    }

    window.AesPriceDiagnostics = {
        recordSkip,
        recordProposal,
        recordApply,
        recordContext,
        getAll,
        getRoute,
        getContext,
        buildRouteContext,
        buildManyRouteContexts,
        clear,
        KEY: KEY,
        MAX_ROUTES: MAX_ROUTES,
        CLASSES: CLASSES,
        _private: {
            _historyByClass,
            _competitorStats,
            _orsPricingIndex,
            _mergeOrsCompetitors,
            _orsSummary,
            _yieldSummary,
            _classAdvice,
            _buildRouteContextFromAll,
            _pair
        }
    }
})()
