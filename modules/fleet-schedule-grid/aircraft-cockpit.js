"use strict"

/**
 * Fleet Schedule Grid — per-aircraft cockpit (decision-support drawer).
 *
 * Mounted as the "Aircraft" tab on the side rail. When the user clicks the
 * Inspect chevron on an aircraft row in the grid, this drawer surfaces — for
 * the selected tail — candidate destinations from its hub (scored by
 * demand · fit · profit), an ORS rank + competitor breakdown for the
 * highlighted candidate, and the aircraft's current wave layer.
 *
 * Read-only: actual flight creation still flows through the Aircraft Flight
 * Plan page, deep-linked via "Open Flight Plan ↗".
 *
 * Public API:
 *   buildPane()             → HTMLElement (mounted by side rail)
 *   setAircraft(aircraftId) → re-render for that tail
 *   refresh()               → re-render the current selection
 *
 * Defensive against missing dependencies — each section degrades to a hint
 * line rather than crashing the cockpit.
 */
class FleetScheduleGridAircraftCockpit {
    constructor(deps) {
        const d = deps || {}
        this.server            = d.server         || ""
        this.airlineCode       = d.airlineCode    || ""
        this._getFleetRow      = typeof d.getFleetRow      === "function" ? d.getFleetRow      : () => null
        this._getSchedule      = typeof d.getSchedule      === "function" ? d.getSchedule      : () => null
        this._getWaveLayers    = typeof d.getWaveLayers    === "function" ? d.getWaveLayers    : () => []
        this._activateWavesTab = typeof d.activateWavesTab === "function" ? d.activateWavesTab : () => {}

        this._paneEl       = null
        this._headerEl     = null
        this._waveEl       = null
        this._candEl       = null
        this._detailEl     = null

        this._aircraftId   = null
        this._candidates   = null   // null = loading, [] = loaded empty
        this._selectedDest = null
        this._loadSeq      = 0
    }

    buildPane() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const pane = document.createElement("div")
        pane.style.cssText = "padding:8px 10px;display:flex;flex-direction:column;gap:8px;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "font-size:12px;"

        this._headerEl = document.createElement("div")
        this._waveEl   = document.createElement("div")
        this._candEl   = document.createElement("div")
        this._detailEl = document.createElement("div")
        pane.append(this._headerEl, this._waveEl, this._candEl, this._detailEl)

