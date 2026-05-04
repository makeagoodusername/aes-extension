"use strict"

/**
 * CanvasRouteCreateModal — route details dialog for a schedule-canvas add.
 *
 * Triggered by the drop-bridge when the user drags a destination card onto
 * a wave cell, or by the empty-cell context menu. Collects fields that map
 * directly to AirlineSim's New Flight Number form: destination, departure
 * time, price %, service, and optional flight-number suffix.
 *
 * Pure modal: no storage writes, no network. Closes on Cancel, Esc, or
 * after the user confirms. Single-instance — opening twice closes the
 * previous prompt.
 */
class CanvasRouteCreateModal {

    static OVERLAY_CLASS = "aes-canvas-route-create-overlay"
    static _active = null

    /**
     * Open the modal and return a Promise that resolves with the user's
     * route details (or `null` on cancel).
     *
     * @param {object} ctx — {hub, destIata, destName, aircraftId, registration}
     */
    static open(ctx) {
        if (CanvasRouteCreateModal._active) CanvasRouteCreateModal._active.close(null)
        return new Promise((resolve) => {
            const m = new CanvasRouteCreateModal(ctx || {}, resolve)
            CanvasRouteCreateModal._active = m
            m._mount()
        })
    }

    constructor(ctx, resolve) {
        this.ctx = ctx
        this._resolve = resolve
        this._overlayEl = null
        this._keydownHandler = null
        this._fields = null
        this._errorEl = null
    }

    _mount() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const overlay = document.createElement("div")
        overlay.className = CanvasRouteCreateModal.OVERLAY_CLASS
        overlay.style.cssText = [
            "position:fixed",
            "inset:0",
            "background:rgba(20,18,15,0.62)",
            "z-index:" + (T ? T.z.modal + 1 : 10001),
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:24px",
            "box-sizing:border-box"
        ].join(";")
        overlay.addEventListener("click", e => { if (e.target === overlay) this.close(null) })

        const card = document.createElement("div")
        card.style.cssText = [
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "min-width:360px",
            "max-width:480px",
            "display:flex",
            "flex-direction:column",
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-size:" + (T ? T.fs.body : "12px")
        ].join(";")

        // Header
        const head = document.createElement("div")
        head.style.cssText = [
            "padding:10px 14px",
            "background:" + (T ? T.color.bone3 : "#E0DAC8"),
            "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "display:flex",
            "justify-content:space-between",
            "align-items:center",
            "gap:12px"
        ].join(";")
        const title = document.createElement("div")
        title.style.cssText = "font-weight:" + (T ? T.fw.display : "800") + ";font-size:13px;text-transform:uppercase;letter-spacing:0.06em;"
        title.textContent = "Stage new route"
        const sub = document.createElement("div")
        sub.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:11px;"
        sub.textContent = (this.ctx.hub || "—") + " → " + (this._normIata(this.ctx.destIata) || "new route")
            + (this.ctx.registration ? "  ·  " + this.ctx.registration : "")
        head.append(title, sub)
        card.appendChild(head)

        // Body
        const body = document.createElement("div")
        body.style.cssText = "padding:14px 16px;display:flex;flex-direction:column;gap:10px;"
        const lead = document.createElement("div")
        lead.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-size:11px;line-height:1.5;"
        lead.textContent = "These values are staged into the schedule apply batch and then posted through AirlineSim's Flight Plan form."
        body.appendChild(lead)

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:120px 1fr;gap:7px 10px;align-items:center;"
        const fields = {}

        const destInput = document.createElement("input")
        destInput.type = "text"
        destInput.maxLength = 3
        destInput.inputMode = "text"
        destInput.autocomplete = "off"
        destInput.value = this._normIata(this.ctx.destIata)
        destInput.placeholder = "IATA"
        destInput.style.cssText = this._inputCss(T) + "text-transform:uppercase;width:80px;"
        destInput.addEventListener("input", () => {
            destInput.value = String(destInput.value || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3)
        })
        fields.destIata = destInput
        this._addField(grid, T, "Destination", destInput)

        const fnInput = document.createElement("input")
        fnInput.type = "text"
        fnInput.maxLength = 4
        fnInput.inputMode = "numeric"
        fnInput.placeholder = "auto"
        fnInput.style.cssText = this._inputCss(T) + "width:80px;"
        fnInput.addEventListener("input", () => {
            fnInput.value = String(fnInput.value || "").replace(/[^0-9]/g, "").slice(0, 4)
        })
        fields.flightNumberText = fnInput
        this._addField(grid, T, "Flight #", fnInput)

        const depInput = document.createElement("input")
        depInput.type = "time"
        depInput.value = this._normTime(this.ctx.depTimeLocal || this.ctx.depTime) || ""
        depInput.style.cssText = this._inputCss(T) + "width:110px;"
        fields.depTimeLocal = depInput
        this._addField(grid, T, "Departure", depInput)

        const priceInput = document.createElement("input")
        priceInput.type = "number"
        priceInput.min = "50"
        priceInput.max = "200"
        priceInput.step = "5"
        priceInput.value = String(this._normPricePct(this.ctx.pricePct) || 100)
        priceInput.style.cssText = this._inputCss(T) + "width:90px;"
        fields.pricePct = priceInput
        this._addField(grid, T, "Price %", priceInput)

