"use strict"

/**
 * Fleet Hub host — orchestrates the inline augmentation of the AS fleet
 * management page (`/app/fleets*`). Only mounts on the fleet *list* page
 * (gated on `.as-page-fleet-management`), not on the per-aircraft detail
 * subpages that share the URL prefix.
 *
 * Lifecycle:
 *   1. content_fleetHub.js waits for content_fleetManagement.js to write
 *      its "Currently N aircrafts stored" panel, then calls mount().
 *   2. mount() reads the per-airline aircraftFleet record, asks
 *      AircraftAggregator to enrich it, then paints the table + summary.
 *   3. A storage.onChanged listener re-aggregates + repaints when AFP or
 *      ScheduleStore writes affect this airline's aircraft.
 *   4. A debounced MutationObserver on the table tbody re-paints if Wicket
 *      re-renders the table out from under us.
 *
 * Owns the click-handler wiring for the R/S/P inline action buttons by
 * subscribing to the CustomEvents that FleetHubInlineTable dispatches.
 */
class FleetHubHost {

    static REMOUNT_DEBOUNCE_MS = 200

    constructor() {
        this.server = ""
        this.airlineCode = ""
        this.fleetKey = ""
        this.tableEl = null
        this.anchorEl = null
        this._lastRows = []
        this._observer = null
        this._remountTimer = null
        this._storageListener = null
        this._boundTable = null
        this._dashboardHost = null    // lazy AesAfpDashboardHost
    }

    /** Idempotent. Returns immediately if the page hasn't mounted yet. */
    async mount() {
        if (!document.querySelector(".as-page-fleet-management")) return

        this.server = AES.getServerName()
        // fltmng_getAirlineName lives in content_fleetManagement.js, loaded
        // before us in the same content_scripts block, so it's in scope.
        this.airlineCode = fltmng_getAirlineName()
        this.fleetKey = this.server + this.airlineCode + "aircraftFleet"

        if (!this._resolveTable()) {
            console.warn("[AES Fleet Hub] fleet table not found; bailing")
            return
        }
        this.anchorEl = FleetHubHost._findFltmngPanel()

        await this._renderOnce()
        this._bindTableListeners()
        this._attachStorageListener()
        this._attachObserver()
    }

    /**
     * Re-resolve the AS fleet table — Wicket may swap the whole element
     * out from under us. Returns true when a table exists. When the table
     * has changed, drop the listener-binding flag so listeners re-attach.
     *
     * :eq() is jQuery, not CSS, so the original `:eq(0)` becomes :nth-of-type(1).
     */
    _resolveTable() {
        const next = document.querySelector(".as-page-fleet-management > .row > .col-md-9 > .as-panel:nth-of-type(1) table")
            || document.querySelector(".as-page-fleet-management table")
        if (next !== this.tableEl) {
            this.tableEl = next
            this._boundTable = null
        }
        return !!this.tableEl
    }

    _bindTableListeners() {
        if (!this.tableEl || this._boundTable === this.tableEl) return
        const E = FleetHubInlineTable.EVENT
        this.tableEl.addEventListener(E.R, e => this._onActionR(e.detail))
        this.tableEl.addEventListener(E.S, e => this._onActionS(e.detail))
        this.tableEl.addEventListener(E.P, e => this._onActionP(e.detail))
        if (E.D) this.tableEl.addEventListener(E.D, e => this._onActionD(e.detail))
        this._boundTable = this.tableEl
    }

    /**
     * Locate the AES summary panel that fltmng_display() injects. Match
     * on "Currently N aircrafts stored" body copy so we can't pick up the
     * AS-native fleet table panel by mistake.
     */
    static _findFltmngPanel() {
        const candidates = document.querySelectorAll(".as-page-fleet-management .as-panel")
        for (const el of candidates) {
            if (/aircrafts? stored/i.test(el.textContent || "")) return el
        }
        return null
    }

    async _renderOnce() {
        if (!this._resolveTable()) return

        const blob = await chrome.storage.local.get([this.fleetKey])
        const fleetRec = blob[this.fleetKey]
        const fleet = fleetRec && Array.isArray(fleetRec.fleet) ? fleetRec.fleet : []
        if (!fleet.length) return

        const rows = await FleetHubAircraftAggregator.enrich({
            server:      this.server,
            airlineCode: this.airlineCode,
            fleet
        })
        this._lastRows = rows

        FleetHubInlineTable.augment(this.tableEl, rows)
        this._bindTableListeners()

        FleetHubSummaryStrip.render(this.anchorEl, rows, FleetHubHost._latestScrapeTime(fleet))
    }

    static _latestScrapeTime(fleet) {
        let best = ""
        for (const a of fleet) {
            if (a && a.time && (!best || a.time > best)) best = a.time
        }
        return best || ""
    }

    _attachStorageListener() {
        if (this._storageListener) return
        const fleetKey = this.fleetKey
        const afpPrefix = "aircraftFlightPlan:state:" + this.server + ":"
        // Track 2 — wear-model writes pipe through three keys per aircraft.
        // Listening to all three lets the Fleet Hub repaint when a sister
        // tab updates maintenance/wear data, even though the column itself
        // (Phase 2) hasn't been wired yet — keeps the column adoption a
        // pure inline-table change later.
        const maintPrefix = "aircraftFlightPlan:maintenance:"  + this.server + ":"
        const wearPrefix  = "aircraftFlightPlan:wearObservations:" + this.server + ":"
        const flightLogPrefix = "aircraftFlightPlan:flightLog:" + this.server + ":"
        const sIndex = this.server + this.airlineCode + "scheduleManagement:index"

        this._storageListener = (changes, area) => {
            if (area !== "local") return
            let touched = false
            for (const k in changes) {
                if (k === fleetKey) { touched = true; break }
                if (k === sIndex)  { touched = true; break }
                if (k.indexOf(afpPrefix)       === 0) { touched = true; break }
                if (k.indexOf(maintPrefix)     === 0) { touched = true; break }
                if (k.indexOf(wearPrefix)      === 0) { touched = true; break }
                if (k.indexOf(flightLogPrefix) === 0) { touched = true; break }
            }
            if (!touched) return
            this._scheduleRepaint()
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    _attachObserver() {
        if (this._observer) {
            try { this._observer.disconnect() } catch (_) { /* noop */ }
            this._observer = null
        }
        const tbody = this.tableEl.querySelector("tbody")
        if (!tbody) return
        this._observer = new MutationObserver(() => {
            if (tbody.querySelector("tr td.aes-fleet-hub-cell")) return  // augmentation is intact
            this._scheduleRepaint()
        })
        this._observer.observe(tbody, {childList: true, subtree: false})
    }

    _scheduleRepaint() {
        if (this._remountTimer) clearTimeout(this._remountTimer)
        this._remountTimer = setTimeout(() => {
            this._remountTimer = null
            this._renderOnce().catch(err => {
                console.warn("[AES Fleet Hub] repaint failed", err)
            })
        }, FleetHubHost.REMOUNT_DEBOUNCE_MS)
    }

    _onActionR(detail) {
        const hub = detail.hub || detail.fallbackHub
        if (!hub) {
            console.info("[AES Fleet Hub] R: no hub for aircraft and no fallback; opening generic scheduling page")
            window.open("/app/com/scheduling", "_blank")
            return
        }
        // HUB→HUB so Route Assistant scoring activates from that hub even
        // before the user picks a real destination.
        const url = "/app/com/scheduling/" + hub + hub
        window.open(url, "_blank")
    }

    _onActionS(detail) {
        const aircraftId = detail.aircraftId
        if (!aircraftId) return
        const row = this._lastRows.find(r => String(r.aircraftId) === String(aircraftId))
        if (!row) return
        FleetHubScheduleOverlay.open({
            row,
            ctx: {server: this.server, airlineCode: this.airlineCode}
        }).catch(err => console.warn("[AES Fleet Hub] S action failed", err))
    }

    _onActionP(detail) {
        const aircraftId = detail.aircraftId
        if (!aircraftId) return
        window.open("/app/fleets/aircraft/" + aircraftId + "/0", "_blank")
    }

    /**
     * AFP Schedule Control (Tier 1 dry-run). Lazy-instantiates the
     * dashboard host so its dependency graph (proxy fetcher, applier,
     * candidate pipeline, etc.) only initialises when the user actually
     * clicks D — keeps the cold-load cost off the fleet table mount.
     */
    _onActionD(detail) {
        if (!detail || !detail.aircraftId) return
        if (typeof AesAfpDashboardHost === "undefined") {
            console.warn("[AES Fleet Hub] AesAfpDashboardHost not loaded — check manifest order on /app/fleets*")
            return
        }
        if (!this._dashboardHost) {
            this._dashboardHost = new AesAfpDashboardHost()
            this._dashboardHost.init({server: this.server, airlineCode: this.airlineCode})
        }
        this._dashboardHost.openFor(detail).catch(err =>
            console.warn("[AES Fleet Hub] D action failed", err))
    }
}

if (typeof window !== "undefined") {
    window.FleetHubHost = FleetHubHost
}
