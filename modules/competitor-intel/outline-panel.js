"use strict"

/**
 * Competitor Outline panel — full-screen overlay rendering the
 * outline-aggregator output. Two synced views mounted in one shell:
 *
 *   - Left rail: competitor list (search, sort by threat / route count /
 *                share). Click a competitor to focus the main pane.
 *   - Main pane: selected competitor's full route table with all the
 *                fields the user wanted in "one outline" — HUB→DEST,
 *                their price/freq/aircraft/age/ORS/est income, our
 *                presence, verdict, counter-aircraft recommendation,
 *                and an Assign button that emits `open-tile` so the
 *                Route Assistant or AFP tile picks up the route +
 *                suggested tail.
 *
 * Mount once via `AesCompetitorOutlinePanel.show({server})`. The panel
 * lives directly under `document.body` and closes itself on × / Escape.
 */
class AesCompetitorOutlinePanel {
    static _instance = null

    static async show(opts) {
        if (AesCompetitorOutlinePanel._instance) {
            // Already open — just refresh.
            AesCompetitorOutlinePanel._instance.refresh()
            return AesCompetitorOutlinePanel._instance
        }
        const inst = new AesCompetitorOutlinePanel(opts || {})
        AesCompetitorOutlinePanel._instance = inst
        await inst.mount()
        return inst
    }

    constructor(opts) {
        this.server = opts.server || ""
        this.outline = null
        this.selectedId = null
        this.searchQuery = ""
        this.sortKey = "threat"
        this.root = null
        this.scoreboardEl = null
        this.listEl = null
        this.mainEl = null
        this.statusEl = null
        this._keyHandler = null
    }

    async mount() {
        const T = window.AESTokens
        const root = document.createElement("div")
        root.className = "aes-competitor-outline-panel"
        root.style.cssText = [
            "position:fixed", "inset:0", "z-index:9999",
            "background:" + T.color.oxide + "ee",
            "display:flex", "flex-direction:column",
            "font-family:" + T.font.display
        ].join(";")

        const inner = document.createElement("div")
        inner.style.cssText = [
            "flex:1 1 auto",
            "margin:" + T.sp[3],
            "background:" + T.color.bone,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "display:flex", "flex-direction:column",
            "overflow:hidden"
        ].join(";")

        // Header
        const header = this._buildHeader(T)
        inner.appendChild(header)

        // Threat scoreboard strip
        const scoreboard = document.createElement("div")
        scoreboard.style.cssText = [
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "overflow-x:auto", "white-space:nowrap"
        ].join(";")
        this.scoreboardEl = scoreboard
        inner.appendChild(scoreboard)

        // Body — left rail + main
        const body = document.createElement("div")
        body.style.cssText = "flex:1 1 auto;display:flex;min-height:0;"
        const list = document.createElement("div")
        list.style.cssText = [
            "flex:0 0 280px",
            "border-right:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "overflow:auto",
            "padding:" + T.sp[2] + " 0"
        ].join(";")
        const main = document.createElement("div")
        main.style.cssText = [
            "flex:1 1 auto",
            "overflow:auto",
            "padding:" + T.sp[3]
        ].join(";")
        body.append(list, main)
        inner.appendChild(body)

        // Status footer
        const status = document.createElement("div")
        status.style.cssText = [
            "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "color:" + T.color.slate,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro
        ].join(";")
        status.textContent = "Loading…"
        this.statusEl = status
        inner.appendChild(status)

        root.appendChild(inner)
        document.body.appendChild(root)
        this.root = root
        this.listEl = list
        this.mainEl = main

        this._keyHandler = (e) => { if (e.key === "Escape") this.close() }
        document.addEventListener("keydown", this._keyHandler)

        await this.refresh()
    }

