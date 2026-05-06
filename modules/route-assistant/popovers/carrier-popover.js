/**
 * RouteAssistantCarrierPopover
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantCarrierPopover {
    constructor(panel) {
        this.panel = panel;
    }

open(row, anchorEl, opts) {
    try {
        return this.panel._openCarrierPopoverInner(row, anchorEl, opts)
    } catch (err) {
        console.error("[RA] _openCarrierPopover threw:", err)
        // Surface a tiny, dismissable error popover anchored to the
        // pill instead of silently swallowing — the user reported a
        // hover crash; a visible message makes the failure
        // diagnosable rather than mysterious.
        try { this.panel.close() } catch (e) { /* noop */ }
        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:     "fixed",
            background:   "#1f2937",
            color:        "#fca5a5",
            border:       "1px solid #b91c1c",
            borderRadius: "5px",
            boxShadow:    "0 8px 25px rgba(0,0,0,0.55)",
            padding:      "8px 10px",
            zIndex:       "10002",
            maxWidth:     "440px",
            font:         "11px/1.4 sans-serif"
        })
        pop.textContent = "Competitor popover error: " + (err && err.message ? err.message : String(err))
        document.body.append(pop)
        this.panel._carrierPopover = pop
        this.panel._carrierPopoverPinned = false
        try { this.panel._positionCarrierPopover(anchorEl) } catch (e) { /* noop */ }
        const remove = () => {
            if (pop.parentNode) pop.parentNode.removeChild(pop)
            this.panel._carrierPopover = null
            document.removeEventListener("mousedown", remove)
        }
        setTimeout(() => document.addEventListener("mousedown", remove), 0)
        anchorEl.addEventListener("mouseleave", () => {
            setTimeout(() => { if (pop.parentNode) pop.parentNode.removeChild(pop) }, 250)
        }, {once: true})
        return pop
    }
}

