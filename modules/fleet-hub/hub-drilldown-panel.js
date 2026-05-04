"use strict"

/**
 * Per-hub drilldown overlay for the Fleet Command Center.
 *
 * Click a hub card on `/app/fleets` (CC OVERVIEW) and this opens. It is a
 * planning view — read-only — that shows how the strategy engine would
 * fill this hub's aircraft within their weekly block-hour caps and the
 * per-route time ceilings, alongside what those aircraft are currently
 * flying. No edits, no apply: the affordances jump out to existing edit
 * surfaces (Route Assistant, AFP, Fleet Schedule Grid).
 *
 * Modeled on `FleetScheduleGridPanel`:
 *   • single-instance via static _active
 *   • z-index modal overlay, ESC + backdrop + X all close
 *   • lazy data loading after mount so the modal paints immediately
 *
 * Data sources:
 *   • planEnvelope (passed in from CC) — `{plan, snapshot, scored, ...}`
 *     supplies per-aircraft proposed legs + utilization + routeFrequency
 *     (added by allocate-fleet.js Phase 2).
 *   • AesAfpScheduleStore — current per-aircraft VFP-scraped schedules.
 *     If null/stale, the user can hit "↻ Refresh schedules" to drive a
 *     scrape via FleetScheduleGridScraper filtered to this hub.
 */
class FleetHubDrilldownPanel {

    static OVERLAY_CLASS = "aes-fleet-hub-drilldown-overlay"
    static FALLBACK_WEEKLY_HOURS = 80
    static FALLBACK_DAILY_HOURS  = 14
    static _active = null

    constructor(opts) {
        const o = opts || {}
        this.server       = String(o.server || "")
        this.airlineCode  = String(o.airlineCode || "")
        this.hub          = String(o.hub || "").toUpperCase()
        this.fleet        = Array.isArray(o.fleet) ? o.fleet.slice() : []
        this.planEnvelope = o.planEnvelope || null
        this._overlayEl   = null
        this._bodyEl      = null
        this._statusEl    = null
        this._progressEl  = null
        this._currentSchedules = new Map()  // aircraftId -> Schedule
        this._scraper     = null
        this._keydownHandler = null
        this._composing   = false
    }

    /** Open the drilldown for one hub. Closes any prior instance. */
    static async open(opts) {
        if (FleetHubDrilldownPanel._active) {
            try { FleetHubDrilldownPanel._active.close() } catch (_) { /* noop */ }
        }
        const p = new FleetHubDrilldownPanel(opts)
        FleetHubDrilldownPanel._active = p
        try {
            await p._mount()
        } catch (err) {
            console.warn("[AES Fleet Hub Drilldown] mount failed", err)
            p.close()
            throw err
        }
        // Load data after mount so the modal paints first; spinner drives UX.
        p._loadData().catch(err => {
            console.warn("[AES Fleet Hub Drilldown] data load failed", err)
            p._setStatus("Data load failed: " + ((err && err.message) || String(err)))
        })
        return p
    }

    static close() {
        if (FleetHubDrilldownPanel._active) {
            try { FleetHubDrilldownPanel._active.close() } catch (_) { /* noop */ }
        }
    }