    _buildHeader(T) {
        const header = document.createElement("div")
        header.style.cssText = [
            "display:flex", "align-items:center", "gap:" + T.sp[3],
            "padding:" + T.sp[2] + " " + T.sp[3],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + T.color.bone2
        ].join(";")

        const title = document.createElement("h2")
        title.textContent = "COMPETITOR OUTLINE"
        title.style.cssText = [
            "margin:0",
            "font-size:" + T.fs.h3,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.oxide,
            "flex:0 0 auto"
        ].join(";")

        const sub = document.createElement("span")
        sub.textContent = "server: " + this.server
        sub.style.cssText = [
            "color:" + T.color.slate,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "flex:1 1 auto"
        ].join(";")

        const search = document.createElement("input")
        search.placeholder = "search rivals…"
        search.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "min-width:200px"
        ].join(";")
        search.addEventListener("input", () => {
            this.searchQuery = search.value || ""
            this._renderList()
        })

        const sort = document.createElement("select")
        sort.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body
        ].join(";")
        const sortOptions = [
            ["threat", "Sort: Threat"],
            ["routes", "Sort: Route count"],
            ["flights", "Sort: Weekly flights"],
            ["name", "Sort: Name"]
        ]
        for (const [v, l] of sortOptions) {
            const o = document.createElement("option")
            o.value = v
            o.textContent = l
            sort.appendChild(o)
        }
        sort.addEventListener("change", () => {
            this.sortKey = sort.value
            this._renderList()
        })

        const refresh = document.createElement("button")
        refresh.type = "button"
        refresh.textContent = "↻ Refresh"
        refresh.style.cssText = this._btnCss(T, false)
        refresh.addEventListener("click", () => this._handleRefresh(refresh))

        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "× Close"
        close.style.cssText = this._btnCss(T, false)
        close.addEventListener("click", () => this.close())

        header.append(title, sub, search, sort, refresh, close)
        return header
    }

    _btnCss(T, primary) {
        return [
            "background:" + (primary ? T.color.oxide : "transparent"),
            "color:"      + (primary ? T.color.bone : T.color.oxide),
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer",
            "flex:0 0 auto"
        ].join(";")
    }

    async refresh() {
        if (!this.statusEl) return
        this.statusEl.textContent = "Aggregating…"
        try {
            this.outline = await window.AesCompetitorOutlineAggregator.build({
                server: this.server
            })
            if (!this.selectedId && this.outline.competitors.length) {
                this.selectedId = this.outline.competitors[0].enterpriseId
            }
            this._renderScoreboard()
            this._renderList()
            this._renderMain()
            this.statusEl.textContent = this._statusText()
        } catch (e) {
            console.warn("[AES competitor-outline] aggregator failed", e)
            this.statusEl.textContent = "Aggregator error — see console"
        }
    }

    _statusText() {
        if (!this.outline) return ""
        const o = this.outline
        return [
            o.competitors.length + " competitors",
            o.totalRoutes + " routes",
            o.uncontested + " uncontested lanes",
            "scraped " + this._fmtAgo(o.scrapedAt)
        ].join(" · ")
    }

    _fmtAgo(ms) {
        if (!ms) return "—"
        const d = Date.now() - ms
        if (d < 60000) return "just now"
        if (d < 3600000) return Math.round(d / 60000) + "m ago"
        if (d < 86400000) return Math.round(d / 3600000) + "h ago"
        return Math.round(d / 86400000) + "d ago"
    }

    _renderScoreboard() {
        const T = window.AESTokens
        if (!this.scoreboardEl) return
        this.scoreboardEl.textContent = ""
        const top = (this.outline.competitors || [])
            .slice()
            .sort((a, b) => (b.summary.threatScore || 0) - (a.summary.threatScore || 0))
            .slice(0, 8)
        if (!top.length) {
            const empty = document.createElement("span")
            empty.style.cssText = "color:" + T.color.slate + ";font-style:italic;"
            empty.textContent = "No competitors tracked yet — visit /app/info/airports/<id> or /app/info/enterprises/<id> on this server to seed data."
            this.scoreboardEl.appendChild(empty)
            return
        }
        for (const c of top) {
            const card = document.createElement("button")
            card.type = "button"
            card.style.cssText = [
                "display:inline-flex", "flex-direction:column", "gap:" + T.sp[0],
                "min-width:160px", "max-width:240px",
                "padding:" + T.sp[1] + " " + T.sp[2],
                "margin-right:" + T.sp[2],
                "background:" + (this.selectedId === c.enterpriseId ? T.color.oxide : T.color.bone),
                "color:"      + (this.selectedId === c.enterpriseId ? T.color.bone : T.color.oxide),
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "border-radius:" + T.geom.radius,
                "cursor:pointer", "vertical-align:top",
                "text-align:left", "white-space:normal"
            ].join(";")
            const name = document.createElement("strong")
            name.textContent = (c.code ? "[" + c.code + "] " : "") + c.name
            name.style.cssText = "font-size:" + T.fs.body + ";"
            const sub = document.createElement("span")
            sub.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
            sub.textContent = "threat " + c.summary.threatScore
                + " · " + c.summary.totalRoutes + " routes"
                + (c.summary.counterableRoutes > 0
                    ? " · " + c.summary.counterableRoutes + " counter"
                    : "")
                + (c.summary.uncontestedRoutes > 0
                    ? " · " + c.summary.uncontestedRoutes + " open"
                    : "")
            card.append(name, sub)
            card.addEventListener("click", () => {
                this.selectedId = c.enterpriseId
                this._renderScoreboard()
                this._renderList()
                this._renderMain()
            })
            this.scoreboardEl.appendChild(card)
        }
    }

    _renderList() {
        const T = window.AESTokens
        if (!this.listEl) return
        this.listEl.textContent = ""
        const competitors = this._filteredSortedCompetitors()
        if (!competitors.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "padding:" + T.sp[3] + ";color:" + T.color.slate + ";margin:0;"
            empty.textContent = "No matches."
            this.listEl.appendChild(empty)
            return
        }
        for (const c of competitors) {
            const row = document.createElement("button")
            row.type = "button"
            const isSel = c.enterpriseId === this.selectedId
            row.style.cssText = [
                "display:block", "width:100%", "text-align:left",
                "padding:" + T.sp[2] + " " + T.sp[3],
                "background:" + (isSel ? T.color.bone2 : "transparent"),
                "border:none",
                "border-left:" + (isSel ? "3px solid " + T.color.rust : "3px solid transparent"),
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "cursor:pointer", "font-family:" + T.font.display
            ].join(";")
            const head = document.createElement("div")
            head.style.cssText = "display:flex;align-items:baseline;gap:" + T.sp[2] + ";"
            const name = document.createElement("strong")
            name.textContent = c.name
            name.style.cssText = "color:" + T.color.oxide + ";font-size:" + T.fs.body + ";"
            const code = document.createElement("span")
            code.textContent = c.code || ""
            code.style.cssText = "color:" + T.color.cobalt + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
            head.append(name, code)
            const sub = document.createElement("div")
            sub.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";margin-top:2px;"
            sub.textContent = "threat " + c.summary.threatScore
                + " · " + c.summary.totalRoutes + " routes"
                + " · " + c.summary.totalWeeklyFlights + " flights/wk"
            row.append(head, sub)
            row.addEventListener("click", () => {
                this.selectedId = c.enterpriseId
                this._renderScoreboard()
                this._renderList()
                this._renderMain()
            })
            this.listEl.appendChild(row)
        }
    }

    _filteredSortedCompetitors() {
        if (!this.outline) return []
        let out = (this.outline.competitors || []).slice()
        const q = this.searchQuery.trim().toLowerCase()
        if (q) {
            out = out.filter(c =>
                (c.name || "").toLowerCase().indexOf(q) >= 0
                || (c.code || "").toLowerCase().indexOf(q) >= 0
                || (c.alliance && (c.alliance.name || "").toLowerCase().indexOf(q) >= 0))
        }
        const cmp = {
            threat:  (a, b) => (b.summary.threatScore || 0) - (a.summary.threatScore || 0),
            routes:  (a, b) => (b.summary.totalRoutes || 0) - (a.summary.totalRoutes || 0),
            flights: (a, b) => (b.summary.totalWeeklyFlights || 0) - (a.summary.totalWeeklyFlights || 0),
            name:    (a, b) => String(a.name || "").localeCompare(String(b.name || ""))
        }[this.sortKey] || ((a, b) => 0)
        out.sort(cmp)
        return out
    }

    _renderMain() {
        const T = window.AESTokens
        if (!this.mainEl) return
        this.mainEl.textContent = ""
        if (!this.outline) return
        const c = (this.outline.competitors || []).find(x => x.enterpriseId === this.selectedId)
        if (!c) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Pick a competitor to see their routes."
            this.mainEl.appendChild(empty)
            return
        }

        // Heading with key meta
        const head = document.createElement("div")
        head.style.cssText = "margin-bottom:" + T.sp[3] + ";"
        const h = document.createElement("h3")
        h.textContent = c.name + (c.code ? " (" + c.code + ")" : "")
        h.style.cssText = "margin:0 0 " + T.sp[1] + " 0;font-size:" + T.fs.h3
            + ";font-weight:" + T.fw.display + ";text-transform:uppercase;letter-spacing:" + T.track.caps
            + ";color:" + T.color.oxide + ";"
        head.appendChild(h)
        const meta = document.createElement("div")
        meta.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.micro + ";"
        const metaParts = []
        if (c.alliance && c.alliance.name) metaParts.push("alliance: " + c.alliance.name)
        if (c.baseCountry && c.baseCountry.name) metaParts.push(c.baseCountry.name)
        if (c.fleet && c.fleet.totalCount != null) {
            metaParts.push(c.fleet.totalCount + " aircraft")
        }
        if (c.summary.dominantTypes) metaParts.push("dominant: " + c.summary.dominantTypes)
        meta.textContent = metaParts.join(" · ") || "—"
        head.appendChild(meta)
        this.mainEl.appendChild(head)

        // Fleet-by-type strip
        if (c.fleet && Array.isArray(c.fleet.byType) && c.fleet.byType.length) {
            const fleetBox = document.createElement("div")
            fleetBox.style.cssText = "margin-bottom:" + T.sp[3]
                + ";padding:" + T.sp[2]
                + ";background:" + T.color.bone2
                + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule
                + ";border-radius:" + T.geom.radius + ";"
            const fHead = document.createElement("strong")
            fHead.textContent = "Fleet composition"
            fHead.style.cssText = "display:block;font-size:" + T.fs.body
                + ";color:" + T.color.oxide + ";margin-bottom:" + T.sp[1] + ";"
            fleetBox.appendChild(fHead)
            const fList = document.createElement("div")
            fList.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2] + ";"
            for (const f of c.fleet.byType) {
                const chip = document.createElement("span")
                chip.style.cssText = "padding:" + T.sp[0] + " " + T.sp[2]
                    + ";background:" + T.color.bone
                    + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule
                    + ";border-radius:" + T.geom.radius
                    + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                const ageLabel = f.avgAgeMonths != null
                    ? " · " + this._fmtAge(f.avgAgeMonths) + " avg"
                    : ""
                chip.textContent = (f.typeCode || "?") + " ×" + f.count + ageLabel
                fList.appendChild(chip)
            }
            fleetBox.appendChild(fList)
            this.mainEl.appendChild(fleetBox)
        }

        if (!c.routes.length) {
            this._renderEmpty(this.mainEl, "No routes scraped yet for this competitor. Visit their profile or hit Refresh.")
            return
        }

        const table = this._buildRouteTable(c, T)
        this.mainEl.appendChild(table)
    }

    _renderEmpty(host, msg) {
        const T = window.AESTokens
        const p = document.createElement("p")
        p.style.cssText = "color:" + T.color.slate + ";margin:0;"
        p.textContent = msg
        host.appendChild(p)
    }

    _buildRouteTable(c, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "overflow:auto;border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";border-radius:" + T.geom.radius + ";"
        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-family:"
            + T.font.mono + ";font-size:" + T.fs.body + ";"
        const thead = document.createElement("thead")
        const headRow = document.createElement("tr")
        headRow.style.cssText = "background:" + T.color.bone2 + ";text-align:left;"
        const cols = [
            "ROUTE",
            "THEIR PRICE",
            "THEIR FREQ",
            "THEIR AC",
            "AGE",
            "THEIR ORS",
            "THEIR INCOME (est)",
            "OUR PRESENCE",
            "VERDICT",
            "COUNTER",
            ""
        ]
        for (const col of cols) {
            const th = document.createElement("th")
            th.textContent = col
            th.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2]
                + ";font-family:" + T.font.display + ";font-size:" + T.fs.micro
                + ";letter-spacing:" + T.track.caps + ";color:" + T.color.oxide
                + ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
            headRow.appendChild(th)
        }
        thead.appendChild(headRow)
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        for (const r of c.routes) {
            tbody.appendChild(this._buildRouteTr(r, T))
        }
        table.appendChild(tbody)
        wrap.appendChild(table)
        return wrap
    }

    _buildRouteTr(r, T) {
        const tr = document.createElement("tr")
        tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"

        const verdictTone = this._verdictTone(r.counter && r.counter.verdict, T)

        const td = (text, opts) => {
            const c = document.createElement("td")
            c.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";"
                + (opts && opts.color ? "color:" + opts.color + ";" : "")
                + (opts && opts.bg ? "background:" + opts.bg + ";" : "")
                + (opts && opts.weight ? "font-weight:" + opts.weight + ";" : "")
                + (opts && opts.align ? "text-align:" + opts.align + ";" : "")
            if (text instanceof Node) c.appendChild(text)
            else c.textContent = (text == null || text === "") ? "—" : String(text)
            return c
        }

        const route = r.hub + " → " + r.dest + (r.distanceKm
            ? " · " + Math.round(r.distanceKm) + "km" : "")
        tr.appendChild(td(route, {weight: "600"}))
        tr.appendChild(td(r.theirs.price ? this._fmtMoney(r.theirs.price) : null))
        tr.appendChild(td(r.theirs.freq ? r.theirs.freq + "/wk" : null))
        const acText = r.theirs.aircraftType
            ? r.theirs.aircraftType + (r.theirs.seats ? " (" + r.theirs.seats + ")" : "")
            : null
        tr.appendChild(td(acText))
        tr.appendChild(td(r.theirs.aircraftAgeMonths != null
            ? this._fmtAge(r.theirs.aircraftAgeMonths) : null))
        tr.appendChild(td(r.theirs.ors != null ? String(r.theirs.ors) : null))
        const incomeText = r.theirs.estProfitPerWeek != null
            ? this._fmtMoney(r.theirs.estProfitPerWeek) + "/wk"
                + (r.theirs.incomeConfidence ? " (" + r.theirs.incomeConfidence + ")" : "")
            : null
        tr.appendChild(td(incomeText))
        const ourText = r.ours.hasFlights
            ? (r.ours.estProfitPerWeek != null
                ? this._fmtMoney(r.ours.estProfitPerWeek) + "/wk"
                : "active") + (r.ours.ors != null ? " · ORS " + r.ours.ors : "")
            : "(none)"
        tr.appendChild(td(ourText, {color: r.ours.hasFlights ? T.color.cobalt : T.color.slate}))

        const verdictBadge = document.createElement("span")
        verdictBadge.textContent = this._verdictLabel(r.counter && r.counter.verdict)
        verdictBadge.style.cssText = "display:inline-block;padding:" + T.sp[0] + " " + T.sp[2]
            + ";background:" + verdictTone.bg + ";color:" + verdictTone.color
            + ";border-radius:" + T.geom.radius
            + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro
            + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;"
        tr.appendChild(td(verdictBadge))

        tr.appendChild(td(this._counterText(r.counter)))

        const assign = this._buildAssignButton(r, T)
        tr.appendChild(td(assign, {align: "right"}))
        return tr
    }

    _verdictLabel(v) {
        return ({
            "we-already-win": "we lead",
            "tail-available": "assign tail",
            "buy-needed":     "buy to win",
            "uncontested":    "open lane",
            "out-of-range":   "out of range",
            "no-data":        "no data"
        })[v] || (v || "—")
    }

    _verdictTone(v, T) {
        switch (v) {
            case "we-already-win": return {bg: T.color.mossSoft || T.color.bone2, color: T.color.moss || T.color.oxide}
            case "tail-available": return {bg: T.color.cobaltSoft || T.color.bone2, color: T.color.cobalt}
            case "buy-needed":     return {bg: T.color.amberSoft  || T.color.bone2, color: T.color.amber}
            case "uncontested":    return {bg: T.color.bone2, color: T.color.cobalt}
            case "out-of-range":   return {bg: T.color.bone2, color: T.color.slate}
            default: return {bg: T.color.bone2, color: T.color.slate}
        }
    }

    _counterText(counter) {
        if (!counter) return null
        if (counter.bestExistingTail) {
            const t = counter.bestExistingTail
            const delta = (t.deltaVsThem != null)
                ? " (Δ " + this._fmtMoney(t.deltaVsThem) + "/wk)"
                : ""
            const where = t.hubMismatch ? " · @" + t.hub : ""
            return (t.registration || "tail") + " · " + (t.typeCode || "?") + delta + where
        }
        if (counter.bestPurchaseType) {
            const p = counter.bestPurchaseType
            const delta = (p.deltaVsThem != null)
                ? " (Δ " + this._fmtMoney(p.deltaVsThem) + "/wk)"
                : ""
            const reason = p.reason ? " · " + p.reason : ""
            return "buy " + (p.typeCode || "?") + delta + reason
        }
        return null
    }

    _buildAssignButton(r, T) {
        const btn = document.createElement("button")
        btn.type = "button"
        const counter = r.counter
        const can = counter && (counter.bestExistingTail || counter.bestPurchaseType)
        btn.textContent = can ? "Assign →" : "Open"
        btn.style.cssText = [
            "background:" + (can ? T.color.rust : "transparent"),
            "color:" + (can ? T.color.bone : T.color.oxide),
            "border:" + T.geom.bw1 + " solid " + (can ? T.color.rust : T.color.paperRule),
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[0] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        btn.addEventListener("click", () => this._handleAssign(r))
        return btn
    }

    _handleAssign(r) {
        const tail = r.counter && r.counter.bestExistingTail
        // Best UX: navigate the user to where they can actually create the
        // counter flight. If we have a suggested existing tail, jump to its
        // Aircraft Flight Plan page; otherwise jump to the hub's scheduling
        // page. We also persist a tiny handoff payload so the destination
        // page can read the suggested route + tail and prefill its UI.
        const handoff = {
            source:    "competitor-outline",
            hub:       r.hub,
            dest:      r.dest,
            counter:   r.counter || null,
            createdAt: Date.now()
        }
        try {
            chrome.storage.local.set({"competitorIntel:assignHandoff": handoff})
        } catch (e) { /* best-effort */ }

        // Emit bus events for any tile already listening on this page.
        if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
            window.CentralHubBus.emit("focus-route", {
                hub: r.hub, dest: r.dest, source: "competitor-outline"
            })
        }

        // Navigate.
        const baseHost = window.location.host
        if (tail && tail.aircraftId) {
            window.location.href = "https://" + baseHost
                + "/app/fleets/aircraft/" + encodeURIComponent(tail.aircraftId) + "/0"
            return
        }
        window.location.href = "https://" + baseHost
            + "/app/com/scheduling/" + encodeURIComponent(r.hub)
        this.close()
    }

    async _handleRefresh(btn) {
        btn.disabled = true
        const original = btn.textContent
        btn.textContent = "↻ Refreshing…"
        try {
            if (typeof AesCompetitorOutlineRunner !== "undefined") {
                await AesCompetitorOutlineRunner.runForServer({server: this.server})
            }
            await this.refresh()
        } catch (e) {
            console.warn("[AES competitor-outline] refresh failed", e)
        } finally {
            btn.disabled = false
            btn.textContent = original
        }
    }

    _fmtMoney(n) {
        if (n == null || !isFinite(n)) return "—"
        const abs = Math.abs(n)
        if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B"
        if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M"
        if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k"
        return String(Math.round(n))
    }

    _fmtAge(months) {
        if (months == null || !isFinite(months)) return "—"
        if (months < 12) return months + "mo"
        const y = Math.floor(months / 12)
        const m = months % 12
        return m ? y + "y " + m + "m" : y + "y"
    }

    close() {
        if (this._keyHandler) {
            document.removeEventListener("keydown", this._keyHandler)
            this._keyHandler = null
        }
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root)
        this.root = null
        AesCompetitorOutlinePanel._instance = null
    }
}

if (typeof window !== "undefined") {
    window.AesCompetitorOutlinePanel = AesCompetitorOutlinePanel
}
