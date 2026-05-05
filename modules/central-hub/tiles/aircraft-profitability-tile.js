"use strict"

/**
 * Aircraft Profitability tile — surfaces lifetime profit per aircraft and
 * highlights the best/worst performers.
 *
 * Reads via `AesAircraftInfoHub`, the central per-aircraft facade that joins
 * fleet roster (`<server><airline>aircraftFleet`), per-aircraft flight blobs
 * (`<server>[<airline>]aircraftFlights<id>`), and per-flight money
 * (`<server>[<airline>]flightInfo<flightId>`). The hub re-derives the
 * effective profit from per-flight CM5.Total when the cached value is zero
 * or missing, and on mount we kick off a backfill loop that fetches the
 * `/action/info/flight?id=<id>` endpoint for finished flights whose money
 * blobs were never extracted — so the tile populates with real numbers
 * without forcing the user to visit each aircraft's Flights tab manually.
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
        this._backfillInFlight = false
        this._backfillUnsubscribe = null
    }

    watchedStorageKeys(ctx) {
        const server = String(ctx && ctx.server || "")
        if (!server) return []
        // F-9228-703: only watch the per-aircraft profit records here.
        // Fleet records are `<server><airline>aircraftFleet`, which have no
        // shared prefix that does not also catch unrelated server-scoped
        // writes; those are handled by the hub subscription in mount().
        return [server + "aircraftFlights", server + "flightInfo"]
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        const server = String(ctx && ctx.server || "")
        if (server && window.AesAircraftInfoHub) {
            this._backfillUnsubscribe = window.AesAircraftInfoHub.subscribe(server, () => this.refresh())
        }
        // Kick off a backfill pass once the tile mounts. The hub does the
        // throttling; this is fire-and-forget so the tile renders the
        // existing snapshot first and updates as backfilled blobs land via
        // the storage subscription above.
        this._maybeRunBackfill()
    }

    dispose() {
        if (this._backfillUnsubscribe) {
            try { this._backfillUnsubscribe() } catch (_) { /* noop */ }
            this._backfillUnsubscribe = null
        }
        super.dispose()
    }

    openHref() { return "/app/fleets" }

    async _loadFleetWithProfit() {
        const server = (this.ctx && this.ctx.server) || ""
        if (!server || !window.AesAircraftInfoHub) return []
        const airline = (this.ctx && this.ctx.airline) || null
        // Fall back to roster across the largest fleet on the server when
        // airline isn't supplied — matches AesFleetRoster's default.
        const snapshots = await window.AesAircraftInfoHub.getRoster(server, airline)
        if (!snapshots.length) return []
        return snapshots.map(s => ({
            aircraftId:      s.aircraftId,
            registration:    s.registration || "",
            equipment:       s.equipment || "",
            fleet:           s.fleet || "",
            profit:          s.effectiveProfit,
            profitSource:    s.profitSource,
            totalFlights:    s.totalFlights,
            finishedFlights: s.finishedFlights,
            coveredFlights:  s.coveredFlights,
            missingFlightInfo: s.missingFlightInfo,
            profitDate:      s.scrapedDate
        }))
    }

    /**
     * Single-flight backfill driver. Walks the roster, finds aircraft with
     * finished flights but missing per-flight money, and asks the hub to
     * fetch the missing blobs (rate-limited inside the hub). Runs at most
     * one pass per mount so we don't hammer AS — re-runs are gated on the
     * `_backfillInFlight` flag and the hub's negative cache for purged ids.
     */
    async _maybeRunBackfill() {
        const server = (this.ctx && this.ctx.server) || ""
        if (!server || !window.AesAircraftInfoHub) return
        if (this._backfillInFlight) return
        this._backfillInFlight = true
        try {
            const airline = (this.ctx && this.ctx.airline) || null
            const roster = await window.AesAircraftInfoHub.getRoster(server, airline)
            const targets = roster.filter(s => s.missingFlightInfo > 0)
            // Prioritise aircraft with the largest gap — they're the ones
            // showing AS$0 on the tile and should populate first.
            targets.sort((a, b) => (b.missingFlightInfo || 0) - (a.missingFlightInfo || 0))
            for (const t of targets) {
                if (!this.root) return  // disposed mid-loop
                await window.AesAircraftInfoHub.backfillProfit(server, t.aircraftId, {
                    airline: t.airline || airline || ""
                })
            }
        } catch (e) {
            console.warn("[AES profitability-tile] backfill failed", e)
        } finally {
            this._backfillInFlight = false
        }
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
        // Re-entrancy guard — overlapping renders from the shell's
        // open-tile flow (toggle()'s render + an explicit render with
        // filter) would otherwise both clear, both await, both append,
        // doubling the Top-5 / Bottom-3 sections in the body.
        const gen = (this._renderGen = (this._renderGen || 0) + 1)
        host.textContent = ""
        const merged = await this._loadFleetWithProfit()
        if (gen !== this._renderGen) return
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
