"use strict"

/**
 * Aircraft Profitability tile — surfaces lifetime profit per aircraft and
 * highlights the best/worst performers.
 *
 * Reads:
 *   <server><sanitizedAirlineName>aircraftFleet  — fleet roster (legacy key)
 *   <server>aircraftFlights<aircraftId>          — per-aircraft profit blob
 *
 * The legacy `displayAircraftProfitability()` (content_dashboard.js:2000)
 * provides the full sortable / filterable / hideable column table; this
 * tile mirrors only the highlights so the user can spot outliers at a
 * glance and jump to the legacy table or aircraft detail page.
 */
class CentralHubAircraftProfitabilityTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "aircraft-profitability"
        this.title = "Profitability"
        this.section = "fleet"
        this.priority = 40
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        return [String(ctx && ctx.server || "") + ""]
    }

    openHref() { return "/app/fleets" }

    async _loadFleetWithProfit() {
        const server = (this.ctx && this.ctx.server) || ""
        if (!server) return []
        const all = await chrome.storage.local.get(null)
        let fleetRec = null
        let bestTime = ""
        for (const k in all) {
            if (k.indexOf(server) !== 0) continue
            if (k.lastIndexOf("aircraftFleet") !== k.length - "aircraftFleet".length) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.fleet) || !rec.fleet.length) continue
            const latest = rec.fleet.reduce((acc, a) => (a && a.time && a.time > acc) ? a.time : acc, "")
            if (!fleetRec || latest > bestTime) { fleetRec = rec; bestTime = latest }
        }
        if (!fleetRec) return []

        const profitPrefix = server + "aircraftFlights"
        const merged = []
        for (const a of fleetRec.fleet) {
            if (!a || !a.aircraftId) continue
            const profitKey = profitPrefix + a.aircraftId
            const blob = all[profitKey]
            const profit = blob ? Number(blob.profit) : NaN
            merged.push({
                aircraftId: a.aircraftId,
                registration: a.registration || "",
                equipment: a.equipment || "",
                fleet: a.fleet || "",
                profit: Number.isFinite(profit) ? profit : null,
                totalFlights: blob ? blob.totalFlights : null,
                finishedFlights: blob ? blob.finishedFlights : null,
                profitDate: blob ? blob.date : null
            })
        }
        return merged
    }

    async loadStatus() {
        const merged = await this._loadFleetWithProfit()
        if (!merged.length) {
            return {
                badge: "NO DATA",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "Open /app/fleets to extract aircraft profit data."
            }
        }
        const withProfit = merged.filter(m => m.profit !== null)
        if (!withProfit.length) {
            return {
                badge: String(merged.length) + " AC",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: merged.length + " aircraft, no profit history scraped yet."
            }
        }
        const total = withProfit.reduce((acc, m) => acc + m.profit, 0)
        const positive = withProfit.filter(m => m.profit > 0).length
        const formatted = Intl.NumberFormat().format(Math.round(total))
        const sign = total >= 0 ? "+" : "−"
        return {
            badge: sign + formatted + " AS$",
            badgeKind: total >= 0
                ? window.CentralHubStatusBadges.KIND.OK
                : window.CentralHubStatusBadges.KIND.ALERT,
            summary: withProfit.length + " / " + merged.length + " tracked · "
                + positive + " profitable · " + (withProfit.length - positive) + " loss-making"
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const merged = await this._loadFleetWithProfit()
        const withProfit = merged.filter(m => m.profit !== null)
        if (!withProfit.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "No profit data yet. Visit each aircraft's Flights tab "
                + "(/app/fleets/aircraft/<id>/1) to extract per-aircraft profit."
            host.appendChild(empty)
            return
        }
        const sorted = withProfit.slice().sort((a, b) => b.profit - a.profit)
        const top = sorted.slice(0, 5)
        const bottom = sorted.slice(-3).reverse()

        host.appendChild(this._buildSection("Top 5", top, T))
        host.appendChild(this._buildSection("Bottom 3", bottom, T))
    }

    _buildSection(label, rows, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-bottom:" + T.sp[3] + ";"

        const heading = document.createElement("h4")
        heading.textContent = label
        heading.style.cssText = [
            "margin:0 0 " + T.sp[1] + " 0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate
        ].join(";")
        wrap.appendChild(heading)

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-family:"
            + T.font.mono + ";font-size:" + T.fs.body + ";"

        for (const r of rows) {
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
                + ";cursor:pointer;"
            tr.addEventListener("mouseenter", () => { tr.style.background = T.color.bone2 })
            tr.addEventListener("mouseleave", () => { tr.style.background = "" })
            tr.addEventListener("click", (e) => {
                if (e.target && e.target.closest("a")) return  // let link clicks navigate
                if (!window.CentralHubBus) return
                const payload = {aircraftId: String(r.aircraftId), source: "aircraft-profitability"}
                window.CentralHubBus.emit("focus-aircraft", payload)
                window.CentralHubBus.emit("open-tile", {
                    tileId: "aircraft-flight-plan",
                    expand: true, scrollIntoView: true,
                    filter: {type: "tail", aircraftId: String(r.aircraftId)},
                    source: "aircraft-profitability"
                })
            })
            const profitFmt = (r.profit >= 0 ? "+" : "−") + Intl.NumberFormat().format(Math.abs(Math.round(r.profit)))
            tr.innerHTML =
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";'>"
                    + "<a href='/app/fleets/aircraft/" + encodeURIComponent(r.aircraftId) + "/0'"
                    + " style='color:" + T.color.rust + ";text-decoration:none;'>"
                    + escapeHtml(r.registration || ("#" + r.aircraftId))
                    + "</a>"
                    + " <span style='color:" + T.color.slate + ";'>"
                    + escapeHtml(r.equipment) + "</span></td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;color:"
                    + (r.profit >= 0 ? T.color.moss : T.color.crimson) + ";'>"
                    + profitFmt + " AS$</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;color:"
                    + T.color.oxide2 + ";'>" + (r.finishedFlights || 0) + " flights</td>"
            table.appendChild(tr)
        }
        wrap.appendChild(table)
        return wrap
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "aircraft-profitability",
        section: "fleet",
        priority: 40,
        factory: () => new CentralHubAircraftProfitabilityTile()
    })
}
