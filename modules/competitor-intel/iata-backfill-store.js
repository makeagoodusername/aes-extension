"use strict"

/**
 * Per-server IATA → enterpriseId backfill table.
 *
 * Built up opportunistically as the user touches enterprise records (every
 * `competitorIntel:enterprise:*` entry that ships an `iata` plus a real
 * numeric enterpriseId is one (iata, id, name) triple we can remember).
 * Read by IATA-only carrier rows in the explore-map drilldown so the
 * "Profile →" affordance can deep-link to the AS enterprise page even
 * when the underlying source (markets-page-scraper) only saw a flight
 * code prefix.
 *
 * Storage: one blob per server at `competitorIntel:iataBackfill:<server>`
 *   { server, builtAt, byIata: { <IATA>: {enterpriseId, name, lastSeenAt} } }
 *
 * Capped at IATA_CAP entries (FIFO by lastSeenAt). 256 is comfortably above
 * the per-game-world airline count on free1 (~150) and stays well inside
 * the per-namespace storage budget.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIataBackfill) return

    const KEY_PREFIX = "competitorIntel:iataToEnterpriseId:"
    const IATA_RE = /^[A-Z]{2,3}$/
    const IATA_CAP = 256

    function _key(server) {
        return KEY_PREFIX + String(server || "")
    }

    function _normIata(raw) {
        const s = String(raw || "").trim().toUpperCase()
        return IATA_RE.test(s) ? s : null
    }

    function _normEnterpriseId(raw) {
        if (raw == null) return null
        const s = String(raw)
        // The host's loadServerData synthesises `iata:XX` ids for IATA-only
        // edges; we reject them — backfill only stores real numeric ids.
        if (!s || s.startsWith("iata:")) return null
        return s
    }

    function _emptyBlob(server) {
        return {server: String(server || ""), builtAt: 0, byIata: {}}
    }

    async function load(server) {
        if (!server) return _emptyBlob(server)
        const key = _key(server)
        const data = await chrome.storage.local.get([key])
        const blob = data[key]
        if (!blob || typeof blob !== "object" || !blob.byIata) return _emptyBlob(server)
        return blob
    }

    async function save(server, blob) {
        if (!server) return
        const key = _key(server)
        blob.builtAt = Date.now()
        await chrome.storage.local.set({[key]: blob})
    }

    /**
     * Record an iata → (enterpriseId, name) mapping. No-op when either side
     * is missing or already current. Returns true when the blob was changed.
     */
    async function record(server, iata, enterpriseId, name) {
        const code = _normIata(iata)
        const id = _normEnterpriseId(enterpriseId)
        if (!server || !code || !id) return false
        const blob = await load(server)
        const prior = blob.byIata[code]
        const nm = name ? String(name) : (prior && prior.name) || null
        if (prior && prior.enterpriseId === id && prior.name === nm) {
            // Touch lastSeenAt without rewriting if it's older than 24h —
            // keeps the FIFO eviction order honest under steady-state use.
            if (Date.now() - (prior.lastSeenAt || 0) < 86400000) return false
        }
        blob.byIata[code] = {enterpriseId: id, name: nm, lastSeenAt: Date.now()}
        _evictOverflow(blob)
        await save(server, blob)
        return true
    }

    /**
     * Bulk-seed from an iterable of {iata, enterpriseId, name}. Used by
     * `loadServerData`'s post-merge sweep so every cached enterprise record
     * with both fields contributes once per session. Idempotent — re-seeding
     * the same triples is a no-op.
     */
    async function bulkSeed(server, triples) {
        if (!server || !triples || !triples[Symbol.iterator]) return 0
        const blob = await load(server)
        let touched = 0
        const now = Date.now()
        for (const t of triples) {
            if (!t) continue
            const code = _normIata(t.iata)
            const id = _normEnterpriseId(t.enterpriseId)
            if (!code || !id) continue
            const prior = blob.byIata[code]
            const nm = t.name ? String(t.name) : (prior && prior.name) || null
            if (prior && prior.enterpriseId === id && prior.name === nm
                    && now - (prior.lastSeenAt || 0) < 86400000) continue
            blob.byIata[code] = {enterpriseId: id, name: nm, lastSeenAt: now}
            touched++
        }
        if (!touched) return 0
        _evictOverflow(blob)
        await save(server, blob)
        return touched
    }

    function _evictOverflow(blob) {
        const codes = Object.keys(blob.byIata)
        if (codes.length <= IATA_CAP) return
        const sorted = codes
            .map(c => [c, blob.byIata[c].lastSeenAt || 0])
            .sort((a, b) => a[1] - b[1])
        const dropCount = codes.length - IATA_CAP
        for (let i = 0; i < dropCount; i++) delete blob.byIata[sorted[i][0]]
    }

    async function lookup(server, iata) {
        const code = _normIata(iata)
        if (!server || !code) return null
        const blob = await load(server)
        return blob.byIata[code] || null
    }

    async function loadAll(server) {
        const blob = await load(server)
        const m = new Map()
        for (const k in blob.byIata) m.set(k, blob.byIata[k])
        return m
    }

    /**
     * Pure projection — used by `host.loadServerData` and tests. Walks an
     * enterprises Map and returns the (iata, id, name) triples to seed.
     */
    function projectFromEnterprises(enterprises) {
        const out = []
        if (!enterprises || typeof enterprises.forEach !== "function") return out
        for (const [, rec] of enterprises) {
            if (!rec) continue
            const iata = _normIata(rec.iata)
            const id = _normEnterpriseId(rec.enterpriseId)
            if (!iata || !id) continue
            out.push({iata, enterpriseId: id, name: rec.name || null})
        }
        return out
    }

    /**
     * Pure projection — captures (iata, enterpriseId, name) triples from
     * edge competitors that carry BOTH fields. Some edges (own-fleet flight
     * scrapes, alliance-tile snapshots) record the enterpriseId before any
     * dedicated enterprise scrape has run, so this is the only path to seed
     * the backfill for those carriers without forcing the user to visit
     * /app/info/enterprises/<id> first.
     *
     *   edges: Map<HUB-DEST, {competitors:[{enterpriseId, iata, name}, ...]}>
     */
    function projectFromEdges(edges) {
        const out = []
        const seenIata = new Set()
        if (!edges || typeof edges.values !== "function") return out
        for (const edge of edges.values()) {
            if (!edge || !Array.isArray(edge.competitors)) continue
            for (const c of edge.competitors) {
                if (!c) continue
                const iata = _normIata(c.iata)
                const id = _normEnterpriseId(c.enterpriseId)
                if (!iata || !id) continue
                if (seenIata.has(iata)) continue
                seenIata.add(iata)
                out.push({iata, enterpriseId: id, name: c.name || null})
            }
        }
        return out
    }

    window.AesCompetitorIataBackfill = {
        load, record, bulkSeed, lookup, loadAll,
        projectFromEnterprises, projectFromEdges,
        _key, _normIata, _normEnterpriseId, IATA_CAP
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(window.AesCompetitorIataBackfill._normIata("ba") === "BA", "[smoke iata-backfill] norm")
            console.assert(window.AesCompetitorIataBackfill._normIata("xyzz") === null, "[smoke iata-backfill] reject 4-char")
            console.assert(window.AesCompetitorIataBackfill._normEnterpriseId("iata:BA") === null, "[smoke iata-backfill] reject iata: id")
            console.assert(window.AesCompetitorIataBackfill._normEnterpriseId("12345") === "12345", "[smoke iata-backfill] real id")
            const ents = new Map([
                ["77", {enterpriseId: "77", iata: "BA", name: "British"}],
                ["iata:WWW", {enterpriseId: "iata:WWW", iata: "WWW"}]  // synthetic — should be skipped
            ])
            const proj = window.AesCompetitorIataBackfill.projectFromEnterprises(ents)
            console.assert(proj.length === 1 && proj[0].iata === "BA", "[smoke iata-backfill] project skips iata: ids")
        }
    } catch (_) {}
})()
