"use strict"

/**
 * Slice C — Route Candidate Generator for the Aircraft Flight Plan Assistant.
 *
 * Mounts on `/app/fleets/aircraft/<id>/0*` via the AFP family content-script
 * block. Subscribes to Slice A's `ctx:ready` and Slice B's `spec:resolved`
 * bus events, computes a scored, range-filtered list of destinations from the
 * aircraft's current location, and renders it into `AesAfp.slot("candidates")`
 * with chip filters + a sortable mini-table. Click a row → emits
 * `candidate:selected` so Slice D can pre-fill the New Flight Number form.
 *
 * Read-only against every store — Slice F handles persistence. Watchlist + the
 * distance-resolver cache are consumed defensively (`if (typeof X !==
 * "undefined")`) so this slice ships before the consolidation pass that wires
 * those modules into the manifest.
 *
 * Public API:
 *   AesAfpRouteCandidates.compute({originIata, spec, settings,
 *                                  scheduledDestSet, scheduledFlightIds})
 *     → Promise<Candidate[]>
 *   AesAfpRouteCandidates.render(host, candidates, opts) → void
 *   AesAfpRouteCandidates.last → Candidate[] | null
 *
 * Track 7 slice 7e: scheduledDestSet is now derived from
 * `AesAfpScheduleStore` (persisted by the broadcaster on the AFP page),
 * not from `AesAfp.getCurrentSchedule()` — so dimmed and locked legs
 * the legacy filter missed are now included. `scheduledFlightIds` is
 * surfaced on the candidate so a future "Replace this flight" CTA can
 * locate the leg without re-scraping. The store is watched via
 * chrome.storage.onChanged AND the in-page bus `schedule:updated`
 * event so cross-tab + same-tab updates both repaint.
 *
 * Candidate shape:
 *   {destIata, destName, distanceKm, distanceNm, paxScore, cargoScore,
 *    weeklyFlights, seatsPerWeek, airlineCount,
 *    fits: "fit"|"tight"|"oor"|"unknown", scoreBlend, alreadyScheduled, notes,
 *    score (alias of scoreBlend), aircraftFit ("optimal"|"falloff"|"oor"|null)}
 *
 * Bus contract:
 *   in:  ctx:ready, spec:resolved
 *   out: candidates:updated {candidates}, candidate:selected {candidate, source}
 */
