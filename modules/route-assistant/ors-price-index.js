"use strict"

/**
 * RouteAssistantOrsPriceIndex
 *
 * Pure adapter from cached Online Reservation System scrape records to the
 * price signals used by silent-auto pricing. The scraper already stores every
 * ORS connection per payload class; this module indexes those connections by
 * cabin, separates own vs competitor itineraries, and exposes median/min/max
 * fare bands without re-fetching the live ORS page.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.RouteAssistantOrsPriceIndex) return

    const PRICE_CLASSES = ["Y", "C", "F", "Cargo"]
    const ORS_KEYS = {
        Y:     ["ECONOMY", "Y"],
        C:     ["BUSINESS", "C"],
        F:     ["FIRST", "F"],
        Cargo: ["CARGO", "Cargo"]
    }

    function _num(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    function _clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v))
    }

    function _roundPct(v) {
        return Math.round(v * 100) / 100
    }

    function _competitionWeight(competitorCount, opts) {
        const source = typeof window !== "undefined" && window.AesOrsCompetitionWeight
            ? window.AesOrsCompetitionWeight
            : null
        if (source && typeof source.weightFromCompetitorCount === "function") {
            return source.weightFromCompetitorCount(competitorCount, opts && opts.competitionWeight)
        }
        const n = Math.max(0, Math.floor(_num(competitorCount) || 0))
        if (n === 0) return 0.20
        if (n === 1) return 0.85
        if (n === 2) return 0.90
        if (n === 3) return 0.95
        return 1
    }

    function _pressurePct(classRec, competitorCount, opts) {
        if (!classRec) return null
        const rank = _num(classRec.rankAny)
        const our = _num(classRec.ourTopRating)
        const top = _num(classRec.topCompetitorRating)
        const explicitGap = _num(classRec.ratingGapToTop)
        const gap = explicitGap != null ? explicitGap
            : (our != null && top != null ? our - top : null)
        let pressure = 0
        let signals = 0

        if (gap != null) {
            pressure += _clamp(gap * 0.25, -8, 6)
            signals++
        } else if (our == null && top != null) {
            pressure -= 4
            signals++
        }

        if (rank != null) {
            const target = Math.max(1, Math.round(_num(opts && opts.rankTarget) || 3))
            if (rank <= target) pressure += _clamp((target - rank + 1) * 1.2, 0, 4)
            else pressure -= _clamp((rank - target) * 0.8, 0, 8)
            signals++
        }

        if (!signals) return null
        return _roundPct(pressure * _competitionWeight(competitorCount, opts))
    }

    function _roundForClass(cls, value) {
        const n = _num(value)
        if (n == null) return null
        return cls === "Cargo" && Math.abs(n) < 10
            ? Math.round(n * 100) / 100
            : Math.round(n)
    }

    function _median(values, cls) {
        const vals = (values || []).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b)
        if (!vals.length) return null
        const mid = Math.floor(vals.length / 2)
        const raw = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
        return _roundForClass(cls, raw)
    }

    function _stats(values, cls) {
        const vals = (values || []).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b)
        if (!vals.length) return {count: 0, min: null, max: null, median: null, avg: null}
        const sum = vals.reduce((s, v) => s + v, 0)
        return {
            count: vals.length,
            min: _roundForClass(cls, vals[0]),
            max: _roundForClass(cls, vals[vals.length - 1]),
            median: _median(vals, cls),
            avg: _roundForClass(cls, sum / vals.length)
        }
    }

    function _classRecord(rec, cls) {
        const byClass = rec && rec.byClass && typeof rec.byClass === "object" ? rec.byClass : null
        if (byClass) {
            const keys = ORS_KEYS[cls] || []
            for (const k of keys) if (byClass[k]) return byClass[k]
            return null
        }
        if (cls === "Y" && rec && Array.isArray(rec.connections)) return rec
        return null
    }

    function _flightLegs(conn) {
        return (conn && Array.isArray(conn.legs) ? conn.legs : []).filter(l => l && !l.isGround)
    }

    function _connPrice(conn) {
        const total = _num(conn && conn.totalPrice)
        if (total != null && total > 0) return total
        const legs = _flightLegs(conn)
        let sum = 0
        let found = false
        for (const leg of legs) {
            const p = _num(leg && leg.price)
            if (p != null && p > 0) { sum += p; found = true }
        }
        return found ? sum : null
    }

    function _carrierPrefixes(conn) {
        const out = []
        const seen = new Set()
        for (const leg of _flightLegs(conn)) {
            let p = String(leg.carrierPrefix || "").trim().toUpperCase()
            if (!p) {
                const m = /^([A-Z0-9]+)/.exec(String(leg.flightCode || "").trim().toUpperCase())
                p = m && m[1]
            }
            if (p && !seen.has(p)) { seen.add(p); out.push(p) }
        }
        return out
    }

    function _indexClass(classRec, cls, currentPrice, opts) {
        const conns = classRec && Array.isArray(classRec.connections) ? classRec.connections : []
        const allPrices = []
        const competitorPrices = []
        const ownPrices = []
        const nonstopCompetitorPrices = []
        const topConnections = []
        const competitorCarrierPrefixes = new Set()
        let ownCount = 0
        let competitorCount = 0
        let bookableCount = 0
        let bookableOwnCount = 0
        let bookableCompetitorCount = 0

        for (let i = 0; i < conns.length; i++) {
            const conn = conns[i]
            const legs = _flightLegs(conn)
            if (!legs.length) continue
            const price = _connPrice(conn)
            if (price == null || price <= 0) continue
            const anyOurs = legs.some(l => !!l.isOurs)
            const allOurs = legs.every(l => !!l.isOurs)
            const nonstop = legs.length === 1
            const bookable = conn.bookable !== false
            const prefixes = _carrierPrefixes(conn)
            if (bookable) bookableCount++
            allPrices.push(price)
            if (anyOurs) {
                ownCount++
                if (bookable) bookableOwnCount++
                ownPrices.push(price)
            } else {
                competitorCount++
                if (bookable) bookableCompetitorCount++
                for (const prefix of prefixes) competitorCarrierPrefixes.add(prefix)
                competitorPrices.push(price)
                if (nonstop) nonstopCompetitorPrices.push(price)
            }
            if (topConnections.length < 12) {
                topConnections.push({
                    rank: i + 1,
                    price: _roundForClass(cls, price),
                    rating: _num(conn.rating),
                    bookable: conn.bookable !== false,
                    isOurs: anyOurs,
                    allOurs,
                    nonstop,
                    carrierPrefixes: prefixes
                })
            }
        }

        const competitor = _stats(competitorPrices, cls)
        const nonstopCompetitor = _stats(nonstopCompetitorPrices, cls)
        const own = _stats(ownPrices, cls)
        const all = _stats(allPrices, cls)
        const current = _num(currentPrice)
        const median = competitor.median != null ? competitor.median : nonstopCompetitor.median
        const deltaToCurrentPct = current != null && current > 0 && median != null
            ? ((median - current) / current) * 100
            : null
        const competitorCarrierCount = competitorCarrierPrefixes.size || competitorCount
        const pressurePct = _pressurePct(classRec, competitorCarrierCount, opts || {})

        return {
            classKey: cls,
            payload: (ORS_KEYS[cls] || [cls])[0],
            orsPayload: (ORS_KEYS[cls] || [cls])[0],
            scrapedAt: _num(classRec && classRec.scrapedAt),
            rankAny: _num(classRec && classRec.rankAny),
            rankNonstop: _num(classRec && classRec.rankNonstop),
            rankBookable: _num(classRec && classRec.rankBookable),
            ourTopRating: _num(classRec && classRec.ourTopRating),
            topCompetitorRating: _num(classRec && classRec.topCompetitorRating),
            ratingGapToTop: _num(classRec && classRec.ratingGapToTop),
            totalConnections: _num(classRec && classRec.totalConnections) || conns.length,
            pricedConnections: all.count,
            ownCount,
            competitorCount,
            ownConnectionCount: ownCount,
            competitorConnectionCount: competitorCount,
            competitorCarrierCount,
            bookableCount,
            bookableOwnCount,
            bookableCompetitorCount,
            all,
            own,
            competitor,
            nonstopCompetitor,
            competitorMedian: median,
            competitorMedianPrice: median,
            ownMedianPrice: own.median,
            bestOwnPrice: own.min,
            bestCompetitorPrice: competitor.min,
            topCompetitorPrice: competitor.min,
            deltaToCurrentPct,
            pressurePct,
            hasOwnConnection: ownCount > 0 || _num(classRec && classRec.ourTopRating) != null,
            topConnections
        }
    }

    function indexRecord(rec, opts) {
        opts = opts || {}
        const currentPrices = opts.currentPrices || {}
        if (!rec || typeof rec !== "object") return null
        const classes = {}
        const competitorPricesByClass = {}
        const competitorCountsByClass = {}
        const ownPricesByClass = {}
        const connectionCountsByClass = {}
        const orsPressureByClass = {}
        let any = false
        let freshest = _num(rec.scrapedAt) || 0

        for (const cls of PRICE_CLASSES) {
            const classRec = _classRecord(rec, cls)
            if (!classRec) continue
            const indexed = _indexClass(classRec, cls, currentPrices[cls], opts)
            classes[cls] = indexed
            competitorCountsByClass[cls] = indexed.competitorCount
            connectionCountsByClass[cls] = indexed.pricedConnections
            if (indexed.competitorMedian != null) competitorPricesByClass[cls] = indexed.competitorMedian
            if (indexed.own.median != null) ownPricesByClass[cls] = indexed.own.median
            if (indexed.pressurePct != null) orsPressureByClass[cls] = indexed.pressurePct
            if (indexed.scrapedAt && indexed.scrapedAt > freshest) freshest = indexed.scrapedAt
            any = true
        }
        if (!any) return null
        const labels = ["ORS"]
        if (Object.keys(competitorPricesByClass).length) labels.push("ORS-price")
        if (Object.keys(orsPressureByClass).length) labels.push("ORS-pressure")
        return {
            hub: String(rec.hub || "").toUpperCase(),
            dest: String(rec.dest || "").toUpperCase(),
            pair: String(rec.hub || "").toUpperCase() + "-" + String(rec.dest || "").toUpperCase(),
            pairKey: String(rec.hub || "").toUpperCase() + "-" + String(rec.dest || "").toUpperCase(),
            scrapedAt: freshest || null,
            classes,
            competitorPricesByClass,
            competitorCountsByClass,
            ownPricesByClass,
            connectionCountsByClass,
            orsPressureByClass,
            labels,
            source: "ors-search"
        }
    }

    function classStats(index, cls) {
        return index && index.classes && index.classes[cls] || null
    }

    window.RouteAssistantOrsPriceIndex = {
        indexRecord,
        classStats,
        PRICE_CLASSES,
        _connPrice,
        _stats,
        _roundForClass,
        _pressurePct
    }
})()
