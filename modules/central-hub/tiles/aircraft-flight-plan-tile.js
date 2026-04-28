"use strict"

/**
 * Aircraft Flight Plan tile — counts active per-aircraft draft schedules
 * and surfaces the most recently edited ones with quick links.
 *
 * Reads `aircraftFlightPlan:draft:<server>:<aircraftId>` records (see
 * modules/aircraft-flight-plan/active-draft-store.js). The full draft
 * editor lives at /app/fleets/aircraft/<id>/0; the hub doesn't reproduce
 * it — the Open buttons take the user straight there.
 */
class CentralHubAfpTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "aircraft-flight-plan"
        this.title = "Flight Plan"
        this.section = "fleet"
        this.priority = 20
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        return ["aircraftFlightPlan:draft:" + (ctx && ctx.server || "") + ":"]
    }

    openHref() { return "/app/fleets" }

    async _loadDrafts() {
        const server = (this.ctx && this.ctx.server) || ""
        if (!server) return []
        const entries = await this._loadByPrefix("aircraftFlightPlan:draft:" + server)
        const drafts = entries.map(e => e.value).filter(rec => rec && rec.aircraftId)
        drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        return drafts
    }

    async loadStatus() {
        const drafts = await this._loadDrafts()
        if (!drafts.length) {
            return {
                badge: "0",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No active drafts. Open an aircraft to start one."
            }
        }
        const withFlights = drafts.filter(d => Array.isArray(d.flights) && d.flights.length).length
        const totalFlights = drafts.reduce(
            (acc, d) => acc + (Array.isArray(d.flights) ? d.flights.length : 0), 0)
        return {
            badge: String(drafts.length),
            badgeKind: drafts.length > 0
                ? window.CentralHubStatusBadges.KIND.INFO
                : window.CentralHubStatusBadges.KIND.MUTED,
            summary: drafts.length + " active draft" + (drafts.length === 1 ? "" : "s")
                + " · " + withFlights + " populated · " + totalFlights + " total legs"
        }
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        host.textContent = ""

        // CH-5d-3: pin tail filter on the instance.
        if (focusFilter && focusFilter.type === "tail" && focusFilter.aircraftId) {
            this._tailFilter = String(focusFilter.aircraftId)
        }

        const drafts = await this._loadDrafts()

        if (this._tailFilter) {
            host.appendChild(this._renderTailBanner(T))
            const match = drafts.filter(d => String(d.aircraftId) === this._tailFilter)
            if (!match.length) {
                const empty = this._renderEmptyState(host, "No draft yet for #" + this._tailFilter + ". ", {marginTop: T.sp[2]})
                const link = document.createElement("a")
                link.href = "/app/fleets/aircraft/" + encodeURIComponent(this._tailFilter) + "/0"
                link.textContent = "Open #" + this._tailFilter + " to start a draft →"
                link.style.cssText = "color:" + T.color.rust + ";text-decoration:none;"
                empty.appendChild(link)
                return
            }
            host.appendChild(this._renderDraftList(match, T))
            return
        }

        if (!drafts.length) {
            this._renderEmptyState(host, "No drafts yet. Open an aircraft from /app/fleets and use Generate / Wave on the flight plan editor.")
            return
        }

        host.appendChild(this._renderDraftList(drafts.slice(0, 6), T))
        if (drafts.length > 6) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (drafts.length - 6) + " more drafts — see Fleet Hub on /app/fleets."
            host.appendChild(more)
        }
    }

    _renderTailBanner(T) {
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
        label.textContent = "Focused on aircraft #" + this._tailFilter
        const clear = document.createElement("button")
        clear.type = "button"
        clear.textContent = "× clear"
        clear.style.cssText = "background:transparent;color:" + T.color.cobalt
            + ";border:" + T.geom.bw1 + " solid " + T.color.cobalt + ";border-radius:" + T.geom.radius
            + ";padding:" + T.sp[0] + " " + T.sp[2] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        clear.addEventListener("click", () => {
            this._tailFilter = null
            this._renderBodySafe()
        })
        banner.append(label, clear)
        return banner
    }

    _renderDraftList(drafts, T) {
        const list = document.createElement("ul")
        list.style.cssText = [
            "list-style:none",
            "margin:0",
            "padding:0",
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[1]
        ].join(";")

        for (const d of drafts) {
            const li = document.createElement("li")
            li.style.cssText = [
                "display:flex",
                "align-items:center",
                "gap:" + T.sp[3],
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:" + T.color.bone2,
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            ].join(";")

            const id = document.createElement("span")
            id.style.cssText = [
                "font-family:" + T.font.mono,
                "letter-spacing:" + T.track.mono,
                "color:" + T.color.oxide,
                "flex:0 0 auto"
            ].join(";")
            id.textContent = "#" + d.aircraftId

            const meta = document.createElement("span")
            meta.style.cssText = "flex:1 1 auto;color:" + T.color.oxide2 + ";min-width:0;"
            const hub = d.hub || "—"
            const flights = Array.isArray(d.flights) ? d.flights.length : 0
            const ts = d.updatedAt ? new Date(d.updatedAt).toISOString().replace("T", " ").substring(0, 16) : "—"
            meta.textContent = hub + " · " + flights + " legs · " + ts

            const link = document.createElement("a")
            link.href = "/app/fleets/aircraft/" + encodeURIComponent(d.aircraftId) + "/0"
            link.textContent = "Open →"
            link.style.cssText = [
                "color:" + T.color.rust,
                "text-decoration:none",
                "font-weight:" + T.fw.bold,
                "flex:0 0 auto"
            ].join(";")

            li.append(id, meta, link)
            list.appendChild(li)
        }
        return list
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "aircraft-flight-plan",
        section: "fleet",
        priority: 20,
        factory: () => new CentralHubAfpTile()
    })
}
