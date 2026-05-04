"use strict"

/**
 * Competitor refresh watchlist — pure-derived priority queue answering
 * "which competitors should I deep-scrape next?".
 *
 * Reads the cached competitor records on the current server and combines
 * `AesCompetitorThreatScorer.score()` with a staleness factor to rank
 * enterprises for re-scrape. The output is a list of
 * { enterpriseId, name, code, priority, threat, ageDays, reasons }.
 *
 * Pure derivation (no writes) — orchestrators / auto-drivers consume this
 * via `derive()` to pick the next N candidates. A separate `nextBatch()`
 * convenience returns the top-K ids respecting a maximum age cutoff so
 * fresh records are not re-scraped just because they're high-threat.
 *
 * The user's manual UI surfaces (airport-panel, enterprise-panel,
 * outline-panel) are unchanged — this is a read-side aggregator that the
 * automation layer can call without affecting human-driven flows.
 */
class AesCompetitorWatchlist {
    /** Soft default: a meta record older than this gets full staleness weight. */
    static STALENESS_HORIZON_DAYS = 14
    /** Cap returned by nextBatch when caller doesn't override. */
    static DEFAULT_BATCH_SIZE = 8
    /** Below this, an entry is considered too fresh to re-scrape regardless of threat. */
    static MIN_AGE_FOR_RESCRAPE_DAYS = 1

    /**
     * @param {object} args
     * @param {string} args.server                 current AS server.
     * @param {Array<string>} [args.ourHubs]       our own hub IATA codes.
     * @param {number} [args.now]                  override clock (ms).
     * @param {number} [args.minThreat]            drop entries scoring below this.
     * @param {Array<string>} [args.skipIds]       enterprise IDs to exclude (e.g. our own kin).
     * @returns {Promise<Array<object>>}
     */
    static async derive(args) {
        const server = args && args.server
        if (!server) return []
        const now = isFinite(args.now) ? Number(args.now) : Date.now()
        const ourHubs = args.ourHubs || []
        const minThreat = isFinite(args.minThreat) ? Number(args.minThreat) : 0
        const skipIds = AesCompetitorWatchlist._asSet(args.skipIds)

        const records = await AesCompetitorWatchlist._loadRecords(server)
        if (!records.length) return []

        const out = []
        for (const rec of records) {
            const id = String(rec.enterpriseId || "")
            if (!id || skipIds.has(id)) continue
            const snapshots = await AesCompetitorWatchlist._loadSnapshotsSafe(server, id)
            const threat = AesCompetitorWatchlist._safeScore({record: rec, snapshots, ourHubs, now})
            if (threat.score < minThreat) continue

            const ageDays = isFinite(rec.scrapedAt)
                ? Math.max(0, (now - rec.scrapedAt) / 86400000)
                : Number.POSITIVE_INFINITY
            const stalenessFactor = AesCompetitorWatchlist._stalenessFactor(ageDays)
            const priority = Math.round(threat.score * 0.7 + threat.score * 0.3 * stalenessFactor)

            const reasons = []
            if (threat.flags.hubOverlap)   reasons.push("hub overlap")
            if (threat.flags.expanding)    reasons.push("expanding")
            if (threat.flags.contracting)  reasons.push("contracting")
            if (threat.flags.alliance)     reasons.push("alliance member")
            if (ageDays === Number.POSITIVE_INFINITY) reasons.push("never scraped")
            else if (ageDays > AesCompetitorWatchlist.STALENESS_HORIZON_DAYS) reasons.push("data " + Math.round(ageDays) + "d old")
            if (!reasons.length && threat.bucket !== "low") reasons.push(threat.bucket + " threat")

            out.push({
                enterpriseId: id,
                name:         rec.name || null,
                code:         rec.iata || null,
                priority,
                threat:       threat.score,
                threatBucket: threat.bucket,
                ageDays:      ageDays === Number.POSITIVE_INFINITY ? null : Number(ageDays.toFixed(1)),
                reasons,
                rationale:    threat.rationale,
                flags:        threat.flags
            })
        }

        out.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority
            const ageA = a.ageDays == null ? Infinity : a.ageDays
            const ageB = b.ageDays == null ? Infinity : b.ageDays
            return ageB - ageA
        })
        return out
    }

    /**
     * Convenience for orchestrators: top-K enterprise ids that are not too
     * fresh to re-scrape. Returns just the ids; the full ranking entries are
     * available via `derive()` for the caller wanting rationale / debug.
     */
    static async nextBatch(args) {
        const limit = Math.max(1, Math.min(64,
            isFinite(args && args.limit) ? Number(args.limit) : AesCompetitorWatchlist.DEFAULT_BATCH_SIZE))
        const minAgeDays = isFinite(args && args.minAgeDays)
            ? Number(args.minAgeDays)
            : AesCompetitorWatchlist.MIN_AGE_FOR_RESCRAPE_DAYS

        const ranked = await AesCompetitorWatchlist.derive(args || {})
        const out = []
        for (const r of ranked) {
            if (r.ageDays != null && r.ageDays < minAgeDays) continue
            out.push(r.enterpriseId)
            if (out.length >= limit) break
        }
        return out
    }

    /**
     * Stable factor in [0, 1]: 0 when the record is brand-new, 1 when at-or-beyond
     * STALENESS_HORIZON_DAYS. Linear in between so a 7d-old entry is half-weight.
     */
    static _stalenessFactor(ageDays) {
        if (!isFinite(ageDays)) return 1
        if (ageDays <= 0) return 0
        const horizon = AesCompetitorWatchlist.STALENESS_HORIZON_DAYS
        if (ageDays >= horizon) return 1
        return ageDays / horizon
    }

    static async _loadRecords(server) {
        if (typeof AesCompetitorStore === "undefined") return []
        const all = await chrome.storage.local.get(null)
        const prefix = "competitorIntel:enterprise:" + server + ":"
        const byId = new Map()
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (rec && typeof rec === "object") {
                byId.set(String(rec.enterpriseId || k.slice(prefix.length)), rec)
            }
        }
        if (typeof AesCompetitorStore.loadLegacyMonitoring === "function") {
            const legacy = await AesCompetitorStore.loadLegacyMonitoring(server, all)
            for (const rec of legacy) {
                if (!rec || !rec.enterpriseId) continue
                const id = String(rec.enterpriseId)
                if (!byId.has(id)) byId.set(id, rec)
            }
        }
        return Array.from(byId.values())
    }

    static async _loadSnapshotsSafe(server, enterpriseId) {
        if (typeof AesCompetitorSnapshotStore === "undefined") return []
        try { return await AesCompetitorSnapshotStore.loadHistory(server, enterpriseId) }
        catch (_) { return [] }
    }

    static _safeScore(input) {
        if (typeof AesCompetitorThreatScorer === "undefined") {
            return {score: 0, bucket: "low", components: {}, rationale: ["scorer unavailable"], flags: {}}
        }
        try { return AesCompetitorThreatScorer.score(input) }
        catch (_) {
            return {score: 0, bucket: "low", components: {}, rationale: ["scorer threw"], flags: {}}
        }
    }

    static _asSet(arr) {
        const out = new Set()
        if (!Array.isArray(arr)) return out
        for (const v of arr) if (v != null) out.add(String(v))
        return out
    }
}

if (typeof window !== "undefined") {
    window.AesCompetitorWatchlist = AesCompetitorWatchlist
}
