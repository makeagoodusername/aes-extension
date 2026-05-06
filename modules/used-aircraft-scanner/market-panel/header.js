/**
 * Header band for the in-page market scanner panel. Title + status line +
 * primary actions (Refresh / Scan / Cancel / Preset picker / collapse / gear).
 *
 * The header is re-rendered on every state change so its widgets always
 * reflect current session.status, lease ownership, and preset selection.
 * Idempotent: callers replace the header element's children each call.
 */
class MarketPanelHeader {
    static STATUS_FORMAT = {
        running: d => `Scanning ${d.progress.completed}/${d.progress.total} types · `
                    + `${d.progress.inFlight} in flight · ${d.totalRows} offers`,
        done:    d => `Last scan ${d.lastScannedAgo} · ${d.totalRows} offers`,
        aborted: d => `Last scan cancelled · ${d.totalRows} offers`
    }

    static render(host, data, cb) {
        host.innerHTML = ""
        host.className = "aes-panel__header"
        host.style.cssText = "flex:0 0 auto;flex-wrap:wrap;"

        const title = document.createElement("h3")
        title.className = "aes-panel__title"
        title.textContent = "Used Aircraft Scanner"
        host.append(title)

        const collapseBtn = MarketPanelHeader._iconBtn(
            data.collapsed ? "▸" : "▾",
            data.collapsed ? "Expand panel" : "Collapse panel",
            cb.onToggleCollapse)
        host.append(collapseBtn)

        if (data.collapsed) return

        const meta = document.createElement("div")
        meta.className = "aes-panel__subtitle"
        meta.style.cssText = "flex:1 1 100%;text-transform:none;letter-spacing:0;"
        meta.textContent = MarketPanelHeader._statusText(data)
        host.append(meta)

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex:1 1 100%;"

        const select = document.createElement("select")
        select.className = "aes-select"
        select.style.cssText = "flex:1 1 160px;min-width:140px;font-size:var(--aes-fs-small);"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = data.presets.length || data.scanCurrentLabel
            ? "— pick a preset —"
            : "— pick a preset (or set scope below) —"
        placeholder.disabled = true
        placeholder.selected = !data.presetId && !data.scanCurrentSelected
        select.append(placeholder)
        if (data.scanCurrentLabel) {
            const o = document.createElement("option")
            o.value = "__current__"
            o.textContent = "▶ " + data.scanCurrentLabel
            o.selected = !!data.scanCurrentSelected
            select.append(o)
        }
        for (const p of data.presets) {
            const o = document.createElement("option")
            o.value = p.id
            o.textContent = p.name + " (" + (p.types || []).length + ")"
            if (data.presetId === p.id) o.selected = true
            select.append(o)
        }
        select.addEventListener("change", () => cb.onPresetChange(select.value))
        actions.append(select)

        const running = data.status === "running"
        if (!running) {
            const scanLabel = (data.scopeTypeCount && !data.presetId && !data.scanCurrentSelected)
                ? "Scan now (" + data.scopeTypeCount + ")"
                : "Scan now"
            actions.append(MarketPanelHeader._btn({
                label: scanLabel,
                tooltip: "Run the selected preset, current AS filter, or scope chips — opens hidden tabs.",
                variant: "primary",
                disabled: !data.canScan,
                onClick: cb.onScan
            }))
        } else if (data.mirror) {
            const mirrorTag = document.createElement("span")
            mirrorTag.textContent = "Tracking from another tab"
            mirrorTag.style.cssText = "font-size:var(--aes-fs-small);font-style:italic;color:var(--aes-slate);"
            actions.append(mirrorTag)
        } else {
            actions.append(MarketPanelHeader._btn({
                label: "Cancel",
                tooltip: "Stop the running scan",
                variant: "danger",
                onClick: cb.onCancel
            }))
        }
        if (!running && data.scanId) {
            actions.append(MarketPanelHeader._btn({
                label: "↻ Refresh",
                tooltip: "Re-run the last preset",
                disabled: !data.canRefresh,
                onClick: cb.onRefresh
            }))
        }
        if (!running) {
            actions.append(MarketPanelHeader._btn({
                label: "Save preset",
                tooltip: "Save the current scope chips as a named preset",
                disabled: !data.canSavePreset,
                onClick: cb.onSavePreset
            }))
        }

        actions.append(MarketPanelHeader._scheduleControl(data, cb))

        host.append(actions)
    }

    /**
     * Compact "⏰" chip that opens an inline popover for the auto-rescan
     * scheduler. Shows the next-run countdown when armed; idle when off.
     */
    static _scheduleControl(data, cb) {
        const sched = data.schedule || {}
        const wrap = document.createElement("div")
        wrap.style.cssText = "position:relative;flex:0 0 auto;"

        const label = MarketPanelHeader._scheduleLabel(sched)
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "aes-btn aes-btn--sm" + (sched.enabled ? " aes-btn--primary" : "")
        btn.textContent = label
        btn.title = sched.enabled
            ? "Auto-rescan armed — click to edit"
            : "Schedule a recurring rescan of a preset"
        wrap.append(btn)

        let panel = null
        let onDoc = null
        const close = () => {
            if (!panel) return
            panel.remove()
            panel = null
            if (onDoc) document.removeEventListener("click", onDoc, true)
            onDoc = null
        }
        btn.addEventListener("click", (e) => {
            e.stopPropagation()
            if (panel) { close(); return }
            panel = MarketPanelHeader._schedulePopover(data, cb, close)
            wrap.append(panel)
            setTimeout(() => {
                onDoc = (ev) => {
                    if (panel && (panel.contains(ev.target) || btn.contains(ev.target))) return
                    close()
                }
                document.addEventListener("click", onDoc, true)
            }, 0)
        })
        return wrap
    }