_openCarrierPopoverInner(row, anchorEl, opts) {
    opts = opts || {}
    if (!row || !anchorEl) return null
    // Source priority for the popover content:
    //   1. competitorEntries — merged AS pax+cargo leaderboard, with
    //      flight-prefix backfill for routes without a leaderboard.
    //   2. marketSharePax — raw pax leaderboard (older cache shape).
    //   3. row.carriers — flightsfrom.com per-carrier list (Letter F).
    //   4. row.airlines — bare airline list from the flightsfrom listing
    //      page (only the primary name is known; remaining slots render
    //      as "?"). Without this, the Cmp pill could show "2~3" from
    //      `airlineCount` while the popover bailed to "no data" — leaving
    //      the user staring at a count with no airline to attach it to.
    //   5. Empty popover with a "no data yet" message.
    const fromMerged = Array.isArray(row.competitorEntries) ? row.competitorEntries.slice() : null
    const fromPaxOnly = Array.isArray(row.marketSharePax) ? row.marketSharePax.slice() : []
    let shares = (fromMerged && fromMerged.length) ? fromMerged : fromPaxOnly
    let usingFlightsFromFallback = false
    let usingAirlinesListFallback = false
    if (!shares.length && Array.isArray(row.carriers) && row.carriers.length) {
        usingFlightsFromFallback = true
        shares = row.carriers.map(c => ({
            enterpriseId:    null,
            name:            (c.name || c.code || "?")
                              + (c.weeklyFlights ? "  ·  " + c.weeklyFlights + "/wk" : ""),
            paxShare:        null,
            cargoShare:      null,
            paxRank:         null,
            cargoRank:       null,
            fromFlightsFrom: true
        }))
    }
    if (!shares.length && Array.isArray(row.airlines) && row.airlines.length) {
        usingAirlinesListFallback = true
        shares = row.airlines.map((name, i) => ({
            enterpriseId:    null,
            name:            name || (i === 0 ? "?" : "(name not on listing)"),
            paxShare:        null,
            cargoShare:      null,
            paxRank:         null,
            cargoRank:       null,
            fromFlightsFrom: true
        }))
    }
    // 5. Airport-overview fallback — when no per-route data exists
    //    but the user has visited the destination's AS airport page,
    //    surface the AS Stations table (every carrier operating from
    //    the destination, with weeklyDepartures and IL flag). Sorted
    //    by weeklyDepartures desc so the top operator is on top.
    // Capped at 30 — busy hubs (LHR/DXB/JFK) cache 100-300+ enterprises
    // and a per-carrier row is heavy (2 imgs each, banner 404s on
    // enterprises without custom logos firing DOM-mutating error
    // handlers). Past ~50 rows the synchronous build froze the AS tab.
    let usingAirportOverviewFallback = false
    let airportOverviewTruncatedFrom = 0
    const AIRPORT_OVERVIEW_CAP = 30
    if (!shares.length && row.airportId != null
            && this.panel._airportOverviewByStationId instanceof Map) {
        const rec = this.panel._airportOverviewByStationId.get(String(row.airportId))
        if (rec && Array.isArray(rec.carriers) && rec.carriers.length) {
            usingAirportOverviewFallback = true
            const baseLogoUrl = `https://${this.panel.server}.airlinesim.aero/app/logo/`
            const sorted = rec.carriers
                .slice()
                .sort((a, b) => (b.weeklyDepartures || 0) - (a.weeklyDepartures || 0))
            if (sorted.length > AIRPORT_OVERVIEW_CAP) {
                airportOverviewTruncatedFrom = sorted.length
            }
            shares = sorted
                .slice(0, AIRPORT_OVERVIEW_CAP)
                .map(c => ({
                    enterpriseId:             c.enterpriseId,
                    name:                     c.enterpriseName || "(unknown)",
                    allianceId:               c.allianceId || null,
                    bannerUrl:                baseLogoUrl + String(c.enterpriseId) + "/enterprise-s.png?strict=true",
                    allianceLogoUrl:          c.allianceId ? baseLogoUrl + String(c.allianceId) + "/enterprise-s.png?strict=true" : null,
                    airportWeeklyDepartures:  c.weeklyDepartures || 0,
                    isInterliningAtAirport:   !!c.isInterlining,
                    paxShare:                 null,
                    cargoShare:               null,
                    paxRank:                  null,
                    cargoRank:                null,
                    fromAirportOverview:      true
                }))
        }
    }
    // Render an EMPTY popover with a clear "no data" message rather than
    // returning silently — fixes the user-reported "hover doesn't register"
    // bug where the rich popover bailed but the native title fallback also
    // had nothing useful to show.
    // Rank by max share across pax + cargo so dominant operators
    // float to the top regardless of which leaderboard they lead.
    shares.sort((a, b) => {
        const aMax = Math.max(a.paxShare || a.sharePct || 0, a.cargoShare || 0)
        const bMax = Math.max(b.paxShare || b.sharePct || 0, b.cargoShare || 0)
        return bMax - aMax
    })
    // Defensive hard cap — every per-carrier row builds two <img>
    // tags whose error handlers mutate the DOM, and AS's logo 404s
    // are common enough that an oversized list froze the tab. The
    // airport-overview path is already capped at 30; this catches
    // any future scraper that produces a long list.
    const SHARES_HARD_CAP = 60
    let sharesTruncatedFrom = 0
    if (shares.length > SHARES_HARD_CAP) {
        sharesTruncatedFrom = shares.length
        shares = shares.slice(0, SHARES_HARD_CAP)
    }

    this.panel._closeCarrierPopover()

    const pop = document.createElement("div")
    pop.tabIndex = -1
    Object.assign(pop.style, {
        position:     "fixed",
        background:   "#1f2937",
        color:        "#f3f4f6",
        border:       "1px solid #15803d",
        borderRadius: "5px",
        boxShadow:    "0 8px 25px rgba(0,0,0,0.55)",
        padding:      "8px 10px",
        zIndex:       "10002",
        minWidth:     "320px",
        maxWidth:     "440px",
        maxHeight:    "70vh",
        overflowY:    "auto",
        font:         "11px/1.4 sans-serif"
    })

    const header = document.createElement("div")
    header.style.cssText = "color:#86efac;font-size:11px;margin-bottom:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;"
    const intensity = row.competitiveIntensity
        || (typeof RouteAssistantCarriersScraper !== "undefined"
            ? RouteAssistantCarriersScraper.intensity(shares.length || row.airlineCount)
            : null)
    const intensityColor = (typeof RouteAssistantCarriersScraper !== "undefined")
        ? RouteAssistantCarriersScraper.intensityColor(intensity)
        : "#9ca3af"
    const intensityPill = document.createElement("span")
    intensityPill.textContent = intensity ? intensity.toUpperCase() : "—"
    intensityPill.style.cssText = "padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;color:#0f172a;background:" + intensityColor + ";"
    const headTitle = document.createElement("strong")
    // Decompose the count: how many compete on pax, how many on
    // cargo. Bare total is misleading on freight-heavy routes.
    const paxN   = shares.filter(e => (e.paxShare   != null) || (e.sharePct != null && e.cargoShare == null)).length
    const cargoN = shares.filter(e => e.cargoShare != null).length
    let label
    if (!shares.length) {
        label = "No detail data yet"
    } else if (usingAirportOverviewFallback) {
        label = shares.length + " carrier" + (shares.length === 1 ? "" : "s")
            + " @ destination (AS Stations table)"
    } else if (usingAirlinesListFallback) {
        const known = shares.filter(e => e.name && e.name !== "?" && e.name !== "(name not on listing)").length
        label = shares.length + " real-world airline" + (shares.length === 1 ? "" : "s")
            + " · " + known + " named"
    } else if (usingFlightsFromFallback) {
        label = shares.length + " real-world carrier" + (shares.length === 1 ? "" : "s")
    } else {
        label = shares.length + " AS competitor" + (shares.length === 1 ? "" : "s")
        if (paxN && cargoN) label += " · " + paxN + " pax / " + cargoN + " cargo"
        else if (cargoN)    label += " · cargo only"
        else if (paxN)      label += " · pax only"
    }
    headTitle.textContent = label
    const period = document.createElement("span")
    period.textContent = row.marketSharePeriod ? "· " + row.marketSharePeriod : ""
    period.style.cssText = "color:#9ca3af;font-weight:normal;"
    header.append(headTitle, intensityPill, period)
    pop.append(header)

    if (shares.length) {
        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        for (const e of shares) {
            try {
                list.append(this.panel._buildCarrierRow(e, row))
            } catch (err) {
                console.error("[RA] _buildCarrierRow failed for entry", e, err)
                const stub = document.createElement("div")
                stub.style.cssText = "padding:3px 4px;color:#fca5a5;font-size:10px;"
                stub.textContent = (e && e.name) ? "(" + e.name + " — render error)"
                                                 : "(competitor render error)"
                list.append(stub)
            }
        }
        pop.append(list)
        if (sharesTruncatedFrom > shares.length) {
            const cap = document.createElement("div")
            cap.style.cssText = "color:#fbbf24;font-size:10px;margin-top:6px;font-style:italic;"
            cap.textContent = "Showing top " + shares.length + " of "
                + sharesTruncatedFrom + " competitors (popover capped for performance)."
            pop.append(cap)
        }
        if (usingFlightsFromFallback) {
            const note = document.createElement("div")
            note.style.cssText = "color:#fbbf24;font-size:10px;margin-top:6px;font-style:italic;"
            note.textContent = "↑ flightsfrom.com real-world carriers (no AS in-game market data scraped yet)."
            pop.append(note)
        } else if (usingAirlinesListFallback) {
            const note = document.createElement("div")
            note.style.cssText = "color:#fbbf24;font-size:10px;margin-top:6px;font-style:italic;"
            note.innerHTML = "↑ partial real-world list from the flightsfrom listing scan — only the primary carrier name is available. "
                + "Open <em>Settings → Carriers</em> and click <em>Sync carriers</em> to fill in the rest, "
                + "or <em>Settings → Market Analysis</em> for the AS in-game leaderboard."
            pop.append(note)
        } else if (usingAirportOverviewFallback) {
            if (airportOverviewTruncatedFrom > shares.length) {
                const cap = document.createElement("div")
                cap.style.cssText = "color:#fbbf24;font-size:10px;margin-top:6px;font-style:italic;"
                const airportHref = "/app/info/airports/" + encodeURIComponent(row.airportId)
                cap.innerHTML = "Showing top " + shares.length + " of "
                    + airportOverviewTruncatedFrom
                    + " carriers @ destination — <a href=\"" + airportHref
                    + "\" target=\"_blank\" rel=\"noreferrer noopener\" "
                    + "style=\"color:#93c5fd;\">open the airport page</a> for the full list."
                pop.append(cap)
            }
            const note = document.createElement("div")
            note.style.cssText = "color:#a78bfa;font-size:10px;margin-top:6px;font-style:italic;"
            note.innerHTML = "↑ carriers operating from the destination airport (AS <em>Stations</em> table). "
                + "For the per-route market-share leaderboard, open <em>Settings → Market Analysis</em> "
                + "and click <em>Sync market analysis</em>."
            pop.append(note)
        }
    } else {
        // No data at all — show a clear "fetch this" message instead of
        // returning silently. The user-reported "doesn't register" bug
        // came from silent returns leaving the user thinking the panel
        // was broken; now the popover always opens with an action hint.
        const empty = document.createElement("div")
        empty.style.cssText = "color:#9ca3af;font-size:11px;line-height:1.5;padding:6px 0;"
        empty.innerHTML = "No competitor detail captured for this route yet.<br><br>"
            + "<strong style='color:#86efac;'>To populate:</strong><br>"
            + "1. Open <em>Settings → Market Analysis</em> and click <em>Sync market analysis</em>, or<br>"
            + "2. Open <em>Settings → Carriers</em> and click <em>Sync carriers</em> for real-world data, or<br>"
            + "3. Visit <code>/app/com/markets/" + escapeHtml(this.panel.hubIata || "?") + escapeHtml(row.destIata || "?") + "</code> directly."
        pop.append(empty)
    }

    const footer = document.createElement("div")
    footer.style.cssText = "color:#6b7280;font-size:10px;margin-top:8px;border-top:1px solid #374151;padding-top:6px;"
    const meta = (this.panel.settings && this.panel.settings.carriers) || {}
    const missingMeta = shares.some(e => e.enterpriseId != null && !e.bannerUrl && !e.avatarUrl)
    const lastSync = meta.lastEnterpriseMetaSyncAt
        ? new Date(meta.lastEnterpriseMetaSyncAt).toLocaleString()
        : null
    const lines = []
    if (lastSync) lines.push("Enterprise meta last synced: " + lastSync)
    if (missingMeta) {
        lines.push("Some banners/avatars missing — open Settings → Carriers → \"Sync enterprise data\".")
    }
    if (row.marketsScrapedAt) {
        lines.push("Market shares from " + new Date(row.marketsScrapedAt).toLocaleString())
    }
    if (!lines.length) lines.push("Click a name to open the enterprise page.")
    footer.innerHTML = lines.map(s => escapeHtml(s)).join("<br>")
    pop.append(footer)

    document.body.append(pop)
    this.panel._carrierPopover = pop
    this.panel._carrierPopoverPinned = !!opts.pinned

    this.panel._positionCarrierPopover(anchorEl)

    const cancelClose = () => {
        if (this.panel._carrierPopoverCloseTimer) {
            clearTimeout(this.panel._carrierPopoverCloseTimer)
            this.panel._carrierPopoverCloseTimer = null
        }
    }
    const scheduleClose = () => {
        if (this.panel._carrierPopoverPinned) return
        cancelClose()
        this.panel._carrierPopoverCloseTimer = setTimeout(() => this.panel._closeCarrierPopover(), 250)
    }
    pop.addEventListener("mouseenter", cancelClose)
    pop.addEventListener("mouseleave", scheduleClose)
    anchorEl.addEventListener("mouseleave", scheduleClose)

    const onMouseDown = (e) => {
        if (!this.panel._carrierPopoverPinned) return
        if (pop.contains(e.target)) return
        if (e.target === anchorEl) return
        this.panel._closeCarrierPopover()
    }
    const onKey = (e) => { if (e.key === "Escape") this.panel._closeCarrierPopover() }
    setTimeout(() => {
        document.addEventListener("mousedown", onMouseDown)
        document.addEventListener("keydown",   onKey)
    }, 0)

    this.panel._carrierPopoverCleanup = () => {
        cancelClose()
        anchorEl.removeEventListener("mouseleave", scheduleClose)
        document.removeEventListener("mousedown", onMouseDown)
        document.removeEventListener("keydown",   onKey)
    }
    return pop
}

_closeCarrierPopover() {
    if (this.panel._carrierPopoverCloseTimer) {
        clearTimeout(this.panel._carrierPopoverCloseTimer)
        this.panel._carrierPopoverCloseTimer = null
    }
    if (this.panel._carrierPopoverCleanup) {
        try { this.panel._carrierPopoverCleanup() } catch (e) { /* noop */ }
        this.panel._carrierPopoverCleanup = null
    }
    if (this.panel._carrierPopover && this.panel._carrierPopover.parentNode) {
        this.panel._carrierPopover.parentNode.removeChild(this.panel._carrierPopover)
    }
    this.panel._carrierPopover = null
    this.panel._carrierPopoverPinned = false
}

}

window.RouteAssistantCarrierPopover = RouteAssistantCarrierPopover;
