/**
 * The in-page Used Aircraft Scanner panel — mounts on every cold load of
 * `/app/aircraft/market` (when the worker scripts aren't already commandeering
 * the tab via `#aesScan=` / `#aesGoto=`) and gives the user the full
 * deal-finding experience without leaving the market page.
 *
 * Composition:
 *   ┌ MarketPanelHeader        ── title + status + preset picker + actions
 *   ├ MarketPanelKpiStrip      ── 5 at-a-glance tiles
 *   ├ MarketPanelBestCases     ── top-N cards with rationale chips
 *   ├ MarketPanelFilterChips   ── class / age / price / extras chips + search
 *   ├ MarketScanResultsTable   ── narrow-mode table (existing module)
 *   └ Footer                   ── total + CSV export
 *
 * Data layer (all reused, no duplication):
 *   - MarketScanSession      — chrome.storage.local session + per-type blobs
 *   - ScanController         — child-tab orchestration + lease arbitration
 *   - UsedAircraftPresets    — preset CRUD + uiState
 *   - MarketScanDealClassifier — composite score + Steal/Great/... bucketing
 *   - MarketScanPriceHistory — per-type historical samples for absolute scoring
 *   - MarketScanLease        — coordinates dashboard + market-panel surfaces
 */
class MarketPanel {
    static SUPPRESS_HASHES = ["#aesScan=", "#aesGoto="]
    static PANEL_ID = "aes-marketscan-panel"

    static instance = null

    /**
     * Idempotent singleton mount. Bails when:
     *   - already mounted in this tab, or
     *   - the page is in scan/goto worker mode (the controller is driving it),
     *   - required modules aren't loaded yet (older bundles without the panel).
     */
    static async mount() {
        if (MarketPanel.instance) return MarketPanel.instance
        const hash = window.location.hash || ""
        for (const h of MarketPanel.SUPPRESS_HASHES) {
            if (hash.indexOf(h) === 0) return null
        }
        if (typeof MarketScanResultsTable === "undefined") {
            console.warn("AES marketScan panel: MarketScanResultsTable not loaded — skipping mount")
            return null
        }
        if (typeof ScanController === "undefined") {
            console.warn("AES marketScan panel: ScanController not loaded — skipping mount")
            return null
        }
        if (document.readyState === "loading") {
            await new Promise(r => document.addEventListener("DOMContentLoaded", r, {once: true}))
        }
        const inst = new MarketPanel()
        MarketPanel.instance = inst
        await inst.init()
        return inst
    }

    constructor() {
        this.server = window.location.hostname.split(".")[0]
        this.controller = null
        this.rows = []
        this.settings = {}
        this.uiState = MarketPanel._defaultUiState()
        this.fleetByType = null
        this.fuelCtx = null
        this.disposed = false
        this.storageListener = null
        this._refreshTimer = null
        this._scoringSaveTimer = null
        this._scoringPending = null
    }

    static _defaultUiState() {
        return {
            collapsed:      false,
            classes:        new Set(),
            ageBracket:     null,
            priceBracket:   null,
            fitsFleet:      false,
            expiringSoon:   false,
            hasHistory:     false,
            search:         "",
            sort:           "score-desc",
            presetId:       null,
            scanCurrent:    false,
            scoringOpen:    false
        }
    }

    async init() {
        // settings.usedAircraftScanner.marketUiState is the panel's slice of
        // the shared scanner settings blob; the dashboard tile keeps its own
        // sub-keys (uiState, presets) so the surfaces don't clobber each
        // other. Cleanup + fleet load run in parallel with the settings
        // read — none of them depend on each other.
        const [settings] = await Promise.all([
            UsedAircraftPresets.load().catch(e => {
                console.error("AES marketScan panel: settings load failed:", e)
                return {}
            }),
            this._loadFleetContext()
        ])
        this.settings = settings || {}
        if (typeof MarketScanPriceHistory !== "undefined") {
            MarketScanPriceHistory.cleanup(this.server).catch(() => {})
        }

        const restored = this.settings.marketUiState || {}
        const scoringOpenSaved = this.settings.uiState && this.settings.uiState.scoringOpen
        this.uiState = Object.assign(
            MarketPanel._defaultUiState(),
            restored,
            {
                classes:     new Set(restored.classes || []),
                scoringOpen: !!scoringOpenSaved
            }
        )

        this.controller = new ScanController(this.server)
        this.controller.onUpdate(() => this._renderHeader())

        this._buildShell()
        this._installStorageListener()

        if (this.settings.lastScanId) {
            await this.controller.resume(this.settings.lastScanId)
            await this._reloadRowsAndRender()
        } else {
            this._render()
        }
    }