    static _scheduleLabel(sched) {
        if (!sched || !sched.enabled) return "⏰ Schedule"
        const cadence = Math.max(1, Number(sched.cadenceMin) || 60)
        const last = Number(sched.lastRunAt) || 0
        if (!last) return "⏰ in <" + cadence + "m"
        const remaining = cadence * 60 * 1000 - (Date.now() - last)
        if (remaining <= 0) return "⏰ now"
        const mins = Math.max(1, Math.round(remaining / 60000))
        return "⏰ " + mins + "m"
    }

    static _schedulePopover(data, cb, close) {
        const sched = data.schedule || {}
        const panel = document.createElement("div")
        panel.style.cssText = [
            "position:absolute", "top:calc(100% + 4px)", "right:0",
            "z-index:10001", "min-width:240px",
            "background:var(--aes-paper)",
            "border:1px solid var(--aes-paper-rule)",
            "box-shadow:0 8px 24px rgba(0,0,0,0.18)",
            "padding:10px", "display:flex", "flex-direction:column", "gap:8px"
        ].join(";")
        panel.addEventListener("click", (e) => e.stopPropagation())

        const title = document.createElement("div")
        title.textContent = "Auto-rescan"
        title.style.cssText = [
            "font:10px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase", "color:var(--aes-ink)"
        ].join(";")
        panel.append(title)

        const enabledRow = document.createElement("label")
        enabledRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;cursor:pointer;"
        const enabledCb = document.createElement("input")
        enabledCb.type = "checkbox"
        enabledCb.checked = !!sched.enabled
        enabledCb.addEventListener("change", () => {
            if (typeof cb.onScheduleChange === "function") {
                cb.onScheduleChange({enabled: enabledCb.checked})
            }
        })
        enabledRow.append(enabledCb,
            document.createTextNode("Run rescans automatically"))
        panel.append(enabledRow)

        const cadenceRow = document.createElement("div")
        cadenceRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;"
        cadenceRow.append(document.createTextNode("Every"))
        const cadenceSel = document.createElement("select")
        cadenceSel.className = "aes-select"
        cadenceSel.style.cssText = "font-size:var(--aes-fs-small);flex:0 0 auto;"
        for (const v of [15, 30, 60, 120, 240, 480]) {
            const o = document.createElement("option")
            o.value = String(v)
            o.textContent = v < 60 ? (v + " min")
                : (v % 60 === 0 ? (v / 60) + "h" : Math.round(v / 60 * 10) / 10 + "h")
            if (Number(sched.cadenceMin) === v) o.selected = true
            cadenceSel.append(o)
        }
        cadenceSel.addEventListener("change", () => {
            if (typeof cb.onScheduleChange === "function") {
                cb.onScheduleChange({cadenceMin: Number(cadenceSel.value)})
            }
        })
        cadenceRow.append(cadenceSel)
        panel.append(cadenceRow)

        const presetRow = document.createElement("div")
        presetRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;flex-wrap:wrap;"
        presetRow.append(document.createTextNode("Preset"))
        const presetSel = document.createElement("select")
        presetSel.className = "aes-select"
        presetSel.style.cssText = "flex:1 1 100%;font-size:var(--aes-fs-small);min-width:0;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = data.presets && data.presets.length
            ? "— pick a preset —"
            : "Save a preset first"
        placeholder.disabled = true
        placeholder.selected = !sched.presetId
        presetSel.append(placeholder)
        for (const p of (data.presets || [])) {
            const o = document.createElement("option")
            o.value = p.id
            o.textContent = p.name + " (" + (p.types || []).length + ")"
            if (sched.presetId === p.id) o.selected = true
            presetSel.append(o)
        }
        presetSel.addEventListener("change", () => {
            if (typeof cb.onScheduleChange === "function") {
                cb.onScheduleChange({presetId: presetSel.value || null})
            }
        })
        presetRow.append(presetSel)
        panel.append(presetRow)

        const note = document.createElement("div")
        note.textContent = "Ticks while this market tab is open."
        note.style.cssText = "font-size:11px;color:var(--aes-slate);font-style:italic;"
        panel.append(note)

        const closeBtn = MarketPanelHeader._btn({
            label: "Done",
            onClick: close
        })
        closeBtn.style.cssText = "align-self:flex-end;"
        panel.append(closeBtn)
        return panel
    }

    static _statusText(data) {
        const fmt = MarketPanelHeader.STATUS_FORMAT[data.status]
        if (fmt) return fmt(data)
        return "No scan yet · pick a preset or set scope below, then Scan"
    }

    static _btn({label, tooltip, variant, disabled, onClick}) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        if (tooltip) b.title = tooltip
        b.disabled = !!disabled
        b.className = "aes-btn aes-btn--sm"
            + (variant === "primary" ? " aes-btn--primary"
              : variant === "danger" ? " aes-btn--danger" : "")
        if (!disabled && typeof onClick === "function") {
            b.addEventListener("click", onClick)
        }
        return b
    }

    static _iconBtn(glyph, tooltip, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = glyph
        if (tooltip) {
            b.title = tooltip
            b.setAttribute("aria-label", tooltip)
        }
        b.className = "aes-btn aes-btn--ghost aes-btn--icon"
        if (typeof onClick === "function") b.addEventListener("click", onClick)
        return b
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelHeader
