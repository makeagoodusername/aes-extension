"use strict"

/**
 * Fleet Command Center — central island for overall route management on the
 * AS fleet management page (`/app/fleets*`).
 *
 * Mounts inside the AES summary panel right beneath FleetHubSummaryStrip and
 * presents four tabs that consolidate the cross-module data the user needs to
 * make scheduling/wave/strategy decisions without bouncing between pages:
 *
 *   • Overview   — per-hub roster cards (fleet count, drafted plans, applied
 *                  legs, saved schedules, wave preset, last scrape)
 *   • Schedules  — saved schedule history (ScheduleStore.listIndex), grouped
 *                  by hub, click to open SchedulePanel for that aircraft
 *   • Waves      — wave preset library by hub (SchedulePresets) + draft hints
 *                  from RouteAssistantWaveDraftStore
 *   • Aircraft   — per-aircraft wave drafts (AesAfpActiveDraftStore), one row
 *                  per tail with a jump into the AFP Dashboard
 *
 * Repaints in response to chrome.storage.onChanged on any data source it
 * shows. Debounced (200 ms) so a burst of writes (e.g. AFP page sync of state
 * + schedule + draft together) is one repaint.
 *
 * Entirely additive — never mutates the AS fleet table, doesn't replace the
 * existing FleetHubInlineTable / FleetHubSummaryStrip outputs. Owned by
 * FleetHubHost which calls render() after each enrich pass.
 */
class FleetHubCommandCenter {

    static ROOT_ATTR = "data-aes-fleet-cc"
    static SETTINGS_KEY = "settings"
    static SETTINGS_BLOCK = "fleetCommandCenter"
    static REPAINT_DEBOUNCE_MS = 200
    static STRATEGY_FRESH_MS = 60_000   // skip recompose when plan younger than this

    static TABS = [
        {id: "overview",  label: "Overview",       glyph: "◆"},
        {id: "schedules", label: "Schedules",      glyph: "≡"},
        {id: "waves",     label: "Waves",          glyph: "↟"},
        {id: "aircraft",  label: "Aircraft Plans", glyph: "✈"}
    ]

    constructor(opts) {
        const o = opts || {}
        this.server      = o.server      || ""
        this.airlineCode = o.airlineCode || ""
        this.anchorEl    = o.anchorEl    || null
        this.rootEl      = null
        this.bodyEl      = null
        this.tabBarEl    = null
        this._rows       = []
        this._activeTab  = "overview"
        this._storageListener = null
        this._repaintTimer    = null
        this._loaded     = false

        // Cache loaded auxiliary data so flipping a tab doesn't re-fetch from
        // chrome.storage when nothing's changed. Invalidated by repaint().
        this._scheduleIndex = null    // [{scheduleId, presetName, hub, ...}]
        this._scheduleCache = new Map()  // scheduleId -> full record
        this._presetsBlock  = null    // {presets, defaultPresetId, ...}
        this._waveDrafts    = new Map()  // hub -> draft record (or null)
        this._aircraftDrafts = new Map()  // aircraftId -> draft record (or null)
        this._hubManagement = null       // {hiddenHubs:[], labels:{IATA:label}, ...}
        this._hubMenuDispose = null      // dismisses the open hub-card kebab menu

        // Strategy header strip — composed lazily on mount, repainted on
        // chrome.storage.onChanged for any aesStrategy key. The plan is
        // optional: the strip degrades gracefully when AesStrategy isn't
        // loaded, when compose fails, or when no plan has been applied yet.
        this._strategySettings    = null    // {tier, *Enabled, ...} from AesStrategySettings.load
        this._strategyApplied     = null    // last-apply envelope from aesStrategy:plan:applied
        this._strategyAutoTick    = null    // last auto-driver tick envelope (see auto-driver.js)
        this._strategyPlan        = null    // {snapshot, plan, diff, weights, composedAt}
        this._strategyComposedAt  = 0
        this._strategyComposing   = false
        this._strategyComposeError = null   // err.message string when last compose threw
        this._strategyStripHost   = null    // sub-region inside header for in-place repaint

        // ── Inline-editor state ─────────────────────────────────────────────
        // Lazy AFP build pipeline + proxy fetcher (see _getPipeline /
        // _getProxyFetcher). Both live for the lifetime of the CC; the
        // fetcher carries its own form-context cache so repeat generates
        // are cheap.
        this._pipelineInst       = null
        this._proxyFetcherInst   = null
        this._pipelineUnavailable     = false   // true once we've confirmed the class isn't loaded
        this._proxyFetcherUnavailable = false

        // In-flight action keyed by "kind:id" (e.g. "generate:AC1234"). We use
        // it to disable the per-row button + swap its label without forcing a
        // full repaint. The map is cleared on dispose; entries are deleted on
        // settle (success OR error).
        this._busy           = new Map()

        // Preset rows the user has expanded into the inline wave editor. Set
        // of preset.id strings, persisted alongside activeTab in CC settings.
        this._expandedPresets = new Set()

        // Aircraft draft rows the user has expanded into the inline per-leg
        // editor on the Aircraft Plans tab. Persisted alongside activeTab.
        this._expandedAircraft = new Set()

        // Per-aircraft tag map and routine list — loaded by _loadAuxData
        // from AircraftTagsStore + FleetRoutinesStore. Default-initialised
        // here so renderers can read .byAircraftId / iterate without an
        // undefined-check before the first load lands.
        this._aircraftTags  = {byAircraftId: {}}
        this._routines      = []
        this._knownAccounts = []

        // Tag-edit popover state — at most one open at a time. Tracks the
        // aircraftId whose chip cluster has the popover anchored.
        this._tagEditOpenFor = null

        // Routines panel — collapsible above the Aircraft table. Track
        // which routine row is in edit mode (id, or "new" for the create
        // form). One at a time keeps the UI focused; the user explicitly
        // saves or cancels before opening another.
        this._routinesPanelOpen = true
        this._editingRoutineId  = null

        // Strategy decisions the user has explicitly opted into for inline
        // bulk-apply on the Overview tab. Keyed by decision-id; not persisted.
        this._strategySelectedDecisions = new Set()

        // Per-leg transient state ({"<aircraftId>:<seq>": "submitting"|"error"})
        // surfaced in the Aircraft Plans inline leg list. Cleared on dispose.
        this._legStatusBySeq = {}

        // CentralHubBus subscriber disposers — paired with `dispose()` so
        // sibling-panel events (waves:preset-updated, strategy:decision-applied,
        // focus-aircraft, …) live-mirror into Fleet CC without leaking handlers
        // across mount cycles. Same pattern as CentralHubTile.subscribeBus.
        this._busDisposers = []
    }

    /** Idempotent. Mounts and renders the first frame. */
    async mount() {
        if (!this.anchorEl) return
        this._removePrior()

        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const root = document.createElement("div")
        root.setAttribute(FleetHubCommandCenter.ROOT_ATTR, "1")
        root.style.cssText = T
            ? [
                "margin-top:" + T.sp[3],
                "background:" + T.color.bone,
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "border-top:" + T.geom.bw2 + " solid " + T.color.oxide,
                "color:" + T.color.oxide,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "line-height:" + T.lh.body
            ].join(";")
            : "margin-top:12px;background:#f4f1ea;border:1px solid #c9c0b0;color:#2b2520;"

        this.rootEl = root
        this.anchorEl.appendChild(root)

        this._activeTab = await this._loadActiveTab()
        await this._loadAuxData()
        this._render()
        this._attachStorageListener()
        this._attachBusListeners()
        // Background-compose the strategy plan — strip will repaint in
        // place when it lands. Don't await: first paint shows the static
        // tier + last-apply rows immediately, the rest fills in.
        if (typeof window.AesStrategy !== "undefined") {
            this._composePlan().catch(err => console.warn("[AES Fleet CC] strategy compose failed", err))
        }
    }

    _removePrior() {
        if (!this.anchorEl) return
        const existing = this.anchorEl.querySelectorAll("[" + FleetHubCommandCenter.ROOT_ATTR + "]")
        for (const el of existing) {
            if (el.parentElement) el.parentElement.removeChild(el)
        }
    }

    /** Called by FleetHubHost when its enrich pass produces fresh rows. */
    async update(rows) {
        this._rows = Array.isArray(rows) ? rows : []
        if (!this.rootEl || !this.rootEl.parentElement) return
        await this._loadAuxData()
        this._render()
    }

    setRows(rows) {
        this._rows = Array.isArray(rows) ? rows : []
    }

    dispose() {
        if (this._storageListener && typeof chrome !== "undefined"
                && chrome.storage && chrome.storage.onChanged) {
            try { chrome.storage.onChanged.removeListener(this._storageListener) }
            catch (_) { /* noop */ }
        }
        this._storageListener = null
        if (this._busDisposers && this._busDisposers.length) {
            for (const dispose of this._busDisposers) {
                try { dispose() } catch (_) { /* noop */ }
            }
            this._busDisposers = []
        }
        if (this._repaintTimer) {
            clearTimeout(this._repaintTimer)
            this._repaintTimer = null
        }
        // Tear down any open tag-edit popover (document-level click /
        // keydown listeners must be released before the CC is dropped).
        if (this._tagPopoverDispose) {
            try { this._tagPopoverDispose() } catch (_) { /* noop */ }
            this._tagPopoverDispose = null
        }
        this._tagPopoverEl = null
        this._tagEditOpenFor = null

        // Same for the hub-card kebab menu.
        if (this._hubMenuDispose) {
            try { this._hubMenuDispose() } catch (_) { /* noop */ }
            this._hubMenuDispose = null
        }
        this._hubMenuOpenFor = null

        this._legStatusBySeq = {}
        if (this.rootEl && this.rootEl.parentElement) {
            this.rootEl.parentElement.removeChild(this.rootEl)
        }
        this.rootEl = null
    }

    // ── Storage I/O ──────────────────────────────────────────────────────

    async _loadActiveTab() {
        try {
            const got = await chrome.storage.local.get([FleetHubCommandCenter.SETTINGS_KEY])
            const settings = got[FleetHubCommandCenter.SETTINGS_KEY] || {}
            const block = settings[FleetHubCommandCenter.SETTINGS_BLOCK] || {}
            // Hydrate the expanded-presets set in the same pass — the caller
            // (mount) reads activeTab synchronously, but expandedPresets just
            // needs to be ready before the first body render.
            const expanded = Array.isArray(block.expandedPresets) ? block.expandedPresets : []
            this._expandedPresets = new Set(expanded.map(s => String(s)))
            const expandedAc = Array.isArray(block.expandedAircraft) ? block.expandedAircraft : []
            this._expandedAircraft = new Set(expandedAc.map(s => String(s)))
            const tab = block.activeTab
            if (FleetHubCommandCenter.TABS.find(t => t.id === tab)) return tab
        } catch (_) { /* fall through */ }
        return "overview"
    }

    async _saveActiveTab(tabId) {
        try {
            const got = await chrome.storage.local.get([FleetHubCommandCenter.SETTINGS_KEY])
            const settings = got[FleetHubCommandCenter.SETTINGS_KEY] || {}
            const block = Object.assign({}, settings[FleetHubCommandCenter.SETTINGS_BLOCK] || {})
            block.activeTab = tabId
            settings[FleetHubCommandCenter.SETTINGS_BLOCK] = block
            await chrome.storage.local.set({[FleetHubCommandCenter.SETTINGS_KEY]: settings})
        } catch (_) { /* non-fatal */ }
    }

    /** Persist expanded-row sets. Fired by chevron toggles on Waves + Aircraft tabs. */
    async _saveExpandedPresets() {
        try {
            const got = await chrome.storage.local.get([FleetHubCommandCenter.SETTINGS_KEY])
            const settings = got[FleetHubCommandCenter.SETTINGS_KEY] || {}
            const block = Object.assign({}, settings[FleetHubCommandCenter.SETTINGS_BLOCK] || {})
            block.expandedPresets  = Array.from(this._expandedPresets)
            block.expandedAircraft = Array.from(this._expandedAircraft)
            settings[FleetHubCommandCenter.SETTINGS_BLOCK] = block
            await chrome.storage.local.set({[FleetHubCommandCenter.SETTINGS_KEY]: settings})
        } catch (_) { /* non-fatal */ }
    }

    /** Read auxiliary data needed by the tabs. Run on every repaint. */
    async _loadAuxData() {
        const tasks = [
            this._loadScheduleIndex(),
            this._loadPresets(),
            this._loadWaveDrafts(),
            this._loadAircraftDrafts(),
            this._loadAircraftTags(),
            this._loadRoutines(),
            this._loadKnownAccounts(),
            this._loadStrategyAux(),
            this._loadHubManagement()
        ]
        await Promise.all(tasks)
        this._loaded = true
    }

    /**
     * Strategy aux: tier + last-apply envelope. Cheap reads — does NOT
     * compose a fresh plan (that's `_composePlan`). The strip uses these
     * to show tier badge + last-apply summary even before compose lands.
     */
    async _loadStrategyAux() {
        try {
            this._strategySettings = (typeof window.AesStrategySettings !== "undefined"
                    && typeof window.AesStrategySettings.load === "function")
                ? await window.AesStrategySettings.load()
                : null
        } catch (_) { this._strategySettings = null }
        // Per-account scoped reads: prefer the current page's account
        // envelope so the strip reflects this airline, falling back to
        // the legacy global keys when no scoped envelope exists yet.
        try {
            const acct = (typeof window !== "undefined" && window.__aesAccountId) || null
            const baseKeys = ["aesStrategy:plan:applied", "aesStrategy:autoTick:last"]
            const scopedKeys = acct
                ? baseKeys.map(k => k + ":acct:" + acct)
                : []
            const blob = await chrome.storage.local.get(baseKeys.concat(scopedKeys))
            const applied = (acct && blob["aesStrategy:plan:applied:acct:" + acct])
                || blob["aesStrategy:plan:applied"]
                || null
            const autoTick = (acct && blob["aesStrategy:autoTick:last:acct:" + acct])
                || blob["aesStrategy:autoTick:last"]
                || null
            // Drop the legacy fallback if it points at a different account —
            // surfacing a sister's last apply on this airline's strip is more
            // misleading than showing nothing.
            this._strategyApplied = (applied && applied.accountId && acct
                && applied.accountId !== acct) ? null : applied
            this._strategyAutoTick = (autoTick && autoTick.accountId && acct
                && autoTick.accountId !== acct) ? null : autoTick
        } catch (_) {
            this._strategyApplied  = null
            this._strategyAutoTick = null
        }
    }

    /**
     * Compose a fresh strategy plan and cache on `this._strategyPlan`.
     * Mirrors `panel.js`'s _composePlan but kept private to avoid
     * touching the panel's IIFE-internal helper. Cheap-skips when a
     * recent plan exists unless `opts.force === true`.
     *
     * Returns the cached plan envelope or null on failure.
     */
    async _composePlan(opts) {
        const ns = window.AesStrategy
        if (!ns || typeof ns.snapshot !== "function" || typeof ns.scoreRoutes !== "function"
                || typeof ns.allocateFleet !== "function" || typeof ns.diffPlan !== "function") {
            this._strategyPlan = null
            this._strategyComposeError = "AesStrategy not loaded"
            return null
        }
        const force = !!(opts && opts.force)
        if (!force && this._strategyComposing) return this._strategyPlan
        if (!force && this._strategyPlan
                && (Date.now() - this._strategyComposedAt) < FleetHubCommandCenter.STRATEGY_FRESH_MS) {
            return this._strategyPlan
        }

        this._strategyComposing = true
        this._strategyComposeError = null
        // Repaint the strip eagerly so the user sees a "composing…" state
        // rather than stale data while the compose runs.
        this._renderStrategyStripInPlace()

        try {
            const snapshot = await ns.snapshot({})
            const acctId = (snapshot && snapshot.accountId) || null
            let weights = null
            if (window.AesStrategyLearn
                    && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
                try { weights = await window.AesStrategyLearn.getCurrentWeights(acctId) }
                catch (_) { weights = null }
            }
            const scored = ns.scoreRoutes(snapshot, weights || undefined)
            const plan   = await ns.allocateFleet(snapshot, scored, {})
            const currentSchedules = await this._loadCurrentSchedulesForPlan(plan, snapshot && snapshot.server)
            const diff   = ns.diffPlan(plan, snapshot, {currentSchedules})
            this._strategyPlan = {snapshot, scored, plan, diff, weights, currentSchedules}
            this._strategyComposedAt = Date.now()
            return this._strategyPlan
        } catch (err) {
            console.warn("[AES Fleet CC] strategy compose failed", err)
            this._strategyPlan = null
            this._strategyComposeError = (err && err.message) || String(err)
            return null
        } finally {
            this._strategyComposing = false
            this._renderStrategyStripInPlace()
        }
    }

    async _loadCurrentSchedulesForPlan(plan, server) {
        const out = new Map()
        if (!plan || !Array.isArray(plan.perAircraft) || !server) return out
        if (typeof window.AesAfpScheduleStore === "undefined"
                || typeof window.AesAfpScheduleStore.load !== "function") return out
        await Promise.all(plan.perAircraft.map(async a => {
            if (!a || !a.aircraftId) return
            try {
                const sched = await window.AesAfpScheduleStore.load(server, a.aircraftId)
                if (sched && Array.isArray(sched.legs) && sched.legs.length) {
                    out.set(String(a.aircraftId), sched.legs)
                }
            } catch (_) { /* missing tail → diff falls back to v1 stub */ }
        }))
        return out
    }

    /**
     * Decisions worth one-click applying:
     *   - applicable (the engine can fire them today)
     *   - tier + per-domain gate currently allows this domain to apply
     *   - predicted dollar impact passes the per-domain gate
     *     (price moves: any non-zero impact unless objective is profit-max,
     *      since the linear-revenue heuristic misses share/volume gains;
     *      every other domain stays on strict > 0)
     *
     * Kept aligned with auto-driver._impactPasses — when one is loosened,
     * the other has to be too or the manual "Quick-apply N" count drifts
     * from what the auto-tick will actually fire.
     *
     * Returns [] when no plan composed or no decisions match.
     */
    _strategyHighConfDecisions() {
        const diff = this._strategyPlan && this._strategyPlan.diff
        if (!diff || !Array.isArray(diff.decisions) || !diff.decisions.length) return []
        const settings = this._strategySettings
        const ns = window.AesStrategySettings
        const canApply = (s, domain) => {
            if (!ns || typeof ns.canApply !== "function") return false
            try { return !!ns.canApply(s, domain) } catch (_) { return false }
        }
        return diff.decisions.filter(d => {
            if (!d || !d.applicable) return false
            if (!canApply(settings, d.domain)) return false
            const im = d._impact
            if (!im || im.unit !== "$/wk") return false
            const v = Number(im.value)
            if (!isFinite(v) || v === 0) return false
            if (d.domain !== "price") return v > 0
            const objKind = d.payload && d.payload.objective && d.payload.objective.kind
            const trustProposer = objKind === "maxShare"
                               || objKind === "balanced"
                               || objKind === "custom"
            return trustProposer ? true : v > 0
        })
    }

    async _loadScheduleIndex() {
        if (typeof ScheduleStore === "undefined") { this._scheduleIndex = []; return }
        try {
            this._scheduleIndex = await ScheduleStore.listIndex(this.server, this.airlineCode) || []
        } catch (_) { this._scheduleIndex = [] }
    }

    async _loadPresets() {
        if (typeof SchedulePresets === "undefined") { this._presetsBlock = {presets: []}; return }
        try { this._presetsBlock = await SchedulePresets.load() }
        catch (_) { this._presetsBlock = {presets: []} }
    }

    async _loadWaveDrafts() {
        this._waveDrafts.clear()
        if (typeof RouteAssistantWaveDraftStore === "undefined") return
        const hubs = this._uniqueHubs()
        if (!hubs.length) return
        // Hubs are usually a small set (≤ a handful), so per-hub load is fine.
        await Promise.all(hubs.map(async (hub) => {
            try {
                const rec = await RouteAssistantWaveDraftStore.load(hub)
                this._waveDrafts.set(hub, rec || null)
            } catch (_) { this._waveDrafts.set(hub, null) }
        }))
    }

    async _loadAircraftDrafts() {
        this._aircraftDrafts.clear()
        if (typeof AesAfpActiveDraftStore === "undefined") return
        const rows = this._rows
        if (!rows.length) return
        const keys = rows.map(r => "aircraftFlightPlan:draft:" + this.server + ":" + r.aircraftId)
        try {
            const blob = await chrome.storage.local.get(keys)
            for (const r of rows) {
                const k = "aircraftFlightPlan:draft:" + this.server + ":" + r.aircraftId
                const rec = blob[k]
                if (rec && Array.isArray(rec.flights) && rec.flights.length) {
                    this._aircraftDrafts.set(String(r.aircraftId), rec)
                }
            }
        } catch (_) { /* leave empty */ }
    }

    /**
     * User-managed hub overrides (hidden hubs + display labels). Single
     * read off the per-airline FleetHubHubManagement store. Empty record
     * is the safe default — every consumer treats absent fields as
     * "no overrides".
     */
    async _loadHubManagement() {
        if (typeof window.FleetHubHubManagement === "undefined") {
            this._hubManagement = {hiddenHubs: [], labels: {}}
            return
        }
        try {
            this._hubManagement = await window.FleetHubHubManagement.load(
                this.server, this.airlineCode)
        } catch (_) {
            this._hubManagement = {hiddenHubs: [], labels: {}}
        }
    }

    /**
     * Per-aircraft tags (status + roles + notes) — surfaces controlled
     * vocabularies as filter dimensions for routines and as inline chips
     * on the Aircraft tab. Cheap single-key read.
     */
    async _loadAircraftTags() {
        this._aircraftTags = {byAircraftId: {}}
        if (typeof window.AircraftTagsStore === "undefined") return
        try { this._aircraftTags = await window.AircraftTagsStore.load() }
        catch (_) { this._aircraftTags = {byAircraftId: {}} }
    }

    /** Routines list for the routines panel (Phase 3+). Same single-key shape. */
    async _loadRoutines() {
        this._routines = []
        if (typeof window.FleetRoutinesStore === "undefined") return
        try { this._routines = await window.FleetRoutinesStore.list() }
        catch (_) { this._routines = [] }
    }

    /**
     * Known accounts for the routine editor's "sister airlines" picker
     * (Phase 5). Fed by AesAccountRegistry — every airline the user has
     * visited surfaces here. Cross-airline routine *execution* is gated
     * on the user being on that airline's page in v1, so this is mostly
     * scaffolding for the deferred orchestrator.
     */
    async _loadKnownAccounts() {
        this._knownAccounts = []
        if (typeof window.AesAccountRegistry === "undefined") return
        try { this._knownAccounts = await window.AesAccountRegistry.list() }
        catch (_) { this._knownAccounts = [] }
    }

    _uniqueHubs() {
        const set = new Set()
        for (const r of this._rows) {
            if (r && r.hub) set.add(r.hub)
        }
        return Array.from(set)
    }

    /**
     * Operational hub count — union of parked-aircraft hubs, saved-schedule
     * hubs, wave-preset hubs, and active wave-draft hubs. Matches what
     * `_buildHubAggregate` renders on the OVERVIEW tab so the header summary
     * and tab pill stay consistent with the grid.
     */
    _operationalHubCount() {
        const set = new Set()
        for (const r of this._rows) {
            if (r && r.hub) set.add(String(r.hub).toUpperCase())
        }
        for (const e of (this._scheduleIndex || [])) {
            if (e && e.hub) set.add(String(e.hub).toUpperCase())
        }
        for (const p of ((this._presetsBlock && this._presetsBlock.presets) || [])) {
            if (p && p.hub) set.add(String(p.hub).toUpperCase())
        }
        for (const [hub, rec] of this._waveDrafts) {
            if (hub && rec) set.add(String(hub).toUpperCase())
        }
        return set.size
    }

