/**
 * chrome.storage.local wrapper for flightsfrom.com scraped data.
 *
 * One record per airport, keyed by IATA:
 *
 *   flightsFrom:<IATA>        → {iata, scrapedAt, airportName, routes: [...]}
 *   flightsFrom:<IATA>:status → {iata, scanId, status, error, progress}
 *
 * The status record is written by the child tab as it scrapes, so the
 * dashboard (or scheduling-page overlay) can surface progress without
 * waiting for the full dataset.
 */
class FlightsFromStore {
    static _dataKey(iata)   { return "flightsFrom:" + String(iata || "").toUpperCase() }
    static _statusKey(iata) { return "flightsFrom:" + String(iata || "").toUpperCase() + ":status" }

    static async saveAirport(record) {
        if (!record || !record.iata) throw new Error("saveAirport: iata required")
        const key = FlightsFromStore._dataKey(record.iata)
        const toStore = Object.assign({scrapedAt: Date.now()}, record,
            {iata: String(record.iata).toUpperCase()})
        await chrome.storage.local.set({[key]: toStore})
        try { await FlightsFromStore.publishTopRoutesFromAirport(toStore) }
        catch (e) {
            if (typeof console !== "undefined" && console.warn) {
                console.warn("[AES flightsFrom] topRoutes fallback publish failed", e)
            }
        }
        return toStore
    }

    static async loadAirport(iata) {
        if (!iata) return null
        const key = FlightsFromStore._dataKey(iata)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    static async deleteAirport(iata) {
        if (!iata) return
        await chrome.storage.local.remove([
            FlightsFromStore._dataKey(iata),
            FlightsFromStore._statusKey(iata)
        ])
    }

    static async listAirports() {
        const all = await chrome.storage.local.get(null)
        const prefix = "flightsFrom:"
        const out = []
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            if (k.indexOf(":status") !== -1) continue
            const rec = all[k]
            if (rec && rec.iata) {
                out.push({
                    iata: rec.iata,
                    airportName: rec.airportName || null,
                    scrapedAt: rec.scrapedAt || null,
                    routeCount: (rec.routes || []).length
                })
            }
        }
        return out.sort((a, b) => a.iata.localeCompare(b.iata))
    }

    /**
     * Shared interpretation of FlightsFrom route frequency as a planning
     * demand signal. The CountryScraper demand store is still the authoritative
     * AS pax/cargo source; this fallback keeps route queues useful when the
     * user has only run a FlightsFrom scrape.
     */
    static buildDemandContext(routes) {
        const list = Array.isArray(routes) ? routes : []
        let maxWeekly = 0, maxSeats = 0, totalWeekly = 0, busiestRoute = null
        for (const r of list) {
            const weekly = FlightsFromStore._num(r && r.weeklyFlights)
            const seats  = FlightsFromStore._num(r && r.seatsPerWeek)
            if (weekly != null && weekly > 0) {
                totalWeekly += weekly
                if (weekly > maxWeekly) {
                    maxWeekly = weekly
                    busiestRoute = r
                }
            }
            if (seats != null && seats > maxSeats) maxSeats = seats
        }
        return {
            maxWeeklyFlights: maxWeekly || null,
            maxSeatsPerWeek:  maxSeats || null,
            totalWeeklyFlights: totalWeekly || null,
            routeCount: list.length,
            busiestRoute: busiestRoute
        }
    }

    static demandForRoute(route, context) {
        if (!route) return null
        const ctx = context || FlightsFromStore.buildDemandContext([route])
        const weekly = FlightsFromStore._num(route.weeklyFlights)
        const seats  = FlightsFromStore._num(route.seatsPerWeek)
        const airlineCount = Array.isArray(route.airlines)
            ? route.airlines.length
            : FlightsFromStore._num(route.airlineCount)
        const parts = []
        if (weekly != null && weekly > 0) {
            parts.push({score: FlightsFromStore.scoreWeeklyFlights(weekly), weight: 3})
        }
        if (seats != null && seats > 0) {
            parts.push({score: FlightsFromStore._scoreRelative(seats, ctx.maxSeatsPerWeek), weight: 1})
        }
        if (!parts.length && airlineCount != null && airlineCount > 0) {
            parts.push({score: FlightsFromStore._clampScore(airlineCount + 1), weight: 1})
        }
        if (!parts.length) return null
        const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
        const paxScore = FlightsFromStore._clampScore(Math.round(
            parts.reduce((sum, p) => sum + (p.score * p.weight), 0) / totalWeight
        ))
        const basis = []
        if (weekly != null && weekly > 0) basis.push(weekly + " flights/wk")
        if (seats  != null && seats  > 0) basis.push(seats.toLocaleString() + " seats/wk")
        if (airlineCount != null && airlineCount > 0) {
            basis.push(airlineCount + " airline" + (airlineCount === 1 ? "" : "s"))
        }
        return {
            iata:          String(route.destIata || "").toUpperCase() || null,
            name:          route.destName || null,
            paxScore:      paxScore,
            cargoScore:    null,
            source:        "flightsfrom",
            sourceLabel:   "FlightsFrom frequency",
            demandSource:  "flightsfrom",
            demandBasis:   basis.join(" · "),
            weeklyFlights: weekly,
            seatsPerWeek:  seats,
            airlineCount:  airlineCount
        }
    }

