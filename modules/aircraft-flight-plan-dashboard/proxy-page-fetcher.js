"use strict"

/**
 * AFP Dashboard — proxy page fetcher.
 *
 * GETs `/app/fleets/aircraft/<id>/0` in the background (credentials:include)
 * and parses the form context via `AesAfpFnApplier.parseFormContext` so the
 * dashboard can compose a would-be POST body without navigating the user
 * into the aircraft page.
 *
 * One-shot only in T1 — no `bulkFetch`, no concurrency limiter, no circuit
 * breaker. Those land in T2/T3 alongside the live POST path. A 60-second
 * in-memory cache keyed by aircraftId covers rapid repeat clicks (open D,
 * preview leg A, preview leg B from the same form context).
 *
 * Mirrors the GET half of `RouteAssistantPricingApplier.apply()` (markets
 * page handshake at modules/route-assistant/pricing-applier.js:443-475).
 */
class AesAfpProxyPageFetcher {
    static CACHE_TTL_MS = 60 * 1000

    constructor(server) {
        if (!server) throw new Error("AesAfpProxyPageFetcher: server required")
        this.server = server
        this._cache = new Map()  // aircraftId → {ts, formContext}
    }

    static aircraftPageUrl(server, aircraftId) {
        return "https://" + server + ".airlinesim.aero/app/fleets/aircraft/" + aircraftId + "/0"
    }

    /**
     * Fetch + parse. Returns
     *   {ok: true,  formContext, fromCache, url}
     *   {ok: false, error: {code, message, httpStatus?}, url}
     *
     * Errors mirror pricing-applier's: fetchFailed (non-2xx), fetchThrew,
     * notLoggedIn (login form in body), noFormContext (parser couldn't
     * locate the New Flight Number form on the page).
     */
    async fetchAircraftFormContext(aircraftId) {
        const url = AesAfpProxyPageFetcher.aircraftPageUrl(this.server, aircraftId)
        const cached = this._cache.get(String(aircraftId))
        if (cached && (Date.now() - cached.ts) < AesAfpProxyPageFetcher.CACHE_TTL_MS) {
            return {ok: true, formContext: cached.formContext, fromCache: true, url}
        }

        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                return {
                    ok: false,
                    url,
                    error: {
                        code:       "fetchFailed",
                        message:    "GET " + url + " returned HTTP " + resp.status,
                        httpStatus: resp.status
                    }
                }
            }
            html = await resp.text()
        } catch (e) {
            return {
                ok: false,
                url,
                error: {
                    code:    "fetchThrew",
                    message: "GET threw: " + ((e && e.message) || String(e))
                }
            }
        }

        // Login-form detection — same regex shape as pricing-applier's
        // AUTHENTICATION_RE. Cheap pre-parse check so we surface a clear
        // "sign into AS" message rather than a "couldn't find form" one.
        if (/<form[^>]+action=["'][^"']*\/login/i.test(html)) {
            return {
                ok: false,
                url,
                error: {
                    code:    "notLoggedIn",
                    message: "Aircraft page returned a login form — sign into AS in this browser tab and retry."
                }
            }
        }

        if (typeof AesAfpFnApplier === "undefined" || typeof AesAfpFnApplier.parseFormContext !== "function") {
            return {
                ok: false,
                url,
                error: {
                    code:    "applierMissing",
                    message: "AesAfpFnApplier not loaded — check manifest order on /app/fleets*."
                }
            }
        }

        const formContext = AesAfpFnApplier.parseFormContext(html)
        if (!formContext) {
            return {
                ok: false,
                url,
                error: {
                    code:    "noFormContext",
                    message: "Couldn't locate the New Flight Number form on " + url
                           + ". The aircraft may be retired or AS markup may have changed."
                }
            }
        }

        this._cache.set(String(aircraftId), {ts: Date.now(), formContext})
        return {ok: true, formContext, fromCache: false, url}
    }

    invalidate(aircraftId) {
        this._cache.delete(String(aircraftId))
    }
}

if (typeof window !== "undefined") {
    window.AesAfpProxyPageFetcher = AesAfpProxyPageFetcher
}
