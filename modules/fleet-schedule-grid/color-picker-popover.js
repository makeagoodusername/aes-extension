"use strict"

/**
 * Fleet Schedule Grid — color picker popover.
 *
 * Anchored popover triggered from the bar context menu and the MX context
 * menu. One scope at a time:
 *
 *   { scope: "route"|"aircraft"|"day"|"maintenance",
 *     key:   string|null,        // route key / aircraftId / "0".."6" / unused for maintenance
 *     label: string,             // human-readable subject ("JFK→LAX", "N001FGM", "Monday")
 *     currentColor: string|null  // pre-fill the swatch when the user already overrode this
 *   }
 *
 * Native `<input type="color">` is the picker primitive — light, no jQuery,
 * already a familiar UX. "Reset to default" wipes the override; "Save"
 * commits via AesScheduleColorOverrides.set(...). Single-instance: opening
 * a second popover closes the first.
 */
class FleetScheduleGridColorPicker {

    static _active = null

    static open(opts) {
        const o = opts || {}
        if (FleetScheduleGridColorPicker._active) FleetScheduleGridColorPicker._active.close()
        const inst = new FleetScheduleGridColorPicker(o)
        FleetScheduleGridColorPicker._active = inst
        inst._mount()
        return inst
    }

    constructor(opts) {
        const o = opts || {}
        this.scope        = o.scope        || "route"
        this.key          = o.key != null ? String(o.key) : null
        this.label        = o.label        || ""
        this.currentColor = o.currentColor || ""
        this.anchorRect   = o.anchorRect   || null
        this.onApplied    = typeof o.onApplied === "function" ? o.onApplied : null
        this._rootEl      = null
        this._docKey      = null
        this._docClick    = null
    }