    _attachStorageListener() {
        if (this._storageListener) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return

        const fleetKey  = this.server + this.airlineCode + "aircraftFleet"
        const sIndex    = this.server + this.airlineCode + "scheduleManagement:index"
        const sPrefix   = this.server + this.airlineCode + "scheduleManagement:"
        const afpDraftPrefix    = "aircraftFlightPlan:draft:"    + this.server + ":"
        const afpStatePrefix    = "aircraftFlightPlan:state:"    + this.server + ":"
        const afpSchedulePrefix = "aircraftFlightPlan:schedule:" + this.server + ":"
        const waveDraftPrefix   = "routeAssistant:waveDraft"
        const hubMgmtKey        = "fleetHub:hubManagement:" + this.server + ":" + this.airlineCode

        // Strategy keys repaint the strip in place rather than the whole
        // CC so the user's active tab + scroll position don't reset on
        // every applied plan / learnt-weight bump. Per-account scoping
        // means the auto-driver and apply-pipeline write both the
        // legacy global key AND a `:acct:<id>:` variant — listen for
        // the prefix so either form trips the repaint.
        const STRATEGY_APPLIED_KEY  = "aesStrategy:plan:applied"
        const STRATEGY_WEIGHTS_KEY  = "aesStrategy:learn:weights:current"
        const STRATEGY_AUTOTICK_KEY = "aesStrategy:autoTick:last"

        // Per-account tag + routine stores. Both write the legacy unscoped
        // key (during the rollout) AND the `:acct:<id>:` variant — match
        // either form so writes from any tab fire a repaint.
        const TAGS_KEY     = "aircraftTags"
        const ROUTINES_KEY = "fleetRoutines"

        this._storageListener = (changes, area) => {
            if (area !== "local") return
            let fullHit = false
            let stratHit = false
            for (const k of Object.keys(changes)) {
                if (k === fleetKey)                            { fullHit = true; continue }
                if (k === sIndex)                              { fullHit = true; continue }
                if (k === FleetHubCommandCenter.SETTINGS_KEY)  { fullHit = true; continue }
                if (k === hubMgmtKey)                          { fullHit = true; continue }
                if (k.indexOf(sPrefix)            === 0)       { fullHit = true; continue }
                if (k.indexOf(afpDraftPrefix)     === 0)       { fullHit = true; continue }
                if (k.indexOf(afpStatePrefix)     === 0)       { fullHit = true; continue }
                if (k.indexOf(afpSchedulePrefix)  === 0)       { fullHit = true; continue }
                if (k.indexOf(waveDraftPrefix)    === 0)       { fullHit = true; continue }
                if (k === TAGS_KEY     || k.indexOf(TAGS_KEY     + ":acct:") === 0) { fullHit = true; continue }
                if (k === ROUTINES_KEY || k.indexOf(ROUTINES_KEY + ":acct:") === 0) { fullHit = true; continue }
                if (k === STRATEGY_APPLIED_KEY
                        || k.indexOf(STRATEGY_APPLIED_KEY  + ":acct:") === 0) { stratHit = true; continue }
                if (k === STRATEGY_WEIGHTS_KEY
                        || k.indexOf(STRATEGY_WEIGHTS_KEY  + ":acct:") === 0) { stratHit = true; continue }
                if (k === STRATEGY_AUTOTICK_KEY
                        || k.indexOf(STRATEGY_AUTOTICK_KEY + ":acct:") === 0) { stratHit = true; continue }
            }
            if (fullHit) this._scheduleRepaint()
            else if (stratHit) this._handleStrategyStorageChange()
        }
        try { chrome.storage.onChanged.addListener(this._storageListener) }
        catch (_) { this._storageListener = null }
    }

    /**
     * Subscribe to CentralHubBus events so sibling-panel edits propagate
     * into Fleet CC immediately, without waiting for the 200 ms storage
     * debounce. Storage onChanged remains the source of truth — these are
     * just lower-latency hints. Disposers are tracked in `_busDisposers`
     * and dropped in `dispose()` so handlers don't leak across mounts.
     */
    _attachBusListeners() {
        if (typeof window === "undefined") return
        const bus = window.CentralHubBus
        if (!bus || typeof bus.on !== "function") return

        const sub = (event, handler) => {
            try {
                const off = bus.on(event, handler)
                if (typeof off === "function") this._busDisposers.push(off)
            } catch (err) {
                console.warn("[AES Fleet CC] bus subscribe failed", event, err)
            }
        }

        // Wave-related edits — invalidate caches + repaint.
        const onWaveEdit = () => this._scheduleRepaint()
        sub("waves:preset-updated",      onWaveEdit)
        sub("wavestrip:preset-changed",  onWaveEdit)
        sub("waveeditor:wave-cloned",    onWaveEdit)
        sub("waveeditor:wave-archived",  onWaveEdit)
        sub("waveeditor:wave-split",     onWaveEdit)

        // Strategy decisions applied via apply-pipeline — recompose plan
        // and repaint the strip + Overview decisions list.
        sub("strategy:decision-applied", () => this._handleStrategyStorageChange())

        // Cross-panel focus signals — expand the relevant hub block on
        // the appropriate tab and scroll into view. Defensive: handlers
        // ignore malformed payloads.
        sub("focus-aircraft", (payload) => this._handleFocusAircraft(payload))
        sub("focus-route",    (payload) => this._handleFocusRoute(payload))
    }

    _handleFocusAircraft(payload) {
        try {
            const aircraftId = payload && (payload.aircraftId || payload.id)
            if (!aircraftId) return
            this._activeTab = "aircraft"
            this._expandedAircraft.add(String(aircraftId))
            this._saveExpandedPresets()
            this._render()
            // Scroll the row into view on the next frame, after _render
            // has produced the DOM.
            requestAnimationFrame(() => {
                if (!this.bodyEl) return
                const row = this.bodyEl.querySelector(
                    "[data-aircraft-id=\"" + String(aircraftId).replace(/"/g, "") + "\"]")
                if (row && typeof row.scrollIntoView === "function") {
                    row.scrollIntoView({behavior: "smooth", block: "center"})
                }
            })
        } catch (err) {
            console.warn("[AES Fleet CC] focus-aircraft handler failed", err)
        }
    }

    _handleFocusRoute(payload) {
        try {
            const hub = payload && (payload.hub || payload.origin || payload.iata)
            if (!hub) return
            this._activeTab = "overview"
            this._render()
            requestAnimationFrame(() => {
                if (!this.bodyEl) return
                const card = this.bodyEl.querySelector(
                    "[data-hub-card=\"" + String(hub).toUpperCase().replace(/"/g, "") + "\"]")
                if (card && typeof card.scrollIntoView === "function") {
                    card.scrollIntoView({behavior: "smooth", block: "center"})
                }
            })
        } catch (err) {
            console.warn("[AES Fleet CC] focus-route handler failed", err)
        }
    }

    /**
     * Strategy-only storage hit: invalidate the cached plan, re-read the
     * applied envelope, and recompose lazily in the background. The
     * strip repaints twice — once with the staleness/composing state,
     * once with the fresh plan — both in place.
     */
    _handleStrategyStorageChange() {
        this._strategyPlan = null
        this._strategyComposedAt = 0
        this._loadStrategyAux()
            .then(() => {
                this._renderStrategyStripInPlace()
                return this._composePlan({force: true})
            })
            .catch(err => console.warn("[AES Fleet CC] strategy storage repaint failed", err))
    }

    _scheduleRepaint() {
        if (this._repaintTimer) clearTimeout(this._repaintTimer)
        this._repaintTimer = setTimeout(() => {
            this._repaintTimer = null
            this._loadAuxData()
                .then(() => this._render())
                .catch(err => console.warn("[AES Fleet CC] repaint failed", err))
        }, FleetHubCommandCenter.REPAINT_DEBOUNCE_MS)
    }

    // ── Rendering ────────────────────────────────────────────────────────

    _render() {
        if (!this.rootEl) return
        this.rootEl.textContent = ""
        this.rootEl.appendChild(this._renderHeader())
        this.rootEl.appendChild(this._renderTabBar())
        const body = document.createElement("div")
        body.style.cssText = "padding:12px 14px;"
        this.bodyEl = body
        this.rootEl.appendChild(body)
        this._renderBody()
    }

    _renderHeader() {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = T
            ? [
                "display:flex",
                "flex-direction:column",
                "background:" + T.color.bone2,
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
            ].join(";")
            : "display:flex;flex-direction:column;background:#ece7dc;border-bottom:1px solid #c9c0b0;"

        // ── Title row ────────────────────────────────────────────────────
        const titleRow = document.createElement("div")
        titleRow.style.cssText = T
            ? [
                "display:flex",
                "align-items:center",
                "gap:" + T.sp[2],
                "padding:" + T.sp[2] + " " + T.sp[3]
            ].join(";")
            : "display:flex;align-items:center;gap:8px;padding:8px 12px;"

        const title = document.createElement("div")
        title.style.cssText = T
            ? [
                "flex:1 1 auto",
                "font-family:" + T.font.display,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "font-size:" + T.fs.lead,
                "color:" + T.color.oxide
            ].join(";")
            : "flex:1 1 auto;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;font-size:14px;color:#2b2520;"
        title.textContent = "Fleet Command Center"
        titleRow.appendChild(title)

        const summary = document.createElement("span")
        summary.style.cssText = T
            ? "color:" + T.color.slate + ";font-size:" + T.fs.small + ";font-family:" + T.font.mono + ";"
            : "color:#7a6f66;font-size:11px;font-family:monospace;"
        const hubCount = this._operationalHubCount()
        const fleetCount = this._rows.length
        const draftedCount = this._rows.filter(r => r.hasDraftedPlan).length
        const unassignedCount = this._rows.filter(r => !r.hub).length
        summary.textContent = fleetCount + " aircraft · "
            + hubCount + " hub" + (hubCount === 1 ? "" : "s") + " · "
            + draftedCount + " plan" + (draftedCount === 1 ? "" : "s") + " drafted"
            + (unassignedCount > 0 ? " · " + unassignedCount + " unassigned" : "")
        titleRow.appendChild(summary)

        // When AesStrategy isn't loaded, the strip is omitted but the
        // single Run Strategy button stays in the title row so the user
        // still sees the affordance (it warns + no-ops on click).
        if (typeof window.AesStrategy === "undefined") {
            const strategyBtn = this._actionButton("Run Strategy ▸",
                "Open the cross-module Strategy preview/apply panel",
                () => this._openStrategy())
            titleRow.appendChild(strategyBtn)
        }

        wrap.appendChild(titleRow)

        // ── Strategy strip ───────────────────────────────────────────────
        if (typeof window.AesStrategy !== "undefined") {
            const stripHost = document.createElement("div")
            this._strategyStripHost = stripHost
            this._renderStrategyStrip(stripHost)
            wrap.appendChild(stripHost)
        } else {
            this._strategyStripHost = null
        }

        return wrap
    }

    /**
     * Replace the strategy strip subtree in place — used when compose
     * resolves, when storage events change underlying data, or when the
     * user clicks ⟳. No-ops if the host has been detached (CC repaint
     * replaced the whole header).
     */
    _renderStrategyStripInPlace() {
        const host = this._strategyStripHost
        if (!host || !host.parentElement) return
        this._renderStrategyStrip(host)
    }

    _renderStrategyStrip(host) {
        const T = window.AESTokens
        host.textContent = ""
        host.style.cssText = T
            ? [
                "display:flex",
                "flex-direction:column",
                "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "background:" + T.color.bone
            ].join(";")
            : "display:flex;flex-direction:column;border-top:1px solid #c9c0b0;background:#f4f1ea;"

        const subRow = (children, opts) => {
            const o = opts || {}
            const r = document.createElement("div")
            r.style.cssText = T
                ? [
                    "display:flex",
                    "align-items:center",
                    "gap:" + T.sp[2],
                    "flex-wrap:wrap",
                    "padding:" + T.sp[1] + " " + T.sp[3],
                    o.divider ? "border-top:" + T.geom.bw1 + " dashed " + T.color.paperRule : ""
                ].filter(Boolean).join(";")
                : "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 12px;"
                    + (o.divider ? "border-top:1px dashed #c9c0b0;" : "")
            for (const c of children) {
                if (c) r.appendChild(c)
            }
            return r
        }

        const settings = this._strategySettings
        const plan     = this._strategyPlan
        const diff     = plan && plan.diff
        const planSum  = plan && plan.plan && plan.plan.summary
        const composeErr = this._strategyComposeError
        const composing  = this._strategyComposing

        // ── Row 1 — status (tier · freshness · Δprofit · ORS · ⟳) ─────────
        const r1Children = []
        const tier = settings ? settings.tier : null
        const tierTone = tier === "apply-on-confirm" ? "moss"
                       : tier === "apply-auto"      ? "crimson"
                       :                              "muted"
        r1Children.push(this._badge("TIER · " + (tier || "?"), tierTone))

        if (composing) {
            r1Children.push(this._stripText("composing plan…", "muted"))
        } else if (composeErr) {
            r1Children.push(this._stripText("compose failed: " + composeErr, "crimson"))
        } else if (this._strategyComposedAt) {
            r1Children.push(this._stripText("plan " + this._relativeTime(this._strategyComposedAt), "slate"))
        } else {
            r1Children.push(this._stripText("plan not composed yet", "slate"))
        }

        if (planSum && Number.isFinite(planSum.predictedWeeklyProfit) && planSum.predictedWeeklyProfit !== 0) {
            const v = Math.round(planSum.predictedWeeklyProfit)
            const sign = v >= 0 ? "+" : "-"
            const abs  = Math.abs(v).toLocaleString()
            const tone = v >= 0 ? "moss" : "crimson"
            r1Children.push(this._stripText("pred " + sign + "$" + abs + "/wk", tone))
        }
        if (planSum && Number.isFinite(planSum.predictedOrsAvg)) {
            r1Children.push(this._stripText("ORS " + planSum.predictedOrsAvg.toFixed(2), "slate"))
        }

        // Spacer pushes ⟳ to the right
        const spacer = document.createElement("span")
        spacer.style.cssText = "flex:1 1 auto;"
        r1Children.push(spacer)

        const refreshBtn = this._actionButton("⟳",
            "Recompose strategy plan",
            () => { this._composePlan({force: true}) })
        if (composing) {
            refreshBtn.disabled = true
            refreshBtn.style.opacity = "0.5"
            refreshBtn.style.cursor  = "wait"
        }
        r1Children.push(refreshBtn)

        host.appendChild(subRow(r1Children))

        // ── Row 2 — decision counts ──────────────────────────────────────
        const r2Children = []
        if (composing && !diff) {
            r2Children.push(this._stripText("…", "muted"))
        } else if (composeErr) {
            // Already messaged in row 1; row 2 shows nothing.
        } else if (!diff || !diff.summary) {
            r2Children.push(this._stripText("compose plan to see decisions", "slate"))
        } else {
            const byKind = (diff.summary && diff.summary.byKind) || {}
            const chips = [
                ["sched", byKind.schedule],
                ["svc",   byKind.service],
                ["price", byKind.price],
                ["crew",  byKind.crew],
                ["nr",    byKind.routeCreation]
            ]
            const nonZero = chips.filter(([, n]) => Number(n) > 0)
            if (!nonZero.length) {
                r2Children.push(this._stripText("▸ no proposed changes", "slate"))
            } else {
                r2Children.push(this._stripText("▸", "slate"))
                for (const [label, n] of nonZero) {
                    r2Children.push(this._stripText(n + " " + label, "oxide"))
                }
            }
            const appT = Number(diff.summary.applicableTotal) || 0
            const advT = Number(diff.summary.advisoryTotal)   || 0
            if (appT || advT) {
                r2Children.push(this._stripText(
                    "(" + appT + " applicable · " + advT + " advisory)",
                    "muted"
                ))
            }
        }
        host.appendChild(subRow(r2Children, {divider: true}))

        // ── Row 3 — last apply ───────────────────────────────────────────
        const applied = this._strategyApplied
        if (applied && applied.applyReport) {
            const r = applied.applyReport
            const totals = r.totals || {ok: 0, failed: 0, skipped: 0}
            const ts = applied.ts ? new Date(applied.ts) : null
            const hhmm = ts
                ? String(ts.getHours()).padStart(2, "0") + ":" + String(ts.getMinutes()).padStart(2, "0")
                : "?"
            const r3Children = [
                this._stripText("Last apply " + hhmm, "slate"),
                this._stripText(r.tier || tier || "—", "muted"),
                this._stripText(totals.ok + " ok", "moss"),
                this._stripText(totals.failed + " err", totals.failed ? "crimson" : "muted"),
                this._stripText(totals.skipped + " skip", "muted")
            ]
            if (r.aborted) {
                r3Children.push(this._stripText("aborted: " + (r.abortReason || "?"), "crimson"))
            }
            host.appendChild(subRow(r3Children, {divider: true}))
        }

        // ── Row 3.5 — auto-driver tick status ────────────────────────────
        // Stays visible after the user flips off apply-auto so they can see
        // why nothing's firing — hence the "envelope exists" branch.
        const autoTick = this._strategyAutoTick
        if (tier === "apply-auto" || autoTick) {
            const isOn = tier === "apply-auto"
            const r35 = [
                this._stripText("Auto · " + (isOn ? "ON" : "OFF"), isOn ? "moss" : "muted")
            ]
            if (autoTick) {
                r35.push(this._stripText("last " + this._relativeTime(autoTick.at), "slate"))
                if (autoTick.error) {
                    r35.push(this._stripText("error: " + autoTick.error, "crimson"))
                } else if (autoTick.skippedReason) {
                    r35.push(this._stripText("skipped (" + autoTick.skippedReason + ")", "muted"))
                } else {
                    const ok   = Number(autoTick.applied) || 0
                    const fail = Number(autoTick.failed)  || 0
                    const skip = Number(autoTick.skipped) || 0
                    r35.push(this._stripText(ok + " ok",  "moss"))
                    r35.push(this._stripText(fail + " err", fail ? "crimson" : "muted"))
                    if (skip) r35.push(this._stripText(skip + " skip", "muted"))
                    if (autoTick.aborted) {
                        r35.push(this._stripText("aborted: " + (autoTick.abortReason || "?"), "crimson"))
                    }
                }
            } else {
                r35.push(this._stripText("no ticks yet", "muted"))
            }
            host.appendChild(subRow(r35, {divider: true}))
        }

        // ── Row 4 — actions ──────────────────────────────────────────────
        const r4Children = []
        const runBtn = this._actionButton("Run Strategy ▸",
            "Open the cross-module Strategy preview/apply panel",
            () => this._openStrategy())
        r4Children.push(runBtn)

        const highConf = this._strategyHighConfDecisions()
        const n = highConf.length
        const quickLabel = "Quick-apply " + n + " high-conf ▸"
        const quickTitle = n
            ? "Open the modal pre-selected to " + n + " applicable, positive-impact decisions"
            : "No high-confidence applicable decisions in the current plan"
        const quickBtn = this._actionButton(quickLabel, quickTitle,
            () => this._quickApplyHighConf(highConf))
        if (!n || typeof window.AesStrategyPanel === "undefined") {
            quickBtn.disabled = true
            quickBtn.style.opacity = "0.5"
            quickBtn.style.cursor  = "not-allowed"
        }
        r4Children.push(quickBtn)
        host.appendChild(subRow(r4Children, {divider: true}))
    }

    /**
     * Inline decisions list rendered on the Overview tab. Surfaces the
     * high-confidence applicable decisions with checkboxes, predicted
     * dollar impact, and an "Apply selected" button that calls
     * AesStrategy.apply directly. Returns null when no plan / no
     * decisions / pipeline missing — caller skips the section.
     *
     * Selection state lives on `this._strategySelectedDecisions` so it
     * survives intra-tab repaints (storage events). Cleared on dispose.
     */
    _renderStrategyDecisionsInline() {
        if (typeof window.AesStrategy === "undefined"
                || typeof window.AesStrategy.apply !== "function") return null
        const plan = this._strategyPlan
        if (!plan || !plan.diff) return null
        const decisions = this._strategyHighConfDecisions()
        if (!decisions.length) return null

        const T = window.AESTokens
        const tier = (this._strategySettings && this._strategySettings.tier) || "preview-only"
        const previewOnly = (tier === "preview-only")

        // Prune the selection set to currently-visible decision ids — old
        // ids drop out when the plan recomposes.
        const visibleIds = new Set(decisions.map(d => d.id).filter(Boolean))
        for (const id of Array.from(this._strategySelectedDecisions)) {
            if (!visibleIds.has(id)) this._strategySelectedDecisions.delete(id)
        }

        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:8px 10px;margin-bottom:" + (T ? T.sp[3] : "12px") + ";"
            + "background:" + (T ? T.color.bone3 : "#e0dac8") + ";"
            + "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "border-left:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.cobalt : "#3656a8") + ";"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:8px;margin-bottom:6px;"
        const ttl = document.createElement("span")
        ttl.style.cssText = "font-size:11px;font-weight:" + (T ? T.fw.bold : 700) + ";"
            + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
            + "color:" + (T ? T.color.oxide : "#2b2520") + ";"
        ttl.textContent = "High-confidence proposals"
        head.appendChild(ttl)
        const cnt = document.createElement("span")
        cnt.style.cssText = "font-size:10px;color:" + (T ? T.color.slate : "#7a6f66") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        cnt.textContent = decisions.length + " applicable · tier=" + tier
        head.appendChild(cnt)
        wrap.appendChild(head)

        // Bulk "select all" + Apply selected.
        const ctrls = document.createElement("div")
        ctrls.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;"

        const selAll = document.createElement("input")
        selAll.type = "checkbox"
        const allSelected = decisions.every(d => this._strategySelectedDecisions.has(d.id))
        selAll.checked = allSelected
        selAll.id = "aes-cc-decisions-selall"
        selAll.addEventListener("change", () => {
            if (selAll.checked) {
                for (const d of decisions) this._strategySelectedDecisions.add(d.id)
            } else {
                this._strategySelectedDecisions.clear()
            }
            this._renderBody()
        })
        const selAllLabel = document.createElement("label")
        selAllLabel.htmlFor = "aes-cc-decisions-selall"
        selAllLabel.style.cssText = "font-size:11px;color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "cursor:pointer;display:inline-flex;align-items:center;gap:4px;"
        selAllLabel.append(selAll, document.createTextNode(" Select all"))
        ctrls.appendChild(selAllLabel)

        const applyBtn = this._actionButton(
            "Apply " + this._strategySelectedDecisions.size + " selected",
            previewOnly
                ? "Tier is preview-only — switch to apply-tier in Strategy Settings to enable inline apply."
                : "Apply the selected decisions via AesStrategy.apply. Outcomes propagate to all panels.",
            () => this._applyStrategyDecisionsInline(decisions))
        if (previewOnly || !this._strategySelectedDecisions.size) {
            this._disableButton(applyBtn)
        }
        this._wireBusyDisable(applyBtn, "strategyApply")
        ctrls.appendChild(applyBtn)

        // "Open Strategy panel ▸" safety valve to the full editor.
        if (typeof window.AesStrategyPanel !== "undefined"
                && typeof window.AesStrategyPanel.open === "function") {
            const fullBtn = document.createElement("a")
            fullBtn.href = "#"
            fullBtn.textContent = "Open full editor ▸"
            fullBtn.style.cssText = "margin-left:auto;font-size:10px;"
                + "color:" + (T ? T.color.slate : "#7a6f66") + ";text-decoration:none;"
                + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
            fullBtn.addEventListener("click", (ev) => {
                ev.preventDefault()
                this._openStrategy()
            })
            ctrls.appendChild(fullBtn)
        }
        wrap.appendChild(ctrls)

        // Decision rows.
        const list = document.createElement("ul")
        list.style.cssText = "list-style:none;margin:0;padding:0;"
            + "display:flex;flex-direction:column;gap:2px;"
        for (const d of decisions) {
            list.appendChild(this._renderStrategyDecisionRow(d))
        }
        wrap.appendChild(list)
        return wrap
    }

    _renderStrategyDecisionRow(d) {
        const T = window.AESTokens
        const li = document.createElement("li")
        li.style.cssText = "display:flex;align-items:baseline;gap:8px;font-size:11px;"
            + "padding:3px 6px;background:" + (T ? T.color.bone : "#f4f1ea") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"

        const cb = document.createElement("input")
        cb.type = "checkbox"
        cb.checked = this._strategySelectedDecisions.has(d.id)
        cb.addEventListener("change", () => {
            if (cb.checked) this._strategySelectedDecisions.add(d.id)
            else this._strategySelectedDecisions.delete(d.id)
            this._renderBody()   // refresh "Apply N selected" label
        })
        li.appendChild(cb)

        const dom = document.createElement("span")
        dom.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:10px;"
            + "color:" + (T ? T.color.cobalt : "#3656a8") + ";font-weight:" + (T ? T.fw.bold : 700) + ";"
            + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";min-width:64px;"
        dom.textContent = (d.domain || "—")
        li.appendChild(dom)

        const desc = document.createElement("span")
        desc.style.cssText = "flex:1 1 auto;color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        desc.textContent = d.summary || d.description || d.id || "(no description)"
        desc.title = desc.textContent
        li.appendChild(desc)

        const im = d._impact
        if (im && im.unit === "$/wk") {
            const v = Number(im.value) || 0
            const imp = document.createElement("span")
            imp.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
                + "color:" + (v > 0 ? (T ? T.color.moss : "#2f5f3f") : (T ? T.color.slate : "#7a6f66")) + ";"
                + "font-weight:" + (T ? T.fw.bold : 700) + ";min-width:90px;text-align:right;"
            imp.textContent = (v > 0 ? "+$" : "$") + Math.round(v).toLocaleString() + "/wk"
            li.appendChild(imp)
        }
        return li
    }

    /**
     * Apply the user's selected decisions through the same pipeline the
     * Strategy panel modal uses (AesStrategy.apply). The bus event
     * `strategy:decision-applied` fires from apply-pipeline.js for each
     * applied decision; Phase 0's bus subscription auto-refreshes the
     * Fleet CC.
     */
    async _applyStrategyDecisionsInline(decisions) {
        if (typeof window.AesStrategy === "undefined"
                || typeof window.AesStrategy.apply !== "function") return
        const plan = this._strategyPlan
        if (!plan) return
        const sel = new Set(this._strategySelectedDecisions)
        if (!sel.size) return

        this._setBusy("strategyApply", true)
        try {
            const report = await window.AesStrategy.apply(plan.plan, {
                selected: sel,
                source:   "fleet-cc-inline",
                snapshot: plan.snapshot
            })
            const t = (report && report.totals) || {}
            console.info("[AES Fleet CC] strategy.apply", t)
            this._strategySelectedDecisions.clear()
            // Storage onChanged + bus sub repaints the Overview body.
        } catch (err) {
            console.warn("[AES Fleet CC] strategy.apply threw", err)
        } finally {
            this._setBusy("strategyApply", false)
        }
    }

    /** Plain inline text inside a strip row. Tone keys map to AESTokens colors. */
    _stripText(text, tone) {
        const T = window.AESTokens
        const colorMap = {
            oxide:   T ? T.color.oxide   : "#2b2520",
            slate:   T ? T.color.slate   : "#7a6f66",
            muted:   T ? T.color.slate   : "#7a6f66",
            moss:    T ? T.color.moss    : "#2f5f3f",
            amber:   T ? T.color.amber   : "#b8861f",
            cobalt:  T ? T.color.cobalt  : "#3656a8",
            crimson: T ? T.color.crimson : "#8b2727"
        }
        const span = document.createElement("span")
        span.style.cssText = "color:" + (colorMap[tone] || colorMap.oxide)
            + ";font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
        span.textContent = text
        return span
    }

    _quickApplyHighConf(decisions) {
        if (typeof window.AesStrategyPanel === "undefined"
                || typeof window.AesStrategyPanel.open !== "function") {
            console.warn("[AES Fleet CC] AesStrategyPanel not loaded — quick-apply unavailable")
            return
        }
        const ids = decisions.map(d => d.id).filter(Boolean)
        window.AesStrategyPanel.open({
            preselect: ids,
            filter: {selectedOnly: true, sort: "impact"}
        }).catch(err => console.warn("[AES Fleet CC] quick-apply open failed", err))
    }

    _renderTabBar() {
        const T = window.AESTokens
        const bar = document.createElement("div")
        bar.style.cssText = T
            ? [
                "display:flex",
                "align-items:stretch",
                "gap:0",
                "background:" + T.color.bone,
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
            ].join(";")
            : "display:flex;background:#f4f1ea;border-bottom:1px solid #c9c0b0;"
        this.tabBarEl = bar

        for (const tab of FleetHubCommandCenter.TABS) {
            bar.appendChild(this._renderTabPill(tab))
        }
        return bar
    }

    _renderTabPill(tab) {
        const T = window.AESTokens
        const isActive = tab.id === this._activeTab
        const btn = document.createElement("button")
        btn.type = "button"
        btn.title = isActive ? tab.label + " — active" : "Switch to " + tab.label
        btn.dataset.tabId = tab.id

        const summary = this._tabSummary(tab.id)
        btn.style.cssText = T
            ? [
                "display:inline-flex",
                "flex-direction:column",
                "align-items:center",
                "justify-content:center",
                "padding:" + T.sp[2] + " " + T.sp[3],
                "min-width:120px",
                "background:" + (isActive ? T.color.rust  : "transparent"),
                "color:"      + (isActive ? T.color.bone  : T.color.oxide),
                "border:none",
                "border-right:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "cursor:" + (isActive ? "default" : "pointer"),
                "font-family:" + T.font.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "line-height:" + T.lh.tight
            ].join(";")
            : "display:inline-flex;flex-direction:column;align-items:center;padding:8px 12px;min-width:120px;"
              + "background:" + (isActive ? "#b8472a" : "transparent")
              + ";color:" + (isActive ? "#f4f1ea" : "#2b2520")
              + ";border:none;border-right:1px solid #c9c0b0;cursor:" + (isActive ? "default" : "pointer") + ";"
              + "text-transform:uppercase;letter-spacing:0.08em;"

        const top = document.createElement("span")
        top.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;"
        const glyph = document.createElement("span")
        glyph.textContent = tab.glyph
        glyph.style.cssText = "font-size:11px;opacity:0.85;"
        const label = document.createElement("span")
        label.textContent = tab.label
        top.append(glyph, label)
        btn.append(top)

        if (summary) {
            const sub = document.createElement("span")
            sub.textContent = summary
            sub.style.cssText = T
                ? "font-size:9px;opacity:0.8;font-family:" + T.font.mono + ";text-transform:none;letter-spacing:0;margin-top:2px;"
                : "font-size:9px;opacity:0.8;font-family:monospace;text-transform:none;letter-spacing:0;margin-top:2px;"
            btn.append(sub)
        }

        if (!isActive) btn.addEventListener("click", () => this._setActiveTab(tab.id))
        return btn
    }

    _tabSummary(tabId) {
        if (tabId === "overview")  return this._operationalHubCount() + " hubs"
        if (tabId === "schedules") {
            const n = (this._scheduleIndex || []).length
            return n + " saved"
        }
        if (tabId === "waves") {
            const n = ((this._presetsBlock && this._presetsBlock.presets) || []).length
            return n + " preset" + (n === 1 ? "" : "s")
        }
        if (tabId === "aircraft") {
            return this._aircraftDrafts.size + " w/ draft"
        }
        return ""
    }

    _setActiveTab(tabId) {
        if (this._activeTab === tabId) return
        this._activeTab = tabId
        this._saveActiveTab(tabId)
        this._render()
    }

    _renderBody() {
        if (!this.bodyEl) return
        this.bodyEl.textContent = ""
        const header = this._renderTabHeader(this._activeTab)
        if (header) this.bodyEl.appendChild(header)
        if (this._activeTab === "overview")  return this._renderOverview()
        if (this._activeTab === "schedules") return this._renderSchedules()
        if (this._activeTab === "waves")     return this._renderWaves()
        if (this._activeTab === "aircraft")  return this._renderAircraft()
    }

    /**
     * Top-of-tab KPI strip. Reads from already-loaded aux data so it costs
     * nothing extra. Returns null for the Overview tab — the bulk-ops bar
     * already serves as that tab's header.
     */
    _renderTabHeader(tabId) {
        if (tabId === "overview") return null
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:baseline;gap:10px;"
            + "padding:6px 10px;margin-bottom:" + (T ? T.sp[2] : "8px") + ";"
            + "background:" + (T ? T.color.bone3 : "#e0dac8") + ";"
            + "border-left:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.rust : "#b8472a") + ";"
            + "font-size:11px;color:" + (T ? T.color.slate : "#7a6f66") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"

        let text = ""
        if (tabId === "schedules") {
            const idx = this._scheduleIndex || []
            const withWarn = idx.filter(e => Number(e.warningCount) > 0).length
            const lastEdit = idx.length
                ? idx.reduce((a, e) => (e.generatedAt && e.generatedAt > a) ? e.generatedAt : a, 0)
                : 0
            text = idx.length + " saved"
                + " · " + withWarn + " with warnings"
                + (lastEdit ? " · last edit " + this._relativeTime(lastEdit) : "")
        } else if (tabId === "waves") {
            const presets = (this._presetsBlock && this._presetsBlock.presets) || []
            const variants = presets.filter(p => p && p.tweakedFrom).length
            let drafts = 0
            for (const [, rec] of this._waveDrafts) if (rec) drafts++
            text = presets.length + " preset" + (presets.length === 1 ? "" : "s")
                + " · " + drafts + " w/ active draft"
                + " · " + variants + " variant" + (variants === 1 ? "" : "s")
        } else if (tabId === "aircraft") {
            const total = this._rows.length
            const drafted = this._aircraftDrafts.size
            let pending = 0
            let applied = 0
            for (const draft of this._aircraftDrafts.values()) {
                pending += this._pendingLegCount(draft)
                applied += draft.appliedLegs ? Object.keys(draft.appliedLegs).length : 0
            }
            text = drafted + " / " + total + " w/ draft"
                + " · " + pending + " leg" + (pending === 1 ? "" : "s") + " pending"
                + " · " + applied + " applied"

            // Tag distribution — show the top three statuses inline so the
            // user sees fleet posture (e.g. "5 operational · 2 spare") at
            // a glance without opening every popover.
            const tagsNs = window.AircraftTagsStore
            const tagsBlock = this._aircraftTags || {byAircraftId: {}}
            const dist = tagsNs ? tagsNs.distribution(tagsBlock.byAircraftId) : {status: {}, role: {}}
            const statusEntries = Object.entries(dist.status)
                .sort((a, b) => b[1] - a[1]).slice(0, 3)
            if (statusEntries.length) {
                text += " · " + statusEntries.map(([s, n]) =>
                    n + " " + (tagsNs.STATUS_LABELS[s] || s).toLowerCase()).join(" · ")
            }
        }

        wrap.textContent = text
        return wrap
    }

    // ── Overview tab ─────────────────────────────────────────────────────

    _renderOverview() {
        const T = window.AESTokens
        const hubs = this._buildHubAggregate()

        // Bulk operations bar — always rendered; individual buttons gate on
        // available work (no missing-draft aircraft → Auto-generate disabled,
        // etc.) so the row's affordance is consistent across states.
        this.bodyEl.appendChild(this._renderOverviewBulkBar())

        // Inline strategy decisions block — surfaces the high-confidence
        // applicable plan changes with checkboxes + bulk Apply, skipping
        // the modal trip. Hidden when no plan composed yet.
        const decisionsBlock = this._renderStrategyDecisionsInline()
        if (decisionsBlock) this.bodyEl.appendChild(decisionsBlock)

        if (!hubs.length) {
            const hiddenCount = (this._hubManagement && Array.isArray(this._hubManagement.hiddenHubs))
                ? this._hubManagement.hiddenHubs.length : 0
            this.bodyEl.appendChild(this._emptyState(hiddenCount
                ? "All visible hubs are hidden — unhide any of the " + hiddenCount + " below to bring its card back."
                : "No hub data yet — visit each aircraft's Flight Plan tab once to capture its location."
            ))
            const stripIfAny = this._renderHiddenHubsStrip()
            if (stripIfAny) this.bodyEl.appendChild(stripIfAny)
            return
        }

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:" + (T ? T.sp[3] : "12px") + ";"

        let unassigned = null
        for (const h of hubs) {
            if (h.unassigned) { unassigned = h; continue }
            grid.appendChild(this._renderHubCard(h))
        }
        this.bodyEl.appendChild(grid)
        const hidden = this._renderHiddenHubsStrip()
        if (hidden) this.bodyEl.appendChild(hidden)
        if (unassigned) {
            this.bodyEl.appendChild(this._renderUnassignedBlock(unassigned))
        }
    }

    /**
     * Cross-fleet bulk actions surface. Two buttons today:
     *   - Auto-generate plans for fleet — sweeps every aircraft with a
     *     resolvable hub but no draft, runs the AFP candidate pipeline
     *     against each (concurrency capped to 2), and persists. The proxy
     *     fetcher's per-aircraft cache makes a re-run cheap.
     *   - Apply all pending — for every draft with pending legs, marks every
     *     pending leg applied via AesAfpActiveDraftStore.setApplied. Tier-1
     *     semantic — does not push to AS, only updates the local draft.
     *
     * The bar is informational when there's no work to do (counts displayed
     * as "0 missing", "0 pending"). Each button label updates in flight to
     * "Generating N / M…" / "Applying N / M…" so users can see progress
     * without opening devtools.
     */
    _renderOverviewBulkBar() {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;"
            + "padding:8px 10px;margin-bottom:" + (T ? T.sp[3] : "12px") + ";"
            + "background:" + (T ? T.color.bone3 : "#e0dac8") + ";"
            + "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"

        const title = document.createElement("span")
        title.style.cssText = "flex:0 0 auto;font-size:11px;font-weight:" + (T ? T.fw.bold : 700)
            + ";text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.08em")
            + ";color:" + (T ? T.color.oxide : "#2b2520") + ";"
        title.textContent = "Bulk operations"
        wrap.appendChild(title)

        const pipelineReady = typeof window.AesAfpCandidatePipeline !== "undefined"
            && typeof window.AesAfpProxyPageFetcher  !== "undefined"

        // Aircraft missing a draft (and with a known hub).
        const missing = this._rows.filter(r => r && r.hub
            && !this._aircraftDrafts.has(String(r.aircraftId)))
        // Pending leg total across all drafts.
        let pendingTotal = 0
        for (const draft of this._aircraftDrafts.values()) {
            pendingTotal += this._pendingLegCount(draft)
        }

        // ── Auto-generate plans ───────────────────────────────────────
        const genTitle = !pipelineReady
            ? "AFP candidate pipeline not loaded on this page."
            : !missing.length
                ? "All aircraft with a known hub already have a wave draft."
                : "Build a wave draft for every aircraft missing one (" + missing.length + " aircraft, runs sequentially with concurrency 2)."
        const genBtn = this._actionButton("Auto-generate plans (" + missing.length + ")",
            genTitle, () => this._bulkGenerateMissingDrafts())
        if (!pipelineReady || !missing.length) this._disableButton(genBtn)
        this._wireBusyDisable(genBtn, "bulkGen")
        wrap.appendChild(genBtn)

        // ── Apply all pending ──────────────────────────────────────────
        const apTitle = !pendingTotal
            ? "No pending legs across the fleet."
            : "Mark every pending leg applied across " + this._aircraftDrafts.size
                + " draft" + (this._aircraftDrafts.size === 1 ? "" : "s")
                + " (Tier-1: visit each AFP page to push to AS)."
        const apBtn = this._actionButton("Apply all pending (" + pendingTotal + ")",
            apTitle, () => this._bulkApplyAllPending())
        if (!pendingTotal) this._disableButton(apBtn)
        this._wireBusyDisable(apBtn, "bulkApply")
        wrap.appendChild(apBtn)

        // Trailing summary count (right-aligned).
        const sp = document.createElement("span")
        sp.style.cssText = "flex:1 1 auto;"
        wrap.appendChild(sp)
        const summary = document.createElement("span")
        summary.style.cssText = "font-size:10px;color:" + (T ? T.color.slate : "#7a6f66")
            + ";font-family:" + (T ? T.font.mono : "monospace") + ";"
        summary.textContent = this._aircraftDrafts.size + " / " + this._rows.length + " w/ draft"
        wrap.appendChild(summary)

        return wrap
    }

