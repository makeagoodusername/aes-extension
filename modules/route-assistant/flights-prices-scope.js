"use strict";

/**
 * Pure-function scope resolver for the AS `flightsPrices?adjust=true`
 * bulk panel. Translates the form filters (from / to / service profile /
 * class checkboxes) into a filtered route list the formula-bridge can
 * feed into `AesStrategy.proposePriceMoves`.
 *
 * The form's option values use a `<prefix>:<id>` encoding:
 *   `""`        → anywhere (no constraint on that side)
 *   `"a:<id>"`  → specific airport (matched by IATA code on the route record)
 *   `"c:<id>"`  → country (matched by hubCountryId / destCountryId)
 *
 * Inputs are intentionally simple data — no DOM, no async, no chrome
 * storage — so the resolver is unit-testable under Node.
 *
 * Each route in `routes` is expected to look like:
 *   {
 *     hub:              "JFK",
 *     dest:             "LAX",
 *     hubAirportId?:    3551,
 *     destAirportId?:   3395,
 *     hubCountryId?:    182,
 *     destCountryId?:   182,
 *     serviceProfileId?: 611,
 *     classes?:         ["Y", "C"]            // AS-offered cabins; class filter is honoured against this
 *   }
 *
 * Filters in `filter`:
 *   {
 *     fromCode:         "a:3551" | "c:182" | "" ,
 *     toCode:           same,
 *     serviceProfileId: "611" | "0" | 0 | "",   // 0 / "0" / "" = any
 *     classes:          ["Y", "C", "F", "Cargo"]  // subset; empty = all
 *   }
 *
 * Returns:
 *   {
 *     routes:  [<filtered route records>],
 *     classes: ["Y", "C", ...],   // class subset that survived (empty input → all four)
 *     reason:  "ok" | "noClasses" | "emptyMatch"
 *   }
 */
(function() {
    "use strict";

    const ALL_CLASSES = ["Y", "C", "F", "Cargo"];

    function parseCode(raw) {
        const s = String(raw || "").trim();
        if (!s) return { kind: "any", value: null };
        const m = /^([ac]):(.+)$/.exec(s);
        if (!m) return { kind: "any", value: null };
        return { kind: m[1] === "a" ? "airport" : "country", value: m[2] };
    }

    function airportMatch(routeIata, routeId, parsed) {
        if (parsed.kind === "any") return true;
        if (parsed.kind === "airport") {
            // Accept either numeric AS airport id OR the IATA code — the
            // form encodes the id, but a panel test fixture might pass
            // an IATA value directly.
            const a = String(routeId == null ? "" : routeId);
            const b = String(routeIata || "").toUpperCase();
            const want = String(parsed.value || "").toUpperCase();
            return (a && a === parsed.value) || (b && b === want);
        }
        // country side is matched separately
        return false;
    }

    function countryMatch(routeCountryId, parsed) {
        if (parsed.kind === "any") return true;
        if (parsed.kind === "country") {
            const a = String(routeCountryId == null ? "" : routeCountryId);
            return !!a && a === String(parsed.value);
        }
        return false;
    }

    function sideMatch(routeIata, routeAirportId, routeCountryId, parsed) {
        if (parsed.kind === "any") return true;
        if (parsed.kind === "airport") return airportMatch(routeIata, routeAirportId, parsed);
        if (parsed.kind === "country") return countryMatch(routeCountryId, parsed);
        return false;
    }

    function normaliseClassFilter(classes) {
        if (!Array.isArray(classes) || !classes.length) return ALL_CLASSES.slice();
        const set = {};
        for (const c of classes) {
            const k = String(c || "").trim();
            if (ALL_CLASSES.indexOf(k) >= 0) set[k] = true;
        }
        const out = ALL_CLASSES.filter(c => set[c]);
        return out.length ? out : ALL_CLASSES.slice();
    }

    function profileMatch(routeProfile, filterProfile) {
        const f = String(filterProfile == null ? "" : filterProfile).trim();
        if (!f || f === "0") return true;
        return String(routeProfile == null ? "" : routeProfile) === f;
    }

    function resolveScope(filter, routes) {
        const f = filter || {};
        const list = Array.isArray(routes) ? routes : [];
        const fromP = parseCode(f.fromCode);
        const toP   = parseCode(f.toCode);
        const wantClasses = normaliseClassFilter(f.classes);
        const wantClassesSet = {};
        for (const c of wantClasses) wantClassesSet[c] = true;

        const out = [];
        for (const r of list) {
            if (!r || !r.hub || !r.dest) continue;
            if (!sideMatch(r.hub,  r.hubAirportId,  r.hubCountryId,  fromP)) continue;
            if (!sideMatch(r.dest, r.destAirportId, r.destCountryId, toP))  continue;
            if (!profileMatch(r.serviceProfileId, f.serviceProfileId)) continue;
            // Class filter narrows to routes that actually offer at least
            // one of the wanted classes (so e.g. an "F-only" filter
            // doesn't list a route with no first-class cabin).
            if (Array.isArray(r.classes) && r.classes.length) {
                let any = false;
                for (const c of r.classes) {
                    if (wantClassesSet[c]) { any = true; break; }
                }
                if (!any) continue;
            }
            out.push(r);
        }
        return {
            routes:  out,
            classes: wantClasses,
            reason:  out.length ? "ok" : "emptyMatch"
        };
    }

    const api = {
        resolveScope,
        parseCode,
        normaliseClassFilter,
        ALL_CLASSES
    };

    if (typeof window !== "undefined") {
        window.RouteAssistantFlightsPricesScope = api;
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})();
