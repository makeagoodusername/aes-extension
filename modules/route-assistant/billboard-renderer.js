"use strict"

/**
 * Route Assistant — Flight Billboard renderer.
 *
 * Replaces the row-of-text "Aircraft schedules at {hub}" card with a
 * single-canvas timeline where every cached aircraft's bands are
 * superimposed. Overlapping bands brighten via `mix-blend-mode: screen`
 * against the dark canvas — that's the "collision" effect.
 *
 * Each aircraft gets a deterministic Y stripe (hash of aircraftId), so
 * its bands always land on the same row. Flight bands are coloured by
 * relation to the hub: inbound (destination = hub) sky blue, outbound
 * (origin = hub) rose, off-hub neither pale gray. Maintenance and
 * turnaround blocks render as gray hatched and beige bands respectively.
 *
 * The active aircraft (clicked) lifts its bands to full opacity with a
 * sky-blue glow ring; all other bands fade to ~0.12 — the "flight
 * chosen for modification" highlight.
 *
 * Pure renderer — no state. The panel passes records, hub, mode, and
 * callbacks; the renderer mutates the host and wires DOM listeners.
 */
class RouteAssistantBillboard {

    static get CLASS_PREFIX() { return "aes-rab" }
    static get MIN_PER_DAY()  { return 1440 }
    static get MIN_PER_WEEK() { return 10080 }
    static get DAY_NAMES()    { return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }

    /**
     * Paint the billboard into `host` (the existing `_hubSchedulesHost`).
     * Wipes prior contents.
     *
     * @param {HTMLElement} host
     * @param {object} opts
     *   - records: schedule records (Array<Schedule>)
     *   - hubIata: current hub IATA (string)
     *   - server: AS server short name (string), used to build AFP URL
     *   - activeAircraftId: aircraft id to highlight (string|null)
     *   - timeMode: "1d" | "7d"  (default "1d")
     *   - onBandClick(aircraftId): single-click handler — highlight
     *   - onBandDoubleClick(record): double-click handler — open AFP
     *   - onCanvasClick(): click on empty canvas — clear selection
     *   - onModeChange(mode): "1d" | "7d" toggle
     */
    static paint(host, opts) {
        if (!host) return
        const o = opts || {}
        const records  = Array.isArray(o.records) ? o.records : []
        const hubIata  = String(o.hubIata || "").toUpperCase()
        const timeMode = (o.timeMode === "7d") ? "7d" : "1d"
        const activeId = o.activeAircraftId != null ? String(o.activeAircraftId) : null

        RouteAssistantBillboard._ensureStyles()

        host.innerHTML = ""
        host.style.cssText = "display:block;margin:6px 0;padding:6px 8px;border:1px solid var(--aes-paper-rule, #374151);"
            + "border-radius:4px;background:var(--aes-bone-2, #0f1623);"
            + "font-family:var(--aes-font-mono, monospace);font-size:11px;color:var(--aes-slate, #cbd5e1);"

        host.appendChild(RouteAssistantBillboard._buildHeader(records, hubIata, timeMode, o))

        if (!records.length) return

        const canvasH  = (timeMode === "7d") ? 156 : 108
        const bandH    = (timeMode === "7d") ? 6   : 8
        const canvas   = RouteAssistantBillboard._buildCanvas(canvasH)
        host.appendChild(canvas)

        const totalMin = (timeMode === "7d")
            ? RouteAssistantBillboard.MIN_PER_WEEK
            : RouteAssistantBillboard.MIN_PER_DAY

        canvas.appendChild(RouteAssistantBillboard._buildAxis(timeMode))

        const bandLayer = document.createElement("div")
        bandLayer.className = `${RouteAssistantBillboard.CLASS_PREFIX}-bands`
        canvas.appendChild(bandLayer)

        const labelStrip = document.createElement("div")
        labelStrip.className = `${RouteAssistantBillboard.CLASS_PREFIX}-labels`
        host.appendChild(labelStrip)

        const labelXById = new Map()

        const hasActive = activeId != null
        for (const rec of records) {
            const aid = String(rec.aircraftId || "")
            if (!aid) continue
            const stripeY = RouteAssistantBillboard._hashY(aid, canvasH, bandH)
            const state = !hasActive ? "neutral" : (aid === activeId ? "hot" : "dim")
            let firstHubBandPct = null

            for (const leg of (rec.legs || [])) {
                const startAbs = RouteAssistantBillboard._legAbsMin(leg, timeMode)
                if (startAbs == null) continue
                const widthMin = Number(leg.durationMin) || 0
                if (widthMin <= 0) continue

                const role = RouteAssistantBillboard._classifyLeg(leg, hubIata)
                bandLayer.appendChild(RouteAssistantBillboard._mkBand({
                    role, startAbs, widthMin, totalMin, stripeY, bandH, state,
                    aircraftId: aid,
                    tooltip: RouteAssistantBillboard._legTooltip(rec, leg, role)
                }))

                if (firstHubBandPct == null && role !== "offhub") {
                    firstHubBandPct = (startAbs / totalMin) * 100
                }
            }

            for (const day of (rec.days || [])) {
                for (const blk of (day.blocks || [])) {
                    if (blk.kind !== "maintenance" && blk.kind !== "turnaround") continue
                    if (blk.startMin == null || blk.durationMin == null) continue
                    const startAbs = (timeMode === "7d")
                        ? (Number(day.dayIdx || blk.dayIdx || 0) * RouteAssistantBillboard.MIN_PER_DAY) + Number(blk.startMin)
                        : Number(blk.startMin)
                    const role = (blk.kind === "maintenance") ? "maintenance" : "ground"
                    bandLayer.appendChild(RouteAssistantBillboard._mkBand({
                        role, startAbs, widthMin: Number(blk.durationMin), totalMin,
                        stripeY, bandH, state,
                        aircraftId: aid,
                        tooltip: RouteAssistantBillboard._blockTooltip(rec, blk, role)
                    }))
                }
            }

            if (firstHubBandPct != null) labelXById.set(aid, firstHubBandPct)
        }

        for (const rec of records) {
            const aid = String(rec.aircraftId || "")
            if (!aid) continue
            const xPct = labelXById.has(aid) ? labelXById.get(aid) : null
            if (xPct == null) continue
            labelStrip.appendChild(RouteAssistantBillboard._mkLabel(aid, xPct, activeId === aid))
        }

        RouteAssistantBillboard._wireInteractions(host, bandLayer, canvas, records, o)
    }

