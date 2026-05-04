"use strict"

/**
 * WorldViewRecommendAlliance — rank alliance fits for the focused hub.
 *
 * Input: {network, enterprises: Map<id, EnterpriseRecord>, hub}
 *   enterprises is a snapshot of every cached competitor enterprise
 *   record (from AesCompetitorStore.bulkLoadEnterprises). Each record
 *   carries `alliance.{id, name}` plus `hubs[].iata` and
 *   `routeFootprint[].destIata`.
 *
 * Score formula (from the plan):
 *   reach          = |allianceDests \ myDests|
 *   feedersAtHub   = |allianceHubs ∩ {focusedHub}|       (0 or 1+)
 *   overlapHubs    = |allianceHubs ∩ myHubsSet|
 *   contestedAt    = members we currently fight head-to-head with on a route
 *   score = reach + 8·feedersAtHub
 *         − 3·max(0, overlapHubs − feedersAtHub)
 *         − 2·contestedAt
 *
 * Returns top-N {id, name, members, reach, feedersAtHub, overlapHubs,
 * contestedAt, score, rationale, isMine, openHref}.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewRecommendAlliance) return

    function _norm(s) { return (s || "").toString().toUpperCase().trim() }

    function _allianceKey(rec) {
        if (!rec || !rec.alliance) return null
        if (rec.alliance.id != null) return String(rec.alliance.id)
        if (rec.alliance.name) return "name:" + String(rec.alliance.name).toLowerCase()
        return null
    }

    function _bucketByAlliance(enterprises) {
        const out = new Map()
        if (!enterprises) return out
        const each = (rec) => {
            if (!rec || !rec.alliance) return
            const key = _allianceKey(rec)
            if (!key) return
            const slot = out.get(key) || {
                id: rec.alliance.id != null ? String(rec.alliance.id) : null,
                name: rec.alliance.name || rec.alliance.id || "Alliance",
                members: []
            }
            slot.members.push(rec)
            out.set(key, slot)
        }
        if (typeof enterprises.forEach === "function") {
            enterprises.forEach(rec => each(rec))
        } else if (Array.isArray(enterprises)) {
            for (const rec of enterprises) each(rec)
        } else {
            for (const k of Object.keys(enterprises)) each(enterprises[k])
        }
        return out
    }

    function _unionHubs(members) {
        const out = new Set()
        for (const m of members) {
            const hubs = (m && Array.isArray(m.hubs)) ? m.hubs : []
            for (const h of hubs) {
                const i = _norm(h && h.iata)
                if (i) out.add(i)
            }
        }
        return out
    }

    function _unionDests(members) {
        const out = new Set()
        for (const m of members) {
            const fp = (m && Array.isArray(m.routeFootprint)) ? m.routeFootprint : []
            for (const r of fp) {
                const i = _norm(r && r.destIata)
                if (i) out.add(i)
            }
        }
        return out
    }

    function _contestedCount(members, network) {
        let count = 0
        const ids = new Set()
        for (const m of members) ids.add(String(m && m.enterpriseId || m.id || ""))
        ids.delete("")
        if (!ids.size || !network || !Array.isArray(network.destinations)) return 0
        for (const d of network.destinations) {
            const did = d && d.competition && d.competition.dominantEnterpriseId
            if (did && ids.has(String(did))) count++
        }
        return count
    }

    function _renderRationale(parts, alliance) {
        const reach = parts.reach
        const feeders = parts.feedersAtHub
        const dup = Math.max(0, parts.overlapHubs - parts.feedersAtHub)
        const head = (alliance.name || "Alliance") + " adds " + reach
            + " new destination" + (reach === 1 ? "" : "s")
        const feed = feeders > 0
            ? "; " + feeders + " member" + (feeders === 1 ? "" : "s") + " already operates "
                + (parts.hub || "your hub") + " as a hub"
            : ""
        const overlap = dup > 0
            ? "; " + dup + " other hub" + (dup === 1 ? "" : "s")
                + " overlap (joining duplicates capacity)"
            : ""
        const contested = parts.contestedAt > 0
            ? "; you currently fight " + parts.contestedAt
                + " of their carriers head-to-head"
            : ""
        const mine = parts.isMine ? " — already a member." : "."
        return head + feed + overlap + contested + mine
    }

    function rank(input) {
        const network = input && input.network
        const enterprises = input && input.enterprises
        const hub = _norm(input && input.hub)
        const limit = (input && Number(input.limit)) > 0 ? Number(input.limit) : 5

        if (!network) return []
        const myDests = new Set((network.destinations || []).map(d => _norm(d && d.dest)).filter(Boolean))
        const myHubsSet = new Set((network.hubs || []).map(h => _norm(h)).filter(Boolean))
        const myAllianceKey = network.myAlliance && network.myAlliance.name
            ? "name:" + String(network.myAlliance.name).toLowerCase()
            : null

        const buckets = _bucketByAlliance(enterprises)
        const out = []
        buckets.forEach((slot, key) => {
            const members = slot.members
            if (!members.length) return
            const allianceHubs = _unionHubs(members)
            const allianceDests = _unionDests(members)
            const reach = _setDifferenceSize(allianceDests, myDests)
            const feedersAtHub = allianceHubs.has(hub) ? 1 : 0
            const overlapHubs = _setIntersectionSize(allianceHubs, myHubsSet)
            const contestedAt = _contestedCount(members, network)
            const score = reach
                + 8 * feedersAtHub
                - 3 * Math.max(0, overlapHubs - feedersAtHub)
                - 2 * contestedAt
            // F-DASH-508: production AllianceOverviewScraper writes
            // network.myAlliance with `name` only; enterprise-scraper writes
            // alliance: {id, name} so bucket keys are stringified ids. The
            // legacy myAllianceKey/slot.id paths therefore never match. Add a
            // name-equal fallback so "MINE" surfaces when only names line up.
            const myName = network.myAlliance && network.myAlliance.name
                ? String(network.myAlliance.name).toLowerCase() : null
            const slotName = slot.name ? String(slot.name).toLowerCase() : null
            const isMine = myAllianceKey === key
                || (slot.id && network.myAlliance && network.myAlliance.id != null
                    && String(slot.id) === String(network.myAlliance.id))
                || (myName && slotName && myName === slotName)
            const parts = {reach, feedersAtHub, overlapHubs, contestedAt, hub, isMine}
            const rationale = _renderRationale(parts, slot)
            out.push({
                id: slot.id,
                name: slot.name,
                members: members.map(m => ({
                    enterpriseId: m && (m.enterpriseId || m.id) || null,
                    name: m && (m.name || m.enterpriseName) || null,
                    iata: m && m.iata || null
                })),
                reach: reach,
                feedersAtHub: feedersAtHub,
                overlapHubs: overlapHubs,
                contestedAt: contestedAt,
                score: score,
                rationale: rationale,
                isMine: isMine
            })
        })

        out.sort((a, b) => (b.score || 0) - (a.score || 0))
        return out.slice(0, limit)
    }

    function _setDifferenceSize(a, b) {
        let n = 0
        a.forEach(v => { if (!b.has(v)) n++ })
        return n
    }
    function _setIntersectionSize(a, b) {
        let n = 0
        a.forEach(v => { if (b.has(v)) n++ })
        return n
    }

    window.WorldViewRecommendAlliance = {rank: rank}
})()
