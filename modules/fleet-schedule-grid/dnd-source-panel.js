"use strict"

/**
 * Fleet Schedule Grid — drag source panel (Side-rail "Drag destinations" tab).
 *
 * Lists draggable destination cards the user can drop onto a lane in the grid.
 * Sources, in priority order:
 *   1. Free-text IATA input — types any 3-letter code, presses Enter to add
 *      it as a one-off card. Always available, no setup required.
 *   2. Cached hub routes from Route Assistant top-routes / FlightsFrom.
 *   3. RouteAssistantWatchlistStore — entries the user has starred elsewhere.
 *
 * Each card is `draggable=true` and stamps a JSON payload onto
 * `dataTransfer` under `application/x-aes-dnd-dest`:
 *   {destIata, destName, distanceKm?, score?, source?}
 *
 * The panel doesn't own the drop bridge — that lives in `dnd-grid-bridge.js`.
 */
class FleetScheduleGridDndSourcePanel {

    static DT_TYPE = "application/x-aes-dnd-dest"

    constructor(opts) {
        const o = opts || {}
        this.server      = o.server || ""
        this.airlineCode = o.airlineCode || ""
        this.activeHub   = o.activeHub ? String(o.activeHub).toUpperCase() : ""
        this.schedules   = o.schedules instanceof Map ? o.schedules : new Map()
        this.fleet       = Array.isArray(o.fleet) ? o.fleet : []
        this.paneEl      = null
        this._listEl     = null
        this._customCards = []   // user-typed, in-memory only
    }

    update(opts) {
        const o = opts || {}
        if (o.activeHub !== undefined) this.activeHub = o.activeHub ? String(o.activeHub).toUpperCase() : ""
        if (o.schedules !== undefined) this.schedules = o.schedules instanceof Map ? o.schedules : new Map()
        if (o.fleet !== undefined) this.fleet = Array.isArray(o.fleet) ? o.fleet : []
    }

    buildPane() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const pane = document.createElement("div")
        pane.style.cssText = "padding:10px 12px;display:flex;flex-direction:column;gap:10px;"

