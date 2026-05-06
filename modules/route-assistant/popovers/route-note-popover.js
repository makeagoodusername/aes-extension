/**
 * RouteAssistantRouteNotePopover
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantRouteNotePopover {
    constructor(panel) {
        this.panel = panel;
    }

open(row, anchorEl) {
    if (!row || !this.panel.hubIata) return
    this.panel.close()
    const hubU    = String(this.panel.hubIata).toUpperCase()
    const destU   = String(row.destIata).toUpperCase()
    const pairKey = hubU + "-" + destU
    const existingText = (row.routeNote && typeof row.routeNote.text === "string")
        ? row.routeNote.text : ""
    const updatedAt = (row.routeNote && row.routeNote.updatedAt) || null
    const pop = document.createElement("div")
    pop.tabIndex = -1
    Object.assign(pop.style, {
        position:     "fixed",
        background:   "#1f2937",
        color:        "#f3f4f6",
        border:       "1px solid #475569",
        borderRadius: "5px",
        boxShadow:    "0 8px 25px rgba(0,0,0,0.55)",
        padding:      "10px 12px",
        zIndex:       "10002",
        minWidth:     "320px",
        font:         "11px/1.5 sans-serif"
    })
    const titleEl = document.createElement("strong")
    titleEl.textContent = "Note · " + hubU + " → " + destU
    titleEl.style.cssText = "color:#cbd5e1;display:block;margin-bottom:4px;font-size:12px;"
    const sub = document.createElement("div")
    sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;"
    sub.textContent = updatedAt
        ? "Last updated " + new Date(updatedAt).toLocaleString()
        : "Capture context — strategy thoughts, observations, things to watch."
    const ta = document.createElement("textarea")
    ta.value = existingText
    ta.maxLength = RouteAssistantRouteNoteStore.MAX_TEXT_LEN
    ta.rows = 5
    ta.style.cssText = "width:100%;box-sizing:border-box;background:#0f1623;"
        + "color:#f3f4f6;border:1px solid #374151;border-radius:3px;"
        + "padding:5px;font-size:11px;font-family:inherit;resize:vertical;"
    const counter = document.createElement("div")
    counter.style.cssText = "color:#6b7280;font-size:10px;text-align:right;margin-top:2px;"
    const btnRow = document.createElement("div")
    btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:8px;"
    const cancelBtn = document.createElement("button")
    cancelBtn.textContent = "Cancel"
    Object.assign(cancelBtn.style, smallBtnStyle())
    cancelBtn.style.background = "#475569"
    cancelBtn.style.fontSize = "10px"
    cancelBtn.style.padding = "2px 8px"
    const deleteBtn = document.createElement("button")
    deleteBtn.textContent = "Delete"
    Object.assign(deleteBtn.style, smallBtnStyle())
    deleteBtn.style.background = "#7f1d1d"
    deleteBtn.style.fontSize = "10px"
    deleteBtn.style.padding = "2px 8px"
    const saveBtn = document.createElement("button")
    saveBtn.textContent = "Save"
    Object.assign(saveBtn.style, smallBtnStyle())
    saveBtn.style.fontSize = "10px"
    saveBtn.style.padding = "2px 8px"

    // Save is disabled while the textarea is empty so that the only path
    // to a deletion is the explicit Delete button — avoids the user
    // accidentally Cmd-A-Backspace-Save'ing away an existing note.
    // Delete is disabled when there's nothing to delete.
    const updateButtonState = () => {
        const len = ta.value.trim().length
        counter.textContent = ta.value.length + " / " + RouteAssistantRouteNoteStore.MAX_TEXT_LEN
        saveBtn.disabled = len === 0
        saveBtn.style.opacity = saveBtn.disabled ? "0.5" : "1"
        deleteBtn.disabled = !existingText
        deleteBtn.style.opacity = deleteBtn.disabled ? "0.5" : "1"
    }
    updateButtonState()
    ta.addEventListener("input", updateButtonState)
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (!saveBtn.disabled) saveBtn.click()
        }
    })

    // _renderRows rebuilds this.panel.scoredRows from this.panel.rows via
    // Object.assign, so the source-of-truth update has to land on
    // this.panel.rows as well — mutating only the scoredRow we got passed
    // in would be erased on the very next render.
    const propagateNote = (record) => {
        row.routeNote = record
        row.routeNoteText = record ? record.text : null
        if (this.panel.rows) {
            const baseRow = this.panel.rows.find(r =>
                String(r.destIata || "").toUpperCase() === destU)
            if (baseRow) {
                baseRow.routeNote = record
                baseRow.routeNoteText = record ? record.text : null
            }
        }
        if (record) this.panel.routeNoteMap.set(pairKey, record)
        else        this.panel.routeNoteMap.delete(pairKey)
    }

    // Single close path used by Cancel / outside-click / Escape. Confirms
    // before discarding when the textarea diverges from existingText.
    const requestClose = () => {
        if (ta.value !== existingText
            && !window.confirm("Discard unsaved note changes?")) return
        this.panel._closeRouteNotePopover()
    }
    cancelBtn.addEventListener("click", requestClose)
    deleteBtn.addEventListener("click", async () => {
        if (!existingText) return
        // Capture the full prev record so Undo can restore not just the
        // text but createdAt + updatedAt. The store's save() rewrites
        // updatedAt unconditionally — we lose the original timestamp,
        // but the user-facing text round-trips correctly.
        const prevRecord = this.panel.routeNoteMap.get(pairKey) || null
        await this.panel._undoableSave({
            label: "Note deleted for " + hubU + "→" + destU,
            type:  "info",
            perform: async () => {
                await RouteAssistantRouteNoteStore.remove(hubU, destU)
                propagateNote(null)
                this.panel._renderRows()
            },
            restore: prevRecord
                ? async () => {
                    const restored = await RouteAssistantRouteNoteStore.save(hubU, destU,
                        {text: prevRecord.text})
                    propagateNote(restored)
                    this.panel._renderRows()
                }
                : null
        })
        this.panel._closeRouteNotePopover()
    })
    saveBtn.addEventListener("click", async () => {
        if (saveBtn.disabled) return
        // Skip the round-trip when nothing changed — the underlying store
        // would otherwise rewrite the record with a fresh updatedAt and
        // falsely advance the "Last updated" line on the next open.
        if (ta.value === existingText) {
            this.panel._closeRouteNotePopover()
            return
        }
        const prevText = existingText
        const newText  = ta.value
        await this.panel._undoableSave({
            label: "Note saved for " + hubU + "→" + destU,
            perform: async () => {
                const saved = await RouteAssistantRouteNoteStore.save(hubU, destU, {text: newText})
                propagateNote(saved)
                this.panel._renderRows()
            },
            restore: async () => {
                if (!prevText) {
                    // Previous state was empty → restore = remove the new save.
                    await RouteAssistantRouteNoteStore.remove(hubU, destU)
                    propagateNote(null)
                } else {
                    const restored = await RouteAssistantRouteNoteStore.save(hubU, destU,
                        {text: prevText})
                    propagateNote(restored)
                }
                this.panel._renderRows()
            }
        })
        this.panel._closeRouteNotePopover()
    })
    btnRow.append(cancelBtn, deleteBtn, saveBtn)
    pop.append(titleEl, sub, ta, counter, btnRow)
    document.body.append(pop)
    this.panel._routeNotePopover = pop
    const r = anchorEl.getBoundingClientRect()
    const popRect = pop.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    let top = r.bottom + 6
    if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
    let left = r.left
    if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
    if (left < 8) left = 8
    pop.style.top  = top  + "px"
    pop.style.left = left + "px"
    ta.focus()
    const onMouseDown = (e) => {
        if (pop.contains(e.target)) return
        if (e.target === anchorEl) return
        requestClose()
    }
    const onKey = (e) => { if (e.key === "Escape") requestClose() }
    setTimeout(() => {
        document.addEventListener("mousedown", onMouseDown)
        document.addEventListener("keydown",   onKey)
    }, 0)
    this.panel._routeNotePopoverCleanup = () => {
        document.removeEventListener("mousedown", onMouseDown)
        document.removeEventListener("keydown",   onKey)
    }
}

/**
 * H slice 3b.1 — per-route interlining popover. Lists current
 * partners, lets the user add / remove entries, and surfaces a
 * total-share-by-class summary in the footer. Partner picker source:
 * F slice 3 contractual-partners-scraper cache, walked via
 * `bulkLoadCache(myEnterpriseIds)`. When the contractual cache is
 * empty the dropdown disables and points the user to Settings →
 * Carriers. No `_undoableSave` — popover stays open after each add /
 * remove, accidental clicks are recoverable inline; Clear All does
 * its own `window.confirm`.
 */