        const serviceInput = document.createElement("input")
        serviceInput.type = "text"
        serviceInput.value = typeof this.ctx.service === "string" ? this.ctx.service : ""
        serviceInput.placeholder = "default"
        serviceInput.style.cssText = this._inputCss(T) + "width:160px;"
        fields.service = serviceInput
        this._addField(grid, T, "Service", serviceInput)

        this._fields = fields
        body.appendChild(grid)

        const err = document.createElement("div")
        err.style.cssText = "display:none;font-size:11px;color:" + (T ? T.color.crimson : "#8B2727") + ";"
            + "border:1px solid " + (T ? T.color.crimson : "#8B2727") + ";"
            + "background:rgba(139,39,39,0.08);padding:6px 8px;"
        this._errorEl = err
        body.appendChild(err)
        card.appendChild(body)

        // Footer
        const foot = document.createElement("div")
        foot.style.cssText = [
            "padding:10px 14px",
            "background:" + (T ? T.color.bone2 : "#ECE7DC"),
            "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "display:flex",
            "justify-content:flex-end",
            "gap:8px"
        ].join(";")
        const cancel = document.createElement("button")
        cancel.type = "button"
        cancel.textContent = "Cancel"
        cancel.style.cssText = "padding:5px 12px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        cancel.addEventListener("click", () => this.close(null))
        const stage = document.createElement("button")
        stage.type = "button"
        stage.textContent = "Stage edit"
        stage.style.cssText = "padding:5px 14px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.rust : "#B8472A") + ";"
            + "background:" + (T ? T.color.rust : "#B8472A") + ";"
            + "color:" + (T ? T.color.rustFg || "#F4F1EA" : "#F4F1EA") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        stage.addEventListener("click", () => this._submit())
        foot.append(cancel, stage)
        card.appendChild(foot)

        overlay.appendChild(card)
        document.body.appendChild(overlay)
        this._overlayEl = overlay

        this._keydownHandler = (e) => {
            if (e.key === "Escape") { e.preventDefault(); this.close(null) }
            else if (e.key === "Enter") { e.preventDefault(); this._submit() }
        }
        document.addEventListener("keydown", this._keydownHandler, true)
        const first = this._normIata(this.ctx.destIata) ? depInput : destInput
        if (first) setTimeout(() => first.focus(), 30)
    }

    _submit() {
        if (!this._fields) return this.close(null)
        const destIata = this._normIata(this._fields.destIata.value)
        if (!destIata) {
            this._showError("Enter a 3-letter IATA destination.")
            return
        }
        const rawDep = String(this._fields.depTimeLocal.value || "")
        const depTimeLocal = this._normTime(rawDep)
        if (rawDep && !depTimeLocal) {
            this._showError("Enter departure time as HH:MM.")
            return
        }
        const rawPrice = String(this._fields.pricePct.value || "")
        const pricePct = this._normPricePct(rawPrice)
        if (rawPrice && pricePct == null) {
            this._showError("Price % must be between 50 and 200.")
            return
        }
        const meta = {
            destIata,
            destName: this.ctx.destName || destIata,
            fares: {},
            pricePct: pricePct != null ? pricePct : 100,
            service: String(this._fields.service.value || "").trim(),
            flightNumberText: String(this._fields.flightNumberText.value || "")
                .replace(/[^0-9]/g, "").slice(0, 4),
            depTimeLocal: depTimeLocal || ""
        }
        this.close(meta)
    }

    _addField(parent, T, label, input) {
        const lbl = document.createElement("label")
        lbl.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-weight:" + (T ? T.fw.bold : "700") + ";"
        lbl.textContent = label
        parent.append(lbl, input)
    }

    _inputCss(T) {
        return "padding:4px 6px;font-family:" + (T ? T.font.mono : "monospace") + ";font-size:12px;"
            + "border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
    }

    _showError(message) {
        if (!this._errorEl) return
        this._errorEl.textContent = message
        this._errorEl.style.display = "block"
    }

    _normIata(value) {
        const s = String(value || "").trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : ""
    }

    _normTime(value) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim())
        if (!m) return ""
        const h = Number(m[1])
        const min = Number(m[2])
        if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return ""
        return (h < 10 ? "0" + h : String(h)) + ":" + (min < 10 ? "0" + min : String(min))
    }

    _normPricePct(value) {
        if (value == null || value === "") return null
        const n = Number(value)
        if (!Number.isFinite(n) || n < 50 || n > 200) return null
        return Math.round(n)
    }

    close(result) {
        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler, true)
            this._keydownHandler = null
        }
        if (this._overlayEl && this._overlayEl.parentElement) {
            this._overlayEl.parentElement.removeChild(this._overlayEl)
        }
        this._overlayEl = null
        if (CanvasRouteCreateModal._active === this) CanvasRouteCreateModal._active = null
        if (this._resolve) { try { this._resolve(result) } catch (_) {} this._resolve = null }
    }
}

if (typeof window !== "undefined") {
    window.CanvasRouteCreateModal = CanvasRouteCreateModal
}