        // Free-text adder.
        const adder = document.createElement("div")
        adder.style.cssText = "display:flex;flex-direction:column;gap:4px;"
            + "padding:8px;background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        const adderTitle = document.createElement("div")
        adderTitle.style.cssText = this._sectionTitleCss(T)
        adderTitle.textContent = "Add destination"
        const adderRow = document.createElement("div")
        adderRow.style.cssText = "display:flex;gap:6px;align-items:stretch;"
        const iataInput = document.createElement("input")
        iataInput.type = "text"
        iataInput.maxLength = 3
        iataInput.placeholder = "IATA"
        iataInput.style.cssText = "flex:0 0 60px;padding:4px 6px;font-size:12px;"
            + "border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "text-transform:uppercase;text-align:center;font-weight:700;"
        const nameInput = document.createElement("input")
        nameInput.type = "text"
        nameInput.placeholder = "Name (optional)"
        nameInput.style.cssText = "flex:1 1 auto;padding:4px 6px;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
        const addBtn = document.createElement("button")
        addBtn.type = "button"
        addBtn.textContent = "+ Add"
        addBtn.style.cssText = "padding:4px 8px;cursor:pointer;font-size:11px;"
            + "background:" + (T ? T.color.rust : "#B8472A") + ";"
            + "color:" + (T ? T.color.rustFg : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.rustDeep : "#8B3520") + ";"
            + "font-weight:700;"
        const submit = () => {
            const code = (iataInput.value || "").trim().toUpperCase()
            if (!/^[A-Z]{3}$/.test(code)) {
                iataInput.style.borderColor = (T ? T.color.crimson : "#8B2727")
                setTimeout(() => { iataInput.style.borderColor = (T ? T.color.oxide2 : "#4A413B") }, 600)
                return
            }
            if (!this._customCards.find(c => c.destIata === code)) {
                this._customCards.unshift({destIata: code, destName: (nameInput.value || "").trim() || code, source: "manual"})
            }
            iataInput.value = ""; nameInput.value = ""
            iataInput.focus()
            this._renderList()
        }
        addBtn.addEventListener("click", submit)
        iataInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit() } })
        nameInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit() } })
        adderRow.append(iataInput, nameInput, addBtn)
        adder.append(adderTitle, adderRow)
        pane.appendChild(adder)

        const note = document.createElement("div")
        note.style.cssText = "font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;"
        note.textContent = "Drag a route card onto any aircraft-wave cell."
        pane.appendChild(note)

        // List host.
        const listEl = document.createElement("div")
        listEl.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        pane.appendChild(listEl)
        this._listEl = listEl

        this.paneEl = pane
        return pane
    }

    async refresh() {
        if (!this._listEl) return
        await this._renderList()
    }

    async _renderList() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this._listEl.innerHTML = ""

        // Custom (user-typed) section.
        if (this._customCards.length) {
            const h = document.createElement("div")
            h.style.cssText = this._sectionTitleCss(T)
            h.textContent = "Custom (" + this._customCards.length + ")"
            this._listEl.appendChild(h)
            for (const c of this._customCards) this._listEl.appendChild(this._buildCard(c, T, true))
        }

        const routeCards = await this._loadRouteCards()
        if (routeCards.length) {
            const h = document.createElement("div")
            h.style.cssText = this._sectionTitleCss(T) + "margin-top:8px;"
            h.textContent = "Routes (" + routeCards.length + ")"
            this._listEl.appendChild(h)
            for (const c of routeCards) this._listEl.appendChild(this._buildCard(c, T, false))
        }

        if (!this._customCards.length && !routeCards.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "font-style:italic;padding:8px 0;"
            empty.textContent = this.activeHub
                ? "No cached routes for " + this.activeHub + " yet — type an IATA above to add one."
                : "No destinations yet — type an IATA above to add one."
            this._listEl.appendChild(empty)
        }
    }

    async _loadRouteCards() {
        const byDest = new Map()
        const scheduled = this._scheduledDestinations()
        const [topRoutes, ffRoutes, watchlistCards] = await Promise.all([
            this._loadTopRoutes(),
            this._loadFlightsFromRoutes(),
            this._loadWatchlist()
        ])
        for (const c of topRoutes) this._mergeCard(byDest, c)
        for (const c of ffRoutes) this._mergeCard(byDest, c)
        for (const c of watchlistCards) this._mergeCard(byDest, c)

        const cards = Array.from(byDest.values())
        if (typeof RouteAssistantDemandStore !== "undefined") {
            try {
                const demand = await RouteAssistantDemandStore.getMany(cards.map(c => c.destIata))
                for (const c of cards) {
                    const d = demand && demand.get ? demand.get(c.destIata) : null
                    if (d) {
                        if (!c.destName && d.name) c.destName = d.name
                        if (c.paxScore == null && typeof d.paxScore === "number") c.paxScore = d.paxScore
                        if (c.cargoScore == null && typeof d.cargoScore === "number") c.cargoScore = d.cargoScore
                    }
                }
            } catch (_) { /* non-fatal */ }
        }

        for (const c of cards) c.alreadyScheduled = scheduled.has(c.destIata)
        cards.sort((a, b) => {
            if (!!a.alreadyScheduled !== !!b.alreadyScheduled) return a.alreadyScheduled ? 1 : -1
            const as = Number.isFinite(Number(a.score)) ? Number(a.score) : -Infinity
            const bs = Number.isFinite(Number(b.score)) ? Number(b.score) : -Infinity
            if (bs !== as) return bs - as
            return String(a.destIata).localeCompare(String(b.destIata))
        })
        return cards.slice(0, 60)
    }

    _mergeCard(map, card) {
        if (!map || !card) return
        const code = String(card.destIata || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(code)) return
        if (this.activeHub && code === this.activeHub) return
        const prev = map.get(code)
        if (!prev) {
            map.set(code, Object.assign({}, card, {
                destIata: code,
                destName: card.destName || "",
                sources:  new Set(card.source ? [card.source] : [])
            }))
            return
        }
        if (card.source) prev.sources.add(card.source)
        if (!prev.destName && card.destName) prev.destName = card.destName
        const fields = ["distanceKm", "distanceNm", "blockMin", "score", "paxScore", "cargoScore", "weeklyFlights", "suggestedDepTime", "stationTurnMin"]
        for (const f of fields) {
            if (prev[f] == null && card[f] != null) prev[f] = card[f]
        }
    }

    async _loadTopRoutes() {
        const hub = this.activeHub
        if (!hub || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return []
        const keys = ["routeAssistant:topRoutes:" + hub, "routeAssistant:topRoutes"]
        if (typeof acctKey === "function") {
            try {
                const scoped = acctKey("routeAssistant:topRoutes", hub)
                if (scoped && keys.indexOf(scoped) < 0) keys.unshift(scoped)
            } catch (_) {}
        }
        try {
            const out = await chrome.storage.local.get(keys)
            const cards = []
            for (const key of keys) {
                const blob = out && out[key]
                if (!blob || !Array.isArray(blob.rows)) continue
                if (blob.hub && String(blob.hub).toUpperCase() !== hub) continue
                for (const r of blob.rows) {
                    const code = String(r && r.destIata || "").toUpperCase()
                    if (!/^[A-Z]{3}$/.test(code)) continue
                    cards.push({
                        destIata:      code,
                        destName:      r.destName || "",
                        distanceKm:    this._numberOrNull(r.distanceKm),
                        score:         this._numberOrNull(r.score),
                        paxScore:      this._numberOrNull(r.paxScore),
                        cargoScore:    this._numberOrNull(r.cargoScore),
                        weeklyFlights: this._numberOrNull(r.weeklyFlights),
                        source:        "top"
                    })
                }
                if (cards.length) break
            }
            return cards
        } catch (_) { return [] }
    }

    async _loadFlightsFromRoutes() {
        const hub = this.activeHub
        if (!hub || typeof FlightsFromStore === "undefined") return []
        try {
            const rec = await FlightsFromStore.loadAirport(hub)
            const routes = rec && Array.isArray(rec.routes) ? rec.routes : []
            return routes.map(r => ({
                destIata:      String(r && r.destIata || "").toUpperCase(),
                destName:      (r && (r.destName || r.name)) || "",
                distanceKm:    this._numberOrNull(r && r.distanceKm),
                weeklyFlights: this._numberOrNull(r && r.weeklyFlights),
                source:        "ff"
            })).filter(c => /^[A-Z]{3}$/.test(c.destIata))
        } catch (_) { return [] }
    }

    async _loadWatchlist() {
        if (typeof RouteAssistantWatchlistStore === "undefined") return []
        try {
            if (typeof RouteAssistantWatchlistStore.loadAll === "function") {
                const map = await RouteAssistantWatchlistStore.loadAll()
                const out = []
                if (map && typeof map.forEach === "function") {
                    map.forEach((rec, key) => {
                        const parsed = this._parseRouteKey(key)
                        if (!parsed) return
                        if (this.activeHub && parsed.hub && parsed.hub !== this.activeHub) return
                        out.push({
                            destIata: parsed.dest,
                            destName: (rec && (rec.destName || rec.name)) || parsed.dest,
                            source:   "watch"
                        })
                    })
                }
                return out
            }
            if (typeof RouteAssistantWatchlistStore.list === "function") {
                const list = await RouteAssistantWatchlistStore.list()
                if (!Array.isArray(list)) return []
                return list.map(e => ({
                    destIata: String((e && (e.destIata || e.iata)) || "").toUpperCase(),
                    destName: (e && (e.destName || e.name)) || "",
                    source:   "watch"
                })).filter(c => /^[A-Z]{3}$/.test(c.destIata))
            }
        } catch (_) { return [] }
        return []
    }

    _parseRouteKey(key) {
        const text = String(key || "").toUpperCase()
        const dash = text.indexOf("-")
        if (dash > 0) {
            const hub = text.slice(0, dash)
            const dest = text.slice(dash + 1)
            if (/^[A-Z]{3}$/.test(hub) && /^[A-Z]{3}$/.test(dest)) return {hub, dest}
        }
        if (/^[A-Z]{3}$/.test(text)) return {hub: "", dest: text}
        return null
    }

    _scheduledDestinations() {
        const set = new Set()
        const hub = this.activeHub
        if (!this.schedules || typeof this.schedules.forEach !== "function") return set
        this.schedules.forEach((schedule) => {
            const legs = schedule && Array.isArray(schedule.legs) ? schedule.legs : []
            for (const leg of legs) {
                const origin = String(leg && leg.origin || "").toUpperCase()
                const dest = String(leg && leg.destination || "").toUpperCase()
                if (!/^[A-Z]{3}$/.test(dest)) continue
                if (!hub || origin === hub) set.add(dest)
                else if (dest === hub && /^[A-Z]{3}$/.test(origin)) set.add(origin)
            }
        })
        return set
    }

    _numberOrNull(value) {
        const n = Number(value)
        return Number.isFinite(n) ? n : null
    }

    _buildCard(card, T, isCustom) {
        const el = document.createElement("div")
        el.className = "aes-fsg-dnd-card"
        el.draggable = true
        el.dataset.destIata = card.destIata
        el.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:grab;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "border-left:3px solid " + (T ? T.color.cobalt : "#3656A8") + ";"
            + "transition:background 80ms linear;"
        const code = document.createElement("span")
        code.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "font-size:13px;font-weight:700;color:" + (T ? T.color.oxide : "#2B2520") + ";flex:0 0 auto;"
        code.textContent = card.destIata
        const text = document.createElement("span")
        text.style.cssText = "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;"
        const name = document.createElement("span")
        name.style.cssText = "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        name.textContent = card.destName || ""
        text.appendChild(name)
        const metaText = this._cardMetaText(card)
        if (metaText) {
            const meta = document.createElement("span")
            meta.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            meta.textContent = metaText
            text.appendChild(meta)
        }
        el.append(code, text)
        if (isCustom) {
            const rm = document.createElement("button")
            rm.type = "button"; rm.textContent = "×"
            rm.style.cssText = "padding:1px 5px;cursor:pointer;font-size:10px;"
                + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "background:transparent;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            rm.title = "Remove this card"
            rm.addEventListener("click", e => {
                e.preventDefault(); e.stopPropagation()
                this._customCards = this._customCards.filter(c => c.destIata !== card.destIata)
                this._renderList()
            })
            el.appendChild(rm)
        }
        el.addEventListener("dragstart", e => {
            const sourceList = card.sources && typeof card.sources.forEach === "function"
                ? Array.from(card.sources) : (card.source ? [card.source] : [])
            const payload = JSON.stringify({
                destIata:      card.destIata,
                destName:      card.destName || card.destIata,
                distanceKm:    card.distanceKm || null,
                distanceNm:    card.distanceNm || null,
                blockMin:      card.blockMin || null,
                score:         card.score || null,
                paxScore:      card.paxScore || null,
                cargoScore:    card.cargoScore || null,
                weeklyFlights: card.weeklyFlights || null,
                source:        sourceList.join("+")
            })
            try { e.dataTransfer.setData(FleetScheduleGridDndSourcePanel.DT_TYPE, payload) }
            catch (_) {}
            try { e.dataTransfer.setData("text/plain", card.destIata) } catch (_) {}
            e.dataTransfer.effectAllowed = "copy"
            el.style.opacity = "0.5"
        })
        el.addEventListener("dragend", () => { el.style.opacity = "1" })
        return el
    }

    _cardMetaText(card) {
        const parts = []
        if (card.sources && typeof card.sources.forEach === "function") {
            const labels = Array.from(card.sources).map(s => String(s || "")).filter(Boolean)
            if (labels.length) parts.push(labels.join("+"))
        } else if (card.source) {
            parts.push(card.source)
        }
        if (Number.isFinite(Number(card.score))) parts.push("score " + Math.round(Number(card.score)))
        if (Number.isFinite(Number(card.weeklyFlights))) parts.push(Number(card.weeklyFlights) + "x")
        if (card.alreadyScheduled) parts.push("scheduled")
        return parts.join(" · ")
    }

    _sectionTitleCss(T) {
        return "font-size:10px;font-weight:700;letter-spacing:0.08em;"
             + "text-transform:uppercase;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
             + "padding-bottom:4px;border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridDndSourcePanel = FleetScheduleGridDndSourcePanel
}
