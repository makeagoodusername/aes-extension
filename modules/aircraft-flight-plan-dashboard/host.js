"use strict"

/**
 * AFP Dashboard — host.
 *
 * Singleton on `/app/fleets*`. Listens for the new "D" action chip from
 * `FleetHubInlineTable` (`aes-fleet-hub:action-d`), lazily wires its
 * dependencies (apply log, applier, proxy fetcher, candidate pipeline,
 * fleet roster), and opens the modal panel.
 *
 * Construction is lazy because the dashboard's dependency graph (route-
 * candidates IIFE attaches a 50ms _attach timer to wait for the AFP bus,
 * etc.) is heavy. Until the user clicks D we don't even instantiate the
 * applier / pipeline.
 */
class AesAfpDashboardHost {
    constructor() {
        this._panel        = null
        this._applyLog     = null
        this._applier      = null
        this._proxyFetcher = null
        this._pipeline     = null
        this._roster       = null
        this._server       = ""
        this._airlineCode  = ""
        // Track 7 slice 7f — single global onChanged listener; when the
        // open panel's aircraft schedule key changes (because another tab
        // visited the AFP page and the broadcaster wrote), the panel
        // header repaints with the fresh badge.
        this._scheduleListener = null
    }

    init(opts) {
        const o = opts || {}
        this._server      = o.server      || (typeof AES !== "undefined" ? AES.getServerName() : "")
        this._airlineCode = o.airlineCode || ""
        this._attachScheduleListener()
    }

    _attachScheduleListener() {
        if (this._scheduleListener) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        if (typeof AesAfpScheduleStore === "undefined") return
        this._scheduleListener = (changes, area) => {
            if (area !== "local") return
            if (!this._panel || !this._panel._row) return
            const myKey = AesAfpScheduleStore._key(this._server, this._panel._row.aircraftId)
            if (!Object.prototype.hasOwnProperty.call(changes, myKey)) return
            this._panel.refreshSchedule().catch(err =>
                console.warn("[AES afp-dashboard] schedule refresh failed", err))
        }
        try { chrome.storage.onChanged.addListener(this._scheduleListener) }
        catch (_) { this._scheduleListener = null }
    }

    /** Called by FleetHubHost when the D event fires. detail = {aircraftId, hub, fallbackHub}. */
    async openFor(detail) {
        if (!detail || !detail.aircraftId) return
        await this._lazyWire()
        const row = await this._roster.getById(detail.aircraftId)
        if (!row) {
            console.warn("[AES afp-dashboard] aircraft not in fleet roster:", detail.aircraftId)
            return
        }
        if (!this._panel) {
            this._panel = new AesAfpDashboardPanel({
                server:        this._server,
                airlineCode:   this._airlineCode,
                proxyFetcher:  this._proxyFetcher,
                applier:       this._applier,
                applyLog:      this._applyLog,
                pipeline:      this._pipeline,
                roster:        this._roster
            })
        }
        this._panel.openFor(row).catch(err => console.warn("[AES afp-dashboard] openFor failed", err))
    }

    async _lazyWire() {
        if (this._applyLog) return
        if (typeof AesAfpFnApplyLog        === "undefined"
         || typeof AesAfpFnApplier         === "undefined"
         || typeof AesAfpProxyPageFetcher  === "undefined"
         || typeof AesAfpCandidatePipeline === "undefined"
         || typeof AesAfpDashboardFleetRoster === "undefined") {
            console.warn("[AES afp-dashboard] one or more dashboard modules failed to load — check manifest order on /app/fleets*")
            return
        }
        this._applyLog     = new AesAfpFnApplyLog()
        let applySettings = null
        if (typeof AesAfpDashboardSettings !== "undefined"
                && typeof AesAfpDashboardSettings.load === "function") {
            try { applySettings = await AesAfpDashboardSettings.load() }
            catch (_) { applySettings = null }
        }
        this._applier      = new AesAfpFnApplier(this._server, Object.assign({
            applyLog: this._applyLog
        }, applySettings || {}))
        this._proxyFetcher = new AesAfpProxyPageFetcher(this._server)
        this._pipeline     = new AesAfpCandidatePipeline({
            server:      this._server,
            airlineCode: this._airlineCode
        })
        this._roster       = new AesAfpDashboardFleetRoster({
            server:      this._server,
            airlineCode: this._airlineCode
        })
    }
}

if (typeof window !== "undefined") {
    window.AesAfpDashboardHost = AesAfpDashboardHost
}
