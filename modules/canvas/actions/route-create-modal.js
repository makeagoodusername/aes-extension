"use strict"

/**
 * CanvasRouteCreateModal — fares dialog for an empty-cell drop.
 *
 * Triggered by the drop-bridge when the user drags a destination card onto
 * a wave cell that has no existing route on that aircraft. Collects Y / C
 * / F / Cargo prices (optional — empty fields stay at AS defaults), then
 * resolves with the fare map. Caller stages an `addRoute` edit carrying
 * both the cell coordinates and the fare hint.
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
     * fare map (or `null` on cancel).
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
        this._inputs = null
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
        sub.textContent = (this.ctx.hub || "—") + " → " + (this.ctx.destIata || "???")
            + (this.ctx.registration ? "  ·  " + this.ctx.registration : "")
        head.append(title, sub)
        card.appendChild(head)

        // Body
        const body = document.createElement("div")
        body.style.cssText = "padding:14px 16px;display:flex;flex-direction:column;gap:10px;"
        const lead = document.createElement("div")
        lead.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-size:11px;line-height:1.5;"
        lead.textContent = "Optional fares — empty fields keep the AS default for that class. The leg is staged for the AFP page; you confirm the actual schedule there."
        body.appendChild(lead)

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:60px 1fr;gap:6px 10px;align-items:center;"
        const inputs = {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const lbl = document.createElement("label")
            lbl.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-weight:" + (T ? T.fw.bold : "700") + ";"
            lbl.textContent = cls
            const inp = document.createElement("input")
            inp.type = "number"
            inp.min = "0"
            inp.step = "1"
            inp.placeholder = "default"
            inp.style.cssText = "padding:4px 6px;font-family:" + (T ? T.font.mono : "monospace") + ";font-size:12px;"
                + "border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
                + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            inputs[cls] = inp
            grid.append(lbl, inp)
        }
        this._inputs = inputs
        body.appendChild(grid)
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
        const first = inputs.Y
        if (first) setTimeout(() => first.focus(), 30)
    }

    _submit() {
        if (!this._inputs) return this.close(null)
        const out = {}
        for (const k of Object.keys(this._inputs)) {
            const v = (this._inputs[k].value || "").trim()
            if (!v) continue
            const n = Number(v)
            if (!isFinite(n) || n < 0) continue
            out[k] = Math.round(n)
        }
        this.close(Object.keys(out).length ? out : {})
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
