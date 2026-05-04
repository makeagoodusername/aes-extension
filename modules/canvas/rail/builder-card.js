"use strict"

/**
 * CanvasBuilderCard — renders one CanvasBuilderEngine proposal in the rail.
 *
 * One card per proposal. Card shows:
 *   - Name + scoreDelta
 *   - Rationale (one-liner)
 *   - Edit count (e.g. "9 routes across 3 aircraft, 3 waves")
 *   - [Stage plan]  [Choose aircraft]  [Dismiss]
 *
 * Stage plan:      emits one canvas:edit-staged batch with all edits.
 * Choose aircraft: expands an inline checkbox tree (per-aircraft).
 *                  V1 simplification: ships a "select all" / per-aircraft
 *                  toggles only — per-wave is overkill for first cut.
 * Dismiss:         removes the card (not bus-emitted; cards are ephemeral).
 *
 * Pure renderer. The card wires its own click handlers; callers only
 * provide a `onAdopt(edits)` callback so a single bus emit point lives
 * in the engine layer.
 */
class CanvasBuilderCard {

    static render(proposal, callbacks) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const cb = callbacks || {}
        const card = document.createElement("article")
        card.className = "aes-canvas-builder-card"
        card.dataset.proposalId = proposal.proposalId
        card.style.cssText = [
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "border-left:3px solid " + (T ? T.color.cobalt : "#3656A8"),
            "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "border-left-width:3px",
            "padding:8px 10px",
            "display:flex",
            "flex-direction:column",
            "gap:4px"
        ].join(";")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:6px;"
        const name = document.createElement("strong")
        name.style.cssText = "font-size:12px;flex:1 1 auto;"
        name.textContent = proposal.name || "Proposal"
        const delta = document.createElement("span")
        delta.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
        delta.textContent = (proposal.scoreDelta != null) ? "+" + proposal.scoreDelta + " pax-score" : ""
        head.append(name, delta)
        card.append(head)

        if (proposal.rationale) {
            const lead = document.createElement("div")
            lead.style.cssText = "font-size:11px;line-height:1.35;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            lead.textContent = proposal.rationale
            card.append(lead)
        }

        const diag = CanvasBuilderCard._diagnosticLine(proposal.diagnostics)
        if (diag) {
            const line = document.createElement("div")
            line.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;line-height:1.35;"
            line.textContent = diag
            card.append(line)
        }

        const edits = (proposal.plan && Array.isArray(proposal.plan.edits)) ? proposal.plan.edits : []
        if (proposal.empty || !edits.length) {
            const note = document.createElement("div")
            note.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;"
            note.textContent = CanvasBuilderCard._emptyDetail(proposal.diagnostics) || "Nothing to apply."
            card.append(note)
            const dismiss = document.createElement("button")
            dismiss.type = "button"
            dismiss.textContent = "Dismiss"
            dismiss.style.cssText = CanvasBuilderCard._btnStyle(T, "ghost")
            dismiss.addEventListener("click", () => CanvasBuilderCard._dismiss(card))
            card.append(dismiss)
            return card
        }

        const stats = CanvasBuilderCard._summarise(edits)
        const meta = document.createElement("div")
        meta.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
        meta.textContent = edits.length + " routes · "
            + stats.aircraftCount + " aircraft · "
            + stats.waveCount + " waves"
            + (stats.stationText ? " · " + stats.stationText : "")
        card.append(meta)

        const preview = CanvasBuilderCard._buildPreviewList(edits, T)
        if (preview) card.append(preview)

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:6px;margin-top:6px;"

        const adoptBtn = document.createElement("button")
        adoptBtn.type = "button"
        adoptBtn.textContent = "Stage plan"
        adoptBtn.style.cssText = CanvasBuilderCard._btnStyle(T, "primary")
        adoptBtn.addEventListener("click", () => {
            if (cb.onAdopt) cb.onAdopt(edits, proposal)
            CanvasBuilderCard._markAdopted(card, edits.length)
        })

        const fragBtn = document.createElement("button")
        fragBtn.type = "button"
        fragBtn.textContent = "Choose aircraft…"
        fragBtn.style.cssText = CanvasBuilderCard._btnStyle(T, "ghost")
        fragBtn.addEventListener("click", () => {
            CanvasBuilderCard._toggleFragmentPanel(card, edits, cb)
        })

        const dismissBtn = document.createElement("button")
        dismissBtn.type = "button"
        dismissBtn.textContent = "Dismiss"
        dismissBtn.style.cssText = CanvasBuilderCard._btnStyle(T, "ghost")
        dismissBtn.addEventListener("click", () => CanvasBuilderCard._dismiss(card))

