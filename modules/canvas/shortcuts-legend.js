"use strict"

/**
 * CanvasShortcutsLegend — small mid-modal panel listing the canvas's
 * keyboard shortcuts. Toggled by the `?` shortcut from canvas-modal.js;
 * single instance, second toggle dismisses.
 */
class CanvasShortcutsLegend {

    static CLASS = "aes-canvas-shortcuts-legend"
    static _active = null

    static toggle(opts) {
        if (CanvasShortcutsLegend._active) {
            CanvasShortcutsLegend._dismiss()
            return null
        }
        return CanvasShortcutsLegend._mount(opts || {})
    }

    static dismiss() {
        CanvasShortcutsLegend._dismiss()
    }

    static _mount(opts) {
        const host = opts.hostEl
        if (!host || typeof document === "undefined") return null
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const overlay = document.createElement("div")
        overlay.className = CanvasShortcutsLegend.CLASS
        overlay.setAttribute("role", "dialog")
        overlay.setAttribute("aria-modal", "true")
        overlay.setAttribute("aria-label", "Keyboard shortcuts")
        overlay.style.cssText = [
            "position:absolute",
            "inset:0",
            "background:rgba(20,18,15,0.45)",
            "z-index:" + (T ? T.z.modal + 1 : 10001),
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:24px"
        ].join(";")
        overlay.addEventListener("click", e => { if (e.target === overlay) CanvasShortcutsLegend._dismiss() })

        const card = document.createElement("div")
        card.style.cssText = [
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "padding:16px 20px",
            "min-width:280px",
            "max-width:420px",
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif")
        ].join(";")

        const title = document.createElement("div")
        title.style.cssText = [
            "font-size:13px",
            "font-weight:" + (T ? T.fw.display : "800"),
            "text-transform:uppercase",
            "letter-spacing:0.08em",
            "margin-bottom:10px",
            "padding-bottom:6px",
            "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0")
        ].join(";")
        title.textContent = "Keyboard shortcuts"
        card.appendChild(title)

        const rows = [
            ["B",            "Toggle Builder / Advisor"],
            ["T",            "Toggle Waves / Timeline"],
            ["R",            "Toggle assistant rail"],
            ["⌘ / Ctrl + ⏎", "Commit staged edits"],
            ["?",            "Show this legend"],
            ["Esc",          "Close canvas"]
        ]
        const table = document.createElement("div")
        table.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:11px;line-height:1.5;"
        for (const [key, desc] of rows) {
            const k = document.createElement("kbd")
            k.textContent = key
            k.style.cssText = [
                "font-family:" + (T ? T.font.mono : "monospace"),
                "font-size:11px",
                "background:" + (T ? T.color.bone3 : "#E0DAC8"),
                "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
                "padding:1px 6px",
                "white-space:nowrap"
            ].join(";")
            const d = document.createElement("span")
            d.textContent = desc
            d.style.color = T ? T.color.oxide : "#2B2520"
            table.append(k, d)
        }
        card.appendChild(table)

        const hint = document.createElement("div")
        hint.style.cssText = "margin-top:10px;font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        hint.textContent = "Press ? again or Esc to dismiss."
        card.appendChild(hint)

        overlay.appendChild(card)

        const hostStyle = host.style && host.style.position
        if (!hostStyle || hostStyle === "static") host.style.position = "relative"
        host.appendChild(overlay)
        CanvasShortcutsLegend._active = overlay
        return overlay
    }

    static _dismiss() {
        const el = CanvasShortcutsLegend._active
        if (el && el.parentElement) el.parentElement.removeChild(el)
        CanvasShortcutsLegend._active = null
    }
}

if (typeof window !== "undefined") {
    window.CanvasShortcutsLegend = CanvasShortcutsLegend
}
