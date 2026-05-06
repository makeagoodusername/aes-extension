/**
 * RouteAssistantColumnPrefsModal
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantColumnPrefsModal {
    constructor(panel) {
        this.panel = panel;
    }

open() {
    const FROZEN = {score: 1, destIata: 1}
    const overlay = document.createElement("div")
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);"
        + "z-index:10001;display:flex;align-items:center;justify-content:center;"
    const modal = document.createElement("div")
    modal.style.cssText = "background:#1f2937;color:#f3f4f6;border:1px solid #374151;"
        + "border-radius:6px;padding:12px 16px;min-width:520px;max-width:80vw;"
        + "max-height:80vh;display:flex;flex-direction:column;font:12px/1.4 sans-serif;"

    const head = document.createElement("strong")
    head.textContent = "Configure columns & groups"
    head.style.cssText = "font-size:14px;margin-bottom:4px;"
    const meta = document.createElement("div")
    meta.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
    meta.textContent = "Hide individual columns or collapse whole groups. "
        + "Frozen columns (Sc, Dest) stay visible. Changes persist across reloads."

    const body = document.createElement("div")
    body.style.cssText = "overflow-y:auto;flex:1;border:1px solid #374151;"
        + "border-radius:4px;padding:8px 10px;margin-bottom:10px;background:#0f1623;"

    // Build a map of group → columns by walking COLUMNS in declaration
    // order so the modal reflects the table's actual column ordering.
    const groupOrder = []
    const groupCols  = {}
    for (const c of RouteAssistantPanel.COLUMNS) {
        if (!groupCols[c.group]) {
            groupCols[c.group] = []
            groupOrder.push(c.group)
        }
        groupCols[c.group].push(c)
    }

    const cp = (this.panel.settings && this.panel.settings.columnPrefs) || {hiddenFields: [], collapsedGroups: []}
    const hidden    = new Set(cp.hiddenFields    || [])
    const collapsed = new Set(cp.collapsedGroups || [])

    // Single funnel for every checkbox/toggle — keeps the in-memory
    // Sets, the panel settings, and chrome.storage in lockstep.
    const persist = async () => {
        const next = {
            hiddenFields:    Array.from(hidden),
            collapsedGroups: Array.from(collapsed)
        }
        this.panel.settings.columnPrefs = next
        try { await RouteAssistantSettings.save({columnPrefs: next}) } catch (e) { /* non-fatal */ }
    }

    for (const groupKey of groupOrder) {
        const def   = RouteAssistantPanel.COLUMN_GROUPS[groupKey] || {}
        const label = def.label || "(unlabeled)"
        const fset = document.createElement("fieldset")
        fset.style.cssText = "border:1px solid #374151;border-radius:4px;"
            + "padding:6px 10px 8px;margin:0 0 8px 0;"
        const legend = document.createElement("legend")
        legend.style.cssText = "padding:0 6px;color:#cbd5e1;font-size:11px;"
            + "font-weight:600;display:flex;gap:6px;align-items:center;"

        const collapseBtn = document.createElement("button")
        collapseBtn.type = "button"
        const refreshCollapseBtn = () => {
            const isC = collapsed.has(groupKey)
            collapseBtn.textContent = isC ? "▸ Expand group" : "▾ Collapse group"
            collapseBtn.title = isC
                ? "Expand the " + label + " group in the table"
                : "Collapse the " + label + " group to a single … placeholder cell"
        }
        collapseBtn.style.cssText = "background:#1f2937;color:#cbd5e1;"
            + "border:1px solid #475569;border-radius:3px;padding:1px 7px;"
            + "font-size:10px;cursor:pointer;line-height:1.4;"
        refreshCollapseBtn()
        collapseBtn.addEventListener("click", async () => {
            if (collapsed.has(groupKey)) collapsed.delete(groupKey)
            else collapsed.add(groupKey)
            refreshCollapseBtn()
            await persist()
        })

        const labText = document.createElement("span")
        labText.textContent = label
        legend.append(labText, collapseBtn)
        fset.append(legend)

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:repeat(3, 1fr);"
            + "gap:2px 12px;margin-top:4px;"
        for (const c of groupCols[groupKey]) {
            const row = document.createElement("label")
            row.style.cssText = "display:flex;gap:6px;align-items:center;"
                + "padding:1px 0;cursor:pointer;color:#e5e7eb;font-size:11px;"
            const cb = document.createElement("input")
            cb.type = "checkbox"
            const isFrozen = !!FROZEN[c.field]
            cb.checked  = isFrozen ? true : !hidden.has(c.field)
            cb.disabled = isFrozen
            if (isFrozen) {
                row.style.opacity = "0.55"
                row.style.cursor  = "default"
                row.title = "Frozen sticky-left column — always visible."
            }
            cb.addEventListener("change", async () => {
                if (isFrozen) return
                if (cb.checked) hidden.delete(c.field)
                else            hidden.add(c.field)
                await persist()
            })
            const txt = document.createElement("span")
            txt.textContent = c.label + (isFrozen ? " · frozen" : "")
            row.append(cb, txt)
            grid.append(row)
        }
        fset.append(grid)
        body.append(fset)
    }

    const btnRow = document.createElement("div")
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:space-between;align-items:center;"
    const resetBtn = document.createElement("button")
    resetBtn.type = "button"
    resetBtn.textContent = "Show all columns"
    Object.assign(resetBtn.style, smallBtnStyle())
    resetBtn.style.background = "#374151"
    resetBtn.addEventListener("click", async () => {
        hidden.clear()
        collapsed.clear()
        await persist()
        close()
        this.panel._render()
    })
    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.textContent = "Close"
    Object.assign(closeBtn.style, smallBtnStyle())
    const close = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        document.removeEventListener("keydown", onKey)
        overlay.removeEventListener("click", onOverlayClick)
    }
    const onKey = (e) => { if (e.key === "Escape") { close(); this.panel._render() } }
    const onOverlayClick = (e) => { if (e.target === overlay) { close(); this.panel._render() } }
    closeBtn.addEventListener("click", () => { close(); this.panel._render() })
    btnRow.append(resetBtn, closeBtn)

    modal.append(head, meta, body, btnRow)
    overlay.append(modal)
    document.body.appendChild(overlay)
    document.addEventListener("keydown", onKey)
    overlay.addEventListener("click", onOverlayClick)
}

/** Resolve the active view tab safely; defaults to "all". */
}

window.RouteAssistantColumnPrefsModal = RouteAssistantColumnPrefsModal;