    async _loadFleetContext() {
        if (typeof RouteAssistantFleetStore === "undefined") return
        try {
            const map = await RouteAssistantFleetStore.byTypeId(this.server)
            if (map && (map.size || Object.keys(map).length)) this.fleetByType = map
        } catch (e) {
            this.fleetByType = null
        }
    }

    _buildShell() {
        const root = document.createElement("div")
        root.id = MarketPanel.PANEL_ID
        root.className = "aes-panel"
        const initialWidth = MarketPanel._readPanelWidth(this.settings)
        Object.assign(root.style, {
            position:      "fixed",
            right:         "16px",
            bottom:        "16px",
            width:         initialWidth + "px",
            maxWidth:      "calc(100vw - 32px)",
            maxHeight:     "92vh",
            zIndex:        "9999",
            display:       "flex",
            flexDirection: "column",
            overflow:      "hidden"
        })
        document.body.appendChild(root)
        this.root = root

        this._installResizeHandle()

        this.headerEl = document.createElement("div")
        root.append(this.headerEl)

        this.bodyEl = document.createElement("div")
        Object.assign(this.bodyEl.style, {
            flex:          "1 1 auto",
            overflow:      "auto",
            display:       "flex",
            flexDirection: "column"
        })
        root.append(this.bodyEl)

        this.kpiEl = document.createElement("div")
        this.scoringEl = document.createElement("div")
        this.bestCasesEl = document.createElement("div")
        this.filterEl = document.createElement("div")
        this.tableEl = document.createElement("div")
        this.tableEl.style.cssText = "padding:0 6px 6px;"
        this.bodyEl.append(this.kpiEl, this.scoringEl, this.bestCasesEl, this.filterEl, this.tableEl)

        this.footerEl = document.createElement("div")
        this.footerEl.className = "aes-panel__footer"
        this.footerEl.style.cssText = "flex:0 0 auto;text-transform:none;"
        root.append(this.footerEl)

        this.table = new MarketScanResultsTable(this.tableEl)
        this.table.setNarrowMode(true)
        if (this.settings.typeFamilyOverrides) {
            this.table.setOverrides(this.settings.typeFamilyOverrides)
        }
    }

    static _readPanelWidth(settings) {
        const w = settings && settings.marketUiState && Number(settings.marketUiState.panelWidth)
        if (isFinite(w) && w >= 360) {
            const max = Math.max(360, window.innerWidth - 32)
            return Math.min(w, max)
        }
        return 480
    }

