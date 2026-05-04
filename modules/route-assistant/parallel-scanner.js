/**
 * Concurrent country-fetch orchestrator for the Route Assistant.
 *
 * Given a set of destination IATAs, drives them through the resolver to learn
 * their countryId, then fetches each unique country's airports via
 * CountryScraper and writes the results to DemandStore. Concurrency-limited
 * with a stagger so we don't hit AS as a thundering herd.
 *
 * Lifecycle:
 *   const ps = new RouteAssistantParallelScanner(server, {concurrency: 3, staggerMs: 1500})
 *   ps.onProgress(p => updateUi(p))
 *   await ps.run(["JFK", "LAX", ...])
 *
 * Progress callbacks fire on every state change with:
 *   {phase: "resolving"|"fetching"|"done",
 *    total, resolved, fetched, failedIatas, currentCountryId?}
 *
 * Failures are non-fatal — an IATA that can't be resolved or whose country
 * page errors is added to `failedIatas` and the rest continue.
 *
 * Load-order: wrapped in idempotent IIFE guard (see audit FIX F-2 /
 * streamline-A7.md). Manifest currently lists this file once; the guard
 * matches the house style (silent-auto-proposers.js, AesAfpScheduleStore)
 * so any future double-listing or SPA re-injection no-ops cleanly instead
 * of throwing `SyntaxError: Identifier 'RouteAssistantParallelScanner'
 * has already been declared`.
 */
