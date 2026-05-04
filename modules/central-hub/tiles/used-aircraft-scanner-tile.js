"use strict"

/**
 * Used Aircraft Scanner tile — exposes saved presets and the most recent
 * scan session at a glance. The full scanner UI (preset editor + family
 * grid + concurrent tab orchestration) stays in the legacy
 * `displayUsedAircraftScanner()` handler in content_dashboard.js until the
 * CH-4 cutover; the hub provides quick visibility + a one-click route to
 * the AS aircraft market page where the scanner mounts.
 *
 * Reads:
 *   settings.usedAircraftScanner               — UsedAircraftPresets shape
 *   <server>marketScan:<scanId>                — MarketScanSession session
 */
class CentralHubUasTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "used-aircraft-scanner"
        this.title = "Used Scanner"
        this.section = "fleet"
        this.priority = 30
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        const server = (ctx && ctx.server) || ""
        // F-9228-203: dropped the bare "settings" prefix — that key holds
        // every module's settings slice, so watching it caused refreshes
        // from completely unrelated modules. The mount() override below
        // attaches a slice-aware listener that fires only on
        // settings.usedAircraftScanner changes.
        return [
            server + "marketScan:",
            server + "marketScan:digest:"
        ]
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        // F-9228-203: scoped listener for the usedAircraftScanner slice of
        // the global settings blob. Compares fingerprint before/after to
        // skip refreshes on unrelated slice writes (RA, schedule-mgmt, …).
        this._uasSettingsListener = (changes, area) => {
            if (area !== "local" || !changes.settings) return
            const oldSlice = changes.settings.oldValue && changes.settings.oldValue.usedAircraftScanner
            const newSlice = changes.settings.newValue && changes.settings.newValue.usedAircraftScanner
            if (JSON.stringify(oldSlice || null) === JSON.stringify(newSlice || null)) return
            this.refresh()
        }
        try { chrome.storage.onChanged.addListener(this._uasSettingsListener) }
        catch (_) { /* tile still works without it */ }
    }

    dispose() {
        if (this._uasSettingsListener) {
            try { chrome.storage.onChanged.removeListener(this._uasSettingsListener) }
            catch (_) { /* noop */ }
            this._uasSettingsListener = null
        }
        super.dispose()
    }

    openHref() { return "/app/aircraft/market" }

    async _loadDigests() {
        // Class declarations in content scripts are lexical bindings in the
        // shared realm — they don't attach to window. Probe by typeof on
        // the bare identifier (matches market-panel/panel.js usage).
        if (typeof MarketScanDiffStore === "undefined") return []
        const server = (this.ctx && this.ctx.server) || ""
        if (!server) return []
        try { return await MarketScanDiffStore.loadAllDigests(server) }
        catch (_) { return [] }
    }

    async _loadBlock() {
        try {
            if (typeof UsedAircraftPresets !== "undefined") {
                return await UsedAircraftPresets.load()
            }
        } catch (_) { /* fall through */ }
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const block = settings.usedAircraftScanner || {presets: [], lastScanId: null}
        return block
    }

    async _loadLastSession(scanId) {
        if (!scanId) return null
        const server = (this.ctx && this.ctx.server) || ""
        if (!server) return null
        try {
            // Bare identifier — class decls don't pollute window. Matches
            // content_marketScan.js / market-panel/panel.js access pattern.
            if (typeof MarketScanSession !== "undefined") {
                return await MarketScanSession.loadSession(server, scanId)
            }
        } catch (_) { /* fall through */ }
        const key = server + "marketScan:" + scanId
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    /**
     * Apply a preset from the tile. Mirrors the standalone panel's
     * _onPresetApply: pulls the patch via UsedAircraftPresets.apply, writes
     * it back to storage, and re-renders the tile body so the active chip
     * highlight + status badge update without a full hub refresh.
     */
    async _activatePreset(presetId, host, ctx) {
        if (typeof UsedAircraftPresets === "undefined") return
        const block = await this._loadBlock()
        const patch = UsedAircraftPresets.apply(presetId, block)
        if (!patch) return
        let merged = null
        try { merged = await UsedAircraftPresets.save(patch) }
        catch (e) { console.error("AES UAS tile: preset apply failed:", e) }
        // F-9228-204: cache the merged block on `this` instead of passing
        // it positionally — the base class's renderBody contract uses the
        // 3rd arg as `focusFilter`, and conflating the two parameters
        // breaks any cross-tile drill-in to the UAS tile.
        this._pendingBlock = merged
        await this.renderBody(ctx, host)
    }

    async loadStatus() {
        const block = await this._loadBlock()
        // F-9228-200: only kick the digests read off when the path that
        // consumes it (finished-session branch) is reachable. The previous
        // unconditional parallel fetch fired even on running-scan and
        // no-session paths where the result was orphaned — and the
        // underlying loadAllDigests is a chrome.storage.local.get(null)
        // full-storage scan, so the orphan read was non-trivial.
        const session = await this._loadLastSession(block && block.lastScanId)
        const userCount   = (block && block.presets && block.presets.length) || 0
        const builtIns    = (typeof UsedAircraftPresets !== "undefined")
            ? (UsedAircraftPresets.BUILT_IN_PRESETS || []).length : 0
        const presetCount = userCount + builtIns
        const watchCount  = (block && Array.isArray(block.watchlist)) ? block.watchlist.length : 0
        const sched       = (block && block.schedule) || null
        const automation  = CentralHubUasTile._summariseAutomation(watchCount, sched)

        if (session && session.status === "running") {
            const queue = Array.isArray(session.queue) ? session.queue : []
            const done = queue.filter(q => q.status === "done" || q.status === "error").length
            return {
                badge: "RUNNING",
                badgeKind: window.CentralHubStatusBadges.KIND.WARN,
                summary: "Scan in progress · " + done + " / " + queue.length + " types"
                    + (automation ? " · " + automation : "")
            }
        }
        if (session && session.finishedAt) {
            const when = new Date(session.finishedAt).toISOString().substring(0, 10)
            const digests = await this._loadDigests()
            const latest = digests[0]
            // F-9228-201: guard diffCounts presence — `summary` is set by
            // panel.js after a scan, but other writers (or future scans
            // started before diff post-processing finishes) can produce a
            // digest with summary but no diffCounts, which would crash here.
            const diffTail = (latest && latest.summary && latest.diffCounts && !latest.diffCounts.firstScan)
                ? " · " + latest.summary
                : ""
            return {
                badge: presetCount + " PRESETS",
                badgeKind: window.CentralHubStatusBadges.KIND.OK,
                summary: "Last scan " + when + " · " + (session.presetName || "(unnamed)")
                    + diffTail
                    + (automation ? " · " + automation : "")
            }
        }
        return {
            badge: presetCount ? presetCount + " PRESETS" : "NO PRESETS",
            badgeKind: presetCount
                ? window.CentralHubStatusBadges.KIND.DEFAULT
                : window.CentralHubStatusBadges.KIND.MUTED,
            summary: presetCount
                ? ("No completed scans yet — pick a preset and start one."
                    + (automation ? " · " + automation : ""))
                : "Save a preset on /app/aircraft/market or via the legacy dashboard."
        }
    }

    /**
     * Compact "Watch · N · Auto-rescan 60m" describer for the status row,
     * surfacing the automation features without bloating the badge.
     */
    static _summariseAutomation(watchCount, sched) {
        const bits = []
        if (watchCount > 0) bits.push("Watch · " + watchCount)
        if (sched && sched.enabled && sched.cadenceMin) {
            bits.push("Auto " + sched.cadenceMin + "m")
        }
        return bits.join(" · ")
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        // Generation guard: shell.js's open-tile handler can fire two
        // overlapping renders (toggle()'s _renderBodySafe + an explicit
        // _renderBodySafe(filter)). Both clear synchronously, then both
        // await; without this guard both append after their await, doubling
        // the preset chip strip + steals list. Bail older renders.
        const gen = (this._renderGen = (this._renderGen || 0) + 1)
        host.textContent = ""
        // F-9228-204: pull from the per-render cache populated by
        // _activatePreset (skips a redundant _loadBlock right after a
        // save). Cleared after consumption so subsequent refreshes go
        // through the regular load path. focusFilter is reserved for the
        // documented base-class drill-in contract.
        const cached = this._pendingBlock
        this._pendingBlock = null
        const block = cached || await this._loadBlock()
        if (gen !== this._renderGen) return
        // Kick the two reads that follow off in parallel — they're
        // independent of the synchronous DOM build below and depend only
        // on the block we just loaded.
        const sessionP = this._loadLastSession(block && block.lastScanId)
        const digestsP = this._loadDigests()
        const presets = (typeof UsedAircraftPresets !== "undefined")
            ? UsedAircraftPresets.allPresets(block)
            : ((block && block.presets) || [])
        const activeId  = (block && block.activePresetId) || null
        const watchlist = (block && Array.isArray(block.watchlist)) ? block.watchlist : []
        const sched     = (block && block.schedule) || null

        // Automation summary row — surfaces watchlist + schedule state above
        // the preset list so the reader sees the loop's status at a glance.
        if (watchlist.length || (sched && sched.enabled)) {
            const auto = document.createElement("div")
            auto.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[3] + ";"
            if (watchlist.length) {
                auto.appendChild(CentralHubUasTile._infoChip(T,
                    "WATCHING", watchlist.length + " models",
                    watchlist.length === 1
                        ? watchlist[0]
                        : watchlist.slice(0, 5).join(", ")
                            + (watchlist.length > 5 ? ", …" : "")))
            }
            if (sched && sched.enabled) {
                const presetName = (presets.find(p => p.id === sched.presetId) || {}).name || "(no preset)"
                auto.appendChild(CentralHubUasTile._infoChip(T,
                    "AUTO-RESCAN",
                    "every " + (sched.cadenceMin || "?") + " min",
                    "Preset: " + presetName))
            }
            host.appendChild(auto)
        }

        if (!presets.length) {
            const note = document.createElement("p")
            note.style.cssText = "color:" + T.color.slate + ";margin:0 0 " + T.sp[2] + " 0;"
            note.textContent = "No presets defined. Use the legacy dashboard ‘Used Aircraft Scanner’ section below to create one."
            host.appendChild(note)
        } else {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[3] + ";"
            for (const p of presets) {
                const isActive = p.id === activeId
                const chip = document.createElement("button")
                chip.type = "button"
                chip.title = p.blurb || ""
                chip.style.cssText = [
                    "all:unset",
                    "display:inline-flex",
                    "align-items:center",
                    "gap:" + T.sp[1],
                    "padding:2px " + T.sp[2],
                    "background:" + (isActive ? T.color.rust : T.color.bone2),
                    "color:" + (isActive ? "#fff" : T.color.oxide),
                    "border:" + T.geom.bw1 + " solid " + (isActive ? T.color.rust : T.color.oxide),
                    "border-radius:" + T.geom.radius,
                    "font-family:" + T.font.mono,
                    "font-size:" + T.fs.micro,
                    "letter-spacing:" + T.track.mono,
                    "text-transform:uppercase",
                    "cursor:pointer"
                ].join(";")
                const name = document.createElement("span")
                name.textContent = p.name || "(unnamed)"
                const meta = document.createElement("span")
                meta.style.color = isActive ? "#fff" : T.color.slate
                meta.style.opacity = isActive ? "0.85" : "1"
                if (p.builtIn) meta.textContent = "· " + (p.mode || "buy")
                else           meta.textContent = "· " + ((p.types && p.types.length) || 0) + " types"
                chip.append(name, meta)
                chip.addEventListener("click", () => this._activatePreset(p.id, host, ctx))
                wrap.appendChild(chip)
            }
            host.appendChild(wrap)
        }

        const session = await sessionP
        if (gen !== this._renderGen) return
        if (session) {
            const T2 = window.AESTokens
            const note = document.createElement("div")
            note.style.cssText = [
                "padding:" + T2.sp[2] + " " + T2.sp[3],
                "background:" + T2.color.bone2,
                "border:" + T2.geom.bw1 + " solid " + T2.color.paperRule,
                "color:" + T2.color.oxide2,
                "font-family:" + T2.font.mono,
                "font-size:" + T2.fs.body,
                "letter-spacing:" + T2.track.mono
            ].join(";")
            const queue = Array.isArray(session.queue) ? session.queue : []
            const done = queue.filter(q => q.status === "done").length
            const err = queue.filter(q => q.status === "error").length
            const started = session.startedAt ? new Date(session.startedAt).toISOString().substring(0, 16).replace("T", " ") : "?"
            note.textContent = "Last session: " + (session.presetName || "(unnamed)")
                + " · status " + session.status + " · started " + started
                + " · " + done + " ok / " + err + " err / " + queue.length + " total"
            host.appendChild(note)
        }

        // Top STEALs across every saved digest, best 3 by dealScore — gives
        // the user "what's actually worth AS$ right now" without clicking
        // through to the market panel.
        const digests = await digestsP
        if (gen !== this._renderGen) return
        const stealRows = CentralHubUasTile._topSteals(digests, 3)
        if (stealRows.length) {
            host.appendChild(CentralHubUasTile._stealsList(T, stealRows))
        }
    }

    static _topSteals(digests, limit) {
        const out = []
        for (const d of digests) {
            for (const r of (d.rows || [])) {
                if (r && r.dealClass === "steal" && typeof r.dealScore === "number") {
                    out.push(r)
                }
            }
        }
        out.sort((a, b) => b.dealScore - a.dealScore)
        return out.slice(0, limit || 3)
    }

    static _stealsList(T, rows) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:" + T.sp[3] + ";"
        const heading = document.createElement("div")
        heading.textContent = "Top steals · last scan"
        heading.style.cssText = [
            "font:9px " + T.font.display,
            "font-weight:700",
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.slate,
            "margin-bottom:" + T.sp[2]
        ].join(";")
        wrap.appendChild(heading)
        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1] + ";"
        for (const r of rows) {
            // F-9228-202: when offerUrl is missing, build a non-clickable
            // <span> with greyed-out style instead of an anchor with
            // href="#". The previous version rendered a styled link that
            // navigated to the current page's #fragment in the same tab,
            // losing the user's hub state.
            const link = document.createElement(r.offerUrl ? "a" : "span")
            if (r.offerUrl) {
                link.href = r.offerUrl
                link.target = "_blank"
                link.rel = "noopener"
            } else {
                link.title = "Offer URL unavailable for this row"
            }
            link.style.cssText = [
                "display:flex", "gap:" + T.sp[2],
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:" + T.color.bone2,
                "border-left:3px solid " + T.color.rust,
                "color:" + T.color.oxide,
                "text-decoration:none",
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.body,
                "letter-spacing:" + T.track.mono,
                "align-items:center"
            ].join(";")
            const score = document.createElement("strong")
            score.textContent = String(r.dealScore)
            score.style.cssText = "color:" + T.color.rust + ";min-width:28px;"
            const title = document.createElement("span")
            title.textContent = r.aircraftType
                + (r.registration ? " · " + r.registration : "")
            title.style.cssText = "flex:1 1 auto;"
            const pps = document.createElement("span")
            pps.textContent = (typeof r.pps === "number")
                ? Math.round(r.pps).toLocaleString() + "/seat"
                : "—"
            pps.style.color = T.color.slate
            link.append(score, title, pps)
            list.appendChild(link)
        }
        wrap.appendChild(list)
        return wrap
    }

    static _infoChip(T, label, value, tooltip) {
        const chip = document.createElement("span")
        chip.title = tooltip || ""
        chip.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "gap:" + T.sp[1],
            "padding:2px " + T.sp[2],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-left:" + T.geom.bw1 + " solid " + T.color.rust,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "text-transform:uppercase"
        ].join(";")
        const k = document.createElement("span")
        k.textContent = label
        k.style.color = T.color.slate
        const v = document.createElement("span")
        v.textContent = value
        chip.append(k, v)
        return chip
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "used-aircraft-scanner",
        section: "fleet",
        priority: 30,
        factory: () => new CentralHubUasTile()
    })
}