    _installResizeHandle() {
        const handle = document.createElement("div")
        Object.assign(handle.style, {
            position:   "absolute",
            top:        "0",
            left:       "0",
            width:      "6px",
            height:     "100%",
            cursor:     "ew-resize",
            zIndex:     "10000",
            background: "transparent"
        })
        handle.title = "Drag to resize"
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault()
            const startX = e.clientX
            const startW = this.root.offsetWidth
            const onMove = (ev) => {
                const dx = startX - ev.clientX
                const next = Math.max(360, Math.min(window.innerWidth - 32, startW + dx))
                this.root.style.width = next + "px"
            }
            const onUp = () => {
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
                document.body.style.userSelect = ""
                this._persistUiState({panelWidth: this.root.offsetWidth})
            }
            document.body.style.userSelect = "none"
            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })
        this.root.append(handle)
    }

    _installStorageListener() {
        if (this.storageListener) return
        this.storageListener = (changes, area) => {
            if (area !== "local") return
            // Any per-type result blob change → reload aggregated rows.
            const session = this.controller && this.controller.session
            if (!session) return
            const prefix = session.server + "marketScan:" + session.scanId + ":r:"
            for (const k in changes) {
                if (k.indexOf(prefix) === 0) {
                    this._scheduleReload()
                    return
                }
            }
        }
        chrome.storage.onChanged.addListener(this.storageListener)
    }

    _scheduleReload() {
        if (this._refreshTimer) clearTimeout(this._refreshTimer)
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null
            this._reloadRowsAndRender().catch(e => console.error(e))
        }, 200)
    }

    async _reloadRowsAndRender() {
        if (!this.controller || !this.controller.session) { this._render(); return }
        const raw = await this.controller.aggregatedRows()
        const deduped = MarketPanel._dedup(raw)
        const overrides = this.settings.typeFamilyOverrides || {}
        this.fuelCtx = await this._buildFuelCtx()
        if (typeof MarketScanDealMetrics !== "undefined") {
            const decorateCtx = this._decorateCtx()
            for (const r of deduped) {
                MarketScanDealMetrics.decorate(r, decorateCtx)
                const family = TypeFamilyMap.resolve(r.aircraftType, overrides)
                r.familyName = family || ""
                r.familyCategory = TypeFamilyMap.category(r.familyName)
                r._familyColor = TypeFamilyMap.categoryColor(r.familyCategory)
            }
        }
        this.rows = deduped
        if (typeof MarketScanDealClassifier !== "undefined") {
            const classifier = await MarketScanDealClassifier.build(
                this.server, deduped, this._classifierOpts())
            classifier.decorateAll(deduped)
            this.table.setClassifier(classifier)
        }
        this._render()
        // When a scan finishes, the storage write that triggered this
        // reload also bumped the price history; nothing else to do here.
    }

    _decorateCtx() {
        return {
            fleetByType: this.fleetByType,
            economics:   this.raEconomics || null,
            leaseConfig: this.settings.leaseConfig || null,
            fuelCtx:     this.fuelCtx
        }
    }

    _classifierOpts() {
        const cw = this.settings.classifierWeights || {}
        return {
            weights:     cw,
            enabled:     cw.enabled,
            leaseConfig: this.settings.leaseConfig || null
        }
    }

    /**
     * Resolve the fuel-price context the scanner needs to compute fuel-cost
     * per-seat-km. Sources, in priority order:
     *   1. fuelConfig.overrideFuelPriceASc — explicit user pin
     *   2. RouteAssistant fuel-price scraper cache (live ASc$/l from AS)
     *   3. economics.fuelPriceBaselineValue when its unit is ASc$/l
     * When none resolve, returns {fuelPriceASc: null} so the fuel component
     * silently drops out of the score blend instead of synthesising values.
     *
     * Loads RouteAssistantSettings.economics here too so the break-even
     * estimator gets fed without each row having to read settings itself.
     */
    async _buildFuelCtx() {
        let economics = null
        if (typeof RouteAssistantSettings !== "undefined") {
            try {
                const ra = await RouteAssistantSettings.load()
                economics = (ra && ra.economics) || null
            } catch (_) { /* RA may not be initialised yet — ignore */ }
        }
        this.raEconomics = economics

        const fuelCfg = this.settings.fuelConfig || {}
        let priceASc = numOrNullPanel(fuelCfg.overrideFuelPriceASc)
        if (priceASc === null) {
            try {
                const cached = await chrome.storage.local.get(["routeAssistant:fuelPriceIndex"])
                const rec = cached["routeAssistant:fuelPriceIndex"]
                if (rec && rec.unit === "ASc$/l") priceASc = numOrNullPanel(rec.value)
            } catch (_) { /* storage hiccup — fall through */ }
        }
        if (priceASc === null && economics
            && economics.fuelPriceBaselineUnit === "ASc$/l") {
            priceASc = numOrNullPanel(economics.fuelPriceBaselineValue)
        }
        const agePenalty = economics
            ? numOrNullPanel(economics.fuelAgePenaltyPerYear)
            : null
        return {
            fuelPriceASc:          priceASc,
            fuelAgePenaltyPerYear: agePenalty !== null ? agePenalty : 0
        }
    }

    static _dedup(rows) {
        const byKey = new Map()
        for (const r of rows) {
            if (!r) continue
            const key = (r.typeId || r.aircraftType || "?")
                + "|" + (r.registration || "?")
                + "|" + (r.owner || "?")
            if (!byKey.has(key)) byKey.set(key, r)
        }
        return Array.from(byKey.values())
    }

    _render() {
        if (this.disposed || !this.root) return
        this._renderHeader()
        this._renderBody()
    }

    _renderHeader() {
        if (this.disposed || !this.headerEl) return
        MarketPanelHeader.render(this.headerEl, this._headerData(), {
            onScan:           () => this._onScan(),
            onCancel:         () => this._onCancel(),
            onRefresh:        () => this._onRefresh(),
            onPresetChange:   v => this._onPresetChange(v),
            onToggleCollapse: () => this._toggleCollapse()
        })
    }

    _renderBody() {
        if (this.disposed || !this.bodyEl) return
        const showBody = !this.uiState.collapsed
        this.bodyEl.style.display = showBody ? "flex" : "none"
        this.footerEl.style.display = showBody ? "flex" : "none"
        if (!showBody) return

        const filtered = MarketPanelFilterChips.apply(this.rows, this.uiState)

        MarketPanelKpiStrip.render(this.kpiEl, MarketPanelKpiStrip.compute(filtered))
        this._renderScoring()

        const session = this.controller && this.controller.session
        const bestEmptyText = this.rows.length
            ? (filtered.length ? "All visible offers fall in Pass." : "No offers match the current filters.")
            : (session && session.status === "running"
                ? "Scanning… deals will appear here as they stream in."
                : "Run a scan to see ranked deals here.")
        MarketPanelBestCases.render(this.bestCasesEl,
            Object.assign({emptyText: bestEmptyText},
                MarketPanelBestCases.compute(filtered)),
            {})

        MarketPanelFilterChips.render(this.filterEl, this.uiState, {
            onChange: () => {
                this._persistUiState({})
                this._renderBody()
            }
        })

        const sort = MarketPanelFilterChips.lookupSort(this.uiState.sort)
        this.table.sortField = sort.field === "score" ? "dealScore" : sort.field
        this.table.sortDir   = sort.dir
        this.table.render(filtered)

        this._renderFooter(filtered)
    }

    _renderScoring() {
        if (typeof MarketPanelScoringControls === "undefined" || !this.scoringEl) return
        MarketPanelScoringControls.render(this.scoringEl, {
            weights:     this.settings.classifierWeights,
            enabled:     this.settings.classifierWeights && this.settings.classifierWeights.enabled,
            leaseConfig: this.settings.leaseConfig,
            fuelConfig:  this.settings.fuelConfig,
            open:        !!this.uiState.scoringOpen
        }, {
            onChange:      partial => this._onScoringChange(partial),
            onReset:       ()      => this._onScoringReset(),
            onToggleOpen:  ()      => this._onScoringToggleOpen()
        })
    }

    _onScoringToggleOpen() {
        this.uiState.scoringOpen = !this.uiState.scoringOpen
        // Persist in the shared uiState block (not marketUiState) so the
        // dashboard tile sees the same state if it ever surfaces this toggle.
        const persisted = Object.assign({}, this.settings.uiState || {},
            {scoringOpen: this.uiState.scoringOpen})
        this.settings.uiState = persisted
        UsedAircraftPresets.save({uiState: persisted}).catch(() => {})
        this._renderScoring()
    }

    /**
     * Live re-score handler. Receives a partial scoring delta; merges it into
     * this.settings, debounces the storage write, and immediately re-decorates
     * + re-classifies the cached rows so the panel reorders without rescan.
     *
     * Lease/fuel-config changes flip the price basis, so they require a full
     * re-decorate. Pure weight changes only need a classifier rebuild — the
     * row metrics don't move when only weights shift.
     */
    _onScoringChange(partial) {
        if (!partial) return
        const next = MarketPanel._mergeScoringPartial(this.settings, partial)
        this.settings.classifierWeights = next.classifierWeights
        this.settings.leaseConfig       = next.leaseConfig
        this.settings.fuelConfig        = next.fuelConfig

        const needsDecorate = !!(partial.leaseConfig || partial.fuelConfig)
        this._reclassifyCachedRows(needsDecorate).catch(e =>
            console.error("AES marketScan panel: live re-score failed:", e))

        // Debounce the storage write so a slider drag doesn't hit storage
        // every frame — the in-memory re-render is what the user feels;
        // persistence can land 150 ms later.
        this._scoringPending = Object.assign(this._scoringPending || {}, {
            classifierWeights: this.settings.classifierWeights,
            leaseConfig:       this.settings.leaseConfig,
            fuelConfig:        this.settings.fuelConfig
        })
        if (this._scoringSaveTimer) clearTimeout(this._scoringSaveTimer)
        this._scoringSaveTimer = setTimeout(() => {
            this._scoringSaveTimer = null
            const blob = this._scoringPending
            this._scoringPending = null
            if (blob) UsedAircraftPresets.save(blob).catch(() => {})
        }, 150)

        this._renderScoring()
    }

    async _reclassifyCachedRows(needsDecorate) {
        if (!Array.isArray(this.rows) || !this.rows.length) return
        if (needsDecorate && typeof MarketScanDealMetrics !== "undefined") {
            this.fuelCtx = await this._buildFuelCtx()
            const ctx = this._decorateCtx()
            for (const r of this.rows) MarketScanDealMetrics.decorate(r, ctx)
        }
        if (typeof MarketScanDealClassifier !== "undefined") {
            const c = await MarketScanDealClassifier.build(
                this.server, this.rows, this._classifierOpts())
            c.decorateAll(this.rows)
            this.table.setClassifier(c)
        }
        this._renderBody()
    }

    async _onScoringReset() {
        const defaults = UsedAircraftPresets._defaults()
        const blob = {
            classifierWeights: defaults.classifierWeights,
            leaseConfig:       defaults.leaseConfig,
            fuelConfig:        defaults.fuelConfig
        }
        this.settings.classifierWeights = blob.classifierWeights
        this.settings.leaseConfig       = blob.leaseConfig
        this.settings.fuelConfig        = blob.fuelConfig
        if (this._scoringSaveTimer) {
            clearTimeout(this._scoringSaveTimer)
            this._scoringSaveTimer = null
        }
        this._scoringPending = null
        try { await UsedAircraftPresets.save(blob) }
        catch (e) { console.error("AES marketScan panel: reset save failed:", e) }
        await this._reclassifyCachedRows(true)
        this._renderScoring()
    }

    /**
     * Deep-merge a {classifierWeights, leaseConfig, fuelConfig} partial into
     * the current settings. Returns a fresh blob suitable for assigning back
     * onto `this.settings` and persisting wholesale. The classifierWeights
     * sub-object's `enabled` map is sub-merged so flipping one component's
     * checkbox doesn't drop the other entries.
     */
    static _mergeScoringPartial(current, partial) {
        const cur = current || {}
        const baseWeights = cur.classifierWeights || {}
        const baseEnabled = baseWeights.enabled || {}
        const newWeights = Object.assign({}, baseWeights, partial.classifierWeights || {})
        if (partial.classifierWeights && partial.classifierWeights.enabled) {
            newWeights.enabled = Object.assign({}, baseEnabled, partial.classifierWeights.enabled)
        } else {
            newWeights.enabled = Object.assign({}, baseEnabled)
        }
        return {
            classifierWeights: newWeights,
            leaseConfig: Object.assign({}, cur.leaseConfig || {}, partial.leaseConfig || {}),
            fuelConfig:  Object.assign({}, cur.fuelConfig  || {}, partial.fuelConfig  || {})
        }
    }

    _renderFooter(filteredRows) {
        this.footerEl.innerHTML = ""

        const count = document.createElement("span")
        count.textContent = filteredRows.length + " of " + this.rows.length + " offers"
        count.style.cssText = "flex:1 1 auto;text-transform:none;letter-spacing:0;"
        this.footerEl.append(count)

        const csv = document.createElement("button")
        csv.type = "button"
        csv.className = "aes-btn aes-btn--sm"
        csv.textContent = "Download CSV"
        csv.disabled = !filteredRows.length
        if (filteredRows.length) {
            csv.addEventListener("click", () => {
                this.table.downloadCsv("aes-market-scan-" + Date.now() + ".csv")
            })
        }
        this.footerEl.append(csv)
    }

    _headerData() {
        const session = this.controller && this.controller.session
        const status = session ? session.status : null
        const queue = session ? session.queue : []
        const completed = queue.filter(e =>
            e.status !== "pending" && e.status !== "inflight").length
        const inFlight = queue.filter(e => e.status === "inflight").length
        const total = queue.length
        const lastScannedAgo = session
            ? MarketPanel._timeAgo(session.finishedAt || session.startedAt)
            : null
        const presets = this.settings.presets || []
        const scanCurrentLabel = this._scanCurrentLabel()
        return {
            status:     status,
            mirror:     this.controller && this.controller.isMirror(),
            collapsed:  !!this.uiState.collapsed,
            scanId:     session ? session.scanId : null,
            totalRows:  this.rows.length,
            progress:   {completed, inFlight, total},
            lastScannedAgo: lastScannedAgo,
            presets:    presets,
            presetId:   this.uiState.presetId,
            scanCurrentLabel:    scanCurrentLabel,
            scanCurrentSelected: this.uiState.scanCurrent,
            canScan: !!(scanCurrentLabel
                || (this.uiState.presetId && presets.find(p => p.id === this.uiState.presetId))),
            canRefresh: !!(session && session.presetId
                && presets.find(p => p.id === session.presetId))
        }
    }

    /**
     * If the user has set Family + Type on the AS native filters, returns
     * a label like "Scan: Boeing 737-800" so the panel can offer a one-shot
     * scan of exactly what they're looking at.
     */
    _scanCurrentLabel() {
        const familyEl = document.querySelector("select[name='tab:panel:filter-aircraftFamily']")
        const typeEl   = document.querySelector("select[name='tab:panel:filter-aircraftType']")
        const family = familyEl && familyEl.options[familyEl.selectedIndex]
            ? (familyEl.options[familyEl.selectedIndex].textContent || "").trim()
            : ""
        const type = typeEl && typeEl.options[typeEl.selectedIndex]
            ? (typeEl.options[typeEl.selectedIndex].textContent || "").trim()
            : ""
        if (!family || family.toLowerCase() === "any aircraft family") return null
        if (!type || type.toLowerCase().indexOf("any") === 0) return null
        return "Scan this view (" + type + ")"
    }

    _onPresetChange(value) {
        if (value === "__current__") {
            this.uiState.presetId = null
            this.uiState.scanCurrent = true
        } else {
            this.uiState.presetId = value || null
            this.uiState.scanCurrent = false
        }
        this._persistUiState({})
        this._render()
    }

    _scanOpts() {
        return {
            concurrency:         this.settings.concurrency || 6,
            staggerMs:           this.settings.staggerMs   || 2000,
            typeFamilyOverrides: this.settings.typeFamilyOverrides || {}
        }
    }

    async _onScan() {
        const running = this.controller && this.controller.session
            && this.controller.session.status === "running"
        if (running) return
        let preset = null
        if (this.uiState.scanCurrent) {
            const typeEl = document.querySelector("select[name='tab:panel:filter-aircraftType']")
            const type = typeEl && typeEl.options[typeEl.selectedIndex]
                ? (typeEl.options[typeEl.selectedIndex].textContent || "").trim()
                : null
            if (!type) return
            preset = {id: "__synthetic__", name: type, types: [type]}
        } else if (this.uiState.presetId) {
            preset = (this.settings.presets || []).find(p => p.id === this.uiState.presetId) || null
        }
        if (!preset) return
        try { await this.controller.start(preset, this._scanOpts()) }
        catch (e) { console.error("AES marketScan panel: start() failed:", e) }
    }

    async _onCancel() {
        if (!this.controller) return
        try { await this.controller.cancel() }
        catch (e) { console.error("AES marketScan panel: cancel() failed:", e) }
    }

    async _onRefresh() {
        const session = this.controller && this.controller.session
        if (!session || !session.presetId) return
        const preset = (this.settings.presets || []).find(p => p.id === session.presetId)
        if (!preset) return
        try { await this.controller.start(preset, this._scanOpts()) }
        catch (e) { console.error("AES marketScan panel: refresh() failed:", e) }
    }

    _toggleCollapse() {
        this.uiState.collapsed = !this.uiState.collapsed
        this._persistUiState({})
        this._render()
    }

    /**
     * Persist the panel's UI state under settings.usedAircraftScanner.marketUiState
     * so reloads / Wicket navs restore the same chips, sort, search, width.
     * Sets are serialised to arrays for storage.
     */
    _persistUiState(extra) {
        const blob = {
            collapsed:    this.uiState.collapsed,
            classes:      Array.from(this.uiState.classes || []),
            ageBracket:   this.uiState.ageBracket,
            priceBracket: this.uiState.priceBracket,
            fitsFleet:    this.uiState.fitsFleet,
            expiringSoon: this.uiState.expiringSoon,
            hasHistory:   this.uiState.hasHistory,
            search:       this.uiState.search,
            sort:         this.uiState.sort,
            presetId:     this.uiState.presetId,
            scanCurrent:  this.uiState.scanCurrent,
            panelWidth:   this.root ? this.root.offsetWidth : null
        }
        Object.assign(blob, extra || {})
        UsedAircraftPresets.save({marketUiState: blob}).catch(() => {})
    }

    static _timeAgo(t) {
        if (!t) return "—"
        const s = Math.max(0, Math.round((Date.now() - t) / 1000))
        if (s < 60)   return s + "s ago"
        if (s < 3600) return Math.round(s / 60) + "m ago"
        if (s < 86400) return Math.round(s / 3600) + "h ago"
        return Math.round(s / 86400) + "d ago"
    }
}

function numOrNullPanel(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanel
