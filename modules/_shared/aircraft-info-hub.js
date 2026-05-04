"use strict"

/**
 * AesAircraftInfoHub — single read facade for per-aircraft identity, flights,
 * and money. Built on top of `AesFleetRoster` (identity) and the legacy
 * `<server>[<airline>]aircraftFlights<aircraftId>` / `<server>[<airline>]flightInfo<flightId>`
 * storage records written by `content_aircraftFlights.js` / `content_flightInfo.js`.
 *
 * Three jobs:
 *
 *   1. Aggregate the scattered per-aircraft state into one snapshot so other
 *      tiles + panels can ask one question instead of joining keys themselves.
 *      `getAircraft()` / `getRoster()` return everything a consumer needs to
 *      render a row.
 *
 *   2. Compute *effective* profit. The cached `aircraftFlights.profit` is only
 *      populated when the user clicks the legacy "Extract finished flight
 *      profit/loss" button on `/app/fleets/aircraft/<id>/1`. When the cached
 *      value is zero or null but per-flight `flightInfo` blobs exist, we
 *      re-derive on the fly so consumers see the real number without forcing
 *      the user to visit each aircraft page.
 *
 *   3. Backfill missing `flightInfo` blobs by fetching `/action/info/flight?id=<id>`
 *      with the user's session cookie, parsing the same `.cm` table the legacy
 *      content script reads, and writing under the existing key shape. Persists
 *      under both the airline-scoped key (current contract) and the legacy
 *      un-scoped key (back-compat for older readers). AS purges flight info
 *      after roughly 24h, so backfill returns `purged` for any flight the
 *      endpoint says doesn't exist anymore — those are skipped, not retried.
 *
 * Reads only the three legacy key families above; never touches the
 * `aircraftFlightPlan:*` namespace owned by `AesAircraftContext`.
 */
class AesAircraftInfoHub {
    static AIRCRAFT_FLIGHTS_INFIX = "aircraftFlights"
    static FLIGHT_INFO_INFIX      = "flightInfo"

    // AS frequently purges per-flight info ~24h after the flight finishes.
    // Keep an in-memory negative cache so we don't re-hit the endpoint for
    // a known-purged id during this page session. Cleared on dispose / reload.
    static _purgedFlightIds = new Set()

    static _u(s) { return String(s || "") }

    /**
     * Storage key resolution. Both shapes are written by the legacy content
     * scripts (post F-9228-807 added the airline scoping; un-scoped key kept
     * for back-compat). Reader has to consult both because either could be
     * the most recent depending on the user's airline.
     */
    static _aircraftFlightsKeys(server, airline, aircraftId) {
        const s  = AesAircraftInfoHub._u(server)
        const al = AesAircraftInfoHub._u(airline)
        const id = AesAircraftInfoHub._u(aircraftId)
        const out = []
        if (s && al && id) out.push(s + al + AesAircraftInfoHub.AIRCRAFT_FLIGHTS_INFIX + id)
        if (s && id)       out.push(s + AesAircraftInfoHub.AIRCRAFT_FLIGHTS_INFIX + id)
        return out
    }

    static _flightInfoKeys(server, airline, flightId) {
        const s  = AesAircraftInfoHub._u(server)
        const al = AesAircraftInfoHub._u(airline)
        const id = AesAircraftInfoHub._u(flightId)
        const out = []
        if (s && al && id) out.push(s + al + AesAircraftInfoHub.FLIGHT_INFO_INFIX + id)
        if (s && id)       out.push(s + AesAircraftInfoHub.FLIGHT_INFO_INFIX + id)
        return out
    }

    /**
     * Pick the airline-scoped record when present, fall back to the legacy
     * un-scoped record. Used by every per-aircraft / per-flight read.
     */
    static _readFirst(all, keys) {
        for (const k of keys) {
            if (all && all[k] != null) return {key: k, record: all[k]}
        }
        return null
    }

