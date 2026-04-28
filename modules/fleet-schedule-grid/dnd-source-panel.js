"use strict"

/**
 * Fleet Schedule Grid — drag source panel (Side-rail "Drag destinations" tab).
 *
 * Lists draggable destination cards the user can drop onto a lane in the grid.
 * Sources, in priority order:
 *   1. Free-text IATA input — types any 3-letter code, presses Enter to add
 *      it as a one-off card. Always available, no setup required.
 *   2. RouteAssistantWatchlistStore — entries the user has starred elsewhere.
 *   3. Recent route-candidates output — populated as a side-effect of the
 *      aircraft-flight-plan candidate engine; cached per (server, aircraftId).
 *
 * Each card is `draggable=true` and stamps a JSON payload onto
 * `dataTransfer` under `application/x-aes-dnd-dest`:
 *   {destIata, destName, sourceWaveLayerId?}
 *
 * The panel doesn't own the drop bridge — that lives in `dnd-grid-bridge.js`.
 */
class FleetScheduleGridDndSourcePanel {

    static DT_TYPE = "application/x-aes-dnd-dest"

    constructor(opts) {
        const o = opts || {}
        this.server      = o.server || ""
        this.airlineCode = o.airlineCode || ""
        this.paneEl      = null
        this._listEl     = null
        this._customCards = []   // user-typed, in-memory only
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
        note.textContent = "Drag a card onto any aircraft-day lane to schedule a flight at that time."
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

        // Watchlist section.
        const watchlistCards = await this._loadWatchlist()
        if (watchlistCards.length) {
            const h = document.createElement("div")
            h.style.cssText = this._sectionTitleCss(T) + "margin-top:8px;"
            h.textContent = "Watchlist (" + watchlistCards.length + ")"
            this._listEl.appendChild(h)
            for (const c of watchlistCards) this._listEl.appendChild(this._buildCard(c, T, false))
        }

        if (!this._customCards.length && !watchlistCards.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "font-style:italic;padding:8px 0;"
            empty.textContent = "No destinations yet — type an IATA above to add one."
            this._listEl.appendChild(empty)
        }
    }

    async _loadWatchlist() {
        if (typeof RouteAssistantWatchlistStore === "undefined") return []
        try {
            const list = await RouteAssistantWatchlistStore.list()
            if (!Array.isArray(list)) return []
            // Deduplicate by destIata; map to card shape.
            const seen = new Set()
            const out = []
            for (const e of list) {
                const code = String((e && (e.destIata || e.iata)) || "").toUpperCase()
                if (!/^[A-Z]{3}$/.test(code)) continue
                if (seen.has(code)) continue
                seen.add(code)
                out.push({destIata: code, destName: e.destName || e.name || code, source: "watchlist"})
            }
            return out
        } catch (_) { return [] }
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
        const name = document.createElement("span")
        name.style.cssText = "flex:1 1 auto;font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        name.textContent = card.destName || ""
        el.append(code, name)
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
            const payload = JSON.stringify({destIata: card.destIata, destName: card.destName || card.destIata})
            try { e.dataTransfer.setData(FleetScheduleGridDndSourcePanel.DT_TYPE, payload) }
            catch (_) {}
            try { e.dataTransfer.setData("text/plain", card.destIata) } catch (_) {}
            e.dataTransfer.effectAllowed = "copy"
            el.style.opacity = "0.5"
        })
        el.addEventListener("dragend", () => { el.style.opacity = "1" })
        return el
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