    close() {
        if (this._scraper) { try { this._scraper.abort() } catch (_) { /* noop */ } }
        this._scraper = null
        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler, true)
            this._keydownHandler = null
        }
        if (this._overlayEl && this._overlayEl.parentElement) {
            this._overlayEl.parentElement.removeChild(this._overlayEl)
        }
        this._overlayEl = null
        this._bodyEl = null
        if (FleetHubDrilldownPanel._active === this) FleetHubDrilldownPanel._active = null
    }

    // ── Mount ────────────────────────────────────────────────────────────

    async _mount() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const overlay = document.createElement("div")
        overlay.className = FleetHubDrilldownPanel.OVERLAY_CLASS
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(20,18,15,0.62);"
            + "z-index:" + (T ? T.z.modal : 10000) + ";display:flex;align-items:stretch;"
            + "justify-content:center;padding:24px;box-sizing:border-box;"
        overlay.addEventListener("click", e => { if (e.target === overlay) this.close() })

        const modal = document.createElement("div")
        modal.style.cssText = "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "flex:1 1 auto;max-width:1400px;display:flex;flex-direction:column;"
            + "overflow:hidden;font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "font-size:" + (T ? T.fs.body : "12px") + ";"

        modal.appendChild(this._buildHeader(T))
        modal.appendChild(this._buildProgressStrip(T))

        const scroll = document.createElement("div")
        scroll.style.cssText = "flex:1 1 auto;overflow:auto;padding:16px 20px;"
        const body = document.createElement("div")
        body.style.cssText = "display:flex;flex-direction:column;gap:" + (T ? T.sp[4] : "16px") + ";"
        scroll.appendChild(body)
        modal.appendChild(scroll)
        this._bodyEl = body

        modal.appendChild(this._buildFooter(T))

        overlay.appendChild(modal)
        document.body.appendChild(overlay)
        this._overlayEl = overlay

        this._keydownHandler = (e) => {
            if (e.key === "Escape") { e.preventDefault(); this.close() }
        }
        document.addEventListener("keydown", this._keydownHandler, true)

        // First paint with whatever we have (envelope often pre-supplied,
        // current schedules empty until _loadData fills them).
        this._render()
    }

    _buildHeader(T) {
        const h = document.createElement("div")
        h.style.cssText = "display:flex;align-items:center;gap:16px;padding:12px 20px;"
            + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"

        const title = document.createElement("h2")
        title.style.cssText = "margin:0;font-size:" + (T ? T.fs.h3 : "18px") + ";"
            + "font-weight:" + (T ? T.fw.display : "800") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";flex:0 0 auto;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        title.textContent = this.hub
        h.appendChild(title)

        const sub = document.createElement("div")
        sub.style.cssText = "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";flex:0 0 auto;"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        sub.textContent = "Hub drilldown · " + this.fleet.length + " aircraft"
        h.appendChild(sub)

        const status = document.createElement("div")
        status.style.cssText = "flex:1 1 auto;font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";text-align:right;"
        status.textContent = ""
        this._statusEl = status
        h.appendChild(status)

        const close = document.createElement("button")
        close.type = "button"
        close.title = "Close (Esc)"
        close.textContent = "✕"
        close.style.cssText = "background:transparent;border:none;cursor:pointer;font-size:18px;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";padding:0 4px;"
        close.addEventListener("click", () => this.close())
        h.appendChild(close)

        return h
    }

    _buildProgressStrip(T) {
        const strip = document.createElement("div")
        strip.style.cssText = "padding:6px 20px;background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-bottom:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
            + "color:" + (T ? T.color.slate : "#7A6F66") + ";min-height:18px;"
        this._progressEl = strip
        return strip
    }

    _buildFooter(T) {
        const f = document.createElement("div")
        f.style.cssText = "display:flex;gap:8px;padding:10px 20px;"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-top:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        const refresh = this._actionButton("↻ Refresh schedules",
            "Re-scrape current schedules for this hub's aircraft",
            () => this._refreshSchedules())
        f.appendChild(refresh)

        const grid = this._actionButton("→ Open in Fleet Schedule Grid",
            "Open the existing Fleet Schedule Grid filtered to this hub",
            () => this._openInGrid())
        f.appendChild(grid)

        const ra = document.createElement("a")
        ra.href = "/app/com/scheduling/" + this.hub + this.hub
        ra.target = "_blank"
        ra.rel = "noopener"
        ra.textContent = "→ Route Assistant"
        ra.title = "Open Route Assistant for " + this.hub
        ra.style.cssText = T
            ? "padding:" + T.sp[1] + " " + T.sp[2] + ";background:transparent;color:"
                + T.color.oxide + ";border:" + T.geom.bw1 + " solid " + T.color.oxide
                + ";font-family:" + T.font.display + ";font-size:" + T.fs.small
                + ";font-weight:" + T.fw.bold + ";text-transform:uppercase;letter-spacing:"
                + T.track.caps + ";text-decoration:none;cursor:pointer;"
            : "padding:4px 8px;background:transparent;color:#2b2520;border:1px solid #2b2520;"
                + "font-weight:700;text-transform:uppercase;letter-spacing:0.08em;text-decoration:none;font-size:11px;"
        f.appendChild(ra)

        return f
    }

    // ── Data ─────────────────────────────────────────────────────────────

    async _loadData() {
        // Compose a plan if the caller didn't pass one.
        if (!this.planEnvelope && typeof window.AesStrategy !== "undefined"
                && typeof window.AesStrategy.snapshot === "function") {
            this._composing = true
            this._setStatus("Composing strategy plan…")
            try {
                const ns = window.AesStrategy
                const snapshot = await ns.snapshot({})
                let weights = null
                if (window.AesStrategyLearn && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
                    try { weights = await window.AesStrategyLearn.getCurrentWeights() } catch (_) {}
                }
                const scored = ns.scoreRoutes(snapshot, weights || undefined)
                const plan   = await ns.allocateFleet(snapshot, scored, {})
                this.planEnvelope = {snapshot, scored, plan, weights}
            } catch (err) {
                console.warn("[AES Fleet Hub Drilldown] compose failed", err)
                this._setStatus("Compose failed: " + ((err && err.message) || String(err)))
            } finally {
                this._composing = false
            }
        }

        // Load cached schedules — don't fetch unless the user hits Refresh.
        await this._loadStoredSchedules()
        this._render()
    }

    async _loadStoredSchedules() {
        if (typeof window.AesAfpScheduleStore === "undefined"
                || typeof window.AesAfpScheduleStore.load !== "function") return
        await Promise.all(this.fleet.map(async (r) => {
            try {
                const s = await window.AesAfpScheduleStore.load(this.server, r.aircraftId)
                if (s) this._currentSchedules.set(String(r.aircraftId), s)
            } catch (_) { /* missing tail — leave unset */ }
        }))
    }

    async _refreshSchedules() {
        if (this._scraper) return
        if (typeof window.FleetScheduleGridScraper === "undefined") {
            // F-9228-604: progress strip is right above the footer button —
            // status strip lives in the header where the user isn't looking
            // when they click here.
            this._setProgress("Bulk scraper not loaded — open Fleet Schedule Grid first")
            return
        }
        const fleet = this.fleet.map(r => ({aircraftId: r.aircraftId, registration: r.registration}))
        if (!fleet.length) { this._setProgress("No aircraft to scrape"); return }

        this._scraper = new window.FleetScheduleGridScraper(this.server, {maxConcurrency: 3})
        this._setProgress("Scraping " + fleet.length + " aircraft…")
        try {
            const result = await this._scraper.scrapeAll(fleet, {
                forceRefetch: true,
                onProgress: (p) => {
                    if (!p) return
                    if (p.phase === "done") {
                        this._setProgress("Scrape complete · " + p.completed + "/" + p.total)
                    } else if (p.phase === "fetching" || p.phase === "scanning") {
                        this._setProgress("Scraping " + p.completed + "/" + p.total + " · " + (p.current || ""))
                    }
                }
            })
            for (const [aid, sched] of result.schedules) {
                this._currentSchedules.set(String(aid), sched)
            }
            this._render()
            const errs = result.results.filter(r => !r.ok).length
            this._setProgress("Scrape complete · " + (result.results.length - errs) + " ok"
                + (errs ? " · " + errs + " err" : ""))
        } catch (err) {
            this._setProgress("Scrape failed: " + ((err && err.message) || String(err)))
        } finally {
            this._scraper = null
        }
    }

    _openInGrid() {
        if (typeof window.FleetScheduleGridPanel === "undefined") {
            window.open("/app/com/scheduling/" + this.hub + this.hub, "_blank")
            return
        }
        const first = this.fleet[0]
        window.FleetScheduleGridPanel.open({
            server:             this.server,
            airlineCode:        this.airlineCode,
            selectedHub:        this.hub,
            selectedAircraftId: first ? first.aircraftId : null
        }).catch(err => console.warn("[AES Fleet Hub Drilldown] grid open failed", err))
    }

    // ── Render ───────────────────────────────────────────────────────────

    _render() {
        if (!this._bodyEl) return
        this._bodyEl.textContent = ""
        const T = window.AESTokens

        // Aircraft-id-keyed lookups for this render pass: the strategy plan's
        // per-aircraft proposals and the snapshot's per-aircraft wear/spec
        // record. Built once and consulted by _capForAircraft / per-row
        // renderers — beats Array.find for every lookup.
        const planPerAc = (this.planEnvelope && this.planEnvelope.plan
            && this.planEnvelope.plan.perAircraft) || []
        const planByAc = new Map(
            planPerAc
                .filter(p => p && p.aircraftId != null)
                .map(p => [String(p.aircraftId), p])
        )
        const snapFleet = (this.planEnvelope && this.planEnvelope.snapshot
            && this.planEnvelope.snapshot.fleet) || []
        this._snapFleetById = new Map(
            snapFleet
                .filter(a => a && a.aircraftId != null)
                .map(a => [String(a.aircraftId), a])
        )

        let capTotal = 0
        let usedTotal = 0
        let proposedTotal = 0
        let proposedRT = 0
        for (const r of this.fleet) {
            const cap = this._capForAircraft(r)
            const used = this._usedForAircraft(r)
            capTotal += cap
            usedTotal += used
            const p = planByAc.get(String(r.aircraftId))
            if (p && p.utilization && Number.isFinite(Number(p.utilization.weeklyHours))) {
                proposedTotal += Number(p.utilization.weeklyHours)
            }
            if (p && Array.isArray(p.legs)) proposedRT += p.legs.length / 2
        }

        // ── Section: capacity summary ──────────────────────────────────
        this._bodyEl.appendChild(this._renderCapacitySection(T, {
            capTotal, usedTotal, proposedTotal, proposedRT, planByAc
        }))

        // ── Section: route mix ─────────────────────────────────────────
        this._bodyEl.appendChild(this._renderRouteMixSection(T, planByAc))

        // ── Section: per-aircraft breakdown ─────────────────────────────
        this._bodyEl.appendChild(this._renderAircraftSection(T, planByAc))
    }

    _renderCapacitySection(T, ctx) {
        const wrap = this._section(T, "Capacity")

        const summary = document.createElement("div")
        summary.style.cssText = "display:flex;flex-wrap:wrap;gap:16px;font-family:"
            + (T ? T.font.mono : "monospace") + ";font-size:13px;"
            + "color:" + (T ? T.color.oxide : "#2b2520") + ";"
        const headroom = Math.max(0, ctx.capTotal - ctx.usedTotal)
        const utilPct = ctx.capTotal > 0 ? Math.round(ctx.usedTotal / ctx.capTotal * 100) : 0
        summary.appendChild(this._kv(T, "Cap",      ctx.capTotal.toFixed(0) + "h"))
        summary.appendChild(this._kv(T, "Used",     ctx.usedTotal.toFixed(0) + "h (" + utilPct + "%)"))
        summary.appendChild(this._kv(T, "Headroom", headroom.toFixed(0) + "h"))
        wrap.appendChild(summary)

        // Capacity bar — one segment per aircraft, width by cap, fill by used/cap
        if (this.fleet.length) {
            wrap.appendChild(this._renderCapacityBar(T, ctx))
        }

        if (this.planEnvelope) {
            const fc = document.createElement("div")
            fc.style.cssText = "padding:8px 12px;background:" + (T ? T.color.bone2 : "#ece7dc")
                + ";border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0")
                + ";font-family:" + (T ? T.font.mono : "monospace") + ";font-size:12px;"
                + "display:flex;flex-wrap:wrap;gap:14px;align-items:baseline;"
            const propPct = ctx.capTotal > 0 ? Math.round(ctx.proposedTotal / ctx.capTotal * 100) : 0
            const tone = this._toneForRatio(T, propPct / 100, {hi: 0.9, mid: 0.6})
            fc.appendChild(this._labelStrong(T, "Capacity utilisation forecast"))
            fc.appendChild(this._kv(T, "Proposed", ctx.proposedTotal.toFixed(0) + "h / "
                + ctx.capTotal.toFixed(0) + "h (" + propPct + "%)", tone))
            fc.appendChild(this._kv(T, "Round-trips", String(Math.round(ctx.proposedRT))))
            const dh = ctx.proposedTotal - ctx.usedTotal
            const sign = dh >= 0 ? "+" : ""
            const dtone = this._toneForDelta(T, dh)
            fc.appendChild(this._kv(T, "Δ vs current", sign + dh.toFixed(0) + "h", dtone))
            if (this._composing) {
                const c = document.createElement("span")
                c.textContent = "composing…"
                c.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-style:italic;"
                fc.appendChild(c)
            }
            wrap.appendChild(fc)
        } else {
            const note = document.createElement("p")
            note.style.cssText = "margin:0;color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-style:italic;font-size:11px;"
            note.textContent = "Strategy plan not loaded — proposed-frequency view unavailable."
            wrap.appendChild(note)
        }

        return wrap
    }

    _renderCapacityBar(T, ctx) {
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;width:100%;height:18px;border:" + (T ? T.geom.bw1 : "1px")
            + " solid " + (T ? T.color.oxide : "#2b2520") + ";background:" + (T ? T.color.bone : "#f4f1ea") + ";"
        for (const r of this.fleet) {
            const cap = this._capForAircraft(r) || FleetHubDrilldownPanel.FALLBACK_WEEKLY_HOURS
            const used = this._usedForAircraft(r)
            const ratio = cap > 0 ? Math.min(used / cap, 1.5) : 0
            const fill = Math.max(0, Math.min(used / cap, 1)) * 100
            const tone = ratio > 1
                ? (T ? T.color.crimson : "#8b2727")
                : this._toneForRatio(T, ratio, {hi: 0.8, mid: 0})
            const seg = document.createElement("div")
            seg.title = (r.registration || ("#" + r.aircraftId))
                + " · " + (r.equipment || "?")
                + " · used " + used.toFixed(0) + "h / cap " + cap.toFixed(0) + "h"
                + " (" + Math.round(ratio * 100) + "%)"
            const widthPct = ctx.capTotal > 0 ? (cap / ctx.capTotal * 100) : (100 / Math.max(1, this.fleet.length))
            seg.style.cssText = "flex:0 0 " + widthPct.toFixed(2) + "%;"
                + "background:linear-gradient(to right, " + tone + " " + fill + "%, "
                + (T ? T.color.bone : "#f4f1ea") + " " + fill + "%);"
                + "border-right:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            bar.appendChild(seg)
        }
        return bar
    }

    _renderRouteMixSection(T, planByAc) {
        const wrap = this._section(T, "Route mix · proposed frequency")

        // Aggregate routeFrequency across the hub's aircraft.
        const byDest = new Map()  // dest -> {dest, proposedFreq, maxFreqByTime, rtHours, contributors}
        for (const r of this.fleet) {
            const p = planByAc.get(String(r.aircraftId))
            if (!p || !Array.isArray(p.routeFrequency)) continue
            for (const rf of p.routeFrequency) {
                if (!rf || !rf.dest) continue
                let cur = byDest.get(rf.dest)
                if (!cur) {
                    cur = {
                        dest:           rf.dest,
                        proposedFreq:   0,
                        maxFreqByTime:  rf.maxFreqByTime,
                        rtHours:        rf.rtHours,
                        contributors:   0,
                        anyDailyExceeds: false
                    }
                    byDest.set(rf.dest, cur)
                }
                cur.proposedFreq += Number(rf.proposedFreq) || 0
                cur.contributors++
                // Daily-cap heuristic: rt × proposed / 7 vs aircraft's daily cap
                const dailyCap = (p.utilization && Number.isFinite(Number(p.utilization.maxDailyBlockHours)))
                    ? Number(p.utilization.maxDailyBlockHours)
                    : FleetHubDrilldownPanel.FALLBACK_DAILY_HOURS
                if (rf.rtHours && rf.proposedFreq && (rf.rtHours * rf.proposedFreq / 7) > dailyCap) {
                    cur.anyDailyExceeds = true
                }
            }
        }
        const rows = Array.from(byDest.values()).sort((a, b) => b.proposedFreq - a.proposedFreq)
        if (!rows.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "margin:0;color:" + (T ? T.color.slate : "#7a6f66")
                + ";font-style:italic;font-size:11px;"
            empty.textContent = this.planEnvelope
                ? "No proposed routes — strategy engine left this hub idle (no candidates met the score threshold or no headroom)."
                : "Strategy plan not loaded."
            wrap.appendChild(empty)
            return wrap
        }

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        const thead = document.createElement("thead")
        const trh = document.createElement("tr")
        for (const [label, align] of [
            ["Dest", "left"], ["RT hours", "right"], ["Max freq (time)", "right"],
            ["Proposed freq", "right"], ["Aircraft", "right"], ["Notes", "left"]
        ]) {
            const th = document.createElement("th")
            th.textContent = label
            th.style.cssText = "text-align:" + align + ";padding:4px 8px;border-bottom:"
                + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.oxide : "#2b2520")
                + ";font-weight:" + (T ? T.fw.bold : "700") + ";text-transform:uppercase;"
                + "letter-spacing:0.06em;font-size:10px;"
            trh.appendChild(th)
        }
        thead.appendChild(trh)
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        for (const row of rows) {
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:" + (T ? T.geom.bw1 : "1px")
                + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"

            const atCap = row.maxFreqByTime != null
                && row.contributors === 1
                && row.proposedFreq >= row.maxFreqByTime
            const cellStyle = "padding:4px 8px;font-variant-numeric:tabular-nums;"

            const td1 = document.createElement("td")
            td1.style.cssText = cellStyle + "font-weight:700;"
            td1.textContent = row.dest
            tr.appendChild(td1)

            const td2 = document.createElement("td")
            td2.style.cssText = cellStyle + "text-align:right;"
            td2.textContent = row.rtHours != null ? row.rtHours.toFixed(1) : "—"
            tr.appendChild(td2)

            const td3 = document.createElement("td")
            td3.style.cssText = cellStyle + "text-align:right;color:"
                + (T ? T.color.slate : "#7a6f66") + ";"
            td3.textContent = row.maxFreqByTime != null ? String(row.maxFreqByTime) : "—"
            tr.appendChild(td3)

            const td4 = document.createElement("td")
            td4.style.cssText = cellStyle + "text-align:right;font-weight:700;color:"
                + (atCap ? (T ? T.color.amber : "#b8861f") : (T ? T.color.oxide : "#2b2520")) + ";"
            td4.textContent = String(row.proposedFreq)
            tr.appendChild(td4)

            const td5 = document.createElement("td")
            td5.style.cssText = cellStyle + "text-align:right;color:" + (T ? T.color.slate : "#7a6f66") + ";"
            td5.textContent = row.contributors > 1 ? row.contributors + " ac" : "1 ac"
            tr.appendChild(td5)

            const td6 = document.createElement("td")
            td6.style.cssText = cellStyle + "color:" + (T ? T.color.slate : "#7a6f66") + ";"
            const notes = []
            if (atCap) notes.push("at time cap")
            if (row.anyDailyExceeds) notes.push("daily-cap?")
            td6.textContent = notes.join(" · ")
            if (row.anyDailyExceeds) td6.style.color = T ? T.color.amber : "#b8861f"
            tr.appendChild(td6)

            tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        wrap.appendChild(table)

        const footnote = document.createElement("p")
        footnote.style.cssText = "margin:0;color:" + (T ? T.color.slate : "#7a6f66")
            + ";font-style:italic;font-size:10px;"
        footnote.textContent = "Max freq (time) = floor(168 / (rt hours)) — theoretical, ignoring daily-block cap. "
            + "“daily-cap?” flags when proposed × rt / 7 > aircraft's daily block cap."
        wrap.appendChild(footnote)

        return wrap
    }

    _renderAircraftSection(T, planByAc) {
        const wrap = this._section(T, "Per-aircraft breakdown")

        if (!this.fleet.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "margin:0;color:" + (T ? T.color.slate : "#7a6f66") + ";font-style:italic;font-size:11px;"
            empty.textContent = "No aircraft at this hub."
            wrap.appendChild(empty)
            return wrap
        }

        const list = document.createElement("ul")
        list.style.cssText = "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;"
            + "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "background:" + (T ? T.color.bone2 : "#ece7dc") + ";"

        for (const r of this.fleet) {
            list.appendChild(this._renderAircraftRow(T, r, planByAc.get(String(r.aircraftId))))
        }
        wrap.appendChild(list)
        return wrap
    }

    _renderAircraftRow(T, r, plan) {
        const li = document.createElement("li")
        li.style.cssText = "display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr 0.5fr;"
            + "gap:8px;padding:8px 12px;align-items:center;"
            + "border-bottom:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0") + ";"
            + "font-size:12px;"

        const idCell = document.createElement("div")
        const reg = document.createElement("strong")
        reg.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "color:" + (T ? T.color.oxide : "#2b2520") + ";"
        reg.textContent = r.registration || ("#" + r.aircraftId)
        idCell.appendChild(reg)
        const eq = document.createElement("div")
        eq.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-size:10px;"
        eq.textContent = r.equipment || ""
        idCell.appendChild(eq)
        li.appendChild(idCell)

        const cap = this._capForAircraft(r)
        const used = this._usedForAircraft(r)
        const curCell = document.createElement("div")
        curCell.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
        curCell.appendChild(this._kv(T, "Current", used.toFixed(0) + "h / " + cap.toFixed(0) + "h"))
        li.appendChild(curCell)

        const propCell = document.createElement("div")
        propCell.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
        if (plan && plan.utilization && Number.isFinite(Number(plan.utilization.weeklyHours))) {
            const pHours = Number(plan.utilization.weeklyHours)
            const pCap = this._positiveNumber(plan.utilization.capWeeklyHours) || cap
            const tone = this._toneForRatio(T, pHours / pCap, {hi: 0.95, mid: 0.6})
            propCell.appendChild(this._kv(T, "Proposed", pHours.toFixed(0) + "h / " + pCap.toFixed(0) + "h", tone))
        } else {
            propCell.appendChild(this._kv(T, "Proposed", "—"))
        }
        li.appendChild(propCell)

        const rtCell = document.createElement("div")
        rtCell.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
        const curRT = this._currentRoundTripCount(r)
        const propRT = plan && Array.isArray(plan.legs) ? Math.round(plan.legs.length / 2) : null
        if (propRT != null) {
            const delta = propRT - (curRT || 0)
            const sign = delta > 0 ? "+" : delta < 0 ? "" : "±"
            const tone = this._toneForDelta(T, delta)
            rtCell.appendChild(this._kv(T, "RT (current → proposed)",
                (curRT || 0) + " → " + propRT + " (" + sign + delta + ")", tone))
        } else {
            rtCell.appendChild(this._kv(T, "RT", String(curRT != null ? curRT : "—")))
        }
        li.appendChild(rtCell)

        const openCell = document.createElement("div")
        openCell.style.cssText = "text-align:right;"
        const a = document.createElement("a")
        a.href = "/app/fleets/aircraft/" + r.aircraftId + "/0"
        a.target = "_blank"
        a.rel = "noopener"
        a.textContent = "AFP ▸"
        a.style.cssText = T
            ? "color:" + T.color.rust + ";text-decoration:none;font-size:11px;font-weight:"
                + T.fw.bold + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            : "color:#b8472a;text-decoration:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;"
        openCell.appendChild(a)
        li.appendChild(openCell)

        return li
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    _capForAircraft(r) {
        const snap = this._snapFleetById && this._snapFleetById.get(String(r.aircraftId))
        const wear = snap && snap.wear ? snap.wear : null
        const cap = wear && Number.isFinite(Number(wear.maxWeeklyBlockHours))
            ? Number(wear.maxWeeklyBlockHours)
            : null
        return cap && cap > 0
            ? cap
            : FleetHubDrilldownPanel.FALLBACK_WEEKLY_HOURS
    }

    _usedForAircraft(r) {
        const sched = this._currentSchedules.get(String(r.aircraftId))
        if (sched && sched.summary && Number.isFinite(Number(sched.summary.weeklyBlockMinutes))) {
            return Number(sched.summary.weeklyBlockMinutes) / 60
        }
        const snap = this._snapFleetById && this._snapFleetById.get(String(r.aircraftId))
        const wear = snap && snap.wear ? snap.wear : null
        if (wear && Number.isFinite(Number(wear.weeklyHoursLast7d))) {
            return Number(wear.weeklyHoursLast7d)
        }
        return 0
    }

    _currentRoundTripCount(r) {
        const sched = this._currentSchedules.get(String(r.aircraftId))
        if (sched && sched.summary && Number.isFinite(Number(sched.summary.flightCount))) {
            return Math.max(0, Math.floor(Number(sched.summary.flightCount) / 2))
        }
        if (!sched || !Array.isArray(sched.days)) return null
        let outbound = 0
        for (const day of sched.days) {
            if (!day || !Array.isArray(day.blocks)) continue
            for (const b of day.blocks) {
                if (b && b.kind === "flight" && b.flight
                        && (b.flight.destinationIata || b.flight.destination)) outbound++
            }
        }
        // Round-trips = total flight blocks / 2 (rough; out + return per pair)
        return Math.max(0, Math.floor(outbound / 2))
    }

    _positiveNumber(value) {
        const n = Number(value)
        return Number.isFinite(n) && n > 0 ? n : null
    }

    _setStatus(text) {
        if (this._statusEl) this._statusEl.textContent = text || ""
    }

    _setProgress(text) {
        if (this._progressEl) this._progressEl.textContent = text || ""
    }

    _section(T, title) {
        const wrap = document.createElement("section")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + (T ? T.sp[2] : "8px") + ";"
        const head = document.createElement("h3")
        head.style.cssText = "margin:0;font-size:" + (T ? T.fs.lead : "14px")
            + ";font-weight:" + (T ? T.fw.display : "800")
            + ";text-transform:uppercase;letter-spacing:0.08em;"
            + "color:" + (T ? T.color.oxide : "#2b2520") + ";"
            + "border-bottom:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.paperRule : "#c9c0b0")
            + ";padding-bottom:4px;"
        head.textContent = title
        wrap.appendChild(head)
        return wrap
    }

    _toneForRatio(T, ratio, opts) {
        const o = opts || {}
        if (ratio >= (o.hi != null ? o.hi : 0.9))  return T ? T.color.amber : "#b8861f"
        if (ratio >= (o.mid != null ? o.mid : 0.6)) return T ? T.color.moss  : "#2f5f3f"
        return T ? T.color.slate : "#7a6f66"
    }

    _toneForDelta(T, delta) {
        if (delta > 0) return T ? T.color.moss    : "#2f5f3f"
        if (delta < 0) return T ? T.color.crimson : "#8b2727"
        return T ? T.color.slate : "#7a6f66"
    }

    _kv(T, label, value, valueColor) {
        const span = document.createElement("span")
        span.style.cssText = "display:inline-flex;gap:6px;align-items:baseline;"
        const k = document.createElement("span")
        k.textContent = label
        k.style.cssText = "color:" + (T ? T.color.slate : "#7a6f66") + ";font-size:10px;"
            + "text-transform:uppercase;letter-spacing:0.06em;"
        const v = document.createElement("span")
        v.textContent = value
        v.style.cssText = "color:" + (valueColor || (T ? T.color.oxide : "#2b2520"))
            + ";font-family:" + (T ? T.font.mono : "monospace") + ";font-size:12px;font-weight:700;"
        span.append(k, v)
        return span
    }

    _labelStrong(T, text) {
        const s = document.createElement("strong")
        s.textContent = text
        s.style.cssText = "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "font-weight:" + (T ? T.fw.display : "800") + ";font-size:11px;"
            + "text-transform:uppercase;letter-spacing:0.06em;color:" + (T ? T.color.oxide : "#2b2520") + ";"
        return s
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
            : "padding:4px 8px;background:transparent;color:#2b2520;border:1px solid #2b2520;"
              + "font-weight:700;text-transform:uppercase;letter-spacing:0.08em;cursor:pointer;font-size:11px;"
        if (onClick) btn.addEventListener("click", (e) => { e.preventDefault(); onClick() })
        return btn
    }
}

if (typeof window !== "undefined") {
    window.FleetHubDrilldownPanel = FleetHubDrilldownPanel
}
