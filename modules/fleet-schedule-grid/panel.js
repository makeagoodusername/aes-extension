"use strict"

/**
 * Fleet Schedule Grid — modal panel.
 *
 * Full-screen overlay (z-index: tokens.z.modal) that owns the scrape
 * lifecycle and renders the grid + legend. Single-instance: opening
 * twice closes the previous panel first.
 *
 * UX flow:
 *   1. open() — mounts the modal, kicks off bulk scrape (uses persisted
 *               schedules where fresh, fetches the rest).
 *   2. progress strip ticks completed/total, lists current aircraft.
 *   3. on each completed aircraft, the grid is incrementally re-rendered
 *      so users see schedules appearing as they land (no all-at-once
 *      blank-then-pop). Re-render is debounced to ~200 ms during scrape.
 *   4. coloring is recomputed after every batch so new routes get colors.
 *   5. user can refresh (force re-fetch), filter by hub / day / route,
 *      hover routes to highlight cross-aircraft.
 *
 * Closes via X, Esc, or backdrop click. Aborts any in-flight scrape on
 * close (the scraper's _aborted flag stops the worker loop).
 */
class FleetScheduleGridPanel {
    static OVERLAY_CLASS = "aes-fleet-schedule-grid-overlay"

    static _active = null

    constructor(deps) {
        const d = deps || {}
        this.server      = d.server      || ""
        this.airlineCode = d.airlineCode || ""
        // Optional deep-link selection: when set, the panel pre-filters the
        // hub select and activates the per-aircraft cockpit drawer for the
        // given tail. Used by the Fleet Command Center "Schedule" button.
        this._selectedHub        = d.selectedHub        || null
        this._selectedAircraftId = d.selectedAircraftId != null ? String(d.selectedAircraftId) : null
        this.fleet       = []                          // RowRecord[]
        this.schedules   = new Map()                   // aircraftId -> Schedule
        this.maintenance = new Map()                   // aircraftId -> MaintenanceRecord
        this.coloring    = null
        this._scraper    = null
        this._renderer   = null
        this._overlayEl  = null
        this._gridEl     = null
        this._legendEl   = null
        this._progressEl = null
        this._statusEl   = null
        this._hubSelect  = null
        this._daySelect  = null
        this._refreshBtn = null
        this._closeBtn   = null
        this._keydownHandler = null
        this._mxUnwatch  = null
        this._renderTimer = null
        this._lastRenderAt = 0
    }

    /** Open the modal and start the scrape. Single-instance enforced. */
    static async open(opts) {
        const o = opts || {}
        if (FleetScheduleGridPanel._active) {
            FleetScheduleGridPanel._active.close()
        }
        const p = new FleetScheduleGridPanel(o)
        FleetScheduleGridPanel._active = p
        await p._mount()
        p._kickoffScrape({force: false}).catch(err =>
            console.warn("[AES Fleet Schedule Grid] initial scrape failed", err))
        return p
    }

    static close() {
        if (FleetScheduleGridPanel._active) FleetScheduleGridPanel._active.close()
    }