    /**
     * Roster: array of {aircraft snapshot}. Mirrors `getAircraft` for every
     * tail in the active airline's fleet. `airlineCode` is optional — when
     * omitted we fall back to the largest fleet (matches `AesFleetRoster.load`).
     */
    static async getRoster(server, airlineCode) {
        if (typeof window === "undefined" || !window.AesFleetRoster) return []
        const fleet = await window.AesFleetRoster.load(server, airlineCode)
        if (!fleet || !Array.isArray(fleet.aircraft) || !fleet.aircraft.length) return []

        const all = await chrome.storage.local.get(null)
        const out = []
        for (const a of fleet.aircraft) {
            if (!a || !a.aircraftId) continue
            out.push(AesAircraftInfoHub._buildSnapshot(server, fleet.airline, a, all))
        }
        return out
    }

    /**
     * One aircraft. Reads identity + flights + money from cache, computes the
     * effective profit. Pass an optional `all` (already-loaded
     * chrome.storage.local snapshot) to skip the read when the caller is
     * already iterating storage.
     */
    static async getAircraft(server, aircraftId, opts) {
        opts = opts || {}
        const airline = opts.airline || ""
        const all = opts.all || await chrome.storage.local.get(null)
        const flightsHit = AesAircraftInfoHub._readFirst(all,
            AesAircraftInfoHub._aircraftFlightsKeys(server, airline, aircraftId))
        const flightsRec = flightsHit ? flightsHit.record : null
        const identity = {
            aircraftId:   String(aircraftId),
            registration: flightsRec && flightsRec.registration || null,
            equipment:    flightsRec && flightsRec.equipment || null,
            airline:      flightsRec && flightsRec.airline || airline || null,
            server:       server || null
        }
        return AesAircraftInfoHub._buildSnapshot(server, identity.airline, identity, all)
    }

    /**
     * Build the snapshot from an identity record (may come from fleet roster
     * or from the per-aircraft flights blob). `all` is the already-loaded
     * chrome.storage.local map so we don't re-read inside a tight loop.
     */
    static _buildSnapshot(server, airline, identity, all) {
        const aircraftId = AesAircraftInfoHub._u(identity.aircraftId)
        const flightsHit = AesAircraftInfoHub._readFirst(all,
            AesAircraftInfoHub._aircraftFlightsKeys(server, airline, aircraftId))
        const rec = flightsHit ? flightsHit.record : null
        const cachedProfit = rec && Number(rec.profit)
        const flightsArr = (rec && Array.isArray(rec.flights)) ? rec.flights : []

        // Re-derive from per-flight blobs whenever the cached value is missing
        // or zero. A real-world zero-profit aircraft is rare but possible, so
        // we still surface the derived figure as authoritative when present —
        // re-derivation reuses the same per-flight CM5.Total summing the
        // legacy panel does, so the values agree.
        let derived = AesAircraftInfoHub._sumProfitFromFlights(server, airline, flightsArr, all)
        let effectiveProfit = null
        let profitSource    = "none"
        let coveredFlights  = 0
        let totalFinished   = 0
        for (const f of flightsArr) {
            if (f && (f.status === "finished" || f.status === "inflight")) totalFinished++
        }

        if (derived.coveredFlights > 0) {
            effectiveProfit = derived.profit
            coveredFlights  = derived.coveredFlights
            profitSource    = (totalFinished > 0 && coveredFlights >= totalFinished)
                ? "rederived" : "rederived-partial"
        } else if (Number.isFinite(cachedProfit) && cachedProfit !== 0) {
            effectiveProfit = cachedProfit
            profitSource    = "cached"
        } else if (Number.isFinite(cachedProfit) && cachedProfit === 0 && totalFinished === 0) {
            // Aircraft has flown nothing yet. A real zero, not a missing read.
            effectiveProfit = 0
            profitSource    = "no-flights"
        }

        return {
            aircraftId,
            server,
            airline:         airline || (rec && rec.airline) || null,
            registration:    (rec && rec.registration) || identity.registration || null,
            equipment:       (rec && rec.equipment) || identity.equipment || null,
            fleet:           (rec && rec.fleet) || identity.fleet || null,
            // Money
            cachedProfit:    Number.isFinite(cachedProfit) ? cachedProfit : null,
            effectiveProfit,
            profitSource,
            // Flight counts
            totalFlights:    rec ? rec.totalFlights : null,
            finishedFlights: rec ? rec.finishedFlights : null,
            profitFlights:   rec ? rec.profitFlights : null,
            coveredFlights,
            missingFlightInfo: Math.max(0, totalFinished - coveredFlights),
            // Stamp
            scrapedDate:     rec ? rec.date : null,
            scrapedTime:     rec ? rec.time : null,
            // Raw flights array — callers may iterate to render per-flight rows
            flights:         flightsArr,
            // Reusable cache key the writer wrote under (for debug + storage events)
            _aircraftFlightsKey: flightsHit ? flightsHit.key : null
        }
    }

