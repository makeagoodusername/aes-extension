"use strict"

/**
 * Storage wrapper for the Competitor Intelligence module. Persists per-server
 * (NOT per-airline) records under the `competitorIntel:` namespace — competitor
 * data is server-public, so encoding airline into the key would force redundant
 * scrapes across an enterprise's sister logins.
 *
 * Record families:
 *   competitorIntel:airport:<server>:<airportId>      — Stations-table view
 *   competitorIntel:enterprise:<server>:<enterpriseId> — meta + hubs + fleet
 *   competitorIntel:alliance:<server>:<allianceId>    — derived alliance summary
 *   competitorIntel:edge:<server>:<HUB>-<DEST>        — per-pair traffic edge
 *   competitorIntel:profile:<server>:<enterpriseId>   — render cache (6h)
 *
 * All records carry `server` and `scrapedAt` (or `builtAt` for derived caches)
 * so callers can do their own freshness arithmetic.
 */
class AesCompetitorStore {
    static NS = "competitorIntel:"

    static _airportKey(server, id) {
        return AesCompetitorStore.NS + "airport:" + server + ":" + String(id)
    }
    static _enterpriseKey(server, id) {
        return AesCompetitorStore.NS + "enterprise:" + server + ":" + String(id)
    }
    static _allianceKey(server, id) {
        return AesCompetitorStore.NS + "alliance:" + server + ":" + String(id)
    }
    static _edgeKey(server, hub, dest) {
        return AesCompetitorStore.NS + "edge:" + server + ":" + String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
    }
    static _profileKey(server, id) {
        return AesCompetitorStore.NS + "profile:" + server + ":" + String(id)
    }

    static isExpired(record, maxAgeMs) {
        if (!maxAgeMs || maxAgeMs <= 0) return false
        if (!record || typeof record.scrapedAt !== "number") return false
        return Date.now() - record.scrapedAt > maxAgeMs
    }

    // ---------- Airport ----------