;(function () {
    const FIELD_DEFS = [
        {field: "paxScore",      direction: "higher"},
        {field: "cargoScore",    direction: "higher"},
        {field: "weeklyFlights", direction: "higher"},
        {field: "airlineCount",  direction: "lower"}
    ]
    const TOP_N_CYCLE = [5, 10, 25, 50, "all"]
    const SORTABLE_COLUMNS = [
        {key: "destIata",      label: "DEST",  natural: "asc"},
        {key: "distanceKm",    label: "Dist",  natural: "asc"},
        {key: "blockMin",      label: "Time",  natural: "asc"},
        {key: "paxScore",      label: "Pax",   natural: "desc"},
        {key: "cargoScore",    label: "Cargo", natural: "desc"},
        {key: "weeklyFlights", label: "Wkly",  natural: "desc"},
        {key: "airlineCount",  label: "Air",   natural: "asc"},
        {key: "sizeOrder",     label: "Size",  natural: "desc"},
        {key: "fuelKgRT",      label: "Fuel",  natural: "asc"},
        {key: "alphaY",        label: "αY",    natural: "desc"},
        {key: "scoreBlend",    label: "Score", natural: "desc"}
    ]
    const SIZE_ORDER = {S: 1, M: 2, L: 3, XL: 4}
    const SIZE_COLOR = {S: "#fca5a5", M: "#fcd34d", L: "#86efac", XL: "#7dd3fc"}
    // Lazy-fetch dedupe — set of airportIds we've already kicked off
    // a metadata scrape for in this page session. Keeps reruns idempotent
    // even when the user toggles chips or sorts.
    const _metaInflight = new Set()
    // 1 L Jet A ≈ 0.8 kg — same constant the AS Performance Check tool uses
    // when it converts liters to mass for payload planning.
    const KG_PER_LITRE_JETA = 0.8

    const HHMM_RE = /^(\d{1,2}):(\d{2})$/
    const FALLBACK_DEP_TIME = "09:00"

    let _ffCtrl = null

    /** "3:42" — minutes-into-day duration → h:mm. */
    function _fmtBlockMin(min) {
        if (min == null || !isFinite(min)) return "—"
        const h = Math.floor(min / 60)
        const m = min % 60
        return h + ":" + String(m).padStart(2, "0")
    }

    const AesAfpRouteCandidates = {
        last:          null,
        _lastFfData:   null,
        _lastCtx:      null,
        _lastHost:     null,
        _chipState:    null,    // {rangeFitOnly, hideAlreadyScheduled, watchlistOnly, topN}
        _sortState:    {field: "scoreBlend", dir: "desc"},
        _watchlistKeys: null,   // Set<"<HUB>-<DEST>"> | null when store unavailable
        _pendingTimer: 0,
        // Per-row HH:MM picker default — refreshed lazily from
        // AesAfpSettings.defaultDepartureTime so the user's preferred
        // departure flows through the candidate-list click → form-fill path
        // (form-driver applies the same fallback for safety).
        _defaultDepTime: FALLBACK_DEP_TIME,
        _depTimeLoaded: false,

        async compute(opts) {
            const originIata = String((opts && opts.originIata) || "").toUpperCase()
            const spec       = (opts && opts.spec) || null
            const settings   = (opts && opts.settings) || null
            const scheduled  = (opts && opts.scheduledDestSet) || new Set()
            // Track 7 slice 7e — surface flight ids so a future
            // "Replace this flight" CTA can locate the leg directly.
            const scheduledFlightIds = (opts && opts.scheduledFlightIds) || new Set()

            this._lastCtx    = {originIata, spec, settings, scheduledDestSet: scheduled,
                                scheduledFlightIds}
            this._lastFfData = null

            if (!originIata || !/^[A-Z]{3}$/.test(originIata)) { this.last = []; return [] }
            if (typeof FlightsFromStore         === "undefined"
             || typeof RouteAssistantDemandStore === "undefined"
             || typeof RouteAssistantScore       === "undefined"
             || typeof ScheduleFactors           === "undefined") {
                console.warn("[AES afp] route-candidates: dependency missing — bailing")
                this.last = []
                return []
            }

            const ffData = await FlightsFromStore.loadAirport(originIata)
            this._lastFfData = ffData
            const routes = (ffData && Array.isArray(ffData.routes)) ? ffData.routes : []
            if (!routes.length) { this.last = []; return [] }

            const iatas = routes.map(r => String(r.destIata || "").toUpperCase()).filter(Boolean)
            const demandMap = await RouteAssistantDemandStore.getMany(iatas)

            // Phase-3 enrichment: bulk-fetch directional α overrides; compute
            // fuel burn once from spec (constant per-aircraft) and apply per-leg.
            // Both stores are loaded by the AFP manifest entry; defensive guards
            // keep the path safe if a future build drops one.
            let alphaMap = null
            if (typeof RouteAssistantRatingAlphaStore !== "undefined") {
                try {
                    const pairs = iatas.map(d => [originIata, d])
                    alphaMap = await RouteAssistantRatingAlphaStore.getMany(pairs)
                } catch (e) { /* non-fatal — α chip stays blank */ }
            }
            let burn = null
            if (spec && typeof RouteAssistantFuelBurn !== "undefined") {
                try { burn = RouteAssistantFuelBurn.estimate({
                    typeId:        spec.typeId,
                    seats:         spec.seats,
                    cargoCapacity: spec.cargoCapacity,
                    speed:         spec.cruiseSpeedKmh
                }) }
                catch (e) { /* non-fatal */ }
            }

            // Optional cache-only distance backfill — never writes, never fetches.
            let distMap = null
            if (typeof RouteAssistantDistanceResolver !== "undefined") {
                try {
                    const pairs = iatas.map(d => [originIata, d])
                    const maxAge = (settings && typeof settings.distanceMaxAgeDays === "number")
                        ? settings.distanceMaxAgeDays : null
                    distMap = await RouteAssistantDistanceResolver.bulkLoadCache(pairs,
                        {maxAgeDays: maxAge})
                } catch (e) { /* non-fatal */ }
            }

            // Cache-only airport metadata (size / runway / noise / curfew /
            // station turnaround) keyed by airportId. Resolved via the demand
            // store which already carries airportId per IATA. Missing entries
            // are queued for a background fetch below — first paint never
            // blocks on a network round-trip.
            let airportMetaMap = null     // Map<airportId, metaRecord>
            let iataToAirportId = null    // Map<IATA, airportId> for hub + dest
            if (typeof RouteAssistantAirportMetaScraper !== "undefined") {
                try {
                    iataToAirportId = new Map()
                    if (demandMap) {
                        for (const [iata, rec] of demandMap.entries()) {
                            if (rec && rec.airportId) {
                                iataToAirportId.set(iata, String(rec.airportId))
                            }
                        }
                    }
                    const knownIds = Array.from(new Set(Array.from(iataToAirportId.values())))
                    if (knownIds.length) {
                        airportMetaMap = await RouteAssistantAirportMetaScraper.bulkLoadCache(
                            knownIds, {maxAgeDays: 30})
                    }
                } catch (e) { /* non-fatal — table renders without meta */ }
            }
            this._iataToAirportId = iataToAirportId
            this._lastAirportMeta = airportMetaMap

            // Watchlist set (defensive — chip stays inert when store missing).
            this._watchlistKeys = null
            if (typeof RouteAssistantWatchlistStore !== "undefined") {
                try { this._watchlistKeys = await RouteAssistantWatchlistStore.loadKeys() }
                catch (e) { /* non-fatal */ }
            }

            // spec.range is in km (AS UI convention — see wave-overlay.js:42-43);
            // ScheduleFactors expects nm, so convert at the boundary.
            const rangeKm = (spec && Number(spec.range)) || null
            const rangeNm = rangeKm ? ScheduleFactors.kmToNm(rangeKm) : null
            const cruiseKmh = (spec && Number(spec.cruiseSpeedKmh)) || null
            const rows = routes.map(r => this._buildRow(r, originIata, demandMap, distMap,
                rangeNm, scheduled, alphaMap, burn, airportMetaMap, iataToAirportId, cruiseKmh))

            const scoringCfg = (settings && settings.scoring) || {}
            const scored = RouteAssistantScore.computeScores(rows, scoringCfg, FIELD_DEFS)
                .map(r => {
                    const blend = (r.score == null) ? 0 : r.score
                    return Object.assign({}, r, {scoreBlend: blend, score: blend})
                })

            scored.sort((a, b) => b.scoreBlend - a.scoreBlend)

            this.last = scored
            if (window.AesAfp && AesAfp.bus) {
                AesAfp.bus.emit("candidates:updated", {candidates: scored})
            }

            this._kickAirportMetaFetch(originIata, iataToAirportId, airportMetaMap)
            return scored
        },

        /**
         * Background-fetch metadata for any airport (hub + visible destinations)
         * we don't already have a cached record for. Re-renders the table as
         * each batch lands so the user sees Size/R! cells fill in progressively.
         * Idempotent via the module-level `_metaInflight` set.
         */
        _kickAirportMetaFetch(originIata, iataToAirportId, metaMap) {
            if (typeof RouteAssistantAirportMetaScraper === "undefined") return
            if (!iataToAirportId || !iataToAirportId.size) return
            const ctx = (window.AesAfp && AesAfp.ctx) || null
            const server = ctx && ctx.server
            if (!server) return

            const have = new Set(metaMap ? metaMap.keys() : [])
            const missing = []
            for (const airportId of iataToAirportId.values()) {
                const id = String(airportId)
                if (have.has(id)) continue
                if (_metaInflight.has(id)) continue
                missing.push(id)
            }
            if (!missing.length) return

            for (const id of missing) _metaInflight.add(id)
            const scraper = new RouteAssistantAirportMetaScraper(server)
            scraper.bulkScrape(missing, {concurrency: 3, staggerMs: 800})
                .then(async () => {
                    try {
                        const fresh = await RouteAssistantAirportMetaScraper.bulkLoadCache(
                            Array.from(iataToAirportId.values()), {maxAgeDays: 30})
                        this._lastAirportMeta = fresh
                        // Re-stamp current candidates without re-scoring.
                        if (Array.isArray(this.last) && this.last.length) {
                            for (const c of this.last) {
                                const aid = iataToAirportId.get(c.destIata)
                                const meta = aid ? fresh.get(String(aid)) : null
                                this._stampMetaOnCandidate(c, meta)
                            }
                            if (window.AesAfp && AesAfp.bus) {
                                AesAfp.bus.emit("candidates:updated", {candidates: this.last})
                            }
                            this._reRender()
                        }
                    } catch (e) { /* non-fatal */ }
                    finally {
                        for (const id of missing) _metaInflight.delete(id)
                    }
                })
                .catch(() => {
                    for (const id of missing) _metaInflight.delete(id)
                })
        },

        _stampMetaOnCandidate(c, meta) {
            if (!c) return
            const sizeClass = meta && meta.sizeClass ? meta.sizeClass : null
            c.sizeClass       = sizeClass
            c.sizeOrder       = sizeClass != null ? (SIZE_ORDER[sizeClass] || null) : null
            c.runwayLengthM   = meta ? meta.runwayLengthM : null
            c.nightCurfew     = meta ? meta.nightCurfew : null
            c.curfewLabel     = meta ? meta.curfewLabel : null
            c.noiseRestricted = meta ? meta.noiseRestricted : null
            c.noiseLabel      = meta ? meta.noiseLabel : null
            c.stationTurnMin  = meta ? meta.turnaroundMin : null
        },

        _buildRow(r, originIata, demandMap, distMap, rangeNm, scheduled, alphaMap, burn,
                  airportMetaMap, iataToAirportId, cruiseKmh) {
            const destIata = String(r.destIata || "").toUpperCase()
            const demand   = demandMap && demandMap.get(destIata)
            let distanceKm = (typeof r.distanceKm === "number" && isFinite(r.distanceKm))
                ? r.distanceKm : null
            if (distanceKm == null && distMap) {
                const pairKey = (originIata < destIata)
                    ? originIata + "-" + destIata : destIata + "-" + originIata
                const cached = distMap.get(pairKey)
                if (cached && typeof cached.distanceKm === "number") distanceKm = cached.distanceKm
            }
            const distanceNm = (distanceKm != null) ? ScheduleFactors.kmToNm(distanceKm) : null
            const fits   = this._classifyFit(distanceNm, rangeNm)
            // Block time (one-way): cruiseSpeedKmh is the AS-displayed cruise
            // figure; we don't add taxi here so the column is comparable with
            // distance-only sort. Sidebar surfaces a more accurate estimate
            // via flightTimeMin() with taxi padding.
            const blockMin = (distanceKm != null && cruiseKmh != null && cruiseKmh > 0)
                ? Math.round((distanceKm / cruiseKmh) * 60) : null

            let meta = null
            if (airportMetaMap && iataToAirportId) {
                const aid = iataToAirportId.get(destIata)
                if (aid) meta = airportMetaMap.get(String(aid)) || null
            }

            // Per-route time-budget headroom: how often (per week, theoretical)
            // a single aircraft could fly this round-trip given block time and
            // the destination's turnaround. The cap ignores daily limits and
            // multi-aircraft sharing — it's the *time-feasibility* ceiling, not
            // a scheduled frequency. Long-haul routes whose round-trip + turn
            // exceeds 168h/wk yield 0; treat those as not flyable weekly.
            // Default 45 min mirrors the strategy allocator's FALLBACK_TURNAROUND_MIN
            // (different IIFE — kept literal here, not imported).
            const turnaroundMin = (meta && Number.isFinite(Number(meta.turnaroundMin)))
                ? Number(meta.turnaroundMin) : 45
            const rtHoursWithTurnaround = (blockMin != null)
                ? ((blockMin * 2) + turnaroundMin) / 60 : null
            const maxFreqByTime = (rtHoursWithTurnaround != null && rtHoursWithTurnaround > 0)
                ? Math.max(0, Math.floor(168 / rtHoursWithTurnaround)) : null
            const sizeClass = meta && meta.sizeClass ? meta.sizeClass : null
            const aircraftFit = (fits === "fit") ? "optimal"
                : (fits === "tight") ? "falloff"
                : (fits === "oor")   ? "oor" : null
            const alreadyScheduled = !!(scheduled && scheduled.has(destIata))

            const notes = []
            if (fits === "oor")     notes.push("OOR — exceeds " + (rangeNm || "?") + " nm")
            if (fits === "tight")   notes.push("Tight fit — within 5% of range")
            if (fits === "unknown") notes.push("Distance unresolved")
            if (alreadyScheduled)   notes.push("Already scheduled")
            if (!demand)            notes.push("No demand cached")

            // Round-trip fuel burn = (cycleL × 2) + perKmL × distanceKm × 2.
            // Convert L → kg with the AS-internal Jet A density. Returns null
            // when distance is unknown or spec/burn unavailable.
            let fuelKgRT = null
            if (burn && distanceKm != null) {
                const litres = (burn.cycleL * 2) + (burn.perKmL * distanceKm * 2)
                fuelKgRT = Math.round(litres * KG_PER_LITRE_JETA)
            }
            const alphaRec = alphaMap ? alphaMap.get(originIata + "-" + destIata) : null

            return {
                destIata:        destIata,
                destName:        r.destName || (demand && demand.name) || null,
                distanceKm:      distanceKm,
                distanceNm:      distanceNm,
                blockMin:        blockMin,
                rtHoursWithTurnaround: rtHoursWithTurnaround,
                maxFreqByTime:   maxFreqByTime,
                paxScore:        demand ? demand.paxScore   : null,
                cargoScore:      demand ? demand.cargoScore : null,
                weeklyFlights:   typeof r.weeklyFlights === "number" ? r.weeklyFlights : null,
                seatsPerWeek:    typeof r.seatsPerWeek    === "number" ? r.seatsPerWeek  : null,
                airlineCount:    Array.isArray(r.airlines) ? r.airlines.length : null,
                fits:            fits,
                aircraftFit:     aircraftFit,
                alreadyScheduled: alreadyScheduled,
                notes:           notes,
                fuelKgRT:        fuelKgRT,
                fuelSource:      burn ? burn.source : null,
                alphaY:          alphaRec && isFinite(Number(alphaRec.Y)) ? Number(alphaRec.Y) : null,
                alphaC:          alphaRec && isFinite(Number(alphaRec.C)) ? Number(alphaRec.C) : null,
                alphaF:          alphaRec && isFinite(Number(alphaRec.F)) ? Number(alphaRec.F) : null,
                sizeClass:        sizeClass,
                sizeOrder:        sizeClass != null ? (SIZE_ORDER[sizeClass] || null) : null,
                runwayLengthM:    meta ? meta.runwayLengthM : null,
                nightCurfew:      meta ? meta.nightCurfew : null,
                curfewLabel:      meta ? meta.curfewLabel : null,
                noiseRestricted:  meta ? meta.noiseRestricted : null,
                noiseLabel:       meta ? meta.noiseLabel : null,
                stationTurnMin:   meta ? meta.turnaroundMin : null
            }
        },

        _classifyFit(distanceNm, rangeNm) {
            if (distanceNm == null) return "unknown"
            if (!rangeNm)           return "unknown"
            if (!ScheduleFactors.aircraftCanFly(rangeNm, distanceNm)) return "oor"
            return (distanceNm > rangeNm * 0.85) ? "tight" : "fit"
        },

        render(host, candidates, opts) {
            if (!host) return
            this._lastHost = host
            this._lastCtx  = opts || this._lastCtx || {}
            this._chipState = this._chipState || this._defaultChipState(opts && opts.settings)
            host.innerHTML  = ""

            // Pick up the user's preferred default departure time once per
            // module load — non-blocking; first render uses the fallback,
            // subsequent re-renders use the cached value.
            this._loadDefaultDepTime()

            const list = Array.isArray(candidates) ? candidates : []
            if (!list.length) { this._renderEmpty(host, this._lastCtx.originIata); return }

            this._renderWaveStrip(host)
            this._renderChipBar(host)
            // Track B — wave-fit context is async (SchedulePresets.load).
            // First render returns null and kicks off a build; on completion
            // the cache fills and `_reRender` re-paints with the column.
            const waveFitCtx = this._waveFitContextOrSchedule(list)
            this._renderTable(host, list, waveFitCtx)
            this._renderFooter(host, list)
            // Track C — pick up a fleet-schedule-grid drop handoff if one is
            // pending for this aircraft. Deferred until after the table is
            // painted so the row data attributes exist for scroll-into-view.
            this._consumeDndHandoff()
        },

        /** Mount the wave-pattern overlay above the chip bar when the
         *  "🌊 Waves" chip is active. Renders into a self-contained host
         *  so the wave-strip module owns its own DOM lifecycle. */
        _renderWaveStrip(host) {
            if (!this._chipState || !this._chipState.showWaves) return
            if (typeof window.AesAfpWaveStrip === "undefined") return
            const wrap = document.createElement("div")
            wrap.dataset.aesAfpWaveStripHost = "1"
            wrap.style.cssText = "margin:0 0 6px 0;"
            host.append(wrap)
            const hub = String((this._lastCtx && this._lastCtx.originIata) || "").toUpperCase()
            window.AesAfpWaveStrip.render(wrap, hub).catch(err => {
                console.warn("[AES afp] wave-strip render threw", err)
            })
        },

        _defaultChipState(settings) {
            const afp  = (settings && settings.aircraftFlightPlan) || {}
            const chips = afp.candidateChips || {}
            return {
                rangeFitOnly:        chips.rangeFitOnly        !== false,
                hideAlreadyScheduled: chips.hideAlreadyScheduled !== false,
                watchlistOnly:       !!chips.watchlistOnly,
                showWaves:           !!chips.showWaves,
                topN:                (typeof afp.defaultTopN === "number" && afp.defaultTopN > 0)
                                         ? afp.defaultTopN : 10
            }
        },

        _renderEmpty(host, originIata) {
            const validIata = !!(originIata && /^[A-Z]{3}$/i.test(originIata))
            const iata = String(originIata || "").toUpperCase() || "—"
            const safeUrl = "https://www.flightsfrom.com/" + encodeURIComponent(iata)
            const card = document.createElement("div")
            card.style.cssText = "padding:8px;border:1px dashed #374151;border-radius:6px;"
                + "color:#9ca3af;font-size:11px;line-height:1.5;margin-top:4px;"

            const lead = document.createElement("div")
            lead.style.cssText = "font-weight:600;color:#cbd5e1;margin-bottom:3px;"
            lead.textContent = validIata
                ? "No FlightsFrom data for " + iata + "."
                : "Origin airport unknown — Slice A's ctx hasn't resolved a current location yet."
            card.append(lead)

            if (!validIata) { host.append(card); return }

            if (typeof FlightsFromController === "undefined") {
                // Defensive fallback (manifest entry must include scan-controller.js).
                const fallback = document.createElement("div")
                const link = document.createElement("a")
                link.href = safeUrl
                link.target = "_blank"
                link.rel = "noopener"
                link.style.color = "#60a5fa"
                link.textContent = "flightsfrom.com/" + iata
                fallback.append(
                    document.createTextNode("Visit "),
                    link,
                    document.createTextNode(" to seed route data, then refresh.")
                )
                card.append(fallback)
                host.append(card)
                return
            }

            const scanBtn = document.createElement("button")
            scanBtn.type = "button"
            scanBtn.dataset.aesFfScanBtn = "1"
            scanBtn.textContent = "Scan flightsfrom.com for " + iata
            scanBtn.style.cssText = "background:#1e40af;color:#dbeafe;border:1px solid #1d4ed8;"
                + "border-radius:3px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;"

            const manualLink = document.createElement("a")
            manualLink.href = safeUrl
            manualLink.target = "_blank"
            manualLink.rel = "noopener"
            manualLink.textContent = "or open flightsfrom.com/" + iata + " manually"
            manualLink.style.cssText = "color:#60a5fa;font-size:10px;"

            const statusLine = document.createElement("div")
            statusLine.dataset.aesFfStatus = "1"
            statusLine.style.cssText = "color:#9ca3af;font-size:10px;margin-top:4px;min-height:14px;"

            const actionRow = document.createElement("div")
            actionRow.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;"
            actionRow.append(scanBtn, manualLink)
            card.append(actionRow, statusLine)

            // Reflect any in-flight scan that started before this render
            // (e.g. user scrolled away and back, or this is a re-render after
            // a ctx change). Single-listener-per-page contract: the listener
            // queries _lastHost on each fire so it always targets the
            // currently-mounted empty card.
            this._ensureFfListener()
            const live = _ffCtrl && _ffCtrl.activeScan
            if (live && live.iata === iata && live.status === "running") {
                scanBtn.disabled = true
                const phase = (live.progress && live.progress.phase) || "starting"
                statusLine.textContent = "Scanning " + iata + "… (" + phase + ")"
                statusLine.style.color = "#fde68a"
            }

            scanBtn.addEventListener("click", async () => {
                scanBtn.disabled = true
                statusLine.textContent = "Opening scan tab…"
                statusLine.style.color = "#fde68a"
                try {
                    await _ffCtrl.start(iata)
                } catch (e) {
                    scanBtn.disabled = false
                    statusLine.textContent = "Scan failed: " + (e && e.message ? e.message : String(e))
                    statusLine.style.color = "#fca5a5"
                }
            })

            host.append(card)
        },

        _ensureFfListener() {
            if (_ffCtrl) return
            _ffCtrl = new FlightsFromController()
            _ffCtrl.onUpdate(scan => {
                if (!scan) return
                const host = AesAfpRouteCandidates._lastHost
                if (!host) return
                const liveStatus = host.querySelector("[data-aes-ff-status]")
                const liveBtn    = host.querySelector("[data-aes-ff-scan-btn]")
                if (scan.status === "running") {
                    if (liveBtn)    liveBtn.disabled = true
                    if (liveStatus) {
                        const phase = (scan.progress && scan.progress.phase) || "starting"
                        liveStatus.textContent = "Scanning " + scan.iata + "… (" + phase + ")"
                        liveStatus.style.color = "#fde68a"
                    }
                } else if (scan.status === "ok") {
                    if (liveStatus) {
                        liveStatus.textContent = "Done — refreshing candidates."
                        liveStatus.style.color = "#a7f3d0"
                    }
                    // The chrome.storage.onChanged listener below already
                    // triggers _scheduleRun on the data-key write. This emit
                    // is a belt-and-suspenders refresh in case the storage
                    // event arrives before the status event.
                    if (window.AesAfp && AesAfp.bus && typeof AesAfp.bus.emit === "function") {
                        try { AesAfp.bus.emit("ctx:ready", AesAfp.ctx) }
                        catch (_) { /* bus self-isolates */ }
                    }
                } else {
                    if (liveBtn) liveBtn.disabled = false
                    if (liveStatus) {
                        liveStatus.textContent = "Scan " + scan.status + ": "
                            + (scan.error || "unknown — the scrape tab was kept open for inspection.")
                        liveStatus.style.color = "#fca5a5"
                    }
                }
            })
        },

        _renderChipBar(host) {
            const state = this._chipState
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;margin:0 0 6px 0;"
                + "align-items:center;font-size:11px;"

            const mkChip = (label, active, tip, tint, onClick) => {
                const btn = document.createElement("button")
                btn.type = "button"
                btn.textContent = label
                btn.title = tip || label
                btn.style.cssText = "padding:3px 9px;border-radius:11px;font-size:11px;cursor:pointer;"
                    + "transition:background 120ms ease, color 120ms ease;"
                    + "border:1px solid " + (active ? (tint || "#60a5fa") : "#374151") + ";"
                    + "background:"        + (active ? (tint || "#1d4ed8") : "transparent") + ";"
                    + "color:"             + (active ? "#f8fafc" : "#9ca3af") + ";"
                    + "font-weight:"       + (active ? "600" : "400") + ";"
                btn.addEventListener("click", onClick)
                return btn
            }

            wrap.append(mkChip("Range-fit only", state.rangeFitOnly,
                "Drop destinations the picked aircraft can't reach (5% margin via ScheduleFactors).",
                "#166534",
                () => { state.rangeFitOnly = !state.rangeFitOnly; this._reRender() }))

            wrap.append(mkChip("Hide scheduled", state.hideAlreadyScheduled,
                "Drop destinations that already appear in the aircraft's current visual flight plan.",
                "#1e40af",
                () => { state.hideAlreadyScheduled = !state.hideAlreadyScheduled; this._reRender() }))

            const wlAvailable = !!this._watchlistKeys
                || (typeof RouteAssistantWatchlistStore !== "undefined")
            wrap.append(mkChip("★ Watchlist", state.watchlistOnly,
                wlAvailable
                    ? "Show only routes starred in the Route Assistant watchlist (click ★ on a row to add)."
                    : "Watchlist store not loaded on this page — chip is inert.",
                "#92400e",
                () => { if (wlAvailable) { state.watchlistOnly = !state.watchlistOnly; this._reRender() } }))

            const wavesAvailable = (typeof window.AesAfpWaveStrip !== "undefined")
            wrap.append(mkChip("🌊 Waves", state.showWaves,
                wavesAvailable
                    ? "Toggle the wave-pattern overlay above the table. Drag bands to move; drag edges to resize."
                    : "Wave-strip module not loaded on this page — chip is inert.",
                "#0e7490",
                () => { if (wavesAvailable) { state.showWaves = !state.showWaves; this._reRender() } }))

            const topNLabel = (state.topN === "all") ? "Top: all" : "Top " + state.topN
            wrap.append(mkChip(topNLabel + " ▾", false,
                "Cycle the result cap: 5 → 10 → 25 → 50 → all.",
                null,
                () => {
                    const i = TOP_N_CYCLE.indexOf(state.topN)
                    state.topN = TOP_N_CYCLE[(i + 1) % TOP_N_CYCLE.length]
                    this._reRender()
                }))

            host.append(wrap)
        },

        _renderTable(host, candidates, waveFitCtx) {
            const capped = this._visibleSet(candidates)

            if (!capped.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "padding:8px;color:#9ca3af;font-size:11px;font-style:italic;"
                empty.textContent = "No candidates match the current chips. Toggle one off?"
                host.append(empty)
                return
            }

            const showFit = !!(waveFitCtx && waveFitCtx.ready && waveFitCtx.fitByDest)

            const table = document.createElement("table")
            table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
                + "color:#cbd5e1;table-layout:fixed;"

            const thead = document.createElement("thead")
            const trh = document.createElement("tr")
            trh.style.cssText = "color:#9ca3af;border-bottom:1px solid #374151;"
            for (const col of SORTABLE_COLUMNS) {
                const th = document.createElement("th")
                th.style.cssText = "text-align:" + (col.key === "destIata" ? "left" : "right") + ";"
                    + "padding:3px 4px;font-weight:600;cursor:pointer;user-select:none;"
                const arrow = (this._sortState.field === col.key)
                    ? (this._sortState.dir === "desc" ? " ▾" : " ▴") : ""
                th.textContent = col.label + arrow
                th.title = "Click to sort by " + col.label
                th.addEventListener("click", () => this._handleSort(col.key))
                trh.append(th)
            }
            if (showFit) {
                const fitTh = document.createElement("th")
                fitTh.style.cssText = "text-align:right;padding:3px 4px;font-weight:600;"
                    + "user-select:none;width:60px;"
                fitTh.textContent = "Fit"
                fitTh.title = "Wave-plan fit for the active preset"
                    + (waveFitCtx.presetName ? " (" + waveFitCtx.presetName + ")" : "")
                    + " — Excellent / Good / Fair / Weak / Poor."
                trh.append(fitTh)
            }
            // Trailing non-sortable column: airport restriction icons
            // (curfew + noise). Empty when both are unknown / not flagged.
            const restrTh = document.createElement("th")
            restrTh.style.cssText = "text-align:center;padding:3px 4px;font-weight:600;"
                + "user-select:none;width:34px;"
            restrTh.textContent = "R!"
            restrTh.title = "Restrictions: 🌙 night curfew, 🔇 noise — hover a cell for details."
            trh.append(restrTh)

            // Trailing non-sortable column: per-row Departure HH:MM picker.
            // Click on the row uses this value as the candidate:selected
            // payload's depTime, which form-driver feeds into AS's form.
            const depTh = document.createElement("th")
            depTh.style.cssText = "text-align:right;padding:3px 4px;font-weight:600;"
                + "user-select:none;width:54px;"
            depTh.textContent = "Dep"
            depTh.title = "Per-row departure HH:MM. Click the row to pre-fill AS's form with this time."
            trh.append(depTh)
            thead.append(trh)
            table.append(thead)

            const tbody = document.createElement("tbody")
            capped.forEach((c, idx) => tbody.append(this._renderRow(c, idx, waveFitCtx)))
            table.append(tbody)
            host.append(table)
        },

        _renderRow(c, idx, waveFitCtx) {
            const tr = document.createElement("tr")
            tr.style.cssText = "cursor:pointer;border-bottom:1px solid #1f2937;"
                + (idx % 2 ? "background:#0f1623;" : "")
            tr.title = c.destName ? (c.destIata + " · " + c.destName) : c.destIata
            tr.dataset.aesAfpCandIata = String(c.destIata || "").toUpperCase()
            tr.addEventListener("mouseenter", () => { tr.style.background = "#1f2937" })
            tr.addEventListener("mouseleave", () => {
                tr.style.background = (idx % 2) ? "#0f1623" : ""
            })

            // F3a — drag candidate row into Flight Studio's multi-leg tray.
            // Payload mirrors the subset Flight Studio needs to seed a leg;
            // text/plain fallback keeps drops on text fields readable.
            tr.draggable = true
            tr.addEventListener("dragstart", ev => {
                const payload = {
                    destIata:   c.destIata,
                    destName:   c.destName,
                    distanceKm: c.distanceKm,
                    paxScore:   c.paxScore,
                    cargoScore: c.cargoScore
                }
                try {
                    ev.dataTransfer.setData("application/x-aes-candidate", JSON.stringify(payload))
                    ev.dataTransfer.setData("text/plain", c.destIata)
                    ev.dataTransfer.effectAllowed = "copy"
                } catch (_) { /* dataTransfer unsupported — drop quietly */ }
                tr.style.opacity = "0.6"
            })
            tr.addEventListener("dragend", () => { tr.style.opacity = "" })

            const readDepTime = () => {
                const inp = tr.querySelector(".aes-afp-row-dep")
                const raw = inp ? String(inp.value || "").trim() : ""
                return HHMM_RE.test(raw) ? raw : (this._defaultDepTime || FALLBACK_DEP_TIME)
            }
            const emit = (source) => {
                if (!window.AesAfp || !AesAfp.bus) return
                AesAfp.bus.emit("candidate:selected",
                    {candidate: c, source: source, depTime: readDepTime()})
            }
            tr.addEventListener("click", () => emit("candidate-list"))

            const tipParts = []
            if (c.notes && c.notes.length) tipParts.push(c.notes.join(" · "))
            const baseTitle = tipParts.join(" · ")

            const destCell = document.createElement("td")
            destCell.style.cssText = "padding:3px 4px;font-weight:600;color:#f8fafc;"

            const origin = String((this._lastCtx && this._lastCtx.originIata) || "").toUpperCase()
            const wlKey  = origin + "-" + c.destIata
            const starred = !!(this._watchlistKeys && this._watchlistKeys.has(wlKey))

            const star = document.createElement("span")
            star.textContent = starred ? "★" : "☆"
            star.title = (typeof RouteAssistantWatchlistStore === "undefined")
                ? "Watchlist store not loaded"
                : (starred ? "Remove from Route Assistant watchlist"
                           : "Add to Route Assistant watchlist")
            star.style.cssText = "color:" + (starred ? "#fbbf24" : "#6b7280") + ";"
                + "cursor:" + (typeof RouteAssistantWatchlistStore === "undefined" ? "default" : "pointer") + ";"
                + "margin-right:4px;font-weight:600;user-select:none;"
            star.addEventListener("click", (ev) => {
                ev.stopPropagation()
                if (typeof RouteAssistantWatchlistStore === "undefined" || !origin) return
                RouteAssistantWatchlistStore.toggle(origin, c.destIata).then(nowStarred => {
                    if (!this._watchlistKeys) this._watchlistKeys = new Set()
                    if (nowStarred) this._watchlistKeys.add(wlKey)
                    else            this._watchlistKeys.delete(wlKey)
                    star.textContent = nowStarred ? "★" : "☆"
                    star.style.color = nowStarred ? "#fbbf24" : "#6b7280"
                    star.title = nowStarred ? "Remove from Route Assistant watchlist"
                                            : "Add to Route Assistant watchlist"
                    // Re-render so the "Watchlist only" chip filter reflects the change.
                    if (this._chipState && this._chipState.watchlistOnly) this._reRender()
                }).catch(err => console.warn("[AES afp] watchlist toggle failed", err))
            })
            destCell.appendChild(star)

            const iataText = document.createElement("span")
            let glyphs = ""
            if (c.fits === "oor")           glyphs += " <span style=\"color:#f87171;\">⚠</span>"
            else if (c.fits === "tight")    glyphs += " <span style=\"color:#fbbf24;\">⏳</span>"
            if (c.alreadyScheduled)         glyphs += " <span style=\"color:#60a5fa;\">✓</span>"
            iataText.innerHTML = escapeHtml(c.destIata) + glyphs
            destCell.appendChild(iataText)
            if (baseTitle) destCell.title = baseTitle

            // F3b — ⓘ Detail button. Opens the station drawer for this dest;
            // stopPropagation keeps the row's fill-form click and the row's
            // dragstart unaffected. Hidden when the drawer module is absent
            // so an old install never shows a dead button.
            if (window.AesAfpStationDrawer && typeof AesAfpStationDrawer.open === "function") {
                const info = document.createElement("span")
                info.textContent = "ⓘ"
                info.title = "Open station detail drawer"
                info.style.cssText = "color:#6b7280;cursor:pointer;margin-left:6px;"
                    + "font-size:11px;user-select:none;"
                info.addEventListener("mouseenter", () => { info.style.color = "#60a5fa" })
                info.addEventListener("mouseleave", () => { info.style.color = "#6b7280" })
                info.addEventListener("click", (ev) => {
                    ev.stopPropagation()
                    AesAfpStationDrawer.open(c.destIata)
                })
                destCell.appendChild(info)
            }

            const distCell = this._mkNumCell(
                (c.distanceKm == null) ? "—" : Math.round(c.distanceKm).toLocaleString())

            const timeCell  = this._mkNumCell(c.blockMin == null ? "—" : _fmtBlockMin(c.blockMin))
            if (c.blockMin != null) {
                timeCell.title = "One-way block time at cruise speed (no taxi)"
            }

            const paxCell   = this._mkNumCell((c.paxScore   == null) ? "—" : ("★" + c.paxScore))
            const cargoCell = this._mkNumCell((c.cargoScore == null) ? "—" : ("★" + c.cargoScore))
            const wklyCell  = this._mkNumCell(c.weeklyFlights == null ? "—" : c.weeklyFlights)
            const airCell   = this._mkNumCell(c.airlineCount  == null ? "—" : c.airlineCount)

            const sizeCell  = this._mkNumCell(c.sizeClass == null ? "—" : c.sizeClass)
            if (c.sizeClass) {
                sizeCell.style.color      = SIZE_COLOR[c.sizeClass] || "#cbd5e1"
                sizeCell.style.fontWeight = "600"
                const tipBits = ["Airport size " + c.sizeClass]
                if (c.runwayLengthM) tipBits.push("runway " + c.runwayLengthM + " m")
                sizeCell.title = tipBits.join(" · ")
            }

            const fuelCell  = this._mkNumCell(c.fuelKgRT == null
                ? "—"
                : (c.fuelKgRT >= 1000
                    ? (c.fuelKgRT / 1000).toFixed(1) + "t"
                    : c.fuelKgRT + "kg"))
            if (c.fuelSource) fuelCell.title = "Round-trip fuel burn (" + c.fuelSource + ")"

            const alphaCell = this._mkNumCell(c.alphaY == null ? "—" : c.alphaY)
            if (c.alphaY != null || c.alphaC != null || c.alphaF != null) {
                const tipBits = []
                if (c.alphaY != null) tipBits.push("Y " + c.alphaY)
                if (c.alphaC != null) tipBits.push("C " + c.alphaC)
                if (c.alphaF != null) tipBits.push("F " + c.alphaF)
                alphaCell.title = "Per-class rating-α override · " + tipBits.join(" · ")
                alphaCell.style.color = "#fbbf24"
            }

            const scoreCell = document.createElement("td")
            scoreCell.style.cssText = "padding:3px 4px;text-align:right;font-weight:700;color:#f8fafc;"
            scoreCell.textContent = (c.scoreBlend == null) ? "—" : c.scoreBlend

            const restrCell = document.createElement("td")
            restrCell.style.cssText = "padding:3px 4px;text-align:center;width:34px;"
            const restrParts = []
            const restrTip   = []
            if (c.nightCurfew) {
                restrParts.push('<span style="color:#a78bfa;">🌙</span>')
                restrTip.push("Night curfew" + (c.curfewLabel ? " — " + c.curfewLabel : ""))
            }
            if (c.noiseRestricted) {
                restrParts.push('<span style="color:#fbbf24;">🔇</span>')
                restrTip.push("Noise restriction" + (c.noiseLabel ? " — " + c.noiseLabel : ""))
            }
            restrCell.innerHTML = restrParts.length ? restrParts.join(" ") : "—"
            if (!restrParts.length) restrCell.style.color = "#4b5563"
            if (restrTip.length) restrCell.title = restrTip.join(" · ")
            else if (c.nightCurfew == null && c.noiseRestricted == null) {
                restrCell.title = "Airport restrictions not yet loaded"
            } else {
                restrCell.title = "No noise / night-curfew restrictions"
            }

            const depCell = document.createElement("td")
            depCell.style.cssText = "padding:2px 4px;text-align:right;width:54px;"
            const depInput = document.createElement("input")
            depInput.type = "text"
            depInput.maxLength = 5
            depInput.value = this._defaultDepTime || FALLBACK_DEP_TIME
            depInput.placeholder = "hh:mm"
            depInput.className = "aes-afp-row-dep"
            depInput.title = "Departure HH:MM. Click the row to pre-fill AS's form;"
                + " edit then press Enter (or click the row) to apply."
            depInput.style.cssText = "width:48px;font-size:10px;padding:1px 3px;"
                + "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
                + "border-radius:3px;text-align:center;"
            // Don't bubble row click when interacting with the input.
            depInput.addEventListener("mousedown", ev => ev.stopPropagation())
            depInput.addEventListener("click",     ev => ev.stopPropagation())
            // Keep the input editable when the row is HTML5-draggable; without
            // this, mousedown on the input would initiate a row drag instead
            // of focusing the field for text entry / selection.
            depInput.draggable = false
            // Re-fire candidate:selected when the user commits a new value
            // (Enter or blur) so the form picks up the time without needing
            // a fresh row click.
            const fireFromInput = () => emit("candidate-list-time")
            depInput.addEventListener("change", fireFromInput)
            depInput.addEventListener("keydown", ev => {
                if (ev.key === "Enter") { ev.preventDefault(); depInput.blur() }
            })
            depCell.append(depInput)

            const showFit = !!(waveFitCtx && waveFitCtx.ready && waveFitCtx.fitByDest)
            const fitCell = showFit
                ? this._mkFitCell(waveFitCtx.fitByDest.get(String(c.destIata || "").toUpperCase()))
                : null

            const tail = [destCell, distCell, timeCell, paxCell, cargoCell, wklyCell, airCell,
                sizeCell, fuelCell, alphaCell, scoreCell]
            if (fitCell) tail.push(fitCell)
            tail.push(restrCell, depCell)
            tr.append(...tail)
            return tr
        },

        _mkFitCell(fit) {
            const td = document.createElement("td")
            td.style.cssText = "padding:3px 4px;text-align:right;width:60px;"
            if (!fit || typeof fit.fitScore !== "number") {
                td.textContent = "—"
                td.style.color = "#4b5563"
                td.title = "No wave-fit score (route not in scoring set)."
                return td
            }
            const chip = document.createElement("span")
            const color = (typeof RouteAssistantWaveRouteFitter !== "undefined")
                ? RouteAssistantWaveRouteFitter.colorForFit(fit.fitScore) : "#cbd5e1"
            const label = (typeof RouteAssistantWaveRouteFitter !== "undefined")
                ? RouteAssistantWaveRouteFitter.labelForFit(fit.fitScore) : ""
            chip.textContent = String(fit.fitScore)
            chip.style.cssText = "display:inline-block;padding:1px 5px;border-radius:8px;"
                + "background:rgba(0,0,0,0.35);border:1px solid " + color + ";"
                + "color:" + color + ";font-weight:700;font-size:10px;line-height:1.2;"
            const reasons = Array.isArray(fit.reasons) && fit.reasons.length
                ? "\n• " + fit.reasons.join("\n• ") : ""
            td.title = label + " · " + fit.category + " · " + fit.fitScore + "/100" + reasons
            td.append(chip)
            return td
        },

        _mkNumCell(text) {
            const td = document.createElement("td")
            td.style.cssText = "padding:3px 4px;text-align:right;color:#cbd5e1;"
            td.textContent = String(text)
            return td
        },

        _renderFooter(host, candidates) {
            const filtered = this._applyFilters(candidates)
            const sorted   = this._sortRows(filtered)
            const shown    = (this._chipState.topN === "all")
                ? sorted.length : Math.min(sorted.length, this._chipState.topN)
            const foot = document.createElement("div")
            foot.style.cssText = "color:#6b7280;font-size:10px;margin-top:4px;border-top:1px solid"
                + " #1f2937;padding-top:3px;"
            const sortLabel = SORTABLE_COLUMNS.find(c => c.key === this._sortState.field)
            foot.textContent = shown + " of " + filtered.length + " · sorted by "
                + (sortLabel ? sortLabel.label : this._sortState.field)
                + " " + this._sortState.dir
            host.append(foot)
        },

        _applyFilters(candidates) {
            const s = this._chipState
            const wl = this._watchlistKeys
            const origin = String((this._lastCtx && this._lastCtx.originIata) || "").toUpperCase()
            return candidates.filter(c => {
                if (s.rangeFitOnly && c.fits === "oor") return false
                if (s.hideAlreadyScheduled && c.alreadyScheduled) return false
                if (s.watchlistOnly && wl) {
                    if (!wl.has(origin + "-" + c.destIata)) return false
                }
                return true
            })
        },

        _sortRows(rows) {
            const {field, dir} = this._sortState
            const mul = dir === "desc" ? -1 : 1
            const out = rows.slice()
            out.sort((a, b) => {
                const av = a[field], bv = b[field]
                if (av == null && bv == null) return 0
                if (av == null) return 1                            // nulls always last
                if (bv == null) return -1
                if (typeof av === "string" || typeof bv === "string") {
                    return mul * String(av).localeCompare(String(bv))
                }
                return mul * (av - bv)
            })
            return out
        },

        _handleSort(key) {
            const col = SORTABLE_COLUMNS.find(c => c.key === key)
            if (!col) return
            if (this._sortState.field === key) {
                this._sortState.dir = (this._sortState.dir === "desc") ? "asc" : "desc"
            } else {
                this._sortState.field = key
                this._sortState.dir   = col.natural
            }
            this._reRender()
        },

        _reRender() {
            if (!this._lastHost) return
            this.render(this._lastHost, this.last || [], this._lastCtx)
        },

        /**
         * Track B — sync hand-off for the optional Fit column. Returns the
         * cached payload when ready, otherwise kicks off a one-shot async
         * build that calls `_reRender()` on completion. Returns null when
         * the wave-strip chip is off, the wave domain isn't loaded, or the
         * active hub has no preset — the table renders as before.
         */
        _waveFitContextOrSchedule(candidates) {
            if (!this._chipState || !this._chipState.showWaves) return null
            if (typeof RouteAssistantWaveOverlay === "undefined") return null
            if (typeof RouteAssistantWaveRouteFitter === "undefined") return null
            if (typeof SchedulePresets === "undefined") return null
            const hub = String((this._lastCtx && this._lastCtx.originIata) || "").toUpperCase()
            if (!/^[A-Z]{3}$/.test(hub)) return null

            const cacheKey = this._waveFitCacheKey(hub, candidates)
            const cache = this._waveFitCache
            if (cache && cache.key === cacheKey) return cache.payload || null
            if (this._waveFitInflight === cacheKey) return null
            this._waveFitInflight = cacheKey
            this._buildWaveFitContext(hub, candidates).then(payload => {
                if (this._waveFitInflight !== cacheKey) return
                this._waveFitInflight = null
                this._waveFitCache = {key: cacheKey, payload: payload || null}
                this._reRender()
            }).catch(err => {
                this._waveFitInflight = null
                console.warn("[AES afp] wave-fit build failed", err)
            })
            return null
        },

        _waveFitCacheKey(hub, candidates) {
            const n = candidates ? candidates.length : 0
            const head = n ? String(candidates[0].destIata || "") : ""
            const tail = n ? String(candidates[n - 1].destIata || "") : ""
            return hub + ":" + n + ":" + head + ":" + tail
        },

        async _buildWaveFitContext(hub, candidates) {
            const block = await SchedulePresets.load()
            const presets = (block && Array.isArray(block.presets)) ? block.presets : []
            if (!presets.length) return null
            let preset = block.defaultPresetId
                ? presets.find(p => p.id === block.defaultPresetId) : null
            if (!preset) preset = presets.find(
                p => String(p.hub || "").toUpperCase() === hub) || null
            if (!preset) preset = presets[0] || null
            if (!preset) return null

            // Adapt the AFP candidate shape to the scoredRow shape the wave
            // domain expects. The fitter only reads a subset of fields.
            const scoredRows = (candidates || []).map(c => ({
                destIata:      c.destIata,
                distanceKm:    c.distanceKm,
                paxScore:      c.paxScore,
                cargoScore:    c.cargoScore,
                weeklyFlights: c.weeklyFlights,
                profitPerWeek: null,
                aircraftFit:   c.fits === "oor"     ? "oor"
                            :  c.fits === "fit"     ? "optimal"
                            :  c.fits === "tight"   ? "falloff"
                            :  null
            }))
            const spec = (this._lastCtx && this._lastCtx.spec) || null
            const topN = scoredRows.length || 50
            const plan = RouteAssistantWaveOverlay.buildSchedule(preset, scoredRows, {
                hubIata:      hub,
                selectedSpec: spec,
                topN:         topN
            })
            if (!plan || !plan.preset) return null
            const ranked = RouteAssistantWaveRouteFitter.rankRoutesByPlanFit(
                scoredRows, plan, {selectedSpec: spec, hubIata: hub, topN: topN})
            const fitByDest = new Map()
            const accumulate = (entries) => {
                for (const e of entries) {
                    const d = String(e.row.destIata || "").toUpperCase()
                    if (d) fitByDest.set(d, e.fit)
                }
            }
            accumulate(ranked.inPlan)
            accumulate(ranked.candidates)
            accumulate(ranked.noFit)
            accumulate(ranked.oor)
            return {ready: true, fitByDest, presetId: preset.id, presetName: preset.name}
        },

        _invalidateWaveFitCache() {
            this._waveFitCache    = null
            this._waveFitInflight = null
        },

        /**
         * Track C — consume a `dnd-grid` handoff (set by
         * fleet-schedule-grid/dnd-drop-popover after a successful drop +
         * "Open in Flight Studio" click), scroll the matching row into
         * view, flash a highlight, and pre-fill the per-row Departure
         * input with the dropMin. The wave-applier consumer leaves
         * dnd-grid records alone so we can claim them here.
         *
         * Idempotent per page-mount via `_dndHandoffConsumed`.
         * Defensive: no AS form mutation, no candidate:selected emit —
         * this is a navigation aid only.
         */
        async _consumeDndHandoff() {
            if (typeof window.AesHandoffStore === "undefined") return
            if (this._dndHandoffConsumed) return
            const ctx = (window.AesAfp && window.AesAfp.ctx) || {}
            if (!ctx.aircraftId) return
            let rec
            try { rec = await window.AesHandoffStore.peek() }
            catch (_) { return }
            if (!rec || rec.source !== "dnd-grid") return
            if (String(rec.aircraftId) !== String(ctx.aircraftId)) return
            this._dndHandoffConsumed = true
            try { rec = await window.AesHandoffStore.consume(ctx.aircraftId) }
            catch (_) { return }
            if (!rec) return
            const dest = String(rec.destIata || "").toUpperCase()
            if (!dest) return
            const host = this._lastHost
            if (!host) return
            const row = host.querySelector('tr[data-aes-afp-cand-iata="' + dest + '"]')
            if (!row) {
                // Row may be filtered out by chip state; nudge the user toward
                // the toggles. Toast is best-effort — silent if missing.
                if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.info) {
                    try { RouteAssistantToast.info("Drag handoff: " + dest
                        + " not in current candidate filter — toggle chips to reveal.") }
                    catch (_) { /* noop */ }
                }
                return
            }
            try { row.scrollIntoView({behavior: "smooth", block: "center"}) } catch (_) {}
            const prevBg = row.style.background
            row.style.transition = "background 600ms ease"
            row.style.background = "#3b82f6"
            setTimeout(() => { row.style.background = prevBg }, 1400)
            if (rec.dropMin != null && isFinite(rec.dropMin)) {
                const m = Math.max(0, Math.min(1439, Math.round(Number(rec.dropMin))))
                const hh = String(Math.floor(m / 60)).padStart(2, "0")
                const mm = String(m % 60).padStart(2, "0")
                const depInput = row.querySelector(".aes-afp-row-dep")
                if (depInput) {
                    // Set value only — do NOT dispatch change. The change
                    // handler emits candidate:selected, which form-driver
                    // listens to and writes to AS's New Flight form. The
                    // dnd-grid handoff is a navigation aid only; the user
                    // commits via row click / Enter when ready.
                    depInput.value = hh + ":" + mm
                }
            }
        },

        _visibleSet(candidates) {
            const filtered = this._applyFilters(candidates)
            const sorted   = this._sortRows(filtered)
            return (this._chipState && this._chipState.topN === "all")
                ? sorted
                : sorted.slice(0, (this._chipState && this._chipState.topN) || 10)
        },

        /** IATAs of the currently rendered (chip-filtered, sorted, top-N capped)
         *  candidate rows. host.js's "Open stations…" button reads this so the
         *  bulk-open modal operates on what the user can see. Empty when no
         *  candidates have been computed yet. */
        visibleIatas() {
            if (!Array.isArray(this.last) || !this.last.length) return []
            if (!this._chipState) this._chipState = this._defaultChipState(null)
            return this._visibleSet(this.last)
                .map(c => String(c && c.destIata || "").toUpperCase())
                .filter(i => /^[A-Z]{3}$/.test(i))
        },

        /** Public refresh entry — host.js's "Update" tool button calls this
         *  so users can force a recompute without navigating away. Bypasses
         *  the 150 ms debounce that the bus subscriptions use, so a click
         *  can't be swallowed by a `spec:resolved` / `ctx:ready` /
         *  `schedule:updated` event that arrived a few ms earlier. Read-only:
         *  re-reads schedule + FlightsFrom + demand + α + watchlist stores
         *  and re-renders; never writes. */
        refresh() {
            if (_scheduledRun) { clearTimeout(_scheduledRun); _scheduledRun = 0 }
            _runCompute()
        },

        async _loadDefaultDepTime() {
            if (this._depTimeLoaded) return
            this._depTimeLoaded = true
            if (typeof window.AesAfpSettings === "undefined") return
            try {
                const s = await window.AesAfpSettings.load()
                if (s && typeof s.defaultDepartureTime === "string"
                        && HHMM_RE.test(s.defaultDepartureTime)) {
                    this._defaultDepTime = s.defaultDepartureTime
                }
            } catch (_) { /* keep fallback */ }
        }
    }

    window.AesAfpRouteCandidates = AesAfpRouteCandidates

    // ---- Bus wiring ---------------------------------------------------------

    let _scheduledRun = 0

    /**
     * Always-paint placeholder so the slot is never empty while the slice
     * waits for upstream events (spec:resolved, ctx:ready). Cleared the
     * moment AesAfpRouteCandidates.render runs with real data.
     */
    function _renderPlaceholder(host, headline, detail) {
        if (!host) return
        host.innerHTML = ''
            + '<div data-aes-afp-cand-card="placeholder" '
            + 'style="padding:8px;border:1px dashed #374151;border-radius:6px;'
            + 'color:#9ca3af;font-size:11px;line-height:1.5;margin-top:4px;">'
            + '<div style="font-weight:600;color:#cbd5e1;margin-bottom:3px;">'
            + escapeHtml(headline) + '</div>'
            + '<div>' + escapeHtml(detail) + '</div>'
            + '</div>'
    }

    async function _runCompute() {
        try {
            const slot = (window.AesAfp && AesAfp.slot) ? AesAfp.slot("candidates") : null
            const activeHub = (window.AesAfp && typeof AesAfp.getActiveHub === "function")
                ? AesAfp.getActiveHub() : null
            if (!activeHub) {
                _renderPlaceholder(slot, "Hub not yet resolved.",
                    "Set a planning hub via the 'Plan from' input above, or wait for Slice A's ctx to find the aircraft's current airport.")
                return
            }
            const spec = (window.AesAfpSpecResolver && AesAfpSpecResolver.last) || null
            if (!spec) {
                _renderPlaceholder(slot, "Waiting for aircraft spec…",
                    "Slice B is still resolving the aircraft type. Candidates will appear after spec:resolved fires.")
                return
            }
            if (typeof RouteAssistantSettings === "undefined") {
                console.warn("[AES afp] route-candidates: RouteAssistantSettings not loaded")
                _renderPlaceholder(slot, "Route Assistant settings unavailable.",
                    "RouteAssistantSettings is not loaded — check the manifest content_scripts entry for /app/fleets/aircraft/*/0*.")
                return
            }
            const settings = await RouteAssistantSettings.load()

            // Track 7 slice 7e — prefer the persisted Schedule from the
            // store (catches dimmed + locked legs the legacy `.flight`-only
            // VFP scrape missed). Fall back to the live DOM scrape when
            // the store is unavailable or empty (e.g. very first AFP page
            // load before the broadcaster has run).
            let scheduleLegs = null
            if (typeof AesAfpScheduleStore !== "undefined"
                    && AesAfp.ctx && AesAfp.ctx.server && AesAfp.ctx.aircraftId) {
                try {
                    const sched = await AesAfpScheduleStore.load(
                        AesAfp.ctx.server, AesAfp.ctx.aircraftId)
                    if (sched && Array.isArray(sched.legs)) scheduleLegs = sched.legs
                } catch (e) { /* fall through to live scrape */ }
            }
            if (!scheduleLegs && typeof AesAfp.getCurrentSchedule === "function") {
                scheduleLegs = AesAfp.getCurrentSchedule() || []
            }
            scheduleLegs = scheduleLegs || []
            const scheduledDestSet = new Set(scheduleLegs
                .map(l => String((l && l.destination) || "").toUpperCase())
                .filter(Boolean))
            const scheduledFlightIds = new Set(scheduleLegs
                .map(l => l && l.flightId != null ? String(l.flightId) : null)
                .filter(Boolean))
            const opts = {
                originIata: activeHub,
                spec, settings, scheduledDestSet, scheduledFlightIds
            }
            const candidates = await AesAfpRouteCandidates.compute(opts)
            const host = AesAfp.slot && AesAfp.slot("candidates")
            if (host) AesAfpRouteCandidates.render(host, candidates, opts)
        } catch (e) {
            console.warn("[AES afp] route-candidates compute failed", e)
        }
    }

    function _scheduleRun() {
        if (_scheduledRun) return
        _scheduledRun = setTimeout(() => { _scheduledRun = 0; _runCompute() }, 150)
    }

    function _attach() {
        if (!window.AesAfp || !AesAfp.bus || typeof AesAfp.bus.on !== "function") {
            setTimeout(_attach, 50)
            return
        }
        AesAfp.bus.on("spec:resolved", _scheduleRun)
        AesAfp.bus.on("ctx:ready",     _scheduleRun)   // _runCompute bails if spec not yet ready
        // Track 7 slice 7e — refresh when the broadcaster persists a new
        // schedule (in-page immediacy; chrome.storage.onChanged covers the
        // cross-tab case below).
        AesAfp.bus.on("schedule:updated", _scheduleRun)
        // Plan-from override changed (tools-strip hub picker) — recompute
        // candidates against the new hub. _runCompute reads getActiveHub()
        // each call so no extra plumbing is needed.
        AesAfp.bus.on("hub:changed", _scheduleRun)
        // Race-safe one-shot when spec already resolved before we subscribed.
        if (window.AesAfpSpecResolver && AesAfpSpecResolver.last) _scheduleRun()

        // Cross-tab sync. The same listener handles two key families:
        //   - Watchlist toggles (RouteAssistantWatchlistStore.CACHE_KEY)
        //   - Schedule writes (any "aircraftFlightPlan:schedule:" key, 7e)
        // On a schedule write to THIS aircraft, recompute so Hide-scheduled
        // and the alreadyScheduled flag track the new persisted state.
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== "local") return
                if (typeof RouteAssistantWatchlistStore !== "undefined"
                    && Object.prototype.hasOwnProperty.call(changes,
                        RouteAssistantWatchlistStore.CACHE_KEY)) {
                    RouteAssistantWatchlistStore.loadKeys().then(keys => {
                        AesAfpRouteCandidates._watchlistKeys = keys
                        AesAfpRouteCandidates._reRender()
                    }).catch(() => { /* keep stale */ })
                }
                // Schedule changes (Track 7 slice 7e). Match prefix +
                // current ctx so cross-tab edits to OTHER aircraft don't
                // trigger a wasted recompute on this page.
                if (typeof AesAfpScheduleStore !== "undefined"
                    && window.AesAfp && AesAfp.ctx) {
                    const myKey = AesAfpScheduleStore._key(
                        AesAfp.ctx.server, AesAfp.ctx.aircraftId)
                    if (Object.prototype.hasOwnProperty.call(changes, myKey)) {
                        _scheduleRun()
                    }
                }
                // FlightsFrom data writes for the current origin — covers
                // both this-tab scans started from the empty-state button
                // and cross-tab scans (Route Assistant, dashboard).
                if (window.AesAfp && AesAfp.ctx && AesAfp.ctx.currentLocationIata) {
                    const ffKey = "flightsFrom:" + AesAfp.ctx.currentLocationIata.toUpperCase()
                    if (Object.prototype.hasOwnProperty.call(changes, ffKey)) {
                        _scheduleRun()
                    }
                }
                // Track B — SchedulePresets lives in the consolidated
                // `settings` blob; cross-tab edits invalidate the wave-fit
                // cache so the column refreshes on the next render.
                if (Object.prototype.hasOwnProperty.call(changes, "settings")) {
                    AesAfpRouteCandidates._invalidateWaveFitCache()
                    AesAfpRouteCandidates._reRender()
                }
            })
        }
        // Track B — same-page bus signal from wave-editor / wave-strip.
        // Cross-tab is handled above via chrome.storage.onChanged.
        if (typeof window !== "undefined" && window.CentralHubBus
                && typeof window.CentralHubBus.on === "function") {
            window.CentralHubBus.on("waves:preset-updated", () => {
                AesAfpRouteCandidates._invalidateWaveFitCache()
                AesAfpRouteCandidates._reRender()
            })
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _attach, {once: true})
    } else {
        _attach()
    }
})()