    _mount() {
        if (typeof document === "undefined") return
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const root = document.createElement("div")
        root.className = "aes-color-popover"
        root.style.cssText = [
            "position:fixed",
            "z-index:" + (T ? T.z.popover || 9999 : 9999),
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "border:1px solid " + (T ? T.color.oxide : "#2B2520"),
            "padding:10px 12px",
            "min-width:240px",
            "box-shadow:0 6px 20px rgba(0,0,0,0.25)",
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-size:11px",
            "color:" + (T ? T.color.oxide : "#2B2520")
        ].join(";")

        const title = document.createElement("div")
        title.style.cssText = "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
            + "font-size:10px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";margin-bottom:6px;"
        title.textContent = this._titleText()
        root.appendChild(title)

        const subject = document.createElement("div")
        subject.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "font-weight:700;font-size:13px;margin-bottom:10px;"
        subject.textContent = this.label || "(no subject)"
        root.appendChild(subject)

        const row = document.createElement("div")
        row.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:10px;"

        const swatch = document.createElement("input")
        swatch.type = "color"
        swatch.value = this._toHex(this.currentColor) || this._defaultColor()
        swatch.style.cssText = "width:48px;height:36px;border:1px solid " + (T ? T.color.oxide : "#2B2520")
            + ";cursor:pointer;padding:0;background:none;"
        row.appendChild(swatch)

        const hex = document.createElement("input")
        hex.type = "text"
        hex.value = swatch.value
        hex.maxLength = 7
        hex.style.cssText = "flex:1 1 auto;padding:6px 8px;font-family:" + (T ? T.font.mono : "monospace")
            + ";font-size:12px;border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
        row.appendChild(hex)

        swatch.addEventListener("input", () => { hex.value = swatch.value })
        hex.addEventListener("input", () => {
            const v = (hex.value || "").trim()
            if (/^#[0-9a-fA-F]{6}$/.test(v)) swatch.value = v
        })
        root.appendChild(row)

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;"

        const reset = document.createElement("button")
        reset.type = "button"
        reset.textContent = "Reset to default"
        reset.style.cssText = this._btnStyle(T, "default")
        reset.addEventListener("click", async () => { await this._reset() })

        const cancel = document.createElement("button")
        cancel.type = "button"
        cancel.textContent = "Cancel"
        cancel.style.cssText = this._btnStyle(T, "default")
        cancel.addEventListener("click", () => this.close())

        const save = document.createElement("button")
        save.type = "button"
        save.textContent = "Save"
        save.style.cssText = this._btnStyle(T, "rust")
        save.addEventListener("click", async () => { await this._save(swatch.value) })

        btnRow.append(reset, cancel, save)
        root.appendChild(btnRow)

        document.body.appendChild(root)
        this._rootEl = root
        this._positionAt(root, this.anchorRect)

        // Close on outside click / Escape.
        this._docClick = (ev) => {
            if (!this._rootEl) return
            if (ev.target === this._rootEl || this._rootEl.contains(ev.target)) return
            this.close()
        }
        this._docKey = (ev) => { if (ev.key === "Escape") this.close() }
        setTimeout(() => {
            document.addEventListener("mousedown", this._docClick, true)
            document.addEventListener("keydown",   this._docKey,   true)
        }, 0)
    }

    close() {
        if (this._docClick) document.removeEventListener("mousedown", this._docClick, true)
        if (this._docKey)   document.removeEventListener("keydown",   this._docKey,   true)
        this._docClick = null
        this._docKey   = null
        if (this._rootEl && this._rootEl.parentElement) {
            this._rootEl.parentElement.removeChild(this._rootEl)
        }
        this._rootEl = null
        if (FleetScheduleGridColorPicker._active === this) FleetScheduleGridColorPicker._active = null
    }

    async _save(color) {
        if (!window.AesScheduleColorOverrides) { this.close(); return }
        const next = await window.AesScheduleColorOverrides.set(this.scope, this.key, color)
        if (this.onApplied) {
            try { this.onApplied(next) } catch (_) {}
        }
        this.close()
    }

    async _reset() {
        if (!window.AesScheduleColorOverrides) { this.close(); return }
        const next = await window.AesScheduleColorOverrides.clear(this.scope, this.key)
        if (this.onApplied) {
            try { this.onApplied(next) } catch (_) {}
        }
        this.close()
    }

    _titleText() {
        if (this.scope === "maintenance") return "Maintenance color"
        if (this.scope === "route")       return "Route color"
        if (this.scope === "aircraft")    return "Aircraft color"
        if (this.scope === "day")         return "Day color"
        return "Color"
    }

    _defaultColor() {
        if (this.scope === "maintenance" && window.AesScheduleColorOverrides) {
            return window.AesScheduleColorOverrides.defaultMaintenance()
        }
        return "#3656A8"
    }

    _toHex(color) {
        if (!color) return ""
        if (/^#[0-9a-fA-F]{6}$/.test(color)) return color
        // hsl()/rgb()/named colors won't fit in input[type=color] — leave
        // blank and let the user pick afresh.
        return ""
    }

    _btnStyle(T, variant) {
        const base = "padding:5px 10px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "border-radius:0;font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        if (variant === "rust") {
            return base + "background:" + (T ? T.color.rust : "#B8472A") + ";"
                + "color:" + (T ? T.color.boneFg || "#F4F1EA" : "#F4F1EA") + ";"
        }
        return base + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
    }

    _positionAt(el, rect) {
        if (!el) return
        const padding = 8
        const vw = window.innerWidth || 1024
        const vh = window.innerHeight || 768
        const w = el.offsetWidth || 260
        const h = el.offsetHeight || 180
        let left = (rect ? rect.left : (vw - w) / 2)
        let top  = (rect ? rect.bottom + 4 : (vh - h) / 2)
        if (left + w + padding > vw) left = vw - w - padding
        if (top  + h + padding > vh) top  = (rect ? rect.top - h - 4 : padding)
        if (left < padding) left = padding
        if (top  < padding) top  = padding
        el.style.left = left + "px"
        el.style.top  = top  + "px"
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridColorPicker = FleetScheduleGridColorPicker
}