    /**
     * Sweep aircraft missing a draft and generate one each, sequential
     * with a concurrency cap to keep the proxy fetcher polite. Re-uses
     * _generateForAircraft (so per-aircraft errors surface as toasts and
     * non-fatal). Updates the bulk-button label between batches via a
     * local repaint trigger.
     */
    async _bulkGenerateMissingDrafts() {
        if (this._busy.has("bulkGen")) return
        const targets = this._rows.filter(r => r && r.hub
            && !this._aircraftDrafts.has(String(r.aircraftId)))
        if (!targets.length) return

        this._setBusy("bulkGen", true)
        this._scheduleRepaint()
        let done = 0, ok = 0, fail = 0
        const total = targets.length
        const labelEvery = () => {
            // Update only the bulk button text — full repaint on each
            // batch would lose the in-flight visual.
            const btn = this._findBulkButton("bulkGen")
            if (btn) btn.textContent = "Generating " + done + " / " + total + "…"
        }
        labelEvery()

        const CONCURRENCY = 2
        const queue = targets.slice()
        const workers = []
        for (let i = 0; i < CONCURRENCY; i++) {
            workers.push((async () => {
                while (queue.length) {
                    const row = queue.shift()
                    try {
                        const r = await this._generateForAircraft(row)
                        if (r && r.ok) ok++; else fail++
                    } catch (_) { fail++ }
                    done++
                    labelEvery()
                }
            })())
        }
        try {
            await Promise.all(workers)
            this._toast("info", "Bulk generate: " + ok + " ok · " + fail + " failed")
        } finally {
            this._setBusy("bulkGen", false)
            this._scheduleRepaint()
        }
        return {ok, fail}
    }

    async _bulkApplyAllPending() {
        if (this._busy.has("bulkApply")) return
        const targets = []
        for (const [, draft] of this._aircraftDrafts) {
            if (!draft) continue
            const pending = this._pendingLegCount(draft)
            if (pending > 0) targets.push(draft)
        }
        if (!targets.length) return

        this._setBusy("bulkApply", true)
        this._scheduleRepaint()
        let done = 0, applied = 0
        const total = targets.length
        const labelEvery = () => {
            const btn = this._findBulkButton("bulkApply")
            if (btn) btn.textContent = "Applying " + done + " / " + total + "…"
        }
        labelEvery()

        try {
            for (const draft of targets) {
                const row = this._rows.find(r => r && String(r.aircraftId) === String(draft.aircraftId))
                if (!row) { done++; labelEvery(); continue }
                try {
                    const r = await this._applyPendingForAircraft(row, draft)
                    if (r && r.applied) applied += r.applied
                } catch (e) {
                    console.warn("[AES Fleet CC] bulk apply for "
                        + draft.aircraftId + " failed", e)
                }
                done++
                labelEvery()
            }
            this._toast("info", "Bulk apply: marked " + applied
                + " leg" + (applied === 1 ? "" : "s") + " applied across "
                + done + " aircraft")
        } finally {
            this._setBusy("bulkApply", false)
            this._scheduleRepaint()
        }
        return {applied}
    }

    /** Locate a bulk button in the rendered Overview bar by its busy key. */
    _findBulkButton(key) {
        if (!this.bodyEl) return null
        const btns = this.bodyEl.querySelectorAll("button")
        // The bulk bar buttons are first; we identify them by their
        // labels' prefix since we don't tag them with a data attr.
        for (const b of btns) {
            const t = b.textContent || ""
            if (key === "bulkGen"   && /Auto-generate|Generating/.test(t)) return b
            if (key === "bulkApply" && /Apply all|Applying/.test(t))      return b
        }
        return null
    }

    _renderUnassignedBlock(entry) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = T
            ? [
                "margin-top:" + T.sp[3],
                "padding:" + T.sp[3],
                "border:" + T.geom.bw1 + " dashed " + T.color.paperRule,
                "background:" + T.color.bone,
                "display:flex",
                "flex-direction:column",
                "gap:" + T.sp[2]
            ].join(";")
            : "margin-top:12px;padding:12px;border:1px dashed #c9c0b0;background:#f4f1ea;display:flex;flex-direction:column;gap:8px;"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:8px;"
        const title = document.createElement("span")
        title.style.cssText = T
            ? "font-family:" + T.font.display + ";font-weight:" + T.fw.display + ";font-size:" + T.fs.lead + ";color:" + T.color.oxide + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            : "font-weight:800;font-size:14px;color:#2b2520;text-transform:uppercase;letter-spacing:0.08em;"
        title.textContent = "Unassigned"
        head.appendChild(title)
        const count = document.createElement("span")
        count.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7a6f66") + ";"
        count.textContent = entry.aircraft.length + " aircraft · no known location yet"
        head.appendChild(count)
        wrap.appendChild(head)

        const note = document.createElement("p")
        note.style.cssText = "margin:0;color:" + (T ? T.color.slate : "#7a6f66") + ";font-style:italic;font-size:11px;"
        note.textContent = "Visit each aircraft's Flight Plan tab to populate its hub."
        wrap.appendChild(note)