        this._paneEl = pane
        this._renderEmpty()
        return pane
    }

    setAircraft(aircraftId) {
        const id = aircraftId == null ? null : String(aircraftId)
        if (this._aircraftId === id) {
            this.refresh()
            return
        }
        this._aircraftId   = id
        this._selectedDest = null
        this._candidates   = null
        if (!id) { this._renderEmpty(); return }
        this._renderAll()
        this._loadCandidates().catch(err =>
            console.warn("[AES FSG cockpit] candidate load failed", err))
    }

    refresh() {
        if (this._aircraftId) this._renderAll()
        else this._renderEmpty()
    }

    // ── Render ──────────────────────────────────────────────────────────

    _renderEmpty() {
        if (!this._headerEl) return
        this._headerEl.innerHTML = ""
        this._waveEl.innerHTML   = ""
        this._candEl.innerHTML   = ""
        this._detailEl.innerHTML = ""
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const hint = document.createElement("div")
        hint.style.cssText = "padding:16px;text-align:center;line-height:1.5;font-size:11px;"
            + "border:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;"
        hint.textContent = "Click ▸ INSPECT on any aircraft row to see candidates, "
            + "ORS rank, competitors, and the active wave."
        this._headerEl.appendChild(hint)
    }

    _renderAll() {
        if (!this._aircraftId) { this._renderEmpty(); return }
        this._renderHeader()
        this._renderWave()
        this._renderCandidates()
        this._renderDetail()
    }

    _renderHeader() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this._headerEl.innerHTML = ""
        const row = this._getFleetRow(this._aircraftId)
        const sched = this._getSchedule(this._aircraftId)

        const box = document.createElement("div")
        box.style.cssText = "padding:8px 10px;background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "display:flex;flex-direction:column;gap:4px;"

        const titleRow = document.createElement("div")
        titleRow.style.cssText = "display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;"

        const reg = document.createElement("span")
        reg.style.cssText = "font-weight:700;font-size:13px;"
        reg.textContent = (row && row.registration) || this._aircraftId

        const eq = document.createElement("span")
        eq.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-size:11px;"
        eq.textContent = (row && row.equipment) || "?"

        const hub = document.createElement("span")
        hub.style.cssText = "padding:1px 6px;border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
        hub.textContent = (row && row.hub) || "—"

        const link = document.createElement("a")
        link.href = "/app/fleets/aircraft/" + encodeURIComponent(this._aircraftId) + "/0"
        link.target = "_blank"
        link.rel = "noopener"
        link.style.cssText = "margin-left:auto;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;"
            + "color:" + (T ? T.color.rust : "#B8472A") + ";text-decoration:none;font-weight:700;"
        link.textContent = "Flight Plan ↗"
        link.title = "Open the Aircraft Flight Plan page in a new tab"

        titleRow.append(reg, eq, hub, link)
        box.appendChild(titleRow)

        if (sched && sched.summary) {
            const stats = document.createElement("div")
            stats.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            const fc = sched.summary.flightCount || 0
            const bh = ((sched.summary.weeklyBlockMinutes || 0) / 60).toFixed(1)
            stats.textContent = fc + " flight" + (fc === 1 ? "" : "s") + " · " + bh + "h block · weekly"
            box.appendChild(stats)
        } else if (sched) {
            const stats = document.createElement("div")
            stats.style.cssText = "font-style:italic;color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:11px;"
            stats.textContent = "(empty schedule)"
            box.appendChild(stats)
        } else {
            const stats = document.createElement("div")
            stats.style.cssText = "font-style:italic;color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:11px;"
            stats.textContent = "(schedule still loading)"
            box.appendChild(stats)
        }
        this._headerEl.appendChild(box)
    }

    _renderWave() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this._waveEl.innerHTML = ""
        const row = this._getFleetRow(this._aircraftId)
        const layers = this._getWaveLayers() || []
        const hub = ((row && row.hub) || "").toUpperCase()
        const layer = layers.find(l => !l.hub || String(l.hub).toUpperCase() === hub) || null

        const box = document.createElement("div")
        box.style.cssText = "padding:6px 10px;border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "display:flex;align-items:center;gap:8px;font-size:11px;"

        const lbl = document.createElement("span")
        lbl.style.cssText = "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
            + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-size:10px;"
        lbl.textContent = "Wave"

        const value = document.createElement("span")
        value.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";flex:1 1 auto;"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        if (layer) {
            const ts = layer.timeShiftMin || 0
            const ar = layer.arrShiftMin  || 0
            const dp = layer.depShiftMin  || 0
            const fmt = m => (m === 0 ? "0" : (m > 0 ? "+" + m : String(m))) + "m"
            let txt = layer.name || layer.id || "(layer)"
            if (ts || ar || dp) {
                const parts = []
                if (ts) parts.push("shift " + fmt(ts))
                if (ar) parts.push("A " + fmt(ar))
                if (dp) parts.push("D " + fmt(dp))
                txt += " · " + parts.join(" · ")
            }
            value.textContent = txt
            value.title = txt
        } else {
            value.style.fontStyle = "italic"
            value.style.color = T ? T.color.slate : "#7A6F66"
            value.textContent = hub ? "(no layer for " + hub + ")" : "(no hub on this aircraft)"
        }

        const editBtn = document.createElement("button")
        editBtn.type = "button"
        editBtn.style.cssText = "padding:2px 8px;font-size:10px;cursor:pointer;flex:0 0 auto;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        editBtn.textContent = "Edit waves"
        editBtn.title = "Switch to the Waves tab"
        editBtn.addEventListener("click", () => this._activateWavesTab())

        box.append(lbl, value, editBtn)
        this._waveEl.appendChild(box)
    }

    async _loadCandidates() {
        const seq = ++this._loadSeq
        const row = this._getFleetRow(this._aircraftId)
        if (!row || !row.hub) {
            this._candidates = []
            if (seq === this._loadSeq) this._renderCandidates()
            return
        }

        let spec = null
        try {
            if (typeof AesAircraftSpec !== "undefined") {
                spec = await AesAircraftSpec.get({
                    aircraftId:  row.aircraftId,
                    typeId:      row.typeId,
                    equipment:   row.equipment,
                    server:      this.server,
                    airlineCode: this.airlineCode
                })
            }
        } catch (e) { /* non-fatal */ }
        this._spec = spec

        let settings = null
        try {
            if (typeof RouteAssistantSettings !== "undefined") {
                settings = await RouteAssistantSettings.load()
            }
        } catch (e) { /* non-fatal */ }
        this._settings = settings

        if (typeof AesAfpRouteCandidates === "undefined") {
            this._candidates = []
            if (seq === this._loadSeq) this._renderCandidates()
            return
        }

        let cands = []
        try {
            cands = await AesAfpRouteCandidates.compute({
                originIata: row.hub,
                spec,
                settings
            }) || []
        } catch (e) {
            console.warn("[AES FSG cockpit] candidates compute failed", e)
            cands = []
        }
        if (seq !== this._loadSeq) return

        const econ = (settings && settings.economics) || null
        if (econ && spec && typeof RouteAssistantProfitEstimator !== "undefined") {
            for (const c of cands) {
                try {
                    const est = RouteAssistantProfitEstimator.estimate({
                        distanceKm: c.distanceKm,
                        spec,
                        frequency:  7,
                        paxScore:   c.paxScore,
                        cargoScore: c.cargoScore,
                        economics:  econ,
                        falloffPct: 10
                    })
                    c._profitPerWeek = est.profitPerWeek
                    c._blockHours    = est.blockHours
                    c._profitFit     = est.fit
                } catch (e) { /* non-fatal */ }
            }
        }
        this._candidates = cands
        if (seq === this._loadSeq) this._renderCandidates()
    }

    _renderCandidates() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this._candEl.innerHTML = ""
        const cands = this._candidates

        const wrap = document.createElement("div")
        wrap.style.cssText = "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"

        const head = document.createElement("div")
        head.style.cssText = "padding:6px 10px;background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;"
            + "display:flex;align-items:center;gap:6px;"
        const ht = document.createElement("span")
        ht.textContent = "Candidates"
        head.appendChild(ht)
        const ct = document.createElement("span")
        ct.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";font-weight:400;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        ct.textContent = cands ? "(" + cands.length + ")" : "(loading…)"
        head.appendChild(ct)
        wrap.appendChild(head)

        if (!cands) {
            const loading = document.createElement("div")
            loading.style.cssText = "padding:18px;text-align:center;font-style:italic;font-size:11px;"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            loading.textContent = "Loading candidates…"
            wrap.appendChild(loading)
            this._candEl.appendChild(wrap)
            return
        }
        if (!cands.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:14px;text-align:center;font-style:italic;font-size:11px;line-height:1.5;"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            const row = this._getFleetRow(this._aircraftId)
            const hub = (row && row.hub) || ""
            empty.textContent = hub
                ? "No candidates from " + hub + ". Visit /app/info/airports/" + hub
                    + " or run a Route Assistant scan to seed demand data."
                : "No hub set on this aircraft — visit its Flight Plan tab to assign one."
            wrap.appendChild(empty)
            this._candEl.appendChild(wrap)
            return
        }

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"

        const thead = document.createElement("thead")
        const trH = document.createElement("tr")
        const cols = [
            {label: "DEST", align: "left"},
            {label: "PAX",  align: "right", title: "Pax demand score 0–10"},
            {label: "CAR",  align: "right", title: "Cargo demand score 0–10"},
            {label: "AL",   align: "right", title: "Airlines already on the route"},
            {label: "FIT",  align: "center", title: "Aircraft range fit"},
            {label: "$/wk", align: "right", title: "Profit per week (rough estimate at 7 freq)"}
        ]
        for (const c of cols) {
            const th = document.createElement("th")
            th.style.cssText = "padding:4px 6px;text-align:" + c.align + ";"
                + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
                + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "font-weight:700;text-transform:uppercase;letter-spacing:0.04em;font-size:9px;"
            th.textContent = c.label
            if (c.title) th.title = c.title
            trH.appendChild(th)
        }
        thead.appendChild(trH)
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        const top = cands.slice(0, 25)
        const fmt1 = n => (n == null || !isFinite(n)) ? "—" : Number(n).toFixed(1)
        const fmtInt = n => (n == null || !isFinite(n)) ? "—" : String(Math.round(n))
        const fmtMoney = n => {
            if (n == null || !isFinite(n)) return "—"
            const a = Math.abs(n)
            if (a >= 1e6) return (n / 1e6).toFixed(1) + "M"
            if (a >= 1e3) return Math.round(n / 1e3) + "k"
            return String(Math.round(n))
        }
        const fitStyle = (fit) => {
            if (fit === "optimal" || fit === "fit") return "color:" + (T ? T.color.moss : "#2F5F3F") + ";"
            if (fit === "tight" || fit === "falloff") return "color:" + (T ? T.color.amber : "#B8861F") + ";"
            if (fit === "oor") return "color:" + (T ? T.color.crimson : "#8B2727") + ";"
            return "color:" + (T ? T.color.slate : "#7A6F66") + ";"
        }
        for (const c of top) {
            const tr = document.createElement("tr")
            const isSel = (this._selectedDest === c.destIata)
            tr.style.cssText = "cursor:pointer;"
                + (isSel ? "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";" : "")
            tr.addEventListener("click", () => {
                this._selectedDest = (this._selectedDest === c.destIata) ? null : c.destIata
                this._renderCandidates()
                this._renderDetail()
            })
            tr.addEventListener("mouseenter", () => {
                if (!isSel) tr.style.background = T ? T.color.bone2 : "#ECE7DC"
            })
            tr.addEventListener("mouseleave", () => {
                if (!isSel) tr.style.background = "transparent"
            })

            const fit = c.aircraftFit || c.fits || ""
            const cells = [
                {text: c.destIata,                       align: "left",   bold: true},
                {text: fmt1(c.paxScore),                 align: "right"},
                {text: fmt1(c.cargoScore),               align: "right"},
                {text: fmtInt(c.airlineCount),           align: "right"},
                {text: fit || "—",                       align: "center", style: fitStyle(fit)},
                {text: fmtMoney(c._profitPerWeek),       align: "right"}
            ]
            for (const cell of cells) {
                const td = document.createElement("td")
                td.style.cssText = "padding:3px 6px;text-align:" + cell.align + ";"
                    + "border-bottom:1px solid " + (T ? T.color.bone2 : "#ECE7DC") + ";"
                    + (cell.bold ? "font-weight:700;" : "")
                    + (cell.style || "")
                td.textContent = cell.text
                tr.appendChild(td)
            }
            tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        wrap.appendChild(table)

        if (cands.length > top.length) {
            const note = document.createElement("div")
            note.style.cssText = "padding:4px 10px;font-size:10px;font-style:italic;"
                + "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            note.textContent = "Top 25 of " + cands.length + " — full list lives in the Flight Plan tab."
            wrap.appendChild(note)
        }
        this._candEl.appendChild(wrap)
    }

    _renderDetail() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this._detailEl.innerHTML = ""

        if (!this._selectedDest) {
            const hint = document.createElement("div")
            hint.style.cssText = "padding:10px;font-size:11px;font-style:italic;text-align:center;"
                + "border:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            hint.textContent = "Click a candidate above for ORS rank and competitor breakdown."
            this._detailEl.appendChild(hint)
            return
        }

        const row = this._getFleetRow(this._aircraftId)
        const hub = (row && row.hub) || ""
        const dest = this._selectedDest
        const cand = (this._candidates || []).find(c => c.destIata === dest)

        const wrap = document.createElement("div")
        wrap.style.cssText = "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"

        const head = document.createElement("div")
        head.style.cssText = "padding:6px 10px;background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;"
            + "display:flex;align-items:center;gap:6px;"
        const ht = document.createElement("span")
        ht.textContent = hub + " → " + dest
        head.appendChild(ht)
        if (cand && cand.distanceKm) {
            const dt = document.createElement("span")
            dt.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";font-weight:400;"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
            dt.textContent = "· " + Math.round(cand.distanceKm) + " km"
            head.appendChild(dt)
        }
        wrap.appendChild(head)

        const body = document.createElement("div")
        body.style.cssText = "padding:8px 10px;display:flex;flex-direction:column;gap:8px;font-size:11px;"
        wrap.appendChild(body)

        if (cand) {
            const stats = document.createElement("div")
            stats.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:2px 8px;"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
            const addStat = (k, v) => {
                const ek = document.createElement("span")
                ek.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";"
                    + "text-transform:uppercase;letter-spacing:0.04em;font-size:9px;"
                ek.textContent = k
                const ev = document.createElement("span")
                ev.style.fontSize = "11px"
                ev.textContent = v
                stats.append(ek, ev)
            }
            const fmt1 = n => (n == null || !isFinite(n)) ? "—" : Number(n).toFixed(1)
            addStat("Demand", "pax " + fmt1(cand.paxScore) + " · cargo " + fmt1(cand.cargoScore))
            addStat("Market", (cand.airlineCount != null ? cand.airlineCount : "—") + " airlines · "
                + (cand.weeklyFlights != null ? cand.weeklyFlights + " wkly flights" : "no freq data"))
            const fitTxt = (cand.aircraftFit || cand.fits || "—")
                + (cand._blockHours ? " · " + cand._blockHours.toFixed(1) + "h block RT" : "")
            addStat("Fit", fitTxt)
            if (cand._profitPerWeek != null) {
                const fmtM = n => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n) + ""
                addStat("Profit/wk", "$" + fmtM(cand._profitPerWeek) + " (rough · 7 freq)")
            }
            if (cand.notes) addStat("Notes", String(cand.notes))
            body.appendChild(stats)
        }

        // ORS · Competitor breakdown.
        const orsSection = document.createElement("div")
        orsSection.style.cssText = "border-top:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "padding-top:8px;"
        const orsHd = document.createElement("div")
        orsHd.style.cssText = "font-size:9px;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
            + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";margin-bottom:4px;"
        orsHd.textContent = "ORS · Competitors"
        const orsBody = document.createElement("div")
        orsBody.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;font-size:11px;"
        orsBody.textContent = "Loading…"
        orsSection.append(orsHd, orsBody)
        body.appendChild(orsSection)

        this._loadOrs(hub, dest, orsBody).catch(err => {
            orsBody.textContent = "ORS load failed."
            console.warn("[AES FSG cockpit] ORS load failed", err)
        })

        // External jump links.
        const linkRow = document.createElement("div")
        linkRow.style.cssText = "display:flex;gap:14px;font-size:10px;text-transform:uppercase;"
            + "letter-spacing:0.06em;border-top:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "padding-top:6px;"
        const mkLink = (label, href, title) => {
            const a = document.createElement("a")
            a.href = href
            a.target = "_blank"
            a.rel = "noopener"
            a.style.cssText = "color:" + (T ? T.color.rust : "#B8472A") + ";text-decoration:none;font-weight:700;"
            a.textContent = label
            a.title = title
            return a
        }
        linkRow.appendChild(mkLink("Markets ↗", "/app/com/markets/" + dest, "Open the markets page for " + dest))
        linkRow.appendChild(mkLink("Airport ↗", "/app/info/airports/" + dest, "Open the airport overview for " + dest))
        body.appendChild(linkRow)

        this._detailEl.appendChild(wrap)
    }

    async _loadOrs(hub, dest, container) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        if (typeof RouteAssistantOrsScraper === "undefined") {
            container.textContent = "ORS module not loaded."
            return
        }
        let rec = null
        try { rec = await RouteAssistantOrsScraper.loadRecord(hub, dest) }
        catch (e) { container.textContent = "ORS read error."; return }

        if (!rec || !rec.byClass) {
            container.style.fontStyle = "italic"
            container.style.color = T ? T.color.slate : "#7A6F66"
            container.textContent = "No ORS scrape cached for " + hub + " → " + dest
                + ". Run ORS from Route Assistant to populate."
            return
        }
        const cls = rec.byClass.ECONOMY || rec.byClass.BUSINESS || rec.byClass.FIRST || null
        if (!cls) {
            container.textContent = "ORS record has no class data."
            return
        }
        container.style.fontStyle = ""
        container.style.color = T ? T.color.oxide : "#2B2520"
        container.innerHTML = ""

        const summary = document.createElement("div")
        summary.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:2px 8px;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;margin-bottom:6px;"
        const addSm = (k, v) => {
            const ek = document.createElement("span")
            ek.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "text-transform:uppercase;letter-spacing:0.04em;font-size:9px;"
            ek.textContent = k
            const ev = document.createElement("span")
            ev.textContent = v
            summary.append(ek, ev)
        }
        const ourRank = (cls.rankAny != null) ? ("#" + cls.rankAny) : "—"
        const ourRating = (cls.ourTopRating != null) ? Number(cls.ourTopRating).toFixed(1) : "—"
        const topRating = (cls.topCompetitorRating != null) ? Number(cls.topCompetitorRating).toFixed(1) : "—"
        addSm("Our rank", ourRank + (cls.totalConnections != null ? " of " + cls.totalConnections : ""))
        addSm("Rating", "us " + ourRating + " · top comp " + topRating)
        if (cls.ratingGapToTop != null) {
            addSm("Gap", (cls.ratingGapToTop > 0 ? "+" : "") + Number(cls.ratingGapToTop).toFixed(1) + " pts")
        }
        if (rec.scrapedAt) addSm("Scraped", this._fmtAge(rec.scrapedAt))
        container.appendChild(summary)

        const conns = (cls.connections || []).slice(0, 6)
        if (!conns.length) {
            const none = document.createElement("div")
            none.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;font-size:11px;"
            none.textContent = "No connections in record."
            container.appendChild(none)
            return
        }
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:10px;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        const thr = document.createElement("tr")
        for (const lbl of ["#", "Carrier", "Rating", "Price"]) {
            const th = document.createElement("th")
            th.style.cssText = "padding:2px 6px;text-align:left;"
                + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
                + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "font-weight:700;text-transform:uppercase;letter-spacing:0.04em;font-size:9px;"
            th.textContent = lbl
            thr.appendChild(th)
        }
        tbl.appendChild(thr)
        conns.forEach((c, i) => {
            const tr = document.createElement("tr")
            const ours = c.legs && c.legs.some(l => l && l.isOurs)
            tr.style.cssText = ours
                ? "background:" + (T ? T.color.mossSoft : "rgba(47,95,63,0.14)") + ";font-weight:700;"
                : ""
            const firstLeg = c.legs && c.legs[0] || {}
            const carrier = firstLeg.carrier || firstLeg.flightCode || firstLeg.airline || "?"
            const cells = [
                String(i + 1),
                String(carrier),
                c.rating != null ? Number(c.rating).toFixed(1) : "—",
                c.totalPrice != null ? Math.round(c.totalPrice) + "" : "—"
            ]
            for (const v of cells) {
                const td = document.createElement("td")
                td.style.cssText = "padding:2px 6px;border-bottom:1px solid " + (T ? T.color.bone2 : "#ECE7DC") + ";"
                td.textContent = v
                tr.appendChild(td)
            }
            tbl.appendChild(tr)
        })
        container.appendChild(tbl)
        if ((cls.connections || []).length > conns.length) {
            const note = document.createElement("div")
            note.style.cssText = "padding-top:3px;font-size:9px;font-style:italic;"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            note.textContent = "Top 6 of " + cls.connections.length + " connections."
            container.appendChild(note)
        }
    }

    _fmtAge(ts) {
        if (!ts) return "(unknown)"
        const ms = Date.now() - ts
        if (ms < 60_000)     return Math.floor(ms / 1000) + "s ago"
        if (ms < 3600_000)   return Math.floor(ms / 60_000) + "m ago"
        if (ms < 86_400_000) return Math.floor(ms / 3600_000) + "h ago"
        return Math.floor(ms / 86_400_000) + "d ago"
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridAircraftCockpit = FleetScheduleGridAircraftCockpit
}
