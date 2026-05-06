/**
 * RouteAssistantRouteOpeningChecklist
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantRouteOpeningChecklist {
    constructor(panel) {
        this.panel = panel;
    }

open(row) {
    if (!row || !row.destIata || !this.panel.hubIata) return
    const prior = document.getElementById("aes-checklist-modal")
    if (prior && prior.parentNode) prior.parentNode.removeChild(prior)
    const hubU  = String(this.panel.hubIata).toUpperCase()
    const destU = String(row.destIata).toUpperCase()

    const overlay = document.createElement("div")
    overlay.id = "aes-checklist-modal"
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center;"
    const card = document.createElement("div")
    card.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);max-width:480px;width:90%;display:flex;flex-direction:column;font:12px/1.4 sans-serif;"
    overlay.append(card)
    const closeC = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        document.removeEventListener("keydown", onKeyC)
    }
    const onKeyC = (e) => { if (e.key === "Escape") closeC() }
    document.addEventListener("keydown", onKeyC)

    const header = document.createElement("div")
    header.style.cssText = "padding:10px 14px;border-bottom:1px solid #374151;display:flex;align-items:center;gap:10px;"
    const title = document.createElement("strong")
    title.innerHTML = "Opening checklist · " + escapeHtml(hubU) + "→" + escapeHtml(destU)
    title.style.flex = "1"
    title.style.color = "#60a5fa"
    header.append(title)
    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.textContent = "×"
    closeBtn.style.cssText = "background:transparent;color:#9ca3af;border:none;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;"
    closeBtn.addEventListener("click", closeC)
    header.append(closeBtn)
    card.append(header)

    const subtitle = document.createElement("div")
    subtitle.style.cssText = "padding:6px 14px;color:#6b7280;font-size:10px;border-bottom:1px solid #374151;line-height:1.5;"
    subtitle.textContent = "Prerequisites for opening this route. ✓ items have data cached; ✗ items need a sync. Click \"fix this\" on any ✗ row to take the next step."
    card.append(subtitle)

    const body = document.createElement("div")
    body.style.cssText = "padding:6px 4px;"
    card.append(body)

    // Build the checklist. Each item: {label, ok, hint?, fix?}.
    // `ok` evaluated from row decorations + cached records; `fix` is
    // an action handler that closes the modal then triggers a sync.
    const items = []
    items.push({
        label: "Distance resolved",
        ok: typeof row.distanceKm === "number" && isFinite(row.distanceKm),
        hint: typeof row.distanceKm === "number" ? Math.round(row.distanceKm).toLocaleString() + " km" : "no distance",
        fix: () => { closeC(); window.open("/app/com/scheduling/" + hubU + destU, "_blank") }
    })
    items.push({
        label: row.demandSource === "flightsfrom" ? "Flight demand reflected" : "AS demand seeded",
        ok: row.paxScore !== null && row.paxScore !== undefined,
        hint: (row.paxScore != null)
            ? "pax " + row.paxScore + " · "
                + (row.demandSource === "flightsfrom"
                    ? "FlightsFrom" : "cargo " + (row.cargoScore != null ? row.cargoScore : "?"))
            : "no demand record",
        fix: () => { closeC(); window.open("/action/info/airports/" + (row.airportId || ""), "_blank") }
    })
    const fleetCtx = (typeof this.panel._fleetContext === "function") ? this.panel._fleetContext() : null
    items.push({
        label: "Aircraft selected",
        ok: !!(fleetCtx && (fleetCtx.selectedSpec || fleetCtx.fleetSpecs)),
        hint: fleetCtx && fleetCtx.selectedSpec
            ? "type: " + (fleetCtx.selectedSpec.typeName || fleetCtx.selectedSpec.equipment || "?")
            : "no aircraft picker mode set",
        fix: () => {
            closeC()
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.info("Set Aircraft mode in the controls bar at the top of the panel.")
            }
        }
    })
    const svcOk = !!(this.panel.serviceConfigMap && this.panel.serviceConfigMap.get(hubU + "-" + destU))
    items.push({
        label: "Service profile set",
        ok: svcOk,
        hint: svcOk ? "per-route service config saved" : "uses defaults",
        fix: () => { closeC(); window.open("/app/com/scheduling/" + hubU + destU, "_blank") }
    })
    const marketsOk = !!(row.ownPricing || row.marketSharePeriod)
    items.push({
        label: "Markets scraped",
        ok: marketsOk,
        hint: marketsOk ? "competitors / pricing / share data cached" : "open Settings → Market Analysis → Sync to populate",
        fix: () => { closeC(); window.open("/app/com/markets/" + hubU + destU, "_blank") }
    })
    const orsOk = !!(row.orsByClass && Object.keys(row.orsByClass).length)
    items.push({
        label: "ORS connection list cached",
        ok: orsOk,
        hint: orsOk ? "rank + connections cached" : "open Settings → ORS Rank → Sync to populate",
        fix: () => {
            closeC()
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.info("Open Settings → ORS Rank → Sync ORS rank for all visible routes.")
            }
        }
    })
    items.push({
        label: "Carriers list cached",
        ok: !!(row.carriers && Array.isArray(row.carriers) && row.carriers.length),
        hint: (row.carriers && row.carriers.length) ? row.carriers.length + " carriers cached" : "open Settings → Carriers → Sync to populate",
        fix: () => {
            closeC()
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.info("Open Settings → Carriers → Sync carriers for all visible routes.")
            }
        }
    })

    const okCount = items.filter(it => it.ok).length

    const summary = document.createElement("div")
    summary.style.cssText = "padding:6px 14px;color:#cbd5e1;font-size:11px;border-bottom:1px solid #1f2937;"
    summary.innerHTML = "<strong>" + okCount + " / " + items.length + " ready</strong>"
        + (okCount === items.length ? " · all set" : " · " + (items.length - okCount) + " step" + ((items.length - okCount) === 1 ? "" : "s") + " remaining")
    body.append(summary)

    const list = document.createElement("div")
    list.style.cssText = "padding:6px 0;"
    for (const it of items) {
        const row = document.createElement("div")
        row.style.cssText = "padding:6px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1f2937;"
        const tick = document.createElement("span")
        tick.textContent = it.ok ? "✓" : "✗"
        tick.style.cssText = "font-size:14px;font-weight:600;color:" + (it.ok ? "#34d399" : "#f87171") + ";min-width:18px;"
        row.append(tick)
        const main = document.createElement("div")
        main.style.cssText = "flex:1;display:flex;flex-direction:column;gap:1px;"
        const lab = document.createElement("div")
        lab.textContent = it.label
        lab.style.color = "#e5e7eb"
        main.append(lab)
        if (it.hint) {
            const h = document.createElement("div")
            h.textContent = it.hint
            h.style.cssText = "color:#6b7280;font-size:10px;"
            main.append(h)
        }
        row.append(main)
        if (!it.ok && typeof it.fix === "function") {
            const fixBtn = document.createElement("button")
            fixBtn.type = "button"
            fixBtn.textContent = "fix this →"
            fixBtn.style.cssText = "background:#1f2937;color:#60a5fa;border:1px solid #475569;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer;"
            fixBtn.addEventListener("click", it.fix)
            row.append(fixBtn)
        }
        list.append(row)
    }
    body.append(list)

    const foot = document.createElement("div")
    foot.style.cssText = "padding:8px 14px;border-top:1px solid #374151;color:#6b7280;font-size:10px;line-height:1.5;"
    foot.textContent = "All checks read from cached data; \"fix this\" opens the next step. Once every item is ✓ the route is fully primed for opening — fly it from /app/com/scheduling/" + hubU + destU + "."
    card.append(foot)

    document.body.append(overlay)
}

/**
 * N2 — Notification center popover. Anchored to the 🔔 button.
 * Reverse-chronological list of every toast fired this session.
 * Each entry carries a click handler that re-fires its action when
 * one was attached (Undo a save from 5 min ago, Retry a failed
 * sync, View a flagged route). History is in-memory only — closing
 * the tab clears it.
 */
}

window.RouteAssistantRouteOpeningChecklist = RouteAssistantRouteOpeningChecklist;
