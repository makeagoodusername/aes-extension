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
        this._busOffs = []
        this._busReloadTimer = null
        // Idempotency cursor for watchlist notifications. Stamped after
        // each scan so re-renders triggered by storage churn don't fire
        // the same chrome notification twice.
        this._notifiedScanId = null
        this._scheduleTimer = null
        // Diff cursor + cache. `_diffedScanId` keeps compute idempotent
        // per scan; `lastDiff` is what the panel + tile read for "since
        // last scan" rendering.
        this._diffedScanId = null
        this.lastDiff = null
        // Bid-intent context surfaced on the model-overview cards. Map
        // form lets `_card` look up by row key in O(1).
        this.intentByKey = new Map()
    }

    async _loadIntents() {
        if (typeof BidIntentStore === "undefined") return
        try {
            const list = await BidIntentStore.loadAll(this.server)
            const map = new Map()
            for (const r of list) if (r && r.key) map.set(r.key, r)
            this.intentByKey = map
        } catch (e) {
            this.intentByKey = new Map()
        }
    }

    /**
     * Strip every view filter (deal class, age/price brackets, booleans,
     * search) from a uiState clone, leaving only the scope chips. Used to
     * feed the model-overview so the at-a-glance card grid reflects the
     * scanned pool — independent of which rows the table currently shows.
     */
    static _scopeOnlyState(state) {
        return {
            categories:    state.categories    instanceof Set ? state.categories    : new Set(),
            families:      state.families      instanceof Set ? state.families      : new Set(),
            manufacturers: state.manufacturers instanceof Set ? state.manufacturers : new Set(),
            types:         state.types         instanceof Set ? state.types         : new Set(),
            classes:       new Set(),
            ageBracket:    null,
            priceBracket:  null,
            fitsFleet:     false,
            fitsCash:      false,
            expiringSoon:  false,
            hasHistory:    false,
            search:        "",
            sort:          state.sort || "score-desc"
        }
    }

    static _defaultUiState() {
        return {
            collapsed:      false,
            classes:        new Set(),
            categories:     new Set(),
            families:       new Set(),
            manufacturers:  new Set(),
            types:          new Set(),
            ageBracket:     null,
            priceBracket:   null,
            fitsFleet:      false,
            fitsCash:       false,
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
        // Cash read runs after fleet so it can reuse fleetAirline for the
        // snapshot fallback. Cheap (single DOM query in the live path).
        await this._loadCashContext()
        await this._loadIntents()
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
                classes:       new Set(restored.classes       || []),
                categories:    new Set(restored.categories    || []),
                families:      new Set(restored.families      || []),
                manufacturers: new Set(restored.manufacturers || []),
                types:         new Set(restored.types         || []),
                scoringOpen:   !!scoringOpenSaved
            }
        )

        this.controller = new ScanController(this.server)
        this.controller.onUpdate(() => this._renderHeader())

        this._buildShell()
        this._installStorageListener()
        this._installViewSubscriptions()

        if (this.settings.lastScanId) {
            await this.controller.resume(this.settings.lastScanId)
            await this._reloadRowsAndRender()
        } else {
            this._render()
        }

        this._installScheduleTick()
    }

    /**
     * Tab-bound auto-rescan tick. Polls every 60s while the market tab is
     * mounted and kicks off a scan when settings.schedule says it's time.
     * Honest scope: only ticks while this panel is alive — the user has to
     * keep a market tab open. A full background-SW scheduler would need
     * cross-tab orchestration we don't have plumbing for yet.
     */
    _installScheduleTick() {
        if (this._scheduleTimer) return
        const tick = () => this._maybeAutoRescan().catch(e =>
            console.warn("AES marketScan panel: auto-rescan tick failed:", e))
        this._scheduleTimer = setInterval(tick, 60 * 1000)
        // Run once shortly after mount so a long-overdue rescan kicks
        // without waiting a minute.
        setTimeout(tick, 5 * 1000)
    }

    async _maybeAutoRescan() {
        if (this.disposed) return
        const sched = this.settings.schedule || {}
        if (!sched.enabled) return
        const cadenceMs = Math.max(1, Number(sched.cadenceMin) || 60) * 60 * 1000
        const last = Number(sched.lastRunAt) || 0
        if (Date.now() - last < cadenceMs) return
        const session = this.controller && this.controller.session
        if (session && session.status === "running") return
        const preset = (this.settings.presets || []).find(p => p.id === sched.presetId)
        if (!preset) return
        try {
            await this.controller.start(preset, this._scanOpts())
            const next = Object.assign({}, sched, {lastRunAt: Date.now()})
            this.settings.schedule = next
            await UsedAircraftPresets.save({schedule: next})
            this._renderHeader()
        } catch (e) {
            console.error("AES marketScan panel: auto-rescan start failed:", e)
        }
    }

    /**
     * Slice-2 — declare `scanner:fuel-context` as a reactive view. The
     * view's compute reads RouteAssistantSettings.economics + the fuel-price
     * scraper cache and returns the bus-derived inputs the scoring pipeline
     * needs ({fuelPriceASc, fuelAgePenaltyPerYear, raEconomics}). Whenever
     * either dep topic fires, the engine re-runs compute, caches the value,
     * and emits `view:scanner:fuel-context:computed` — the panel's
     * subscription kicks off `_reclassifyCachedRows(true)` and the table
     * reorders without a rescan.
     *
     * Replaces the prior hand-rolled subscribe-debounce pattern. Same
     * effective behaviour, but the engine handles the debounce, microtask
     * coalescing, error surfacing, and exposes the view to the dashboard
     * inspector tile for live observation.
     */
    _installViewSubscriptions() {
        if (typeof AesView === "undefined") return
        AesView.declare({
            name:       "scanner:fuel-context",
            deps:       ["data:route-assistant:settings:saved",
                         "data:route-assistant:fuel-price:updated"],
            debounceMs: 150,
            compute:    async () => MarketPanel._computeFuelContextView()
        })
        this._busOffs.push(AesView.subscribe("scanner:fuel-context", (e) => {
            if (this.disposed) return
            if (!this.rows || !this.rows.length) return
            if (e.error) {
                // Compute failed upstream — fall through; _reclassifyCachedRows
                // will rebuild ctx itself via the inline path in _buildFuelCtx.
                console.warn("AES marketScan panel: fuel-context view error:", e.error)
            }
            this._reclassifyCachedRows(true).catch(err =>
                console.error("AES marketScan panel: bus-driven re-decorate failed:", err))
        }))
    }

    /**
     * Pure compute backing `scanner:fuel-context`. Static so it can run
     * outside any panel instance (the view engine doesn't know about
     * panels). The panel's `_buildFuelCtx` layers its UI override
     * (overrideFuelPriceASc) on top of this baseline at read time.
     */
    static async _computeFuelContextView() {
        let economics = null
        if (typeof RouteAssistantSettings !== "undefined") {
            try {
                const ra = await RouteAssistantSettings.load()
                economics = (ra && ra.economics) || null
            } catch (_) { /* RA may not be initialised yet — ignore */ }
        }
        let priceASc = null
        if (typeof RouteAssistantFuelPriceScraper !== "undefined") {
            try {
                const rec = await RouteAssistantFuelPriceScraper.getCachedFresh()
                if (rec && rec.unit === "ASc$/l") priceASc = numOrNullPanel(rec.value)
            } catch (_) { /* fall through */ }
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
            fuelAgePenaltyPerYear: agePenalty !== null ? agePenalty : 0,
            raEconomics:           economics
        }
    }

    async _loadFleetContext() {
        if (typeof RouteAssistantFleetStore === "undefined") return
        try {
            const fleet = await RouteAssistantFleetStore.loadFleet(this.server)
            if (fleet && fleet.byType && fleet.byType.size) {
                this.fleetByType    = fleet.byType
                this.fleetAirline   = fleet.airline || ""
                this.fleetAmbiguous = !!fleet.ambiguous
            }
        } catch (e) {
            this.fleetByType = null
        }
    }

    /**
     * Resolve the user's current cash on hand for affordability badges.
     * Primary source: the AS navbar's `.balance` element which is rendered
     * on every authenticated page (we're on `/app/aircraft/market`, so it's
     * right there) — this is the freshest figure, no scraping required.
     * Fallback: AccountingSnapshotStore.loadLatest, which carries a stale
     * but stable cashBalance from the user's last visit to /app/finance.
     *
     * Stamps {cash, source: "live"|"snapshot", scrapedAt, weekId} so the
     * card tooltip can disclose the freshness without lying about it.
     */
    async _loadCashContext() {
        const liveCash = MarketPanel._readNavbarCash()
        if (liveCash !== null) {
            this.cashCtx = {cash: liveCash, source: "live", scrapedAt: Date.now(), weekId: null}
            return
        }
        if (typeof AccountingSnapshotStore === "undefined") return
        try {
            const airline = this.fleetAirline || ""
            const snap = await AccountingSnapshotStore.loadLatest(this.server, airline)
            const bank = snap && snap.bank
            const payload = bank && bank.payload
            const cash = payload && Number(payload.cashBalance)
            if (!isFinite(cash)) return
            this.cashCtx = {
                cash:      cash,
                source:    "snapshot",
                scrapedAt: bank.scrapedAt || (payload && payload.scrapedAt) || null,
                weekId:    bank.weekId || null
            }
        } catch (_) { this.cashCtx = null }
    }

    static _readNavbarCash() {
        const el = document.querySelector(".as-navbar-main .balance")
        if (!el) return null
        const text = (el.textContent || "").trim()
        if (!text) return null
        if (typeof AES === "undefined" || typeof AES.cleanInteger !== "function") return null
        const v = AES.cleanInteger(text)
        return isFinite(v) ? v : null
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
        this._applyHostInset()

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
        this.diffStripEl = document.createElement("div")
        this.scoringEl = document.createElement("div")
        this.bestCasesEl = document.createElement("div")
        this.modelOverviewEl = document.createElement("div")
        this.filterEl = document.createElement("div")
        this.emptyHintEl = document.createElement("div")
        this.tableEl = document.createElement("div")
        this.tableEl.style.cssText = "padding:0 6px 6px;"
        this.bodyEl.append(this.kpiEl, this.diffStripEl, this.scoringEl,
            this.bestCasesEl, this.modelOverviewEl,
            this.filterEl, this.emptyHintEl, this.tableEl)

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
        const max = Math.max(360, window.innerWidth - 32)
        const w = settings && settings.marketUiState && Number(settings.marketUiState.panelWidth)
        if (isFinite(w) && w >= 360) return Math.min(w, max)
        // Default to half the viewport so the panel reads as a side-by-side
        // dashboard rather than a small drawer. Clamped to [480, viewport-32]
        // so it stays usable on narrow windows and never overflows.
        return Math.max(480, Math.min(Math.round(window.innerWidth / 2), max))
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
                this._applyHostInset()
            }
            const onUp = () => {
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
                document.body.style.userSelect = ""
                this._persistUiState({panelWidth: this.root.offsetWidth})
                this._applyHostInset()
            }
            document.body.style.userSelect = "none"
            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })
        this.root.append(handle)
    }

    /**
     * Reserve right-edge space on <body> equal to the panel's footprint
     * so the underlying AS market table reflows to the left half and its
     * offer rows / Place Bid buttons stay clickable instead of being
     * hidden behind the panel. Cleared when collapsed (the user has
     * traded panel space for page space).
     *
     * Page navigation blasts the DOM anyway, so we don't need a separate
     * teardown — but we still clear when the panel collapses so a
     * minimised panel doesn't keep stealing layout.
     */
    _applyHostInset() {
        if (!this.root) return
        if (this.uiState.collapsed) {
            document.body.style.paddingRight = ""
            return
        }
        const w = this.root.offsetWidth
        if (!w) { document.body.style.paddingRight = ""; return }
        document.body.style.paddingRight = (w + 32) + "px"
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
                r.manufacturer = TypeFamilyMap.manufacturer(r.aircraftType)
            }
        }
        this.rows = deduped
        if (typeof MarketScanDealClassifier !== "undefined") {
            const classifier = await MarketScanDealClassifier.build(
                this.server, deduped, this._classifierOpts())
            classifier.decorateAll(deduped)
            this.table.setClassifier(classifier)
        }
        // Affordability + fleet decoration runs after classification so the
        // visible card stats line up with the same row state filter-chips
        // and model-overview consume.
        this._decorateAffordability(deduped)
        this._decorateFleet(deduped)
        await this._maybeComputeDiff()
        this._maybeNotifyWatchlist()
        this._render()
        // When a scan finishes, the storage write that triggered this
        // reload also bumped the price history; nothing else to do here.
    }

    /**
     * After a scan completes, build a digest of the current rows, diff
     * it against the prior digest stored for this preset, and persist
     * the new digest. Idempotent per scanId so the storage churn that
     * follows a scan (per-type result blobs landing one by one) doesn't
     * recompute or overwrite mid-flight.
     *
     * Synthetic presets (`__scope__`, `__synthetic__`) don't get diffed —
     * they're one-shot scans with no stable identity to compare against.
     */
    async _maybeComputeDiff() {
        if (typeof MarketScanDiffStore === "undefined") return
        const session = this.controller && this.controller.session
        if (!session || session.status !== "done") return
        if (this._diffedScanId === session.scanId) return
        const presetId = session.presetId
        if (!presetId || presetId.indexOf("__") === 0) {
            this._diffedScanId = session.scanId
            this.lastDiff = null
            return
        }
        try {
            const presetName = session.presetName
                || ((this.settings.presets || []).find(p => p.id === presetId) || {}).name
                || ""
            const next = MarketScanDiffStore.buildDigest(session, this.rows, presetId, presetName)
            const prev = await MarketScanDiffStore.loadDigest(this.server, presetId)
            const diff = MarketScanDiffStore.compute(prev, next)
            // Embed the summary alongside the digest so the central-hub
            // tile can render "since last scan" without recomputing.
            next.summary = MarketScanDiffStore.summarise(diff)
            next.diffCounts = {
                newOffers:         diff.newOffers.length,
                gone:              diff.gone.length,
                priceDrops:        diff.priceDrops.length,
                classImprovements: diff.classImprovements.length,
                firstScan:         !!diff.firstScan
            }
            this.lastDiff = diff
            await MarketScanDiffStore.saveDigest(this.server, next)
            this._diffedScanId = session.scanId
            await this._reconcileIntents(next)
        } catch (e) {
            console.warn("AES marketScan panel: diff compute failed:", e)
            this._diffedScanId = session.scanId
            this.lastDiff = null
        }
    }

    /**
     * Compare every persisted bid-intent against this scan's digest and
     * fire chrome notifications for the consequential transitions:
     * "the offer you eyed is gone" (sold or expired) and "the offer you
     * eyed got cheaper" (≥5% drop). Updates each intent record in place
     * so the next reconcile diffs against this scan, not the original
     * sighting. Refreshes `this.intentByKey` so the Eyed badge stays in
     * sync with the persisted state.
     */
    async _reconcileIntents(digest) {
        if (typeof BidIntentStore === "undefined") return
        try {
            const out = await BidIntentStore.reconcile(this.server, digest)
            for (const e of out.gone) {
                const i = e.intent
                this._notifyIntent({
                    title:   "Offer gone: " + (i.aircraftType || "?"),
                    message: (i.registration ? i.registration + " · " : "")
                        + "the offer you eyed has left the market"
                })
            }
            for (const e of out.cheaper) {
                const i = e.intent
                this._notifyIntent({
                    title:   "Cheaper now: " + (i.aircraftType || "?"),
                    message: (i.registration ? i.registration + " · " : "")
                        + "$/seat down " + e.dropPct + "% since you eyed it"
                })
            }
            await this._loadIntents()
        } catch (e) {
            console.warn("AES marketScan panel: intent reconcile failed:", e)
        }
    }

    _notifyIntent(payload) {
        try {
            chrome.runtime.sendMessage({
                type:    "aes:notify:long-op",
                title:   payload.title,
                message: payload.message
            })
        } catch (_) { /* best-effort */ }
    }

    /**
     * Fire a chrome notification when the current scan has just landed
     * a STEAL classification on a watchlisted type. Idempotent per
     * scanId so re-renders within the same scan don't double-notify.
     * Forwards through the existing `aes:notify:long-op` background
     * handler (background.js:757) to reuse its icon + click-to-focus
     * machinery.
     */
    _maybeNotifyWatchlist() {
        const session = this.controller && this.controller.session
        if (!session || session.status !== "done") return
        if (this._notifiedScanId === session.scanId) return
        const watch = this.settings.watchlist
        if (!Array.isArray(watch) || !watch.length) {
            this._notifiedScanId = session.scanId
            return
        }
        const watchSet = new Set(watch)
        const hits = []
        for (const r of this.rows) {
            if (r && r.dealClass === "steal" && watchSet.has(r.aircraftType)) {
                hits.push(r)
            }
        }
        this._notifiedScanId = session.scanId
        if (!hits.length) return
        // Build a compact summary — best-scoring hit headlines, count tail.
        hits.sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0))
        const top = hits[0]
        const more = hits.length - 1
        const title = "AES scanner: STEAL on " + top.aircraftType
        const tail = more ? (" · +" + more + " more") : ""
        const pps  = (typeof top.pricePerSeat === "number")
            ? Math.round(top.pricePerSeat).toLocaleString() + "/seat"
            : "—"
        // Tag the diff summary onto the message so the user sees what
        // changed in this scan, not just the headline hit.
        const diffSummary = (typeof MarketScanDiffStore !== "undefined" && this.lastDiff
            && !this.lastDiff.firstScan && !MarketScanDiffStore.isEmpty(this.lastDiff))
            ? (" · " + MarketScanDiffStore.summarise(this.lastDiff))
            : ""
        const message = "Score " + (top.dealScore || "—") + " · " + pps
            + (top.registration ? " · " + top.registration : "") + tail + diffSummary
        try {
            chrome.runtime.sendMessage({
                type:    "aes:notify:long-op",
                title:   title,
                message: message
            })
        } catch (e) {
            console.warn("AES marketScan panel: STEAL notify failed:", e)
        }
    }

    /**
     * Stamp affordability fields on each row. `affordCost` is the AS$
     * figure we compare against cash on hand — uses the mode-aware
     * MarketScanDealMetrics.affordabilityCost so lease mode bracket by
     * lease total but buy mode bracket by purchase price (matches what
     * the user actually pays). `affordFraction` is null when cash is
     * unknown (so the chip filter degrades to a no-op), and `affordFits`
     * is true only when both sides are known AND cost ≤ cash.
     */
    _decorateAffordability(rows) {
        if (!rows || !rows.length) return
        const leaseConfig = this.settings.leaseConfig || null
        const cash = this.cashCtx && Number(this.cashCtx.cash)
        const haveCash = isFinite(cash) && cash > 0
        const metrics = (typeof MarketScanDealMetrics !== "undefined") ? MarketScanDealMetrics : null
        for (const r of rows) {
            let cost = null
            if (metrics && typeof metrics.affordabilityCost === "function") {
                const v = metrics.affordabilityCost(r, leaseConfig)
                cost = isFinite(v) ? v : null
            }
            r.affordCost     = cost
            r.affordFraction = (haveCash && cost !== null) ? (cost / cash) : null
            r.affordFits     = (haveCash && cost !== null) ? (cost <= cash) : true
        }
    }

    /**
     * Look the row's typeId up in the fleet `byType` Map (or fall back to
     * the `name:<equipment>` key the store uses when typeId is missing on
     * older fleet records). Stamps ownedCount + ownedAvgAge, both null
     * when the user doesn't own this type. The model-overview cards use
     * these directly to render the "would join N owned" badge.
     */
    _decorateFleet(rows) {
        if (!rows || !rows.length) return
        const byType = this.fleetByType
        for (const r of rows) {
            let slot = null
            if (byType && byType.size) {
                const k1 = r.typeId
                const k2 = "name:" + (r.aircraftType || "")
                slot = (k1 && byType.get(k1)) || byType.get(k2) || null
            }
            r.ownedCount  = slot ? (slot.count || 0) : 0
            r.ownedAvgAge = slot && typeof slot.avgAge === "number" ? slot.avgAge : null
        }
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
        const lc = this.settings.leaseConfig || null
        return {
            mode:        lc && lc.mode,
            weights:     cw,
            enabled:     cw.enabled,
            leaseConfig: lc
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
        // Slice-2: read the bus-derived baseline from the reactive view when
        // available. The view's compute is the canonical "what does the
        // scoring pipeline need to know about RA economics + fuel price"
        // function, so this code path is now just "read view; layer the
        // UI override on top".
        let baseline = (typeof AesView !== "undefined")
            ? AesView.get("scanner:fuel-context")
            : null
        if (!baseline) {
            // First render before the view has computed — invoke the same
            // pure compute synchronously so we don't render an empty fuel
            // chip while waiting for the engine's microtask.
            baseline = await MarketPanel._computeFuelContextView()
        }
        this.raEconomics = baseline.raEconomics || null

        const fuelCfg = this.settings.fuelConfig || {}
        const override = numOrNullPanel(fuelCfg.overrideFuelPriceASc)
        return {
            fuelPriceASc:          override !== null ? override : baseline.fuelPriceASc,
            fuelAgePenaltyPerYear: baseline.fuelAgePenaltyPerYear
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
            onSavePreset:     () => this._onSavePreset(),
            onScheduleChange: p => this._onScheduleChange(p),
            onToggleCollapse: () => this._toggleCollapse()
        })
    }

    _renderBody() {
        if (this.disposed || !this.bodyEl) return
        const showBody = !this.uiState.collapsed
        this.bodyEl.style.display = showBody ? "flex" : "none"
        this.footerEl.style.display = showBody ? "flex" : "none"
        if (!showBody) return

        const leaseConfig = this.settings.leaseConfig || null
        const overrides   = this.settings.typeFamilyOverrides || null
        const filtered = MarketPanelFilterChips.apply(this.rows, this.uiState, leaseConfig)

        MarketPanelKpiStrip.render(this.kpiEl, MarketPanelKpiStrip.compute(filtered))
        this._renderDiffStrip()
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

        const scopeTypes = this._resolveScopeTypes()

        if (typeof MarketPanelModelOverview !== "undefined") {
            // Show every scanned model the scope chips admit, even when view
            // filters (STEAL/age/price brackets) hide all rows from the
            // table. The overview's job is "what's in the scanned pool",
            // not "what currently shows" — those are separate questions.
            const scopeOnly = MarketPanelFilterChips.apply(this.rows,
                MarketPanel._scopeOnlyState(this.uiState), leaseConfig)
            const watchSet = new Set(this.settings.watchlist || [])
            MarketPanelModelOverview.render(this.modelOverviewEl, scopeOnly,
                this.uiState.types, leaseConfig, {
                    onTypeToggle:    t => this._onCardPin(t),
                    onWatchToggle:   t => this._onWatchToggle(t),
                    onSendToStrategy: () => this._onSendToStrategy()
                }, watchSet, this.cashCtx || null,
                {server: this.server, intentByKey: this.intentByKey})
        }

        MarketPanelFilterChips.render(this.filterEl, this.uiState, {
            onChange: () => {
                this._persistUiState({})
                this._render()
            }
        }, this.rows, leaseConfig, overrides, {count: scopeTypes.length})

        // Filters-drop-everything banner — distinguishes a freshly mounted
        // panel ("never scanned") from a scan whose chips happen to exclude
        // every offer. Only the latter gets a Clear-filters hint.
        this._renderEmptyHint(filtered)

        const sort = MarketPanelFilterChips.lookupSort(this.uiState.sort)
        this.table.sortField = sort.field === "score" ? "dealScore" : sort.field
        this.table.sortDir   = sort.dir
        if (typeof this.table.setLeaseConfig === "function") {
            this.table.leaseConfig = leaseConfig
        }
        this.table.render(filtered)

        this._renderFooter(filtered)
    }

    /**
     * "Since last scan" delta band. Renders a single line with the diff
     * summary and a click-to-expand list of the most-relevant changes
     * (improvements > new > drops > gone). Hidden when no diff exists,
     * the diff is empty, or this was the first scan of a preset.
     */
    _renderDiffStrip() {
        if (!this.diffStripEl) return
        this.diffStripEl.innerHTML = ""
        const diff = this.lastDiff
        if (!diff || diff.firstScan) return
        if (typeof MarketScanDiffStore === "undefined") return
        if (MarketScanDiffStore.isEmpty(diff)) return

        const summary = MarketScanDiffStore.summarise(diff)
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "margin:8px 12px 0",
            "background:var(--aes-bone-2)",
            "border:1px solid var(--aes-paper-rule)",
            "border-left:4px solid var(--aes-rust)"
        ].join(";")
        const head = document.createElement("button")
        head.type = "button"
        head.style.cssText = [
            "all:unset", "cursor:pointer", "display:flex",
            "gap:8px", "align-items:center", "padding:6px 10px",
            "width:100%", "box-sizing:border-box",
            "font-size:12px", "color:var(--aes-oxide)"
        ].join(";")
        const label = document.createElement("span")
        label.textContent = "Since last scan"
        label.style.cssText = [
            "font:9px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase",
            "color:var(--aes-slate)"
        ].join(";")
        const counts = document.createElement("span")
        counts.textContent = summary
        counts.style.cssText = "flex:1 1 auto;font-family:var(--aes-font-mono);"
        const chevron = document.createElement("span")
        chevron.textContent = "▾"
        chevron.style.cssText = "color:var(--aes-slate);font-size:10px;"
        head.append(label, counts, chevron)
        wrap.append(head)

        const body = document.createElement("div")
        body.style.cssText = [
            "border-top:1px solid var(--aes-paper-rule)",
            "padding:6px 10px",
            "display:none",
            "flex-direction:column", "gap:3px",
            "max-height:180px", "overflow:auto"
        ].join(";")
        const limit = 8
        const entries = []
        for (const r of diff.classImprovements) entries.push({kind: "↑", row: r,
            extra: r.prevClass + " → " + r.dealClass})
        for (const r of diff.newOffers)         entries.push({kind: "＋", row: r, extra: "new"})
        for (const r of diff.priceDrops)        entries.push({kind: "↓", row: r,
            extra: "AS$" + Math.round(r.prevPps).toLocaleString()
                  + " → " + Math.round(r.pps).toLocaleString() + "/seat"})
        for (const r of diff.gone)              entries.push({kind: "✗", row: r, extra: "gone"})
        for (const e of entries.slice(0, limit)) {
            body.append(MarketPanel._diffEntry(e))
        }
        if (entries.length > limit) {
            const more = document.createElement("div")
            more.textContent = "+ " + (entries.length - limit) + " more"
            more.style.cssText = "font-size:11px;color:var(--aes-slate);font-style:italic;padding:2px 0;"
            body.append(more)
        }
        wrap.append(body)
        head.addEventListener("click", () => {
            const open = body.style.display !== "none"
            body.style.display = open ? "none" : "flex"
            chevron.textContent = open ? "▾" : "▴"
        })
        this.diffStripEl.append(wrap)
    }

    static _diffEntry(e) {
        const row = document.createElement("a")
        row.href = e.row.offerUrl || "#"
        if (e.row.offerUrl) {
            row.target = "_blank"
            row.rel = "noopener"
        }
        row.style.cssText = [
            "display:flex", "gap:8px", "align-items:baseline",
            "font:11px var(--aes-font-mono)",
            "color:var(--aes-oxide)", "text-decoration:none",
            "padding:1px 0"
        ].join(";")
        const kind = document.createElement("span")
        kind.textContent = e.kind
        kind.style.cssText = "color:var(--aes-rust);width:14px;flex:0 0 auto;text-align:center;"
        const title = document.createElement("span")
        title.textContent = e.row.aircraftType
            + (e.row.registration ? " · " + e.row.registration : "")
        title.style.cssText = "flex:1 1 auto;"
        const extra = document.createElement("span")
        extra.textContent = e.extra
        extra.style.cssText = "color:var(--aes-slate);"
        row.append(kind, title, extra)
        if (!e.row.offerUrl) {
            row.style.cursor = "default"
            row.style.opacity = "0.7"
        }
        return row
    }

    _renderEmptyHint(filtered) {
        if (!this.emptyHintEl) return
        this.emptyHintEl.innerHTML = ""
        if (filtered.length || !this.rows.length) return
        const banner = document.createElement("div")
        banner.style.cssText = [
            "margin:8px 12px 0",
            "padding:8px 10px",
            "background:var(--aes-bone-3)",
            "border:1px solid var(--aes-paper-rule)",
            "border-left:4px solid var(--aes-amber)",
            "display:flex",
            "align-items:center",
            "gap:8px",
            "font-size:12px",
            "color:var(--aes-oxide)"
        ].join(";")
        const msg = document.createElement("span")
        msg.textContent = this.rows.length + " offers scanned, "
            + "but the active filters hide all of them."
        msg.style.cssText = "flex:1 1 auto;"
        banner.append(msg)
        const clear = document.createElement("button")
        clear.type = "button"
        clear.className = "aes-btn aes-btn--sm"
        clear.textContent = "Clear view filters"
        clear.style.cssText = "flex:0 0 auto;"
        clear.addEventListener("click", () => {
            // Only nuke view filters — leave the scan scope alone so the
            // user doesn't have to rebuild it.
            if (this.uiState.classes) this.uiState.classes.clear()
            this.uiState.ageBracket   = null
            this.uiState.priceBracket = null
            this.uiState.fitsFleet    = false
            this.uiState.fitsCash     = false
            this.uiState.expiringSoon = false
            this.uiState.hasHistory   = false
            this.uiState.search       = ""
            this._persistUiState({})
            this._render()
        })
        banner.append(clear)
        this.emptyHintEl.append(banner)
    }

    _renderScoring() {
        if (typeof MarketPanelScoringControls === "undefined" || !this.scoringEl) return
        const presets = (typeof UsedAircraftPresets === "function")
            ? UsedAircraftPresets.allPresets(this.settings)
            : (this.settings.presets || [])
        MarketPanelScoringControls.render(this.scoringEl, {
            weights:        this.settings.classifierWeights,
            enabled:        this.settings.classifierWeights && this.settings.classifierWeights.enabled,
            leaseConfig:    this.settings.leaseConfig,
            fuelConfig:     this.settings.fuelConfig,
            open:           !!this.uiState.scoringOpen,
            presets:        presets,
            activePresetId: this.settings.activePresetId || null
        }, {
            onChange:        partial => this._onScoringChange(partial),
            onReset:         ()      => this._onScoringReset(),
            onToggleOpen:    ()      => this._onScoringToggleOpen(),
            onPresetApply:   id      => this._onPresetApply(id),
            onPresetSave:    ()      => this._onPresetSave()
        })
    }

    /**
     * Apply a built-in or saved preset. Pulls the patch from
     * UsedAircraftPresets.apply(), merges it into local settings, persists,
     * and re-decorates + re-classifies the cached rows so the panel
     * reorders without a rescan.
     */
    async _onPresetApply(presetId) {
        if (!presetId || typeof UsedAircraftPresets !== "function") return
        const patch = UsedAircraftPresets.apply(presetId, this.settings)
        if (!patch) return
        this.settings.classifierWeights = patch.classifierWeights
        this.settings.leaseConfig       = patch.leaseConfig
        if (patch.routeFilter) this.settings.routeFilter = patch.routeFilter
        this.settings.activePresetId    = patch.activePresetId
        try { await UsedAircraftPresets.save(patch) }
        catch (e) { console.error("AES marketScan panel: preset apply save failed:", e) }
        await this._reclassifyCachedRows(true)
        this._renderScoring()
    }

    /**
     * Save current sliders/filters as a new user preset. Naming uses a
     * simple `prompt()` since the panel doesn't yet have a modal — same
     * pattern legacy AS extensions follow when capturing a one-shot string.
     */
    async _onPresetSave() {
        if (typeof UsedAircraftPresets !== "function") return
        const name = (typeof window !== "undefined" && window.prompt)
            ? window.prompt("Name this preset:", "My scan preset")
            : null
        if (!name) return
        const lc = this.settings.leaseConfig || {}
        try {
            const created = await UsedAircraftPresets.create({
                name:       name,
                mode:       MarketScanDealClassifier.normalizeMode(lc.mode),
                termMonths: lc.termMonths,
                weights:    Object.assign({}, this.settings.classifierWeights || {}),
                filters:    {
                    minRangeKm: this.settings.routeFilter && this.settings.routeFilter.minRangeKm
                }
            })
            this.settings.activePresetId = created.id
            await UsedAircraftPresets.save({activePresetId: created.id})
        } catch (e) {
            console.error("AES marketScan panel: preset save failed:", e)
        }
        this._renderScoring()
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

        // Manual edit → diverge from any active preset so the dropdown
        // surfaces "Custom" rather than mis-attributing the tweak.
        const presetCleared = this.settings.activePresetId !== null
        this.settings.activePresetId = null

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
        if (presetCleared) this._scoringPending.activePresetId = null
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
        // Lease-config slider can flip lease/purchase basis — re-stamp
        // affordability so the Fits-cash filter and Cost badge stay in
        // sync with the new basis. Fleet stats are independent of scoring.
        this._decorateAffordability(this.rows)
        this._renderBody()
    }

    async _onScoringReset() {
        const defaults = UsedAircraftPresets._defaults()
        const blob = {
            classifierWeights: defaults.classifierWeights,
            leaseConfig:       defaults.leaseConfig,
            fuelConfig:        defaults.fuelConfig,
            activePresetId:    null
        }
        this.settings.classifierWeights = blob.classifierWeights
        this.settings.leaseConfig       = blob.leaseConfig
        this.settings.fuelConfig        = blob.fuelConfig
        this.settings.activePresetId    = null
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
        const scopeTypeCount = this._resolveScopeTypes().length
        const presetSelected = !!(this.uiState.presetId
            && presets.find(p => p.id === this.uiState.presetId))
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
            scopeTypeCount:      scopeTypeCount,
            schedule:            this.settings.schedule || null,
            // Scope-derived scan is allowed only when no preset is picked —
            // an explicit preset selection wins over loose scope chips.
            canScan: !!(scanCurrentLabel || presetSelected
                || (!this.uiState.presetId && !this.uiState.scanCurrent && scopeTypeCount > 0)),
            canSavePreset: scopeTypeCount > 0 || presetSelected,
            canRefresh: !!(session && session.presetId
                && presets.find(p => p.id === session.presetId))
        }
    }

    /**
     * Resolve the scope chip selections into a concrete AS Type list, the
     * same way `UsedAircraftPresets.create()` expects. Walks every type
     * in TypeFamilyMap and keeps the ones that pass every non-empty scope
     * dimension (categories ∧ manufacturers ∧ families ∧ types). Returns
     * `[]` when no scope dimension is selected — the caller treats that
     * as "scope can't drive a scan, fall back to preset/scanCurrent".
     */
    _resolveScopeTypes() {
        const u = this.uiState
        const cats = u.categories    instanceof Set && u.categories.size    ? u.categories    : null
        const mfrs = u.manufacturers instanceof Set && u.manufacturers.size ? u.manufacturers : null
        const fams = u.families      instanceof Set && u.families.size      ? u.families      : null
        const tps  = u.types         instanceof Set && u.types.size         ? u.types         : null
        if (!cats && !mfrs && !fams && !tps) return []
        const overrides = this.settings.typeFamilyOverrides || {}
        const dim = TypeFamilyMap.marketDimensions(overrides)
        const out = []
        for (const e of dim.typeOptions) {
            if (dim.liveTypeSet && !dim.liveTypeSet.has(e.type)) continue
            if (cats && !cats.has(e.category || "other")) continue
            if (fams && !fams.has(e.family || "")) continue
            if (tps  && !tps.has(e.type)) continue
            if (mfrs && !mfrs.has(TypeFamilyMap.manufacturer(e.type))) continue
            out.push(e.type)
        }
        return out
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
        if (!family || TypeFamilyMap.isAnyFamilyLabel(family)) return null
        if (!type || TypeFamilyMap.isAnyTypeLabel(type)) return null
        return "Scan this view (" + type + ")"
    }

    _onCardPin(type) {
        if (!(this.uiState.types instanceof Set)) {
            this.uiState.types = new Set()
        }
        if (this.uiState.types.has(type)) this.uiState.types.delete(type)
        else this.uiState.types.add(type)
        this._persistUiState({})
        this._render()
    }

    /**
     * Toggle an aircraft type into settings.watchlist. Watchlisted types
     * fire a chrome notification when a STEAL classification lands inside
     * them on the next scan completion.
     */
    async _onWatchToggle(type) {
        if (!type) return
        const current = Array.isArray(this.settings.watchlist)
            ? this.settings.watchlist.slice()
            : []
        const i = current.indexOf(type)
        if (i >= 0) current.splice(i, 1)
        else current.push(type)
        this.settings.watchlist = current
        try { await UsedAircraftPresets.save({watchlist: current}) }
        catch (e) { console.error("AES marketScan panel: watchlist save failed:", e) }
        this._render()
    }

    /**
     * Open the Strategy panel for fleet/route ROI context. Strategy doesn't
     * accept per-type intake today (its allocator reads the live fleet), so
     * this is an honest "open the panel" handoff — the user gets the
     * strategy view in one click instead of navigating to the central hub.
     */
    _onSendToStrategy() {
        if (typeof window.AesStrategyPanel === "undefined"
            || typeof window.AesStrategyPanel.open !== "function") {
            console.warn("AES marketScan panel: AesStrategyPanel.open not available")
            return
        }
        try {
            const opts = {server: this.server}
            window.AesStrategyPanel.open(opts)
        } catch (e) {
            console.error("AES marketScan panel: Strategy open failed:", e)
        }
    }

    /**
     * Persist a schedule partial. Defaulting presetId to the currently-
     * selected preset on first arm makes the popover one-click for the
     * common case "rescan the preset I'm already looking at".
     */
    async _onScheduleChange(partial) {
        const cur = this.settings.schedule || {
            enabled: false, cadenceMin: 60, presetId: null, lastRunAt: null
        }
        const next = Object.assign({}, cur, partial || {})
        if (next.enabled && !next.presetId && this.uiState.presetId) {
            next.presetId = this.uiState.presetId
        }
        this.settings.schedule = next
        try { await UsedAircraftPresets.save({schedule: next}) }
        catch (e) { console.error("AES marketScan panel: schedule save failed:", e) }
        this._renderHeader()
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
            // When the user has additionally narrowed the scope chips,
            // intersect them with the preset so the scan only scrapes the
            // picked subset — addresses "scrapes everything in the preset"
            // slowness without forcing the user to edit/save a new preset.
            if (preset) {
                const scopeTypes = this._resolveScopeTypes()
                if (scopeTypes.length) {
                    const allow = new Set(scopeTypes)
                    const narrowed = (preset.types || []).filter(t => allow.has(t))
                    if (narrowed.length && narrowed.length < (preset.types || []).length) {
                        preset = Object.assign({}, preset, {
                            id:    preset.id + "__narrowed",
                            name:  preset.name + " (" + narrowed.length + "/" + preset.types.length + ")",
                            types: narrowed
                        })
                    }
                }
            }
        } else {
            // No preset / no AS-native scan-this-view → drive the scan from
            // whatever scope chips are selected. Mirrors the synthetic-preset
            // pattern used for "Scan this view".
            const types = this._resolveScopeTypes()
            if (types.length) {
                preset = {id: "__scope__", name: "Scope (" + types.length + ")", types: types}
            }
        }
        if (!preset) return
        try { await this.controller.start(preset, this._scanOpts()) }
        catch (e) { console.error("AES marketScan panel: start() failed:", e) }
    }

    /**
     * "Save preset" handler. Snapshots the current scope chips (or the
     * selected preset's types when scope is empty), prompts for a name,
     * and persists via UsedAircraftPresets.create. The new preset becomes
     * the selected one so the user can scan it immediately.
     */
    async _onSavePreset() {
        let types = this._resolveScopeTypes()
        let suggested = MarketPanel._suggestedPresetName(this.uiState)
        if (!types.length && this.uiState.presetId) {
            const cur = (this.settings.presets || []).find(p => p.id === this.uiState.presetId)
            if (cur) {
                types = (cur.types || []).slice()
                suggested = (cur.name || "Preset") + " (copy)"
            }
        }
        if (!types.length) return
        const name = window.prompt(
            "Save scope as preset (" + types.length + " type"
                + (types.length === 1 ? "" : "s") + "):",
            suggested
        )
        if (name === null) return
        const trimmed = (name || "").trim()
        if (!trimmed) return
        try {
            const created = await UsedAircraftPresets.create(trimmed, types)
            this.settings = await UsedAircraftPresets.load()
            this.uiState.presetId = created.id
            this.uiState.scanCurrent = false
            this._persistUiState({})
            this._render()
        } catch (e) {
            console.error("AES marketScan panel: save preset failed:", e)
        }
    }

    /**
     * Build a default preset name from the active scope chips so the
     * prompt arrives pre-filled with something the user can accept with
     * Enter — e.g. "Airbus · A320 family" or "Narrowbody · Boeing".
     */
    static _suggestedPresetName(state) {
        const parts = []
        const cats = state.categories instanceof Set ? Array.from(state.categories) : []
        const mfrs = state.manufacturers instanceof Set ? Array.from(state.manufacturers) : []
        const fams = state.families instanceof Set ? Array.from(state.families) : []
        const tps  = state.types instanceof Set ? Array.from(state.types) : []
        if (cats.length) parts.push(cats.length === 1
            ? cats[0].charAt(0).toUpperCase() + cats[0].slice(1)
            : cats.length + " categories")
        if (mfrs.length) parts.push(mfrs.length === 1 ? mfrs[0] : mfrs.length + " manufacturers")
        if (fams.length) parts.push(fams.length === 1 ? fams[0] : fams.length + " families")
        if (tps.length)  parts.push(tps.length === 1  ? tps[0]  : tps.length  + " types")
        return parts.length ? parts.join(" · ") : "New preset"
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
        this._applyHostInset()
        this._render()
    }

    /**
     * Persist the panel's UI state under settings.usedAircraftScanner.marketUiState
     * so reloads / Wicket navs restore the same chips, sort, search, width.
     * Sets are serialised to arrays for storage.
     */
    _persistUiState(extra) {
        const blob = {
            collapsed:     this.uiState.collapsed,
            classes:       Array.from(this.uiState.classes       || []),
            categories:    Array.from(this.uiState.categories    || []),
            families:      Array.from(this.uiState.families      || []),
            manufacturers: Array.from(this.uiState.manufacturers || []),
            types:         Array.from(this.uiState.types         || []),
            ageBracket:    this.uiState.ageBracket,
            priceBracket:  this.uiState.priceBracket,
            fitsFleet:     this.uiState.fitsFleet,
            fitsCash:      this.uiState.fitsCash,
            expiringSoon:  this.uiState.expiringSoon,
            hasHistory:    this.uiState.hasHistory,
            search:        this.uiState.search,
            sort:          this.uiState.sort,
            presetId:      this.uiState.presetId,
            scanCurrent:   this.uiState.scanCurrent,
            panelWidth:    this.root ? this.root.offsetWidth : null
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
