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
