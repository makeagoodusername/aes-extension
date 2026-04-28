"use strict"

/**
 * Strategy tile — entry point to the AES Strategy preview/apply modal.
 *
 * Reads `aesStrategy:plan:applied` to surface the most recent applied
 * plan's summary; loads a fresh `Snapshot` + `FleetPlan` on body expand
 * to show what the engine would propose right now without the user
 * having to open the full modal first.
 *
 * The Open button launches `AesStrategyPanel.open()` directly rather
 * than navigating — the panel mounts in-page on the dashboard.
 */
class CentralHubStrategyTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "strategy"
        this.title = "Strategy"
        this.section = "tools"
        this.priority = 5
        this.requiresAirline = false
    }

    watchedStorageKeys() {
        return [
            "aesStrategy:plan:applied",
            "aesStrategy:audit",
            "aesStrategy:learn:outcomes",
            "aesStrategy:learn:weights:current",
            "settings"
        ]
    }

    /**
     * Storage writes from a strategy apply land via `chrome.storage.set`,
     * which the base class's storage listener picks up — but storage
     * notifications can arrive batched / debounced. The bus event fires
     * synchronously per applied decision, so the tile re-renders within
     * the same task as the apply. `subscribeBus` auto-disposes through
     * `_busDisposers` on the base class's `dispose()`.
     */
    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this.subscribeBus("strategy:decision-applied", () => {
            this.refresh().catch(err =>
                console.warn("[AES strategy tile] bus refresh failed", err))
        })
    }

    openHandler() {
        return () => {
            try {
                if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                    window.AesStrategyPanel.open()
                } else {
                    console.warn("[AES strategy tile] AesStrategyPanel not loaded")
                }
            } catch (e) {
                console.warn("[AES strategy tile] open threw", e)
            }
        }
    }

    async _loadApplied() {
        // Multi-account: prefer the per-account scoped record (Slice 11
        // scoping in apply-pipeline.js). Falls back to the legacy global
        // key for installs that haven't applied since the rollout, or
        // when the registry hasn't bootstrapped yet on this page.
        try {
            if (window.AesStrategy && typeof window.AesStrategy.getApplied === "function") {
                const id = (typeof window !== "undefined" && window.__aesAccountId) || null
                const rec = await window.AesStrategy.getApplied(id)
                if (rec) return rec
            }
            const data = await chrome.storage.local.get(["aesStrategy:plan:applied"])
            return data["aesStrategy:plan:applied"] || null
        } catch (_) { return null }
    }

    async _loadSettings() {
        if (window.AesStrategySettings && typeof window.AesStrategySettings.load === "function") {
            try { return await window.AesStrategySettings.load() }
            catch (_) { /* fall through */ }
        }
        return null
    }

    async loadStatus() {
        const T = window.AESTokens
        const KIND = window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND

        if (!window.AesStrategy) {
            return {badge: "OFF", badgeKind: KIND ? KIND.MUTED : "muted",
                    summary: "AesStrategy not loaded — open /app/enterprise/dashboard or /app/fleets/* to mount."}
        }

        const settings = await this._loadSettings()
        const tier = settings ? settings.tier : "preview-only"
        const applied = await this._loadApplied()

        const goalKind = (settings && settings.objective && settings.objective.kind) || "balanced"
        const GOAL_SHORT = {maxShare: "share", maxProfit: "profit", balanced: "balanced", custom: "custom"}
        if (!applied) {
            const tone = tier === "preview-only" ? (KIND ? KIND.MUTED : "muted") : (KIND ? KIND.OK : "ok")
            return {
                badge:     "TIER " + (tier || "?").toUpperCase(),
                badgeKind: tone,
                summary:   "No plan applied yet. Goal · " + (GOAL_SHORT[goalKind] || goalKind)
                            + ". Open the modal to compose, review, and (when tier permits) apply."
            }
        }

        const ts = applied.ts ? new Date(applied.ts).toISOString().substring(0, 16).replace("T", " ") : "?"
        const r = applied.applyReport || {}
        const totals = r.totals || {ok: 0, failed: 0, skipped: 0}
        const tone = (r.aborted || totals.failed) ? (KIND ? KIND.WARN : "warn") : (KIND ? KIND.OK : "ok")
        return {
            badge:     totals.ok + " OK · " + totals.failed + " ERR",
            badgeKind: tone,
            summary:   "Last apply " + ts + " · tier " + (r.tier || tier) + " · "
                          + totals.skipped + " skipped"
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""

        if (!window.AesStrategy) {
            host.appendChild(this._note(T, "AesStrategy not loaded on this page. Strategy mounts on the dashboard and on /app/fleets/* — try opening one of those."))
            return
        }

        // Settings strip
        const settings = await this._loadSettings()
        const tier = settings ? settings.tier : "preview-only"
        const applied = await this._loadApplied()

        host.appendChild(this._buildOpenCta(T))
        host.appendChild(this._buildSettingsStrip(T, settings, tier))
        if (applied && applied.applyReport) {
            host.appendChild(this._buildLastApplyCard(T, applied))
        }
        const learningCard = await this._buildLearningCard(T, settings)
        if (learningCard) host.appendChild(learningCard)

        // Multi-account portfolio — only shown when 2+ servers have
        // cached strategy inputs. Read-only summary; cross-server applies
        // are gated behind the modal's per-server picker (Slice 11/18).
        const portfolioCard = await this._buildPortfolioCard(T)
        if (portfolioCard) host.appendChild(portfolioCard)

        const crossAirCard = await this._buildCrossAirlineOpsCard(T, settings)
        if (crossAirCard) host.appendChild(crossAirCard)

        // Live preview button — composes a plan inline without opening the
        // modal so the user gets a quick "what would the engine do right
        // now" without a full screen interrupt.
        const inlineCard = document.createElement("div")
        inlineCard.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";margin-top:" + T.sp[3]
            + ";background:" + T.color.bone2 + ";"
        const inlineHead = document.createElement("div")
        inlineHead.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:" + T.sp[2] + ";"
        const inlineTitle = document.createElement("strong")
        inlineTitle.textContent = "Quick plan preview"
        inlineTitle.style.cssText = "color:" + T.color.oxide + ";font-family:" + T.font.display + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";font-size:" + T.fs.body + ";"
        const composeBtn = this._smallBtn(T, "Compose")
        composeBtn.addEventListener("click", () => this._renderInlinePlan(T, inlineCard, composeBtn))
        inlineHead.append(inlineTitle, composeBtn)
        inlineCard.appendChild(inlineHead)
        const inlineBody = document.createElement("div")
        inlineBody.dataset.role = "inline-plan"
        inlineBody.style.cssText = "color:" + T.color.slate + ";font-style:italic;font-size:" + T.fs.body + ";"
        inlineBody.textContent = "Click Compose to load snapshot + plan."
        inlineCard.appendChild(inlineBody)
        host.appendChild(inlineCard)
    }

    async _renderInlinePlan(T, card, btn) {
        const body = card.querySelector('[data-role="inline-plan"]')
        if (!body) return
        const oldLabel = btn.textContent
        btn.disabled = true
        btn.textContent = "…"
        body.textContent = "Composing snapshot + plan…"
        body.style.fontStyle = "italic"
        body.style.color = T.color.slate
        try {
            const snap = await window.AesStrategy.snapshot({})
            let weights = null
            if (window.AesStrategyLearn && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
                try { weights = await window.AesStrategyLearn.getCurrentWeights() } catch (_) { weights = null }
            }
            const scored = window.AesStrategy.scoreRoutes(snap, weights || undefined)
            const plan = window.AesStrategy.allocateFleet(snap, scored, {})
            const diff = window.AesStrategy.diffPlan(plan, snap)
            body.textContent = ""
            body.style.fontStyle = "normal"
            body.style.color = T.color.oxide2

            const summary = (plan && plan.summary) || {}
            const profit = summary.predictedWeeklyProfit
            const ors    = summary.predictedOrsAvg

            const top = document.createElement("div")
            top.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[2] + ";"
            const chip = (label, val) => {
                const c = document.createElement("div")
                c.style.cssText = "display:flex;flex-direction:column;align-items:center;padding:" + T.sp[1] + " " + T.sp[2]
                    + ";background:" + T.color.bone + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
                const lbl = document.createElement("span")
                lbl.textContent = label
                lbl.style.cssText = "font:600 10px " + T.font.display + ";letter-spacing:" + T.track.caps
                    + ";text-transform:uppercase;color:" + T.color.slate + ";"
                const v = document.createElement("span")
                v.textContent = val
                v.style.cssText = "font:600 14px " + T.font.mono + ";color:" + T.color.oxide + ";"
                c.append(lbl, v)
                return c
            }
            top.appendChild(chip("Aircraft",      String((plan.perAircraft || []).length)))
            top.appendChild(chip("Schedules",     String(diff.summary.byKind.schedule || 0)))
            top.appendChild(chip("Pricing",       String(diff.summary.byKind.price    || 0)))
            top.appendChild(chip("Service",       String(diff.summary.byKind.service  || 0)))
            top.appendChild(chip("Crew",          String(diff.summary.byKind.crew     || 0)))
            top.appendChild(chip("New routes",    String(diff.summary.byKind.routeCreation || 0)))
            if (profit != null) top.appendChild(chip("Pred $/wk", "$" + Math.round(profit).toLocaleString()))
            if (ors != null)    top.appendChild(chip("Pred ORS",  Number(ors).toFixed(2)))
            body.appendChild(top)

            const cta = document.createElement("button")
            cta.type = "button"
            cta.textContent = "Open full modal →"
            cta.style.cssText = "background:" + T.color.rust + ";color:" + T.color.bone + ";"
                + "border:" + T.geom.bw1 + " solid " + T.color.rust + ";"
                + "border-radius:" + T.geom.radius + ";padding:" + T.sp[1] + " " + T.sp[3] + ";"
                + "font:600 11px " + T.font.display + ";letter-spacing:" + T.track.caps
                + ";text-transform:uppercase;cursor:pointer;"
            cta.addEventListener("click", () => {
                if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                    window.AesStrategyPanel.open({plan: plan, snapshot: snap, diff: diff})
                }
            })
            body.appendChild(cta)
        } catch (e) {
            body.style.color = T.color.rust
            body.textContent = "Compose failed: " + ((e && e.message) || String(e))
        } finally {
            btn.disabled = false
            btn.textContent = oldLabel
        }
    }

    _buildOpenCta(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-bottom:" + T.sp[2] + ";"
        const cta = document.createElement("button")
        cta.type = "button"
        cta.textContent = "Open strategy modal"
        cta.style.cssText = "background:" + T.color.oxide + ";color:" + T.color.bone + ";"
            + "border:" + T.geom.bw1 + " solid " + T.color.oxide + ";"
            + "border-radius:" + T.geom.radius + ";padding:" + T.sp[1] + " " + T.sp[3] + ";"
            + "font:600 12px " + T.font.display + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        cta.addEventListener("click", () => {
            if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                window.AesStrategyPanel.open()
            }
        })
        wrap.appendChild(cta)
        return wrap
    }

    _buildSettingsStrip(T, settings, tier) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";background:" + T.color.bone2 + ";"
        const head = document.createElement("strong")
        const goalKind = (settings && settings.objective && settings.objective.kind) || "balanced"
        const GOAL_LABEL = {maxShare: "Max share", maxProfit: "Max profit", balanced: "Balanced", custom: "Custom"}
        head.textContent = "Tier · " + (tier || "preview-only")
            + "   ·   Goal · " + (GOAL_LABEL[goalKind] || goalKind)
            + "   ·   Auto · " + (tier === "apply-auto" ? "on (S2)" : "off")
        head.style.cssText = "color:" + T.color.oxide + ";font:600 11px " + T.font.display
            + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
        wrap.appendChild(head)
        const note = document.createElement("p")
        note.style.cssText = "margin:" + T.sp[1] + " 0 0 0;color:" + T.color.slate + ";font-size:" + T.fs.body + ";"
        if (!settings) {
            note.textContent = "Strategy settings unavailable (default-settings.js not loaded?). Default tier = preview-only."
        } else if (tier === "preview-only") {
            note.textContent = "Preview-only — every actuator is blocked even if you tick decisions in the modal. Flip to apply-on-confirm + per-domain enable flags to allow real writes."
        } else if (tier === "apply-on-confirm") {
            note.textContent = "Apply-on-confirm — modal applies only the decisions you select. Per-domain flags must be ON for that decision's actuator to fire."
        } else {
            note.textContent = "APPLY-AUTO — silent loop will fire applicable decisions; S2 wires the loop. Today this tier behaves like apply-on-confirm."
        }
        wrap.appendChild(note)
        if (settings) {
            const flags = document.createElement("div")
            flags.style.cssText = "margin-top:" + T.sp[1] + ";display:flex;flex-wrap:wrap;gap:" + T.sp[2]
                + ";font:11px " + T.font.mono + ";color:" + T.color.slate + ";"
            const items = [
                ["Schedules", "scheduleApplyEnabled"],
                ["Service",   "serviceMovesEnabled"],
                ["Pricing",   "priceMovesEnabled"],
                ["Crew",      "crewMovesEnabled"],
                ["RouteCre",  "routeCreationEnabled"]
            ]
            for (const [label, key] of items) {
                const span = document.createElement("span")
                const on = !!settings[key]
                span.textContent = (on ? "● " : "○ ") + label
                span.style.color = on ? T.color.oxide : T.color.slate
                flags.appendChild(span)
            }
            wrap.appendChild(flags)
        }
        return wrap
    }

    _buildLastApplyCard(T, applied) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";margin-top:" + T.sp[3]
            + ";background:" + T.color.bone + ";"
        const head = document.createElement("strong")
        head.textContent = "Last apply"
        head.style.cssText = "color:" + T.color.oxide + ";font:600 11px " + T.font.display
            + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
        wrap.appendChild(head)

        const r = applied.applyReport || {}
        const t = r.totals || {}
        const ts = applied.ts ? new Date(applied.ts).toLocaleString() : "?"
        const list = document.createElement("ul")
        list.style.cssText = "margin:" + T.sp[1] + " 0 0 0;padding-left:" + T.sp[4] + ";color:"
            + T.color.oxide2 + ";font-size:" + T.fs.body + ";"
        const li = (txt) => { const e = document.createElement("li"); e.textContent = txt; list.appendChild(e) }
        li("Plan id · " + (applied.planId || "?"))
        li("Applied · " + ts)
        li("Tier · " + (r.tier || "?"))
        li("Outcomes · " + (t.ok || 0) + " ok · " + (t.failed || 0) + " failed · " + (t.skipped || 0) + " skipped")
        if (r.aborted) li("⚠ Aborted: " + (r.abortReason || "unknown"))
        wrap.appendChild(list)
        return wrap
    }

    /**
     * Slice 5 — closed-loop learning summary card. Renders nothing
     * (returns null) when neither outcomes.js nor learn.js is loaded so
     * the tile gracefully degrades on pages where those modules aren't
     * registered.
     */
    async _buildLearningCard(T, settings) {
        const hasOutcomes = !!window.AesStrategyOutcomes
        const hasLearn    = !!window.AesStrategyLearn
        if (!hasOutcomes && !hasLearn) return null

        const wrap = document.createElement("div")
        wrap.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";margin-top:" + T.sp[3]
            + ";background:" + T.color.bone + ";"

        const head = document.createElement("strong")
        head.textContent = "Learning"
        head.style.cssText = "color:" + T.color.oxide + ";font:600 11px " + T.font.display
            + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
        wrap.appendChild(head)

        const enabled = !!(settings && settings.learningEnabled)
        const stepLabel = settings && typeof settings.learningStepSize === "number"
            ? Number(settings.learningStepSize).toFixed(2) : "—"

        let counts = {recorded: 0, ready: 0, attributed: 0}
        if (hasOutcomes) {
            try { counts = await window.AesStrategyOutcomes.countReady() } catch (_) { /* keep zeros */ }
        }
        const summary = document.createElement("p")
        summary.style.cssText = "margin:" + T.sp[1] + " 0 0 0;color:" + T.color.oxide2
            + ";font:11px " + T.font.mono + ";"
        summary.textContent =
            counts.recorded + " outcome" + (counts.recorded === 1 ? "" : "s")
            + " · " + counts.attributed + " attributed"
            + " · " + counts.ready + " ready"
            + " · " + (enabled ? "enabled" : "paused")
            + " · step " + stepLabel
        wrap.appendChild(summary)

        if (hasLearn) {
            try {
                const history = await window.AesStrategyLearn.getHistory()
                if (history.length) {
                    const last = history[0]
                    const ts = last.ts ? new Date(last.ts).toLocaleString() : "?"
                    const tail = document.createElement("p")
                    tail.style.cssText = "margin:" + T.sp[1] + " 0 0 0;color:" + T.color.slate + ";font-size:11px;"
                    tail.textContent = "Last weight change · " + ts + " · " + (last.reason || "?")
                    wrap.appendChild(tail)
                }
            } catch (_) { /* ignore */ }
        }
        return wrap
    }

    /**
     * Multi-account portfolio card (Slice 11 — single game world,
     * Slice 18 — multi). Per (server, airline) row: fleet, cached
     * schedules, hub list, and last-scrape age. Renders nothing when
     * only one airline is known (single-account install) so the tile
     * stays focused on the current airline.
     *
     * Highlights the current page's airline so the user can spot it at
     * a glance amid the sister rows. Read-only — switching scope happens
     * in the modal, not from this card.
     */
    async _buildPortfolioCard(T) {
        if (!window.AesStrategyPortfolio || typeof window.AesStrategyPortfolio.scanAll !== "function") {
            return null
        }
        let byServer = new Map()
        try { byServer = await window.AesStrategyPortfolio.scanAll() } catch (_) { return null }

        // Flatten to a single row list with server context per row.
        const rows = []
        for (const [server, p] of byServer.entries()) {
            for (const a of (p.airlines || [])) {
                rows.push(Object.assign({server}, a, {
                    overlapHubs:  (p.overlapHubs || []).filter(h => h.airlines.indexOf(a.airline) >= 0).length,
                    overlapRoutes:(p.overlapRoutes || []).filter(r => r.airlines.indexOf(a.airline) >= 0).length
                }))
            }
        }
        if (rows.length < 2) return null

        let curServer = null, curAirline = null
        try {
            curServer  = (typeof AES !== "undefined" && AES.getServer)          ? AES.getServer()          : null
            curAirline = (typeof AES !== "undefined" && AES.getAirlineIdentity) ? AES.getAirlineIdentity() : null
        } catch (_) {}

        // Sort: current account first, then by server, then by fleet desc.
        rows.sort((a, b) => {
            const aHere = (a.server === curServer && (a.airline === curAirline || a.displayName === curAirline))
            const bHere = (b.server === curServer && (b.airline === curAirline || b.displayName === curAirline))
            if (aHere !== bHere) return aHere ? -1 : 1
            if (a.server !== b.server) return a.server < b.server ? -1 : 1
            return b.fleetCount - a.fleetCount
        })

        const wrap = document.createElement("div")
        wrap.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";margin-top:" + T.sp[3]
            + ";background:" + T.color.bone + ";"

        const serverCount = byServer.size
        const head = document.createElement("strong")
        head.textContent = "Portfolio · " + rows.length + " airline" + (rows.length === 1 ? "" : "s")
            + (serverCount > 1 ? " across " + serverCount + " servers" : "")
        head.style.cssText = "color:" + T.color.oxide + ";font:600 11px " + T.font.display
            + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
        wrap.appendChild(head)

        const note = document.createElement("p")
        note.style.cssText = "margin:" + T.sp[1] + " 0 0 0;color:" + T.color.slate + ";font-size:11px;"
        note.textContent = "Sister airlines on each server. Open the modal to switch scope; the engine never touches an airline you haven't picked."
        wrap.appendChild(note)

        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font:11px " + T.font.mono + ";color:" + T.color.oxide2
            + ";margin-top:" + T.sp[2] + ";"
        const thead = document.createElement("thead")
        const trh = document.createElement("tr")
        for (const h of ["Airline", "Server", "Fleet", "Schedules", "Hubs", "Overlap", "Last apply", "Last scrape"]) {
            const th = document.createElement("th")
            th.textContent = h
            th.style.cssText = "padding:3px 6px;text-align:left;color:" + T.color.slate
                + ";font:600 10px " + T.font.display + ";letter-spacing:" + T.track.caps
                + ";text-transform:uppercase;border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
            trh.appendChild(th)
        }
        thead.appendChild(trh)
        tbl.appendChild(thead)

        const tbody = document.createElement("tbody")
        for (const r of rows) {
            const tr = document.createElement("tr")
            const here = (r.server === curServer && (r.airline === curAirline || r.displayName === curAirline))
            const overlap = (r.overlapHubs ? "h:" + r.overlapHubs : "")
                + (r.overlapHubs && r.overlapRoutes ? " · " : "")
                + (r.overlapRoutes ? "r:" + r.overlapRoutes : "")
                || "—"
            const hubsLabel = (r.hubs && r.hubs.length)
                ? r.hubs.slice(0, 3).join(" ") + (r.hubs.length > 3 ? " +" + (r.hubs.length - 3) : "")
                : "—"
            const lastApply = r.lastApplied
                ? this._fmtAgo(r.lastApplied.ts) + " · "
                    + (r.lastApplied.aborted ? "aborted" : (r.lastApplied.ok + "ok/" + r.lastApplied.failed + "err"))
                    + (r.lastApplied.tier ? " · " + r.lastApplied.tier : "")
                : "—"
            const cells = [
                {text: (r.displayName || r.airline) + (here ? " ★" : ""), clickable: true,
                 server: r.server, airline: r.airline},
                {text: r.server},
                {text: String(r.fleetCount)},
                {text: String(r.scheduleLegCount)},
                {text: hubsLabel},
                {text: overlap},
                {text: lastApply, tone: r.lastApplied && r.lastApplied.failed ? T.color.warn || T.color.rust : null},
                {text: r.lastScrape ? this._fmtAgo(r.lastScrape) : "—"}
            ]
            for (const c of cells) {
                const td = document.createElement("td")
                td.style.cssText = "padding:3px 6px;border-bottom:" + T.geom.bw1
                    + " dotted " + T.color.paperRule + ";"
                if (here)    td.style.color = T.color.oxide
                if (c.tone)  td.style.color = c.tone
                if (c.clickable) {
                    // Click-to-switch: opens the modal scoped to that
                    // sister so the user doesn't have to open and pick
                    // from the dropdown. Falls back gracefully when the
                    // panel isn't loaded.
                    const a = document.createElement("a")
                    a.textContent = c.text
                    a.href = "#"
                    a.style.cssText = "color:inherit;text-decoration:underline dotted;"
                        + "cursor:pointer;"
                    a.title = "Open strategy modal scoped to " + c.airline
                    a.addEventListener("click", (e) => {
                        e.preventDefault()
                        try {
                            if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                                window.AesStrategyPanel.open({server: c.server, airlineCode: c.airline})
                            }
                        } catch (err) { console.warn("[AES strategy tile] open via portfolio threw", err) }
                    })
                    td.appendChild(a)
                } else {
                    td.textContent = c.text
                }
                tr.appendChild(td)
            }
            tbody.appendChild(tr)
        }
        tbl.appendChild(tbody)
        wrap.appendChild(tbl)
        return wrap
    }

    _fmtAgo(ts) {
        if (!ts) return "—"
        const ms = Date.now() - ts
        if (ms < 0) return "now"
        const min = Math.floor(ms / 60000)
        if (min < 60) return min + "m ago"
        const hr  = Math.floor(min / 60)
        if (hr < 48) return hr + "h ago"
        const day = Math.floor(hr / 24)
        return day + "d ago"
    }

    /**
     * Cross-airline allocator hint — match (idle aircraft of sister A)
     * with (high-demand-but-undersupplied route at sister B's hub). Hidden
     * unless `settings.crossAirlineEnabled` is true and the matcher module
     * is loaded; returns null on a single-airline install or when no
     * matches surface.
     */
    async _buildCrossAirlineOpsCard(T, settings) {
        if (!window.AesCrossAirlineOpps) return null
        if (!settings || !settings.crossAirlineEnabled) return null

        let server = null
        try {
            server = (typeof AES !== "undefined" && AES.getServer) ? AES.getServer() : null
        } catch (_) {}
        if (!server) return null

        let matches = []
        try { matches = await window.AesCrossAirlineOpps.scanForServer(server, {topN: 6}) }
        catch (_) { return null }
        if (!matches.length) return null

        const wrap = document.createElement("div")
        wrap.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";margin-top:" + T.sp[3]
            + ";background:" + T.color.bone + ";"

        const head = document.createElement("strong")
        head.textContent = "Cross-airline opportunities · " + matches.length
        head.style.cssText = "color:" + T.color.oxide + ";font:600 11px " + T.font.display
            + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
        wrap.appendChild(head)

        const note = document.createElement("p")
        note.style.cssText = "margin:" + T.sp[1] + " 0 0 0;color:" + T.color.slate + ";font-size:11px;"
        note.textContent = "Idle aircraft from one sister could plug a high-demand gap at another. "
            + "Click to scope the modal to the idle airline."
        wrap.appendChild(note)

        const list = document.createElement("div")
        list.style.cssText = "margin-top:" + T.sp[2] + ";display:flex;flex-direction:column;gap:"
            + T.sp[1] + ";"
        for (const m of matches) list.appendChild(this._buildCrossAirlineRow(T, m, server))
        wrap.appendChild(list)
        return wrap
    }

    _buildCrossAirlineRow(T, m, server) {
        const row = document.createElement("div")
        row.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2]
            + ";border:" + T.geom.bw1 + " dotted " + T.color.paperRule
            + ";background:" + T.color.bone2 + ";cursor:pointer;"
        row.title = "Open strategy modal scoped to " + (m.idleAirline.displayName || m.idleAirline.airline)
        row.addEventListener("click", () => {
            try {
                if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                    window.AesStrategyPanel.open({server: server, airlineCode: m.idleAirline.airline})
                }
            } catch (e) { console.warn("[AES strategy tile] cross-airline open threw", e) }
        })

        const idleLabel = m.idleAirline.displayName || m.idleAirline.airline
        const baseLabel = m.idleAircraft.baseIata ? " at " + m.idleAircraft.baseIata : ""
        const top = document.createElement("div")
        top.style.cssText = "color:" + T.color.oxide2 + ";font:11px " + T.font.mono + ";"
        top.textContent = "✈ " + idleLabel + " " + (m.idleAircraft.equipment || "?")
            + " idle (" + Math.round(m.idleAircraft.headroomHours) + "h" + baseLabel + ")"
        row.appendChild(top)

        const shortLabel = m.shortAirline.displayName || m.shortAirline.airline
        let arrowText = "  → " + shortLabel + "  " + m.hub + "–" + m.dest
            + "  pax " + m.paxScore + "/10"
        if (m.idleAircraft.baseIata && m.idleAircraft.baseIata !== m.hub) {
            arrowText += "  ⚠ ferry " + m.idleAircraft.baseIata + "→" + m.hub
                + (m.ferryKm > 0 ? " (" + Math.round(m.ferryKm) + "km)" : "")
        }
        const arrow = document.createElement("div")
        arrow.style.cssText = "color:" + T.color.oxide2 + ";font:11px " + T.font.mono + ";margin-top:2px;"
        arrow.textContent = arrowText
        row.appendChild(arrow)

        if (m.staleAirlines && m.staleAirlines.length) {
            const stale = document.createElement("div")
            stale.textContent = "⚠ stale data · " + m.staleAirlines.join(", ")
            stale.style.cssText = "color:" + T.color.slate + ";font:9px " + T.font.mono
                + ";margin-top:1px;font-style:italic;"
            row.appendChild(stale)
        }

        return row
    }

    _note(T, txt) {
        const p = document.createElement("p")
        p.style.cssText = "color:" + T.color.slate + ";margin:0;font-style:italic;"
        p.textContent = txt
        return p
    }

    _smallBtn(T, label) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.style.cssText = "background:transparent;color:" + T.color.oxide + ";"
            + "border:" + T.geom.bw1 + " solid " + T.color.oxide + ";"
            + "border-radius:" + T.geom.radius + ";padding:" + T.sp[0] + " " + T.sp[2] + ";"
            + "font:600 11px " + T.font.display + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        return b
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "strategy",
        section: "tools",
        priority: 5,
        factory: () => new CentralHubStrategyTile()
    })
}