    close() {
        if (this._scraper) { try { this._scraper.abort() } catch (_) {} }
        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler, true)
            this._keydownHandler = null
        }
        if (this._mxUnwatch) { try { this._mxUnwatch() } catch (_) {} this._mxUnwatch = null }
        if (this._overlayEl && this._overlayEl.parentElement) {
            this._overlayEl.parentElement.removeChild(this._overlayEl)
        }
        this._overlayEl = null
        this._gridEl = this._legendEl = this._progressEl = null
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null }
        if (FleetScheduleGridPanel._active === this) FleetScheduleGridPanel._active = null
    }

    async _mount() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const overlay = document.createElement("div")
        overlay.className = FleetScheduleGridPanel.OVERLAY_CLASS
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(20,18,15,0.62);"
            + "z-index:" + (T ? T.z.modal : 10000) + ";display:flex;align-items:stretch;justify-content:center;"
            + "padding:24px;box-sizing:border-box;"
        overlay.addEventListener("click", e => { if (e.target === overlay) this.close() })

        const modal = document.createElement("div")
        modal.style.cssText = "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "border-radius:0;flex:1 1 auto;max-width:1600px;display:flex;flex-direction:column;"
            + "overflow:hidden;font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "font-size:" + (T ? T.fs.body : "12px") + ";"

        modal.append(this._buildHeader(T))
        modal.append(this._buildControlsBar(T))
        modal.append(this._buildProgressStrip(T))

        const bodyWrap = document.createElement("div")
        bodyWrap.style.cssText = "flex:1 1 auto;display:flex;flex-direction:row;overflow:hidden;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"

        // Left column — grid + legend.
        const gridColumn = document.createElement("div")
        gridColumn.style.cssText = "flex:1 1 auto;display:flex;flex-direction:column;min-width:0;overflow:hidden;"

        const gridScroll = document.createElement("div")
        gridScroll.style.cssText = "flex:1 1 auto;overflow:auto;"
        const gridEl = document.createElement("div")
        gridEl.className = "aes-fsg-grid"
        gridScroll.appendChild(gridEl)
        gridColumn.appendChild(gridScroll)

        const legendEl = document.createElement("div")
        legendEl.style.cssText = "flex:0 0 auto;max-height:30vh;overflow:auto;"
        gridColumn.appendChild(legendEl)

        bodyWrap.appendChild(gridColumn)

        modal.appendChild(bodyWrap)
        overlay.appendChild(modal)
        document.body.appendChild(overlay)

        this._overlayEl = overlay
        this._gridEl = gridEl
        this._legendEl = legendEl
        this._bodyWrapEl = bodyWrap

        // Hover styles for the grid blocks — single style tag scoped to this overlay.
        const styleEl = document.createElement("style")
        styleEl.textContent = ".aes-fsg-block { transition: opacity 80ms linear, box-shadow 80ms linear, transform 80ms linear; }"
            + " .aes-fsg-block.aes-fsg-dim { opacity: 0.18; }"
            + " .aes-fsg-block.aes-fsg-hot { box-shadow: 0 0 0 2px " + (T ? T.color.oxide : "#2B2520") + ", 0 1px 6px rgba(0,0,0,0.3); z-index: 4; transform: translateY(-1px); }"
            + " .aes-fsg-block:hover { z-index: 3; }"
        modal.appendChild(styleEl)

        // ESC closes.
        this._keydownHandler = (e) => {
            if (e.key === "Escape") { e.preventDefault(); this.close() }
        }
        document.addEventListener("keydown", this._keydownHandler, true)

        // Resolve the fleet roster — the AS fleet management page already
        // wrote it; we just re-aggregate it through FleetHubAircraftAggregator
        // so we get hub/locIata/etc.
        await this._loadFleet()
        await this._loadMaintenance()
        this._renderer = new FleetScheduleGridRenderer({
            rootEl:      gridEl,
            fleet:       this.fleet,
            schedules:   this.schedules,
            maintenance: this.maintenance,
            coloring:    null
        })
        this._populateHubSelect()
        this._wireMaintenanceWatch()

        // Apply deep-link hub filter (e.g. when launched from Fleet Command
        // Center's per-hub Schedule button) so the grid opens already
        // narrowed to the target hub.
        if (this._selectedHub && this._hubSelect) {
            const opt = Array.from(this._hubSelect.options).find(o => o.value === this._selectedHub)
            if (opt) {
                this._hubSelect.value = this._selectedHub
                this._renderer.setHub(this._selectedHub)
            }
        }

        // Listen for grid filter clicks to keep the legend in sync.
        gridEl.addEventListener("aes-fsg:filter-changed", (e) => {
            this._renderLegend(e && e.detail ? e.detail.routeKey : null)
        })

        // Aircraft inspect — fired by the grid renderer when the user clicks
        // the Inspect chevron on an aircraft header. Activates the cockpit
        // tab and points it at the selected tail.
        gridEl.addEventListener("aes-fsg:aircraft-selected", (e) => {
            const id = e && e.detail && e.detail.aircraftId
            if (!id || !this._aircraftCockpit) return
            this._aircraftCockpit.setAircraft(id)
            if (this._sideRail) this._sideRail.setActiveTab("aircraft")
        })

        // Repaint wave overlay bands after every grid render.
        gridEl.addEventListener("aes-fsg:rendered", () => this._paintWaveBands())

        // Side rail with the wave picker tab (Slice 1) — drag-source tab is
        // a Slice 3 placeholder for now.
        await this._mountSideRail()

        this._renderAll()
    }

    _buildHeader(T) {
        const h = document.createElement("div")
        h.style.cssText = "display:flex;align-items:center;gap:12px;padding:10px 16px;"
            + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"

        const title = document.createElement("h2")
        title.style.cssText = "margin:0;font-size:" + (T ? T.fs.lead : "14px") + ";"
            + "font-weight:" + (T ? T.fw.display : "800") + ";"
            + "text-transform:uppercase;letter-spacing:0.08em;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";flex:0 0 auto;"
        title.textContent = "Fleet Schedule Grid"

        const subtitle = document.createElement("div")
        subtitle.style.cssText = "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";flex:0 0 auto;"
        subtitle.textContent = this.airlineCode || ""

        const status = document.createElement("div")
        status.style.cssText = "flex:1 1 auto;font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";text-align:right;"
        status.textContent = "Initializing…"
        this._statusEl = status

        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "× Close"
        close.title = "Close (Esc)"
        close.style.cssText = this._btnStyle(T, "default")
        close.addEventListener("click", () => this.close())
        this._closeBtn = close

        h.append(title, subtitle, status)

        // Track C — header shortcut to the per-aircraft cockpit drawer.
        // Hidden when the cockpit module didn't load (load-order race or
        // manifest miss); the side-rail "Aircraft" tab also hides itself
        // in that case so the two stay consistent.
        if (typeof FleetScheduleGridAircraftCockpit !== "undefined") {
            const cockpitBtn = document.createElement("button")
            cockpitBtn.type = "button"
            cockpitBtn.textContent = "Cockpit ▸"
            cockpitBtn.title = "Open the per-aircraft cockpit drawer (candidates, ORS, competitors, current wave)."
            cockpitBtn.style.cssText = this._btnStyle(T, "default")
            cockpitBtn.addEventListener("click", () => this._openCockpit())
            this._cockpitBtn = cockpitBtn
            h.append(cockpitBtn)
        }

        h.append(close)
        return h
    }

    /**
     * Track C — focus the cockpit drawer for the currently-relevant aircraft.
     * Picks the deep-linked id when present, otherwise the last cockpit
     * selection, otherwise the first fleet row, otherwise leaves the cockpit
     * in its empty state. Activates the "aircraft" tab on the side rail.
     */
    _openCockpit() {
        if (!this._sideRail || !this._aircraftCockpit) return
        let id = this._selectedAircraftId
            || (this._aircraftCockpit && this._aircraftCockpit._aircraftId)
            || null
        if (!id && this.fleet && this.fleet.length) {
            id = String(this.fleet[0].aircraftId || "") || null
        }
        if (id) this._aircraftCockpit.setAircraft(id)
        this._sideRail.setActiveTab("aircraft")
    }

    _buildControlsBar(T) {
        const c = document.createElement("div")
        c.style.cssText = "display:flex;align-items:center;gap:12px;padding:8px 16px;"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        const refresh = document.createElement("button")
        refresh.type = "button"
        refresh.textContent = "↻ Refresh all"
        refresh.title = "Force re-fetch every aircraft (ignores cached schedules)"
        refresh.style.cssText = this._btnStyle(T, "rust")
        refresh.addEventListener("click", () => {
            this._kickoffScrape({force: true}).catch(err =>
                console.warn("[AES Fleet Schedule Grid] refresh failed", err))
        })
        this._refreshBtn = refresh

        const sep1 = this._sep(T)

        const hubLabel = document.createElement("label")
        hubLabel.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:0.06em;"
            + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        hubLabel.textContent = "Hub"
        const hubSelect = document.createElement("select")
        hubSelect.style.cssText = "padding:3px 6px;font-size:11px;border:1px solid "
            + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        hubSelect.addEventListener("change", () => {
            const v = hubSelect.value
            if (this._renderer) this._renderer.setHub(v === "*" ? null : v)
        })
        const optAll = document.createElement("option")
        optAll.value = "*"
        optAll.textContent = "All hubs"
        hubSelect.appendChild(optAll)
        this._hubSelect = hubSelect

        const sep2 = this._sep(T)

        const dayLabel = document.createElement("label")
        dayLabel.style.cssText = hubLabel.style.cssText
        dayLabel.textContent = "Day"
        const daySelect = document.createElement("select")
        daySelect.style.cssText = hubSelect.style.cssText
        const dayOpts = [["all", "Mon – Sun"]].concat(
            ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
                .map((d, i) => [String(i), d])
        )
        for (const [v, lbl] of dayOpts) {
            const o = document.createElement("option")
            o.value = v; o.textContent = lbl
            daySelect.appendChild(o)
        }
        daySelect.addEventListener("change", () => {
            if (this._renderer) this._renderer.setDay(daySelect.value === "all" ? "all" : +daySelect.value)
        })
        this._daySelect = daySelect

        const sep3 = this._sep(T)

        const clearFilter = document.createElement("button")
        clearFilter.type = "button"
        clearFilter.textContent = "Clear route filter"
        clearFilter.style.cssText = this._btnStyle(T, "default")
        clearFilter.addEventListener("click", () => {
            if (this._renderer) {
                this._renderer.setRouteFilter(null)
                this._renderLegend(null)
            }
        })

        const note = document.createElement("div")
        note.style.cssText = "margin-left:auto;font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
            + "font-style:italic;"
        note.textContent = "Click any flight to filter to that route · hover to highlight"

        c.append(refresh, sep1, hubLabel, hubSelect, sep2, dayLabel, daySelect, sep3, clearFilter, note)
        return c
    }

    _buildProgressStrip(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 16px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "min-height:22px;"
        const bar = document.createElement("div")
        bar.style.cssText = "flex:1 1 auto;height:6px;background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";position:relative;"
        const fill = document.createElement("div")
        fill.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:0%;"
            + "background:" + (T ? T.color.cobalt : "#3656A8") + ";transition:width 100ms linear;"
        bar.appendChild(fill)
        const lbl = document.createElement("div")
        lbl.style.cssText = "flex:0 0 auto;font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "font-size:11px;min-width:120px;text-align:right;"
        lbl.textContent = "—"
        wrap.append(bar, lbl)
        this._progressEl = {wrap, bar, fill, lbl}
        return wrap
    }

    _btnStyle(T, variant) {
        const base = "padding:4px 10px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "border-radius:0;font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        if (variant === "rust") {
            return base + "background:" + (T ? T.color.rust : "#B8472A") + ";"
                + "color:" + (T ? T.color.rustFg : "#F4F1EA") + ";"
        }
        return base + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
    }

    _sep(T) {
        const s = document.createElement("div")
        s.style.cssText = "width:1px;height:18px;background:" + (T ? T.color.paperRule : "#C9C0B0") + ";"
        return s
    }

    async _loadFleet() {
        try {
            if (typeof FleetHubAircraftAggregator !== "undefined" && this.airlineCode) {
                const fleetKey = this.server + this.airlineCode + "aircraftFleet"
                const blob = await chrome.storage.local.get([fleetKey])
                const rec = blob[fleetKey]
                const fleet = (rec && Array.isArray(rec.fleet)) ? rec.fleet : []
                this.fleet = await FleetHubAircraftAggregator.enrich({
                    server: this.server, airlineCode: this.airlineCode, fleet
                })
                return
            }
            // Fallback path — AesFleetRoster works on any page where it's loaded.
            if (typeof AesFleetRoster !== "undefined") {
                const fleet = await AesFleetRoster.loadCurrent()
                this.fleet = (fleet && fleet.aircraft || []).map(a => ({
                    aircraftId:    a.aircraftId,
                    registration:  a.registration || "",
                    equipment:     a.equipment || "",
                    typeId:        a.typeId || null,
                    hub:           null,
                    locIata:       null,
                    hasDraftedPlan: false,
                    scheduleStatus: null
                }))
                return
            }
        } catch (e) {
            console.warn("[AES Fleet Schedule Grid] fleet load failed", e)
        }
        this.fleet = []
    }

    _populateHubSelect() {
        if (!this._hubSelect) return
        const hubs = new Set()
        for (const r of this.fleet) if (r.hub) hubs.add(r.hub)
        const sorted = Array.from(hubs).sort()
        // Drop existing extras (keep "All hubs" placeholder option).
        while (this._hubSelect.options.length > 1) this._hubSelect.remove(1)
        for (const h of sorted) {
            const o = document.createElement("option")
            o.value = h; o.textContent = h
            this._hubSelect.appendChild(o)
        }
    }

    async _kickoffScrape(opts) {
        if (typeof FleetScheduleGridScraper === "undefined") {
            this._setStatus("FleetScheduleGridScraper missing — check manifest order.")
            return
        }
        const force = !!(opts && opts.force)
        if (this._scraper) {
            try { this._scraper.abort() } catch (_) {}
        }
        this._scraper = new FleetScheduleGridScraper(this.server, {maxConcurrency: 3})

        // Pre-load any cached schedules so the grid paints immediately.
        if (typeof AesAfpScheduleStore !== "undefined") {
            const preload = await Promise.all(this.fleet.map(async (r) => {
                try { return [r.aircraftId, await AesAfpScheduleStore.load(this.server, r.aircraftId)] }
                catch (_) { return [r.aircraftId, null] }
            }))
            this.schedules = new Map()
            for (const [id, s] of preload) if (s) this.schedules.set(String(id), s)
        }
        this._renderAll()

        const startedAt = Date.now()
        const result = await this._scraper.scrapeAll(this.fleet, {
            forceRefetch: force,
            maxAgeMs:     force ? 0 : (10 * 60 * 1000),
            onProgress:   (p) => this._onProgress(p)
        })
        if (this._scraper && this._scraper._aborted) return

        for (const [id, s] of result.schedules) this.schedules.set(String(id), s)
        const failed = result.results.filter(r => !r.ok).length
        const fetched = result.results.filter(r => r.ok && r.source === "fetch").length
        const fresh   = result.results.filter(r => r.ok && r.source === "store-fresh").length
        const empty   = result.results.filter(r => r.ok && r.empty).length
        const elapsedMs = Date.now() - startedAt
        const sec = (elapsedMs / 1000).toFixed(1)
        this._setStatus(
            `${result.results.length} aircraft · ${fetched} fetched · ${fresh} from cache · ${empty} empty · ${failed} failed · ${sec}s`
        )
        this._setProgress(result.results.length, result.results.length)
        this._renderAll()
    }

    _onProgress(p) {
        // Live status line.
        if (p.phase === "fetching") {
            this._setStatus(`Fetching ${p.current} (${p.completed + 1}/${p.total})…`)
        } else if (p.phase === "saved" && p.lastResult && p.lastResult.schedule) {
            this.schedules.set(String(p.lastResult.aircraftId), p.lastResult.schedule)
            this._setStatus(`Loaded ${p.current} (${p.completed}/${p.total})`)
            this._scheduleIncRender()
        } else if (p.phase === "skipped-fresh" && p.lastResult && p.lastResult.schedule) {
            this.schedules.set(String(p.lastResult.aircraftId), p.lastResult.schedule)
            this._setStatus(`Cached ${p.current} (${p.completed}/${p.total})`)
            this._scheduleIncRender()
        } else if (p.phase === "failed") {
            this._setStatus(`Failed ${p.current}: ${(p.lastResult && p.lastResult.error && p.lastResult.error.code) || "?"}`)
        } else if (p.phase === "done") {
            // final summary written by caller
        }
        this._setProgress(p.completed, p.total)
    }

    _setProgress(done, total) {
        if (!this._progressEl) return
        const pct = total ? Math.round((done / total) * 100) : 0
        this._progressEl.fill.style.width = pct + "%"
        this._progressEl.lbl.textContent = total
            ? (done + "/" + total + " · " + pct + "%")
            : "—"
    }

    _setStatus(text) {
        if (this._statusEl) this._statusEl.textContent = text
    }

    /** Debounced re-render during scrape — every 200ms at most. */
    _scheduleIncRender() {
        const now = Date.now()
        if (now - this._lastRenderAt > 250) {
            this._renderAll()
            this._lastRenderAt = now
            return
        }
        if (this._renderTimer) return
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null
            this._lastRenderAt = Date.now()
            this._renderAll()
        }, 250)
    }

    _renderAll() {
        if (!this._renderer) return
        this.coloring = (typeof FleetScheduleGridColoring !== "undefined")
            ? FleetScheduleGridColoring.assign(this.schedules)
            : null
        this._renderer.coloring = this.coloring
        this._renderer.fleet = this.fleet
        this._renderer.schedules = this.schedules
        this._renderer.maintenance = this.maintenance
        this._renderer.render()
        this._renderLegend(null)
        // Keep the cockpit's schedule summary current as bulk-scrape lands.
        if (this._aircraftCockpit) this._aircraftCockpit.refresh()
    }

    _renderLegend(filterRoute) {
        if (!this._legendEl) return
        this._legendEl.innerHTML = ""
        if (!this.coloring) return
        const legend = FleetScheduleGridRenderer.buildLegend(this.coloring, {
            filterRoute,
            onClick: (key, route, mode) => {
                if (mode === "hover-in") {
                    this._renderer.setHoveredRoute(key)
                } else if (mode === "hover-out") {
                    this._renderer.setHoveredRoute(null)
                } else {
                    const next = (this._renderer && this._renderer._filterRoute === key) ? null : key
                    this._renderer.setRouteFilter(next)
                    this._renderLegend(next)
                }
            }
        })
        this._legendEl.appendChild(legend)
    }

    // ── Wave overlay (Slice 1) ──────────────────────────────────────────

    async _mountSideRail() {
        if (typeof FleetScheduleGridSideRail === "undefined") return
        const tabs = []

        if (typeof FleetScheduleGridWavePicker !== "undefined") {
            this._wavePicker = new FleetScheduleGridWavePicker({
                server:        this.server,
                airlineCode:   this.airlineCode,
                currentHub:    this._mostCommonHub(),
                getHubSummary: (hub) => this._buildHubHeaderData(hub),
                onChange:      () => this._paintWaveBands()
            })
            const pane = this._wavePicker.buildPane()
            tabs.push({
                id:          "waves",
                label:       "Waves",
                paneEl:      pane,
                onActivate:  () => this._wavePicker.refresh()
            })
            // Cross-tab sync — when AesAfpSettings.activePresetIdByHub
            // changes from another tab (or from a sibling surface like
            // Route Assistant), refresh the picker so the active marker
            // and Hub Plan Header reflect reality.
            this._attachSettingsWatcher()
        }

        // Per-aircraft cockpit — surfaces candidates · ORS · competitors ·
        // profit · current wave for the tail the user picks via the grid's
        // Inspect chevron. Read-only; deep-link target for the Fleet Command
        // Center "Schedule" button.
        if (typeof FleetScheduleGridAircraftCockpit !== "undefined") {
            this._aircraftCockpit = new FleetScheduleGridAircraftCockpit({
                server:           this.server,
                airlineCode:      this.airlineCode,
                getFleetRow:      (id) => this.fleet.find(r => String(r.aircraftId) === String(id)) || null,
                getSchedule:      (id) => this.schedules.get(String(id)) || null,
                getWaveLayers:    () => this._wavePicker ? this._wavePicker.getLayers() : [],
                activateWavesTab: () => this._sideRail && this._sideRail.setActiveTab("waves")
            })
            const pane = this._aircraftCockpit.buildPane()
            tabs.push({
                id:          "aircraft",
                label:       "Aircraft",
                paneEl:      pane,
                onActivate:  () => this._aircraftCockpit.refresh()
            })
        }

        // Slice 3 — drag destinations tab (real, not a placeholder).
        if (typeof FleetScheduleGridDndSourcePanel !== "undefined") {
            this._dndSourcePanel = new FleetScheduleGridDndSourcePanel({
                server:      this.server,
                airlineCode: this.airlineCode
            })
            const pane = this._dndSourcePanel.buildPane()
            tabs.push({
                id:          "dnd",
                label:       "Drag destinations",
                paneEl:      pane,
                onActivate:  () => this._dndSourcePanel.refresh()
            })
        }

        const initialTab = this._selectedAircraftId ? "aircraft" : "waves"
        this._sideRail = new FleetScheduleGridSideRail({tabs, activeTabId: initialTab})
        this._sideRail.mount(this._bodyWrapEl)
        if (this._wavePicker) await this._wavePicker.refresh()
        if (this._dndSourcePanel) await this._dndSourcePanel.refresh()
        if (this._aircraftCockpit && this._selectedAircraftId) {
            this._aircraftCockpit.setAircraft(this._selectedAircraftId)
        }
        this._paintWaveBands()
        this._mountDndBridge()
    }

    _mostCommonHub() {
        const counts = new Map()
        for (const r of this.fleet) if (r.hub) counts.set(r.hub, (counts.get(r.hub) || 0) + 1)
        let best = null, bestN = 0
        for (const [h, n] of counts) if (n > bestN) { best = h; bestN = n }
        return best || ""
    }

    /**
     * Hub Plan Workbench — fleet-derived summary for the picker's Hub
     * Plan Header card. Returns count of aircraft whose home hub matches,
     * plus total fleet size, so the user sees "matched 5/9 aircraft".
     */
    _buildHubHeaderData(hub) {
        const HUB = String(hub || "").toUpperCase()
        if (!HUB || !this.fleet || !this.fleet.length) return null
        let count = 0
        for (const r of this.fleet) {
            if (r && String(r.hub || "").toUpperCase() === HUB) count++
        }
        return {count, total: this.fleet.length}
    }

    /**
     * Watch chrome.storage for AesAfpSettings changes so the picker
     * repaints when another tab updates the per-hub active map. The
     * settings blob lives under the top-level "settings" key; we
     * unconditionally refresh the picker on any change there — a
     * narrower diff isn't worth the complexity since refresh() is cheap.
     */
    _attachSettingsWatcher() {
        if (this._settingsWatcherAttached) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        this._settingsWatcherAttached = true
        const handler = (changes, area) => {
            if (area !== "local") return
            if (!changes || !changes.settings) return
            if (!this._wavePicker) return
            this._wavePicker.refresh().then(() => this._paintWaveBands()).catch(() => {})
        }
        try { chrome.storage.onChanged.addListener(handler) }
        catch (_) {}
    }

    // ── Drag-and-drop bridge (Slice 3) ──────────────────────────────────

    _mountDndBridge() {
        if (this._dndBridge || !this._gridEl) return
        if (typeof FleetScheduleGridDndBridge === "undefined") return
        this._dndBridge = new FleetScheduleGridDndBridge({
            gridEl: this._gridEl,
            getScheduleForLane: (lane) => {
                const id = lane && lane.dataset && lane.dataset.aircraftId
                return id ? this.schedules.get(String(id)) || null : null
            },
            onDrop: (drop) => this._onDestinationDrop(drop)
        })
        this._dndBridge.attach()
    }

    _onDestinationDrop(drop) {
        if (!drop || !drop.aircraftId || !drop.destIata) return
        if (typeof FleetScheduleGridDropPopover === "undefined") return
        const fleetRow = this.fleet.find(r => String(r.aircraftId) === String(drop.aircraftId)) || null
        const schedule = this.schedules.get(String(drop.aircraftId)) || null
        const sourceWaveLayer = drop.sourceWaveLayerId && this._wavePicker
            ? (this._wavePicker.getLayers() || []).find(l => l.id === drop.sourceWaveLayerId) || null
            : null
        FleetScheduleGridDropPopover.openAt({
            dropCtx: drop,
            deps: {
                server:      this.server,
                fleetRow,
                schedule,
                sourceWaveLayer
            },
            onApplied: () => {
                this._rescrapeAircraft(drop.aircraftId).catch(err =>
                    console.warn("[AES Fleet Schedule Grid] post-apply rescrape failed", err))
            }
        })
    }

    async _rescrapeAircraft(aircraftId) {
        if (!aircraftId || typeof FleetScheduleGridScraper === "undefined") return
        // Invalidate the proxy form-context cache so any subsequent drop
        // doesn't dispatch against a stale form action URL.
        try {
            const fetcher = (typeof window !== "undefined") ? window.__aesFsgProxyFetcher : null
            if (fetcher && typeof fetcher.invalidate === "function") fetcher.invalidate(aircraftId)
        } catch (_) {}
        const oneShot = new FleetScheduleGridScraper(this.server, {maxConcurrency: 1})
        let res
        try { res = await oneShot.scrapeOne(aircraftId, {force: true}) }
        catch (err) {
            console.warn("[AES Fleet Schedule Grid] scrapeOne threw", err)
            return
        }
        if (res && res.ok && res.schedule) {
            this.schedules.set(String(aircraftId), res.schedule)
            await this._refreshMaintenance(aircraftId)
            this._renderAll()
            this._setStatus("Updated " + (res.schedule && res.schedule.aircraftId ? "aircraft " + res.schedule.aircraftId : aircraftId))
        } else if (res && !res.ok) {
            this._setStatus("Rescrape failed: " + ((res.error && res.error.code) || "?"))
        }
    }

    /**
     * Bulk-load maintenance records for every fleet row at panel mount.
     * Silently skips when AesAfpMaintenanceStore isn't loaded — same defensive
     * pattern as the rest of the AFP-store callers.
     */
    async _loadMaintenance() {
        if (typeof AesAfpMaintenanceStore === "undefined") return
        if (!this.fleet || !this.fleet.length) return
        const recs = await Promise.all(this.fleet.map(row =>
            AesAfpMaintenanceStore.load(this.server, row.aircraftId).catch(() => null)
        ))
        for (let i = 0; i < this.fleet.length; i++) {
            const rec = recs[i]
            if (rec) this.maintenance.set(String(this.fleet[i].aircraftId), rec)
        }
    }

    async _refreshMaintenance(aircraftId) {
        if (typeof AesAfpMaintenanceStore === "undefined") return
        try {
            const rec = await AesAfpMaintenanceStore.load(this.server, aircraftId)
            if (rec) this.maintenance.set(String(aircraftId), rec)
        } catch (_) { /* noop */ }
    }

    /**
     * Re-render when a maintenance record changes in any tab — keeps the row
     * header in sync with whatever the AFP page scraper most recently wrote.
     */
    _wireMaintenanceWatch() {
        if (typeof AesAfpMaintenanceStore === "undefined") return
        if (typeof AesAfpMaintenanceStore.watch !== "function") return
        this._mxUnwatch = AesAfpMaintenanceStore.watch(({server, aircraftId, maintenance}) => {
            if (!aircraftId) return
            if (server && this.server && String(server) !== String(this.server)) return
            this.maintenance.set(String(aircraftId), maintenance)
            this._scheduleIncRender()
        })
    }

    _paintWaveBands() {
        if (!this._gridEl) return
        if (typeof FleetScheduleGridWaveOverlay === "undefined") return
        // The drag handler holds an in-memory copy that overrides the picker's
        // store-backed copy during a drag; otherwise we use the picker's view.
        const layers = this._dragLayers || (this._wavePicker ? this._wavePicker.getLayers() : [])
        const fadeRatio = this._wavePicker ? this._wavePicker.getFadeRatio() : 0.25
        const lanes = this._gridEl.querySelectorAll("[data-aircraft-id][data-day-idx]")
        for (const lane of lanes) {
            const dayIdx = +lane.dataset.dayIdx
            const hub = (lane.dataset.hub || "").toUpperCase()
            const visibleLayers = layers.filter(l => l.days[dayIdx])
            FleetScheduleGridWaveOverlay.paint(lane, {
                dayIdx,
                layers:    visibleLayers,
                hubMatch:  (l) => !l.hub || hub === l.hub,
                fadeRatio
            })
        }
        if (!this._waveDragAttached) this._attachWaveDragHandler()
    }

    // ── Wave drag-to-shift (Slice 2) ────────────────────────────────────

    _attachWaveDragHandler() {
        if (this._waveDragAttached || !this._gridEl) return
        this._waveDragAttached = true
        this._gridEl.addEventListener("mousedown", (e) => this._onBandMouseDown(e))
    }

    _onBandMouseDown(e) {
        if (e.button !== 0) return
        const bandEl = e.target && e.target.closest(".aes-fsg-wave-band")
        if (!bandEl) return
        const lane = bandEl.closest("[data-aircraft-id][data-day-idx]")
        if (!lane) return
        const layerId = bandEl.dataset.layerId
        const bandKind = bandEl.dataset.bandKind
        if (!layerId || !this._wavePicker) return
        this._dragLayers = JSON.parse(JSON.stringify(this._wavePicker.getLayers()))
        const target = this._dragLayers.find(l => l.id === layerId)
        if (!target) { this._dragLayers = null; return }

        FleetScheduleGridPanel._ensureArbGesture()
        const rect = lane.getBoundingClientRect()
        const startX = e.clientX
        const startTimeShift = target.timeShiftMin || 0
        const startArrShift  = target.arrShiftMin  || 0
        const startDepShift  = target.depShiftMin  || 0
        const altMode = !!e.altKey
        const widthMin = FleetScheduleGridRenderer.MIN_PER_DAY

        const arbCtx = {
            kind: "fsg.band.shift",
            panel: this, target, layerId, bandKind, altMode, widthMin,
            rect, startX, startTimeShift, startArrShift, startDepShift,
            pendingFrame: null, lastDeltaMin: 0,
            origLayer: JSON.parse(JSON.stringify(target))
        }
        if (!window.AesDragArbiter || !window.AesDragArbiter.startManual(e, arbCtx)) return
        e.preventDefault()
    }

    static _ensureArbGesture() {
        if (FleetScheduleGridPanel._arbRegistered) return
        if (!window.AesDragArbiter) return
        FleetScheduleGridPanel._arbRegistered = true
        window.AesDragArbiter.register({
            id:       "fsg.band.shift",
            surface:  "fsg",
            priority: 100,
            matches:  (e, c) => !!(c && c.kind === "fsg.band.shift"),
            feedback: {
                onMove:   (ev, c)   => FleetScheduleGridPanel._arbBandMove(ev, c),
                onCancel: (c, info) => FleetScheduleGridPanel._arbBandCancel(c, info)
            },
            effect:   (drop)        => FleetScheduleGridPanel._arbBandDrop(drop)
        })
    }

    static _arbBandMove(ev, c) {
        const dxPx = ev.clientX - c.startX
        const deltaMin = Math.round((dxPx / c.rect.width) * c.widthMin / 5) * 5
        if (deltaMin === c.lastDeltaMin) return
        c.lastDeltaMin = deltaMin
        if (c.altMode) {
            if (c.bandKind === "arr") c.target.arrShiftMin = c.startArrShift + deltaMin
            else                       c.target.depShiftMin = c.startDepShift + deltaMin
        } else {
            c.target.timeShiftMin = c.startTimeShift + deltaMin
        }
        if (c.pendingFrame) return
        c.pendingFrame = requestAnimationFrame(() => {
            c.pendingFrame = null
            c.panel._paintWaveBands()
            c.panel._showDragReadout(c.target, c.altMode ? c.bandKind : "both")
        })
    }

    static _arbBandCancel(c) {
        if (c.pendingFrame) { cancelAnimationFrame(c.pendingFrame); c.pendingFrame = null }
        // Revert in-memory layer to pre-drag snapshot.
        c.target.timeShiftMin = c.origLayer.timeShiftMin || 0
        c.target.arrShiftMin  = c.origLayer.arrShiftMin  || 0
        c.target.depShiftMin  = c.origLayer.depShiftMin  || 0
        c.panel._dragLayers = null
        c.panel._hideDragReadout()
        c.panel._paintWaveBands()
    }

    static async _arbBandDrop(drop) {
        const c = drop.ctx
        if (c.pendingFrame) { cancelAnimationFrame(c.pendingFrame); c.pendingFrame = null }
        const finalLayer = c.target
        c.panel._dragLayers = null
        c.panel._hideDragReadout()
        if (typeof FleetScheduleGridWaveLayoutStore !== "undefined") {
            try { await FleetScheduleGridWaveLayoutStore.upsertLayer(c.panel.server, c.panel.airlineCode, finalLayer) }
            catch (err) { console.warn("[AES FSG] wave drag persist failed", err) }
            if (c.panel._wavePicker) await c.panel._wavePicker.refresh()
        }
        c.panel._paintWaveBands()
        return {ok: true, audit: {
            kind:     "fsg-band-shift",
            layerId:  c.layerId,
            bandKind: c.bandKind,
            altMode:  c.altMode,
            before:   {time: c.startTimeShift, arr: c.startArrShift, dep: c.startDepShift},
            after:    {time: finalLayer.timeShiftMin || 0, arr: finalLayer.arrShiftMin || 0, dep: finalLayer.depShiftMin || 0}
        }}
    }

    _showDragReadout(layer, kind) {
        if (!this._dragReadoutEl) {
            const T = (typeof window !== "undefined" && window.AESTokens) || null
            const el = document.createElement("div")
            el.style.cssText = "position:fixed;z-index:" + (T ? T.z.toast : 10001) + ";"
                + "padding:6px 10px;background:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "color:" + (T ? T.color.boneFg : "#F4F1EA") + ";"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
                + "border-radius:2px;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);"
                + "top:auto;bottom:24px;left:50%;transform:translateX(-50%);"
            document.body.appendChild(el)
            this._dragReadoutEl = el
        }
        const fmt = (m) => (m === 0 ? "±0" : (m > 0 ? "+" + m : String(m))) + "m"
        const total = layer.timeShiftMin || 0
        const arr = layer.arrShiftMin || 0
        const dep = layer.depShiftMin || 0
        let line = "Shift: " + fmt(total)
        if (arr) line += " · A " + fmt(arr)
        if (dep) line += " · D " + fmt(dep)
        if (kind !== "both") line += " (Alt: " + (kind === "arr" ? "arrival only" : "departure only") + ")"
        this._dragReadoutEl.textContent = line
    }

    _hideDragReadout() {
        if (this._dragReadoutEl && this._dragReadoutEl.parentElement) {
            this._dragReadoutEl.parentElement.removeChild(this._dragReadoutEl)
        }
        this._dragReadoutEl = null
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridPanel = FleetScheduleGridPanel
}
