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
        if (this._repaintTimer) {
            clearTimeout(this._repaintTimer)
            this._repaintTimer = null
        }
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

    /** Read auxiliary data needed by the tabs. Run on every repaint. */
    async _loadAuxData() {
        const tasks = [
            this._loadScheduleIndex(),
            this._loadPresets(),
            this._loadWaveDrafts(),
            this._loadAircraftDrafts(),
            this._loadStrategyAux()
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
            const plan   = ns.allocateFleet(snapshot, scored, {})
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
     *   - predicted dollar impact > 0
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
            return Number(im.value) > 0
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

        // Strategy keys repaint the strip in place rather than the whole
        // CC so the user's active tab + scroll position don't reset on
        // every applied plan / learnt-weight bump. Per-account scoping
        // means the auto-driver and apply-pipeline write both the
        // legacy global key AND a `:acct:<id>:` variant — listen for
        // the prefix so either form trips the repaint.
        const STRATEGY_APPLIED_KEY  = "aesStrategy:plan:applied"
        const STRATEGY_WEIGHTS_KEY  = "aesStrategy:learn:weights:current"
        const STRATEGY_AUTOTICK_KEY = "aesStrategy:autoTick:last"

        this._storageListener = (changes, area) => {
            if (area !== "local") return
            let fullHit = false
            let stratHit = false
            for (const k of Object.keys(changes)) {
                if (k === fleetKey)                            { fullHit = true; continue }
                if (k === sIndex)                              { fullHit = true; continue }
                if (k === FleetHubCommandCenter.SETTINGS_KEY)  { fullHit = true; continue }
                if (k.indexOf(sPrefix)            === 0)       { fullHit = true; continue }
                if (k.indexOf(afpDraftPrefix)     === 0)       { fullHit = true; continue }
                if (k.indexOf(afpStatePrefix)     === 0)       { fullHit = true; continue }
                if (k.indexOf(afpSchedulePrefix)  === 0)       { fullHit = true; continue }
                if (k.indexOf(waveDraftPrefix)    === 0)       { fullHit = true; continue }
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
        if (this._activeTab === "overview")  return this._renderOverview()
        if (this._activeTab === "schedules") return this._renderSchedules()
        if (this._activeTab === "waves")     return this._renderWaves()
        if (this._activeTab === "aircraft")  return this._renderAircraft()
    }

    // ── Overview tab ─────────────────────────────────────────────────────

    _renderOverview() {
        const T = window.AESTokens
        const hubs = this._buildHubAggregate()
        if (!hubs.length) {
            this.bodyEl.appendChild(this._emptyState(
                "No hub data yet — visit each aircraft's Flight Plan tab once to capture its location."
            ))
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
        if (unassigned) {
            this.bodyEl.appendChild(this._renderUnassignedBlock(unassigned))
        }
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
        const byHub = new Map()
        const getOrCreate = (rawHub) => {
            if (!rawHub) return null
            const k = String(rawHub).toUpperCase()
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
            const target = r.hub ? getOrCreate(r.hub) : unassigned
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
        head.style.cssText = "display:flex;align-items:baseline;gap:8px;"
        const iata = document.createElement("span")
        iata.style.cssText = T
            ? "font-family:" + T.font.mono + ";font-size:" + T.fs.h3 + ";font-weight:" + T.fw.bold + ";color:" + T.color.oxide + ";letter-spacing:" + T.track.mono + ";"
            : "font-family:monospace;font-size:18px;font-weight:700;color:#2b2520;"
        iata.textContent = hub.hub
        head.appendChild(iata)
        const acCount = document.createElement("span")
        acCount.style.cssText = T
            ? "font-size:" + T.fs.small + ";color:" + T.color.slate + ";"
            : "font-size:11px;color:#7a6f66;"
        acCount.textContent = empty
            ? "no aircraft parked"
            : hub.aircraft.length + " aircraft"
        head.appendChild(acCount)
        if (hub.liveSchedule) head.appendChild(this._badge("LIVE", "moss"))
        if (!empty) {
            const chevron = document.createElement("span")
            chevron.style.cssText = T
                ? "margin-left:auto;font-size:" + T.fs.small + ";color:" + T.color.slate + ";"
                : "margin-left:auto;font-size:11px;color:#7a6f66;"
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
            stats.appendChild(this._statLine("Wave preset", "(none — create one in Route Assistant)", true))
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

    // ── Schedules tab ────────────────────────────────────────────────────

    _renderSchedules() {
        const T = window.AESTokens
        const idx = this._scheduleIndex || []
        if (!idx.length) {
            this.bodyEl.appendChild(this._emptyState(
                "No saved schedules yet. Generate one from Route Assistant (Waves mode → 💾 Save schedule)."
            ))
            return
        }
        const byHub = new Map()
        for (const e of idx) {
            const hub = e.hub || "(no hub)"
            if (!byHub.has(hub)) byHub.set(hub, [])
            byHub.get(hub).push(e)
        }
        const hubs = Array.from(byHub.keys()).sort()
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + (T ? T.sp[3] : "12px") + ";"
        for (const hub of hubs) {
            wrap.appendChild(this._renderScheduleHubBlock(hub, byHub.get(hub)))
        }
        this.bodyEl.appendChild(wrap)
    }

    _renderScheduleHubBlock(hub, entries) {
        const T = window.AESTokens
        const block = document.createElement("div")
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
        const count = document.createElement("span")
        count.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7a6f66") + ";"
        count.textContent = entries.length + " saved"
        head.appendChild(count)
        block.appendChild(head)

        const list = document.createElement("ul")
        list.style.cssText = "list-style:none;margin:0;padding:0;"
        for (const e of entries) list.appendChild(this._renderScheduleRow(e))
        block.appendChild(list)
        return block
    }

    _renderScheduleRow(entry) {
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
        return li
    }

    // ── Waves tab ────────────────────────────────────────────────────────

    _renderWaves() {
        const T = window.AESTokens
        const presets = (this._presetsBlock && this._presetsBlock.presets) || []
        if (!presets.length) {
            this.bodyEl.appendChild(this._emptyState(
                "No wave presets yet. Create one in Route Assistant (Waves mode)."
            ))
            return
        }
        const byHub = new Map()
        for (const p of presets) {
            const hub = (p.hub || "").toUpperCase() || "(global)"
            if (!byHub.has(hub)) byHub.set(hub, [])
            byHub.get(hub).push(p)
        }
        const hubs = Array.from(byHub.keys()).sort()
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + (T ? T.sp[3] : "12px") + ";"
        for (const hub of hubs) {
            wrap.appendChild(this._renderWavesHubBlock(hub, byHub.get(hub)))
        }
        this.bodyEl.appendChild(wrap)
    }

    _renderWavesHubBlock(hub, presets) {
        const T = window.AESTokens
        const block = document.createElement("div")
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
        return block
    }

    _renderPresetRow(preset, hub) {
        const T = window.AESTokens
        const li = document.createElement("li")
        li.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";font-size:12px;"
        const name = document.createElement("span")
        name.style.cssText = "flex:1 1 auto;color:" + (T ? T.color.oxide : "#2b2520") + ";"
        name.textContent = preset.name || "(unnamed)"
        li.appendChild(name)

        const wn = (preset.waves || []).length
        const meta = document.createElement("span")
        meta.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
        meta.textContent = wn + " wave" + (wn === 1 ? "" : "s")
            + (preset.tweakedFrom ? " · variant" : "")
        li.appendChild(meta)

        if (preset.tweakedFrom) li.appendChild(this._badge("VARIANT", "cobalt"))

        const open = document.createElement("a")
        open.href = "/app/com/scheduling/" + (hub === "(global)" ? "" : hub + hub)
        open.target = "_blank"
        open.rel = "noopener"
        open.textContent = "Open ▸"
        open.style.cssText = T
            ? "color:" + T.color.rust + ";text-decoration:none;font-size:11px;font-weight:" + T.fw.bold + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            : "color:#b8472a;text-decoration:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;"
        open.title = "Open Route Assistant at this hub"
        li.appendChild(open)
        return li
    }

    // ── Aircraft Plans tab ───────────────────────────────────────────────

    _renderAircraft() {
        const T = window.AESTokens
        const rows = this._rows.filter(r => this._aircraftDrafts.has(String(r.aircraftId)))
        if (!rows.length) {
            this.bodyEl.appendChild(this._emptyState(
                "No per-aircraft wave drafts yet. Click the D button on any aircraft row above to generate one."
            ))
            return
        }

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
        const thead = document.createElement("thead")
        thead.innerHTML = "<tr>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Aircraft</th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Hub</th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Preset</th>"
            + "<th style=\"text-align:right;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Legs</th>"
            + "<th style=\"text-align:right;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Applied</th>"
            + "<th style=\"text-align:right;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Pending</th>"
            + "<th style=\"text-align:left;padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\">Last edit</th>"
            + "<th style=\"padding:4px 8px;border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";\"></th>"
            + "</tr>"
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        const presets = (this._presetsBlock && this._presetsBlock.presets) || []
        const presetById = new Map()
        for (const p of presets) presetById.set(p.id, p)

        for (const r of rows) {
            const draft = this._aircraftDrafts.get(String(r.aircraftId))
            const flights = (draft && draft.flights) || []
            const applied = draft && draft.appliedLegs ? Object.keys(draft.appliedLegs).length : 0
            const dismissed = draft && draft.dismissedLegs ? Object.keys(draft.dismissedLegs).length : 0
            const pending = Math.max(0, flights.length - applied - dismissed)
            const presetName = (draft && draft.presetId && presetById.get(draft.presetId))
                ? presetById.get(draft.presetId).name
                : (draft && draft.presetId ? "(preset " + draft.presetId + ")" : "—")
            const when = draft && draft.updatedAt ? this._relativeTime(draft.updatedAt) : ""

            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:1px solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            const cell = (text, style) => {
                const td = document.createElement("td")
                td.style.cssText = "padding:4px 8px;" + (style || "")
                td.textContent = text
                return td
            }

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
            tr.appendChild(cell(presetName))
            tr.appendChild(cell(String(flights.length), "text-align:right;font-variant-numeric:tabular-nums;"))
            tr.appendChild(cell(String(applied), "text-align:right;font-variant-numeric:tabular-nums;color:" + (T ? T.color.moss : "#2f5f3f") + ";"))
            tr.appendChild(cell(String(pending), "text-align:right;font-variant-numeric:tabular-nums;color:" + (pending > 0 && T ? T.color.amber : (T ? T.color.slate : "#7a6f66")) + ";"))
            tr.appendChild(cell(when || "—", "color:" + (T ? T.color.slate : "#7a6f66") + ";font-family:" + (T ? T.font.mono : "monospace") + ";"))

            const actCell = document.createElement("td")
            actCell.style.cssText = "padding:4px 8px;text-align:right;"
            const open = document.createElement("a")
            open.href = "/app/fleets/aircraft/" + r.aircraftId + "/0"
            open.target = "_blank"
            open.rel = "noopener"
            open.textContent = "AFP ▸"
            open.style.cssText = T
                ? "color:" + T.color.rust + ";text-decoration:none;font-size:11px;font-weight:" + T.fw.bold + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
                : "color:#b8472a;text-decoration:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;"
            open.title = "Open the AFP page for this aircraft"
            actCell.appendChild(open)
            tr.appendChild(actCell)

            tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        this.bodyEl.appendChild(table)
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

    // ── Atoms ────────────────────────────────────────────────────────────

    _emptyState(text) {
        const T = window.AESTokens
        const div = document.createElement("div")
        div.style.cssText = "padding:20px;text-align:center;color:" + (T ? T.color.slate : "#7a6f66") + ";"
            + "font-style:italic;font-size:12px;border:1px dashed " + (T ? T.color.paperRule : "#c9c0b0") + ";"
        div.textContent = text
        return div
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
