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
    }

    async mount(anchorEl) {
        this.settings = await window.CentralHubSettings.load()
        this._migrateLegacyDashboardSetting()

        const root = this._buildShellSkeleton()
        anchorEl.before(root)
        this.root = root

        await this._mountTiles()

        this.nav.setActive(this.settings.activeSection || "fleet")
        this._scrollToActiveSection()
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
            stationAutomation:     "routes",
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

        bar.append(title, subtitle, filter, ctxStamp, stamp)
        return bar
    }

    async _mountTiles() {
        const ctx = {server: this.server, airline: this.airline}
        const all = window.CentralHubTileRegistry.all()
        const expandedSet = new Set(this.settings.expandedTiles || [])

        for (const section of window.CentralHubNav.SECTIONS) {
            const sectionTiles = all.filter(t => t.section === section.id)
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

    _buildSectionContainer(section) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.dataset.section = section.id
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
        window.CentralHubSettings.save(this.settings).catch(() => { /* noop */ })
    }

    _scrollToActiveSection() {
        if (!this.mainEl) return
        const target = this.mainEl.querySelector(
            "#aes-central-hub-section-" + (this.settings.activeSection || "fleet")
        )
        if (target) target.scrollIntoView({behavior: "smooth", block: "start"})
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
