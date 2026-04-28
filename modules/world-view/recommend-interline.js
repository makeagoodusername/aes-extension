"use strict"

/**
 * WorldViewRecommendInterline — rank interline candidates for the
 * focused hub.
 *
 * For each rival airline (any cached enterprise that isn't ours and
 * isn't already a partner):
 *   feedToHub       = focusedHub ∈ rivalHubs ? 1 : 0
 *   newReach        = |rivalDests \ myDests|
 *   overlapDom      = count of myDests where dominantEnterpriseId === rival.id
 *   contestedFraction = overlapDom / |myDests|
 *
 *   Skip if contestedFraction > 0.35 or newReach < 4.
 *   score = 4·feedToHub + 1.5·newReach − 5·overlapDom
 *
 * Output: top-N candidates with rationale.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewRecommendInterline) return

    const CONTESTED_FRACTION_MAX = 0.35
    const NEW_REACH_MIN = 4

    function _norm(s) { return (s || "").toString().toUpperCase().trim() }

    function _hubsSet(rec) {
        const out = new Set()
        const hubs = (rec && Array.isArray(rec.hubs)) ? rec.hubs : []
        for (const h of hubs) {
            const i = _norm(h && h.iata)
            if (i) out.add(i)
        }
        return out
    }

    function _destSet(rec) {
        const out = new Set()
        const fp = (rec && Array.isArray(rec.routeFootprint)) ? rec.routeFootprint : []
        for (const r of fp) {
            const i = _norm(r && r.destIata)
            if (i) out.add(i)
        }
        return out
    }

    function _existingRelations(partnerCache, id) {
        if (!partnerCache || typeof partnerCache.get !== "function") return []
        return partnerCache.get(String(id)) || []
    }

    function _renderRationale(rec, parts) {
        const name = (rec && (rec.name || rec.enterpriseName)) || "this carrier"
        const head = name + " would add " + parts.newReach
            + " destination" + (parts.newReach === 1 ? "" : "s") + " you don't fly"
        const feed = parts.feedToHub
            ? " and feeds them directly into " + (parts.hub || "your hub")
            : (parts.fromIata ? " from their hub at " + parts.fromIata : "")
        const contested = parts.overlapDom > 0
            ? "; you currently contest " + parts.overlapDom + " of their routes"
                + " (" + Math.round(parts.contestedFraction * 100) + "%)"
            : ""
        return head + feed + contested + "."
    }

    function rank(input) {
        const network = input && input.network
        const enterprises = input && input.enterprises
        const partnerCache = input && input.partnerCache
        const hub = _norm(input && input.hub)
        const limit = (input && Number(input.limit)) > 0 ? Number(input.limit) : 8

        if (!network) return []
        const myDests = new Set((network.destinations || []).map(d => _norm(d && d.dest)).filter(Boolean))
        const myDestCount = Math.max(1, myDests.size)
        const ownIds = new Set(((network.carrierIndex && network.carrierIndex.ownEnterpriseIds) || []).map(String))

        // Build dominant-by-dest map for overlap counting.
        const dominantByDest = new Map()
        for (const d of (network.destinations || [])) {
            if (!d || !d.dest) continue
            const did = d.competition && d.competition.dominantEnterpriseId
            if (did) dominantByDest.set(_norm(d.dest), String(did))
        }

        const each = []
        const collect = (rec) => {
            const id = rec && (rec.enterpriseId || rec.id)
            if (id == null) return
            if (ownIds.has(String(id))) return
            const rels = _existingRelations(partnerCache, id)
            if (Array.isArray(rels)) {
                for (const r of rels) {
                    const u = String(r || "").toUpperCase()
                    if (u === "ALLIANCE" || u === "INTERLINING") return
                }
            }
            each.push({id: String(id), rec: rec})
        }
        if (enterprises && typeof enterprises.forEach === "function") {
            enterprises.forEach(rec => collect(rec))
        } else if (Array.isArray(enterprises)) {
            for (const rec of enterprises) collect(rec)
        } else if (enterprises && typeof enterprises === "object") {
            for (const k of Object.keys(enterprises)) collect(enterprises[k])
        }

        const out = []
        for (const e of each) {
            const rec = e.rec
            const rivalHubs = _hubsSet(rec)
            const rivalDests = _destSet(rec)
            const newReach = _setDifferenceSize(rivalDests, myDests)
            if (newReach < NEW_REACH_MIN) continue

            // Count routes where THIS rival is the dominant carrier on a
            // dest we serve.
            let overlapDom = 0
            dominantByDest.forEach((domId) => {
                if (domId === e.id) overlapDom++
            })
            const contestedFraction = overlapDom / myDestCount
            if (contestedFraction > CONTESTED_FRACTION_MAX) continue

            const feedToHub = rivalHubs.has(hub) ? 1 : 0
            const score = 4 * feedToHub + 1.5 * newReach - 5 * overlapDom
            if (score <= 0) continue

            const parts = {
                hub, newReach, feedToHub, overlapDom, contestedFraction,
                fromIata: rivalHubs.size ? Array.from(rivalHubs)[0] : null
            }

            out.push({
                enterpriseId: e.id,
                name: rec && (rec.name || rec.enterpriseName) || ("Enterprise " + e.id),
                iata: rec && rec.iata || null,
                allianceName: rec && rec.alliance && rec.alliance.name || null,
                hubs: Array.from(rivalHubs),
                newReach: newReach,
                feedToHub: feedToHub,
                overlapDom: overlapDom,
                contestedFraction: contestedFraction,
                score: score,
                rationale: _renderRationale(rec, parts)
            })
        }

        out.sort((a, b) => (b.score || 0) - (a.score || 0))
        return out.slice(0, limit)
    }

    function _setDifferenceSize(a, b) {
        let n = 0
        a.forEach(v => { if (!b.has(v)) n++ })
        return n
    }

    window.WorldViewRecommendInterline = {rank: rank}
})()