;(function () {
    const root = (typeof window !== "undefined")
        ? window
        : ((typeof globalThis !== "undefined") ? globalThis : null)
    if (typeof window !== "undefined") {
        if (window.RouteAssistantParallelScanner) return
    } else if (root && root.RouteAssistantParallelScanner) {
        return
    }

class RouteAssistantParallelScanner {
    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantParallelScanner: server required")
        this.server = server
        this.concurrency = (opts && opts.concurrency) || 3
        this.staggerMs   = (opts && opts.staggerMs)   || 1500
        this.resolver = new RouteAssistantCountryResolver(server)
        this.listeners = []
        this._aborted = false
    }

    onProgress(cb) { this.listeners.push(cb) }

    abort() { this._aborted = true }

    /**
     * One-time bulk seed: walks every country in the game world via
     * `/action/info/countries`, scrapes its airport list, and writes every
     * airport's pax/cargo demand into RouteAssistantDemandStore. This is the
     * only way to get full IATA→countryId coverage since AS has no per-IATA
     * lookup endpoint. Takes 5–15 minutes depending on country count and
     * how many have regional sub-pages (US, Canada, Russia, etc.).
     *
     * Progress callbacks fire with:
     *   {phase: "seeding"|"done", total, fetched, failedCountries,
     *    currentCountryId?, currentCountryName?}
     */
    async seedAllCountries() {
        const countries = await CountryScraper.loadCountriesList(this.server)
        const state = {
            phase: "seeding",
            total: countries.length,
            fetched: 0,
            airportsSeeded: 0,
            failedCountries: [],
            currentCountryId: null,
            currentCountryName: null
        }
        this._notify(state)
        if (!countries.length) {
            state.phase = "done"
            this._notify(state)
            return state
        }

        for (let i = 0; i < countries.length; i++) {
            if (this._aborted) break
            const c = countries[i]
            state.currentCountryId = c.id
            state.currentCountryName = c.name
            this._notify(state)
            try {
                const airports = await CountryScraper._getAllAirportsForCountry(c.id, this.server)
                if (airports && airports.length) {
                    await RouteAssistantDemandStore.saveCountryAirports(c.id, airports)
                    state.fetched++
                    state.airportsSeeded += airports.length
                } else {
                    state.failedCountries.push({id: c.id, name: c.name})
                }
            } catch (error) {
                console.warn(`[AES routeAssistant] seed country ${c.id} (${c.name}) failed`, error)
                state.failedCountries.push({id: c.id, name: c.name})
            }
            this._notify(state)
            if (i < countries.length - 1 && !this._aborted) await sleep(this.staggerMs)
        }

        state.phase = "done"
        state.currentCountryId = null
        state.currentCountryName = null
        this._notify(state)
        return state
    }

    _notify(state) {
        for (const cb of this.listeners) {
            try { cb(state) } catch (e) { console.error("ParallelScanner listener:", e) }
        }
    }

    /**
     * Resolve+scrape every IATA in the list. Returns a summary.
     */
    async run(iatas) {
        const todo = Array.from(new Set((iatas || []).map(i => String(i || "").toUpperCase())))
            .filter(Boolean)
        const state = {
            phase:        "resolving",
            total:        todo.length,
            resolved:     0,
            fetched:      0,
            failedIatas:  [],
            currentCountryId: null
        }
        if (!todo.length) {
            state.phase = "done"
            this._notify(state)
            return state
        }
        this._notify(state)

        // Phase 1: resolve every IATA → countryId. Resolution can do an HTTP
        // fetch per never-seen IATA, so we limit concurrency the same way
        // CountryScraper does internally: small batches.
        const countryToIatas = new Map()  // countryId → [iata, ...]
        const resolveQueue = todo.slice()
        const resolvers = []
        for (let i = 0; i < this.concurrency; i++) {
            resolvers.push(this._resolveWorker(resolveQueue, countryToIatas, state))
        }
        await Promise.all(resolvers)
        if (this._aborted) {
            state.phase = "done"
            this._notify(state)
            return state
        }

        // Phase 2: fetch each unique country's airport list. CountryScraper
        // already throttles its own region fetches; we sequence countries
        // with a stagger so a slow region doesn't pile up demand against AS.
        state.phase = "fetching"
        this._notify(state)

        const countries = Array.from(countryToIatas.keys())
        for (let i = 0; i < countries.length; i++) {
            if (this._aborted) break
            const countryId = countries[i]
            state.currentCountryId = countryId
            this._notify(state)
            try {
                const airports = await CountryScraper._getAllAirportsForCountry(countryId, this.server)
                if (airports && airports.length) {
                    await RouteAssistantDemandStore.saveCountryAirports(countryId, airports)
                    // Mark each requested IATA in this country as "fetched";
                    // IATAs that the country page didn't return get flagged.
                    const have = new Set(airports.map(a => String(a.iata || "").toUpperCase()))
                    for (const iata of countryToIatas.get(countryId)) {
                        if (have.has(iata)) state.fetched++
                        else state.failedIatas.push(iata)
                    }
                } else {
                    for (const iata of countryToIatas.get(countryId)) state.failedIatas.push(iata)
                }
            } catch (error) {
                console.warn(`[AES routeAssistant] country ${countryId} scrape failed`, error)
                for (const iata of countryToIatas.get(countryId)) state.failedIatas.push(iata)
            }
            this._notify(state)
            if (i < countries.length - 1) await sleep(this.staggerMs)
        }

        state.phase = "done"
        state.currentCountryId = null
        this._notify(state)
        return state
    }

    async _resolveWorker(queue, countryToIatas, state) {
        while (queue.length && !this._aborted) {
            const iata = queue.shift()
            try {
                const r = await this.resolver.resolve(iata)
                if (r && r.countryId) {
                    if (!countryToIatas.has(r.countryId)) countryToIatas.set(r.countryId, [])
                    countryToIatas.get(r.countryId).push(iata)
                    state.resolved++
                } else {
                    state.failedIatas.push(iata)
                }
            } catch (error) {
                console.warn(`[AES routeAssistant] resolve ${iata} failed`, error)
                state.failedIatas.push(iata)
            }
            this._notify(state)
        }
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

if (root) {
    root.RouteAssistantParallelScanner = RouteAssistantParallelScanner
}
})()
