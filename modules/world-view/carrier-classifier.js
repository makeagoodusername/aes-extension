"use strict"

/**
 * WorldViewCarrierClassifier — builds a flight → carrier-class function
 * for use as ScheduleBuilder.computeConnections's carrierClassifier
 * callback. Mirrors RouteAssistantPanel._carrierClassifierForFlight
 * (modules/route-assistant/panel.js:6678) but is lifted out so the
 * panel instance isn't required.
 *
 * build({ownEnterpriseIds, partnerByEnterpriseId, leadByDest, fallback})
 *   returns (flight) => "own" | "interline" | "alliance" | null
 *
 * - ownEnterpriseIds: Set or array of strings (your airline + sisters).
 * - partnerByEnterpriseId: Map<enterpriseId, [relationKind]> from
 *     RouteAssistantContractualPartnersScraper.bulkLoadCache. Empty Map
 *     is fine; "unknown" partner classification falls through to
 *     fallback.
 * - leadByDest: Map<destIata, enterpriseId> — leading carrier per dest.
 * - fallback: "own" | null. Used when no leadId is known. Matches the
 *     panel.js convention of returning "own" so empty-competition
 *     routes still render, while still allowing strict consumers to
 *     drop unknowns.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewCarrierClassifier) return

    function _setOf(input) {
        if (input && typeof input.has === "function") return input
        const s = new Set()
        if (Array.isArray(input)) for (const v of input) if (v != null) s.add(String(v))
        return s
    }

    function _mapOf(input) {
        if (input && typeof input.get === "function") return input
        const m = new Map()
        if (Array.isArray(input)) {
            for (const e of input) {
                if (!e) continue
                if (Array.isArray(e) && e.length >= 2) m.set(String(e[0]), e[1])
                else if (e.id != null) m.set(String(e.id), e.rels || e.relations || [])
            }
        } else if (input && typeof input === "object") {
            for (const k of Object.keys(input)) m.set(String(k), input[k])
        }
        return m
    }

    function build(input) {
        const ownIds  = _setOf(input && input.ownEnterpriseIds)
        const partners = _mapOf(input && input.partnerByEnterpriseId)
        const leadMap = _mapOf(input && input.leadByDest)
        const fallback = (input && input.fallback === null) ? null : "own"

        return function classify(flight) {
            if (!flight) return fallback
            const isOut = flight.direction === "outbound"
            const foreignIata = String(
                isOut ? (flight.destination || "") : (flight.origin || "")
            ).toUpperCase()
            const leadId = leadMap.get(foreignIata) || null
            if (!leadId) return fallback
            const id = String(leadId)
            if (ownIds.has(id)) return "own"
            const rels = partners.get(id) || []
            const relsArr = Array.isArray(rels) ? rels : [rels]
            for (const r of relsArr) {
                const u = String(r || "").toUpperCase()
                if (u === "ALLIANCE")    return "alliance"
                if (u === "INTERLINING") return "interline"
            }
            return null
        }
    }

    /**
     * Build a leadByDest Map from a WorldViewNetwork. Uses the
     * `dominantEnterpriseId` recorded on each destination's competition
     * field. Returns an empty Map when no competitor data is present.
     */
    function leadByDestFromNetwork(network) {
        const m = new Map()
        if (!network || !Array.isArray(network.destinations)) return m
        for (const d of network.destinations) {
            const id = d && d.competition && d.competition.dominantEnterpriseId
            if (d && d.dest && id) m.set(String(d.dest).toUpperCase(), String(id))
        }
        return m
    }

    window.WorldViewCarrierClassifier = {
        build: build,
        leadByDestFromNetwork: leadByDestFromNetwork
    }
})()
