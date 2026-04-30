"use strict"

/**
 * Fleet Hub tile — surfaces the per-server aircraft roster summary.
 *
 * Reads the fleet record at `<server><sanitizedAirlineName>aircraftFleet`
 * (the canonical key written by content_fleetManagement.js). Since the
 * sanitized-name fragment isn't always recoverable from the navbar, the
 * tile scans the full chrome.storage.local namespace for any key on the
 * current server ending in "aircraftFleet" and picks the freshest.
 *
 * Open → /app/fleets, where the Fleet Hub overlay (modules/fleet-hub) and
 * Aircraft Flight Plan Dashboard (D action chip) take over.
 */
class CentralHubFleetHubTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "fleet-hub"
        this.title = "Fleet Hub"
        this.section = "fleet"
        this.priority = 10
        this.requiresAirline = false
        this._focusedAircraftId = null   // CH-5d-3
    }

    watchedStorageKeys(ctx) {
        const server = String(ctx && ctx.server || "")
        const airline = String(ctx && ctx.airline || "")
        if (server && airline) return [server + airline + "aircraftFleet"]
        return server ? [server] : []
    }

    openHref() { return "/app/fleets" }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this.subscribeBus("focus-aircraft", ({aircraftId}) => {
            if (!aircraftId) return
            this._focusedAircraftId = String(aircraftId)
            if (!this.expanded) this.toggle()
            if (this.root) this.root.scrollIntoView({behavior: "smooth", block: "start"})
            this._renderBodySafe()
        })
    }

    async _findFleetRecord() {
        const server = (this.ctx && this.ctx.server) || ""
        const airline = (this.ctx && this.ctx.airline) || ""
        if (!server) return null
        // Prefer the exact (server, airline) key when ctx supplies an airline;
        // otherwise fall back to the legacy "newest by max time on this server"
        // heuristic so single-airline users still see their fleet.
        if (airline) {
            const key = server + airline + "aircraftFleet"
            const blob = await chrome.storage.local.get(key)
            const rec = blob && blob[key]
            if (rec && Array.isArray(rec.fleet) && rec.fleet.length) {
                return {key, record: rec}
            }
            return null
        }
        const all = await chrome.storage.local.get(null)
        let best = null
        let bestTime = ""
        for (const k in all) {
            if (k.indexOf(server) !== 0) continue
            if (k.lastIndexOf("aircraftFleet") !== k.length - "aircraftFleet".length) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.fleet) || !rec.fleet.length) continue
            const latest = rec.fleet.reduce((acc, a) => (a && a.time && a.time > acc) ? a.time : acc, "")
            if (!best || latest > bestTime) { best = {key: k, record: rec}; bestTime = latest }
        }
        return best
    }

    async loadStatus() {
        const found = await this._findFleetRecord()
        if (!found) {
            return {
                badge: "NO DATA",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No fleet stored. Visit /app/fleets to extract."
            }
        }
        const fleet = found.record.fleet
        const count = fleet.length
        const types = new Set(fleet.map(a => a.equipment).filter(Boolean))
        const latest = fleet.reduce(
            (acc, a) => (a && a.time && a.time > acc) ? a.time : acc, "")
        return {
            badge: String(count),
            badgeKind: window.CentralHubStatusBadges.KIND.OK,
            summary: count + " aircraft · " + types.size + " types"
                + (latest ? " · scraped " + latest : "")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const found = await this._findFleetRecord()
        if (!found) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Visit /app/fleets to populate the fleet roster."
            host.appendChild(empty)
            return
        }

        if (this._focusedAircraftId) {
            const aircraft = found.record.fleet.find(a => String(a && a.aircraftId) === this._focusedAircraftId)
            host.appendChild(this._renderFocusBanner(aircraft, T))
            if (aircraft) {
                host.appendChild(this._renderFocusedAircraft(aircraft, T))
                return
            }
        }

        const fleet = found.record.fleet
        const byType = new Map()
        for (const a of fleet) {
            const k = a.equipment || "(unknown)"
            const cur = byType.get(k) || {count: 0, fleets: new Set()}
            cur.count++
            if (a.fleet) cur.fleets.add(a.fleet)
            byType.set(k, cur)
        }
        const rows = Array.from(byType.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8)

        const table = document.createElement("table")
        table.style.cssText = [
            "width:100%",
            "border-collapse:collapse",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono
        ].join(";")

        const head = document.createElement("thead")
        head.innerHTML =
            "<tr>" +
            "<th style='text-align:left;padding:" + T.sp[1] + " " + T.sp[2] +
                ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";'>Equipment</th>" +
            "<th style='text-align:right;padding:" + T.sp[1] + " " + T.sp[2] +
                ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";'>Count</th>" +
            "<th style='text-align:left;padding:" + T.sp[1] + " " + T.sp[2] +
                ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";'>Sub-fleets</th>" +
            "</tr>"

        const body = document.createElement("tbody")
        for (const [eq, info] of rows) {
            const tr = document.createElement("tr")
            tr.innerHTML =
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";'>" + escapeHtml(eq) + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;'>" + info.count + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.oxide2 + ";'>"
                    + escapeHtml(Array.from(info.fleets).join(", ") || "—") + "</td>"
            body.appendChild(tr)
        }
        table.append(head, body)
        host.appendChild(table)

        if (byType.size > rows.length) {
            const more = document.createElement("p")
            more.style.cssText = [
                "margin:" + T.sp[2] + " 0 0 0",
                "color:" + T.color.slate,
                "font-style:italic"
            ].join(";")
            more.textContent = "+ " + (byType.size - rows.length) + " more types — open /app/fleets for the full list."
            host.appendChild(more)
        }
    }

    _renderFocusBanner(aircraft, T) {
        const banner = document.createElement("div")
        banner.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "margin-bottom:" + T.sp[2],
            "background:" + T.color.cobaltSoft,
            "color:" + T.color.cobalt,
            "border:" + T.geom.bw1 + " solid " + T.color.cobalt,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body
        ].join(";")
        const label = document.createElement("span")
        label.textContent = aircraft
            ? "Focused on " + (aircraft.registration || ("#" + aircraft.aircraftId))
            : "Aircraft #" + this._focusedAircraftId + " not in current fleet record"
        const clear = document.createElement("button")
        clear.type = "button"
        clear.textContent = "× clear"
        clear.style.cssText = "background:transparent;color:" + T.color.cobalt
            + ";border:" + T.geom.bw1 + " solid " + T.color.cobalt + ";border-radius:" + T.geom.radius
            + ";padding:" + T.sp[0] + " " + T.sp[2] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        clear.addEventListener("click", () => {
            this._focusedAircraftId = null
            this._renderBodySafe()
        })
        banner.append(label, clear)
        return banner
    }

    _renderFocusedAircraft(aircraft, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:" + T.sp[3] + ";background:" + T.color.bone2
            + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"

        const heading = document.createElement("h4")
        heading.textContent = (aircraft.registration || ("#" + aircraft.aircraftId))
            + " · " + (aircraft.equipment || "(unknown)")
        heading.style.cssText = "margin:0 0 " + T.sp[1] + " 0;font-family:" + T.font.display
            + ";font-size:" + T.fs.lead + ";font-weight:" + T.fw.display
            + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";color:" + T.color.oxide + ";"
        wrap.appendChild(heading)

        const lines = [
            ["aircraftId", aircraft.aircraftId],
            ["sub-fleet", aircraft.fleet || "—"],
            ["age",       aircraft.age != null ? aircraft.age + " mo" : "—"],
            ["maintanance", aircraft.maintanance != null ? aircraft.maintanance : "—"],
            ["typeId",    aircraft.typeId || "—"]
        ]
        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-family:" + T.font.mono
            + ";font-size:" + T.fs.body + ";letter-spacing:" + T.track.mono + ";color:" + T.color.oxide2 + ";"
        for (const [label, value] of lines) {
            const tr = document.createElement("tr")
            tr.innerHTML =
                "<td style='padding:" + T.sp[0] + " " + T.sp[2] + ";color:" + T.color.slate + ";'>"
                    + escapeHtml(label) + "</td>" +
                "<td style='padding:" + T.sp[0] + " " + T.sp[2] + ";'>" + escapeHtml(String(value)) + "</td>"
            table.appendChild(tr)
        }
        wrap.appendChild(table)

        const link = document.createElement("a")
        link.href = "/app/fleets/aircraft/" + encodeURIComponent(aircraft.aircraftId) + "/0"
        link.textContent = "Open in /app/fleets →"
        link.style.cssText = "display:inline-block;margin-top:" + T.sp[2] + ";color:" + T.color.rust
            + ";text-decoration:none;font-family:" + T.font.display + ";font-size:" + T.fs.body + ";"
        wrap.appendChild(link)
        return wrap
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "fleet-hub",
        section: "fleet",
        priority: 10,
        factory: () => new CentralHubFleetHubTile()
    })
}
