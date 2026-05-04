"use strict"

/**
 * Explore Map tab — server-wide interactive airport map for the
 * Competitor Intel hub.
 *
 * Renders an equirectangular SVG of every airport we have intel on,
 * sized by carrier count (or our presence), colored by competition
 * pressure. Clicking a bubble opens a side-panel listing every carrier
 * we've cached for that airport with one-click jumps into:
 *   - the airline's enterprise profile (`/app/info/enterprises/<id>`)
 *   - the airline's row in the Companies tab (filtered by name)
 *   - the airport AS native page (`/app/info/airports/<id>`)
 *
 * Pure-renderer contract (matches companies-view / routes-view):
 *   render(host, data, opts)
 *     host  — HTMLElement, exclusive ownership
 *     data  — competitor-intel host's loadServerData() shape
 *     opts  — {search, sort, onSort, onSelect}
 *
 * Builds on existing primitives:
 *   - WorldViewAirportCoords for lat/lon lookup (~250 hubs)
 *   - AesCompetitorStore.bulkLoadAirports for the carrier table at click
 *   - Existing AesCompetitorIntelDrilldown isn't reused here — we render
 *     inline because the hub-shell content host already has space and
 *     the drilldown is tuned for company/route/ors selection envelopes.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelExploreMapView) return

    const VW = 1000, VH = 500
    const NS_SVG = "http://www.w3.org/2000/svg"
    const RADIUS_MIN = 4
    const RADIUS_MAX = 20

    function _project(lat, lon) {
        const x = (Number(lon) + 180) / 360
        const y = (90 - Number(lat)) / 180
        return {x: Math.max(0, Math.min(1, x)) * VW, y: Math.max(0, Math.min(1, y)) * VH}
    }

    function _radius(carrierCount, maxCarrierCount) {
        if (!isFinite(carrierCount) || carrierCount <= 0) return RADIUS_MIN
        const s = maxCarrierCount > 0 ? carrierCount / maxCarrierCount : 0
        return RADIUS_MIN + Math.sqrt(Math.max(0, Math.min(1, s))) * (RADIUS_MAX - RADIUS_MIN)
    }

    function _svg(tag, attrs, children) {
        const el = document.createElementNS(NS_SVG, tag)
        if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k])
        if (children) for (const c of children) if (c) el.appendChild(c)
        return el
    }

    /**
     * From the hub data, derive the per-airport carrier-set + edge-summary
     * map keyed by IATA. Pure.
     *   edges:       Map<HUB-DEST, {hub, dest, competitors[]}>
     *   enterprises: Map<id, {enterpriseId, name, hubs?}>
     *   ourHubs:     Set<iata>
     *
     * Returns Map<iata, {iata, name?, carriers: Map<id, {id,name,iata,hubBased}>,
     *                    weeklyFlights, isOurs}>
     */
    function _buildAirportIndex(data, coords) {
        const out = new Map()
        const upsert = (iata) => {
            const code = String(iata || "").toUpperCase()
            if (!/^[A-Z]{3}$/.test(code)) return null
            let rec = out.get(code)
            if (!rec) {
                const c = coords && typeof coords.get === "function" ? coords.get(code) : null
                rec = {
                    iata: code,
                    name: c ? c.name : null,
                    lat: c ? c.lat : null,
                    lon: c ? c.lon : null,
                    carriers: new Map(),
                    weeklyFlights: 0,
                    isOurs: !!(data.ourHubs && data.ourHubs.has && data.ourHubs.has(code))
                }
                out.set(code, rec)
            }
            return rec
        }
        const addCarrier = (rec, comp, hubBased) => {
            if (!rec || !comp) return
            // Real enterpriseId wins; otherwise key by IATA. Markets-derived
            // edges only have IATA — that's enough to group within the map,
            // even though the "Profile →" button can't drill in without an id.
            const explicitId = comp.enterpriseId != null ? String(comp.enterpriseId) : null
            const fallbackId = comp.iata ? "iata:" + String(comp.iata).toUpperCase() : null
            const id = explicitId || fallbackId
            if (!id) return
            const prior = rec.carriers.get(id) || {
                enterpriseId: explicitId,
                name: comp.name || (comp.iata ? "[" + String(comp.iata).toUpperCase() + "]" : "#" + id),
                iata:  (comp.iata && String(comp.iata).toUpperCase()) || null,
                hubBased: false,
                weeklyFlights: 0
            }
            if (hubBased) prior.hubBased = true
            const weekly = Number(comp.weeklyFlights) || 0
            if (weekly > 0) prior.weeklyFlights += weekly
            rec.carriers.set(id, prior)
        }

        // edges feed both endpoints
        if (data && data.edges && typeof data.edges.forEach === "function") {
            for (const edge of data.edges.values()) {
                if (!edge) continue
                const hubRec = upsert(edge.hub)
                const destRec = upsert(edge.dest)
                const wf = Number(edge.totals && edge.totals.totalWeeklyFlights) || 0
                if (hubRec) hubRec.weeklyFlights += wf
                if (destRec) destRec.weeklyFlights += wf
                for (const comp of (edge.competitors || [])) {
                    addCarrier(hubRec, comp, false)
                    addCarrier(destRec, comp, false)
                }
            }
        }
        // enterprise hubs add a "hub-based" carrier even when no edge exists
        if (data && data.enterprises && typeof data.enterprises.forEach === "function") {
            for (const ent of data.enterprises.values()) {
                if (!ent) continue
                const hubs = Array.isArray(ent.hubs) ? ent.hubs : []
                for (const h of hubs) {
                    const code = (h && (h.iata || h.airportIata)) || h
                    const rec = upsert(code)
                    addCarrier(rec, {
                        enterpriseId: ent.enterpriseId,
                        name: ent.name,
                        iata: ent.iata
                    }, true)
                }
            }
        }
        return out
    }

    function _carrierSummary(carriers, ourId) {
        const list = []
        for (const c of carriers.values()) list.push(c)
        list.sort((a, b) => (b.weeklyFlights || 0) - (a.weeklyFlights || 0)
            || (a.name || "").localeCompare(b.name || ""))
        return {list, total: list.length, ours: ourId ? list.find(c => c.enterpriseId === String(ourId)) : null}
    }

    function _styleEl(tagName, css) {
        const el = document.createElement(tagName)
        el.style.cssText = css
        return el
    }

    function _onPickAirport(iata, data, paneHost, opts) {
        paneHost.innerHTML = ""
        const rec = paneHost._index ? paneHost._index.get(iata) : null
        if (!rec) {
            paneHost.textContent = "No data for " + iata
            return
        }
        const {list, total} = _carrierSummary(rec.carriers)
        const head = _styleEl("div",
            "padding:8px 12px;border-bottom:1px solid #1f2937;display:flex;justify-content:space-between;align-items:center;")
        const title = document.createElement("div")
        title.innerHTML = "<b style='color:#7dd3fc;font-size:13px;'>" + iata + "</b>"
            + (rec.name ? " <span style='color:#94a3b8;'>· " + rec.name + "</span>" : "")
            + (rec.isOurs ? " <span style='color:#10b981;font-size:10px;margin-left:6px;'>OUR HUB</span>" : "")
            + " <div style='font-size:10px;color:#94a3b8;margin-top:2px;'>"
            + total + " carrier" + (total === 1 ? "" : "s")
            + (rec.weeklyFlights > 0 ? " · " + Math.round(rec.weeklyFlights) + " wkly flights cached" : "")
            + "</div>"
        head.appendChild(title)
        const openAirport = document.createElement("button")
        openAirport.textContent = "Open AS"
        openAirport.title = "Open the AirlineSim airport page in a new tab. We have airportId in cache for some airports; falling back to IATA path otherwise."
        openAirport.style.cssText = "background:#1e3a8a;color:#e5e7eb;border:1px solid #38bdf8;border-radius:3px;"
            + "padding:3px 8px;font-size:11px;cursor:pointer;"
        openAirport.addEventListener("click", () => {
            const id = paneHost._airportIdsByIata && paneHost._airportIdsByIata.get(iata)
            const path = id != null
                ? "/app/info/airports/" + encodeURIComponent(id)
                : "/app/info/search?query=" + encodeURIComponent(iata)
            window.open(path, "_blank")
        })
        head.appendChild(openAirport)
        paneHost.appendChild(head)

        if (!list.length) {
            const empty = _styleEl("div", "padding:12px;color:#94a3b8;font-size:11px;")
            empty.textContent = "No cached carriers for this airport. Open the AS airport page to seed AES's cache."
            paneHost.appendChild(empty)
            return
        }

        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const tbody = document.createElement("tbody")
        for (const c of list) {
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:1px solid #1f2937;"
            const nameCell = document.createElement("td")
            nameCell.style.cssText = "padding:6px 10px;color:#e5e7eb;"
            nameCell.textContent = (c.iata ? "[" + c.iata + "] " : "") + (c.name || "—")
            if (c.hubBased) {
                const tag = document.createElement("span")
                tag.textContent = "HUB"
                tag.style.cssText = "margin-left:6px;font-size:9px;padding:1px 4px;color:#fbbf24;"
                    + "border:1px solid #b45309;border-radius:2px;"
                tag.title = "This airport is a hub for the airline (per cached enterprise record)."
                nameCell.appendChild(tag)
            }
            const flCell = document.createElement("td")
            flCell.style.cssText = "padding:6px 10px;text-align:right;color:#cbd5e1;width:80px;"
            flCell.textContent = c.weeklyFlights > 0 ? Math.round(c.weeklyFlights) + " /wk" : "—"
            const actionCell = document.createElement("td")
            actionCell.style.cssText = "padding:6px 10px;text-align:right;width:230px;"

            const profileBtn = document.createElement("button")
            const directId = c.enterpriseId && !String(c.enterpriseId).startsWith("iata:")
                ? String(c.enterpriseId) : null
            const backfillHit = !directId && c.iata && data && data.iataBackfill
                ? data.iataBackfill.get(String(c.iata).toUpperCase()) : null
            const resolvedId = directId || (backfillHit ? backfillHit.enterpriseId : null)
            const hasRealId = !!resolvedId
            profileBtn.textContent = hasRealId ? "Profile →" : "Search ↗"
            profileBtn.title = directId
                ? "Open this airline's enterprise page on AS in a new tab. AES will inject the competitor profile panel inline."
                : (backfillHit
                    ? "Enterprise id resolved from IATA backfill (" + (backfillHit.name || c.iata)
                        + "). Open the AS profile in a new tab."
                    : "No enterprise id known yet — opens AS info-search by IATA. "
                        + "Click a flight on the carrier's route to seed the enterprise id.")
            profileBtn.style.cssText = "margin-right:4px;background:#1e3a8a;color:#e5e7eb;border:1px solid #38bdf8;"
                + "border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;"
            profileBtn.addEventListener("click", () => {
                if (hasRealId) {
                    // Slice 5 — stamp the (iata, enterpriseId) pairing in the
                    // backfill table the moment the user confirms it via a
                    // Profile click, so future markets-derived rows that share
                    // this IATA can resolve directly. Direct-id case only;
                    // backfill-resolved rows don't need a re-stamp.
                    if (directId && c.iata && data && data.server
                            && window.AesCompetitorIntelHost
                            && window.AesCompetitorIntelHost.stampIataMapping) {
                        window.AesCompetitorIntelHost.stampIataMapping(
                            data.server, c.iata, directId, c.name || null)
                    }
                    window.open("/app/info/enterprises/" + encodeURIComponent(resolvedId), "_blank")
                } else if (c.iata) {
                    window.open("/app/info/search?query=" + encodeURIComponent(c.iata), "_blank")
                }
            })

            const schedBtn = document.createElement("button")
            schedBtn.textContent = "Schedule ↘"
            schedBtn.title = "Show this carrier's flights at " + iata + " over a 24h cycle. Reads cached departure rows from routeAssistant:markets:competitors:* and clusters them into banks."
            schedBtn.style.cssText = "margin-right:4px;background:transparent;color:#fbbf24;"
                + "border:1px solid #b45309;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;"
            schedBtn.addEventListener("click", async () => {
                await _renderCarrierSchedule(paneHost, iata, c, data)
            })

            const networkBtn = document.createElement("button")
            networkBtn.textContent = "Network ↗"
            networkBtn.title = "List every cached route this carrier flies on the server, with weekly flights, dep-time pattern, and top banks per route. Click a route to drill into that airport."
            networkBtn.style.cssText = "margin-right:4px;background:transparent;color:#a78bfa;"
                + "border:1px solid #6d28d9;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;"
            networkBtn.addEventListener("click", async () => {
                await _renderCarrierNetwork(paneHost, c, data, opts)
            })

            const filterBtn = document.createElement("button")
            filterBtn.textContent = "Filter ↑"
            filterBtn.title = "Switch to the Companies tab pre-filtered to this airline's name."
            filterBtn.style.cssText = "background:transparent;color:#94a3b8;border:1px solid #475569;"
                + "border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;"
            filterBtn.addEventListener("click", () => {
                if (opts && typeof opts.onSelect === "function") {
                    opts.onSelect({kind: "switchTab", tab: "companies", search: c.name || ""})
                }
            })

            actionCell.append(profileBtn, schedBtn, networkBtn, filterBtn)
            tr.append(nameCell, flCell, actionCell)
            tbody.appendChild(tr)
        }
        tbl.appendChild(tbody)
        paneHost.appendChild(tbl)
    }

    /**
     * Pull every cached flight row for `carrier.iata` that touches `airportIata`,
     * group by route + flightCode, and project into a 24h-cycle bin set.
     * Pure given the storage records — caller passes them in.
     *
     *   records: array of {hub, dest, competitors:[{flightCode, depTimeUtc, arrTimeUtc, depDateUtc, typeCode, ...}]}
     *   carrierIata: e.g. "BA"
     *   anchorIata:  the airport whose drilldown we're in
     *   nowMs: optional; defaults to Date.now()
     *
     * Output:
     *   {
     *     flights: [{routePair, dir:"out"|"in", flightCode, depHHMM, arrHHMM, typeCode, depMin, arrMin}],
     *     banks:   [{centerMin, count, peakMin}]   // 30-min clustered, sorted desc
     *     uniqueCount, sevenDayCount
     *   }
     */
    function _scheduleFromRecords(records, carrierIata, anchorIata, nowMs) {
        const now = isFinite(nowMs) ? nowMs : Date.now()
        const sevenDaysAgo = now - 7 * 86400000
        const carrier = String(carrierIata || "").toUpperCase()
        const anchor = String(anchorIata || "").toUpperCase()
        if (!/^[A-Z]{2,3}$/.test(carrier) || !/^[A-Z]{3}$/.test(anchor)) {
            return {flights: [], banks: [], uniqueCount: 0, sevenDayCount: 0}
        }
        const re = new RegExp("^" + carrier + "\\s*\\d", "i")
        const seen = new Set()                // flightId+depTimeUtc — dedupes service-class triplets
        const flights = []
        const last7 = new Set()
        for (const rec of records || []) {
            if (!rec || !rec.competitors) continue
            const hub = String(rec.hub || "").toUpperCase()
            const dest = String(rec.dest || "").toUpperCase()
            if (hub !== anchor && dest !== anchor) continue
            const dir = hub === anchor ? "out" : "in"  // out: anchor → other; in: other → anchor
            for (const c of rec.competitors) {
                if (!c || c.isOurs) continue
                const code = String(c.flightCode || c.flightNumber || "").trim()
                if (!re.test(code)) continue
                const fid = c.flightId != null ? String(c.flightId) : (code + "@" + (c.depTimeUtc || ""))
                const depKey = fid + "|" + (c.depTimeUtc || "")
                if (seen.has(depKey)) continue
                seen.add(depKey)
                const depMin = _hhmmToMin(c.depTimeUtc)
                const arrMin = _hhmmToMin(c.arrTimeUtc)
                if (depMin == null) continue
                flights.push({
                    routePair: hub + "→" + dest,
                    dir,
                    flightCode: code,
                    depHHMM: c.depTimeUtc || "",
                    arrHHMM: c.arrTimeUtc || "",
                    typeCode: c.typeCode || null,
                    depMin,
                    arrMin
                })
                if (c.depDateUtc) {
                    const depMs = Date.parse(c.depDateUtc + "T" + (c.depTimeUtc || "00:00") + "Z")
                    if (isFinite(depMs) && depMs >= sevenDaysAgo) last7.add(depKey)
                }
            }
        }
        // Bank detection — bin departures into 30-min windows; report top peaks.
        const bins = new Array(48).fill(0)
        for (const f of flights) {
            if (f.dir !== "out") continue       // banks pivot on departures from this airport
            const idx = Math.floor(f.depMin / 30)
            if (idx >= 0 && idx < bins.length) bins[idx] += 1
        }
        const banks = []
        for (let i = 0; i < bins.length; i++) {
            if (bins[i] >= 2) {
                banks.push({centerMin: i * 30 + 15, count: bins[i], peakMin: i * 30})
            }
        }
        banks.sort((a, b) => b.count - a.count)
        return {
            flights,
            banks: banks.slice(0, 5),
            uniqueCount: flights.length,
            sevenDayCount: last7.size
        }
    }

    function _hhmmToMin(s) {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ""))
        if (!m) return null
        const h = parseInt(m[1], 10)
        const min = parseInt(m[2], 10)
        if (!isFinite(h) || !isFinite(min)) return null
        return Math.max(0, Math.min(24 * 60 - 1, h * 60 + min))
    }

    function _minToHHMM(min) {
        const h = Math.floor(min / 60)
        const m = min % 60
        return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0")
    }

    /**
     * Read raw markets:competitors records that touch `airportIata`. Returns
     * a list of full records (so the schedule projector can see both hub and
     * dest fields).
     */
    async function _loadRecordsForAirport(airportIata) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return []
        const PREFIX = "routeAssistant:markets:competitors:"
        const code = String(airportIata || "").toUpperCase()
        const all = await new Promise(resolve => chrome.storage.local.get(null, resolve))
        const acctId = (typeof window !== "undefined" && window.__aesAccountId) || null
        const out = []
        for (const k in all) {
            if (k.indexOf(PREFIX) !== 0) continue
            if (k.indexOf(":acct:") !== -1) {
                if (!acctId || k.indexOf(":acct:" + acctId + ":") < 0) continue
            }
            const rec = all[k]
            if (!rec || !rec.competitors) continue
            const hub = String(rec.hub || "").toUpperCase()
            const dest = String(rec.dest || "").toUpperCase()
            if (hub !== code && dest !== code) continue
            out.push(rec)
        }
        return out
    }

    /**
     * Append a schedule pane to `paneHost` for `carrier` at `airportIata`.
     * Reuses the same pane host so subsequent clicks re-render in place.
     * The pane includes a 24h-cycle Gantt-strip (departures only — arrivals
     * are derivable from the partner airport's own schedule pane) and a
     * per-bank summary line.
     */
    async function _renderCarrierSchedule(paneHost, airportIata, carrier, data) {
        // Tear out any prior schedule block; keep the airport header + carrier table intact.
        const prior = paneHost.querySelector("[data-aes-perleg-schedule]")
        if (prior) prior.remove()

        const wrap = document.createElement("div")
        wrap.setAttribute("data-aes-perleg-schedule", "")
        wrap.style.cssText = "padding:10px 12px;margin-top:4px;border-top:1px solid #1f2937;"
            + "background:rgba(15,23,42,0.5);"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"
        const title = document.createElement("div")
        title.innerHTML = "<b style='color:#fbbf24;font-size:12px;'>SCHEDULE · "
            + (carrier.iata || "?") + " at " + airportIata + "</b>"
            + "<div style='font-size:10px;color:#94a3b8;margin-top:1px;'>"
            + "Loading cached flight rows…</div>"
        head.appendChild(title)
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:12px;"
        closeBtn.addEventListener("click", () => wrap.remove())
        head.appendChild(closeBtn)
        wrap.appendChild(head)

        paneHost.appendChild(wrap)

        const records = await _loadRecordsForAirport(airportIata)
        const proj = _scheduleFromRecords(records, carrier.iata, airportIata)
        title.querySelector("div").textContent = proj.uniqueCount
            + " unique flight" + (proj.uniqueCount === 1 ? "" : "s")
            + " · " + proj.sevenDayCount + " in last 7d"
            + (proj.banks.length ? " · " + proj.banks.length + " bank(s) detected" : " · no banks (sparse pattern)")

        if (!proj.flights.length) {
            const empty = _styleEl("div", "color:#94a3b8;font-size:11px;padding:6px 0;")
            empty.textContent = "No cached " + carrier.iata
                + " departures or arrivals through " + airportIata + ". "
                + "Open /app/com/markets/" + airportIata + "<DEST> for a route this carrier flies to populate the cache."
            wrap.appendChild(empty)
            return
        }

        // 24h-cycle Gantt strip — one stacked row per route pair.
        const stripWidth = 720
        const stripHeight = 90
        const padL = 36, padR = 8, padT = 12, padB = 18
        const innerW = stripWidth - padL - padR
        const innerH = stripHeight - padT - padB

        const svg = _svg("svg", {viewBox: "0 0 " + stripWidth + " " + stripHeight,
            width: "100%", height: stripHeight, preserveAspectRatio: "xMidYMid meet"})
        svg.style.background = "#0b1220"
        svg.style.border = "1px solid #1f2937"
        svg.style.borderRadius = "3px"

        // Hour grid
        for (let h = 0; h <= 24; h++) {
            const x = padL + (h / 24) * innerW
            svg.appendChild(_svg("line", {
                x1: x, y1: padT, x2: x, y2: padT + innerH,
                stroke: h % 6 === 0 ? "#334155" : "#1e293b",
                "stroke-width": h % 6 === 0 ? 1 : 0.5
            }))
            if (h % 6 === 0 && h < 24) {
                const txt = _svg("text", {
                    x: x + 2, y: stripHeight - 4, fill: "#94a3b8", "font-size": 9
                })
                txt.textContent = String(h).padStart(2, "0") + ":00"
                svg.appendChild(txt)
            }
        }

        // Aggregate departures per minute for a fill/heat strip
        const byPair = new Map()
        for (const f of proj.flights) {
            const key = f.dir + ":" + f.routePair
            const list = byPair.get(key) || {dir: f.dir, pair: f.routePair, items: []}
            list.items.push(f)
            byPair.set(key, list)
        }
        const pairs = Array.from(byPair.values()).sort((a, b) => b.items.length - a.items.length).slice(0, 8)
        const rowH = pairs.length ? Math.min(14, innerH / pairs.length) : 0
        for (let i = 0; i < pairs.length; i++) {
            const p = pairs[i]
            const yTop = padT + i * (rowH + 2)
            const labelTxt = _svg("text", {x: 2, y: yTop + rowH * 0.7, fill: "#cbd5e1", "font-size": 8})
            labelTxt.textContent = (p.dir === "out" ? "→ " : "← ") + p.pair.slice(p.pair.indexOf("→") + 1).trim()
            svg.appendChild(labelTxt)
            for (const f of p.items) {
                const x = padL + (f.depMin / (24 * 60)) * innerW
                const w = Math.max(2, ((f.arrMin != null && f.arrMin > f.depMin)
                    ? (f.arrMin - f.depMin) : 30) / (24 * 60) * innerW)
                const tip = _svg("title", null, [])
                tip.textContent = f.flightCode + " · " + f.depHHMM
                    + (f.arrHHMM ? " → " + f.arrHHMM : "")
                    + (f.typeCode ? " · " + f.typeCode : "")
                const fill = p.dir === "out" ? "#38bdf8" : "#a78bfa"
                const bar = _svg("rect", {
                    x, y: yTop + 1, width: w, height: rowH - 2,
                    fill, "fill-opacity": 0.7, rx: 1, ry: 1
                })
                bar.appendChild(tip)
                svg.appendChild(bar)
            }
        }
        wrap.appendChild(svg)

        if (proj.banks.length) {
            const banksLine = _styleEl("div", "margin-top:8px;font-size:11px;color:#cbd5e1;")
            banksLine.innerHTML = "<span style='color:#94a3b8;'>BANKS:</span> "
                + proj.banks.map(b => "<b>" + _minToHHMM(b.peakMin) + "</b> ×" + b.count).join(" · ")
            wrap.appendChild(banksLine)
        }
    }

    /**
     * Read every cached `routeAssistant:markets:competitors:*` record on the
     * server. Used by the per-carrier network projector below; chrome.storage
     * read happens once per Network ↗ click.
     */
    async function _loadAllRecords() {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return []
        const PREFIX = "routeAssistant:markets:competitors:"
        const all = await new Promise(resolve => chrome.storage.local.get(null, resolve))
        const acctId = (typeof window !== "undefined" && window.__aesAccountId) || null
        const out = []
        for (const k in all) {
            if (k.indexOf(PREFIX) !== 0) continue
            if (k.indexOf(":acct:") !== -1) {
                if (!acctId || k.indexOf(":acct:" + acctId + ":") < 0) continue
            }
            const rec = all[k]
            if (rec && rec.competitors) out.push(rec)
        }
        return out
    }

    /**
     * Project a carrier's ENTIRE network across all cached records.
     * Pure given the records array.
     *
     *   records:     full markets:competitors records ({hub, dest, competitors[]})
     *   carrierIata: e.g. "WWW"
     *   nowMs: optional; defaults to Date.now()
     *
     * Output:
     *   {
     *     routes: [{
     *       hub, dest, pair: "HUB-DEST",
     *       weeklyFlights, last7d,
     *       depSpark: number[24]      // count of departures per UTC hour
     *       topBanks:  [{peakMin, count}]   // up to 3
     *       firstSeenAt, lastSeenAt
     *     }]                                // sorted desc by weekly count
     *     totalRoutes, totalWeekly, totalLast7d, hubsTouched (Set<iata>)
     *   }
     */
    function _carrierNetworkFromRecords(records, carrierIata, nowMs) {
        const now = isFinite(nowMs) ? nowMs : Date.now()
        const sevenDaysAgo = now - 7 * 86400000
        const carrier = String(carrierIata || "").toUpperCase()
        if (!/^[A-Z]{2,3}$/.test(carrier)) {
            return {routes: [], totalRoutes: 0, totalWeekly: 0, totalLast7d: 0, hubsTouched: new Set()}
        }
        const re = new RegExp("^" + carrier + "\\s*\\d", "i")
        const byPair = new Map()
        const seen = new Set()
        for (const rec of records || []) {
            if (!rec || !rec.competitors) continue
            const hub = String(rec.hub || "").toUpperCase()
            const dest = String(rec.dest || "").toUpperCase()
            if (!/^[A-Z]{3}$/.test(hub) || !/^[A-Z]{3}$/.test(dest)) continue
            const pair = hub + "-" + dest
            for (const c of rec.competitors) {
                if (!c || c.isOurs) continue
                const code = String(c.flightCode || c.flightNumber || "").trim()
                if (!re.test(code)) continue
                const fid = c.flightId != null ? String(c.flightId) : (code + "@" + (c.depTimeUtc || ""))
                const key = pair + "|" + fid + "|" + (c.depTimeUtc || "")
                if (seen.has(key)) continue
                seen.add(key)
                const slot = byPair.get(pair) || {
                    hub, dest, pair,
                    weeklyFlights: 0,
                    last7d: 0,
                    depSpark: new Array(24).fill(0),
                    depMins: [],
                    firstSeenAt: null,
                    lastSeenAt: null
                }
                slot.weeklyFlights += 1
                const depMin = _hhmmToMin(c.depTimeUtc)
                if (depMin != null) {
                    slot.depMins.push(depMin)
                    const hr = Math.floor(depMin / 60)
                    if (hr >= 0 && hr < 24) slot.depSpark[hr] += 1
                }
                if (c.depDateUtc) {
                    const depMs = Date.parse(c.depDateUtc + "T" + (c.depTimeUtc || "00:00") + "Z")
                    if (isFinite(depMs)) {
                        if (depMs >= sevenDaysAgo) slot.last7d += 1
                        if (slot.firstSeenAt == null || depMs < slot.firstSeenAt) slot.firstSeenAt = depMs
                        if (slot.lastSeenAt == null || depMs > slot.lastSeenAt) slot.lastSeenAt = depMs
                    }
                }
                byPair.set(pair, slot)
            }
        }
        // Compute top banks per route from depMins (30-min bins; report up to 3 ≥2-flight peaks)
        const routes = []
        const hubsTouched = new Set()
        let totalWeekly = 0, totalLast7d = 0
        for (const slot of byPair.values()) {
            const bins = new Array(48).fill(0)
            for (const m of slot.depMins) {
                const idx = Math.floor(m / 30)
                if (idx >= 0 && idx < 48) bins[idx] += 1
            }
            const banks = []
            for (let i = 0; i < bins.length; i++) {
                if (bins[i] >= 2) banks.push({peakMin: i * 30, count: bins[i]})
            }
            banks.sort((a, b) => b.count - a.count)
            slot.topBanks = banks.slice(0, 3)
            delete slot.depMins
            routes.push(slot)
            hubsTouched.add(slot.hub)
            hubsTouched.add(slot.dest)
            totalWeekly += slot.weeklyFlights
            totalLast7d += slot.last7d
        }
        routes.sort((a, b) => b.weeklyFlights - a.weeklyFlights)
        return {
            routes,
            totalRoutes: routes.length,
            totalWeekly,
            totalLast7d,
            hubsTouched
        }
    }

    /**
     * Append a network sub-pane below the airport drilldown. Lists every
     * cached route the carrier flies, with per-route mini-sparkline of
     * departure-hour distribution and top banks. Click a route → re-pin
     * the map to that hub via the existing onSelect("switchTab"…) bus.
     */
    async function _renderCarrierNetwork(paneHost, carrier, data, opts) {
        const prior = paneHost.querySelector("[data-aes-perleg-network]")
        if (prior) prior.remove()

        const wrap = document.createElement("div")
        wrap.setAttribute("data-aes-perleg-network", "")
        wrap.style.cssText = "padding:10px 12px;margin-top:4px;border-top:1px solid #1f2937;"
            + "background:rgba(15,23,42,0.5);"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;"
        const title = document.createElement("div")
        title.style.cssText = "flex:1;min-width:0;"
        title.innerHTML = "<b style='color:#a78bfa;font-size:12px;'>NETWORK · "
            + (carrier.iata || "?") + "</b>"
            + "<div style='font-size:10px;color:#94a3b8;margin-top:1px;'>Loading cache…</div>"
        head.appendChild(title)

        // Resolve a real enterpriseId via the IATA backfill table when the
        // carrier row only carries a synthetic `iata:XX` id. Surfaces a
        // "Detail →" CTA when one is available — bridges the gap between
        // markets-derived carrier rows (no enterpriseId) and the rich
        // airline-detail-view (needs one).
        const directId = carrier.enterpriseId && !String(carrier.enterpriseId).startsWith("iata:")
            ? String(carrier.enterpriseId) : null
        const backfillHit = !directId && carrier.iata && data && data.iataBackfill
            ? data.iataBackfill.get(String(carrier.iata).toUpperCase()) : null
        const resolvedId = directId || (backfillHit ? backfillHit.enterpriseId : null)
        if (resolvedId) {
            const detailBtn = document.createElement("button")
            detailBtn.textContent = "Detail →"
            detailBtn.title = directId
                ? "Open the full airline detail view (network map + ORS overlay + routes table)."
                : "Enterprise id resolved from IATA backfill (" + (backfillHit && backfillHit.name || carrier.iata)
                    + "). Open the full airline detail view."
            detailBtn.style.cssText = "background:#1e3a8a;color:#e5e7eb;border:1px solid #38bdf8;"
                + "border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer;"
            detailBtn.addEventListener("click", () => {
                if (directId && carrier.iata && data && data.server
                        && window.AesCompetitorIntelHost
                        && window.AesCompetitorIntelHost.stampIataMapping) {
                    window.AesCompetitorIntelHost.stampIataMapping(
                        data.server, carrier.iata, directId, carrier.name || null)
                }
                if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                    window.CentralHubBus.emit("focus-enterprise", {enterpriseId: resolvedId})
                }
            })
            head.appendChild(detailBtn)
        }

        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:12px;"
        closeBtn.addEventListener("click", () => wrap.remove())
        head.appendChild(closeBtn)
        wrap.appendChild(head)

        paneHost.appendChild(wrap)

        const records = await _loadAllRecords()
        const proj = _carrierNetworkFromRecords(records, carrier.iata)
        title.querySelector("div").textContent = proj.totalRoutes
            + " route" + (proj.totalRoutes === 1 ? "" : "s")
            + " · " + Array.from(proj.hubsTouched).length + " airports touched"
            + " · " + proj.totalWeekly + " unique flights cached"
            + (proj.totalLast7d ? " · " + proj.totalLast7d + " in last 7d" : "")

        if (!proj.routes.length) {
            const empty = _styleEl("div", "color:#94a3b8;font-size:11px;padding:6px 0;")
            empty.textContent = "No cached routes for " + carrier.iata
                + " on this server. Open /app/com/markets/* for routes "
                + carrier.iata + " operates to populate the cache."
            wrap.appendChild(empty)
            return
        }

        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const thead = document.createElement("thead")
        thead.innerHTML = "<tr style='color:#94a3b8;font-size:10px;text-transform:uppercase;'>"
            + "<th style='text-align:left;padding:4px 8px;'>Route</th>"
            + "<th style='text-align:right;padding:4px 8px;width:72px;'>Wkly</th>"
            + "<th style='text-align:right;padding:4px 8px;width:48px;'>7d</th>"
            + "<th style='text-align:left;padding:4px 8px;'>Departures (UTC hour)</th>"
            + "<th style='text-align:left;padding:4px 8px;width:160px;'>Top banks</th>"
            + "<th style='padding:4px 8px;width:80px;'></th>"
            + "</tr>"
        tbl.appendChild(thead)
        const tbody = document.createElement("tbody")
        const maxHour = proj.routes.reduce((mx, r) => Math.max(mx, ...r.depSpark), 1)

        for (const r of proj.routes.slice(0, 30)) {  // cap row count for very wide carriers
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:1px solid #1f2937;"
            const routeCell = document.createElement("td")
            routeCell.style.cssText = "padding:6px 8px;color:#e5e7eb;font-family:var(--aes-font-mono,monospace);"
            routeCell.textContent = r.hub + " → " + r.dest
            const wfCell = document.createElement("td")
            wfCell.style.cssText = "padding:6px 8px;text-align:right;color:#cbd5e1;"
            wfCell.textContent = String(r.weeklyFlights)
            const last7Cell = document.createElement("td")
            last7Cell.style.cssText = "padding:6px 8px;text-align:right;color:#94a3b8;"
            last7Cell.textContent = r.last7d > 0 ? String(r.last7d) : "—"
            // Sparkline cell — 24 bars, one per hour
            const sparkCell = document.createElement("td")
            sparkCell.style.cssText = "padding:6px 8px;"
            const sparkSvg = _svg("svg", {viewBox: "0 0 240 18", width: 240, height: 18})
            sparkSvg.style.background = "#0b1220"
            sparkSvg.style.borderRadius = "2px"
            for (let h = 0; h < 24; h++) {
                const v = r.depSpark[h]
                const x = h * 10 + 1
                const barH = v > 0 ? Math.max(2, Math.round((v / maxHour) * 16)) : 0
                if (barH > 0) {
                    sparkSvg.appendChild(_svg("rect", {
                        x, y: 18 - barH, width: 8, height: barH,
                        fill: "#a78bfa", "fill-opacity": 0.85
                    }))
                }
            }
            // Hour anchors at 06/12/18
            for (const h of [6, 12, 18]) {
                sparkSvg.appendChild(_svg("line", {
                    x1: h * 10 + 5, y1: 0, x2: h * 10 + 5, y2: 18,
                    stroke: "#1e293b", "stroke-width": 0.5
                }))
            }
            const sparkTip = _svg("title", null, [])
            sparkTip.textContent = "Hourly departure count UTC, 0–23. Max bar = "
                + maxHour + " on this network."
            sparkSvg.appendChild(sparkTip)
            sparkCell.appendChild(sparkSvg)
            const banksCell = document.createElement("td")
            banksCell.style.cssText = "padding:6px 8px;color:#cbd5e1;font-size:10px;"
            banksCell.textContent = r.topBanks.length
                ? r.topBanks.map(b => _minToHHMM(b.peakMin) + " ×" + b.count).join(" · ")
                : "—"
            const drillCell = document.createElement("td")
            drillCell.style.cssText = "padding:6px 8px;text-align:right;display:flex;gap:3px;justify-content:flex-end;"

            const mkDrill = (iata) => {
                const b = document.createElement("button")
                b.textContent = iata
                b.title = "Re-render the airport pane on " + iata
                    + " — hops along this carrier's network."
                b.style.cssText = "background:transparent;color:#94a3b8;border:1px solid #475569;"
                    + "border-radius:3px;padding:1px 5px;font-size:9px;cursor:pointer;"
                b.addEventListener("click", () => {
                    _onPickAirport(iata, data, paneHost, opts)
                })
                return b
            }
            drillCell.appendChild(mkDrill(r.hub))
            drillCell.appendChild(mkDrill(r.dest))

            tr.append(routeCell, wfCell, last7Cell, sparkCell, banksCell, drillCell)
            tbody.appendChild(tr)
        }
        tbl.appendChild(tbody)
        wrap.appendChild(tbl)

        if (proj.routes.length > 30) {
            const more = _styleEl("div", "margin-top:6px;font-size:10px;color:#94a3b8;")
            more.textContent = "Showing top 30 of " + proj.routes.length
                + " routes (sorted by weekly flights cached)."
            wrap.appendChild(more)
        }
    }

    /**
     * Per-airport ORS aggregate. Sums total connection counts across every
     * cached ORS route record where the airport is hub OR dest. Used by
     * slice 3's "ORS connections" layer to color/size bubbles by traffic
     * intensity rather than carrier count.
     *
     *   data.orsRoutes: Map<HUB-DEST, {hub, dest, byClass: {ECONOMY: {totalConnections}}}>
     * Returns Map<iata, {connections, routeCount}>
     */
    function _buildOrsAirportIndex(data) {
        const out = new Map()
        const ors = data && data.orsRoutes
        if (!ors || typeof ors.forEach !== "function") return out
        const bump = (iata, conn) => {
            const code = String(iata || "").toUpperCase()
            if (!/^[A-Z]{3}$/.test(code)) return
            const slot = out.get(code) || {connections: 0, routeCount: 0}
            slot.connections += conn
            slot.routeCount += 1
            out.set(code, slot)
        }
        for (const rec of ors.values()) {
            if (!rec || !rec.byClass) continue
            const ecoConn = (rec.byClass.ECONOMY && Number(rec.byClass.ECONOMY.totalConnections)) || 0
            const yConn   = (rec.byClass.Y       && Number(rec.byClass.Y.totalConnections))       || 0
            const conn = ecoConn || yConn || 0
            if (conn <= 0) continue
            if (rec.hub) bump(rec.hub, conn)
            if (rec.dest) bump(rec.dest, conn)
        }
        return out
    }

    /**
     * Per-airport alliance distribution. Walks every cached enterprise
     * record's `alliance: {id, name}` and stamps it onto every airport the
     * enterprise touches (hub from `enterprise.hubs[]`, plus dest of every
     * footprint edge they fly). Pure given the data envelope + the airport
     * index produced by `_buildAirportIndex`.
     *
     *   data.enterprises: Map<id, {alliance?: {id, name}, hubs?: [{iata}], iata?}>
     *   airportIndex:     Map<iata, {carriers: Map<id, {enterpriseId,...}>}>
     *
     * Returns Map<iata, {
     *   alliances: Map<allianceId, {id, name, count}>,
     *   dominantId, dominantName, dominantCount,
     *   distinctCount, totalAffiliated
     * }>
     *
     * Empty when no cached enterprise carries an alliance — the chip renders
     * disabled with a "scrape competitor enterprise pages" hint.
     */
    function _buildAllianceAirportIndex(data, airportIndex) {
        const out = new Map()
        const enterprises = data && data.enterprises
        if (!enterprises || typeof enterprises.forEach !== "function") return out
        if (!airportIndex || typeof airportIndex.values !== "function") return out

        // Map<enterpriseId, {id, name}|null> — every enterprise we have an
        // alliance reading on (null when an enterprise has been scraped but
        // is unaffiliated; absent when never scraped).
        const allianceByEnt = new Map()
        for (const [, rec] of enterprises) {
            if (!rec || !rec.enterpriseId) continue
            const alliance = rec.alliance && rec.alliance.id
                ? {id: String(rec.alliance.id), name: rec.alliance.name || null}
                : null
            allianceByEnt.set(String(rec.enterpriseId), alliance)
        }

        const bump = (iata, alliance) => {
            const code = String(iata || "").toUpperCase()
            if (!/^[A-Z]{3}$/.test(code)) return
            let slot = out.get(code)
            if (!slot) {
                slot = {
                    alliances: new Map(),
                    dominantId: null, dominantName: null, dominantCount: 0,
                    distinctCount: 0, totalAffiliated: 0
                }
                out.set(code, slot)
            }
            if (!alliance) return
            const cell = slot.alliances.get(alliance.id) || {id: alliance.id, name: alliance.name, count: 0}
            cell.count += 1
            if (alliance.name && !cell.name) cell.name = alliance.name
            slot.alliances.set(alliance.id, cell)
            slot.totalAffiliated += 1
        }

        for (const [iata, rec] of airportIndex) {
            for (const c of rec.carriers.values()) {
                const id = c && c.enterpriseId ? String(c.enterpriseId) : null
                if (!id) continue
                const alliance = allianceByEnt.get(id)
                bump(iata, alliance || null)
            }
        }

        for (const slot of out.values()) {
            slot.distinctCount = slot.alliances.size
            for (const cell of slot.alliances.values()) {
                if (cell.count > slot.dominantCount) {
                    slot.dominantId = cell.id
                    slot.dominantName = cell.name
                    slot.dominantCount = cell.count
                }
            }
        }
        return out
    }

    /**
     * Pass-through over `data.ourSchedule` (built by host.js from
     * `aircraftFlightPlan:schedule:<server>:*`). Kept as a view-side helper
     * so render() doesn't sprinkle `data.ourSchedule || new Map()` guards
     * everywhere; tests can mock here without touching host.js.
     */
    function _buildOurNetworkAirportIndex(data) {
        const ours = data && data.ourSchedule
        return ours && typeof ours.forEach === "function" ? ours : new Map()
    }

    /** Pass-through over `data.demand` — same shape contract as above. */
    function _buildDemandAirportIndex(data) {
        const dem = data && data.demand
        return dem && typeof dem.forEach === "function" ? dem : new Map()
    }

    /**
     * Stable colour from an allianceId so the same alliance keeps the same
     * bubble across re-renders. Five-bucket palette tuned for dark-mode
     * legibility against the #0f172a backdrop.
     */
    function _allianceColor(allianceId) {
        if (!allianceId) return {fill: "#475569", stroke: "#1e293b"}
        const palette = [
            {fill: "#fbbf24", stroke: "#92400e"},   // amber — Star
            {fill: "#a78bfa", stroke: "#581c87"},   // violet — Sky
            {fill: "#f87171", stroke: "#7f1d1d"},   // rose
            {fill: "#34d399", stroke: "#065f46"},   // emerald
            {fill: "#22d3ee", stroke: "#155e75"},   // cyan
            {fill: "#fb923c", stroke: "#9a3412"},   // orange
            {fill: "#e879f9", stroke: "#86198f"},   // fuchsia
            {fill: "#94a3b8", stroke: "#1e293b"}    // slate
        ]
        let h = 0
        const s = String(allianceId)
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
        return palette[Math.abs(h) % palette.length]
    }

    function render(host, data, opts) {
        host.innerHTML = ""
        const coords = window.WorldViewAirportCoords
        if (!coords) {
            host.textContent = "WorldViewAirportCoords not loaded — Map tab needs the world-view module."
            return
        }
        const idx = _buildAirportIndex(data || {}, coords)
        const orsIdx = _buildOrsAirportIndex(data || {})
        const allianceIdx = _buildAllianceAirportIndex(data || {}, idx)
        const ourIdx = _buildOurNetworkAirportIndex(data || {})
        const demandIdx = _buildDemandAirportIndex(data || {})

        // Layout: map on top (~60%), airport pane below (~40%).
        const wrap = _styleEl("div", "display:flex;flex-direction:column;height:100%;gap:8px;padding:8px 14px;")
        const mapWrap = _styleEl("div",
            "flex:0 0 60%;min-height:240px;background:#0b1220;border:1px solid #1f2937;border-radius:4px;overflow:hidden;position:relative;")
        const mapTitle = _styleEl("div",
            "padding:6px 10px;font-size:11px;color:#94a3b8;border-bottom:1px solid #1f2937;display:flex;justify-content:space-between;")
        const counts = []
        let withCoords = 0, withoutCoords = 0, totalCarriers = 0
        for (const r of idx.values()) {
            if (r.lat == null || r.lon == null) withoutCoords++
            else withCoords++
            totalCarriers += r.carriers.size
        }
        mapTitle.innerHTML = "<span><b style='color:#7dd3fc;'>EXPLORE</b> · "
            + idx.size + " airport" + (idx.size === 1 ? "" : "s")
            + " · " + totalCarriers + " carrier-cells cached"
            + (withoutCoords > 0 ? " · " + withoutCoords + " w/o coords" : "")
            + "</span>"
        // Layer chip group — Carriers / ORS connections / Alliances / Our
        // network / Demand. Each chip is a different read of the same airport
        // bubbles; data-poor layers auto-disable with a "what to scrape"
        // tooltip so the user knows how to unlock them.
        const chips = document.createElement("span")
        chips.style.cssText = "display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap;"
        const mkChip = (id, label, hint, enabled, disabledHint) => {
            const b = document.createElement("button")
            b.type = "button"
            b.dataset.layer = id
            b.textContent = label
            b.title = hint + (enabled ? "" : " " + (disabledHint || "(no cached data yet)"))
            b.disabled = !enabled
            b.style.cssText = "background:transparent;color:" + (enabled ? "#cbd5e1" : "#64748b") + ";"
                + "border:1px solid " + (enabled ? "#334155" : "#1e293b") + ";"
                + "border-radius:3px;padding:2px 8px;font-size:10px;cursor:" + (enabled ? "pointer" : "not-allowed") + ";"
            return b
        }
        const carriersChip = mkChip("carriers", "Carriers",
            "Bubble size = carriers cached at airport, color = our hub / ≥5 / default.", true)
        const orsChip = mkChip("ors", "ORS connections",
            "Bubble size = ORS total-connections summed across routes, color = traffic intensity.",
            orsIdx.size > 0,
            "(scrape ORS for at least one route to enable)")
        const allianceChip = mkChip("alliances", "Alliances",
            "Bubble color = dominant alliance at the airport, size = distinct alliances present. Reads cached enterprise records.",
            allianceIdx.size > 0,
            "(scrape competitor enterprise pages — alliances are pulled from /app/info/enterprises/<id>)")
        const ourChip = mkChip("ourNetwork", "Our network",
            "Bubble size = our weekly leg count touching the airport (departures + arrivals), color = own-hub / heavy / light.",
            ourIdx.size > 0,
            "(open at least one /app/fleets/aircraft/<id>/0 tab so the AFP scrape populates the schedule store)")
        const demandChip = mkChip("demand", "Demand",
            "Bubble size = AS pax demand × airport size (0–100 product), color = pax intensity. Reads routeAssistant:demand:* from country scrapes.",
            demandIdx.size > 0,
            "(open Route Assistant on a destination so the country scraper populates demand records)")
        chips.append(carriersChip, orsChip, allianceChip, ourChip, demandChip)
        mapTitle.appendChild(chips)
        mapWrap.appendChild(mapTitle)

        const svgHost = _styleEl("div", "width:100%;height:calc(100% - 28px);")
        const svg = _svg("svg", {
            viewBox: "0 0 " + VW + " " + VH,
            width: "100%", height: "100%",
            preserveAspectRatio: "xMidYMid meet"
        })
        svg.style.cssText = "background:#0f172a;display:block;"

        // Backdrop graticule (every 30°)
        for (let lon = -180; lon <= 180; lon += 30) {
            const x = ((lon + 180) / 360) * VW
            svg.appendChild(_svg("line", {
                x1: x, y1: 0, x2: x, y2: VH,
                stroke: "#1e293b", "stroke-width": 0.5
            }))
        }
        for (let lat = -60; lat <= 60; lat += 30) {
            const y = ((90 - lat) / 180) * VH
            svg.appendChild(_svg("line", {
                x1: 0, y1: y, x2: VW, y2: y,
                stroke: "#1e293b", "stroke-width": 0.5
            }))
        }

        let maxCarriers = 1
        for (const r of idx.values()) {
            if (r.carriers.size > maxCarriers) maxCarriers = r.carriers.size
        }
        let maxOrsConn = 1
        for (const slot of orsIdx.values()) {
            if (slot.connections > maxOrsConn) maxOrsConn = slot.connections
        }
        let maxAllianceCount = 1
        for (const slot of allianceIdx.values()) {
            if (slot.distinctCount > maxAllianceCount) maxAllianceCount = slot.distinctCount
        }
        let maxOurLegs = 1
        for (const slot of ourIdx.values()) {
            if ((slot.totalLegs || 0) > maxOurLegs) maxOurLegs = slot.totalLegs
        }
        let maxDemandProduct = 1
        for (const slot of demandIdx.values()) {
            const v = (Number(slot.paxScore) || 0) * (Number(slot.sizeScore) || 1)
            if (v > maxDemandProduct) maxDemandProduct = v
        }

        const bubbles = []
        let activeLayer = "carriers"
        const allChips = [carriersChip, orsChip, allianceChip, ourChip, demandChip]

        function paintBubbles() {
            for (const b of bubbles) {
                const r = b.rec
                const layer = activeLayer
                let sizeWeight, sizeMax, fill, stroke, tipExtra
                if (layer === "ors") {
                    const slot = orsIdx.get(r.iata) || null
                    sizeWeight = slot ? slot.connections : 0
                    sizeMax = maxOrsConn
                    if (r.isOurs)              { fill = "#10b981"; stroke = "#a7f3d0" }
                    else if (slot) {
                        const t = Math.max(0, Math.min(1, slot.connections / Math.max(1, maxOrsConn)))
                        if (t > 0.66)      { fill = "#ec4899"; stroke = "#831843" }
                        else if (t > 0.33) { fill = "#a855f7"; stroke = "#581c87" }
                        else               { fill = "#38bdf8"; stroke = "#0c4a6e" }
                    } else                     { fill = "#1e293b"; stroke = "#334155" }
                    tipExtra = slot
                        ? " · " + slot.connections + " ORS conns / " + slot.routeCount + " routes"
                        : " · no ORS"
                } else if (layer === "alliances") {
                    const slot = allianceIdx.get(r.iata) || null
                    sizeWeight = slot ? slot.distinctCount : 0
                    sizeMax = maxAllianceCount
                    if (r.isOurs)              { fill = "#10b981"; stroke = "#a7f3d0" }
                    else if (slot && slot.dominantId) {
                        const c = _allianceColor(slot.dominantId)
                        fill = c.fill; stroke = c.stroke
                    } else                     { fill = "#1e293b"; stroke = "#334155" }
                    if (slot && slot.distinctCount) {
                        tipExtra = " · " + slot.distinctCount + " alliance"
                            + (slot.distinctCount === 1 ? "" : "s")
                            + (slot.dominantName
                                ? " · top: " + slot.dominantName + " ×" + slot.dominantCount
                                : (slot.dominantId ? " · top: #" + slot.dominantId + " ×" + slot.dominantCount : ""))
                    } else {
                        tipExtra = " · no allied carriers"
                    }
                } else if (layer === "ourNetwork") {
                    const slot = ourIdx.get(r.iata) || null
                    sizeWeight = slot ? (slot.totalLegs || 0) : 0
                    sizeMax = maxOurLegs
                    if (r.isOurs)              { fill = "#10b981"; stroke = "#a7f3d0" }
                    else if (slot && slot.totalLegs > 0) {
                        const t = Math.max(0, Math.min(1, slot.totalLegs / Math.max(1, maxOurLegs)))
                        if (t > 0.66)      { fill = "#10b981"; stroke = "#064e3b" }
                        else if (t > 0.33) { fill = "#34d399"; stroke = "#065f46" }
                        else               { fill = "#6ee7b7"; stroke = "#047857" }
                    } else                     { fill = "#1e293b"; stroke = "#334155" }
                    tipExtra = slot && slot.totalLegs > 0
                        ? " · we fly " + slot.totalLegs + " legs/wk"
                            + (slot.aircraftIds && slot.aircraftIds.size
                                ? " · " + slot.aircraftIds.size + " aircraft" : "")
                        : " · we don't fly here"
                } else if (layer === "demand") {
                    const slot = demandIdx.get(r.iata) || null
                    const product = slot
                        ? (Number(slot.paxScore) || 0) * (Number(slot.sizeScore) || 1)
                        : 0
                    sizeWeight = product
                    sizeMax = maxDemandProduct
                    if (r.isOurs)              { fill = "#10b981"; stroke = "#a7f3d0" }
                    else if (slot && product > 0) {
                        const t = Math.max(0, Math.min(1, product / Math.max(1, maxDemandProduct)))
                        if (t > 0.66)      { fill = "#f87171"; stroke = "#7f1d1d" }
                        else if (t > 0.33) { fill = "#fbbf24"; stroke = "#92400e" }
                        else               { fill = "#a3e635"; stroke = "#365314" }
                    } else                     { fill = "#1e293b"; stroke = "#334155" }
                    tipExtra = slot
                        ? " · pax=" + (slot.paxScore != null ? slot.paxScore : "?")
                            + " size=" + (slot.sizeScore != null ? slot.sizeScore : "?")
                            + (slot.cargoScore != null ? " cargo=" + slot.cargoScore : "")
                        : " · no demand scrape"
                } else {
                    sizeWeight = r.carriers.size
                    sizeMax = maxCarriers
                    if (r.isOurs)                  { fill = "#10b981"; stroke = "#a7f3d0" }
                    else if (r.carriers.size >= 5) { fill = "#f59e0b"; stroke = "#0c4a6e" }
                    else                           { fill = "#38bdf8"; stroke = "#0c4a6e" }
                    tipExtra = " · " + r.carriers.size + " carrier(s)"
                        + (r.weeklyFlights > 0 ? " · " + Math.round(r.weeklyFlights) + " wkly" : "")
                }
                const radius = _radius(sizeWeight, sizeMax)
                b.circle.setAttribute("r", radius)
                b.circle.setAttribute("fill", fill)
                b.circle.setAttribute("stroke", stroke)
                b.circle.setAttribute("fill-opacity", r.isOurs ? 0.85 : 0.6)
                const tipEl = b.circle.querySelector("title")
                if (tipEl) {
                    tipEl.textContent = r.iata + (r.name ? " · " + r.name : "")
                        + tipExtra + (r.isOurs ? " · OUR HUB" : "")
                }
            }
        }

        function applyChipState() {
            for (const c of allChips) {
                const active = c.dataset.layer === activeLayer
                c.style.borderColor = active ? "#7dd3fc" : (c.disabled ? "#1e293b" : "#334155")
                c.style.color       = active ? "#7dd3fc" : (c.disabled ? "#64748b" : "#cbd5e1")
                c.style.background  = active ? "rgba(56,189,248,0.1)" : "transparent"
            }
        }

        for (const chip of allChips) {
            chip.addEventListener("click", () => {
                if (chip.disabled) return
                const next = chip.dataset.layer
                if (activeLayer === next) return
                activeLayer = next
                applyChipState()
                paintBubbles()
            })
        }
        applyChipState()

        for (const r of idx.values()) {
            if (r.lat == null || r.lon == null) continue
            const {x, y} = _project(r.lat, r.lon)
            const circle = _svg("circle", {
                cx: x, cy: y, r: 4,
                "data-iata": r.iata
            })
            circle.style.cursor = "pointer"
            const tip = _svg("title", null, [])
            circle.appendChild(tip)
            bubbles.push({circle, rec: r})
            svg.appendChild(circle)
        }
        paintBubbles()
        svgHost.appendChild(svg)
        mapWrap.appendChild(svgHost)
        wrap.appendChild(mapWrap)

        const paneWrap = _styleEl("div",
            "flex:1 1 40%;min-height:120px;background:#0b1220;border:1px solid #1f2937;border-radius:4px;overflow:auto;")
        const paneEmpty = _styleEl("div", "padding:14px;color:#94a3b8;font-size:11px;")
        paneEmpty.textContent = "Click any airport on the map to list its cached carriers."
        paneWrap.appendChild(paneEmpty)
        paneWrap._index = idx
        // Best-effort airport-id lookup from edges (for the Open-AS button)
        paneWrap._airportIdsByIata = new Map()
        if (data && data.edges && typeof data.edges.forEach === "function") {
            for (const e of data.edges.values()) {
                // edges don't carry airportId; nothing to fill in here. The
                // Open-AS button falls back to /app/info/search?query=IATA.
            }
        }
        wrap.appendChild(paneWrap)
        host.appendChild(wrap)

        // Wire bubble click → render carrier pane
        for (const b of bubbles) {
            b.circle.addEventListener("click", () => {
                _onPickAirport(b.rec.iata, data, paneWrap, opts)
                // Visual highlight
                for (const other of bubbles) {
                    other.circle.setAttribute("stroke-width", other.rec === b.rec ? 2.5 : (other.rec.isOurs ? 1.5 : 0.75))
                }
            })
        }
    }

    window.AesCompetitorIntelExploreMapView = {
        render,
        DEFAULT_SORT: null,
        // Internal — exposed for tests + future extensions.
        _buildAirportIndex,
        _carrierSummary,
        _radius,
        _project,
        _scheduleFromRecords,
        _hhmmToMin,
        _minToHHMM,
        _buildOrsAirportIndex,
        _carrierNetworkFromRecords,
        _buildAllianceAirportIndex,
        _buildOurNetworkAirportIndex,
        _buildDemandAirportIndex,
        _allianceColor
    }
})()