    static _classifyLeg(leg, hubIata) {
        const o = String(leg.origin || "").toUpperCase()
        const d = String(leg.destination || "").toUpperCase()
        if (d === hubIata) return "inbound"
        if (o === hubIata) return "outbound"
        return "offhub"
    }

    static _legAbsMin(leg, timeMode) {
        const min = RouteAssistantBillboard._hhmmToMin(leg.depTimeLocal)
        if (min == null) return null
        if (timeMode === "7d") {
            const di = Number(leg.dayIdx) || 0
            return (di * RouteAssistantBillboard.MIN_PER_DAY) + min
        }
        return min
    }

    static _hhmmToMin(s) {
        if (typeof s !== "string") return null
        const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
        if (!m) return null
        const h = Number(m[1]), mm = Number(m[2])
        if (!isFinite(h) || !isFinite(mm)) return null
        return (h * 60) + mm
    }

    static _hashY(aircraftId, canvasH, bandH) {
        let h = 0
        for (let i = 0; i < aircraftId.length; i++) h = ((h * 31) + aircraftId.charCodeAt(i)) | 0
        const span = Math.max(1, canvasH - bandH - 14)
        return 14 + (Math.abs(h) % span)
    }

    static _legTooltip(rec, leg, role) {
        const route = [leg.origin || "?", leg.destination || "?"].join("→")
        const day = (typeof leg.dayName === "string" && leg.dayName) ? leg.dayName : ("D" + (leg.dayIdx || 0))
        const dep = leg.depTimeLocal || "--:--"
        const arr = leg.arrTimeLocal || "--:--"
        const dur = (Number(leg.durationMin) || 0) + "m"
        const code = leg.flightCode || leg.flightNumber || "?"
        const ac = rec.aircraftId || "?"
        return `AC ${ac} · ${code} · ${route}\n${day} ${dep}–${arr} (${dur}) · ${role}`
    }

    static _blockTooltip(rec, blk, role) {
        const ac  = rec.aircraftId || "?"
        const day = blk.dayName || ("D" + (blk.dayIdx || 0))
        const dep = blk.startLocal || "--:--"
        const arr = blk.endLocal   || "--:--"
        const dur = (Number(blk.durationMin) || 0) + "m"
        return `AC ${ac} · ${role}\n${day} ${dep}–${arr} (${dur})`
    }

