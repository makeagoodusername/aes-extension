"use strict"

/**
 * AES Strategy — pure Division/Fleet membership matcher (Slice 3-4).
 *
 * Given a layered-store record (division or fleet) and a resolution
 * context, decide whether the record applies. Pure — no I/O, no DOM.
 *
 * A record carries `kind` and `members` (kind-specific shape). Caller
 * passes the resolution context with whatever it knows synchronously
 * (hub IATA, dest IATA, aircraft id, aircraft type, server, airline,
 * accountId). When the context is missing a field a kind requires,
 * that kind's matcher returns false (fold-to-no-op safety).
 *
 * Supported kinds:
 *   - "manual"          {hubs?, destinations?, routePairs?, aircraftIds?}
 *   - "region"          {regionIds[], iso2Codes?, continents?, countryIds?}
 *                       Best-effort; needs a regionIdResolver+demand
 *                       in ctx, otherwise iso2/continent/countryId
 *                       fallbacks are tried directly via ctx.
 *   - "aircraft-types"  {aircraftTypes: [typeName]}      (fleet kind)
 *   - "aircraft-cats"   {categories: ["narrow"|"wide"|"regional"|"heavy"]}
 *   - "aircraft-ids"    {aircraftIds: [tailId]}
 *   - "org-ref"         {orgId}        (fleet kind; needs ctx.orgId pre-resolved)
 *
 * Public API (window.AesStrategyLayeredMembership):
 *   matches(record, ctx)              → boolean
 *   KINDS                             → readonly list
 *   matchKind(kind, members, ctx)     → boolean
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredMembership) return

    const KINDS = [
        "manual", "region",
        "aircraft-types", "aircraft-cats", "aircraft-ids", "org-ref"
    ]

    function _arr(v) { return Array.isArray(v) ? v : [] }

    function _matchManual(members, ctx) {
        if (!members) return false
        const hubs    = _arr(members.hubs).map(String)
        const dests   = _arr(members.destinations).map(String)
        const pairs   = _arr(members.routePairs).map(String)
        const tailIds = _arr(members.aircraftIds).map(String)
        if (ctx.hub        && hubs.length    && hubs.indexOf(String(ctx.hub).toUpperCase())  >= 0) return true
        if (ctx.dest       && dests.length   && dests.indexOf(String(ctx.dest).toUpperCase()) >= 0) return true
        if (ctx.hub && ctx.dest && pairs.length) {
            const pair = String(ctx.hub).toUpperCase() + "-" + String(ctx.dest).toUpperCase()
            if (pairs.indexOf(pair) >= 0) return true
        }
        if (ctx.aircraftId && tailIds.length && tailIds.indexOf(String(ctx.aircraftId)) >= 0) return true
        return false
    }

    function _matchRegion(members, ctx) {
        // Fast paths: if the caller pre-resolved iso2/continent/countryId
        // for the relevant hub (typically origin), match directly.
        if (!members) return false
        const iso2List      = _arr(members.iso2Codes).map(s => String(s).toUpperCase())
        const continents    = _arr(members.continents).map(String)
        const countryIds    = _arr(members.countryIds).map(Number)
        const regionIds     = _arr(members.regionIds).map(String)

        if (ctx.iso2        && iso2List.length    && iso2List.indexOf(String(ctx.iso2).toUpperCase())   >= 0) return true
        if (ctx.continent   && continents.length  && continents.indexOf(String(ctx.continent))          >= 0) return true
        if (ctx.countryId != null && countryIds.length && countryIds.indexOf(Number(ctx.countryId))     >= 0) return true
        if (ctx.regionId    && regionIds.length   && regionIds.indexOf(String(ctx.regionId))            >= 0) return true

        // If the caller passed a regionIdResolver and a hub IATA, try it
        // as a last resort (still pure — caller-injected closure).
        if (regionIds.length && typeof ctx.regionIdResolver === "function" && ctx.hub) {
            try {
                const rid = ctx.regionIdResolver(ctx.hub)
                if (rid && regionIds.indexOf(String(rid)) >= 0) return true
            } catch (_) {}
        }
        return false
    }

    function _matchAircraftTypes(members, ctx) {
        if (!members || !ctx.aircraftType) return false
        const list = _arr(members.aircraftTypes).map(s => String(s).toLowerCase())
        if (!list.length) return false
        return list.indexOf(String(ctx.aircraftType).toLowerCase()) >= 0
    }

    function _matchAircraftCats(members, ctx) {
        if (!members || !ctx.aircraftCategory) return false
        const list = _arr(members.categories).map(s => String(s).toLowerCase())
        if (!list.length) return false
        return list.indexOf(String(ctx.aircraftCategory).toLowerCase()) >= 0
    }

    function _matchAircraftIds(members, ctx) {
        if (!members || !ctx.aircraftId) return false
        const list = _arr(members.aircraftIds).map(String)
        if (!list.length) return false
        return list.indexOf(String(ctx.aircraftId)) >= 0
    }

    function _matchOrgRef(members, ctx) {
        if (!members || !members.orgId || !ctx.orgId) return false
        return String(members.orgId) === String(ctx.orgId)
    }

    function matchKind(kind, members, ctx) {
        ctx = ctx || {}
        switch (kind) {
            case "manual":          return _matchManual(members, ctx)
            case "region":          return _matchRegion(members, ctx)
            case "aircraft-types":  return _matchAircraftTypes(members, ctx)
            case "aircraft-cats":   return _matchAircraftCats(members, ctx)
            case "aircraft-ids":    return _matchAircraftIds(members, ctx)
            case "org-ref":         return _matchOrgRef(members, ctx)
            default:                return false
        }
    }

    function matches(record, ctx) {
        if (!record || !record.kind) return false
        return matchKind(record.kind, record.members, ctx)
    }

    window.AesStrategyLayeredMembership = {
        KINDS:     KINDS.slice(),
        matches:   matches,
        matchKind: matchKind
    }

    // ── ?aes-debug smoke ─────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const ctxLAX = {hub: "LAX", dest: "NRT", aircraftId: "T123",
                            aircraftType: "B777-300ER", aircraftCategory: "wide",
                            iso2: "US", continent: "North America", orgId: "oA"}
            console.assert(matches({kind: "manual", members: {hubs: ["LAX"]}}, ctxLAX),
                "[membership/smoke] manual hub match")
            console.assert(matches({kind: "manual", members: {routePairs: ["LAX-NRT"]}}, ctxLAX),
                "[membership/smoke] manual route-pair match")
            console.assert(!matches({kind: "manual", members: {hubs: ["JFK"]}}, ctxLAX),
                "[membership/smoke] manual non-match")
            console.assert(matches({kind: "region", members: {iso2Codes: ["US"]}}, ctxLAX),
                "[membership/smoke] region by iso2")
            console.assert(matches({kind: "aircraft-types", members: {aircraftTypes: ["B777-300ER"]}}, ctxLAX),
                "[membership/smoke] aircraft-type match")
            console.assert(matches({kind: "aircraft-cats", members: {categories: ["wide"]}}, ctxLAX),
                "[membership/smoke] aircraft-category match")
            console.assert(matches({kind: "aircraft-ids", members: {aircraftIds: ["T123"]}}, ctxLAX),
                "[membership/smoke] aircraft-id match")
            console.assert(matches({kind: "org-ref", members: {orgId: "oA"}}, ctxLAX),
                "[membership/smoke] org-ref match")
            console.assert(!matches({kind: "org-ref", members: {orgId: "oOther"}}, ctxLAX),
                "[membership/smoke] org-ref non-match")
            console.assert(!matches(null, ctxLAX),
                "[membership/smoke] null record never matches")
            console.assert(!matches({kind: "unknown", members: {}}, ctxLAX),
                "[membership/smoke] unknown kind never matches")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
