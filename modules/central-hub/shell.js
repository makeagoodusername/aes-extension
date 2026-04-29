"use strict"

/**
 * CentralHubShell — orchestrates the hub UI on /app/enterprise/dashboard*.
 *
 * Builds the top bar, the left-rail nav, and the main pane. Asks
 * CentralHubTileRegistry for each tile, mounts it into its section
 * container, and persists the user's expand/active-section choices via
 * CentralHubSettings. Tiles handle their own data subscriptions; the shell
 * does no per-tile storage watching itself.
 */
class CentralHubShell {
    constructor(opts) {
        this.server  = (opts && opts.server)  || ""
        this.airline = (opts && opts.airline) || ""
        this.root    = null
        this.navEl   = null
        this.mainEl  = null
        this.nav     = null
        this.tilesById = new Map()
        this._tilesBySection = new Map()
        this.settings = null
        this._filterText = ""
        this._filterEl   = null
        this.heroStrip   = null
        this.activityStrip = null
        this._busDispose = null
    }

    async mount(anchorEl) {
        this.settings = await window.CentralHubSettings.load()
        this._migrateLegacyDashboardSetting()
        this._applyCubistMode()

        const root = this._buildShellSkeleton()
        anchorEl.before(root)
        this.root = root

        // Subscribe before tiles mount so a click on the hero strip during
        // the async tile-mount window doesn't drop. tilesById is captured by
        // reference and populated below.
        this._subscribeBusEvents()

        await this._mountTiles()

        this.nav.setActive(this.settings.activeSection || "fleet")
        this._scrollToActiveSection()

        // HubFeed: tiles attached their feedSlices subscriptions in mount().
        // The account bootstrap signal lets account-scoped slices recompute
        // now that __aesAccountId has resolved (or remains null on legacy).
        if (typeof window.AesDataBus !== "undefined") {
            window.AesDataBus.emit("data:account:bootstrapped", {
                accountId: window.__aesAccountId || null,
                server:    this.server || null,
                airline:   this.airline || null
            })
        }

        // Replay any open-tile intent emitted before tiles were live so a
        // hero-strip click during the mount window isn't dropped.
        if (window.CentralHubBus && typeof window.CentralHubBus.replay === "function") {
            const pending = window.CentralHubBus.replay("open-tile")
            if (pending && pending.tileId && this.tilesById.has(pending.tileId)) {
                window.CentralHubBus.emit("open-tile", pending)
            }
        }

        // CH-W3 — first-boot Cascade prompt. Non-blocking; the user
        // either dismisses or tries it. Re-prompt allowed after 60d
        // (cascadePromptedAt is bumped on either action).
        this._maybePromptCascade()
    }

    _maybePromptCascade() {
        if (!this.settings) return
        if (this.settings.layoutMode === "cascade") return
        const stamped = Number(this.settings.cascadePromptedAt) || 0
        const sixtyDays = 60 * 24 * 3600 * 1000
        if (stamped > 0 && Date.now() - stamped < sixtyDays) return
        if (!this.mainEl) return

        const T = window.AESTokens
        const banner = document.createElement("div")
        banner.className = "aes-central-hub__cascade-prompt"
        banner.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[3],
            "padding:" + T.sp[3] + " " + T.sp[4],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.cobalt,
            "border-radius:" + T.geom.radius,
            "margin-bottom:" + T.sp[4],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "color:" + T.color.oxide
        ].join(";")
        const msg = document.createElement("span")
        msg.style.cssText = "flex:1 1 auto"
        msg.innerHTML = "<strong>Try Cascade.</strong> "
            + "Salience-ranked waterfall masonry — your highest-signal "
            + "tiles float to the top, chrome fades behind content. "
            + "Switch back any time via the topbar selector."
        const tryBtn = document.createElement("button")
        tryBtn.type = "button"
        tryBtn.textContent = "Show me"
        tryBtn.style.cssText = [
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
        const dismissBtn = document.createElement("button")
        dismissBtn.type = "button"
        dismissBtn.textContent = "Not now"
        dismissBtn.style.cssText = [
            "background:transparent",
            "color:" + T.color.slate,
            "border:" + T.geom.bw1 + " solid " + T.color.slate,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "cursor:pointer"
        ].join(";")
        const dismiss = async () => {
            this.settings.cascadePromptedAt = Date.now()
            await window.CentralHubSettings.save(this.settings).catch(() => {})
            if (banner.parentNode) banner.parentNode.removeChild(banner)
        }
        tryBtn.addEventListener("click", async () => {
            await dismiss()
            await this._setLayoutMode("cascade")
        })
        dismissBtn.addEventListener("click", dismiss)
        banner.append(msg, tryBtn, dismissBtn)
        this.mainEl.insertBefore(banner, this.mainEl.firstChild)
    }