        actions.append(adoptBtn, fragBtn, dismissBtn)
        card.append(actions)
        return card
    }

    static _btnStyle(T, kind) {
        const base = [
            "padding:3px 8px",
            "font-size:10px",
            "text-transform:uppercase",
            "letter-spacing:0.06em",
            "cursor:pointer",
            "border:1px solid " + (T ? T.color.oxide : "#2B2520"),
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-weight:" + (T ? T.fw.bold : "700")
        ]
        if (kind === "primary") {
            base.push("background:" + (T ? T.color.rust : "#B8472A"))
            base.push("color:" + (T ? T.color.rustFg || "#F4F1EA" : "#F4F1EA"))
        } else {
            base.push("background:" + (T ? T.color.bone : "#F4F1EA"))
            base.push("color:" + (T ? T.color.oxide : "#2B2520"))
        }
        return base.join(";")
    }

    static _summarise(edits) {
        const aircraftSet = new Set()
        const waveSet = new Set()
        let stationOpen = 0, stationMissing = 0, stationUnknown = 0
        for (const e of edits) {
            if (e.aircraftId) aircraftSet.add(String(e.aircraftId))
            if (e.waveId) waveSet.add(String(e.waveId))
            if (e.stationStatus === "open") stationOpen++
            else if (e.stationStatus === "missing") stationMissing++
            else stationUnknown++
        }
        const parts = []
        if (stationOpen) parts.push(stationOpen + " station open")
        if (stationMissing) parts.push(stationMissing + " need station")
        if (stationUnknown) parts.push(stationUnknown + " station unknown")
        return {aircraftCount: aircraftSet.size, waveCount: waveSet.size, stationText: parts.join(" · ")}
    }

    static _diagnosticLine(d) {
        if (!d) return ""
        const parts = []
        if (d.demandRows != null) parts.push(d.demandRows + " demand")
        if (d.hubFleetCount != null) parts.push(d.hubFleetCount + " aircraft")
        if (d.waveCount != null) parts.push(d.waveCount + " waves")
        if (d.waveScore != null && isFinite(d.waveScore)) parts.push("wave score " + Math.round(d.waveScore))
        if (d.unplacedCount) parts.push(d.unplacedCount + " unplaced")
        if (d.emptyCells != null) parts.push(d.emptyCells + " empty cells")
        if (d.stationKnown) {
            const n = d.openStationCount == null ? "?" : d.openStationCount
            parts.push(n + " open stations")
        } else {
            parts.push("stations unknown")
        }
        return parts.join(" · ")
    }

    static _emptyDetail(d) {
        if (!d) return ""
        const skips = []
        if (d.skippedRange) skips.push(d.skippedRange + " range skips")
        if (d.skippedDuplicate) skips.push(d.skippedDuplicate + " duplicate skips")
        if (Array.isArray(d.waveBlockers) && d.waveBlockers.length) {
            skips.push("wave blockers: " + d.waveBlockers.slice(0, 2).join("; "))
        }
        const suffix = skips.length ? " (" + skips.join(", ") + ")" : ""
        if (d.reason) return d.reason + suffix + "."
        return suffix ? "No route edits generated" + suffix + "." : ""
    }

    static _buildPreviewList(edits, T) {
        if (!Array.isArray(edits) || !edits.length) return null
        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-top:2px;font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        const max = Math.min(4, edits.length)
        for (let i = 0; i < max; i++) {
            const e = edits[i]
            const row = document.createElement("div")
            const station = e.stationStatus === "open" ? "station open"
                : e.stationStatus === "missing" ? "needs station"
                : "station unknown"
            row.textContent = (e.aircraftId || "?") + " -> " + (e.destIata || "?")
                + " · " + (e.waveId || "wave") + " · " + station
            list.append(row)
        }
        if (edits.length > max) {
            const more = document.createElement("div")
            more.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            more.textContent = "+" + (edits.length - max) + " more"
            list.append(more)
        }
        return list
    }

    static _dismiss(card) {
        if (!card || !card.parentElement) return
        card.parentElement.removeChild(card)
    }

    static _markAdopted(card, count) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const banner = document.createElement("div")
        banner.style.cssText = "margin-top:6px;font-size:10px;color:" + (T ? T.color.moss : "#2F5F3F") + ";"
        banner.textContent = "Staged " + count + " route" + (count === 1 ? "" : "s") + " for Apply"
        card.append(banner)
    }

    static _toggleFragmentPanel(card, edits, cb) {
        let panel = card.querySelector("[data-fragment-panel]")
        if (panel) { panel.remove(); return }
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        panel = document.createElement("div")
        panel.dataset.fragmentPanel = "1"
        panel.style.cssText = "margin-top:6px;display:flex;flex-direction:column;gap:3px;border-top:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";padding-top:6px;"

        const byAircraft = new Map()
        for (const e of edits) {
            const aid = String(e.aircraftId || "")
            if (!aid) continue
            if (!byAircraft.has(aid)) byAircraft.set(aid, [])
            byAircraft.get(aid).push(e)
        }

        const checkboxes = []
        for (const [aid, list] of byAircraft) {
            const row = document.createElement("label")
            row.style.cssText = "display:flex;gap:6px;align-items:center;font-size:10px;font-family:" + (T ? T.font.mono : "monospace") + ";"
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = true
            cb.dataset.aid = aid
            const span = document.createElement("span")
            span.textContent = aid + " · " + list.length + " route" + (list.length === 1 ? "" : "s")
            row.append(cb, span)
            panel.append(row)
            checkboxes.push(cb)
        }

        const apply = document.createElement("button")
        apply.type = "button"
        apply.textContent = "Stage selected"
        apply.style.cssText = CanvasBuilderCard._btnStyle(T, "primary") + ";align-self:flex-start;margin-top:4px;"
        apply.addEventListener("click", () => {
            const allowed = new Set()
            for (const c of checkboxes) if (c.checked) allowed.add(c.dataset.aid)
            const subset = edits.filter(e => allowed.has(String(e.aircraftId || "")))
            if (subset.length && cb && cb.onAdopt) cb.onAdopt(subset, {fragment: true})
            CanvasBuilderCard._markAdopted(card, subset.length)
            panel.remove()
        })
        panel.append(apply)
        card.append(panel)
    }
}

if (typeof window !== "undefined") {
    window.CanvasBuilderCard = CanvasBuilderCard
}