async _openInterlinePopover(row, anchorEl) {
    if (!row || !this.panel.hubIata) return
    if (typeof RouteAssistantInterlineStore === "undefined") return
    this.panel._closeInterlinePopover()
    const hubU  = String(this.panel.hubIata).toUpperCase()
    const destU = String(row.destIata).toUpperCase()
    let record = await RouteAssistantInterlineStore.load(hubU, destU)
    const cfg = (this.panel.settings && this.panel.settings.carriers) || {}
    const ownIds = (cfg.myEnterpriseIds || []).map(v => String(v).trim()).filter(Boolean)
    const partnersCatalog = new Map()
    if (ownIds.length && typeof RouteAssistantContractualPartnersScraper !== "undefined") {
        try {
            const cache = await RouteAssistantContractualPartnersScraper.bulkLoadCache(ownIds)
            for (const rec of cache.values()) {
                if (!rec || !Array.isArray(rec.partners)) continue
                for (const p of rec.partners) {
                    if (!p || !p.partnerId) continue
                    const pid = String(p.partnerId)
                    const existing = partnersCatalog.get(pid) || {
                        name:      p.partnerName || ("#" + pid),
                        iata:      p.partnerIata || "",
                        relations: []
                    }
                    if (p.partnerName && existing.name.startsWith("#")) existing.name = p.partnerName
                    for (const r of (p.relations || [])) {
                        if (existing.relations.indexOf(r) === -1) existing.relations.push(r)
                    }
                    partnersCatalog.set(pid, existing)
                }
            }
        } catch (e) {
            console.warn("[AES interline] partners catalog load failed:", e)
        }
    }
    const pop = document.createElement("div")
    pop.tabIndex = -1
    Object.assign(pop.style, {
        position: "fixed", background: "#1f2937", color: "#f3f4f6",
        border: "1px solid #475569", borderRadius: "5px",
        boxShadow: "0 8px 25px rgba(0,0,0,0.55)",
        padding: "12px 14px", zIndex: "10002",
        minWidth: "440px", maxWidth: "560px",
        font: "11px/1.5 sans-serif"
    })
    const titleEl = document.createElement("strong")
    titleEl.textContent = "Interlining · " + hubU + " → " + destU
    titleEl.style.cssText = "color:#cbd5e1;display:block;margin-bottom:4px;font-size:12px;"
    pop.append(titleEl)
    const sub = document.createElement("div")
    sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:10px;line-height:1.45;"
    sub.textContent = "Per-route partner shares. Layered above your contractual partners (Settings → Carriers). "
        + "Each entry: partner × class × share %."
    pop.append(sub)
    const listHost = document.createElement("div")
    listHost.style.cssText = "max-height:220px;overflow-y:auto;margin-bottom:8px;"
    pop.append(listHost)
    const formHost = document.createElement("div")
    pop.append(formHost)
    const footHost = document.createElement("div")
    footHost.style.cssText = "margin-top:10px;display:flex;justify-content:space-between;"
        + "align-items:center;padding-top:8px;border-top:1px solid #374151;"
    pop.append(footHost)

    const renderList = () => {
        listHost.innerHTML = ""
        if (!record.partners || !record.partners.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:#6b7280;font-style:italic;padding:8px 4px;"
            empty.textContent = "No entries yet. Click + Add partner below."
            listHost.append(empty)
            return
        }
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const head = document.createElement("tr")
        for (const h of ["Partner", "Class", "Share", "Type", ""]) {
            const th = document.createElement("th")
            th.textContent = h
            th.style.cssText = "text-align:left;padding:3px 6px;color:#9ca3af;"
                + "font-weight:600;font-size:10px;border-bottom:1px solid #374151;"
            head.append(th)
        }
        tbl.append(head)
        for (const p of record.partners) {
            const tr = document.createElement("tr")
            const meta = partnersCatalog.get(p.partnerEnterpriseId)
                || {name: p.partnerName || ("#" + p.partnerEnterpriseId), iata: ""}
            const displayName = (p.partnerName || meta.name)
                + (meta.iata ? "  ·  " + meta.iata : "")
            const cells = [displayName, p.productClass,
                (Number(p.sharePercent) || 0).toFixed(1) + "%", p.relationType]
            for (const c of cells) {
                const td = document.createElement("td")
                td.textContent = c
                td.style.cssText = "padding:4px 6px;border-bottom:1px solid #1f2937;color:#e5e7eb;"
                tr.append(td)
            }
            const xTd = document.createElement("td")
            xTd.style.cssText = "padding:4px 6px;border-bottom:1px solid #1f2937;text-align:right;"
            const rmBtn = document.createElement("button")
            rmBtn.type = "button"
            rmBtn.textContent = "✕"
            rmBtn.title = "Remove this entry"
            rmBtn.style.cssText = "background:transparent;color:#ef4444;border:0;cursor:pointer;"
                + "font-size:13px;padding:0 4px;line-height:1;"
            rmBtn.addEventListener("click", async () => {
                const next = await RouteAssistantInterlineStore.removePartner(
                    hubU, destU, p.partnerEnterpriseId, p.productClass)
                record = next || {pair: hubU + "-" + destU, partners: [], updatedAt: null}
                this.panel._onInterlineRecordSaved(hubU, destU, next)
                renderList(); renderFooter()
            })
            xTd.append(rmBtn)
            tr.append(xTd)
            tbl.append(tr)
        }
        listHost.append(tbl)
    }

    let formOpen = false
    const renderForm = () => {
        formHost.innerHTML = ""
        if (!formOpen) {
            const addBtn = document.createElement("button")
            addBtn.type = "button"
            addBtn.textContent = "+ Add partner"
            addBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px dashed #475569;"
                + "border-radius:3px;padding:5px 12px;font-size:11px;cursor:pointer;"
            addBtn.addEventListener("click", () => { formOpen = true; renderForm() })
            formHost.append(addBtn)
            return
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "background:#0f1623;border:1px solid #374151;border-radius:3px;"
            + "padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px;"
        const fldStyle = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "padding:3px;font-size:11px;width:100%;box-sizing:border-box;"
        const labStyle = "display:flex;flex-direction:column;gap:2px;color:#9ca3af;font-size:10px;"
        const labStyleWide = labStyle + "grid-column:span 2;"

        const partnerSel = document.createElement("select")
        partnerSel.style.cssText = fldStyle
        const partnerEntries = Array.from(partnersCatalog.entries())
            .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""))
        if (!partnerEntries.length) {
            const opt = document.createElement("option")
            opt.value = ""
            opt.textContent = "(no contractual partners cached — sync in Settings → Carriers first)"
            partnerSel.append(opt)
            partnerSel.disabled = true
        } else {
            const ph = document.createElement("option")
            ph.value = ""; ph.textContent = "— pick a partner —"
            partnerSel.append(ph)
            for (const [pid, meta] of partnerEntries) {
                const opt = document.createElement("option")
                opt.value = pid
                opt.textContent = meta.name + " (#" + pid + ")"
                    + (meta.relations.length ? "  ·  " + meta.relations.join(",") : "")
                partnerSel.append(opt)
            }
        }
        const partnerLbl = document.createElement("label")
        partnerLbl.style.cssText = labStyleWide
        partnerLbl.append(document.createTextNode("Partner"), partnerSel)
        wrap.append(partnerLbl)

        const classSel = document.createElement("select")
        classSel.style.cssText = fldStyle
        for (const c of RouteAssistantInterlineStore.VALID_PRODUCT_CLASSES) {
            const opt = document.createElement("option")
            opt.value = c; opt.textContent = c
            classSel.append(opt)
        }
        const classLbl = document.createElement("label")
        classLbl.style.cssText = labStyle
        classLbl.append(document.createTextNode("Class"), classSel)
        wrap.append(classLbl)

        const shareInput = document.createElement("input")
        shareInput.type = "number"
        shareInput.min = "0"; shareInput.max = "100"; shareInput.step = "0.5"
        shareInput.value = "0"
        shareInput.style.cssText = fldStyle
        const shareLbl = document.createElement("label")
        shareLbl.style.cssText = labStyle
        shareLbl.append(document.createTextNode("Share %"), shareInput)
        wrap.append(shareLbl)

        const relSel = document.createElement("select")
        relSel.style.cssText = fldStyle
        for (const r of RouteAssistantInterlineStore.VALID_RELATION_TYPES) {
            const opt = document.createElement("option")
            opt.value = r; opt.textContent = r
            relSel.append(opt)
        }
        const relLbl = document.createElement("label")
        relLbl.style.cssText = labStyleWide
        relLbl.append(document.createTextNode("Relation type"), relSel)
        wrap.append(relLbl)

        const notesInput = document.createElement("input")
        notesInput.type = "text"
        notesInput.maxLength = 280
        notesInput.placeholder = "Optional — context, agreement expiry, etc."
        notesInput.style.cssText = fldStyle
        const notesLbl = document.createElement("label")
        notesLbl.style.cssText = labStyleWide
        notesLbl.append(document.createTextNode("Notes"), notesInput)
        wrap.append(notesLbl)

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "grid-column:span 2;display:flex;gap:6px;"
            + "justify-content:flex-end;margin-top:6px;"
        const cancelBtn = document.createElement("button")
        cancelBtn.type = "button"
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.style.fontSize = "10px"
        cancelBtn.style.padding = "2px 8px"
        cancelBtn.addEventListener("click", () => { formOpen = false; renderForm() })
        const saveBtn = document.createElement("button")
        saveBtn.type = "button"
        saveBtn.textContent = "Add"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.style.padding = "2px 12px"
        saveBtn.addEventListener("click", async () => {
            const pid = String(partnerSel.value || "").trim()
            if (!pid) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.warn("Pick a partner first.")
                }
                return
            }
            const meta = partnersCatalog.get(pid)
            const partner = {
                partnerEnterpriseId: pid,
                partnerName:         (meta && meta.name) || "",
                productClass:        classSel.value,
                sharePercent:        Number(shareInput.value) || 0,
                relationType:        relSel.value,
                notes:               notesInput.value
            }
            const next = await RouteAssistantInterlineStore.addPartner(hubU, destU, partner)
            if (!next) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.error("Save failed — see console.")
                }
                return
            }
            record = next
            formOpen = false
            this.panel._onInterlineRecordSaved(hubU, destU, next)
            renderList(); renderFooter(); renderForm()
        })
        btnRow.append(cancelBtn, saveBtn)
        wrap.append(btnRow)
        formHost.append(wrap)
    }

    const renderFooter = () => {
        footHost.innerHTML = ""
        const left = document.createElement("div")
        left.style.cssText = "color:#9ca3af;font-size:10px;"
        const partnerCount = (record.partners || []).length
        if (partnerCount > 0) {
            const totals = []
            for (const cls of RouteAssistantInterlineStore.VALID_PRODUCT_CLASSES) {
                const t = RouteAssistantInterlineStore.totalShare(record, cls)
                if (t > 0) totals.push(cls + " " + t.toFixed(1) + "%")
            }
            left.textContent = partnerCount + " entr" + (partnerCount === 1 ? "y" : "ies")
                + (totals.length ? "  ·  " + totals.join(" · ") : "")
            // H slice 3b.2.2 — surface the dollar cost so the user
            // sees what they're paying for the partner deal. Pulled
            // off the matching row's estimator breakdown; only shows
            // when the estimator has run (fleet/aircraft mode active).
            const matchingRow = (this.panel.rows || []).find(r =>
                r && r.destIata === destU)
            const lossPerWeek = matchingRow && matchingRow.profitBreakdown
                && Number(matchingRow.profitBreakdown.interlineRevenueLossPerWeek) || 0
            if (lossPerWeek > 0) {
                const lossLine = document.createElement("div")
                lossLine.style.cssText = "color:#fbbf24;font-size:10px;margin-top:2px;"
                lossLine.textContent = "Forgone revenue ≈ $"
                    + Math.round(lossPerWeek).toLocaleString() + "/wk (cost stays the same)"
                left.append(lossLine)
            }
        } else {
            left.textContent = "(no entries)"
        }
        footHost.append(left)
        const right = document.createElement("div")
        right.style.cssText = "display:flex;gap:6px;"
        if (partnerCount > 0) {
            const clearBtn = document.createElement("button")
            clearBtn.type = "button"
            clearBtn.textContent = "Clear all"
            Object.assign(clearBtn.style, smallBtnStyle())
            clearBtn.style.background = "#7f1d1d"
            clearBtn.style.fontSize = "10px"
            clearBtn.style.padding = "2px 8px"
            clearBtn.addEventListener("click", async () => {
                if (!window.confirm("Remove all interline entries on " + hubU + "→" + destU + "?")) return
                await RouteAssistantInterlineStore.clear(hubU, destU)
                record = {pair: hubU + "-" + destU, partners: [], updatedAt: null}
                this.panel._onInterlineRecordSaved(hubU, destU, null)
                renderList(); renderFooter()
            })
            right.append(clearBtn)
        }
        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "Close"
        Object.assign(closeBtn.style, smallBtnStyle())
        closeBtn.style.fontSize = "10px"
        closeBtn.style.padding = "2px 12px"
        closeBtn.addEventListener("click", () => this.panel._closeInterlinePopover())
        right.append(closeBtn)
        footHost.append(right)
    }

    renderList(); renderForm(); renderFooter()
    document.body.append(pop)
    this.panel._interlinePopover = pop
    const r = anchorEl.getBoundingClientRect()
    const popRect = pop.getBoundingClientRect()
    const vh = window.innerHeight, vw = window.innerWidth
    let top = r.bottom + 6
    if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
    let left = r.left
    if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
    if (left < 8) left = 8
    pop.style.top  = top  + "px"
    pop.style.left = left + "px"
    const onMouseDown = (e) => {
        if (pop.contains(e.target)) return
        if (e.target === anchorEl) return
        this.panel._closeInterlinePopover()
    }
    const onKey = (e) => { if (e.key === "Escape") this.panel._closeInterlinePopover() }
    setTimeout(() => {
        document.addEventListener("mousedown", onMouseDown)
        document.addEventListener("keydown",   onKey)
    }, 0)
    this.panel._interlinePopoverCleanup = () => {
        document.removeEventListener("mousedown", onMouseDown)
        document.removeEventListener("keydown",   onKey)
    }
}