        const list = document.createElement("ul")
        list.style.cssText = "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px;"
        for (const r of entry.aircraft) {
            const li = document.createElement("li")
            li.style.cssText = "display:flex;align-items:baseline;gap:8px;"
            const reg = document.createElement("strong")
            reg.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.oxide : "#2b2520") + ";"
            reg.textContent = r.registration || ("#" + r.aircraftId)
            li.appendChild(reg)
            const eq = document.createElement("span")
            eq.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-size:11px;"
            eq.textContent = r.equipment || ""
            li.appendChild(eq)
            const open = document.createElement("a")
            open.href = "/app/fleets/aircraft/" + r.aircraftId + "/0"
            open.target = "_blank"
            open.rel = "noopener"
            open.textContent = "Flight Plan ▸"
            open.style.cssText = T
                ? "margin-left:auto;color:" + T.color.rust + ";text-decoration:none;font-size:11px;font-weight:" + T.fw.bold + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
                : "margin-left:auto;color:#b8472a;text-decoration:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;"
            li.appendChild(open)
            list.appendChild(li)
        }
        wrap.appendChild(list)
        return wrap
    }

    /**
     * Build the per-hub aggregate that feeds the OVERVIEW grid.
     *
     * "Operational hub" union — a hub appears as a card iff ANY of:
     *   • ≥1 aircraft parked there (row.hub)
     *   • a saved schedule exists for that hub
     *   • a wave preset names that hub
     *   • a wave draft is open for that hub
     * Drafted-plan leg origins are a *tag*, not a creator: they add a
     * `sources.draftedPlan` flag to existing hubs but never spawn new ones
     * (a one-off draft against an aircraft that's since moved shouldn't
     * mint a phantom hub card).
     *
     * Aircraft with no `r.hub` collapse into a single "(unassigned)" entry
     * appended at the end of the list — never silently dropped.
     */
    _buildHubAggregate() {
        // User-hidden hubs (per-airline override) drop out of the seeding
        // loops AND any aircraft tagged to them fall into UNASSIGNED. This
        // is a UI suppression — the underlying data is untouched, so an
        // unhide flips the card back instantly.
        const hidden = new Set(
            (this._hubManagement && Array.isArray(this._hubManagement.hiddenHubs))
                ? this._hubManagement.hiddenHubs.map(s => String(s).toUpperCase())
                : []
        )

        const byHub = new Map()
        const getOrCreate = (rawHub) => {
            if (!rawHub) return null
            const k = String(rawHub).toUpperCase()
            if (hidden.has(k)) return null
            let entry = byHub.get(k)
            if (!entry) {
                entry = {
                    hub: k,
                    aircraft: [],
                    drafted: 0,
                    liveSchedule: false,
                    aircraftDrafts: 0,
                    appliedLegs: 0,
                    pendingLegs: 0,
                    sources: new Set()
                }
                byHub.set(k, entry)
            }
            return entry
        }

        // ── Pass A — seed from operational signals so empty hubs survive ──
        for (const e of (this._scheduleIndex || [])) {
            if (!e || !e.hub) continue
            const entry = getOrCreate(e.hub)
            if (entry) entry.sources.add("schedule")
        }
        for (const p of ((this._presetsBlock && this._presetsBlock.presets) || [])) {
            if (!p || !p.hub) continue
            const entry = getOrCreate(p.hub)
            if (entry) entry.sources.add("preset")
        }
        for (const [hub, rec] of this._waveDrafts) {
            if (!hub || !rec) continue
            const entry = getOrCreate(hub)
            if (entry) entry.sources.add("waveDraft")
        }

        // ── Pass B — fleet rows. Aircraft without a hub bucket into "unassigned". ──
        const unassigned = {
            hub: "(unassigned)",
            unassigned: true,
            aircraft: [],
            drafted: 0,
            liveSchedule: false,
            aircraftDrafts: 0,
            appliedLegs: 0,
            pendingLegs: 0,
            sources: new Set()
        }
        for (const r of this._rows) {
            // getOrCreate returns null when r.hub is in the hidden set; the
            // aircraft then falls into UNASSIGNED so the user can still see
            // it and unhide the hub from the strip below.
            const created = r.hub ? getOrCreate(r.hub) : null
            const target = created || unassigned
            if (target !== unassigned) target.sources.add("aircraft")
            target.aircraft.push(r)
            if (r.hasDraftedPlan) target.drafted++
            if (r.scheduleStatus === "live") target.liveSchedule = true

            const draft = this._aircraftDrafts.get(String(r.aircraftId))
            if (draft && Array.isArray(draft.flights) && draft.flights.length) {
                target.aircraftDrafts++
                const applied = draft.appliedLegs ? Object.keys(draft.appliedLegs).length : 0
                target.appliedLegs += applied
                target.pendingLegs += Math.max(0, draft.flights.length - applied
                    - (draft.dismissedLegs ? Object.keys(draft.dismissedLegs).length : 0))

                // Drafted-plan leg origins tag existing hubs only — never
                // spawn a new hub card from a stale draft.
                const seen = new Set()
                for (const f of draft.flights) {
                    const orig = f && f.origin ? String(f.origin).toUpperCase() : null
                    if (!orig || seen.has(orig)) continue
                    seen.add(orig)
                    const existing = byHub.get(orig)
                    if (existing) existing.sources.add("draftedPlan")
                }
            }
        }

        // ── Pass C — decorate with schedule + preset + wave-draft hints ──
        const presets = (this._presetsBlock && this._presetsBlock.presets) || []
        const scheduleByHub = new Map()
        for (const e of (this._scheduleIndex || [])) {
            if (!e || !e.hub) continue
            const k = String(e.hub).toUpperCase()
            const cur = scheduleByHub.get(k)
            if (!cur || (e.generatedAt && cur.generatedAt && e.generatedAt > cur.generatedAt)) {
                scheduleByHub.set(k, e)
            }
        }
        for (const entry of byHub.values()) {
            entry.preset = presets.find(p => p && (p.hub || "").toUpperCase() === entry.hub) || null
            entry.waveDraft = this._waveDrafts.get(entry.hub) || null
            entry.lastSchedule = scheduleByHub.get(entry.hub) || null
            entry.empty = entry.aircraft.length === 0
        }

        const list = Array.from(byHub.values())
            .sort((a, b) => b.aircraft.length - a.aircraft.length)
        if (unassigned.aircraft.length) list.push(unassigned)
        return list
    }

    _renderHubCard(hub) {
        const T = window.AESTokens
        const card = document.createElement("div")
        const empty = !!hub.empty
        // Marker for focus-route bus events — Phase 0's _handleFocusRoute
        // queries by this attribute to scroll the matching card into view.
        if (hub.hub) card.dataset.hubCard = String(hub.hub).toUpperCase()
        const cardBg = empty
            ? (T ? T.color.bone : "#f4f1ea")
            : (T ? T.color.bone2 : "#ece7dc")
        card.style.cssText = T
            ? [
                "border:" + T.geom.bw1 + (empty ? " dashed " : " solid ") + T.color.paperRule,
                "background:" + cardBg,
                "padding:" + T.sp[3],
                "display:flex",
                "flex-direction:column",
                "gap:" + T.sp[2],
                empty ? "opacity:0.86" : ""
            ].filter(Boolean).join(";")
            : "border:1px " + (empty ? "dashed" : "solid") + " #c9c0b0;background:" + cardBg + ";padding:12px;display:flex;flex-direction:column;gap:8px;"
                + (empty ? "opacity:0.86;" : "")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:8px;position:relative;"
        const labels = (this._hubManagement && this._hubManagement.labels) || {}
        const customLabel = labels[hub.hub] || ""
        const iata = document.createElement("span")
        iata.style.cssText = T
            ? "font-family:" + T.font.mono + ";font-size:" + T.fs.h3 + ";font-weight:" + T.fw.bold + ";color:" + T.color.oxide + ";letter-spacing:" + T.track.mono + ";"
            : "font-family:monospace;font-size:18px;font-weight:700;color:#2b2520;"
        iata.textContent = customLabel || hub.hub
        head.appendChild(iata)
        if (customLabel) {
            const sub = document.createElement("span")
            sub.style.cssText = T
                ? "font-family:" + T.font.mono + ";font-size:" + T.fs.small + ";color:" + T.color.slate + ";letter-spacing:" + T.track.mono + ";"
                : "font-family:monospace;font-size:11px;color:#7a6f66;"
            sub.textContent = "(" + hub.hub + ")"
            head.appendChild(sub)
        }
        const acCount = document.createElement("span")
        acCount.style.cssText = T
            ? "font-size:" + T.fs.small + ";color:" + T.color.slate + ";"
            : "font-size:11px;color:#7a6f66;"
        acCount.textContent = empty
            ? "no aircraft parked"
            : hub.aircraft.length + " aircraft"
        head.appendChild(acCount)
        if (hub.liveSchedule) head.appendChild(this._badge("LIVE", "moss"))

        // Kebab — hide / rename / clear-drafts. Pushed against the right
        // edge so the row reads IATA · count · LIVE · ⋯ · chevron.
        const kebab = this._renderHubCardMenu(hub, customLabel)
        if (kebab) head.appendChild(kebab)

        if (!empty) {
            const chevron = document.createElement("span")
            chevron.style.cssText = T
                ? "font-size:" + T.fs.small + ";color:" + T.color.slate + ";"
                : "font-size:11px;color:#7a6f66;"
            chevron.textContent = "▸"
            chevron.setAttribute("aria-hidden", "true")
            head.appendChild(chevron)
        }
        card.appendChild(head)

        // Stat lines
        const stats = document.createElement("ul")
        stats.style.cssText = "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px;"
        if (!empty) {
            stats.appendChild(this._statLine("Drafted plans", hub.drafted + " / " + hub.aircraft.length))
        }
        if (hub.aircraftDrafts > 0) {
            stats.appendChild(this._statLine("Wave drafts active", hub.aircraftDrafts + " (" + hub.appliedLegs + " applied / " + hub.pendingLegs + " pending)"))
        }
        if (hub.preset) {
            const wn = (hub.preset.waves || []).length
            stats.appendChild(this._statLine("Wave preset", hub.preset.name + " · " + wn + " wave" + (wn === 1 ? "" : "s")))
        } else if (!empty) {
            stats.appendChild(this._renderWavePresetCreateLine(hub.hub))
        }
        if (hub.waveDraft) {
            stats.appendChild(this._statLine("Wave editor", "draft active", false, "amber"))
        }
        if (hub.lastSchedule) {
            const when = hub.lastSchedule.generatedAt ? this._relativeTime(hub.lastSchedule.generatedAt) : ""
            stats.appendChild(this._statLine("Last schedule", (hub.lastSchedule.flightCount || 0) + " legs"
                + (when ? " · " + when : "")))
        }
        if (empty) {
            const sources = Array.from(hub.sources || [])
                .map(s => s === "schedule"     ? "saved schedule"
                       :  s === "preset"       ? "wave preset"
                       :  s === "waveDraft"    ? "wave draft"
                       :  s === "draftedPlan"  ? "drafted plan"
                       :                          s)
                .join(" · ")
            if (sources) {
                stats.appendChild(this._statLine("Source", sources, true))
            }
        }
        card.appendChild(stats)

        // Actions row
        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;"
        actions.appendChild(this._linkButton("Route Assistant", "Open Route Assistant for " + hub.hub,
            "/app/com/scheduling/" + hub.hub + hub.hub))
        if (!empty) {
            actions.appendChild(this._actionButton("Schedule",
                "Open the Fleet Schedule Grid filtered to " + hub.hub
                    + " with the per-aircraft cockpit (candidates · ORS · competitors · profit)",
                () => this._openHubSchedule(hub)))
            // Phase I — under-drafted callout. When fewer aircraft have a
            // drafted plan than total AND the hub already has a wave preset
            // (so the canvas is meaningful), surface a primary CTA that
            // jumps straight into Schedule Canvas Builder mode for this hub.
            if (hub.preset && hub.drafted < hub.aircraft.length
                && typeof window.CanvasModal !== "undefined") {
                actions.appendChild(this._buildCanvasBuilderButton(hub))
            }
        }
        actions.appendChild(this._actionButton("Markets",
            "Open the route markets page for " + hub.hub,
            () => window.open("/app/com/markets/" + hub.hub, "_blank")))
        card.appendChild(actions)

        // Card-level click → drilldown overlay. Skipped for empty hubs.
        // Inner buttons/links keep their own actions: a target inside an
        // <a> or <button> short-circuits the open() handler.
        if (!empty) {
            card.style.cursor = "pointer"
            card.setAttribute("role", "button")
            card.setAttribute("tabindex", "0")
            card.title = "Open hub drilldown for " + hub.hub
            const open = (ev) => {
                if (ev && ev.target && ev.target.closest && ev.target.closest("button,a")) return
                if (typeof window.FleetHubDrilldownPanel === "undefined") return
                try {
                    window.FleetHubDrilldownPanel.open({
                        server:       this.server,
                        airlineCode:  this.airlineCode,
                        hub:          hub.hub,
                        fleet:        hub.aircraft.slice(),
                        planEnvelope: this._strategyPlan
                    })
                } catch (err) {
                    console.warn("[AES Fleet CC] hub drilldown open failed", err)
                }
            }
            card.addEventListener("click", open)
            card.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault()
                    open(ev)
                }
            })
        }

        return card
    }

    /**
     * Builds the kebab control + on-demand popover for a hub card. Returns
     * null when FleetHubHubManagement isn't loaded so the head still renders
     * cleanly. Click-outside / Escape close the menu; openings are mutually
     * exclusive across cards (only one menu open at a time).
     *
     * Actions:
     *   • Hide hub               — adds IATA to hiddenHubs[]
     *   • Rename label…          — prompts for a display label
     *   • Clear label            — only when a custom label is set
     *   • Clear drafted plans    — bulk-removes AesAfpActiveDraftStore drafts
     *                              for every aircraft tagged to this hub
     *
     * Empty hubs (no aircraft) skip "Clear drafted plans" — there's nothing
     * to clear.
     */
    _renderHubCardMenu(hub, customLabel) {
        if (typeof window.FleetHubHubManagement === "undefined") return null
        const T = window.AESTokens

        const wrap = document.createElement("span")
        wrap.style.cssText = "margin-left:auto;position:relative;display:inline-flex;align-items:center;"

        const btn = document.createElement("button")
        btn.type = "button"
        btn.title = "Hub actions"
        btn.setAttribute("aria-label", "Hub actions for " + hub.hub)
        btn.textContent = "⋯"
        btn.style.cssText = T
            ? [
                "padding:0 " + T.sp[1],
                "background:transparent",
                "border:none",
                "color:" + T.color.slate,
                "font-size:" + T.fs.h3,
                "line-height:1",
                "cursor:pointer"
            ].join(";")
            : "padding:0 4px;background:transparent;border:none;color:#7a6f66;font-size:18px;line-height:1;cursor:pointer;"

        btn.addEventListener("click", (ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            // Toggle: clicking the kebab while its own menu is open closes it.
            if (this._hubMenuDispose && this._hubMenuOpenFor === hub.hub) {
                this._closeHubMenu()
                return
            }
            this._closeHubMenu()
            this._openHubMenu(wrap, hub, customLabel)
        })
        wrap.appendChild(btn)
        return wrap
    }

    _closeHubMenu() {
        if (this._hubMenuDispose) {
            try { this._hubMenuDispose() } catch (_) { /* noop */ }
            this._hubMenuDispose = null
        }
        this._hubMenuOpenFor = null
    }

    _openHubMenu(anchor, hub, customLabel) {
        const T = window.AESTokens
        const menu = document.createElement("div")
        menu.style.cssText = T
            ? [
                "position:absolute",
                "top:100%",
                "right:0",
                "z-index:50",
                "background:" + T.color.bone,
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "box-shadow:0 2px 6px rgba(0,0,0,0.18)",
                "min-width:200px",
                "display:flex",
                "flex-direction:column"
            ].join(";")
            : "position:absolute;top:100%;right:0;z-index:50;background:#f4f1ea;border:1px solid #c9c0b0;box-shadow:0 2px 6px rgba(0,0,0,0.18);min-width:200px;display:flex;flex-direction:column;"
        // Prevent the card's drilldown click from firing through the menu.
        menu.addEventListener("click", (e) => e.stopPropagation())

        const item = (label, onSelect) => {
            const it = document.createElement("button")
            it.type = "button"
            it.textContent = label
            it.style.cssText = T
                ? [
                    "padding:" + T.sp[2] + " " + T.sp[3],
                    "background:transparent",
                    "border:none",
                    "color:" + T.color.oxide,
                    "font-family:" + T.font.display,
                    "font-size:" + T.fs.small,
                    "text-align:left",
                    "cursor:pointer"
                ].join(";")
                : "padding:8px 12px;background:transparent;border:none;color:#2b2520;font-size:11px;text-align:left;cursor:pointer;"
            it.addEventListener("mouseenter", () => {
                it.style.background = T ? T.color.bone2 : "#ece7dc"
            })
            it.addEventListener("mouseleave", () => {
                it.style.background = "transparent"
            })
            it.addEventListener("click", (e) => {
                e.preventDefault()
                e.stopPropagation()
                this._closeHubMenu()
                Promise.resolve()
                    .then(() => onSelect())
                    .catch(err => console.warn("[AES Fleet CC] hub menu action failed", err))
            })
            return it
        }

        menu.appendChild(item("Hide hub", () => this._hubMenuHide(hub)))
        menu.appendChild(item(customLabel ? "Rename label…" : "Set label…",
            () => this._hubMenuRename(hub, customLabel)))
        if (customLabel) {
            menu.appendChild(item("Clear label",
                () => this._hubMenuClearLabel(hub)))
        }
        if (!hub.empty && hub.aircraft && hub.aircraft.length) {
            menu.appendChild(item("Clear drafted plans for hub",
                () => this._hubMenuClearDrafts(hub)))
        }

        anchor.appendChild(menu)
        this._hubMenuOpenFor = hub.hub

        // Close on outside-click or Escape. Both listeners self-detach via
        // the dispose closure stored on the instance.
        const onDocClick = (e) => {
            if (anchor.contains(e.target)) return
            this._closeHubMenu()
        }
        const onKey = (e) => {
            if (e.key === "Escape") this._closeHubMenu()
        }
        // Defer attach so the click that opened the menu doesn't immediately
        // bubble back up and close it.
        setTimeout(() => {
            document.addEventListener("click", onDocClick, true)
            document.addEventListener("keydown", onKey, true)
        }, 0)
        this._hubMenuDispose = () => {
            document.removeEventListener("click", onDocClick, true)
            document.removeEventListener("keydown", onKey, true)
            if (menu.parentElement) menu.parentElement.removeChild(menu)
        }
    }

    async _hubMenuHide(hub) {
        if (!hub || !hub.hub) return
        if (!window.confirm("Hide hub " + hub.hub
                + " from the command center? You can unhide it from the strip below the hub grid.")) {
            return
        }
        await window.FleetHubHubManagement.hide(this.server, this.airlineCode, hub.hub)
        // The storage onChanged listener will fire and trigger _scheduleRepaint,
        // but call it eagerly so the user sees the card disappear immediately
        // even before the listener round-trips.
        this._scheduleRepaint()
    }

    async _hubMenuRename(hub, currentLabel) {
        if (!hub || !hub.hub) return
        const next = window.prompt("Display label for " + hub.hub
            + ".\nLeave blank to clear.", currentLabel || "")
        if (next === null) return
        await window.FleetHubHubManagement.setLabel(
            this.server, this.airlineCode, hub.hub, next.trim())
        this._scheduleRepaint()
    }

    async _hubMenuClearLabel(hub) {
        if (!hub || !hub.hub) return
        await window.FleetHubHubManagement.setLabel(
            this.server, this.airlineCode, hub.hub, "")
        this._scheduleRepaint()
    }

    /**
     * Removes every AesAfpActiveDraftStore record for aircraft currently
     * tagged to this hub. Doesn't touch saved schedules or wave presets —
     * those have their own delete affordances on the Schedules / Waves tabs.
     */
    async _hubMenuClearDrafts(hub) {
        if (!hub || !hub.aircraft || !hub.aircraft.length) return
        if (typeof window.AesAfpActiveDraftStore === "undefined") return
        const count = hub.aircraft.length
        if (!window.confirm("Clear drafted plans for all " + count
                + " aircraft at " + hub.hub + "? Saved schedules and wave presets are not affected.")) {
            return
        }
        const tasks = hub.aircraft.map(r =>
            window.AesAfpActiveDraftStore.remove(this.server, r.aircraftId)
                .catch(err => console.warn("[AES Fleet CC] clear draft failed", r.aircraftId, err)))
        await Promise.all(tasks)
        this._scheduleRepaint()
    }

    /**
     * Strip of "unhide" chips for any hubs the user has hidden. Renders
     * nothing when nothing is hidden — keeps the Overview clean by default.
     */
    _renderHiddenHubsStrip() {
        const hidden = (this._hubManagement && Array.isArray(this._hubManagement.hiddenHubs))
            ? this._hubManagement.hiddenHubs : []
        if (!hidden.length) return null
        if (typeof window.FleetHubHubManagement === "undefined") return null
        const T = window.AESTokens

        const wrap = document.createElement("div")
        wrap.style.cssText = T
            ? [
                "display:flex",
                "align-items:center",
                "flex-wrap:wrap",
                "gap:" + T.sp[2],
                "margin-top:" + T.sp[3],
                "padding:" + T.sp[2] + " " + T.sp[3],
                "background:" + T.color.bone,
                "border:" + T.geom.bw1 + " dashed " + T.color.paperRule
            ].join(";")
            : "display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px;padding:8px 12px;background:#f4f1ea;border:1px dashed #c9c0b0;"

        const title = document.createElement("span")
        title.style.cssText = "font-size:11px;font-weight:" + (T ? T.fw.bold : 700)
            + ";text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.08em")
            + ";color:" + (T ? T.color.oxide : "#2b2520") + ";"
        title.textContent = "Hidden hubs"
        wrap.appendChild(title)

        for (const iata of hidden) {
            const chip = document.createElement("button")
            chip.type = "button"
            chip.title = "Unhide " + iata
            chip.textContent = iata + " ⤴"
            chip.style.cssText = T
                ? [
                    "padding:" + T.sp[1] + " " + T.sp[2],
                    "background:transparent",
                    "color:" + T.color.oxide,
                    "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                    "font-family:" + T.font.mono,
                    "font-size:" + T.fs.small,
                    "letter-spacing:" + T.track.mono,
                    "cursor:pointer"
                ].join(";")
                : "padding:4px 8px;background:transparent;color:#2b2520;border:1px solid #c9c0b0;font-family:monospace;font-size:11px;cursor:pointer;"
            chip.addEventListener("click", async (e) => {
                e.preventDefault()
                try {
                    await window.FleetHubHubManagement.unhide(
                        this.server, this.airlineCode, iata)
                    this._scheduleRepaint()
                } catch (err) {
                    console.warn("[AES Fleet CC] unhide hub failed", iata, err)
                }
            })
            wrap.appendChild(chip)
        }

        return wrap
    }

    // ── Schedules tab ────────────────────────────────────────────────────

    /**
     * Lists every operational hub (union of parked-aircraft hubs, hubs that
     * already have saved schedules, and hubs with a wave preset). Each hub
     * block carries a "+ Generate schedule" button at the top so the user
     * can create a schedule without leaving the page; saved entries below
     * each have a Delete button.
     */
    _renderSchedules() {
        const T = window.AESTokens
        const idx = this._scheduleIndex || []
        const presetsByHub = new Map()
        for (const p of ((this._presetsBlock && this._presetsBlock.presets) || [])) {
            if (!p) continue
            const k = String(p.hub || "").toUpperCase()
            if (!k) continue
            if (!presetsByHub.has(k)) presetsByHub.set(k, [])
            presetsByHub.get(k).push(p)
        }
        const aircraftByHub = new Map()
        for (const r of this._rows) {
            if (!r || !r.hub) continue
            const k = String(r.hub).toUpperCase()
            if (!aircraftByHub.has(k)) aircraftByHub.set(k, [])
            aircraftByHub.get(k).push(r)
        }
        const schedulesByHub = new Map()
        for (const e of idx) {
            const k = (e && e.hub) ? String(e.hub).toUpperCase() : "(NO HUB)"
            if (!schedulesByHub.has(k)) schedulesByHub.set(k, [])
            schedulesByHub.get(k).push(e)
        }

        const hubs = new Set()
        for (const k of presetsByHub.keys())   hubs.add(k)
        for (const k of aircraftByHub.keys())  hubs.add(k)
        for (const k of schedulesByHub.keys()) hubs.add(k)
        const hubList = Array.from(hubs).sort()

        if (!hubList.length) {
            this.bodyEl.appendChild(this._emptyState(
                "No hubs to schedule yet. Park an aircraft, create a wave preset, or generate a schedule to populate this tab."
            ))
            return
        }

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + (T ? T.sp[3] : "12px") + ";"
        for (const hub of hubList) {
            wrap.appendChild(this._renderScheduleHubBlock(
                hub,
                schedulesByHub.get(hub) || [],
                presetsByHub.get(hub) || [],
                aircraftByHub.get(hub) || []
            ))
        }
        this.bodyEl.appendChild(wrap)
    }

    _renderScheduleHubBlock(hub, entries, presetsForHub, aircraftAtHub) {
        const T = window.AESTokens
        const block = document.createElement("div")
        block.style.cssText = T
            ? "border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";background:" + T.color.bone2 + ";"
            : "border:1px solid #c9c0b0;background:#ece7dc;"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:8px;padding:8px 12px;flex-wrap:wrap;"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
        const hubLbl = document.createElement("span")
        hubLbl.style.cssText = T
            ? "font-family:" + T.font.mono + ";font-size:" + T.fs.lead + ";font-weight:" + T.fw.bold + ";color:" + T.color.oxide + ";"
            : "font-family:monospace;font-size:14px;font-weight:700;color:#2b2520;"
        hubLbl.textContent = hub
        head.appendChild(hubLbl)
        const count = document.createElement("span")
        count.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7a6f66") + ";flex:1 1 auto;"
        count.textContent = entries.length + " saved"
            + " · " + aircraftAtHub.length + " aircraft"
            + " · " + presetsForHub.length + " preset" + (presetsForHub.length === 1 ? "" : "s")
        head.appendChild(count)

        head.appendChild(this._renderScheduleGenerateControl(hub, presetsForHub, aircraftAtHub))
        block.appendChild(head)

        if (!entries.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:8px 12px;color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-size:11px;font-style:italic;"
            empty.textContent = "No saved schedules at " + hub + " yet."
            block.appendChild(empty)
        } else {
            const list = document.createElement("ul")
            list.style.cssText = "list-style:none;margin:0;padding:0;"
            for (const e of entries) list.appendChild(this._renderScheduleRow(e, hub))
            block.appendChild(list)
        }
        return block
    }

    /**
     * "+ Generate" with optional inline preset picker. When the hub has more
     * than one preset, an inline `<select>` lets the user pick which one to
     * build from (avoids a separate modal). With one preset, the button is
     * direct. With zero presets or zero parked aircraft, the button is
     * disabled with a title that explains why.
     */
    _renderScheduleGenerateControl(hub, presetsForHub, aircraftAtHub) {
        const wrap = document.createElement("span")
        wrap.style.cssText = "display:inline-flex;gap:6px;align-items:center;"

        const pipelineReady = typeof window.AesAfpCandidatePipeline !== "undefined"
            && typeof window.AesAfpProxyPageFetcher  !== "undefined"
        const noAircraft = !aircraftAtHub.length
        const noPreset   = !presetsForHub.length

        let presetSel = null
        if (presetsForHub.length > 1) {
            presetSel = document.createElement("select")
            presetSel.title = "Pick which preset to build from."
            presetSel.style.cssText = "font-size:11px;padding:2px 4px;"
            for (const p of presetsForHub) {
                const o = document.createElement("option")
                o.value = p.id
                o.textContent = p.name
                presetSel.appendChild(o)
            }
            wrap.appendChild(presetSel)
        }

        let title = "Build a schedule for " + hub + " using this preset and store it."
        if (!pipelineReady) title = "AFP candidate pipeline not loaded on this page."
        else if (noAircraft) title = "No aircraft parked at " + hub + " — generate needs at least one for the candidate seed."
        else if (noPreset)   title = "No wave preset for " + hub + ". Create one in the Waves tab first."

        const btn = this._actionButton("+ Generate schedule", title, () => {
            const presetId = presetSel ? presetSel.value : (presetsForHub[0] && presetsForHub[0].id)
            this._generateSchedule(hub, presetId)
        })
        if (!pipelineReady || noAircraft || noPreset) this._disableButton(btn)
        this._wireBusyDisable(btn, "genSched:" + hub)
        wrap.appendChild(btn)
        return wrap
    }

    _renderScheduleRow(entry, hub) {
        const T = window.AESTokens
        const li = document.createElement("li")
        li.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";font-size:12px;"
        const name = document.createElement("span")
        name.style.cssText = "flex:1 1 auto;color:" + (T ? T.color.oxide : "#2b2520") + ";"
        name.textContent = entry.presetName || "(unnamed schedule)"
        li.appendChild(name)

        const meta = document.createElement("span")
        meta.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
        const when = entry.generatedAt ? this._relativeTime(entry.generatedAt) : ""
        meta.textContent = (entry.flightCount || 0) + " legs"
            + (entry.warningCount ? " · " + entry.warningCount + " warn" : "")
            + (when ? " · " + when : "")
        li.appendChild(meta)

        if (entry.status && entry.status !== "draft") {
            li.appendChild(this._badge(String(entry.status).toUpperCase(),
                entry.status === "applied" ? "moss" : "muted"))
        }

        const delBtn = this._actionButton("Delete",
            "Delete this saved schedule.",
            () => this._deleteSchedule(entry))
        this._wireBusyDisable(delBtn, "delSched:" + entry.scheduleId)
        li.appendChild(delBtn)
        return li
    }

    /**
     * Build a schedule for `hub` using `presetId` and persist via
     * ScheduleStore.save. Reuses AesAfpCandidatePipeline against the first
     * parked aircraft as the candidate seed (the pipeline is per-aircraft —
     * ScheduleBuilder needs a populated candidate set, not a stub). Storage
     * onChanged on the index key triggers the CC repaint.
     */
    async _generateSchedule(hub, presetId) {
        const HUB = String(hub || "").toUpperCase()
        const key = "genSched:" + HUB
        if (this._busy.has(key)) return {ok: false, error: "busy"}
        if (typeof window.ScheduleStore === "undefined") {
            this._toast("error", "ScheduleStore not loaded.")
            return {ok: false, error: "noStore"}
        }
        const pipeline = this._getPipeline()
        const fetcher  = this._getProxyFetcher()
        if (!pipeline || !fetcher) {
            this._toast("error", "AFP modules not loaded — cannot generate from this page.")
            return {ok: false, error: "noPipeline"}
        }
        const seedAircraft = this._rows.find(r => r && r.hub
            && String(r.hub).toUpperCase() === HUB)
        if (!seedAircraft) {
            this._toast("error", "No aircraft parked at " + HUB + ".")
            return {ok: false, error: "noSeed"}
        }
        const preset = this._presetsBlock && this._presetsBlock.presets
            && this._presetsBlock.presets.find(p => p.id === presetId)
            || this._presetForHub(HUB)
        if (!preset) {
            this._toast("error", "No preset for " + HUB + ".")
            return {ok: false, error: "noPreset"}
        }

        this._setBusy(key, true)
        this._scheduleRepaint()
        try {
            const fc = await fetcher.fetchAircraftFormContext(seedAircraft.aircraftId)
            if (!fc || !fc.ok) {
                const msg = (fc && fc.error && fc.error.message) || "fetch form context failed"
                this._toast("error", "Generate at " + HUB + ": " + msg)
                return {ok: false, error: msg}
            }
            const r = await pipeline.generateBuild({
                aircraftId:  seedAircraft.aircraftId,
                formContext: fc.formContext,
                presetId:    preset.id,
                typeId:      seedAircraft.typeId || null
            })
            if (!r || !r.ok) {
                const msg = (r && r.error && r.error.message) || "generate failed"
                this._toast("error", "Generate at " + HUB + ": " + msg)
                return {ok: false, error: msg}
            }
            const flights = (r.build && r.build.flights) || []
            const warnings = (r.build && r.build.warnings) || []
            const record = window.ScheduleStore.newSchedule({
                server:      this.server,
                airlineCode: this.airlineCode,
                presetId:    preset.id,
                presetName:  preset.name,
                hub:         HUB
            })
            record.flights  = flights
            record.warnings = warnings
            await window.ScheduleStore.save(record)
            this._toast("info", "Saved schedule for " + HUB + " — " + flights.length
                + " leg" + (flights.length === 1 ? "" : "s")
                + (warnings.length ? " · " + warnings.length + " warning" + (warnings.length === 1 ? "" : "s") : ""))
            return {ok: true, scheduleId: record.scheduleId}
        } catch (err) {
            console.warn("[AES Fleet CC] generate schedule failed", err)
            this._toast("error", "Generate failed: " + ((err && err.message) || String(err)))
            return {ok: false, error: (err && err.message) || String(err)}
        } finally {
            this._setBusy(key, false)
            this._scheduleRepaint()
        }
    }

    async _deleteSchedule(entry) {
        if (!entry || !entry.scheduleId) return false
        const key = "delSched:" + entry.scheduleId
        if (this._busy.has(key)) return false
        if (typeof window.ScheduleStore === "undefined") return false
        if (!window.confirm("Delete saved schedule \"" + (entry.presetName || entry.scheduleId) + "\"?"))
            return false

        this._setBusy(key, true)
        this._scheduleRepaint()
        try {
            await window.ScheduleStore.remove(this.server, this.airlineCode, entry.scheduleId)
            return true
        } catch (err) {
            console.warn("[AES Fleet CC] delete schedule failed", err)
            this._toast("error", "Delete failed: " + ((err && err.message) || String(err)))
            return false
        } finally {
            this._setBusy(key, false)
            this._scheduleRepaint()
        }
    }

    // ── Waves tab ────────────────────────────────────────────────────────

    _renderWaves() {
        const T = window.AESTokens
        const presets = (this._presetsBlock && this._presetsBlock.presets) || []

        const byHub = new Map()
        for (const p of presets) {
            const hub = (p.hub || "").toUpperCase() || "(global)"
            if (!byHub.has(hub)) byHub.set(hub, [])
            byHub.get(hub).push(p)
        }
        const opHubs = this._uniqueHubs().map(h => String(h).toUpperCase())
        const missingHubs = opHubs.filter(h => !byHub.has(h)).sort()

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + (T ? T.sp[3] : "12px") + ";"

        // Inline create — surface every operational hub that hasn't got a
        // preset yet so the user can build one without bouncing to RA.
        // Presets write through SchedulePresets, which every other surface
        // (RA Wave View, AFP wave-strip, Fleet Schedule Grid wave picker)
        // already reads from — so any preset created here shows up there.
        if (missingHubs.length || !presets.length) {
            wrap.appendChild(this._renderWavesCreateBlock(missingHubs, presets.length === 0))
        }

        const hubs = Array.from(byHub.keys()).sort()
        for (const hub of hubs) {
            wrap.appendChild(this._renderWavesHubBlock(hub, byHub.get(hub)))
        }
        this.bodyEl.appendChild(wrap)
    }

    /**
     * Inline "+ Create wave plan for <HUB>" block. Lists every operational
     * hub that doesn't yet have a preset. When `noneAtAll` is true the copy
     * frames it as the empty-state CTA; otherwise it's a "missing hubs"
     * supplement under the existing per-hub blocks.
     */
    _renderWavesCreateBlock(missingHubs, noneAtAll) {
        const T = window.AESTokens
        const block = document.createElement("div")
        block.style.cssText = T
            ? "border:" + T.geom.bw1 + " dashed " + T.color.paperRule + ";background:" + T.color.bone + ";"
                + "padding:" + T.sp[3] + ";display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
            : "border:1px dashed #c9c0b0;background:#f4f1ea;padding:12px;display:flex;flex-direction:column;gap:8px;"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:8px;"
        const title = document.createElement("span")
        title.style.cssText = T
            ? "font-family:" + T.font.display + ";font-weight:" + T.fw.display + ";font-size:" + T.fs.lead + ";color:" + T.color.oxide + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            : "font-weight:800;font-size:14px;color:#2b2520;text-transform:uppercase;letter-spacing:0.08em;"
        title.textContent = noneAtAll ? "No wave plans yet" : "Hubs without a wave plan"
        head.appendChild(title)
        block.appendChild(head)

        const note = document.createElement("p")
        note.style.cssText = "margin:0;color:" + (T ? T.color.slate : "#7a6f66") + ";font-size:11px;line-height:1.5;"
        note.textContent = "A wave plan reserves arrival + departure slots and tells the auto-scheduler "
            + "how many short / medium / long-haul flights belong in each wave. Edits here sync with "
            + "Route Assistant Wave View, the AFP wave strip, and the Fleet Schedule Grid wave overlay."
        block.appendChild(note)

        const canCreate = typeof RouteAssistantWaveEditor !== "undefined"
            && typeof SchedulePresets !== "undefined"
        if (!canCreate) {
            const warn = document.createElement("p")
            warn.style.cssText = "margin:0;color:" + (T ? T.color.slate : "#7a6f66") + ";font-style:italic;font-size:11px;"
            warn.textContent = "Wave editor not loaded on this page — open Route Assistant to create a preset."
            block.appendChild(warn)
            return block
        }

        if (missingHubs.length) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;"
            for (const hub of missingHubs) {
                row.appendChild(this._renderCreateForHubButton(hub))
            }
            block.appendChild(row)
        }

        // "Custom hub" entry — for hubs not yet in the fleet roster, plus
        // a global-default preset path.
        const customRow = document.createElement("div")
        customRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;"
        const customBtn = this._actionButton(
            "+ Create for another hub…",
            "Prompt for a hub IATA and create a starter wave plan there.",
            () => this._promptCreateForCustomHub()
        )
        customRow.appendChild(customBtn)
        block.appendChild(customRow)

        return block
    }

    _renderCreateForHubButton(hub) {
        const T = window.AESTokens
        const btn = document.createElement("button")
        btn.type = "button"
        btn.title = "Create a starter wave plan for " + hub
            + " (1 wave, 4S/2M/1L composition). Tune in any wave-aware panel."
        btn.textContent = "+ Create for " + hub
        btn.style.cssText = T
            ? [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:" + T.color.rust,
                "color:" + T.color.bone,
                "border:" + T.geom.bw1 + " solid " + T.color.rust,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.small,
                "font-weight:" + T.fw.bold,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "cursor:pointer"
            ].join(";")
            : "padding:4px 8px;background:#b8472a;color:#f4f1ea;border:1px solid #b8472a;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;cursor:pointer;font-size:11px;"
        btn.addEventListener("click", async (ev) => {
            ev.preventDefault()
            await this._createStarterPreset(btn, hub)
        })
        return btn
    }

    async _promptCreateForCustomHub() {
        const raw = window.prompt("Hub IATA for the new wave plan:", "")
        if (!raw) return
        const hub = String(raw).trim().toUpperCase()
        if (!/^[A-Z]{3}$/.test(hub)) {
            window.alert("Hub IATA must be three letters (e.g. JFK).")
            return
        }
        await this._createStarterPreset(null, hub)
    }

    async _createStarterPreset(btn, hub) {
        if (typeof RouteAssistantWaveEditor === "undefined") return
        if (btn) {
            btn.disabled = true
            btn.dataset.prevText = btn.textContent
            btn.textContent = "Creating…"
        }
        try {
            await RouteAssistantWaveEditor.createStarterPreset(hub)
            // Storage onChanged ("settings" key) triggers _scheduleRepaint
            // — the new card lands on its own. No manual re-render needed.
        } catch (err) {
            console.warn("[AES Fleet CC] create starter preset failed", err)
            if (btn) {
                btn.disabled = false
                btn.textContent = btn.dataset.prevText || ("+ Create for " + hub)
            }
        }
    }

    _renderWavesHubBlock(hub, presets) {
        const T = window.AESTokens
        const block = document.createElement("div")
        if (hub && hub !== "(global)") block.dataset.hubCard = String(hub).toUpperCase()
        block.style.cssText = T
            ? "border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";background:" + T.color.bone2 + ";"
            : "border:1px solid #c9c0b0;background:#ece7dc;"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:8px;padding:8px 12px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
        const hubLbl = document.createElement("span")
        hubLbl.style.cssText = T
            ? "font-family:" + T.font.mono + ";font-size:" + T.fs.lead + ";font-weight:" + T.fw.bold + ";color:" + T.color.oxide + ";"
            : "font-family:monospace;font-size:14px;font-weight:700;color:#2b2520;"
        hubLbl.textContent = hub
        head.appendChild(hubLbl)
        const draft = this._waveDrafts.get(hub)
        if (draft) head.appendChild(this._badge("DRAFT", "amber"))
        block.appendChild(head)

        const list = document.createElement("ul")
        list.style.cssText = "list-style:none;margin:0;padding:0;"
        for (const p of presets) list.appendChild(this._renderPresetRow(p, hub))
        block.appendChild(list)

        // Per-hub "+ another plan" affordance — same store, same starter
        // template the AFP wave-strip and RA Wave View use. Skipped for
        // the synthetic "(global)" bucket since starter presets need a
        // hub IATA.
        if (hub !== "(global)" && typeof RouteAssistantWaveEditor !== "undefined") {
            const foot = document.createElement("div")
            foot.style.cssText = "padding:6px 12px;display:flex;justify-content:flex-end;"
            const addBtn = document.createElement("button")
            addBtn.type = "button"
            addBtn.textContent = "+ another plan"
            addBtn.title = "Create an additional starter wave plan for " + hub + "."
            addBtn.style.cssText = "background:transparent;color:" + (T ? T.color.rust : "#b8472a") + ";"
                + "border:1px dashed " + (T ? T.color.rust : "#b8472a") + ";"
                + "padding:2px 8px;font-size:11px;cursor:pointer;"
                + "font-family:" + (T ? T.font.display : "inherit") + ";"
                + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
                + "font-weight:" + (T ? T.fw.bold : "700") + ";"
            addBtn.addEventListener("click", async (ev) => {
                ev.preventDefault()
                await this._createStarterPreset(addBtn, hub)
            })
            foot.appendChild(addBtn)
            block.appendChild(foot)
        }

        return block
    }

    _renderPresetRow(preset, hub) {
        const T = window.AESTokens
        const editorAvailable = typeof window.RouteAssistantWaveEditor !== "undefined"
        const expanded = editorAvailable && this._expandedPresets.has(String(preset.id))

        const li = document.createElement("li")
        li.style.cssText = "display:flex;flex-direction:column;border-bottom:1px solid "
            + (T ? T.color.paperRule : "#c9c0b0") + ";font-size:12px;"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 12px;"
            + (expanded ? "background:" + (T ? T.color.bone3 : "#e0dac8") + ";" : "")

        // Chevron toggle — only if the editor module is loaded; otherwise a
        // static spacer keeps the row layout aligned with editable rows
        // elsewhere in the list.
        if (editorAvailable) {
            const chev = document.createElement("button")
            chev.type = "button"
            chev.textContent = expanded ? "▾" : "▸"
            chev.title = expanded ? "Collapse editor" : "Expand inline wave editor"
            chev.style.cssText = "background:transparent;border:none;cursor:pointer;font-size:11px;"
                + "color:" + (T ? T.color.oxide : "#2b2520") + ";padding:0 4px;"
            chev.addEventListener("click", (e) => {
                e.preventDefault()
                this._togglePresetExpansion(preset.id)
            })
            head.appendChild(chev)
        } else {
            const sp = document.createElement("span")
            sp.style.cssText = "display:inline-block;width:14px;"
            head.appendChild(sp)
        }

        const name = document.createElement("span")
        name.style.cssText = "flex:1 1 auto;color:" + (T ? T.color.oxide : "#2b2520") + ";"
        name.textContent = preset.name || "(unnamed)"
        head.appendChild(name)

        const wn = (preset.waves || []).length
        const meta = document.createElement("span")
        meta.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
        meta.textContent = wn + " wave" + (wn === 1 ? "" : "s")
            + (preset.tweakedFrom ? " · variant" : "")
        head.appendChild(meta)

        if (preset.tweakedFrom) head.appendChild(this._badge("VARIANT", "cobalt"))

        const open = document.createElement("a")
        open.href = "/app/com/scheduling/" + (hub === "(global)" ? "" : hub + hub)
        open.target = "_blank"
        open.rel = "noopener"
        open.textContent = "Open ▸"
        open.style.cssText = T
            ? "color:" + T.color.rust + ";text-decoration:none;font-size:11px;font-weight:" + T.fw.bold + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            : "color:#b8472a;text-decoration:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;"
        open.title = "Open Route Assistant at this hub"
        head.appendChild(open)

        li.appendChild(head)
        if (expanded) li.appendChild(this._renderPresetEditor(preset, hub))
        return li
    }

    _togglePresetExpansion(presetId) {
        const id = String(presetId)
        if (this._expandedPresets.has(id)) this._expandedPresets.delete(id)
        else this._expandedPresets.add(id)
        this._saveExpandedPresets()
        // Re-render just the body so the KPI header + new editor body land
        // together; full _render would reset scroll position.
        if (this._activeTab === "waves") this._renderBody()
    }

    /**
     * Inline wave editor body, mounted under an expanded preset row on the
     * Waves tab. Composes four sibling-panel surfaces in one place:
     *   - Preset CRUD (RouteAssistantWaveEditor.renderPresetActions)
     *   - Factors row (slot window + day pattern, lifted from SchedulePanel)
     *   - Draft promote/discard/save-as-variant (RouteAssistantWaveDraftStore)
     *   - Wave Gantt timeline (RouteAssistantWaveOverlay.renderGantt) with
     *     per-lane composition spinners + HH:MM inputs + delete via
     *     RouteAssistantWaveEditor.enhanceLaneLabel
     *
     * All edits write through SchedulePresets / WaveDraftStore — storage
     * onChanged + the bus subscriptions added in `_attachBusListeners`
     * drive repaint; we wire callbacks only for fast-path UI fixups
     * (e.g. keeping a duplicated preset expanded).
     */
    _renderPresetEditor(preset, hub) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:10px 12px 12px;"
            + "background:" + (T ? T.color.bone : "#f4f1ea") + ";"
            + "border-top:" + (T ? T.geom.bw1 : "1px") + " dashed " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "display:flex;flex-direction:column;gap:8px;"

        if (typeof window.RouteAssistantWaveEditor === "undefined") {
            const note = document.createElement("div")
            note.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-style:italic;font-size:11px;"
            note.textContent = "Wave editor module not loaded on this page. Open Route Assistant to edit."
            wrap.appendChild(note)
            return wrap
        }

        // ── Preset CRUD strip ──────────────────────────────────────────
        const crudHost = document.createElement("div")
        crudHost.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;"
        const presets = (this._presetsBlock && this._presetsBlock.presets) || []
        const presetActions = window.RouteAssistantWaveEditor.renderPresetActions(preset, presets, {
            hubIata: hub,
            onPickPreset:    () => { /* CC doesn't track an active preset; no-op */ },
            onAfterCreate:   () => { /* storage onChanged repaints */ },
            onAfterDuplicate:(p) => { if (p && p.id) this._expandedPresets.add(String(p.id)) },
            onAfterRename:   () => { /* storage onChanged repaints */ },
            onAfterDelete:   (id) => { this._expandedPresets.delete(String(id)) }
        })
        crudHost.appendChild(presetActions)
        // "Open full editor ▸" safety valve — deep-link to RA Wave View.
        const openLink = document.createElement("a")
        openLink.href = "/app/com/scheduling/" + (hub === "(global)" ? "" : hub + hub)
        openLink.target = "_blank"
        openLink.rel = "noopener"
        openLink.textContent = "Open full editor ▸"
        openLink.title = "Open Route Assistant Wave View for this hub in a new tab"
        openLink.style.cssText = "margin-left:auto;font-size:10px;"
            + "color:" + (T ? T.color.slate : "#7a6f66") + ";"
            + "text-decoration:none;text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
        crudHost.appendChild(openLink)
        wrap.appendChild(crudHost)

        // ── Factors row (compact: slot window + day pattern) ───────────
        wrap.appendChild(this._renderFactorsRow(preset))

        // ── Draft strip (active draft → promote / discard / save variant;
        //                 otherwise → fork-into-draft button) ─────────────
        wrap.appendChild(this._renderDraftStrip(preset, hub))

        // ── Wave Gantt timeline ────────────────────────────────────────
        const ganttHost = document.createElement("div")
        ganttHost.style.cssText = "background:#0a1019;border:1px solid #1f2937;border-radius:4px;"
            + "padding:8px 10px;color:#cbd5e1;"
        wrap.appendChild(ganttHost)

        const ganttReady = typeof window.RouteAssistantWaveOverlay !== "undefined"
            && typeof ScheduleFactors !== "undefined"
        if (!ganttReady) {
            ganttHost.textContent = "Gantt module not loaded on this page."
            return wrap
        }
        try {
            window.RouteAssistantWaveOverlay.renderGantt(ganttHost, {
                preset:      preset,
                flights:     [],
                warnings:    [],
                connections: [],
                unplaced:    [],
                routes:      []
            }, {
                hubIata: hub === "(global)" ? "" : hub,
                onEnhanceLabel: (labelEl, wave, p) => {
                    window.RouteAssistantWaveEditor.enhanceLaneLabel(labelEl, wave, p, {
                        onComposition: (waveId, partial) => {
                            window.RouteAssistantWaveEditor.updateWaveComposition(preset.id, waveId, partial)
                                .catch(err => console.warn("[AES Fleet CC] updateWaveComposition failed", err))
                        },
                        onTime: (waveId, field, time) => {
                            window.RouteAssistantWaveEditor.updateWaveTime(preset.id, waveId, field, time)
                                .catch(err => console.warn("[AES Fleet CC] updateWaveTime failed", err))
                        },
                        onRemoveWave: (waveId) => {
                            window.RouteAssistantWaveEditor.removeWave(preset.id, waveId)
                                .catch(err => console.warn("[AES Fleet CC] removeWave failed", err))
                        }
                    })
                },
                onAddWave: () => {
                    window.RouteAssistantWaveEditor.addWave(preset.id)
                        .catch(err => console.warn("[AES Fleet CC] addWave failed", err))
                }
            })
        } catch (err) {
            console.warn("[AES Fleet CC] renderGantt failed", err)
            ganttHost.textContent = "Gantt render failed — see console."
        }
        return wrap
    }

    /**
     * Compact factors editor: slot window (HH:MM start–end) + day pattern
     * dropdown (custom mask via 7 checkbox toggles below). Mirrors
     * `SchedulePanel._buildFactorsSection` (line 269) but trims to the
     * fields the user typically tunes inline. Min/max transfer +
     * turnaround buffer remain in the full Schedule Management editor.
     */
    _renderFactorsRow(preset) {
        const T = window.AESTokens
        const f = (preset && preset.factors) || {}
        const slot = f.slotWindow || {start: "06:00", end: "23:00"}

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;"
            + "padding:6px 8px;background:" + (T ? T.color.bone2 : "#ece7dc") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "font-size:11px;"

        const lbl = (txt) => {
            const s = document.createElement("span")
            s.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";"
                + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
                + "font-weight:" + (T ? T.fw.bold : "700") + ";"
            s.textContent = txt
            return s
        }

        wrap.appendChild(lbl("Slot"))
        const slotStart = this._mkTimeField(slot.start || "06:00", async (v) => {
            const next = Object.assign({}, f, {slotWindow: Object.assign({}, slot, {start: v})})
            await SchedulePresets.update(preset.id, {factors: next})
        })
        const dash = document.createElement("span")
        dash.textContent = "–"
        dash.style.color = T ? T.color.slate : "#7a6f66"
        const slotEnd = this._mkTimeField(slot.end || "23:00", async (v) => {
            const next = Object.assign({}, f, {slotWindow: Object.assign({}, slot, {end: v})})
            await SchedulePresets.update(preset.id, {factors: next})
        })
        wrap.append(slotStart, dash, slotEnd)

        wrap.appendChild(lbl("Days"))
        const daySel = document.createElement("select")
        daySel.style.cssText = "padding:1px 4px;font-size:11px;"
            + "background:" + (T ? T.color.bone : "#f4f1ea") + ";color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
        for (const opt of [["daily","Daily"], ["weekdays","Weekdays"], ["weekends","Weekends"], ["custom","Custom"]]) {
            const o = document.createElement("option")
            o.value = opt[0]; o.textContent = opt[1]
            if ((f.dayPattern || "daily") === opt[0]) o.selected = true
            daySel.appendChild(o)
        }
        daySel.addEventListener("change", async () => {
            const next = Object.assign({}, f, {dayPattern: daySel.value})
            await SchedulePresets.update(preset.id, {factors: next})
        })
        wrap.appendChild(daySel)

        if ((f.dayPattern || "daily") === "custom") {
            const dayNames = ["M", "T", "W", "T", "F", "S", "S"]
            const mask = (typeof ScheduleFactors !== "undefined")
                ? ScheduleFactors.resolveDayMask("custom", f.dayMask)
                : (f.dayMask || [1,1,1,1,1,1,1])
            for (let i = 0; i < 7; i++) {
                const on = !!mask[i]
                const tgl = document.createElement("button")
                tgl.type = "button"
                tgl.textContent = dayNames[i]
                tgl.title = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"][i]
                tgl.style.cssText = "width:22px;height:22px;padding:0;font-size:10px;cursor:pointer;"
                    + "background:" + (on ? (T ? T.color.rust : "#b8472a") : "transparent") + ";"
                    + "color:" + (on ? (T ? T.color.bone : "#f4f1ea") : (T ? T.color.oxide : "#2b2520")) + ";"
                    + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
                    + "font-weight:" + (T ? T.fw.bold : "700") + ";"
                tgl.addEventListener("click", async () => {
                    const next = mask.slice()
                    next[i] = on ? 0 : 1
                    await SchedulePresets.update(preset.id, {factors: Object.assign({}, f, {dayMask: next})})
                })
                wrap.appendChild(tgl)
            }
        }

        return wrap
    }

    _mkTimeField(value, onChange) {
        const T = window.AESTokens
        const inp = document.createElement("input")
        inp.type = "time"
        inp.value = value
        inp.style.cssText = "padding:1px 4px;font-size:11px;width:78px;"
            + "background:" + (T ? T.color.bone : "#f4f1ea") + ";color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
        inp.addEventListener("change", () => {
            if (!/^\d{2}:\d{2}$/.test(inp.value)) return
            Promise.resolve(onChange(inp.value)).catch(err => console.warn("[AES Fleet CC] time field save failed", err))
        })
        return inp
    }

    /**
     * Draft strip: when a draft is active for this hub, surface promote /
     * save-as-variant / discard. When no draft is active, surface a "fork
     * into draft" button that duplicates the preset under
     * RouteAssistantWaveDraftStore so the user can experiment without
     * touching the baseline.
     */
    _renderDraftStrip(preset, hub) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;"

        if (typeof RouteAssistantWaveDraftStore === "undefined" || hub === "(global)") {
            return wrap   // no-op container preserves grid spacing
        }

        const draftRec = this._waveDrafts.get(hub) || null
        const isDraft = !!(draftRec && preset.id === draftRec.draftPresetId)
        const hasDraft = !!draftRec

        if (isDraft) {
            const banner = document.createElement("span")
            banner.style.cssText = "color:" + (T ? T.color.amber : "#b8861f") + ";"
                + "font-weight:" + (T ? T.fw.bold : "700") + ";text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
            banner.textContent = "Draft of " + (draftRec.baselineId ? "baseline" : "(deleted baseline)")
            wrap.appendChild(banner)
            const promote = this._mkDraftBtn("Promote → baseline",
                "Copy this draft's waves + factors back into the baseline preset, then delete the draft.",
                () => RouteAssistantWaveDraftStore.promoteToBaseline(hub))
            const variant = this._mkDraftBtn("Save as variant",
                "Keep both baseline and this draft; rename the draft as a variant.",
                () => RouteAssistantWaveDraftStore.saveAsVariant(hub))
            const discard = this._mkDraftBtn("Discard draft",
                "Delete this draft and clear the draft record.",
                () => RouteAssistantWaveDraftStore.discard(hub))
            wrap.append(promote, variant, discard)
        } else if (hasDraft) {
            const banner = document.createElement("span")
            banner.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";"
            banner.textContent = "(draft active for " + hub + " — switch to it via the picker above)"
            wrap.appendChild(banner)
        } else {
            const fork = this._mkDraftBtn("Fork as draft",
                "Duplicate this preset into a sandboxed draft. Edit freely, then promote or save as variant.",
                async () => {
                    const created = await RouteAssistantWaveDraftStore.beginDraft(hub, preset)
                    if (created && created.id) {
                        this._expandedPresets.add(String(created.id))
                        this._saveExpandedPresets()
                    }
                    return created
                })
            wrap.appendChild(fork)
        }
        return wrap
    }

    _mkDraftBtn(label, title, action) {
        const T = window.AESTokens
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = label
        btn.title = title
        btn.style.cssText = "padding:2px 8px;font-size:10px;cursor:pointer;"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "border:1px dashed " + (T ? T.color.oxide : "#2b2520") + ";"
            + "font-weight:" + (T ? T.fw.bold : "700") + ";text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
        btn.addEventListener("click", async (ev) => {
            ev.preventDefault()
            const prev = btn.textContent
            btn.disabled = true
            btn.textContent = "…"
            try { await action() }
            catch (err) {
                console.warn("[AES Fleet CC] draft action failed", label, err)
                btn.disabled = false
                btn.textContent = prev
            }
            // Storage onChanged + bus sub repaint; no manual re-render.
        })
        return btn
    }

    // ── Aircraft Plans tab ───────────────────────────────────────────────

    /**
     * Lists every aircraft, not just those with drafts. Per-row buttons drive
     * the state transitions: Generate (no draft) → Apply N pending (legs to
     * mark applied) → Discard (clears the draft entirely). Always-visible AFP
     * link stays so users can jump into the per-aircraft page if they want
     * the full editor instead of the inline action.
     */
    // ── Routines panel ───────────────────────────────────────────────────

    /**
     * Top-level container — chrome (header + collapsible body) plus the
     * routine-row list and (when active) an inline editor row. Always
     * rendered; the body collapses to a one-liner when empty.
     */
    _renderRoutinesPanel() {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-bottom:" + (T ? T.sp[3] : "12px") + ";"
            + "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "background:" + (T ? T.color.bone2 : "#ece7dc") + ";"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;"
            + "background:" + (T ? T.color.bone3 : "#e0dac8") + ";"
            + "border-bottom:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"

        const chev = document.createElement("button")
        chev.type = "button"
        chev.textContent = this._routinesPanelOpen ? "▾" : "▸"
        chev.title = this._routinesPanelOpen ? "Collapse routines" : "Expand routines"
        chev.style.cssText = "background:transparent;border:none;cursor:pointer;font-size:11px;"
            + "color:" + (T ? T.color.oxide : "#2b2520") + ";padding:0 4px;"
        chev.addEventListener("click", (e) => {
            e.preventDefault()
            this._routinesPanelOpen = !this._routinesPanelOpen
            if (this._activeTab === "aircraft") this._renderBody()
        })
        head.appendChild(chev)

        const title = document.createElement("span")
        title.style.cssText = "font-weight:" + (T ? T.fw.bold : 700) + ";"
            + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.08em") + ";"
            + "color:" + (T ? T.color.oxide : "#2b2520") + ";font-size:11px;"
        title.textContent = "Routines"
        head.appendChild(title)

        const count = document.createElement("span")
        count.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-size:11px;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";flex:1 1 auto;"
        count.textContent = (this._routines || []).length + " defined"
        head.appendChild(count)

        const newBtn = this._actionButton("+ New routine",
            "Create a new routine — bundle aircraft selection, preset, and strategy policy.",
            () => {
                this._editingRoutineId = "new"
                this._routinesPanelOpen = true
                if (this._activeTab === "aircraft") this._renderBody()
            })
        head.appendChild(newBtn)
        wrap.appendChild(head)

        if (!this._routinesPanelOpen) return wrap

        const body = document.createElement("div")
        body.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:6px;"

        // Editor for the "new routine" case lives at the top of the body
        // so it doesn't push existing routines out of view.
        if (this._editingRoutineId === "new") {
            body.appendChild(this._renderRoutineEditor(null))
        }

        const routines = this._routines || []
        if (!routines.length && this._editingRoutineId !== "new") {
            const empty = document.createElement("div")
            empty.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-style:italic;font-size:11px;padding:6px 0;"
            empty.textContent = "No routines defined. Click + New routine to bundle a "
                + "filter + preset + strategy policy you can apply with one click."
            body.appendChild(empty)
        }

        for (const r of routines) {
            body.appendChild(this._renderRoutineRow(r))
            if (this._editingRoutineId === r.id) {
                body.appendChild(this._renderRoutineEditor(r))
            }
        }
        wrap.appendChild(body)
        return wrap
    }

    /**
     * One routine in the list — name + filter summary + matched-count chip
     * + action buttons. Click Edit to expand the inline editor (which
     * lands as the next sibling, see `_renderRoutinesPanel`).
     */
    _renderRoutineRow(routine) {
        const T = window.AESTokens
        const row = document.createElement("div")
        const editing = this._editingRoutineId === routine.id
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;"
            + "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "background:" + (editing ? (T ? T.color.bone3 : "#e0dac8") : (T ? T.color.bone : "#f4f1ea")) + ";"
            + "font-size:12px;"

        const name = document.createElement("strong")
        name.textContent = routine.name || "(unnamed routine)"
        name.style.cssText = "flex:0 0 auto;color:" + (T ? T.color.oxide : "#2b2520") + ";"
        row.appendChild(name)

        const summary = document.createElement("span")
        summary.style.cssText = "flex:1 1 auto;color:" + (T ? T.color.slate : "#7a6f66") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
        summary.textContent = this._summarizeRoutine(routine)
        row.appendChild(summary)

        const matched = this._matchAircraftFor(routine).length
        row.appendChild(this._chip(matched + " matched",
            matched > 0 ? "moss" : "muted"))

        const applyBtn = this._actionButton("Apply",
            matched > 0
                ? "Run this routine — generate drafts for " + matched
                    + " aircraft"
                    + (routine.strategyPolicy && routine.strategyPolicy.domains
                        && routine.strategyPolicy.domains.scheduleApplyEnabled === true
                        ? " and mark every pending leg applied"
                        : "")
                    + "."
                : "No aircraft match this routine's filter.",
            () => this._handleRoutineApply(routine))
        if (matched <= 0) this._disableButton(applyBtn)
        this._wireBusyDisable(applyBtn, "applyRoutine:" + routine.id)
        row.appendChild(applyBtn)

        const editBtn = this._actionButton(editing ? "Cancel" : "Edit",
            editing ? "Discard pending edits" : "Edit this routine",
            () => {
                this._editingRoutineId = editing ? null : routine.id
                if (this._activeTab === "aircraft") this._renderBody()
            })
        row.appendChild(editBtn)

        const delBtn = this._actionButton("Delete",
            "Delete this routine.",
            () => this._handleRoutineDelete(routine))
        this._wireBusyDisable(delBtn, "delRoutine:" + routine.id)
        row.appendChild(delBtn)

        // Last-applied summary chip — folds the persisted apply report
        // into a one-line ("12 ok · 0 fail · 5h ago") so the user sees
        // run history without opening the routine.
        if (routine.lastAppliedAt) {
            const t = routine.lastAppliedReport && routine.lastAppliedReport.totals
            const summary = (t ? t.ok + " ok · " + t.fail + " fail · " : "")
                + this._relativeTime(routine.lastAppliedAt)
            const chip = this._chip(summary, t && t.fail ? "amber" : "moss")
            chip.style.opacity = "0.85"
            row.appendChild(chip)
        }

        return row
    }

    /**
     * Apply a routine via FleetRoutineOrchestrator. Confirms first when
     * matched count is large or when the policy enables auto-apply of
     * schedule legs (which marks AS-pushable state). Updates the Apply
     * button label live so the user sees per-aircraft progress.
     */
    async _handleRoutineApply(routine) {
        if (typeof window.FleetRoutineOrchestrator === "undefined") {
            this._toast("error", "Routine orchestrator not loaded.")
            return
        }
        const key = "applyRoutine:" + routine.id
        if (this._busy.has(key)) return

        const matched = this._matchAircraftFor(routine)
        if (!matched.length) {
            this._toast("error", "No aircraft match this routine's filter.")
            return
        }
        const willApply = !!(routine.strategyPolicy
            && routine.strategyPolicy.domains
            && routine.strategyPolicy.domains.scheduleApplyEnabled === true)
        const confirmMsg = "Run \"" + routine.name + "\" on " + matched.length
            + " aircraft?"
            + (willApply
                ? "\n\nThis will also mark every pending leg as applied. (Tier-1 — "
                  + "you'll still need to visit the AFP page to push to AirlineSim.)"
                : "")
        if (!window.confirm(confirmMsg)) return

        this._setBusy(key, true)
        this._scheduleRepaint()

        // Live label updates without forcing a full repaint mid-run —
        // _findApplyRoutineButton walks the body looking for the routine's
        // dataset tag (set in _renderRoutineRow's edit/cancel button — we
        // tag the row's apply button on render so we can find it).
        const ctx = {
            server:      this.server,
            airlineCode: this.airlineCode,
            rows:        this._rows,
            tags:        this._aircraftTags,
            presets:     this._presetsBlock,
            concurrency: 2,
            onAircraftStart: (id, ix, total) => {
                this._setApplyRoutineLabel(routine.id, "Applying " + ix + " / " + total + "…")
            },
            onAircraftDone: (id, ix, total) => {
                this._setApplyRoutineLabel(routine.id, "Applied " + ix + " / " + total)
            }
        }

        try {
            const report = await window.FleetRoutineOrchestrator.run(routine, ctx)
            const t = report.totals || {ok: 0, fail: 0, generated: 0, applied: 0}
            const deferred = (report.deferredAccountIds || []).length
            this._toast(t.fail ? "warn" : "info",
                "Routine \"" + routine.name + "\": "
                    + t.ok + " ok · " + t.fail + " fail · "
                    + t.generated + " legs generated"
                    + (willApply ? " · " + t.applied + " marked applied" : "")
                    + (deferred > 0 ? " · " + deferred + " sister airline"
                        + (deferred === 1 ? "" : "s") + " deferred (visit them to run)" : ""))
        } catch (err) {
            console.warn("[AES Fleet CC] routine apply threw", err)
            this._toast("error", "Routine apply failed: " + ((err && err.message) || String(err)))
        } finally {
            this._setBusy(key, false)
            this._scheduleRepaint()
        }
    }

    /** Find a routine's Apply button by searching the rendered body for its
     *  busy-key marker. Best-effort — returns null if the row isn't visible. */
    _setApplyRoutineLabel(routineId, label) {
        if (!this.bodyEl) return
        // The button has its busy key wired but no data attribute we can
        // grep. Walk all buttons and match by title prefix + the row's
        // strong-name proximity. Cheap because the routines panel rarely
        // has more than a handful of rows.
        const btns = this.bodyEl.querySelectorAll("button")
        for (const b of btns) {
            const t = b.textContent || ""
            if (t.indexOf("Apply") === 0 || t.indexOf("Applying") === 0
                    || t.indexOf("Applied") === 0) {
                // Prefer the in-flight one (disabled + matches routine's
                // busy key) — but we don't have the id on the DOM node.
                // Approximation: if there's only one Apply* button in
                // disabled state, that's it. Most users apply one routine
                // at a time.
                if (b.disabled) { b.textContent = label; return }
            }
        }
    }

    /** Compact one-line description used in the row summary. */
    _summarizeRoutine(routine) {
        const f = routine.aircraftFilter || {}
        const parts = []
        if (f.hubs && f.hubs.length)         parts.push("hub " + f.hubs.join("/"))
        if (f.types && f.types.length)       parts.push("type " + f.types.join("/"))
        if (f.statuses && f.statuses.length) parts.push("status " + f.statuses.join("/"))
        if (f.roles && f.roles.length)       parts.push("role " + f.roles.join("/"))
        if (!parts.length) parts.push("any aircraft")
        const presets = (this._presetsBlock && this._presetsBlock.presets) || []
        const preset = routine.presetId ? presets.find(p => p.id === routine.presetId) : null
        if (preset) parts.push("preset " + preset.name)
        else if (routine.presetId) parts.push("preset " + routine.presetId)
        else parts.push("preset auto-by-hub")
        const tier = routine.strategyPolicy && routine.strategyPolicy.tier
        if (tier) parts.push("tier " + tier)
        if (routine.accountIds && routine.accountIds.length) {
            const currentId = (typeof window !== "undefined" && window.__aesAccountId) || null
            const others = routine.accountIds.filter(id => id !== currentId).length
            parts.push(routine.accountIds.length + " airline"
                + (routine.accountIds.length === 1 ? "" : "s")
                + (others > 0 ? " (" + others + " sister deferred)" : ""))
        }
        return parts.join(" · ")
    }

    /**
     * Inline editor — multi-section form. Reads the routine into a working
     * draft (so cancel discards changes) and persists via Save. Save calls
     * either FleetRoutinesStore.create or .update; storage onChanged
     * triggers the panel repaint, which clears `_editingRoutineId`.
     */
    _renderRoutineEditor(routine) {
        const T = window.AESTokens
        const isCreate = !routine
        const draft = isCreate ? this._defaultRoutineDraft() : JSON.parse(JSON.stringify(routine))

        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:10px 12px;background:" + (T ? T.color.bone : "#f4f1ea") + ";"
            + "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "border-top:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.rust : "#b8472a") + ";"
            + "display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px;"

        // ── Identity ──────────────────────────────────────────────────
        wrap.appendChild(this._editorField("Name", T, () => {
            const inp = document.createElement("input")
            inp.type = "text"
            inp.value = draft.name || ""
            inp.placeholder = "e.g. JFK morning wave"
            inp.style.cssText = "width:100%;padding:3px 6px;font-size:11px;box-sizing:border-box;"
                + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            inp.addEventListener("input", () => { draft.name = inp.value })
            return inp
        }))

        wrap.appendChild(this._editorField("Description", T, () => {
            const inp = document.createElement("input")
            inp.type = "text"
            inp.value = draft.description || ""
            inp.placeholder = "(optional)"
            inp.style.cssText = "width:100%;padding:3px 6px;font-size:11px;box-sizing:border-box;"
                + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            inp.addEventListener("input", () => { draft.description = inp.value })
            return inp
        }))

        // ── Aircraft filter ───────────────────────────────────────────
        const hubs = Array.from(new Set(this._rows.map(r => r && r.hub).filter(Boolean)
            .map(s => String(s).toUpperCase()))).sort()
        const types = Array.from(new Set(this._rows.map(r => r && (r.typeId || r.equipment))
            .filter(Boolean).map(String))).sort()
        wrap.appendChild(this._editorField("Hubs", T,
            () => this._multiCheckboxList(hubs, draft.aircraftFilter.hubs, T,
                (next) => { draft.aircraftFilter.hubs = next })))
        wrap.appendChild(this._editorField("Equipment / type", T,
            () => this._multiCheckboxList(types, draft.aircraftFilter.types, T,
                (next) => { draft.aircraftFilter.types = next })))
        wrap.appendChild(this._editorField("Status", T,
            () => this._multiCheckboxList(window.AircraftTagsStore.STATUSES,
                draft.aircraftFilter.statuses, T,
                (next) => { draft.aircraftFilter.statuses = next },
                window.AircraftTagsStore.STATUS_LABELS)))
        wrap.appendChild(this._editorField("Roles (any-match)", T,
            () => this._multiCheckboxList(window.AircraftTagsStore.ROLES,
                draft.aircraftFilter.roles, T,
                (next) => { draft.aircraftFilter.roles = next },
                window.AircraftTagsStore.ROLE_LABELS)))

        // ── Preset ────────────────────────────────────────────────────
        wrap.appendChild(this._editorField("Schedule preset", T, () => {
            const sel = document.createElement("select")
            sel.style.cssText = "width:100%;font-size:11px;padding:2px 4px;"
            const auto = document.createElement("option")
            auto.value = ""
            auto.textContent = "(auto — pick by hub)"
            sel.appendChild(auto)
            for (const p of (this._presetsBlock && this._presetsBlock.presets) || []) {
                const o = document.createElement("option")
                o.value = p.id
                o.textContent = p.name + (p.hub ? " — " + p.hub : "")
                if (p.id === draft.presetId) o.selected = true
                sel.appendChild(o)
            }
            sel.addEventListener("change", () => { draft.presetId = sel.value || null })
            return sel
        }))

        // ── Strategy policy: tier ─────────────────────────────────────
        wrap.appendChild(this._editorField("Strategy tier", T, () => {
            const sel = document.createElement("select")
            sel.style.cssText = "width:100%;font-size:11px;padding:2px 4px;"
            const inh = document.createElement("option")
            inh.value = ""
            inh.textContent = "(inherit fleet tier)"
            sel.appendChild(inh)
            for (const t of window.FleetRoutinesStore.TIERS) {
                const o = document.createElement("option")
                o.value = t
                o.textContent = t
                if (t === (draft.strategyPolicy && draft.strategyPolicy.tier)) o.selected = true
                sel.appendChild(o)
            }
            sel.addEventListener("change", () => {
                draft.strategyPolicy.tier = sel.value || null
            })
            return sel
        }))

        // ── Sister-airline targets (Phase 5 scaffolding) ─────────────
        // Known accounts come from AesAccountRegistry — every airline the
        // user has visited. The current account is implicitly always
        // included; sister-airline EXECUTION lands in a follow-up (the
        // orchestrator currently records non-current selections as
        // "deferred" so the user knows where the apply landed).
        wrap.appendChild(this._editorField("Sister airlines", T, () => {
            const host = document.createElement("div")
            host.style.cssText = "display:flex;flex-direction:column;gap:4px;"
            const accounts = (this._knownAccounts || [])
                .filter(a => a && a.id)
            const currentId = (typeof window !== "undefined" && window.__aesAccountId) || null

            if (!accounts.length) {
                const empty = document.createElement("span")
                empty.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66")
                    + ";font-size:10px;font-style:italic;"
                empty.textContent = "(no other airlines registered yet)"
                host.appendChild(empty)
                return host
            }

            const opts = accounts.map(a => a.id)
            const labels = {}
            for (const a of accounts) {
                labels[a.id] = (a.displayName || a.airlineIdentity || a.id)
                    + (a.id === currentId ? " · this airline" : "")
                    + (a.server ? " (" + a.server + ")" : "")
            }
            host.appendChild(this._multiCheckboxList(opts, draft.accountIds, T,
                (next) => { draft.accountIds = next }, labels))

            const note = document.createElement("span")
            note.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-size:9px;font-style:italic;margin-top:2px;"
            note.textContent = "Cross-airline execution requires visiting each airline's page. "
                + "Selections for sister airlines are recorded; in this slice they're queued, not executed."
            host.appendChild(note)
            return host
        }))

        // ── Strategy policy: per-domain enables (tri-state) ──────────
        wrap.appendChild(this._editorField("Strategy domains (override)", T, () => {
            const host = document.createElement("div")
            host.style.cssText = "display:flex;flex-direction:column;gap:3px;"
            const domainPairs = [
                ["scheduleApplyEnabled", "schedule"],
                ["serviceMovesEnabled",  "service"],
                ["priceMovesEnabled",    "price"],
                ["crewMovesEnabled",     "crew"],
                ["routeCreationEnabled", "route creation"]
            ]
            for (const [field, label] of domainPairs) {
                const cur = draft.strategyPolicy.domains[field]
                const sel = document.createElement("select")
                sel.style.cssText = "font-size:10px;padding:1px 3px;"
                ;[
                    {v: "",      l: "inherit"},
                    {v: "true",  l: "enable"},
                    {v: "false", l: "disable"}
                ].forEach(({v, l}) => {
                    const o = document.createElement("option")
                    o.value = v; o.textContent = l
                    if ((cur === null || cur === undefined) && v === "") o.selected = true
                    if (cur === true  && v === "true")  o.selected = true
                    if (cur === false && v === "false") o.selected = true
                    sel.appendChild(o)
                })
                sel.addEventListener("change", () => {
                    if (sel.value === "") draft.strategyPolicy.domains[field] = null
                    else draft.strategyPolicy.domains[field] = (sel.value === "true")
                })
                const line = document.createElement("label")
                line.style.cssText = "display:flex;align-items:center;gap:6px;"
                    + "font-size:10px;color:" + (T ? T.color.oxide : "#2b2520") + ";"
                const lbl = document.createElement("span")
                lbl.textContent = label
                lbl.style.cssText = "flex:1;"
                line.append(lbl, sel)
                host.appendChild(line)
            }
            return host
        }))

        // ── Save / Cancel ─────────────────────────────────────────────
        const foot = document.createElement("div")
        foot.style.cssText = "grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end;margin-top:4px;"
        const matchedCount = window.AircraftTagsStore
            ? window.AircraftTagsStore.match(this._rows,
                this._aircraftTags.byAircraftId, draft.aircraftFilter).length
            : 0
        const matchLabel = document.createElement("span")
        matchLabel.style.cssText = "flex:1 1 auto;color:" + (T ? T.color.slate : "#7a6f66")
            + ";font-size:11px;font-style:italic;"
        matchLabel.textContent = matchedCount + " aircraft would match"
        foot.appendChild(matchLabel)

        const cancel = this._actionButton("Cancel",
            "Discard pending edits",
            () => {
                this._editingRoutineId = null
                if (this._activeTab === "aircraft") this._renderBody()
            })
        foot.appendChild(cancel)
        const save = this._actionButton(isCreate ? "Create" : "Save",
            isCreate ? "Create this routine" : "Save changes",
            () => this._handleRoutineSave(isCreate ? null : routine.id, draft))
        this._wireBusyDisable(save, "saveRoutine:" + (isCreate ? "new" : routine.id))
        foot.appendChild(save)
        wrap.appendChild(foot)

        return wrap
    }

    _defaultRoutineDraft() {
        return {
            name: "",
            description: "",
            aircraftFilter: {hubs: [], types: [], statuses: [], roles: []},
            presetId: null,
            strategyPolicy: {
                tier: null,
                domains: {
                    scheduleApplyEnabled: null,
                    priceMovesEnabled:    null,
                    serviceMovesEnabled:  null,
                    crewMovesEnabled:     null,
                    routeCreationEnabled: null
                },
                perAircraftOverrides: {}
            },
            accountIds: []
        }
    }

    /** Field wrapper — label on top, content below. */
    _editorField(label, T, build) {
        const f = document.createElement("div")
        f.style.cssText = "display:flex;flex-direction:column;gap:3px;"
        const lbl = document.createElement("label")
        lbl.textContent = label
        lbl.style.cssText = "font-weight:700;text-transform:uppercase;letter-spacing:0.06em;"
            + "font-size:9px;color:" + (T ? T.color.slate : "#7a6f66") + ";"
        f.appendChild(lbl)
        f.appendChild(build())
        return f
    }

    /**
     * Multi-select chip strip used by every filter dimension. Toggles
     * write through to `setNext` with the new array — caller mutates the
     * draft directly.
     */
    _multiCheckboxList(options, current, T, setNext, labels) {
        const host = document.createElement("div")
        host.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;"
        const cur = new Set((current || []).map(s => String(s).toUpperCase()))
        if (!options.length) {
            const empty = document.createElement("span")
            empty.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-size:10px;font-style:italic;"
            empty.textContent = "(none available)"
            host.appendChild(empty)
            return host
        }
        for (const opt of options) {
            const oU = String(opt).toUpperCase()
            const on = cur.has(oU)
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = (labels && labels[opt]) || opt
            btn.style.cssText = "padding:2px 7px;font-size:10px;cursor:pointer;"
                + "background:" + (on ? (T ? T.color.cobaltSoft : "rgba(54,86,168,0.14)") : "transparent") + ";"
                + "color:"      + (on ? (T ? T.color.cobalt     : "#3656a8")              : (T ? T.color.oxide : "#2b2520")) + ";"
                + "border:1px solid " + (on ? (T ? T.color.cobalt : "#3656a8") : (T ? T.color.paperRule : "#c9c0b0")) + ";"
                + "border-radius:8px;"
            btn.addEventListener("click", (e) => {
                e.preventDefault()
                if (on) cur.delete(oU)
                else    cur.add(oU)
                setNext(Array.from(cur))
                // Visual feedback without triggering full panel repaint —
                // re-style this button only. (The matched-count footer
                // below will be stale until next render; acceptable.)
                const nowOn = cur.has(oU)
                btn.style.background = nowOn ? (T ? T.color.cobaltSoft : "rgba(54,86,168,0.14)") : "transparent"
                btn.style.color      = nowOn ? (T ? T.color.cobalt     : "#3656a8")              : (T ? T.color.oxide : "#2b2520")
                btn.style.borderColor = nowOn ? (T ? T.color.cobalt    : "#3656a8")              : (T ? T.color.paperRule : "#c9c0b0")
            })
            host.appendChild(btn)
        }
        return host
    }

    /** Resolve aircraft matching a routine's filter against current rows + tags. */
    _matchAircraftFor(routine) {
        if (typeof window.AircraftTagsStore === "undefined") return []
        return window.AircraftTagsStore.match(
            this._rows,
            (this._aircraftTags && this._aircraftTags.byAircraftId) || {},
            (routine && routine.aircraftFilter) || {}
        )
    }

    async _handleRoutineSave(id, draft) {
        if (typeof window.FleetRoutinesStore === "undefined") return
        const key = "saveRoutine:" + (id || "new")
        if (this._busy.has(key)) return
        if (!draft.name || !String(draft.name).trim()) {
            this._toast("error", "Routine needs a name.")
            return
        }
        this._setBusy(key, true)
        this._scheduleRepaint()
        try {
            if (id) {
                await window.FleetRoutinesStore.update(id, draft)
                this._toast("info", "Routine \"" + draft.name + "\" saved.")
            } else {
                await window.FleetRoutinesStore.create(draft)
                this._toast("info", "Routine \"" + draft.name + "\" created.")
            }
            this._editingRoutineId = null
        } catch (err) {
            console.warn("[AES Fleet CC] routine save failed", err)
            this._toast("error", "Save failed: " + ((err && err.message) || String(err)))
        } finally {
            this._setBusy(key, false)
            this._scheduleRepaint()
        }
    }

    async _handleRoutineDelete(routine) {
        if (typeof window.FleetRoutinesStore === "undefined") return
        const key = "delRoutine:" + routine.id
        if (this._busy.has(key)) return
        if (!window.confirm("Delete routine \"" + routine.name + "\"?")) return
        this._setBusy(key, true)
        this._scheduleRepaint()
        try {
            await window.FleetRoutinesStore.remove(routine.id)
            if (this._editingRoutineId === routine.id) this._editingRoutineId = null
        } catch (err) {
            console.warn("[AES Fleet CC] routine delete failed", err)
            this._toast("error", "Delete failed: " + ((err && err.message) || String(err)))
        } finally {
            this._setBusy(key, false)
            this._scheduleRepaint()
        }
    }

    // ── Aircraft Plans tab ───────────────────────────────────────────────

    _renderAircraft() {
        const T = window.AESTokens

        // Routines panel — collapsible bundle-of-policies above the table.
        // Always rendered so the "+ New routine" affordance is discoverable
        // even on a brand-new airline. Self-collapses when there's nothing
        // to show.
        this.bodyEl.appendChild(this._renderRoutinesPanel())

        const rows = this._rows.slice()
        if (!rows.length) {
            this.bodyEl.appendChild(this._emptyState(
                "No aircraft in this airline yet."
            ))
            return
        }

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
        const thead = document.createElement("thead")
        thead.innerHTML = "<tr>"
            + "<th style=\"width:18px;padding:4px 4px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\"></th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Aircraft</th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Hub</th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Tags</th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Preset</th>"
            + "<th style=\"text-align:right;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Legs</th>"
            + "<th style=\"text-align:right;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Applied</th>"
            + "<th style=\"text-align:right;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Pending</th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Last edit</th>"
            + "<th style=\"padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Actions</th>"
            + "</tr>"
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        const presets = (this._presetsBlock && this._presetsBlock.presets) || []
        const presetById = new Map()
        for (const p of presets) presetById.set(p.id, p)

        // Sort: drafts with pending legs first, then drafts, then no-draft.
        rows.sort((a, b) => {
            const da = this._aircraftDrafts.get(String(a.aircraftId))
            const db = this._aircraftDrafts.get(String(b.aircraftId))
            const pa = da ? this._pendingLegCount(da) : -1
            const pb = db ? this._pendingLegCount(db) : -1
            if (pa !== pb) return pb - pa
            return String(a.registration || "").localeCompare(String(b.registration || ""))
        })

        for (const r of rows) {
            const draft = this._aircraftDrafts.get(String(r.aircraftId))
            tbody.appendChild(this._renderAircraftRow(r, draft, presetById, T))
            const aid = String(r.aircraftId)
            const expanded = draft && this._expandedAircraft.has(aid)
            if (expanded) {
                tbody.appendChild(this._renderAircraftLegsRow(r, draft, T))
            }
        }
        table.appendChild(tbody)
        this.bodyEl.appendChild(table)
    }

    _renderAircraftRow(r, draft, presetById, T) {
        const flights = (draft && draft.flights) || []
        const applied = draft && draft.appliedLegs ? Object.keys(draft.appliedLegs).length : 0
        const dismissed = draft && draft.dismissedLegs ? Object.keys(draft.dismissedLegs).length : 0
        const pending = Math.max(0, flights.length - applied - dismissed)
        const presetName = (draft && draft.presetId && presetById.get(draft.presetId))
            ? presetById.get(draft.presetId).name
            : (draft && draft.presetId ? "(preset " + draft.presetId + ")" : "—")
        const when = draft && draft.updatedAt ? this._relativeTime(draft.updatedAt) : ""
        const aircraftId = String(r.aircraftId)
        const expanded = draft && this._expandedAircraft.has(aircraftId)

        const tr = document.createElement("tr")
        tr.dataset.aircraftId = aircraftId
        tr.style.cssText = "border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + (expanded ? "background:" + (T ? T.color.bone3 : "#e0dac8") + ";" : "")
        const cell = (text, style) => {
            const td = document.createElement("td")
            td.style.cssText = "padding:4px 8px;" + (style || "")
            td.textContent = text
            return td
        }

        // Chevron toggle — only when there's a draft to expand into.
        const chevCell = document.createElement("td")
        chevCell.style.cssText = "padding:4px 4px;text-align:center;"
        if (draft) {
            const chev = document.createElement("button")
            chev.type = "button"
            chev.textContent = expanded ? "▾" : "▸"
            chev.title = expanded ? "Collapse leg editor" : "Expand leg-by-leg editor"
            chev.style.cssText = "background:transparent;border:none;cursor:pointer;font-size:11px;"
                + "color:" + (T ? T.color.oxide : "#2b2520") + ";padding:0 4px;"
            chev.addEventListener("click", (e) => {
                e.preventDefault()
                this._toggleAircraftExpansion(aircraftId)
            })
            chevCell.appendChild(chev)
        }
        tr.appendChild(chevCell)

        const acCell = document.createElement("td")
        acCell.style.cssText = "padding:4px 8px;"
        const reg = document.createElement("strong")
        reg.textContent = r.registration || ("#" + r.aircraftId)
        acCell.appendChild(reg)
        const eq = document.createElement("span")
        eq.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";margin-left:6px;font-size:11px;"
        eq.textContent = r.equipment || ""
        acCell.appendChild(eq)
        tr.appendChild(acCell)

        tr.appendChild(cell(r.hub || "—", "font-family:" + (T ? T.font.mono : "monospace") + ";"))
        tr.appendChild(this._renderAircraftTagsCell(r, T))
        tr.appendChild(cell(draft ? presetName : "—"))
        tr.appendChild(cell(draft ? String(flights.length) : "—", "text-align:right;font-variant-numeric:tabular-nums;"))
        tr.appendChild(cell(draft ? String(applied) : "—", "text-align:right;font-variant-numeric:tabular-nums;color:" + (T ? T.color.moss : "#2f5f3f") + ";"))
        tr.appendChild(cell(draft ? String(pending) : "—", "text-align:right;font-variant-numeric:tabular-nums;color:" + (pending > 0 && T ? T.color.amber : (T ? T.color.slate : "#7a6f66")) + ";"))
        tr.appendChild(cell(when || "—", "color:" + (T ? T.color.slate : "#7a6f66") + ";font-family:" + (T ? T.font.mono : "monospace") + ";"))

        tr.appendChild(this._renderAircraftActionsCell(r, draft, pending, T))
        return tr
    }

    _toggleAircraftExpansion(aircraftId) {
        const id = String(aircraftId)
        if (this._expandedAircraft.has(id)) this._expandedAircraft.delete(id)
        else this._expandedAircraft.add(id)
        this._saveExpandedPresets()
        if (this._activeTab === "aircraft") this._renderBody()
    }

    // ── Tag chip rendering + edit popover ────────────────────────────────

    /**
     * Tag cell — status badge (singular) + role chips (zero-or-many) plus
     * an "edit" affordance that opens an in-place popover. The cell is
     * the click target for opening the popover; chip rendering itself is
     * read-only — every mutation routes through the popover so the
     * vocabulary is enforced through one path (`AircraftTagsStore.set`).
     */
    _renderAircraftTagsCell(r, T) {
        const td = document.createElement("td")
        td.style.cssText = "padding:4px 8px;position:relative;"

        const aircraftId = String(r.aircraftId)
        const tag = (this._aircraftTags.byAircraftId || {})[aircraftId] || null
        const status = tag && tag.status
        const roles  = (tag && tag.roles) || []

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:inline-flex;flex-wrap:wrap;gap:3px;align-items:center;"
            + "max-width:220px;cursor:pointer;"
        wrap.title = "Click to edit tags"
        wrap.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            this._openTagPopover(aircraftId, td)
        })

        if (status) {
            wrap.appendChild(this._chip(this._statusLabel(status), this._statusTone(status)))
        }
        for (const role of roles) {
            wrap.appendChild(this._chip(this._roleLabel(role), "muted"))
        }
        if (!status && !roles.length) {
            const empty = document.createElement("span")
            empty.textContent = "+ tag"
            empty.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-size:10px;font-style:italic;"
            wrap.appendChild(empty)
        }
        td.appendChild(wrap)
        return td
    }

    /** Compact pill — sister of `_badge` but smaller and without uppercase. */
    _chip(text, tone) {
        const T = window.AESTokens
        const palette = {
            moss:    {bg: T ? T.color.mossSoft   : "rgba(47,95,63,0.14)",   fg: T ? T.color.moss   : "#2f5f3f"},
            amber:   {bg: T ? T.color.amberSoft  : "rgba(184,134,31,0.14)", fg: T ? T.color.amber  : "#b8861f"},
            cobalt:  {bg: T ? T.color.cobaltSoft : "rgba(54,86,168,0.14)",  fg: T ? T.color.cobalt : "#3656a8"},
            crimson: {bg: T ? T.color.crimsonSoft: "rgba(139,39,39,0.14)",  fg: T ? T.color.crimson: "#8b2727"},
            muted:   {bg: T ? T.color.bone3      : "#e0dac8",               fg: T ? T.color.slate  : "#7a6f66"}
        }
        const p = palette[tone] || palette.muted
        const span = document.createElement("span")
        span.style.cssText = "display:inline-block;padding:1px 5px;"
            + "background:" + p.bg + ";color:" + p.fg + ";"
            + "border:1px solid " + p.fg + ";border-radius:8px;"
            + "font-size:9px;font-weight:600;white-space:nowrap;"
        span.textContent = text
        return span
    }

    _statusLabel(status) {
        const ns = window.AircraftTagsStore
        return (ns && ns.STATUS_LABELS && ns.STATUS_LABELS[status]) || status
    }

    _roleLabel(role) {
        const ns = window.AircraftTagsStore
        return (ns && ns.ROLE_LABELS && ns.ROLE_LABELS[role]) || role
    }

    /**
     * Status → tone mapping. Keeps the colour grammar consistent with the
     * rest of the CC: green = healthy/active, amber = attention, muted =
     * non-operational, crimson = blocking.
     */
    _statusTone(status) {
        switch (status) {
            case "operational": return "moss"
            case "spare":       return "cobalt"
            case "reserve":     return "cobalt"
            case "maintenance": return "amber"
            case "transit":     return "amber"
            case "training":    return "muted"
            case "leased":      return "muted"
            default:            return "muted"
        }
    }

    /**
     * Open the tag-edit popover anchored to one row's tag cell. Singleton:
     * opening for a different aircraft closes any prior. Click-outside +
     * ESC close the popover. Mutations land via AircraftTagsStore which
     * fires a storage event that triggers the CC's normal repaint —
     * we don't manually re-render anything here.
     */
    _openTagPopover(aircraftId, anchorTd) {
        if (typeof window.AircraftTagsStore === "undefined") return
        this._closeTagPopover()
        this._tagEditOpenFor = aircraftId

        const T = window.AESTokens
        const tag = (this._aircraftTags.byAircraftId || {})[aircraftId] || {status: null, roles: [], notes: ""}

        const pop = document.createElement("div")
        pop.dataset.aesTagPopover = aircraftId
        pop.style.cssText = "position:absolute;top:100%;left:0;z-index:50;"
            + "min-width:240px;padding:10px;"
            + "background:" + (T ? T.color.bone : "#f4f1ea") + ";"
            + "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.oxide : "#2b2520") + ";"
            + "box-shadow:0 4px 12px rgba(0,0,0,0.15);"
            + "font-size:11px;color:" + (T ? T.color.oxide : "#2b2520") + ";"

        // ── Status row ────────────────────────────────────────────────
        const statusRow = document.createElement("div")
        statusRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;"
        const sLbl = document.createElement("span")
        sLbl.textContent = "Status"
        sLbl.style.cssText = "font-weight:700;text-transform:uppercase;letter-spacing:0.06em;"
            + "font-size:9px;color:" + (T ? T.color.slate : "#7a6f66") + ";min-width:50px;"
        statusRow.appendChild(sLbl)
        const sel = document.createElement("select")
        sel.style.cssText = "flex:1;font-size:11px;padding:2px 4px;"
        const noneOpt = document.createElement("option")
        noneOpt.value = ""
        noneOpt.textContent = "(no status)"
        sel.appendChild(noneOpt)
        for (const s of window.AircraftTagsStore.STATUSES) {
            const o = document.createElement("option")
            o.value = s
            o.textContent = window.AircraftTagsStore.STATUS_LABELS[s] || s
            if (s === tag.status) o.selected = true
            sel.appendChild(o)
        }
        sel.addEventListener("change", () => {
            window.AircraftTagsStore.set(aircraftId, {status: sel.value || null})
                .catch(err => console.warn("[AES Fleet CC] set tag status failed", err))
        })
        statusRow.appendChild(sel)
        pop.appendChild(statusRow)

        // ── Roles row ─────────────────────────────────────────────────
        const rolesLbl = document.createElement("div")
        rolesLbl.textContent = "Roles"
        rolesLbl.style.cssText = "font-weight:700;text-transform:uppercase;letter-spacing:0.06em;"
            + "font-size:9px;color:" + (T ? T.color.slate : "#7a6f66") + ";margin-bottom:4px;"
        pop.appendChild(rolesLbl)
        const rolesGrid = document.createElement("div")
        rolesGrid.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;"
        for (const role of window.AircraftTagsStore.ROLES) {
            const on = (tag.roles || []).indexOf(role) >= 0
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = window.AircraftTagsStore.ROLE_LABELS[role] || role
            btn.style.cssText = "padding:2px 8px;font-size:10px;cursor:pointer;"
                + "background:" + (on ? (T ? T.color.cobaltSoft : "rgba(54,86,168,0.14)") : "transparent") + ";"
                + "color:"      + (on ? (T ? T.color.cobalt     : "#3656a8")              : (T ? T.color.oxide : "#2b2520")) + ";"
                + "border:1px solid " + (on ? (T ? T.color.cobalt : "#3656a8") : (T ? T.color.paperRule : "#c9c0b0")) + ";"
                + "border-radius:8px;"
            btn.addEventListener("click", (e) => {
                e.preventDefault()
                window.AircraftTagsStore.toggleRole(aircraftId, role)
                    .catch(err => console.warn("[AES Fleet CC] toggle role failed", err))
            })
            rolesGrid.appendChild(btn)
        }
        pop.appendChild(rolesGrid)

        // ── Notes ────────────────────────────────────────────────────
        const notesLbl = document.createElement("div")
        notesLbl.textContent = "Notes"
        notesLbl.style.cssText = "font-weight:700;text-transform:uppercase;letter-spacing:0.06em;"
            + "font-size:9px;color:" + (T ? T.color.slate : "#7a6f66") + ";margin-bottom:4px;"
        pop.appendChild(notesLbl)
        const notes = document.createElement("textarea")
        notes.value = tag.notes || ""
        notes.placeholder = "Optional notes about this aircraft…"
        notes.style.cssText = "width:100%;min-height:40px;padding:4px;font-size:11px;"
            + "border:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "background:" + (T ? T.color.bone2 : "#ece7dc") + ";"
            + "color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "font-family:" + (T ? T.font.body : "system-ui") + ";box-sizing:border-box;"
            + "resize:vertical;"
        let notesTimer = null
        notes.addEventListener("input", () => {
            if (notesTimer) clearTimeout(notesTimer)
            notesTimer = setTimeout(() => {
                window.AircraftTagsStore.set(aircraftId, {notes: notes.value})
                    .catch(err => console.warn("[AES Fleet CC] set tag notes failed", err))
            }, 350)
        })
        pop.appendChild(notes)

        // ── Footer (close + clear all) ────────────────────────────────
        const foot = document.createElement("div")
        foot.style.cssText = "display:flex;justify-content:space-between;margin-top:8px;"
        const clearBtn = document.createElement("button")
        clearBtn.type = "button"
        clearBtn.textContent = "Clear all"
        clearBtn.title = "Remove every tag from this aircraft"
        clearBtn.style.cssText = "padding:2px 8px;font-size:10px;cursor:pointer;"
            + "background:transparent;color:" + (T ? T.color.crimson : "#8b2727") + ";"
            + "border:1px solid " + (T ? T.color.crimson : "#8b2727") + ";"
        clearBtn.addEventListener("click", (e) => {
            e.preventDefault()
            window.AircraftTagsStore.clear(aircraftId).then(() => this._closeTagPopover())
                .catch(err => console.warn("[AES Fleet CC] clear tags failed", err))
        })
        foot.appendChild(clearBtn)
        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "Close"
        closeBtn.style.cssText = "padding:2px 8px;font-size:10px;cursor:pointer;"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "border:1px solid " + (T ? T.color.oxide : "#2b2520") + ";"
        closeBtn.addEventListener("click", (e) => {
            e.preventDefault()
            this._closeTagPopover()
        })
        foot.appendChild(closeBtn)
        pop.appendChild(foot)

        anchorTd.appendChild(pop)
        this._tagPopoverEl = pop

        // Click-outside listener — closes the popover on any click that
        // isn't inside it. Captured at document level so events from the
        // chip cluster (which would re-open) don't fire after close.
        const onDocClick = (e) => {
            if (!pop.contains(e.target)) this._closeTagPopover()
        }
        const onEsc = (e) => {
            if (e.key === "Escape") { e.preventDefault(); this._closeTagPopover() }
        }
        // Defer attaching one tick so the click that opened doesn't re-close.
        setTimeout(() => {
            document.addEventListener("click", onDocClick, true)
            document.addEventListener("keydown", onEsc, true)
        }, 0)
        this._tagPopoverDispose = () => {
            document.removeEventListener("click", onDocClick, true)
            document.removeEventListener("keydown", onEsc, true)
        }
    }

    _closeTagPopover() {
        if (this._tagPopoverDispose) {
            try { this._tagPopoverDispose() } catch (_) { /* noop */ }
            this._tagPopoverDispose = null
        }
        if (this._tagPopoverEl && this._tagPopoverEl.parentElement) {
            this._tagPopoverEl.parentElement.removeChild(this._tagPopoverEl)
        }
        this._tagPopoverEl = null
        this._tagEditOpenFor = null
    }

    /**
     * Inline per-leg editor row for an expanded aircraft. Lives below the
     * summary row in the same tbody, spanning all columns. Renders the
     * legs via SchedulePanel.buildLegRow so the editing surface is 1:1
     * with the Schedule Management modal — the user can edit destination,
     * departure time, price%, and Apply / Dismiss / Restore each leg in
     * place. All store mutations go through AesAfpActiveDraftStore so RA
     * Wave View, AFP wave-strip, and the SchedulePanel modal see the
     * same state.
     */
    _renderAircraftLegsRow(r, draft, T) {
        const tr = document.createElement("tr")
        tr.style.cssText = "background:" + (T ? T.color.bone : "#f4f1ea") + ";"
        const td = document.createElement("td")
        td.colSpan = 10
        td.style.cssText = "padding:10px 12px 14px;"
            + "border-bottom:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
        tr.appendChild(td)

        const builderReady = typeof window.SchedulePanel !== "undefined"
            && typeof window.AesAfpActiveDraftStore !== "undefined"
            && typeof window.SchedulePanel.buildLegRow === "function"
        if (!builderReady) {
            td.textContent = "Leg editor unavailable on this page — open the AFP page or Schedule Management to edit."
            td.style.color = T ? T.color.slate : "#7a6f66"
            td.style.fontStyle = "italic"
            return tr
        }

        const flights = (draft && draft.flights) || []
        if (!flights.length) {
            td.textContent = "Draft has no legs yet."
            td.style.color = T ? T.color.slate : "#7a6f66"
            td.style.fontStyle = "italic"
            return tr
        }

        // Header strip with Open in AFP / Open in Schedule Management.
        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;"
            + "font-size:11px;color:" + (T ? T.color.slate : "#7a6f66") + ";"
        const lbl = document.createElement("strong")
        lbl.textContent = (r.registration || ("#" + r.aircraftId)) + " · " + flights.length + " leg"
            + (flights.length === 1 ? "" : "s")
        lbl.style.color = T ? T.color.oxide : "#2b2520"
        head.appendChild(lbl)
        const openLink = document.createElement("a")
        openLink.href = "/app/fleets/aircraft/" + r.aircraftId + "/0"
        openLink.target = "_blank"
        openLink.rel = "noopener"
        openLink.textContent = "Open AFP ▸"
        openLink.style.cssText = "margin-left:auto;font-size:10px;"
            + "color:" + (T ? T.color.rust : "#b8472a") + ";"
            + "text-decoration:none;text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
            + "font-weight:" + (T ? T.fw.bold : "700") + ";"
        head.appendChild(openLink)
        td.appendChild(head)

        const table = document.createElement("table")
        table.className = "table table-condensed"
        table.style.cssText = "width:100%;font-size:11px;margin:0;"
        const thead = document.createElement("thead")
        thead.innerHTML = "<tr>"
            + "<th style=\"text-align:left;\">Wave</th>"
            + "<th style=\"text-align:left;\">Dir</th>"
            + "<th style=\"text-align:left;\">Origin</th>"
            + "<th style=\"text-align:left;\">Dest</th>"
            + "<th style=\"text-align:left;\">Dep</th>"
            + "<th style=\"text-align:left;\">Price%</th>"
            + "<th style=\"text-align:left;\">Status</th>"
            + "<th style=\"text-align:left;\">Actions</th>"
            + "</tr>"
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        const aid = String(r.aircraftId)
        const state = {
            perLegEdits:   draft.perLegEdits   || {},
            appliedLegs:   draft.appliedLegs   || {},
            dismissedLegs: draft.dismissedLegs || {}
        }
        const transient = this._legStatusBySeq[aid] || {}
        const callbacks = this._buildLegCallbacks(r, draft)
        for (const f of flights) {
            tbody.appendChild(window.SchedulePanel.buildLegRow(f, state, {
                transient,
                onLegEdit:          callbacks.onLegEdit,
                onLegApply:         callbacks.onLegApply,
                onLegDismissToggle: callbacks.onLegDismissToggle
            }))
        }
        table.appendChild(tbody)
        td.appendChild(table)
        return tr
    }

    /**
     * Build the per-leg callback bundle used by buildLegRow. Edits and
     * dismiss/restore go straight to AesAfpActiveDraftStore. Apply uses
     * AesAfpSubmitBridge if loaded; if not, gracefully degrades to the
     * AFP deep-link so the user isn't dead-ended.
     */
    _buildLegCallbacks(r, draft) {
        const aid = String(r.aircraftId)
        const server = this.server
        const onLegEdit = async (seq, patch) => {
            try {
                if (typeof window.AesAfpActiveDraftStore === "undefined") return
                await window.AesAfpActiveDraftStore.setEdit(server, aid, seq, patch)
            } catch (err) {
                console.warn("[AES Fleet CC] setEdit failed", aid, seq, err)
            }
        }
        const onLegDismissToggle = async (seq, makeDismissed) => {
            try {
                if (typeof window.AesAfpActiveDraftStore === "undefined") return
                await window.AesAfpActiveDraftStore.setDismissed(
                    server, aid, seq, makeDismissed ? Date.now() : null)
            } catch (err) {
                console.warn("[AES Fleet CC] setDismissed failed", aid, seq, err)
            }
        }
        const onLegApply = async (seq) => {
            const bridgeReady = typeof window.AesAfpSubmitBridge !== "undefined"
                && typeof window.AesAfpSubmitBridge.submitLegInBackground === "function"
                && typeof window.AesAfpActiveDraftStore !== "undefined"
            if (!bridgeReady) {
                window.open("/app/fleets/aircraft/" + r.aircraftId + "/0", "_blank")
                return
            }
            const eff = window.AesAfpActiveDraftStore.effectiveLeg(draft, seq)
            if (!eff) return
            const inbound = (eff.direction === "inbound")
            const hub = draft.hub || r.hub || null
            const origin = inbound ? (eff.origin || hub) : (hub || eff.origin)
            const destination = inbound ? hub : eff.destination
            const leg = {
                origin:       origin || null,
                destination:  destination || null,
                depTimeLocal: eff.depTimeLocal || null,
                pricePct:     (typeof eff.pricePct === "number") ? eff.pricePct : 100,
                service:      eff.service || null
            }
            this._legStatusBySeq[aid] = Object.assign({}, this._legStatusBySeq[aid] || {}, {[seq]: "submitting"})
            this._renderBody()
            try {
                const resp = await window.AesAfpSubmitBridge.submitLegInBackground({
                    server, aircraftId: r.aircraftId, hub, leg
                })
                if (resp && resp.ok) {
                    if (this._legStatusBySeq[aid]) delete this._legStatusBySeq[aid][seq]
                    await window.AesAfpActiveDraftStore.setApplied(server, aid, seq, Date.now())
                } else {
                    console.warn("[AES Fleet CC] leg apply failed", resp)
                    this._legStatusBySeq[aid] = Object.assign({}, this._legStatusBySeq[aid] || {}, {[seq]: "error"})
                    this._renderBody()
                }
            } catch (err) {
                console.warn("[AES Fleet CC] leg apply threw", err)
                this._legStatusBySeq[aid] = Object.assign({}, this._legStatusBySeq[aid] || {}, {[seq]: "error"})
                this._renderBody()
            }
        }
        return {onLegEdit, onLegApply, onLegDismissToggle}
    }

    /**
     * Per-row state machine.
     *   no draft     → Generate
     *   draft, pending>0 → Apply N pending  (+ Discard)
     *   draft, pending=0 → Discard           (every leg already marked)
     * The AFP link stays as a tertiary action so the per-aircraft full editor
     * is one click away when someone wants more than the inline path offers.
     */
    _renderAircraftActionsCell(r, draft, pending, T) {
        const td = document.createElement("td")
        td.style.cssText = "padding:4px 8px;text-align:right;white-space:nowrap;"

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:inline-flex;gap:6px;align-items:center;"
        td.appendChild(wrap)

        const aircraftId = String(r.aircraftId)
        const pipelineReady = typeof window.AesAfpCandidatePipeline !== "undefined"
            && typeof window.AesAfpProxyPageFetcher  !== "undefined"

        if (!draft) {
            // No draft yet — Generate path.
            const noHub = !r.hub
            const title = noHub
                ? "Aircraft has no hub on file — open its AFP page once to record the location."
                : (pipelineReady
                    ? "Build a wave plan from " + r.hub + "'s preset and store it as a draft."
                    : "AFP candidate pipeline not loaded on this page.")
            const btn = this._actionButton("Generate", title,
                () => this._generateForAircraft(r))
            if (noHub || !pipelineReady) this._disableButton(btn)
            this._wireBusyDisable(btn, "generate:" + aircraftId)
            wrap.appendChild(btn)
        } else {
            if (pending > 0) {
                const applyBtn = this._actionButton(
                    "Apply " + pending + " pending",
                    "Mark " + pending + " leg" + (pending === 1 ? "" : "s") + " applied in the draft. "
                        + "(Tier-1: visit the AFP page to push to AS — this only updates the local draft.)",
                    () => this._applyPendingForAircraft(r, draft))
                this._wireBusyDisable(applyBtn, "apply:" + aircraftId)
                wrap.appendChild(applyBtn)
            }
            const discardBtn = this._actionButton("Discard",
                "Clear the entire wave draft for " + (r.registration || aircraftId) + ".",
                () => this._discardDraft(r))
            this._wireBusyDisable(discardBtn, "discard:" + aircraftId)
            wrap.appendChild(discardBtn)
        }

        const afpLink = document.createElement("a")
        afpLink.href = "/app/fleets/aircraft/" + r.aircraftId + "/0"
        afpLink.target = "_blank"
        afpLink.rel = "noopener"
        afpLink.textContent = "AFP ▸"
        afpLink.title = "Open the AFP page for this aircraft."
        afpLink.style.cssText = T
            ? "margin-left:4px;color:" + T.color.slate + ";text-decoration:none;font-size:10px;font-weight:" + T.fw.bold + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            : "margin-left:4px;color:#7a6f66;text-decoration:none;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;"
        wrap.appendChild(afpLink)

        return td
    }

    _pendingLegCount(draft) {
        if (!draft) return 0
        const flights = draft.flights || []
        const applied = draft.appliedLegs ? Object.keys(draft.appliedLegs).length : 0
        const dismissed = draft.dismissedLegs ? Object.keys(draft.dismissedLegs).length : 0
        return Math.max(0, flights.length - applied - dismissed)
    }

    // ── Inline-editor infrastructure ─────────────────────────────────────

    /** Lazy AFP candidate pipeline. Returns null when the pipeline class isn't on the page. */
    _getPipeline() {
        if (this._pipelineUnavailable) return null
        if (!this._pipelineInst) {
            if (typeof window.AesAfpCandidatePipeline === "undefined") {
                this._pipelineUnavailable = true
                return null
            }
            this._pipelineInst = new window.AesAfpCandidatePipeline({
                server: this.server, airlineCode: this.airlineCode
            })
        }
        return this._pipelineInst
    }

    _getProxyFetcher() {
        if (this._proxyFetcherUnavailable) return null
        if (!this._proxyFetcherInst) {
            if (typeof window.AesAfpProxyPageFetcher === "undefined") {
                this._proxyFetcherUnavailable = true
                return null
            }
            this._proxyFetcherInst = new window.AesAfpProxyPageFetcher({
                server: this.server, airlineCode: this.airlineCode
            })
        }
        return this._proxyFetcherInst
    }

    /** First match by hub.toUpperCase, then defaultPresetId, then first preset. */
    _presetForHub(hub) {
        const block = this._presetsBlock || {}
        const presets = (block.presets || [])
        if (!presets.length) return null
        const HUB = String(hub || "").toUpperCase()
        if (HUB) {
            const m = presets.find(p => String((p && p.hub) || "").toUpperCase() === HUB)
            if (m) return m
        }
        if (block.defaultPresetId) {
            const d = presets.find(p => p.id === block.defaultPresetId)
            if (d) return d
        }
        return presets[0]
    }

    _setBusy(key, on) {
        if (on) this._busy.set(key, true)
        else this._busy.delete(key)
    }

    /**
     * Disable a button while a busy key is set, swap label to a loading
     * variant. The busy key is owned by the caller (always cleared on
     * settle, success or error). Repaint is the canonical refresh — this
     * just keeps the button visually consistent before the storage event
     * lands.
     */
    _wireBusyDisable(btn, key) {
        if (this._busy.has(key)) {
            btn.disabled = true
            btn.dataset.prevText = btn.textContent
            btn.textContent = "…"
            btn.style.opacity = "0.5"
            btn.style.cursor  = "wait"
        }
    }

    _disableButton(btn) {
        btn.disabled = true
        btn.style.opacity = "0.5"
        btn.style.cursor  = "not-allowed"
    }

    _toast(level, msg) {
        const ns = window.RouteAssistantToast
        if (ns) {
            const fn = ns[level] || ns.info
            try { return fn.call(ns, msg) } catch (_) { /* fall through */ }
        }
        const tag = "[AES Fleet CC]"
        if (level === "error" || level === "warn") console.warn(tag, msg)
        else console.info(tag, msg)
    }

    /**
     * Generate a per-aircraft draft via the AFP candidate pipeline and
     * persist it to AesAfpActiveDraftStore. Storage onChanged repaints the
     * row with the new flight counts. On error, surface the actionable
     * message inline (no alert).
     */
    async _generateForAircraft(row) {
        if (!row || !row.aircraftId) return {ok: false, error: "noRow"}
        const aircraftId = String(row.aircraftId)
        const key = "generate:" + aircraftId
        if (this._busy.has(key)) return {ok: false, error: "busy"}

        const pipeline = this._getPipeline()
        const fetcher  = this._getProxyFetcher()
        if (!pipeline || !fetcher || typeof window.AesAfpActiveDraftStore === "undefined") {
            this._toast("error", "AFP modules not loaded — cannot generate from this page.")
            return {ok: false, error: "noPipeline"}
        }

        this._setBusy(key, true)
        this._scheduleRepaint()
        try {
            const fc = await fetcher.fetchAircraftFormContext(aircraftId)
            if (!fc || !fc.ok) {
                const msg = (fc && fc.error && fc.error.message) || "fetch form context failed"
                this._toast("error", "Generate " + (row.registration || aircraftId) + ": " + msg)
                return {ok: false, error: msg}
            }
            const preset = this._presetForHub(row.hub)
            const r = await pipeline.generateBuild({
                aircraftId,
                formContext: fc.formContext,
                presetId:    preset ? preset.id : null,
                typeId:      row.typeId || null
            })
            if (!r || !r.ok) {
                const msg = (r && r.error && r.error.message) || "generate failed"
                this._toast("error", "Generate " + (row.registration || aircraftId) + ": " + msg)
                return {ok: false, error: msg}
            }
            const flights = (r.build && r.build.flights) || []
            await window.AesAfpActiveDraftStore.setFlights(this.server, aircraftId, {
                hub:         r.hub || row.hub || null,
                presetId:    r.preset ? r.preset.id : (preset ? preset.id : null),
                flights,
                generatedAt: Date.now()
            })
            this._toast("info", "Generated " + flights.length + " leg" + (flights.length === 1 ? "" : "s")
                + " for " + (row.registration || aircraftId))
            return {ok: true, count: flights.length}
        } catch (err) {
            console.warn("[AES Fleet CC] generate failed for " + aircraftId, err)
            this._toast("error", "Generate failed: " + ((err && err.message) || String(err)))
            return {ok: false, error: (err && err.message) || String(err)}
        } finally {
            this._setBusy(key, false)
            // Storage onChanged from setFlights triggers repaint; on the
            // error path nothing changed but still repaint to clear the
            // busy state from the button.
            this._scheduleRepaint()
        }
    }

    /**
     * Mark every pending leg of a draft as applied. Tier-1 semantic — this
     * persists `appliedLegs[seq]=ts` only; the actual game submit happens
     * via the AFP page's wave-applier when the user visits it.
     */
    async _applyPendingForAircraft(row, draft) {
        if (!row || !draft) return {applied: 0}
        const aircraftId = String(row.aircraftId)
        const key = "apply:" + aircraftId
        if (this._busy.has(key)) return {applied: 0}
        if (typeof window.AesAfpActiveDraftStore === "undefined") return {applied: 0}

        const flights = draft.flights || []
        const applied = draft.appliedLegs || {}
        const dismissed = draft.dismissedLegs || {}
        const pending = flights.filter(f => f && f.seq != null
            && !applied[f.seq] && !dismissed[f.seq])
        if (!pending.length) return {applied: 0}

        this._setBusy(key, true)
        this._scheduleRepaint()
        let count = 0
        try {
            for (const f of pending) {
                try {
                    await window.AesAfpActiveDraftStore.setApplied(
                        this.server, aircraftId, f.seq, Date.now())
                    count++
                } catch (e) {
                    console.warn("[AES Fleet CC] setApplied failed for seq=" + f.seq, e)
                }
            }
            this._toast("info", "Marked " + count + " / " + pending.length
                + " leg" + (pending.length === 1 ? "" : "s") + " applied for "
                + (row.registration || aircraftId))
            return {applied: count}
        } finally {
            this._setBusy(key, false)
            this._scheduleRepaint()
        }
    }

    async _discardDraft(row) {
        if (!row) return false
        const aircraftId = String(row.aircraftId)
        const key = "discard:" + aircraftId
        if (this._busy.has(key)) return false
        if (typeof window.AesAfpActiveDraftStore === "undefined") return false
        if (!window.confirm("Discard the wave draft for "
                + (row.registration || aircraftId) + "?")) return false

        this._setBusy(key, true)
        this._scheduleRepaint()
        try {
            await window.AesAfpActiveDraftStore.remove(this.server, aircraftId)
            return true
        } catch (err) {
            console.warn("[AES Fleet CC] discard failed for " + aircraftId, err)
            this._toast("error", "Discard failed: " + ((err && err.message) || String(err)))
            return false
        } finally {
            this._setBusy(key, false)
            this._scheduleRepaint()
        }
    }

    // ── Actions ──────────────────────────────────────────────────────────

    _openStrategy() {
        if (typeof window.AesStrategyPanel !== "undefined" && typeof window.AesStrategyPanel.open === "function") {
            window.AesStrategyPanel.open().catch(err => console.warn("[AES Fleet CC] strategy open failed", err))
            return
        }
        console.warn("[AES Fleet CC] AesStrategyPanel not loaded — cannot open strategy panel")
    }

    _openHubSchedule(hub) {
        const first = hub.aircraft[0]
        if (typeof window.FleetScheduleGridPanel === "undefined") {
            window.open("/app/com/scheduling/" + hub.hub + hub.hub, "_blank")
            return
        }
        window.FleetScheduleGridPanel.open({
            server:             this.server,
            airlineCode:        this.airlineCode,
            selectedHub:        hub.hub,
            selectedAircraftId: first ? first.aircraftId : null
        }).catch(err => console.warn("[AES Fleet CC] schedule grid open failed", err))
    }

    /**
     * Phase I — primary "Build wave schedule for HUB ▸" CTA for hubs that
     * have a preset but most aircraft still lack a drafted plan. Opens the
     * Schedule Canvas in Builder mode pre-seeded for the hub. Routes via
     * the bus so future surfaces (full-page canvas) can pick up the same
     * intent — falls back to a direct CanvasModal.open call when the host
     * isn't listening.
     */
    _buildCanvasBuilderButton(hub) {
        const T = window.AESTokens
        const btn = document.createElement("button")
        btn.type = "button"
        btn.title = "Open the Schedule Canvas in Builder mode for " + hub.hub
            + ". The assistant will stream wave-aligned plan candidates you can adopt."
        btn.textContent = "Build wave schedule ▸"
        btn.style.cssText = T
            ? [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:" + T.color.cobalt,
                "color:" + (T.color.boneFg || T.color.bone),
                "border:" + T.geom.bw1 + " solid " + T.color.cobalt,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.small,
                "font-weight:" + T.fw.bold,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "cursor:pointer"
            ].join(";")
            : "padding:4px 8px;background:#3656A8;color:#F4F1EA;border:1px solid #3656A8;"
              + "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;cursor:pointer;"
        btn.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            this._openHubCanvas(hub)
        })
        return btn
    }

    _openHubCanvas(hub) {
        const filter = {hub: hub.hub, railMode: "builder"}
        if (typeof window.CentralHubBus !== "undefined" && window.CentralHubBus.emit) {
            window.CentralHubBus.emit("open-tile", {
                tileId:   "fleet-schedule-canvas",
                filter,
                source:   "fleet-hub-command-center"
            })
        }
        if (typeof window.CanvasModal !== "undefined") {
            // Direct call so click-to-open works regardless of host wiring.
            window.CanvasModal.open({
                server:      this.server,
                airlineCode: this.airlineCode,
                selectedHub: hub.hub,
                railMode:    "builder"
            }).catch(err => console.warn("[AES Fleet CC] canvas open failed", err))
        }
    }

    // ── Atoms ────────────────────────────────────────────────────────────

    _emptyState(text) {
        const T = window.AESTokens
        const div = document.createElement("div")
        div.style.cssText = "padding:20px;text-align:center;color:" + (T ? T.color.slate : "#7a6f66") + ";"
            + "font-style:italic;font-size:12px;border:1px dashed " + (T ? T.color.paperRule : "#c9c0b0") + ";"
        div.textContent = text
        return div
    }

    /**
     * Stat-line variant for "Wave preset: none" that swaps the muted value
     * text for an inline "+ create" button. Mirrors the Waves-tab CTA so
     * the OVERVIEW card stops being a dead end.
     */
    _renderWavePresetCreateLine(hubIata) {
        const T = window.AESTokens
        const li = document.createElement("li")
        li.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;"
        const k = document.createElement("span")
        k.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-size:11px;"
            + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
        k.textContent = "Wave preset"
        li.appendChild(k)

        if (typeof RouteAssistantWaveEditor === "undefined") {
            const v = document.createElement("span")
            v.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
                + "font-size:11px;font-style:italic;"
            v.textContent = "(none)"
            li.appendChild(v)
            return li
        }

        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = "+ create starter"
        btn.title = "Create a starter wave plan for " + hubIata
            + ". Edits sync with RA Wave View, AFP wave strip, and the Fleet Schedule Grid."
        btn.style.cssText = "background:transparent;color:" + (T ? T.color.rust : "#b8472a") + ";"
            + "border:1px dashed " + (T ? T.color.rust : "#b8472a") + ";"
            + "padding:1px 8px;font-size:10px;cursor:pointer;"
            + "font-family:" + (T ? T.font.display : "inherit") + ";"
            + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
            + "font-weight:" + (T ? T.fw.bold : "700") + ";"
        btn.addEventListener("click", async (ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            await this._createStarterPreset(btn, hubIata)
        })
        li.appendChild(btn)
        return li
    }

    _statLine(label, value, muted, tone) {
        const T = window.AESTokens
        const li = document.createElement("li")
        li.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;gap:8px;"
        const k = document.createElement("span")
        k.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-size:11px;"
            + "text-transform:uppercase;letter-spacing:" + (T ? T.track.caps : "0.06em") + ";"
        k.textContent = label
        const v = document.createElement("span")
        const colorMap = {
            moss:    T ? T.color.moss   : "#2f5f3f",
            amber:   T ? T.color.amber  : "#b8861f",
            cobalt:  T ? T.color.cobalt : "#3656a8",
            crimson: T ? T.color.crimson : "#8b2727"
        }
        const valueColor = tone && colorMap[tone]
            ? colorMap[tone]
            : (muted ? (T ? T.color.slate : "#7a6f66") : (T ? T.color.oxide : "#2b2520"))
        v.style.cssText = "color:" + valueColor + ";font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
            + (muted ? "font-style:italic;" : "")
        v.textContent = value
        li.append(k, v)
        return li
    }

    _badge(text, tone) {
        const T = window.AESTokens
        const palette = {
            moss:    {bg: T ? T.color.mossSoft   : "rgba(47,95,63,0.14)",   fg: T ? T.color.moss   : "#2f5f3f"},
            amber:   {bg: T ? T.color.amberSoft  : "rgba(184,134,31,0.14)", fg: T ? T.color.amber  : "#b8861f"},
            cobalt:  {bg: T ? T.color.cobaltSoft : "rgba(54,86,168,0.14)",  fg: T ? T.color.cobalt : "#3656a8"},
            crimson: {bg: T ? T.color.crimsonSoft: "rgba(139,39,39,0.14)",  fg: T ? T.color.crimson: "#8b2727"},
            muted:   {bg: T ? T.color.bone3      : "#e0dac8",               fg: T ? T.color.slate  : "#7a6f66"}
        }
        const p = palette[tone] || palette.muted
        const span = document.createElement("span")
        span.style.cssText = "display:inline-block;padding:1px 6px;background:" + p.bg + ";color:" + p.fg
            + ";border:1px solid " + p.fg + ";font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;"
        span.textContent = text
        return span
    }

    _actionButton(label, title, onClick) {
        const T = window.AESTokens
        const btn = document.createElement("button")
        btn.type = "button"
        btn.title = title || ""
        btn.textContent = label
        btn.style.cssText = T
            ? [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:transparent",
                "color:" + T.color.oxide,
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.small,
                "font-weight:" + T.fw.bold,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "cursor:pointer"
            ].join(";")
            : "padding:4px 8px;background:transparent;color:#2b2520;border:1px solid #2b2520;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;cursor:pointer;font-size:11px;"
        if (onClick) btn.addEventListener("click", (e) => { e.preventDefault(); onClick() })
        return btn
    }

    _linkButton(label, title, href) {
        const T = window.AESTokens
        const a = document.createElement("a")
        a.href = href
        a.target = "_blank"
        a.rel = "noopener"
        a.textContent = label
        a.title = title || ""
        a.style.cssText = T
            ? [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:transparent",
                "color:" + T.color.oxide,
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.small,
                "font-weight:" + T.fw.bold,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "text-decoration:none",
                "cursor:pointer"
            ].join(";")
            : "padding:4px 8px;background:transparent;color:#2b2520;border:1px solid #2b2520;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;text-decoration:none;font-size:11px;"
        return a
    }

    _relativeTime(ts) {
        const ms = Date.now() - Number(ts)
        if (!isFinite(ms) || ms < 0) return ""
        const s = Math.floor(ms / 1000)
        if (s < 60)   return s + "s ago"
        const m = Math.floor(s / 60)
        if (m < 60)   return m + "m ago"
        const h = Math.floor(m / 60)
        if (h < 24)   return h + "h ago"
        const d = Math.floor(h / 24)
        return d + "d ago"
    }
}

if (typeof window !== "undefined") {
    window.FleetHubCommandCenter = FleetHubCommandCenter
}
