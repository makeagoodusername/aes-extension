"use strict"

/**
 * CanvasRailShell — the assistant rail that lives in the canvas's right
 * column. Pure layout + mode toggle. Body content (Builder cards / Advisor
 * cards) is provided by the engines via setBody().
 *
 * Layout:
 *   [ Builder | Advisor ]   HUB · close
 *   ─────────────────────
 *   { body slot }
 *   ─────────────────────
 *   {staged-edit count}  [Discard] [Commit]
 *
 * Mode toggle is passive — clicking emits the bus event and the canvas
 * shell re-orchestrates which engine drives the body. The footer is
 * filled by Phase G's commit-bar; in Phase C it's a stub.
 */
class CanvasRailShell {

    static MODE_BUILDER = "builder"
    static MODE_ADVISOR = "advisor"

    constructor(deps) {
        const d = deps || {}
        this.activeHub = d.activeHub || null
        this.mode      = d.mode === CanvasRailShell.MODE_ADVISOR ? CanvasRailShell.MODE_ADVISOR : CanvasRailShell.MODE_BUILDER
        // Callbacks
        this.onModeChange  = typeof d.onModeChange  === "function" ? d.onModeChange  : null
        this.onClose       = typeof d.onClose       === "function" ? d.onClose       : null
        this.onCommit      = typeof d.onCommit      === "function" ? d.onCommit      : null
        this.onDiscard     = typeof d.onDiscard     === "function" ? d.onDiscard     : null

        this._rootEl   = null
        this._headerEl = null
        this._bodyEl   = null
        this._footerEl = null
        this._stagedCount = 0
    }

    mount(hostEl) {
        if (!hostEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const root = document.createElement("div")
        root.className = "aes-canvas-rail"
        root.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "flex:1 1 auto",
            "min-height:0",
            "background:" + (T ? T.color.bone2 : "#ECE7DC"),
            "color:" + (T ? T.color.oxide : "#2B2520")
        ].join(";")

        const header = this._buildHeader(T)
        root.appendChild(header)
        this._headerEl = header

        const body = document.createElement("div")
        body.className = "aes-canvas-rail__body"
        body.style.cssText = "flex:1 1 auto;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px;"
        root.appendChild(body)
        this._bodyEl = body

        const footer = this._buildFooter(T)
        root.appendChild(footer)
        this._footerEl = footer

        hostEl.appendChild(root)
        this._rootEl = root
    }

    setMode(mode) {
        const next = mode === CanvasRailShell.MODE_ADVISOR ? CanvasRailShell.MODE_ADVISOR : CanvasRailShell.MODE_BUILDER
        if (next === this.mode) return
        this.mode = next
        this._renderHeader()
    }

    setBody(node) {
        if (!this._bodyEl) return
        this._bodyEl.innerHTML = ""
        if (node) this._bodyEl.appendChild(node)
    }

    appendBody(node) {
        if (!this._bodyEl || !node) return
        this._bodyEl.appendChild(node)
    }

    setStagedCount(n) {
        this._stagedCount = Number(n) || 0
        this._renderFooter()
    }

