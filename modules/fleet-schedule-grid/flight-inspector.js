"use strict"

/**
 * Fleet Schedule Grid — Flight Inspector popover.
 *
 * Anchored popover that opens when the user clicks (or drag-shifts) a flight
 * block on the grid. Surfaces the flight's metadata and the deep-links that
 * were already scraped into the schedule (`flight.overlayActions.editHref`,
 * `.deleteHref`, `.infoHref`, `flight.flightLink`) so the user can manipulate
 * the flight via the existing AS edit/delete overlays without us introducing
 * a new POST path. When opened from a drag-shift, also surfaces a "PROPOSED"
 * dep time and an "Open AS edit overlay with this time" button — the AS form
 * is what actually applies the change; we only stage the suggestion.
 *
 * Single-instance: a second open() closes the prior popover first.
 *
 * Closes via X, Esc, or outside-click. Outside-click is deferred one tick so
 * the open click that produced the popover doesn't immediately close it.
 */
class FleetScheduleGridFlightInspector {

    static OPEN_CLASS = "aes-fsg-flight-inspector"
    static _active = null

    /**
     * @param {object} args
     *   - block: schedule block (`{kind:"flight", flight, dayIdx, startMin, endMin, durationMin, classifiers}`)
     *   - aircraftId: string
     *   - fleetRow: row record from FleetHubAircraftAggregator (registration, hub, equipment)
     *   - schedule: full schedule for the aircraft (used for day-of-week recurrence)
     *   - anchorRect: getBoundingClientRect of the clicked block (for positioning)
     *   - proposedDepMin?: number — drag-shift result; if set, inspector renders the suggestion strip
     *   - origDepMin?: number — original dep time (so the suggestion can show ±)
     *   - filterRouteKey?: string|null — currently-active route filter
     *   - onFilter: (routeKey, bool) => void
     *   - onOpenCockpit: (aircraftId) => void
     */
    static open(args) {
        if (FleetScheduleGridFlightInspector._active) {
            FleetScheduleGridFlightInspector._active.close()
        }
        const inst = new FleetScheduleGridFlightInspector(args)
        FleetScheduleGridFlightInspector._active = inst
        inst._mount()
        return inst
    }

    static close() {
        if (FleetScheduleGridFlightInspector._active) {
            FleetScheduleGridFlightInspector._active.close()
        }
    }

    constructor(args) {
        const a = args || {}
        this.block          = a.block || null
        this.aircraftId     = a.aircraftId || null
        this.fleetRow       = a.fleetRow || null
        this.schedule       = a.schedule || null
        this.anchorRect     = a.anchorRect || null
        this.proposedDepMin = (typeof a.proposedDepMin === "number" && isFinite(a.proposedDepMin)) ? a.proposedDepMin : null
        this.origDepMin     = (typeof a.origDepMin === "number" && isFinite(a.origDepMin)) ? a.origDepMin : null
        this.filterRouteKey = a.filterRouteKey || null
        this.onFilter       = typeof a.onFilter === "function" ? a.onFilter : (() => {})
        this.onOpenCockpit  = typeof a.onOpenCockpit === "function" ? a.onOpenCockpit : (() => {})
        this._rootEl = null
        this._keydown = null
        this._outsideClick = null
    }

    close() {
        if (this._rootEl && this._rootEl.parentElement) {
            this._rootEl.parentElement.removeChild(this._rootEl)
        }
        if (this._keydown) document.removeEventListener("keydown", this._keydown, true)
        if (this._outsideClick) document.removeEventListener("mousedown", this._outsideClick, true)
        if (FleetScheduleGridFlightInspector._active === this) {
            FleetScheduleGridFlightInspector._active = null
        }
    }

    _mount() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const root = document.createElement("div")
        root.className = FleetScheduleGridFlightInspector.OPEN_CLASS
        root.style.cssText = "position:fixed;z-index:" + (T ? "calc(" + T.z.modal + " + 5)" : "10005") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "box-shadow:0 12px 32px rgba(0,0,0,0.35);"
            + "min-width:340px;max-width:440px;font-size:12px;"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
        document.body.appendChild(root)
        this._rootEl = root

        this._render(T)
        this._positionAnchored(root, this.anchorRect)