    /**
     * One-shot port of `settings.general.defaultDashboard` (legacy
     * dropdown choice in content_dashboard.js) into the hub's
     * activeSection. Idempotent: if the hub already has a non-default
     * activeSection saved, leave it alone. Final removal of the legacy
     * key happens in slice CH-4.
     */
    _migrateLegacyDashboardSetting() {
        if (this.settings.activeSection && this.settings.activeSection !== "fleet") return
        const legacy = window.settings && window.settings.general && window.settings.general.defaultDashboard
        if (!legacy) return
        const map = {
            general:               "finance",
            routeManagement:       "routes",
            competitorMonitoring:  "routes",
            aircraftProfitability: "fleet",
            stationAutomation:     "operations",
            usedAircraftScanner:   "fleet",
            scheduleManagement:    "routes",
            flightsFrom:           "routes",
            other:                 "tools"
        }
        const next = map[legacy]
        if (!next) return
        this.settings.activeSection = next
        window.CentralHubSettings.save(this.settings).catch(() => { /* noop */ })
    }

    /**
     * CB0 — apply the cubistMode setting to document.body so primitives
     * defined in css/cubist.css (scoped under body.aes-cubist) activate.
     * No visible effect in CB0; CB1 onward bind surfaces to the class.
     */
    _applyCubistMode() {
        if (typeof document === "undefined" || !document.body) return
        const on = !!(this.settings && this.settings.cubistMode)
        document.body.classList.toggle("aes-cubist", on)
    }

    _buildShellSkeleton() {
        const T = window.AESTokens

        const root = document.createElement("div")
        root.className = "aes-central-hub"
        root.id = "aes-central-hub"
        root.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "margin:" + T.sp[3] + " 0",
            "font-family:" + T.font.display,
            "min-height:480px",
            "box-sizing:border-box"
        ].join(";")

        root.appendChild(this._buildTopBar())

        if (typeof window.CentralHubActivityStrip === "function") {
            this.activityStrip = new window.CentralHubActivityStrip({
                server:  this.server,
                airline: this.airline
            })
            root.appendChild(this.activityStrip.mount())
        }

        const cubistOn = !!(this.settings && this.settings.cubistMode)
        if (cubistOn && typeof window.CentralHubHeroPolyhedron === "function") {
            this.heroStrip = new window.CentralHubHeroPolyhedron({
                server:  this.server,
                airline: this.airline
            })
            root.appendChild(this.heroStrip.mount())
        } else if (typeof window.CentralHubHeroStrip === "function") {
            this.heroStrip = new window.CentralHubHeroStrip({
                server:  this.server,
                airline: this.airline
            })
            root.appendChild(this.heroStrip.mount())
        }

        const split = document.createElement("div")
        split.className = "aes-central-hub__split"
        split.style.cssText = [
            "display:flex",
            "flex-direction:row",
            "min-height:0",
            "flex:1 1 auto"
        ].join(";")

        this.nav = new window.CentralHubNav({
            activeSection:   this.settings.activeSection,
            onSectionChange: (s)  => this._onSectionChange(s),
            onTileSelect:    (id) => this._onTileSelect(id)
        })
        this.navEl = this.nav.build()

        this.mainEl = document.createElement("div")
        this.mainEl.className = "aes-central-hub__main"
        this.mainEl.style.cssText = [
            "flex:1 1 auto",
            "min-width:0",
            "padding:" + T.sp[4],
            "max-height:80vh",
            "overflow-y:auto",
            "box-sizing:border-box"
        ].join(";")

