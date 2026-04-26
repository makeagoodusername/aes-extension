/**
 * Route Assistant — fixed-position side panel for the AS scheduling page.
 *
 * Replaces the older FlightsFromSchedulePanel with a richer, scored view that
 * blends:
 *   - flightsfrom.com cached routes for the hub
 *   - AS station demand (pax/cargo 0-10) per destination
 *   - the user's own existing frequency to each destination
 *   - airline-count from flightsfrom (competition proxy)
 *
 * Mount lifecycle:
 *   const panel = new RouteAssistantPanel({resolveOriginIata})
 *   panel.mount()    // attaches to document.body, calls render()
 *   panel.dispose()  // tears down
 */
class RouteAssistantPanel {
    constructor(opts) {
        this.resolveOriginIata = opts && opts.resolveOriginIata
        this.server = window.location.hostname.split(".")[0]
        this.root = null
        this.body = null
        this.statusBar = null
        this.controlsHost = null   // hosts the Mode + Aircraft dropdowns
        this.chipBar = null        // Q1 quick-filter chips, between tabBar and tableHost
        this.tableHost = null
        this.settingsHost = null
        this.collapsed = false
        this._hubShortcutHandler = null   // Q15 hub keyboard quick-swap (Alt+1..5)

        this.settings = null      // RouteAssistantSettings.load() result
        this.hubIata = null
        this.ffData = null
        this.demandMap = new Map()
        this.ownSchedule = null
        this.rows = []
        this.scoredRows = []
        this.sortField = "score"
        this.sortDir = -1

        this.scanController = null
        this.scanner = null
        this.distanceResolver = null
        this.distanceProgress = null  // {total, done} while a fetch is running
        this.overrideMap = new Map()
        this.yieldHistoryMap = new Map()    // routeAssistant:yieldHistory:<HUB>-<DEST>
        this.serviceConfigMap = new Map()   // routeAssistant:serviceConfig:<HUB>-<DEST>
        this.routeNoteMap = new Map()       // routeAssistant:routeNote:<HUB>-<DEST>
        this.serviceProfilesCache = new Map()  // Map<id, profileDetail> from RouteAssistantServiceProfileScraper
        this._serviceProfilesList = null    // {profiles, scrapedAt}
        this._serviceProfileSyncRunning = false
        this._snapshotRunning = false
        this._snapshotStatusEl = null
        this.fuelPrice = null         // RouteAssistantFuelPriceScraper cached record
        this._fuelScrapeInFlight = false
        this.fuelBurnOverrides = new Map()  // Map<typeId, {cycleL, perKmL}>

        // Phase 2 — fleet awareness
        this.fleet = null              // RouteAssistantFleetStore.loadFleet result, or null
        this.typeSpecs = new Map()     // Map<typeId, spec record>
        this.typeSpecsProgress = null  // {total, done} while specs fetch in flight
        this.selectedSpec = null       // resolved spec for Type/Tail mode
        this.fleetSpecs = null         // array of specs for Fleet mode
        this._storageListener = null
        this._storageDebounceTimer = null

        // Re-entry / lifecycle guards. The two enrichment loops can be
        // triggered both by user action (refresh) and by storage events,
        // so guard against running twice in parallel and against firing
        // a re-render after dispose.
        this._disposed = false
        this._enrichingDistances = false
        this._enrichingTypeSpecs = false

        // Debounce timer for live Economics input typing — coalesces a
        // multi-keystroke value (e.g. "0.123") into one save + recompute.
        this._economicsDebounceTimer = null

        // Diff-against-last-visit baseline. Loaded once per mount in
        // refresh() from `routeAssistant:lastSnapshot:<HUB>`; held in memory
        // so intra-mount re-renders keep showing the same "since last visit"
        // delta even after _drawTable overwrites the storage record.
        this._diffPrevSnapshot   = null
        this._diffBaselineLoaded = false

        // Route-note popover state. Cleanup function unbinds the
        // outside-click + Escape listeners; nullified by
        // _closeRouteNotePopover when the popover dismisses.
        this._routeNotePopover        = null
        this._routeNotePopoverCleanup = null

        // Watchlist (starred routes) — global Set<"HUB-DEST"> loaded once
        // per refresh() from RouteAssistantWatchlistStore. The panel
        // decorates each scoredRow with `_starred: bool` before sorting
        // so the destIata render closure + `_sortRows` can react. Star
        // toggles flip the in-memory Set immediately, persist async, then
        // re-render — no need to await storage to update the UI.
        this._watchlist = new Set()

        // Wave overlay (Roadmap H slice 1) — cached build + presets list
        // kept across intra-mode re-renders. Invalidated explicitly by the
        // Re-run button + on hub change / preset change.
        this._waveBuild    = null
        this._wavePresets  = null   // last-loaded SchedulePresets.load() block
        this._waveBuildHub = null   // hub IATA the cached build was for

        // ORS Sandbox (Letter I slice 1) — per-route pricing simulator state.
        // `_orsSandboxRoute` holds the {hub, dest} of the picked route;
        // `_orsSandboxResult` caches the latest projection from
        // RouteAssistantOrsModel.project so re-renders during slider drag
        // don't blow away the in-flight result. `_orsSandboxRaf` coalesces
        // slider-input events to one recompute per animation frame.
        this._orsSandboxRoute  = null
        this._orsSandboxResult = null
        this._orsSandboxRaf    = 0

        // Active prompts — alert rules + per-mount fired set.
        // The fired set keeps the same rule+route from spamming toasts on
        // intra-mount re-renders (sort change, filter tweak, etc.). The
        // store-level cooldown (rule.cooldownHours) handles the cross-
        // mount case so the user doesn't see the same alert every time
        // they open the panel within a day.
        this._alertRules = []
        this._alertFiredThisMount = new Set()
    }

    async mount() {
        if (this.root) return
        this.settings = await RouteAssistantSettings.load()
        this.collapsed = !!this.settings.collapsed

        this._buildSkeleton()
        document.body.append(this.root)
        this._attachStorageListener()
        this._attachHubShortcuts()
        await this.refresh()
        this._maybeAutoSnapshot()
    }

    /**
     * If the user opted into auto-snapshot, fire one snapshot pass once after
     * mount/refresh has populated rows + cached live-route data. Skipped
     * silently when the prerequisite caches are empty so a brand-new install
     * doesn't burn cycles for no benefit. Runs as fire-and-forget — the UI
     * keeps rendering while the snapshot completes; `_runYieldSnapshot` will
     * re-render when finished.
     */
    _maybeAutoSnapshot() {
        const cfg = this.settings && this.settings.yieldFeedback
        if (!cfg || !cfg.autoSnapshotOnMount) return
        if (this._snapshotRunning) return
        if (!this.hubIata || !this.rows || !this.rows.length) return
        const liveCount = this.rows.filter(r => r.liveAircraftType || r.liveDeparture).length
        if (!liveCount) return
        this._runYieldSnapshot()
    }

    dispose() {
        this._disposed = true
        if (this.scanner) this.scanner.abort()
        if (this._onViewportResize) {
            window.removeEventListener("resize", this._onViewportResize)
            this._onViewportResize = null
        }
        if (this._viewportResizeTimer) {
            clearTimeout(this._viewportResizeTimer)
            this._viewportResizeTimer = null
        }
        this._detachStorageListener()
        this._detachHubShortcuts()
        if (this._stationStatusStrip) { this._stationStatusStrip.dispose(); this._stationStatusStrip = null }
        this._closeProfitPopover()
        this._closeServicePopover()
        this._closeCarrierPopover()
        this._closeRouteNotePopover()
        if (this._overrideEditor && this._overrideEditor.parentNode) {
            this._overrideEditor.parentNode.removeChild(this._overrideEditor)
            this._overrideEditor = null
        }
        if (this._fuelBurnEditor && this._fuelBurnEditor.parentNode) {
            this._fuelBurnEditor.parentNode.removeChild(this._fuelBurnEditor)
            this._fuelBurnEditor = null
        }
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root)
        this.root = null
    }

    /**
     * React to fleet/type-spec writes from sibling tabs without forcing the
     * user to click refresh. Phase 2 introduced two background writers:
     *  - content_fleetManagement.js (writes <server><airline>aircraftFleet)
     *  - content_marketScan.js / our own _enrichTypeSpecsAsync (writes
     *    routeAssistant:typeSpec:<typeId>)
     * Either can populate the cache while the panel is mounted.
     */
    _attachStorageListener() {
        if (!chrome.storage || !chrome.storage.onChanged) return
        this._storageListener = (changes, areaName) => {
            if (areaName !== "local") return
            let interesting = false
            for (const key in changes) {
                if (key.endsWith("aircraftFleet")) interesting = true
                else if (key.startsWith(RouteAssistantTypeSpecsStore.PREFIX)) interesting = true
                if (interesting) break
            }
            if (!interesting) return
            // Debounce — a fleet rescan writes one big record, but the
            // sibling specs enrichment writes one key per type. Avoid
            // re-rendering N times.
            clearTimeout(this._storageDebounceTimer)
            this._storageDebounceTimer = setTimeout(() => this.refresh(), 500)
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    _detachStorageListener() {
        if (this._storageListener && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.removeListener(this._storageListener)
        }
        this._storageListener = null
        clearTimeout(this._storageDebounceTimer)
        this._storageDebounceTimer = null
        clearTimeout(this._economicsDebounceTimer)
        this._economicsDebounceTimer = null
    }

    /**
     * Cheap re-aggregation that re-applies fleet context to the existing
     * `this.rows` and re-renders the table. Used by Economics input
     * handlers and the falloff% selector — neither invalidates fleet,
     * schedule, distance, or spec caches, so calling the full `refresh()`
     * (with two `chrome.storage.local.get(null)` reads) per keystroke
     * would be wasteful.
     */
    _recomputeProfit() {
        if (!this.rows || !this.rows.length) return
        RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
        this._renderRows()
    }

    /**
     * Toggle a route's starred state. Updates the in-memory Set immediately
     * and re-renders so the user sees the flip without waiting on storage,
     * then persists asynchronously through RouteAssistantWatchlistStore.
     * Failures fall back to the persisted state on the next refresh.
     */
    async _toggleWatchlist(hub, dest) {
        if (!hub || !dest) return
        const key = String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
        const wasStarred = this._watchlist.has(key)
        if (wasStarred) this._watchlist.delete(key)
        else            this._watchlist.add(key)
        this._renderRows()
        try {
            await RouteAssistantWatchlistStore.toggle(hub, dest)
            // Foundation toast — gives the user visible confirmation of the
            // flip and a one-click Undo. Replaces silent state changes.
            if (typeof RouteAssistantToast !== "undefined") {
                const verb = wasStarred ? "Unstarred" : "Starred"
                RouteAssistantToast.show(verb + " " + key, {
                    type:  wasStarred ? "info" : "success",
                    id:    "watchlist-" + key,
                    action: {
                        label: "Undo",
                        fn:    () => this._toggleWatchlist(hub, dest)
                    }
                })
            }
        } catch (e) {
            console.warn("[AES routeAssistant] watchlist toggle failed:", e)
            if (wasStarred) this._watchlist.add(key)
            else            this._watchlist.delete(key)
            this._renderRows()
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.error("Watchlist toggle failed for " + key)
            }
        }
    }

    /**
     * Export the entire `settings.routeAssistant` + `settings.usedAircraftScanner`
     * blobs as a downloadable JSON file. Wrap-format envelope is documented
     * next to AES_CONFIG_FORMAT below.
     */
    async _exportConfig() {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const manifest = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
            ? chrome.runtime.getManifest()
            : {}
        const envelope = {
            format:              AES_CONFIG_FORMAT,
            version:             manifest.version_name || manifest.version || "unknown",
            exportedAt:          new Date().toISOString(),
            server:              this.server || "",
            routeAssistant:      settings.routeAssistant || {},
            usedAircraftScanner: settings.usedAircraftScanner || {}
        }
        const json = JSON.stringify(envelope, null, 2)
        const blob = new Blob([json], {type: "application/json"})
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = "aes-config-" + (this.server || "world") + "-"
            + new Date().toISOString().slice(0, 10) + ".json"
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        if (typeof RouteAssistantToast !== "undefined") {
            RouteAssistantToast.success("Exported " + a.download)
        }
    }

    /**
     * Open the system file picker for an AES config JSON, validate it,
     * compute the diff against current settings, and show a modal listing
     * every change with Apply / Cancel. On Apply both blobs are written
     * back through their respective stores (which deep-merge against
     * defaults for any missing keys).
     */
    _openImportConfig() {
        const input = document.createElement("input")
        input.type = "file"
        input.accept = "application/json,.json"
        input.style.display = "none"
        input.addEventListener("change", async () => {
            const file = input.files && input.files[0]
            document.body.removeChild(input)
            if (!file) return
            let parsed
            try {
                const text = await file.text()
                parsed = JSON.parse(text)
            } catch (e) {
                this._noteToast("Couldn't parse JSON: " + e.message, true)
                return
            }
            if (!parsed || parsed.format !== AES_CONFIG_FORMAT) {
                this._noteToast("Not a valid AES config file (expected format: \""
                    + AES_CONFIG_FORMAT + "\").", true)
                return
            }
            // Defend against hand-edited JSON where a namespace was replaced
            // with a non-object — _diffConfig would otherwise walk Object.keys
            // on a string/array and produce nonsense rows.
            if (parsed.routeAssistant !== undefined && !_isPlainObject(parsed.routeAssistant)) {
                this._noteToast("Config file shape is invalid (routeAssistant must be an object).", true)
                return
            }
            if (parsed.usedAircraftScanner !== undefined && !_isPlainObject(parsed.usedAircraftScanner)) {
                this._noteToast("Config file shape is invalid (usedAircraftScanner must be an object).", true)
                return
            }
            const data = await chrome.storage.local.get(["settings"])
            const cur = data.settings || {}
            const changes = _diffConfig(
                {routeAssistant: cur.routeAssistant || {}, usedAircraftScanner: cur.usedAircraftScanner || {}},
                {routeAssistant: parsed.routeAssistant || {}, usedAircraftScanner: parsed.usedAircraftScanner || {}}
            )
            this._showImportDiffModal(parsed, changes)
        })
        document.body.appendChild(input)
        input.click()
    }

    /**
     * Floating modal listing every changed leaf path in the import diff.
     * Apply writes both blobs back via their stores; Cancel discards.
     * No-changes case still shows the modal so the user knows the file
     * matched their current state (and didn't silently no-op).
     */
    _showImportDiffModal(parsed, changes) {
        const overlay = document.createElement("div")
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);"
            + "z-index:10001;display:flex;align-items:center;justify-content:center;"
        const modal = document.createElement("div")
        modal.style.cssText = "background:#1f2937;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:6px;padding:12px 16px;min-width:480px;max-width:80vw;"
            + "max-height:80vh;display:flex;flex-direction:column;font:13px/1.4 sans-serif;"

        // Partition changes by namespace so the per-section toggles can hide
        // their rows without rebuilding the list, and Apply can gate each
        // store's save() independently.
        const raChanges  = changes.filter(c => c.path.startsWith("routeAssistant."))
        const uasChanges = changes.filter(c => c.path.startsWith("usedAircraftScanner."))

        const h = document.createElement("strong")
        h.textContent = "Import AES config — " + changes.length + " change"
            + (changes.length === 1 ? "" : "s")
        h.style.cssText = "font-size:14px;margin-bottom:6px;"

        const meta = document.createElement("div")
        meta.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:8px;"
        meta.textContent = "From: v" + (parsed.version || "?") + "  ·  exported "
            + (parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString() : "?")
            + (parsed.server ? "  ·  server " + parsed.server : "")

        // Version-skew warning — informational only, never blocks Apply. The
        // deep-merge in each store's save() handles missing/extra keys, but
        // a renamed key would silently land in the wrong place, so the user
        // should eyeball the diff before committing across versions.
        const currentVersion = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
            ? (chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version || "")
            : ""
        let skewBanner = null
        if (parsed.version && currentVersion && parsed.version !== currentVersion) {
            skewBanner = document.createElement("div")
            skewBanner.style.cssText = "margin:0 0 8px 0;padding:6px 10px;"
                + "background:rgba(245, 158, 11, 0.12);border:1px solid rgba(245, 158, 11, 0.40);"
                + "border-radius:4px;color:#fcd34d;font-size:11px;"
            skewBanner.textContent = "⚠ Imported from v" + parsed.version
                + ". You're on v" + currentVersion
                + ". Schema may have changed shape; review the diff carefully."
        }

        // Per-namespace toggles — disabled when the namespace isn't present
        // in the envelope. State drives both the row visibility and which
        // save() runs at Apply time.
        const raPresent  = parsed.routeAssistant !== undefined
        const uasPresent = parsed.usedAircraftScanner !== undefined
        let importRA  = raPresent
        let importUAS = uasPresent

        const toggles = document.createElement("div")
        toggles.style.cssText = "display:flex;gap:14px;margin-bottom:8px;font-size:12px;color:#cbd5e1;"

        const mkToggle = (label, count, present, getter, setter) => {
            const wrap = document.createElement("label")
            wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;cursor:"
                + (present ? "pointer" : "default") + ";"
                + (present ? "" : "opacity:0.45;")
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = getter() && present
            cb.disabled = !present
            cb.style.cursor = present ? "pointer" : "default"
            cb.addEventListener("change", () => {
                setter(cb.checked)
                applyVisibilityAndLabel()
            })
            const txt = document.createElement("span")
            txt.textContent = label + " (" + count + " change"
                + (count === 1 ? "" : "s") + ")"
            wrap.append(cb, txt)
            return wrap
        }
        toggles.append(
            mkToggle("Route Assistant", raChanges.length, raPresent,
                () => importRA, (v) => { importRA = v }),
            mkToggle("Used Aircraft Scanner", uasChanges.length, uasPresent,
                () => importUAS, (v) => { importUAS = v })
        )

        const list = document.createElement("div")
        list.style.cssText = "overflow-y:auto;flex:1;border:1px solid #374151;"
            + "border-radius:4px;padding:6px 8px;margin-bottom:10px;background:#0f1623;"
            + "font-family:ui-monospace,monospace;font-size:11px;"

        // Tag each row with its namespace so toggle handlers can flip
        // display:none without rebuilding the list.
        const rowEntries = []

        if (!changes.length) {
            const p = document.createElement("p")
            p.textContent = "Imported config is identical to current settings — nothing to apply."
            p.style.cssText = "color:#9ca3af;margin:6px 0;"
            list.append(p)
        } else {
            for (const c of changes) {
                const namespace = c.path.startsWith("routeAssistant.")        ? "ra"
                                : c.path.startsWith("usedAircraftScanner.")   ? "uas"
                                                                              : "other"
                const row = document.createElement("div")
                row.style.cssText = "padding:2px 0;border-bottom:1px solid #1f2937;"
                const tagColor = c.kind === "added"   ? "#86efac"
                              : c.kind === "removed" ? "#fca5a5"
                              : "#fde68a"
                const tag = document.createElement("span")
                tag.textContent = c.kind.toUpperCase().padEnd(8, " ")
                tag.style.cssText = "color:" + tagColor + ";font-weight:bold;margin-right:6px;"
                const path = document.createElement("span")
                path.textContent = c.path
                path.style.cssText = "color:#cbd5e1;"
                row.append(tag, path)
                if (c.kind === "changed") {
                    const arrow = document.createElement("div")
                    arrow.style.cssText = "color:#9ca3af;margin-left:64px;"
                    arrow.textContent = _formatDiffValue(c.from) + "  →  " + _formatDiffValue(c.to)
                    row.append(arrow)
                } else if (c.kind === "added") {
                    const arrow = document.createElement("div")
                    arrow.style.cssText = "color:#9ca3af;margin-left:64px;"
                    arrow.textContent = "(new)  →  " + _formatDiffValue(c.to)
                    row.append(arrow)
                } else {
                    const arrow = document.createElement("div")
                    arrow.style.cssText = "color:#9ca3af;margin-left:64px;"
                    arrow.textContent = _formatDiffValue(c.from) + "  →  (removed)"
                    row.append(arrow)
                }
                list.append(row)
                rowEntries.push({row, namespace})
            }
        }

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;"
        const cancel = document.createElement("button")
        cancel.textContent = "Cancel"
        Object.assign(cancel.style, smallBtnStyle())
        cancel.style.background = "#374151"
        const apply = document.createElement("button")
        Object.assign(apply.style, smallBtnStyle())

        // Recompute visible-changes count + Apply label whenever a namespace
        // toggle flips. Also flips row visibility in place — checking a box
        // restores rows without rebuilding the list.
        const applyVisibilityAndLabel = () => {
            const visibleCount = (importRA ? raChanges.length : 0)
                + (importUAS ? uasChanges.length : 0)
            for (const e of rowEntries) {
                const show = (e.namespace === "ra"  && importRA)
                          || (e.namespace === "uas" && importUAS)
                          || (e.namespace === "other")
                e.row.style.display = show ? "" : "none"
            }
            if (visibleCount === 0) {
                apply.textContent = "Close"
                apply.style.background = "#374151"
            } else {
                apply.textContent = "Apply " + visibleCount + " change"
                    + (visibleCount === 1 ? "" : "s")
                apply.style.background = ""
            }
        }
        applyVisibilityAndLabel()

        // Lifecycle — single close() removes the overlay AND unbinds both
        // listeners. Previous version only unbound the keydown listener on
        // Escape press, so Cancel/Apply leaked it forever.
        const onKey = (e) => { if (e.key === "Escape") close() }
        const onOverlayClick = (e) => { if (e.target === overlay) close() }
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            document.removeEventListener("keydown", onKey)
            overlay.removeEventListener("click", onOverlayClick)
        }
        cancel.addEventListener("click", close)
        apply.addEventListener("click", async () => {
            const visibleCount = (importRA ? raChanges.length : 0)
                + (importUAS ? uasChanges.length : 0)
            close()
            if (visibleCount === 0) return

            // Per-namespace try/catch so a UAS save failure doesn't bury the
            // fact that the RA save already landed. The user always learns
            // exactly which blob made it into storage.
            const applied = []
            const failed  = []
            if (importRA && parsed.routeAssistant) {
                try {
                    await RouteAssistantSettings.save(parsed.routeAssistant)
                    applied.push("routeAssistant")
                } catch (e) {
                    failed.push({ns: "routeAssistant", err: e && e.message ? e.message : String(e)})
                }
            }
            if (importUAS && parsed.usedAircraftScanner) {
                try {
                    await UsedAircraftPresets.save(parsed.usedAircraftScanner)
                    applied.push("usedAircraftScanner")
                } catch (e) {
                    failed.push({ns: "usedAircraftScanner", err: e && e.message ? e.message : String(e)})
                }
            }
            if (applied.length) {
                try {
                    this.settings = await RouteAssistantSettings.load()
                    this._render()
                } catch (e) {
                    console.warn("[AES routeAssistant] post-import reload failed:", e)
                }
            }
            if (failed.length === 0) {
                this._noteToast("Imported " + applied.length + " section"
                    + (applied.length === 1 ? "" : "s")
                    + ", " + visibleCount + " change"
                    + (visibleCount === 1 ? "" : "s"), false)
            } else if (applied.length > 0) {
                this._noteToast("Partial import — applied " + applied.join(", ")
                    + "; failed " + failed.map(f => f.ns).join(", ")
                    + ": " + failed[0].err, true)
            } else {
                this._noteToast("Import failed: " + failed[0].err, true)
            }
        })
        overlay.addEventListener("click", onOverlayClick)
        document.addEventListener("keydown", onKey)

        btnRow.append(cancel, apply)
        const children = [h, meta]
        if (skewBanner) children.push(skewBanner)
        if (changes.length > 0) children.push(toggles)
        children.push(list, btnRow)
        modal.append(...children)
        overlay.append(modal)
        document.body.appendChild(overlay)
    }

    /**
     * Open a small popup menu anchored to the Config button. Two items:
     * Export → triggers _exportConfig; Import → triggers _openImportConfig.
     * Click outside / Escape closes. Modeled after the panel's other
     * lightweight menus rather than a styled <select>.
     */
    _openConfigMenu(anchor) {
        const existing = document.getElementById("aes-config-menu")
        if (existing) { existing.parentNode.removeChild(existing); return }
        const menu = document.createElement("div")
        menu.id = "aes-config-menu"
        menu.style.cssText = "position:absolute;background:#0f1623;border:1px solid #374151;"
            + "border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);z-index:10000;"
            + "padding:4px 0;font:12px/1.4 sans-serif;color:#f3f4f6;min-width:200px;"
        const rect = anchor.getBoundingClientRect()
        menu.style.top  = (rect.bottom + 4) + "px"
        menu.style.left = (rect.right  - 200) + "px"
        const mkItem = (label, fn) => {
            const item = document.createElement("div")
            item.textContent = label
            item.style.cssText = "padding:6px 12px;cursor:pointer;"
            item.addEventListener("mouseenter", () => item.style.background = "#1f2937")
            item.addEventListener("mouseleave", () => item.style.background = "")
            item.addEventListener("click", () => { close(); fn() })
            return item
        }
        const close = () => {
            if (menu.parentNode) menu.parentNode.removeChild(menu)
            document.removeEventListener("click", onDocClick, true)
            document.removeEventListener("keydown", onKey)
        }
        const onDocClick = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close() }
        const onKey = (e) => { if (e.key === "Escape") close() }
        menu.append(
            mkItem("Export config → file", () => this._exportConfig()),
            mkItem("Import config ← file", () => this._openImportConfig())
        )
        document.body.appendChild(menu)
        setTimeout(() => {
            document.addEventListener("click",   onDocClick, true)
            document.addEventListener("keydown", onKey)
        }, 0)
    }

    /**
     * Right-click context menu for table rows. Two items: the legacy
     * override editor (default — preserves muscle memory) and a new
     * "Open in ORS Sandbox" entry that switches to the sandbox mode and
     * pins the row's destination as the simulated route.
     */
    _openRowContextMenu(row, x, y) {
        const existing = document.getElementById("aes-row-context-menu")
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        const menu = document.createElement("div")
        menu.id = "aes-row-context-menu"
        menu.style.cssText = "position:fixed;background:#0f1623;border:1px solid #374151;"
            + "border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);z-index:10000;"
            + "padding:4px 0;font:12px/1.4 sans-serif;color:#f3f4f6;min-width:220px;"
        // Position via fixed coords; clamp to viewport.
        const vw = window.innerWidth, vh = window.innerHeight
        menu.style.top  = Math.min(vh - 80, y) + "px"
        menu.style.left = Math.min(vw - 230, x) + "px"
        const close = () => {
            if (menu.parentNode) menu.parentNode.removeChild(menu)
            document.removeEventListener("click",   onDocClick, true)
            document.removeEventListener("keydown", onKey)
        }
        const mkItem = (label, fn) => {
            const item = document.createElement("div")
            item.textContent = label
            item.style.cssText = "padding:6px 12px;cursor:pointer;"
            item.addEventListener("mouseenter", () => item.style.background = "#1f2937")
            item.addEventListener("mouseleave", () => item.style.background = "")
            item.addEventListener("click", () => { close(); fn() })
            return item
        }
        const onDocClick = (e) => { if (!menu.contains(e.target)) close() }
        const onKey = (e) => { if (e.key === "Escape") close() }
        menu.append(
            mkItem("Modify yield / LF…",        () => this._openOverrideEditor(row)),
            mkItem("Open in ORS Sandbox 🧪",   () => this._openInOrsSandbox(row))
        )
        document.body.appendChild(menu)
        setTimeout(() => {
            document.addEventListener("click",   onDocClick, true)
            document.addEventListener("keydown", onKey)
        }, 0)
    }

    /**
     * Right-click drill-in target — pins the route on the sandbox state
     * and enables sandbox mode in one step. Persists `lastRouteIata` and
     * `enabled = true` so the next mount restores the same view.
     */
    async _openInOrsSandbox(row) {
        if (!row || !row.destIata) return
        this._orsSandboxRoute  = {hub: this.hubIata, dest: row.destIata, _row: row}
        this._orsSandboxResult = null
        const cfg = Object.assign({}, this.settings.orsSandbox || {})
        cfg.enabled = true
        cfg.lastRouteIata = row.destIata
        this.settings.orsSandbox = cfg
        try { await RouteAssistantSettings.save({orsSandbox: cfg}) } catch (e) { /* non-fatal */ }
        this._render()
    }

    /**
     * N2 — Notification center popover. Anchored to the 🔔 button.
     * Reverse-chronological list of every toast fired this session.
     * Each entry carries a click handler that re-fires its action when
     * one was attached (Undo a save from 5 min ago, Retry a failed
     * sync, View a flagged route). History is in-memory only — closing
     * the tab clears it.
     */
    _openNotificationCenter(anchor) {
        const existing = document.getElementById("aes-notification-center")
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing)
            return
        }
        const popover = document.createElement("div")
        popover.id = "aes-notification-center"
        popover.style.cssText = "position:fixed;background:#0f1623;border:1px solid #374151;"
            + "border-radius:5px;box-shadow:0 6px 20px rgba(0,0,0,0.5);z-index:10001;"
            + "padding:0;font:12px/1.4 sans-serif;color:#f3f4f6;min-width:340px;max-width:480px;"
            + "max-height:60vh;display:flex;flex-direction:column;"
        const r = anchor.getBoundingClientRect()
        const vw = window.innerWidth, vh = window.innerHeight
        popover.style.top  = Math.min(vh - 80, r.bottom + 4) + "px"
        // Right-align under the button.
        popover.style.left = Math.max(8, Math.min(vw - 350, r.right - 340)) + "px"

        // ---- Header --------------------------------------------------
        const head = document.createElement("div")
        head.style.cssText = "padding:8px 12px;border-bottom:1px solid #374151;"
            + "display:flex;align-items:center;gap:8px;"
        const title = document.createElement("strong")
        title.textContent = "🔔 Notification center"
        title.style.flex = "1"
        head.append(title)

        const history = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.getHistory()
            : []
        const count = document.createElement("span")
        count.textContent = history.length + (history.length === 1 ? " toast" : " toasts")
        count.style.cssText = "color:#9ca3af;font-size:11px;"
        head.append(count)

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        clearBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;"
        clearBtn.title = "Clear in-session history (does not affect saved data)."
        clearBtn.disabled = !history.length
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", () => {
            if (typeof RouteAssistantToast !== "undefined") RouteAssistantToast.clearHistory()
            close()
        })
        head.append(clearBtn)
        popover.append(head)

        // ---- Body --------------------------------------------------
        const body = document.createElement("div")
        body.style.cssText = "overflow-y:auto;padding:4px 0;flex:1;"
        if (!history.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:20px 12px;color:#6b7280;text-align:center;font-size:11px;"
            empty.textContent = "No toasts yet — confirmations will land here as you work."
            body.append(empty)
        } else {
            // Newest first.
            for (let i = history.length - 1; i >= 0; i--) {
                body.append(this._buildNotificationRow(history[i]))
            }
        }
        popover.append(body)

        // ---- Footer hint ------------------------------------------
        const foot = document.createElement("div")
        foot.style.cssText = "padding:6px 10px;border-top:1px solid #374151;color:#6b7280;font-size:10px;"
        foot.textContent = "Click any entry to re-fire its action (when available). History is in-memory — closing the tab clears it."
        popover.append(foot)

        document.body.appendChild(popover)
        const close = () => {
            if (popover.parentNode) popover.parentNode.removeChild(popover)
            document.removeEventListener("click",   onDocClick, true)
            document.removeEventListener("keydown", onKey)
        }
        const onDocClick = (e) => {
            if (popover.contains(e.target)) return
            if (e.target === anchor || (anchor && anchor.contains && anchor.contains(e.target))) return
            close()
        }
        const onKey = (e) => { if (e.key === "Escape") close() }
        setTimeout(() => {
            document.addEventListener("click",   onDocClick, true)
            document.addEventListener("keydown", onKey)
        }, 0)
    }

    /** Single row in the notification center. */
    _buildNotificationRow(entry) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:8px;padding:6px 12px;align-items:flex-start;"
            + "border-bottom:1px solid rgba(55,65,81,0.5);"
            + (entry.action ? "cursor:pointer;" : "")
        const palette = {
            info:    "#60a5fa", success: "#34d399",
            warn:    "#fbbf24", error:   "#f87171"
        }
        const dot = document.createElement("span")
        dot.textContent = "●"
        dot.style.cssText = "color:" + (palette[entry.type] || palette.info) + ";font-size:8px;margin-top:5px;"
        row.append(dot)

        const main = document.createElement("div")
        main.style.cssText = "flex:1;display:flex;flex-direction:column;gap:1px;"
        const msg = document.createElement("div")
        msg.textContent = entry.message
        msg.style.cssText = "color:#e5e7eb;font-size:12px;line-height:1.35;"
        main.append(msg)
        const meta = document.createElement("div")
        meta.style.cssText = "color:#6b7280;font-size:10px;display:flex;gap:6px;align-items:center;"
        const ago = document.createElement("span")
        ago.textContent = _formatRelativeTime(entry.timestamp)
        meta.append(ago)
        if (entry.action) {
            const actionLabel = document.createElement("span")
            actionLabel.textContent = "↻ " + entry.action.label
            actionLabel.style.color = "#fde68a"
            meta.append(actionLabel)
        }
        main.append(meta)
        row.append(main)

        if (entry.action) {
            row.title = "Click to re-fire: " + entry.action.label
            row.addEventListener("mouseenter", () => row.style.background = "#1f2937")
            row.addEventListener("mouseleave", () => row.style.background = "")
            row.addEventListener("click", () => {
                try { entry.action.fn() }
                catch (e) {
                    if (typeof RouteAssistantToast !== "undefined") {
                        RouteAssistantToast.error("Re-fire failed: " + (e && e.message ? e.message : e))
                    }
                }
                const center = document.getElementById("aes-notification-center")
                if (center && center.parentNode) center.parentNode.removeChild(center)
            })
        }
        return row
    }

    // ---------- Skeleton ----------

    _buildSkeleton() {
        this.root = document.createElement("div")
        this.root.id = "aes-route-assistant"
        // Width is user-resizable via the left-edge drag handle. Persist
        // across sessions in settings.routeAssistant.panelWidth. Default
        // 1100px fits the standard column groups without horizontal
        // scroll; expanders with many controls benefit from more.
        const savedWidth = (this.settings && typeof this.settings.panelWidth === "number"
            && this.settings.panelWidth >= 600 && this.settings.panelWidth <= 3000)
            ? this.settings.panelWidth
            : 1100
        // Belt-and-braces clamp. CSS `max-width: calc(100vw - 32px)` *should*
        // be enough on its own, but in practice users have reported the
        // panel's left edge drifting off-screen when the saved width
        // exceeds the current viewport (e.g., resized on a wide monitor,
        // re-opened on a narrow laptop screen). Compute the effective
        // width in JS and apply it explicitly; a window-resize listener
        // (below) keeps it honest as the viewport changes.
        const clampWidth = (desired) => {
            const max = Math.max(600, window.innerWidth - 32)
            return Math.max(600, Math.min(desired, max))
        }
        const initialWidth = clampWidth(savedWidth)
        Object.assign(this.root.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            width: initialWidth + "px",
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "95vh",
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

        // Re-clamp on viewport change. Saves the user from "drag panel wide
        // on big monitor, switch to small screen, panel left-edge falls
        // off-screen". Also re-renders so `_activeColumns` recomputes the
        // auto-compact gate based on the new viewport.
        const onViewportResize = () => {
            if (!this.root || this._disposed) return
            const desired = (this.settings && typeof this.settings.panelWidth === "number")
                ? this.settings.panelWidth : 1100
            this.root.style.width = clampWidth(desired) + "px"
            // Debounced re-render so the auto-compact column set responds
            // to the new effective width without thrashing on every pixel.
            if (this._viewportResizeTimer) clearTimeout(this._viewportResizeTimer)
            this._viewportResizeTimer = setTimeout(() => {
                this._viewportResizeTimer = null
                if (!this._disposed) this._render()
            }, 200)
        }
        window.addEventListener("resize", onViewportResize)
        this._onViewportResize = onViewportResize
        this._clampPanelWidth = clampWidth

        // Left-edge drag handle for resizing. 6px wide invisible strip on
        // the panel's left side; cursor flips to ew-resize on hover. Mouse-
        // down captures pointer; mousemove updates `right:` (the panel is
        // anchored to the bottom-right) so the right edge stays put while
        // the left edge moves. Persisted to settings on mouseup.
        const resizeHandle = document.createElement("div")
        Object.assign(resizeHandle.style, {
            position:   "absolute",
            top:        "0",
            left:       "0",
            width:      "6px",
            height:     "100%",
            cursor:     "ew-resize",
            zIndex:     "10000",
            background: "transparent"
        })
        resizeHandle.title = "Drag to resize panel width"
        resizeHandle.addEventListener("mousedown", (e) => {
            e.preventDefault()
            const startX = e.clientX
            const startW = this.root.offsetWidth
            const onMove = (ev) => {
                const dx = startX - ev.clientX                          // drag-left = positive = wider
                const next = Math.max(600, Math.min(window.innerWidth - 32, startW + dx))
                this.root.style.width = next + "px"
            }
            const onUp = async () => {
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup",   onUp)
                document.body.style.userSelect = ""
                const finalW = this.root.offsetWidth
                if (this.settings) this.settings.panelWidth = finalW
                try { await RouteAssistantSettings.save({panelWidth: finalW}) }
                catch (err) { /* non-fatal — width is best-effort */ }
            }
            document.body.style.userSelect = "none"
            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup",   onUp)
        })
        this.root.append(resizeHandle)

        // Link styling — scoped to #aes-route-assistant so the hover rules
        // don't leak into AS's own UI. The icon row stays muted until the
        // user hovers a row, then pops to full opacity.
        const linkStyle = document.createElement("style")
        linkStyle.textContent = `
            #aes-route-assistant a.aes-iata { color: #f3f4f6; font-weight: bold; text-decoration: none; }
            #aes-route-assistant a.aes-iata:hover { color: #93c5fd; text-decoration: underline; }
            #aes-route-assistant .aes-iata-icons { font-size: 10px; margin-left: 4px; opacity: 0.5; white-space: nowrap; }
            #aes-route-assistant .aes-iata-icons a { color: #cbd5e1; text-decoration: none; margin-right: 3px; }
            #aes-route-assistant .aes-iata-icons a:hover { color: #93c5fd; }
            #aes-route-assistant tr:hover .aes-iata-icons { opacity: 1; }
            #aes-route-assistant a.aes-link { color: #93c5fd; text-decoration: none; }
            #aes-route-assistant a.aes-link:hover { color: #dbeafe; text-decoration: underline; }
            #aes-route-assistant a.aes-aircraft-link { color: inherit; text-decoration: none; }
            #aes-route-assistant a.aes-aircraft-link:hover { text-decoration: underline; filter: brightness(1.2); }
        `
        this.root.append(linkStyle)

        const header = document.createElement("div")
        Object.assign(header.style, {
            padding: "8px 12px",
            background: "#111827",
            borderBottom: "1px solid #374151",
            display: "flex",
            alignItems: "center",
            gap: "8px"
        })
        const title = document.createElement("strong")
        title.textContent = "Route Assistant"
        title.style.flex = "1"

        const refreshBtn = makeBtn("↻", "Refresh from cache", () => this.refresh())
        // Compact toggle — collapses every settings-driven column group
        // (Live route data, Actuals, Service, Market Analysis, ORS Rank)
        // in one click so the table fits in narrow viewports. Persists
        // via settings.routeAssistant.compactView.
        this._compactBtn = makeBtn("◧", "Compact view (toggle heavy column groups)",
            () => this._toggleCompactView())
        // Wave View toggle (H slice 1) — replaces the table with a
        // Gantt-style timeline of the recommended wave structure for
        // the top-N scored rows. Reuses ScheduleBuilder / SchedulePresets.
        this._waveBtn = makeBtn("📊", "Wave View (toggle Gantt timeline)",
            () => this._toggleWaveView())
        // ORS Sandbox toggle (Letter I slice 1) — replaces the table with
        // a per-route pricing simulator. Mutually exclusive with Wave
        // View; when both flags are on, Wave View wins (its render branch
        // fires first in _renderRows).
        this._orsSandboxBtn = makeBtn("🧪", "ORS Sandbox (toggle pricing simulator)",
            () => this._toggleOrsSandbox())
        // Bulk-open stations from scraped airports — launches the same
        // OpenStationsModal the dashboard's Schedule Management uses, but
        // pre-seeded with the panel's current hub so distances and
        // watchlist-current-hub-only default sensibly.
        const openStationsBtn = makeBtn("🛬", "Open stations at scraped airports",
            () => this._openStationsModal())
        // Compact live status chip next to the 🛬 button — auto-hides when
        // the queue is empty and no run is active. Click → opens the dashboard
        // Station Automation tab in a new browser tab.
        const stationStatusHost = document.createElement("span")
        stationStatusHost.style.cssText = "display:inline-flex;align-items:center;margin-left:2px;"
        this._stationStatusHost = stationStatusHost
        this._ensureStationStatusStrip()
        const settingsBtn = makeBtn("⚙", "Score weights & filters", () => this._toggleSettings())
        // N2 notification center — bell opens a dropdown showing every
        // toast fired this session. Click any past entry to re-execute
        // its action (e.g. Undo a save from 3 minutes ago).
        this._notifBtn = makeBtn("🔔", "Notification center — recent toasts + re-runnable actions",
            (e) => this._openNotificationCenter(e.currentTarget))
        // Config export/import — opens a tiny menu with two items. Persists
        // both routeAssistant + usedAircraftScanner blobs as a single JSON
        // file; import shows a diff modal before committing.
        const configBtn = makeBtn("⇅", "Export / import config (JSON roundtrip)",
            (e) => this._openConfigMenu(e.currentTarget))
        const toggleBtn = makeBtn("_", "Minimise", () => this._toggleCollapse())
        header.append(title, refreshBtn, this._compactBtn, this._waveBtn, this._orsSandboxBtn, openStationsBtn, stationStatusHost, settingsBtn, this._notifBtn, configBtn, toggleBtn)

        this.statusBar = document.createElement("div")
        Object.assign(this.statusBar.style, {
            padding: "6px 12px",
            background: "#111827",
            borderBottom: "1px solid #374151",
            color: "#9ca3af",
            fontSize: "11px",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center"
        })

        // Aircraft picker row — Mode + Aircraft dropdowns. Hidden until at
        // least one fleet aircraft is loaded; the banner stack handles the
        // empty-fleet case.
        this.controlsHost = document.createElement("div")
        Object.assign(this.controlsHost.style, {
            padding: "6px 12px",
            background: "#0f1623",
            borderBottom: "1px solid #374151",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: "11px"
        })

        this.settingsHost = document.createElement("div")
        Object.assign(this.settingsHost.style, {
            padding: "8px 12px",
            background: "#0f1623",
            borderBottom: "1px solid #374151",
            display: "none",
            // Cap at 50vh so the table below always gets meaningful
            // space — the drawer grew with the pricing / yield /
            // carriers / market-analysis expanders and was crowding
            // body to 0 height. Settings scroll internally; user
            // never loses the table.
            maxHeight: "50vh",
            overflowY: "auto",
            flexShrink: "0",
            fontSize: "11px"
        })

        this.body = document.createElement("div")
        Object.assign(this.body.style, {
            padding: "8px 12px",
            overflowY: "auto",
            // Horizontal scroll within the body when the table is wider
            // than the panel — keeps the panel from blowing past its
            // user-resized width and lets the rightmost column groups
            // (Market Analysis, ORS Rank) stay reachable via scroll
            // without forcing the whole panel to overflow the viewport.
            overflowX: "auto",
            flex: "1"
        })

        // Tabbed view selector lives ABOVE tableHost so the bar
        // survives `tableHost.innerHTML = ""` resets (every empty /
        // seed / draw call wipes tableHost — the tabs would flicker
        // if they lived inside it).
        this.tabBar = document.createElement("div")
        this.body.append(this.tabBar)

        // Q1 quick-filter chips — same lifecycle reasoning as tabBar.
        // Hidden when there are zero rows (e.g. the FF-not-scanned banner).
        this.chipBar = document.createElement("div")
        this.body.append(this.chipBar)

        this.tableHost = document.createElement("div")
        this.body.append(this.tableHost)

        this.root.append(header, this.statusBar, this.controlsHost, this.settingsHost, this.body)
        if (this.collapsed) {
            this.statusBar.style.display = "none"
            this.controlsHost.style.display = "none"
            this.body.style.display = "none"
        }
    }

    _toggleCollapse() {
        this.collapsed = !this.collapsed
        this.statusBar.style.display = this.collapsed ? "none" : "flex"
        this.controlsHost.style.display = this.collapsed
            ? "none"
            : (this.controlsHost.dataset.populated === "1" ? "flex" : "none")
        this.body.style.display = this.collapsed ? "none" : "block"
        this.settingsHost.style.display = this.collapsed ? "none"
            : (this.settingsHost.dataset.open === "1" ? "block" : "none")
        RouteAssistantSettings.save({collapsed: this.collapsed})
    }

    _toggleSettings() {
        const open = this.settingsHost.dataset.open !== "1"
        this.settingsHost.dataset.open = open ? "1" : "0"
        this.settingsHost.style.display = open ? "block" : "none"
        // When drawer is open, cap the body so the drawer wins the height
        // contest. Body keeps a small window so the user can still glance at
        // top-scoring routes while tweaking settings.
        this.body.style.maxHeight = open ? "25vh" : ""
        if (open) this._renderSettings()
    }

    _openStationsModal() {
        const airlineCode = (this.ownSchedule && this.ownSchedule.airline) || null
        if (!airlineCode) {
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.show("Airline not loaded yet — try again in a moment.", {type: "warn"})
            }
            return
        }
        const modal = new OpenStationsModal({
            server:      this.server,
            airlineCode: airlineCode,
            currentHub:  this.hubIata || null,
        })
        modal.open()
    }

    /**
     * Idempotent: mounts the compact StationAutomationStatusStrip the first
     * time `ownSchedule.airline` is available. Called from _buildSkeleton
     * (no-op until refresh fills ownSchedule) and from refresh() (mounts when
     * ready). Re-calls are no-ops once the strip is alive.
     */
    _ensureStationStatusStrip() {
        if (this._stationStatusStrip) return
        if (!this._stationStatusHost) return
        if (typeof StationAutomationStatusStrip === "undefined") return
        const airlineCode = (this.ownSchedule && this.ownSchedule.airline) || null
        if (!airlineCode) return
        this._stationStatusStrip = new StationAutomationStatusStrip({
            server:      this.server,
            airlineCode: airlineCode,
            container:   this._stationStatusHost,
            style:       "compact",
        })
        this._stationStatusStrip.mount().catch(err => console.warn("[AES status-strip] mount failed", err))
    }

    /**
     * Toggle Compact view — hides the heavy settings-driven column groups
     * (Live route data, Actuals, Service, Market Analysis, ORS Rank) in
     * one click so the table fits in narrow panels. Per-group toggles in
     * each expander still work; this is just a master switch.
     */
    async _toggleCompactView() {
        const next = !(this.settings && this.settings.compactView)
        if (this.settings) this.settings.compactView = next
        try { await RouteAssistantSettings.save({compactView: next}) }
        catch (e) { /* non-fatal */ }
        if (this._compactBtn) {
            this._compactBtn.style.opacity = next ? "1" : "0.6"
            this._compactBtn.title = next
                ? "Compact view ON — heavy column groups hidden. Click to show all."
                : "Compact view OFF — all column groups visible. Click to hide heavy groups."
        }
        this._render()
    }

    /**
     * H slice 1 — Wave View toggle. When ON, _renderRows() takes the
     * wave-overlay branch which replaces the table with a Gantt timeline
     * built from this.scoredRows (top-N) + the user's selected preset.
     * Persisted to settings.waveView so the mode survives page reloads.
     */
    async _toggleWaveView() {
        const next = !(this.settings && this.settings.waveView)
        if (this.settings) this.settings.waveView = next
        try { await RouteAssistantSettings.save({waveView: next}) }
        catch (e) { /* non-fatal */ }
        if (this._waveBtn) {
            this._waveBtn.style.opacity = next ? "1" : "0.6"
            this._waveBtn.title = next
                ? "Wave View ON — Gantt timeline of the recommended schedule. Click to return to the table."
                : "Wave View OFF — table view. Click to switch to the Gantt wave overlay."
        }
        // Invalidate cached build so toggling re-runs against current rows.
        this._waveBuild = null
        this._render()
    }

    /**
     * Letter I slice 1 — ORS Sandbox toggle. When ON, _renderRows() takes
     * the sandbox branch which replaces the table with a per-route
     * pricing simulator (rank/share/$/wk projections from cached
     * ORS + markets + demand-derivator data).
     * Persisted to settings.orsSandbox.enabled so the mode survives
     * page reloads. Mutually exclusive with Wave View — Wave wins when
     * both are on (Wave's render branch fires first).
     */
    async _toggleOrsSandbox() {
        const cfg = (this.settings && this.settings.orsSandbox) || {}
        const next = !cfg.enabled
        if (this.settings) this.settings.orsSandbox = Object.assign({}, cfg, {enabled: next})
        try { await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox}) }
        catch (e) { /* non-fatal */ }
        if (this._orsSandboxBtn) {
            this._orsSandboxBtn.style.opacity = next ? "1" : "0.6"
            this._orsSandboxBtn.title = next
                ? "ORS Sandbox ON — per-route pricing simulator. Click to return to the table."
                : "ORS Sandbox OFF — table view. Click to switch to the pricing simulator."
        }
        // Invalidate cached projection so toggling re-runs against current cache.
        this._orsSandboxResult = null
        this._render()
    }

    // ---------- Data refresh ----------

    /**
     * Reload everything from cache (no AS / flightsfrom hits) and re-render.
     * Used on mount, after settings changes, and after a scan completes.
     */
    async refresh() {
        const iata = this.resolveOriginIata ? this.resolveOriginIata() : null
        if (!iata) {
            this.hubIata = null
            this._renderEmpty("Couldn't detect the origin airport on this page. Set the origin in the scheduler and click ↻.")
            return
        }
        this.hubIata = iata
        this._trackRecentHub(iata)

        // Diff-against-last-visit — load the previous snapshot ONCE per
        // (mount, hub) pair. Subsequent in-mount refreshes (storage events,
        // settings changes) keep the same baseline so the delta badges
        // stay anchored to "what the user saw last time they opened this
        // hub" rather than re-baselining mid-session. Hub change re-loads.
        if (!this._diffBaselineLoaded || this._diffBaselineHub !== iata) {
            this._diffPrevSnapshot = await _loadDiffSnapshot(iata)
            this._diffBaselineLoaded = true
            this._diffBaselineHub = iata
        }

        // Watchlist — global Set across all hubs. Loaded fresh every
        // refresh so cross-tab toggles eventually surface (no chrome.storage
        // listener wired for this key in v1; refresh is enough).
        this._watchlist = await RouteAssistantWatchlistStore.loadKeys()

        this.ffData = await FlightsFromStore.loadAirport(iata)
        this.ownSchedule = await this._loadOwnSchedule()
        this.fuelPrice = await RouteAssistantFuelPriceScraper.getCached()
        if (RouteAssistantFuelPriceScraper.isStale(this.fuelPrice)) this._scrapeFuelPriceAsync()

        // Pin fleet to the schedule's airline when available — multi-airline
        // accounts otherwise pick by largest fleet, which is usually right but
        // worth marking ambiguous.
        const airlineCode = this.ownSchedule && this.ownSchedule.airline || null
        this.fleet = await RouteAssistantFleetStore.loadFleet(this.server, airlineCode)
        this._ensureStationStatusStrip()
        await this._loadCachedTypeSpecs()
        const fleetTypeIds = RouteAssistantFleetStore.typeIdsIn(this.fleet)
        this.fuelBurnOverrides = await RouteAssistantFuelBurn.getOverrides(fleetTypeIds)
        this._resolveSelection()

        const dests = this.ffData && this.ffData.routes
            ? this.ffData.routes.map(r => String(r.destIata || "").toUpperCase()).filter(Boolean)
            : []
        this.demandMap = await RouteAssistantDemandStore.getMany(dests)
        this.overrideMap = await RouteAssistantRouteOverridesStore.getMany(
            dests.map(d => [iata, d])
        )
        this.yieldHistoryMap = await RouteAssistantYieldHistoryStore.getMany(
            dests.map(d => [iata, d])
        )
        this.serviceConfigMap = (typeof RouteAssistantServiceConfigStore !== "undefined")
            ? await RouteAssistantServiceConfigStore.getMany(dests.map(d => [iata, d]))
            : new Map()
        this.routeNoteMap = (typeof RouteAssistantRouteNoteStore !== "undefined")
            ? await RouteAssistantRouteNoteStore.getMany(dests.map(d => [iata, d]))
            : new Map()
        // Active prompts — load alert rules + reset the per-mount fired
        // set so the same rule+route can re-fire on the next mount (the
        // store-level cooldown handles short-window suppression).
        await this._loadAlertRules()
        this._alertFiredThisMount = new Set()
        // Service-profile cache (auto-detected from /action/enterprise/*)
        if (typeof RouteAssistantServiceProfileScraper !== "undefined") {
            this.serviceProfilesCache = await RouteAssistantServiceProfileScraper.loadAllDetails()
            this._serviceProfilesList = await RouteAssistantServiceProfileScraper.loadList()
        }

        this.rows = RouteAssistantAggregator.buildRouteRows({
            hubIata:          iata,
            ffData:           this.ffData,
            demandMap:        this.demandMap,
            overrideMap:      this.overrideMap,
            yieldHistoryMap:  this.yieldHistoryMap,
            serviceConfigMap: this.serviceConfigMap,
            routeNoteMap:     this.routeNoteMap,
            serviceProfiles:  (this.settings && this.settings.serviceProfiles) || null,
            fleet:            this.fleet,
            ownSchedule:      this.ownSchedule
        })

        // Paint instantly with any distances we already have cached, then
        // kick off lazy enrichment in the background for missing pairs.
        // Fleet context is applied AFTER distances so fit/profit see the
        // populated distance values rather than null.
        await this._applyCachedDistances()
        await this._applyCachedPrices()
        await this._applyCachedCarriers()
        await this._applyCachedMarkets()
        await this._applyCachedEnterpriseMeta()
        await this._applyCachedContractualPartners()
        await this._applyCachedOrs()
        await this._applyCachedDemand()
        RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
        this._render()
        this._enrichDistancesAsync()
        this._enrichTypeSpecsAsync()
        this._maybeAutoRefreshMarketsAndDemand()
    }

    /**
     * Returns the service-projection context for `applyFleetContext` so the
     * aggregator can refresh class breakdowns whenever fleet/economics
     * change. Includes the per-route map and the global defaults.
     */
    _serviceContext() {
        return {
            serviceProfiles:  (this.settings && this.settings.serviceProfiles) || null,
            serviceConfigMap: this.serviceConfigMap || null,
            fleet:            this.fleet || null,
            hubIata:          this.hubIata || null
        }
    }

    /**
     * Returns the fleet context to feed into the aggregator, or null when no
     * aircraft is selected (Phase 1 view — fit/profit columns hidden).
     */
    _fleetContext() {
        const a = this.settings && this.settings.aircraft
        if (!a || !a.mode) return null
        const common = this._fuelContextFields()
        // Letter K — pull the demand-depth opt-in toggle into the
        // context so the aggregator can hand it to the estimator
        // alongside the per-row demand pool.
        const dd = (this.settings && this.settings.demandDepth) || {}
        const useRealDemandForLF = !!dd.useRealDemandForLF
        if (a.mode === "fleet") {
            if (!this.fleetSpecs || !this.fleetSpecs.length) return null
            return Object.assign({
                selectedSpec: null,
                fleetSpecs:   this.fleetSpecs,
                falloffPct:   a.falloffPct,
                economics:    this._economicsForEstimator(),
                useRealDemandForLF: useRealDemandForLF
            }, common)
        }
        if (!this.selectedSpec) return null
        return Object.assign({
            selectedSpec: this.selectedSpec,
            fleetSpecs:   null,
            falloffPct:   a.falloffPct,
            economics:    this._economicsForEstimator(),
            useRealDemandForLF: useRealDemandForLF
        }, common)
    }

    /**
     * The fuel-related fields the estimator needs in order to switch from
     * the legacy AS$/h × blockHours model to the AS-accurate (cycle_L +
     * per_km_L × dist) × priceASc / 100 model.
     *
     * Per-type fuel kicks in only when:
     *   - economics.fuelPriceAutoEnabled (toggle in Cache section)
     *   - we have a current scraped price in ASc$/l (the table format —
     *     the SVG fallback's chart-scale "index" can't drive cost).
     * Otherwise the estimator falls back to fuelCostPerHour × blockHours.
     */
    /**
     * Cruise-asymptotic fuel rate (AS$/h) for the currently picked aircraft.
     * Used to display a meaningful AS$/h in the Fuel field when per-type
     * fuel is on. Distance-dependent in reality (cycle dilutes on long
     * flights) — we report the cruise rate (per_km × speed × price) which
     * is the limiting value for long-haul and a reasonable single-number
     * summary.
     *
     * In Fleet mode (no single selectedSpec), returns the seat-weighted
     * average across the fleet. Returns null if nothing usable.
     */
    _computeCruiseFuelRate(fuelPriceASc) {
        const overrides = this.fuelBurnOverrides
        const rateForSpec = (spec) => {
            if (!spec) return null
            const burn = RouteAssistantFuelBurn.estimate(spec, overrides)
            const speed = Number(spec.speed) || 0
            if (!burn || !speed) return null
            return {rate: burn.perKmL * speed * fuelPriceASc / 100, perKmL: burn.perKmL, speed: speed}
        }
        if (this.selectedSpec) {
            const r = rateForSpec(this.selectedSpec)
            if (r) {
                r.label = this.selectedSpec.typeName || ("type " + this.selectedSpec.typeId)
                return r
            }
        }
        if (this.fleetSpecs && this.fleetSpecs.length) {
            // Seat-weighted average — bigger aircraft contribute more to the
            // "typical" cruise rate. Falls back to plain mean if no seats.
            let weightSum = 0, rateAcc = 0, perKmAcc = 0, speedAcc = 0, count = 0
            for (const s of this.fleetSpecs) {
                const r = rateForSpec(s)
                if (!r) continue
                const w = Math.max(1, Number(s.seats) || 1)
                weightSum += w
                rateAcc   += r.rate * w
                perKmAcc  += r.perKmL * w
                speedAcc  += r.speed * w
                count++
            }
            if (count > 0 && weightSum > 0) {
                return {
                    rate:   rateAcc   / weightSum,
                    perKmL: perKmAcc  / weightSum,
                    speed:  Math.round(speedAcc / weightSum),
                    label:  "fleet avg of " + count
                }
            }
        }
        return null
    }

    _fuelContextFields() {
        const econ = (this.settings && this.settings.economics) || {}
        const fp = this.fuelPrice
        const usable = econ.fuelPriceAutoEnabled
            && fp && fp.unit === "ASc$/l" && typeof fp.value === "number" && fp.value > 0
        return {
            useDistanceFuel:   !!usable,
            fuelPriceASc:      usable ? fp.value : null,
            fuelBurnOverrides: this.fuelBurnOverrides
        }
    }

    /**
     * Pass-through. Per-type fuel cost (cycle_L + per_km_L × dist) × ASc/l
     * lives in the estimator now and is gated by `useDistanceFuel`. The
     * legacy Phase-2 baseline-ratio scaling is no longer applied — see
     * `_fuelContextFields` for the gate. The flat `fuelCostPerHour` is used
     * only as a fallback when per-type fuel isn't available (spec missing).
     */
    _economicsForEstimator() {
        return (this.settings && this.settings.economics) || {}
    }

    /**
     * Bulk-load every cached type spec for typeIds present in the fleet, plus
     * the explicitly-selected typeId (if it's somehow not in the fleet — e.g.
     * the user sold the last one of a type). Populates this.typeSpecs.
     */
    async _loadCachedTypeSpecs() {
        const ids = new Set(RouteAssistantFleetStore.typeIdsIn(this.fleet))
        const a   = this.settings && this.settings.aircraft
        if (a && a.mode === "type" && a.typeId) ids.add(a.typeId)
        if (!ids.size) {
            this.typeSpecs = new Map()
            return
        }
        this.typeSpecs = await RouteAssistantTypeSpecsStore.getMany(Array.from(ids))
    }

    /**
     * Compute the chosen aircraft spec(s) for the current settings.aircraft
     * selection. Reads from this.typeSpecs (cache) — newly-fetched specs from
     * _enrichTypeSpecsAsync trigger a re-render which calls this again.
     */
    _resolveSelection() {
        this.selectedSpec = null
        this.fleetSpecs = null
        const a = this.settings && this.settings.aircraft
        if (!a || !a.mode || !this.fleet) return

        const lookup = (typeId, typeName, aircraftAge) => {
            const cached = this.typeSpecs.get(typeId)
            if (!cached) return null
            // aircraftAge: per-tail age in registration mode; avg-of-type
            // otherwise. Profit estimator scales fuel by age × penalty.
            return Object.assign({typeId: typeId, typeName: typeName || cached.typeName, aircraftAge: aircraftAge}, cached)
        }

        if (a.mode === "fleet") {
            const specs = []
            for (const slot of RouteAssistantFleetStore.activeTypeSlots(this.fleet)) {
                const s = lookup(slot.typeId, slot.typeName, slot.avgAge)
                if (s) specs.push(s)
            }
            this.fleetSpecs = specs
        } else if (a.mode === "type" && a.typeId) {
            const slot = RouteAssistantFleetStore.slotForTypeId(this.fleet, a.typeId)
            this.selectedSpec = lookup(a.typeId, slot ? slot.typeName : null, slot ? slot.avgAge : null)
        } else if (a.mode === "registration" && a.registration) {
            const ac = RouteAssistantFleetStore.findByRegistration(this.fleet, a.registration)
            if (ac && ac.typeId) {
                const tailAge = (typeof ac.age === "number" && isFinite(ac.age)) ? ac.age : null
                this.selectedSpec = lookup(ac.typeId, ac.equipment, tailAge)
            }
        }
    }

    /**
     * Bulk-load distance cache for every (hub, dest) pair in this.rows and
     * apply to row.distanceKm. Synchronous from the user's perspective —
     * one chrome.storage.local read for all pairs.
     */
    async _applyCachedDistances() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const pairs = this.rows.map(r => [this.hubIata, r.destIata])
        const maxAgeDays = this.settings && this.settings.distanceMaxAgeDays
        const cache = await RouteAssistantDistanceResolver.bulkLoadCache(pairs, {maxAgeDays: maxAgeDays})
        for (const r of this.rows) {
            if (r.distanceKm !== null && r.distanceKm !== undefined) continue
            const key = RouteAssistantDistanceResolver._pairKey(this.hubIata, r.destIata)
            const c = cache.get(key)
            if (c) r.distanceKm = c.distanceKm
        }
    }

    /**
     * Bulk-load the per-route cache and project both the live-data fields
     * (aircraft / departure / freq pattern / cruise speed) and the Tier 2
     * placeholders (ourPrice/ourYield/orsRank — currently always null) onto
     * each row.
     */
    async _applyCachedPrices() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cfg = (this.settings && this.settings.pricing) || {}
        const maxAgeDays = cfg.priceMaxAgeDays
        const cache = await RouteAssistantTicketPriceScraper.bulkLoadCache(pairs, {maxAgeDays: maxAgeDays})
        for (const r of this.rows) {
            const key = RouteAssistantTicketPriceScraper._pairKey(this.hubIata, r.destIata)
            const rec = cache.get(key)
            if (!rec) continue
            // Tier 2 placeholders — wired up so columns stay reactive once
            // the price/ORS scrapers land in a follow-up.
            r.ourPrice       = rec.ourPrice
            r.ourYield       = rec.ourYield
            r.orsRank        = rec.orsRank
            r.priceScrapedAt = rec.scrapedAt
            // Live route data scraped from /app/com/scheduling/<HUB><DEST>.
            r.liveAircraftType   = rec.primaryAircraftType
            r.liveAircraftTypeId = rec.primaryAircraftTypeId
            r.liveAircraftReg    = rec.primaryAircraftReg
            r.liveDeparture      = rec.departureTime
            r.liveDaysPerWeek    = rec.daysPerWeek
            r.liveCruiseSpeed    = rec.cruiseSpeedKmh
            r.liveScrapedAt      = rec.scrapedAt
            // Cross-reference primary registration against the cached fleet
            // so the Eq cell can deep-link to /app/fleets/aircraft/<id>/1
            // (the page that writes the aircraftFlights record consumed by
            // the yield-feedback snapshot). Falls back to null silently
            // when the fleet hasn't been refreshed since the tail was added.
            if (rec.primaryAircraftReg && this.fleet) {
                const fleetRec = RouteAssistantFleetStore.findByRegistration(
                    this.fleet, rec.primaryAircraftReg
                )
                r.liveAircraftId = fleetRec && fleetRec.aircraftId || null
            } else {
                r.liveAircraftId = null
            }

            // Per-day flight counts. Prefer the new shape; synthesize from
            // the legacy `frequencyPattern` (days-flown digits) for records
            // written before the parser learned about multi-daily. Lossy
            // when the legacy route was multi-daily — user can re-Sync to
            // get the precise per-day breakdown.
            if (Array.isArray(rec.dailyFlights) && rec.dailyFlights.length === 7) {
                r.liveDailyFlights  = rec.dailyFlights
                r.liveWeeklyFlights = (rec.weeklyFlights != null)
                    ? rec.weeklyFlights
                    : rec.dailyFlights.reduce((s, n) => s + n, 0)
            } else if (typeof rec.frequencyPattern === "string" && rec.frequencyPattern.length >= 7) {
                const synth = [0, 0, 0, 0, 0, 0, 0]
                for (let i = 0; i < 7; i++) {
                    const ch = rec.frequencyPattern.charAt(i)
                    if (ch >= "1" && ch <= "7") synth[i] = 1
                }
                r.liveDailyFlights  = synth
                r.liveWeeklyFlights = synth.reduce((s, n) => s + n, 0)
            } else if (rec.daysPerWeek > 0) {
                // Last-ditch: only the count survived. Show the count with a
                // null pattern so the cell renders something rather than "—".
                r.liveDailyFlights  = null
                r.liveWeeklyFlights = rec.daysPerWeek
            }
        }
    }

    /**
     * Letter F — load any cached per-route carrier records and decorate
     * rows with `carriers`, `carriersScrapedAt`, and the derived
     * `competitiveIntensity`. Mirrors `_applyCachedPrices`. Cells fall
     * back to the existing `airlineCount` integer when no record exists.
     */
    async _applyCachedCarriers() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const cfg = (this.settings && this.settings.carriers) || {}
        const maxAgeDays = cfg.carriersMaxAgeDays
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cache = await RouteAssistantCarriersScraper.bulkLoadCache(pairs, {maxAgeDays: maxAgeDays})
        for (const r of this.rows) {
            const key = RouteAssistantCarriersScraper._pairKey(this.hubIata, r.destIata)
            const rec = cache.get(key)
            if (!rec) continue
            r.carriers           = Array.isArray(rec.carriers) ? rec.carriers : []
            r.carriersScrapedAt  = rec.scrapedAt
            r.carriersParserNote = rec.parserNotes || null
            r.totalCarrierFlights = rec.totalWeeklyFlights || null
            // Intensity uses the cached `totalAirlines` when present (more
            // accurate, since the listing-page airlineCount can be stale)
            // and falls back to the row's existing flightsfrom count.
            const intensitySource = (typeof rec.totalAirlines === "number" && rec.totalAirlines > 0)
                ? rec.totalAirlines
                : r.airlineCount
            r.competitiveIntensity = RouteAssistantCarriersScraper.intensity(intensitySource)
        }
    }

    /**
     * F slice 2 — load any cached AS enterprise metadata (banner +
     * avatar URLs, name, IATA code) and decorate every market-share
     * entry on every row. Runs after `_applyCachedMarkets` so the
     * enterpriseIds are already on the rows.
     *
     * Decoration is in-place on `r.marketSharePax[i]` /
     * `marketShareCargo[i]` so the popover renderer doesn't need to
     * cross-reference a separate map at draw time. When metadata is
     * missing for an enterprise the entry stays untouched and the
     * popover falls back to plain-text rendering for that row.
     */
    async _applyCachedEnterpriseMeta() {
        if (!this.rows || !this.rows.length) return
        const cfg = (this.settings && this.settings.carriers) || {}
        const ids = new Set()
        for (const r of this.rows) {
            for (const list of [r.marketSharePax, r.marketShareCargo]) {
                if (!Array.isArray(list)) continue
                for (const e of list) {
                    if (e && e.enterpriseId != null) ids.add(String(e.enterpriseId))
                }
            }
        }
        if (!ids.size) return
        const cache = await RouteAssistantEnterpriseMetaScraper.bulkLoadCache(
            Array.from(ids), {maxAgeDays: cfg.enterpriseMetaMaxAgeDays}
        )
        if (!cache.size) return
        // Decorate every market-share entry that has a matching cache hit.
        for (const r of this.rows) {
            for (const list of [r.marketSharePax, r.marketShareCargo, r.competitorEntries]) {
                if (!Array.isArray(list)) continue
                for (const e of list) {
                    if (!e || e.enterpriseId == null) continue
                    const meta = cache.get(String(e.enterpriseId))
                    if (!meta) continue
                    e.bannerUrl = meta.bannerUrl || null
                    e.avatarUrl = meta.avatarUrl || null
                    e.iata      = meta.iata || null
                    if (!e.name && meta.name) e.name = meta.name
                }
            }
        }
    }

    /**
     * F slice 3 — load the user's own enterprise(s) contractual partners
     * from cache and union the per-id partner lists into a single
     * `_partnersByEnterpriseId` map. The Cmp popover row builder reads
     * this at render time to surface a ⇄ glyph next to interlining
     * partners (and optionally a ✦ for alliance partners).
     *
     * Multiple own enterprises (canopy users) contribute their partner
     * lists into the same map: if ANY of your enterprises has IL with
     * X, X gets the glyph. Conflicting relations on the same partner
     * across own enterprises are unioned (worst case both labels win).
     */
    async _applyCachedContractualPartners() {
        const cfg = (this.settings && this.settings.carriers) || {}
        const ids = (cfg.myEnterpriseIds || []).map(v => String(v).trim()).filter(Boolean)
        this._partnersByEnterpriseId = new Map()
        if (!ids.length) return
        const cache = await RouteAssistantContractualPartnersScraper.bulkLoadCache(
            ids, {maxAgeDays: cfg.partnersMaxAgeDays}
        )
        if (!cache.size) return
        for (const rec of cache.values()) {
            if (!rec || !Array.isArray(rec.partners)) continue
            for (const p of rec.partners) {
                if (!p || !p.partnerId) continue
                const key = String(p.partnerId)
                const existing = this._partnersByEnterpriseId.get(key) || []
                for (const r of (p.relations || [])) {
                    if (existing.indexOf(r) === -1) existing.push(r)
                }
                this._partnersByEnterpriseId.set(key, existing)
            }
        }
    }

    /**
     * Background distance enrichment: for any row still missing distanceKm,
     * fire the three-tier resolver in parallel batches. Re-renders the
     * table after each batch so the km column fills in incrementally.
     * Idempotent — safe to call multiple times; resolved pairs short-circuit
     * via the resolver's session + persistent cache.
     */
    async _enrichDistancesAsync() {
        if (!this.hubIata || this._enrichingDistances || this._disposed) return
        const missing = (this.rows || []).filter(r =>
            r.destIata && (r.distanceKm === null || r.distanceKm === undefined)
        )
        if (!missing.length) {
            this.distanceProgress = null
            return
        }
        const maxAgeDays = this.settings && this.settings.distanceMaxAgeDays
        if (!this.distanceResolver) {
            this.distanceResolver = new RouteAssistantDistanceResolver(this.server, {maxAgeDays: maxAgeDays})
        } else {
            // Pick up any settings change made since the resolver was created;
            // the persistent cache filter must reflect the user's current choice.
            this.distanceResolver.maxAgeDays = RouteAssistantDistanceResolver._normaliseMaxAge(maxAgeDays)
        }

        this._enrichingDistances = true
        this.distanceProgress = {total: missing.length, done: 0}
        this._renderStatusBar()

        const concurrency = 4
        const staggerMs   = 800
        try {
            for (let i = 0; i < missing.length; i += concurrency) {
                if (this._disposed) return
                const batch = missing.slice(i, i + concurrency)
                await Promise.all(batch.map(async row => {
                    try {
                        const result = await this.distanceResolver.resolve(this.hubIata, row.destIata)
                        if (result && typeof result.distanceKm === "number") row.distanceKm = result.distanceKm
                    } catch (e) { /* graceful */ }
                    this.distanceProgress.done++
                }))
                if (this._disposed) return
                // Distances changed → fit/profit need to be recomputed.
                RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
                this._renderRows()  // table only — preserves any open picker dropdown
                if (i + concurrency < missing.length) await sleep(staggerMs)
            }
        } finally {
            this._enrichingDistances = false
            this.distanceProgress = null
            if (!this._disposed) this._renderStatusBar()
        }
    }

    /**
     * Background type-spec enrichment: any typeId present in the fleet but
     * missing from this.typeSpecs gets fetched via the shared
     * AESAircraftTypeSpecs.fetchById and persisted into the
     * RouteAssistantTypeSpecsStore. Mirrors _enrichDistancesAsync — same
     * 4 parallel × 800 ms stagger, re-render after each batch.
     *
     * Idempotent: a fleet aircraft whose typeId hasn't been backfilled yet
     * (older fleet record) is skipped. The "visit /app/fleets to refresh"
     * banner is what asks the user to backfill those.
     */
    async _enrichTypeSpecsAsync() {
        if (!this.fleet || this._enrichingTypeSpecs || this._disposed) return
        const need = []
        for (const id of RouteAssistantFleetStore.typeIdsIn(this.fleet)) {
            if (!this.typeSpecs.has(id)) need.push(id)
        }
        // Also enrich an explicitly-selected typeId in case the user sold all
        // of a type but kept the selection.
        const a = this.settings && this.settings.aircraft
        if (a && a.mode === "type" && a.typeId && !this.typeSpecs.has(a.typeId) && !need.includes(a.typeId)) {
            need.push(a.typeId)
        }
        if (!need.length) {
            this.typeSpecsProgress = null
            return
        }

        this._enrichingTypeSpecs = true
        this.typeSpecsProgress = {total: need.length, done: 0}
        this._renderStatusBar()

        const concurrency = 4
        const staggerMs   = 800
        try {
            for (let i = 0; i < need.length; i += concurrency) {
                if (this._disposed) return
                const batch = need.slice(i, i + concurrency)
                await Promise.all(batch.map(async typeId => {
                    try {
                        const specs = await AESAircraftTypeSpecs.fetchById(typeId)
                        if (specs) {
                            const typeName = this._typeNameFor(typeId)
                            const record = Object.assign({typeId: typeId, typeName: typeName}, specs)
                            const saved = await RouteAssistantTypeSpecsStore.save(record)
                            if (saved) this.typeSpecs.set(typeId, record)
                        }
                    } catch (e) { /* graceful */ }
                    this.typeSpecsProgress.done++
                }))
                if (this._disposed) return
                // A newly-fetched spec may flip the picked aircraft from
                // "no spec yet" to a real spec, so re-resolve and re-apply.
                this._resolveSelection()
                RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
                this._renderRows()
                if (i + concurrency < need.length) await sleep(staggerMs)
            }
        } finally {
            this._enrichingTypeSpecs = false
            this.typeSpecsProgress = null
            if (!this._disposed) this._renderStatusBar()
        }
    }

    /**
     * Background fuel-price scrape. Idempotent — flag prevents two scrapes
     * racing. On success, re-renders the settings drawer (if open) so the
     * "AS fuel index" line picks up the new value without a manual refresh.
     */
    async _scrapeFuelPriceAsync() {
        if (this._fuelScrapeInFlight || this._disposed) return
        this._fuelScrapeInFlight = true
        try {
            const scraper = new RouteAssistantFuelPriceScraper(this.server)
            const rec = await scraper.scrape()
            if (rec) this.fuelPrice = rec
        } catch (e) { /* graceful */ }
        finally {
            this._fuelScrapeInFlight = false
            if (!this._disposed && this.settingsHost && this.settingsHost.dataset.open === "1") {
                this._renderSettings()
            }
        }
    }

    /**
     * Best-effort type-name lookup for a typeId — first the fleet, then the
     * cache. Used as the saved record's `typeName` so the picker can render
     * a friendly label without re-fetching.
     */
    _typeNameFor(typeId) {
        const slot = RouteAssistantFleetStore.slotForTypeId(this.fleet, typeId)
        if (slot && slot.typeName) return slot.typeName
        const cached = this.typeSpecs.get(typeId)
        return (cached && cached.typeName) || null
    }

    /**
     * Storage-key probe: the schedule extractor (content_fligthSchedule.js)
     * writes to "<server><airlineCode>schedule". We don't know the airline
     * code from the scheduling page directly, so scan all keys with that
     * shape and pick whichever one's most recent latest-date entry contains
     * any flight from the current hub. That pins us to the right airline
     * even on a multi-airline account.
     */
    async _loadOwnSchedule() {
        const all = await chrome.storage.local.get(null)
        const candidates = []
        const prefix = this.server
        for (const key in all) {
            if (key.indexOf(prefix) !== 0) continue
            if (key.lastIndexOf("schedule") !== key.length - "schedule".length) continue
            const rec = all[key]
            if (!rec || rec.type !== "schedule" || !rec.date) continue
            candidates.push(rec)
        }
        if (!candidates.length) return null

        // Prefer one that has a flight from this hub in its latest date.
        const hub = this.hubIata
        for (const rec of candidates) {
            const dates = Object.keys(rec.date).sort()
            const latest = rec.date[dates[dates.length - 1]]
            if (latest && Array.isArray(latest.schedule)
                && latest.schedule.some(r => String(r.origin || "").toUpperCase() === hub)) {
                return rec
            }
        }
        // Fallback: just return the first one.
        return candidates[0]
    }

    // ---------- Status bar + actions ----------

    /**
     * Render the Pax / Cargo / All tab bar above the table. Persists
     * the chosen tab to settings on click + re-renders so column
     * visibility + score blend update in lockstep.
     *
     * The "All" tab keeps the existing combined score/columns. Pax
     * filters out cargoScore from the blend (and hides the Crg cell);
     * Cargo flips it. The underlying row data is the same on every tab
     * — only display + scoring change.
     */
    _renderTabBar() {
        if (!this.tabBar) return
        this.tabBar.innerHTML = ""
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;gap:0;margin:4px 0 8px 0;border-bottom:1px solid #374151;"
        const current = this._currentViewMode()
        const TABS = [
            {id: "all",   label: "All",   tip: "Combined score across pax + cargo signals (current default)"},
            {id: "pax",   label: "Pax",   tip: "Focus on passenger metrics — cargoScore drops from the blend, Crg cell hides"},
            {id: "cargo", label: "Cargo", tip: "Focus on cargo metrics — paxScore drops from the blend, Pax cell hides"}
        ]
        for (const t of TABS) {
            const btn = document.createElement("button")
            btn.textContent = t.label
            btn.title = t.tip
            const active = current === t.id
            Object.assign(btn.style, {
                background:    active ? "#1f2937" : "transparent",
                color:         active ? "#f3f4f6" : "#9ca3af",
                border:        "0",
                borderBottom:  active ? "2px solid #60a5fa" : "2px solid transparent",
                padding:       "6px 12px",
                cursor:        "pointer",
                fontSize:      "11px",
                fontWeight:    active ? "600" : "400",
                marginBottom:  "-1px"
            })
            btn.addEventListener("click", async () => {
                if (this._currentViewMode() === t.id) return
                this.settings.viewMode = t.id
                try {
                    await RouteAssistantSettings.save({viewMode: t.id})
                } catch (e) { /* persist failure is non-fatal — re-render anyway */ }
                this._renderRows()
                if (this.settingsHost && this.settingsHost.dataset.open === "1") {
                    this._renderSettings()
                }
            })
            wrap.append(btn)
        }
        this.tabBar.append(wrap)
    }

    /**
     * Q1 quick-filter chips — fast-path UI for the most common filters.
     * Each chip toggles a single setting under settings.filters and re-renders.
     * Status chips mirror settings.filters.statuses[<key>] (the chip is "ON"
     * when the status is being SHOWN). The remaining chips toggle dedicated
     * filter flags (watchlistOnly, lossMakers, hasOverride, hasNote) and the
     * "Δ Changed" innovation toggle (onlyChanged).
     *
     * Hides when there are no rows yet — a chip strip without a table looks
     * disembodied during the first-mount scan. Also hides when collapsed.
     */
    _renderChipBar() {
        if (!this.chipBar) return
        this.chipBar.innerHTML = ""
        if (this.collapsed) return
        if (!this.rows || !this.rows.length) return
        const f = (this.settings && this.settings.filters) || {}
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;margin:0 0 6px 0;"
            + "align-items:center;font-size:11px;"

        // Build one chip. `state.label` shows on the chip; `state.active`
        // controls highlight; `state.toggle` is the click handler that
        // mutates settings + saves + re-renders. `state.tip` becomes the
        // hover tooltip.
        const mkChip = (state) => {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = state.label
            btn.title = state.tip || state.label
            btn.style.cssText = "padding:3px 9px;border-radius:11px;font-size:11px;cursor:pointer;"
                + "transition:background 120ms ease, color 120ms ease;"
                + "border:1px solid " + (state.active ? (state.tint || "#60a5fa") : "#374151") + ";"
                + "background:"        + (state.active ? (state.tint || "#1d4ed8") : "transparent") + ";"
                + "color:"             + (state.active ? "#f8fafc" : "#9ca3af") + ";"
                + "font-weight:"       + (state.active ? "600" : "400") + ";"
            btn.addEventListener("click", state.toggle)
            return btn
        }

        // ★ Watchlist
        wrap.append(mkChip({
            label: "★ Watchlist",
            tip:   "Show only starred routes",
            active: !!f.watchlistOnly,
            tint:  "#92400e",
            toggle: () => this._toggleQuickFilter("watchlistOnly")
        }))

        // Status chips. Active when the status is INCLUDED (filter shows it).
        const statuses = f.statuses || {}
        const STATUS_CHIPS = [
            ["NEW",   "#1e40af", "Show NEW (untouched candidates)"],
            ["OK",    "#166534", "Show OK (frequency in line with demand)"],
            ["UNDER", "#92400e", "Show UNDER (room to scale up)"],
            ["OVER",  "#7c2d12", "Show OVER (possibly over-deployed)"],
            ["OOR",   "#7f1d1d", "Show OOR (out of selected aircraft's range)"]
        ]
        for (const [key, tint, tip] of STATUS_CHIPS) {
            wrap.append(mkChip({
                label: key,
                tip:   tip,
                active: statuses[key] !== false,
                tint:  tint,
                toggle: () => this._toggleStatusChip(key)
            }))
        }

        // Spacer between status group and content-based filters.
        const sep = document.createElement("span")
        sep.style.cssText = "color:#374151;margin:0 2px;"
        sep.textContent = "·"
        wrap.append(sep)

        wrap.append(mkChip({
            label: "$ Loss-makers",
            tip:   "Show only routes with profitPerWeek < 0 (negative cash). Requires an aircraft picked.",
            active: !!f.lossMakers,
            tint:  "#7f1d1d",
            toggle: () => this._toggleQuickFilter("lossMakers")
        }))
        wrap.append(mkChip({
            label: "📌 Override",
            tip:   "Show only routes with a saved LF / yield override",
            active: !!f.hasOverride,
            tint:  "#6d28d9",
            toggle: () => this._toggleQuickFilter("hasOverride")
        }))
        wrap.append(mkChip({
            label: "📝 Note",
            tip:   "Show only routes with a saved free-text note",
            active: !!f.hasNote,
            tint:  "#0e7490",
            toggle: () => this._toggleQuickFilter("hasNote")
        }))
        wrap.append(mkChip({
            label: "Δ Changed",
            tip:   "Show only routes whose tracked metrics moved since your last visit"
                + " (any ▲/▼ badge). Requires a previous-visit baseline to be useful.",
            active: !!f.onlyChanged,
            tint:  "#0d9488",
            toggle: () => this._toggleQuickFilter("onlyChanged")
        }))

        // Right-aligned "Clear" — only shown when at least one chip is active
        // OR a status is hidden, so it doesn't add clutter to the default state.
        const anyContentFilter = !!f.watchlistOnly || !!f.lossMakers || !!f.hasOverride
            || !!f.hasNote || !!f.onlyChanged
        const anyStatusHidden = STATUS_CHIPS.some(([k]) => statuses[k] === false)
        if (anyContentFilter || anyStatusHidden) {
            const spacer = document.createElement("span")
            spacer.style.cssText = "flex:1;"
            wrap.append(spacer)
            const clearBtn = document.createElement("button")
            clearBtn.type = "button"
            clearBtn.textContent = "Clear filters"
            clearBtn.title = "Reset every chip — show all rows"
            clearBtn.style.cssText = "padding:3px 9px;border-radius:11px;font-size:11px;cursor:pointer;"
                + "border:1px dashed #475569;background:transparent;color:#9ca3af;"
            clearBtn.addEventListener("click", () => this._clearQuickFilters())
            wrap.append(clearBtn)
        }
        this.chipBar.append(wrap)
    }

    /** Flip a top-level filter flag. Persists + re-renders. */
    async _toggleQuickFilter(key) {
        const filters = Object.assign({}, this.settings.filters || {})
        filters[key] = !filters[key]
        this.settings.filters = filters
        try { await RouteAssistantSettings.save({filters: filters}) } catch (e) { /* non-fatal */ }
        this._renderRows()
    }

    /**
     * Status chips show "active" when the status is being SHOWN. Toggling
     * mutates filters.statuses[<key>] — same source the settings drawer
     * already reads — so the two UIs stay in sync.
     */
    async _toggleStatusChip(statusKey) {
        const filters = Object.assign({}, this.settings.filters || {})
        const next = Object.assign({}, filters.statuses || {})
        next[statusKey] = next[statusKey] === false ? true : false
        filters.statuses = next
        this.settings.filters = filters
        try { await RouteAssistantSettings.save({filters: filters}) } catch (e) { /* non-fatal */ }
        // Re-render the settings drawer if it's open so the checkboxes
        // stay in sync with the chip flip.
        this._renderRows()
        if (this.settingsHost && this.settingsHost.dataset.open === "1") {
            this._renderSettings()
        }
    }

    /** Reset every chip to its default (all statuses ON, content flags OFF). */
    async _clearQuickFilters() {
        const filters = Object.assign({}, this.settings.filters || {})
        filters.statuses = {NEW: true, OK: true, UNDER: true, OVER: true, OOR: true}
        filters.watchlistOnly = false
        filters.lossMakers    = false
        filters.hasOverride   = false
        filters.hasNote       = false
        filters.onlyChanged   = false
        this.settings.filters = filters
        try { await RouteAssistantSettings.save({filters: filters}) } catch (e) { /* non-fatal */ }
        this._renderRows()
        if (this.settingsHost && this.settingsHost.dataset.open === "1") {
            this._renderSettings()
        }
    }

    /**
     * Q15 hub keyboard quick-swap — push the current hub onto the most-
     * recent-first list, dedupe case-insensitively, cap at 5. Persisted
     * to settings so the chips survive a tab close.
     */
    _trackRecentHub(iata) {
        if (!iata || typeof iata !== "string") return
        const hub = iata.toUpperCase()
        if (!/^[A-Z]{3}$/.test(hub)) return
        const list = Array.isArray(this.settings.recentHubs)
            ? this.settings.recentHubs.slice()
            : []
        const existing = list.indexOf(hub)
        if (existing === 0) return
        if (existing > 0) list.splice(existing, 1)
        list.unshift(hub)
        const trimmed = list.slice(0, 5)
        this.settings.recentHubs = trimmed
        RouteAssistantSettings.save({recentHubs: trimmed}).catch(() => {})
    }

    /**
     * Q15 — Alt+1..5 jumps to the corresponding entry in settings.recentHubs.
     * Skipped when focus is inside an input/textarea/contentEditable so the
     * shortcut never eats keystrokes the user is actually typing.
     */
    _attachHubShortcuts() {
        if (this._hubShortcutHandler) return
        this._hubShortcutHandler = (e) => {
            if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
            const k = e.key
            if (k < "1" || k > "5") return
            const t = e.target
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
            const list = (this.settings && this.settings.recentHubs) || []
            const idx = Number(k) - 1
            const target = list[idx]
            if (!target) return
            if (this.hubIata && target === this.hubIata.toUpperCase()) return
            e.preventDefault()
            window.location.assign("/app/com/scheduling/" + encodeURIComponent(target))
        }
        document.addEventListener("keydown", this._hubShortcutHandler, true)
    }

    _detachHubShortcuts() {
        if (!this._hubShortcutHandler) return
        document.removeEventListener("keydown", this._hubShortcutHandler, true)
        this._hubShortcutHandler = null
    }

    /**
     * Recent-hubs chip strip rendered into the controls bar. Empty when the
     * user has only ever visited one hub. Click navigates; the small digit
     * suffix mirrors the Alt+1..5 shortcut so the affordance is discoverable.
     */
    _renderRecentHubsBar(host) {
        const list = (this.settings && this.settings.recentHubs) || []
        if (!Array.isArray(list) || list.length < 2) return
        const others = list.filter(h => !this.hubIata || h !== this.hubIata.toUpperCase())
        if (!others.length) return
        const wrap = document.createElement("label")
        wrap.style.cssText = "display:flex;gap:5px;align-items:center;color:#9ca3af;"
        wrap.title = "Recent hubs — click or use Alt+1..5 to jump"
        wrap.append(document.createTextNode("Hubs"))
        const inner = document.createElement("span")
        inner.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;"
        for (let i = 0; i < others.length && i < 5; i++) {
            const hub = others[i]
            const altIdx = list.indexOf(hub) + 1
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = hub
            btn.title = "Alt+" + altIdx + " — jump to " + hub
            btn.style.cssText = "padding:2px 7px;border-radius:10px;font-size:11px;cursor:pointer;"
                + "background:transparent;color:#cbd5e1;border:1px solid #475569;"
                + "font-family:monospace;letter-spacing:0.5px;"
            btn.addEventListener("click", () => {
                window.location.assign("/app/com/scheduling/" + encodeURIComponent(hub))
            })
            const idxSup = document.createElement("sub")
            idxSup.textContent = String(altIdx)
            idxSup.style.cssText = "color:#6b7280;margin-left:3px;font-size:9px;"
            btn.append(idxSup)
            inner.append(btn)
        }
        wrap.append(inner)
        host.append(wrap)
    }

    /**
     * Q1 quick-filter chips — pill toggles for the four content-shape
     * filter fields (watchlistOnly, lossMakers, hasOverride, hasNote)
     * plus Δ Changed (`onlyChanged`, applied post-decoration in
     * _renderRows). Always rendered so users discover the affordance.
     * Lit (filled) when active, outline-only when inactive.
     */
    _renderQuickFilterChips(host) {
        const f = (this.settings && this.settings.filters) || {}
        const wrap = document.createElement("label")
        wrap.style.cssText = "display:flex;gap:5px;align-items:center;color:#9ca3af;"
        wrap.title = "Quick filters — toggle to restrict the visible row set"
        wrap.append(document.createTextNode("Filters"))
        const inner = document.createElement("span")
        inner.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;"

        // Each chip: {field, label, activeColor, tooltip}.
        const chips = [
            {field: "watchlistOnly", label: "★ Watch",     activeColor: "#fbbf24",
             tooltip: "Show only ★-starred routes."},
            {field: "lossMakers",    label: "💸 Loss",     activeColor: "#f87171",
             tooltip: "Show only routes where profit/wk is negative."},
            {field: "hasOverride",   label: "🛠 Override", activeColor: "#a78bfa",
             tooltip: "Show only routes with a saved LF/yield override."},
            {field: "hasNote",       label: "📝 Note",     activeColor: "#60a5fa",
             tooltip: "Show only routes with a saved route note."},
            {field: "onlyChanged",   label: "Δ Changed",   activeColor: "#34d399",
             tooltip: "Show only routes whose tracked fields moved since your last visit. Empty before the first baseline lands."}
        ]

        for (const chip of chips) {
            const active = !!f[chip.field]
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = chip.label
            btn.title = chip.tooltip
            btn.style.cssText = "padding:2px 8px;border-radius:10px;font-size:11px;cursor:pointer;"
                + "transition:background 120ms ease, border-color 120ms ease, color 120ms ease;"
                + (active
                    ? ("background:" + chip.activeColor + ";color:#0f1623;border:1px solid " + chip.activeColor + ";font-weight:600;")
                    : "background:transparent;color:#cbd5e1;border:1px solid #475569;")
            btn.addEventListener("click", async () => {
                this.settings.filters = Object.assign({}, this.settings.filters || {})
                this.settings.filters[chip.field] = !this.settings.filters[chip.field]
                try {
                    await RouteAssistantSettings.save({filters: this.settings.filters})
                } catch (e) { /* non-fatal */ }
                this._renderRows()
                this._renderControls()
            })
            inner.append(btn)
        }
        wrap.append(inner)
        host.append(wrap)
    }

    _renderStatusBar() {
        this.statusBar.innerHTML = ""
        const hubText = document.createElement("span")
        hubText.innerHTML = `Hub <strong style="color:#f3f4f6;">${escapeHtml(this.hubIata || "—")}</strong>`
        this.statusBar.append(hubText)

        if (this.ffData) {
            const ageH = this.ffData.scrapedAt
                ? Math.round((Date.now() - this.ffData.scrapedAt) / 3600e3)
                : null
            const ageStr = ageH === null ? "" : ageH < 1 ? "just now" : ageH + "h ago"
            const stale = ageH !== null && ageH > (this.settings.flightsfromMaxAgeDays * 24)
            const ffSpan = document.createElement("span")
            ffSpan.textContent = `· FF: ${(this.ffData.routes || []).length} routes${ageStr ? ", " + ageStr : ""}`
            ffSpan.style.color = stale ? "#fbbf24" : "#9ca3af"
            this.statusBar.append(ffSpan)
        } else {
            const ffSpan = document.createElement("span")
            ffSpan.textContent = "· FF: not scanned"
            ffSpan.style.color = "#fbbf24"
            this.statusBar.append(ffSpan)
        }

        const unresolved = this.rows.filter(r => r.paxScore === null).length
        const demandSpan = document.createElement("span")
        demandSpan.textContent = `· Demand: ${this.rows.length - unresolved}/${this.rows.length} resolved`
        demandSpan.style.color = unresolved > 0 ? "#fbbf24" : "#9ca3af"
        this.statusBar.append(demandSpan)

        // Distance enrichment status — shown only while a fetch is in flight
        // or when some rows still have unknown distance.
        const totalRows = this.rows.length
        const knownDist = this.rows.filter(r => typeof r.distanceKm === "number").length
        const distSpan = document.createElement("span")
        if (this.distanceProgress) {
            distSpan.textContent = `· Distance: ${this.distanceProgress.done}/${this.distanceProgress.total} resolving…`
            distSpan.style.color = "#60a5fa"
        } else {
            distSpan.textContent = `· Distance: ${knownDist}/${totalRows}`
            distSpan.style.color = knownDist < totalRows ? "#fbbf24" : "#9ca3af"
        }
        this.statusBar.append(distSpan)

        // Type-spec enrichment — shows while specs are being fetched or when
        // any fleet typeId still lacks a cached spec. Suppressed when there's
        // no fleet at all (no specs to chase).
        if (this.fleet && this.fleet.aircraft && this.fleet.aircraft.length) {
            const fleetTypeIds = RouteAssistantFleetStore.typeIdsIn(this.fleet)
            const cachedTypeIds = fleetTypeIds.filter(id => this.typeSpecs.has(id))
            const specSpan = document.createElement("span")
            if (this.typeSpecsProgress) {
                specSpan.textContent = `· Specs: ${this.typeSpecsProgress.done}/${this.typeSpecsProgress.total} fetching…`
                specSpan.style.color = "#60a5fa"
            } else if (cachedTypeIds.length < fleetTypeIds.length) {
                specSpan.textContent = `· Specs: ${cachedTypeIds.length}/${fleetTypeIds.length}`
                specSpan.style.color = "#fbbf24"
            } else if (fleetTypeIds.length) {
                specSpan.textContent = `· Specs: ${fleetTypeIds.length}/${fleetTypeIds.length}`
                specSpan.style.color = "#9ca3af"
            }
            if (specSpan.textContent) this.statusBar.append(specSpan)
        }

        // Action buttons
        const actions = document.createElement("span")
        actions.style.cssText = "margin-left:auto;display:flex;gap:6px;"

        if (this.hubIata) {
            const scanBtn = document.createElement("button")
            scanBtn.textContent = this.ffData ? "Rescan flightsfrom" : "Scan flightsfrom"
            Object.assign(scanBtn.style, smallBtnStyle())
            scanBtn.addEventListener("click", () => this._scanFlightsFrom())
            actions.append(scanBtn)
        }

        if (unresolved > 0) {
            const demandBtn = document.createElement("button")
            demandBtn.textContent = `Resolve ${unresolved} demand`
            Object.assign(demandBtn.style, smallBtnStyle())
            demandBtn.addEventListener("click", () => this._resolveDemand())
            actions.append(demandBtn)
        }

        const seedBtn = document.createElement("button")
        seedBtn.textContent = "Seed all countries"
        seedBtn.title = "One-time bulk scrape of every AS country (5–15 min). Required after install."
        Object.assign(seedBtn.style, smallBtnStyle())
        seedBtn.style.background = "#7c3aed"
        seedBtn.addEventListener("click", () => this._seedAllCountries())
        actions.append(seedBtn)

        this.statusBar.append(actions)
    }

    async _seedAllCountries() {
        if (this.scanner) {
            this._noteToast("A scan is already running — wait for it to finish.")
            return
        }
        const ok = window.confirm(
            "Bulk-seed AS demand for every country in this game world?\n\n" +
            "This fetches ~150 country pages and takes 5–15 minutes. " +
            "After it finishes, every destination's demand resolves instantly. " +
            "You only need to do this once per game world."
        )
        if (!ok) return

        this.scanner = new RouteAssistantParallelScanner(this.server, {concurrency: 3, staggerMs: 1200})
        this.scanner.onProgress(state => {
            if (state.phase === "seeding") {
                const cur = state.currentCountryName ? ` (${state.currentCountryName})` : ""
                this._noteToast(
                    `Seeding ${state.fetched}/${state.total} countries${cur} · ` +
                    `${state.airportsSeeded} airports cached`
                )
            } else {
                this._noteToast(
                    `Seed complete. ${state.fetched}/${state.total} countries · ` +
                    `${state.airportsSeeded} airports cached · ` +
                    `${state.failedCountries.length} failed.`
                )
            }
        })
        try {
            await this.scanner.seedAllCountries()
        } finally {
            this.scanner = null
            await this.refresh()
        }
    }

    async _scanFlightsFrom() {
        if (!this.hubIata) return
        if (!this.scanController) {
            this.scanController = new FlightsFromController()
            this.scanController.onUpdate(scan => this._handleScanUpdate(scan))
        }
        try {
            await this.scanController.start(this.hubIata)
            this._noteToast(`Scanning flightsfrom.com for ${this.hubIata}…`)
        } catch (error) {
            this._noteToast(`Scan failed: ${error.message || error}`, true)
        }
    }

    _handleScanUpdate(scan) {
        if (!scan) return
        if (scan.status === "ok") {
            this._noteToast(`flightsfrom scrape complete for ${scan.iata}.`)
            this.refresh()
        } else if (scan.status === "error" || scan.status === "timeout") {
            this._noteToast(`flightsfrom scrape ${scan.status}: ${scan.error || "unknown"} — the scrape tab stayed open for debugging.`, true)
            this.refresh()
        }
    }

    async _resolveDemand() {
        const unresolved = this.rows.filter(r => r.paxScore === null).map(r => r.destIata)
        if (!unresolved.length) return
        if (this.scanner) {
            this._noteToast("Already resolving demand…")
            return
        }
        this.scanner = new RouteAssistantParallelScanner(this.server, {concurrency: 3, staggerMs: 1500})
        this.scanner.onProgress(state => {
            const phase = state.phase === "resolving" ? `Resolving ${state.resolved}/${state.total}…`
                        : state.phase === "fetching"  ? `Fetching demand (${state.fetched}/${state.total})…`
                        : `Done. ${state.fetched} resolved, ${state.failedIatas.length} unresolved.`
            this._noteToast(phase)
        })
        try {
            await this.scanner.run(unresolved)
        } finally {
            this.scanner = null
            await this.refresh()
        }
    }

    _noteToast(msg, isError) {
        // Single floating message line under the status bar; replaces previous.
        let toast = this.root.querySelector(".aes-ra-toast")
        if (!toast) {
            toast = document.createElement("div")
            toast.className = "aes-ra-toast"
            toast.style.cssText = "padding:4px 12px;font-size:11px;background:#0f1623;border-bottom:1px solid #374151;"
            this.statusBar.parentNode.insertBefore(toast, this.settingsHost)
        }
        toast.style.color = isError ? "#f87171" : "#60a5fa"
        toast.textContent = msg
    }

    /**
     * Q11 single-step undo wrapper. Caller supplies `perform` (the save) +
     * optional `restore` (the closure that re-applies the captured prev
     * state) + optional `afterRestore` (re-render hook). Returns whatever
     * `perform` returns.
     *
     * On success, fires a floating RouteAssistantToast with an Undo button
     * wired to `restore`. On failure, fires an error toast and re-throws so
     * the caller can keep its own error path.
     *
     * Capture-then-perform is the caller's responsibility — `perform` is
     * called AFTER the caller has read the prev state into a closure that
     * `restore` can use. This keeps the helper free of store-specific
     * knowledge.
     */
    async _undoableSave(arg) {
        let result
        try {
            result = await arg.perform()
        } catch (e) {
            if (typeof RouteAssistantToast !== "undefined") {
                const msg = (e && e.message) ? e.message : String(e)
                RouteAssistantToast.error((arg.label || "Save") + " failed: " + msg)
            }
            throw e
        }
        if (typeof RouteAssistantToast !== "undefined") {
            RouteAssistantToast.show(arg.label, {
                type:     arg.type || "success",
                duration: arg.durationMs || 6000,
                action:   arg.restore ? {
                    label: arg.actionLabel || "Undo",
                    fn:    async () => {
                        try {
                            await arg.restore()
                            if (typeof arg.afterRestore === "function") arg.afterRestore()
                            RouteAssistantToast.info("Reverted", {duration: 2500})
                        } catch (e) {
                            const msg = (e && e.message) ? e.message : String(e)
                            RouteAssistantToast.error("Undo failed: " + msg)
                        }
                    }
                } : undefined
            })
        }
        return result
    }

    // ---------- Active prompts (alert rules) ----------

    /**
     * Reload alert rules from chrome.storage.local. Called once per refresh
     * so the panel's rules are always current. Failures are non-fatal —
     * an empty rule list silently disables alerts until the next reload.
     */
    async _loadAlertRules() {
        if (typeof RouteAssistantAlertRulesStore === "undefined") {
            this._alertRules = []
            return
        }
        try {
            const rec = await RouteAssistantAlertRulesStore.load()
            this._alertRules = (rec && rec.rules) || []
        } catch (e) {
            console.warn("[AES routeAssistant] alert rules load failed:", e)
            this._alertRules = []
        }
    }

    /**
     * Evaluate alert rules against the current scoredRows and fire toasts
     * for triggered alerts. Dedupes per-mount via `_alertFiredThisMount`
     * + persists `recordFired` so the store-level cooldown carries across
     * mounts.
     */
    _evaluateAndFireAlerts(rows) {
        if (typeof RouteAssistantAlertEvaluator === "undefined") return
        if (typeof RouteAssistantToast === "undefined")          return
        if (!Array.isArray(this._alertRules) || !this._alertRules.length) return
        if (!Array.isArray(rows) || !rows.length) return

        const triggered = RouteAssistantAlertEvaluator.evaluate(this._alertRules, rows, {
            hubIata: this.hubIata,
            now:     Date.now()
        })
        if (!triggered.length) return

        for (const alert of triggered) {
            const key = alert.ruleId + "|" + alert.routeKey
            if (this._alertFiredThisMount.has(key)) continue
            this._alertFiredThisMount.add(key)

            const toastType = alert.severity === "error" ? "error"
                : alert.severity === "info" ? "info"
                : "warn"
            RouteAssistantToast.show(alert.message, {
                type:     toastType,
                duration: 8000,
                id:       "alert-" + key,
                action: {
                    label: "View",
                    fn:    () => this._scrollToRouteRow(alert.dest)
                }
            })

            // Persist the fire timestamp so the store-level cooldown
            // suppresses the same trigger on the next mount within the
            // cooldown window.
            if (typeof RouteAssistantAlertRulesStore !== "undefined") {
                RouteAssistantAlertRulesStore.recordFired(alert.ruleId, alert.routeKey)
                    .catch(() => {})
            }
        }
    }

    /**
     * Scroll the table to a specific destIata's row + flash-highlight it.
     * Called from the "View" action on an alert toast.
     */
    _scrollToRouteRow(destIata) {
        if (!this.tableHost || !destIata) return
        const target = String(destIata).toUpperCase()
        const cells = this.tableHost.querySelectorAll("tbody td")
        for (const td of cells) {
            if ((td.textContent || "").trim().toUpperCase() === target) {
                const row = td.parentElement
                if (!row) continue
                row.scrollIntoView({behavior: "smooth", block: "center"})
                const prevBg = row.style.background
                row.style.transition = "background 1500ms ease"
                row.style.background = "rgba(251, 191, 36, 0.18)"
                setTimeout(() => { row.style.background = prevBg || "" }, 2000)
                return
            }
        }
    }

    // ---------- Aircraft picker ----------

    /**
     * Renders the Mode + Aircraft dropdowns inside this.controlsHost. Called
     * on every _render so the option list stays in sync with the live fleet
     * (e.g. after a fleet rescan in another tab).
     */
    _renderControls() {
        if (!this.controlsHost) return
        this.controlsHost.innerHTML = ""
        this.controlsHost.dataset.populated = "0"

        if (this.collapsed) {
            this.controlsHost.style.display = "none"
            return
        }

        // Q12 free-text search — first control on the bar so it's the most
        // discoverable. Persists to settings.searchQuery; debounced 200ms
        // so typing doesn't thrash _renderRows on every keystroke.
        const searchWrap = document.createElement("label")
        searchWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        searchWrap.title = "Filter rows by IATA / city / route note (case-insensitive substring)."
        searchWrap.append(document.createTextNode("🔍"))
        const searchInp = document.createElement("input")
        searchInp.type = "search"
        searchInp.placeholder = "Search IATA / city / note"
        searchInp.value = (this.settings && this.settings.searchQuery) || ""
        searchInp.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 6px;font-size:11px;min-width:180px;"
        let searchTimer = null
        searchInp.addEventListener("input", () => {
            const v = searchInp.value
            this.settings.searchQuery = v
            // Debounce both the storage write AND the re-render so typing
            // is fluid even on slow disks. Render runs at the same cadence
            // as save — keystrokes coalesce naturally.
            clearTimeout(searchTimer)
            searchTimer = setTimeout(() => {
                RouteAssistantSettings.save({searchQuery: v}).catch(() => {})
                this._renderRows()
            }, 200)
        })
        searchInp.addEventListener("search", () => {
            // The native "search" event fires when the user clicks the X
            // clear-button. Re-render immediately, no debounce.
            this.settings.searchQuery = ""
            RouteAssistantSettings.save({searchQuery: ""}).catch(() => {})
            this._renderRows()
        })
        searchWrap.append(searchInp)
        this.controlsHost.append(searchWrap)

        // Q15 — recent-hubs chip strip. Renders nothing when the user has
        // only ever visited one hub, so first-time users don't see clutter.
        this._renderRecentHubsBar(this.controlsHost)

        // Q1 quick-filter chips — fast-path toggles paired with the
        // content-shape gates pre-staged in settings.filters. Each chip
        // is a pill button; clicking flips the corresponding settings
        // field, persists, and re-renders. Active state lights the pill.
        this._renderQuickFilterChips(this.controlsHost)

        const fleetEmpty = !this.fleet || !this.fleet.aircraft || !this.fleet.aircraft.length
        const a = this.settings.aircraft || {}
        const currentMode = a.mode || ""

        // Mode select
        const modeWrap = document.createElement("label")
        modeWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        modeWrap.append(document.createTextNode("Aircraft mode"))
        const modeSel = mkSelect([
            {value: "",             label: "None"},
            {value: "fleet",        label: "Fleet (any owned)"},
            {value: "type",         label: "By type"},
            {value: "registration", label: "By tail"}
        ], currentMode)
        modeSel.disabled = fleetEmpty
        modeWrap.append(modeSel)
        this.controlsHost.append(modeWrap)

        // Aircraft select — populated based on mode
        const acWrap = document.createElement("label")
        acWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        acWrap.append(document.createTextNode("Aircraft"))
        const acSel = document.createElement("select")
        acSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;max-width:260px;"

        const noneOpt = document.createElement("option")
        noneOpt.value = ""
        noneOpt.textContent = fleetEmpty ? "(no fleet — visit /app/fleets)" : "(none)"
        acSel.append(noneOpt)

        if (currentMode === "fleet" && !fleetEmpty) {
            const sum = this._fleetSummaryLabel()
            const opt = document.createElement("option")
            opt.value = "fleet"
            opt.textContent = sum
            opt.selected = true
            acSel.append(opt)
        } else if (currentMode === "type" && !fleetEmpty) {
            const slots = RouteAssistantFleetStore.activeTypeSlots(this.fleet)
                .sort((x, y) => y.count - x.count)
            for (const s of slots) {
                const opt = document.createElement("option")
                opt.value = String(s.typeId)
                const cached = this.typeSpecs.get(s.typeId)
                const rangeStr = cached && cached.range ? ` · ${cached.range.toLocaleString()} km` : ""
                opt.textContent = `${s.typeName} (×${s.count})${rangeStr}`
                if (a.typeId && Number(a.typeId) === Number(s.typeId)) opt.selected = true
                acSel.append(opt)
            }
        } else if (currentMode === "registration" && !fleetEmpty) {
            const tails = (this.fleet.aircraft || []).slice()
                .filter(x => x && x.registration)
                .sort((x, y) => String(x.registration).localeCompare(String(y.registration)))
            for (const ac of tails) {
                const opt = document.createElement("option")
                opt.value = String(ac.registration)
                opt.textContent = `${ac.registration} — ${ac.equipment || "(unknown)"}`
                if (a.registration === ac.registration) opt.selected = true
                acSel.append(opt)
            }
        }

        acSel.disabled = (currentMode === "" || fleetEmpty)
        acWrap.append(acSel)
        this.controlsHost.append(acWrap)

        // Falloff% live tweak — only meaningful when an aircraft is selected.
        if (currentMode && !fleetEmpty) {
            const falloffWrap = document.createElement("label")
            falloffWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            falloffWrap.append(document.createTextNode("Fall-off %"))
            const falloffSel = mkSelect(
                [5, 7, 10, 12, 15, 20, 25].map(v => ({value: String(v), label: String(v)})),
                String(a.falloffPct || 10)
            )
            falloffSel.addEventListener("change", async () => {
                this.settings.aircraft.falloffPct = Number(falloffSel.value) || 10
                await RouteAssistantSettings.save({aircraft: this.settings.aircraft})
                this._recomputeProfit()
            })
            falloffWrap.append(falloffSel)
            this.controlsHost.append(falloffWrap)

            const flyableWrap = document.createElement("label")
            flyableWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            const cb = mkInput("checkbox", null)
            cb.checked = !!(this.settings.filters && this.settings.filters.fleetFlyableOnly)
            cb.addEventListener("change", async () => {
                this.settings.filters.fleetFlyableOnly = cb.checked
                await RouteAssistantSettings.save({filters: this.settings.filters})
                this._render()
            })
            flyableWrap.append(cb, document.createTextNode("Fleet-flyable only"))
            this.controlsHost.append(flyableWrap)
        }

        // Wire up the cascading change handlers — Mode change wipes selection,
        // Aircraft change saves the chosen typeId/registration.
        modeSel.addEventListener("change", async () => {
            const next = modeSel.value || null
            this.settings.aircraft.mode         = next
            this.settings.aircraft.typeId       = null
            this.settings.aircraft.registration = null
            await RouteAssistantSettings.save({aircraft: this.settings.aircraft})
            await this.refresh()
        })
        acSel.addEventListener("change", async () => {
            const v = acSel.value
            if (currentMode === "type") {
                this.settings.aircraft.typeId = v ? Number(v) : null
            } else if (currentMode === "registration") {
                this.settings.aircraft.registration = v || null
            } else if (currentMode === "fleet") {
                // value is "fleet" or "" (none) — mode covers it; no extra state.
                if (!v) this.settings.aircraft.mode = null
            }
            await RouteAssistantSettings.save({aircraft: this.settings.aircraft})
            await this.refresh()
        })

        this.controlsHost.style.display = "flex"
        this.controlsHost.dataset.populated = "1"
    }

    _fleetSummaryLabel() {
        if (!this.fleet) return "Any owned"
        const totalAc    = (this.fleet.aircraft || []).length
        const totalTypes = RouteAssistantFleetStore.activeTypeSlots(this.fleet).length
        return `Any owned (${totalAc} aircraft, ${totalTypes} type${totalTypes === 1 ? "" : "s"})`
    }

    // ---------- Table + filters ----------

    _render() {
        this._syncVarianceWarn()
        this._syncRenderContext()
        this._renderControls()
        this._renderRows()
    }

    /**
     * The Δ% column's render closure reads this static so the threshold
     * stays in sync with the user's `yieldFeedback.varianceWarnPct` setting
     * without having to thread the panel instance into static config.
     */
    _syncVarianceWarn() {
        const yf = this.settings && this.settings.yieldFeedback
        const v = yf && Number(yf.varianceWarnPct)
        RouteAssistantPanel._varianceWarnPct = (isFinite(v) && v > 0) ? v : 25
    }

    /**
     * Cell-render closures need the current hub IATA + server name to build
     * the AS URLs. Stash them in static fields right before render so the
     * closures don't need to capture the panel instance.
     */
    _syncRenderContext() {
        RouteAssistantPanel._currentHubIata = this.hubIata || ""
        RouteAssistantPanel._currentServer  = this.server  || ""
        RouteAssistantPanel._currentInstance = this
        RouteAssistantPanel._serviceProfilesCacheStatic = this.serviceProfilesCache || null
        const carriers = this.settings && this.settings.carriers
        RouteAssistantPanel._showCarrierIntensity = !carriers || carriers.showCarrierIntensity !== false
        const ma = this.settings && this.settings.marketAnalysis
        const stale = ma && Number(ma.staleThresholdDays)
        RouteAssistantPanel._demandStaleThresholdDays = (stale > 0) ? stale : 14
        const ors = this.settings && this.settings.ors
        RouteAssistantPanel._orsPrimaryColumn = (ors && ors.primaryColumn) || "ratingGapToTop"
        const wl = this.settings && this.settings.watchlist
        RouteAssistantPanel._showWatchTriggers = !wl || wl.showAlertBadges !== false
        // Reflect Compact-view state on the header button so the user sees
        // at a glance whether they're in Compact or Full mode.
        const compact = !!(this.settings && this.settings.compactView)
        if (this._compactBtn) {
            this._compactBtn.style.opacity = compact ? "1" : "0.6"
            this._compactBtn.title = compact
                ? "Compact view ON — heavy column groups hidden. Click to show all."
                : "Compact view OFF — all column groups visible. Click to hide heavy groups."
        }
        // Wave View visual state.
        const waveOn = !!(this.settings && this.settings.waveView)
        if (this._waveBtn) {
            this._waveBtn.style.opacity = waveOn ? "1" : "0.6"
            this._waveBtn.title = waveOn
                ? "Wave View ON — Gantt timeline of the recommended schedule. Click to return to the table."
                : "Wave View OFF — table view. Click to switch to the Gantt wave overlay."
        }
        // ORS Sandbox visual state.
        const sbCfg  = (this.settings && this.settings.orsSandbox) || {}
        const sbOn   = !!sbCfg.enabled
        if (this._orsSandboxBtn) {
            this._orsSandboxBtn.style.opacity = sbOn ? "1" : "0.6"
            this._orsSandboxBtn.title = sbOn
                ? "ORS Sandbox ON — per-route pricing simulator. Click to return to the table."
                : "ORS Sandbox OFF — table view. Click to switch to the pricing simulator."
        }
    }

    /**
     * Body re-render only — skips _renderControls so a user-opened picker
     * dropdown isn't wiped while distance / type-spec batches stream in.
     * Called from both enrichment loops between batches.
     */
    _renderRows() {
        this._renderStatusBar()
        this._renderTabBar()
        this._renderChipBar()
        if (!this.hubIata) return
        if (!this.ffData) {
            this._renderEmpty(`No flightsfrom.com data cached for ${this.hubIata}. Click "Scan flightsfrom" above.`)
            return
        }
        if (!this.rows.length) {
            this._renderEmpty(`flightsfrom.com cached, but no routes recorded for ${this.hubIata}.`)
            return
        }

        // Empty-cache banner — most common first-run state.
        const resolved = this.rows.filter(r => r.paxScore !== null).length
        if (resolved === 0) {
            this._renderSeedPrompt()
            return
        }

        const filtered = this._applyFilters(this.rows)
        // Filter SCORING_FIELDS by the active view mode so the score
        // blend reflects only signals relevant to the current tab.
        // Pax tab drops cargoScore; Cargo tab drops paxScore; All
        // keeps everything (preserves pre-tabbed behaviour).
        const mode = this._currentViewMode()
        const activeFields = RouteAssistantPanel.SCORING_FIELDS.filter(f =>
            !Array.isArray(f.modes) || f.modes.indexOf(mode) >= 0
        )
        this.scoredRows = RouteAssistantScore.computeScores(filtered, this.settings.scoring,
            activeFields)

        if (!this.scoredRows.length) {
            this._renderEmpty("No routes match the current filters.")
            return
        }

        // Decorate each row with `_diff.<field>` scalars from the previous
        // mount's snapshot. No-op when there's no baseline (first ever
        // mount on this hub) — render closures fall through silently.
        _decorateRowsWithDiffs(this.scoredRows, this._diffPrevSnapshot)

        // Q1 chip: "Δ Changed" — drop rows whose `_diff` is empty. Has to
        // run AFTER _decorateRowsWithDiffs because `_diff` doesn't exist
        // on raw rows. When there's no baseline yet (first visit), every
        // row is "unchanged" by definition — short-circuit to keep the
        // first-mount UX informative instead of silently empty.
        const onlyChanged = this.settings.filters && this.settings.filters.onlyChanged
        if (onlyChanged && this._diffPrevSnapshot) {
            this.scoredRows = this.scoredRows.filter(r => !!r._diff)
            if (!this.scoredRows.length) {
                this._renderEmpty("No routes have changed since your last visit. Toggle the Δ Changed chip off to see all rows.")
                return
            }
        }

        // Watchlist — decorate `_starred` per row from the in-memory Set.
        // Lookup is `<HUB>-<DEST>` upper-cased; the store always stores
        // upper-case so a direct Set.has on the same key works.
        const wlSet = this._watchlist || new Set()
        const hubKey = String(this.hubIata || "").toUpperCase()
        for (const r of this.scoredRows) {
            const k = hubKey + "-" + String(r.destIata || "").toUpperCase()
            r._starred = wlSet.has(k)
        }

        // Active prompts — evaluate user-defined alert rules against the
        // newly-decorated rows. Has to run AFTER `_decorateRowsWithDiffs`
        // (rules read `row._diff.<field>`) AND AFTER the `_starred`
        // decoration above (the "watchlist" scope filter relies on it).
        // Fire-and-forget so render isn't blocked by the rules-store
        // recordFired round-trip.
        this._evaluateAndFireAlerts(this.scoredRows)

        const sorted = this._sortRows(this.scoredRows)

        // H slice 1 — Wave View hands the sorted rows off to the Gantt
        // renderer instead of drawing the table. We branch AFTER scoring
        // + sorting so Wave View honours the same filters, the same view
        // mode, and naturally promotes starred routes (they sort to the
        // top via the watchlist comparator → land in the top-N).
        if (this.settings && this.settings.waveView) {
            this._renderWaveOverlay(sorted)
            return
        }

        // Letter I slice 1 — ORS Sandbox replaces the table with a
        // per-route pricing simulator. Mutually exclusive with Wave
        // View; Wave wins because its branch runs first above.
        const sbCfg = this.settings && this.settings.orsSandbox
        if (sbCfg && sbCfg.enabled) {
            this._renderOrsSandbox(sorted)
            return
        }

        this._drawTable(sorted)
    }

    _applyFilters(rows) {
        const f = this.settings.filters || {}
        const minScore = numOrNull(f.minScore)
        const maxDist  = numOrNull(f.maxDistanceKm)
        const statuses = f.statuses || {}
        const fleetFlyable = !!f.fleetFlyableOnly && this._fleetContext() !== null
        // Q12 free-text search — case-insensitive substring match against
        // IATA / city name / route note. Empty query passes through.
        const rawQuery = (this.settings && this.settings.searchQuery) || ""
        const query = String(rawQuery).trim().toLowerCase()
        // Q1 quick-filter chips — content-shape gates orthogonal to status.
        // The watchlist filter consults the same in-memory Set the panel
        // uses to decorate rows so it stays correct between refreshes.
        const watchlistOnly = !!f.watchlistOnly
        const lossMakers    = !!f.lossMakers
        const hasOverride   = !!f.hasOverride
        const hasNote       = !!f.hasNote
        // Note: `onlyChanged` is applied post-decoration in _renderRows
        // because _diff doesn't exist on raw rows yet — see the filter
        // call site for the actual gate.
        const hubKey = String(this.hubIata || "").toUpperCase()
        const wlSet = this._watchlist || new Set()
        return rows.filter(r => {
            if (statuses[r.status] === false) return false
            if (maxDist !== null && r.distanceKm !== null && r.distanceKm > maxDist) return false
            // Fleet-flyable filter: only meaningful when an aircraft is picked.
            // OOR rows (or rows where the spec couldn't be evaluated) are dropped.
            if (fleetFlyable && (r.aircraftFit === "oor" || r.aircraftFit === null)) return false
            if (query) {
                const iata = String(r.destIata || "").toLowerCase()
                const name = String(r.destName || "").toLowerCase()
                const note = String(r.routeNoteText || "").toLowerCase()
                if (iata.indexOf(query) < 0 && name.indexOf(query) < 0 && note.indexOf(query) < 0) return false
            }
            if (watchlistOnly) {
                const k = hubKey + "-" + String(r.destIata || "").toUpperCase()
                if (!wlSet.has(k)) return false
            }
            if (lossMakers && (r.profitPerWeek === null || r.profitPerWeek >= 0)) return false
            if (hasOverride && !r.override) return false
            if (hasNote && !r.routeNoteText) return false
            // minScore is checked AFTER scoring, since score depends on the
            // visible set. We do it in _drawTable by post-filtering.
            return true
        })
    }

    _sortRows(rows) {
        const dir = this.sortDir
        const field = this.sortField
        const wl = this.settings && this.settings.watchlist
        const floatStars = !wl || wl.floatStarredToTop !== false
        return rows.slice().sort((a, b) => {
            // Watchlist primary key — starred rows float above unstarred
            // ones regardless of sort field. Within each group the user's
            // chosen field+dir is honoured (the comparator below).
            if (floatStars) {
                const sa = !!a._starred, sb = !!b._starred
                if (sa !== sb) return sa ? -1 : 1
            }
            const va = a[field], vb = b[field]
            if (va === vb) return 0
            if (va === null || va === undefined || va === "") return 1
            if (vb === null || vb === undefined || vb === "") return -1
            if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir
            return String(va).localeCompare(String(vb)) * dir
        })
    }

    _drawTable(sorted) {
        this.tableHost.innerHTML = ""

        const minScore = numOrNull(this.settings.filters && this.settings.filters.minScore)
        const visible = minScore === null
            ? sorted
            : sorted.filter(r => r.score === null || r.score >= minScore)
        if (!visible.length) {
            this._renderEmpty(`No routes pass the min-score filter (≥ ${minScore}).`)
            return
        }

        const fleetBanner = this._renderFleetBanner()
        if (fleetBanner) this.tableHost.append(fleetBanner)
        this.tableHost.append(this._buildLegend())
        // Defensive try/catch: any runtime error in _buildTable would
        // otherwise leave the table host empty (innerHTML was cleared
        // above) and the user sees no rows + no clue why. Surface the
        // error inline so reports can quote the message.
        try {
            this.tableHost.append(this._buildTable(visible))
        } catch (e) {
            console.error("[AES routeAssistant] _buildTable failed:", e)
            const errBox = document.createElement("div")
            errBox.style.cssText = "background:#7f1d1d;color:#fee2e2;padding:10px 14px;"
                + "border-radius:4px;margin:8px 0;font-size:11px;line-height:1.4;"
                + "font-family:ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;"
            errBox.textContent = "Table render failed:\n" + (e && e.stack ? e.stack : String(e))
            this.tableHost.append(errBox)
        }

        // Publish a slim top-routes snapshot for cross-feature consumers
        // (currently the Used Aircraft Scanner's route-fit metric). Capped
        // at 50 to keep storage write small; the scanner doesn't need more.
        this._publishTopRoutes(visible)

        // Diff-against-last-visit — overwrite `routeAssistant:lastSnapshot:<HUB>`
        // with the full scored set so the next mount can compute deltas.
        // The in-memory `this._diffPrevSnapshot` is unaffected, so the
        // current mount keeps showing "since last visit" against its own
        // baseline even though storage now holds the new state.
        _writeDiffSnapshot(this.hubIata, this.server, this.scoredRows)
    }

    /**
     * H slice 1 — Wave View render path. Replaces the table with a
     * Gantt timeline of the recommended schedule for the top-N scored
     * rows, built via ScheduleBuilder + the user's selected preset.
     *
     * Read-only against ScheduleStore — slice 1 visualises only.
     */
    async _renderWaveOverlay(sorted) {
        this.tableHost.innerHTML = ""

        const wo = (this.settings && this.settings.waveOverlay) || {}
        const topN = Math.max(1, Math.min(100, Number(wo.topN) || 20))

        if (!this._wavePresets) {
            this._wavePresets = await SchedulePresets.load()
        }
        const presets = (this._wavePresets && this._wavePresets.presets) || []
        const pickedId = wo.lastPresetId
            || (this._wavePresets && this._wavePresets.defaultPresetId)
            || (presets[0] && presets[0].id)
            || null
        const preset = pickedId ? presets.find(p => p.id === pickedId) : null

        this.tableHost.append(this._buildWaveHeader(preset, presets, topN))

        if (!preset) {
            const empty = document.createElement("div")
            empty.style.cssText = "margin:18px 0;padding:14px;border:1px dashed #4c1d95;"
                + "background:rgba(124,58,237,0.06);border-radius:4px;color:#d8b4fe;"
            empty.innerHTML = "<strong>No wave preset configured.</strong><br>"
                + "<span style='color:#a78bfa;font-size:11px;'>"
                + "Wave View needs at least one preset describing wave windows + composition counts. "
                + "Open the AES dashboard → <em>Schedule Management</em> to create one.</span>"
            this.tableHost.append(empty)
            return
        }

        if (!this.selectedSpec) {
            const banner = document.createElement("div")
            banner.style.cssText = "margin:6px 0;padding:6px 10px;font-size:11px;"
                + "background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.30);"
                + "border-radius:3px;color:#fde68a;"
            banner.textContent = "No aircraft picked — pick one in the panel header to size haul buckets and skip OOR routes."
            this.tableHost.append(banner)
        }

        const buildSig = (preset.id || "?") + ":" + topN
            + ":" + (this.selectedSpec ? this.selectedSpec.typeId : "none")
            + ":" + (sorted ? sorted.length : 0)
        if (!this._waveBuild
            || this._waveBuild._sig !== buildSig
            || this._waveBuildHub !== this.hubIata) {
            this._waveBuild = RouteAssistantWaveOverlay.buildSchedule(preset, sorted, {
                server:       this.server,
                airlineCode:  (this.ownSchedule && this.ownSchedule.airline) || null,
                hubIata:      this.hubIata,
                selectedSpec: this.selectedSpec,
                topN:         topN
            })
            this._waveBuild._sig = buildSig
            this._waveBuildHub   = this.hubIata
        }

        if (this._waveBuild.validation && this._waveBuild.validation.length) {
            const vbox = document.createElement("div")
            vbox.style.cssText = "margin:8px 0;padding:8px 10px;"
                + "background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.40);"
                + "border-radius:3px;color:#fca5a5;font-size:11px;"
            const h = document.createElement("strong")
            h.textContent = "Preset \"" + preset.name + "\" has issues — fix in Schedule Management:"
            h.style.cssText = "display:block;margin-bottom:4px;"
            vbox.append(h)
            for (const err of this._waveBuild.validation) {
                const line = document.createElement("div")
                line.textContent = "• " + err
                vbox.append(line)
            }
            this.tableHost.append(vbox)
            return
        }

        if (!sorted || !sorted.length) {
            const hint = document.createElement("div")
            hint.style.cssText = "margin:18px 0;padding:14px;color:#9ca3af;"
                + "background:rgba(75,85,99,0.10);border-radius:4px;"
            hint.textContent = "No scored routes available yet — run the demand seed and wait for distance enrichment first."
            this.tableHost.append(hint)
            return
        }

        const ganttHost = document.createElement("div")
        ganttHost.style.marginTop = "4px"
        this.tableHost.append(ganttHost)
        RouteAssistantWaveOverlay.renderGantt(ganttHost, this._waveBuild, {
            hubIata: this.hubIata,
            onFlightClick: (flight) => {
                const partner = (flight.direction === "inbound")
                    ? flight.origin
                    : flight.destination
                if (this.hubIata && partner) {
                    const url = "/app/com/scheduling/"
                        + encodeURIComponent(this.hubIata) + encodeURIComponent(partner)
                    window.open(url, "_blank", "noopener")
                }
            }
        })
    }

    /**
     * Wave View header strip — preset picker + top-N + aircraft display
     * + re-run + edit-presets. Returns the assembled DOM node.
     */
    _buildWaveHeader(preset, presets, topN) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "padding:6px 8px;margin:4px 0 6px 0;font-size:11px;"
            + "background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.25);"
            + "border-radius:4px;"

        const presetSel = document.createElement("select")
        presetSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;"
        if (!presets.length) {
            const o = document.createElement("option")
            o.value = ""
            o.textContent = "(no presets — create one in dashboard)"
            presetSel.append(o)
            presetSel.disabled = true
        } else {
            for (const p of presets) {
                const o = document.createElement("option")
                o.value = p.id
                o.textContent = p.name + (p.hub ? " · " + p.hub : "")
                if (preset && p.id === preset.id) o.selected = true
                presetSel.append(o)
            }
        }
        presetSel.addEventListener("change", async () => {
            const id = presetSel.value
            this.settings.waveOverlay = Object.assign({}, this.settings.waveOverlay || {},
                {lastPresetId: id})
            try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
            catch (e) { /* non-fatal */ }
            this._waveBuild = null
            this._renderRows()
        })
        const presetLbl = document.createElement("label")
        presetLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        presetLbl.append(document.createTextNode("Preset:"), presetSel)
        wrap.append(presetLbl)

        const topInput = document.createElement("input")
        topInput.type = "number"
        topInput.min = "5"
        topInput.max = "100"
        topInput.step = "1"
        topInput.value = String(topN)
        topInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;width:55px;"
        topInput.addEventListener("change", async () => {
            const n = Math.max(5, Math.min(100, Number(topInput.value) || 20))
            topInput.value = String(n)
            this.settings.waveOverlay = Object.assign({}, this.settings.waveOverlay || {}, {topN: n})
            try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
            catch (e) { /* non-fatal */ }
            this._waveBuild = null
            this._renderRows()
        })
        const topLbl = document.createElement("label")
        topLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        topLbl.append(document.createTextNode("Top N:"), topInput)
        wrap.append(topLbl)

        const acLbl = document.createElement("span")
        acLbl.style.color = "#9ca3af"
        const acName = this.selectedSpec
            ? (this.selectedSpec.typeName || this.selectedSpec.name || "?")
            : "(none)"
        acLbl.innerHTML = "Aircraft: <strong style='color:#cbd5e1;'>" + escapeHtml(acName) + "</strong>"
        wrap.append(acLbl)

        const rerunBtn = document.createElement("button")
        rerunBtn.textContent = "⟳ Re-run"
        rerunBtn.title = "Re-build the Gantt against the current scored rows"
        Object.assign(rerunBtn.style, smallBtnStyle())
        rerunBtn.style.background = "#1e40af"
        rerunBtn.addEventListener("click", () => {
            this._waveBuild = null
            this._renderRows()
        })
        wrap.append(rerunBtn)

        const editLink = document.createElement("a")
        editLink.href = "/app/enterprise/dashboard"
        editLink.target = "_blank"
        editLink.rel = "noopener"
        editLink.textContent = "📅 Edit presets →"
        editLink.style.cssText = "color:#93c5fd;text-decoration:none;font-size:11px;margin-left:auto;"
        editLink.title = "Open the dashboard → Schedule Management to add or edit wave presets"
        wrap.append(editLink)

        return wrap
    }

    // ==================================================================
    // Letter I slice 1 — ORS Sandbox (per-route pricing simulator).
    // ==================================================================
    //
    // Replaces the table with a single-route projection sandbox: pick a
    // route, drag price/frequency/comfort sliders, watch projected rank,
    // share, pax/wk, revenue/wk, profit/wk update in real time. Sourced
    // entirely from cached data (ORS connection lists + markets-page own
    // pricing + demand-derivator outputs); no AS hits. Read-only.
    //
    // The model lives in `RouteAssistantOrsModel.project(...)`. This UI
    // is a thin shell — assemble a route bundle from cache, push it into
    // the model with the current scenario, render the result.

    _renderOrsSandbox(sorted) {
        this.tableHost.innerHTML = ""
        const cfg = (this.settings && this.settings.orsSandbox) || {}

        // Restore last-used route on first render after toggle-on.
        if (!this._orsSandboxRoute && cfg.lastRouteIata) {
            const restored = (sorted || []).find(r => String(r.destIata).toUpperCase() === String(cfg.lastRouteIata).toUpperCase())
            if (restored) this._orsSandboxRoute = {hub: this.hubIata, dest: restored.destIata, _row: restored}
        }

        this.tableHost.append(this._buildOrsSandboxHeader(sorted))

        if (!this._orsSandboxRoute) {
            this.tableHost.append(this._buildOrsSandboxRoutePicker(sorted))
            return
        }

        const row = this._orsSandboxRoute._row
            || (sorted || []).find(r => String(r.destIata).toUpperCase() === String(this._orsSandboxRoute.dest).toUpperCase())
        if (!row) {
            const empty = document.createElement("div")
            empty.style.cssText = "margin:18px 0;padding:14px;border:1px dashed #475569;"
                + "background:rgba(100,116,139,0.08);border-radius:4px;color:#cbd5e1;"
            empty.textContent = "Selected route is not in the current view (filters may have hidden it). "
                + "Pick another route or relax filters."
            this.tableHost.append(empty)
            return
        }
        this._orsSandboxRoute._row = row

        const route = this._assembleOrsSandboxRoute(row)
        if (!route.orsByClass || !Object.keys(route.orsByClass).length) {
            this.tableHost.append(this._buildOrsSandboxNoOrsBanner(row))
            return
        }

        // Per-route scenario — pick the saved entry for this exact route, OR
        // the one-time legacy scenario (settings-store surfaces it via
        // `_legacyLastScenario` for the route the user had open last
        // pre-upgrade), OR neutral defaults.
        const routeKey = String(this.hubIata).toUpperCase() + "-" + String(row.destIata).toUpperCase()
        const savedForRoute = (cfg.lastScenarioByRoute && cfg.lastScenarioByRoute[routeKey]) || null
        const legacyFallback = (!savedForRoute
                                && cfg._legacyLastScenario
                                && String(cfg.lastRouteIata || "").toUpperCase() === String(row.destIata).toUpperCase())
            ? cfg._legacyLastScenario : null
        const scenario = RouteAssistantOrsModel._normaliseScenario(savedForRoute || legacyFallback)
        // First render — kick off a synchronous compute so baseline/projected
        // cards are populated before paint.
        this._orsSandboxResult = RouteAssistantOrsModel.project({
            route:              route,
            scenario:           scenario,
            modelParams:        Object.assign({}, cfg.modelParams || {},
                {perRouteT: (cfg.perRouteTemperature || {})[routeKey]}),
            economics:          this.settings.economics || {},
            useRealDemandForLF: !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
        })

        const body = document.createElement("div")
        body.style.cssText = "display:grid;grid-template-columns:minmax(360px, 1fr) minmax(420px, 1.2fr);"
            + "gap:14px;margin-top:10px;"
        this._orsSandboxScenarioHost = this._buildOrsSandboxScenarioCard(route, scenario)
        this._orsSandboxResultsHost  = this._buildOrsSandboxResultsCard(this._orsSandboxResult, route)
        body.append(this._orsSandboxScenarioHost, this._orsSandboxResultsHost)
        this.tableHost.append(body)

        this.tableHost.append(this._buildOrsSandboxNotes(this._orsSandboxResult))
    }

    /**
     * Header strip for the sandbox: title · route label · "Pick another"
     * button · open-on-AS link. Always present, before the picker or body.
     */
    _buildOrsSandboxHeader(sorted) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 10px;"
            + "background:rgba(100,116,139,0.10);border:1px solid rgba(100,116,139,0.35);"
            + "border-radius:4px;color:#e5e7eb;font-size:12px;"
        const title = document.createElement("strong")
        title.textContent = "🧪 ORS Sandbox"
        wrap.append(title)

        const route = this._orsSandboxRoute
        if (route && route.dest) {
            const label = document.createElement("span")
            label.textContent = " · " + String(this.hubIata || "").toUpperCase() + " → " + String(route.dest).toUpperCase()
            label.style.color = "#cbd5e1"
            wrap.append(label)

            const link = document.createElement("a")
            link.textContent = "↗ Open route in AS"
            link.href = "/app/com/scheduling/" + String(this.hubIata || "").toUpperCase() + String(route.dest).toUpperCase()
            link.target = "_blank"
            link.style.cssText = "margin-left:6px;color:#60a5fa;text-decoration:none;font-size:11px;"
            wrap.append(link)

            const pick = document.createElement("button")
            pick.textContent = "Pick another"
            pick.style.cssText = "margin-left:auto;background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
                + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;"
            pick.addEventListener("click", () => {
                this._orsSandboxRoute = null
                this._orsSandboxResult = null
                this._render()
            })
            wrap.append(pick)
        } else {
            const hint = document.createElement("span")
            hint.style.color = "#9ca3af"
            hint.textContent = " · Pick a route to begin."
            wrap.append(hint)
        }

        const help = document.createElement("span")
        help.textContent = " · read-only · sourced from cache"
        help.style.cssText = "color:#6b7280;font-size:10px;"
        wrap.append(help)

        return wrap
    }

    /**
     * Route picker — dropdown of every visible row that has cached ORS
     * data, sorted by score. Selecting a route stores it on
     * `_orsSandboxRoute` and re-renders.
     */
    _buildOrsSandboxRoutePicker(sorted) {
        const candidates = (sorted || []).filter(r => r.orsByClass && Object.keys(r.orsByClass).length)
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:14px;padding:14px;border:1px solid #475569;border-radius:4px;"
            + "background:rgba(15,22,35,0.7);color:#e5e7eb;"
        const title = document.createElement("div")
        title.style.cssText = "font-size:12px;color:#cbd5e1;margin-bottom:8px;"
        if (!candidates.length) {
            title.innerHTML = "<strong>No routes have cached ORS data yet.</strong> " +
                "Open Settings (⚙) → ORS Rank → Sync ORS rank for all visible routes, " +
                "then return here to pick a route."
            wrap.append(title)
            return wrap
        }
        title.innerHTML = "<strong>Pick a route to simulate.</strong> " +
            "Routes are sorted by current score. Only routes with cached ORS data are listed " +
            "(<span style='color:#9ca3af;'>" + candidates.length + " of " + (sorted || []).length + " visible</span>)."
        wrap.append(title)

        const sel = document.createElement("select")
        sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;"
            + "padding:4px 6px;font-size:12px;width:100%;max-width:520px;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "— select a route —"
        placeholder.selected = true
        sel.append(placeholder)
        for (const r of candidates) {
            const opt = document.createElement("option")
            opt.value = r.destIata
            const score = (typeof r.score === "number") ? Math.round(r.score) : "—"
            opt.textContent = String(r.destIata).toUpperCase() + " · " + (r.destName || "")
                + "  (score " + score + ")"
            sel.append(opt)
        }
        sel.addEventListener("change", () => {
            const dest = sel.value
            if (!dest) return
            const row = candidates.find(r => r.destIata === dest)
            if (!row) return
            this._orsSandboxRoute = {hub: this.hubIata, dest: row.destIata, _row: row}
            this._orsSandboxResult = null
            // Persist last-used route.
            const cfg = Object.assign({}, this.settings.orsSandbox || {})
            cfg.lastRouteIata = row.destIata
            this.settings.orsSandbox = cfg
            RouteAssistantSettings.save({orsSandbox: cfg}).catch(() => {})
            this._render()
        })
        wrap.append(sel)
        return wrap
    }

    /**
     * Banner shown when a route is picked but has no cached ORS data
     * (rare — picker filters these out, but possible if cache expired
     * between selection and render).
     */
    _buildOrsSandboxNoOrsBanner(row) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:14px;padding:14px;border:1px dashed #475569;border-radius:4px;"
            + "background:rgba(100,116,139,0.08);color:#cbd5e1;font-size:12px;line-height:1.5;"
        wrap.innerHTML = "<strong>No ORS data cached for this route.</strong><br>"
            + "The sandbox needs at least one cabin class scraped from /app/info/ors. "
            + "Open Settings (⚙) → ORS Rank → Sync ORS rank for all visible routes, "
            + "then re-pick the route."
        return wrap
    }

    /**
     * Scenario controls card — three sliders (Y price multiplier, freq,
     * comfort) + Calibrate-T affordance. Each slider's input handler
     * persists the new scenario (debounced via storage save) and kicks
     * the rAF-coalesced recompute.
     */
    _buildOrsSandboxScenarioCard(route, scenario) {
        const card = document.createElement("div")
        card.style.cssText = "padding:12px;border:1px solid rgba(100,116,139,0.35);border-radius:4px;"
            + "background:rgba(15,22,35,0.45);color:#e5e7eb;font-size:12px;"
        const h = document.createElement("div")
        h.style.cssText = "color:#cbd5e1;margin-bottom:8px;"
        h.innerHTML = "<strong>Scenario</strong> <span style='color:#6b7280;font-size:11px;'>"
            + "— sliders re-project live</span>"
        card.append(h)

        // ----- Per-class price multiplier sliders -----------------------
        // Render one slider per cabin class with a cached observed fare.
        // Routes with only Y cached collapse to a single slider, visually
        // identical to slice 1.
        const prices = (route.ownPricing && route.ownPricing.prices) || {}
        const observedByCls = {Y: prices.Y || null, C: prices.C || null, F: prices.F || null}
        const sliders = {}
        const readouts = {}
        for (const cls of ["Y", "C", "F"]) {
            const observed = observedByCls[cls]
            if (observed == null) continue
            const initial = Number(scenario.priceMultipliers && scenario.priceMultipliers[cls]) || 1
            const built   = this._buildOrsSandboxPriceSliderRow(cls, observed, initial)
            sliders[cls]  = built.slider
            readouts[cls] = built.updateReadout
            card.append(built.row)
        }

        // ----- Cargo multiplier slider (slice 2d) -----------------------
        // Renders only when CARGO connection list is cached. Scales the
        // cargo yield only — no rating/share shift modelled.
        const hasCargo = !!(route.orsByClass && route.orsByClass.CARGO
            && Array.isArray(route.orsByClass.CARGO.connections)
            && route.orsByClass.CARGO.connections.length)
        let cargoSlider = null
        let cargoReadout = null
        const cargoPool = Number(route.cargoDemandPool)
        if (hasCargo || (isFinite(cargoPool) && cargoPool > 0)) {
            const cargoRow = this._mkOrsSandboxRow("Cargo yield",
                "scales cargo yield only · no rating shift")
            cargoSlider = document.createElement("input")
            cargoSlider.type = "range"
            cargoSlider.min = "0.30"
            cargoSlider.max = "3.00"
            cargoSlider.step = "0.01"
            cargoSlider.value = String(Number(scenario.cargoMultiplier) || 1.0)
            cargoSlider.style.cssText = "width:100%;accent-color:#10b981;"
            const cargoOut = document.createElement("span")
            cargoOut.style.cssText = "color:#cbd5e1;font-variant-numeric:tabular-nums;font-size:11px;min-width:80px;text-align:right;"
            cargoReadout = () => {
                const m = Number(cargoSlider.value) || 1
                cargoOut.textContent = m.toFixed(2) + "x"
            }
            cargoReadout()
            cargoRow.append(cargoSlider, cargoOut)
            card.append(cargoRow)
        }

        // ----- Frequency input ------------------------------------------
        const baseFreq = Number(route.currentFrequency) || 0
        const freqWrap = this._mkOrsSandboxRow("Frequency",
            baseFreq ? baseFreq + "/wk current" : "no scheduled flights")
        const freqInput = document.createElement("input")
        freqInput.type = "number"
        freqInput.min = "0"
        freqInput.max = "200"
        freqInput.step = "1"
        freqInput.value = String(scenario.frequency != null ? scenario.frequency : baseFreq)
        freqInput.style.cssText = "width:80px;background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;"
        const freqHint = document.createElement("span")
        freqHint.style.cssText = "color:#6b7280;font-size:10px;margin-left:6px;"
        freqHint.textContent = "/wk · synthesises own-connections when above current"
        freqWrap.append(freqInput, freqHint)
        card.append(freqWrap)

        // ----- Comfort selector -----------------------------------------
        const comfortWrap = this._mkOrsSandboxRow("Comfort",
            "−2 budget … 0 standard … +2 premium")
        const comfortSel = document.createElement("select")
        comfortSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;"
        const cd = Number(scenario.comfortDelta) || 0
        for (const v of [-2, -1, 0, 1, 2]) {
            const o = document.createElement("option")
            o.value = String(v)
            const labels = {"-2": "−2 (budget)", "-1": "−1", "0": "0 (current)", "1": "+1", "2": "+2 (premium)"}
            o.textContent = labels[String(v)]
            if (v === cd) o.selected = true
            comfortSel.append(o)
        }
        comfortWrap.append(comfortSel)
        card.append(comfortWrap)

        // ----- Live recompute wiring ------------------------------------
        const onChange = () => {
            const pm = {Y: 1, C: 1, F: 1}
            for (const cls of ["Y", "C", "F"]) {
                if (sliders[cls]) pm[cls] = Number(sliders[cls].value) || 1
            }
            const cargoMult = cargoSlider ? (Number(cargoSlider.value) || 1) : 1
            this._recomputeOrsSandbox({
                priceMultipliers: pm,
                cargoMultiplier:  cargoMult,
                frequency:        Number(freqInput.value),
                comfortDelta:     Number(comfortSel.value) || 0
            })
        }
        for (const cls of ["Y", "C", "F"]) {
            if (!sliders[cls]) continue
            sliders[cls].addEventListener("input", () => { readouts[cls](); onChange() })
        }
        if (cargoSlider) {
            cargoSlider.addEventListener("input", () => { cargoReadout(); onChange() })
        }
        freqInput.addEventListener("input",   onChange)
        comfortSel.addEventListener("change", onChange)

        // ----- Calibrate T affordance + per-route T banner --------------
        const calibrateRow = document.createElement("div")
        calibrateRow.style.cssText = "margin-top:10px;padding-top:10px;border-top:1px solid rgba(100,116,139,0.30);"
            + "display:flex;flex-direction:column;gap:6px;"
        const tBanner = document.createElement("div")
        tBanner.style.cssText = "color:#9ca3af;font-size:10px;"
        const calBtn = document.createElement("button")
        calBtn.textContent = "Calibrate T from this route's actual share"
        calBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
            + "border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;align-self:flex-start;"
        calBtn.addEventListener("click", () => this._calibrateOrsSandboxT(route, tBanner))

        calibrateRow.append(calBtn, tBanner)
        this._orsSandboxTBanner = tBanner
        this._refreshOrsSandboxTBanner(route)
        card.append(calibrateRow)

        return card
    }

    /** Small label + sublabel + control container row. */
    _mkOrsSandboxRow(label, sublabel) {
        const row = document.createElement("div")
        row.style.cssText = "margin:6px 0;display:flex;flex-direction:column;gap:2px;"
        const lab = document.createElement("div")
        lab.style.cssText = "color:#cbd5e1;font-size:11px;"
        lab.innerHTML = "<strong>" + label + "</strong> "
            + "<span style='color:#6b7280;font-weight:normal;font-size:10px;'>" + sublabel + "</span>"
        row.append(lab)
        const inner = document.createElement("div")
        inner.style.cssText = "display:flex;align-items:center;gap:8px;"
        row.append(inner)
        // The caller appends its inputs to the inner div via row.append (last child).
        // We expose `append` on the row that forwards to inner for ergonomics.
        const origAppend = row.append.bind(row)
        row.append = (...nodes) => { inner.append(...nodes) }
        row.appendOuter = (...nodes) => origAppend(...nodes)
        return row
    }

    /**
     * Build one price-multiplier slider for a cabin class. Returns
     * `{row, slider, updateReadout}` — caller wires `slider`'s input
     * event to call `updateReadout()` then trigger a recompute.
     */
    _buildOrsSandboxPriceSliderRow(cls, observed, initialValue) {
        const labels = {Y: "Y price", C: "C price", F: "F price"}
        const row = this._mkOrsSandboxRow(labels[cls] || (cls + " price"),
            "$" + Math.round(observed) + " baseline")
        const slider = document.createElement("input")
        slider.type = "range"
        slider.min = "0.30"
        slider.max = "3.00"
        slider.step = "0.01"
        slider.value = String(initialValue || 1.0)
        slider.style.cssText = "width:100%;accent-color:#60a5fa;"
        const readout = document.createElement("span")
        readout.style.cssText = "color:#cbd5e1;font-variant-numeric:tabular-nums;font-size:11px;min-width:80px;text-align:right;"
        const updateReadout = () => {
            const m = Number(slider.value) || 1
            const newPrice = Math.round(observed * m)
            readout.textContent = "$" + newPrice + " (" + m.toFixed(2) + "x)"
        }
        updateReadout()
        row.append(slider, readout)
        return {row, slider, updateReadout}
    }

    _refreshOrsSandboxTBanner(route) {
        if (!this._orsSandboxTBanner) return
        const cfg = (this.settings && this.settings.orsSandbox) || {}
        const key = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest || "").toUpperCase()
        const perRouteT = cfg.perRouteTemperature && cfg.perRouteTemperature[key]
        const calibratedAt = cfg.perRouteTemperatureCalibratedAt && cfg.perRouteTemperatureCalibratedAt[key]
        const globalT = (cfg.modelParams && cfg.modelParams.shareTemperature) || 25
        if (perRouteT != null) {
            // Surface calibration age. Markets drift — a 30-day-old T is
            // worth re-running. Color the age badge amber/red as it crosses
            // the staleness thresholds (30d / 90d).
            let ageHtml = ""
            if (calibratedAt) {
                const ageDays = Math.max(0, Math.round((Date.now() - calibratedAt) / 86400000))
                const stale   = ageDays >= 30
                const ancient = ageDays >= 90
                const ageColor = ancient ? "#fca5a5" : (stale ? "#fbbf24" : "#6b7280")
                const suffix   = ancient ? " — recalibrate" : (stale ? " — consider recalibrating" : "")
                ageHtml = " <span style='color:" + ageColor + ";'>· calibrated "
                    + (ageDays === 0 ? "today" : ageDays + "d ago") + suffix + "</span>"
            } else {
                ageHtml = " <span style='color:#6b7280;'>· calibration age unknown</span>"
            }
            this._orsSandboxTBanner.innerHTML = "Using calibrated T = <strong>" + perRouteT + "</strong> "
                + "<span style='color:#6b7280;'>for this route · global T = " + globalT + "</span>"
                + ageHtml
                + " <a href='#' data-action='reset-t' style='color:#fbbf24;text-decoration:none;'>[reset]</a>"
            const resetLink = this._orsSandboxTBanner.querySelector("[data-action='reset-t']")
            if (resetLink) resetLink.addEventListener("click", async (e) => {
                e.preventDefault()
                const next       = Object.assign({}, cfg.perRouteTemperature || {})
                const nextStamps = Object.assign({}, cfg.perRouteTemperatureCalibratedAt || {})
                delete next[key]
                delete nextStamps[key]
                this.settings.orsSandbox = Object.assign({}, cfg, {
                    perRouteTemperature:             next,
                    perRouteTemperatureCalibratedAt: nextStamps
                })
                await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox}).catch(() => {})
                this._orsSandboxResult = null
                this._render()
            })
        } else {
            this._orsSandboxTBanner.textContent = "Using global T = " + globalT
                + " (sets the share/rating sensitivity; lower = sharper share-by-rank)"
        }
    }

    /**
     * Results card — three columns: baseline / projected / Δ for
     * rating, rank, share, pax/wk, rev/wk, profit/wk.
     */
    _buildOrsSandboxResultsCard(result, route) {
        const card = document.createElement("div")
        card.style.cssText = "padding:12px;border:1px solid rgba(100,116,139,0.35);border-radius:4px;"
            + "background:rgba(15,22,35,0.45);color:#e5e7eb;font-size:12px;"
        const h = document.createElement("div")
        h.style.cssText = "color:#cbd5e1;margin-bottom:8px;"
        h.innerHTML = "<strong>Outcome</strong> "
            + "<span style='color:#6b7280;font-size:11px;'>— baseline · projected · Δ</span>"
        card.append(h)

        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
        const renderRow = (label, fmtKey, baseVal, projVal, deltaVal, tooltip, annotation) => {
            const tr = document.createElement("tr")
            const cells = []
            const lab = document.createElement("td")
            lab.style.cssText = "padding:3px 6px;color:#9ca3af;width:90px;"
            lab.textContent = label
            if (tooltip) lab.title = tooltip
            cells.push(lab)
            const fmt = this._formatOrsSandboxValue.bind(this)
            // Base + Projected cells. Annotation (e.g. clamp marker) attaches to the projected cell.
            const slots = [{v: baseVal, isProjected: false}, {v: projVal, isProjected: true}]
            for (const slot of slots) {
                const td = document.createElement("td")
                td.style.cssText = "padding:3px 6px;text-align:right;font-variant-numeric:tabular-nums;color:#e5e7eb;"
                td.textContent = fmt(slot.v, fmtKey)
                if (slot.isProjected && annotation && annotation.marker) {
                    td.textContent = td.textContent + annotation.marker
                    td.style.color = "#fbbf24"
                    if (annotation.tooltip) td.title = annotation.tooltip
                }
                cells.push(td)
            }
            const dtd = document.createElement("td")
            dtd.style.cssText = "padding:3px 6px;text-align:right;font-variant-numeric:tabular-nums;width:80px;"
            const dStr = fmt(deltaVal, fmtKey, true)
            dtd.textContent = dStr
            if (typeof deltaVal === "number" && isFinite(deltaVal)) {
                dtd.style.color = deltaVal > 0 ? "#34d399" : (deltaVal < 0 ? "#f87171" : "#9ca3af")
            } else {
                dtd.style.color = "#6b7280"
            }
            cells.push(dtd)
            for (const c of cells) tr.append(c)
            return tr
        }
        const head = document.createElement("tr")
        for (const t of ["", "Base", "Projected", "Δ"]) {
            const th = document.createElement("th")
            th.style.cssText = "padding:3px 6px;color:#6b7280;font-weight:normal;text-align:right;border-bottom:1px solid rgba(100,116,139,0.3);"
            if (t === "") th.style.textAlign = "left"
            th.textContent = t
            head.append(th)
        }
        tbl.append(head)

        const baseline = (result && result.baseline) || {}
        const projected = (result && result.projected) || {}
        const delta = (result && result.delta) || {}

        // Rank — only show the most useful flavor (`nonstop` if any, else `any`).
        const baseRank = (baseline.rank && (baseline.rank.nonstop != null ? baseline.rank.nonstop : baseline.rank.any)) || null
        const projRank = (projected.rank && (projected.rank.nonstop != null ? projected.rank.nonstop : projected.rank.any)) || null
        const rankDelta = (typeof baseRank === "number" && typeof projRank === "number") ? (projRank - baseRank) : null

        const ratingAnnotation = this._clampedClasses(result)
        tbl.append(renderRow("Rating",     "rating", baseline.rating,        projected.rating,        delta.rating, "Our top per-class rating from the cached connection list. Projection applies a linear-in-percent rating shift then clamps to ±50% of the baseline.", ratingAnnotation))
        tbl.append(renderRow("Rank",       "rank",   baseRank,               projRank,                rankDelta != null ? -rankDelta : null, "Rank in the ORS connection list for the primary class (nonstop preferred over any). Lower rank position = better, so Δ is sign-flipped here."))
        tbl.append(renderRow("Share",      "share",  baseline.share,         projected.share,         delta.share, "Numeric-stable softmax over connection ratings, summed across our connections. Default temperature T=25; calibrate per-route from the markets-page leaderboard."))
        tbl.append(renderRow("Pax/wk",     "pax",    baseline.paxPerWeek,    projected.paxPerWeek,    delta.paxPerWeek, "Demand pool × projected share. Pool comes from the markets-page historic chart; price-side elasticity (from demand-derivator) shifts the pool proportionally to (newPrice/observedPrice)^elasticity."))
        if (baseline.cargoPerWeek != null || projected.cargoPerWeek != null) {
            tbl.append(renderRow("Cargo/wk", "pax", baseline.cargoPerWeek, projected.cargoPerWeek, delta.cargoPerWeek, "Cargo demand pool × projected cargo share. Cargo multiplier scales yield only — share doesn't shift with price in the current model."))
        }
        tbl.append(renderRow("Revenue/wk", "money",  baseline.revenuePerWeek, projected.revenuePerWeek, delta.revenuePerWeek, "Estimator's revenue × frequency. Override paxLF = projected pax/(seats×freq), override yieldPerKm = newPriceY/distance. Cargo revenue folds in via cargoLoadFactor × effectiveCargoYield × distance."))
        tbl.append(renderRow("Profit/wk",  "money",  baseline.profitPerWeek,  projected.profitPerWeek,  delta.profitPerWeek, "Estimator's profit × frequency. Costs unchanged; revenue moves with both price and projected pax."))

        card.append(tbl)
        return card
    }

    /** Format a number for the Outcome card by metric type. */
    _formatOrsSandboxValue(v, key, isDelta) {
        if (v == null || !isFinite(v)) return "—"
        const sign = isDelta ? (v > 0 ? "+" : (v < 0 ? "" : "")) : ""
        if (key === "rating") return sign + (Math.round(v * 10) / 10)
        if (key === "rank")   return (sign === "+" ? "" : sign) + (v >= 0 ? "#" + Math.round(v) : Math.round(v))   // ranks shown as #N; deltas plain
        if (key === "share")  return sign + (Math.round(v * 1000) / 10) + "%"
        if (key === "pax")    return sign + Math.round(v)
        if (key === "money")  return sign + "$" + Math.round(v).toLocaleString()
        return sign + String(v)
    }

    /**
     * Detect classes whose projected rating clamped at the ±50% guardrail.
     * Returns `{marker, tooltip}` for the projected rating cell, or null
     * when no class clamped. Threshold matches RATING_CLAMP_LOW/HIGH = 0.5/1.5.
     */
    _clampedClasses(result) {
        const perClass = result && result.perClass
        if (!perClass) return null
        const hits = []
        for (const cls of ["Y", "C", "F"]) {
            const pc = perClass[cls]
            if (!pc || !isFinite(Number(pc.priceRatio))) continue
            const r = Number(pc.priceRatio)
            if (r <= -0.5)      hits.push(cls + " (−50% floor)")
            else if (r >= 0.5)  hits.push(cls + " (+50% ceiling)")
        }
        if (!hits.length) return null
        return {
            marker:  "*",
            tooltip: "Rating clamped at ±50% of baseline for: " + hits.join(", ")
        }
    }

    /** Footer notes — every fallback / clamp / data-gap surfaced by the model. */
    _buildOrsSandboxNotes(result) {
        const notes = (result && result.notes) || []
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:8px 10px;background:rgba(15,22,35,0.45);"
            + "border:1px solid rgba(100,116,139,0.25);border-radius:4px;color:#9ca3af;font-size:10px;"
        if (!notes.length) {
            wrap.textContent = "No model caveats."
            return wrap
        }
        const heading = document.createElement("div")
        heading.style.cssText = "color:#cbd5e1;margin-bottom:4px;"
        heading.innerHTML = "<strong>Model notes (" + notes.length + ")</strong>"
        wrap.append(heading)
        const ul = document.createElement("ul")
        ul.style.cssText = "margin:0;padding-left:18px;line-height:1.5;"
        for (const n of notes) {
            const li = document.createElement("li")
            li.textContent = n
            ul.append(li)
        }
        wrap.append(ul)
        return wrap
    }

    /**
     * Pull every cached field the model needs into a single bundle. Reads
     * from the row decorations (`row.orsByClass`, `row.ownPricing`, etc.)
     * + the panel's `_fleetContext` for the spec/economics half.
     */
    _assembleOrsSandboxRoute(row) {
        if (!row) return {}
        const ctx = (typeof this._fleetContext === "function") ? this._fleetContext() : null
        const spec = (ctx && ctx.selectedSpec) || row.aircraftSpec || null
        // Resolve currentFrequency from row.weeklyFlights or row.ownTotalFreq.
        const currentFreq = row.ownTotalFreq != null ? row.ownTotalFreq
            : (row.weeklyFlights != null ? row.weeklyFlights : 0)
        // Our enterprise id — pulled from the carriers settings myEnterpriseIds (first entry).
        let ourEnterpriseId = null
        const myIds = (this.settings && this.settings.carriers && this.settings.carriers.myEnterpriseIds) || []
        if (myIds.length) ourEnterpriseId = myIds[0]
        return {
            hub:                this.hubIata,
            dest:               row.destIata,
            distanceKm:         row.distanceKm,
            ownPricing:         row.ownPricing ? {prices: row.ownPricing, defaults: row.ownPriceDefaults || null} : null,
            orsByClass:         row.orsByClass || {},
            marketSharePax:     row.marketSharePax || [],
            ourEnterpriseId:    ourEnterpriseId,
            ourFlightIds:       row.orsOurFlightIds || [],
            ourCarrierPrefixes: row.orsOurCarrierPrefixes || [],
            spec:               spec,
            currentFrequency:   currentFreq,
            paxDemandPool:      row.paxDemandPool != null ? row.paxDemandPool : null,
            cargoDemandPool:    row.cargoDemandPool != null ? row.cargoDemandPool : null,
            paxElasticity:      row.paxElasticity != null ? row.paxElasticity : null,
            cargoElasticity:    row.cargoElasticity != null ? row.cargoElasticity : null,
            paxScore:           row.paxScore,
            cargoScore:         row.cargoScore,
            aircraftAge:        spec && spec.aircraftAge,
            falloffPct:         (this.settings && this.settings.aircraft && this.settings.aircraft.falloffPct) || 10,
            useDistanceFuel:    !!(this.settings && this.settings.economics && this.settings.economics.fuelPriceAutoEnabled),
            fuelPriceASc:       row.fuelPriceASc != null ? row.fuelPriceASc : null
        }
    }

    /**
     * rAF-coalesced recompute. Cancels any pending frame and schedules a
     * single project() + result-card swap on the next animation frame.
     * Persists the new scenario to settings (debounced via storage).
     */
    _recomputeOrsSandbox(scenario) {
        // Persist scenario opportunistically, keyed per-route. Storage saves
        // coalesce naturally via the timer below. Drop the legacy global
        // fields (`lastScenario`, `_legacyLastScenario`) on first save so
        // they don't keep round-tripping after the migration.
        const cfg = Object.assign({}, this.settings.orsSandbox || {})
        delete cfg.lastScenario
        delete cfg._legacyLastScenario
        const route = this._orsSandboxRoute
        if (route && route.dest) {
            const routeKey = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest).toUpperCase()
            const map = Object.assign({}, cfg.lastScenarioByRoute || {})
            map[routeKey] = RouteAssistantOrsModel._normaliseScenario(scenario)
            cfg.lastScenarioByRoute = map
        }
        this.settings.orsSandbox = cfg
        // Fire-and-forget save — failure is non-fatal, we'll just not persist.
        clearTimeout(this._orsSandboxSaveTimer)
        this._orsSandboxSaveTimer = setTimeout(() => {
            RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox}).catch(() => {})
        }, 250)

        if (this._orsSandboxRaf) cancelAnimationFrame(this._orsSandboxRaf)
        this._orsSandboxRaf = requestAnimationFrame(() => {
            this._orsSandboxRaf = 0
            const route = this._orsSandboxRoute && this._orsSandboxRoute._row
                ? this._assembleOrsSandboxRoute(this._orsSandboxRoute._row)
                : null
            if (!route) return
            const key = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest || "").toUpperCase()
            const cfgNow = (this.settings && this.settings.orsSandbox) || {}
            this._orsSandboxResult = RouteAssistantOrsModel.project({
                route:              route,
                scenario:           scenario,
                modelParams:        Object.assign({}, cfgNow.modelParams || {},
                    {perRouteT: (cfgNow.perRouteTemperature || {})[key]}),
                economics:          this.settings.economics || {},
                useRealDemandForLF: !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
            })
            // Swap just the results card + notes — leaves the controls card alone
            // (preserves slider drag focus + cursor position).
            if (this._orsSandboxResultsHost && this._orsSandboxResultsHost.parentNode) {
                const next = this._buildOrsSandboxResultsCard(this._orsSandboxResult, route)
                this._orsSandboxResultsHost.parentNode.replaceChild(next, this._orsSandboxResultsHost)
                this._orsSandboxResultsHost = next
            }
            // Notes footer is the last child of tableHost — replace it too.
            const lastChild = this.tableHost.lastChild
            if (lastChild && lastChild.previousElementSibling) {
                const newNotes = this._buildOrsSandboxNotes(this._orsSandboxResult)
                this.tableHost.replaceChild(newNotes, lastChild)
            }
        })
    }

    /**
     * Solve T from the cached marketShare leaderboard observation for
     * this route. Refuses calibration if marketShare is missing, the
     * user's enterprise isn't in the leaderboard, or the freshness
     * window between marketShare and ORS data is > 7 days.
     */
    async _calibrateOrsSandboxT(route, banner) {
        const out = (msg, ok) => {
            if (!banner) return
            banner.style.color = ok ? "#34d399" : "#fbbf24"
            banner.textContent = msg
            setTimeout(() => this._refreshOrsSandboxTBanner(route), 6000)
        }
        const mkt = route.marketSharePax
        const ourId = route.ourEnterpriseId
        if (!mkt || !mkt.length) return out("Calibration unavailable — no market-share data cached for this route.", false)
        if (!ourId) return out("Calibration unavailable — set your enterprise id in Settings → Carriers → Contractual partners.", false)
        const ourRow = RouteAssistantOrsModel.findOurInLeaderboard(mkt, ourId)
        if (!ourRow) return out("Your enterprise (id " + ourId + ") isn't in this route's leaderboard. Confirm Settings → Carriers → my enterprise IDs.", false)
        const observedShare = (ourRow.sharePct != null) ? Number(ourRow.sharePct) / 100 : null
        if (observedShare == null || !isFinite(observedShare)) return out("Calibration unavailable — leaderboard row has no share%.", false)

        // Use the primary class connection list (Y first, then C, then F).
        const byClass = route.orsByClass || {}
        const primaryClass = byClass.ECONOMY || byClass.BUSINESS || byClass.FIRST
        if (!primaryClass || !Array.isArray(primaryClass.connections) || !primaryClass.connections.length) {
            return out("Calibration unavailable — no ORS connection list cached for any class.", false)
        }

        // Build the ratings array + ourIndices the same way the model does.
        const conns = primaryClass.connections.slice(0, RouteAssistantOrsModel.MAX_FOR_SOFTMAX)
        const ratings = conns.map(c => Number(c.rating) || 0)
        const ourIndices = []
        for (let i = 0; i < conns.length; i++) {
            const legs = (conns[i].legs || []).filter(l => !l.isGround)
            if (legs.length && legs.every(l => !!l.isOurs)) ourIndices.push(i)
        }
        if (!ourIndices.length) return out("Calibration unavailable — no own connections in the ORS data.", false)

        const T = RouteAssistantOrsModel.calibrateTemperature({
            allRatings:    ratings,
            ourIndices:    ourIndices,
            observedShare: observedShare
        })
        if (T == null || !isFinite(T)) return out("Calibration failed — solver did not converge.", false)

        // Persist per-route T + the calibration timestamp so the results
        // card can flag stale calibrations (markets drift; 30+ day-old
        // calibrations should be re-run when new marketShare lands).
        const cfg = Object.assign({}, this.settings.orsSandbox || {})
        const map = Object.assign({}, cfg.perRouteTemperature || {})
        const tsMap = Object.assign({}, cfg.perRouteTemperatureCalibratedAt || {})
        const key = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest || "").toUpperCase()
        map[key] = T
        tsMap[key] = Date.now()
        cfg.perRouteTemperature = map
        cfg.perRouteTemperatureCalibratedAt = tsMap
        this.settings.orsSandbox = cfg
        try { await RouteAssistantSettings.save({orsSandbox: cfg}) } catch (e) { /* non-fatal */ }
        out("Calibrated T = " + T + " (from " + (Math.round(observedShare * 1000) / 10) + "% observed share). Re-projecting…", true)
        if (typeof RouteAssistantToast !== "undefined") {
            const routeKey = String(this.hubIata || "").toUpperCase() + "→" + String(route.dest || "").toUpperCase()
            RouteAssistantToast.success("Calibrated T = " + T + " for " + routeKey, {duration: 5000})
        }
        this._orsSandboxResult = null
        this._render()
    }

    /**
     * Persist the visible scored rows to `routeAssistant:topRoutes` so
     * other features (Used Aircraft Scanner) can score offers against
     * the user's current hub priorities without re-running the whole
     * RA pipeline. Single global key — overwritten on every render.
     * Only the fields downstream features need are kept, to bound the
     * write size.
     */
    _publishTopRoutes(visible) {
        if (!this.hubIata) return
        const fin = v => typeof v === "number" && isFinite(v)
        const slim = (visible || []).slice(0, 50).map(r => ({
            destIata:      r.destIata,
            destName:      r.destName,
            distanceKm:    fin(r.distanceKm)    ? r.distanceKm    : null,
            score:         fin(r.score)         ? r.score         : null,
            status:        r.status || null,
            paxScore:      fin(r.paxScore)      ? r.paxScore      : null,
            cargoScore:    fin(r.cargoScore)    ? r.cargoScore    : null,
            weeklyFlights: fin(r.weeklyFlights) ? r.weeklyFlights : null  // real-world wfl,
                                                                          // consumed by Used Aircraft Scanner
                                                                          // route-fit (J slice 4)
        }))
        const blob = {
            hub:       this.hubIata,
            server:    this.server,
            scrapedAt: Date.now(),
            count:     slim.length,
            rows:      slim
        }
        // Fire-and-forget; failures here mustn't break the panel render.
        try {
            chrome.storage.local.set({"routeAssistant:topRoutes": blob})
        } catch (e) {
            console.warn("[AES routeAssistant] topRoutes write failed:", e)
        }
    }

    /**
     * Top-of-table banner driven by the current fleet state. Returns null
     * when nothing notable to surface. Banner priority (only the highest one
     * renders):
     *   1. No fleet found at all
     *   2. Fleet has aircraft but some/all lack typeId (older fleet records)
     *
     * The "demand cache empty" state is handled separately by
     * `_renderSeedPrompt` because it replaces the whole view.
     */
    _renderFleetBanner() {
        if (!this.fleet) return null
        if (!this.fleet.aircraft || !this.fleet.aircraft.length) {
            return makeBanner({
                level: "amber",
                title: "No fleet data found.",
                body: "Visit /app/fleets in this game world to record your aircraft. Once it's saved, this panel can score routes by range and rough profit."
            })
        }
        if (RouteAssistantFleetStore.hasMissingTypeIds(this.fleet)) {
            const missing = this.fleet.aircraft.filter(a => a && !a.typeId).length
            return makeBanner({
                level: "amber",
                title: `${missing} aircraft missing type id.`,
                body: "Open Fleet Management once to refresh aircraft data — older saves don't carry the type id needed for spec lookup."
            })
        }
        if (this.fleet.ambiguous) {
            return makeBanner({
                level: "amber",
                title: "Multiple airlines on this server.",
                body: "Picked the airline with the largest fleet. Run Extract Schedule on the airline you want to score, and the panel will pin to it next refresh."
            })
        }
        return null
    }

    /**
     * Compact status legend pill row above the table — explains what NEW /
     * OK / UNDER / OVER / OOR mean without forcing the user to hover every cell.
     * OOR is only shown when an aircraft is selected (otherwise no row will
     * carry that status).
     */
    _buildLegend() {
        const legend = document.createElement("div")
        legend.style.cssText = "display:flex;gap:10px;font-size:10px;margin:4px 0 8px 0;flex-wrap:wrap;align-items:center;"
        const intro = document.createElement("span")
        intro.textContent = "Status legend:"
        intro.style.color = "#6b7280"
        legend.append(intro)
        const shortDesc = {NEW: "you don't fly", OK: "healthy", UNDER: "scale up", OVER: "trim", OOR: "out of range"}
        const keys = ["NEW", "OK", "UNDER", "OVER"]
        if (this._fleetContext() !== null) keys.push("OOR")
        for (const k of keys) {
            const def = RouteAssistantPanel.STATUS_DEF[k]
            const wrap = document.createElement("span")
            wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;"
            wrap.title = def.description
            const tag = document.createElement("strong")
            tag.textContent = k
            tag.style.color = def.color
            const desc = document.createElement("span")
            desc.textContent = shortDesc[k] || ""
            desc.style.color = "#9ca3af"
            wrap.append(tag, desc)
            legend.append(wrap)
        }
        return legend
    }

    /**
     * Builds the route table including the group-label sub-header (AS
     * in-game / Real-world / Aircraft). Cells in each group share a subtle
     * background tint so the source of every number is obvious at a glance.
     *
     * The "aircraft" group columns are hidden when no aircraft is picked, so
     * the Phase 1 view stays compact.
     */
    _buildTable(rows) {
        const cols = this._activeColumns()

        const table = document.createElement("table")
        // border-collapse: separate (with zero spacing) keeps the visual
        // exactly the same as `collapse`, but makes `position: sticky` on
        // table cells work reliably in Chrome — collapsed-border tables
        // share borders between cells, which trips up the sticky offset
        // calculation and causes the header row to render at the wrong
        // vertical position (visible as data leaking through, even though
        // the cell backgrounds are opaque).
        table.style.cssText = "width:100%;border-collapse:separate;border-spacing:0;font-size:11px;"

        const thead = document.createElement("thead")

        // Group sub-header — collapses adjacent columns sharing a group key
        // into one <th colspan>. This relies on COLUMNS being ordered such
        // that columns of the same group are contiguous.
        //
        // Both header rows are `position: sticky` so they stay glued to the
        // top of the body (the scroll container) during vertical scroll —
        // when the user scrolls down through 100+ rows, the column labels
        // remain visible and parallel to the data underneath. The two rows
        // need explicit `top` offsets so they stack correctly: group row at
        // 0, column-header row directly under it.

        const STICKY_GROUP_BG = "#1f2937"   // panel background (opaque so rows scrolling under aren't visible through the header)
        const STICKY_GROUP_TOP = 0
        const STICKY_HEAD_TOP  = 22         // ~height of the group row at font-size:10px + padding 2px
        // Compose a sticky-safe opaque background for a column tint. The
        // COLUMN_GROUPS tints are rgba(…, 0.10–0.24) — fine for normal
        // (non-sticky) cells where the panel bg shows through naturally,
        // but transparent when sticky-positioned (data scrolling underneath
        // is visible THROUGH the sticky cell). Pre-composite the tint over
        // the opaque panel bg into a SOLID rgb() string so there's no
        // alpha to bleed through. (An earlier attempt used
        // `linear-gradient(tint, tint), bg`; in practice this still
        // showed visible tearing in Chrome — a solid color is bulletproof.)
        const PANEL_BG_RGB = [0x1f, 0x29, 0x37]   // matches STICKY_GROUP_BG = #1f2937
        const opaqueTint = (tint) => {
            if (!tint) return STICKY_GROUP_BG
            const m = String(tint).match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)/)
            if (!m) return STICKY_GROUP_BG
            const r = parseFloat(m[1]), g = parseFloat(m[2]), b = parseFloat(m[3])
            const a = (m[4] === undefined) ? 1 : parseFloat(m[4])
            const out = [
                Math.round(r * a + PANEL_BG_RGB[0] * (1 - a)),
                Math.round(g * a + PANEL_BG_RGB[1] * (1 - a)),
                Math.round(b * a + PANEL_BG_RGB[2] * (1 - a))
            ]
            return "rgb(" + out[0] + ", " + out[1] + ", " + out[2] + ")"
        }
        // The first two data columns (score + destIata) are ALSO frozen
        // sticky-left so the row identifier stays visible during horizontal
        // scroll — without this, scrolling right hides which route a row
        // represents. Approximate offsets (score ~46px wide, destIata
        // starts immediately after); the table uses table-layout: auto so
        // actual widths can drift, but the user-visible result is still
        // "the dest column never goes off-screen". The boundary column
        // gets a box-shadow so the freeze line is obvious.
        const FROZEN_FIELDS = {score: 0, destIata: 46}
        const FROZEN_LAST   = "destIata"
        const stickyLeftCss = (field, baseZ) => {
            if (!Object.prototype.hasOwnProperty.call(FROZEN_FIELDS, field)) return ""
            const left   = FROZEN_FIELDS[field]
            const shadow = (field === FROZEN_LAST) ? "box-shadow:2px 0 4px rgba(0,0,0,0.3);" : ""
            return "position:sticky;left:" + left + "px;z-index:" + baseZ + ";" + shadow
        }
        const groupRow = document.createElement("tr")
        // Solid background on the row itself so any gaps between/around
        // the TH cells (border-spacing, sub-pixel rounding, scroll
        // overshoot) are filled with the panel bg instead of letting the
        // tbody data row visible through. Without this the group-header
        // strip can look "thin" — the labels are centered and the cell
        // is opaque, but the row's TOP and BOTTOM edges may show data
        // bleeding through during scroll.
        groupRow.style.background = STICKY_GROUP_BG
        let groupTh = null
        let groupSpan = 0
        let prevGroup = null
        const groupHeaders = []   // Track for mouseenter/mouseleave wiring (U15 group-header hover).
        for (const col of cols) {
            if (col.group !== prevGroup) {
                if (groupTh) groupTh.colSpan = groupSpan
                const def = RouteAssistantPanel.COLUMN_GROUPS[col.group] || {}
                groupTh = document.createElement("th")
                groupTh.textContent = def.label || ""
                groupTh.dataset.group = col.group   // U15 — hover-highlight target
                groupTh.dataset.groupHeader = "1"
                // Single solid background for the whole group bar — the
                // multi-tinted version (one colour per group) was visually
                // noisy. Group identity is still readable via the labels
                // themselves and the column-level tints below.
                groupTh.style.cssText = "padding:2px 6px;font-size:10px;font-weight:600;color:#9ca3af;"
                    + "text-align:center;border-bottom:1px solid #374151;"
                    + "position:sticky;top:" + STICKY_GROUP_TOP + "px;z-index:3;"
                    + "background:" + STICKY_GROUP_BG + ";"
                    + "transition:color 120ms ease;"
                groupRow.append(groupTh)
                groupHeaders.push(groupTh)
                prevGroup = col.group
                groupSpan = 0
            }
            groupSpan++
        }
        if (groupTh) groupTh.colSpan = groupSpan
        thead.append(groupRow)

        // Column header — clickable for sort. Frozen columns get sticky-left
        // (z-index 4) on top of the regular sticky-top (z-index 2) so they
        // stay visible during both vertical AND horizontal scroll.
        const tr = document.createElement("tr")
        // Solid row background — same reason as groupRow above. Cell tints
        // still render on top of this via their own `background:` declarations.
        tr.style.background = STICKY_GROUP_BG
        for (const col of cols) {
            const th = document.createElement("th")
            th.textContent = col.label + (this.sortField === col.field
                ? (this.sortDir === 1 ? " ▲" : " ▼") : "")
            th.dataset.group = col.group   // U15 — column band marker
            const tint    = (RouteAssistantPanel.COLUMN_GROUPS[col.group] || {}).tint
            const frozen  = stickyLeftCss(col.field, 4)
            th.style.cssText = "padding:4px 6px;border-bottom:1px solid #374151;cursor:pointer;"
                + "text-align:" + (col.align || "left") + ";white-space:nowrap;"
                + (frozen
                    ? "position:sticky;top:" + STICKY_HEAD_TOP + "px;left:" + FROZEN_FIELDS[col.field] + "px;z-index:4;"
                      + ((col.field === FROZEN_LAST) ? "box-shadow:2px 0 4px rgba(0,0,0,0.3);" : "")
                    : "position:sticky;top:" + STICKY_HEAD_TOP + "px;z-index:2;")
                + "background:" + opaqueTint(tint) + ";"
            th.title = col.title || col.label
            th.addEventListener("click", () => {
                if (this.sortField === col.field) this.sortDir = -this.sortDir
                else { this.sortField = col.field; this.sortDir = col.defaultDir || -1 }
                this._render()
            })
            tr.append(th)
        }
        thead.append(tr)
        table.append(thead)

        // U15 — group-header hover highlights every cell in that group's
        // column band. Pure JS rather than CSS because there's no built-in
        // selector for "every cell sharing a column-group attribute"; we
        // toggle a class on each matching cell instead.
        for (const gh of groupHeaders) {
            const groupName = gh.dataset.group
            gh.addEventListener("mouseenter", () => {
                for (const el of table.querySelectorAll('[data-group="' + groupName + '"]')) {
                    el.classList.add("aes-grp-hover")
                }
                gh.style.color = "#f3f4f6"
            })
            gh.addEventListener("mouseleave", () => {
                for (const el of table.querySelectorAll('[data-group="' + groupName + '"]')) {
                    el.classList.remove("aes-grp-hover")
                }
                gh.style.color = "#9ca3af"
            })
        }

        const tbody = document.createElement("tbody")
        for (const row of rows) {
            const trow = document.createElement("tr")
            // Solid row background. Without this the row inherits the
            // panel-root bg through nested transparent layers, and any
            // sticky-positioned header above it can show data values
            // bleeding through. Cell tints are still rendered on top of
            // this row bg via cell-level `background:` declarations.
            trow.style.background = STICKY_GROUP_BG
            trow.style.cursor = "context-menu"
            trow.title = (trow.title || "") + (trow.title ? "\n" : "")
                + "Right-click to override LF / yield for this route."
            trow.addEventListener("contextmenu", (e) => {
                e.preventDefault()
                this._openRowContextMenu(row, e.clientX, e.clientY)
            })
            trow.addEventListener("click", (e) => {
                if (!e.target || !e.target.closest) return
                const profitTrig = e.target.closest("[data-profit-trigger='1']")
                if (profitTrig) {
                    e.preventDefault()
                    e.stopPropagation()
                    this._openProfitModifierPopover(row, profitTrig)
                    return
                }
                const svcTrig = e.target.closest("[data-service-trigger='1']")
                if (svcTrig) {
                    e.preventDefault()
                    e.stopPropagation()
                    this._openServiceConfigPopover(row, svcTrig)
                    return
                }
                const noteTrig = e.target.closest("[data-routenote-trigger='1']")
                if (noteTrig) {
                    e.preventDefault()
                    e.stopPropagation()
                    this._openRouteNotePopover(row, noteTrig)
                }
            })
            for (const col of cols) {
                const td = document.createElement("td")
                td.dataset.group = col.group   // U15 — hover-highlight target
                const tint = (RouteAssistantPanel.COLUMN_GROUPS[col.group] || {}).tint
                // Frozen columns need an explicit opaque background so
                // scrolling cells don't bleed through. Defaults to the
                // panel bg when the group has no tint. The score column
                // render closure overrides background for its colored
                // score chip — that overrides this base, which is fine
                // (the chip itself is opaque).
                const isFrozen = Object.prototype.hasOwnProperty.call(FROZEN_FIELDS, col.field)
                const stickyDecl = isFrozen
                    ? "position:sticky;left:" + FROZEN_FIELDS[col.field] + "px;z-index:1;"
                      + ((col.field === FROZEN_LAST) ? "box-shadow:2px 0 4px rgba(0,0,0,0.3);" : "")
                    : ""
                // Frozen cells need an opaque background (panel bg + tint
                // composited) so data rows scrolling under don't bleed
                // through. Non-frozen cells keep the raw tint — the panel
                // bg shows through naturally, no tearing because the cell
                // scrolls with the data.
                const bgDecl = isFrozen
                    ? "background:" + opaqueTint(tint) + ";"
                    : (tint ? "background:" + tint + ";" : "")
                td.style.cssText = "padding:3px 6px;border-bottom:1px solid #2a3444;"
                    + "text-align:" + (col.align || "left") + ";"
                    + bgDecl + stickyDecl
                col.render(td, row)
                trow.append(td)
            }
            tbody.append(trow)
        }
        table.append(tbody)
        return table
    }

    /**
     * Returns the columns visible right now. Aircraft-group columns are only
     * shown when an aircraft is selected; pricing- and actuals-group columns
     * are each gated by their own settings toggle.
     */
    _activeColumns() {
        const showAircraft = this._fleetContext() !== null
        const userCompact = !!(this.settings && this.settings.compactView)
        // Auto-compact: when the panel's effective width drops below
        // ~1100px (laptop browsers, side-by-side windows, narrow Chromes),
        // force compact mode regardless of the user's explicit toggle.
        // Heavy expander-driven groups (Pricing, Actuals, Service, Markets,
        // ORS, Demand depth) collapse to leave room for the essentials
        // (Sc, Dest, Status, paxScore/cargoScore, Distance, Pax/Cargo
        // demand, freq, profit). Sticky-left frozen columns (score +
        // destIata) keep the row identifier visible during horizontal
        // scroll inside whatever's still rendered.
        const effectiveWidth = (this.root && this.root.offsetWidth) || window.innerWidth
        const autoCompact = effectiveWidth < 1100
        const compact = userCompact || autoCompact
        // Compact view forces all heavy expander-driven groups OFF in one
        // click. Per-group settings still apply when compact is OFF.
        const showPricing  = !compact && (!this.settings || !this.settings.pricing
            ? true
            : this.settings.pricing.showPricingColumns !== false)
        const showActuals  = !compact && (!this.settings || !this.settings.yieldFeedback
            ? true
            : this.settings.yieldFeedback.showColumns !== false)
        const showMarkets  = !compact && (!this.settings || !this.settings.marketAnalysis
            ? true
            : this.settings.marketAnalysis.showColumns !== false)
        const showOrs      = !compact && (!this.settings || !this.settings.ors
            ? true
            : this.settings.ors.showColumns !== false)
        const showService  = !compact && (!this.settings || !this.settings.serviceProfiles
            ? true
            : this.settings.serviceProfiles.showServiceColumns !== false)
        const showDemand   = !compact && (!this.settings || !this.settings.demandDepth
            ? true
            : this.settings.demandDepth.showDemandColumns !== false)
        // Per-class ORS columns (Y / C / F) need an extra gate on top of
        // the ors-group gate. Compact view always hides them; user can
        // also turn them off via the More-options checkbox even in full view.
        const showOrsPerClass = !compact && (!this.settings || !this.settings.ors
            ? true
            : this.settings.ors.showPerClassColumns !== false)
        const PER_CLASS_FIELDS = {orsClassY: 1, orsClassC: 1, orsClassF: 1}
        const viewMode = this._currentViewMode()
        return RouteAssistantPanel.COLUMNS.filter(c => {
            if (c.group === "aircraft"    && !showAircraft) return false
            if (c.group === "pricing"     && !showPricing)  return false
            if (c.group === "actuals"     && !showActuals)  return false
            if (c.group === "service"     && !showService)  return false
            if (c.group === "competition" && !showMarkets)  return false
            if (c.group === "markets"     && !showMarkets)  return false
            if (c.group === "ors"         && !showOrs)      return false
            if (PER_CLASS_FIELDS[c.field]  && !showOrsPerClass) return false
            if (c.group === "demand"      && !showDemand)   return false
            // Tabbed view filter — derive `modes` via _columnModes so
            // we don't have to tag every entry in the large COLUMNS
            // array. Only paxScore / cargoScore are mode-specific
            // today; everything else shows in all three tabs.
            const modes = RouteAssistantPanel._columnModes(c)
            if (modes.indexOf(viewMode) < 0) return false
            return true
        })
    }

    /** Resolve the active view tab safely; defaults to "all". */
    _currentViewMode() {
        const v = this.settings && this.settings.viewMode
        if (v === "pax" || v === "cargo" || v === "all") return v
        return "all"
    }

    _renderEmpty(msg) {
        this.tableHost.innerHTML = ""
        const p = document.createElement("p")
        p.style.cssText = "color:#9ca3af;margin:6px 0;"
        p.textContent = msg
        this.tableHost.append(p)
    }

    _renderSeedPrompt() {
        this.tableHost.innerHTML = ""
        const box = document.createElement("div")
        box.style.cssText = "background:#1e1b4b;border:1px solid #4c1d95;border-radius:4px;padding:10px 12px;margin:6px 0;"
        const h = document.createElement("strong")
        h.textContent = "Demand cache is empty for this game world."
        h.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;"
        const p = document.createElement("p")
        p.style.cssText = "margin:0 0 8px 0;color:#d8d4f5;font-size:12px;"
        p.textContent = "AirlineSim doesn't expose per-IATA airport lookup, so the assistant needs a one-time bulk seed of every country before it can score routes. This takes 5–15 minutes; after it's done you're set permanently."
        const btn = document.createElement("button")
        btn.textContent = "Seed all countries now"
        Object.assign(btn.style, smallBtnStyle())
        btn.style.background = "#7c3aed"
        btn.addEventListener("click", () => this._seedAllCountries())
        box.append(h, p, btn)
        this.tableHost.append(box)

        // Surface the fleet banner too so the user sees both first-run gates
        // at once and can knock them out in any order.
        const fleetBanner = this._renderFleetBanner()
        if (fleetBanner) this.tableHost.append(fleetBanner)

        // Still render the table below the banner so the user can see the
        // flightsfrom data we already have. Reuses _buildTable so column
        // groups and tints look identical to the post-seed view.
        const sep = document.createElement("div")
        sep.style.cssText = "margin:10px 0 4px 0;font-size:11px;color:#9ca3af;"
        sep.textContent = "Routes (no demand scored until seeded):"
        this.tableHost.append(sep)
        this.scoredRows = this.rows.map(r => Object.assign({score: null}, r))
        const sorted = this._sortRows(this.scoredRows)
        this.tableHost.append(this._buildTable(sorted))
    }

    // ---------- Settings UI ----------

    _renderSettings() {
        this.settingsHost.innerHTML = ""

        // ----- Header
        const scoringHeader = document.createElement("div")
        scoringHeader.innerHTML = "<strong>Score weights & filters</strong>"
        scoringHeader.style.cssText = "margin-bottom:6px;"
        this.settingsHost.append(scoringHeader)

        // ----- Quick presets row
        const presetRow = document.createElement("div")
        presetRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;"
        const presetLabel = document.createElement("span")
        presetLabel.textContent = "Quick presets:"
        presetLabel.style.cssText = "color:#9ca3af;font-size:11px;"
        presetRow.append(presetLabel)
        for (const preset of RouteAssistantPanel.WEIGHT_PRESETS) {
            const btn = document.createElement("button")
            btn.textContent = preset.name
            btn.title = preset.description
            Object.assign(btn.style, smallBtnStyle())
            btn.style.background = "#475569"
            btn.style.fontSize = "10px"
            btn.style.padding = "2px 7px"
            btn.addEventListener("click", () => this._applyWeightPreset(preset))
            presetRow.append(btn)
        }
        this.settingsHost.append(presetRow)

        // ----- Scoring table
        const scoringTable = document.createElement("table")
        scoringTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:8px;"
        scoringTable.innerHTML = `<thead><tr>
            <th style="text-align:center;padding:2px 4px;width:36px;">On</th>
            <th style="text-align:left;padding:2px 4px;">Variable</th>
            <th style="text-align:left;padding:2px 4px;">Direction</th>
            <th style="text-align:right;padding:2px 4px;width:60px;">Weight</th>
            <th style="text-align:right;padding:2px 4px;width:90px;">Min</th>
            <th style="text-align:right;padding:2px 4px;width:90px;">Max</th>
        </tr></thead>`
        const tbody = document.createElement("tbody")
        scoringTable.append(tbody)

        const settingsMode = this._currentViewMode()
        for (const f of RouteAssistantPanel.SCORING_FIELDS) {
            // Hide scoring rows that don't apply to the active tab so
            // the user doesn't toggle a field that's silently ignored
            // by the current view's score blend.
            if (Array.isArray(f.modes) && f.modes.indexOf(settingsMode) < 0) continue
            const cfg = this.settings.scoring[f.field] = Object.assign(
                {enabled: false, weight: 1, direction: f.direction, min: null, max: null},
                this.settings.scoring[f.field] || {}
            )
            const tr = document.createElement("tr")
            const groupTint = (RouteAssistantPanel.COLUMN_GROUPS[f.group] || {}).tint
            if (groupTint) tr.style.background = groupTint

            const cb = mkInput("checkbox", null)
            cb.checked = !!cfg.enabled

            const dirSel = mkSelect([
                {value: "higher", label: "higher = better"},
                {value: "lower",  label: "lower = better"}
            ], cfg.direction || f.direction)

            const w = mkInput("number", cfg.weight)
            w.min = "0"; w.step = "0.5"; w.style.width = "55px"

            const mn = mkSuggestSelect(cfg.min, f.suggestedValues)
            const mx = mkSuggestSelect(cfg.max, f.suggestedValues)

            const td1 = document.createElement("td")
            td1.style.cssText = "padding:2px 4px;text-align:center;"
            td1.append(cb); tr.append(td1)

            const td2 = document.createElement("td")
            td2.style.cssText = "padding:2px 4px;"
            td2.textContent = f.label
            tr.append(td2)

            const td3 = document.createElement("td")
            td3.style.cssText = "padding:2px 4px;"
            td3.append(dirSel); tr.append(td3)

            const td4 = document.createElement("td")
            td4.style.cssText = "padding:2px 4px;text-align:right;"
            td4.append(w); tr.append(td4)

            const td5 = document.createElement("td")
            td5.style.cssText = "padding:2px 4px;text-align:right;"
            td5.append(mn); tr.append(td5)

            const td6 = document.createElement("td")
            td6.style.cssText = "padding:2px 4px;text-align:right;"
            td6.append(mx); tr.append(td6)

            tbody.append(tr)

            const sync = async () => {
                const wNum = w.value === "" ? 1 : Number(w.value)
                this.settings.scoring[f.field] = {
                    enabled:   cb.checked,
                    weight:    isFinite(wNum) && wNum >= 0 ? wNum : 1,
                    direction: dirSel.value,
                    min:       numOrNull(mn.value),
                    max:       numOrNull(mx.value)
                }
                await RouteAssistantSettings.save({scoring: this.settings.scoring})
                this._render()
            }
            cb.addEventListener("change", sync)
            dirSel.addEventListener("change", sync)
            w.addEventListener("input", sync)
            mn.addEventListener("change", sync)
            mx.addEventListener("change", sync)
        }
        this.settingsHost.append(scoringTable)

        // ----- Filters: min score, max distance, status checkboxes
        const filtRow = document.createElement("div")
        filtRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const minScoreSel = mkSuggestSelect(
            (this.settings.filters || {}).minScore,
            [50, 60, 70, 80, 90]
        )
        const minScoreLbl = document.createElement("label")
        minScoreLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        minScoreLbl.append(document.createTextNode("Min score"), minScoreSel)
        filtRow.append(minScoreLbl)

        const maxDistSel = mkSuggestSelect(
            (this.settings.filters || {}).maxDistanceKm,
            [500, 1500, 3000, 5000, 8000, 12000, 15000]
        )
        const maxDistLbl = document.createElement("label")
        maxDistLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        maxDistLbl.append(document.createTextNode("Max km"), maxDistSel)
        filtRow.append(maxDistLbl)

        const statusBox = document.createElement("span")
        statusBox.style.cssText = "display:flex;gap:8px;"
        for (const s of ["NEW", "OK", "UNDER", "OVER", "OOR"]) {
            const sCb = mkInput("checkbox", null)
            sCb.checked = (this.settings.filters.statuses[s] !== false)
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:3px;align-items:center;color:" +
                ((RouteAssistantPanel.STATUS_DEF[s] || {}).color || "#9ca3af") + ";"
            lbl.append(sCb, document.createTextNode(s))
            statusBox.append(lbl)
            sCb.addEventListener("change", async () => {
                this.settings.filters.statuses[s] = sCb.checked
                await RouteAssistantSettings.save({filters: this.settings.filters})
                this._render()
            })
        }
        filtRow.append(statusBox)

        this.settingsHost.append(filtRow)

        const filterSync = async () => {
            this.settings.filters.minScore      = numOrNull(minScoreSel.value)
            this.settings.filters.maxDistanceKm = numOrNull(maxDistSel.value)
            await RouteAssistantSettings.save({filters: this.settings.filters})
            this._render()
        }
        minScoreSel.addEventListener("change", filterSync)
        maxDistSel.addEventListener("change", filterSync)

        // ----- Auto-Pricing (Tier 1 — visibility layer)
        // Surfaces the user's current ticket price / yield / ORS rank per
        // route, scraped from /app/com/scheduling/<HUB><DEST>. Tier 2
        // (recommendations) and Tier 3 (write-back) hang off the same
        // settings.pricing block.
        this._renderAutoPricingSection()

        // ----- Yield feedback (Roadmap G — actual-yields feedback loop)
        // Joins the live-route-data cache (which tells us which tails fly
        // each route) with `<server>aircraftFlights<id>` profit records
        // (written by content_aircraftFlights.js) and projects realised
        // $/flt onto the table. Closes the loop on the rough estimator.
        this._renderYieldFeedbackSection()

        // ----- Service profiles (per-class seats + service-level posture)
        // Default Y/C/F mix, class yield multipliers, per-class costs, and
        // service-level definitions. Per-route overrides land via the
        // Seats/wk ▾ popover.
        this._renderServiceProfilesSection()

        // ----- Carriers (Letter F — full carrier list per route)
        // Bulk-sync flightsfrom.com/<HUB>-<DEST> to enrich the Cmp
        // column with a colored intensity badge + per-carrier tooltip.
        this._renderCarriersSection()

        // ----- Market Analysis (Tier 2a — per-route markets-page scraper)
        // Bulk-sync /app/com/markets/<HUB><DEST> for competitor flights,
        // own pricing, market shares, and historic capacity/price charts.
        // Stored split across 4 chrome.storage.local key families.
        this._renderMarketAnalysisSection()

        // ----- Demand depth (Letter K — per-class historic + RM buckets)
        // Heavy fan-out scrape that derives real per-route demand pool +
        // price elasticity + RM tightness, replacing the 0–10 station
        // badge as the score-blend's demand signal.
        this._renderDemandDepthSection()

        // ----- ORS Rank (Tier 2b — Online Reservation System scraper)
        // Submits /app/info/ors per route and walks all result pages,
        // computing every flavor of "our rank". Stores the full connection
        // list so any rank metric can be re-derived at render time.
        this._renderOrsRankSection()

        // ----- ORS Sandbox (Letter I slice 1 — pricing simulator config)
        // Tunable model parameters (α_price, α_comfort, default T) +
        // per-route T overrides. The sandbox UI lives in the panel mode
        // toggled via the 🧪 header button; this expander is for the
        // model knobs only.
        this._renderOrsSandboxSection()

        // ----- Active prompts (alert rules)
        // Per-row triggers — declarative "if this field crosses N, toast
        // me on next mount". Rules persist in `routeAssistant:alertRules`
        // and evaluate against the diff-decorated scoredRows on every
        // _renderRows call.
        this._renderAlertRulesSection()

        // ----- Economics — feeds the rough profit estimator
        const econHeader = document.createElement("div")
        econHeader.style.cssText = "margin-top:10px;margin-bottom:4px;color:#9ca3af;font-size:11px;"
        econHeader.innerHTML = "<strong>Economics (rough profit estimator)</strong> — live-syncs as you type. Hover any $/flt cell for the full per-row breakdown."
        this.settingsHost.append(econHeader)

        const formula = document.createElement("div")
        formula.style.cssText = "margin:2px 0 6px 0;color:#6b7280;font-size:10px;line-height:1.5;"
        formula.innerHTML =
            "<strong>Pax LF</strong> = lerp(LF min, max) by pax demand 0–10. " +
            "<strong>Cargo LF</strong> = same with cargo demand. " +
            "<strong>Effective yield</strong> = base yield × (1 + <em>sensitivity</em> × (demand − 5)/5), " +
            "clamped [0.5×, 1.5×]. <strong>0 sensitivity = flat yield</strong>.<br>" +
            "Revenue = seats × paxLF × paxYield × dist × 2 × falloffMult <em>+</em> " +
            "cargoKg × cargoLF × cargoYield × dist × 2 × falloffMult.<br>" +
            "Cost = (fuel + crew + maint) × block hours + other-per-flight. " +
            "<em>$/flt = revenue − cost.</em>"
        this.settingsHost.append(formula)

        const econ = this.settings.economics || {}

        // Pax row
        const lfMinInput  = mkNumberInput(econ.loadFactorMin,          {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const lfMaxInput  = mkNumberInput(econ.loadFactorMax,          {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const lfInput     = mkNumberInput(econ.loadFactor,             {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const yieldInput  = mkNumberInput(econ.yieldPerKm,             {min: 0,    max: 10,   step: 0.01, width: "55px"})
        const yieldSensInput = mkNumberInput(econ.yieldDemandSensitivity, {min: 0, max: 1,    step: 0.1,  width: "55px"})
        // Cargo row
        const cyInput     = mkNumberInput(econ.cargoYieldPerKgKm,      {min: 0,    max: 1,    step: 0.0001, width: "75px"})
        const cLfMinInput = mkNumberInput(econ.cargoLoadFactorMin,     {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const cLfMaxInput = mkNumberInput(econ.cargoLoadFactorMax,     {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const cySensInput = mkNumberInput(econ.cargoYieldDemandSensitivity, {min: 0, max: 1, step: 0.1, width: "55px"})
        // Cost row
        const fuelInput   = mkNumberInput(econ.fuelCostPerHour,        {min: 0,    max: 99999, step: 100, width: "70px"})
        const fuelAgeInput = mkNumberInput(econ.fuelAgePenaltyPerYear, {min: 0,    max: 0.05, step: 0.001, width: "65px"})
        const crewInput   = mkNumberInput(econ.crewCostPerHour,        {min: 0,    max: 99999, step: 50,  width: "65px"})
        const maintInput  = mkNumberInput(econ.maintenanceCostPerHour, {min: 0,    max: 99999, step: 50,  width: "65px"})
        const otherInput  = mkNumberInput(econ.otherFixedPerFlight,    {min: 0,    max: 9999999, step: 100, width: "75px"})
        const falloffMult = mkNumberInput(econ.falloffYieldMultiplier, {min: 0,    max: 1.5,  step: 0.05, width: "55px"})

        const wrap = (label, inp, hint) => {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            w.title = hint || ""
            w.append(document.createTextNode(label), inp)
            return w
        }

        const paxRow = document.createElement("div")
        paxRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-bottom:4px;"
        const paxTag = document.createElement("strong")
        paxTag.textContent = "Pax"
        paxTag.style.cssText = "color:#60a5fa;font-size:10px;width:36px;"
        paxRow.append(
            paxTag,
            wrap("Yield AS$/km",       yieldInput,     "AS$ revenue per pax per km. Default 0.10 — tune to your game world."),
            wrap("Yield sens.",        yieldSensInput, "How much pax demand modulates yield. 0 = flat (default), 1 = ±20% by demand (clamped). Pairs with LF curve."),
            wrap("LF min (demand 0)",  lfMinInput,     "Pax load factor when AS pax demand is 0/10. Default 0.50."),
            wrap("LF max (demand 10)", lfMaxInput,     "Pax load factor when AS pax demand is 10/10. Default 0.95."),
            wrap("LF base",            lfInput,        "Pax fallback LF when demand isn't resolved. Default 0.75.")
        )
        this.settingsHost.append(paxRow)

        const cargoRow = document.createElement("div")
        cargoRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-bottom:4px;"
        const cargoTag = document.createElement("strong")
        cargoTag.textContent = "Cargo"
        cargoTag.style.cssText = "color:#a78bfa;font-size:10px;width:36px;"
        cargoRow.append(
            cargoTag,
            wrap("Yield AS$/kg-km",    cyInput,     "AS$ revenue per kg of cargo per km. Default 0 — cargo revenue is OFF until you enter a value. Try 0.0008 as a starting point."),
            wrap("Yield sens.",        cySensInput, "How much cargo demand modulates cargo yield. 0 = flat (default), 1 = ±20% by demand (clamped)."),
            wrap("LF min (demand 0)",  cLfMinInput, "Cargo load factor when AS cargo demand is 0/10. Default 0.40."),
            wrap("LF max (demand 10)", cLfMaxInput, "Cargo load factor when AS cargo demand is 10/10. Default 0.85.")
        )
        this.settingsHost.append(cargoRow)

        const commonRow = document.createElement("div")
        commonRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"
        const commonTag = document.createElement("strong")
        commonTag.textContent = "Cost"
        commonTag.style.cssText = "color:#9ca3af;font-size:10px;width:36px;"
        commonRow.append(
            commonTag,
            wrap("Fuel AS$/h",         fuelInput,    "AS$ per block hour, fleet-average fuel cost (base, before age penalty). Default 2500. When 'Auto-scale' is on in the Cache section below, this is the BASELINE — effective cost auto-scales by AS fuel price ratio."),
            wrap("Age penalty/yr",     fuelAgeInput, "Fraction of extra fuel per year of aircraft age. Default 0 = OFF. Try 0.005 (0.5%/yr) or 0.01 (1%/yr) — exact AS mechanic unconfirmed, calibrate from observation. Capped at 2× total. Per-tail mode uses exact tail age; per-type / Fleet mode uses avg age of owned aircraft of that type."),
            wrap("Crew AS$/h",         crewInput,    "AS$ per block hour for crew. Default 0 — disabled until you set it."),
            wrap("Maint AS$/h",        maintInput,   "AS$ per block hour for maintenance reserves. Default 0 — disabled until you set it."),
            wrap("Other AS$/flt",      otherInput,   "AS$ per round-trip: leasing, insurance, gate fees, anything fixed-per-flight. Default 0."),
            wrap("Falloff yield",      falloffMult,  "Revenue multiplier when distance is in the fall-off zone (90–95% of range). Default 0.85.")
        )
        this.settingsHost.append(commonRow)

        // ----- Cache section
        const cacheHeader = document.createElement("div")
        cacheHeader.style.cssText = "margin-top:10px;margin-bottom:4px;color:#9ca3af;font-size:11px;"
        cacheHeader.innerHTML = "<strong>Cache</strong> — distances are cached forever by default. Set a max age to re-resolve stale entries (e.g. after AS adjusts route restrictions)."
        this.settingsHost.append(cacheHeader)

        const cacheRow = document.createElement("div")
        cacheRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"
        const cacheTag = document.createElement("strong")
        cacheTag.textContent = "Distance"
        cacheTag.style.cssText = "color:#9ca3af;font-size:10px;width:50px;"
        const distAgeSel = mkSuggestSelect(
            this.settings.distanceMaxAgeDays,
            [7, 14, 30, 60, 90, 180]
        )
        const distAgeWrap = document.createElement("label")
        distAgeWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        distAgeWrap.title = "Days before a cached distance is considered stale and re-resolved on next mount. Default: no expiry."
        distAgeWrap.append(document.createTextNode("Max age (days)"), distAgeSel)
        cacheRow.append(cacheTag, distAgeWrap)
        this.settingsHost.append(cacheRow)

        distAgeSel.addEventListener("change", async () => {
            this.settings.distanceMaxAgeDays = numOrNull(distAgeSel.value)
            await RouteAssistantSettings.save({distanceMaxAgeDays: this.settings.distanceMaxAgeDays})
            // Drop the resolver so it picks up the new max age, then refresh:
            // refresh rebuilds rows from ffData (distanceKm null), bulkLoad
            // applies only fresh entries, enrichment re-resolves the rest.
            this.distanceResolver = null
            await this.refresh()
        })

        // ----- AS fuel auto (letter A)
        // Per-type model: when Auto is on AND the scraped price is in ASc$/l,
        // fuel cost per flight = (cycle_L + per_km_L × dist × 2) × price/100,
        // with cycle_L and per_km_L derived per type (heuristic from spec, or
        // a stored override). When Auto is off, the legacy "Fuel AS$/h ×
        // block hours" model is used.
        const fuelRow = document.createElement("div")
        fuelRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-top:4px;"
        const fuelTag = document.createElement("strong")
        fuelTag.textContent = "AS fuel"
        fuelTag.style.cssText = "color:#9ca3af;font-size:10px;width:50px;"

        const fp = this.fuelPrice
        const havePrice = fp && fp.unit === "ASc$/l" && typeof fp.value === "number" && fp.value > 0
        const fuelStatus = document.createElement("span")
        fuelStatus.style.color = "#9ca3af"
        if (this._fuelScrapeInFlight) {
            fuelStatus.textContent = "Scraping…"
            fuelStatus.style.color = "#60a5fa"
        } else if (fp && typeof fp.value === "number") {
            const ageH = Math.max(0, Math.round((Date.now() - fp.scrapedAt) / 3600e3))
            const ageStr = ageH < 1 ? "just now" : ageH + "h ago"
            const dateStr = fp.date ? " · " + (typeof fp.date === "number" ? fp.date.toFixed(2) : fp.date) : ""
            const unit = fp.unit === "ASc$/l" ? " ASc$/l" : " (chart-scale)"
            fuelStatus.textContent = `${fp.value.toFixed(2)}${unit} (${ageStr})${dateStr}`
            if (RouteAssistantFuelPriceScraper.isStale(fp)) fuelStatus.style.color = "#fbbf24"
        } else {
            fuelStatus.textContent = "Not scraped — click Refresh."
            fuelStatus.style.color = "#fbbf24"
        }

        const fuelRefreshBtn = document.createElement("button")
        fuelRefreshBtn.textContent = "Refresh"
        Object.assign(fuelRefreshBtn.style, smallBtnStyle())
        fuelRefreshBtn.style.fontSize = "10px"
        fuelRefreshBtn.style.padding = "1px 6px"
        fuelRefreshBtn.disabled = this._fuelScrapeInFlight
        if (this._fuelScrapeInFlight) fuelRefreshBtn.style.opacity = "0.5"
        fuelRefreshBtn.addEventListener("click", () => this._scrapeFuelPriceAsync())

        // Auto toggle — only meaningful with a usable ASc$/l price scrape.
        const autoCb = mkInput("checkbox", null)
        autoCb.checked = !!econ.fuelPriceAutoEnabled
        autoCb.disabled = !havePrice
        const autoLbl = document.createElement("label")
        autoLbl.style.cssText = "display:flex;gap:3px;align-items:center;color:#9ca3af;"
        autoLbl.title = "Compute fuel cost as (cycle_L + per_km_L × distance × 2) × current AS price. Per-type cycle/per_km derived from spec heuristic; override per type below."
        autoLbl.append(autoCb, document.createTextNode("Auto (per-type fuel)"))
        autoCb.addEventListener("change", async () => {
            this.settings.economics.fuelPriceAutoEnabled = autoCb.checked
            await RouteAssistantSettings.save({economics: this.settings.economics})
            this._recomputeProfit()
            this._renderSettings()
        })

        fuelRow.append(fuelTag, fuelStatus, fuelRefreshBtn, autoLbl)

        // When per-type fuel is on, override the Fuel AS$/h input with the
        // cruise-equivalent rate for the currently selected aircraft (or the
        // fleet average in Fleet mode). The user sees what fuel actually
        // costs them per hour at cruise. Field becomes read-only — the
        // underlying setting is preserved unchanged.
        const cruiseRate = (econ.fuelPriceAutoEnabled && havePrice)
            ? this._computeCruiseFuelRate(fp.value) : null
        if (cruiseRate !== null) {
            fuelInput.value = String(Math.round(cruiseRate.rate))
            fuelInput.disabled = true
            fuelInput.style.opacity = "0.7"
            fuelInput.title = `Auto-derived: ${cruiseRate.perKmL.toFixed(2)} L/km × ${cruiseRate.speed} km/h × ${fp.value} ASc/l ÷ 100 = AS$${Math.round(cruiseRate.rate)}/h cruise${cruiseRate.label ? " (" + cruiseRate.label + ")" : ""}. Disable Auto (per-type fuel) to edit.`
        }

        // Method indicator
        const methodNote = document.createElement("span")
        methodNote.style.cssText = "color:#6b7280;font-size:10px;"
        if (econ.fuelPriceAutoEnabled && havePrice) {
            methodNote.style.color = "#a3e635"
            const rateStr = cruiseRate
                ? ` · cruise rate AS$${Math.round(cruiseRate.rate)}/h${cruiseRate.label ? " (" + cruiseRate.label + ")" : ""}`
                : ""
            methodNote.textContent = "→ fuel = (cycle_L + per_km_L × dist × 2) × AS price" + rateStr
        } else if (econ.fuelPriceAutoEnabled && !havePrice) {
            methodNote.style.color = "#fbbf24"
            methodNote.textContent = "→ Auto on but no ASc$/l price — falling back to flat AS$/h"
        } else {
            methodNote.textContent = "→ legacy: Fuel AS$/h × block hours"
        }
        fuelRow.append(methodNote)

        this.settingsHost.append(fuelRow)

        // Per-type fuel-burn list (read-only summary; opens edit modal on click).
        if (econ.fuelPriceAutoEnabled && havePrice && this.fleet
                && Array.isArray(RouteAssistantFleetStore.activeTypeSlots(this.fleet))) {
            this._renderFuelBurnTable()
        }

        const allInputs = [lfMinInput, lfMaxInput, lfInput, yieldInput, yieldSensInput,
                           cyInput, cLfMinInput, cLfMaxInput, cySensInput,
                           fuelInput, fuelAgeInput, crewInput, maintInput, otherInput, falloffMult]

        // Apply changes immediately to in-memory settings (so the breakdown
        // tooltip on hover reads current values), but debounce the storage
        // write + recompute so a multi-keystroke entry like "0.123" doesn't
        // trigger 4 saves and 4 re-aggregations.
        const stageEconomics = () => {
            this.settings.economics = Object.assign({}, this.settings.economics, {
                loadFactor:                  parseFloatOr(lfInput.value, 0.75),
                loadFactorMin:               parseFloatOr(lfMinInput.value, 0.50),
                loadFactorMax:               parseFloatOr(lfMaxInput.value, 0.95),
                yieldPerKm:                  parseFloatOr(yieldInput.value, 0.10),
                yieldDemandSensitivity:      parseFloatOr(yieldSensInput.value, 0),
                cargoYieldPerKgKm:           parseFloatOr(cyInput.value, 0),
                cargoLoadFactorMin:          parseFloatOr(cLfMinInput.value, 0.40),
                cargoLoadFactorMax:          parseFloatOr(cLfMaxInput.value, 0.85),
                cargoYieldDemandSensitivity: parseFloatOr(cySensInput.value, 0),
                fuelCostPerHour:             fuelInput.disabled
                                                 ? this.settings.economics.fuelCostPerHour
                                                 : parseFloatOr(fuelInput.value, 2500),
                fuelAgePenaltyPerYear:       parseFloatOr(fuelAgeInput.value, 0),
                crewCostPerHour:             parseFloatOr(crewInput.value, 0),
                maintenanceCostPerHour:      parseFloatOr(maintInput.value, 0),
                otherFixedPerFlight:         parseFloatOr(otherInput.value, 0),
                falloffYieldMultiplier:      parseFloatOr(falloffMult.value, 0.85)
            })
        }

        const econDebounced = () => {
            stageEconomics()
            clearTimeout(this._economicsDebounceTimer)
            this._economicsDebounceTimer = setTimeout(async () => {
                await RouteAssistantSettings.save({economics: this.settings.economics})
                this._recomputeProfit()
            }, 250)
        }

        for (const inp of allInputs) {
            inp.addEventListener("input", econDebounced)
        }
    }

    // ---------- Auto-Pricing section (Tier 1) ----------

    /**
     * Renders the Auto-Pricing block inside the settings drawer:
     *   - status line (last scrape, K/N routes priced)
     *   - "Show pricing columns" toggle
     *   - "Scan prices for all visible routes" CTA + progress
     *   - placeholder note for Tier 2 / Tier 3 controls
     */
    _renderAutoPricingSection() {
        const cfg = this.settings.pricing = Object.assign(
            {showPricingColumns: true, concurrency: 4, staggerMs: 800, lastBulkScrapeAt: null},
            this.settings.pricing || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(244, 63, 94, 0.06);border:1px solid rgba(244, 63, 94, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#fda4af;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Live route data</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Captures aircraft, departure time, "
            + "frequency and cruise speed from /app/com/scheduling/&lt;HUB&gt;&lt;DEST&gt;. "
            + "Tier 2 will add prices and ORS rank from /app/com/markets/&lt;HUB&gt;&lt;DEST&gt;.</span>"
        wrap.append(header)

        // Status line — refreshed on every render; live progress updates
        // happen on this._priceStatusEl when a bulk scrape is running.
        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.liveAircraftType || r.liveDeparture).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Captured: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._priceStatusEl = status

        // Controls row: toggle + scan button
        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showPricingColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fda4af;"
        showLbl.append(showCb, document.createTextNode("Show live-data columns"))
        showCb.addEventListener("change", async () => {
            this.settings.pricing.showPricingColumns = showCb.checked
            await RouteAssistantSettings.save({pricing: this.settings.pricing})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._priceScrapeRunning
            ? "Syncing routes…"
            : "Sync route data for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#9f1239"
        scanBtn.disabled = !!this._priceScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkPriceScrape())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        // Tier 2/3 placeholder
        const futureNote = document.createElement("div")
        futureNote.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        futureNote.innerHTML = "Coming next: <em>Tier 2</em> — actual ticket prices + ORS rank from the markets page. "
            + "<em>Tier 3</em> — one-click apply with batch confirmation. "
            + "<em>Silent auto-apply</em> stays behind a separate explicit setting."
        wrap.append(futureNote)

        this.settingsHost.append(wrap)
    }

    /**
     * Bulk-scrape ticket prices for every (hub, dest) pair in this.rows
     * using RouteAssistantTicketPriceScraper. Updates the status line as
     * progress arrives; on completion, re-loads the cache, persists
     * lastBulkScrapeAt, and re-renders so columns fill in.
     */
    async _runBulkPriceScrape() {
        if (this._priceScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.pricing || {}
        const concurrency = cfg.concurrency || 4
        const staggerMs   = cfg.staggerMs   || 800

        if (!this.priceScraper) {
            this.priceScraper = new RouteAssistantTicketPriceScraper(this.server, {
                maxAgeDays: cfg.priceMaxAgeDays
            })
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._priceScrapeRunning = true
        this._renderSettings()  // disable button + flip label

        const progressHandle = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.progress("Syncing live route data…", {id: "price-bulk-scrape", type: "info"})
            : null
        let lastTotal = pairs.length, failed = false
        try {
            await this.priceScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    lastTotal = total
                    if (this._priceStatusEl) {
                        this._priceStatusEl.textContent = "Syncing route data: " + done + "/" + total + "…"
                    }
                    if (progressHandle) {
                        progressHandle.update({
                            progressPct:   total ? (100 * done / total) : 0,
                            progressLabel: done + " / " + total + " routes"
                        })
                    }
                }
            })
        } catch (e) {
            failed = true
            console.warn("[AES priceScraper] bulk scrape failed", e)
        }

        this._priceScrapeRunning = false
        this.settings.pricing.lastBulkScrapeAt = Date.now()
        await RouteAssistantSettings.save({pricing: this.settings.pricing})

        await this._applyCachedPrices()
        this._render()

        if (progressHandle) {
            progressHandle.complete({
                type:    failed ? "warn" : "success",
                message: failed
                    ? "Route data sync finished with errors · " + lastTotal + " routes"
                    : "Route data sync complete · " + lastTotal + " routes"
            })
        }
    }

    // ---------- Yield feedback (Roadmap G) ----------

    /**
     * Settings-drawer block for the actual-yields feedback loop:
     *   - status line (last snapshot, K/N routes have history)
     *   - Snapshot CTA + progress
     *   - "Show actuals columns" toggle, attribution-mode select,
     *     variance threshold, history limit
     */
    _renderYieldFeedbackSection() {
        const cfg = this.settings.yieldFeedback = Object.assign(
            {showColumns: true, varianceWarnPct: 25, attributionMode: "frequency",
             historyLimit: 12, lastSnapshotAt: null, autoSnapshotOnMount: false,
             deltaMode: false},
            this.settings.yieldFeedback || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(168, 85, 247, 0.08);border:1px solid rgba(168, 85, 247, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#d8b4fe;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Yield feedback (actuals)</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Joins cached "
            + "live-route data with each tail's <code>aircraftFlights</code> profit record "
            + "to attribute realised $/flt per route. Closes the loop with the rough estimator.</span>"
        wrap.append(header)

        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.actualProfitPerFlight != null).length
        const lastSnap  = cfg.lastSnapshotAt
            ? new Date(cfg.lastSnapshotAt).toLocaleString()
            : "never"

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        status.textContent = "Snapshots: " + dataRows + "/" + totalRows
            + " routes · last snapshot: " + lastSnap
        wrap.append(status)
        this._snapshotStatusEl = status

        // Diagnostic block — only shown after the user actually clicked
        // "Snapshot yields now". Surfaces *why* the run produced what it did
        // so a 0-routes outcome doesn't read as silent failure.
        const diag = this._lastSnapshotResult
        if (diag) {
            const liveCaptured = (this.rows || []).filter(r => r.liveAircraftType || r.liveDeparture).length
            const lines = []
            let modeLine
            if (diag.attributionMode === "per-flight") {
                modeLine = "per-flight (exact) · " + (diag.routesWithPerFlight || 0)
                    + " route" + ((diag.routesWithPerFlight === 1) ? "" : "s")
                    + " attributed exactly"
                    + ((diag.routesFellBack > 0)
                        ? " · " + diag.routesFellBack + " fell back to frequency"
                        : "")
            } else if (diag.mode === "delta") {
                modeLine = "delta-mode · " + (diag.tailsUsingDelta || 0) + "/" + diag.tailsUsed
                    + " tails had a prior baseline"
            } else {
                modeLine = "cumulative-mode (lifetime average $/flt per tail)"
            }
            lines.push(diag.routesUpdated + " route" + (diag.routesUpdated === 1 ? "" : "s")
                + " updated · " + diag.routesScanned + " scanned · "
                + diag.tailsUsed + "/" + diag.tailsSeen + " tails contributed · " + modeLine)
            if (diag.attributionMode === "per-flight" && diag.routesFellBack > 0) {
                lines.push("⚠ " + diag.routesFellBack + " route" + (diag.routesFellBack === 1 ? "" : "s")
                    + " had no measured flights. Visit each tail's flight-history page AND each "
                    + "individual flight detail page to populate <server>flightInfo<id>; the "
                    + "Aircraft history page's \"Extract finished flight profit\" button bulk-opens them.")
            }
            if (diag.tailsMissingProfit > 0) {
                const sample = (diag.tailsMissingList || []).slice(0, 6).join(", ")
                lines.push("⚠ " + diag.tailsMissingProfit + " tail"
                    + (diag.tailsMissingProfit === 1 ? "" : "s")
                    + " missing profit data — visit /app/fleets/aircraft/<id>/1 to capture each."
                    + (sample ? "\n   First few: " + sample
                        + (diag.tailsMissingList.length > 6 ? ", …" : "") : ""))
            }
            if (diag.routesScanned === 0 && liveCaptured === 0) {
                lines.push("⚠ No live route data found. Click \"Sync route data for all visible routes\" first.")
            } else if (diag.routesScanned === 0 && liveCaptured > 0) {
                lines.push("⚠ Live route data exists but no flights were attributed. "
                    + "Re-sync the routes in case the previous fetch missed the Flight Numbers table.")
            }
            const diagBox = document.createElement("div")
            const errorish = diag.routesUpdated === 0 || diag.tailsMissingProfit > 0
            diagBox.style.cssText = "color:" + (errorish ? "#fde68a" : "#a7f3d0")
                + ";font-size:10px;margin-bottom:6px;white-space:pre-wrap;line-height:1.45;"
                + "background:" + (errorish ? "rgba(245,158,11,0.07)" : "rgba(34,197,94,0.07)")
                + ";border:1px solid " + (errorish ? "rgba(245,158,11,0.30)" : "rgba(34,197,94,0.30)")
                + ";border-radius:3px;padding:4px 6px;"
            diagBox.textContent = "Last snapshot: " + lines.join("\n")
            wrap.append(diagBox)
        }

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#d8b4fe;"
        showLbl.append(showCb, document.createTextNode("Show actuals columns"))
        showCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.showColumns = showCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
            this._render()
        })
        ctrlRow.append(showLbl)

        const modeSel = mkSelect([
            {value: "per-flight", label: "per-flight (exact)"},
            {value: "frequency",  label: "by frequency"},
            {value: "distance",   label: "by distance × frequency"},
            {value: "equal",      label: "split equally per route"}
        ])
        modeSel.value = cfg.attributionMode || "frequency"
        modeSel.style.fontSize = "11px"
        modeSel.title = "per-flight = sums each finished flight's profit per route exactly "
            + "(no frequency averaging). Requires the user to have visited each flight's "
            + "detail page so the financials cache is populated. Routes with no per-flight "
            + "data fall back to frequency-weighted attribution."
        modeSel.addEventListener("change", async () => {
            this.settings.yieldFeedback.attributionMode = modeSel.value
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        const modeLbl = document.createElement("label")
        modeLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        modeLbl.append(document.createTextNode("Attribution:"), modeSel)
        ctrlRow.append(modeLbl)

        const warnInput = mkNumberInput(cfg.varianceWarnPct, {min: 1, max: 200, step: 1, width: "55px"})
        warnInput.addEventListener("change", async () => {
            const v = parseFloatOr(warnInput.value, 25)
            this.settings.yieldFeedback.varianceWarnPct = Math.max(1, Math.round(v))
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
            this._render()
        })
        const warnLbl = document.createElement("label")
        warnLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        warnLbl.append(document.createTextNode("Δ% warn at ±"), warnInput, document.createTextNode("%"))
        ctrlRow.append(warnLbl)

        const limitInput = mkNumberInput(cfg.historyLimit, {min: 2, max: 60, step: 1, width: "50px"})
        limitInput.addEventListener("change", async () => {
            const v = parseFloatOr(limitInput.value, 12)
            this.settings.yieldFeedback.historyLimit = Math.max(2, Math.round(v))
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        const limitLbl = document.createElement("label")
        limitLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        limitLbl.append(document.createTextNode("History"), limitInput, document.createTextNode("snapshots"))
        ctrlRow.append(limitLbl)

        const deltaCb = mkInput("checkbox", null)
        deltaCb.checked = !!cfg.deltaMode
        const deltaLbl = document.createElement("label")
        deltaLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        deltaLbl.title = "Delta mode subtracts the previous snapshot's lifetime profit from each "
            + "tail's current cumulative profit, so $/flt reflects only flights flown SINCE the "
            + "last snapshot (true periodic yield). First snapshot still uses cumulative; "
            + "subsequent runs switch automatically per-tail when a baseline exists."
        deltaLbl.append(deltaCb, document.createTextNode("Delta mode"))
        deltaCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.deltaMode = deltaCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        ctrlRow.append(deltaLbl)

        const autoCb = mkInput("checkbox", null)
        autoCb.checked = !!cfg.autoSnapshotOnMount
        const autoLbl = document.createElement("label")
        autoLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        autoLbl.title = "When enabled, the panel runs a snapshot once after each mount/refresh. "
            + "Skipped silently when no live route data is cached yet."
        autoLbl.append(autoCb, document.createTextNode("Auto on mount"))
        autoCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.autoSnapshotOnMount = autoCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        ctrlRow.append(autoLbl)

        const snapBtn = document.createElement("button")
        snapBtn.textContent = this._snapshotRunning ? "Snapshotting…" : "Snapshot yields now"
        Object.assign(snapBtn.style, smallBtnStyle())
        snapBtn.style.background = "#7c3aed"
        snapBtn.disabled = !!this._snapshotRunning || !this.hubIata
        snapBtn.addEventListener("click", () => this._runYieldSnapshot())
        ctrlRow.append(snapBtn)

        // Calibrate-flagged button — runs the per-route override editor's
        // "Calibrate from actuals" math against every row whose |Δ%| trips
        // the variance threshold, batched behind a confirmation modal so a
        // single click never silently overrides 50 routes.
        const flagged = this._flaggedRoutesForCalibration()
        const calibBtn = document.createElement("button")
        calibBtn.textContent = "Calibrate flagged (" + flagged.length + ")"
        Object.assign(calibBtn.style, smallBtnStyle())
        calibBtn.style.background = flagged.length ? "#7c3aed" : "#475569"
        calibBtn.disabled = !flagged.length
        if (!flagged.length) calibBtn.style.opacity = "0.5"
        calibBtn.title = flagged.length
            ? "Open a confirmation modal listing every route whose Δ% currently exceeds the warn threshold "
              + "and the per-route yield override that would make the estimator match the latest snapshot. "
              + "Save runs as a batch."
            : "No routes currently flagged. Lower the warn threshold or take a fresh snapshot to populate."
        calibBtn.addEventListener("click", () => this._openCalibrateFlaggedModal(flagged))
        ctrlRow.append(calibBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Requires recent <em>Sync route data</em> (so we know which tails fly each route) "
            + "and one visit to each tail's flight-history page (<code>/app/fleets/aircraft/&lt;id&gt;/1</code>) "
            + "so its profit is captured. Snapshot reports tails missing profit data so you can fill in the gaps."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Returns the rows whose |actualVariancePct| meets or exceeds the user's
     * warn threshold AND whose `derivedYieldFromActuals` solves to a finite
     * positive number. Used by the "Calibrate flagged" CTA.
     */
    _flaggedRoutesForCalibration() {
        if (!this.rows || !this.rows.length) return []
        const cfg = this.settings && this.settings.yieldFeedback
        const warn = (cfg && Number(cfg.varianceWarnPct) > 0) ? Number(cfg.varianceWarnPct) : 25
        const out = []
        for (const row of this.rows) {
            const v = row.actualVariancePct
            if (v === null || v === undefined) continue
            if (Math.abs(v) < warn) continue
            const result = derivedYieldFromActuals(row)
            if (result === null) continue
            out.push({
                row:      row,
                primary:  {side: result.side, value: result.value},
                alt:      result.alt,
                variance: v
            })
        }
        return out
    }

    /**
     * Modal — list every flagged route's existing yield, the proposed
     * calibrated yield, and the resulting Δ%. User can deselect any row,
     * Save writes batch overrides via RouteAssistantRouteOverridesStore.
     */
    _openCalibrateFlaggedModal(flagged) {
        if (!flagged || !flagged.length) return
        if (this._calibrateFlaggedOverlay) return  // already open
        const overlay = document.createElement("div")
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.65);"
            + "z-index:10001;display:flex;align-items:center;justify-content:center;"
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._calibrateFlaggedOverlay = null
        }
        overlay.addEventListener("click", e => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        card.style.cssText = "background:#0f172a;color:#e5e7eb;border:1px solid #334155;"
            + "border-radius:6px;padding:14px 16px;max-width:680px;max-height:80vh;"
            + "overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,0.5);"

        const title = document.createElement("div")
        title.style.cssText = "font-size:13px;font-weight:600;color:#d8b4fe;margin-bottom:4px;"
        title.textContent = "Calibrate " + flagged.length + " flagged route"
            + (flagged.length === 1 ? "" : "s") + " from actuals"
        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;line-height:1.5;"
        sub.innerHTML = "Each row shows the existing yield (or default), the calibrated value that "
            + "would make the estimator match the latest snapshot at the current LF / spec, and the "
            + "Δ% that drove the flag. The Side column auto-picks pax (P) or cargo (C) based on the "
            + "route's dominant revenue share — flip per row to calibrate the other side instead. "
            + "Untick any row you don't want to write. Saving creates or extends a per-route override "
            + "(other override fields are preserved)."
        card.append(title, sub)

        const econ = (this.settings && this.settings.economics) || {}
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;"
        const head = document.createElement("tr")
        head.innerHTML = "<th></th>"
            + "<th style='text-align:left;padding:4px 6px;color:#94a3b8;'>Route</th>"
            + "<th style='text-align:center;padding:4px 6px;color:#94a3b8;'>Side</th>"
            + "<th style='text-align:right;padding:4px 6px;color:#94a3b8;'>Δ%</th>"
            + "<th style='text-align:right;padding:4px 6px;color:#94a3b8;'>Old yield</th>"
            + "<th style='text-align:right;padding:4px 6px;color:#94a3b8;'>New yield</th>"
        tbl.append(head)
        const checks = []
        const oldYieldFor = (f, side) => {
            const ex = f.row.override || {}
            if (side === "cargo") {
                if (typeof ex.cargoYieldPerKgKm === "number") return ex.cargoYieldPerKgKm
                return typeof econ.cargoYieldPerKgKm === "number" ? econ.cargoYieldPerKgKm : null
            }
            if (typeof ex.yieldPerKm === "number") return ex.yieldPerKm
            return typeof econ.yieldPerKm === "number" ? econ.yieldPerKm : null
        }
        const solutionFor = (f, side) => {
            if (f.primary && f.primary.side === side) return f.primary
            if (f.alt && f.alt.side === side) return f.alt
            return null
        }
        for (const f of flagged) {
            const tr = document.createElement("tr")
            tr.style.borderTop = "1px solid #1f2937"
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = true
            const td = (txt, align) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:4px 6px;text-align:" + (align || "left") + ";"
                c.textContent = txt
                return c
            }
            const cbCell = document.createElement("td")
            cbCell.style.padding = "4px 6px"
            cbCell.append(cb)

            // Side dropdown — disabled when only one side is solvable.
            const sideSel = document.createElement("select")
            sideSel.style.cssText = "background:#0f172a;color:#e5e7eb;border:1px solid #334155;"
                + "border-radius:3px;padding:1px 4px;font-size:11px;"
            const optP = document.createElement("option")
            optP.value = "pax"; optP.textContent = "P"
            const optC = document.createElement("option")
            optC.value = "cargo"; optC.textContent = "C"
            sideSel.append(optP, optC)
            const hasPax   = !!solutionFor(f, "pax")
            const hasCargo = !!solutionFor(f, "cargo")
            optP.disabled = !hasPax
            optC.disabled = !hasCargo
            sideSel.value = f.primary.side
            sideSel.disabled = !(hasPax && hasCargo)
            const sideCell = document.createElement("td")
            sideCell.style.cssText = "padding:4px 6px;text-align:center;"
            sideCell.append(sideSel)

            const v = f.variance
            const vCell = td((v > 0 ? "+" : "") + v + "%", "right")
            vCell.style.color = v > 0 ? "#86efac" : "#fca5a5"

            const oldCell = td("", "right")
            const newCell = td("", "right")
            const refresh = () => {
                const side = sideSel.value
                const sol  = solutionFor(f, side)
                const old  = oldYieldFor(f, side)
                oldCell.textContent = old != null ? old.toFixed(4) : "—"
                newCell.textContent = sol ? sol.value.toFixed(4) : "—"
            }
            refresh()
            sideSel.addEventListener("change", refresh)
            checks.push({entry: f, cb: cb, sideSel: sideSel})

            tr.append(cbCell, td(f.row.destIata, "left"), sideCell, vCell, oldCell, newCell)
            tbl.append(tr)
        }
        card.append(tbl)

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:8px;margin-top:12px;justify-content:flex-end;"
        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.addEventListener("click", () => close())
        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save selected"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.background = "#7c3aed"
        saveBtn.addEventListener("click", async () => {
            saveBtn.disabled = true
            saveBtn.textContent = "Saving…"
            const hubU = String(this.hubIata || "").toUpperCase()
            const dateStr = new Date().toISOString().slice(0, 10)
            let written = 0
            for (const c of checks) {
                if (!c.cb.checked) continue
                const side = c.sideSel.value
                const sol  = (c.entry.primary.side === side) ? c.entry.primary
                           : (c.entry.alt && c.entry.alt.side === side) ? c.entry.alt
                           : null
                if (!sol) continue
                const ex = c.entry.row.override || {}
                const noteStr = "calibrated " + dateStr + " (" + side + ")"
                const fields = {
                    paxLF:             typeof ex.paxLF === "number" ? ex.paxLF : null,
                    cargoLF:           typeof ex.cargoLF === "number" ? ex.cargoLF : null,
                    yieldPerKm:        side === "pax"
                                           ? sol.value
                                           : (typeof ex.yieldPerKm === "number" ? ex.yieldPerKm : null),
                    cargoYieldPerKgKm: side === "cargo"
                                           ? sol.value
                                           : (typeof ex.cargoYieldPerKgKm === "number" ? ex.cargoYieldPerKgKm : null),
                    note:              ex.note ? (ex.note + " · " + noteStr) : noteStr
                }
                const destU = String(c.entry.row.destIata || "").toUpperCase()
                const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
                if (saved) {
                    c.entry.row.override = saved
                    this.overrideMap.set(hubU + "-" + destU, saved)
                    written++
                }
            }
            close()
            if (written) {
                this._recomputeProfit()
                console.log("[AES yieldFeedback] calibrated " + written + " route(s) from actuals")
            }
        })
        btnRow.append(cancelBtn, saveBtn)
        card.append(btnRow)

        overlay.append(card)
        document.body.append(overlay)
        this._calibrateFlaggedOverlay = overlay
    }

    /**
     * Walk every aircraftFlights record in this server's storage, join to the
     * cached scheduling-page scrape (tails ↔ routes), attribute profits, and
     * append one snapshot per route to RouteAssistantYieldHistoryStore.
     * Updates the panel's in-memory map + re-renders so the actuals columns
     * fill in without a full refresh.
     */
    async _runYieldSnapshot() {
        if (this._snapshotRunning || !this.hubIata) return
        const cfg = this.settings.yieldFeedback || {}
        this._snapshotRunning = true
        if (this._snapshotStatusEl) this._snapshotStatusEl.textContent = "Snapshotting…"
        this._renderSettings()

        let result = null
        try {
            // Distance-mode attribution wants a hub-pair → distance map. We
            // already cache distances per pair; the resolver's symmetric
            // pair-key matches what `RouteAssistantYieldSnapshot._lookupDistance`
            // tries. Fall back to "frequency" silently per-pair when missing.
            const distanceMap = await RouteAssistantDistanceResolver.bulkLoadCache(
                (this.rows || []).map(r => [this.hubIata, r.destIata])
            )
            result = await RouteAssistantYieldSnapshot.takeSnapshot({
                server:          this.server,
                hubIata:         this.hubIata,
                attributionMode: cfg.attributionMode,
                historyLimit:    cfg.historyLimit,
                distanceMap:     distanceMap,
                deltaMode:       !!cfg.deltaMode
            })
        } catch (e) {
            console.warn("[AES yieldFeedback] snapshot failed", e)
        }

        this._snapshotRunning = false
        this.settings.yieldFeedback.lastSnapshotAt = Date.now()
        await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        this._lastSnapshotResult = result

        if (this.hubIata && this.rows && this.rows.length) {
            const dests = this.rows.map(r => [this.hubIata, r.destIata])
            this.yieldHistoryMap = await RouteAssistantYieldHistoryStore.getMany(dests)
            RouteAssistantAggregator.applyYieldHistory(this.rows, this.yieldHistoryMap, this.hubIata)
        }
        this._render()
        this._renderSettings()

        if (result) {
            let modeStr
            if (result.attributionMode === "per-flight") {
                modeStr = "per-flight (" + (result.routesWithPerFlight || 0) + " exact, "
                    + (result.routesFellBack || 0) + " fell back)"
            } else if (result.mode === "delta") {
                modeStr = "delta (" + (result.tailsUsingDelta || 0) + "/" + result.tailsUsed + " tails w/ baseline)"
            } else {
                modeStr = "cumulative"
            }
            const summary = "[AES yieldFeedback] snapshot: "
                + result.routesUpdated + " routes updated · "
                + result.tailsUsed + "/" + result.tailsSeen + " tails contributed · "
                + result.tailsMissingProfit + " missing profit data · mode: " + modeStr
            console.log(summary, result)
        }
    }

    // ---------- Carriers (letter F) ----------

    /**
     * Settings-drawer expander for the per-route service profiles defaults.
     * Per-route overrides land via the Seats/wk ▾ popover; this expander
     * lets the user tune the global defaults that fall through.
     */
    _renderServiceProfilesSection() {
        const cfg = this.settings.serviceProfiles = Object.assign(
            {showServiceColumns: true},
            this.settings.serviceProfiles || {}
        )
        // Ensure nested defaults exist (deep-merge already filled them at load,
        // but a fresh upgrade through save() may strip them).
        cfg.defaultClassMix  = Object.assign({Y: 1.0, C: 0,    F: 0  }, cfg.defaultClassMix  || {})
        cfg.classYieldMult   = Object.assign({Y: 1.0, C: 2.5,  F: 4.5}, cfg.classYieldMult   || {})
        cfg.classCostPerPax  = Object.assign({Y: 5,   C: 18,   F: 45 }, cfg.classCostPerPax  || {})
        cfg.serviceLevels    = Object.assign({
            budget:   {yieldMult: 0.85, costPerPax: 3,  label: "Budget"},
            standard: {yieldMult: 1.00, costPerPax: 8,  label: "Standard"},
            premium:  {yieldMult: 1.20, costPerPax: 22, label: "Premium"}
        }, cfg.serviceLevels || {})

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(56, 189, 248, 0.08);border:1px solid rgba(56, 189, 248, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#7dd3fc;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Service profiles</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Default Y/C/F class mix, class yield multipliers, per-pax cost, and service-level posture. Per-route overrides via the Seats/wk ▾.</span>"
        wrap.append(header)

        // ---- Show columns toggle
        const showRow = document.createElement("div")
        showRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;"
        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showServiceColumns !== false
        showCb.addEventListener("change", async () => {
            cfg.showServiceColumns = showCb.checked
            await RouteAssistantSettings.save({serviceProfiles: cfg})
            this._render()
        })
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#7dd3fc;"
        showLbl.append(showCb, document.createTextNode("Show Service columns (Seats/wk · Mix · Svc)"))
        showRow.append(showLbl)
        wrap.append(showRow)

        // ---- Default class mix
        const mixWrap = document.createElement("div")
        mixWrap.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px;flex-wrap:wrap;"
        const mY = mkNumberInput(Math.round((cfg.defaultClassMix.Y || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mC = mkNumberInput(Math.round((cfg.defaultClassMix.C || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mF = mkNumberInput(Math.round((cfg.defaultClassMix.F || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        mixWrap.append((() => { const s = document.createElement("span"); s.textContent = "Default mix %"; s.style.color = "#9ca3af"; return s })())
        for (const [lbl, inp, color] of [["Y", mY, "#7dd3fc"], ["C", mC, "#fcd34d"], ["F", mF, "#fda4af"]]) {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:3px;align-items:center;color:" + color + ";"
            w.append(document.createTextNode(lbl), inp)
            mixWrap.append(w)
        }
        wrap.append(mixWrap)

        // ---- Per-class yield mult + cost
        const fareTable = document.createElement("table")
        fareTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        fareTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Class</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield × base</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
        </tr></thead>`
        const fareBody = document.createElement("tbody")
        const yldInputs = {}
        const costInputs = {}
        const classColors = {Y: "#7dd3fc", C: "#fcd34d", F: "#fda4af"}
        for (const cls of ["Y", "C", "F"]) {
            const yldIn  = mkNumberInput(cfg.classYieldMult[cls],  {min: 0, max: 20,    step: 0.1,  width: "70px"})
            const costIn = mkNumberInput(cfg.classCostPerPax[cls], {min: 0, max: 99999, step: 1,    width: "70px"})
            yldInputs[cls]  = yldIn
            costInputs[cls] = costIn
            const tr = document.createElement("tr")
            const cell = (text, color) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:2px 4px;color:" + (color || "#d1d5db") + ";"
                c.textContent = text
                return c
            }
            tr.append(cell(cls, classColors[cls]))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(yldCell, costCell)
            fareBody.append(tr)
        }
        fareTable.append(fareBody)
        wrap.append(fareTable)

        // ---- Service levels
        const lvlTable = document.createElement("table")
        lvlTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        lvlTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Service level</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield ×</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
        </tr></thead>`
        const lvlBody = document.createElement("tbody")
        const lvlInputs = {}
        for (const lvl of ["budget", "standard", "premium"]) {
            const def = cfg.serviceLevels[lvl] || {}
            const yldIn  = mkNumberInput(def.yieldMult,  {min: 0,    max: 5,    step: 0.05, width: "65px"})
            const costIn = mkNumberInput(def.costPerPax, {min: 0,    max: 9999, step: 1,    width: "65px"})
            lvlInputs[lvl] = {yld: yldIn, cost: costIn}
            const tr = document.createElement("tr")
            const labelCell = document.createElement("td")
            labelCell.style.cssText = "padding:2px 4px;color:#d1d5db;"
            labelCell.textContent = (def.label || (lvl.charAt(0).toUpperCase() + lvl.slice(1)))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(labelCell, yldCell, costCell)
            lvlBody.append(tr)
        }
        lvlTable.append(lvlBody)
        wrap.append(lvlTable)

        // ---- Save row
        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save service-profile defaults"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.background = "#0284c7"
        saveBtn.addEventListener("click", async () => {
            const sumPct = (parseFloatOr(mY.value, 0) || 0)
                         + (parseFloatOr(mC.value, 0) || 0)
                         + (parseFloatOr(mF.value, 0) || 0)
            const factor = sumPct > 0 ? 100 / sumPct : 1
            const norm = {
                Y: Math.max(0, (parseFloatOr(mY.value, 0) || 0) * factor) / 100,
                C: Math.max(0, (parseFloatOr(mC.value, 0) || 0) * factor) / 100,
                F: Math.max(0, (parseFloatOr(mF.value, 0) || 0) * factor) / 100
            }
            cfg.defaultClassMix  = norm
            for (const cls of ["Y", "C", "F"]) {
                cfg.classYieldMult[cls]  = parseFloatOr(yldInputs[cls].value,  cfg.classYieldMult[cls])
                cfg.classCostPerPax[cls] = parseFloatOr(costInputs[cls].value, cfg.classCostPerPax[cls])
            }
            for (const lvl of ["budget", "standard", "premium"]) {
                cfg.serviceLevels[lvl] = Object.assign({}, cfg.serviceLevels[lvl] || {}, {
                    yieldMult:  parseFloatOr(lvlInputs[lvl].yld.value,  cfg.serviceLevels[lvl].yieldMult),
                    costPerPax: parseFloatOr(lvlInputs[lvl].cost.value, cfg.serviceLevels[lvl].costPerPax)
                })
            }
            await RouteAssistantSettings.save({serviceProfiles: cfg})
            this._reapplyServiceProjection()
            this._render()
        })
        wrap.append(saveBtn)

        // ---- AS service profiles auto-detect block
        const asWrap = document.createElement("div")
        asWrap.style.cssText = "margin-top:8px;padding:6px 8px;background:rgba(15, 23, 42, 0.5);border:1px dashed rgba(56, 189, 248, 0.30);border-radius:3px;"
        const asHead = document.createElement("div")
        asHead.style.cssText = "color:#7dd3fc;font-size:10px;margin-bottom:4px;"
        const profileCount = (this.serviceProfilesCache && this.serviceProfilesCache.size) || 0
        const listCache    = this._serviceProfilesList || null
        const lastSyncTxt  = listCache && listCache.scrapedAt
            ? new Date(listCache.scrapedAt).toLocaleString()
            : "never"
        asHead.innerHTML = "<strong>AS service profiles auto-detect</strong> — "
            + profileCount + " profile" + (profileCount === 1 ? "" : "s") + " cached · last sync: " + lastSyncTxt
        asWrap.append(asHead)

        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = this._serviceProfileSyncRunning ? "Syncing…" : "Refresh AS service profiles"
        Object.assign(refreshBtn.style, smallBtnStyle())
        refreshBtn.style.background = "#0ea5e9"
        refreshBtn.disabled = !!this._serviceProfileSyncRunning
        refreshBtn.addEventListener("click", () => this._refreshServiceProfilesFromAS())
        asWrap.append(refreshBtn)

        const asNote = document.createElement("div")
        asNote.style.cssText = "color:#6b7280;font-size:10px;margin-top:4px;line-height:1.4;"
        asNote.innerHTML = "Fetches /action/enterprise/serviceProfiles + per-profile detail pages. "
            + "Each route's <em>assigned</em> service profile (from the markets-page sync) "
            + "then surfaces in the Svc tooltip + Seats/wk popover with its real name + per-class quality score."
        asWrap.append(asNote)
        wrap.append(asWrap)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Mix percentages renormalise to 100% on save. Per-route overrides (Seats/wk ▾) take precedence over these defaults."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Sync the AS service-profile list + every detail referenced. Persists
     * `routeAssistant:serviceProfilesList` and `routeAssistant:serviceProfile:<id>`
     * for the popover / tooltip layer to read on next render.
     */
    async _refreshServiceProfilesFromAS() {
        if (this._serviceProfileSyncRunning) return
        if (typeof RouteAssistantServiceProfileScraper === "undefined") return
        this._serviceProfileSyncRunning = true
        this._renderSettings()
        try {
            if (!this._serviceProfileScraper) {
                this._serviceProfileScraper = new RouteAssistantServiceProfileScraper(this.server)
            }
            await this._serviceProfileScraper.syncAll()
            this.serviceProfilesCache = await RouteAssistantServiceProfileScraper.loadAllDetails()
            this._serviceProfilesList = await RouteAssistantServiceProfileScraper.loadList()
        } catch (e) {
            console.warn("[AES serviceProfile] sync failed", e)
        }
        this._serviceProfileSyncRunning = false
        this._render()
        this._renderSettings()
    }

    /**
     * Settings-drawer expander for the carrier-list scraper.
     * Mirrors `_renderAutoPricingSection`:
     *   - status line: "Synced X/Y routes · last bulk sync: …"
     *   - showCarrierIntensity toggle
     *   - "Sync carriers for all visible routes" CTA
     *
     * Fetches go through `RouteAssistantCarriersScraper.bulkScrape`
     * with concurrency + stagger from `settings.carriers`.
     */
    _renderCarriersSection() {
        const cfg = this.settings.carriers = Object.assign(
            {showCarrierIntensity: true, concurrency: 3, staggerMs: 1200, lastBulkScrapeAt: null},
            this.settings.carriers || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(34, 197, 94, 0.06);border:1px solid rgba(34, 197, 94, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#86efac;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Carriers</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-route carrier list from "
            + "flightsfrom.com/&lt;HUB&gt;-&lt;DEST&gt;. Replaces the integer Cmp count with a "
            + "colored intensity badge (green/amber/red) and a hover tooltip listing each carrier.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r =>
            Array.isArray(r.carriers) || r.carriersScrapedAt
        ).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Synced: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._carrierStatusEl = status

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showCarrierIntensity !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#86efac;"
        showLbl.append(showCb, document.createTextNode("Show colored intensity badge"))
        showCb.addEventListener("change", async () => {
            this.settings.carriers.showCarrierIntensity = showCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._carrierScrapeRunning
            ? "Syncing carriers…"
            : "Sync carriers for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#15803d"
        scanBtn.disabled = !!this._carrierScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkCarrierScrape())
        ctrlRow.append(scanBtn)

        // F slice 2 — bulk-sync AS enterprise metadata for the
        // competitor list. Different button so the user can keep
        // flightsfrom carriers fresh independently of AS enterprise
        // banner/avatar caches (different TTLs).
        const enterpriseBtn = document.createElement("button")
        enterpriseBtn.textContent = this._enterpriseMetaScrapeRunning
            ? "Syncing enterprise data…"
            : "Sync enterprise data (banners + avatars)"
        Object.assign(enterpriseBtn.style, smallBtnStyle())
        enterpriseBtn.style.background = "#1d4ed8"
        // Count distinct enterpriseIds across visible rows so we can
        // gate the button: nothing to do if no AS competitors yet.
        const visibleIds = (() => {
            const s = new Set()
            for (const r of (this.rows || [])) {
                for (const list of [r.marketSharePax, r.marketShareCargo]) {
                    if (!Array.isArray(list)) continue
                    for (const e of list) {
                        if (e && e.enterpriseId != null) s.add(String(e.enterpriseId))
                    }
                }
            }
            return s.size
        })()
        enterpriseBtn.disabled = !!this._enterpriseMetaScrapeRunning
            || !this.hubIata
            || visibleIds === 0
        enterpriseBtn.title = visibleIds > 0
            ? visibleIds + " distinct enterprises visible"
            : "Sync the Markets page first to populate AS competitors."
        enterpriseBtn.addEventListener("click", () => this._runBulkEnterpriseMetaSync())
        ctrlRow.append(enterpriseBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        const lastMeta = (cfg.lastEnterpriseMetaSyncAt)
            ? new Date(cfg.lastEnterpriseMetaSyncAt).toLocaleString()
            : "never"
        note.innerHTML = "flightsfrom.com is rate-limited — defaults are "
            + cfg.concurrency + " concurrent / " + cfg.staggerMs + "ms stagger. "
            + "Hover any Cmp pill to see the carrier list. "
            + "<br>AS enterprise data: " + visibleIds + " visible · last sync " + lastMeta + "."
        wrap.append(note)

        this.settingsHost.append(wrap)

        // F slice 3 — Contractual partners sub-panel. Visually distinct
        // (purple) from the green carriers panel above so the user
        // doesn't conflate "what flightsfrom says about competition"
        // with "what AS says about my own agreements".
        const partnersWrap = document.createElement("div")
        partnersWrap.style.cssText = "margin-top:6px;padding:6px 8px;"
            + "background:rgba(124, 58, 237, 0.06);border:1px solid rgba(124, 58, 237, 0.25);"
            + "border-radius:4px;"

        const partnersHeader = document.createElement("div")
        partnersHeader.style.cssText = "color:#c4b5fd;font-size:11px;margin-bottom:4px;"
        partnersHeader.innerHTML = "<strong>Contractual partners</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Reads your own enterprise's "
            + "<em>Contractual partners</em> tab to mark interlining (⇄) and alliance (✦) partners "
            + "in the Cmp popover.</span>"
        partnersWrap.append(partnersHeader)

        const lastPartnersTs = cfg.lastPartnersSyncAt
            ? new Date(cfg.lastPartnersSyncAt).toLocaleString()
            : "never"
        const partnersStatus = document.createElement("div")
        partnersStatus.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        partnersStatus.textContent = "Configured: " + ((cfg.myEnterpriseIds || []).length)
            + " enterprise id(s) · last sync: " + lastPartnersTs
        partnersWrap.append(partnersStatus)
        // Hold a reference so _runRefreshContractualPartners can update
        // progress in this panel rather than in the green Carriers panel
        // above (which the user might not be looking at).
        this._partnersStatusEl = partnersStatus

        const inputRow = document.createElement("div")
        inputRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:11px;margin-bottom:6px;flex-wrap:wrap;"
        const idsLabel = document.createElement("span")
        idsLabel.textContent = "Own enterprise IDs:"
        idsLabel.style.cssText = "color:#c4b5fd;flex-shrink:0;"
        inputRow.append(idsLabel)

        const idsInput = document.createElement("input")
        idsInput.type = "text"
        idsInput.placeholder = "e.g. 785 or 785, 872"
        idsInput.value = (cfg.myEnterpriseIds || []).join(", ")
        idsInput.style.cssText = "flex:1;min-width:140px;background:#0f1623;border:1px solid #374151;color:#e5e7eb;padding:3px 6px;border-radius:3px;font-size:11px;font-family:monospace;"
        const persistIds = async () => {
            const parsed = idsInput.value.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
            const before = (this.settings.carriers.myEnterpriseIds || []).join(",")
            const after  = parsed.join(",")
            if (before === after) return
            this.settings.carriers.myEnterpriseIds = parsed
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            await this._applyCachedContractualPartners()
            // Rebuild the drawer so the Configured: count + Refresh
            // button's disabled state pick up the new id list. _render()
            // alone only redraws the table, so the drawer would otherwise
            // keep showing stale "Configured: 0".
            this._renderSettings()
            this._render()
        }
        idsInput.addEventListener("change", persistIds)
        idsInput.addEventListener("blur",   persistIds)
        inputRow.append(idsInput)

        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = this._partnersScrapeRunning
            ? "Refreshing…"
            : "Refresh contractual partners"
        Object.assign(refreshBtn.style, smallBtnStyle())
        refreshBtn.style.background = "#7c3aed"
        // Only disable while a scrape is in flight. An empty-IDs click
        // is allowed through so the handler can surface the inline
        // "enter an ID first" hint — avoids the silently-dead button
        // problem when the user types but hasn't blurred the input yet.
        refreshBtn.disabled = !!this._partnersScrapeRunning
        refreshBtn.addEventListener("click", () => this._runRefreshContractualPartners())
        inputRow.append(refreshBtn)
        partnersWrap.append(inputRow)

        const togglesRow = document.createElement("div")
        togglesRow.style.cssText = "display:flex;gap:14px;align-items:center;font-size:11px;flex-wrap:wrap;"

        const ilCb = mkInput("checkbox", null)
        ilCb.checked = cfg.showInterliningGlyph !== false
        const ilLbl = document.createElement("label")
        ilLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#c4b5fd;cursor:pointer;"
        ilLbl.append(ilCb, document.createTextNode("Show ⇄ for interlining partners"))
        ilCb.addEventListener("change", async () => {
            this.settings.carriers.showInterliningGlyph = ilCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        togglesRow.append(ilLbl)

        const alCb = mkInput("checkbox", null)
        alCb.checked = !!cfg.showAllianceGlyph
        const alLbl = document.createElement("label")
        alLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#c4b5fd;cursor:pointer;"
        alLbl.append(alCb, document.createTextNode("Show ✦ for alliance partners"))
        alCb.addEventListener("change", async () => {
            this.settings.carriers.showAllianceGlyph = alCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        togglesRow.append(alLbl)
        partnersWrap.append(togglesRow)

        const partnersHint = document.createElement("div")
        partnersHint.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        partnersHint.innerHTML = "Find your enterprise ID in the AS URL when you open your own profile — e.g. "
            + "<code style='color:#a78bfa;'>/app/info/enterprises/<strong>785</strong>?tab=1</code>. "
            + "Multiple IDs (canopy users): comma-separate them. "
            + "Default cache TTL: " + (cfg.partnersMaxAgeDays || 30) + "d."
        partnersWrap.append(partnersHint)

        this.settingsHost.append(partnersWrap)
    }

    /**
     * Bulk-scrape carrier lists for every (hub, dest) pair in this.rows.
     * Mirrors `_runBulkPriceScrape` — same concurrency/stagger pattern,
     * same `lastBulkScrapeAt` persistence, same re-load + re-render
     * sequence on completion.
     */
    async _runBulkCarrierScrape() {
        if (this._carrierScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.carriers || {}
        const concurrency = cfg.concurrency || 3
        const staggerMs   = cfg.staggerMs   || 1200

        if (!this.carrierScraper) {
            this.carrierScraper = new RouteAssistantCarriersScraper({
                maxAgeDays: cfg.carriersMaxAgeDays
            })
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._carrierScrapeRunning = true
        this._renderSettings()

        const progressHandle = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.progress("Syncing carriers…", {id: "carriers-bulk-scrape", type: "info"})
            : null
        let lastTotal = pairs.length, failed = false
        try {
            await this.carrierScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    lastTotal = total
                    if (this._carrierStatusEl) {
                        this._carrierStatusEl.textContent =
                            "Syncing carriers: " + done + "/" + total + "…"
                    }
                    if (progressHandle) {
                        progressHandle.update({
                            progressPct:   total ? (100 * done / total) : 0,
                            progressLabel: done + " / " + total + " routes"
                        })
                    }
                }
            })
        } catch (e) {
            failed = true
            console.warn("[AES carriersScraper] bulk scrape failed", e)
        }

        this._carrierScrapeRunning = false
        this.settings.carriers.lastBulkScrapeAt = Date.now()
        await RouteAssistantSettings.save({carriers: this.settings.carriers})

        await this._applyCachedCarriers()
        this._render()

        if (progressHandle) {
            progressHandle.complete({
                type:    failed ? "warn" : "success",
                message: failed
                    ? "Carriers sync finished with errors · " + lastTotal + " routes"
                    : "Carriers sync complete · " + lastTotal + " routes"
            })
        }
    }

    /**
     * F slice 2 — bulk-fetch enterprise metadata (banner + avatar +
     * name + IATA) for every distinct enterpriseId currently visible
     * across all rows' marketSharePax / marketShareCargo lists.
     *
     * Skips IDs we already have cached and unexpired — the user can
     * re-run the scrape after the configured TTL passes (default 90
     * days). Idempotent: a full second click does nothing if every ID
     * is fresh.
     */
    async _runBulkEnterpriseMetaSync() {
        if (this._enterpriseMetaScrapeRunning || !this.rows || !this.rows.length) return
        const cfg = this.settings.carriers || {}
        const concurrency = cfg.enterpriseMetaConcurrency || 4
        const staggerMs   = cfg.enterpriseMetaStaggerMs   || 600

        // Collect every enterpriseId visible across both pax + cargo
        // shares. De-duplicate to avoid hammering the same page once
        // per appearance.
        const ids = new Set()
        for (const r of this.rows) {
            for (const list of [r.marketSharePax, r.marketShareCargo]) {
                if (!Array.isArray(list)) continue
                for (const e of list) {
                    if (e && e.enterpriseId != null) ids.add(String(e.enterpriseId))
                }
            }
        }
        if (!ids.size) {
            if (this._carrierStatusEl) {
                this._carrierStatusEl.textContent = "No AS competitors visible — sync the Markets page first."
            }
            return
        }

        // Drop ids that are already fresh in cache.
        const cached = await RouteAssistantEnterpriseMetaScraper.bulkLoadCache(
            Array.from(ids), {maxAgeDays: cfg.enterpriseMetaMaxAgeDays}
        )
        const todo = Array.from(ids).filter(id => !cached.has(id))
        if (!todo.length) {
            if (this._carrierStatusEl) {
                this._carrierStatusEl.textContent = "All " + ids.size + " enterprise records are fresh — nothing to sync."
            }
            return
        }

        if (!this.enterpriseMetaScraper) {
            this.enterpriseMetaScraper = new RouteAssistantEnterpriseMetaScraper(this.server, {
                maxAgeDays: cfg.enterpriseMetaMaxAgeDays
            })
        }

        this._enterpriseMetaScrapeRunning = true
        this._renderSettings()

        const progressHandle = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.progress("Syncing enterprise data…", {id: "enterprise-meta-bulk-scrape", type: "info"})
            : null
        let lastTotal = todo.length, failed = false
        try {
            await this.enterpriseMetaScraper.bulkScrape(todo, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    lastTotal = total
                    if (this._carrierStatusEl) {
                        this._carrierStatusEl.textContent =
                            "Syncing enterprise data: " + done + "/" + total + "…"
                    }
                    if (progressHandle) {
                        progressHandle.update({
                            progressPct:   total ? (100 * done / total) : 0,
                            progressLabel: done + " / " + total + " enterprises"
                        })
                    }
                }
            })
        } catch (e) {
            failed = true
            console.warn("[AES enterpriseMeta] bulk scrape failed", e)
        }

        this._enterpriseMetaScrapeRunning = false
        this.settings.carriers.lastEnterpriseMetaSyncAt = Date.now()
        await RouteAssistantSettings.save({carriers: this.settings.carriers})

        await this._applyCachedEnterpriseMeta()
        this._render()

        if (progressHandle) {
            progressHandle.complete({
                type:    failed ? "warn" : "success",
                message: failed
                    ? "Enterprise sync finished with errors · " + lastTotal + " ids"
                    : "Enterprise sync complete · " + lastTotal + " ids"
            })
        }
    }

    /**
     * F slice 3 — fetch the user's own enterprise(s) "Contractual
     * partners" tab and persist the results. Driven by
     * `settings.carriers.myEnterpriseIds` (small list, typically 1-2
     * for a single-airline user, more for canopy-style multi-airline
     * setups).
     *
     * Always re-fetches every id when the user clicks (no
     * already-fresh skip). The user only triggers this manually after
     * they sign new agreements, so deferring the cache is the wrong
     * default — fresh data is what they pressed the button for.
     */
    async _runRefreshContractualPartners() {
        if (this._partnersScrapeRunning) return
        const cfg = this.settings.carriers || {}
        const ids = (cfg.myEnterpriseIds || []).map(v => String(v).trim()).filter(Boolean)
        const setStatus = (msg) => {
            if (this._partnersStatusEl) this._partnersStatusEl.textContent = msg
        }
        if (!ids.length) {
            setStatus("⚠ Enter at least one of your own enterprise IDs first, then press Tab to commit.")
            return
        }

        if (!this.contractualPartnersScraper) {
            this.contractualPartnersScraper = new RouteAssistantContractualPartnersScraper(this.server, {
                maxAgeDays: cfg.partnersMaxAgeDays
            })
        }

        this._partnersScrapeRunning = true
        this._renderSettings()
        // _renderSettings() rebuilt the drawer, which created a new
        // partnersStatus DOM node — the local `setStatus` closure points
        // at the OLD node. Re-resolve via the latest `this._partnersStatusEl`
        // on every status update so the user actually sees the message.
        const writeStatus = (msg) => {
            if (this._partnersStatusEl) this._partnersStatusEl.textContent = msg
        }
        console.log("[AES partnersScraper] starting refresh for ids:", ids)
        writeStatus("Refreshing " + ids.length + " enterprise(s)… (see DevTools console for per-id progress)")

        let scrapeError = null
        const progressHandle = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.progress("Refreshing contractual partners…", {id: "partners-bulk-scrape", type: "info"})
            : null
        let lastTotal = ids.length
        try {
            await this.contractualPartnersScraper.bulkScrape(ids, {
                concurrency: cfg.partnersConcurrency || 2,
                staggerMs:   cfg.partnersStaggerMs   || 400,
                onProgress:  (done, total) => {
                    lastTotal = total
                    writeStatus("Refreshing partners: " + done + "/" + total + "…")
                    if (progressHandle) {
                        progressHandle.update({
                            progressPct:   total ? (100 * done / total) : 0,
                            progressLabel: done + " / " + total + " enterprises"
                        })
                    }
                }
            })
        } catch (e) {
            scrapeError = e
            console.warn("[AES partnersScraper] bulk scrape failed", e)
        }
        if (progressHandle) {
            progressHandle.complete({
                type:    scrapeError ? "warn" : "success",
                message: scrapeError
                    ? "Partners refresh finished with errors · " + lastTotal + " ids"
                    : "Partners refresh complete · " + lastTotal + " ids"
            })
        }

        this._partnersScrapeRunning = false
        this.settings.carriers.lastPartnersSyncAt = Date.now()
        await RouteAssistantSettings.save({carriers: this.settings.carriers})

        await this._applyCachedContractualPartners()

        // Summarise the result before _renderSettings() rebuilds the
        // drawer — the next render reverts the status line back to
        // "Configured: N · last sync: …" but the console log persists.
        const totalPartners = this._partnersByEnterpriseId
            ? this._partnersByEnterpriseId.size
            : 0
        if (scrapeError) {
            console.warn("[AES partnersScraper] refresh finished with errors:", scrapeError)
        } else {
            console.log("[AES partnersScraper] refresh complete:",
                ids.length, "enterprise(s),",
                totalPartners, "distinct partner(s) cross-referenced")
        }

        this._renderSettings()
        this._render()
    }

    // ---------- Market Analysis (Tier 2a — markets-page scraper) ----------

    /**
     * Bulk-load the per-route markets cache (4 split families) and project
     * derived fields onto each row: market share %, competitor count, median
     * competitor Y price, our pricing-drift flag.
     */
    async _applyCachedMarkets() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const cfg = (this.settings && this.settings.marketAnalysis) || {}
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cache = await RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {
            maxAge: {
                competitors: cfg.competitorMaxAgeDays,
                marketShare: cfg.shareMaxAgeDays,
                historic:    cfg.historicMaxAgeDays
            }
        })
        let ourName = ""
        try { ourName = (typeof AES !== "undefined" && AES.getAirlineIdentity) ? AES.getAirlineIdentity() : "" }
        catch (e) { ourName = "" }
        const ourNameLow = (ourName || "").toLowerCase().trim()

        // Our enterprise ID(s) — harvested from the navbar's "Switch
        // Enterprise" dropdown links (`<a href="../enterprise/dashboard?select=<ID>">`).
        // The leaderboard rows on the markets page link enterprise pages by
        // numeric ID, so an ID-match is rock-solid where a name match is
        // fragile (extra spaces, periods, "Airways" suffix variants).
        // Multi-enterprise users (e.g. FLY NYON. + NYON.) collect all IDs.
        const ourEnterpriseIds = new Set()
        try {
            for (const a of document.querySelectorAll(".as-navbar-main a[href*='dashboard?select=']")) {
                const m = /select=(\d+)/.exec(a.getAttribute("href") || "")
                if (m) ourEnterpriseIds.add(parseInt(m[1], 10))
            }
        } catch (e) { /* ignore */ }

        for (const r of this.rows) {
            const key = RouteAssistantMarketsPageScraper._pairKey(this.hubIata, r.destIata)
            const bucket = cache.get(key)
            if (!bucket) continue
            r.marketsScrapedAt = (bucket.competitors && bucket.competitors.scrapedAt)
                || (bucket.marketShare && bucket.marketShare.scrapedAt)
                || null

            if (bucket.marketShare) {
                r.marketSharePeriod = bucket.marketShare.period || null
                r.marketSharePax    = (bucket.marketShare.pax   || []).map(e => Object.assign({}, e))
                r.marketShareCargo  = (bucket.marketShare.cargo || []).map(e => Object.assign({}, e))

                // Match "us" in pax leaderboard: enterprise ID first
                // (rock-solid), then airline name (fragile).
                let ourPaxShare = null
                for (const e of r.marketSharePax) {
                    if (e.enterpriseId != null && ourEnterpriseIds.has(e.enterpriseId)) {
                        ourPaxShare = e.sharePct
                        break
                    }
                }
                if (ourPaxShare == null && ourNameLow) {
                    for (const e of r.marketSharePax) {
                        if (e.name && e.name.toLowerCase().trim() === ourNameLow) {
                            ourPaxShare = e.sharePct
                            break
                        }
                    }
                }
                r.ourPaxShare = ourPaxShare

                // Competitor count: distinct enterprises across BOTH pax
                // and cargo leaderboards, excluding ours. A pax-only
                // count missed any cargo-only operators on mixed
                // routes, which is the primary cause of "Cmp count
                // doesn't match the list" reports.
                const ids = new Set()
                const merged = new Map()  // key → {enterpriseId|name, name, paxShare, cargoShare, paxRank, cargoRank, paxChange, cargoChange}
                const addEntry = (e, kind) => {
                    if (!e) return
                    const isOurs = (e.enterpriseId != null && ourEnterpriseIds.has(e.enterpriseId))
                        || (e.name && e.name.toLowerCase().trim() === ourNameLow)
                    if (isOurs) return
                    const key = e.enterpriseId != null ? "id:" + e.enterpriseId : "name:" + (e.name || "").toLowerCase().trim()
                    if (!key || key === "name:") return
                    ids.add(key)
                    let slot = merged.get(key)
                    if (!slot) {
                        slot = {
                            enterpriseId: e.enterpriseId != null ? e.enterpriseId : null,
                            name:         e.name || null,
                            paxShare:     null,
                            cargoShare:   null,
                            paxRank:      null,
                            cargoRank:    null,
                            paxChange:    null,
                            cargoChange:  null
                        }
                        merged.set(key, slot)
                    }
                    if (e.name && !slot.name) slot.name = e.name
                    if (kind === "pax") {
                        slot.paxShare  = e.sharePct
                        slot.paxRank   = e.rank
                        slot.paxChange = e.change
                    } else {
                        slot.cargoShare  = e.sharePct
                        slot.cargoRank   = e.rank
                        slot.cargoChange = e.change
                    }
                }
                for (const e of (r.marketSharePax   || [])) addEntry(e, "pax")
                for (const e of (r.marketShareCargo || [])) addEntry(e, "cargo")
                r.competitorCount   = ids.size || null
                r.competitorEntries = Array.from(merged.values())
            }

            if (bucket.ownPricing) {
                r.ownPricing       = bucket.ownPricing.prices   || null
                r.ownPriceDefaults = bucket.ownPricing.defaults || null
                // Project AS's general settings for the route (service
                // profile + terminals + boarding/cargo prefs) onto the
                // row so the Service tooltip + popover surface what AS
                // currently has assigned.
                const gs = bucket.ownPricing.generalSettings || null
                if (gs) {
                    r.serviceProfileId    = (typeof gs.serviceProfileId === "number") ? gs.serviceProfileId : null
                    r.serviceProfileName  = gs.serviceProfile || null
                    r.originTerminal      = gs.originTerminal || null
                    r.destinationTerminal = gs.destinationTerminal || null
                    r.boardingPreference  = gs.boardingPreference || null
                    r.cargoPreference     = gs.cargoPreference || null
                }
                if (r.ownPricing && r.ownPriceDefaults) {
                    let drift = false
                    for (const cls of ["Y", "C", "F", "Cargo"]) {
                        if (r.ownPricing[cls] != null && r.ownPriceDefaults[cls] != null
                            && r.ownPricing[cls] !== r.ownPriceDefaults[cls]) {
                            drift = true; break
                        }
                    }
                    r.pricingDrift = drift ? "drift" : "default"
                }
            }

            if (bucket.competitors) {
                const all = bucket.competitors.competitors || []
                const competitorYs = []
                // Distinct competitor airline prefixes derived from the
                // route's flight list. Used to BACKFILL competitorEntries
                // when the markets page didn't render a market-share
                // section (new routes / no completed bookings yet).
                // Without this, the rich popover had nothing to show on
                // the majority of routes even though we knew exactly who
                // was flying them.
                const flightPrefixes = new Map()  // prefix → {prefix, flights, sampleType}
                for (const c of all) {
                    if (c.isOurs) continue
                    if (c.serviceClass === "Y" && typeof c.price === "number" && c.price > 0) {
                        competitorYs.push(c.price)
                    }
                    if (c.flightCode) {
                        const m = /^([A-Z0-9]+)/.exec(c.flightCode.trim().toUpperCase())
                        if (m) {
                            const p = m[1]
                            let slot = flightPrefixes.get(p)
                            if (!slot) {
                                slot = {prefix: p, flights: 0, sampleType: c.typeCode || null}
                                flightPrefixes.set(p, slot)
                            }
                            slot.flights += 1
                            if (!slot.sampleType && c.typeCode) slot.sampleType = c.typeCode
                        }
                    }
                }
                if (competitorYs.length) {
                    competitorYs.sort((a, b) => a - b)
                    const mid = Math.floor(competitorYs.length / 2)
                    r.competitorMedianPriceY = competitorYs.length % 2
                        ? competitorYs[mid]
                        : Math.round((competitorYs[mid - 1] + competitorYs[mid]) / 2)
                } else {
                    r.competitorMedianPriceY = null
                }
                // Stash the raw prefix → flight-count map; the popover
                // can render this when the leaderboard is empty.
                r.competitorFlightPrefixes = Array.from(flightPrefixes.values())

                // Backfill competitorEntries from flight prefixes when the
                // leaderboard parse produced nothing. Each entry uses the
                // prefix as its display name (no enterprise ID — the
                // markets page doesn't link enterprises from the inventory
                // table). Marked `fromFlightList: true` so the popover can
                // render a hint that this is derived intel.
                if (!Array.isArray(r.competitorEntries) || r.competitorEntries.length === 0) {
                    if (flightPrefixes.size) {
                        r.competitorEntries = Array.from(flightPrefixes.values()).map(slot => ({
                            enterpriseId:    null,
                            name:            slot.prefix + "  ·  " + slot.flights + " flight"
                                                + (slot.flights === 1 ? "" : "s"),
                            paxShare:        null,
                            cargoShare:      null,
                            paxRank:         null,
                            cargoRank:       null,
                            paxChange:       null,
                            cargoChange:     null,
                            sampleType:      slot.sampleType,
                            flightsOnRoute:  slot.flights,
                            fromFlightList:  true
                        }))
                        if (r.competitorCount == null) r.competitorCount = flightPrefixes.size
                    }
                }
            }

            if (bucket.historic) {
                r.historicPeriods    = bucket.historic.periods
                r.historicCapacities = bucket.historic.capacities
                r.historicPrices     = bucket.historic.prices
            }
        }
    }

    /**
     * Settings-drawer block for the markets-page scraper. Mirrors the
     * Live route data expander pattern: status line + show-cols toggle +
     * Sync CTA + lastBulkScrapeAt.
     */
    _renderMarketAnalysisSection() {
        const cfg = this.settings.marketAnalysis = Object.assign(
            {showColumns: true, concurrency: 4, staggerMs: 800, lastBulkScrapeAt: null,
             competitorMaxAgeDays: null, shareMaxAgeDays: 7, historicMaxAgeDays: null,
             defaultPayloadChart: "ECONOMY"},
            this.settings.marketAnalysis || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(20, 184, 166, 0.08);border:1px solid rgba(20, 184, 166, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#5eead4;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Market Analysis</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-route competitor flights, "
            + "your pricing snapshot, market-share leaderboard, and 25-week capacity/price charts "
            + "from /app/com/markets/&lt;HUB&gt;&lt;DEST&gt;.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r =>
            r.ourPaxShare != null || r.competitorCount != null || r.competitorMedianPriceY != null
        ).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Captured: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._marketStatusEl = status

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#5eead4;"
        showLbl.append(showCb, document.createTextNode("Show market-analysis columns"))
        showCb.addEventListener("change", async () => {
            this.settings.marketAnalysis.showColumns = showCb.checked
            await RouteAssistantSettings.save({marketAnalysis: this.settings.marketAnalysis})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._marketScrapeRunning
            ? "Syncing markets…"
            : "Sync market analysis for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#0d9488"
        scanBtn.disabled = !!this._marketScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkMarketScrape())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Storage is split across 4 keys per route "
            + "(<code>competitors</code> / <code>ownPricing</code> / <code>marketShare</code> / "
            + "<code>historic</code>) so each can have its own freshness window. "
            + "Visiting /app/com/markets/&lt;HUB&gt;&lt;DEST&gt; in your browser also live-captures."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Bulk-scrape markets pages for every (hub, dest) pair in this.rows.
     * Mirrors `_runBulkPriceScrape` — same concurrency/stagger pattern,
     * same `lastBulkScrapeAt` persistence, same re-load + re-render.
     */
    async _runBulkMarketScrape() {
        if (this._marketScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.marketAnalysis || {}
        const ddCfg = this.settings.demandDepth || {}
        const concurrency = cfg.concurrency || 4
        const staggerMs   = cfg.staggerMs   || 800

        if (!this.marketsScraper) {
            this.marketsScraper = new RouteAssistantMarketsPageScraper(this.server, {})
        }
        // Letter K — fold demand depth into the markets sync. We share the
        // same orchestrator instance so the user gets historic per-payload +
        // inventory data without a separate click. The dedicated Demand
        // Depth bulk sync stays as a granular fallback.
        if (!this.inventoryScraper) {
            this.inventoryScraper = new RouteAssistantInventoryPageScraper(this.server, {
                maxAgeDays: ddCfg.inventoryMaxAgeDays
            })
        }
        const ddCoverage = ddCfg.classCoverage || "full"
        const ddPayloads = (ddCoverage === "full")
            ? RouteAssistantMarketsPageScraper.HISTORIC_PAYLOADS
            : ["PAX", "CARGO"]
        const ddConcurrency = ddCfg.concurrency || 3
        const ddStaggerMs   = ddCfg.staggerMs   || 1200

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._marketScrapeRunning = true
        this._demandScrapeRunning = true
        this._renderSettings()

        const setStatus = (msg) => {
            if (this._marketStatusEl) this._marketStatusEl.textContent = msg
            if (this._demandStatusEl) this._demandStatusEl.textContent = msg
        }

        // N1 progress toast — single rolling indicator across the 3 phases.
        // Total "work" is 3 × pairs (markets families + historic + inventory);
        // we map each phase's local done/total onto a slice of the global bar.
        const totalWork = pairs.length * 3
        let workDone = 0
        const progressHandle = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.progress("Syncing market analysis…", {
                id:   "markets-bulk-scrape",
                type: "info"
              })
            : null
        const updateProgress = (phaseLabel, phaseDone, phaseTotal, phaseIdx) => {
            const phaseStart = phaseIdx * pairs.length
            workDone = phaseStart + phaseDone
            if (progressHandle) {
                progressHandle.update({
                    message:       phaseLabel,
                    progressPct:   totalWork ? (100 * workDone / totalWork) : 0,
                    progressLabel: phaseDone + " / " + phaseTotal + " · phase " + (phaseIdx + 1) + " of 3"
                })
            }
        }

        let phaseFailed = false
        try {
            // Phase 1: markets families (competitors / ownPricing / marketShare)
            await this.marketsScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    setStatus("Syncing market analysis (families): " + done + "/" + total + "…")
                    updateProgress("Syncing market analysis…", done, total, 0)
                }
            })
        } catch (e) {
            phaseFailed = true
            console.warn("[AES marketsScraper] bulk scrape failed", e)
        }

        try {
            // Phase 2: demand depth — per-payload historic
            const payloadLabel = ddPayloads.join(", ")
            await this.marketsScraper.bulkScrapeHistoric(pairs, {
                payloads:    ddPayloads,
                concurrency: ddConcurrency,
                staggerMs:   ddStaggerMs,
                onProgress:  (done, total) => {
                    setStatus("Fetching demand-depth historic (" + payloadLabel + "): " + done + "/" + total + "…")
                    updateProgress("Fetching demand-depth historic (" + payloadLabel + ")…", done, total, 1)
                }
            })
        } catch (e) {
            phaseFailed = true
            console.warn("[AES marketsScraper] historic bulk scrape failed", e)
        }

        try {
            // Phase 3: inventory (RM tightness)
            await this.inventoryScraper.bulkScrape(pairs, {
                concurrency: ddConcurrency,
                staggerMs:   ddStaggerMs,
                onProgress:  (done, total) => {
                    setStatus("Fetching inventory (RM tightness): " + done + "/" + total + "…")
                    updateProgress("Fetching inventory (RM tightness)…", done, total, 2)
                }
            })
        } catch (e) {
            phaseFailed = true
            console.warn("[AES inventoryScraper] bulk scrape failed", e)
        }

        if (progressHandle) {
            progressHandle.complete({
                type:    phaseFailed ? "warn" : "success",
                message: phaseFailed
                    ? ("Markets sync finished with errors · " + pairs.length + " routes")
                    : ("Markets + demand-depth sync complete · " + pairs.length + " routes")
            })
        }

        const now = Date.now()
        this._marketScrapeRunning = false
        this._demandScrapeRunning = false
        this.settings.marketAnalysis.lastBulkScrapeAt = now
        this.settings.demandDepth.lastBulkScrapeAt    = now
        await RouteAssistantSettings.save({
            marketAnalysis: this.settings.marketAnalysis,
            demandDepth:    this.settings.demandDepth
        })

        await this._applyCachedMarkets()
        // Newly-cached ownPricing feeds the per-class yield resolution in the
        // service projection — re-apply so the Service columns reflect the
        // scraped fares without waiting for the next refresh.
        this._reapplyServiceProjection()
        // Re-derive demand depth — markets historic and inventory both just
        // landed, so the Pool / Avg$ / Elasticity / RM% columns light up
        // automatically. Aggregator follows so the profit estimator can pick
        // up the new real-demand inputs (gated by useRealDemandForLF).
        await this._applyCachedDemand()
        RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
        setStatus("Sync complete.")
        this._render()
    }

    /**
     * Letter K — auto-refresh markets + demand depth in the background when
     * the cached data is stale. Mirrors `_enrichDistancesAsync`'s
     * fire-and-forget pattern: kicks off after init() finishes its
     * synchronous cache application.
     *
     * Skip cases:
     *   - settings.marketAnalysis.autoRefreshOnMount === false
     *   - hub or rows missing
     *   - markets AND demand-depth both fresh (< staleThresholdDays old)
     *   - user pressed Skip recently (lastAutoRefreshSkipAt within threshold)
     *   - a sync is already running
     */
    _maybeAutoRefreshMarketsAndDemand() {
        if (this._disposed) return
        if (this._marketScrapeRunning || this._demandScrapeRunning) return
        const cfg = (this.settings && this.settings.marketAnalysis) || {}
        if (cfg.autoRefreshOnMount === false) return
        if (!this.hubIata || !this.rows || !this.rows.length) return

        const threshold = Math.max(1, cfg.staleThresholdDays || 14)
        const thresholdMs = threshold * 86400000
        const now = Date.now()
        const lastMarkets = cfg.lastBulkScrapeAt
        const lastDemand  = (this.settings.demandDepth && this.settings.demandDepth.lastBulkScrapeAt) || null
        const lastSkip    = cfg.lastAutoRefreshSkipAt

        if (lastSkip && (now - lastSkip) < thresholdMs) return
        const isStale = (ts) => ts === null || ts === undefined || (now - ts) >= thresholdMs
        if (!isStale(lastMarkets) && !isStale(lastDemand)) return

        this._renderAutoRefreshBanner({lastMarkets: lastMarkets, lastDemand: lastDemand})

        // Defer the actual scrape briefly so the user has time to hit Skip.
        // 5s is long enough for a glance, short enough to feel "automatic".
        setTimeout(() => {
            if (this._autoRefreshSkipped || this._marketScrapeRunning || this._disposed) return
            this._runBulkMarketScrape()
        }, 5000)
    }

    /**
     * Banner above the table announcing the upcoming auto-refresh + a Skip
     * button. Auto-clears when the scrape begins or the user dismisses.
     * Persists `lastAutoRefreshSkipAt` so the banner is suppressed for the
     * same threshold window across mounts.
     */
    _renderAutoRefreshBanner(info) {
        if (this._autoRefreshBanner || this._disposed) return
        const wrap = document.createElement("div")
        wrap.style.cssText = "background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.4);"
            + "color:#c4b5fd;padding:6px 10px;border-radius:4px;margin:4px 0;font-size:11px;"
            + "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;"
        const fmt = ts => ts ? new Date(ts).toLocaleDateString() : "never"
        const left = document.createElement("div")
        left.innerHTML = "<strong>Auto-refresh starting in 5s</strong> "
            + "<span style='color:#9ca3af;'>— Markets last sync: " + fmt(info.lastMarkets)
            + " · Demand depth last sync: " + fmt(info.lastDemand) + "</span>"
        wrap.append(left)
        const skip = document.createElement("button")
        skip.textContent = "Skip this refresh"
        Object.assign(skip.style, smallBtnStyle())
        skip.style.background = "#374151"
        skip.addEventListener("click", async () => {
            this._autoRefreshSkipped = true
            this.settings.marketAnalysis.lastAutoRefreshSkipAt = Date.now()
            await RouteAssistantSettings.save({marketAnalysis: this.settings.marketAnalysis})
            if (wrap.parentNode) wrap.parentNode.removeChild(wrap)
            this._autoRefreshBanner = null
        })
        wrap.append(skip)
        if (this.statusBar && this.statusBar.parentNode) {
            this.statusBar.parentNode.insertBefore(wrap, this.statusBar.nextSibling)
        }
        this._autoRefreshBanner = wrap

        // Auto-clear when the scrape begins (ten seconds covers the 5s defer
        // + a beat). _renderSettings on bulk start would also clobber this if
        // it lived in settingsHost; we anchor on the panel root instead.
        setTimeout(() => {
            if (this._autoRefreshBanner === wrap && wrap.parentNode) {
                wrap.parentNode.removeChild(wrap)
            }
            this._autoRefreshBanner = null
        }, 10000)
    }

    // ---------- Demand depth (Letter K — markets historic + inventory + derivator) ----------

    /**
     * Letter K — load every cached input the demand-derivator needs
     * (markets historic by-payload + inventory) and compute per-row
     * pool / elasticity / RM tightness scalars. Idempotent; pure
     * read of caches written by the demand-depth bulk sync.
     */
    async _applyCachedDemand() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const cfg = (this.settings && this.settings.demandDepth) || {}
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))

        const histMap = await RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {
            families: ["historic", "ownPricing"],
            maxAge:   {historic: cfg.historicMaxAgeDays}
        })
        const invMap = await RouteAssistantInventoryPageScraper.bulkLoadCache(pairs, {
            maxAgeDays: cfg.inventoryMaxAgeDays
        })

        const window = cfg.historicWindowPeriods || 12
        for (const r of this.rows) {
            const key = RouteAssistantMarketsPageScraper._pairKey(this.hubIata, r.destIata)
            const bucket = histMap.get(key)
            const historic   = (bucket && bucket.historic)   || null
            const ownPricing = (bucket && bucket.ownPricing) || null
            const inventory  = invMap.get(RouteAssistantInventoryPageScraper._pairKey(this.hubIata, r.destIata)) || null

            const derived = RouteAssistantDemandDerivator.derive(historic, inventory, ownPricing, {window: window})
            r.paxDemandPool   = derived.paxDemandPool
            r.cargoDemandPool = derived.cargoDemandPool
            r.paxAvgPrice     = derived.paxAvgPrice
            r.cargoAvgPrice   = derived.cargoAvgPrice
            r.paxElasticity   = derived.paxElasticity
            r.cargoElasticity = derived.cargoElasticity
            r.rmTightness     = derived.rmTightness
            r.demandDerivedAt = derived.scrapedAt
            r.demandNotes     = derived.derivationNotes
        }
    }

    /**
     * Letter K — bulk-fan-out per-class historic + inventory fetches
     * across visible routes. Concurrency 3 / stagger 1200ms by default
     * to stay friendly to a parallel ORS bulk sync.
     */
    async _runBulkDemandSync() {
        if (this._demandScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.demandDepth || {}
        const concurrency = cfg.concurrency || 3
        const staggerMs   = cfg.staggerMs   || 1200
        const coverage    = cfg.classCoverage || "summary"
        const payloads    = (coverage === "full")
            ? RouteAssistantMarketsPageScraper.HISTORIC_PAYLOADS
            : ["PAX", "CARGO"]

        if (!this.marketsScraper) {
            this.marketsScraper = new RouteAssistantMarketsPageScraper(this.server, {})
        }
        if (!this.inventoryScraper) {
            this.inventoryScraper = new RouteAssistantInventoryPageScraper(this.server, {
                maxAgeDays: cfg.inventoryMaxAgeDays
            })
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._demandScrapeRunning = true
        this._renderSettings()

        const totalSteps = pairs.length * payloads.length + pairs.length
        let stepDone = 0
        const progressHandle = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.progress("Syncing demand depth…", {id: "demand-bulk-scrape", type: "info"})
            : null
        const tickProgress = (phaseLabel) => {
            stepDone++
            if (this._demandStatusEl) {
                this._demandStatusEl.textContent =
                    "Syncing demand depth: " + stepDone + "/" + totalSteps + "…"
            }
            if (progressHandle) {
                progressHandle.update({
                    message:       phaseLabel || "Syncing demand depth…",
                    progressPct:   totalSteps ? (100 * stepDone / totalSteps) : 0,
                    progressLabel: stepDone + " / " + totalSteps + " steps"
                })
            }
        }

        let failed = false
        try {
            await this.marketsScraper.bulkScrapeHistoric(pairs, {
                payloads:    payloads,
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  () => tickProgress("Fetching historic (" + payloads.join(", ") + ")…")
            })
            await this.inventoryScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  () => tickProgress("Fetching inventory (RM tightness)…")
            })
        } catch (e) {
            failed = true
            console.warn("[AES demandDepth] bulk sync failed", e)
        }

        this._demandScrapeRunning = false
        this.settings.demandDepth.lastBulkScrapeAt = Date.now()
        await RouteAssistantSettings.save({demandDepth: this.settings.demandDepth})

        await this._applyCachedDemand()
        RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
        this._render()

        if (progressHandle) {
            progressHandle.complete({
                type:    failed ? "warn" : "success",
                message: failed
                    ? "Demand depth sync finished with errors · " + pairs.length + " routes"
                    : "Demand depth sync complete · " + pairs.length + " routes"
            })
        }
    }

    /**
     * Settings-drawer expander for demand-depth. Slate-tinted; sits
     * below Market Analysis. The `useRealDemandForLF` toggle prompts
     * a confirm the first time it's flipped on because it shifts
     * every existing profit number.
     */
    _renderDemandDepthSection() {
        const cfg = this.settings.demandDepth = Object.assign(
            {showDemandColumns: true, classCoverage: "summary", useRealDemandForLF: false,
             concurrency: 3, staggerMs: 1200, historicWindowPeriods: 12,
             lastBulkScrapeAt: null, historicMaxAgeDays: null, inventoryMaxAgeDays: 3},
            this.settings.demandDepth || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(100, 116, 139, 0.08);border:1px solid rgba(100, 116, 139, 0.35);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#cbd5e1;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Demand depth</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-class historic + inventory RM buckets. "
            + "Derives per-route demand pool, price elasticity, and RM tightness so the score blend can use real "
            + "AS demand instead of the 0–10 station badge.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.paxDemandPool != null || r.cargoDemandPool != null).length
        const lastSync  = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Synced: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastSync
            + " · class coverage: " + cfg.classCoverage
        wrap.append(status)
        this._demandStatusEl = status

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showDemandColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;"
        showLbl.append(showCb, document.createTextNode("Show demand columns"))
        showCb.addEventListener("change", async () => {
            this.settings.demandDepth.showDemandColumns = showCb.checked
            await RouteAssistantSettings.save({demandDepth: this.settings.demandDepth})
            this._render()
        })
        ctrlRow.append(showLbl)

        const coverageSel = mkSelect([
            {value: "summary", label: "Coverage: Summary (PAX + CARGO)"},
            {value: "full",    label: "Coverage: Full (Y / C / F / PAX / CARGO)"}
        ], cfg.classCoverage || "summary")
        coverageSel.addEventListener("change", async () => {
            this.settings.demandDepth.classCoverage = coverageSel.value
            await RouteAssistantSettings.save({demandDepth: this.settings.demandDepth})
            this._renderSettings()
        })
        ctrlRow.append(coverageSel)

        const realCb = mkInput("checkbox", null)
        realCb.checked = !!cfg.useRealDemandForLF
        const realLbl = document.createElement("label")
        realLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fde68a;"
        realLbl.title = "Advanced — when on, the profit estimator uses pool / weeklySeats for LF instead of the 0–10 paxScore interpolation. Routes with no pool yet keep the paxScore path."
        realLbl.append(realCb, document.createTextNode("Use real demand for LF (advanced)"))
        realCb.addEventListener("change", async () => {
            if (realCb.checked && !cfg.useRealDemandForLF) {
                if (!confirm("Switch profit-estimator load factor to real demand pool?\n\nThis will shift every $/flt and $/wk number on routes that have demand-depth data. Routes without pool data keep the existing paxScore path.")) {
                    realCb.checked = false
                    return
                }
            }
            this.settings.demandDepth.useRealDemandForLF = realCb.checked
            await RouteAssistantSettings.save({demandDepth: this.settings.demandDepth})
            RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
            this._render()
        })
        ctrlRow.append(realLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._demandScrapeRunning
            ? "Syncing demand…"
            : "Sync demand depth"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#475569"
        scanBtn.disabled = !!this._demandScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkDemandSync())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Heavy scrape — " + (cfg.classCoverage === "full" ? "5" : "2")
            + " markets fetches × every visible route + 1 inventory fetch each. "
            + cfg.concurrency + " concurrent / " + cfg.staggerMs + "ms stagger. "
            + "Friendly to a parallel ORS sync (different endpoint)."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    // ---------- ORS Sandbox (Letter I slice 1 — pricing simulator config) ----------

    /**
     * Settings drawer expander for ORS Sandbox tunables. Three numeric
     * inputs (α_price, α_comfort, default T) + a "Reset all per-route
     * Ts" button + a "Reset to defaults" button. The sandbox UI itself
     * lives in the panel mode toggled via the 🧪 header button.
     */
    _renderOrsSandboxSection() {
        const cfg = this.settings.orsSandbox = Object.assign({
            enabled:       false,
            lastRouteIata: null,
            lastScenarioByRoute: {},
            modelParams:   {ratingPriceElasticity: 8, ratingComfortLift: 5, shareTemperature: 25.0},
            perRouteTemperature:             {},
            perRouteTemperatureCalibratedAt: {}
        }, this.settings.orsSandbox || {})
        const params = cfg.modelParams = Object.assign(
            {ratingPriceElasticity: 8, ratingComfortLift: 5, shareTemperature: 25.0},
            cfg.modelParams || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(100, 116, 139, 0.08);border:1px solid rgba(100, 116, 139, 0.35);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#cbd5e1;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>ORS Sandbox</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Pricing simulator (🧪 in panel header). "
            + "Tunes how much projected rating shifts per ±100% price change (α<sub>price</sub>) and per "
            + "service-level step (α<sub>comfort</sub>), plus the softmax temperature T that translates "
            + "rating differences into share. Lower T = sharper share-by-rank.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const perRouteCount = Object.keys(cfg.perRouteTemperature || {}).length
        const lastRoute = cfg.lastRouteIata ? String(cfg.lastRouteIata).toUpperCase() : "—"
        // Count how many calibrated Ts are >=30d old so the user knows when
        // the calibration cache is decaying without opening each route.
        let staleCount = 0
        const stamps = cfg.perRouteTemperatureCalibratedAt || {}
        const staleThreshold = Date.now() - 30 * 86400000
        for (const k in (cfg.perRouteTemperature || {})) {
            const ts = Number(stamps[k])
            if (!isFinite(ts) || ts < staleThreshold) staleCount++
        }
        const staleSuffix = (perRouteCount && staleCount)
            ? " (" + staleCount + " stale ≥30d)"
            : ""
        status.textContent = "Last route: " + lastRoute
            + " · per-route Ts saved: " + perRouteCount + staleSuffix
            + " · sandbox " + (cfg.enabled ? "ON" : "OFF")
        wrap.append(status)

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const mkNumLabel = (text, val, min, max, step, onChange, tooltip) => {
            const lab = document.createElement("label")
            lab.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;"
            if (tooltip) lab.title = tooltip
            const inp = document.createElement("input")
            inp.type = "number"
            inp.min  = String(min)
            inp.max  = String(max)
            inp.step = String(step)
            inp.value = String(val)
            inp.style.cssText = "width:70px;background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
                + "border-radius:3px;padding:1px 4px;font-size:11px;"
            inp.addEventListener("change", () => onChange(Number(inp.value)))
            lab.append(document.createTextNode(text + " "))
            lab.append(inp)
            return lab
        }

        ctrlRow.append(mkNumLabel("α price", params.ratingPriceElasticity, 0, 50, 0.5,
            async (v) => {
                if (!isFinite(v)) return
                this.settings.orsSandbox.modelParams.ratingPriceElasticity = v
                await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox})
                this._orsSandboxResult = null
                if (this.settings.orsSandbox.enabled) this._render()
            },
            "Rating points shifted per ±100% price change. Default 8 — defensible 0–30% deviation. Linear-in-percent."))

        ctrlRow.append(mkNumLabel("α comfort", params.ratingComfortLift, 0, 30, 0.5,
            async (v) => {
                if (!isFinite(v)) return
                this.settings.orsSandbox.modelParams.ratingComfortLift = v
                await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox})
                this._orsSandboxResult = null
                if (this.settings.orsSandbox.enabled) this._render()
            },
            "Rating points shifted per service-level step. Default 5; 5 stops total: −2 (budget) … 0 (current) … +2 (premium)."))

        ctrlRow.append(mkNumLabel("Default T", params.shareTemperature, 1, 200, 0.5,
            async (v) => {
                if (!isFinite(v) || v <= 0) return
                this.settings.orsSandbox.modelParams.shareTemperature = v
                await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox})
                this._orsSandboxResult = null
                if (this.settings.orsSandbox.enabled) this._render()
            },
            "Softmax temperature in rating points. Default 25 (numerically stable for AS rating range ~80–180). Sharp ≈ 15, smooth ≈ 40. Per-route Ts override this on the route they're calibrated for."))

        const resetTsBtn = document.createElement("button")
        resetTsBtn.textContent = "Reset all per-route Ts (" + perRouteCount + ")"
        Object.assign(resetTsBtn.style, smallBtnStyle())
        resetTsBtn.disabled = perRouteCount === 0
        resetTsBtn.title = "Clears every saved per-route T. The Calibrate-T button on each route can re-populate as needed."
        resetTsBtn.addEventListener("click", async () => {
            if (!confirm("Clear all " + perRouteCount + " saved per-route temperatures?\n\nThe global T continues to apply to every route. Each route can re-calibrate via the sandbox's Calibrate-T button.")) return
            this.settings.orsSandbox.perRouteTemperature             = {}
            this.settings.orsSandbox.perRouteTemperatureCalibratedAt = {}
            await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox})
            this._renderSettings()
            this._orsSandboxResult = null
            if (this.settings.orsSandbox.enabled) this._render()
        })
        ctrlRow.append(resetTsBtn)

        const resetDefaultsBtn = document.createElement("button")
        resetDefaultsBtn.textContent = "Reset model params to defaults"
        Object.assign(resetDefaultsBtn.style, smallBtnStyle())
        resetDefaultsBtn.title = "Restores α_price = 8, α_comfort = 5, default T = 25. Per-route Ts are NOT cleared by this button."
        resetDefaultsBtn.addEventListener("click", async () => {
            this.settings.orsSandbox.modelParams = {ratingPriceElasticity: 8, ratingComfortLift: 5, shareTemperature: 25.0}
            await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox})
            this._renderSettings()
            this._orsSandboxResult = null
            if (this.settings.orsSandbox.enabled) this._render()
        })
        ctrlRow.append(resetDefaultsBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "margin-top:6px;color:#6b7280;font-size:10px;line-height:1.5;"
        note.innerHTML = "<strong>How it works:</strong> rating shift is linear in percent — clamped to ±50% of the baseline. "
            + "Share is a numeric-stable softmax over the cached connection ratings, summed across our connections. "
            + "Pax/wk = pool × share, with the pool adjusted by the demand-derivator's price elasticity when present. "
            + "Revenue and profit are projected by feeding the new LF + yield into the existing profit estimator. "
            + "Read-only — the sandbox never writes prices back to AS."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    // ---------- Active prompts (alert rules) ----------

    /**
     * Settings drawer expander for alert rules. Lists existing rules
     * with enable toggle + delete; an "Add rule" row with field /
     * operator / threshold / scope / severity inputs. Saves through
     * RouteAssistantAlertRulesStore.
     */
    _renderAlertRulesSection() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#fde68a;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Active prompts</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Rules that fire a notification "
            + "when a field crosses your threshold. Evaluated on every panel mount against the "
            + "diff-decorated rows. Watchlist scope (default) only fires for ★-starred routes; "
            + "All scope fires for every visible row. Cooldown (default 24h) suppresses repeats "
            + "of the same rule+route within the window.</span>"
        wrap.append(header)

        const rules = this._alertRules || []
        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const enabledCount = rules.filter(r => r.enabled).length
        status.textContent = "Rules: " + rules.length + " (" + enabledCount + " enabled)"
        wrap.append(status)

        // Existing rules list ----------------------------------------------
        if (rules.length) {
            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:6px;"
            for (const rule of rules) {
                list.append(this._buildAlertRuleRow(rule))
            }
            wrap.append(list)
        }

        // Add-rule row ------------------------------------------------------
        const addWrap = document.createElement("div")
        addWrap.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;"
            + "padding-top:4px;border-top:1px solid rgba(251,191,36,0.20);"
        const addLabel = document.createElement("span")
        addLabel.textContent = "Add rule:"
        addLabel.style.color = "#fde68a"
        addWrap.append(addLabel)

        const fieldOpts = (typeof RouteAssistantAlertEvaluator !== "undefined")
            ? RouteAssistantAlertEvaluator.availableFields()
            : []
        const fieldSel = document.createElement("select")
        fieldSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;padding:1px 4px;font-size:11px;max-width:200px;"
        for (const f of fieldOpts) {
            const o = document.createElement("option")
            o.value = f.field
            o.textContent = f.label
            fieldSel.append(o)
        }
        addWrap.append(fieldSel)

        const opSel = document.createElement("select")
        opSel.style.cssText = fieldSel.style.cssText
        for (const op of [
            {value: "increased_by", label: "increased by"},
            {value: "decreased_by", label: "decreased by"},
            {value: "above",        label: "above"},
            {value: "below",        label: "below"}
        ]) {
            const o = document.createElement("option")
            o.value = op.value
            o.textContent = op.label
            opSel.append(o)
        }
        addWrap.append(opSel)

        const thrInput = document.createElement("input")
        thrInput.type = "number"
        thrInput.step = "any"
        thrInput.placeholder = "threshold"
        thrInput.style.cssText = "width:90px;background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;padding:1px 4px;font-size:11px;"
        addWrap.append(thrInput)

        const scopeSel = document.createElement("select")
        scopeSel.style.cssText = fieldSel.style.cssText
        for (const sc of [
            {value: "watchlist", label: "watchlist only"},
            {value: "all",       label: "all routes"}
        ]) {
            const o = document.createElement("option")
            o.value = sc.value
            o.textContent = sc.label
            scopeSel.append(o)
        }
        addWrap.append(scopeSel)

        const sevSel = document.createElement("select")
        sevSel.style.cssText = fieldSel.style.cssText
        for (const sv of [
            {value: "warn",  label: "warn"},
            {value: "info",  label: "info"},
            {value: "error", label: "error"}
        ]) {
            const o = document.createElement("option")
            o.value = sv.value
            o.textContent = sv.label
            sevSel.append(o)
        }
        addWrap.append(sevSel)

        const addBtn = document.createElement("button")
        addBtn.textContent = "+ Add"
        Object.assign(addBtn.style, smallBtnStyle())
        addBtn.style.background = "#92400e"
        addBtn.style.color = "#fde68a"
        addBtn.addEventListener("click", async () => {
            const t = Number(thrInput.value)
            if (!isFinite(t)) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.warn("Enter a numeric threshold first.")
                }
                return
            }
            try {
                await RouteAssistantAlertRulesStore.add({
                    field:    fieldSel.value,
                    operator: opSel.value,
                    threshold: t,
                    scope:    scopeSel.value,
                    severity: sevSel.value
                })
                await this._loadAlertRules()
                this._alertFiredThisMount = new Set()  // re-evaluate against new rule next render
                this._renderSettings()
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.success("Alert rule added.")
                }
            } catch (e) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.error("Couldn't add rule: " + (e && e.message ? e.message : e))
                }
            }
        })
        addWrap.append(addBtn)
        wrap.append(addWrap)

        this.settingsHost.append(wrap)
    }

    /** One row in the alert rules list — label + enable toggle + delete. */
    _buildAlertRuleRow(rule) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 6px;"
            + "background:rgba(15,22,35,0.45);border:1px solid rgba(251,191,36,0.20);"
            + "border-radius:3px;font-size:11px;"
        const enableCb = document.createElement("input")
        enableCb.type = "checkbox"
        enableCb.checked = !!rule.enabled
        enableCb.title = "Toggle rule on/off"
        enableCb.addEventListener("change", async () => {
            try {
                await RouteAssistantAlertRulesStore.update(rule.id, {enabled: enableCb.checked})
                rule.enabled = enableCb.checked
                this._alertFiredThisMount = new Set()
            } catch (e) {
                enableCb.checked = !enableCb.checked
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.error("Toggle failed: " + (e && e.message ? e.message : e))
                }
            }
        })
        row.append(enableCb)

        const sevDot = document.createElement("span")
        const sevColor = rule.severity === "error" ? "#f87171" : (rule.severity === "info" ? "#60a5fa" : "#fbbf24")
        sevDot.textContent = "●"
        sevDot.style.color = sevColor
        sevDot.title = rule.severity
        row.append(sevDot)

        const label = document.createElement("span")
        label.textContent = rule.label
        label.style.color = "#e5e7eb"
        label.style.flex = "1"
        row.append(label)

        const scopeChip = document.createElement("span")
        scopeChip.textContent = rule.scope === "watchlist" ? "★ only" : "all"
        scopeChip.style.cssText = "color:#9ca3af;font-size:10px;padding:1px 5px;border-radius:8px;"
            + "background:rgba(100,116,139,0.15);"
        row.append(scopeChip)

        const cooldownChip = document.createElement("span")
        cooldownChip.textContent = (rule.cooldownHours || 0) + "h"
        cooldownChip.style.cssText = "color:#9ca3af;font-size:10px;"
        cooldownChip.title = "Cooldown — same rule+route can't re-fire within this window."
        row.append(cooldownChip)

        const delBtn = document.createElement("button")
        delBtn.textContent = "×"
        delBtn.title = "Delete rule"
        delBtn.style.cssText = "background:transparent;border:none;color:#9ca3af;cursor:pointer;font-size:14px;line-height:1;padding:0 4px;"
        delBtn.addEventListener("click", async () => {
            await this._undoableSave({
                label: "Deleted rule \"" + rule.label + "\"",
                type:  "info",
                perform: async () => {
                    await RouteAssistantAlertRulesStore.remove(rule.id)
                    await this._loadAlertRules()
                    this._renderSettings()
                },
                restore: async () => {
                    await RouteAssistantAlertRulesStore.add({
                        field:        rule.field,
                        operator:     rule.operator,
                        threshold:    rule.threshold,
                        scope:        rule.scope,
                        severity:     rule.severity,
                        enabled:      rule.enabled,
                        cooldownHours: rule.cooldownHours,
                        label:        rule.label
                    })
                    await this._loadAlertRules()
                    this._renderSettings()
                }
            })
        })
        row.append(delBtn)
        return row
    }

    // ---------- ORS Rank (Tier 2b — Online Reservation System scraper) ----------

    /**
     * Bulk-load the per-route ORS cache and project the user-selected
     * primary metric (default `ratingGapToTop`) plus all rank flavors onto
     * each row. The full `connections` array is also attached so the
     * drill-in drawer can render it without re-scraping.
     */
    async _applyCachedOrs() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const cfg = (this.settings && this.settings.ors) || {}
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cache = await RouteAssistantOrsScraper.bulkLoadCache(pairs, {
            maxAgeDays: cfg.rankMaxAgeDays
        })

        // Resolve composite weights ONCE per refresh. Capacity-weighted
        // method needs the picked aircraft's per-class seat config; fall
        // back to the user's preset weights when no aircraft / no specs.
        const weights = this._resolveOrsWeights()

        for (const r of this.rows) {
            const key = RouteAssistantOrsScraper._pairKey(this.hubIata, r.destIata)
            const rec = cache.get(key)
            if (!rec) continue
            r.orsRecord = rec
            r.orsScrapedAt = rec.scrapedAt
            r.orsParams = rec.params
            r.orsByClass = rec.byClass || {}
            r.orsClassesScraped = rec.classesScraped || Object.keys(r.orsByClass)
            r.orsOurFlightIds      = rec.ourFlightIds
            r.orsOurCarrierPrefixes = rec.ourCarrierPrefixes

            // Per-class metric snapshots — what the Y / C / F columns
            // show. Each is the row's primaryColumn metric for that class.
            const primaryCol = cfg.primaryColumn || "ratingGapToTop"
            r.orsClassY = RouteAssistantPanel._resolveOrsPrimary(r.orsByClass.ECONOMY,  primaryCol)
            r.orsClassC = RouteAssistantPanel._resolveOrsPrimary(r.orsByClass.BUSINESS, primaryCol)
            r.orsClassF = RouteAssistantPanel._resolveOrsPrimary(r.orsByClass.FIRST,    primaryCol)

            // Composite — every flat metric the existing columns read is
            // computed from the per-class records using the user's combine
            // method + weights. That way the existing columns Just Work
            // without a schema change downstream.
            const composite = RouteAssistantPanel._composeOrsAllMetrics(
                r.orsByClass, cfg.combineMethod || "weighted", weights
            )
            r.orsRankAny           = composite.rankAny
            r.orsRankFirstLegOurs  = composite.rankFirstLegOurs
            r.orsRankAllOurs       = composite.rankAllOurs
            r.orsRankNonstop       = composite.rankNonstop
            r.orsRankBookable      = composite.rankBookable
            r.orsOurTopRating      = composite.ourTopRating
            r.orsOurBestNonstopRating = composite.ourBestNonstopRating
            r.orsTopCompetitorRating  = composite.topCompetitorRating
            r.orsRatingGapToTop    = composite.ratingGapToTop
            // Total-connections rolls up by sum across scraped classes
            // (a stable "we got data" signal for the status counter).
            let total = 0, anyScraped = false
            for (const cls in r.orsByClass) {
                const cr = r.orsByClass[cls]
                if (cr && typeof cr.totalConnections === "number") {
                    total += cr.totalConnections
                    anyScraped = true
                }
            }
            r.orsTotalConnections = anyScraped ? total : null

            // For the drill-in drawer fallback: union of all classes'
            // connections so the "All" tab can render without re-iteration.
            r.orsConnections = []
            for (const cls of ["ECONOMY", "BUSINESS", "FIRST", "CARGO"]) {
                const cr = r.orsByClass[cls]
                if (cr && Array.isArray(cr.connections)) {
                    for (const c of cr.connections) {
                        r.orsConnections.push(Object.assign({_orsClass: cls}, c))
                    }
                }
            }

            // Apply min-rating display threshold (display-only filter).
            const minRating = cfg.minRatingThresholdDisplay
            if (minRating != null && r.orsOurTopRating != null && r.orsOurTopRating < minRating) {
                r.orsHiddenByThreshold = true
            } else {
                r.orsHiddenByThreshold = false
            }

            // Resolve the primary value the panel shows in the headline column.
            r.orsPrimaryValue = RouteAssistantPanel._resolveOrsPrimary(
                {/* synthetic carrier-of-composite */
                    rankAny:           r.orsRankAny,
                    rankFirstLegOurs:  r.orsRankFirstLegOurs,
                    rankAllOurs:       r.orsRankAllOurs,
                    rankNonstop:       r.orsRankNonstop,
                    rankBookable:      r.orsRankBookable,
                    ourTopRating:      r.orsOurTopRating,
                    ourBestNonstopRating: r.orsOurBestNonstopRating,
                    ratingGapToTop:    r.orsRatingGapToTop
                }, primaryCol
            )
        }
        // Stash circuit-breaker timestamp + cooldown for the expander UI.
        RouteAssistantPanel._orsCircuitTrippedAt = cfg.circuitBreakerTrippedAt || null
        RouteAssistantPanel._orsCircuitCooldown  = cfg.circuitBreakerCooldownMs || 600000
        RouteAssistantPanel._orsPrimaryColumn    = cfg.primaryColumn || "ratingGapToTop"
        RouteAssistantPanel._orsActiveWeights    = weights
    }

    /**
     * Resolve the active class-weight vector based on the user's
     * combineMethod + preset choice. Returns {ECONOMY, BUSINESS, FIRST}
     * with values summing to ~1. Capacity-weighted derives from the picked
     * aircraft's seat config; falls back to the Standard preset when no
     * aircraft is selected or specs aren't cached.
     */
    _resolveOrsWeights() {
        const cfg = (this.settings && this.settings.ors) || {}
        const presets = (typeof RouteAssistantSettings !== "undefined"
            && RouteAssistantSettings.ORS_WEIGHT_PRESETS) || {}

        if (cfg.combineMethod === "capacityWeighted") {
            // Try to derive from the picked aircraft's cabin config.
            const fromAircraft = this._aircraftCapacityWeights()
            if (fromAircraft) return fromAircraft
            // Fall back to Standard preset.
            return Object.assign({ECONOMY: 0.75, BUSINESS: 0.20, FIRST: 0.05},
                (presets.standard && presets.standard.weights) || {})
        }
        if (cfg.combineMethod === "weighted") {
            // Use whichever preset is selected, or stored classWeights for "custom".
            const preset = cfg.weightPreset && presets[cfg.weightPreset]
            if (cfg.weightPreset === "custom" || !preset || !preset.weights) {
                return Object.assign({ECONOMY: 0.75, BUSINESS: 0.20, FIRST: 0.05},
                    cfg.classWeights || {})
            }
            return Object.assign({}, preset.weights)
        }
        // min / max / avg don't use weights — the composer handles them.
        // Return equal weights so the per-class projections still work.
        return {ECONOMY: 1/3, BUSINESS: 1/3, FIRST: 1/3}
    }

    /**
     * Derive class weights from the picked aircraft's cabin config.
     * Returns null when no aircraft is picked OR the type spec / class
     * mix can't be resolved (caller falls back to Standard preset).
     *
     * Resolution path:
     *   1. Selected aircraft typeId (from aircraft picker) → spec lookup
     *      via RouteAssistantTypeSpecsStore for total seats.
     *   2. Service-config defaultClassMix for that type's categories.
     *   3. Multiply: classSeats[i] = totalSeats × mixPct[i]
     *   4. Normalise to sum 1.
     */
    _aircraftCapacityWeights() {
        try {
            const slot = this._fleetContext()
            if (!slot) return null
            const seats = (typeof slot.seats === "number" && slot.seats > 0) ? slot.seats : null
            if (!seats) return null
            // The service-profile store holds per-class mix percentages.
            const sp = (this.settings && this.settings.serviceProfiles) || {}
            const mix = sp.defaultClassMix || {}
            const y = Number(mix.Y) || 0
            const c = Number(mix.C) || 0
            const f = Number(mix.F) || 0
            const sum = y + c + f
            if (sum <= 0) return null
            return {
                ECONOMY:  y / sum,
                BUSINESS: c / sum,
                FIRST:    f / sum
            }
        } catch (e) {
            return null
        }
    }

    /**
     * Settings-drawer block for the ORS scraper. Per the user's "MAXIMISE
     * OPTIONS" direction, every form parameter + every rank flavor is
     * exposed here. Filtering happens at render time so toggling settings
     * never requires a re-scrape.
     */
    _renderOrsRankSection() {
        const cfg = this.settings.ors = Object.assign(
            {showColumns: true, concurrency: 2, staggerMs: 1500, lastBulkScrapeAt: null,
             rankMaxAgeDays: null,
             classesToScrape: ["ECONOMY", "BUSINESS", "FIRST"],
             defaultDepartureH: 0, defaultArrivalH: 72,
             defaultUseGround: true,
             combineMethod: "capacityWeighted",
             weightPreset:  "capacityWeighted",
             classWeights:  {ECONOMY: 0.75, BUSINESS: 0.20, FIRST: 0.05},
             primaryClass:  "ECONOMY",
             primaryColumn: "ratingGapToTop",
             showRankAnyColumn: true, showRankNonstopColumn: true,
             showRatingGapColumn: true, showCompetitorCountColumn: true,
             showPerClassColumns: true,
             minRatingThresholdDisplay: null,
             airlineCarrierPrefixOverride: null,
             circuitBreakerTrippedAt: null, circuitBreakerCooldownMs: 600000},
            this.settings.ors || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(245, 158, 11, 0.08);border:1px solid rgba(245, 158, 11, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#fcd34d;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>ORS Rank</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Submits the AS Online Reservation "
            + "System form for each route and walks every result page to compute your true rank "
            + "vs. competitors. The full connection list is cached so you can drill into any row "
            + "without re-scraping.</span>"
        wrap.append(header)

        // Circuit-breaker banner.
        const cooldownMs = cfg.circuitBreakerCooldownMs || 600000
        const trippedAt  = cfg.circuitBreakerTrippedAt
        const tripped    = trippedAt && (Date.now() - trippedAt < cooldownMs)
        if (tripped) {
            const remainMin = Math.ceil((cooldownMs - (Date.now() - trippedAt)) / 60000)
            const banner = document.createElement("div")
            banner.style.cssText = "color:#fca5a5;background:rgba(239,68,68,0.10);"
                + "border:1px solid rgba(239,68,68,0.40);border-radius:3px;"
                + "padding:4px 6px;font-size:10px;margin-bottom:6px;"
            banner.textContent = "⚠ Rate-limit circuit breaker tripped — bulk sync disabled for "
                + remainMin + " more minute" + (remainMin === 1 ? "" : "s") + "."
            wrap.append(banner)
        }

        // ----- Top action row — Sync button is FIRST so it's reachable
        // without scrolling no matter how tall the expander grows. Status
        // text rides alongside it so the user sees progress in the same eye-line.
        const topRow = document.createElement("div")
        topRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:11px;margin-bottom:6px;"

        const scanBtn = document.createElement("button")
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#b45309"
        scanBtn.disabled = !!this._orsScrapeRunning || !this.hubIata
            || !(this.rows && this.rows.length) || tripped
        scanBtn.addEventListener("click", () => this._runBulkOrsScrape())
        topRow.append(scanBtn)

        // Recompute the sync button's label live whenever the user toggles
        // class checkboxes — wall-clock estimate scales with class count
        // (each class = one extra GET → POST handshake per route).
        this._orsRecomputeSyncLabel = () => {
            if (this._orsScrapeRunning) { scanBtn.textContent = "Syncing ORS…"; return }
            const classes = (this.settings && this.settings.ors && this.settings.ors.classesToScrape) || []
            const n = classes.length || 1
            const routes = (this.rows || []).length || 0
            // Conservative: ~10 routes/min for 3 classes; scales linearly.
            const minutes = Math.max(1, Math.ceil(routes / (30 / n)))
            const labels = classes.map(c => c[0]).join("/") || "Y"
            scanBtn.textContent = "Sync ORS rank for all visible routes ("
                + labels + " · ~" + minutes + " min)"
        }
        this._orsRecomputeSyncLabel()

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;flex:1;min-width:0;"
        const totalRows  = (this.rows || []).length
        // Two distinct counters:
        //   scrapedRows = routes successfully scraped (totalConnections != null)
        //   ourRankRows = routes where we found OUR flights in the result list
        // The two often diverge: a route is scraped but we have no flights
        // there, so all rank flavors are null. Reporting only the second
        // looked like the sync was failing on most routes.
        const scrapedRows = (this.rows || []).filter(r => r.orsTotalConnections != null).length
        const ourRankRows = (this.rows || []).filter(r => r.orsRankAny != null).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Scraped " + scrapedRows + "/" + totalRows
            + " · your rank in " + ourRankRows
            + " · last sync: " + lastScrape
        topRow.append(status)
        this._orsStatusEl = status

        wrap.append(topRow)

        // ----- Essential controls — payload / window / ground / show-cols -----
        const paramRow = document.createElement("div")
        paramRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:11px;margin-bottom:4px;"

        const classBox = document.createElement("span")
        classBox.style.cssText = "display:flex;gap:6px;align-items:center;color:#9ca3af;"
        classBox.append(document.createTextNode("Classes:"))
        const classKeys = [
            {key: "ECONOMY",  label: "Y", color: "#86efac"},
            {key: "BUSINESS", label: "C", color: "#fde68a"},
            {key: "FIRST",    label: "F", color: "#fca5a5"}
        ]
        const classCbs = {}
        const updateSyncBtnLabel = () => {
            if (this._orsRecomputeSyncLabel) this._orsRecomputeSyncLabel()
        }
        for (const cdef of classKeys) {
            const cb = mkInput("checkbox", null)
            cb.checked = (cfg.classesToScrape || []).indexOf(cdef.key) >= 0
            classCbs[cdef.key] = cb
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:3px;align-items:center;color:" + cdef.color + ";"
            lbl.append(cb, document.createTextNode(cdef.label))
            cb.addEventListener("change", async () => {
                const next = classKeys.filter(k => classCbs[k.key].checked).map(k => k.key)
                if (!next.length) { cb.checked = true; return }
                this.settings.ors.classesToScrape = next
                await RouteAssistantSettings.save({ors: this.settings.ors})
                updateSyncBtnLabel()
            })
            classBox.append(lbl)
        }
        paramRow.append(classBox)

        const windowSel = mkSelect([
            {value: "tight",    label: "Tight 0–24h"},
            {value: "standard", label: "Std 0–48h"},
            {value: "wide",     label: "Wide 0–72h"}
        ])
        windowSel.style.fontSize = "11px"
        const currentWindow = (cfg.defaultDepartureH === 0 && cfg.defaultArrivalH === 24) ? "tight"
                            : (cfg.defaultDepartureH === 0 && cfg.defaultArrivalH === 48) ? "standard"
                            : "wide"
        windowSel.value = currentWindow
        windowSel.addEventListener("change", async () => {
            const v = windowSel.value
            if (v === "tight")    { this.settings.ors.defaultDepartureH = 0; this.settings.ors.defaultArrivalH = 24 }
            else if (v === "standard") { this.settings.ors.defaultDepartureH = 0; this.settings.ors.defaultArrivalH = 48 }
            else                  { this.settings.ors.defaultDepartureH = 0; this.settings.ors.defaultArrivalH = 72 }
            await RouteAssistantSettings.save({ors: this.settings.ors})
        })
        const windowLbl = document.createElement("label")
        windowLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        windowLbl.append(document.createTextNode("Window:"), windowSel)
        paramRow.append(windowLbl)

        const groundCb = mkInput("checkbox", null)
        groundCb.checked = cfg.defaultUseGround !== false
        const groundLbl = document.createElement("label")
        groundLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        groundLbl.append(groundCb, document.createTextNode("Ground"))
        groundCb.addEventListener("change", async () => {
            this.settings.ors.defaultUseGround = groundCb.checked
            await RouteAssistantSettings.save({ors: this.settings.ors})
        })
        paramRow.append(groundLbl)

        const primarySel = mkSelect([
            {value: "ratingGapToTop",       label: "Rating gap"},
            {value: "rankAny",              label: "Rank — any ours"},
            {value: "rankFirstLegOurs",     label: "Rank — first leg ours"},
            {value: "rankAllOurs",          label: "Rank — all ours"},
            {value: "rankNonstop",          label: "Rank — nonstop"},
            {value: "rankBookable",         label: "Rank — bookable"},
            {value: "ourTopRating",         label: "Our top rating"},
            {value: "ourBestNonstopRating", label: "Our nonstop rating"}
        ])
        primarySel.value = cfg.primaryColumn
        primarySel.style.fontSize = "11px"
        primarySel.addEventListener("change", async () => {
            this.settings.ors.primaryColumn = primarySel.value
            await RouteAssistantSettings.save({ors: this.settings.ors})
            await this._applyCachedOrs()
            this._render()
        })
        const primaryLbl = document.createElement("label")
        primaryLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fcd34d;"
        primaryLbl.append(document.createTextNode("Primary:"), primarySel)
        paramRow.append(primaryLbl)

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fcd34d;"
        showLbl.append(showCb, document.createTextNode("Show columns"))
        showCb.addEventListener("change", async () => {
            this.settings.ors.showColumns = showCb.checked
            await RouteAssistantSettings.save({ors: this.settings.ors})
            this._render()
        })
        paramRow.append(showLbl)

        wrap.append(paramRow)

        // ----- Combine method + Preset (composite blending controls).
        // The composite ORS column blends per-class metrics into one
        // headline number; these controls drive the formula. Presets are
        // listed in RouteAssistantSettings.ORS_WEIGHT_PRESETS.
        const combineRow = document.createElement("div")
        combineRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:11px;margin-bottom:4px;"

        const combineSel = mkSelect([
            {value: "capacityWeighted", label: "Capacity-weighted (auto)"},
            {value: "weighted",         label: "Weighted (preset)"},
            {value: "min",              label: "Min (worst class)"},
            {value: "max",              label: "Max (best class)"},
            {value: "avg",              label: "Equal average"}
        ])
        combineSel.value = cfg.combineMethod || "capacityWeighted"
        combineSel.style.fontSize = "11px"
        combineSel.addEventListener("change", async () => {
            this.settings.ors.combineMethod = combineSel.value
            await RouteAssistantSettings.save({ors: this.settings.ors})
            await this._applyCachedOrs()
            this._render()
        })
        const combineLbl = document.createElement("label")
        combineLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fcd34d;"
        combineLbl.append(document.createTextNode("Combine:"), combineSel)
        combineRow.append(combineLbl)

        // Preset dropdown — populated from ORS_WEIGHT_PRESETS so adding
        // playstyles in settings-store automatically surfaces them here.
        const presets = (typeof RouteAssistantSettings !== "undefined"
            && RouteAssistantSettings.ORS_WEIGHT_PRESETS) || {}
        const presetOpts = []
        for (const k in presets) {
            presetOpts.push({value: k, label: presets[k].label || k})
        }
        const presetSel = mkSelect(presetOpts)
        presetSel.value = cfg.weightPreset || "capacityWeighted"
        presetSel.style.fontSize = "11px"
        presetSel.addEventListener("change", async () => {
            const next = presetSel.value
            this.settings.ors.weightPreset = next
            // Auto-set combineMethod to match the preset's intent:
            //   "capacityWeighted" preset → capacityWeighted method
            //   any fixed preset           → weighted method
            //   "custom"                   → weighted (with stored classWeights)
            if (next === "capacityWeighted") {
                this.settings.ors.combineMethod = "capacityWeighted"
                combineSel.value = "capacityWeighted"
            } else {
                this.settings.ors.combineMethod = "weighted"
                combineSel.value = "weighted"
                if (presets[next] && presets[next].weights) {
                    this.settings.ors.classWeights = Object.assign({}, presets[next].weights)
                }
            }
            await RouteAssistantSettings.save({ors: this.settings.ors})
            await this._applyCachedOrs()
            this._render()
        })
        const presetLbl = document.createElement("label")
        presetLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fcd34d;"
        presetLbl.append(document.createTextNode("Preset:"), presetSel)
        combineRow.append(presetLbl)

        // Inline preset-description hint so user understands what they
        // selected without opening More options.
        const presetHint = document.createElement("span")
        presetHint.style.cssText = "color:#6b7280;font-size:10px;font-style:italic;"
        const updatePresetHint = () => {
            const p = presets[presetSel.value]
            presetHint.textContent = p ? "(" + p.description + ")" : ""
        }
        updatePresetHint()
        presetSel.addEventListener("change", updatePresetHint)
        combineRow.append(presetHint)

        wrap.append(combineRow)

        // ----- Advanced disclosure (collapsed by default) — per-column
        // visibility toggles + carrier prefix override + display threshold.
        // Tucked away because most users tune these once and never again,
        // but they need to stay reachable for power users.
        const advToggle = document.createElement("div")
        advToggle.style.cssText = "color:#9ca3af;font-size:10px;cursor:pointer;"
            + "user-select:none;margin-top:4px;"
        const advBody = document.createElement("div")
        advBody.style.cssText = "display:none;margin-top:4px;padding:4px 6px;"
            + "background:rgba(0,0,0,0.15);border-radius:3px;"

        // Persist open/closed across renders for power users.
        const advKey = "_orsAdvOpen"
        const setAdvState = (open) => {
            this[advKey] = open
            advBody.style.display = open ? "block" : "none"
            advToggle.textContent = (open ? "▾ " : "▸ ") + "More options (per-column toggles, prefix override, threshold)"
        }
        setAdvState(!!this[advKey])
        advToggle.addEventListener("click", () => setAdvState(!this[advKey]))
        wrap.append(advToggle)

        // Per-column visibility row.
        const colsRow = document.createElement("div")
        colsRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:10px;color:#9ca3af;margin-bottom:4px;"
        const mkColToggle = (label, settingsKey) => {
            const cb = mkInput("checkbox", null)
            cb.checked = cfg[settingsKey] !== false
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:3px;align-items:center;"
            lbl.append(cb, document.createTextNode(label))
            cb.addEventListener("change", async () => {
                this.settings.ors[settingsKey] = cb.checked
                await RouteAssistantSettings.save({ors: this.settings.ors})
                this._render()
            })
            return lbl
        }
        colsRow.append(document.createTextNode("Columns:"))
        colsRow.append(mkColToggle("Rank-any",     "showRankAnyColumn"))
        colsRow.append(mkColToggle("Rank-nonstop", "showRankNonstopColumn"))
        colsRow.append(mkColToggle("Rating gap",   "showRatingGapColumn"))
        colsRow.append(mkColToggle("Competitor #", "showCompetitorCountColumn"))
        advBody.append(colsRow)

        // Override row — prefix + threshold.
        const overrideRow = document.createElement("div")
        overrideRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:10px;color:#9ca3af;"

        const prefixInput = document.createElement("input")
        prefixInput.type = "text"
        prefixInput.placeholder = "auto-detect (e.g. FN,NY)"
        prefixInput.value = cfg.airlineCarrierPrefixOverride || ""
        prefixInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 6px;font-size:10px;width:120px;"
        prefixInput.addEventListener("change", async () => {
            const v = prefixInput.value.trim()
            this.settings.ors.airlineCarrierPrefixOverride = v || null
            await RouteAssistantSettings.save({ors: this.settings.ors})
        })
        const prefixLbl = document.createElement("label")
        prefixLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        prefixLbl.append(document.createTextNode("Prefix:"), prefixInput)
        overrideRow.append(prefixLbl)

        const thInput = mkNumberInput(cfg.minRatingThresholdDisplay, {min: 0, max: 100, step: 1, width: "55px"})
        thInput.addEventListener("change", async () => {
            const v = numOrNull(thInput.value)
            this.settings.ors.minRatingThresholdDisplay = v
            await RouteAssistantSettings.save({ors: this.settings.ors})
            await this._applyCachedOrs()
            this._render()
        })
        const thLbl = document.createElement("label")
        thLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        thLbl.append(document.createTextNode("Hide rows below rating"), thInput)
        overrideRow.append(thLbl)

        advBody.append(overrideRow)

        // Per-class column visibility (Compact view always overrides this).
        const perClassRow = document.createElement("div")
        perClassRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:10px;color:#9ca3af;margin-top:4px;"
        const pcCb = mkInput("checkbox", null)
        pcCb.checked = cfg.showPerClassColumns !== false
        const pcLbl = document.createElement("label")
        pcLbl.style.cssText = "display:flex;gap:3px;align-items:center;"
        pcLbl.append(pcCb, document.createTextNode("Show per-class columns (Y / C / F)"))
        pcCb.addEventListener("change", async () => {
            this.settings.ors.showPerClassColumns = pcCb.checked
            await RouteAssistantSettings.save({ors: this.settings.ors})
            this._render()
        })
        perClassRow.append(pcLbl)
        advBody.append(perClassRow)

        // Custom class weights — touching any of these flips Preset to
        // "custom" and combineMethod to "weighted". Sum normalised on save.
        const weightRow = document.createElement("div")
        weightRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:10px;color:#9ca3af;margin-top:4px;"
        weightRow.append(document.createTextNode("Custom weights:"))
        const weightInputs = {}
        for (const cls of ["ECONOMY", "BUSINESS", "FIRST"]) {
            const initial = (cfg.classWeights && cfg.classWeights[cls] != null)
                ? cfg.classWeights[cls] : 0
            const inp = mkNumberInput(initial, {min: 0, max: 1, step: 0.05, width: "55px"})
            weightInputs[cls] = inp
            inp.addEventListener("change", async () => {
                const w = {
                    ECONOMY:  Number(weightInputs.ECONOMY.value)  || 0,
                    BUSINESS: Number(weightInputs.BUSINESS.value) || 0,
                    FIRST:    Number(weightInputs.FIRST.value)    || 0
                }
                const sum = w.ECONOMY + w.BUSINESS + w.FIRST
                if (sum > 0) {
                    w.ECONOMY  /= sum; w.BUSINESS /= sum; w.FIRST /= sum
                } else {
                    w.ECONOMY = 0.75; w.BUSINESS = 0.20; w.FIRST = 0.05
                }
                this.settings.ors.classWeights = w
                this.settings.ors.weightPreset = "custom"
                this.settings.ors.combineMethod = "weighted"
                presetSel.value  = "custom"
                combineSel.value = "weighted"
                await RouteAssistantSettings.save({ors: this.settings.ors})
                await this._applyCachedOrs()
                this._render()
            })
            const cwLbl = document.createElement("label")
            cwLbl.style.cssText = "display:flex;gap:3px;align-items:center;"
            cwLbl.append(document.createTextNode(cls[0]), inp)
            weightRow.append(cwLbl)
        }
        const weightHint = document.createElement("span")
        weightHint.style.cssText = "color:#6b7280;font-size:10px;font-style:italic;"
        weightHint.textContent = "(saved values normalised to sum 1.0)"
        weightRow.append(weightHint)
        advBody.append(weightRow)

        wrap.append(advBody)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Each ticked class adds one full GET → POST handshake per route. "
            + "Pace estimate (button label) updates live as you toggle. Per-route Wicket "
            + "session — classes can't share. Circuit breaker on 3× consecutive 429/503 "
            + "disables sync for 10 min."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Bulk-scrape ORS for every visible route. Mirrors `_runBulkPriceScrape`
     * but with circuit-breaker handling: persists `circuitBreakerTrippedAt`
     * on a halt and re-renders so the banner appears.
     */
    async _runBulkOrsScrape() {
        if (this._orsScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.ors || {}
        const concurrency = cfg.concurrency || 2
        const staggerMs   = cfg.staggerMs   || 1500

        if (!this.orsScraper) {
            this.orsScraper = new RouteAssistantOrsScraper(this.server, {
                maxAgeDays: cfg.rankMaxAgeDays,
                circuitBreakerCooldownMs: cfg.circuitBreakerCooldownMs
            })
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._orsScrapeRunning = true
        this._renderSettings()

        // N1 progress toast — sticky, updates in place. Lets the user tab
        // away from the panel during the 5+min scrape and watch the corner
        // indicator instead of staring at the inline status line.
        const progressHandle = (typeof RouteAssistantToast !== "undefined")
            ? RouteAssistantToast.progress("Syncing ORS rank…", {
                id:   "ors-bulk-scrape",
                type: "info"
              })
            : null

        let halted = false, haltReason = null, doneCount = 0, totalCount = pairs.length
        try {
            const result = await this.orsScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                scrapeParams: {
                    classesToScrape: cfg.classesToScrape,
                    departureH:      cfg.defaultDepartureH,
                    arrivalH:        cfg.defaultArrivalH,
                    useGround:       cfg.defaultUseGround,
                    carrierOverride: cfg.airlineCarrierPrefixOverride
                },
                onProgress:  (p) => {
                    doneCount  = p.done
                    totalCount = p.total
                    if (this._orsStatusEl) {
                        let txt = "Syncing ORS rank: " + p.done + "/" + p.total + "…"
                        if (p.halted) txt = "⚠ Halted at " + p.done + "/" + p.total + ": " + p.reason
                        this._orsStatusEl.textContent = txt
                    }
                    if (progressHandle) {
                        progressHandle.update({
                            message:       p.halted
                                ? ("⚠ ORS sync halted (" + p.done + "/" + p.total + ")")
                                : "Syncing ORS rank…",
                            progressPct:   p.total ? (100 * p.done / p.total) : 0,
                            progressLabel: p.done + " / " + p.total + " routes"
                                + (p.halted ? " · " + (p.reason || "halted") : "")
                        })
                    }
                }
            })
            halted = result && result.halted
            haltReason = result && result.reason
        } catch (e) {
            console.warn("[AES orsScraper] bulk scrape failed", e)
            if (progressHandle) {
                progressHandle.complete({
                    type:    "error",
                    message: "ORS sync failed: " + ((e && e.message) ? e.message : e)
                })
            }
        }

        this._orsScrapeRunning = false
        this.settings.ors.lastBulkScrapeAt = Date.now()
        if (halted) {
            this.settings.ors.circuitBreakerTrippedAt = Date.now()
            console.warn("[AES orsScraper] circuit breaker tripped: " + haltReason)
        }
        await RouteAssistantSettings.save({ors: this.settings.ors})

        await this._applyCachedOrs()
        this._render()

        if (progressHandle) {
            if (halted) {
                progressHandle.complete({
                    type:    "warn",
                    message: "ORS sync halted: " + (haltReason || "rate limit hit")
                            + " · " + doneCount + "/" + totalCount + " done"
                })
            } else {
                progressHandle.complete({
                    type:    "success",
                    message: "ORS sync complete · " + totalCount + " routes"
                })
            }
        }
    }

    /**
     * Open a modal showing the cached ORS connection list for one route.
     * Lazy-rendered from cache only — never re-scrapes. Each connection row
     * shows its rank, rating, total price, total duration, and per-leg details.
     */
    _openOrsConnectionsDrawer(row) {
        if (!row) return
        const byClass = row.orsByClass || {}
        const hasAny = Object.keys(byClass).some(k => byClass[k]
            && Array.isArray(byClass[k].connections) && byClass[k].connections.length)
        if (!hasAny) return

        if (this._orsDrawer && this._orsDrawer.parentNode) {
            this._orsDrawer.parentNode.removeChild(this._orsDrawer)
        }

        const overlay = document.createElement("div")
        Object.assign(overlay.style, {
            position: "fixed", inset: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center"
        })
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._orsDrawer = null
        }
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        Object.assign(card.style, {
            background: "#1f2937", color: "#f3f4f6",
            border: "1px solid #b45309", borderRadius: "6px",
            padding: "16px 18px", minWidth: "640px", maxWidth: "920px",
            maxHeight: "82vh", overflowY: "auto",
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
            font: "12px/1.5 sans-serif"
        })
        const title = document.createElement("strong")
        title.textContent = "ORS connections · " + this.hubIata + " → " + row.destIata
        title.style.cssText = "color:#fcd34d;display:block;margin-bottom:6px;font-size:14px;"
        card.append(title)

        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
        const params = row.orsParams || {}
        const classes = Array.isArray(row.orsClassesScraped) ? row.orsClassesScraped : Object.keys(byClass)
        sub.textContent = "Classes scraped: " + (classes.join(", ") || "—")
            + " · Window: " + (params.departureH != null ? params.departureH : "—") + "h–"
                + (params.arrivalH != null ? params.arrivalH : "—") + "h"
            + " · Ground: " + (params.useGround ? "on" : "off")
            + " · Scraped: " + (row.orsScrapedAt ? new Date(row.orsScrapedAt).toLocaleString() : "—")
        card.append(sub)

        // Composite summary (across all classes via the user's chosen
        // combine method — same numbers the panel columns show).
        const summary = document.createElement("div")
        summary.style.cssText = "color:#fcd34d;font-size:11px;margin-bottom:10px;"
            + "background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.30);"
            + "border-radius:3px;padding:6px 8px;"
        const fmtRank   = v => v != null ? "#" + v : "—"
        const fmtRating = v => v != null ? Math.round(v) : "—"
        const gap = row.orsRatingGapToTop
        summary.innerHTML = "<strong>Composite:</strong> "
            + "rankNonstop " + fmtRank(row.orsRankNonstop) + " · "
            + "rankAny " + fmtRank(row.orsRankAny) + " · "
            + "ourTopRating " + fmtRating(row.orsOurTopRating) + " · "
            + "topCompetitor " + fmtRating(row.orsTopCompetitorRating) + " · "
            + "gap " + (gap != null ? (gap > 0 ? "+" : "") + Math.round(gap) : "—")
        card.append(summary)

        // Tab strip — Y / C / F / All. Default = primaryClass.
        const cfg = (this.settings && this.settings.ors) || {}
        const primary = cfg.primaryClass || "ECONOMY"
        const tabDefs = [
            {key: "ECONOMY",  label: "Y (Economy)",  color: "#86efac"},
            {key: "BUSINESS", label: "C (Business)", color: "#fde68a"},
            {key: "FIRST",    label: "F (First)",    color: "#fca5a5"},
            {key: "ALL",      label: "All",          color: "#fcd34d"}
        ]
        const tabBar = document.createElement("div")
        tabBar.style.cssText = "display:flex;gap:0;border-bottom:1px solid #374151;margin-bottom:10px;"
        const tabBtns = {}
        const listHost = document.createElement("div")
        const renderTab = (key) => {
            for (const k in tabBtns) {
                tabBtns[k].style.borderBottom = (k === key) ? "2px solid #fcd34d" : "2px solid transparent"
                tabBtns[k].style.opacity = (k === key) ? "1" : "0.6"
            }
            listHost.innerHTML = ""
            const conns = []
            if (key === "ALL") {
                for (const c of ["ECONOMY", "BUSINESS", "FIRST"]) {
                    const cr = byClass[c]
                    if (!cr || !Array.isArray(cr.connections)) continue
                    for (const conn of cr.connections) conns.push(Object.assign({_orsClass: c}, conn))
                }
            } else {
                const cr = byClass[key]
                if (cr && Array.isArray(cr.connections)) {
                    for (const conn of cr.connections) conns.push(Object.assign({_orsClass: key}, conn))
                }
            }
            if (key !== "ALL") {
                const cr = byClass[key]
                const classSum = document.createElement("div")
                classSum.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
                if (!cr) {
                    classSum.textContent = key + " not scraped — enable it in Classes checkboxes above and re-sync."
                } else {
                    classSum.textContent = key + ": " + (cr.totalConnections != null ? cr.totalConnections : 0) + " connections"
                        + " · rankNonstop " + fmtRank(cr.rankNonstop)
                        + " · ourTopRating " + fmtRating(cr.ourTopRating)
                        + " · topCompetitor " + fmtRating(cr.topCompetitorRating)
                        + " · gap " + (cr.ratingGapToTop != null ? (cr.ratingGapToTop > 0 ? "+" : "") + Math.round(cr.ratingGapToTop) : "—")
                }
                listHost.append(classSum)
            }
            const list = document.createElement("table")
            list.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
            const showClassCol = (key === "ALL")
            list.innerHTML = "<thead><tr style='color:#9ca3af;text-align:left;'>"
                + "<th style='padding:4px;'>#</th>"
                + (showClassCol ? "<th style='padding:4px;'>Cls</th>" : "")
                + "<th style='padding:4px;'>Rating</th>"
                + "<th style='padding:4px;'>Duration</th>"
                + "<th style='padding:4px;'>Price</th>"
                + "<th style='padding:4px;'>Status</th>"
                + "<th style='padding:4px;'>Legs</th>"
                + "</tr></thead>"
            const tbody = document.createElement("tbody")
            if (!conns.length) {
                const tr = document.createElement("tr")
                tr.innerHTML = "<td colspan='" + (showClassCol ? 7 : 6)
                    + "' style='padding:8px;color:#6b7280;text-align:center;'>"
                    + "(no connections in cache for this class)</td>"
                tbody.append(tr)
            }
            for (const conn of conns) {
                const tr = document.createElement("tr")
                const ourLeg = (conn.legs || []).some(l => l.isOurs)
                tr.style.background = ourLeg ? "rgba(245,158,11,0.08)" : "transparent"
                tr.style.borderBottom = "1px solid #2a3444"
                const legSummary = (conn.legs || []).map(l => {
                    if (l.isGround) return "<span style='color:#6b7280;'>↪ ground</span>"
                    const code = l.flightCode ? l.flightCode : "?"
                    const fmt = l.isOurs
                        ? "<strong style='color:#fcd34d;'>" + escapeHtml(code) + "</strong>"
                        : escapeHtml(code)
                    const rating = l.rating != null ? " r" + l.rating : ""
                    const sc = l.serviceClass ? " (" + l.serviceClass + ")" : ""
                    return fmt + rating + sc
                }).join(" → ")
                let cells = "<td style='padding:4px;color:#9ca3af;'>" + ((conn.idx != null ? conn.idx : 0) + 1) + "</td>"
                if (showClassCol) {
                    cells += "<td style='padding:4px;color:#fcd34d;'>" + (conn._orsClass || "—")[0] + "</td>"
                }
                cells += "<td style='padding:4px;font-weight:bold;color:#fcd34d;'>"
                    + (conn.rating != null ? conn.rating : "—") + "</td>"
                cells += "<td style='padding:4px;font-family:monospace;'>" + (conn.totalDuration || "—") + "</td>"
                cells += "<td style='padding:4px;'>" + (conn.totalPrice != null ? conn.totalPrice + " AS$" : "—") + "</td>"
                cells += "<td style='padding:4px;color:" + (conn.bookable ? "#86efac" : "#fca5a5") + ";'>"
                    + (conn.bookable ? "bookable" : "fully booked") + "</td>"
                cells += "<td style='padding:4px;'>" + legSummary + "</td>"
                tr.innerHTML = cells
                tbody.append(tr)
            }
            list.append(tbody)
            listHost.append(list)
        }
        for (const t of tabDefs) {
            const btn = document.createElement("button")
            btn.textContent = t.label
            btn.style.cssText = "background:transparent;border:none;color:" + t.color
                + ";padding:6px 10px;cursor:pointer;font:600 11px sans-serif;"
                + "border-bottom:2px solid transparent;"
            btn.addEventListener("click", () => renderTab(t.key))
            tabBtns[t.key] = btn
            tabBar.append(btn)
        }
        card.append(tabBar)
        card.append(listHost)
        renderTab(byClass[primary] ? primary : (Object.keys(byClass).find(k => byClass[k]) || "ALL"))

        const closeBtn = document.createElement("button")
        closeBtn.textContent = "Close"
        Object.assign(closeBtn.style, smallBtnStyle())
        closeBtn.style.marginTop = "12px"
        closeBtn.style.background = "#475569"
        closeBtn.addEventListener("click", close)
        card.append(closeBtn)

        overlay.append(card)
        document.body.append(overlay)
        this._orsDrawer = overlay
    }

    // ---------- Per-type fuel-burn table (letter A) ----------

    /**
     * Render a compact table inside the settings drawer listing each fleet
     * type's current cycle_L and per_km_L. Source is shown ("override" vs
     * "heuristic") and each row has an Edit link for manual override.
     */
    _renderFuelBurnTable() {
        const slots = RouteAssistantFleetStore.activeTypeSlots(this.fleet) || []
        if (!slots.length) return
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:6px;padding:6px 8px;background:#0b1220;border:1px solid #1f2a3a;border-radius:4px;"
        const head = document.createElement("div")
        head.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:4px;"
        head.textContent = "Per-type fuel burn (cycle_L + per_km_L × dist) — heuristic from spec; override with values from AS Performance Check."
        wrap.append(head)

        const table = document.createElement("table")
        table.style.cssText = "width:100%;font-size:10px;border-collapse:collapse;"
        table.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;">Type</th>
            <th style="text-align:right;padding:2px 4px;">cycle_L</th>
            <th style="text-align:right;padding:2px 4px;">per_km_L</th>
            <th style="text-align:left;padding:2px 4px;">Source</th>
            <th></th>
        </tr></thead>`
        const tbody = document.createElement("tbody")
        for (const slot of slots) {
            const spec = this.typeSpecs.get(slot.typeId)
            if (!spec) continue
            const burn = RouteAssistantFuelBurn.estimate(
                Object.assign({typeId: slot.typeId}, spec),
                this.fuelBurnOverrides
            )
            const tr = document.createElement("tr")
            const td = (text, align) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:2px 4px;text-align:" + (align || "left") + ";color:#d1d5db;"
                c.textContent = text
                return c
            }
            tr.append(td(slot.typeName + " ×" + slot.count, "left"))
            if (burn) {
                tr.append(td(Math.round(burn.cycleL), "right"))
                tr.append(td(burn.perKmL.toFixed(2), "right"))
                const srcCell = td(burn.source, "left")
                srcCell.style.color = burn.source === "override" ? "#a78bfa" : "#9ca3af"
                tr.append(srcCell)
            } else {
                tr.append(td("—", "right"))
                tr.append(td("—", "right"))
                tr.append(td("no spec", "left"))
            }
            const editTd = document.createElement("td")
            editTd.style.cssText = "padding:2px 4px;text-align:right;"
            const editBtn = document.createElement("button")
            editBtn.textContent = burn && burn.source === "override" ? "Edit" : "Override"
            Object.assign(editBtn.style, smallBtnStyle())
            editBtn.style.background = "#475569"
            editBtn.style.fontSize = "9px"
            editBtn.style.padding = "1px 5px"
            editBtn.disabled = !spec
            editBtn.addEventListener("click", () => this._openFuelBurnEditor(slot, spec, burn))
            editTd.append(editBtn)
            tr.append(editTd)
            tbody.append(tr)
        }
        table.append(tbody)
        wrap.append(table)
        this.settingsHost.append(wrap)
    }

    /**
     * Modal to set/clear per-type fuel-burn override. Same pattern as the
     * per-route override editor: show current values (override or heuristic),
     * Save / Clear / Cancel buttons.
     */
    _openFuelBurnEditor(slot, spec, currentBurn) {
        if (!slot || slot.typeId == null) return
        if (this._fuelBurnEditor && this._fuelBurnEditor.parentNode) {
            this._fuelBurnEditor.parentNode.removeChild(this._fuelBurnEditor)
        }

        const overlay = document.createElement("div")
        Object.assign(overlay.style, {
            position: "fixed", inset: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center"
        })
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._fuelBurnEditor = null
        }
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        Object.assign(card.style, {
            background: "#1f2937", color: "#f3f4f6",
            border: "1px solid #4c1d95", borderRadius: "6px",
            padding: "16px 18px", minWidth: "380px", maxWidth: "460px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
            font: "12px/1.5 sans-serif"
        })
        const title = document.createElement("strong")
        title.textContent = "Fuel burn · " + (slot.typeName || "type " + slot.typeId)
        title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:13px;"
        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
        sub.textContent = "Run Performance Check on AS for this type at two distances (e.g. 500 km and 2,000 km) to derive these constants. Empty = use heuristic."

        const cycleInput = mkNumberInput(currentBurn ? currentBurn.cycleL : null, {min: 0, max: 100000, step: 1, width: "80px"})
        const perKmInput = mkNumberInput(currentBurn ? Math.round(currentBurn.perKmL * 1000) / 1000 : null, {min: 0, max: 100, step: 0.01, width: "80px"})

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:12px;"
        const addRow = (label, input, hint) => {
            const lab = document.createElement("label")
            lab.textContent = label
            lab.style.cssText = "color:#9ca3af;font-size:11px;"
            grid.append(lab)
            const wrap = document.createElement("div")
            wrap.append(input)
            const h = document.createElement("span")
            h.textContent = " " + hint
            h.style.cssText = "color:#6b7280;font-size:10px;"
            wrap.append(h)
            grid.append(wrap)
        }
        addRow("cycle_L",  cycleInput, "litres per cycle (taxi+TO+approach+land)")
        addRow("per_km_L", perKmInput, "litres per km of round-trip distance")

        const heur = RouteAssistantFuelBurn.heuristic(Object.assign({typeId: slot.typeId}, spec))
        const heurLine = document.createElement("div")
        heurLine.style.cssText = "color:#6b7280;font-size:10px;margin-bottom:8px;"
        heurLine.textContent = heur
            ? `Heuristic suggests cycle=${Math.round(heur.cycleL)} L, per_km=${heur.perKmL.toFixed(2)} L (from ${spec && spec.seats ? spec.seats : "?"} seats × ${spec && spec.speed ? spec.speed : "?"} km/h).`
            : "Heuristic unavailable (spec missing seats/cargo)."

        const buttonRow = document.createElement("div")
        buttonRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;"

        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.addEventListener("click", close)

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear override"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.disabled = !(currentBurn && currentBurn.source === "override")
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            await RouteAssistantFuelBurn.removeOverride(slot.typeId)
            this.fuelBurnOverrides.delete(slot.typeId)
            this.fuelBurnOverrides.delete(String(slot.typeId))
            this._recomputeProfit()
            this._renderSettings()
            close()
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.addEventListener("click", async () => {
            const fields = {
                cycleL: numOrNull(cycleInput.value),
                perKmL: numOrNull(perKmInput.value)
            }
            const saved = await RouteAssistantFuelBurn.saveOverride(slot.typeId, fields)
            if (saved) {
                this.fuelBurnOverrides.set(slot.typeId, saved)
                this.fuelBurnOverrides.set(String(slot.typeId), saved)
            } else {
                this.fuelBurnOverrides.delete(slot.typeId)
                this.fuelBurnOverrides.delete(String(slot.typeId))
            }
            this._recomputeProfit()
            this._renderSettings()
            close()
        })

        buttonRow.append(cancelBtn, clearBtn, saveBtn)
        card.append(title, sub, grid, heurLine, buttonRow)
        overlay.append(card)
        document.body.append(overlay)
        this._fuelBurnEditor = overlay
        cycleInput.focus()
    }

    // ---------- Per-route override editor ----------

    /**
     * Inline quick-edit popover anchored to the $/flt cell's ▾ caret. Lets
     * the user tweak yield / LF for one route without opening the full
     * modal. Saves to RouteAssistantRouteOverridesStore on click; outside
     * click or Escape closes without saving. The full modal stays available
     * via the "Edit…" button at the bottom.
     */
    _openProfitModifierPopover(row, anchorEl) {
        if (!row || !this.hubIata) return
        this._closeProfitPopover()

        const hubU    = String(this.hubIata).toUpperCase()
        const destU   = String(row.destIata).toUpperCase()
        const pairKey = hubU + "-" + destU
        const econ    = (this.settings && this.settings.economics) || {}
        const existing = row.override || {}

        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:   "fixed",
            background: "#1f2937",
            color:      "#f3f4f6",
            border:     "1px solid #4c1d95",
            borderRadius: "5px",
            boxShadow:  "0 8px 25px rgba(0,0,0,0.55)",
            padding:    "10px 12px",
            zIndex:     "10002",
            minWidth:   "240px",
            font:       "11px/1.5 sans-serif"
        })

        const title = document.createElement("strong")
        title.textContent = `Modify · ${hubU} → ${destU}`
        title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:12px;"

        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;line-height:1.45;"
        const baseYield = existing.yieldPerKm != null ? existing.yieldPerKm
                        : (econ.yieldPerKm != null ? econ.yieldPerKm : 0.10)
        const baseCYld  = existing.cargoYieldPerKgKm != null ? existing.cargoYieldPerKgKm
                        : (econ.cargoYieldPerKgKm != null ? econ.cargoYieldPerKgKm : 0)
        sub.innerHTML = "Quick-edit ticket-price + LF for this route. Empty = inherit base economics.<br>"
            + "<span style='color:#6b7280;'>Effective ticket ≈ yield × distance (one-way).</span>"

        const yieldInput  = mkNumberInput(numOrNull(existing.yieldPerKm),        {min: 0, max: 10,  step: 0.01,   width: "80px"})
        const paxLfInput  = mkNumberInput(numOrNull(existing.paxLF),             {min: 0, max: 1,   step: 0.05,   width: "80px"})
        const cyldInput   = mkNumberInput(numOrNull(existing.cargoYieldPerKgKm), {min: 0, max: 1,   step: 0.0001, width: "80px"})
        const cLfInput    = mkNumberInput(numOrNull(existing.cargoLF),           {min: 0, max: 1,   step: 0.05,   width: "80px"})

        // Live preview of the effective one-way ticket price as the user
        // types. Distance × yield is the simplest read of "what will an
        // average pax pay" — Y/C/F per-class fares come with Tier 2.
        const previewLine = document.createElement("div")
        previewLine.style.cssText = "color:#cbd5e1;font-size:10px;margin-bottom:6px;font-style:italic;"
        const dist = row.distanceKm
        const updatePreview = () => {
            const y = parseFloatOr(yieldInput.value, baseYield)
            if (!dist) { previewLine.textContent = ""; return }
            const oneWay = y * dist
            previewLine.textContent = "≈ AS$" + Math.round(oneWay).toLocaleString()
                + " one-way ticket  (yield × " + dist.toLocaleString() + " km)"
        }
        updatePreview()

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:center;margin-bottom:6px;"
        const addRow = (label, input) => {
            const lab = document.createElement("label")
            lab.textContent = label
            lab.style.cssText = "color:#9ca3af;"
            grid.append(lab, input)
        }
        addRow("Yield AS$/pax-km", yieldInput)
        addRow("Pax LF",           paxLfInput)
        addRow("Cargo AS$/kg-km",  cyldInput)
        addRow("Cargo LF",         cLfInput)

        for (const inp of [yieldInput, paxLfInput, cyldInput, cLfInput]) {
            inp.addEventListener("input", updatePreview)
        }

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap;"

        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.style.fontSize = "10px"
        cancelBtn.style.padding = "2px 8px"
        cancelBtn.addEventListener("click", () => this._closeProfitPopover())

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.style.fontSize = "10px"
        clearBtn.style.padding = "2px 8px"
        clearBtn.disabled = !row.override
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            const prev = row.override ? Object.assign({}, row.override) : null
            await this._undoableSave({
                label: "Override cleared for " + hubU + "→" + destU,
                type:  "info",
                perform: async () => {
                    await RouteAssistantRouteOverridesStore.remove(hubU, destU)
                    row.override = null
                    this.overrideMap.delete(pairKey)
                    this._recomputeProfit()
                },
                restore: prev
                    ? async () => {
                        const restored = await RouteAssistantRouteOverridesStore.save(hubU, destU,
                            {paxLF: prev.paxLF, cargoLF: prev.cargoLF, yieldPerKm: prev.yieldPerKm,
                             cargoYieldPerKgKm: prev.cargoYieldPerKgKm, note: prev.note || ""})
                        row.override = restored
                        if (restored) this.overrideMap.set(pairKey, restored)
                        this._recomputeProfit()
                    }
                    : null
            })
            this._closeProfitPopover()
        })

        const editBtn = document.createElement("button")
        editBtn.textContent = "Full editor…"
        Object.assign(editBtn.style, smallBtnStyle())
        editBtn.style.background = "#475569"
        editBtn.style.fontSize = "10px"
        editBtn.style.padding = "2px 8px"
        editBtn.title = "Open the full editor (adds note + Calibrate-from-actuals)"
        editBtn.addEventListener("click", () => {
            this._closeProfitPopover()
            this._openOverrideEditor(row)
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.style.padding = "2px 8px"
        saveBtn.addEventListener("click", async () => {
            const fields = {
                paxLF:             numOrNull(paxLfInput.value),
                cargoLF:           numOrNull(cLfInput.value),
                yieldPerKm:        numOrNull(yieldInput.value),
                cargoYieldPerKgKm: numOrNull(cyldInput.value),
                note:              existing.note || ""    // preserve any note set in full editor
            }
            const prev = row.override ? Object.assign({}, row.override) : null
            await this._undoableSave({
                label: "Override saved for " + hubU + "→" + destU,
                perform: async () => {
                    const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
                    row.override = saved
                    if (saved) this.overrideMap.set(pairKey, saved)
                    else       this.overrideMap.delete(pairKey)
                    this._recomputeProfit()
                },
                restore: async () => {
                    if (prev) {
                        const restored = await RouteAssistantRouteOverridesStore.save(hubU, destU,
                            {paxLF: prev.paxLF, cargoLF: prev.cargoLF, yieldPerKm: prev.yieldPerKm,
                             cargoYieldPerKgKm: prev.cargoYieldPerKgKm, note: prev.note || ""})
                        row.override = restored
                        if (restored) this.overrideMap.set(pairKey, restored)
                    } else {
                        await RouteAssistantRouteOverridesStore.remove(hubU, destU)
                        row.override = null
                        this.overrideMap.delete(pairKey)
                    }
                    this._recomputeProfit()
                }
            })
            this._closeProfitPopover()
        })

        btnRow.append(cancelBtn, clearBtn, editBtn, saveBtn)
        pop.append(title, sub, grid, previewLine, btnRow)

        document.body.append(pop)
        this._profitPopover = pop

        // Position next to the caret. Prefer below; flip above when too
        // close to the bottom edge of the viewport.
        const r = anchorEl.getBoundingClientRect()
        const popRect = pop.getBoundingClientRect()
        const vh = window.innerHeight
        const vw = window.innerWidth
        let top = r.bottom + 6
        if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
        let left = r.right - popRect.width
        if (left < 8) left = 8
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
        pop.style.top  = top  + "px"
        pop.style.left = left + "px"

        yieldInput.focus()
        yieldInput.select && yieldInput.select()

        // Outside-click + Escape close. Schedule the listener on the next
        // tick so the click that opened us doesn't immediately dismiss it.
        const onMouseDown = (e) => {
            if (pop.contains(e.target)) return
            if (e.target === anchorEl) return
            this._closeProfitPopover()
        }
        const onKey = (e) => { if (e.key === "Escape") this._closeProfitPopover() }
        setTimeout(() => {
            document.addEventListener("mousedown", onMouseDown)
            document.addEventListener("keydown",   onKey)
        }, 0)
        this._profitPopoverCleanup = () => {
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("keydown",   onKey)
        }
    }

    _closeProfitPopover() {
        if (this._profitPopoverCleanup) {
            try { this._profitPopoverCleanup() } catch (e) { /* noop */ }
            this._profitPopoverCleanup = null
        }
        if (this._profitPopover && this._profitPopover.parentNode) {
            this._profitPopover.parentNode.removeChild(this._profitPopover)
        }
        this._profitPopover = null
    }

    _openRouteNotePopover(row, anchorEl) {
        if (!row || !this.hubIata) return
        this._closeRouteNotePopover()
        const hubU    = String(this.hubIata).toUpperCase()
        const destU   = String(row.destIata).toUpperCase()
        const pairKey = hubU + "-" + destU
        const existingText = (row.routeNote && typeof row.routeNote.text === "string")
            ? row.routeNote.text : ""
        const updatedAt = (row.routeNote && row.routeNote.updatedAt) || null
        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:     "fixed",
            background:   "#1f2937",
            color:        "#f3f4f6",
            border:       "1px solid #475569",
            borderRadius: "5px",
            boxShadow:    "0 8px 25px rgba(0,0,0,0.55)",
            padding:      "10px 12px",
            zIndex:       "10002",
            minWidth:     "320px",
            font:         "11px/1.5 sans-serif"
        })
        const titleEl = document.createElement("strong")
        titleEl.textContent = "Note · " + hubU + " → " + destU
        titleEl.style.cssText = "color:#cbd5e1;display:block;margin-bottom:4px;font-size:12px;"
        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;"
        sub.textContent = updatedAt
            ? "Last updated " + new Date(updatedAt).toLocaleString()
            : "Capture context — strategy thoughts, observations, things to watch."
        const ta = document.createElement("textarea")
        ta.value = existingText
        ta.maxLength = RouteAssistantRouteNoteStore.MAX_TEXT_LEN
        ta.rows = 5
        ta.style.cssText = "width:100%;box-sizing:border-box;background:#0f1623;"
            + "color:#f3f4f6;border:1px solid #374151;border-radius:3px;"
            + "padding:5px;font-size:11px;font-family:inherit;resize:vertical;"
        const counter = document.createElement("div")
        counter.style.cssText = "color:#6b7280;font-size:10px;text-align:right;margin-top:2px;"
        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:8px;"
        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.style.fontSize = "10px"
        cancelBtn.style.padding = "2px 8px"
        const deleteBtn = document.createElement("button")
        deleteBtn.textContent = "Delete"
        Object.assign(deleteBtn.style, smallBtnStyle())
        deleteBtn.style.background = "#7f1d1d"
        deleteBtn.style.fontSize = "10px"
        deleteBtn.style.padding = "2px 8px"
        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.style.padding = "2px 8px"

        // Save is disabled while the textarea is empty so that the only path
        // to a deletion is the explicit Delete button — avoids the user
        // accidentally Cmd-A-Backspace-Save'ing away an existing note.
        // Delete is disabled when there's nothing to delete.
        const updateButtonState = () => {
            const len = ta.value.trim().length
            counter.textContent = ta.value.length + " / " + RouteAssistantRouteNoteStore.MAX_TEXT_LEN
            saveBtn.disabled = len === 0
            saveBtn.style.opacity = saveBtn.disabled ? "0.5" : "1"
            deleteBtn.disabled = !existingText
            deleteBtn.style.opacity = deleteBtn.disabled ? "0.5" : "1"
        }
        updateButtonState()
        ta.addEventListener("input", updateButtonState)
        ta.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (!saveBtn.disabled) saveBtn.click()
            }
        })

        // _renderRows rebuilds this.scoredRows from this.rows via
        // Object.assign, so the source-of-truth update has to land on
        // this.rows as well — mutating only the scoredRow we got passed
        // in would be erased on the very next render.
        const propagateNote = (record) => {
            row.routeNote = record
            row.routeNoteText = record ? record.text : null
            if (this.rows) {
                const baseRow = this.rows.find(r =>
                    String(r.destIata || "").toUpperCase() === destU)
                if (baseRow) {
                    baseRow.routeNote = record
                    baseRow.routeNoteText = record ? record.text : null
                }
            }
            if (record) this.routeNoteMap.set(pairKey, record)
            else        this.routeNoteMap.delete(pairKey)
        }

        // Single close path used by Cancel / outside-click / Escape. Confirms
        // before discarding when the textarea diverges from existingText.
        const requestClose = () => {
            if (ta.value !== existingText
                && !window.confirm("Discard unsaved note changes?")) return
            this._closeRouteNotePopover()
        }
        cancelBtn.addEventListener("click", requestClose)
        deleteBtn.addEventListener("click", async () => {
            if (!existingText) return
            // Capture the full prev record so Undo can restore not just the
            // text but createdAt + updatedAt. The store's save() rewrites
            // updatedAt unconditionally — we lose the original timestamp,
            // but the user-facing text round-trips correctly.
            const prevRecord = this.routeNoteMap.get(pairKey) || null
            await this._undoableSave({
                label: "Note deleted for " + hubU + "→" + destU,
                type:  "info",
                perform: async () => {
                    await RouteAssistantRouteNoteStore.remove(hubU, destU)
                    propagateNote(null)
                    this._renderRows()
                },
                restore: prevRecord
                    ? async () => {
                        const restored = await RouteAssistantRouteNoteStore.save(hubU, destU,
                            {text: prevRecord.text})
                        propagateNote(restored)
                        this._renderRows()
                    }
                    : null
            })
            this._closeRouteNotePopover()
        })
        saveBtn.addEventListener("click", async () => {
            if (saveBtn.disabled) return
            // Skip the round-trip when nothing changed — the underlying store
            // would otherwise rewrite the record with a fresh updatedAt and
            // falsely advance the "Last updated" line on the next open.
            if (ta.value === existingText) {
                this._closeRouteNotePopover()
                return
            }
            const prevText = existingText
            const newText  = ta.value
            await this._undoableSave({
                label: "Note saved for " + hubU + "→" + destU,
                perform: async () => {
                    const saved = await RouteAssistantRouteNoteStore.save(hubU, destU, {text: newText})
                    propagateNote(saved)
                    this._renderRows()
                },
                restore: async () => {
                    if (!prevText) {
                        // Previous state was empty → restore = remove the new save.
                        await RouteAssistantRouteNoteStore.remove(hubU, destU)
                        propagateNote(null)
                    } else {
                        const restored = await RouteAssistantRouteNoteStore.save(hubU, destU,
                            {text: prevText})
                        propagateNote(restored)
                    }
                    this._renderRows()
                }
            })
            this._closeRouteNotePopover()
        })
        btnRow.append(cancelBtn, deleteBtn, saveBtn)
        pop.append(titleEl, sub, ta, counter, btnRow)
        document.body.append(pop)
        this._routeNotePopover = pop
        const r = anchorEl.getBoundingClientRect()
        const popRect = pop.getBoundingClientRect()
        const vh = window.innerHeight
        const vw = window.innerWidth
        let top = r.bottom + 6
        if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
        let left = r.left
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
        if (left < 8) left = 8
        pop.style.top  = top  + "px"
        pop.style.left = left + "px"
        ta.focus()
        const onMouseDown = (e) => {
            if (pop.contains(e.target)) return
            if (e.target === anchorEl) return
            requestClose()
        }
        const onKey = (e) => { if (e.key === "Escape") requestClose() }
        setTimeout(() => {
            document.addEventListener("mousedown", onMouseDown)
            document.addEventListener("keydown",   onKey)
        }, 0)
        this._routeNotePopoverCleanup = () => {
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("keydown",   onKey)
        }
    }

    _closeRouteNotePopover() {
        if (this._routeNotePopoverCleanup) {
            try { this._routeNotePopoverCleanup() } catch (e) { /* noop */ }
            this._routeNotePopoverCleanup = null
        }
        if (this._routeNotePopover && this._routeNotePopover.parentNode) {
            this._routeNotePopover.parentNode.removeChild(this._routeNotePopover)
        }
        this._routeNotePopover = null
    }

    /**
     * F slice 2 — rich popover for the Cmp pill. Renders each AS
     * competitor with banner + avatar + clickable enterprise link +
     * pax share % + change indicator, mirroring AS's Stations table.
     * Opens on hover (200ms delay), auto-closes on leave (250ms grace),
     * or click-pins so the user can interact with the links inside.
     * Returns null when no `marketSharePax` data — caller falls back
     * to the existing plain-text title="" tooltip.
     */
    _openCarrierPopover(row, anchorEl, opts) {
        opts = opts || {}
        if (!row || !anchorEl) return null
        // Source priority for the popover content:
        //   1. competitorEntries — merged AS pax+cargo leaderboard, with
        //      flight-prefix backfill for routes without a leaderboard.
        //   2. marketSharePax — raw pax leaderboard (older cache shape).
        //   3. row.carriers — flightsfrom.com per-carrier list (Letter F).
        //   4. Empty popover with a "no data yet" message — at least the
        //      hover registers and the user knows what to do next.
        const fromMerged = Array.isArray(row.competitorEntries) ? row.competitorEntries.slice() : null
        const fromPaxOnly = Array.isArray(row.marketSharePax) ? row.marketSharePax.slice() : []
        let shares = (fromMerged && fromMerged.length) ? fromMerged : fromPaxOnly
        let usingFlightsFromFallback = false
        if (!shares.length && Array.isArray(row.carriers) && row.carriers.length) {
            usingFlightsFromFallback = true
            shares = row.carriers.map(c => ({
                enterpriseId:    null,
                name:            (c.name || c.code || "?")
                                  + (c.weeklyFlights ? "  ·  " + c.weeklyFlights + "/wk" : ""),
                paxShare:        null,
                cargoShare:      null,
                paxRank:         null,
                cargoRank:       null,
                fromFlightsFrom: true
            }))
        }
        // Render an EMPTY popover with a clear "no data" message rather than
        // returning silently — fixes the user-reported "hover doesn't register"
        // bug where the rich popover bailed but the native title fallback also
        // had nothing useful to show.
        // Rank by max share across pax + cargo so dominant operators
        // float to the top regardless of which leaderboard they lead.
        shares.sort((a, b) => {
            const aMax = Math.max(a.paxShare || a.sharePct || 0, a.cargoShare || 0)
            const bMax = Math.max(b.paxShare || b.sharePct || 0, b.cargoShare || 0)
            return bMax - aMax
        })

        this._closeCarrierPopover()

        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:     "fixed",
            background:   "#1f2937",
            color:        "#f3f4f6",
            border:       "1px solid #15803d",
            borderRadius: "5px",
            boxShadow:    "0 8px 25px rgba(0,0,0,0.55)",
            padding:      "8px 10px",
            zIndex:       "10002",
            minWidth:     "320px",
            maxWidth:     "440px",
            maxHeight:    "70vh",
            overflowY:    "auto",
            font:         "11px/1.4 sans-serif"
        })

        const header = document.createElement("div")
        header.style.cssText = "color:#86efac;font-size:11px;margin-bottom:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;"
        const intensity = row.competitiveIntensity
            || (typeof RouteAssistantCarriersScraper !== "undefined"
                ? RouteAssistantCarriersScraper.intensity(shares.length || row.airlineCount)
                : null)
        const intensityColor = (typeof RouteAssistantCarriersScraper !== "undefined")
            ? RouteAssistantCarriersScraper.intensityColor(intensity)
            : "#9ca3af"
        const intensityPill = document.createElement("span")
        intensityPill.textContent = intensity ? intensity.toUpperCase() : "—"
        intensityPill.style.cssText = "padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;color:#0f172a;background:" + intensityColor + ";"
        const headTitle = document.createElement("strong")
        // Decompose the count: how many compete on pax, how many on
        // cargo. Bare total is misleading on freight-heavy routes.
        const paxN   = shares.filter(e => (e.paxShare   != null) || (e.sharePct != null && e.cargoShare == null)).length
        const cargoN = shares.filter(e => e.cargoShare != null).length
        let label
        if (!shares.length) {
            label = "No detail data yet"
        } else if (usingFlightsFromFallback) {
            label = shares.length + " real-world carrier" + (shares.length === 1 ? "" : "s")
        } else {
            label = shares.length + " AS competitor" + (shares.length === 1 ? "" : "s")
            if (paxN && cargoN) label += " · " + paxN + " pax / " + cargoN + " cargo"
            else if (cargoN)    label += " · cargo only"
            else if (paxN)      label += " · pax only"
        }
        headTitle.textContent = label
        const period = document.createElement("span")
        period.textContent = row.marketSharePeriod ? "· " + row.marketSharePeriod : ""
        period.style.cssText = "color:#9ca3af;font-weight:normal;"
        header.append(headTitle, intensityPill, period)
        pop.append(header)

        if (shares.length) {
            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;"
            for (const e of shares) list.append(this._buildCarrierRow(e))
            pop.append(list)
            if (usingFlightsFromFallback) {
                const note = document.createElement("div")
                note.style.cssText = "color:#fbbf24;font-size:10px;margin-top:6px;font-style:italic;"
                note.textContent = "↑ flightsfrom.com real-world carriers (no AS in-game market data scraped yet)."
                pop.append(note)
            }
        } else {
            // No data at all — show a clear "fetch this" message instead of
            // returning silently. The user-reported "doesn't register" bug
            // came from silent returns leaving the user thinking the panel
            // was broken; now the popover always opens with an action hint.
            const empty = document.createElement("div")
            empty.style.cssText = "color:#9ca3af;font-size:11px;line-height:1.5;padding:6px 0;"
            empty.innerHTML = "No competitor detail captured for this route yet.<br><br>"
                + "<strong style='color:#86efac;'>To populate:</strong><br>"
                + "1. Open <em>Settings → Market Analysis</em> and click <em>Sync market analysis</em>, or<br>"
                + "2. Open <em>Settings → Carriers</em> and click <em>Sync carriers</em> for real-world data, or<br>"
                + "3. Visit <code>/app/com/markets/" + escapeHtml(this.hubIata || "?") + escapeHtml(row.destIata || "?") + "</code> directly."
            pop.append(empty)
        }

        const footer = document.createElement("div")
        footer.style.cssText = "color:#6b7280;font-size:10px;margin-top:8px;border-top:1px solid #374151;padding-top:6px;"
        const meta = (this.settings && this.settings.carriers) || {}
        const missingMeta = shares.some(e => e.enterpriseId != null && !e.bannerUrl && !e.avatarUrl)
        const lastSync = meta.lastEnterpriseMetaSyncAt
            ? new Date(meta.lastEnterpriseMetaSyncAt).toLocaleString()
            : null
        const lines = []
        if (lastSync) lines.push("Enterprise meta last synced: " + lastSync)
        if (missingMeta) {
            lines.push("Some banners/avatars missing — open Settings → Carriers → \"Sync enterprise data\".")
        }
        if (row.marketsScrapedAt) {
            lines.push("Market shares from " + new Date(row.marketsScrapedAt).toLocaleString())
        }
        if (!lines.length) lines.push("Click a name to open the enterprise page.")
        footer.innerHTML = lines.map(s => escapeHtml(s)).join("<br>")
        pop.append(footer)

        document.body.append(pop)
        this._carrierPopover = pop
        this._carrierPopoverPinned = !!opts.pinned

        this._positionCarrierPopover(anchorEl)

        const cancelClose = () => {
            if (this._carrierPopoverCloseTimer) {
                clearTimeout(this._carrierPopoverCloseTimer)
                this._carrierPopoverCloseTimer = null
            }
        }
        const scheduleClose = () => {
            if (this._carrierPopoverPinned) return
            cancelClose()
            this._carrierPopoverCloseTimer = setTimeout(() => this._closeCarrierPopover(), 250)
        }
        pop.addEventListener("mouseenter", cancelClose)
        pop.addEventListener("mouseleave", scheduleClose)
        anchorEl.addEventListener("mouseleave", scheduleClose)

        const onMouseDown = (e) => {
            if (!this._carrierPopoverPinned) return
            if (pop.contains(e.target)) return
            if (e.target === anchorEl) return
            this._closeCarrierPopover()
        }
        const onKey = (e) => { if (e.key === "Escape") this._closeCarrierPopover() }
        setTimeout(() => {
            document.addEventListener("mousedown", onMouseDown)
            document.addEventListener("keydown",   onKey)
        }, 0)

        this._carrierPopoverCleanup = () => {
            cancelClose()
            anchorEl.removeEventListener("mouseleave", scheduleClose)
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("keydown",   onKey)
        }
        return pop
    }

    _closeCarrierPopover() {
        if (this._carrierPopoverCloseTimer) {
            clearTimeout(this._carrierPopoverCloseTimer)
            this._carrierPopoverCloseTimer = null
        }
        if (this._carrierPopoverCleanup) {
            try { this._carrierPopoverCleanup() } catch (e) { /* noop */ }
            this._carrierPopoverCleanup = null
        }
        if (this._carrierPopover && this._carrierPopover.parentNode) {
            this._carrierPopover.parentNode.removeChild(this._carrierPopover)
        }
        this._carrierPopover = null
        this._carrierPopoverPinned = false
    }

    _positionCarrierPopover(anchorEl) {
        const pop = this._carrierPopover
        if (!pop) return
        const r = anchorEl.getBoundingClientRect()
        const popRect = pop.getBoundingClientRect()
        const vh = window.innerHeight
        const vw = window.innerWidth
        let top = r.bottom + 6
        if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
        let left = r.right - popRect.width
        if (left < 8) left = 8
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
        pop.style.top  = top  + "px"
        pop.style.left = left + "px"
    }

    /**
     * Build one competitor row in the popover. Layout:
     *   [avatar 32×32]  [name link + banner OR name + #id]  [share% / Δ / rank]
     */
    _buildCarrierRow(entry) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:3px;"
        wrap.addEventListener("mouseenter", () => { wrap.style.background = "rgba(34,197,94,0.08)" })
        wrap.addEventListener("mouseleave", () => { wrap.style.background = "" })

        const avatarBox = document.createElement("div")
        avatarBox.style.cssText = "flex-shrink:0;width:32px;height:32px;border-radius:3px;background:#0f1623;display:flex;align-items:center;justify-content:center;overflow:hidden;"
        if (entry.avatarUrl) {
            const img = document.createElement("img")
            img.src = entry.avatarUrl
            img.alt = entry.name || ""
            img.style.cssText = "width:100%;height:100%;object-fit:cover;"
            img.addEventListener("error", () => {
                if (img.parentNode === avatarBox) avatarBox.removeChild(img)
                avatarBox.append(_initialBadge(entry.name))
            })
            avatarBox.append(img)
        } else {
            avatarBox.append(_initialBadge(entry.name))
        }
        wrap.append(avatarBox)

        const middle = document.createElement("div")
        middle.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;"
        const nameRow = document.createElement("div")
        nameRow.style.cssText = "display:flex;align-items:center;gap:4px;min-width:0;"
        const nameLink = document.createElement("a")
        nameLink.href = "/app/info/enterprises/" + encodeURIComponent(entry.enterpriseId || "")
        nameLink.target = "_blank"
        nameLink.rel = "noreferrer noopener"
        nameLink.textContent = entry.name || "(unknown)"
        nameLink.style.cssText = "color:#93c5fd;text-decoration:none;font-weight:600;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;"
        nameLink.addEventListener("mouseenter", () => { nameLink.style.textDecoration = "underline" })
        nameLink.addEventListener("mouseleave", () => { nameLink.style.textDecoration = "none" })
        nameRow.append(nameLink)

        // F slice 3 — partner glyphs sourced from the user's own
        // enterprise(s) contractual partners table. Inline next to the
        // name so a quick scan of the popover surfaces who you can
        // codeshare with at a glance.
        const cfgC = (this.settings && this.settings.carriers) || {}
        const partnersMap = this._partnersByEnterpriseId
        const partnerKey = entry.enterpriseId != null ? String(entry.enterpriseId) : null
        const relations = (partnersMap && partnerKey) ? partnersMap.get(partnerKey) : null
        if (relations && relations.length) {
            if (relations.indexOf("INTERLINING") !== -1 && cfgC.showInterliningGlyph !== false) {
                const il = document.createElement("span")
                il.textContent = "⇄"
                il.title = "Interlining partner"
                il.style.cssText = "color:#16a34a;font-size:11px;font-weight:700;flex-shrink:0;"
                nameRow.append(il)
            }
            if (relations.indexOf("ALLIANCE") !== -1 && cfgC.showAllianceGlyph) {
                const al = document.createElement("span")
                al.textContent = "✦"
                al.title = "Alliance partner"
                al.style.cssText = "color:#a78bfa;font-size:11px;font-weight:700;flex-shrink:0;"
                nameRow.append(al)
            }
        }
        middle.append(nameRow)

        if (entry.bannerUrl) {
            const banner = document.createElement("img")
            banner.src = entry.bannerUrl
            banner.alt = entry.name || ""
            banner.style.cssText = "max-width:100%;max-height:24px;object-fit:contain;border-radius:2px;"
            banner.addEventListener("error", () => {
                if (banner.parentNode === middle) middle.removeChild(banner)
            })
            middle.append(banner)
        } else {
            const sub = document.createElement("span")
            sub.textContent = (entry.iata ? entry.iata + " · " : "") + "#" + (entry.enterpriseId || "?")
            sub.style.cssText = "color:#6b7280;font-size:9px;"
            middle.append(sub)
        }
        wrap.append(middle)

        // Right-side share block. The merged shape exposes
        // {paxShare, cargoShare, paxRank, cargoRank, paxChange, cargoChange};
        // legacy entries from `marketSharePax` only have `sharePct/rank/change`.
        // Render whatever's present so both shapes work.
        const right = document.createElement("div")
        right.style.cssText = "flex-shrink:0;text-align:right;font-size:9px;line-height:1.25;min-width:80px;display:flex;flex-direction:column;gap:1px;"
        const paxShare   = entry.paxShare   != null ? entry.paxShare   : (entry.sharePct != null ? entry.sharePct : null)
        const cargoShare = entry.cargoShare != null ? entry.cargoShare : null
        const paxChange   = entry.paxChange   != null ? entry.paxChange   : (entry.change != null ? entry.change : null)
        const cargoChange = entry.cargoChange != null ? entry.cargoChange : null

        const buildShareLine = (label, share, change, primary) => {
            if (share == null) return null
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;justify-content:flex-end;align-items:baseline;gap:4px;"
            const tag = document.createElement("span")
            tag.textContent = label
            tag.style.cssText = "color:#6b7280;font-size:8px;"
            const value = document.createElement("span")
            value.textContent = share.toFixed(1) + "%"
            value.style.cssText = "color:" + (primary ? "#f3f4f6" : "#cbd5e1") + ";font-weight:" + (primary ? "600" : "400") + ";"
            wrap.append(tag, value)
            if (change != null && change !== 0) {
                const arrow = change > 0 ? "▲" : "▼"
                const color = change > 0 ? "#86efac" : "#fca5a5"
                const chgEl = document.createElement("span")
                chgEl.textContent = arrow + Math.abs(change).toFixed(1)
                chgEl.style.cssText = "color:" + color + ";font-size:8px;"
                wrap.append(chgEl)
            }
            return wrap
        }
        const primarySide = (paxShare != null && (cargoShare == null || paxShare >= cargoShare)) ? "pax" : "cargo"
        const paxLine = buildShareLine("Pax",   paxShare,   paxChange,   primarySide === "pax")
        const cargoLine = buildShareLine("Cargo", cargoShare, cargoChange, primarySide === "cargo")
        if (paxLine)   right.append(paxLine)
        if (cargoLine) right.append(cargoLine)
        // Rank pill (uses the most relevant side's rank).
        const rank = entry.paxRank != null ? entry.paxRank
                  : (entry.cargoRank != null ? entry.cargoRank
                  : (entry.rank != null ? entry.rank : null))
        if (rank != null) {
            const rankEl = document.createElement("div")
            rankEl.textContent = "#" + rank
            rankEl.style.cssText = "color:#6b7280;font-size:8px;"
            right.append(rankEl)
        }
        // Empty fallback when the entry somehow has neither share.
        if (!paxLine && !cargoLine) {
            const dash = document.createElement("div")
            dash.textContent = "—"
            dash.style.cssText = "color:#6b7280;"
            right.append(dash)
        }
        wrap.append(right)

        return wrap
    }

    /**
     * Inline popover anchored to the Seats/wk ▾ caret. Lets the user pin
     * the class mix (Y/C/F percentages), service level, and per-class
     * yield + per-pax cost overrides for one route. Save → persists to
     * RouteAssistantServiceConfigStore; aggregator re-projects so the
     * Seats/wk + Mix + Svc columns refresh without a full reload.
     */
    _openServiceConfigPopover(row, anchorEl) {
        if (!row || !this.hubIata) return
        if (typeof RouteAssistantServiceConfigStore === "undefined") return
        this._closeServicePopover()

        const hubU    = String(this.hubIata).toUpperCase()
        const destU   = String(row.destIata).toUpperCase()
        const pairKey = hubU + "-" + destU
        const defaults = (this.settings && this.settings.serviceProfiles) || {}
        const eff = RouteAssistantServiceConfigStore.resolveEffective(row.serviceConfig, defaults)
        const recordFares = (row.serviceConfig && row.serviceConfig.classFares) || {}

        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:   "fixed",
            background: "#1f2937",
            color:      "#f3f4f6",
            border:     "1px solid #0ea5e9",
            borderRadius: "5px",
            boxShadow:  "0 8px 25px rgba(0,0,0,0.55)",
            padding:    "10px 12px",
            zIndex:     "10002",
            minWidth:   "320px",
            font:       "11px/1.5 sans-serif"
        })

        const title = document.createElement("strong")
        title.textContent = `Service · ${hubU} → ${destU}`
        title.style.cssText = "color:#7dd3fc;display:block;margin-bottom:4px;font-size:12px;"

        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;line-height:1.45;"
        sub.innerHTML = "Class mix percentages auto-renormalise to 100% on save. Empty per-class field = inherit defaults from Settings → Service profiles."

        // ---- Auto-detected source line (markets-page sync — when present)
        if (row.serviceProfileName || row.serviceProfileId
                || (row.classMixSource === "tail")
                || (row.ownPricing && Object.keys(row.ownPricing).length)) {
            const detected = []
            if (row.classMixSource === "tail") {
                detected.push("mix from assigned tail")
            }
            if (row.ownPricing) {
                const fares = []
                for (const cls of ["Y", "C", "F", "Cargo"]) {
                    if (row.ownPricing[cls] != null) fares.push(cls + " " + row.ownPricing[cls])
                }
                if (fares.length) detected.push("AS fares: " + fares.join(" / "))
            }
            if (row.serviceProfileName || row.serviceProfileId) {
                const cache = this.serviceProfilesCache || new Map()
                const detail = row.serviceProfileId ? cache.get(row.serviceProfileId) : null
                let txt = "AS profile: " + (row.serviceProfileName || ("#" + row.serviceProfileId))
                if (detail && detail.classScore) {
                    const cs = detail.classScore
                    txt += " (Y=" + (cs.Y != null ? cs.Y.toFixed(2) : "?")
                        + " · C=" + (cs.C != null ? cs.C.toFixed(2) : "?")
                        + " · F=" + (cs.F != null ? cs.F.toFixed(2) : "?") + ")"
                }
                detected.push(txt)
            }
            if (detected.length) {
                const auto = document.createElement("div")
                auto.style.cssText = "color:#86efac;font-size:10px;margin-bottom:8px;padding:4px 6px;"
                    + "background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.30);border-radius:3px;"
                auto.textContent = "Auto-detected · " + detected.join(" · ")
                pop.append(title, sub, auto)
            } else {
                pop.append(title, sub)
            }
        } else {
            pop.append(title, sub)
        }

        // ---- Class mix row
        const yMix = mkNumberInput(Math.round((eff.classMix.Y || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const cMix = mkNumberInput(Math.round((eff.classMix.C || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const fMix = mkNumberInput(Math.round((eff.classMix.F || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mixRow = document.createElement("div")
        mixRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;"
        const mixLbl = document.createElement("span")
        mixLbl.style.cssText = "color:#9ca3af;"
        mixLbl.textContent = "Mix %"
        const chipFor = (label, input, color) => {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:3px;align-items:center;color:" + color + ";"
            w.append(document.createTextNode(label), input)
            return w
        }
        const mixSum = document.createElement("span")
        mixSum.style.cssText = "color:#94a3b8;font-size:10px;"
        const updateMixSum = () => {
            const s = (parseFloatOr(yMix.value, 0) || 0)
                + (parseFloatOr(cMix.value, 0) || 0)
                + (parseFloatOr(fMix.value, 0) || 0)
            mixSum.textContent = "Σ " + Math.round(s) + "%"
            mixSum.style.color = Math.abs(s - 100) < 0.5 ? "#86efac" : "#fbbf24"
        }
        updateMixSum()
        for (const inp of [yMix, cMix, fMix]) inp.addEventListener("input", updateMixSum)
        mixRow.append(mixLbl,
            chipFor("Y", yMix, "#7dd3fc"),
            chipFor("C", cMix, "#fcd34d"),
            chipFor("F", fMix, "#fda4af"),
            mixSum)

        // ---- Service level
        const levels = defaults.serviceLevels || {}
        const svcSelOptions = []
        for (const k of RouteAssistantServiceConfigStore.SERVICE_LEVELS) {
            const lvl = levels[k] || {}
            svcSelOptions.push({
                value: k,
                label: (lvl.label || (k.charAt(0).toUpperCase() + k.slice(1)))
                    + "  ×" + (lvl.yieldMult != null ? Number(lvl.yieldMult).toFixed(2) : "?")
                    + "  +AS$" + (lvl.costPerPax != null ? Math.round(lvl.costPerPax) : "?") + "/pax"
            })
        }
        const svcSel = mkSelect(svcSelOptions)
        svcSel.value = eff.serviceLevel
        svcSel.style.fontSize = "11px"
        const svcRow = document.createElement("div")
        svcRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:8px;"
        const svcLbl = document.createElement("span")
        svcLbl.style.cssText = "color:#9ca3af;"
        svcLbl.textContent = "Service level:"
        svcRow.append(svcLbl, svcSel)

        // ---- Per-class fares table
        const fareTable = document.createElement("table")
        fareTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        fareTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Class</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield AS$/km</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
            <th style="text-align:left;padding:2px 4px;color:#6b7280;font-weight:normal;font-size:10px;">defaults</th>
        </tr></thead>`
        const fareBody = document.createElement("tbody")
        const fareInputs = {Y: {}, C: {}, F: {}}
        const classColors = {Y: "#7dd3fc", C: "#fcd34d", F: "#fda4af"}
        for (const cls of RouteAssistantServiceConfigStore.CLASSES) {
            const f = eff.classFares[cls]
            const recF = recordFares[cls] || {}
            const yldIn  = mkNumberInput(numOrNull(recF.yieldPerKm), {min: 0, max: 10,    step: 0.01, width: "75px"})
            const costIn = mkNumberInput(numOrNull(recF.costPerPax), {min: 0, max: 99999, step: 1,    width: "70px"})
            fareInputs[cls].yld  = yldIn
            fareInputs[cls].cost = costIn
            const tr = document.createElement("tr")
            const cell = (text, align, color, font) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:2px 4px;text-align:" + (align || "left") + ";color:" + (color || "#d1d5db") + ";"
                if (font) c.style.fontFamily = font
                c.textContent = text
                return c
            }
            tr.append(cell(cls, "left", classColors[cls], null))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(yldCell, costCell)
            const defNote = "y×" + (f.yieldMult || 1).toFixed(2)
                + " · AS$" + Math.round(f.costPerPax || 0)
            tr.append(cell(defNote, "left", "#6b7280", "monospace"))
            fareBody.append(tr)
        }
        fareTable.append(fareBody)

        // ---- Buttons
        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap;"
        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.style.fontSize = "10px"
        cancelBtn.style.padding = "2px 8px"
        cancelBtn.addEventListener("click", () => this._closeServicePopover())

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.style.fontSize = "10px"
        clearBtn.style.padding = "2px 8px"
        clearBtn.disabled = !row.serviceConfig
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            await RouteAssistantServiceConfigStore.remove(hubU, destU)
            row.serviceConfig = null
            this.serviceConfigMap.delete(pairKey)
            this._reapplyServiceProjection()
            this._renderRows()
            this._closeServicePopover()
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.style.padding = "2px 8px"
        saveBtn.addEventListener("click", async () => {
            const fields = {
                classMix: {
                    Y: parseFloatOr(yMix.value, 0) || 0,
                    C: parseFloatOr(cMix.value, 0) || 0,
                    F: parseFloatOr(fMix.value, 0) || 0
                },
                serviceLevel: svcSel.value,
                classFares: {
                    Y: {yieldPerKm: numOrNull(fareInputs.Y.yld.value), costPerPax: numOrNull(fareInputs.Y.cost.value)},
                    C: {yieldPerKm: numOrNull(fareInputs.C.yld.value), costPerPax: numOrNull(fareInputs.C.cost.value)},
                    F: {yieldPerKm: numOrNull(fareInputs.F.yld.value), costPerPax: numOrNull(fareInputs.F.cost.value)}
                }
            }
            const saved = await RouteAssistantServiceConfigStore.save(hubU, destU, fields)
            row.serviceConfig = saved
            if (saved) this.serviceConfigMap.set(pairKey, saved)
            else       this.serviceConfigMap.delete(pairKey)
            this._reapplyServiceProjection()
            this._renderRows()
            this._closeServicePopover()
        })
        btnRow.append(cancelBtn, clearBtn, saveBtn)

        // Title + sub + (optional auto-detected banner) were appended above
        // already; we just need the rest of the controls.
        pop.append(mixRow, svcRow, fareTable, btnRow)
        document.body.append(pop)
        this._servicePopover = pop

        const r = anchorEl.getBoundingClientRect()
        const popRect = pop.getBoundingClientRect()
        const vh = window.innerHeight, vw = window.innerWidth
        let top  = r.bottom + 6
        if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
        let left = r.right - popRect.width
        if (left < 8) left = 8
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
        pop.style.top  = top  + "px"
        pop.style.left = left + "px"
        yMix.focus(); yMix.select && yMix.select()

        const onMouseDown = (e) => {
            if (pop.contains(e.target)) return
            if (e.target === anchorEl) return
            this._closeServicePopover()
        }
        const onKey = (e) => { if (e.key === "Escape") this._closeServicePopover() }
        setTimeout(() => {
            document.addEventListener("mousedown", onMouseDown)
            document.addEventListener("keydown",   onKey)
        }, 0)
        this._servicePopoverCleanup = () => {
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("keydown",   onKey)
        }
    }

    _closeServicePopover() {
        if (this._servicePopoverCleanup) {
            try { this._servicePopoverCleanup() } catch (e) { /* noop */ }
            this._servicePopoverCleanup = null
        }
        if (this._servicePopover && this._servicePopover.parentNode) {
            this._servicePopover.parentNode.removeChild(this._servicePopover)
        }
        this._servicePopover = null
    }

    /**
     * Re-project service config across all rows after a save/clear without
     * a full refresh. Cheap: aggregator's projector reads each row's
     * existing estimator output + the now-updated map.
     */
    _reapplyServiceProjection() {
        if (!this.rows || !this.rows.length) return
        const def = (this.settings && this.settings.serviceProfiles) || null
        RouteAssistantAggregator.applyServiceProjection(this.rows, def, this.serviceConfigMap, this.hubIata, this.fleet)
    }

    /**
     * Open a modal letting the user pin paxLF / cargoLF / yieldPerKm /
     * cargoYieldPerKgKm / a free-text note for this route. Saves to
     * RouteAssistantRouteOverridesStore and updates the in-memory row +
     * profit estimate in place — no full refresh required.
     */
    _openOverrideEditor(row) {
        if (!row || !this.hubIata) return
        if (this._overrideEditor && this._overrideEditor.parentNode) {
            this._overrideEditor.parentNode.removeChild(this._overrideEditor)
        }

        // Always uppercase before keying — buildRouteRows uppercases both ends
        // when hydrating row.override, so this match must be consistent.
        const hubU  = String(this.hubIata).toUpperCase()
        const destU = String(row.destIata).toUpperCase()
        const pairKey = hubU + "-" + destU
        const existing = row.override || {}
        const overlay = document.createElement("div")
        Object.assign(overlay.style, {
            position: "fixed", inset: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center"
        })
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._overrideEditor = null
        }
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        Object.assign(card.style, {
            background: "#1f2937", color: "#f3f4f6",
            border: "1px solid #4c1d95", borderRadius: "6px",
            padding: "16px 18px", minWidth: "360px", maxWidth: "440px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
            font: "12px/1.5 sans-serif"
        })
        const title = document.createElement("strong")
        title.textContent = `Override · ${this.hubIata} → ${row.destIata}`
        title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:13px;"
        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
        sub.textContent = "Pin route-specific values. Empty = use demand-driven LF curve / configured base yield."

        const paxLfInput   = mkNumberInput(numOrNull(existing.paxLF),             {min: 0, max: 1,   step: 0.05,   width: "70px"})
        const cargoLfInput = mkNumberInput(numOrNull(existing.cargoLF),           {min: 0, max: 1,   step: 0.05,   width: "70px"})
        const yldInput     = mkNumberInput(numOrNull(existing.yieldPerKm),        {min: 0, max: 10,  step: 0.01,   width: "70px"})
        const cyldInput    = mkNumberInput(numOrNull(existing.cargoYieldPerKgKm), {min: 0, max: 1,   step: 0.0001, width: "85px"})
        const noteInput    = document.createElement("input")
        noteInput.type = "text"
        noteInput.maxLength = 200
        noteInput.placeholder = "e.g. measured 88% LF Q3"
        noteInput.value = existing.note || ""
        noteInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:2px 6px;font-size:11px;width:100%;box-sizing:border-box;"

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:12px;"
        const addRow = (label, input, hint) => {
            const lab = document.createElement("label")
            lab.textContent = label
            lab.style.cssText = "color:#9ca3af;font-size:11px;"
            lab.title = hint || ""
            const wrap = document.createElement("div")
            wrap.append(input)
            if (hint) {
                const h = document.createElement("span")
                h.textContent = " " + hint
                h.style.cssText = "color:#6b7280;font-size:10px;"
                wrap.append(h)
            }
            grid.append(lab, wrap)
        }
        addRow("Pax LF",            paxLfInput,   "0–1, e.g. 0.85")
        addRow("Cargo LF",          cargoLfInput, "0–1, e.g. 0.70")
        addRow("Yield AS$/pax-km",  yldInput,     "Beats base yield for this route only")
        addRow("Cargo AS$/kg-km",   cyldInput,    "Beats base cargo yield for this route only")
        addRow("Note",              noteInput,    "")

        const status = document.createElement("div")
        status.style.cssText = "color:#6b7280;font-size:10px;margin-bottom:10px;"
        status.textContent = existing && existing.updatedAt
            ? "Last updated " + new Date(existing.updatedAt).toLocaleString()
            : "No override saved yet."

        const buttonRow = document.createElement("div")
        buttonRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;"

        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.addEventListener("click", close)

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear override"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.disabled = !row.override
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            await RouteAssistantRouteOverridesStore.remove(hubU, destU)
            row.override = null
            this.overrideMap.delete(pairKey)
            this._recomputeProfit()
            close()
        })

        const calibBtn = document.createElement("button")
        Object.assign(calibBtn.style, smallBtnStyle())
        calibBtn.style.background = "#7c3aed"
        const calibTarget = derivedYieldFromActuals(row)
        const calibSide = calibTarget && calibTarget.side
        calibBtn.disabled = !calibTarget
        calibBtn.textContent = calibSide === "cargo"
            ? "Calibrate cargo from actuals"
            : "Calibrate from actuals"
        if (!calibTarget) {
            calibBtn.style.opacity = "0.5"
            calibBtn.title = "Take a snapshot first — derives the base yield needed to reproduce the actuals at the current LF / aircraft."
        } else {
            const fieldLabel = calibSide === "cargo" ? "Cargo AS$/kg-km" : "Yield AS$/pax-km"
            const altNote = calibTarget.alt
                ? "\nThe other side (" + (calibTarget.alt.side === "cargo" ? "cargo" : "pax")
                  + ") would calibrate to " + calibTarget.alt.value.toFixed(4)
                  + " — paste manually if you'd rather pin that side."
                : ""
            calibBtn.title = "Pre-fills " + fieldLabel + " with " + calibTarget.value.toFixed(4)
                + " — the value that would make the estimator match the latest snapshot "
                + "at the current LF / spec.\nReview and Save to pin it as a route override."
                + altNote
        }
        calibBtn.addEventListener("click", () => {
            const v = derivedYieldFromActuals(row)
            if (!v) return
            const targetInput = v.side === "cargo" ? cyldInput : yldInput
            targetInput.value = v.value.toFixed(4)
            targetInput.focus()
            targetInput.select()
            const sideLabel = v.side === "cargo" ? "cargo yield" : "yield"
            const altLabel = v.alt
                ? "  (" + (v.alt.side === "cargo" ? "cargo" : "pax")
                  + " alt: " + v.alt.value.toFixed(4) + ")"
                : ""
            sub.textContent = "Pre-filled " + sideLabel + " from snapshot — edit if you want, then Save."
                + altLabel
            sub.style.color = "#a78bfa"
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.addEventListener("click", async () => {
            const fields = {
                paxLF:             numOrNull(paxLfInput.value),
                cargoLF:           numOrNull(cargoLfInput.value),
                yieldPerKm:        numOrNull(yldInput.value),
                cargoYieldPerKgKm: numOrNull(cyldInput.value),
                note:              noteInput.value
            }
            const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
            row.override = saved
            if (saved) this.overrideMap.set(pairKey, saved)
            else this.overrideMap.delete(pairKey)
            this._recomputeProfit()
            close()
        })

        buttonRow.append(cancelBtn, calibBtn, clearBtn, saveBtn)
        card.append(title, sub, grid, status, buttonRow)
        overlay.append(card)
        document.body.append(overlay)
        this._overrideEditor = overlay
        paxLfInput.focus()
    }

    /**
     * Apply a weight preset: each variable listed in preset.weights gets that
     * weight (and is enabled if weight > 0); variables not in the preset get
     * disabled with weight 0. Re-renders settings + table so the user sees
     * the new state immediately.
     */
    async _applyWeightPreset(preset) {
        for (const f of RouteAssistantPanel.SCORING_FIELDS) {
            const cfg = this.settings.scoring[f.field] = Object.assign(
                {enabled: false, weight: 1, direction: f.direction, min: null, max: null},
                this.settings.scoring[f.field] || {}
            )
            if (preset.weights && preset.weights[f.field] !== undefined) {
                cfg.weight  = preset.weights[f.field]
                cfg.enabled = preset.weights[f.field] > 0
            } else {
                cfg.weight  = 0
                cfg.enabled = false
            }
        }
        await RouteAssistantSettings.save({scoring: this.settings.scoring})
        this._render()
        this._renderSettings()
    }
}

// ---------- Static config ----------

// Visual groups for the results table. Each column references one of these
// keys; the table renders a sub-header row with grouped labels and tints
// each cell to match. The intent is that a glance at a row's colour tells
// you whether you're looking at AirlineSim's in-game numbers or
// flightsfrom.com's real-world signal.
RouteAssistantPanel.COLUMN_GROUPS = {
    computed: {label: "",            tint: null,                          headerTint: null},
    as:       {label: "AS in-game",  tint: "rgba(96, 165, 250, 0.10)",    headerTint: "rgba(96, 165, 250, 0.22)"},
    real:     {label: "Real-world",  tint: "rgba(251, 191, 36, 0.10)",    headerTint: "rgba(251, 191, 36, 0.22)"},
    competition: {label: "Competition", tint: "rgba(132, 204, 22, 0.10)", headerTint: "rgba(132, 204, 22, 0.24)"},
    aircraft: {label: "Aircraft",    tint: "rgba(34, 197, 94, 0.10)",     headerTint: "rgba(34, 197, 94, 0.22)"},
    pricing:  {label: "Live route data", tint: "rgba(244, 63, 94, 0.10)", headerTint: "rgba(244, 63, 94, 0.22)"},
    actuals:  {label: "Actuals",     tint: "rgba(168, 85, 247, 0.10)",    headerTint: "rgba(168, 85, 247, 0.24)"},
    service:  {label: "Service",     tint: "rgba(56, 189, 248, 0.10)",    headerTint: "rgba(56, 189, 248, 0.24)"},
    markets:  {label: "Market Analysis", tint: "rgba(20, 184, 166, 0.10)", headerTint: "rgba(20, 184, 166, 0.24)"},
    ors:      {label: "ORS Rank",         tint: "rgba(245, 158, 11, 0.10)", headerTint: "rgba(245, 158, 11, 0.24)"}
}

RouteAssistantPanel.STATUS_DEF = {
    NEW:   {color: "#60a5fa", description: "You don't fly this route at all. Candidate to start."},
    OK:    {color: "#22c55e", description: "Your frequency is in line with real-world demand. No action needed."},
    UNDER: {color: "#fbbf24", description: "High pax demand (≥ 8/10) and you fly < 1/10 of real-world traffic. Room to scale up."},
    OVER:  {color: "#f97316", description: "You fly more than 1/5 of real-world traffic. Possibly over-deployed; consider trimming frequency."},
    OOR:   {color: "#ef4444", description: "Out of range — the selected aircraft can't reach this destination (over 95% of max range)."}
}

// `modes` gates which view tabs include the field in the score blend.
// "all" keeps every field active (preserves pre-tabbed behaviour);
// "pax"/"cargo" filter to fields relevant to that view. Frequency,
// competition, profit, fleet-fit, and actuals are mode-agnostic.
RouteAssistantPanel.SCORING_FIELDS = [
    {field: "paxScore",            label: "Pax demand",     group: "as",       direction: "higher",
     modes: ["all", "pax"],
     suggestedValues: [0,1,2,3,4,5,6,7,8,9,10]},
    {field: "cargoScore",          label: "Cargo demand",   group: "as",       direction: "higher",
     modes: ["all", "cargo"],
     suggestedValues: [0,1,2,3,4,5,6,7,8,9,10]},
    {field: "weeklyFlights",       label: "FF/week",        group: "real",     direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [5,10,25,50,75,100,150,200,300]},
    {field: "airlineCount",        label: "Competition",    group: "real",     direction: "lower",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [1,2,3,4,5,7,10]},
    {field: "profitPerWeek",       label: "AS$/week",       group: "aircraft", direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [10000, 50000, 100000, 250000, 500000, 1000000]},
    {field: "fitOk",               label: "Fleet-fit",      group: "aircraft", direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [0, 1]},
    {field: "actualProfitPerWeek", label: "Actual $/week",  group: "actuals",  direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [10000, 50000, 100000, 250000, 500000, 1000000]},
    // Letter K — derived demand-depth fields. Pool sizes are
    // higher-is-better; elasticity slopes are negative numbers
    // (price up → quantity down) where less-negative = less
    // price-sensitive market = better. RM tightness 0–1 (sold/total).
    {field: "paxDemandPool",   label: "Pax pool",     group: "demand", direction: "higher",
     modes: ["all", "pax"],
     suggestedValues: [100, 500, 1000, 5000, 10000]},
    {field: "cargoDemandPool", label: "Cargo pool",   group: "demand", direction: "higher",
     modes: ["all", "cargo"],
     suggestedValues: [1000, 5000, 25000, 100000]},
    {field: "paxElasticity",   label: "Pax elast.",   group: "demand", direction: "higher",
     modes: ["all", "pax"],
     suggestedValues: [-2.0, -1.5, -1.0, -0.5, -0.25]},
    {field: "cargoElasticity", label: "Cargo elast.", group: "demand", direction: "higher",
     modes: ["all", "cargo"],
     suggestedValues: [-2.0, -1.5, -1.0, -0.5]},
    {field: "rmTightness",     label: "Inv. tight.",  group: "demand", direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [0.5, 0.7, 0.85, 0.95]}
]

// Quick-apply sets of weights. Click one and every variable's weight
// jumps to the listed value (variables not listed go to 0 = ignored).
RouteAssistantPanel.WEIGHT_PRESETS = [
    {name: "Balanced",
     description: "Equal weight on every signal",
     weights: {paxScore: 1, cargoScore: 1, weeklyFlights: 1, airlineCount: 1}},
    {name: "Chase demand",
     description: "Heavy real-world traffic, light competition penalty",
     weights: {paxScore: 2, cargoScore: 1, weeklyFlights: 3, airlineCount: 0.5}},
    {name: "Avoid competition",
     description: "Strong penalty on crowded routes",
     weights: {paxScore: 1, cargoScore: 1, weeklyFlights: 1, airlineCount: 3}},
    {name: "Cargo focus",
     description: "Cargo demand triple-counted",
     weights: {paxScore: 0.5, cargoScore: 3, weeklyFlights: 1, airlineCount: 1}}
]

RouteAssistantPanel.COLUMNS = [
    {field: "score", label: "Sc", group: "computed", align: "right", defaultDir: -1,
     title: "Score (0–100) = Σ(weightᵢ × normᵢ) / Σweightᵢ × 100\n  normᵢ = (xᵢ − min) / (max − min)            for higher = better\n  normᵢ = (max − xᵢ) / (max − min)            for lower = better\nmin/max are computed across the visible rows. Disable a variable in Settings to drop it from the average.",
     render(td, row) {
        if (row.score === null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const hue = Math.round((Math.max(0, Math.min(100, row.score)) / 100) * 120)
        td.style.background = `hsl(${hue}, 70%, 35%)`
        td.style.color = "#fff"
        td.style.fontWeight = "bold"
        td.textContent = row.score
        _appendDiffBadge(td, "score", row)
    }},
    {field: "destIata", label: "Dest", group: "computed",
     title: "Click IATA → market analysis (per-route ORS, competitors). Small icons jump to scheduling / inventory / airport info. Right-click any row to override LF / yield. Click the ☆ to star a route — starred routes float to the top and light a red dot when their numbers worsen since your last visit.",
     render(td, row) {
        const hub  = RouteAssistantPanel._currentHubIata || ""
        const dest = row.destIata
        const pin = row.override
            ? ` <span title="${escapeHtml(formatOverrideSummary(row.override))}" style="color:#a78bfa;font-size:11px;cursor:help;">📌</span>`
            : ""
        const iataHtml = hub
            ? `<a href="/app/com/markets/${encodeURIComponent(hub)}${encodeURIComponent(dest)}" target="_blank" rel="noopener" class="aes-iata"`
                + ` title="Market analysis (ORS rank, competitors) for ${escapeHtml(hub)}→${escapeHtml(dest)}">${escapeHtml(dest)}</a>`
            : `<strong>${escapeHtml(dest)}</strong>`
        const icons = []
        if (hub) {
            icons.push(`<a href="/app/com/scheduling/${encodeURIComponent(hub)}${encodeURIComponent(dest)}"`
                + ` target="_blank" rel="noopener" title="Scheduling page for ${escapeHtml(hub)}→${escapeHtml(dest)}">📅</a>`)
            icons.push(`<a href="/app/com/inventory/${encodeURIComponent(hub)}${encodeURIComponent(dest)}"`
                + ` target="_blank" rel="noopener" title="Inventory + fares for ${escapeHtml(hub)}→${escapeHtml(dest)}">📦</a>`)
        }
        if (row.airportId) {
            icons.push(`<a href="/app/info/airports/${encodeURIComponent(row.airportId)}"`
                + ` target="_blank" rel="noopener" title="${escapeHtml(dest)} airport info">🛫</a>`)
        }
        // Route-note 📝 — always rendered so the affordance is discoverable
        // even on routes without a saved note. Subdued grey when empty,
        // full color when present. Click opens the popover via the
        // delegated row click handler ([data-routenote-trigger='1']).
        const noteText = (row.routeNoteText && typeof row.routeNoteText === "string")
            ? row.routeNoteText.trim() : ""
        const notePreview = noteText.length > 80 ? noteText.slice(0, 80) + "…" : noteText
        const noteTitle = noteText
            ? "Edit note: " + notePreview
            : "Add note for " + (hub || "?") + "→" + dest
        const noteOpacity = noteText ? "1" : "0.45"
        icons.push(`<span data-routenote-trigger="1"`
            + ` title="${escapeHtml(noteTitle)}"`
            + ` style="cursor:pointer;opacity:${noteOpacity};">📝</span>`)
        const iconRow = icons.length ? `<span class="aes-iata-icons">${icons.join("")}</span>` : ""
        td.innerHTML = iataHtml + pin + iconRow
            + (row.destName ? `<br><span style="color:#9ca3af;font-size:10px;">${escapeHtml(row.destName)}</span>` : "")
        // Cell-wide tooltip surfaces the full note text when present, so
        // hovering anywhere in the cell reveals it without the popover.
        if (noteText) td.title = "Note: " + noteText
        // Watchlist star — prepend so it reads as "[★] DEST 📌 📅 📦 🛫 📝".
        // Built as a real DOM button so the click handler can stop the
        // default <a> activation; rendering the inner content first via
        // innerHTML keeps the rest of the cell unchanged.
        td.prepend(_buildWatchlistStar(row, hub))
    }},
    {field: "status", label: "St", group: "computed",
     title: "Status flag — hover a cell for the rule; click to sort. A VAR+/VAR− pill is appended when the latest snapshot's Δ% exceeds the variance warn threshold.",
     render(td, row) {
        const def = RouteAssistantPanel.STATUS_DEF[row.status] || {color: "#9ca3af", description: ""}
        td.textContent = ""
        const main = document.createElement("span")
        main.textContent = row.status
        main.style.color = def.color
        main.style.fontWeight = "bold"
        td.append(main)
        const v = row.actualVariancePct
        const warn = RouteAssistantPanel._varianceWarnPct || 25
        if (typeof v === "number" && Math.abs(v) >= warn) {
            const pill = document.createElement("span")
            const sign = v > 0 ? "+" : "−"
            pill.textContent = "V" + sign
            pill.style.cssText = "display:inline-block;margin-left:3px;padding:0 3px;"
                + "border-radius:3px;font-size:9px;font-weight:600;"
                + "background:" + (v > 0 ? "rgba(34,197,94,0.20)" : "rgba(239,68,68,0.20)") + ";"
                + "color:" + (v > 0 ? "#86efac" : "#fca5a5") + ";"
                + "border:1px solid " + (v > 0 ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)") + ";"
            pill.title = "Δ% = " + (v > 0 ? "+" : "") + v + "%"
                + (v > 0 ? " — actual exceeds estimate" : " — actual below estimate")
                + " (warn at ±" + warn + "%; tune in Settings → Yield feedback)"
            td.append(pill)
        }
        if (def.description) td.title = `${row.status}: ${def.description}`
    }},
    {field: "paxScore", label: "Pax", group: "as", align: "right",
     title: "AS in-game pax demand for the destination (0–10) — from /action/info/country",
     render(td, row) {
        td.textContent = row.paxScore === null ? "—" : row.paxScore
        if (row.paxScore !== null) _appendDiffBadge(td, "paxScore", row)
    }},
    {field: "cargoScore", label: "Crg", group: "as", align: "right",
     title: "AS in-game cargo demand for the destination (0–10) — from /action/info/country",
     render(td, row) {
        td.textContent = row.cargoScore === null ? "—" : row.cargoScore
        if (row.cargoScore !== null) _appendDiffBadge(td, "cargoScore", row)
    }},
    {field: "ownTotalFreq", label: "Own", group: "as", align: "right",
     title: "Your weekly frequency on this route — from your last extracted AS schedule",
     render(td, row) {
        td.textContent = row.ownTotalFreq || 0
    }},
    {field: "distanceKm", label: "km", group: "real", align: "right",
     title: "Real-world great-circle distance",
     render(td, row) {
        td.textContent = row.distanceKm === null ? "—" : row.distanceKm.toLocaleString()
        td.style.color = "#9ca3af"
    }},
    {field: "weeklyFlights", label: "FF/w", group: "real", align: "right",
     title: "Real-world weekly flights on this route — from flightsfrom.com",
     render(td, row) {
        td.textContent = row.weeklyFlights === null ? "—" : row.weeklyFlights
        if (row.weeklyFlights !== null) _appendDiffBadge(td, "weeklyFlights", row)
    }},
    {field: "airlineCount", label: "Cmp", group: "real", align: "right",
     title: "Distinct competitors on this route. Source priority: "
        + "AS market-share (pax + cargo deduped, excluding you) when the Markets page is synced, "
        + "else flightsfrom.com (real-world airlines). "
        + "Hover for the carrier list; click to pin.",
     render(td, row) {
        const merged = Array.isArray(row.competitorEntries) ? row.competitorEntries : null
        const asCount = (typeof row.competitorCount === "number" && row.competitorCount >= 0)
            ? row.competitorCount
            : (merged ? merged.length : null)
        const display = (asCount != null) ? asCount : row.airlineCount

        if (display === null || display === undefined) {
            td.textContent = "—"
            return
        }
        const showPill = RouteAssistantPanel._showCarrierIntensity !== false
        const intensity = row.competitiveIntensity
            || RouteAssistantCarriersScraper.intensity(display)

        const pill = document.createElement("span")
        pill.textContent = String(display)
        if (showPill && intensity) {
            pill.style.display      = "inline-block"
            pill.style.minWidth     = "1.6em"
            pill.style.padding      = "1px 6px"
            pill.style.borderRadius = "10px"
            pill.style.background   = RouteAssistantCarriersScraper.intensityColor(intensity)
            pill.style.color        = "#0f172a"
            pill.style.fontWeight   = "600"
            pill.style.fontSize     = "10px"
            pill.style.textAlign    = "center"
            pill.style.cursor       = "pointer"
            if (asCount != null) pill.style.boxShadow = "inset 0 0 0 1px rgba(15,23,42,0.4)"
        }
        td.append(pill)
        // Diff badge — prefer competitorCount (AS-side count) when set,
        // else fall back to airlineCount so the badge tracks whichever
        // source the cell rendered.
        _appendDiffBadge(td,
            asCount != null ? ["competitorCount", "airlineCount"] : ["airlineCount", "competitorCount"],
            row)

        // ALWAYS wire the rich popover. _openCarrierPopover gracefully
        // handles every empty-data case (AS leaderboard → flight-prefix
        // backfill → flightsfrom carriers → "no data, here's how to fetch"
        // message). Previously we fell back to a native title="" tooltip
        // when AS data was missing — which produced an empty/unhelpful
        // tooltip on most rows and felt like the hover was broken. The
        // rich popover always shows SOMETHING actionable now.
        let openTimer = null
        const open = (pinned) => {
            if (openTimer) { clearTimeout(openTimer); openTimer = null }
            const inst = RouteAssistantPanel._currentInstance
            if (!inst) return
            inst._openCarrierPopover(row, pill, {pinned: !!pinned})
        }
        pill.addEventListener("mouseenter", () => {
            if (openTimer) clearTimeout(openTimer)
            openTimer = setTimeout(() => open(false), 200)
        })
        pill.addEventListener("mouseleave", () => {
            if (openTimer) { clearTimeout(openTimer); openTimer = null }
        })
        pill.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            open(true)
        })
    }},

    // ----- Competition (in-game) — its own little detached group sitting
    // next to the Real-World Cmp pill. Mkt% surfaces YOUR pax share of the
    // route; clicking/hovering opens the SAME rich popover the Real-World
    // Cmp pill does, so all in-game competition intel — your share AND the
    // full leaderboard — is one hover away from this column too.
    {field: "ourPaxShare", label: "Mkt%", group: "competition", align: "right", defaultDir: -1,
     title: "Your pax market share on this route — from /app/com/markets/<HUB><DEST>'s Market Shares section. Hover ANY row (even '—') to see who's on the route. Color rail: ≥40% green, 20–40% amber, <20% red.",
     render(td, row) {
        // Always wire the rich popover. The popover handles empty-data
        // cases gracefully (AS leaderboard → flight-prefix backfill →
        // flightsfrom carriers → "no data, here's how to fetch" message).
        // No more silent-no-op hovers.
        const cell = document.createElement("span")
        const v = row.ourPaxShare
        if (v != null) {
            cell.textContent = v.toFixed(1) + "%"
            cell.style.fontWeight = "bold"
            if      (v >= 40) cell.style.color = "#86efac"
            else if (v >= 20) cell.style.color = "#fde68a"
            else              cell.style.color = "#fca5a5"
        } else {
            cell.textContent = "—"
            cell.style.color = "#6b7280"
        }
        cell.style.cursor = "pointer"
        td.append(cell)
        if (v != null) _appendDiffBadge(td, "ourPaxShare", row)

        let openTimer = null
        const open = (pinned) => {
            if (openTimer) { clearTimeout(openTimer); openTimer = null }
            const inst = RouteAssistantPanel._currentInstance
            if (!inst) return
            inst._openCarrierPopover(row, cell, {pinned: !!pinned})
        }
        cell.addEventListener("mouseenter", () => {
            if (openTimer) clearTimeout(openTimer)
            openTimer = setTimeout(() => open(false), 200)
        })
        cell.addEventListener("mouseleave", () => {
            if (openTimer) { clearTimeout(openTimer); openTimer = null }
        })
        cell.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            open(true)
        })
    }},

    {field: "aircraftFit", label: "Fit", group: "aircraft",
     title: "Fit class — depends on distance vs range:\n  Optimal: distance ≤ range × (1 − falloffPct/100)         e.g. ≤ 90% of range at default falloff = 10%\n  Fall-off: optimalLimit < distance ≤ range × 0.95             revenue × falloffYieldMultiplier (default 0.85)\n  OOR:      distance > range × 0.95                                  cannot operate the route safely",
     render(td, row) {
        if (!row.aircraftFit) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const map = {optimal: ["✓", "#22c55e"], falloff: ["⚠", "#fbbf24"], oor: ["✗", "#ef4444"]}
        const [glyph, color] = map[row.aircraftFit] || ["?", "#9ca3af"]
        td.textContent = glyph + " " + row.aircraftFit
        td.style.color = color
        td.style.fontWeight = "bold"
        if (row.aircraftTypeName) td.title = "Picked: " + row.aircraftTypeName
    }},
    {field: "blockHours", label: "Hrs", group: "aircraft", align: "right",
     title: "Block hours (round-trip) = 2 × distance / cruiseSpeed + 0.5 h\n  0.5 h is fixed taxi/approach overhead per round trip.\nFeeds the cost side of $/flt: fuel/crew/maint × blockHours.",
     render(td, row) {
        td.textContent = row.blockHours === null ? "—" : row.blockHours.toFixed(1)
        td.style.color = "#9ca3af"
    }},
    {field: "profitPerFlight", label: "$/flt", group: "aircraft", align: "right",
     title: "$/flt = revenue − cost  (per round-trip flight, AS$)\n  revenue = paxRevenue + cargoRevenue\n    paxRevenue   = seats × paxLF × yieldPerKm × distance × 2 × falloffMult\n    cargoRevenue = cargoKg × cargoLF × cargoYieldPerKgKm × distance × 2 × falloffMult\n  cost = (fuel + crew + maint) × blockHours + otherFixedPerFlight\nHover any data cell for the per-row breakdown. Click the ▾ to quick-edit yield / LF for this route.",
     render(td, row) {
        if (row.isCargoOnly) { td.textContent = "—"; td.style.color = "#9ca3af"; td.title = "Cargo aircraft — pax revenue estimate not applicable in v1."; return }
        if (row.profitPerFlight === null) { td.textContent = "—"; td.style.color = "#9ca3af"; return }
        const value = document.createElement("span")
        value.textContent = formatProfit(row.profitPerFlight)
        value.style.color = row.profitPerFlight >= 0 ? "#a3e635" : "#fca5a5"
        value.title = formatProfitBreakdown(row)
        const caret = document.createElement("span")
        caret.textContent = " ▾"
        caret.dataset.profitTrigger = "1"
        caret.title = "Quick-edit yield / LF for this route"
            + (row.override ? " (override active — click to adjust)" : "")
        caret.style.cssText = "cursor:pointer;font-size:10px;padding:0 2px;color:"
            + (row.override ? "#a78bfa" : "#94a3b8") + ";"
        td.append(value, caret)
    }},
    {field: "profitPerWeek", label: "$/wk", group: "aircraft", align: "right",
     title: "$/wk = $/flt × weekly frequency\nUses your own weekly flights from the latest schedule extract. Shows '—' when you don't fly the route yet (no frequency to multiply by).",
     render(td, row) {
        if (row.isCargoOnly) { td.textContent = "—"; td.style.color = "#9ca3af"; return }
        if (row.profitPerWeek === null) { td.textContent = "—"; td.style.color = "#9ca3af"; td.title = "You don't fly this route yet — start scheduling and weekly profit will populate."; return }
        td.textContent = formatProfit(row.profitPerWeek)
        td.style.color = row.profitPerWeek >= 0 ? "#a3e635" : "#fca5a5"
        td.style.fontWeight = "bold"
        td.title = formatProfitBreakdown(row)
    }},
    {field: "liveAircraftType", label: "Eq", group: "pricing",
     title: "Aircraft assigned to this route — captured from /app/com/scheduling/<HUB><DEST>. Type name links to the *individual tail's* flight-history page (visiting it captures the profit data the snapshot consumes). 📋 icon links to the generic spec page.",
     render(td, row) {
        if (!row.liveAircraftType) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const reg = row.liveAircraftReg
        const baseTitle = (reg ? reg + " — " : "")
            + row.liveAircraftType
            + (row.liveCruiseSpeed ? " · cruise " + row.liveCruiseSpeed + " km/h" : "")
        td.style.color = "#fda4af"
        const typeName = escapeHtml(row.liveAircraftType)
        // Primary link points at the individual tail. Falls back to the
        // generic spec page when the registration isn't in the cached fleet
        // (older record before the fleet refresh, or competitor data).
        let mainHtml
        if (row.liveAircraftId) {
            mainHtml = `<a href="/app/fleets/aircraft/${encodeURIComponent(row.liveAircraftId)}/1"`
                + ` target="_blank" rel="noopener" class="aes-aircraft-link"`
                + ` title="${escapeHtml(baseTitle)}\nClick: tail flight-history page (writes the profit record snapshots read)">${typeName}</a>`
        } else if (row.liveAircraftTypeId) {
            mainHtml = `<a href="/action/enterprise/aircraftsType?id=${encodeURIComponent(row.liveAircraftTypeId)}"`
                + ` target="_blank" rel="noopener" class="aes-aircraft-link"`
                + ` title="${escapeHtml(baseTitle)}\nFleet record for this tail not cached — falling back to the generic type spec page.">${typeName}</a>`
        } else {
            mainHtml = typeName
        }
        // 📋 icon → generic type spec page. Always shown when typeId is
        // known so the user can compare specs without leaving the tail page.
        const specIconHtml = row.liveAircraftTypeId
            ? ` <a href="/action/enterprise/aircraftsType?id=${encodeURIComponent(row.liveAircraftTypeId)}"`
                + ` target="_blank" rel="noopener"`
                + ` style="color:#fda4af;text-decoration:none;font-size:10px;opacity:0.6;"`
                + ` title="${escapeHtml(row.liveAircraftType)} — generic spec page">📋</a>`
            : ""
        td.innerHTML = mainHtml + specIconHtml
    }},
    {field: "liveDeparture", label: "Dep", group: "pricing", align: "right",
     title: "Departure time (HT) — captured from the live scheduling page.",
     render(td, row) {
        if (!row.liveDeparture) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = row.liveDeparture
        td.style.color = "#fda4af"
        td.style.fontFamily = "monospace"
    }},
    {field: "liveWeeklyFlights", label: "Wk", group: "pricing", align: "right", defaultDir: -1,
     title: "Total weekly departures + per-day pattern. Each digit is flights that day (Mon→Sun); '·' = not flown. Captures multi-daily — '2222211' = 2x Mon–Fri, 1x weekends, 12/wk.",
     render(td, row) {
        if (!row.liveWeeklyFlights) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const daily = Array.isArray(row.liveDailyFlights) ? row.liveDailyFlights : null
        const total = document.createElement("strong")
        total.textContent = String(row.liveWeeklyFlights)
        td.append(total)
        if (daily) {
            const pat = document.createElement("span")
            pat.textContent = " " + daily.map(n => n > 0 ? String(n) : "·").join("")
            pat.style.cssText = "font-family:monospace;color:rgba(253,164,175,0.7);font-size:10px;"
            td.append(pat)
        }
        td.style.color = "#fda4af"
        td.title = (daily
            ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                .map((d, i) => d + " " + (daily[i] || 0)).join(", ")
            : "Legacy record — click Sync route data for per-day breakdown")
            + " — " + row.liveWeeklyFlights + "/week"
            + (row.liveScrapedAt ? "\nLast scraped: " + new Date(row.liveScrapedAt).toLocaleString() : "")
    }},
    {field: "actualProfitPerFlight", label: "Act $/flt", group: "actuals", align: "right", defaultDir: -1,
     title: "Act $/flt = Σtail (tail.$/flt × tail.weeklyFlightsOnRoute) / Σtail tail.weeklyFlightsOnRoute\n  tail.$/flt = aircraftFlights.profit / aircraftFlights.profitFlights  (lifetime average)\n  tail.weeklyFlightsOnRoute is summed from the live-route-data scrape (each flight number × its days/wk)\nAttribution mode (frequency / distance / equal) selectable in Settings → Yield feedback.\nHover for tail mix + sparkline.",
     render(td, row) {
        if (row.actualProfitPerFlight === null || row.actualProfitPerFlight === undefined) {
            td.textContent = "—"; td.style.color = "#6b7280"
            td.title = "Take a snapshot to populate. Requires Live-route-data sync + a recent visit to each tail's flight-history page."
            return
        }
        td.textContent = formatProfit(row.actualProfitPerFlight)
        td.style.color = row.actualProfitPerFlight >= 0 ? "#d8b4fe" : "#fca5a5"
        td.style.fontWeight = "bold"
        td.title = formatActualsBreakdown(row)
    }},
    {field: "actualVariancePct", label: "Δ%", group: "actuals", align: "right",
     title: "Δ% = (Act $/flt − $/flt) / |$/flt| × 100\n  Positive → outperforming the estimator (yield is higher than predicted).\n  Negative → underperforming (lower than predicted).\nHighlighted green/red when |Δ%| ≥ variance warning threshold (default 25%, configurable in Settings → Yield feedback).",
     render(td, row) {
        if (row.actualVariancePct === null || row.actualVariancePct === undefined) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        const v = row.actualVariancePct
        td.textContent = (v > 0 ? "+" : "") + v + "%"
        const warn = RouteAssistantPanel._varianceWarnPct || 25
        if (Math.abs(v) >= warn)      td.style.color = v > 0 ? "#86efac" : "#fca5a5"
        else                          td.style.color = "#d8b4fe"
        td.style.fontWeight = "bold"
        td.title = formatActualsBreakdown(row)
    }},

    // ----- Service profile (per-route Y/C/F mix + service level) -----
    {field: "weeklySeatsTotal", label: "Seats/wk", group: "service", align: "right", defaultDir: -1,
     title: "Seats offered per week = seatsPerFlight × your weekly frequency (departures only).\n  seatsPerFlight is split across Y/C/F by the per-route class mix; each class is allocated by largest-remainder so the totals stay exact.\nHover for the per-class breakdown + revenue/cost. Click ▾ to edit class mix, service level, and per-class fares.",
     render(td, row) {
        if (!row.weeklySeatsTotal) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const value = document.createElement("span")
        value.textContent = Number(row.weeklySeatsTotal).toLocaleString()
        value.style.color = "#7dd3fc"
        value.title = formatServiceBreakdown(row)
        const caret = document.createElement("span")
        caret.textContent = " ▾"
        caret.dataset.serviceTrigger = "1"
        const overridden = row.classMixSource === "route" || row.serviceLevelSource === "route"
            || (row.serviceConfig && row.serviceConfig.classFares)
        caret.title = "Quick-edit class mix / service level / per-class fares"
            + (overridden ? " (route override active — click to adjust)" : "")
        caret.style.cssText = "cursor:pointer;font-size:10px;padding:0 2px;color:"
            + (overridden ? "#a78bfa" : "#94a3b8") + ";"
        td.append(value, caret)
    }},
    {field: "classMix", label: "Mix", group: "service", align: "right",
     title: "Class mix Y/C/F as percentages.\nResolution priority: route override → assigned tail's seat counts (auto from /app/fleets) → default.\nClick ▾ on Seats/wk to pin a per-route mix.",
     render(td, row) {
        if (!row.classMix) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const m = row.classMix
        const fmt = v => Math.round((Number(v) || 0) * 100)
        const text = fmt(m.Y) + "/" + fmt(m.C) + "/" + fmt(m.F)
        const sourceColor = {route: "#a78bfa", tail: "#86efac", default: "#7dd3fc"}
        const sourceLabel = {route: "route override", tail: "from assigned tail", default: "default"}
        td.textContent = text
        td.style.fontFamily = "monospace"
        td.style.color = sourceColor[row.classMixSource] || "#7dd3fc"
        td.style.fontSize = "10px"
        td.title = "Y " + fmt(m.Y) + "% · C " + fmt(m.C) + "% · F " + fmt(m.F) + "%"
            + "  (" + (sourceLabel[row.classMixSource] || "default") + ")"
    }},
    {field: "serviceLevel", label: "Svc", group: "service", align: "center",
     title: "Service level — multiplies effective yield and adds a fixed per-pax cost on top of class catering.\nB Budget · S Standard · P Premium. Tune the multipliers in Settings → Service profiles; flip per route via the Seats/wk ▾.\nWhen the markets-page sync has run, the AS profile assigned to the route appears in the tooltip with its per-class quality score.",
     render(td, row) {
        if (!row.serviceLevel) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const lvl = row.serviceLevel
        const map = {budget: ["B", "#94a3b8"], standard: ["S", "#7dd3fc"], premium: ["P", "#fcd34d"]}
        const [glyph, color] = map[lvl] || ["?", "#9ca3af"]
        td.textContent = glyph
        td.style.fontWeight = "bold"
        td.style.color = row.serviceLevelSource === "route" ? "#a78bfa" : color
        let title = "Service level: " + lvl
            + (row.serviceLevelSource === "route" ? "  (route override)" : "  (default)")
        if (row.serviceProfileName || row.serviceProfileId) {
            title += "\n\nAS profile assigned: " + (row.serviceProfileName || "")
                + (row.serviceProfileId ? " (#" + row.serviceProfileId + ")" : "")
            const profileCache = RouteAssistantPanel._serviceProfilesCacheStatic
            const detail = (profileCache && row.serviceProfileId)
                ? profileCache.get(row.serviceProfileId) : null
            if (detail && detail.classScore) {
                title += "\nQuality (0-1): Y=" + (detail.classScore.Y != null ? detail.classScore.Y.toFixed(2) : "?")
                    + " · C=" + (detail.classScore.C != null ? detail.classScore.C.toFixed(2) : "?")
                    + " · F=" + (detail.classScore.F != null ? detail.classScore.F.toFixed(2) : "?")
            }
        }
        td.title = title
    }},

    // ----- Market Analysis (Tier 2a — markets-page scraper) -----
    // Mkt% (your pax market share) lives in its own little detached
    // "competition" group, positioned next to the Real-World Cmp pill (see
    // COLUMNS array reordering below). Hover/click opens the SAME rich
    // popover the Real-World Cmp pill uses, so all in-game competition
    // intel — your share AND the full leaderboard — surfaces in one place.
    // The Cmp# duplicate count column was removed: the Real-World Cmp pill
    // already prefers competitorCount when AS market-share data is present.
    {field: "competitorMedianPriceY", label: "Cmp$", group: "markets", align: "right", defaultDir: -1,
     title: "Median competitor Y-class fare (excludes your own flights). Cell shows +/-X% delta vs. your Y price when both are known.",
     render(td, row) {
        if (row.competitorMedianPriceY == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const cmp = row.competitorMedianPriceY
        const ours = row.ownPricing && row.ownPricing.Y
        if (ours && ours > 0) {
            const delta = Math.round(((ours - cmp) / cmp) * 100)
            td.textContent = cmp + " (" + (delta > 0 ? "+" : "") + delta + "%)"
            td.style.color = delta > 0 ? "#fde68a" : (delta < 0 ? "#86efac" : "#5eead4")
            td.title = "Median competitor Y: " + cmp + " AS$\n"
                + "Your Y: " + ours + " AS$ (" + (delta > 0 ? "+" : "") + delta + "%)\n"
                + "Positive % = you're priced higher than the median; negative = you're under."
        } else {
            td.textContent = String(cmp)
            td.style.color = "#5eead4"
        }
    }},
    {field: "pricingDrift", label: "Drft", group: "markets", align: "center",
     title: "Pricing-drift flag — 'drift' = your prices differ from AS's recommended defaults; 'default' = matches. Drift means you've been actively pricing this route.",
     render(td, row) {
        if (!row.pricingDrift) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        if (row.pricingDrift === "drift") {
            td.textContent = "drift"
            td.style.color = "#fbbf24"
        } else {
            td.textContent = "dflt"
            td.style.color = "#9ca3af"
        }
        td.style.fontWeight = "bold"
        if (row.ownPricing && row.ownPriceDefaults) {
            const lines = ["Y / C / F / Cargo prices vs default:"]
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const o = row.ownPricing[cls]
                const d = row.ownPriceDefaults[cls]
                if (o == null && d == null) continue
                lines.push("  " + cls + ": " + (o != null ? o : "—") + " (default " + (d != null ? d : "—") + ")")
            }
            td.title = lines.join("\n")
        }
    }},

    // ----- ORS Rank (Tier 2b — Online Reservation System scraper) -----
    {field: "orsPrimaryValue", label: "ORS", group: "ors", align: "right", defaultDir: -1,
     title: "Whichever ORS metric you've picked as primary in Settings → ORS Rank. Default is rating-gap (positive = winning vs top competitor). Hover the cell to see ALL rank flavors. Click ▾ to drill into the connection list.",
     render(td, row) {
        if (row.orsHiddenByThreshold) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const which = RouteAssistantPanel._orsPrimaryColumn || "ratingGapToTop"
        const v = row.orsPrimaryValue
        if (v == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        let display = String(v)
        let color = "#fcd34d"
        if (which === "ratingGapToTop") {
            display = (v > 0 ? "+" : "") + v
            color = v > 0 ? "#86efac" : (v < 0 ? "#fca5a5" : "#fcd34d")
        } else if (which === "rankAny" || which === "rankFirstLegOurs"
                || which === "rankAllOurs" || which === "rankNonstop"
                || which === "rankBookable") {
            display = "#" + v
            color = v <= 3 ? "#86efac" : (v <= 10 ? "#fcd34d" : "#fca5a5")
        }
        td.style.color = color
        td.style.fontWeight = "bold"
        const wrap = document.createElement("span")
        wrap.style.cursor = "pointer"
        wrap.style.textDecoration = "underline dotted"
        wrap.textContent = display + " ▾"
        wrap.title = formatOrsRanksTooltip(row)
        wrap.addEventListener("click", (e) => {
            e.stopPropagation()
            const panel = RouteAssistantPanel._currentInstance
            if (panel) panel._openOrsConnectionsDrawer(row)
        })
        td.append(wrap)
    }},
    {field: "orsRankNonstop", label: "RkNS", group: "ors", align: "right", defaultDir: 1,
     title: "Rank of your top all-own NONSTOP connection in the ORS result list. # = position; lower is better.",
     render(td, row) {
        if (row.orsHiddenByThreshold || row.orsRankNonstop == null) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        td.textContent = "#" + row.orsRankNonstop
        td.style.color = row.orsRankNonstop <= 3 ? "#86efac"
            : (row.orsRankNonstop <= 10 ? "#fcd34d" : "#fca5a5")
    }},
    {field: "orsRatingGapToTop", label: "Gap", group: "ors", align: "right", defaultDir: -1,
     title: "Rating gap = (your top connection rating) − (top competitor rating). Positive = winning.",
     render(td, row) {
        if (row.orsHiddenByThreshold || row.orsRatingGapToTop == null) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        const v = row.orsRatingGapToTop
        td.textContent = (v > 0 ? "+" : "") + v
        td.style.color = v > 0 ? "#86efac" : (v < 0 ? "#fca5a5" : "#fcd34d")
        td.style.fontWeight = "bold"
        _appendDiffBadge(td, "orsRatingGapToTop", row)
    }},
    {field: "orsCompetitorCount", label: "OrsC#", group: "ors", align: "right", defaultDir: 1,
     title: "Distinct first-leg carriers (other than you) appearing in the cached ORS connection list. Lower = less direct competition in ORS results.",
     render(td, row) {
        if (row.orsHiddenByThreshold || !row.orsConnections || !row.orsConnections.length) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        const carriers = new Set()
        for (const conn of row.orsConnections) {
            const flightLegs = (conn.legs || []).filter(l => !l.isGround)
            if (!flightLegs.length) continue
            const first = flightLegs[0]
            if (first.isOurs || !first.flightCode) continue
            const m = /^([A-Z0-9]+)/.exec(first.flightCode.trim().toUpperCase())
            if (m) carriers.add(m[1])
        }
        td.textContent = String(carriers.size)
        td.style.color = "#fcd34d"
    }},

    // ----- Per-class ORS columns (only render in non-Compact view AND
    // when settings.ors.showPerClassColumns is on). Each shows the user's
    // chosen primaryColumn metric for ONE cabin class. Same color rules as
    // the composite ORS column. Hover/click tooltip notes which class.
    {field: "orsClassY", label: "Y", group: "ors", align: "right", defaultDir: -1,
     title: "Economy-class ORS metric (your selected primary metric, applied to byClass.ECONOMY).",
     render(td, row) { _renderOrsClassCell(td, row, "Y", "orsClassY", "ECONOMY", "#86efac") }},
    {field: "orsClassC", label: "C", group: "ors", align: "right", defaultDir: -1,
     title: "Business-class ORS metric (your selected primary metric, applied to byClass.BUSINESS).",
     render(td, row) { _renderOrsClassCell(td, row, "C", "orsClassC", "BUSINESS", "#fde68a") }},
    {field: "orsClassF", label: "F", group: "ors", align: "right", defaultDir: -1,
     title: "First-class ORS metric (your selected primary metric, applied to byClass.FIRST).",
     render(td, row) { _renderOrsClassCell(td, row, "F", "orsClassF", "FIRST", "#fca5a5") }},

    // ----- Demand depth (Letter K — markets-historic + inventory derivation) -----
    {field: "paxDemandPool", label: "Pool", group: "demand", align: "right", defaultDir: -1,
     title: "Estimated pax bookings/week — average over the last N periods of the markets historic chart (PAX or summed Y+C+F).",
     render(td, row) {
        td.title = RouteAssistantPanel._demandTooltip("paxDemandPool", row)
        if (row.paxDemandPool == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = row.paxDemandPool.toLocaleString()
        td.style.color = RouteAssistantPanel._demandIsStale(row) ? "#9ca3af" : "#bae6fd"
        _appendDiffBadge(td, "paxDemandPool", row)
    }},
    {field: "cargoDemandPool", label: "C-Pool", group: "demand", align: "right", defaultDir: -1,
     title: "Estimated cargo demand/week (kg) — average over the last N periods of the CARGO historic chart.",
     render(td, row) {
        td.title = RouteAssistantPanel._demandTooltip("cargoDemandPool", row)
        if (row.cargoDemandPool == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = row.cargoDemandPool.toLocaleString()
        td.style.color = RouteAssistantPanel._demandIsStale(row) ? "#9ca3af" : "#bae6fd"
        _appendDiffBadge(td, "cargoDemandPool", row)
    }},
    {field: "paxElasticity", label: "Elast", group: "demand", align: "right",
     title: "Pax price elasticity — log-log regression slope of quantity~price across the historic window. Negative numbers (price up → quantity down). Closer to 0 = less price-sensitive (premium / monopoly). Below -2 = highly elastic (volatile route).",
     render(td, row) {
        td.title = RouteAssistantPanel._demandTooltip("paxElasticity", row)
        if (row.paxElasticity == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = row.paxElasticity.toFixed(2)
        td.style.color = RouteAssistantPanel._demandIsStale(row)
            ? "#9ca3af"
            : (row.paxElasticity > -1 ? "#86efac" : "#fcd34d")
    }},
    {field: "cargoElasticity", label: "C-Elast", group: "demand", align: "right",
     title: "Cargo price elasticity — same regression as Elast but on the CARGO historic series.",
     render(td, row) {
        td.title = RouteAssistantPanel._demandTooltip("cargoElasticity", row)
        if (row.cargoElasticity == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = row.cargoElasticity.toFixed(2)
        td.style.color = RouteAssistantPanel._demandIsStale(row)
            ? "#9ca3af"
            : (row.cargoElasticity > -1 ? "#86efac" : "#fcd34d")
    }},
    {field: "paxAvgPrice", label: "Avg$", group: "demand", align: "right", defaultDir: -1,
     title: "Mean Y-class fare across the historic window. Useful sanity check on what the route has historically commanded.",
     render(td, row) {
        td.title = RouteAssistantPanel._demandTooltip("paxAvgPrice", row)
        if (row.paxAvgPrice == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = "AS$" + row.paxAvgPrice.toLocaleString()
        td.style.color = RouteAssistantPanel._demandIsStale(row) ? "#9ca3af" : "#a7f3d0"
    }},
    {field: "rmTightness", label: "RM%", group: "demand", align: "right", defaultDir: -1,
     title: "Revenue-management tightness — sold/total seats averaged across forward departures (or per-class summary). 0.85+ = nearly full; <0.5 = lots of inventory left.",
     render(td, row) {
        td.title = RouteAssistantPanel._demandTooltip("rmTightness", row)
        if (row.rmTightness == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = (row.rmTightness * 100).toFixed(0) + "%"
        td.style.color = RouteAssistantPanel._demandIsStale(row)
            ? "#9ca3af"
            : (row.rmTightness >= 0.85 ? "#86efac" : (row.rmTightness >= 0.5 ? "#fde68a" : "#fca5a5"))
        _appendDiffBadge(td, "rmTightness", row)
    }}
]
// Updated in `_render` from settings.routeAssistant.yieldFeedback.varianceWarnPct;
// the column-render closures read it at draw time.
RouteAssistantPanel._varianceWarnPct = 25
// Updated in `_syncRenderContext` from settings.routeAssistant.carriers.showCarrierIntensity.
// Defaults to true so first render before settings load shows the pill.
RouteAssistantPanel._showCarrierIntensity = true
// Updated in `_syncRenderContext` from settings.routeAssistant.marketAnalysis.staleThresholdDays.
// Used by the demand-depth column render closures to grey-out stale cells.
RouteAssistantPanel._demandStaleThresholdDays = 14

/**
 * Letter K — diagnostic tooltip for a demand-depth cell. Combines the
 * static "what does this column mean" preamble with the row's actual
 * status (data present? cache stale? derivation note? no cache yet?).
 *
 * Called by each demand-depth column's render closure. Always returns a
 * multi-line string suitable for `td.title`.
 */
RouteAssistantPanel._demandTooltip = function(field, row) {
    const PREAMBLE = {
        paxDemandPool:   "Pool — estimated pax bookings/week, averaged across the last N periods of the markets historic chart (PAX or Y+C+F summed).",
        cargoDemandPool: "C-Pool — estimated cargo demand/week (kg), averaged across the last N periods of the CARGO historic chart.",
        paxElasticity:   "Elast — pax price elasticity, log-log regression slope of quantity~price across the historic window.\nNegative = price up → quantity down. >-1 = inelastic (premium / monopoly). <-2 = highly elastic (volatile).",
        cargoElasticity: "C-Elast — cargo price elasticity, same regression on the CARGO historic series.",
        paxAvgPrice:     "Avg$ — mean Y-class fare across the historic window. Sanity check on what the route has historically commanded.",
        cargoAvgPrice:   "C-Avg$ — mean cargo fare across the historic window.",
        rmTightness:     "RM% — revenue-management tightness, sold/total seats averaged across forward departures.\n0.85+ = nearly full; <0.5 = lots of inventory left."
    }
    const lines = [PREAMBLE[field] || field]
    const value = row && row[field]
    const hasData = value !== null && value !== undefined
    if (!hasData) {
        lines.push("")
        if (row && row.demandNotes) {
            lines.push("⚠ " + row.demandNotes)
        } else {
            lines.push("⚠ No demand-depth cache for this route.")
        }
        lines.push("Click \"Sync market analysis for all visible routes\" in the Market Analysis expander to populate.")
        return lines.join("\n")
    }
    if (row.demandDerivedAt) {
        const ageDays = Math.floor((Date.now() - row.demandDerivedAt) / 86400000)
        const stale   = ageDays >= (RouteAssistantPanel._demandStaleThresholdDays || 14)
        lines.push("")
        if (ageDays === 0) {
            lines.push("Last derived: today.")
        } else {
            lines.push("Last derived: " + ageDays + " day(s) ago" + (stale ? " — STALE." : "."))
        }
    }
    if (row.demandNotes) {
        lines.push("Note: " + row.demandNotes)
    }
    return lines.join("\n")
}

/**
 * Letter K — true if a demand-depth row's derivation is older than the
 * configured stale threshold. Used by render closures to grey-out the
 * cell colour so users notice they should re-sync.
 */
RouteAssistantPanel._demandIsStale = function(row) {
    if (!row || !row.demandDerivedAt) return false
    const threshold = RouteAssistantPanel._demandStaleThresholdDays || 14
    return (Date.now() - row.demandDerivedAt) >= threshold * 86400000
}

/**
 * Returns the list of view modes (subset of ["all","pax","cargo"]) in
 * which a column should render. Honours an explicit `modes` field if
 * the COLUMNS entry sets one; otherwise derives from the field name so
 * we don't have to tag every entry in the large COLUMNS array.
 *
 * Today only the `paxScore` and `cargoScore` cells are mode-specific
 * (the AS in-game pax/cargo demand badges). Everything else — distance,
 * frequency, competition, profit, fit, market analysis, ORS, etc. — is
 * relevant to both pax and cargo planning so it stays visible in every
 * tab.
 */
RouteAssistantPanel._columnModes = function(col) {
    if (col && Array.isArray(col.modes)) return col.modes
    const f = col && col.field
    if (f === "paxScore")   return ["all", "pax"]
    if (f === "cargoScore") return ["all", "cargo"]
    // Letter K — demand-depth columns are mode-prefixed by field name.
    // pax* / cargo* / c-elast etc. land in the right tab automatically.
    if (typeof f === "string") {
        if (/^pax[A-Z]/.test(f)) return ["all", "pax"]
        if (/^cargo[A-Z]/.test(f)) return ["all", "cargo"]
    }
    return ["all", "pax", "cargo"]
}
// Set in _applyCachedOrs from settings.routeAssistant.ors.primaryColumn so the
// per-cell render closure knows which metric to display.
RouteAssistantPanel._orsPrimaryColumn = "ratingGapToTop"
// Live reference to the active panel — render closures need it to open the
// drill-in drawer on click without capturing `this`.
RouteAssistantPanel._currentInstance = null
// Watchlist alert-badge gate — set in `_syncRenderContext` from
// settings.routeAssistant.watchlist.showAlertBadges. Read by
// `_buildWatchlistStar` to decide whether to render the red dot suffix
// next to the ★ on starred rows whose `_diff` shows worsening change.
// The starred state itself is per-row (`row._starred`), set in
// `_renderRows`, not exposed here.
RouteAssistantPanel._showWatchTriggers = true

/**
 * Resolve which numeric value the ORS primary column should display, based
 * on the user's settings.ors.primaryColumn choice. Read by _applyCachedOrs;
 * stays a static helper so it's reachable from outside the instance.
 */
RouteAssistantPanel._resolveOrsPrimary = function(rec, which) {
    if (!rec) return null
    switch (which) {
        case "rankAny":              return rec.rankAny
        case "rankFirstLegOurs":     return rec.rankFirstLegOurs
        case "rankAllOurs":          return rec.rankAllOurs
        case "rankNonstop":          return rec.rankNonstop
        case "rankBookable":         return rec.rankBookable
        case "ourTopRating":         return rec.ourTopRating
        case "ourBestNonstopRating": return rec.ourBestNonstopRating
        case "ratingGapToTop":
        default:                     return rec.ratingGapToTop
    }
}

/**
 * Compose all ORS metrics from a `byClass` map using the user's combine
 * method + weights. Returns a flat record with the same shape the legacy
 * single-class code produced — so the existing display columns Just Work.
 *
 * Per-metric semantics:
 *   rank* — lower is better (composed average is rounded).
 *   ourTopRating / ratingGapToTop — higher is better (composed average kept as float, rendered rounded).
 *
 * Combine methods:
 *   weighted / capacityWeighted — Σ(metricᵢ × weight) / Σweight, skipping null metrics.
 *   min — best (lowest) of the rank metrics, worst (lowest) of the rating metrics.
 *   max — opposite.
 *   avg — equal-weight average.
 *
 * Classes with null per-metric value are skipped (don't drag composite
 * down). If ALL classes are null for a metric, composite = null.
 */
RouteAssistantPanel._composeOrsAllMetrics = function(byClass, method, weights) {
    const METRICS = ["rankAny", "rankFirstLegOurs", "rankAllOurs", "rankNonstop", "rankBookable",
                     "ourTopRating", "ourBestNonstopRating", "topCompetitorRating", "ratingGapToTop"]
    const RANK_METRICS = {rankAny: 1, rankFirstLegOurs: 1, rankAllOurs: 1, rankNonstop: 1, rankBookable: 1}
    const out = {}
    const classes = ["ECONOMY", "BUSINESS", "FIRST"]
    for (const m of METRICS) {
        const samples = []
        const ws = []
        for (const cls of classes) {
            const cr = byClass && byClass[cls]
            if (!cr) continue
            const v = cr[m]
            if (v == null) continue
            const w = (weights && weights[cls]) || 0
            samples.push(v)
            ws.push(w)
        }
        if (!samples.length) { out[m] = null; continue }
        let value
        if (method === "min") {
            value = Math.min.apply(null, samples)
        } else if (method === "max") {
            value = Math.max.apply(null, samples)
        } else if (method === "avg") {
            value = samples.reduce((s, x) => s + x, 0) / samples.length
        } else {
            // weighted | capacityWeighted (weights resolved upstream)
            const wsum = ws.reduce((s, x) => s + x, 0)
            if (wsum > 0) {
                let acc = 0
                for (let i = 0; i < samples.length; i++) acc += samples[i] * ws[i]
                value = acc / wsum
            } else {
                value = samples.reduce((s, x) => s + x, 0) / samples.length
            }
        }
        // Round rank metrics; keep ratings as decimal (display layer rounds).
        out[m] = RANK_METRICS[m] ? Math.round(value) : value
    }
    return out
}

/**
 * Per-class ORS cell renderer used by the Y / C / F columns. Reads the
 * row's pre-computed per-class metric (orsClassY / orsClassC / orsClassF)
 * and colors it the same way the composite ORS column does.
 */
function _renderOrsClassCell(td, row, label, rowField, classKey, accent) {
    if (row.orsHiddenByThreshold) { td.textContent = "—"; td.style.color = "#6b7280"; return }
    const v = row[rowField]
    if (v == null) {
        td.textContent = "—"
        td.style.color = "#6b7280"
        const cr = row.orsByClass && row.orsByClass[classKey]
        if (cr === null) td.title = label + " was attempted but failed (parser miss or transient error)."
        else if (!cr)    td.title = label + " not scraped — enable in Settings → ORS Rank → Classes."
        else if (cr.totalConnections === 0) td.title = label + " has 0 connections on this route — no metric to compute."
        else td.title = label + " — no rank computed (you don't fly this route in this class?)"
        return
    }
    const which = RouteAssistantPanel._orsPrimaryColumn || "ratingGapToTop"
    let display, color
    if (which === "ratingGapToTop") {
        const rounded = Math.round(v)
        display = (rounded > 0 ? "+" : "") + rounded
        color = rounded > 0 ? "#86efac" : (rounded < 0 ? "#fca5a5" : accent)
    } else if (which === "rankAny" || which === "rankFirstLegOurs"
            || which === "rankAllOurs" || which === "rankNonstop"
            || which === "rankBookable") {
        display = "#" + v
        color = v <= 3 ? "#86efac" : (v <= 10 ? accent : "#fca5a5")
    } else {
        display = String(Math.round(v))
        color = accent
    }
    td.textContent = display
    td.style.color = color
    td.style.fontWeight = "bold"
    const cr = row.orsByClass && row.orsByClass[classKey]
    if (cr) {
        const lines = [label + " (" + classKey + "):"]
        lines.push("  totalConnections: " + (cr.totalConnections != null ? cr.totalConnections : "—"))
        lines.push("  rankNonstop: " + (cr.rankNonstop != null ? "#" + cr.rankNonstop : "—"))
        lines.push("  ourTopRating: " + (cr.ourTopRating != null ? cr.ourTopRating : "—"))
        lines.push("  topCompetitorRating: " + (cr.topCompetitorRating != null ? cr.topCompetitorRating : "—"))
        td.title = lines.join("\n")
    }
}

function formatOrsRanksTooltip(row) {
    const lines = ["ORS rank flavors:"]
    const fmt = (v) => v != null ? String(v) : "—"
    lines.push("  any leg ours:        " + fmt(row.orsRankAny))
    lines.push("  first leg ours:      " + fmt(row.orsRankFirstLegOurs))
    lines.push("  all flight legs ours: " + fmt(row.orsRankAllOurs))
    lines.push("  own nonstop:         " + fmt(row.orsRankNonstop))
    lines.push("  first own bookable:  " + fmt(row.orsRankBookable))
    lines.push("Ratings:")
    lines.push("  our top:             " + fmt(row.orsOurTopRating))
    lines.push("  our best nonstop:    " + fmt(row.orsOurBestNonstopRating))
    lines.push("  top competitor:      " + fmt(row.orsTopCompetitorRating))
    lines.push("  rating gap:          " + (row.orsRatingGapToTop != null
        ? (row.orsRatingGapToTop > 0 ? "+" + row.orsRatingGapToTop : row.orsRatingGapToTop)
        : "—"))
    if (row.orsTotalConnections != null) {
        lines.push("Total connections in list: " + row.orsTotalConnections)
    }
    if (row.orsScrapedAt) {
        lines.push("Last scraped: " + new Date(row.orsScrapedAt).toLocaleString())
    }
    lines.push("Click ▾ to drill into the connection list.")
    return lines.join("\n")
}

// ---------- Helpers ----------

function makeBtn(label, title, onclick) {
    const b = document.createElement("button")
    b.textContent = label
    b.title = title
    b.style.cssText = "background:none;border:none;color:#f3f4f6;cursor:pointer;font-size:14px;"
    b.addEventListener("click", onclick)
    return b
}

function smallBtnStyle() {
    return {
        background: "#2563eb",
        color: "#fff",
        border: "none",
        padding: "3px 8px",
        borderRadius: "3px",
        fontSize: "11px",
        cursor: "pointer"
    }
}

function mkInput(type, value) {
    const i = document.createElement("input")
    i.type = type
    i.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;"
    if (type === "number" && value !== null && value !== undefined) i.value = value
    return i
}

/**
 * Generic <select> with a fixed option list. Used for the direction picker.
 */
function mkSelect(options, currentValue) {
    const sel = document.createElement("select")
    sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;"
    for (const opt of options) {
        const o = document.createElement("option")
        o.value = opt.value
        o.textContent = opt.label
        if (currentValue === opt.value) o.selected = true
        sel.append(o)
    }
    return sel
}

/**
 * Min/Max <select> with a list of suggested numeric values plus a "no limit"
 * option. If the currently-saved value isn't one of the suggestions, it gets
 * inserted into the dropdown so the user can see what's currently applied
 * (e.g. they migrated from a free-text input). Returns the <select>; reading
 * `.value === ""` means no limit, otherwise a number string.
 */
function mkSuggestSelect(currentValue, suggestedValues) {
    const sel = document.createElement("select")
    sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;width:80px;"

    const noLimit = document.createElement("option")
    noLimit.value = ""
    noLimit.textContent = "no limit"
    sel.append(noLimit)

    const values = (suggestedValues || []).slice()
    if (currentValue !== null && currentValue !== undefined && !values.includes(Number(currentValue))) {
        values.push(Number(currentValue))
    }
    values.sort((a, b) => a - b)

    const seen = new Set()
    for (const v of values) {
        if (seen.has(v)) continue
        seen.add(v)
        const o = document.createElement("option")
        o.value = String(v)
        o.textContent = String(v)
        if (currentValue !== null && currentValue !== undefined && Number(currentValue) === v) o.selected = true
        sel.append(o)
    }
    if (currentValue === null || currentValue === undefined) noLimit.selected = true

    return sel
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

/**
 * Compact relative-time formatter for the notification center. Renders
 * "12s ago" / "3m ago" / "1h ago" / "2d ago". Within 5s it returns
 * "just now". Beyond 7 days it falls back to a localised date string.
 */
function _formatRelativeTime(ts) {
    const t = Number(ts)
    if (!isFinite(t)) return ""
    const diff = Date.now() - t
    if (diff < 0) return "in the future"
    if (diff < 5 * 1000) return "just now"
    const sec = Math.floor(diff / 1000)
    if (sec < 60) return sec + "s ago"
    const min = Math.floor(sec / 60)
    if (min < 60) return min + "m ago"
    const hr = Math.floor(min / 60)
    if (hr < 24) return hr + "h ago"
    const d = Math.floor(hr / 24)
    if (d < 7) return d + "d ago"
    return new Date(t).toLocaleDateString()
}

// `escapeHtml` lives in helpers.js (loaded first in every /app + /action
// content-script block) so wave-overlay.js can call it without depending on
// panel.js parse order.

// ---------- Diff against last visit ----------
// Per-mount delta badges for daily-driver QoL. The render closures for the
// listed numeric columns append a small grey ▲/▼ badge whenever the row
// carries a `_diff.<field>` scalar. The baseline lives at
// `routeAssistant:lastSnapshot:<HUB>`, written at the end of _drawTable on
// every render and read once per mount in refresh().
//
// Tracked field → display formatter for the badge's number portion. The
// `field` here is the row property name (matches the COLUMNS render
// closures), not the SCORING_FIELDS spec name — so the diff stores
// `orsRatingGapToTop` rather than the spec's `ratingGapToTop`.
const RA_DIFF_TRACKED = [
    {field: "score",             fmt: "int"},
    {field: "paxScore",          fmt: "int"},
    {field: "cargoScore",        fmt: "int"},
    {field: "weeklyFlights",     fmt: "int"},
    {field: "airlineCount",      fmt: "int"},
    {field: "competitorCount",   fmt: "int"},
    {field: "paxDemandPool",     fmt: "compact"},
    {field: "cargoDemandPool",   fmt: "compact"},
    {field: "ourPaxShare",       fmt: "pct1"},
    {field: "orsRatingGapToTop", fmt: "intSigned"},
    {field: "rmTightness",       fmt: "pctTight"}
]
const RA_DIFF_FMT_BY_FIELD = (() => {
    const m = {}
    for (const e of RA_DIFF_TRACKED) m[e.field] = e.fmt
    return m
})()

async function _loadDiffSnapshot(hub) {
    if (!hub) return null
    try {
        const key = "routeAssistant:lastSnapshot:" + hub
        const got = await chrome.storage.local.get(key)
        const rec = got[key]
        if (!rec || !Array.isArray(rec.rows)) return null
        return rec
    } catch (e) {
        console.warn("[AES routeAssistant] diff baseline load failed:", e)
        return null
    }
}

function _writeDiffSnapshot(hub, server, rows) {
    if (!hub || !rows || !rows.length) return
    const key = "routeAssistant:lastSnapshot:" + hub
    const num = v => (typeof v === "number" && isFinite(v)) ? v : null
    const slim = []
    for (const r of rows) {
        if (!r || !r.destIata) continue
        const o = {destIata: r.destIata}
        for (const e of RA_DIFF_TRACKED) o[e.field] = num(r[e.field])
        slim.push(o)
    }
    const blob = {hub, server: server || "", scrapedAt: Date.now(), rows: slim}
    try {
        chrome.storage.local.set({[key]: blob})
    } catch (e) {
        console.warn("[AES routeAssistant] lastSnapshot write failed:", e)
    }
}

function _decorateRowsWithDiffs(rows, prev) {
    if (!rows || !rows.length) return
    if (!prev || !Array.isArray(prev.rows) || !prev.rows.length) return
    const prevByIata = new Map()
    for (const p of prev.rows) {
        if (p && p.destIata) prevByIata.set(p.destIata, p)
    }
    if (!prevByIata.size) return
    for (const r of rows) {
        if (!r || !r.destIata) continue
        const before = prevByIata.get(r.destIata)
        if (!before) { r._diff = null; continue }
        const diff = {}
        let any = false
        for (const e of RA_DIFF_TRACKED) {
            const cur = r[e.field]
            const old = before[e.field]
            if (typeof cur !== "number" || !isFinite(cur)) continue
            if (typeof old !== "number" || !isFinite(old)) continue
            const d = cur - old
            if (d === 0) continue
            diff[e.field] = d
            any = true
        }
        r._diff = any ? diff : null
        r._diffSnapshotAt = prev.scrapedAt || null
    }
}

function _formatDiffNumber(field, abs) {
    const fmt = RA_DIFF_FMT_BY_FIELD[field] || "int"
    if (fmt === "compact") {
        if (abs >= 1000) return Math.round(abs / 100) / 10 + "k"
        return Math.round(abs).toLocaleString()
    }
    if (fmt === "pct1")     return abs.toFixed(1) + "pp"
    if (fmt === "pctTight") return Math.round(abs * 100) + "pp"
    if (fmt === "intSigned") return String(Math.round(abs))
    // "int" — round to nearest, but keep one decimal when |abs| < 1 so
    // small score moves still render rather than collapsing to "0".
    if (abs < 1 && abs > 0) return abs.toFixed(2).replace(/\.?0+$/, "") || "0"
    return String(Math.round(abs))
}

/**
 * Append a small grey ▲/▼ delta badge to `td` showing the change in
 * `row[field]` since the previous mount. `field` may be a single string or
 * an array of fallback field names (the first one with a non-zero diff
 * wins — used by the Cmp column which displays competitorCount with an
 * airlineCount fallback).
 */
// ---------- Watchlist (starred routes) ----------
// Pair of helpers powering the ☆/★ button in the destIata cell. Storage
// + Set lifecycle live in RouteAssistantWatchlistStore; everything below is
// the panel-side render + trigger evaluation.
//
// RA_WATCH_TRIGGERS lists every (field, worseDir) pair that should light an
// alert dot on a starred row. The fields here MUST also appear in
// RA_DIFF_TRACKED (above) — the row's `_diff.<field>` scalar is what drives
// the trigger. `worseDir` is the sign of the diff that counts as a bad
// change: `+1` means an increase is bad (more competitors, tighter RM),
// `-1` means a decrease is bad (lower demand, shrinking ORS gap).
const RA_WATCH_TRIGGERS = [
    {field: "paxScore",          worseDir: -1, label: "Pax demand fell"},
    {field: "cargoScore",        worseDir: -1, label: "Cargo demand fell"},
    {field: "airlineCount",      worseDir: +1, label: "Real-world competitor entered"},
    {field: "competitorCount",   worseDir: +1, label: "AS competitor entered"},
    {field: "rmTightness",       worseDir: +1, label: "RM tightness rose (less headroom)"},
    {field: "orsRatingGapToTop", worseDir: -1, label: "ORS gap-to-top shrunk"}
]

/**
 * Returns an array of fired trigger entries for `row`, each `{label, delta}`,
 * by comparing the row's `_diff.<field>` scalars (set upstream by
 * `_decorateRowsWithDiffs`) against `RA_WATCH_TRIGGERS`. Empty array when no
 * triggers fired or when there's no diff baseline yet (first ever mount on
 * this hub).
 */
function _evaluateWatchTriggers(row) {
    const fired = []
    if (!row || !row._diff) return fired
    for (const t of RA_WATCH_TRIGGERS) {
        const d = row._diff[t.field]
        if (typeof d !== "number" || !isFinite(d) || d === 0) continue
        if (Math.sign(d) !== t.worseDir) continue
        fired.push({label: t.label, field: t.field, delta: d})
    }
    return fired
}

/**
 * Build the leading ☆/★ button for the destIata cell. Clickable, calls
 * `_currentInstance._toggleWatchlist(hub, dest)`. When the row is starred
 * AND `_evaluateWatchTriggers` returns at least one trigger, suffix a small
 * red dot whose `title=""` lists every fired trigger and its delta. The dot
 * is gated on `_showWatchTriggers` so users can hide it via the
 * `showAlertBadges` setting without losing the star itself.
 */
function _buildWatchlistStar(row, hub) {
    const wrap = document.createElement("span")
    wrap.style.cssText = "display:inline-flex;align-items:center;margin-right:3px;vertical-align:middle;"
    const starred = !!row._starred
    const btn = document.createElement("a")
    btn.href = "#"
    btn.textContent = starred ? "★" : "☆"
    btn.style.cssText = "text-decoration:none;font-size:13px;line-height:1;cursor:pointer;"
        + (starred ? "color:#fbbf24;" : "color:#6b7280;")
    btn.title = starred
        ? "Starred — pinned to top. Click to unstar."
        : "Click to star this route — pins to top, lights an alert when its numbers worsen since your last visit."
    btn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        const inst = RouteAssistantPanel._currentInstance
        if (!inst) return
        inst._toggleWatchlist(hub || RouteAssistantPanel._currentHubIata || "", row.destIata)
    })
    wrap.append(btn)
    if (starred && RouteAssistantPanel._showWatchTriggers !== false) {
        const fired = _evaluateWatchTriggers(row)
        if (fired.length) {
            const dot = document.createElement("span")
            dot.textContent = "•"
            dot.style.cssText = "margin-left:2px;font-size:14px;line-height:1;"
                + "color:#fca5a5;cursor:help;"
            const stamp = row._diffSnapshotAt
                ? new Date(row._diffSnapshotAt).toLocaleString()
                : "previous panel mount"
            const lines = ["Watch triggers since last visit:"]
            for (const f of fired) {
                const sign = f.delta > 0 ? "+" : "−"
                const fmt  = _formatDiffNumber(f.field, Math.abs(f.delta))
                lines.push("  • " + f.label + " (" + sign + fmt + ")")
            }
            lines.push("(baseline: " + stamp + ")")
            dot.title = lines.join("\n")
            wrap.append(dot)
        }
    }
    return wrap
}

function _appendDiffBadge(td, field, row) {
    if (!td || !row || !row._diff) return
    const fields = Array.isArray(field) ? field : [field]
    let pick = null, fname = null
    for (const f of fields) {
        const d = row._diff[f]
        if (typeof d === "number" && isFinite(d) && d !== 0) {
            pick = d
            fname = f
            break
        }
    }
    if (pick === null) return
    const arrow = pick > 0 ? "▲" : "▼"
    const txt = _formatDiffNumber(fname, Math.abs(pick))
    if (!txt) return
    const span = document.createElement("span")
    span.textContent = " " + arrow + txt
    span.style.cssText = "margin-left:3px;font-size:9px;color:#9ca3af;"
        + "font-weight:normal;opacity:0.85;"
    const stamp = row._diffSnapshotAt
        ? new Date(row._diffSnapshotAt).toLocaleString()
        : "previous panel mount"
    span.title = "Δ " + fname + " since last visit: "
        + (pick > 0 ? "+" : "−") + Math.abs(pick).toLocaleString()
        + "\n(baseline: " + stamp + ")"
    td.append(span)
}

/**
 * F slice 2 — fallback avatar shown when an enterprise has no cached
 * avatarUrl (or its <img> failed to load). Renders a 32×32 colored
 * tile with the first letter of the name. Color hashes from the
 * name so the same enterprise always gets the same tile — quick
 * visual recognition even without art.
 */
function _initialBadge(name) {
    const span = document.createElement("span")
    const ch = (name || "?").trim().charAt(0).toUpperCase() || "?"
    let h = 0
    for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
    const hue = ((h % 360) + 360) % 360
    span.textContent = ch
    span.style.cssText = "width:32px;height:32px;display:flex;align-items:center;justify-content:center;"
        + "color:#0f172a;font-weight:700;font-size:14px;"
        + "background:hsl(" + hue + ", 60%, 70%);"
    return span
}

/**
 * Numeric <input> with min/max/step/width. Returns "" when the cell is
 * cleared, so the caller's parseFloatOr() can apply the default.
 */
function mkNumberInput(value, opts) {
    const i = document.createElement("input")
    i.type = "number"
    if (opts && opts.min !== undefined)  i.min  = String(opts.min)
    if (opts && opts.max !== undefined)  i.max  = String(opts.max)
    if (opts && opts.step !== undefined) i.step = String(opts.step)
    const width = (opts && opts.width) || "60px"
    i.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;width:" + width + ";"
    if (value !== null && value !== undefined && isFinite(value)) i.value = String(value)
    return i
}

function parseFloatOr(text, fallback) {
    if (text === null || text === undefined || text === "") return fallback
    const n = parseFloat(text)
    return isFinite(n) ? n : fallback
}

/**
 * Compact AS$ formatter: 12,345 → "12.3k", 1,234,567 → "1.23M". Negative
 * values keep the sign so the colour-coded cells read right.
 */
function formatProfit(num) {
    if (num === null || num === undefined || !isFinite(num)) return "—"
    const sign = num < 0 ? "−" : ""
    const abs = Math.abs(num)
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M"
    if (abs >= 1e4) return sign + Math.round(abs / 1e3) + "k"
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k"
    return sign + Math.round(abs)
}

/**
 * Multiline string spelling out every term that fed into the row's profit
 * estimate. Rendered as a native title tooltip on the $/flt and $/wk cells
 * so users can see exactly how the number was produced.
 */
function formatProfitBreakdown(row) {
    const b = row && row.profitBreakdown
    if (!b) return ""
    const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toLocaleString()
    const fmt2 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(2)
    const fmt3 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(3)
    const fmt4 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(4)
    const ym  = fmt2(b.yieldMultiplier != null ? b.yieldMultiplier : 1)
    const paxLfFrom = b.paxLoadFactorSource === "override"
        ? "pinned override"
        : b.paxLoadFactorSource === "demand"
            ? "from pax demand " + (b.paxScore != null ? b.paxScore + "/10" : "?/10")
            : "fallback (pax demand unresolved)"
    const cargoLfFrom = b.cargoLoadFactorSource === "override"
        ? "pinned override"
        : b.cargoLoadFactorSource === "demand"
            ? "from cargo demand " + (b.cargoScore != null ? b.cargoScore + "/10" : "?/10")
            : "fallback (cargo demand unresolved)"

    const lines = []
    if (b.hasOverride) {
        lines.push("📌 Per-route override active"
            + (b.overrideNote ? " — " + b.overrideNote : ""))
    }
    lines.push("Aircraft: " + (row.aircraftTypeName || "?")
        + " · " + fmt(b.seats) + " seats"
        + (b.cargoCapacityKg ? " · " + fmt(b.cargoCapacityKg) + " kg cargo" : "")
        + " · " + fmt(b.speed) + " km/h")
    lines.push("Distance: " + fmt(b.distanceKm) + " km × 2 = " + fmt(b.distanceRoundTripKm) + " km round-trip")

    // Pax revenue branch
    if (b.seats > 0) {
        lines.push("Pax LF: " + fmt2(b.paxLoadFactor) + " (" + paxLfFrom + ")")
        const yMult = (b.yieldDemandMultiplier != null && b.yieldDemandMultiplier !== 1)
            ? " · demand-adjusted ×" + fmt2(b.yieldDemandMultiplier)
              + " → AS$" + fmt4(b.effectivePaxYield != null ? b.effectivePaxYield : b.yieldPerKm) + "/pax-km"
            : ""
        const ySrc = b.yieldSource === "override" ? " (pinned)" : ""
        lines.push("Pax yield: AS$" + fmt3(b.yieldPerKm) + "/pax-km" + ySrc + yMult)
        const yldUsed = b.effectivePaxYield != null ? b.effectivePaxYield : b.yieldPerKm
        lines.push("Pax revenue = " + fmt(b.seats) + " × " + fmt2(b.paxLoadFactor)
            + " × AS$" + fmt4(yldUsed) + " × " + fmt(b.distanceRoundTripKm)
            + " × " + ym + " (" + (row.aircraftFit || "?") + ") ≈ AS$" + fmt(b.paxRevenue))
    }
    // Cargo revenue branch (only when enabled)
    if (b.cargoYieldPerKgKm > 0 && b.cargoCapacityKg > 0) {
        lines.push("Cargo LF: " + fmt2(b.cargoLoadFactor) + " (" + cargoLfFrom + ")")
        const cyMult = (b.cargoYieldDemandMultiplier != null && b.cargoYieldDemandMultiplier !== 1)
            ? " · demand-adjusted ×" + fmt2(b.cargoYieldDemandMultiplier)
              + " → AS$" + fmt4(b.effectiveCargoYield != null ? b.effectiveCargoYield : b.cargoYieldPerKgKm) + "/kg-km"
            : ""
        const cySrc = b.cargoYieldSource === "override" ? " (pinned)" : ""
        lines.push("Cargo yield: AS$" + fmt4(b.cargoYieldPerKgKm) + "/kg-km" + cySrc + cyMult)
        const cyldUsed = b.effectiveCargoYield != null ? b.effectiveCargoYield : b.cargoYieldPerKgKm
        lines.push("Cargo revenue = " + fmt(b.cargoCapacityKg) + " kg × " + fmt2(b.cargoLoadFactor)
            + " × AS$" + fmt4(cyldUsed) + " × " + fmt(b.distanceRoundTripKm)
            + " × " + ym + " ≈ AS$" + fmt(b.cargoRevenue))
        lines.push("Total revenue = AS$" + fmt(b.paxRevenue) + " + AS$" + fmt(b.cargoRevenue) + " = AS$" + fmt(b.revenue))
    } else if (b.cargoCapacityKg > 0 && b.seats > 0) {
        lines.push("Cargo revenue = 0 (cargo yield is disabled — set Cargo AS$/kg-km in Economics to enable)")
    }

    lines.push("Block hours: " + fmt(b.distanceRoundTripKm) + " / " + fmt(b.speed) + " + 0.5 = " + fmt2(b.blockHours) + " h")
    // Age penalty line (if active) — explains why effective fuel/h differs
    // from the base setting.
    if (b.ageFuelMultiplier != null && b.ageFuelMultiplier > 1) {
        const ageStr = b.aircraftAge != null ? fmt2(b.aircraftAge) : "?"
        lines.push("Age penalty: AS$" + fmt(b.fuelCostPerHour) + "/h × (1 + "
            + fmt3(b.fuelAgePenaltyPerYear) + " × " + ageStr + " yr) = ×"
            + fmt2(b.ageFuelMultiplier) + " → AS$" + fmt(b.effectiveFuelPerHour) + "/h")
    }
    // Cost breakdown — only show non-zero lines
    const costLines = []
    const fuelHourly = b.effectiveFuelPerHour != null ? b.effectiveFuelPerHour : b.fuelCostPerHour
    if (b.fuelCost > 0) {
        if (b.fuelMethod === "perType" && b.fuelLiters != null && b.fuelPriceASc) {
            costLines.push("Fuel " + fmt(b.fuelLiters) + " L × " + fmt2(b.fuelPriceASc) + " ASc/l ÷ 100 = AS$" + fmt(b.fuelCost))
        } else {
            costLines.push("Fuel AS$" + fmt(fuelHourly) + "/h × " + fmt2(b.blockHours) + " = AS$" + fmt(b.fuelCost))
        }
    }
    if (b.crewCost > 0)        costLines.push("Crew AS$" + fmt(b.crewCostPerHour) + "/h × " + fmt2(b.blockHours) + " = AS$" + fmt(b.crewCost))
    if (b.maintenanceCost > 0) costLines.push("Maint AS$" + fmt(b.maintenanceCostPerHour) + "/h × " + fmt2(b.blockHours) + " = AS$" + fmt(b.maintenanceCost))
    if (b.otherFixedPerFlight > 0) costLines.push("Other AS$" + fmt(b.otherFixedPerFlight) + "/flt")
    if (costLines.length > 1) {
        lines.push("Cost = " + costLines.join(" + ") + " = AS$" + fmt(b.totalCost))
    } else if (costLines.length === 1) {
        lines.push("Cost = " + costLines[0] + (b.totalCost !== b.fuelCost ? " (+ ...) = AS$" + fmt(b.totalCost) : ""))
    } else {
        lines.push("Cost = AS$" + fmt(b.totalCost))
    }
    lines.push("$/flt = AS$" + fmt(b.revenue) + " − AS$" + fmt(b.totalCost) + " = AS$" + fmt(b.profitPerFlight))
    if (b.frequency > 0 && b.profitPerWeek !== null) {
        lines.push("$/wk = AS$" + fmt(b.profitPerFlight) + " × " + b.frequency + " flights/wk = AS$" + fmt(b.profitPerWeek))
    } else {
        lines.push("$/wk = — (you don't fly this route yet)")
    }

    // Append actuals comparison when a snapshot exists for this row. The
    // Actuals columns repeat much of this; mirroring it here gives the user a
    // single tooltip with the full forecast-vs-actual story when they hover
    // the existing $/flt cell.
    if (row.actualProfitPerFlight !== null && row.actualProfitPerFlight !== undefined) {
        lines.push("")
        lines.push(formatActualsBreakdown(row))
    }
    return lines.join("\n")
}

/**
 * Multiline string describing the actuals snapshot for a row — tail mix,
 * frequency, variance vs estimate, and a tiny ASCII sparkline showing the
 * stored history. Used by the Actual $/flt + Δ% column tooltips and tacked
 * onto the bottom of formatProfitBreakdown when a snapshot is present.
 */
function formatActualsBreakdown(row) {
    if (!row || row.actualProfitPerFlight === null || row.actualProfitPerFlight === undefined) {
        return "Actuals: no snapshot — click \"Snapshot yields now\" in Settings."
    }
    const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toLocaleString()
    const modeStr = row.actualSnapshotMode === "delta"
        ? "delta — $/flt across flights flown SINCE the prior snapshot"
        : "cumulative — lifetime average $/flt per tail (toggle Delta mode in Settings)"
    const lines = ["Actuals (" + modeStr + "):"]
    const taken = row.actualSnapshotAt ? new Date(row.actualSnapshotAt).toLocaleString() : "?"
    lines.push("  $/flt actual = AS$" + fmt(row.actualProfitPerFlight)
        + " · $/wk actual = AS$" + fmt(row.actualProfitPerWeek)
        + " (freq " + (row.actualFrequency != null ? Math.round(row.actualFrequency) : "?") + ")")
    if (row.actualVariancePct !== null && row.actualVariancePct !== undefined) {
        const v = row.actualVariancePct
        lines.push("  Δ vs estimate: " + (v > 0 ? "+" : "") + v + "%"
            + (v > 0 ? " — outperforming the estimator" : v < 0 ? " — underperforming" : ""))
    }
    if (Array.isArray(row.actualAircraftTypes) && row.actualAircraftTypes.length) {
        lines.push("  Tails: " + row.actualContributingTails + "/" + (row.actualTotalKnownTails || row.actualContributingTails)
            + " known · types: " + row.actualAircraftTypes.join(", "))
        if (row.actualTotalKnownTails && row.actualContributingTails < row.actualTotalKnownTails) {
            const missing = row.actualTotalKnownTails - row.actualContributingTails
            lines.push("  ⚠ " + missing + " tail" + (missing > 1 ? "s" : "")
                + " missing profit data — visit each aircraft's history page to fill in.")
        }
    }
    const spark = formatActualsSparkline(row.actualSnapshots)
    if (spark) lines.push("  History: " + spark + "  (oldest → newest)")
    lines.push("  Snapshot: " + taken)
    return lines.join("\n")
}

/**
 * Solve for the base pax yield that would make the rough estimator's
 * predicted profit match the latest snapshot's actual $/flt at the row's
 * current LF / aircraft / cost mix. Returns null when the math can't run
 * (no snapshot, no breakdown, no seats, zero distance).
 *
 * Derivation:
 *   actualProfit = effYield × seats × paxLF × distRT × yieldMult − totalCost
 *   ⇒ effYield = (actualProfit + totalCost) / (seats × paxLF × distRT × yieldMult)
 *   baseYield = effYield / yieldDemandMult
 *
 * Pure-pax for v1 — leaves cargo yield untouched. Cargo-only routes return
 * null (the cargo yield calibration is a separate flow).
 */
/**
 * Multiline tooltip describing the per-class seat allocation, weekly seats
 * offered, and class-aware revenue + cost breakdown. Powers the Seats/wk
 * column tooltip; pulls everything from row.classBreakdown so the panel
 * doesn't have to re-derive the math.
 */
function formatServiceBreakdown(row) {
    if (!row || !row.classBreakdown) {
        return "Service breakdown unavailable — pick an aircraft + ensure live route data is captured."
    }
    const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toLocaleString()
    const fmt4 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(4)
    const cb = row.classBreakdown
    const mix = row.classMix || {}
    const lines = []
    lines.push("Service profile: " + (row.serviceLevel || "?")
        + (row.serviceLevelSource === "route" ? " (route override)" : " (default)"))
    if (cb.serviceLevelYieldMult != null && cb.serviceLevelYieldMult !== 1) {
        lines.push("  Service yield multiplier ×" + cb.serviceLevelYieldMult.toFixed(2)
            + " · +AS$" + Math.round(cb.serviceLevelPerPaxCost || 0) + "/pax")
    }
    lines.push("Class mix: Y " + Math.round((mix.Y || 0) * 100)
        + "%  C " + Math.round((mix.C || 0) * 100)
        + "%  F " + Math.round((mix.F || 0) * 100) + "%"
        + (row.classMixSource === "route" ? "  (route override)" : "  (default)"))
    lines.push("")
    lines.push("Per flight                              Per week")
    for (const cls of ["Y", "C", "F"]) {
        const c = cb.classes[cls]
        if (!c || !c.seats) continue
        lines.push("  " + cls + "  " + c.seats + " seats × LF "
            + (cb.classes[cls].seatsFilled / Math.max(1, c.seats)).toFixed(2)
            + " · y AS$" + fmt4(c.yieldPerKm)
            + (c.yieldOverride ? " (pin)" : "")
            + "  rev AS$" + fmt(c.revenuePerFlight)
            + " / wk AS$" + fmt(c.revenuePerWeek))
        lines.push("       cost AS$" + fmt(c.costPerFlight)
            + " (AS$" + c.costPerPax + "/pax"
            + (c.costOverride ? " pin" : "") + ")"
            + " / wk AS$" + fmt(c.costPerWeek)
            + " · seats/wk " + fmt(c.weeklySeats))
    }
    lines.push("")
    lines.push("Total revenue: AS$" + fmt(cb.totalRevenuePerFlight)
        + "/flt · AS$" + fmt(cb.totalRevenuePerWeek) + "/wk")
    lines.push("Total class-cost: AS$" + fmt(cb.totalCostPerFlight)
        + "/flt · AS$" + fmt(cb.totalCostPerWeek) + "/wk")
    lines.push("(class cost is catering/lounge/comfort-kit per filled seat —"
        + " block-hour costs stay on the $/flt column.)")
    return lines.join("\n")
}

/**
 * Solve for the base yield (pax AS$/pax-km OR cargo AS$/kg-km) that would
 * make the rough estimator's predicted profit match the latest snapshot's
 * actual $/flt at the row's current LF / aircraft / cost mix.
 *
 *   paxRevenue   = seats   × paxLF   × effPaxYield   × distRT × yieldMult
 *   cargoRevenue = cargoCap × cargoLF × effCargoYield × distRT × yieldMult
 *   actualProfit + totalCost = paxRevenue + cargoRevenue          (target)
 *
 * Each side's variant holds the OTHER side at its current revenue
 * contribution and solves the subtracted equation.
 *
 * Returns {side, value, alt}:
 *   side  — "pax" | "cargo", auto-selected primary side.
 *   value — base yield ready to pin as a route override.
 *   alt   — {side, value} when the other side also solves cleanly (mixed
 *           routes), null otherwise.
 * Returns null when neither side is solvable (no breakdown, zero LF /
 * distance, or resulting yield non-finite / negative).
 *
 * Auto-selection rule: pick the side currently producing the larger share
 * of revenue. The Calibrate-flagged modal lets the user flip per-row
 * without recomputing — `alt` is the cached counterpart.
 */
function derivedYieldFromActuals(row) {
    if (!row) return null
    const actual = numOrNull(row.actualProfitPerFlight)
    if (actual === null) return null
    const b = row.profitBreakdown
    if (!b) return null
    const distRT = numOrNull(b.distanceRoundTripKm)
    if (!distRT || distRT <= 0) return null
    const yMult = numOrNull(b.yieldMultiplier) || 1
    const targetRevenue = actual + (numOrNull(b.totalCost) || 0)
    const paxRev   = numOrNull(b.paxRevenue)   || 0
    const cargoRev = numOrNull(b.cargoRevenue) || 0

    let paxResult = null
    const seats = numOrNull(b.seats)
    const paxLF = numOrNull(b.paxLoadFactor)
    if (seats && seats > 0 && paxLF && paxLF > 0) {
        const denom = seats * paxLF * distRT * yMult
        if (denom > 0) {
            const yDemand = numOrNull(b.yieldDemandMultiplier) || 1
            const eff = (targetRevenue - cargoRev) / denom
            const base = eff / (yDemand || 1)
            if (isFinite(base) && base >= 0) paxResult = {side: "pax", value: base}
        }
    }

    let cargoResult = null
    const cargoCap = numOrNull(b.cargoCapacityKg)
    const cargoLF  = numOrNull(b.cargoLoadFactor)
    if (cargoCap && cargoCap > 0 && cargoLF && cargoLF > 0) {
        const denom = cargoCap * cargoLF * distRT * yMult
        if (denom > 0) {
            const yDemand = numOrNull(b.cargoYieldDemandMultiplier) || 1
            const eff = (targetRevenue - paxRev) / denom
            const base = eff / (yDemand || 1)
            if (isFinite(base) && base >= 0) cargoResult = {side: "cargo", value: base}
        }
    }

    if (!paxResult && !cargoResult) return null
    if (paxResult && !cargoResult) return Object.assign({}, paxResult, {alt: null})
    if (!paxResult && cargoResult) return Object.assign({}, cargoResult, {alt: null})
    const primary = (paxRev >= cargoRev) ? paxResult : cargoResult
    const alt     = (primary === paxResult) ? cargoResult : paxResult
    return Object.assign({}, primary, {alt: alt})
}

/**
 * 8-step ASCII sparkline (▁▂▃▄▅▆▇█) over the snapshot $/flt timeline. Single
 * data point gets a flat bar; identical values render as the lowest cell.
 */
function formatActualsSparkline(snapshots) {
    if (!Array.isArray(snapshots) || !snapshots.length) return null
    const values = snapshots.map(s => Number(s.profitPerFlight)).filter(v => isFinite(v))
    if (!values.length) return null
    if (values.length === 1) return "▄"
    const blocks = "▁▂▃▄▅▆▇█"
    let lo = Infinity, hi = -Infinity
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v }
    if (hi === lo) return blocks[0].repeat(values.length)
    const span = hi - lo
    return values.map(v => {
        const idx = Math.min(blocks.length - 1, Math.max(0, Math.floor((v - lo) / span * (blocks.length - 1))))
        return blocks[idx]
    }).join("")
}

/**
 * One-line summary of an override record, used as the pin glyph's tooltip
 * so the user can see what's pinned without opening the editor.
 */
function formatOverrideSummary(override) {
    if (!override) return ""
    const parts = []
    if (typeof override.paxLF === "number")             parts.push("Pax LF " + override.paxLF.toFixed(2))
    if (typeof override.cargoLF === "number")           parts.push("Cargo LF " + override.cargoLF.toFixed(2))
    if (typeof override.yieldPerKm === "number")        parts.push("Yield AS$" + override.yieldPerKm.toFixed(3) + "/pax-km")
    if (typeof override.cargoYieldPerKgKm === "number") parts.push("Cargo AS$" + override.cargoYieldPerKgKm.toFixed(4) + "/kg-km")
    let s = "Override: " + (parts.length ? parts.join(" · ") : "(no values)")
    if (override.note) s += "\n— " + override.note
    return s
}

/**
 * Multi-line tooltip body for the colored Cmp pill — Letter F.
 *
 * Source-of-truth priority:
 *   1. AS market-share data (`row.marketSharePax`) — preferred when
 *      present. Real AS competitors with `enterpriseId` (so we can
 *      build a link), share %, and rank ordering. Native `title=""` is
 *      plain text only, so the IDs are mentioned but NOT clickable —
 *      that ships in F slice 2 (custom DOM popover).
 *   2. flightsfrom carrier list (`carriers` arg) — real-world airlines.
 *      Used when AS market-share hasn't been scraped for this route yet.
 *   3. Fallback messaging when neither source is populated.
 */
function formatCarriersTooltip(row, carriers, intensity) {
    const lines = []
    const intensityLabel = intensity ? intensity.toUpperCase() + " competition" : ""

    const asShares = Array.isArray(row.marketSharePax) ? row.marketSharePax : []
    if (asShares.length) {
        // Primary path: AS-native competitor list.
        const period = row.marketSharePeriod ? " · " + row.marketSharePeriod : ""
        lines.push(asShares.length + " AS competitor" + (asShares.length === 1 ? "" : "s")
            + period + (intensityLabel ? " · " + intensityLabel : ""))
        lines.push("")
        const ordered = asShares.slice().sort((a, b) => (b.sharePct || 0) - (a.sharePct || 0))
        const cap = Math.min(ordered.length, 12)
        for (let i = 0; i < cap; i++) {
            const e = ordered[i]
            const name = e.name || "(unknown)"
            const share = (e.sharePct != null) ? " — " + e.sharePct.toFixed(1) + "%" : ""
            const id    = (e.enterpriseId != null) ? "  [#" + e.enterpriseId + "]" : ""
            lines.push("  • " + name + share + id)
        }
        if (ordered.length > cap) lines.push("  • +" + (ordered.length - cap) + " more")
        lines.push("")
        lines.push("(F slice 2 will turn each name into a clickable link with the AS banner + avatar.)")
        if (row.marketsScrapedAt) {
            lines.push("Last synced: " + new Date(row.marketsScrapedAt).toLocaleString())
        }
        return lines.join("\n")
    }

    // Secondary path: flightsfrom carrier list.
    const count = (row.totalAirlines != null) ? row.totalAirlines : (row.airlineCount || 0)
    const wk = row.totalCarrierFlights ? (" · " + row.totalCarrierFlights + " flights/wk") : ""
    lines.push(count + " airline" + (count === 1 ? "" : "s") + wk + (intensityLabel ? " · " + intensityLabel : ""))

    if (carriers && carriers.length) {
        lines.push("")
        const cap = Math.min(carriers.length, 12)
        for (let i = 0; i < cap; i++) {
            const c = carriers[i]
            const name = c.name || "(unknown)"
            const freq = c.weeklyFlights ? " — " + c.weeklyFlights + "/wk" : ""
            lines.push("  • " + name + freq)
        }
        if (carriers.length > cap) {
            lines.push("  • +" + (carriers.length - cap) + " more")
        }
    } else if (row.carriersScrapedAt) {
        lines.push("")
        lines.push("Scrape returned no carrier list" + (row.carriersParserNote ? " (" + row.carriersParserNote + ")" : ""))
    } else {
        lines.push("")
        lines.push("Sync flightsfrom (Carriers expander) for real-world carriers, or sync the Markets page (Market Analysis expander) for AS competitors.")
    }

    if (row.carriersScrapedAt) {
        lines.push("")
        lines.push("Last synced: " + new Date(row.carriersScrapedAt).toLocaleString())
    }
    return lines.join("\n")
}

/**
 * Inline banner for the table area. Levels: amber (informational nudge),
 * red (blocker).
 */
function makeBanner(opts) {
    const palette = {
        amber: {bg: "#3a2c11", border: "#92400e", title: "#fbbf24", body: "#fde68a"},
        red:   {bg: "#3f1d1d", border: "#7f1d1d", title: "#fca5a5", body: "#fecaca"}
    }
    const c = palette[opts.level] || palette.amber
    const box = document.createElement("div")
    box.style.cssText = `background:${c.bg};border:1px solid ${c.border};border-radius:4px;padding:8px 12px;margin:6px 0;`
    const h = document.createElement("strong")
    h.textContent = opts.title || ""
    h.style.cssText = `color:${c.title};display:block;margin-bottom:2px;font-size:12px;`
    const p = document.createElement("p")
    p.textContent = opts.body || ""
    p.style.cssText = `margin:0;color:${c.body};font-size:11px;`
    box.append(h, p)
    return box
}

// ---------- Settings export / import ----------
// JSON roundtrip for `settings.routeAssistant` + `settings.usedAircraftScanner`.
// Wrap-format envelope is `{format: "aes-config", version, exportedAt, server,
// routeAssistant, usedAircraftScanner}`. `format` is the contract import
// validates against. Missing fields fall back to defaults via per-store
// load() deep-merge.
const AES_CONFIG_FORMAT = "aes-config"

function _isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v)
}

// Paths that represent set-shaped multi-selects — order doesn't matter for
// equality, only the set of elements does. Listed by trailing key segment so
// the rule applies wherever the field shows up under the routeAssistant tree.
const _DIFF_SET_PATH_KEYS = new Set(["classesToScrape"])

function _arraysEqual(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
    }
    return true
}

function _arrayEqualsAsSet(a, b) {
    if (a.length !== b.length) return false
    const aJ = a.map(v => JSON.stringify(v)).sort()
    const bJ = b.map(v => JSON.stringify(v)).sort()
    for (let i = 0; i < aJ.length; i++) if (aJ[i] !== bJ[i]) return false
    return true
}

function _diffConfig(current, incoming, prefix) {
    const changes = []
    const cur = current || {}
    const inc = incoming || {}
    const keys = new Set([...Object.keys(cur), ...Object.keys(inc)])
    for (const k of keys) {
        const path = prefix ? prefix + "." + k : k
        const a = cur[k]
        const b = inc[k]
        const aIsObj = a && typeof a === "object" && !Array.isArray(a)
        const bIsObj = b && typeof b === "object" && !Array.isArray(b)
        const aIsArr = Array.isArray(a)
        const bIsArr = Array.isArray(b)
        if (a === undefined && b !== undefined) changes.push({path, kind: "added", to: b})
        else if (a !== undefined && b === undefined) changes.push({path, kind: "removed", from: a})
        else if (aIsObj && bIsObj) for (const c of _diffConfig(a, b, path)) changes.push(c)
        else if (aIsArr && bIsArr) {
            const setLike = _DIFF_SET_PATH_KEYS.has(k)
            const equal = setLike ? _arrayEqualsAsSet(a, b) : _arraysEqual(a, b)
            if (!equal) changes.push({path, kind: "changed", from: a, to: b})
        }
        else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({path, kind: "changed", from: a, to: b})
    }
    return changes
}

function _formatDiffValue(v) {
    if (v === null || v === undefined) return "—"
    if (typeof v === "object") {
        const json = JSON.stringify(v)
        return json.length > 60 ? json.slice(0, 57) + "…" : json
    }
    return String(v)
}
