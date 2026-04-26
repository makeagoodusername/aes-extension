/**
 * Side-by-side panel injected into AirlineSim's scheduling page. Reads the
 * current origin airport from the page, looks up scraped flightsfrom.com data
 * for that IATA, and renders a sortable table of real-world routes.
 *
 * The panel is a fixed-position, collapsible card so it doesn't disturb the
 * native scheduling UI. The user can pin / unpin with the header button.
 */
class FlightsFromSchedulePanel {
    /**
     * @param {object} opts
     * @param {function(): string|null} opts.resolveOriginIata - called on
     *   open and on re-render to figure out which airport's data to show.
     * @param {function(): Array<{destIata, weeklyFlights, seatsPerWeek}>}
     *   [opts.resolveSimRoutes] - optional: return the user's own scheduled
     *   destinations for side-by-side comparison.
     */
    constructor(opts) {
        this.resolveOriginIata = opts.resolveOriginIata
        this.resolveSimRoutes  = opts.resolveSimRoutes || (() => [])
        this.root = null
        this.body = null
        this.currentIata = null
        this.collapsed = false
    }

    mount() {
        if (this.root) return
        this.root = document.createElement("div")
        this.root.id = "aes-flightsfrom-panel"
        Object.assign(this.root.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            width: "360px",
            maxHeight: "60vh",
            background: "#1f2937",
            color: "#f3f4f6",
            border: "1px solid #374151",
            borderRadius: "6px",
            boxShadow: "0 4px 20px rgba(0,0,0,.35)",
            zIndex: "9999",
            font: "13px/1.4 sans-serif",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
        })

        const header = document.createElement("div")
        Object.assign(header.style, {
            padding: "8px 12px",
            background: "#111827",
            borderBottom: "1px solid #374151",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            cursor: "default"
        })
        const title = document.createElement("strong")
        title.textContent = "Real-world demand"
        title.style.flex = "1"
        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = "↻"
        refreshBtn.title = "Reload data"
        refreshBtn.style.cssText = "background:none;border:none;color:#f3f4f6;cursor:pointer;font-size:14px;"
        refreshBtn.addEventListener("click", () => this.render())
        const toggleBtn = document.createElement("button")
        toggleBtn.textContent = "_"
        toggleBtn.title = "Minimise"
        toggleBtn.style.cssText = "background:none;border:none;color:#f3f4f6;cursor:pointer;font-size:14px;"
        toggleBtn.addEventListener("click", () => this._toggleCollapse())
        header.append(title, refreshBtn, toggleBtn)

        this.body = document.createElement("div")
        Object.assign(this.body.style, {
            padding: "8px 12px",
            overflowY: "auto",
            flex: "1"
        })

        this.root.append(header, this.body)
        document.body.append(this.root)
        this.render()
    }

    _toggleCollapse() {
        if (!this.body) return
        this.collapsed = !this.collapsed
        this.body.style.display = this.collapsed ? "none" : "block"
    }

    async render() {
        if (!this.body) return
        this.body.innerHTML = ""

        const iata = this.resolveOriginIata ? this.resolveOriginIata() : null
        if (!iata) {
            this._note("Couldn't detect the origin airport on this page. Set the origin in the scheduler and reopen this panel.")
            return
        }
        this.currentIata = iata

        const rec = await FlightsFromStore.loadAirport(iata)
        if (!rec) {
            this._note(`No flightsfrom.com data cached for ${iata}. Open the Dashboard → Flights From panel and scan this airport first.`)
            return
        }

        const header = document.createElement("div")
        header.style.cssText = "margin-bottom:6px;color:#9ca3af;font-size:11px;"
        const age = rec.scrapedAt ? Math.round((Date.now() - rec.scrapedAt) / 3600e3) : null
        header.textContent = `${iata}${rec.airportName ? " — " + rec.airportName : ""}`
            + ` · ${(rec.routes || []).length} routes`
            + (age !== null ? ` · scraped ${age}h ago` : "")
        this.body.append(header)

        const simDests = new Set(
            (this.resolveSimRoutes() || []).map(r => String(r.destIata || "").toUpperCase())
        )

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
        const thead = document.createElement("thead")
        thead.innerHTML = `
            <tr>
                <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #374151;">To</th>
                <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #374151;">Wk</th>
                <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #374151;">Seats/Wk</th>
                <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #374151;">km</th>
            </tr>`
        table.append(thead)

        const tbody = document.createElement("tbody")
        const sorted = (rec.routes || []).slice().sort((a, b) =>
            (b.seatsPerWeek || b.weeklyFlights || 0) - (a.seatsPerWeek || a.weeklyFlights || 0))

        for (const r of sorted) {
            const tr = document.createElement("tr")
            const userHas = simDests.has(String(r.destIata).toUpperCase())
            if (userHas) tr.style.background = "rgba(34,197,94,.15)"
            tr.innerHTML = `
                <td style="padding:4px 6px;border-bottom:1px solid #2a3444;">
                    <strong>${escapeHtml(r.destIata)}</strong>
                    ${userHas ? '<span title="You fly this route" style="color:#22c55e;margin-left:4px;">●</span>' : ''}
                    ${r.destName ? '<br><span style="color:#9ca3af;font-size:11px;">' + escapeHtml(r.destName) + '</span>' : ''}
                </td>
                <td style="padding:4px 6px;text-align:right;border-bottom:1px solid #2a3444;">${r.weeklyFlights || "—"}</td>
                <td style="padding:4px 6px;text-align:right;border-bottom:1px solid #2a3444;">${r.seatsPerWeek ? r.seatsPerWeek.toLocaleString() : "—"}</td>
                <td style="padding:4px 6px;text-align:right;border-bottom:1px solid #2a3444;color:#9ca3af;">${r.distanceKm || "—"}</td>`
            tbody.append(tr)
        }
        table.append(tbody)
        this.body.append(table)
    }

    _note(msg) {
        const p = document.createElement("p")
        p.style.cssText = "color:#9ca3af;margin:6px 0;"
        p.textContent = msg
        this.body.append(p)
    }

    dispose() {
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root)
        this.root = null
        this.body = null
    }
}

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}
