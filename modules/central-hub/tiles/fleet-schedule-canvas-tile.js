"use strict"

/**
 * Fleet Schedule Canvas tile — dashboard surface for the wave canvas
 * that lives on `/app/fleets*`. The full canvas (CanvasModal + 18
 * supporting modules) only loads on the fleets page; this tile is
 * the dashboard-side discoverability + jump-off.
 *
 * Body: count of hubs with under-drafted aircraft (read from
 * AesFleetRoster), the top hub by spare-aircraft count, and a "build
 * wave schedule" CTA. Title-bar `Open →` navigates the user to
 * `/app/fleets` where the canvas can be opened from the Fleet Hub
 * Command Center.
 *
 * Section "routes" priority 30 — sits next to Route Mgmt + Schedule
 * Mgmt in the same band.
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof window.CentralHubTile !== "function") return

    class CentralHubFleetScheduleCanvasTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "fleet-schedule-canvas"
            this.title = "Schedule Canvas"
            this.section = "routes"
            this.priority = 30
            this.requiresAirline = true
        }

        watchedStorageKeys(ctx) {
            const server = (ctx && ctx.server) || ""
            if (!server) return []
            const keys = []
            for (const airline of this._fleetKeyCandidates(ctx)) {
                keys.push(server + airline + "aircraftFleet")
                keys.push(server + airline + "scheduleManagement:index")
            }
            keys.push("aircraftFlightPlan:state:" + server + ":")
            keys.push("aircraftFlightPlan:draft:" + server + ":")
            keys.push("aircraftFlightPlan:schedule:" + server + ":")
            return keys
        }

        openHandler() {
            return () => {
                // The canvas mounts on /app/fleets where its 18 modules
                // are content-script registered. Dashboard-side click
                // navigates the user there; the Fleet Hub Command Center
                // exposes the actual "Open Schedule Canvas" CTA.
                try { window.location.href = "/app/fleets" }
                catch (_) { /* noop */ }
            }
        }

        async _loadSummary() {
            const ctx = this.ctx || {}
            const fleet = await this._loadFleet(ctx)
            const aircraft = fleet && Array.isArray(fleet.aircraft) ? fleet.aircraft : []
            if (!aircraft.length) {
                return {totalHubs: 0, underDraftedCount: 0, topHub: null, rosterPresent: false}
            }

            const rows = await this._loadRows(ctx, aircraft)
            const server = (ctx && ctx.server) || ""
            const draftKeys = rows.map(r => "aircraftFlightPlan:draft:" + server + ":" + r.aircraftId)
            const scheduleKeys = rows.map(r => "aircraftFlightPlan:schedule:" + server + ":" + r.aircraftId)
            const blob = await chrome.storage.local.get(draftKeys.concat(scheduleKeys))

            const hubMap = new Map()
            for (const r of rows) {
                const schedule = blob["aircraftFlightPlan:schedule:" + server + ":" + r.aircraftId]
                const hub = this._asIata(r.hub)
                    || this._asIata(r.locIata)
                    || this._asIata(schedule && schedule.hubIata)
                    || this._hubFromSchedule(schedule)
                if (!hub) continue
                const entry = hubMap.get(hub) || {hub, total: 0, spare: 0}
                entry.total += 1
                const draft = blob["aircraftFlightPlan:draft:" + server + ":" + r.aircraftId]
                const hasDraft = !!(draft && Array.isArray(draft.flights) && draft.flights.length)
                if (!hasDraft) entry.spare += 1
                hubMap.set(hub, entry)
            }

            const hubs = Array.from(hubMap.values())
            const underDrafted = hubs.filter(h => h.spare > 0)
            underDrafted.sort((a, b) => b.spare - a.spare || a.hub.localeCompare(b.hub))
            return {
                totalHubs: hubs.length,
                underDraftedCount: underDrafted.length,
                topHub: underDrafted[0] || null,
                rosterPresent: aircraft.length > 0
            }
        }

        async _loadFleet(ctx) {
            const server = (ctx && ctx.server) || ""
            if (!server || !window.AesFleetRoster || typeof window.AesFleetRoster.load !== "function") {
                return {aircraft: []}
            }
            const candidates = this._airlineCandidates(ctx)
            for (const airline of candidates) {
                try {
                    const roster = await window.AesFleetRoster.load(server, airline)
                    if (roster && Array.isArray(roster.aircraft) && roster.aircraft.length) return roster
                } catch (_) { /* try next */ }
            }
            try {
                return await window.AesFleetRoster.load(server, null)
            } catch (_) {
                return {aircraft: []}
            }
        }

        async _loadRows(ctx, aircraft) {
            const server = (ctx && ctx.server) || ""
            const airline = this._airlineCandidates(ctx)[0] || (ctx && ctx.airline) || ""
            if (window.FleetHubAircraftAggregator && typeof window.FleetHubAircraftAggregator.enrich === "function") {
                try {
                    const rows = await window.FleetHubAircraftAggregator.enrich({
                        server,
                        airlineCode: airline,
                        fleet: aircraft
                    })
                    if (Array.isArray(rows) && rows.length) return rows
                } catch (_) { /* fall through */ }
            }
            return aircraft.map(a => ({
                aircraftId:   a.aircraftId,
                registration: a.registration || "",
                equipment:    a.equipment || "",
                hub:          this._asIata(a.hub) || this._asIata(a.homebase) || this._asIata(a.location),
                locIata:      this._asIata(a.location)
            }))
        }

        _airlineCandidates(ctx) {
            const out = []
            const push = value => {
                const text = String(value || "").trim()
                if (text && out.indexOf(text) === -1) out.push(text)
            }
            try {
                if (typeof AES !== "undefined" && typeof AES.getAirlineIdentity === "function") {
                    push(AES.getAirlineIdentity())
                }
            } catch (_) { /* fall through */ }
            try {
                if (typeof AES !== "undefined" && typeof AES.getAirlineCode === "function") {
                    const a = AES.getAirlineCode()
                    push(a && a.name)
                    push(a && a.code)
                }
            } catch (_) { /* fall through */ }
            push(ctx && ctx.airlineIdentity)
            push(ctx && ctx.airline)
            push(ctx && ctx.airlineCode)
            return out
        }

        _fleetKeyCandidates(ctx) {
            const out = []
            for (const value of this._airlineCandidates(ctx)) {
                const clean = String(value || "").replace(/[^A-Za-z0-9]/g, "")
                if (clean && out.indexOf(clean) === -1) out.push(clean)
            }
            return out
        }

        _asIata(value) {
            const text = String(value || "").toUpperCase()
            const m = text.match(/\b[A-Z]{3}\b/)
            return m ? m[0] : null
        }

        _hubFromSchedule(schedule) {
            if (!schedule || !Array.isArray(schedule.legs)) return null
            const counts = new Map()
            for (const leg of schedule.legs) {
                const orig = this._asIata(leg && leg.origin)
                if (!orig) continue
                counts.set(orig, (counts.get(orig) || 0) + 1)
            }
            let best = null
            let bestCount = 0
            for (const [hub, n] of counts) {
                if (n > bestCount) { best = hub; bestCount = n }
            }
            return best
        }

        async loadStatus() {
            const summary = await this._loadSummary()
            if (!summary || !summary.rosterPresent) {
                return {
                    badge: "—",
                    badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                    summary: "Wave-aligned schedule canvas. Visit /app/fleets to mount."
                }
            }
            const n = summary.underDraftedCount
            return {
                badge: n > 0 ? (n + " HUB" + (n === 1 ? "" : "S")) : "DRAFTED",
                badgeKind: n > 0
                    ? window.CentralHubStatusBadges.KIND.WARN
                    : window.CentralHubStatusBadges.KIND.OK,
                summary: n > 0
                    ? "Hubs with spare aircraft to draft into the schedule."
                    : "All known hubs are fully scheduled."
            }
        }

        async renderBody(ctx, host) {
            const T = window.AESTokens
            host.textContent = ""

            const summary = await this._loadSummary()

            const wrap = document.createElement("div")
            wrap.style.cssText = [
                "display:flex",
                "flex-direction:column",
                "gap:" + T.sp[2],
                "font-family:" + T.font.body,
                "font-size:" + T.fs.body,
                "color:" + T.color.oxide
            ].join(";")

            if (!summary || !summary.rosterPresent) {
                const empty = document.createElement("div")
                empty.style.cssText = "color:" + T.color.slate + ";font-style:italic;"
                empty.textContent = "No fleet roster cached yet — visit a fleets page to seed."
                wrap.appendChild(empty)
            } else if (summary.underDraftedCount === 0) {
                const ok = document.createElement("div")
                ok.style.cssText = "color:" + T.color.slate + ";"
                ok.textContent = summary.totalHubs + " hub" + (summary.totalHubs === 1 ? "" : "s")
                    + " — every aircraft is scheduled."
                wrap.appendChild(ok)
            } else {
                const head = document.createElement("div")
                head.style.cssText = "display:flex;justify-content:space-between;gap:" + T.sp[2] + ";"
                const left = document.createElement("span")
                left.textContent = summary.underDraftedCount + " of "
                    + summary.totalHubs + " hub" + (summary.totalHubs === 1 ? "" : "s")
                    + " under-drafted"
                const right = document.createElement("span")
                right.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";"
                if (summary.topHub) right.textContent = summary.topHub.hub
                    + " — " + summary.topHub.spare + " spare"
                head.append(left, right)
                wrap.appendChild(head)
            }

            const ctaRow = document.createElement("div")
            ctaRow.style.cssText = "display:flex;gap:" + T.sp[2] + ";margin-top:" + T.sp[2] + ";"
            const buildBtn = document.createElement("button")
            buildBtn.type = "button"
            buildBtn.textContent = "Open canvas on /app/fleets →"
            buildBtn.style.cssText = [
                "background:" + T.color.cobalt,
                "color:" + T.color.bone,
                "border:" + T.geom.bw1 + " solid " + T.color.cobalt,
                "border-radius:" + T.geom.radius,
                "padding:" + T.sp[1] + " " + T.sp[3],
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "cursor:pointer"
            ].join(";")
            buildBtn.addEventListener("click", () => {
                try { window.location.href = "/app/fleets" } catch (_) { /* noop */ }
            })
            ctaRow.appendChild(buildBtn)
            wrap.appendChild(ctaRow)

            host.appendChild(wrap)
        }
    }

    window.CentralHubFleetScheduleCanvasTile = CentralHubFleetScheduleCanvasTile

    if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register({
            id:       "fleet-schedule-canvas",
            section:  "routes",
            priority: 30,
            factory:  () => new CentralHubFleetScheduleCanvasTile()
        })
    }
})()