    static async saveAirport(server, airportId, fields) {
        const key = AesCompetitorStore._airportKey(server, airportId)
        const rec = Object.assign({
            server,
            airportId: String(airportId),
            scrapedAt: Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    static async loadAirport(server, airportId) {
        const key = AesCompetitorStore._airportKey(server, airportId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    static async bulkLoadAirports(server, airportIds) {
        if (!airportIds || !airportIds.length) return new Map()
        const keys = airportIds.map(id => AesCompetitorStore._airportKey(server, id))
        const data = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in data) {
            const rec = data[k]
            if (!rec) continue
            map.set(rec.airportId, rec)
        }
        return map
    }

    // ---------- Enterprise ----------

    static async saveEnterprise(server, enterpriseId, fields) {
        const key = AesCompetitorStore._enterpriseKey(server, enterpriseId)
        const rec = Object.assign({
            server,
            enterpriseId: String(enterpriseId),
            scrapedAt: Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    static async loadEnterprise(server, enterpriseId) {
        const key = AesCompetitorStore._enterpriseKey(server, enterpriseId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    static async bulkLoadEnterprises(server, ids) {
        if (!ids || !ids.length) return new Map()
        const keys = ids.map(id => AesCompetitorStore._enterpriseKey(server, id))
        const data = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in data) {
            const rec = data[k]
            if (!rec) continue
            map.set(rec.enterpriseId, rec)
        }
        return map
    }

    // ---------- Alliance ----------

    static async saveAlliance(server, allianceId, fields) {
        const key = AesCompetitorStore._allianceKey(server, allianceId)
        const rec = Object.assign({
            server,
            allianceId: String(allianceId),
            scrapedAt: Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    static async loadAlliance(server, allianceId) {
        const key = AesCompetitorStore._allianceKey(server, allianceId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    // ---------- Edge ----------

    static async saveEdge(server, hub, dest, fields) {
        const key = AesCompetitorStore._edgeKey(server, hub, dest)
        const rec = Object.assign({
            server,
            hub: String(hub).toUpperCase(),
            dest: String(dest).toUpperCase(),
            scrapedAt: Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    static async loadEdge(server, hub, dest) {
        const key = AesCompetitorStore._edgeKey(server, hub, dest)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    // ---------- Profile (render cache) ----------

    static async saveProfile(server, enterpriseId, fields) {
        const key = AesCompetitorStore._profileKey(server, enterpriseId)
        const rec = Object.assign({
            server,
            enterpriseId: String(enterpriseId),
            builtAt: Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    static async loadProfile(server, enterpriseId) {
        const key = AesCompetitorStore._profileKey(server, enterpriseId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    // ---------- Legacy Competitor Monitoring bridge ----------

    /**
     * Project the original dashboard Competitor Monitoring record into the
     * modern competitor-enterprise shape. This is read-side only; it lets the
     * hub render tracked rivals even before the deep competitor-intel scraper
     * has produced a native `competitorIntel:enterprise:*` record.
     */
    static projectLegacyMonitoring(record, opts) {
        if (!record || record.type !== "competitorMonitoring") return null
        const enterpriseId = String(record.id || record.enterpriseId || "")
        if (!enterpriseId) return null

        const latest0 = AesCompetitorStore._legacyLatest(record.tab0)
        const latest2 = AesCompetitorStore._legacyLatest(record.tab2)
        const tab0 = latest0 ? latest0.value : {}
        const tab2 = latest2 ? latest2.value : {}
        const scheduleInfo = AesCompetitorStore._projectLegacySchedule(opts && opts.schedule)

        const fleet = {}
        AesCompetitorStore._assignNumber(fleet, "aircraftCount", tab0.fleet)
        AesCompetitorStore._assignNumber(fleet, "stationsCount",
            tab0.stations != null ? tab0.stations : tab2.airportsServed)
        AesCompetitorStore._assignNumber(fleet, "employeeCount", tab0.employees)
        AesCompetitorStore._assignNumber(fleet, "paxCarried", tab0.pax)
        AesCompetitorStore._assignNumber(fleet, "cargoCarried", tab0.cargo)
        AesCompetitorStore._assignNumber(fleet, "operatedFlights", tab2.operatedFlights)
        AesCompetitorStore._assignNumber(fleet, "seatsOffered", tab2.seatsOffered)
        AesCompetitorStore._assignNumber(fleet, "cargoOffered", tab2.cargoOffered)
        if (tab0.rating) fleet.rating = tab0.rating

        const rec = {
            server:        record.server || null,
            enterpriseId:  enterpriseId,
            name:          tab0.displayName || tab0.name || record.name || ("#" + enterpriseId),
            iata:          tab0.code || record.code || null,
            alliance:      null,
            baseCountry:   null,
            fleet:         Object.keys(fleet).length ? fleet : null,
            fleetByType:   [],
            hubs:          scheduleInfo.hubs,
            routeFootprint:scheduleInfo.routeFootprint,
            source:        "legacyCompetitorMonitoring",
            legacyTracking:!!record.tracking,
            legacyKey:     record.key || null,
            parserNotes:   "projected from legacy Competitor Monitoring"
        }

        const scrapedAt = AesCompetitorStore._legacyDateToMs(
            (tab0 && tab0.date) || (latest0 && latest0.date)
                || (tab2 && tab2.date) || (latest2 && latest2.date)
                || scheduleInfo.date,
            (tab0 && tab0.updateTime) || (tab2 && tab2.updateTime)
                || scheduleInfo.updateTime
        )
        if (scrapedAt) rec.scrapedAt = scrapedAt

        return rec
    }

    static projectLegacyMonitoringSnapshots(record, opts) {
        if (!record || record.type !== "competitorMonitoring") return []
        const dates = Object.keys(record.tab0 || {})
            .filter(d => /^\d{8}$/.test(String(d)))
            .sort()
        if (!dates.length) {
            const projected = AesCompetitorStore.projectLegacyMonitoring(record, opts)
            const snap = AesCompetitorStore._snapshotFromProjected(projected)
            return snap ? [snap] : []
        }

        const out = []
        for (const date of dates) {
            const clone = Object.assign({}, record, {tab0: {}})
            clone.tab0[date] = record.tab0[date]
            const projected = AesCompetitorStore.projectLegacyMonitoring(clone, opts)
            const snap = AesCompetitorStore._snapshotFromProjected(projected)
            if (snap) out.push(snap)
        }
        return out
    }

    static projectLegacyMonitoringEdges(record, opts) {
        const projected = (opts && opts.projected)
            || AesCompetitorStore.projectLegacyMonitoring(record, opts)
        if (!projected || !projected.enterpriseId) return []
        const footprint = Array.isArray(projected.routeFootprint)
            ? projected.routeFootprint
            : []
        if (!footprint.length) return []

        const routeMap = new Map()
        for (const route of footprint) {
            if (!route || !route.hub || !route.dest) continue
            const hub = String(route.hub).toUpperCase()
            const dest = String(route.dest).toUpperCase()
            if (!/^[A-Z]{3}$/.test(hub) || !/^[A-Z]{3}$/.test(dest) || hub === dest) continue
            const key = hub + "-" + dest
            const weeklyFlights = Number(route.weeklyFlights) || 0
            const edge = routeMap.get(key) || {
                server: projected.server || (record && record.server) || null,
                hub,
                dest,
                scrapedAt: projected.scrapedAt || Date.now(),
                competitors: [],
                totals: {totalWeeklyFlights: 0, totalSeats: null},
                source: "legacyCompetitorMonitoring",
                legacyTracking: true
            }
            edge.competitors.push({
                enterpriseId: String(projected.enterpriseId),
                name: projected.name || ("#" + projected.enterpriseId),
                iata: projected.iata || null,
                sharePctPax: null,
                sharePctCargo: null,
                weeklyFlights: weeklyFlights || null,
                weeklySeats: null,
                source: "legacyCompetitorMonitoring"
            })
            edge.totals.totalWeeklyFlights += weeklyFlights
            if ((projected.scrapedAt || 0) > (edge.scrapedAt || 0)) {
                edge.scrapedAt = projected.scrapedAt
            }
            routeMap.set(key, edge)
        }
        return Array.from(routeMap.values())
    }

    static async loadLegacyMonitoring(server, allBlob) {
        if (!server) return []
        const all = allBlob || await chrome.storage.local.get(null)
        const out = []
        for (const k in all) {
            const rec = all[k]
            if (!rec || typeof rec !== "object") continue
            if (rec.type !== "competitorMonitoring") continue
            if (rec.server && rec.server !== server) continue
            if (!rec.tracking) continue
            const code = AesCompetitorStore._legacyCarrierCode(rec)
            const schedule = code ? all[String(server) + code + "schedule"] : null
            const projected = AesCompetitorStore.projectLegacyMonitoring(rec, {schedule})
            if (projected) out.push(projected)
        }
        return out
    }

    static _legacyLatest(tab) {
        if (!tab || typeof tab !== "object") return null
        const dates = Object.keys(tab)
            .filter(d => /^\d{8}$/.test(String(d)))
            .sort()
        if (!dates.length) return null
        const date = dates[dates.length - 1]
        return {date, value: tab[date] || {}}
    }

    static _legacyCarrierCode(record) {
        const latest = AesCompetitorStore._legacyLatest(record && record.tab0)
        const row = latest ? latest.value : {}
        return row.code || (record && record.code) || null
    }

    static _assignNumber(target, key, value) {
        const n = Number(value)
        if (Number.isFinite(n)) target[key] = n
    }

    static _legacyDateToMs(date, time) {
        const d = String(date || "")
        if (!/^\d{8}$/.test(d)) return null
        const y = Number(d.slice(0, 4))
        const m = Number(d.slice(4, 6))
        const day = Number(d.slice(6, 8))
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return null
        let hour = 12
        let minute = 0
        const tm = /(\d{1,2}):(\d{2})/.exec(String(time || ""))
        if (tm) {
            hour = Math.max(0, Math.min(23, Number(tm[1]) || 0))
            minute = Math.max(0, Math.min(59, Number(tm[2]) || 0))
        }
        return Date.UTC(y, m - 1, day, hour, minute)
    }

    static _projectLegacySchedule(scheduleRec) {
        const empty = {hubs: [], routeFootprint: [], date: null, updateTime: null}
        if (!scheduleRec || !scheduleRec.date || typeof scheduleRec.date !== "object") return empty
        const dates = Object.keys(scheduleRec.date)
            .filter(d => /^\d{8}$/.test(String(d)))
            .sort()
        if (!dates.length) return empty
        const date = dates[dates.length - 1]
        const envelope = scheduleRec.date[date] || {}
        const rows = Array.isArray(envelope.schedule) ? envelope.schedule : []
        const hubMap = new Map()
        const routeMap = new Map()

        for (const row of rows) {
            if (!row || typeof row !== "object") continue
            const pair = AesCompetitorStore._legacySchedulePair(row)
            if (!pair || !pair.hub || !pair.dest || pair.hub === pair.dest) continue
            const freq = AesCompetitorStore._legacyScheduleFreq(row)
            const key = pair.hub + "-" + pair.dest
            const existing = routeMap.get(key) || {
                hub: pair.hub, dest: pair.dest, weeklyFlights: 0
            }
            existing.weeklyFlights += freq
            routeMap.set(key, existing)

            const hub = hubMap.get(pair.hub) || {
                iata: pair.hub, weeklyDepartures: 0, isHub: true
            }
            hub.weeklyDepartures += freq
            hubMap.set(pair.hub, hub)
        }

        const hubs = Array.from(hubMap.values())
            .sort((a, b) => (b.weeklyDepartures || 0) - (a.weeklyDepartures || 0))
        const routeFootprint = Array.from(routeMap.values())
            .sort((a, b) => (b.weeklyFlights || 0) - (a.weeklyFlights || 0))
        return {
            hubs,
            routeFootprint,
            date,
            updateTime: envelope.updateTime || scheduleRec.updateTime || null
        }
    }

    static _legacySchedulePair(row) {
        const od = String(row.od || "").toUpperCase().replace(/[^A-Z]/g, "")
        if (/^[A-Z]{6}$/.test(od)) {
            return {hub: od.slice(0, 3), dest: od.slice(3, 6)}
        }
        const origin = AesCompetitorStore._extractIata(row.origin)
        const dest = AesCompetitorStore._extractIata(row.destination)
        if (!origin || !dest) return null
        if (String(row.direction || "").toLowerCase() === "inbound") {
            return {hub: dest, dest: origin}
        }
        return {hub: origin, dest: dest}
    }

    static _legacyScheduleFreq(row) {
        const fns = row && row.flightNumber
        let total = 0
        if (fns && typeof fns === "object") {
            for (const k in fns) {
                const fn = fns[k] || {}
                total += (Number(fn.paxFreq) || 0) + (Number(fn.cargoFreq) || 0)
            }
        }
        return total > 0 ? total : 1
    }

    static _extractIata(value) {
        const m = /\b([A-Z]{3})\b/.exec(String(value || "").toUpperCase())
        return m ? m[1] : null
    }

    static _snapshotFromProjected(record) {
        if (!record) return null
        const fleet = record.fleet || {}
        const hubs = Array.isArray(record.hubs) ? record.hubs : []
        const footprint = Array.isArray(record.routeFootprint) ? record.routeFootprint : []
        const hubIatas = hubs
            .map(h => h && h.iata ? String(h.iata).toUpperCase() : null)
            .filter(Boolean)
            .sort()
        const routeKeys = footprint
            .filter(r => r && r.hub && r.dest)
            .map(r => String(r.hub).toUpperCase() + "-" + String(r.dest).toUpperCase())
            .sort()
        return {
            at:              Number(record.scrapedAt) || Date.now(),
            allianceId:      null,
            allianceName:    null,
            baseCountryId:   null,
            baseCountryName: null,
            aircraftCount:   Number.isFinite(Number(fleet.aircraftCount)) ? Number(fleet.aircraftCount) : null,
            stationsCount:   Number.isFinite(Number(fleet.stationsCount)) ? Number(fleet.stationsCount) : null,
            employeeCount:   Number.isFinite(Number(fleet.employeeCount)) ? Number(fleet.employeeCount) : null,
            paxCarried:      Number.isFinite(Number(fleet.paxCarried)) ? Number(fleet.paxCarried) : null,
            cargoCarried:    Number.isFinite(Number(fleet.cargoCarried)) ? Number(fleet.cargoCarried) : null,
            rating:          fleet.rating || null,
            fleetTypes:      [],
            hubIatas,
            routeKeys,
            hubCount:        hubIatas.length,
            routeCount:      routeKeys.length,
            fleetTypeCount:  0
        }
    }

    static async clearAll(server) {
        const all = await chrome.storage.local.get(null)
        const prefix = AesCompetitorStore.NS
        const toRemove = []
        for (const k in all) {
            if (!k.startsWith(prefix)) continue
            if (server && !k.includes(":" + server + ":")) continue
            toRemove.push(k)
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
        return toRemove.length
    }
}

if (typeof window !== "undefined") {
    window.AesCompetitorStore = AesCompetitorStore
}
