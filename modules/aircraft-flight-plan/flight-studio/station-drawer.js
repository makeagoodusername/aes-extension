"use strict"

/**
 * Flight Studio — station drawer (Slice F3b).
 *
 * Right-side overlay that surfaces single-airport detail: distance from
 * the active hub, demand histogram, top operators on the route (or top
 * routes from the hub when iata === hub), and conflicts in the user's
 * saved schedule for this aircraft. Hub fees + runway constraints are
 * placeholders for a later F-slice.
 *
 *   AesAfpStationDrawer.open(iata, opts?)  → void  ; toggles when same iata
 *   AesAfpStationDrawer.close()            → void
 *   AesAfpStationDrawer.isOpen()           → boolean
 *
 * Mounted directly on document.body so Wicket re-mounts on the AFP host
 * never orphan it. ESC + click-outside dismiss. Sections populate
 * asynchronously and self-isolate — one missing store never blanks the
 * rest of the drawer.
 *
 * Bus events:
 *   studio:station-drawer-opened  {iata}
 *   studio:station-drawer-closed  {iata}
 */
;(function () {
    if (window.AesAfpStationDrawer) return

    let _root         = null
    let _backdrop     = null
    let _onKeyDown    = null
    let _currentIata  = null
    let _populateGen  = 0   // monotonically increases per open() call to discard stale fetches

    function open(destIata, opts) {
        const iata = String(destIata || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(iata)) return
        if (_root && _currentIata === iata) { close(); return }
        if (_root) close()
        _currentIata = iata
        _mount(iata, opts || {})
    }

    function close() {
        if (_onKeyDown) {
            window.removeEventListener("keydown", _onKeyDown)
            _onKeyDown = null
        }
        if (_backdrop && _backdrop.parentNode) _backdrop.parentNode.removeChild(_backdrop)
        if (_root && _root.parentNode)         _root.parentNode.removeChild(_root)
        _backdrop = null
        _root     = null
        const closedIata = _currentIata
        _currentIata = null
        _emit("studio:station-drawer-closed", {iata: closedIata})
    }

    function isOpen() { return !!_root }

    function _emit(event, payload) {
        if (!window.AesAfp || !AesAfp.bus || typeof AesAfp.bus.emit !== "function") return
        try { AesAfp.bus.emit(event, payload) } catch (_) { /* noop */ }
    }

    function _activeHub() {
        if (window.AesAfp && typeof AesAfp.getActiveHub === "function") {
            const h = AesAfp.getActiveHub()
            if (h) return String(h).toUpperCase()
        }
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        return String(ctx.currentLocationIata || "").toUpperCase()
    }

    function _mount(iata, opts) {
        _populateGen += 1
        const gen = _populateGen

        _backdrop = document.createElement("div")
        _backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.25);z-index:9998;"
        _backdrop.addEventListener("click", close)
        document.body.appendChild(_backdrop)

        _root = document.createElement("aside")
        _root.dataset.aesStationDrawer = "1"
        _root.style.cssText = "position:fixed;top:0;right:0;height:100vh;width:380px;max-width:90vw;"
            + "background:#0f1623;border-left:1px solid #374151;color:#cbd5e1;"
            + "font-family:var(--aes-font-stack,sans-serif);font-size:12px;line-height:1.4;"
            + "z-index:9999;display:flex;flex-direction:column;"
            + "box-shadow:-4px 0 12px rgba(0,0,0,0.4);"
        _root.addEventListener("click", ev => ev.stopPropagation())
        document.body.appendChild(_root)

        const hub = String((opts && opts.hub) || _activeHub() || "").toUpperCase()
        const isHubMode = hub && iata === hub

        const head = document.createElement("header")
        head.style.cssText = "display:flex;align-items:center;justify-content:space-between;"
            + "padding:10px 12px;border-bottom:1px solid #1f2937;background:#0a0f1a;flex:0 0 auto;"
        const title = document.createElement("div")
        title.style.cssText = "display:flex;align-items:baseline;gap:8px;"
        const iataEl = document.createElement("strong")
        iataEl.style.cssText = "font-size:18px;color:#f8fafc;letter-spacing:1px;"
        iataEl.textContent = iata
        const nameEl = document.createElement("span")
        nameEl.dataset.aesStationName = "1"
        nameEl.style.cssText = "color:#9ca3af;font-size:11px;"
        nameEl.textContent = "—"
        title.append(iataEl, nameEl)
        if (isHubMode) {
            const tag = document.createElement("span")
            tag.style.cssText = "color:#0a0f1a;background:#fbbf24;font-size:9px;padding:2px 5px;"
                + "border-radius:2px;font-weight:700;letter-spacing:0.5px;"
            tag.textContent = "HUB"
            title.appendChild(tag)
        }
        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "✕"
        closeBtn.title = "Close (Esc)"
        closeBtn.style.cssText = "background:transparent;color:#9ca3af;border:none;"
            + "font-size:16px;cursor:pointer;padding:2px 6px;"
        closeBtn.addEventListener("click", close)
        head.append(title, closeBtn)
        _root.appendChild(head)

        const body = document.createElement("div")
        body.dataset.aesStationBody = "1"
        body.style.cssText = "flex:1 1 auto;overflow-y:auto;padding:12px;"
            + "display:flex;flex-direction:column;gap:14px;"
        _root.appendChild(body)

        const sectDistance  = _section(isHubMode ? "Hub status" : "Distance",                    _placeholder("Resolving…"))
        const sectDemand    = _section("Demand",                                                 _placeholder("Loading…"))
        const sectOperators = _section(isHubMode ? "Top destinations from this hub" : "Operators on this route", _placeholder("Loading…"))
        const sectConflicts = _section(isHubMode ? "Schedule overview"                : "Conflicts in your schedule", _placeholder("Loading…"))
        const sectHubInfo   = _section("Hub info", _hubTbdNote())
        body.append(sectDistance, sectDemand, sectOperators, sectConflicts, sectHubInfo)

        _onKeyDown = ev => { if (ev.key === "Escape") { ev.preventDefault(); close() } }
        window.addEventListener("keydown", _onKeyDown)

        _emit("studio:station-drawer-opened", {iata})

        _populate(iata, hub, isHubMode, gen, {
            sectDistance, sectDemand, sectOperators, sectConflicts, nameEl
        }).catch(err => console.warn("[AES afp] station-drawer populate threw", err))
    }

    function _section(headingText, body) {
        const sec = document.createElement("section")
        sec.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        const h = document.createElement("h3")
        h.style.cssText = "margin:0;font-size:10px;text-transform:uppercase;"
            + "letter-spacing:1px;color:#9ca3af;font-weight:600;"
        h.textContent = headingText
        sec.append(h, body)
        return sec
    }

    function _placeholder(text) {
        const div = document.createElement("div")
        div.style.cssText = "color:#6b7280;font-size:11px;font-style:italic;"
        div.textContent = text
        return div
    }

    function _hubTbdNote() {
        const div = document.createElement("div")
        div.style.cssText = "color:#6b7280;font-size:11px;"
        div.textContent = "Runway / hub fees data — TBD (filled in a later F-slice)."
        return div
    }

    function _replaceSectionBody(section, newBody) {
        if (!section || !section.children || section.children.length < 2) return
        section.replaceChild(newBody, section.children[1])
    }

    async function _populate(iata, hub, isHubMode, gen, refs) {
        const ctx = (window.AesAfp && AesAfp.ctx) || {}

        let destAirport = null
        if (typeof FlightsFromStore !== "undefined") {
            try { destAirport = await FlightsFromStore.loadAirport(iata) } catch (_) {}
        }
        if (gen !== _populateGen) return
        if (refs.nameEl && destAirport && destAirport.airportName) refs.nameEl.textContent = destAirport.airportName

        let hubAirport = null
        let routeRec   = null
        if (typeof FlightsFromStore !== "undefined" && hub) {
            try {
                hubAirport = (hub === iata) ? destAirport : await FlightsFromStore.loadAirport(hub)
                if (hubAirport && Array.isArray(hubAirport.routes)) {
                    routeRec = hubAirport.routes.find(r =>
                        String(r.destIata || "").toUpperCase() === iata) || null
                }
            } catch (_) {}
        }
        if (gen !== _populateGen) return

        _replaceSectionBody(refs.sectDistance, isHubMode
            ? _renderHubStatus(hub, hubAirport)
            : _renderDistance(hub, iata, routeRec))

        let demand = null
        if (typeof RouteAssistantDemandStore !== "undefined") {
            try { demand = await RouteAssistantDemandStore.get(iata) } catch (_) {}
        }
        if (!_hasPaxDemand(demand)) demand = _flightsFromDemand(iata, hubAirport, routeRec, isHubMode)
        if (gen !== _populateGen) return
        _replaceSectionBody(refs.sectDemand, _renderDemand(demand))

        _replaceSectionBody(refs.sectOperators, isHubMode
            ? _renderHubTopRoutes(hubAirport)
            : _renderOperators(routeRec))

        let schedule = null
        if (typeof AesAfpScheduleStore !== "undefined" && ctx.server && ctx.aircraftId) {
            try { schedule = await AesAfpScheduleStore.load(ctx.server, ctx.aircraftId) } catch (_) {}
        }
        if (gen !== _populateGen) return
        _replaceSectionBody(refs.sectConflicts, _renderConflicts(schedule, iata, isHubMode))
    }

    function _renderDistance(hub, dest, routeRec) {
        const div = document.createElement("div")
        div.style.cssText = "color:#cbd5e1;font-size:12px;font-variant-numeric:tabular-nums;"
        if (!hub) { div.textContent = "Hub not resolved."; return div }
        if (!routeRec) {
            div.textContent = hub + " → " + dest + " · distance unknown (hub not yet scanned for this destination)"
            return div
        }
        const km = (routeRec.distanceKm == null) ? "?" : Math.round(routeRec.distanceKm).toLocaleString()
        const wf = routeRec.weeklyFlights == null ? "—" : routeRec.weeklyFlights
        div.textContent = hub + " → " + dest + " · " + km + " km · " + wf + "×/wk total"
        return div
    }

    function _renderHubStatus(hub, hubAirport) {
        const div = document.createElement("div")
        div.style.cssText = "color:#cbd5e1;font-size:12px;"
        if (!hubAirport) {
            div.textContent = "This is your active hub. Run flightsfrom.com scan to populate route data."
            return div
        }
        const routes = (hubAirport.routes || []).length
        const scrapedAt = hubAirport.scrapedAt
            ? new Date(hubAirport.scrapedAt).toISOString().slice(0, 10)
            : "—"
        div.textContent = "Active hub · " + routes + " known route" + (routes === 1 ? "" : "s")
            + " · scanned " + scrapedAt
        return div
    }

    function _renderDemand(demand) {
        if (!demand) {
            const note = document.createElement("div")
            note.style.cssText = "color:#6b7280;font-size:11px;"
            note.textContent = "No demand data — run the route-assistant demand scan."
            return note
        }
        if (demand.source === "flightsfrom" || demand.demandSource === "flightsfrom") {
            return _renderFlightsFromDemand(demand)
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        wrap.appendChild(_demandBar("Pax",   demand.paxScore,   "#60a5fa"))
        wrap.appendChild(_demandBar("Cargo", demand.cargoScore, "#fbbf24"))
        if (demand.scrapedAt && Date.now() - demand.scrapedAt > 7 * 86400000) {
            const stale = document.createElement("div")
            stale.style.cssText = "color:#fbbf24;font-size:10px;"
            stale.textContent = "stale (>7 days)"
            wrap.appendChild(stale)
        }
        return wrap
    }

    function _flightsFromDemand(iata, hubAirport, routeRec, isHubMode) {
        if (typeof FlightsFromStore === "undefined") return null
        if (isHubMode && typeof FlightsFromStore.demandForHub === "function") {
            return FlightsFromStore.demandForHub(hubAirport)
        }
        if (!routeRec || typeof FlightsFromStore.demandForRoute !== "function") return null
        const ctx = (hubAirport && Array.isArray(hubAirport.routes)
                && typeof FlightsFromStore.buildDemandContext === "function")
            ? FlightsFromStore.buildDemandContext(hubAirport.routes)
            : null
        const demand = FlightsFromStore.demandForRoute(routeRec, ctx)
        if (demand) {
            demand.iata = String(iata || demand.iata || "").toUpperCase()
            demand.scrapedAt = hubAirport ? hubAirport.scrapedAt : null
        }
        return demand
    }

    function _hasPaxDemand(demand) {
        return !!(demand && demand.paxScore !== null && demand.paxScore !== undefined
            && isFinite(Number(demand.paxScore)))
    }

    function _renderFlightsFromDemand(demand) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        const source = document.createElement("div")
        source.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;"
        source.textContent = "FlightsFrom frequency"
        wrap.appendChild(source)
        wrap.appendChild(_demandBar("Pax", demand.paxScore, "#60a5fa"))

        const meta = document.createElement("div")
        meta.style.cssText = "color:#cbd5e1;font-size:11px;font-family:var(--aes-font-mono,monospace);"
        const parts = []
        if (demand.scope === "hub") {
            if (demand.routeCount != null) parts.push(demand.routeCount + " routes")
            if (demand.weeklyFlightsTotal != null) parts.push(demand.weeklyFlightsTotal + "×/wk total")
            if (demand.topDestIata) {
                parts.push("top " + demand.topDestIata
                    + (demand.maxWeeklyFlights != null ? " " + demand.maxWeeklyFlights + "×/wk" : ""))
            }
        } else {
            if (demand.demandBasis) parts.push(demand.demandBasis)
            else if (demand.weeklyFlights != null) parts.push(demand.weeklyFlights + "×/wk")
        }
        meta.textContent = parts.length ? parts.join(" · ") : "frequency present"
        wrap.appendChild(meta)

        const cargo = document.createElement("div")
        cargo.style.cssText = "color:#6b7280;font-size:10px;"
        cargo.textContent = "Cargo demand unavailable from FlightsFrom."
        wrap.appendChild(cargo)
        if (demand.scrapedAt && Date.now() - demand.scrapedAt > 7 * 86400000) {
            const stale = document.createElement("div")
            stale.style.cssText = "color:#fbbf24;font-size:10px;"
            stale.textContent = "stale (>7 days)"
            wrap.appendChild(stale)
        }
        return wrap
    }

    function _demandBar(label, score, fillColor) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;"
        const lbl = document.createElement("span")
        lbl.style.cssText = "color:#9ca3af;width:42px;flex:0 0 42px;"
            + "text-transform:uppercase;letter-spacing:0.6px;font-size:10px;"
        lbl.textContent = label
        const bar = document.createElement("span")
        bar.style.cssText = "flex:1 1 auto;display:inline-flex;gap:1px;"
        const filled = (score == null) ? 0 : Math.max(0, Math.min(10, Math.round(Number(score) || 0)))
        for (let i = 0; i < 10; i++) {
            const cell = document.createElement("span")
            cell.style.cssText = "flex:1 1 0;height:8px;"
                + "background:" + (i < filled ? fillColor : "#1f2937") + ";"
            bar.appendChild(cell)
        }
        const num = document.createElement("span")
        num.style.cssText = "color:#cbd5e1;width:36px;flex:0 0 36px;text-align:right;"
            + "font-family:var(--aes-font-mono,monospace);"
        num.textContent = (score == null) ? "—" : (filled + "/10")
        wrap.append(lbl, bar, num)
        return wrap
    }

    function _renderOperators(routeRec) {
        if (!routeRec) {
            const note = document.createElement("div")
            note.style.cssText = "color:#6b7280;font-size:11px;"
            note.textContent = "Hub not yet scanned for this route."
            return note
        }
        const list = Array.isArray(routeRec.airlines) ? routeRec.airlines : null
        if (!list || !list.length) {
            const note = document.createElement("div")
            note.style.cssText = "color:#6b7280;font-size:11px;"
            note.textContent = "Carrier list not yet scanned for this route."
            return note
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        const sorted = list.slice().sort((a, b) => (Number(b.frequency) || 0) - (Number(a.frequency) || 0))
        for (const a of sorted.slice(0, 8)) wrap.appendChild(_carrierRow(a))
        if (sorted.length > 8) {
            const more = document.createElement("div")
            more.style.cssText = "color:#6b7280;font-size:10px;font-style:italic;margin-top:2px;"
            more.textContent = "+" + (sorted.length - 8) + " more carrier" + (sorted.length - 8 === 1 ? "" : "s")
            wrap.appendChild(more)
        }
        return wrap
    }

    function _carrierRow(a) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;justify-content:space-between;font-size:11px;"
            + "padding:2px 0;border-bottom:1px dashed #1f2937;color:#cbd5e1;"
        const name = document.createElement("span")
        name.textContent = a.code || a.name || "—"
        const freq = document.createElement("span")
        freq.style.cssText = "color:#9ca3af;font-family:var(--aes-font-mono,monospace);"
        freq.textContent = (Number(a.frequency) || 0) + "×/wk"
        row.append(name, freq)
        return row
    }

    function _renderHubTopRoutes(hubAirport) {
        if (!hubAirport || !Array.isArray(hubAirport.routes) || !hubAirport.routes.length) {
            const note = document.createElement("div")
            note.style.cssText = "color:#6b7280;font-size:11px;"
            note.textContent = "No flightsfrom.com data for this hub yet."
            return note
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        const sorted = hubAirport.routes.slice()
            .sort((a, b) => (Number(b.weeklyFlights) || 0) - (Number(a.weeklyFlights) || 0))
            .slice(0, 8)
        for (const r of sorted) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;justify-content:space-between;font-size:11px;"
                + "padding:2px 0;border-bottom:1px dashed #1f2937;color:#cbd5e1;"
            const dest = document.createElement("span")
            dest.textContent = (r.destIata || "—") + (r.destName ? " · " + r.destName : "")
            const wf = document.createElement("span")
            wf.style.cssText = "color:#9ca3af;font-family:var(--aes-font-mono,monospace);"
            wf.textContent = (Number(r.weeklyFlights) || 0) + "×/wk"
            row.append(dest, wf)
            wrap.appendChild(row)
        }
        if (hubAirport.routes.length > 8) {
            const more = document.createElement("div")
            more.style.cssText = "color:#6b7280;font-size:10px;font-style:italic;margin-top:2px;"
            more.textContent = "+" + (hubAirport.routes.length - 8) + " more destinations"
            wrap.appendChild(more)
        }
        return wrap
    }

    function _renderConflicts(schedule, iata, isHubMode) {
        if (!schedule || !Array.isArray(schedule.legs) || !schedule.legs.length) {
            const note = document.createElement("div")
            note.style.cssText = "color:#6b7280;font-size:11px;"
            note.textContent = "No saved schedule for this aircraft."
            return note
        }
        const matches = schedule.legs.filter(L =>
            String(L.origin || "").toUpperCase() === iata
            || String(L.destination || "").toUpperCase() === iata)
        if (!matches.length) {
            const note = document.createElement("div")
            note.style.cssText = "color:#10b981;font-size:11px;"
            note.textContent = isHubMode
                ? "No legs depart from or arrive at the hub yet."
                : "No conflicts — " + iata + " not currently in this aircraft's schedule."
            return note
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;"
        const head = document.createElement("div")
        head.style.cssText = "color:" + (isHubMode ? "#9ca3af" : "#fbbf24") + ";font-size:11px;"
        head.textContent = isHubMode
            ? matches.length + " leg" + (matches.length === 1 ? "" : "s") + " involve this hub"
            : matches.length + " existing leg" + (matches.length === 1 ? "" : "s") + " involve " + iata
        wrap.appendChild(head)
        for (const L of matches.slice(0, 12)) {
            const row = document.createElement("div")
            row.style.cssText = "font-size:11px;color:#cbd5e1;font-family:var(--aes-font-mono,monospace);"
            const code = L.flightCode || L.flightNumber || ""
            const od   = (L.origin || "?") + "→" + (L.destination || "?")
            const dep  = L.depTimeLocal || ""
            row.textContent = (code ? code + " · " : "") + od + (dep ? " · " + dep : "")
            wrap.appendChild(row)
        }
        if (matches.length > 12) {
            const more = document.createElement("div")
            more.style.cssText = "color:#6b7280;font-size:10px;font-style:italic;"
            more.textContent = "+" + (matches.length - 12) + " more leg" + (matches.length - 12 === 1 ? "" : "s")
            wrap.appendChild(more)
        }
        return wrap
    }

    window.AesAfpStationDrawer = {open, close, isOpen}
})()