    _buildHeader(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:8px",
            "padding:8px 10px",
            "background:" + (T ? T.color.bone3 : "#E0DAC8"),
            "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0")
        ].join(";")

        const seg = document.createElement("div")
        seg.style.cssText = "display:inline-flex;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
        for (const m of [
            {id: CanvasRailShell.MODE_BUILDER, label: "Builder"},
            {id: CanvasRailShell.MODE_ADVISOR, label: "Advisor"}
        ]) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = m.label
            const isActive = m.id === this.mode
            btn.style.cssText = [
                "padding:3px 10px",
                "font-size:10px",
                "text-transform:uppercase",
                "letter-spacing:0.06em",
                "border:0",
                "border-right:1px solid " + (T ? T.color.oxide : "#2B2520"),
                "background:" + (isActive ? (T ? T.color.oxide : "#2B2520") : (T ? T.color.bone : "#F4F1EA")),
                "color:" + (isActive ? (T ? T.color.boneFg || "#F4F1EA" : "#F4F1EA") : (T ? T.color.oxide : "#2B2520")),
                "cursor:pointer",
                "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
                "font-weight:" + (T ? T.fw.bold : "700")
            ].join(";")
            btn.addEventListener("click", () => {
                if (m.id !== this.mode) {
                    this.mode = m.id
                    this._renderHeader()
                    if (this.onModeChange) this.onModeChange(m.id)
                }
            })
            seg.appendChild(btn)
        }
        if (seg.lastChild) seg.lastChild.style.borderRight = "0"
        wrap.appendChild(seg)

        const hub = document.createElement("span")
        hub.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:11px;flex:1 1 auto;"
        hub.textContent = this.activeHub ? "Hub " + this.activeHub : ""
        wrap.appendChild(hub)

        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "✕"
        close.title = "Hide assistant"
        close.style.cssText = "padding:2px 6px;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";background:" + (T ? T.color.bone : "#F4F1EA") + ";color:" + (T ? T.color.oxide : "#2B2520") + ";font-size:11px;cursor:pointer;"
        close.addEventListener("click", () => { if (this.onClose) this.onClose() })
        wrap.appendChild(close)

        return wrap
    }

    _renderHeader() {
        if (!this._rootEl || !this._headerEl) {
            const T = (typeof window !== "undefined" && window.AESTokens) || null
            const next = this._buildHeader(T)
            if (this._headerEl && this._headerEl.parentElement) {
                this._headerEl.parentElement.replaceChild(next, this._headerEl)
            } else if (this._rootEl) {
                this._rootEl.insertBefore(next, this._rootEl.firstChild)
            }
            this._headerEl = next
            return
        }
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const next = this._buildHeader(T)
        this._rootEl.replaceChild(next, this._headerEl)
        this._headerEl = next
    }

    _buildFooter(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:6px",
            "padding:6px 10px",
            "background:" + (T ? T.color.bone3 : "#E0DAC8"),
            "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "font-size:11px"
        ].join(";")

        const lbl = document.createElement("span")
        lbl.style.cssText = "flex:1 1 auto;color:" + (T ? T.color.slate : "#7A6F66") + ";font-family:" + (T ? T.font.mono : "monospace") + ";"
        lbl.textContent = this._stagedCount + " staged"
        this._stagedLabelEl = lbl

        const discard = document.createElement("button")
        discard.type = "button"
        discard.textContent = "Discard"
        discard.disabled = this._stagedCount === 0
        discard.style.cssText = "padding:3px 8px;font-size:10px;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";background:" + (T ? T.color.bone : "#F4F1EA") + ";color:" + (T ? T.color.oxide : "#2B2520") + ";cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;"
        discard.addEventListener("click", () => { if (this.onDiscard) this.onDiscard() })

        const commit = document.createElement("button")
        commit.type = "button"
        commit.textContent = "Commit"
        commit.disabled = this._stagedCount === 0
        commit.style.cssText = "padding:3px 10px;font-size:10px;border:1px solid " + (T ? T.color.rust : "#B8472A") + ";background:" + (T ? T.color.rust : "#B8472A") + ";color:" + (T ? T.color.rustFg || "#F4F1EA" : "#F4F1EA") + ";cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        commit.addEventListener("click", () => { if (this.onCommit) this.onCommit() })

        wrap.append(lbl, discard, commit)
        return wrap
    }

    _renderFooter() {
        if (!this._rootEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const next = this._buildFooter(T)
        if (this._footerEl && this._footerEl.parentElement) {
            this._footerEl.parentElement.replaceChild(next, this._footerEl)
        } else if (this._rootEl) {
            this._rootEl.appendChild(next)
        }
        this._footerEl = next
    }
}

// Track footerEl on first construction so subsequent _renderFooter
// replacements find a live anchor. Done via a one-shot in the constructor
// flow above: the initial render sets footerEl in mount(), so let's wire that.
;(function () {
    if (typeof window === "undefined") return
    if (!window.CanvasRailShell) window.CanvasRailShell = CanvasRailShell
})()
