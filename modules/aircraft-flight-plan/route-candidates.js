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
        {key: "paxScore",      label: "Pax",   natural: "desc"},
        {key: "cargoScore",    label: "Cargo", natural: "desc"},
        {key: "weeklyFlights", label: "Wkly",  natural: "desc"},
        {key: "airlineCount",  label: "Air",   natural: "asc"},
        {key: "fuelKgRT",      label: "Fuel",  natural: "asc"},
        {key: "alphaY",        label: "αY",    natural: "desc"},
        {key: "scoreBlend",    label: "Score", natural: "desc"}
    ]
    // 1 L Jet A ≈ 0.8 kg — same constant the AS Performance Check tool uses
    // when it converts liters to mass for payload planning.
    const KG_PER_LITRE_JETA = 0.8

    const HHMM_RE = /^(\d{1,2}):(\d{2})$/
    const FALLBACK_DEP_TIME = "09:00"

    let _ffCtrl = null

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
            const rows = routes.map(r => this._buildRow(r, originIata, demandMap, distMap,
                rangeNm, scheduled, alphaMap, burn))

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
            return scored
        },

        _buildRow(r, originIata, demandMap, distMap, rangeNm, scheduled, alphaMap, burn) {
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
                alphaF:          alphaRec && isFinite(Number(alphaRec.F)) ? Number(alphaRec.F) : null
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

            this._renderChipBar(host)
            this._renderTable(host, list)
            this._renderFooter(host, list)
        },

        _defaultChipState(settings) {
            const afp  = (settings && settings.aircraftFlightPlan) || {}
            const chips = afp.candidateChips || {}
            return {
                rangeFitOnly:        chips.rangeFitOnly        !== false,
                hideAlreadyScheduled: chips.hideAlreadyScheduled !== false,
                watchlistOnly:       !!chips.watchlistOnly,
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

        _renderTable(host, candidates) {
            const capped = this._visibleSet(candidates)

            if (!capped.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "padding:8px;color:#9ca3af;font-size:11px;font-style:italic;"
                empty.textContent = "No candidates match the current chips. Toggle one off?"
                host.append(empty)
                return
            }

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
            capped.forEach((c, idx) => tbody.append(this._renderRow(c, idx)))
            table.append(tbody)
            host.append(table)
        },

        _renderRow(c, idx) {
            const tr = document.createElement("tr")
            tr.style.cssText = "cursor:pointer;border-bottom:1px solid #1f2937;"
                + (idx % 2 ? "background:#0f1623;" : "")
            tr.title = c.destName ? (c.destIata + " · " + c.destName) : c.destIata
            tr.addEventListener("mouseenter", () => { tr.style.background = "#1f2937" })
            tr.addEventListener("mouseleave", () => {
                tr.style.background = (idx % 2) ? "#0f1623" : ""
            })

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

            const distCell = this._mkNumCell(
                (c.distanceKm == null) ? "—" : Math.round(c.distanceKm).toLocaleString())

            const paxCell   = this._mkNumCell((c.paxScore   == null) ? "—" : ("★" + c.paxScore))
            const cargoCell = this._mkNumCell((c.cargoScore == null) ? "—" : ("★" + c.cargoScore))
            const wklyCell  = this._mkNumCell(c.weeklyFlights == null ? "—" : c.weeklyFlights)
            const airCell   = this._mkNumCell(c.airlineCount  == null ? "—" : c.airlineCount)

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
            // Re-fire candidate:selected when the user commits a new value
            // (Enter or blur) so the form picks up the time without needing
            // a fresh row click.
            const fireFromInput = () => emit("candidate-list-time")
            depInput.addEventListener("change", fireFromInput)
            depInput.addEventListener("keydown", ev => {
                if (ev.key === "Enter") { ev.preventDefault(); depInput.blur() }
            })
            depCell.append(depInput)

            tr.append(destCell, distCell, paxCell, cargoCell, wklyCell, airCell,
                fuelCell, alphaCell, scoreCell, depCell)
            return tr
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
            if (!window.AesAfp || !AesAfp.ctx || !AesAfp.ctx.currentLocationIata) {
                _renderPlaceholder(slot, "Aircraft location not yet resolved.",
                    "Slice A's ctx hasn't found the aircraft's current airport. Reload the page or use the header Refresh link.")
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
                originIata: AesAfp.ctx.currentLocationIata,
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
            })
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _attach, {once: true})
    } else {
        _attach()
    }
})()
