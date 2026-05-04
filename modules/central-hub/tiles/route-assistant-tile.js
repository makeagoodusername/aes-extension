"use strict"

/**
 * Route Assistant tile — top routes across all known hubs.
 *
 * Reads `routeAssistant:topRoutes:<HUB>` snapshots auto-published by the
 * Route Assistant panel on /app/com/scheduling*. The hub doesn't run RA
 * itself; it surfaces what RA has already cached and routes the user to
 * the scheduling page where the panel mounts and a real refresh happens.
 */
class CentralHubRouteAssistantTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "route-assistant"
        this.title = "Route Assistant"
        this.section = "routes"
        this.priority = 10
        this.requiresAirline = false
    }

    watchedStorageKeys() {
        return [
            "settings",
            "routeAssistant:topRoutes:",
            "routeAssistant:ors:",
            "routeAssistant:orsHealth",
            "routeAssistant:markets:",
            "routeAssistant:inventory:",
            "routeAssistant:yieldHistory:",
            "routeAssistant:override"
        ]
    }

    openHandler() {
        return async () => {
            const hubs = await this._loadHubs()
            const target = this._firstSchedulingTarget(hubs)
            window.location.href = target
                ? "/app/com/scheduling/" + encodeURIComponent(target)
                : "/app/com/scheduling"
        }
    }

    async _loadHubs() {
        const entries = await this._loadByPrefix("routeAssistant:topRoutes")
        const out = []
        for (const e of entries) {
            // Skip ":perClass:" companion snapshots and any deeper-keyed siblings.
            if (e.suffix.indexOf(":") >= 0) continue
            if (!e.suffix || !e.value) continue
            out.push({hub: e.suffix, record: e.value})
        }
        out.sort((a, b) => (b.record.snapshotAt || 0) - (a.record.snapshotAt || 0))
        return out
    }

    _firstSchedulingTarget(hubs) {
        for (const hubInfo of hubs || []) {
            const target = this._scheduleTargetForHub(hubInfo)
            if (target && target.length === 6) return target
        }
        return null
    }

    _scheduleTargetForHub(hubInfo) {
        const hub = String((hubInfo && hubInfo.hub) || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(hub)) return null
        const rows = (hubInfo && hubInfo.record && hubInfo.record.rows) || []
        const firstRoute = rows.find(r => r && (r.destIata || r.dest))
        const firstDest = firstRoute ? String(firstRoute.destIata || firstRoute.dest || "").toUpperCase() : ""
        return hub + (/^[A-Z]{3}$/.test(firstDest) ? firstDest : "")
    }

    async loadStatus() {
        const hubs = await this._loadHubs()
        if (!hubs.length) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No top-routes cached. Open /app/com/scheduling/<HUB> to seed."
            }
        }
        const totalRows = hubs.reduce(
            (acc, h) => acc + ((h.record.rows && h.record.rows.length) || 0), 0)
        const ors = await this._loadOrsCoverage(hubs)
        const newest = hubs[0].record.snapshotAt
            ? new Date(hubs[0].record.snapshotAt).toISOString().substring(0, 10)
            : ""
        const orsTxt = ors && ors.totalRoutes
            ? " · ORS " + ors.coveragePct + "% covered"
                + (ors.breaker && ors.breaker.active ? " · cooldown" : "")
            : ""
        return {
            badge: hubs.length + " HUBS",
            badgeKind: (ors && ors.breaker && ors.breaker.active)
                ? window.CentralHubStatusBadges.KIND.WARN
                : window.CentralHubStatusBadges.KIND.OK,
            summary: totalRows + " scored routes across " + hubs.length + " hub"
                + (hubs.length === 1 ? "" : "s") + (newest ? " · refreshed " + newest : "") + orsTxt
        }
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        const renderSeq = (this._renderBodySeq || 0) + 1
        this._renderBodySeq = renderSeq
        const isCurrentRender = () => this._renderBodySeq === renderSeq && host === this.bodyEl

        // CH-5d-2: pin the filter on the instance so a storage refresh keeps it.
        if (focusFilter && focusFilter.type === "fired-alerts") {
            this._filter = "fired-alerts"
        }

        const hubs = await this._loadHubs()
        if (!isCurrentRender()) return
        if (!hubs.length) {
            const autoPricing = await this._renderAutoPricingPanel(ctx, T)
            if (!isCurrentRender()) return
            host.textContent = ""
            if (autoPricing) host.appendChild(autoPricing)
            this._renderEmptyState(host, "Visit a /app/com/scheduling/<HUB> page (e.g. ATL) to publish a topRoutes snapshot.", {marginTop: T.sp[2]})
            return
        }

        if (this._filter === "fired-alerts") {
            const firedKeys = await this._loadFiredAlertRoutes()
            if (!isCurrentRender()) return
            const frag = document.createDocumentFragment()
            frag.appendChild(this._renderFilterBanner(firedKeys.size, T))
            if (!firedKeys.size) {
                this._renderEmptyState(frag, "No alert rules fired in the last 24 h.", {marginTop: T.sp[2]})
                host.textContent = ""
                host.appendChild(frag)
                return
            }
            const filteredHubs = hubs
                .map(h => ({
                    hub: h.hub,
                    record: Object.assign({}, h.record, {
                        rows: (h.record.rows || []).filter(r =>
                            firedKeys.has(h.hub + "-" + (r.destIata || r.dest)))
                    })
                }))
                .filter(h => h.record.rows && h.record.rows.length)

            if (!filteredHubs.length) {
                this._renderEmptyState(frag,
                    firedKeys.size + " fired route"
                        + (firedKeys.size === 1 ? "" : "s") + " — none in cached topRoutes snapshots.",
                    {marginTop: T.sp[2]})
                host.textContent = ""
                host.appendChild(frag)
                return
            }
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[3] + ";"
            for (const h of filteredHubs) wrap.appendChild(this._renderHub(h, T))
            frag.appendChild(wrap)
            host.textContent = ""
            host.appendChild(frag)
            return
        }

        const frag = document.createDocumentFragment()
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[3] + ";"

        const autoPricing = await this._renderAutoPricingPanel(ctx, T)
        if (!isCurrentRender()) return
        if (autoPricing) frag.appendChild(autoPricing)

        const ors = await this._loadOrsCoverage(hubs)
        if (!isCurrentRender()) return
        if (ors && ors.totalRoutes) frag.appendChild(this._renderOrsHealth(ors, T))

        for (const h of hubs.slice(0, 3)) {
            wrap.appendChild(this._renderHub(h, T))
        }
        frag.appendChild(wrap)

        if (hubs.length > 3) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (hubs.length - 3) + " more hubs cached."
            frag.appendChild(more)
        }
        host.textContent = ""
        host.appendChild(frag)
    }

    _autoPricingHost(ctx) {
        return {
            server:  ctx && ctx.server || "",
            airline: ctx && ctx.airline || ""
        }
    }

    _autoPricingFollowMode() {
        return this._autoPricingFollow || null
    }

    async _autoPricingPreview(ctx) {
        if (!window.AesRoutePriceAutomator
                || typeof window.AesRoutePriceAutomator.preview !== "function") {
            return null
        }
        const opts = {limit: 75}
        if (this._autoPricingFollowMode()) opts.followMode = this._autoPricingFollowMode()
        return await window.AesRoutePriceAutomator.preview(this._autoPricingHost(ctx), opts)
    }

    async _renderAutoPricingPanel(ctx, T) {
        const box = document.createElement("div")
        box.className = "aes-auto-pricing-panel"
        box.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + T.color.bone2,
            "padding:" + T.sp[3],
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[2],
            "font-family:" + T.font.display,
            "color:" + T.color.oxide,
            "min-width:0"
        ].join(";")

        const head = document.createElement("div")
        head.style.cssText = [
            "display:flex",
            "align-items:flex-start",
            "justify-content:space-between",
            "gap:" + T.sp[2],
            "flex-wrap:wrap"
        ].join(";")
        const title = document.createElement("div")
        title.style.cssText = "font-weight:" + T.fw.display + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
        title.textContent = "Auto pricing"
        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;align-items:center;gap:" + T.sp[2] + ";flex-wrap:wrap;"
        head.append(title, actions)
        box.appendChild(head)

        if (!window.AesRoutePriceAutomator) {
            this._renderEmptyState(box, "Dashboard price automator is not loaded on this page.")
            return box
        }

        let preview = null
        try {
            preview = await this._autoPricingPreview(ctx)
        } catch (e) {
            const err = document.createElement("p")
            err.style.cssText = "margin:0;color:" + T.color.crimson + ";"
            err.textContent = "Preview failed: " + (e && e.message || String(e))
            box.appendChild(err)
            return box
        }
        this._lastAutoPricingPreview = preview

        const state = preview && preview.state || {}
        const counts = preview && preview.counts || {}
        const status = document.createElement("div")
        status.style.cssText = [
            "display:flex",
            "gap:" + T.sp[1],
            "flex-wrap:wrap",
            "align-items:center",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono
        ].join(";")
        status.append(
            this._signalChip(state.liveWrites ? "live gate" : "dry-run gate", state.liveWrites ? "warn" : "ok", T),
            this._signalChip((state.strategy || "per-class-elasticity"), "muted", T),
            this._signalChip((state.followMode || "watchlist"), "muted", T),
            this._signalChip((counts.proposed || 0) + " proposed", counts.proposed ? "ok" : "muted", T),
            this._signalChip((counts.cooldownBlocked || 0) + " cooldown", counts.cooldownBlocked ? "warn" : "muted", T),
            this._signalChip((counts.capBlocked || 0) + " capped", counts.capBlocked ? "warn" : "muted", T),
            this._signalChip((counts.withOwnPricing || 0) + " priced", counts.withOwnPricing ? "ok" : "muted", T),
            this._signalChip((counts.withOrs || 0) + " ORS", counts.withOrs ? "ok" : "muted", T),
            this._signalChip((counts.withActiveFlights || 0) + " in-air", counts.withActiveFlights ? "warn" : "muted", T),
            this._signalChip((counts.withYieldHistory || 0) + " history", counts.withYieldHistory ? "ok" : "muted", T)
        )
        box.appendChild(status)

        const follow = document.createElement("select")
        follow.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body
        ].join(";")
        for (const opt of [
            {value: "", label: "Saved scope"},
            {value: "watchlist", label: "Watchlist"},
            {value: "all", label: "All cached"}
        ]) {
            const el = document.createElement("option")
            el.value = opt.value
            el.textContent = opt.label
            if ((this._autoPricingFollow || "") === opt.value) el.selected = true
            follow.appendChild(el)
        }
        follow.addEventListener("change", () => {
            this._autoPricingFollow = follow.value || null
            this._renderBodySafe()
        })
        actions.appendChild(follow)

        const refreshBtn = this._autoPricingButton("Preview", T, false)
        refreshBtn.addEventListener("click", () => this._renderBodySafe())
        actions.appendChild(refreshBtn)

        const dryRunBtn = this._autoPricingButton("Dry-run tick", T, true)
        dryRunBtn.disabled = !!this._autoPricingBusy
        dryRunBtn.addEventListener("click", () => this._runAutoPricingTick(ctx, {forceDryRun: true}))
        actions.appendChild(dryRunBtn)

        const gatedBtn = this._autoPricingButton(state.liveWrites ? "Run live gate" : "Run gate", T, false)
        gatedBtn.disabled = !!this._autoPricingBusy
        gatedBtn.addEventListener("click", () => {
            if (state.liveWrites && !window.confirm("Run a live silent-auto pricing tick with the current write gate?")) return
            this._runAutoPricingTick(ctx, {forceDryRun: false})
        })
        actions.appendChild(gatedBtn)

        if (this._autoPricingBusy) {
            const busy = document.createElement("p")
            busy.className = "aes-auto-pricing-busy"
            busy.style.cssText = "margin:0;color:" + T.color.slate + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
            busy.textContent = "pricing tick running..."
            box.appendChild(busy)
        }

        if (this._lastAutoPricingTick) {
            box.appendChild(this._renderAutoPricingTickResult(this._lastAutoPricingTick, T))
        }

        const rows = this._autoPricingDisplayRows(preview)
        if (!rows.length) {
            this._renderEmptyState(box, "No cached route pricing inputs available yet.")
            return box
        }
        const list = document.createElement("div")
        list.className = "aes-auto-pricing-list"
        list.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
        for (const row of rows) list.appendChild(this._renderAutoPricingRow(row, T))
        box.appendChild(list)
        return box
    }

    _autoPricingDisplayRows(preview) {
        const rows = ((preview && preview.rows) || []).slice()
        const byPair = new Map()
        const addRows = (candidates, limit) => {
            for (const row of candidates) {
                if (!row || !row.pair || byPair.has(row.pair)) continue
                byPair.set(row.pair, row)
                if (byPair.size >= limit) return
            }
        }
        const alpha = (a, b) => String(a.pair || "").localeCompare(String(b.pair || ""))
        const proposed = rows.filter(r => r.stage === "proposed").sort(alpha)
        const cooldown = rows.filter(r => r.stage === "cooldown").sort(alpha)
        const cap = rows.filter(r => r.stage === "cap").sort(alpha)
        const active = rows.filter(r =>
            r.stage !== "proposed"
                && r.stage !== "cooldown"
                && r.stage !== "cap"
                && r.activeFlightControls
                && Number(r.activeFlightControls.inflight) > 0).sort(alpha)
        const rich = rows.filter(r =>
            r.stage !== "proposed"
                && r.stage !== "cooldown"
                && r.stage !== "cap"
                && !(r.activeFlightControls && Number(r.activeFlightControls.inflight) > 0)
                && r.pricingSignals
                && (r.pricingSignals.demand || r.pricingSignals.competition
                    || r.pricingSignals.ors || r.pricingSignals.history)).sort(alpha)
        const other = rows.filter(r => r.stage !== "proposed" && r.stage !== "cooldown" && r.stage !== "cap").sort(alpha)
        addRows(proposed, 4)
        addRows(active, 6)
        addRows(cooldown, 6)
        addRows(cap, 6)
        addRows(proposed, 6)
        addRows(rich, 6)
        addRows(other, 6)
        return Array.from(byPair.values()).slice(0, 6)
    }

    async _runAutoPricingTick(ctx, opts) {
        if (!window.AesRoutePriceAutomator
                || typeof window.AesRoutePriceAutomator.runTick !== "function") return
        if (this._autoPricingBusy) return
        this._autoPricingBusy = true
        await this._renderBodySafe()
        try {
            const runOpts = {
                force: true,
                maxRoutes: 5,
                limit: 75
            }
            if (this._autoPricingFollowMode()) runOpts.followMode = this._autoPricingFollowMode()
            if (opts && opts.forceDryRun) runOpts.forceDryRun = true
            this._lastAutoPricingTick = await window.AesRoutePriceAutomator.runTick(this._autoPricingHost(ctx), runOpts)
        } catch (e) {
            this._lastAutoPricingTick = {
                ranAt: Date.now(),
                dryRun: !!(opts && opts.forceDryRun),
                applied: 0,
                proposed: 0,
                blocked: 0,
                perRoute: [],
                error: {code: "uiTickThrew", message: String(e && e.message || e)}
            }
        } finally {
            this._autoPricingBusy = false
            this._patchAutoPricingTickResultInline()
            this.refresh()
        }
    }

    _patchAutoPricingTickResultInline() {
        if (!this.bodyEl || !this._lastAutoPricingTick) return
        const T = window.AESTokens
        const panel = this.bodyEl.querySelector(".aes-auto-pricing-panel")
        if (!panel) return
        const busy = panel.querySelector(".aes-auto-pricing-busy")
        if (busy) busy.remove()
        const existing = panel.querySelector(".aes-auto-pricing-tick-result")
        if (existing) existing.remove()
        const resultEl = this._renderAutoPricingTickResult(this._lastAutoPricingTick, T)
        const list = panel.querySelector(".aes-auto-pricing-list")
        if (list) panel.insertBefore(resultEl, list)
        else panel.appendChild(resultEl)
    }

    _renderAutoPricingTickResult(result, T) {
        const wrap = document.createElement("div")
        wrap.className = "aes-auto-pricing-tick-result"
        const tone = result && result.error ? T.color.amber : T.color.moss
        wrap.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + tone,
            "background:" + (result && result.error ? T.color.amberSoft : T.color.bone),
            "padding:" + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide
        ].join(";")
        const bits = [
            result && result.dryRun ? "dry-run" : "gate",
            "eligible " + ((result && result.eligible) || 0),
            "proposed " + ((result && result.proposed) || 0),
            (result && result.dryRun ? "simulated " : "applied ")
                + ((result && result.dryRun && result.simulated != null)
                    ? result.simulated
                    : ((result && result.applied) || 0)),
            "blocked " + ((result && result.blocked) || 0)
        ]
        if (result && result.error) bits.push(result.error.code + ": " + result.error.message)
        wrap.textContent = bits.join(" · ")
        return wrap
    }

    _renderAutoPricingRow(row, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + (row.stage === "proposed" ? T.color.moss : T.color.paperRule),
            "background:" + T.color.bone,
            "padding:" + T.sp[2],
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[1],
            "min-width:0"
        ].join(";")
        const top = document.createElement("div")
        top.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:" + T.sp[2] + ";flex-wrap:wrap;"
        const name = document.createElement("div")
        name.style.cssText = "font-weight:" + T.fw.display + ";font-family:" + T.font.mono + ";letter-spacing:" + T.track.mono + ";"
        name.textContent = row.pair || ((row.hub || "") + "-" + (row.dest || ""))
        const stageLabel = row.stage === "proposed" ? "proposal"
            : row.stage === "cooldown" ? "cooldown"
            : row.stage === "cap" ? "cap"
            : "skip"
        const stageTone = row.stage === "proposed" ? "ok"
            : row.stage === "cooldown" ? "warn"
            : row.stage === "cap" ? "warn"
            : "muted"
        const stage = this._signalChip(stageLabel, stageTone, T)
        top.append(name, stage)
        wrap.appendChild(top)

        const summary = document.createElement("div")
        summary.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.mono + ";color:" + T.color.oxide2 + ";"
        summary.textContent = this._autoPricingPriceSummary(row)
        wrap.appendChild(summary)

        const chips = document.createElement("div")
        chips.style.cssText = "display:flex;gap:" + T.sp[1] + ";flex-wrap:wrap;"
        const labels = row.pricingSignals && row.pricingSignals.labels || []
        for (const label of labels) chips.appendChild(this._signalChip(label, "muted", T))
        if (row.activeFlightControls && row.activeFlightControls.inflight) {
            const cm5 = row.activeFlightControls.avgCm5
            chips.appendChild(this._signalChip(
                "in-air " + row.activeFlightControls.inflight + (cm5 != null ? " CM5 " + Math.round(cm5) : ""),
                cm5 != null && cm5 < 0 ? "warn" : "ok",
                T
            ))
            if (row.activeFlightControls.sourcePairs && row.activeFlightControls.sourcePairs.length) {
                chips.appendChild(this._signalChip(row.activeFlightControls.sourcePairs[0], "muted", T))
            }
        }
        const cv = row.controlVariables || {}
        if (cv.classScore != null) chips.appendChild(this._signalChip("demand " + cv.classScore, "muted", T))
        if (cv.rankAny != null) chips.appendChild(this._signalChip("ORS #" + Math.round(cv.rankAny), cv.orsWeak ? "warn" : "ok", T))
        if (cv.historyLatestProfitPerFlight != null) {
            chips.appendChild(this._signalChip("yield " + Math.round(cv.historyLatestProfitPerFlight), cv.historyWeak ? "warn" : "ok", T))
        }
        wrap.appendChild(chips)

        const reason = document.createElement("div")
        reason.style.cssText = "font-size:" + T.fs.body + ";color:" + T.color.slate + ";"
        reason.textContent = row.reason || ""
        wrap.appendChild(reason)
        return wrap
    }

    _autoPricingPriceSummary(row) {
        const prev = row && row.prices || {}
        const next = row && row.proposal && row.proposal.prices || {}
        const parts = []
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const p = prev[cls]
            const n = next[cls]
            if (p == null && n == null) continue
            parts.push(cls + " " + this._formatClassPrice(cls, p)
                + (n != null ? "→" + this._formatClassPrice(cls, n) : ""))
        }
        return parts.length ? parts.join(" · ") : "no cached prices"
    }

    _formatClassPrice(cls, value) {
        const n = Number(value)
        if (!isFinite(n)) return "—"
        if (cls === "Cargo" && Math.abs(n) < 10) {
            return (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "")
        }
        return String(Math.round(n))
    }

    _signalChip(label, tone, T) {
        const chip = document.createElement("span")
        const color = tone === "ok" ? T.color.moss
            : tone === "warn" ? T.color.amber
            : T.color.slate
        chip.textContent = label
        chip.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "border:" + T.geom.bw1 + " solid " + color,
            "color:" + color,
            "background:" + T.color.bone,
            "padding:1px " + T.sp[1],
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "white-space:nowrap"
        ].join(";")
        return chip
    }

    _autoPricingButton(label, T, primary) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = label
        btn.style.cssText = [
            "background:" + (primary ? T.color.oxide : "transparent"),
            "color:" + (primary ? T.color.bone : T.color.oxide),
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";")
        return btn
    }

    _collectRoutes(hubs) {
        const out = []
        for (const h of hubs || []) {
            const hub = h && h.hub
            for (const row of (h && h.record && h.record.rows) || []) {
                const dest = row && (row.destIata || row.dest)
                if (!hub || !dest) continue
                out.push(Object.assign({}, row, {hub, dest}))
            }
        }
        return out
    }

    async _loadOrsCoverage(hubs) {
        if (typeof window.RouteAssistantOrsIntelligence === "undefined") return null
        try {
            const routes = this._collectRoutes(hubs)
            if (!routes.length) return null
            let settings = null
            try {
                const got = await chrome.storage.local.get(["settings"])
                settings = got && got.settings && got.settings.routeAssistant || null
            } catch (_) { settings = null }
            const svc = new window.RouteAssistantOrsIntelligence(this.ctx && this.ctx.server)
            return await svc.getCoverage(routes, {writeHealth: false, settings})
        } catch (e) {
            return null
        }
    }

    _renderOrsHealth(ors, T) {
        const box = document.createElement("div")
        const activeBreaker = ors.breaker && ors.breaker.active
        box.style.cssText = "border:" + T.geom.bw1 + " solid "
            + (activeBreaker ? T.color.amber : T.color.paperRule)
            + ";background:" + (activeBreaker ? T.color.amberSoft : T.color.bone2)
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.body + ";color:" + T.color.oxide + ";"
        const missing = (ors.missingRoutes && ors.missingRoutes.length) || 0
        const stale = (ors.staleRoutes && ors.staleRoutes.length) || 0
        const warnings = (ors.warningRoutes && ors.warningRoutes.length) || 0
        box.textContent = "ORS readiness: " + ors.coveragePct + "% covered"
            + " · " + stale + " stale"
            + " · " + missing + " missing"
            + (warnings ? " · " + warnings + " warnings" : "")
            + (activeBreaker ? " · cooldown " + Math.ceil(ors.breaker.remainingMs / 60000) + "m" : "")
            + " · " + (ors.nextAction || "healthy")
        return box
    }

    /**
     * Walks every persisted alert-rule record (legacy + acct-namespaced) and
     * collects the route-keys (`<HUB>-<DEST>`) whose lastFiredByRoute
     * timestamp lands in the trailing 24 h.
     */
    async _loadFiredAlertRoutes() {
        const entries = await this._loadByPrefix("routeAssistant:alertRules", {includeExactKey: true})
        const cutoff = Date.now() - 24 * 3600 * 1000
        const fired = new Set()
        for (const e of entries) {
            const rec = e.value
            if (!rec || !Array.isArray(rec.rules)) continue
            for (const rule of rec.rules) {
                if (!rule || rule.enabled === false) continue
                const map = rule.lastFiredByRoute
                if (!map || typeof map !== "object") continue
                for (const route in map) {
                    const t = Number(map[route])
                    if (Number.isFinite(t) && t >= cutoff) fired.add(route)
                }
            }
        }
        return fired
    }

    _renderFilterBanner(count, T) {
        const banner = document.createElement("div")
        banner.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "margin-bottom:" + T.sp[2],
            "background:" + T.color.amberSoft,
            "color:" + T.color.amber,
            "border:" + T.geom.bw1 + " solid " + T.color.amber,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body
        ].join(";")
        const label = document.createElement("span")
        label.textContent = count + " alert" + (count === 1 ? "" : "s")
            + " fired in the last 24 h"
        const clear = document.createElement("button")
        clear.type = "button"
        clear.textContent = "× show all routes"
        clear.style.cssText = "background:transparent;color:" + T.color.amber
            + ";border:" + T.geom.bw1 + " solid " + T.color.amber + ";border-radius:" + T.geom.radius
            + ";padding:" + T.sp[0] + " " + T.sp[2] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        clear.addEventListener("click", () => {
            this._filter = null
            this._renderBodySafe()
        })
        banner.append(label, clear)
        return banner
    }

    _renderHub(hubInfo, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";background:" + T.color.bone2 + ";"

        const heading = document.createElement("div")
        heading.style.cssText = [
            "display:flex",
            "justify-content:space-between",
            "align-items:baseline",
            "margin-bottom:" + T.sp[1],
            "font-family:" + T.font.display
        ].join(";")
        const hubName = document.createElement("span")
        hubName.style.cssText = "font-weight:" + T.fw.display + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;color:" + T.color.oxide + ";"
        hubName.textContent = hubInfo.hub
        const link = document.createElement("a")
        const scheduleTarget = this._scheduleTargetForHub(hubInfo) || hubInfo.hub
        link.href = "/app/com/scheduling/" + encodeURIComponent(scheduleTarget)
        link.textContent = "Open scheduling →"
        link.style.cssText = "color:" + T.color.rust + ";font-size:" + T.fs.body + ";text-decoration:none;"
        heading.append(hubName, link)
        wrap.appendChild(heading)

        const rows = (hubInfo.record.rows || []).slice(0, 5)
        if (!rows.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Snapshot has no rows."
            wrap.appendChild(empty)
            return wrap
        }

        // CB3 — branch to polyhedral cards when cubist mode is active.
        if (CentralHubRouteAssistantTile._isCubist()) {
            wrap.appendChild(this._renderRoutePolyhedronGrid(rows, hubInfo, T))
            return wrap
        }

        const list = document.createElement("ol")
        list.style.cssText = "margin:0;padding:0 0 0 " + T.sp[4] + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.body + ";letter-spacing:" + T.track.mono + ";"
        for (const r of rows) {
            const li = document.createElement("li")
            const dest = r.destIata || r.dest || "?"
            const score = (r.score != null) ? Math.round(r.score) : "—"
            const flights = r.flights || r.weeklyFlights || ""
            li.textContent = dest + " · score " + score + (flights ? " · " + flights + "/wk" : "")
            li.style.color = T.color.oxide2
            li.style.cursor = "pointer"
            li.addEventListener("mouseenter", () => { li.style.color = T.color.rust })
            li.addEventListener("mouseleave", () => { li.style.color = T.color.oxide2 })
            li.addEventListener("click", () => {
                if (!window.CentralHubBus) return
                const payload = {hub: hubInfo.hub, dest, source: "route-assistant"}
                window.CentralHubBus.emit("focus-route", payload)
                window.CentralHubBus.emit("open-tile", {
                    tileId: "inventory",
                    expand: true, scrollIntoView: true,
                    filter: {type: "single-route", hub: hubInfo.hub, dest},
                    source: "route-assistant"
                })
            })
            list.appendChild(li)
        }
        wrap.appendChild(list)
        return wrap
    }

    // ── CB3 — Polyhedral route cards ─────────────────────────────────────
    //
    // Replaces the orthogonal <ol> with a grid of hexagonal polyhedra. Each
    // route becomes a 6-facet card: demand (wedge-tl), profit (trapezoid-t),
    // ORS (wedge-tr), competitor (wedge-bl), pax-mix (trapezoid-b), schedule
    // (wedge-br). Hover dims adjacent facets via cubist.css; click any facet
    // emits focus-route + open-tile (inventory) on the bus, identical to the
    // orthogonal-mode click target.
    //
    // Reuses only fields already present on `topRoutes:<HUB>` rows. No extra
    // storage reads — perf safe at the 3-hubs × 5-routes density the tile
    // exposes (15 polyhedra × 6 facets = 90 clip-pathed nodes per render).

    static _isCubist() {
        try {
            return typeof document !== "undefined"
                && document.body && document.body.classList
                && document.body.classList.contains("aes-cubist")
                && !!window.AESCubistPrimitives
        } catch (_) { return false }
    }

    _renderRoutePolyhedronGrid(rows, hubInfo, T) {
        const grid = document.createElement("div")
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(auto-fill, minmax(200px, 1fr))",
            "gap:" + T.sp[2],
            "margin-top:" + T.sp[1]
        ].join(";")
        for (const r of rows) {
            grid.appendChild(this._renderRoutePolyhedron(r, hubInfo, T))
        }
        return grid
    }

    _renderRoutePolyhedron(row, hubInfo, T) {
        const P = window.AESCubistPrimitives
        const dest = row.destIata || row.dest || "?"
        const onClick = () => {
            if (!window.CentralHubBus) return
            const payload = {hub: hubInfo.hub, dest, source: "route-assistant"}
            window.CentralHubBus.emit("focus-route", payload)
            window.CentralHubBus.emit("open-tile", {
                tileId: "inventory",
                expand: true, scrollIntoView: true,
                filter: {type: "single-route", hub: hubInfo.hub, dest},
                source: "route-assistant"
            })
        }

        const facets = [
            this._buildDemandFacet(row, T),
            this._buildProfitFacet(row, dest, T),
            this._buildOrsFacet(row, T),
            this._buildCompetitorFacet(row, T),
            this._buildPaxMixFacet(row, T),
            this._buildScheduleFacet(row, T)
        ]
        for (const f of facets) {
            f.style.cursor = "pointer"
            f.addEventListener("click", (e) => { e.preventDefault(); onClick() })
        }

        const poly = P.Polyhedron({
            entity: "route:" + hubInfo.hub + "-" + dest,
            facets: facets,
            pivot: true,
            density: "compact",
            layout: "repeat(2, minmax(48px, auto)) / repeat(3, 1fr)"
        })
        poly.style.cssText += [
            ";gap:" + T.geom.bw1,
            "background:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "min-height:120px"
        ].join(";")
        return poly
    }

    _buildDemandFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-start")
        inner.appendChild(P.Stencil({text: "Demand"}))
        const score = Number(row.paxScore ?? row.score)
        const filled = Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score))) : 0
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;gap:1px;width:100%;margin-top:" + T.sp[1]
        for (let i = 0; i < 10; i++) {
            const cell = document.createElement("span")
            cell.style.cssText = "flex:1 1 0;height:6px;background:"
                + (i < filled ? T.color.cobalt : T.color.bone3)
            bar.appendChild(cell)
        }
        inner.appendChild(bar)
        return this._frameFacet(P.Facet({
            shape: "wedge-tl", perspective: "demand", content: inner
        }), T)
    }

    _buildProfitFacet(row, dest, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "center")
        const destLabel = document.createElement("div")
        destLabel.textContent = dest
        destLabel.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide,
            "line-height:" + T.lh.tight
        ].join(";")
        const profit = Number(row.profitPerWeek)
        const profitEl = document.createElement("div")
        if (Number.isFinite(profit)) {
            const sign = profit >= 0 ? "" : "-"
            const abs = Math.abs(profit)
            const compact = abs >= 1e9 ? (abs / 1e9).toFixed(2) + "B"
                : abs >= 1e6 ? (abs / 1e6).toFixed(2) + "M"
                : abs >= 1e3 ? (abs / 1e3).toFixed(1) + "k"
                : Math.round(abs)
            profitEl.textContent = sign + "$" + compact + "/wk"
            profitEl.style.color = profit >= 0 ? T.color.moss : T.color.crimson
        } else {
            profitEl.textContent = "— /wk"
            profitEl.style.color = T.color.slate
        }
        profitEl.style.cssText += [
            ";font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono
        ].join(";")
        inner.append(destLabel, profitEl)
        return this._frameFacet(P.Facet({
            shape: "trapezoid-t", perspective: "profit", content: inner
        }), T, /*emphasis*/ true)
    }

    _buildOrsFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-end")
        inner.appendChild(P.Stencil({text: "ORS"}))
        const rank = row.orsRank ?? row.rankAny
        const value = document.createElement("div")
        value.textContent = (rank == null) ? "—" : "#" + Math.round(Number(rank))
        const rankColor = !Number.isFinite(Number(rank)) ? T.color.slate
            : Number(rank) <= 2 ? T.color.moss
            : Number(rank) <= 4 ? T.color.amber
            : T.color.crimson
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + rankColor,
            "margin-top:" + T.sp[1]
        ].join(";")
        inner.appendChild(value)
        return this._frameFacet(P.Facet({
            shape: "wedge-tr", perspective: "ors", content: inner
        }), T)
    }

    _buildCompetitorFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-start")
        inner.appendChild(P.Stencil({text: "Cmpt"}))
        const count = Number(row.competitors ?? row.competitorCount ?? row.cmpCount)
        const value = document.createElement("div")
        value.textContent = Number.isFinite(count) ? String(count) : "—"
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide
        ].join(";")
        const dots = document.createElement("div")
        dots.style.cssText = "display:flex;gap:2px;margin-top:" + T.sp[1] + ";flex-wrap:wrap"
        const drawDots = Number.isFinite(count) ? Math.min(count, 8) : 0
        for (let i = 0; i < drawDots; i++) {
            const dot = document.createElement("span")
            dot.style.cssText = "width:5px;height:5px;background:" + T.color.rust
                + ";display:inline-block"
            dots.appendChild(dot)
        }
        inner.append(value, dots)
        return this._frameFacet(P.Facet({
            shape: "wedge-bl", perspective: "competitors", content: inner
        }), T)
    }

    _buildPaxMixFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "center")
        inner.appendChild(P.Stencil({text: "Pax mix"}))
        // Y/C/F slivers as diagonal stripes — width-weighted by mix percent.
        const y = Number(row.yShare ?? row.paxShareY)
        const c = Number(row.cShare ?? row.paxShareC)
        const f = Number(row.fShare ?? row.paxShareF)
        const known = [y, c, f].some(v => Number.isFinite(v))
        const stripes = document.createElement("div")
        stripes.style.cssText = "display:flex;width:100%;height:10px;margin-top:" + T.sp[1]
        if (known) {
            const total = (Number.isFinite(y) ? y : 0)
                + (Number.isFinite(c) ? c : 0)
                + (Number.isFinite(f) ? f : 0)
            const mk = (frac, color) => {
                const s = document.createElement("span")
                const pct = total > 0 ? Math.max(0, frac / total * 100) : 0
                s.style.cssText = "flex:" + Math.max(0.001, pct).toFixed(2)
                    + " 0 0;background:" + color
                    + ";clip-path:polygon(8% 0, 100% 0, 92% 100%, 0 100%)"
                stripes.appendChild(s)
            }
            mk(Number.isFinite(y) ? y : 0, T.color.cobalt)
            mk(Number.isFinite(c) ? c : 0, T.color.amber)
            mk(Number.isFinite(f) ? f : 0, T.color.rust)
        } else {
            const note = document.createElement("span")
            note.textContent = "—"
            note.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono
                + ";font-size:" + T.fs.micro
            stripes.appendChild(note)
        }
        inner.appendChild(stripes)
        return this._frameFacet(P.Facet({
            shape: "trapezoid-b", perspective: "pax-mix", content: inner
        }), T)
    }

    _buildScheduleFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-end")
        inner.appendChild(P.Stencil({text: "Sched"}))
        const flights = Number(row.flights ?? row.weeklyFlights)
        const value = document.createElement("div")
        value.textContent = Number.isFinite(flights) ? flights + "×" : "—"
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide
        ].join(";")
        // Mini radial sweep — quarter arc with N tick marks for flights/wk.
        const arc = document.createElement("div")
        arc.style.cssText = "position:relative;width:100%;height:14px;margin-top:" + T.sp[1]
            + ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
        const ticks = Number.isFinite(flights) ? Math.min(flights, 14) : 0
        for (let i = 0; i < ticks; i++) {
            const t = document.createElement("span")
            t.style.cssText = "position:absolute;left:" + ((i + 0.5) / 14 * 100) + "%"
                + ";bottom:0;width:1px;height:" + (4 + (i % 3) * 2) + "px"
                + ";background:" + T.color.viridian
            arc.appendChild(t)
        }
        inner.append(value, arc)
        return this._frameFacet(P.Facet({
            shape: "wedge-br", perspective: "schedule", content: inner
        }), T)
    }

    _facetInnerCss(T, justify) {
        return [
            "display:flex",
            "flex-direction:column",
            "justify-content:" + (justify || "flex-start"),
            "gap:2px",
            "padding:" + T.sp[2],
            "min-height:48px",
            "box-sizing:border-box",
            "width:100%"
        ].join(";")
    }

    _frameFacet(facet, T, emphasis) {
        facet.style.cssText += [
            ";background:" + (emphasis ? T.color.bone : T.color.bone2),
            "color:" + T.color.oxide
        ].join(";")
        return facet
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "route-assistant",
        section: "routes",
        priority: 10,
        factory: () => new CentralHubRouteAssistantTile()
    })
}