    /**
     * Sum CM5.Total across the per-flight blobs we have for the supplied
     * flights array. Returns {profit, coveredFlights, missingFlightIds}.
     */
    static _sumProfitFromFlights(server, airline, flightsArr, all) {
        let profit = 0
        let coveredFlights = 0
        const missing = []
        for (const f of flightsArr) {
            if (!f || (f.status !== "finished" && f.status !== "inflight")) continue
            const fid = f.flightId
            if (fid == null) continue
            const hit = AesAircraftInfoHub._readFirst(all,
                AesAircraftInfoHub._flightInfoKeys(server, airline, fid))
            const blob = hit ? hit.record : null
            const total = blob && blob.money && blob.money.CM5
                ? Number(blob.money.CM5.Total) : NaN
            if (Number.isFinite(total)) {
                profit += total
                coveredFlights++
            } else {
                missing.push(fid)
            }
        }
        return {profit, coveredFlights, missingFlightIds: missing}
    }

    /**
     * Backfill missing per-flight money blobs for one aircraft by fetching
     * `/action/info/flight?id=<id>` and parsing the `.cm` table. Persists
     * under both airline-scoped and legacy keys so existing readers + the
     * recompute path both see the new data on next read.
     *
     * Throttled so a 50-flight aircraft doesn't slam AS in parallel; AS rate-
     * limits aggressively on `/action/info/flight`. Default 4 in flight,
     * 250ms stagger.
     *
     * @param {string} server
     * @param {string|number} aircraftId
     * @param {object} [opts]
     * @param {string} [opts.airline]
     * @param {number} [opts.concurrency=3]
     * @param {number} [opts.staggerMs=250]
     * @param {number} [opts.maxFetches=200]   — hard ceiling per call
     * @param {boolean}[opts.recomputeProfit=true]
     * @returns {Promise<{fetched, alreadyHad, purged, errors, profit, coveredFlights, totalFinished}>}
     */
    static async backfillProfit(server, aircraftId, opts) {
        opts = opts || {}
        const airline      = opts.airline || ""
        const concurrency  = Math.max(1, Math.min(8, opts.concurrency || 3))
        const staggerMs    = Math.max(0, opts.staggerMs == null ? 250 : opts.staggerMs)
        const maxFetches   = Math.max(0, opts.maxFetches == null ? 200 : opts.maxFetches)
        const recompute    = opts.recomputeProfit !== false

        const summary = {
            aircraftId: String(aircraftId), server,
            fetched: 0, alreadyHad: 0, purged: 0, errors: 0,
            profit: null, coveredFlights: 0, totalFinished: 0
        }
        if (!server || !aircraftId) return summary

        let all = await chrome.storage.local.get(null)
        const flightsHit = AesAircraftInfoHub._readFirst(all,
            AesAircraftInfoHub._aircraftFlightsKeys(server, airline, aircraftId))
        const rec = flightsHit ? flightsHit.record : null
        if (!rec || !Array.isArray(rec.flights) || !rec.flights.length) return summary
        const recAirline = rec.airline || airline || ""

        const targets = []
        for (const f of rec.flights) {
            if (!f || (f.status !== "finished" && f.status !== "inflight")) continue
            summary.totalFinished++
            const fid = f.flightId
            if (fid == null) continue
            const hit = AesAircraftInfoHub._readFirst(all,
                AesAircraftInfoHub._flightInfoKeys(server, recAirline, fid))
            if (hit && hit.record && hit.record.money && hit.record.money.CM5) {
                summary.alreadyHad++
                continue
            }
            if (AesAircraftInfoHub._purgedFlightIds.has(String(fid))) {
                summary.purged++
                continue
            }
            targets.push(fid)
            if (targets.length >= maxFetches) break
        }
        if (!targets.length) {
            // Nothing to fetch; still honour `recomputeProfit` so the caller
            // gets a fresh effective-profit number based on cached blobs.
            if (recompute) {
                const sum = AesAircraftInfoHub._sumProfitFromFlights(server, recAirline, rec.flights, all)
                summary.profit = sum.profit
                summary.coveredFlights = sum.coveredFlights
                if (sum.coveredFlights > 0) {
                    await AesAircraftInfoHub._writeBackProfit(flightsHit.key, rec, sum.profit, sum.coveredFlights)
                }
            }
            return summary
        }

        // Drain the queue with bounded concurrency.
        let cursor = 0
        const runOne = async () => {
            while (cursor < targets.length) {
                const idx = cursor++
                const fid = targets[idx]
                if (idx > 0 && staggerMs) {
                    await new Promise(r => setTimeout(r, staggerMs))
                }
                try {
                    const result = await AesAircraftInfoHub.fetchFlightMoney(server, fid, {airline: recAirline})
                    if (result.purged) {
                        AesAircraftInfoHub._purgedFlightIds.add(String(fid))
                        summary.purged++
                    } else if (result.money) {
                        summary.fetched++
                    } else {
                        summary.errors++
                    }
                } catch (_) {
                    summary.errors++
                }
            }
        }
        const workers = []
        for (let i = 0; i < concurrency; i++) workers.push(runOne())
        await Promise.all(workers)

        if (recompute) {
            // Re-load storage so we see the writes we just made.
            all = await chrome.storage.local.get(null)
            const sum = AesAircraftInfoHub._sumProfitFromFlights(server, recAirline, rec.flights, all)
            summary.profit = sum.profit
            summary.coveredFlights = sum.coveredFlights
            if (sum.coveredFlights > 0) {
                await AesAircraftInfoHub._writeBackProfit(flightsHit.key, rec, sum.profit, sum.coveredFlights)
            }
        }
        return summary
    }

