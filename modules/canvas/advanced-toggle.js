"use strict"

/**
 * CanvasAdvancedToggle — header pill that exposes the dense data the
 * canvas hides by default.
 *
 * When toggled on, the canvas main pane gains a "telemetry strip" below
 * the wave spine: a compact line listing the active hub's cached top
 * routes (count + freshness), the schedule store's last-updated
 * timestamp, and the demand-store's cache age. No interactive table
 * yet — the standalone Route Assistant panel is the canonical dense
 * view; this just gives the canvas-mode user a quick "is the data
 * fresh enough" pulse without bouncing back to RA.
 *
 * State persists via `advisorPrefs.advancedOn` on CanvasStateStore.
 */
class CanvasAdvancedToggle {

    /**
     * Build the pill. Returns {el, refresh} — the canvas shell appends
     * `el` to its header and calls `refresh()` whenever the active hub
     * changes so the strip re-reads. The strip itself is a sibling node
     * the caller owns (so it can position it under the spine).
     */
    static build(deps) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const o = deps || {}
        const onToggle = typeof o.onToggle === "function" ? o.onToggle : (() => {})
        const initialOn = !!(o.initialOn)
        const btn = document.createElement("button")
        btn.type = "button"
        btn.style.cssText = "padding:3px 8px;font-size:10px;cursor:pointer;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:" + (T ? T.fw.bold : "700") + ";"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
        let on = initialOn
        const paint = () => {
            btn.textContent = on ? "Advanced ●" : "Advanced ○"
            btn.title = on
                ? "Hide telemetry strip"
                : "Show data freshness telemetry under the wave spine"
            btn.style.background = on
                ? (T ? T.color.oxide : "#2B2520")
                : (T ? T.color.bone : "#F4F1EA")
            btn.style.color = on
                ? (T ? T.color.boneFg || "#F4F1EA" : "#F4F1EA")
                : (T ? T.color.oxide : "#2B2520")
        }
        paint()
        btn.addEventListener("click", () => {
            on = !on
            paint()
            onToggle(on)
        })
        return {
            el:    btn,
            isOn:  () => on,
            setOn: (next) => { on = !!next; paint() }
        }
    }

    /**
     * Render (or update) the telemetry strip into `hostEl`. The strip is
     * one line of cached-data freshness indicators. Idempotent —
     * re-rendering replaces the contents.
     */
    static async renderStrip(hostEl, ctx) {
        if (!hostEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const c = ctx || {}
        hostEl.innerHTML = ""
        hostEl.style.cssText = "padding:8px 14px;display:flex;flex-wrap:wrap;gap:14px;"
            + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "font-size:10px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"

        const hub = c.hub || "—"
        const items = []
        items.push(["Hub", hub])
        items.push(["Aircraft", c.fleetCount != null ? String(c.fleetCount) : "—"])
        items.push(["Schedules cached", c.scheduleCount != null ? String(c.scheduleCount) : "—"])
        items.push(["Top routes",
            c.topRoutes && c.topRoutes.count != null
                ? c.topRoutes.count + " · " + CanvasAdvancedToggle._fmtAge(c.topRoutes.ageMs)
                : "—"])
        items.push(["Demand cache",
            c.demand && c.demand.routes != null
                ? c.demand.routes + " routes · " + CanvasAdvancedToggle._fmtAge(c.demand.ageMs)
                : "—"])
        items.push(["Preset",
            c.preset && c.preset.name
                ? c.preset.name + " · " + (c.preset.waveCount || 0) + "w"
                : "—"])
        for (const [k, v] of items) {
            const span = document.createElement("span")
            span.style.cssText = "display:flex;gap:4px;align-items:baseline;"
            const label = document.createElement("span")
            label.style.cssText = "letter-spacing:0.08em;text-transform:uppercase;color:" + (T ? T.color.slate : "#7A6F66") + ";"
            label.textContent = k
            const val = document.createElement("span")
            val.style.cssText = "font-weight:" + (T ? T.fw.bold : "700") + ";"
            val.textContent = v
            span.append(label, val)
            hostEl.appendChild(span)
        }
    }

    static _fmtAge(ms) {
        if (!isFinite(ms) || ms < 0) return "—"
        const s = Math.round(ms / 1000)
        if (s < 60) return s + "s"
        const m = Math.round(s / 60)
        if (m < 60) return m + "m"
        const h = Math.round(m / 60)
        if (h < 48) return h + "h"
        return Math.round(h / 24) + "d"
    }

    /** Read the cached topRoutes blob freshness for the hub, returns
     *  {count, ageMs} or null. */
    static async readTopRoutesFreshness(hub) {
        if (!hub || typeof chrome === "undefined") return null
        try {
            const key = "routeAssistant:topRoutes:" + String(hub).toUpperCase()
            const data = await chrome.storage.local.get([key])
            const blob = data[key]
            if (!blob) return null
            const count = (blob.rows && blob.rows.length) || 0
            const updatedAt = Number(blob.updatedAt) || Number(blob.scrapedAt) || 0
            const ageMs = updatedAt ? (Date.now() - updatedAt) : null
            return {count, ageMs}
        } catch (_) { return null }
    }

    /** Read the demand-store freshness summary for the hub. */
    static async readDemandFreshness(hub) {
        if (!hub || typeof window === "undefined" || !window.RouteAssistantDemandStore) return null
        try {
            // Best-effort: count cached routes for the hub if the API exposes it.
            const store = window.RouteAssistantDemandStore
            if (typeof store.summary === "function") {
                const s = await store.summary(hub)
                if (s) return s
            }
            // Fallback to the per-hub blob the topRoutes uses — same shape.
            return CanvasAdvancedToggle.readTopRoutesFreshness(hub)
        } catch (_) { return null }
    }
}

if (typeof window !== "undefined") {
    window.CanvasAdvancedToggle = CanvasAdvancedToggle
}
