"use strict"

/**
 * CanvasFirstRunOverlay — three-step darkened overlay shown on the first
 * canvas mount per account.
 *
 * Reads `advisorPrefs.firstRunSeen` from CanvasStateStore. When false, the
 * overlay paints over the canvas modal with three numbered callouts that
 * advance on click and dismiss on the third. Persists `firstRunSeen=true`
 * on dismiss so subsequent opens skip it.
 *
 * The overlay is a child of the canvas modal's overlay (or any host
 * passed in). Pure presentational — caller decides when to mount.
 */
class CanvasFirstRunOverlay {

    static OVERLAY_CLASS = "aes-canvas-first-run-overlay"
    static _active = null

    /**
     * Show the overlay if the user hasn't seen it. Returns the instance
     * (or null when skipped).
     *
     * @param {object} deps
     *   - hostEl: parent element to mount inside (defaults to body)
     *   - force:  bypass the firstRunSeen check (replay from a help menu)
     */
    static async maybeShow(deps) {
        const d = deps || {}
        if (typeof window === "undefined" || !window.AesCanvasStateStore) return null
        let state = null
        try { state = await window.AesCanvasStateStore.load() } catch (_) {}
        const seen = !!(state && state.advisorPrefs && state.advisorPrefs.firstRunSeen)
        if (seen && !d.force) return null
        if (CanvasFirstRunOverlay._active) CanvasFirstRunOverlay._active.dismiss()
        const inst = new CanvasFirstRunOverlay(d)
        CanvasFirstRunOverlay._active = inst
        inst._mount()
        return inst
    }

    constructor(deps) {
        this.hostEl = (deps && deps.hostEl) || (typeof document !== "undefined" ? document.body : null)
        this._step = 0
        this._overlayEl = null
        this._keydownHandler = null
        this._steps = [
            {
                title:   "1. Wave columns are your day's rhythm",
                body:    "Each column is a wave from the active preset. Routes live inside their wave window — empty cells are slots you can fill."
            },
            {
                title:   "2. The rail builds for you",
                body:    "In Builder mode the assistant streams plan candidates with rationales. Stage a plan, then Apply when you're ready."
            },
            {
                title:   "3. Drag anything → rail flips to Advisor",
                body:    "Drag a destination from the dock onto a cell. The rail switches to Advisor mode and reacts: maintenance conflicts, demand fit, fleet synergy."
            }
        ]
    }

    _mount() {
        if (!this.hostEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const overlay = document.createElement("div")
        overlay.className = CanvasFirstRunOverlay.OVERLAY_CLASS
        overlay.style.cssText = [
            "position:absolute",
            "inset:0",
            "background:rgba(20,18,15,0.78)",
            "z-index:" + (T ? T.z.modal + 5 : 10005),
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:24px",
            "color:" + (T ? T.color.boneFg || "#F4F1EA" : "#F4F1EA"),
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif")
        ].join(";")
        overlay.addEventListener("click", () => this._advance())
        this._overlayEl = overlay

        const card = document.createElement("div")
        card.style.cssText = [
            "max-width:420px",
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "padding:18px 20px",
            "display:flex",
            "flex-direction:column",
            "gap:10px"
        ].join(";")
        // Stop the backdrop click from advancing twice when clicking the card.
        card.addEventListener("click", (e) => { e.stopPropagation(); this._advance() })

        this._cardEl = card
        this._renderStep()
        overlay.appendChild(card)
        // Mount inside hostEl so positioning is relative to the canvas modal.
        // hostEl needs position: relative or absolute for `inset:0` to anchor.
        if (this.hostEl && getComputedStyle(this.hostEl).position === "static") {
            this.hostEl.style.position = "relative"
        }
        this.hostEl.appendChild(overlay)

        this._keydownHandler = (e) => {
            if (e.key === "Escape") { e.preventDefault(); this.dismiss() }
            else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._advance() }
        }
        document.addEventListener("keydown", this._keydownHandler, true)
    }

    _renderStep() {
        if (!this._cardEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const step = this._steps[this._step]
        this._cardEl.innerHTML = ""
        const stepLine = document.createElement("div")
        stepLine.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        stepLine.textContent = "Step " + (this._step + 1) + " of " + this._steps.length
        const title = document.createElement("div")
        title.style.cssText = "font-weight:" + (T ? T.fw.display : "800") + ";font-size:15px;letter-spacing:0.04em;"
        title.textContent = step.title
        const body = document.createElement("p")
        body.style.cssText = "margin:0;font-size:12px;line-height:1.5;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        body.textContent = step.body
        const foot = document.createElement("div")
        foot.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:6px;"
        const skip = document.createElement("button")
        skip.type = "button"
        skip.textContent = "Skip"
        skip.style.cssText = "padding:3px 10px;font-size:10px;border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:transparent;color:" + (T ? T.color.slate : "#7A6F66") + ";cursor:pointer;"
            + "text-transform:uppercase;letter-spacing:0.06em;"
        skip.addEventListener("click", (e) => { e.stopPropagation(); this.dismiss() })
        const next = document.createElement("button")
        next.type = "button"
        next.textContent = (this._step === this._steps.length - 1) ? "Got it" : "Next ▸"
        next.style.cssText = "padding:5px 14px;font-size:11px;border:1px solid " + (T ? T.color.rust : "#B8472A") + ";"
            + "background:" + (T ? T.color.rust : "#B8472A") + ";color:" + (T ? T.color.rustFg || "#F4F1EA" : "#F4F1EA") + ";"
            + "cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        next.addEventListener("click", (e) => { e.stopPropagation(); this._advance() })
        foot.append(skip, next)
        this._cardEl.append(stepLine, title, body, foot)
    }

    _advance() {
        if (this._step < this._steps.length - 1) {
            this._step++
            this._renderStep()
            return
        }
        this.dismiss()
    }

    async dismiss() {
        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler, true)
            this._keydownHandler = null
        }
        if (this._overlayEl && this._overlayEl.parentElement) {
            this._overlayEl.parentElement.removeChild(this._overlayEl)
        }
        this._overlayEl = null
        if (CanvasFirstRunOverlay._active === this) CanvasFirstRunOverlay._active = null
        try {
            if (window.AesCanvasStateStore) {
                await window.AesCanvasStateStore.save({advisorPrefs: {firstRunSeen: true}})
            }
        } catch (_) {}
    }
}

if (typeof window !== "undefined") {
    window.CanvasFirstRunOverlay = CanvasFirstRunOverlay
}