        this._keydown = (e) => { if (e.key === "Escape") { e.preventDefault(); this.close() } }
        document.addEventListener("keydown", this._keydown, true)
        this._outsideClick = (e) => {
            if (this._rootEl && !this._rootEl.contains(e.target)) this.close()
        }
        setTimeout(() => document.addEventListener("mousedown", this._outsideClick, true), 0)
    }

    _render(T) {
        this._rootEl.innerHTML = ""

        const block = this.block || {}
        const flight = block.flight || {}
        const fleetRow = this.fleetRow || {}
        const code = flight.flightCode || flight.flightNumber || "(unknown)"
        const orig = flight.origin || (this.origDepMin === 0 && fleetRow.hub) || "?"
        const dest = flight.destination || "?"
        const reg = fleetRow.registration || this.aircraftId
        const eqp = fleetRow.equipment || ""
        const startLocal = block.startLocal || this._fmtMin(block.startMin)
        const endLocal   = block.endLocal   || this._fmtMin(block.endMin)
        const dayName = this._dayName(block.dayIdx)

        // Header.
        const header = document.createElement("div")
        header.style.cssText = "padding:10px 12px;display:flex;align-items:center;gap:10px;"
            + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"
        const title = document.createElement("div")
        title.style.cssText = "flex:1 1 auto;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;font-size:12px;"
        title.textContent = code + "  ·  " + orig + " → " + dest
        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "×"
        close.title = "Close (Esc)"
        close.style.cssText = "padding:2px 8px;cursor:pointer;border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2B2520") + ";font-size:14px;"
        close.addEventListener("click", () => this.close())
        header.append(title, close)
        this._rootEl.appendChild(header)

        // Body.
        const body = document.createElement("div")
        body.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:8px;"

        // Aircraft + time grid.
        const meta = document.createElement("div")
        meta.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:11px;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
        const monoCss = "font-family:" + (T ? T.font.mono : "monospace") + ";font-weight:700;"
        const mutedCss = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-weight:700;letter-spacing:0.04em;"
        meta.appendChild(this._kvLine(T, "Aircraft", reg + (eqp ? " · " + eqp : "")))
        meta.appendChild(this._kvLine(T, "Day", dayName))
        meta.appendChild(this._kvLine(T, "Time", startLocal + " – " + endLocal + "  (" + Math.round(block.durationMin || 0) + " min)", monoCss))
        if (flight.flightId) meta.appendChild(this._kvLine(T, "Flight #", String(flight.flightId), monoCss))
        if (block.classifiers) {
            const flags = []
            if (block.classifiers.locked) flags.push("LOCKED")
            if (block.classifiers.dimmed) flags.push("DIMMED")
            if (block.classifiers.short)  flags.push("SHORT")
            if (block.classifiers.spansFromPrev) flags.push("SPANS FROM PREV DAY")
            if (block.classifiers.spansIntoNext) flags.push("SPANS INTO NEXT DAY")
            if (flags.length) meta.appendChild(this._kvLine(T, "Flags", flags.join(" · "), monoCss))
        }
        body.appendChild(meta)

        // Day-of-week recurrence strip — read-only visual showing every day this
        // flight number runs, derived from the schedule's full week of blocks.
        const daysActive = this._daysActiveFor(flight)
        if (daysActive) {
            const dayWrap = document.createElement("div")
            dayWrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;"
            const lbl = document.createElement("span")
            lbl.style.cssText = mutedCss
            lbl.textContent = "Recurs"
            const cells = document.createElement("div")
            cells.style.cssText = "display:flex;gap:2px;flex:1 1 auto;"
            const DN = ["M","T","W","T","F","S","S"]
            for (let i = 0; i < 7; i++) {
                const c = document.createElement("span")
                c.style.cssText = "flex:1 1 0;text-align:center;padding:2px 0;font-family:" + (T ? T.font.mono : "monospace") + ";"
                    + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                    + "background:" + (daysActive[i] ? (T ? T.color.cobalt : "#3656A8") : "transparent") + ";"
                    + "color:" + (daysActive[i] ? (T ? T.color.boneFg : "#F4F1EA") : (T ? T.color.oxide2 : "#4A413B")) + ";"
                    + "font-weight:" + (daysActive[i] ? "700" : "400") + ";"
                c.textContent = DN[i]
                cells.appendChild(c)
            }
            dayWrap.append(lbl, cells)
            body.appendChild(dayWrap)
        }

        // Proposed dep time strip — only shown when the inspector was opened
        // from a drag-shift gesture. Tells the user the new dep time and offers
        // a deep-link to the AS edit overlay where the actual change lands.
        if (this.proposedDepMin != null && this.origDepMin != null
                && this.proposedDepMin !== this.origDepMin) {
            const delta = this.proposedDepMin - this.origDepMin
            const sign = delta > 0 ? "+" : ""
            const proposed = document.createElement("div")
            proposed.style.cssText = "padding:8px 10px;font-size:11px;"
                + "background:" + (T ? T.color.amberSoft : "rgba(184,134,31,0.14)") + ";"
                + "border:1px solid " + (T ? T.color.amber : "#B8861F") + ";"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "display:flex;flex-direction:column;gap:4px;"
            const head = document.createElement("div")
            head.innerHTML = "<b>Proposed dep time:</b> "
                + "<span style=\"" + monoCss + "\">" + this._fmtMin(this.proposedDepMin) + "</span>"
                + "  (" + sign + delta + " min from " + this._fmtMin(this.origDepMin) + ")"
            const note = document.createElement("div")
            note.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            note.textContent = "AES never POSTs to AS. Click below to open the AS edit overlay where you can apply this time."
            proposed.append(head, note)
            body.appendChild(proposed)
        }

        this._rootEl.appendChild(body)

        // Footer with deep-link buttons. The first row holds AS deep-links;
        // the second row holds in-grid actions. We intentionally separate them
        // visually because the first row navigates away from the grid.
        const oa = (flight.overlayActions || {})
        const editHref   = this._absHref(oa.editHref || flight.flightLink || null)
        const deleteHref = this._absHref(oa.deleteHref || null)
        const numbersHref = this._absHref(oa.infoHref || flight.flightLink || null)
        const aircraftHref = this.aircraftId ? "/app/fleets/aircraft/" + encodeURIComponent(this.aircraftId) + "/0" : null

        const asRow = document.createElement("div")
        asRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        if (editHref) asRow.appendChild(this._linkBtn(T, "Edit on AS ↗", editHref,
            this.proposedDepMin != null && this.proposedDepMin !== this.origDepMin
                ? "rust" : "default",
            "Open the AS edit overlay for this flight in a new tab."))
        if (deleteHref) asRow.appendChild(this._linkBtn(T, "Delete on AS ↗", deleteHref, "default",
            "Open the AS delete overlay in a new tab. AS asks you to confirm before the deletion is final."))
        if (numbersHref) asRow.appendChild(this._linkBtn(T, "Numbers ↗", numbersHref, "default",
            "Open the Flight Number page (loads, prices, profitability)."))
        if (aircraftHref) asRow.appendChild(this._linkBtn(T, "Flight Plan ↗", aircraftHref, "default",
            "Open this aircraft's Flight Plan tab."))
        this._rootEl.appendChild(asRow)

        // Grid-action row.
        const gridRow = document.createElement("div")
        gridRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        const routeKey = this._routeKeyOf(flight)
        const isFiltered = routeKey && this.filterRouteKey === routeKey
        if (routeKey) {
            const filterBtn = this._actionBtn(T, isFiltered ? "Clear route filter" : "Filter to route",
                "default", isFiltered
                    ? "Stop filtering — show all flights again."
                    : "Show only flights on " + (flight.origin || "?") + "→" + (flight.destination || "?") + " across the whole grid.")
            filterBtn.addEventListener("click", () => {
                try { this.onFilter(routeKey, !isFiltered) } catch (_) {}
                this.close()
            })
            gridRow.appendChild(filterBtn)
        }

        const cockpitBtn = this._actionBtn(T, "Open Cockpit", "default",
            "Open the per-aircraft cockpit drawer for " + reg + ".")
        cockpitBtn.addEventListener("click", () => {
            try { this.onOpenCockpit(this.aircraftId) } catch (_) {}
            this.close()
        })
        gridRow.appendChild(cockpitBtn)

        this._rootEl.appendChild(gridRow)
    }

    _kvLine(T, key, val, valCss) {
        const wrap = document.createDocumentFragment()
        const k = document.createElement("span")
        k.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-weight:700;letter-spacing:0.04em;"
        k.textContent = key
        const v = document.createElement("span")
        v.style.cssText = valCss || ("color:" + (T ? T.color.oxide : "#2B2520") + ";")
        v.textContent = val
        wrap.append(k, v)
        return wrap
    }

    _linkBtn(T, text, href, variant, title) {
        const a = document.createElement("a")
        a.href = href
        a.target = "_blank"
        a.rel = "noopener"
        a.title = title || ""
        a.textContent = text
        a.style.cssText = "padding:5px 10px;cursor:pointer;font-size:11px;text-decoration:none;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.04em;font-weight:700;"
        if (variant === "rust") {
            a.style.background = (T ? T.color.rust : "#B8472A")
            a.style.color      = (T ? T.color.rustFg : "#F4F1EA")
        } else {
            a.style.background = (T ? T.color.bone : "#F4F1EA")
            a.style.color      = (T ? T.color.oxide : "#2B2520")
        }
        return a
    }

    _actionBtn(T, text, variant, title) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = text
        b.title = title || ""
        b.style.cssText = "padding:5px 10px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.04em;font-weight:700;"
        return b
    }

    /** Resolve a relative scraped href against the AS app root. */
    _absHref(href) {
        if (!href) return null
        if (/^https?:/i.test(href)) return href
        if (href.startsWith("/")) return href
        // overlayActions hrefs come back like "./0?516-1.-tabs..." — anchor them
        // to the aircraft flight-plan path so the link resolves properly when
        // opened in a new tab from any AS page.
        if (href.startsWith("./") && this.aircraftId) {
            return "/app/fleets/aircraft/" + encodeURIComponent(this.aircraftId) + "/" + href.substring(2)
        }
        if (href.startsWith("../") && this.aircraftId) {
            // "../../../com/numbers/9412?..." style — let the browser resolve
            // relative to the aircraft page by anchoring against /app/fleets/aircraft/{id}/0.
            const base = "/app/fleets/aircraft/" + encodeURIComponent(this.aircraftId) + "/0"
            try { return new URL(href, "https://x" + base).pathname + new URL(href, "https://x" + base).search }
            catch (_) { return href }
        }
        return href
    }

    _routeKeyOf(flight) {
        if (!flight) return null
        const o = (flight.origin || "").toUpperCase()
        const d = (flight.destination || "").toUpperCase()
        if (!o || !d || o === "?" || d === "?") return null
        return o + "→" + d
    }

    _daysActiveFor(flight) {
        if (!this.schedule || !Array.isArray(this.schedule.days) || !flight) return null
        const target = (flight.flightId || flight.flightCode || "").toString()
        if (!target) return null
        const out = [false, false, false, false, false, false, false]
        let any = false
        for (let i = 0; i < this.schedule.days.length && i < 7; i++) {
            const day = this.schedule.days[i]
            if (!day || !Array.isArray(day.blocks)) continue
            for (const b of day.blocks) {
                if (b.kind !== "flight" || !b.flight) continue
                const id = (b.flight.flightId || b.flight.flightCode || "").toString()
                if (id && id === target) { out[i] = true; any = true; break }
            }
        }
        return any ? out : null
    }

    _positionAnchored(root, rect) {
        if (!rect) {
            root.style.left = "50%"
            root.style.top = "50%"
            root.style.transform = "translate(-50%, -50%)"
            return
        }
        const vw = window.innerWidth, vh = window.innerHeight
        let x = Math.round(rect.right + 8)
        let y = Math.round(rect.top)
        // First pass — clamp to viewport using a guess of 360x320; then
        // re-measure in rAF and tighten.
        x = Math.min(x, vw - 360 - 12)
        y = Math.min(y, vh - 320 - 12)
        if (x < 12) x = Math.max(12, Math.round(rect.left - 360 - 8))
        if (y < 12) y = 12
        root.style.left = x + "px"
        root.style.top  = y + "px"
        requestAnimationFrame(() => {
            const r = root.getBoundingClientRect()
            let nx = x, ny = y
            if (nx + r.width > vw - 12) nx = Math.max(12, vw - r.width - 12)
            if (ny + r.height > vh - 12) ny = Math.max(12, vh - r.height - 12)
            root.style.left = nx + "px"
            root.style.top  = ny + "px"
        })
    }

    _fmtMin(min) {
        if (min == null || !isFinite(min)) return "??:??"
        const m = Math.max(0, Math.min(1439, Math.round(min)))
        const h = Math.floor(m / 60), mm = m % 60
        return (h < 10 ? "0" + h : h) + ":" + (mm < 10 ? "0" + mm : mm)
    }

    _dayName(dayIdx) {
        const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        return (Number.isInteger(dayIdx) && dayIdx >= 0 && dayIdx < 7) ? names[dayIdx] : "?"
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridFlightInspector = FleetScheduleGridFlightInspector
}
