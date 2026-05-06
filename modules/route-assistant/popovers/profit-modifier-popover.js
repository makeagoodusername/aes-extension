/**
 * RouteAssistantProfitModifierPopover
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantProfitModifierPopover {
    constructor(panel) {
        this.panel = panel;
    }

open(row, anchorEl) {
    if (!row || !this.panel.hubIata) return
    this.panel.close()

    const hubU    = String(this.panel.hubIata).toUpperCase()
    const destU   = String(row.destIata).toUpperCase()
    const pairKey = hubU + "-" + destU
    const econ    = (this.panel.settings && this.panel.settings.economics) || {}
    const existing = row.override || {}

    const pop = document.createElement("div")
    pop.tabIndex = -1
    Object.assign(pop.style, {
        position:   "fixed",
        background: "#1f2937",
        color:      "#f3f4f6",
        border:     "1px solid #4c1d95",
        borderRadius: "5px",
        boxShadow:  "0 8px 25px rgba(0,0,0,0.55)",
        padding:    "10px 12px",
        zIndex:     "10002",
        minWidth:   "240px",
        font:       "11px/1.5 sans-serif"
    })

    const title = document.createElement("strong")
    title.textContent = `Modify · ${hubU} → ${destU}`
    title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:12px;"

    const sub = document.createElement("div")
    sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;line-height:1.45;"
    const baseYield = existing.yieldPerKm != null ? existing.yieldPerKm
                    : (econ.yieldPerKm != null ? econ.yieldPerKm : 0.10)
    const baseCYld  = existing.cargoYieldPerKgKm != null ? existing.cargoYieldPerKgKm
                    : (econ.cargoYieldPerKgKm != null ? econ.cargoYieldPerKgKm : 0)
    sub.innerHTML = "Quick-edit ticket-price + LF for this route. Empty = inherit base economics.<br>"
        + "<span style='color:#6b7280;'>Effective ticket ≈ yield × distance (one-way).</span>"

    const yieldInput  = mkNumberInput(numOrNull(existing.yieldPerKm),        {min: 0, max: 10,  step: 0.01,   width: "80px"})
    const paxLfInput  = mkNumberInput(numOrNull(existing.paxLF),             {min: 0, max: 1,   step: 0.05,   width: "80px"})
    const cyldInput   = mkNumberInput(numOrNull(existing.cargoYieldPerKgKm), {min: 0, max: 1,   step: 0.0001, width: "80px"})
    const cLfInput    = mkNumberInput(numOrNull(existing.cargoLF),           {min: 0, max: 1,   step: 0.05,   width: "80px"})

    // Live preview of the effective one-way ticket price as the user
    // types. Distance × yield is the simplest read of "what will an
    // average pax pay" — Y/C/F per-class fares come with Tier 2.
    const previewLine = document.createElement("div")
    previewLine.style.cssText = "color:#cbd5e1;font-size:10px;margin-bottom:6px;font-style:italic;"
    const dist = row.distanceKm
    const updatePreview = () => {
        const y = parseFloatOr(yieldInput.value, baseYield)
        if (!dist) { previewLine.textContent = ""; return }
        const oneWay = y * dist
        previewLine.textContent = "≈ AS$" + Math.round(oneWay).toLocaleString()
            + " one-way ticket  (yield × " + dist.toLocaleString() + " km)"
    }
    updatePreview()

    const grid = document.createElement("div")
    grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:center;margin-bottom:6px;"
    const addRow = (label, input) => {
        const lab = document.createElement("label")
        lab.textContent = label
        lab.style.cssText = "color:#9ca3af;"
        grid.append(lab, input)
    }
    addRow("Yield AS$/pax-km", yieldInput)
    addRow("Pax LF",           paxLfInput)
    addRow("Cargo AS$/kg-km",  cyldInput)
    addRow("Cargo LF",         cLfInput)

    for (const inp of [yieldInput, paxLfInput, cyldInput, cLfInput]) {
        inp.addEventListener("input", updatePreview)
    }

    const btnRow = document.createElement("div")
    btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap;"

    const cancelBtn = document.createElement("button")
    cancelBtn.textContent = "Cancel"
    Object.assign(cancelBtn.style, smallBtnStyle())
    cancelBtn.style.background = "#475569"
    cancelBtn.style.fontSize = "10px"
    cancelBtn.style.padding = "2px 8px"
    cancelBtn.addEventListener("click", () => this.panel._closeProfitPopover())

    const clearBtn = document.createElement("button")
    clearBtn.textContent = "Clear"
    Object.assign(clearBtn.style, smallBtnStyle())
    clearBtn.style.background = "#7f1d1d"
    clearBtn.style.fontSize = "10px"
    clearBtn.style.padding = "2px 8px"
    clearBtn.disabled = !row.override
    if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
    clearBtn.addEventListener("click", async () => {
        const prev = row.override ? Object.assign({}, row.override) : null
        await this.panel._undoableSave({
            label: "Override cleared for " + hubU + "→" + destU,
            type:  "info",
            perform: async () => {
                await RouteAssistantRouteOverridesStore.remove(hubU, destU)
                row.override = null
                this.panel.overrideMap.delete(pairKey)
                this.panel._recomputeProfit()
            },
            restore: prev
                ? async () => {
                    const restored = await RouteAssistantRouteOverridesStore.save(hubU, destU,
                        {paxLF: prev.paxLF, cargoLF: prev.cargoLF, yieldPerKm: prev.yieldPerKm,
                         cargoYieldPerKgKm: prev.cargoYieldPerKgKm, note: prev.note || "",
                         expiresAt: prev.expiresAt != null ? prev.expiresAt : null})
                    row.override = restored
                    if (restored) this.panel.overrideMap.set(pairKey, restored)
                    this.panel._recomputeProfit()
                }
                : null
        })
        this.panel._closeProfitPopover()
    })

    const editBtn = document.createElement("button")
    editBtn.textContent = "Full editor…"
    Object.assign(editBtn.style, smallBtnStyle())
    editBtn.style.background = "#475569"
    editBtn.style.fontSize = "10px"
    editBtn.style.padding = "2px 8px"
    editBtn.title = "Open the full editor (adds note + Calibrate-from-actuals)"
    editBtn.addEventListener("click", () => {
        this.panel._closeProfitPopover()
        this.panel._openOverrideEditor(row)
    })

    const saveBtn = document.createElement("button")
    saveBtn.textContent = "Save"
    Object.assign(saveBtn.style, smallBtnStyle())
    saveBtn.style.fontSize = "10px"
    saveBtn.style.padding = "2px 8px"
    saveBtn.addEventListener("click", async () => {
        const fields = {
            paxLF:             numOrNull(paxLfInput.value),
            cargoLF:           numOrNull(cLfInput.value),
            yieldPerKm:        numOrNull(yieldInput.value),
            cargoYieldPerKgKm: numOrNull(cyldInput.value),
            note:              existing.note || "",   // preserve any note set in full editor
            // Q3 — preserve any expiresAt set via the full editor.
            // The profit-modifier popover doesn't expose an expiry
            // input (would clutter the inline-edit popover), so
            // carrying prev forward keeps the user's TTL intact.
            expiresAt:         existing.expiresAt != null ? existing.expiresAt : null
        }
        const prev = row.override ? Object.assign({}, row.override) : null
        await this.panel._undoableSave({
            label: "Override saved for " + hubU + "→" + destU,
            perform: async () => {
                const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
                row.override = saved
                if (saved) this.panel.overrideMap.set(pairKey, saved)
                else       this.panel.overrideMap.delete(pairKey)
                this.panel._recomputeProfit()
            },
            restore: async () => {
                if (prev) {
                    const restored = await RouteAssistantRouteOverridesStore.save(hubU, destU,
                        {paxLF: prev.paxLF, cargoLF: prev.cargoLF, yieldPerKm: prev.yieldPerKm,
                         cargoYieldPerKgKm: prev.cargoYieldPerKgKm, note: prev.note || "",
                         expiresAt: prev.expiresAt != null ? prev.expiresAt : null})
                    row.override = restored
                    if (restored) this.panel.overrideMap.set(pairKey, restored)
                } else {
                    await RouteAssistantRouteOverridesStore.remove(hubU, destU)
                    row.override = null
                    this.panel.overrideMap.delete(pairKey)
                }
                this.panel._recomputeProfit()
            }
        })
        this.panel._closeProfitPopover()
    })

    btnRow.append(cancelBtn, clearBtn, editBtn, saveBtn)
    pop.append(title, sub, grid, previewLine, btnRow)

    document.body.append(pop)
    this.panel._profitPopover = pop

    // Position next to the caret. Prefer below; flip above when too
    // close to the bottom edge of the viewport.
    const r = anchorEl.getBoundingClientRect()
    const popRect = pop.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    let top = r.bottom + 6
    if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
    let left = r.right - popRect.width
    if (left < 8) left = 8
    if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
    pop.style.top  = top  + "px"
    pop.style.left = left + "px"

    yieldInput.focus()
    yieldInput.select && yieldInput.select()

    // Outside-click + Escape close. Schedule the listener on the next
    // tick so the click that opened us doesn't immediately dismiss it.
    const onMouseDown = (e) => {
        if (pop.contains(e.target)) return
        if (e.target === anchorEl) return
        this.panel._closeProfitPopover()
    }
    const onKey = (e) => { if (e.key === "Escape") this.panel._closeProfitPopover() }
    setTimeout(() => {
        document.addEventListener("mousedown", onMouseDown)
        document.addEventListener("keydown",   onKey)
    }, 0)
    this.panel._profitPopoverCleanup = () => {
        document.removeEventListener("mousedown", onMouseDown)
        document.removeEventListener("keydown",   onKey)
    }
}

_closeProfitPopover() {
    if (this.panel._profitPopoverCleanup) {
        try { this.panel._profitPopoverCleanup() } catch (e) { /* noop */ }
        this.panel._profitPopoverCleanup = null
    }
    if (this.panel._profitPopover && this.panel._profitPopover.parentNode) {
        this.panel._profitPopover.parentNode.removeChild(this.panel._profitPopover)
    }
    this.panel._profitPopover = null
}

}

window.RouteAssistantProfitModifierPopover = RouteAssistantProfitModifierPopover;