    static _mkBand({ role, startAbs, widthMin, totalMin, stripeY, bandH, state, aircraftId, tooltip }) {
        const P = RouteAssistantBillboard.CLASS_PREFIX
        const band = document.createElement("div")
        let cls = `${P}-band ${P}-band--${role}`
        if (state === "hot") cls += ` ${P}-hot`
        else if (state === "dim") cls += ` ${P}-dim`
        band.className = cls
        band.dataset.aircraftId = aircraftId
        band.dataset.role = role
        band.style.left   = `${(startAbs / totalMin) * 100}%`
        band.style.width  = `${Math.max(0.15, (widthMin / totalMin) * 100)}%`
        band.style.top    = `${stripeY}px`
        band.style.height = `${bandH}px`
        if (tooltip) band.title = tooltip
        return band
    }

    static _mkLabel(aircraftId, xPct, isActive) {
        const lab = document.createElement("a")
        lab.className = `${RouteAssistantBillboard.CLASS_PREFIX}-label`
            + (isActive ? ` ${RouteAssistantBillboard.CLASS_PREFIX}-label--active` : "")
        lab.style.left = `${xPct}%`
        lab.dataset.aircraftId = aircraftId
        lab.textContent = aircraftId
        return lab
    }

    static _buildHeader(records, hubIata, timeMode, o) {
        const head = document.createElement("div")
        head.className = `${RouteAssistantBillboard.CLASS_PREFIX}-head`
        const title = document.createElement("strong")
        title.style.color = "#f3f4f6"
        title.textContent = "Aircraft schedules at " + (hubIata || "—")
        const meta = document.createElement("span")
        meta.style.color = "#6b7280"
        meta.textContent = " · " + records.length + " cached · click to highlight · double-click to open"
        head.appendChild(title)
        head.appendChild(meta)

        const toggle = document.createElement("div")
        toggle.className = `${RouteAssistantBillboard.CLASS_PREFIX}-toggle`
        for (const m of ["1d", "7d"]) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.className = `${RouteAssistantBillboard.CLASS_PREFIX}-pill`
                + (m === timeMode ? ` ${RouteAssistantBillboard.CLASS_PREFIX}-pill--on` : "")
            btn.textContent = (m === "1d") ? "1D" : "7D"
            btn.title = (m === "1d") ? "Show a single 24h day (all days collapsed)" : "Show the full 7-day week"
            btn.addEventListener("click", (e) => {
                e.preventDefault()
                e.stopPropagation()
                if (m !== timeMode && o.onModeChange) o.onModeChange(m)
            })
            toggle.appendChild(btn)
        }
        head.appendChild(toggle)
        return head
    }

    static _buildCanvas(heightPx) {
        const c = document.createElement("div")
        c.className = `${RouteAssistantBillboard.CLASS_PREFIX}-canvas`
        c.style.height = `${heightPx}px`
        return c
    }

    static _buildAxis(timeMode) {
        const axis = document.createElement("div")
        axis.className = `${RouteAssistantBillboard.CLASS_PREFIX}-axis`
        if (timeMode === "7d") {
            for (let d = 0; d < 7; d++) {
                const tick = document.createElement("span")
                tick.className = `${RouteAssistantBillboard.CLASS_PREFIX}-tick`
                tick.style.left = `${(d / 7) * 100}%`
                tick.textContent = RouteAssistantBillboard.DAY_NAMES[d]
                axis.appendChild(tick)
                if (d > 0) {
                    const rule = document.createElement("span")
                    rule.className = `${RouteAssistantBillboard.CLASS_PREFIX}-day-rule`
                    rule.style.left = `${(d / 7) * 100}%`
                    axis.appendChild(rule)
                }
            }
        } else {
            for (let h = 0; h <= 24; h += 3) {
                const tick = document.createElement("span")
                tick.className = `${RouteAssistantBillboard.CLASS_PREFIX}-tick`
                tick.style.left = `${(h / 24) * 100}%`
                tick.textContent = (h < 10 ? "0" : "") + h
                axis.appendChild(tick)
            }
        }
        return axis
    }

    static _wireInteractions(host, bandLayer, canvas, records, o) {
        const recById = new Map(records.map(r => [String(r.aircraftId || ""), r]))

        canvas.addEventListener("click", (e) => {
            const t = e.target
            const band = (t && t.classList && t.classList.contains(`${RouteAssistantBillboard.CLASS_PREFIX}-band`))
                ? t
                : (t && t.closest ? t.closest(`.${RouteAssistantBillboard.CLASS_PREFIX}-band`) : null)
            if (band && band.dataset && band.dataset.aircraftId) {
                if (o.onBandClick) o.onBandClick(band.dataset.aircraftId)
                return
            }
            if (o.onCanvasClick) o.onCanvasClick()
        })

        canvas.addEventListener("dblclick", (e) => {
            const t = e.target
            const band = (t && t.closest) ? t.closest(`.${RouteAssistantBillboard.CLASS_PREFIX}-band`) : null
            if (!band) return
            const aid = band.dataset.aircraftId
            const rec = recById.get(aid)
            if (rec && o.onBandDoubleClick) o.onBandDoubleClick(rec)
        })

        host.querySelectorAll(`.${RouteAssistantBillboard.CLASS_PREFIX}-label`).forEach(el => {
            el.addEventListener("click", (e) => {
                e.preventDefault()
                e.stopPropagation()
                if (o.onBandClick) o.onBandClick(el.dataset.aircraftId)
            })
            el.addEventListener("dblclick", (e) => {
                e.preventDefault()
                e.stopPropagation()
                const rec = recById.get(el.dataset.aircraftId)
                if (rec && o.onBandDoubleClick) o.onBandDoubleClick(rec)
            })
        })
    }

    static _ensureStyles() {
        if (document.getElementById("aes-rab-styles")) return
        const P = RouteAssistantBillboard.CLASS_PREFIX
        const css = `
            .${P}-head{display:flex;align-items:center;gap:6px;margin-bottom:4px;color:#9ca3af;}
            .${P}-toggle{margin-left:auto;display:inline-flex;border:1px solid #374151;border-radius:3px;overflow:hidden;}
            .${P}-pill{background:transparent;color:#9ca3af;border:none;padding:1px 6px;cursor:pointer;font-family:inherit;font-size:10px;letter-spacing:0.05em;}
            .${P}-pill--on{background:#1f2937;color:#f3f4f6;}
            .${P}-pill+.${P}-pill{border-left:1px solid #374151;}
            .${P}-canvas{position:relative;width:100%;background:linear-gradient(180deg,#0b1120 0%,#0f1623 100%);border:1px solid #1f2937;border-radius:3px;overflow:hidden;cursor:default;isolation:isolate;}
            .${P}-axis{position:absolute;inset:0 0 auto 0;height:12px;pointer-events:none;}
            .${P}-tick{position:absolute;top:0;transform:translateX(-50%);font-size:9px;color:#6b7280;font-family:var(--aes-font-mono,monospace);white-space:nowrap;}
            .${P}-day-rule{position:absolute;top:0;bottom:0;width:1px;background:rgba(148,163,184,0.18);pointer-events:none;}
            .${P}-bands{position:absolute;inset:0;}
            .${P}-band{position:absolute;border-radius:1px;pointer-events:auto;cursor:pointer;mix-blend-mode:screen;transition:opacity 120ms ease,box-shadow 120ms ease;overflow:hidden;}
            .${P}-band--inbound{background:rgba(56,189,248,0.55);border-top:1px solid rgba(125,211,252,0.7);}
            .${P}-band--outbound{background:rgba(244,114,182,0.55);border-top:1px solid rgba(251,113,133,0.7);}
            .${P}-band--offhub{background:rgba(148,163,184,0.22);}
            .${P}-band--maintenance{background:repeating-linear-gradient(45deg,rgba(120,113,108,0.65) 0 3px,rgba(87,83,78,0.65) 3px 6px);}
            .${P}-band--ground{background:rgba(214,184,140,0.40);}
            .${P}-dim{opacity:0.12;}
            .${P}-hot{opacity:1;mix-blend-mode:normal;box-shadow:0 0 0 1px rgba(56,189,248,0.85),0 0 6px 1px rgba(56,189,248,0.45);z-index:3;}
            .${P}-labels{position:relative;height:13px;margin-top:2px;}
            .${P}-label{position:absolute;transform:translateX(-50%);font-size:9px;font-family:var(--aes-font-mono,monospace);color:#6b7280;text-decoration:none;cursor:pointer;white-space:nowrap;padding:0 2px;}
            .${P}-label:hover{color:#cbd5e1;}
            .${P}-label--active{color:#7dd3fc;font-weight:600;}
        `
        const style = document.createElement("style")
        style.id = "aes-rab-styles"
        style.textContent = css
        document.head.appendChild(style)
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantBillboard = RouteAssistantBillboard
}