        split.append(this.navEl, this.mainEl)
        root.appendChild(split)
        return root
    }

    _buildTopBar() {
        const T = window.AESTokens
        const bar = document.createElement("div")
        bar.className = "aes-central-hub__topbar"
        bar.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[3],
            "padding:" + T.sp[3] + " " + T.sp[4],
            "background:" + T.color.bone2,
            "border-bottom:" + T.geom.bw2 + " solid " + T.color.oxide,
            "box-sizing:border-box",
            "flex-wrap:wrap"
        ].join(";")

        const title = document.createElement("h2")
        title.textContent = "AES Hub"
        title.style.cssText = [
            "margin:0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.h3,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "flex:0 0 auto"
        ].join(";")

        const subtitle = document.createElement("span")
        subtitle.textContent = "AirlineSim Enhancement Suite"
        subtitle.style.cssText = [
            "color:" + T.color.slate,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "flex:0 0 auto"
        ].join(";")

        const filter = document.createElement("input")
        filter.type = "search"
        filter.placeholder = "filter tiles…"
        filter.className = "aes-input aes-central-hub__filter"
        filter.style.cssText = [
            "flex:1 1 200px",
            "max-width:320px",
            "padding:" + T.sp[1] + " " + T.sp[2],
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono,
            "box-sizing:border-box"
        ].join(";")
        filter.addEventListener("input", () => {
            this._filterText = (filter.value || "").trim().toLowerCase()
            this._applyFilter()
        })
        this._filterEl = filter

        const scrapeBtn = document.createElement("button")
        scrapeBtn.type = "button"
        scrapeBtn.className = "aes-btn aes-central-hub__scrape-btn"
        scrapeBtn.textContent = "Scrape everything"
        scrapeBtn.title = "Walk every AS page in hidden tabs to warm every cache. ~5–8 minutes."
        scrapeBtn.style.cssText = [
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer",
            "flex:0 0 auto"
        ].join(";")
        scrapeBtn.addEventListener("click", () => {
            if (window.AESScrapeHost && typeof window.AESScrapeHost.open === "function") {
                window.AESScrapeHost.open()
            } else {
                console.warn("[AES Hub] AESScrapeHost not loaded — check manifest order")
            }
        })

        const lastScrapeStamp = document.createElement("span")
        lastScrapeStamp.className = "aes-central-hub__last-scrape"
        lastScrapeStamp.style.cssText = [
            "color:" + T.color.slate,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "flex:0 0 auto"
        ].join(";")
        lastScrapeStamp.textContent = ""
        this._lastScrapeStamp = lastScrapeStamp
        this._refreshLastScrapeStamp()

        const autoDriveStrip = document.createElement("span")
        autoDriveStrip.className = "aes-central-hub__auto-drive"
        autoDriveStrip.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "gap:" + T.sp[1],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide2,
            "flex:0 0 auto"
        ].join(";")
        this._autoDriveStripEl = autoDriveStrip
        this._refreshAutoDriveStrip()

        if (!this._lastScrapeListener) {
            const cadencePrefix = "scrapeOrchestrator:phase:"
            this._lastScrapeListener = (changes, area) => {
                if (area !== "local" || !changes) return
                if (changes["scrapeOrchestrator:lastRun"]) this._refreshLastScrapeStamp()
                for (const k in changes) {
                    if (k.indexOf(cadencePrefix) === 0) {
                        this._refreshAutoDriveStrip(k)
                        break
                    }
                }
            }
            try { chrome.storage.onChanged.addListener(this._lastScrapeListener) } catch (_) { /* noop */ }
        }

        const ctxStamp = document.createElement("span")
        ctxStamp.style.cssText = [
            "color:" + T.color.oxide2,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "flex:0 0 auto"
        ].join(";")
        ctxStamp.textContent = ((this.server || "?") + " · " + (this.airline || "?")).toUpperCase()

        const stamp = document.createElement("span")
        stamp.className = "aes-stamp"
        const v = (chrome.runtime.getManifest && chrome.runtime.getManifest().version_name) || ""
        stamp.textContent = "v" + (v || "?")
        stamp.style.cssText = [
            "padding:2px " + T.sp[2],
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "text-transform:uppercase",
            "flex:0 0 auto"
        ].join(";")

        bar.append(title, subtitle, filter, scrapeBtn, lastScrapeStamp, autoDriveStrip, ctxStamp, stamp)

        // CH-W3 — layout selector. Segmented control between Classic
        // (legacy section flow) and Cascade (salience-ranked masonry).
        // Persisted to settings.layoutMode; classic remains the default.
        const layoutWrap = document.createElement("div")
        layoutWrap.className = "aes-central-hub__layout-selector"
        layoutWrap.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "gap:0",
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "overflow:hidden",
            "flex:0 0 auto"
        ].join(";")
        const _mkLayoutBtn = (id, label, hint) => {
            const b = document.createElement("button")
            b.type = "button"
            b.dataset.layoutMode = id
            b.textContent = label
            b.title = hint
            const isActive = (this.settings && this.settings.layoutMode === id)
                || (id === "classic" && (!this.settings || this.settings.layoutMode !== "cascade"))
            b.style.cssText = [
                "background:" + (isActive ? T.color.oxide : "transparent"),
                "color:" + (isActive ? T.color.bone : T.color.oxide),
                "border:0",
                "padding:" + T.sp[1] + " " + T.sp[3],
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "cursor:pointer"
            ].join(";")
            b.addEventListener("click", () => this._setLayoutMode(id))
            return b
        }
        layoutWrap.append(
            _mkLayoutBtn("classic", "Classic", "Section flow — tiles ordered by priority within each named section."),
            _mkLayoutBtn("cascade", "Cascade", "Waterfall masonry — salience-ranked across topics. Higher signal density floats to the top.")
        )
        this._layoutSelector = layoutWrap
        bar.append(layoutWrap)

        return bar
    }

    /**
     * CH-W3 — switch layout mode. Persists, refreshes the layout
     * selector visual state, and re-runs `_mountTiles` so the new
     * layout takes effect without a page reload. Tiles are NOT
     * unmounted — `cascade-pane.mount()` reparents existing tile.root
     * nodes between columns, so refreshing tile state is preserved.
     */
    async _setLayoutMode(mode) {
        if (mode !== "classic" && mode !== "cascade") return
        if (!this.settings) return
        if (this.settings.layoutMode === mode) return
        this.settings.layoutMode = mode
        // CH-W5 — first cascade boot triggers the topic-override
        // projection migration (handled in _maybeProjectTopicOverrides
        // when the corresponding code lands).
        await window.CentralHubSettings.save(this.settings).catch(() => {})
        this._rebuildLayoutSelector()
        await this._reflowTilesForLayout()
    }

    _rebuildLayoutSelector() {
        const sel = this._layoutSelector
        if (!sel) return
        const T = window.AESTokens
        const buttons = sel.querySelectorAll("button[data-layout-mode]")
        for (const b of buttons) {
            const isActive = b.dataset.layoutMode === this.settings.layoutMode
            b.style.background = isActive ? T.color.oxide : "transparent"
            b.style.color = isActive ? T.color.bone : T.color.oxide
        }
    }

    /**
     * CH-W3 — re-render tiles into the layout corresponding to the
     * current `layoutMode`. Detaches existing tile roots, blanks the
     * main pane, then re-runs `_mountTiles`. Tile instances are
     * disposed and re-created so subscriptions stay clean.
     */
    async _reflowTilesForLayout() {
        if (!this.mainEl) return
        // Dispose existing tiles cleanly before re-mounting.
        for (const tile of this.tilesById.values()) {
            try { if (typeof tile.dispose === "function") tile.dispose() }
            catch (_) { /* noop */ }
        }
        this.tilesById.clear()
        this._tilesBySection = new Map()
        if (this._cascadeController && typeof this._cascadeController.dispose === "function") {
            try { this._cascadeController.dispose() } catch (_) {}
            this._cascadeController = null
        }
        this.mainEl.innerHTML = ""
        await this._mountTiles()
    }

    async _refreshLastScrapeStamp() {
        if (!this._lastScrapeStamp) return
        try {
            const blob = await chrome.storage.local.get(["scrapeOrchestrator:lastRun"])
            const run = blob && blob["scrapeOrchestrator:lastRun"]
            this._lastScrapeStamp.textContent = CentralHubShell._formatLastRun(run)
        } catch (_) {
            this._lastScrapeStamp.textContent = ""
        }
    }

    /**
     * Per-phase auto-drive freshness strip. Reads the cadence-store records
     * for the four mandatory phases and renders one tiny chip each
     * (foundation/per-hub/per-aircraft/per-route) coloured by how recently
     * the phase ran versus its target cadence. When `changedKey` is passed
     * (storage.onChanged callback), the corresponding chip pulses briefly so
     * the user perceives the dashboard updating live.
     */
    async _refreshAutoDriveStrip(changedKey) {
        const el = this._autoDriveStripEl
        if (!el) return
        if (typeof window.AesPhaseCadenceStore === "undefined") {
            el.textContent = ""
            return
        }
        const T = window.AESTokens
        const host = {server: this.server || "", airline: this.airline || ""}
        if (!host.server) { el.textContent = ""; return }

        const phases = [
            {id: "foundation",   short: "F"},
            {id: "per-hub",      short: "H"},
            {id: "per-aircraft", short: "A"},
            {id: "per-route",    short: "R"}
        ]
        const cadence = window.AesPhaseCadenceStore.DEFAULT_CADENCE_MS
        const records = await window.AesPhaseCadenceStore.loadAll(host, phases.map(p => p.id))

        el.innerHTML = ""
        const label = document.createElement("span")
        label.textContent = "auto"
        label.style.cssText = "color:" + T.color.oxide2 + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
        el.appendChild(label)

        for (const p of phases) {
            const r = records[p.id]
            const cad = cadence[p.id] || 0
            const age = window.AesPhaseCadenceStore.ageMs(r)
            const fresh = isFinite(age) && age < cad * 0.5
            const stale = isFinite(age) && age >= cad
            const color = fresh ? "#34d399" : stale ? "#f59e0b" : T.color.slate
            const chip = document.createElement("span")
            chip.style.cssText = "color:" + color + ";"
            chip.textContent = "· " + p.short + " " + CentralHubShell._fmtAge(age)
            chip.title = (r && r.completedAt)
                ? p.id + " — last run " + new Date(r.completedAt).toLocaleString()
                  + " · " + (r.succeeded || 0) + "/" + (r.total || 0) + " ok"
                : p.id + " — never run"
            el.appendChild(chip)

            if (changedKey && changedKey.endsWith(":" + p.id)) {
                chip.style.transition = "background 80ms linear, color 80ms linear"
                chip.style.background = T.color.bone3
                chip.style.borderRadius = "2px"
                chip.style.padding = "0 3px"
                setTimeout(() => {
                    chip.style.background = "transparent"
                    chip.style.padding = "0"
                }, 700)
            }
        }
    }

    static _fmtAge(ms) {
        if (!isFinite(ms)) return "—"
        if (ms < 60_000)         return Math.max(1, Math.floor(ms / 1000)) + "s"
        if (ms < 3_600_000)      return Math.floor(ms / 60_000) + "m"
        if (ms < 86_400_000)     return Math.floor(ms / 3_600_000) + "h"
        return Math.floor(ms / 86_400_000) + "d"
    }

    static _formatLastRun(run) {
        if (!run || !run.completedAt) return "no full scrape yet"
        const ageMs = Date.now() - run.completedAt
        const min = Math.floor(ageMs / 60000)
        const hr  = Math.floor(min / 60)
        const ageText = ageMs < 60000 ? "just now"
                      : hr >= 24 ? Math.floor(hr / 24) + "d ago"
                      : hr >= 1  ? hr + "h ago"
                                 : min + "m ago"
        const phases = run.perPhase || {}
        const parts = []
        for (const id of Object.keys(phases)) {
            const p = phases[id]
            if (p.skipped) { parts.push(id + ":skip"); continue }
            const ok = (p.succeeded || 0)
            const tot = (p.total || 0)
            parts.push(id + " " + ok + "/" + tot + (p.failed ? "·" + p.failed + "f" : ""))
        }
        const aborted = run.aborted ? " (aborted)" : ""
        return "last scrape: " + ageText + aborted + (parts.length ? " · " + parts.join(" · ") : "")
    }

    /**
     * CH-W1 — gather every salience input once per render pass and shape
     * them for the pure `CentralHubSalience.rankTiles` call. No tile
     * subscribes new stores; everything here is read-once-on-render.
     */
    async _buildSalienceContext() {
        const settings = this.settings || {}
        const pinned = Array.isArray(settings.pinnedTiles) ? settings.pinnedTiles : []
        const recents = Array.isArray(settings.recentTiles) ? settings.recentTiles : []
        const tileOrderRaw = (settings.tileOrder && typeof settings.tileOrder === "object")
            ? settings.tileOrder : {}

        // tileOrder may be either {tileId: rank} (CH-W1 shape) or the
        // legacy {sectionId: [tileId,...]} reservation. Flatten the
        // legacy shape into per-tile ranks so both work.
        const tileOrder = {}
        for (const k of Object.keys(tileOrderRaw)) {
            const v = tileOrderRaw[k]
            if (typeof v === "number" && isFinite(v)) {
                tileOrder[k] = v
            } else if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    if (typeof v[i] === "string") tileOrder[v[i]] = i
                }
            }
        }

        // HubFeed unread — many slices are not tile-keyed today, so v1
        // reads only slices whose name matches `hub:tile:<tileId>:unread`.
        // Tiles that don't emit such a slice contribute 0.
        const hubFeedUnread = new Map()
        if (window.HubFeed && typeof window.HubFeed.list === "function") {
            try {
                const slices = window.HubFeed.list() || []
                for (const s of slices) {
                    const m = /^hub:tile:([^:]+):unread$/.exec(s.name || "")
                    if (!m) continue
                    const v = (s.value && typeof s.value.count === "number") ? s.value.count : Number(s.value)
                    if (typeof v === "number" && isFinite(v) && v > 0) {
                        hubFeedUnread.set(m[1], v)
                    }
                }
            } catch (_) { /* ignore */ }
        }

        // Conductor signal-domain density — read the recent ring and
        // bucket by first-token domain. Window: last hour.
        let signalsByDomain = new Map()
        if (window.AesConductorSignalStore && window.CentralHubSalience) {
            try {
                const host = {server: this.server, airline: this.airline}
                const recent = await window.AesConductorSignalStore.recent(host, 200)
                signalsByDomain = window.CentralHubSalience.signalsByDomainFromRing(recent, 3600000)
            } catch (_) { /* ignore */ }
        }

        return {
            pinnedSet:        new Set(pinned),
            recentList:       recents,
            hubFeedUnread:    hubFeedUnread,
            signalsByDomain:  signalsByDomain,
            pulseByTileId:    this._tilePulseMap || new Map(),
            tileOrder:        tileOrder,
            weights:          settings.salienceWeights || null,
            priorityFloor:    100
        }
    }

    async _mountTiles() {
        const ctx = {server: this.server, airline: this.airline}
        let all = window.CentralHubTileRegistry.all()

        // C-3 — apply tile-section overrides if enabled. Pure remap; the
        // section field on each spec is rewritten before the section loop
        // groups them.
        if (window.CentralHubTileSectionOverrider) {
            const validSections = window.CentralHubNav.SECTIONS.map(function (s) { return s.id })
            all = window.CentralHubTileSectionOverrider.apply(all, this.settings, validSections)
        }

        const expandedSet = new Set(this.settings.expandedTiles || [])

        // CH-W1 — pre-load salience inputs once per render. Pure scorer
        // reads pin set, recents ring, HubFeed unread, Conductor signal
        // ring; these are observable at render time without subscribing
        // new stores. The scorer stays pure so the same inputs produce
        // a deterministic order.
        const salienceCtx = await this._buildSalienceContext()

        // C-2 — recents rail above the first section.
        if (window.CentralHubRecentsRail && this.mainEl) {
            try { await window.CentralHubRecentsRail.mount(this.mainEl) }
            catch (_) { /* mount is best-effort */ }
        }

        // CH-W3 — cascade layout branch. Section partitioning vanishes;
        // every tile flows into a single salience-ranked waterfall.
        // Topic chips narrow the visible set without re-grouping.
        if (this.settings.layoutMode === "cascade" && window.CentralHubCascade) {
            await this._mountTilesCascade(all, expandedSet, ctx, salienceCtx)
            return
        }

        for (const section of window.CentralHubNav.SECTIONS) {
            let sectionTiles = all.filter(t => t.section === section.id)
            // CH-W1 — sort by salience desc instead of priority asc.
            // Falls back to alphabetical id on tie. tileOrder beats
            // signal-driven scoring when set.
            if (window.CentralHubSalience) {
                sectionTiles = window.CentralHubSalience.rankTiles(sectionTiles, salienceCtx)
            }
            const sectionContainer = this._buildSectionContainer(section)
            this.mainEl.appendChild(sectionContainer)

            const instances = []
            for (const spec of sectionTiles) {
                let tile
                try { tile = spec.factory() }
                catch (err) { console.warn("[AES Hub] tile factory threw", spec.id, err); continue }
                if (!tile) continue

                const expanded = expandedSet.has(tile.id)
                try {
                    await tile.mount(sectionContainer, ctx, {
                        expanded,
                        onToggleChange: (id, isExpanded) => this._onTileToggle(id, isExpanded)
                    })
                } catch (err) {
                    console.warn("[AES Hub] tile mount failed", tile.id, err)
                    continue
                }
                this.tilesById.set(tile.id, tile)
                instances.push(tile)
            }

            this._tilesBySection.set(section.id, instances)
            this.nav.setTilesForSection(section.id, instances)

            if (!instances.length) {
                const T = window.AESTokens
                const empty = document.createElement("div")
                empty.style.cssText = [
                    "padding:" + T.sp[3],
                    "color:" + T.color.slate,
                    "font-style:italic",
                    "border:" + T.geom.bw1 + " dashed " + T.color.paperRule,
                    "background:" + T.color.bone2,
                    "margin-bottom:" + T.sp[3]
                ].join(";")
                empty.textContent = "No tiles registered for this section yet."
                sectionContainer.appendChild(empty)
            }
        }
    }

    /**
     * CH-W5 — one-shot migration on first cascade boot. Projects the
     * legacy `tileSectionOverrides{tileId: section}` map into the
     * cascade-era `tileTopicOverrides{tileId: [topics]}` map. Original
     * map is preserved for backwards-compat with classic mode. Bumps
     * schemaVersion 1 → 2 so the projection runs exactly once.
     *
     * Idempotent — safe to call from multiple entry points; the
     * schemaVersion gate short-circuits subsequent calls.
     */
    async _maybeProjectTopicOverrides() {
        if (!this.settings) return
        if (Number(this.settings.schemaVersion) >= 2) return
        const src = this.settings.tileSectionOverrides || {}
        const dst = Object.assign({}, this.settings.tileTopicOverrides || {})
        let dirty = false
        for (const tid in src) {
            if (Object.prototype.hasOwnProperty.call(src, tid)) {
                const sec = src[tid]
                if (typeof sec === "string" && sec.length > 0) {
                    if (!Array.isArray(dst[tid]) || dst[tid].indexOf(sec) < 0) {
                        dst[tid] = [sec]
                        dirty = true
                    }
                }
            }
        }
        this.settings.tileTopicOverrides = dst
        this.settings.schemaVersion = 2
        await window.CentralHubSettings.save(this.settings).catch(() => {})
        if (dirty) {
            console.info("[AES Hub] CH-W5 projected " + Object.keys(dst).length
                + " tileSectionOverrides into tileTopicOverrides")
        }
    }

    /**
     * CH-W3 — Cascade-mode tile mount. Mounts every tile into an
     * off-DOM staging container so each tile has a `_root` we can
     * reparent into the cascade columns. The cascade controller owns
     * column count + reflow; the shell owns lifecycle.
     *
     * Topic chips render above the cascade pane.
     */
    async _mountTilesCascade(all, expandedSet, ctx, salienceCtx) {
        // CH-W5 — run the one-shot projection before tiles mount so
        // the cascade reads the new topic map immediately.
        await this._maybeProjectTopicOverrides()
        // Topic-chip strip above the cascade.
        const chipStrip = this._buildTopicChipStrip(all)
        this.mainEl.appendChild(chipStrip)

        // Cascade host — the pane mounts directly into mainEl.
        const cascadeHost = document.createElement("div")
        cascadeHost.className = "aes-central-hub__cascade-host"
        this.mainEl.appendChild(cascadeHost)
        this._cascadeHost = cascadeHost

        const ranked = window.CentralHubSalience
            ? window.CentralHubSalience.rankTiles(all, salienceCtx)
            : all

        // Mount each tile into a hidden staging container; the cascade
        // controller reparents `tile.root` into a column. Tiles never
        // get unmounted on layout reflow.
        const stage = document.createElement("div")
        stage.style.cssText = "display:none"
        document.body.appendChild(stage)
        const liveTiles = []
        for (const spec of ranked) {
            let tile
            try { tile = spec.factory() }
            catch (err) { console.warn("[AES Hub] cascade factory threw", spec.id, err); continue }
            if (!tile) continue
            const expanded = expandedSet.has(tile.id)
            try {
                await tile.mount(stage, ctx, {
                    expanded,
                    onToggleChange: (id, isExpanded) => this._onTileToggle(id, isExpanded)
                })
            } catch (err) {
                console.warn("[AES Hub] cascade tile mount failed", tile.id, err)
                continue
            }
            this.tilesById.set(tile.id, tile)
            // Pass cardKind + topics + _root through to the cascade.
            const sliced = {
                id:        tile.id,
                _root:     tile.root,
                cardKind:  (tile.root && tile.root.dataset.cardKind) || spec.cardKind || "regular",
                topics:    Array.isArray(spec.topics) ? spec.topics
                            : (spec.section ? [spec.section] : []),
                section:   spec.section
            }
            liveTiles.push(sliced)
        }
        if (stage.parentNode) stage.parentNode.removeChild(stage)

        // Mount the cascade controller.
        const controller = window.CentralHubCascade.mount(cascadeHost)
        if (!controller) return
        const fullSet = new Set(this.settings.pinnedFullWidthTiles || [])
        controller.setTiles(liveTiles, new Map(), fullSet)
        // Defer a second pass so post-paint heights propagate into the
        // packer (re-balances columns once real heights are known).
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
                if (!this._disposed) controller.refreshLayout()
            })
        }
        this._cascadeController = controller
        this._cascadeLiveTiles = liveTiles
    }

    /**
     * CH-W3 — topic chip strip. Multi-select; an empty selection means
     * ALL. Active chips persist on `settings.activeTopicFilter` (string[]).
     */
    _buildTopicChipStrip(allSpecs) {
        const T = window.AESTokens
        const strip = document.createElement("div")
        strip.className = "aes-central-hub__topic-chips"
        strip.style.cssText = [
            "display:flex",
            "gap:" + T.sp[2],
            "flex-wrap:wrap",
            "padding:" + T.sp[2] + " 0",
            "margin-bottom:" + T.sp[3]
        ].join(";")

        // Discover topic universe — union of every tile's topics +
        // legacy section ids (every tile has at least its section).
        const universe = new Set()
        for (const spec of allSpecs) {
            if (Array.isArray(spec.topics)) for (const t of spec.topics) universe.add(t)
            if (spec.section) universe.add(spec.section)
        }
        const topicList = ["__all__"].concat(Array.from(universe).sort())

        const active = new Set(Array.isArray(this.settings.activeTopicFilter)
            ? this.settings.activeTopicFilter : [])

        for (const id of topicList) {
            const isAll = id === "__all__"
            const chip = document.createElement("button")
            chip.type = "button"
            chip.dataset.topic = id
            const isActive = isAll ? active.size === 0 : active.has(id)
            chip.textContent = isAll ? "ALL" : id.toUpperCase()
            chip.style.cssText = [
                "padding:" + T.sp[1] + " " + T.sp[3],
                "background:" + (isActive ? T.color.oxide : "transparent"),
                "color:" + (isActive ? T.color.bone : T.color.oxide),
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "border-radius:" + T.geom.radius,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "font-weight:" + T.fw.display,
                "letter-spacing:" + T.track.caps,
                "cursor:pointer"
            ].join(";")
            chip.addEventListener("click", () => this._onTopicChipClick(id))
            strip.appendChild(chip)
        }
        return strip
    }

    async _onTopicChipClick(topicId) {
        const cur = new Set(Array.isArray(this.settings.activeTopicFilter)
            ? this.settings.activeTopicFilter : [])
        if (topicId === "__all__") {
            cur.clear()
        } else if (cur.has(topicId)) {
            cur.delete(topicId)
        } else {
            cur.add(topicId)
        }
        this.settings.activeTopicFilter = Array.from(cur)
        await window.CentralHubSettings.save(this.settings).catch(() => {})
        // Re-render chip strip + apply filter to cascade controller.
        const oldStrip = this.mainEl.querySelector(".aes-central-hub__topic-chips")
        if (oldStrip) {
            const all = window.CentralHubTileRegistry.all()
            const fresh = this._buildTopicChipStrip(all)
            oldStrip.replaceWith(fresh)
        }
        if (this._cascadeController && typeof this._cascadeController.setTopicFilter === "function") {
            this._cascadeController.setTopicFilter(cur.size ? cur : null)
        }
    }

    _buildSectionContainer(section) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.dataset.section = section.id
        wrap.dataset.aesSurface = "panel"
        wrap.id = "aes-central-hub-section-" + section.id
        wrap.className = "aes-central-hub__section"
        wrap.style.cssText = "margin-bottom:" + T.sp[5] + ";"

        const header = document.createElement("h2")
        header.textContent = section.label
        header.style.cssText = [
            "margin:0 0 " + T.sp[3] + " 0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.h3,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "border-bottom:" + T.geom.bw2 + " solid " + T.color.oxide,
            "padding-bottom:" + T.sp[1]
        ].join(";")
        wrap.appendChild(header)
        return wrap
    }

    _onSectionChange(section) {
        this.settings.activeSection = section
        window.CentralHubSettings.save(this.settings).catch(() => { /* noop */ })
        this._scrollToActiveSection()
    }

    _onTileSelect(tileId) {
        const tile = this.tilesById.get(tileId)
        if (!tile || !tile.root) return
        if (!tile.expanded) tile.toggle()
        tile.root.scrollIntoView({behavior: "smooth", block: "start"})
    }

    _onTileToggle(id, isExpanded) {
        const expanded = new Set(this.settings.expandedTiles || [])
        if (isExpanded) expanded.add(id); else expanded.delete(id)
        this.settings.expandedTiles = Array.from(expanded)
        // C-2 — push to recents ring on expand (not on collapse).
        if (isExpanded && window.CentralHubRecentsRail) {
            window.CentralHubRecentsRail.pushRecent(this.settings, id)
        }
        window.CentralHubSettings.save(this.settings).catch(() => { /* noop */ })
    }

    _scrollToActiveSection() {
        if (!this.mainEl) return
        const target = this.mainEl.querySelector(
            "#aes-central-hub-section-" + (this.settings.activeSection || "fleet")
        )
        if (target) target.scrollIntoView({behavior: "smooth", block: "start"})
    }

    /**
     * CH-5c — wire up the cross-tile event bus. Today only "open-tile" has
     * concrete emitters (the hero KPI strip); the focus-* events stay
     * reserved until CH-5d. The shell handles "open-tile" centrally so
     * tiles never have to repeat the scroll/expand/section-activate dance.
     */
    _subscribeBusEvents() {
        if (!window.CentralHubBus || typeof window.CentralHubBus.on !== "function") return
        if (this._busDispose) return
        this._busDispose = window.CentralHubBus.on("open-tile", (payload) => {
            if (!payload || !payload.tileId) return
            const tile = this.tilesById.get(payload.tileId)
            if (!tile) return

            const section = tile.section
            if (section && this.nav) this.nav.setActive(section)
            if (section && this.settings && this.settings.activeSection !== section) {
                this.settings.activeSection = section
                window.CentralHubSettings.save(this.settings).catch(() => { /* noop */ })
            }

            const wantExpand = payload.expand !== false
            if (wantExpand && !tile.expanded) tile.toggle()

            if (payload.scrollIntoView !== false && tile.root) {
                tile.root.scrollIntoView({behavior: "smooth", block: "start"})
            }

            if (payload.filter && tile.expanded && typeof tile._renderBodySafe === "function") {
                tile._renderBodySafe(payload.filter).catch(() => { /* noop */ })
            }
        })
    }

    _applyFilter() {
        const q = this._filterText
        for (const tile of this.tilesById.values()) {
            if (!tile.root) continue
            if (!q) { tile.root.style.display = ""; continue }
            const inTitle   = (tile.title || "").toLowerCase().indexOf(q) >= 0
            const inSummary = ((tile._lastStatus && tile._lastStatus.summary) || "").toLowerCase().indexOf(q) >= 0
            tile.root.style.display = (inTitle || inSummary) ? "" : "none"
        }
    }
}

if (typeof window !== "undefined") {
    window.CentralHubShell = CentralHubShell
}
