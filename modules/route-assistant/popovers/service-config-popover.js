/**
 * RouteAssistantServiceConfigPopover
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantServiceConfigPopover {
    constructor(panel) {
        this.panel = panel;
    }

open(row, anchorEl) {
    if (!row || !this.panel.hubIata) return
    if (typeof RouteAssistantServiceConfigStore === "undefined") return
    this.panel.close()

    const hubU    = String(this.panel.hubIata).toUpperCase()
    const destU   = String(row.destIata).toUpperCase()
    const pairKey = hubU + "-" + destU
    const defaults = (this.panel.settings && this.panel.settings.serviceProfiles) || {}
    const eff = RouteAssistantServiceConfigStore.resolveEffective(row.serviceConfig, defaults)
    const recordFares = (row.serviceConfig && row.serviceConfig.classFares) || {}

    const pop = document.createElement("div")
    pop.tabIndex = -1
    Object.assign(pop.style, {
        position:   "fixed",
        background: "#1f2937",
        color:      "#f3f4f6",
        border:     "1px solid #0ea5e9",
        borderRadius: "5px",
        boxShadow:  "0 8px 25px rgba(0,0,0,0.55)",
        padding:    "10px 12px",
        zIndex:     "10002",
        minWidth:   "320px",
        font:       "11px/1.5 sans-serif"
    })

    const title = document.createElement("strong")
    title.textContent = `Service · ${hubU} → ${destU}`
    title.style.cssText = "color:#7dd3fc;display:block;margin-bottom:4px;font-size:12px;"

    const sub = document.createElement("div")
    sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;line-height:1.45;"
    sub.innerHTML = "Class mix percentages auto-renormalise to 100% on save. Empty per-class field = inherit defaults from Settings → Service profiles."

    // ---- Auto-detected source line (markets-page sync — when present)
    if (row.serviceProfileName || row.serviceProfileId
            || (row.classMixSource === "tail")
            || (row.ownPricing && Object.keys(row.ownPricing).length)) {
        const detected = []
        if (row.classMixSource === "tail") {
            detected.push("mix from assigned tail")
        }
        if (row.ownPricing) {
            const fares = []
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                if (row.ownPricing[cls] != null) fares.push(cls + " " + row.ownPricing[cls])
            }
            if (fares.length) detected.push("AS fares: " + fares.join(" / "))
        }
        if (row.serviceProfileName || row.serviceProfileId) {
            const cache = this.panel.serviceProfilesCache || new Map()
            const detail = row.serviceProfileId ? cache.get(row.serviceProfileId) : null
            let txt = "AS profile: " + (row.serviceProfileName || ("#" + row.serviceProfileId))
            if (detail && detail.classScore) {
                const cs = detail.classScore
                txt += " (Y=" + (cs.Y != null ? cs.Y.toFixed(2) : "?")
                    + " · C=" + (cs.C != null ? cs.C.toFixed(2) : "?")
                    + " · F=" + (cs.F != null ? cs.F.toFixed(2) : "?") + ")"
            }
            detected.push(txt)
        }
        if (detected.length) {
            const auto = document.createElement("div")
            auto.style.cssText = "color:#86efac;font-size:10px;margin-bottom:8px;padding:4px 6px;"
                + "background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.30);border-radius:3px;"
            auto.textContent = "Auto-detected · " + detected.join(" · ")
            pop.append(title, sub, auto)
        } else {
            pop.append(title, sub)
        }
    } else {
        pop.append(title, sub)
    }

    // ---- Class mix row
    const yMix = mkNumberInput(Math.round((eff.classMix.Y || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
    const cMix = mkNumberInput(Math.round((eff.classMix.C || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
    const fMix = mkNumberInput(Math.round((eff.classMix.F || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
    const mixRow = document.createElement("div")
    mixRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;"
    const mixLbl = document.createElement("span")
    mixLbl.style.cssText = "color:#9ca3af;"
    mixLbl.textContent = "Mix %"
    const chipFor = (label, input, color) => {
        const w = document.createElement("label")
        w.style.cssText = "display:flex;gap:3px;align-items:center;color:" + color + ";"
        w.append(document.createTextNode(label), input)
        return w
    }
    const mixSum = document.createElement("span")
    mixSum.style.cssText = "color:#94a3b8;font-size:10px;"
    const updateMixSum = () => {
        const s = (parseFloatOr(yMix.value, 0) || 0)
            + (parseFloatOr(cMix.value, 0) || 0)
            + (parseFloatOr(fMix.value, 0) || 0)
        mixSum.textContent = "Σ " + Math.round(s) + "%"
        mixSum.style.color = Math.abs(s - 100) < 0.5 ? "#86efac" : "#fbbf24"
    }
    updateMixSum()
    for (const inp of [yMix, cMix, fMix]) inp.addEventListener("input", updateMixSum)
    mixRow.append(mixLbl,
        chipFor("Y", yMix, "#7dd3fc"),
        chipFor("C", cMix, "#fcd34d"),
        chipFor("F", fMix, "#fda4af"),
        mixSum)

    // ---- Service level
    const levels = defaults.serviceLevels || {}
    const svcSelOptions = []
    for (const k of RouteAssistantServiceConfigStore.SERVICE_LEVELS) {
        const lvl = levels[k] || {}
        svcSelOptions.push({
            value: k,
            label: (lvl.label || (k.charAt(0).toUpperCase() + k.slice(1)))
                + "  ×" + (lvl.yieldMult != null ? Number(lvl.yieldMult).toFixed(2) : "?")
                + "  +AS$" + (lvl.costPerPax != null ? Math.round(lvl.costPerPax) : "?") + "/pax"
        })
    }
    const svcSel = mkSelect(svcSelOptions)
    svcSel.value = eff.serviceLevel
    svcSel.style.fontSize = "11px"
    const svcRow = document.createElement("div")
    svcRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:8px;"
    const svcLbl = document.createElement("span")
    svcLbl.style.cssText = "color:#9ca3af;"
    svcLbl.textContent = "Service level:"
    svcRow.append(svcLbl, svcSel)

    // ---- Per-class fares table
    const fareTable = document.createElement("table")
    fareTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
    fareTable.innerHTML = `<thead><tr>
        <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Class</th>
        <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield AS$/km</th>
        <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
        <th style="text-align:left;padding:2px 4px;color:#6b7280;font-weight:normal;font-size:10px;">defaults</th>
    </tr></thead>`
    const fareBody = document.createElement("tbody")
    const fareInputs = {Y: {}, C: {}, F: {}}
    const classColors = {Y: "#7dd3fc", C: "#fcd34d", F: "#fda4af"}
    for (const cls of RouteAssistantServiceConfigStore.CLASSES) {
        const f = eff.classFares[cls]
        const recF = recordFares[cls] || {}
        const yldIn  = mkNumberInput(numOrNull(recF.yieldPerKm), {min: 0, max: 10,    step: 0.01, width: "75px"})
        const costIn = mkNumberInput(numOrNull(recF.costPerPax), {min: 0, max: 99999, step: 1,    width: "70px"})
        fareInputs[cls].yld  = yldIn
        fareInputs[cls].cost = costIn
        const tr = document.createElement("tr")
        const cell = (text, align, color, font) => {
            const c = document.createElement("td")
            c.style.cssText = "padding:2px 4px;text-align:" + (align || "left") + ";color:" + (color || "#d1d5db") + ";"
            if (font) c.style.fontFamily = font
            c.textContent = text
            return c
        }
        tr.append(cell(cls, "left", classColors[cls], null))
        const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
        const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
        tr.append(yldCell, costCell)
        const defNote = "y×" + (f.yieldMult || 1).toFixed(2)
            + " · AS$" + Math.round(f.costPerPax || 0)
        tr.append(cell(defNote, "left", "#6b7280", "monospace"))
        fareBody.append(tr)
    }
    fareTable.append(fareBody)

    // ---- Buttons
    const btnRow = document.createElement("div")
    btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap;"
    const cancelBtn = document.createElement("button")
    cancelBtn.textContent = "Cancel"
    Object.assign(cancelBtn.style, smallBtnStyle())
    cancelBtn.style.background = "#475569"
    cancelBtn.style.fontSize = "10px"
    cancelBtn.style.padding = "2px 8px"
    cancelBtn.addEventListener("click", () => this.panel._closeServicePopover())

    const clearBtn = document.createElement("button")
    clearBtn.textContent = "Clear"
    Object.assign(clearBtn.style, smallBtnStyle())
    clearBtn.style.background = "#7f1d1d"
    clearBtn.style.fontSize = "10px"
    clearBtn.style.padding = "2px 8px"
    clearBtn.disabled = !row.serviceConfig
    if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
    clearBtn.addEventListener("click", async () => {
        await RouteAssistantServiceConfigStore.remove(hubU, destU)
        row.serviceConfig = null
        this.panel.serviceConfigMap.delete(pairKey)
        this.panel._reapplyServiceProjection()
        this.panel._renderRows()
        this.panel._closeServicePopover()
    })

    const saveBtn = document.createElement("button")
    saveBtn.textContent = "Save"
    Object.assign(saveBtn.style, smallBtnStyle())
    saveBtn.style.fontSize = "10px"
    saveBtn.style.padding = "2px 8px"
    saveBtn.addEventListener("click", async () => {
        const fields = {
            classMix: {
                Y: parseFloatOr(yMix.value, 0) || 0,
                C: parseFloatOr(cMix.value, 0) || 0,
                F: parseFloatOr(fMix.value, 0) || 0
            },
            serviceLevel: svcSel.value,
            classFares: {
                Y: {yieldPerKm: numOrNull(fareInputs.Y.yld.value), costPerPax: numOrNull(fareInputs.Y.cost.value)},
                C: {yieldPerKm: numOrNull(fareInputs.C.yld.value), costPerPax: numOrNull(fareInputs.C.cost.value)},
                F: {yieldPerKm: numOrNull(fareInputs.F.yld.value), costPerPax: numOrNull(fareInputs.F.cost.value)}
            }
        }
        const saved = await RouteAssistantServiceConfigStore.save(hubU, destU, fields)
        row.serviceConfig = saved
        if (saved) this.panel.serviceConfigMap.set(pairKey, saved)
        else       this.panel.serviceConfigMap.delete(pairKey)
        this.panel._reapplyServiceProjection()
        this.panel._renderRows()
        this.panel._closeServicePopover()
    })
    btnRow.append(cancelBtn, clearBtn, saveBtn)

    // Title + sub + (optional auto-detected banner) were appended above
    // already; we just need the rest of the controls.
    pop.append(mixRow, svcRow, fareTable, btnRow)
    document.body.append(pop)
    this.panel._servicePopover = pop

    const r = anchorEl.getBoundingClientRect()
    const popRect = pop.getBoundingClientRect()
    const vh = window.innerHeight, vw = window.innerWidth
    let top  = r.bottom + 6
    if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
    let left = r.right - popRect.width
    if (left < 8) left = 8
    if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
    pop.style.top  = top  + "px"
    pop.style.left = left + "px"
    yMix.focus(); yMix.select && yMix.select()

    const onMouseDown = (e) => {
        if (pop.contains(e.target)) return
        if (e.target === anchorEl) return
        this.panel._closeServicePopover()
    }
    const onKey = (e) => { if (e.key === "Escape") this.panel._closeServicePopover() }
    setTimeout(() => {
        document.addEventListener("mousedown", onMouseDown)
        document.addEventListener("keydown",   onKey)
    }, 0)
    this.panel._servicePopoverCleanup = () => {
        document.removeEventListener("mousedown", onMouseDown)
        document.removeEventListener("keydown",   onKey)
    }
}

_closeServicePopover() {
    if (this.panel._servicePopoverCleanup) {
        try { this.panel._servicePopoverCleanup() } catch (e) { /* noop */ }
        this.panel._servicePopoverCleanup = null
    }
    if (this.panel._servicePopover && this.panel._servicePopover.parentNode) {
        this.panel._servicePopover.parentNode.removeChild(this.panel._servicePopover)
    }
    this.panel._servicePopover = null
}

/**
 * Re-project service config across all rows after a save/clear without
 * a full refresh. Cheap: aggregator's projector reads each row's
 * existing estimator output + the now-updated map.
 */
}

window.RouteAssistantServiceConfigPopover = RouteAssistantServiceConfigPopover;