    static demandForHub(record) {
        if (!record || !Array.isArray(record.routes) || !record.routes.length) return null
        const ctx = FlightsFromStore.buildDemandContext(record.routes)
        const busiest = ctx.busiestRoute || null
        const topDemand = busiest ? FlightsFromStore.demandForRoute(busiest, ctx) : null
        const routeScore = topDemand && topDemand.paxScore != null ? topDemand.paxScore : null
        const breadthScore = ctx.routeCount
            ? FlightsFromStore._clampScore(Math.ceil(ctx.routeCount / 20))
            : null
        const paxScore = routeScore != null && breadthScore != null
            ? Math.max(routeScore, breadthScore)
            : (routeScore != null ? routeScore : breadthScore)
        return {
            iata:                String(record.iata || "").toUpperCase(),
            name:                record.airportName || null,
            paxScore:            paxScore,
            cargoScore:          null,
            source:              "flightsfrom",
            sourceLabel:         "FlightsFrom frequency",
            demandSource:        "flightsfrom",
            scope:               "hub",
            routeCount:          ctx.routeCount,
            weeklyFlightsTotal:  ctx.totalWeeklyFlights,
            maxWeeklyFlights:    ctx.maxWeeklyFlights,
            topDestIata:         busiest ? String(busiest.destIata || "").toUpperCase() : null,
            topDestName:         busiest ? (busiest.destName || null) : null,
            scrapedAt:           record.scrapedAt || null
        }
    }

    static scoreWeeklyFlights(weeklyFlights) {
        const n = FlightsFromStore._num(weeklyFlights)
        if (n == null || n <= 0) return null
        if (n >= 200) return 10
        if (n >= 150) return 9
        if (n >= 100) return 8
        if (n >= 75)  return 7
        if (n >= 50)  return 6
        if (n >= 35)  return 5
        if (n >= 21)  return 4
        if (n >= 14)  return 3
        if (n >= 7)   return 2
        return 1
    }

    static buildTopRoutesBlob(record) {
        if (!record || !record.iata || !Array.isArray(record.routes)) return null
        const ctx = FlightsFromStore.buildDemandContext(record.routes)
        const rows = record.routes.map(r => {
            const demand = FlightsFromStore.demandForRoute(r, ctx)
            const weekly = FlightsFromStore._num(r.weeklyFlights)
            const seats  = FlightsFromStore._num(r.seatsPerWeek)
            const airlines = Array.isArray(r.airlines) ? r.airlines.length : null
            return {
                destIata:       String(r.destIata || "").toUpperCase(),
                destName:       r.destName || null,
                distanceKm:     FlightsFromStore._num(r.distanceKm),
                score:          demand && demand.paxScore != null ? demand.paxScore * 10 : null,
                status:         null,
                paxScore:       demand ? demand.paxScore : null,
                cargoScore:     null,
                weeklyFlights:  weekly,
                seatsPerWeek:   seats,
                airlineCount:   airlines,
                demandSource:   demand ? demand.demandSource : null,
                demandBasis:    demand ? demand.demandBasis : null
            }
        }).filter(r => /^[A-Z]{3}$/.test(r.destIata))
          .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
              || (Number(b.weeklyFlights) || 0) - (Number(a.weeklyFlights) || 0)
              || a.destIata.localeCompare(b.destIata))
          .slice(0, 50)
        return {
            hub:       String(record.iata).toUpperCase(),
            source:    "flightsfrom",
            scrapedAt: record.scrapedAt || Date.now(),
            count:     rows.length,
            rows:      rows
        }
    }

    static async publishTopRoutesFromAirport(record) {
        if (!record || !record.iata
                || typeof chrome === "undefined"
                || !chrome.storage || !chrome.storage.local) return null
        const blob = FlightsFromStore.buildTopRoutesBlob(record)
        if (!blob || !blob.rows.length) return null
        const hub = blob.hub
        const hubKey = "routeAssistant:topRoutes:" + hub
        let shouldWrite = true
        try {
            const existing = await chrome.storage.local.get([hubKey])
            const cur = existing && existing[hubKey]
            if (cur && cur.source !== "flightsfrom"
                    && cur.scrapedAt && blob.scrapedAt
                    && Number(cur.scrapedAt) >= Number(blob.scrapedAt)) {
                shouldWrite = false
            }
        } catch (_) { shouldWrite = true }
        if (!shouldWrite) return null
        const writes = {
            "routeAssistant:topRoutes": blob,
            [hubKey]: blob
        }
        await chrome.storage.local.set(writes)
        return blob
    }

    static _num(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    static _scoreRelative(value, maxValue) {
        const v = FlightsFromStore._num(value)
        const max = FlightsFromStore._num(maxValue)
        if (v == null || v <= 0) return null
        if (max == null || max <= 0) return FlightsFromStore._clampScore(v)
        return FlightsFromStore._clampScore(Math.ceil((v / max) * 10))
    }

    static _clampScore(value) {
        const n = Number(value)
        if (!isFinite(n)) return null
        return Math.max(1, Math.min(10, Math.round(n)))
    }

    static async saveStatus(iata, status) {
        const key = FlightsFromStore._statusKey(iata)
        await chrome.storage.local.set({[key]: Object.assign({iata: String(iata).toUpperCase()}, status)})
    }

    static async loadStatus(iata) {
        const key = FlightsFromStore._statusKey(iata)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }
}

if (typeof window !== "undefined") {
    window.FlightsFromStore = FlightsFromStore
}
