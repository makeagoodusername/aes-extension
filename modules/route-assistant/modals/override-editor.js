/**
 * RouteAssistantOverrideEditor
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantOverrideEditor {
    constructor(panel) {
        this.panel = panel;
    }

open(row) {
    if (!row || !this.panel.hubIata) return
    if (this.panel._overrideEditor && this.panel._overrideEditor.parentNode) {
        this.panel._overrideEditor.parentNode.removeChild(this.panel._overrideEditor)
    }

    // Always uppercase before keying — buildRouteRows uppercases both ends
    // when hydrating row.override, so this match must be consistent.
    const hubU  = String(this.panel.hubIata).toUpperCase()
    const destU = String(row.destIata).toUpperCase()
    const pairKey = hubU + "-" + destU
    const existing = row.override || {}
    const overlay = document.createElement("div")
    Object.assign(overlay.style, {
        position: "fixed", inset: "0",
        background: "rgba(0,0,0,0.6)",
        zIndex: "10001",
        display: "flex", alignItems: "center", justifyContent: "center"
    })
    const close = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        this.panel._overrideEditor = null
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

    const card = document.createElement("div")
    Object.assign(card.style, {
        background: "#1f2937", color: "#f3f4f6",
        border: "1px solid #4c1d95", borderRadius: "6px",
        padding: "16px 18px", minWidth: "360px", maxWidth: "440px",
        boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
        font: "12px/1.5 sans-serif"
    })
    const title = document.createElement("strong")
    title.textContent = `Override · ${this.panel.hubIata} → ${row.destIata}`
    title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:13px;"
    const sub = document.createElement("div")
    sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
    sub.textContent = "Pin route-specific values. Empty = use demand-driven LF curve / configured base yield. Price pin excludes the route from auto-pricing."

    const paxLfInput   = mkNumberInput(numOrNull(existing.paxLF),             {min: 0, max: 1,   step: 0.05,   width: "70px"})
    const cargoLfInput = mkNumberInput(numOrNull(existing.cargoLF),           {min: 0, max: 1,   step: 0.05,   width: "70px"})
    const yldInput     = mkNumberInput(numOrNull(existing.yieldPerKm),        {min: 0, max: 10,  step: 0.01,   width: "70px"})
    const cyldInput    = mkNumberInput(numOrNull(existing.cargoYieldPerKgKm), {min: 0, max: 1,   step: 0.0001, width: "85px"})
    const pricePinInput = mkNumberInput(numOrNull(existing.pricePin),          {min: 50, max: 200, step: 1,      width: "70px"})
    const noteInput    = document.createElement("input")
    noteInput.type = "text"
    noteInput.maxLength = 200
    noteInput.placeholder = "e.g. measured 88% LF Q3"
    noteInput.value = existing.note || ""
    noteInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:2px 6px;font-size:11px;width:100%;box-sizing:border-box;"

    const grid = document.createElement("div")
    grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:12px;"
    const addRow = (label, input, hint) => {
        const lab = document.createElement("label")
        lab.textContent = label
        lab.style.cssText = "color:#9ca3af;font-size:11px;"
        lab.title = hint || ""
        const wrap = document.createElement("div")
        wrap.append(input)
        if (hint) {
            const h = document.createElement("span")
            h.textContent = " " + hint
            h.style.cssText = "color:#6b7280;font-size:10px;"
            wrap.append(h)
        }
        grid.append(lab, wrap)
    }
    addRow("Pax LF",            paxLfInput,   "0–1, e.g. 0.85")
    addRow("Cargo LF",          cargoLfInput, "0–1, e.g. 0.70")
    addRow("Yield AS$/pax-km",  yldInput,     "Beats base yield for this route only")
    addRow("Cargo AS$/kg-km",   cyldInput,    "Beats base cargo yield for this route only")
    addRow("Price pin %",       pricePinInput, "50-200; auto-pricing skips this route")
    addRow("Note",              noteInput,    "")

    // Q3 — Expires-in-days input. Empty = never expires (default
    // behaviour preserved). Saving with a value sets
    // expiresAt = Date.now() + days × 86400000 so the override
    // auto-falls-back to defaults after that date.
    const expiresWrap = document.createElement("div")
    expiresWrap.style.cssText = "display:flex;gap:6px;align-items:center;"
    const expiresInput = document.createElement("input")
    expiresInput.type = "number"
    expiresInput.min = "0"
    expiresInput.max = "3650"
    expiresInput.step = "1"
    expiresInput.placeholder = "never"
    expiresInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
        + "border-radius:3px;padding:2px 6px;font-size:11px;width:70px;"
    // Pre-fill with current days-remaining when an unexpired expiresAt
    // exists; show the timestamp text alongside for context.
    const existingDays = (existing.expiresAt != null)
        ? Math.max(0, Math.round((existing.expiresAt - Date.now()) / 86400000))
        : null
    if (existingDays != null) expiresInput.value = String(existingDays)
    const expiresHint = document.createElement("span")
    expiresHint.style.cssText = "color:#6b7280;font-size:10px;"
    if (existing.expiresAt != null) {
        const exp = new Date(existing.expiresAt)
        const expired = existing.expiresAt < Date.now()
        expiresHint.textContent = (expired ? "expired " : "expires ") + exp.toLocaleDateString()
        if (expired) expiresHint.style.color = "#f87171"
    } else {
        expiresHint.textContent = "days · empty = never expires"
    }
    expiresInput.addEventListener("input", () => {
        const v = Number(expiresInput.value)
        if (expiresInput.value === "" || !isFinite(v) || v <= 0) {
            expiresHint.textContent = "days · empty = never expires"
            expiresHint.style.color = "#6b7280"
            return
        }
        const newExp = new Date(Date.now() + v * 86400000)
        expiresHint.textContent = "expires " + newExp.toLocaleDateString()
        expiresHint.style.color = "#6b7280"
    })
    expiresWrap.append(expiresInput, expiresHint)
    addRow("Expires in", expiresWrap, "")

    const status = document.createElement("div")
    status.style.cssText = "color:#6b7280;font-size:10px;margin-bottom:10px;"
    status.textContent = existing && existing.updatedAt
        ? "Last updated " + new Date(existing.updatedAt).toLocaleString()
        : "No override saved yet."

    const buttonRow = document.createElement("div")
    buttonRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;"

    const cancelBtn = document.createElement("button")
    cancelBtn.textContent = "Cancel"
    Object.assign(cancelBtn.style, smallBtnStyle())
    cancelBtn.style.background = "#475569"
    cancelBtn.addEventListener("click", close)

    const clearBtn = document.createElement("button")
    clearBtn.textContent = "Clear override"
    Object.assign(clearBtn.style, smallBtnStyle())
    clearBtn.style.background = "#7f1d1d"
    clearBtn.disabled = !row.override
    if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
    clearBtn.addEventListener("click", async () => {
        await RouteAssistantRouteOverridesStore.remove(hubU, destU)
        row.override = null
        this.panel.overrideMap.delete(pairKey)
        this.panel._recomputeProfit()
        close()
    })

    const calibBtn = document.createElement("button")
    Object.assign(calibBtn.style, smallBtnStyle())
    calibBtn.style.background = "#7c3aed"
    const calibTarget = derivedYieldFromActuals(row)
    const calibSide = calibTarget && calibTarget.side
    calibBtn.disabled = !calibTarget
    calibBtn.textContent = calibSide === "cargo"
        ? "Calibrate cargo from actuals"
        : "Calibrate from actuals"
    if (!calibTarget) {
        calibBtn.style.opacity = "0.5"
        calibBtn.title = "Take a snapshot first — derives the base yield needed to reproduce the actuals at the current LF / aircraft."
    } else {
        const fieldLabel = calibSide === "cargo" ? "Cargo AS$/kg-km" : "Yield AS$/pax-km"
        const altNote = calibTarget.alt
            ? "\nThe other side (" + (calibTarget.alt.side === "cargo" ? "cargo" : "pax")
              + ") would calibrate to " + calibTarget.alt.value.toFixed(4)
              + " — paste manually if you'd rather pin that side."
            : ""
        calibBtn.title = "Pre-fills " + fieldLabel + " with " + calibTarget.value.toFixed(4)
            + " — the value that would make the estimator match the latest snapshot "
            + "at the current LF / spec.\nReview and Save to pin it as a route override."
            + altNote
    }
    calibBtn.addEventListener("click", () => {
        const v = derivedYieldFromActuals(row)
        if (!v) return
        const targetInput = v.side === "cargo" ? cyldInput : yldInput
        targetInput.value = v.value.toFixed(4)
        targetInput.focus()
        targetInput.select()
        const sideLabel = v.side === "cargo" ? "cargo yield" : "yield"
        const altLabel = v.alt
            ? "  (" + (v.alt.side === "cargo" ? "cargo" : "pax")
              + " alt: " + v.alt.value.toFixed(4) + ")"
            : ""
        sub.textContent = "Pre-filled " + sideLabel + " from snapshot — edit if you want, then Save."
            + altLabel
        sub.style.color = "#a78bfa"
    })

    const saveBtn = document.createElement("button")
    saveBtn.textContent = "Save"
    Object.assign(saveBtn.style, smallBtnStyle())
    saveBtn.addEventListener("click", async () => {
        // Q3 — translate "expires in N days" UI value into an absolute
        // unix-ms timestamp. Empty / zero / non-numeric → no expiry
        // (preserves the "never expires" default). Non-empty saves
        // start the clock at submit time, NOT at the original
        // override creation time, so editing an override resets the
        // expiration window — the user re-confirms intent.
        const expiresDays = Number(expiresInput.value)
        const expiresAt = (expiresInput.value === "" || !isFinite(expiresDays) || expiresDays <= 0)
            ? null
            : Date.now() + Math.round(expiresDays) * 86400000
        const fields = {
            paxLF:             numOrNull(paxLfInput.value),
            cargoLF:           numOrNull(cargoLfInput.value),
            yieldPerKm:        numOrNull(yldInput.value),
            cargoYieldPerKgKm: numOrNull(cyldInput.value),
            pricePin:          numOrNull(pricePinInput.value),
            note:              noteInput.value,
            expiresAt:         expiresAt
        }
        const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
        row.override = saved
        if (saved) this.panel.overrideMap.set(pairKey, saved)
        else this.panel.overrideMap.delete(pairKey)
        this.panel._recomputeProfit()
        close()
    })

    buttonRow.append(cancelBtn, calibBtn, clearBtn, saveBtn)
    card.append(title, sub, grid, status, buttonRow)
    overlay.append(card)
    document.body.append(overlay)
    this.panel._overrideEditor = overlay
    paxLfInput.focus()
}

/**
 * Apply a weight preset: each variable listed in preset.weights gets that
 * weight (and is enabled if weight > 0); variables not in the preset get
 * disabled with weight 0. Re-renders settings + table so the user sees
 * the new state immediately.
 */