_closeInterlinePopover() {
    if (this.panel._interlinePopoverCleanup) {
        try { this.panel._interlinePopoverCleanup() } catch (e) { /* noop */ }
        this.panel._interlinePopoverCleanup = null
    }
    if (this.panel._interlinePopover && this.panel._interlinePopover.parentNode) {
        this.panel._interlinePopover.parentNode.removeChild(this.panel._interlinePopover)
    }
    this.panel._interlinePopover = null
}

_closeRouteNotePopover() {
    if (this.panel._routeNotePopoverCleanup) {
        try { this.panel._routeNotePopoverCleanup() } catch (e) { /* noop */ }
        this.panel._routeNotePopoverCleanup = null
    }
    if (this.panel._routeNotePopover && this.panel._routeNotePopover.parentNode) {
        this.panel._routeNotePopover.parentNode.removeChild(this.panel._routeNotePopover)
    }
    this.panel._routeNotePopover = null
}

/**
 * F slice 2 — rich popover for the Cmp pill. Renders each AS
 * competitor with banner + avatar + clickable enterprise link +
 * pax share % + change indicator, mirroring AS's Stations table.
 * Opens on hover (200ms delay), auto-closes on leave (250ms grace),
 * or click-pins so the user can interact with the links inside.
 * Returns null when no `marketSharePax` data — caller falls back
 * to the existing plain-text title="" tooltip.
 */
}

window.RouteAssistantRouteNotePopover = RouteAssistantRouteNotePopover;