    /**
     * Fetch `/action/info/flight?id=<flightId>` and parse the `.cm` table.
     * Persists to the legacy key shape so the existing reader on the
     * aircraft-flights page sees the same data on next mount. Returns
     * `{money, purged}` — `purged: true` when AS responded with the
     * "Flight information cannot be displayed!" page (typical 24h+).
     */
    static async fetchFlightMoney(server, flightId, opts) {
        opts = opts || {}
        const airline = opts.airline || ""
        const url = "https://" + AesAircraftInfoHub._u(server)
            + ".airlinesim.aero/action/info/flight?id=" + encodeURIComponent(String(flightId))
        let html
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return {money: null, purged: false, error: "HTTP " + resp.status}
            html = await resp.text()
        } catch (e) {
            return {money: null, purged: false, error: String(e && e.message || e)}
        }
        // Quick string probe to detect the "doesn't exist" page before parsing.
        if (/Flight information cannot be displayed/i.test(html)
                || /requested flight doesn't exist/i.test(html)) {
            return {money: null, purged: true}
        }
        const doc = new DOMParser().parseFromString(html, "text/html")
        const cmRows = doc.querySelectorAll(".cm")
        if (!cmRows.length) {
            // Page returned but lacks the financials block — could be a foreign
            // flight not visible to us. Treat as purged so we don't loop on it.
            return {money: null, purged: true}
        }
        const money = {}
        const cells = ["Y", "C", "F", "PAX", "Cargo", "Total"]
        for (let i = 0; i < cmRows.length; i++) {
            const cmKey = "CM" + (i + 1)
            const tds = cmRows[i].querySelectorAll("td")
            const slot = {}
            for (let j = 0; j < cells.length && j < tds.length; j++) {
                slot[cells[j]] = AesAircraftInfoHub._parseAsMoney(tds[j].textContent)
            }
            money[cmKey] = slot
        }
        const blob = {
            server,
            flightId: Number(flightId),
            type: "flightInfo",
            money,
            // The legacy writer also stores date/time; we don't have a server
            // clock here so use ISO from the page if available, else now().
            date: AesAircraftInfoHub._parseDateFromDoc(doc),
            time: null,
            source: "aircraft-info-hub"
        }
        const writes = {}
        if (server && airline)  writes[server + airline + "flightInfo" + flightId] = blob
        if (server)             writes[server + "flightInfo" + flightId] = blob
        try {
            await chrome.storage.local.set(writes)
        } catch (_) { /* quota / context invalidation — caller still gets the money back */ }
        return {money, purged: false}
    }

    /**
     * Re-write the parent aircraftFlights record so cached `profit` /
     * `profitFlights` reflect the freshly-derived total. Other tiles + the
     * legacy panel pick up the change on next storage read.
     */
    static async _writeBackProfit(key, rec, profit, coveredFlights) {
        if (!key || !rec) return
        const next = Object.assign({}, rec, {
            profit:        Math.round(profit),
            profitFlights: coveredFlights,
            // Stamp so downstream readers know who computed it last.
            profitSource:  "aircraft-info-hub"
        })
        try {
            await chrome.storage.local.set({[key]: next})
        } catch (_) { /* ignore — read path will just re-derive next time */ }
    }

    static _parseAsMoney(text) {
        if (text == null) return null
        // "+88,373 AS$" / "-12,345 AS$" / "0 AS$"
        const m = /(-?[\d.,]+)/.exec(String(text).replace(/[^\d.,\s+\-]/g, " "))
        if (!m) return null
        const raw = m[1].replace(/,/g, "")
        const n = Number(raw)
        return Number.isFinite(n) ? n : null
    }

    static _parseDateFromDoc(doc) {
        // Best-effort — the modal title isn't stable. Just stamp now() so the
        // record carries a recency hint without inventing a fake date.
        try {
            const d = new Date()
            return d.toISOString().slice(0, 10).replace(/-/g, "")
        } catch (_) { return null }
    }

    /**
     * Subscribe to storage changes that affect aircraft info on `server`.
     * Fires on aircraftFleet / aircraftFlights / flightInfo writes for the
     * server. Returns an unsubscribe function.
     */
    static subscribe(server, callback) {
        if (typeof callback !== "function") return () => {}
        const listener = (changes, area) => {
            if (area !== "local") return
            for (const k in changes) {
                if (server && k.indexOf(server) !== 0) continue
                if (k.indexOf(AesAircraftInfoHub.AIRCRAFT_FLIGHTS_INFIX) >= 0
                        || k.indexOf(AesAircraftInfoHub.FLIGHT_INFO_INFIX) >= 0
                        || k.lastIndexOf("aircraftFleet") === k.length - "aircraftFleet".length) {
                    try { callback(k) } catch (_) { /* swallow */ }
                    return
                }
            }
        }
        try { chrome.storage.onChanged.addListener(listener) }
        catch (_) { return () => {} }
        return () => {
            try { chrome.storage.onChanged.removeListener(listener) } catch (_) { /* noop */ }
        }
    }
}

if (typeof window !== "undefined") {
    window.AesAircraftInfoHub = AesAircraftInfoHub
}