async _applyWeightPreset(preset) {
    for (const f of RouteAssistantPanel.SCORING_FIELDS) {
        const cfg = this.panel.settings.scoring[f.field] = Object.assign(
            {enabled: false, weight: 1, direction: f.direction, min: null, max: null},
            this.panel.settings.scoring[f.field] || {}
        )
        if (preset.weights && preset.weights[f.field] !== undefined) {
            cfg.weight  = preset.weights[f.field]
            cfg.enabled = preset.weights[f.field] > 0
        } else {
            cfg.weight  = 0
            cfg.enabled = false
        }
    }
    await RouteAssistantSettings.save({scoring: this.panel.settings.scoring})
    this.panel._render()
    this.panel._renderSettings()
}

/**
 * Slice 2c — fleet-median α per class across the user's routes.
 * Reads each row's `ratingPriceElasticityByClass[cls]` and returns
 * the median of finite values per class. Skipped (returns null
 * fields) when fewer than 5 routes contribute — small sample makes
 * the median unstable, and the cascade resolver will fall through
 * to the global default instead.
 */
static _computeFleetMedianAlpha(rows) {
    const out = {Y: null, C: null, F: null, sampleSizes: {Y: 0, C: 0, F: 0}}
    if (!Array.isArray(rows) || !rows.length) return out
    for (const cls of ["Y", "C", "F"]) {
        const vals = []
        for (const r of rows) {
            if (!r || !r.ratingPriceElasticityByClass) continue
            const v = Number(r.ratingPriceElasticityByClass[cls])
            if (isFinite(v) && v >= 0) vals.push(v)
        }
        out.sampleSizes[cls] = vals.length
        if (vals.length >= 5) out[cls] = _median(vals)
    }
    return out
}
// ====== Tier 3 — pricing apply modals ==============================
//
// Two modals: a per-route apply (single-row apply CTA) and
// a bulk apply (table of all visible routes). Both share the same
// applier instance (`_getPricingApplier`) and share the apply log.

}

window.RouteAssistantOverrideEditor = RouteAssistantOverrideEditor;
