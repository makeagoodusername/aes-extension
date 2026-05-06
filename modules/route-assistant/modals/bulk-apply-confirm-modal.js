/**
 * RouteAssistantBulkApplyConfirmModal
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantBulkApplyConfirmModal {
    constructor(panel) {
        this.panel = panel;
    }

open({selected, deltaPct, hub}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div")
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10002;"
            + "display:flex;align-items:center;justify-content:center;padding:30px;"
        const dialog = document.createElement("div")
        dialog.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #475569;border-radius:6px;"
            + "padding:14px 18px;width:760px;max-width:95vw;font:12px/1.4 sans-serif;"
            + "max-height:80vh;overflow-y:auto;"
        const close = (ok) => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            document.removeEventListener("keydown", onKey)
            resolve(ok)
        }
        const onKey = (e) => { if (e.key === "Escape") close(false) }
        const head = document.createElement("div")
        head.innerHTML = "<strong style='font-size:13px;'>Confirm bulk apply</strong>"
            + "<div style='color:#9ca3af;font-size:10px;margin-top:2px;'>"
            + selected.length + " routes from " + hub + " · review price changes before committing."
            + "</div>"
        dialog.append(head)
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;"
        const thead = document.createElement("thead")
        const trH = document.createElement("tr")
        for (const h of ["Route", "Y", "C", "F", "Cargo"]) {
            const th = document.createElement("th")
            th.textContent = h
            th.style.cssText = "text-align:left;padding:4px 6px;color:#9ca3af;font-size:10px;"
                + "text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #1f2937;"
            trH.append(th)
        }
        thead.append(trH); tbl.append(thead)
        const tbody = document.createElement("tbody")
        for (const {r, cached} of selected) {
            const trr = document.createElement("tr")
            trr.style.cssText = "border-bottom:1px solid rgba(31, 41, 55, 0.5);"
            const routeTd = document.createElement("td")
            routeTd.textContent = r.destIata
            routeTd.style.cssText = "padding:3px 6px;color:#cbd5e1;font-weight:600;"
            trr.append(routeTd)
            const p = cached.prices || {}
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const cur = p[cls]
                const td = document.createElement("td")
                td.style.cssText = "padding:3px 6px;font-variant-numeric:tabular-nums;color:#cbd5e1;"
                if (cur == null) {
                    td.textContent = "—"
                } else {
                    const prop = this.panel._computeBulkProposedPrice(cur, deltaPct[cls], cls)
                    if (prop === cur) td.textContent = this.panel._formatRoutePrice(cls, cur)
                    else {
                        const color = prop > cur ? "#34d399" : "#f87171"
                        td.innerHTML = this.panel._formatRoutePrice(cls, cur)
                            + " → <span style='color:" + color + ";font-weight:600;'>"
                            + this.panel._formatRoutePrice(cls, prop) + "</span>"
                    }
                }
                trr.append(td)
            }
            tbody.append(trr)
        }
        tbl.append(tbody)
        dialog.append(tbl)

        const ack = document.createElement("label")
        ack.style.cssText = "display:flex;gap:6px;align-items:center;margin-top:10px;color:#cbd5e1;font-size:11px;"
        const ackCb = document.createElement("input")
        ackCb.type = "checkbox"
        ack.append(ackCb, document.createTextNode("I understand this will POST " + selected.length + " price updates to AirlineSim."))
        dialog.append(ack)

        const foot = document.createElement("div")
        foot.style.cssText = "display:flex;justify-content:flex-end;gap:6px;margin-top:10px;"
        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.addEventListener("click", () => close(false))
        const okBtn = document.createElement("button")
        okBtn.textContent = "Apply " + selected.length + " routes"
        Object.assign(okBtn.style, smallBtnStyle())
        okBtn.style.background = "#7c3aed"
        okBtn.style.borderColor = "#6d28d9"
        okBtn.disabled = true
        ackCb.addEventListener("change", () => { okBtn.disabled = !ackCb.checked })
        okBtn.addEventListener("click", () => close(true))
        foot.append(cancelBtn, okBtn)
        dialog.append(foot)

        overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false) })
        document.addEventListener("keydown", onKey)
        overlay.append(dialog)
        document.body.append(overlay)
    })
}

/**
 * Halt-confirm modal — surfaced when the orchestrator's circuit breaker
 * trips during a bulk pre-apply pass. The user picks whether to apply
 * just to the K routes that did sync (and skip the rest with a stale-
 * data audit entry), or abort the whole bulk apply. Resolves to
 * "continue" or "abort". Z-index 10003 so it stacks above the bulk
 * apply modal (10001) and the apply confirm modal (10002).
 */
}

window.RouteAssistantBulkApplyConfirmModal = RouteAssistantBulkApplyConfirmModal;
