"use strict"

/**
 * AES Strategy — alliance & IL codeshare proposer (Slice 12).
 *
 * Pure function over `snapshot` (extended in context.js with
 * `snapshot.alliance`). Reads our alliance membership and contractual
 * partners, scans the competitor-intel cache for non-partner enterprises,
 * and ranks candidates by:
 *
 *   score = 4·feedToHub + 1.5·newReach − 5·overlapDom
 *
 * Where:
 *   feedToHub  = does the rival hub overlap any of our hubs? (0/1)
 *   newReach   = |rivalDests \ ourDests|     (destinations they'd add)
 *   overlapDom = |rivalDests ∩ ourDests|     (routes we already contest)
 *
 * Same coefficients as `world-view/recommend-interline.js` so the
 * Strategy panel and the World View tile rank the same candidates the
 * same way. The proposer doesn't reuse `recommend-interline.js`
 * directly because that module wants a fully-built `network` object —
 * a world-view artefact this proposer can't easily reconstruct from
 * the strategy snapshot alone. Duplicating the formula keeps both
 * surfaces independent and verifies the math by symmetry.
 *
 * Two move kinds shipped:
 *   il-request    — propose a bilateral IL agreement with a non-partner
 *   alliance-join — propose joining an alliance whose members already
 *                   feed our hubs (bucketed by alliance.id)
 *
 * Output shape — `AllianceMove`:
 *   {kind:                "il-request" | "alliance-join",
 *    partnerEnterpriseId, partnerName, allianceName?, allianceId?,
 *    hub:                 string | null,        // hub the partner feeds
 *    feedToHub, newReach, overlapDom,
 *    score, rationale: [...],
 *    source:              "alliance"}
 *
 * v1 read-only: surfaces recommendations only. The applier
 * (modules/alliance/il-request-applier.js) handles the optional POST
 * with its own two-gate model. Per spec: "IL agreements are POST-able
 * but require both parties to accept; engine can't unilaterally form."
 *
 * Public API:
 *   AesStrategy.proposeAllianceMoves(snapshot, opts?) →
 *     Promise<AllianceMove[]>
 *
 * Opts (all optional):
 *   {minNewReach: 4, maxOverlapFraction: 0.35, maxProposalsPerCall: 8,
 *    minAllianceMembers: 2, maxAllianceProposals: 3}
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeAllianceMoves === "function") return

    const DEFAULTS = Object.freeze({
        minNewReach:           4,
        maxOverlapFraction:    0.35,
        maxProposalsPerCall:   8,
        minAllianceMembers:    2,
        maxAllianceProposals:  3
    })

    const COMPETITOR_ENTERPRISE_PREFIX = "competitorIntel:enterprise:"

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }
    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }
    function _upper(s) { return String(s == null ? "" : s).toUpperCase().trim() }

    function _resolveOpts(opts) {
        const o = opts || {}
        return {
            minNewReach:          _num(o.minNewReach,          DEFAULTS.minNewReach),
            maxOverlapFraction:   _num(o.maxOverlapFraction,   DEFAULTS.maxOverlapFraction),
            maxProposalsPerCall:  _num(o.maxProposalsPerCall,  DEFAULTS.maxProposalsPerCall),
            minAllianceMembers:   _num(o.minAllianceMembers,   DEFAULTS.minAllianceMembers),
            maxAllianceProposals: _num(o.maxAllianceProposals, DEFAULTS.maxAllianceProposals)
        }
    }

    /**
     * Walk competitorIntel:enterprise:<server>:* cache. Returns the
     * non-self enterprise records as an array. Best-effort — failure
     * returns [] so the proposer degrades gracefully.
     *
     * Uses the prefix-store helper when available; falls back to a
     * direct chrome.storage.local.get(null) + filter when the helper
     * isn't loaded (e.g. running under stub Node smoke).
     */
    async function _loadCandidatePool(server, ourEnterpriseId) {
        if (!server) return []
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return []
        const wantOurId = ourEnterpriseId != null ? String(ourEnterpriseId) : null
        const fullPrefix = COMPETITOR_ENTERPRISE_PREFIX + server + ":"
        const out = []
        try {
            const all = await chrome.storage.local.get(null)
            for (const k in all) {
                if (k.indexOf(fullPrefix) !== 0) continue
                const rec = all[k]
                if (!rec || !rec.enterpriseId) continue
                if (wantOurId && String(rec.enterpriseId) === wantOurId) continue
                out.push(rec)
            }
        } catch (_) {}
        return out
    }

    function _myDestSet(snapshot) {
        const out = new Set()
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            const d = _upper(r && r.dest)
            if (d) out.add(d)
        }
        return out
    }

    function _myHubSet(snapshot) {
        const out = new Set()
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) {
            const i = _upper(h && h.iata)
            if (i) out.add(i)
        }
        return out
    }

    function _rivalDestSet(rec) {
        const out = new Set()
        const fp = (rec && Array.isArray(rec.routeFootprint)) ? rec.routeFootprint : []
        for (const r of fp) {
            const i = _upper(r && (r.destIata || r.dest || r.iata))
            if (i) out.add(i)
        }
        return out
    }

    function _rivalHubSet(rec) {
        const out = new Set()
        const hubs = (rec && Array.isArray(rec.hubs)) ? rec.hubs : []
        for (const h of hubs) {
            const i = _upper(h && (h.iata || h))
            if (i) out.add(i)
        }
        return out
    }

    function _scoreRival(rec, myHubs, myDests, opts) {
        const rivalHubs = _rivalHubSet(rec)
        const rivalDests = _rivalDestSet(rec)
        let newReach = 0
        for (const d of rivalDests) if (!myDests.has(d)) newReach++
        let overlapDom = 0
        for (const d of rivalDests) if (myDests.has(d)) overlapDom++
        const overlapFraction = overlapDom / Math.max(1, rivalDests.size)
        let feedToHub = 0
        let feedHub = null
        for (const h of rivalHubs) if (myHubs.has(h)) { feedToHub = 1; feedHub = h; break }

        if (newReach < opts.minNewReach) return null
        if (overlapFraction > opts.maxOverlapFraction) return null
        const score = 4 * feedToHub + 1.5 * newReach - 5 * overlapDom
        if (score <= 0) return null
        return {score, feedToHub, newReach, overlapDom, overlapFraction, feedHub, rivalDests, rivalHubs}
    }

    function _ilRequestRationale(rec, sig) {
        const name = (rec && rec.name) || "this carrier"
        const head = name + " adds " + sig.newReach + " destination"
            + (sig.newReach === 1 ? "" : "s") + " you don't fly"
        const feed = sig.feedToHub
            ? " and feeds them via your hub at " + sig.feedHub
            : ""
        const contested = sig.overlapDom > 0
            ? "; you currently contest " + sig.overlapDom + " of their routes"
                + " (" + Math.round(sig.overlapFraction * 100) + "%)"
            : ""
        const score = "[score] feed=" + sig.feedToHub
            + " · newReach=" + sig.newReach
            + " · overlap=" + sig.overlapDom
            + " → " + _round(sig.score, 2)
        return [head + feed + contested + ".", score]
    }

    function _ilRequestMoves(snapshot, candidates, opts) {
        const myHubs = _myHubSet(snapshot)
        const myDests = _myDestSet(snapshot)
        const partnerIds = (snapshot.alliance && snapshot.alliance.partnerIds) || new Set()
        const myAllianceMemberIds = (snapshot.alliance && snapshot.alliance.allianceMemberIds) || new Set()
        const out = []
        for (const rec of candidates) {
            const id = String(rec.enterpriseId)
            if (partnerIds.has(id)) continue                 // already a partner
            if (myAllianceMemberIds.has(id)) continue        // already an alliance peer
            const sig = _scoreRival(rec, myHubs, myDests, opts)
            if (!sig) continue
            out.push({
                kind:                "il-request",
                partnerEnterpriseId: id,
                partnerName:         rec.name || rec.enterpriseName || ("#" + id),
                partnerIata:         rec.iata || rec.code || null,
                allianceName:        rec.alliance && (rec.alliance.name || rec.alliance.allianceName) || null,
                allianceId:          rec.alliance && (rec.alliance.id || rec.alliance.allianceId) || null,
                hub:                 sig.feedHub,
                feedToHub:           sig.feedToHub,
                newReach:            sig.newReach,
                overlapDom:          sig.overlapDom,
                score:               _round(sig.score, 2),
                rationale:           _ilRequestRationale(rec, sig),
                source:              "alliance"
            })
        }
        out.sort((a, b) => b.score - a.score)
        return out.slice(0, opts.maxProposalsPerCall)
    }

    /**
     * Bucket non-partner candidates by alliance.id, then for each
     * alliance bucket aggregate `feedToHub` (any member feeds our hub)
     * + `newReach` (union of dests we don't fly across the bucket) +
     * `overlapDom` (sum). Score per alliance with the same coefficients.
     *
     * Skip the user's own alliance (we're already in it) and alliances
     * with fewer than minAllianceMembers in the candidate pool (a
     * handful of cached members is too thin a signal).
     */
    function _allianceJoinMoves(snapshot, candidates, opts) {
        const myHubs = _myHubSet(snapshot)
        const myDests = _myDestSet(snapshot)
        const ourAllianceName = snapshot.alliance && snapshot.alliance.membership
            && (snapshot.alliance.membership.name || snapshot.alliance.membership.allianceName)
        const partnerIds = (snapshot.alliance && snapshot.alliance.partnerIds) || new Set()

        const buckets = new Map()
        for (const rec of candidates) {
            const a = rec.alliance
            const id = a && (a.id || a.allianceId)
            const name = a && (a.name || a.allianceName)
            if (!id && !name) continue
            const key = id ? "id:" + id : "name:" + name
            if (ourAllianceName && name === ourAllianceName) continue
            if (partnerIds.has(String(rec.enterpriseId))) continue
            if (!buckets.has(key)) {
                buckets.set(key, {id, name, members: [], rivalDests: new Set(),
                    rivalHubs: new Set(), feedToHub: 0, feedHub: null})
            }
            const bucket = buckets.get(key)
            bucket.members.push(rec)
            for (const d of _rivalDestSet(rec)) bucket.rivalDests.add(d)
            for (const h of _rivalHubSet(rec)) {
                bucket.rivalHubs.add(h)
                if (!bucket.feedToHub && myHubs.has(h)) {
                    bucket.feedToHub = 1
                    bucket.feedHub = h
                }
            }
        }

        const out = []
        for (const bucket of buckets.values()) {
            if (bucket.members.length < opts.minAllianceMembers) continue
            let newReach = 0, overlapDom = 0
            for (const d of bucket.rivalDests) {
                if (myDests.has(d)) overlapDom++
                else                newReach++
            }
            const overlapFraction = overlapDom / Math.max(1, bucket.rivalDests.size)
            if (newReach < opts.minNewReach) continue
            if (overlapFraction > opts.maxOverlapFraction) continue
            const score = 4 * bucket.feedToHub + 1.5 * newReach - 5 * overlapDom
            if (score <= 0) continue
            const memberNames = bucket.members.slice(0, 5).map(m => m.name || ("#" + m.enterpriseId)).join(", ")
            const rationale = [
                "alliance " + (bucket.name || "#" + bucket.id) + " — "
                    + bucket.members.length + " cached member"
                    + (bucket.members.length === 1 ? "" : "s")
                    + " add " + newReach + " new destinations"
                    + (bucket.feedToHub ? " and feed our hub at " + bucket.feedHub : ""),
                "[members] " + memberNames + (bucket.members.length > 5 ? ", …" : ""),
                "[score] feed=" + bucket.feedToHub + " · newReach=" + newReach
                    + " · overlap=" + overlapDom + " → " + _round(score, 2)
            ]
            out.push({
                kind:                "alliance-join",
                allianceId:          bucket.id || null,
                allianceName:        bucket.name || null,
                memberCount:         bucket.members.length,
                memberSampleIds:     bucket.members.slice(0, 5).map(m => String(m.enterpriseId)),
                hub:                 bucket.feedHub,
                feedToHub:           bucket.feedToHub,
                newReach:            newReach,
                overlapDom:          overlapDom,
                score:               _round(score, 2),
                rationale:           rationale,
                source:              "alliance"
            })
        }
        out.sort((a, b) => b.score - a.score)
        return out.slice(0, opts.maxAllianceProposals)
    }

    async function proposeAllianceMoves(snapshot, opts) {
        const o = _resolveOpts(opts)
        if (!snapshot || !snapshot.alliance) return []

        const candidates = await _loadCandidatePool(
            snapshot.server,
            snapshot.alliance.ourEnterpriseId
        )
        if (!candidates.length) return []

        const ilMoves       = _ilRequestMoves(snapshot, candidates, o)
        const allianceMoves = _allianceJoinMoves(snapshot, candidates, o)

        return ilMoves.concat(allianceMoves)
    }

    ns.proposeAllianceMoves = proposeAllianceMoves

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const myHubs = new Set(["JFK"])
            const myDests = new Set(["LAX", "ORD", "BOS"])
            // Direct unit-test of the pure scoring functions.
            const mockRec = {
                enterpriseId: "999",
                name: "TestAir",
                hubs: [{iata: "JFK"}],
                routeFootprint: [
                    {destIata: "DFW"}, {destIata: "MIA"},
                    {destIata: "SFO"}, {destIata: "PHX"},
                    {destIata: "LAX"}   // overlap
                ],
                alliance: {id: "AL1", name: "TestAlliance"}
            }
            const sig = _scoreRival(mockRec, myHubs, myDests,
                {minNewReach: 3, maxOverlapFraction: 0.5})
            console.assert(sig && sig.score > 0,
                "[smoke alliance] candidate with feed-to-hub + new reach scores positive")
            console.assert(sig.feedHub === "JFK",
                "[smoke alliance] feed hub identified")
            console.assert(sig.newReach === 4 && sig.overlapDom === 1,
                "[smoke alliance] reach/overlap counted from routeFootprint")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
