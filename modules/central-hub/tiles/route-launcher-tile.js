"use strict"

/**
 * Route Launcher tile — one-click flight creation from the dashboard.
 *
 * Body layout:
 *   ┌─ Aircraft (left, ~40%) ─┬─ Destinations (right, ~60%) ─┐
 *   │ list grouped by hub     │ ranked, click to create       │
 *   ├─────────────────────────┴───────────────────────────────┤
 *   │ Status feed (bottom, full width)                        │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Wires the picker → controller.setActive → ranker.render → click →
 * controller.launchTo → status feed. The actual submit goes through
 * AesAfpSubmitBridge → background.js → hidden tab on the AFP page.
 *
 * No "are you sure" prompt: one click = one POST. Failures land in the
 * status feed with a Retry button.
 */
class CentralHubRouteLauncherTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id              = "route-launcher"
        this.title           = "Route Launcher"
        this.section         = "fleet"
        this.priority        = 15
        this.requiresAirline = true
        this._picker = null
        this._feed   = null
        this._destHost = null
        this._unsubStatus = null
        this._unsubActive = null
    }

    watchedStorageKeys(ctx) {
        const s = (ctx && ctx.server) || ""
        return [
            "routeLauncher:log:" + s + ":",
            "routeLauncher:activeAircraft:" + s,
            "aircraftFlightPlan:draft:" + s + ":"
        ]
    }

    async loadStatus(ctx) {
        const K = window.CentralHubStatusBadges.KIND
        if (!window.RouteLauncher) {
            return {badge: "—", badgeKind: K.MUTED, summary: "Loading…"}
        }
        if (!window.RouteLauncher.server) {
            await window.RouteLauncher.init({server: ctx.server, airline: ctx.airline})
        }
        const a = window.RouteLauncher.getActive()
        const records = window.AesRouteLauncherLog
            ? await window.AesRouteLauncherLog.list(ctx.server, 1)
            : []
        const last = records[0]
        const summaryBits = []
        if (a && a.aircraftId) {
            summaryBits.push((a.registration || "#" + a.aircraftId) + (a.hub ? " @ " + a.hub : ""))
        } else {
            summaryBits.push("No aircraft selected")
        }
        if (last) {
            summaryBits.push("last: " + last.status + (last.dest ? " " + last.dest : ""))
        }
        const badgeText = a && a.aircraftId ? (a.registration || a.aircraftId) : "IDLE"
        // F-9228-702: K.GOOD doesn't exist on CentralHubStatusBadges.KIND —
        // the OK colour is K.OK. Without this fix every successful launch
        // fell through to K.INFO/cobalt instead of K.OK/moss.
        const badgeKind = !a ? K.MUTED
                       : last && last.status === "failed" ? K.WARN
                       : last && last.status === "created" ? (K.OK || K.INFO)
                       : K.INFO
        return {badge: String(badgeText), badgeKind, summary: summaryBits.join(" · ")}
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this.subscribeBus("focus-aircraft", ({aircraftId}) => {
            if (!aircraftId) return

            // F-DASH-505: Explicitly call setActive to fix cold-start race
            if (window.RouteLauncher && typeof window.RouteLauncher.setActive === "function") {
                window.RouteLauncher.setActive({aircraftId})
            }

            if (!this.expanded) this.toggle()
            if (this.root) this.root.scrollIntoView({behavior: "smooth", block: "start"})
        })
        // per-leg-autopricer emits this on AesDataBus when a /app/com/numbers/*
        // page produces fresh per-class price suggestions. The launcher
        // surfaces last-applied pricing and so should refresh when fresh
        // suggestions land in the cache the launcher reads from.
        if (window.AesDataBus && typeof window.AesDataBus.on === "function") {
            const off = window.AesDataBus.on("data:route-assistant:flight-number-pricing:updated", () => {
                this.refresh().catch(() => {})
            })
            if (typeof off === "function") this._busDisposers.push(off)
        }
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        host.textContent = ""

        if (!window.RouteLauncher) {
            host.appendChild(this._muted(T, "Route Launcher controller not loaded — check manifest order."))
            return
        }
        if (!window.RouteLauncher.server) {
            await window.RouteLauncher.init({server: ctx.server, airline: ctx.airline})
        }

        if (focusFilter && focusFilter.type === "tail" && focusFilter.aircraftId) {
            await window.RouteLauncher.setActive({aircraftId: String(focusFilter.aircraftId)})
        }

        this._buildLayout(host, T)

        await this._renderPicker()
        await this._renderRanker()
        await this._renderFeed()

        this._attachListeners()
    }

    _buildLayout(host, T) {
        const row = document.createElement("div")
        row.style.cssText = [
            "display:grid",
            "grid-template-columns:minmax(220px, 38%) 1fr",
            "gap:" + T.sp[3]
        ].join(";")

        const left = document.createElement("div")
        const leftHdr = document.createElement("h4")
        leftHdr.textContent = "Aircraft"
        leftHdr.style.cssText = this._sectionTitleCss(T)
        left.appendChild(leftHdr)
        const pickerHost = document.createElement("div")
        left.appendChild(pickerHost)

        const right = document.createElement("div")
        const rightHdr = document.createElement("h4")
        rightHdr.textContent = "Destinations"
        rightHdr.style.cssText = this._sectionTitleCss(T)
        right.appendChild(rightHdr)
        const destHost = document.createElement("div")
        right.appendChild(destHost)

        row.append(left, right)

        const feedHdr = document.createElement("h4")
        feedHdr.textContent = "Status feed"
        feedHdr.style.cssText = this._sectionTitleCss(T) + ";margin-top:" + T.sp[3] + ";"
        const feedHost = document.createElement("div")

        host.append(row, feedHdr, feedHost)

        this._pickerHost = pickerHost
        this._destHost   = destHost
        this._feedHost   = feedHost
    }

    async _renderPicker() {
        const c = window.RouteLauncher
        const a = c.getActive()
        this._picker = new window.AesRouteLauncherAircraftPicker({
            server:      c.server,
            airlineCode: c.airlineCode,
            activeId:    a && a.aircraftId,
            // F-9229-001: don't re-render here. setActive synchronously fires
            // onActiveChange, whose listener (attached in _attachListeners)
            // already runs `await _renderRanker()` + `await refresh()`. The
            // previous double call raced the listener: both started clearing
            // _destHost then both appended their own copy of the top-25
            // destination rows, briefly showing 50 rows until the next
            // refresh tick caught up.
            onPick:      async (sel) => {
                await c.setActive(sel)
            }
        })
        await this._picker.render(this._pickerHost)
    }

    async _renderRanker() {
        const T = window.AESTokens
        const c = window.RouteLauncher
        const a = c.getActive()
        this._destHost.textContent = ""
        this._destHost.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[1],
            "max-height:300px",
            "overflow-y:auto",
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2]
        ].join(";")

        if (!a || !a.aircraftId) {
            this._destHost.appendChild(this._muted(T, "Pick an aircraft on the left."))
            return
        }
        if (!a.hub) {
            this._destHost.appendChild(this._muted(T, "Active aircraft has no known hub. Open it once on /app/fleets/aircraft/" + a.aircraftId + "/0 to seed the hub data."))
            return
        }

        const result = await window.AesRouteLauncherRanker.rank(c.server, a.hub)
        if (!result.entries.length) {
            const msg = result.source === "no-flightsfrom"
                ? "No flightsfrom.com data for " + a.hub + ". Run a scan from the Flightsfrom tile (or the AFP page for any aircraft based at " + a.hub + ") to populate destinations."
                : "No destinations to show."
            this._destHost.appendChild(this._muted(T, msg))
            return
        }

        const draft = window.AesAfpActiveDraftStore
            ? await window.AesAfpActiveDraftStore.load(c.server, a.aircraftId).catch(() => null)
            : null
        const scheduledSet = new Set()
        if (draft && Array.isArray(draft.flights)) {
            for (const f of draft.flights) {
                if (f && f.destination) scheduledSet.add(String(f.destination).toUpperCase())
            }
        }

        const top = result.entries.slice(0, 25)
        for (const e of top) {
            e.alreadyScheduled = scheduledSet.has(e.destIata)
            this._destHost.appendChild(this._renderDestRow(T, e))
        }
    }

    _renderDestRow(T, e) {
        const row = document.createElement("button")
        row.type = "button"
        row.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "background:transparent",
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono,
            "cursor:pointer",
            "text-align:left",
            "opacity:" + (e.alreadyScheduled ? "0.5" : "1")
        ].join(";")

        const dest = document.createElement("span")
        dest.textContent = e.destIata
        dest.style.cssText = "flex:0 0 50px;font-weight:" + T.fw.bold + ";"

        const dist = document.createElement("span")
        dist.textContent = e.distanceKm ? Math.round(e.distanceKm) + " km" : "—"
        dist.style.cssText = "flex:0 0 80px;color:" + T.color.oxide2 + ";font-size:" + T.fs.micro + ";"

        const demand = document.createElement("span")
        if (e.hasDemandData) {
            demand.textContent = "pax " + (e.paxScore != null ? e.paxScore.toFixed(1) : "—")
                               + " · cargo " + (e.cargoScore != null ? e.cargoScore.toFixed(1) : "—")
        } else {
            demand.textContent = "(no demand data)"
        }
        demand.style.cssText = "flex:1 1 auto;color:" + T.color.oxide2 + ";font-size:" + T.fs.micro + ";"

        const score = document.createElement("span")
        score.textContent = e.score != null ? e.score.toFixed(0) : "—"
        score.style.cssText = "flex:0 0 40px;color:" + T.color.cobalt + ";font-weight:" + T.fw.bold + ";text-align:right;"

        row.append(dest, dist, demand, score)
        if (e.alreadyScheduled) {
            const tag = document.createElement("span")
            tag.textContent = "scheduled"
            tag.style.cssText = "flex:0 0 auto;color:" + T.color.slate + ";font-size:" + T.fs.micro + ";"
            row.appendChild(tag)
        }

        row.addEventListener("click", async () => {
            row.disabled = true
            row.style.opacity = "0.5"
            const flightMin = (e.distanceKm && isFinite(e.distanceKm))
                ? Math.round((e.distanceKm / 750) * 60 + 30) : 60
            const r = await window.RouteLauncher.launchTo({destIata: e.destIata, flightMin})
            row.disabled = false
            row.style.opacity = e.alreadyScheduled ? "0.5" : "1"
            if (!r.ok) {
                console.warn("[RouteLauncher] launchTo failed:", r.error)
            }
            await this._renderFeed()
        })
        return row
    }

    async _renderFeed() {
        const c = window.RouteLauncher
        this._feed = new window.AesRouteLauncherStatusFeed({
            server:  c.server,
            onRetry: async (rec) => {
                await c.retry(rec)
                await this._renderFeed()
            }
        })
        await this._feed.render(this._feedHost)
    }

    // F-9230-002: setActive's _persistActive write echoes back through the
    // bridgeStorage subscription on `routeLauncher:activeAircraft:<server>`.
    // The active-change listener already re-renders, so swallow the next
    // storage refresh to avoid a duplicate full renderBody. One-shot.
    async refresh() {
        if (this._suppressNextStorageRefresh) {
            this._suppressNextStorageRefresh = false
            return
        }
        return super.refresh()
    }

    _attachListeners() {
        if (this._unsubStatus) { this._unsubStatus(); this._unsubStatus = null }
        if (this._unsubActive) { this._unsubActive(); this._unsubActive = null }
        this._unsubStatus = window.RouteLauncher.onStatus(async () => {
            await this._renderFeed()
            await this._refreshHeaderOnly()
        })
        this._unsubActive = window.RouteLauncher.onActiveChange(async () => {
            if (this._picker) this._picker.setActive(window.RouteLauncher.getActive() && window.RouteLauncher.getActive().aircraftId)
            // The pending storage echo from _persistActive will trigger an
            // extra refresh through the bridgeStorage path; mark it before we
            // run our own refresh so the override above bails the echo.
            // Use super.refresh so our own call isn't suppressed.
            this._suppressNextStorageRefresh = true
            await super.refresh()
        })
    }

    async _refreshHeaderOnly() {
        try {
            const status = await this.loadStatus(this.ctx)
            this._renderHeader(status)
            this._lastStatus = status
        } catch (e) {
            console.warn("[RouteLauncher] header refresh failed", e)
        }
    }

    dispose() {
        if (this._unsubStatus) { this._unsubStatus(); this._unsubStatus = null }
        if (this._unsubActive) { this._unsubActive(); this._unsubActive = null }
        super.dispose()
    }

    _sectionTitleCss(T) {
        return [
            "margin:0 0 " + T.sp[1] + " 0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.slate
        ].join(";")
    }

    _muted(T, text) {
        const p = document.createElement("p")
        p.style.cssText = "color:" + T.color.slate + ";margin:" + T.sp[2] + " 0;font-style:italic;"
        p.textContent = text
        return p
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "route-launcher",
        section:  "fleet",
        priority: 15,
        factory:  () => new CentralHubRouteLauncherTile()
    })
}
