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
            : "No presets yet (use the dashboard)"
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
            actions.append(MarketPanelHeader._btn({
                label: "Scan now",
                tooltip: "Run the selected preset (or current AS filter) — opens hidden tabs.",
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

        host.append(actions)
    }

    static _statusText(data) {
        const fmt = MarketPanelHeader.STATUS_FORMAT[data.status]
        if (fmt) return fmt(data)
        return "No scan yet · pick a preset and click Scan"
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
        b.title = tooltip || ""
        b.className = "aes-btn aes-btn--ghost aes-btn--icon"
        if (typeof onClick === "function") b.addEventListener("click", onClick)
        return b
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelHeader
