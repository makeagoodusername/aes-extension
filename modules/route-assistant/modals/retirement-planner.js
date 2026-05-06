/**
 * RouteAssistantRetirementPlanner
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantRetirementPlanner {
    constructor(panel) {
        this.panel = panel;
    }

open() {
    const prior = document.getElementById("aes-retirement-modal")
    if (prior && prior.parentNode) prior.parentNode.removeChild(prior)
    const aircraft = (this.panel.fleet && Array.isArray(this.panel.fleet.aircraft))
        ? this.panel.fleet.aircraft.slice() : []
    const MAX_LIFE_YEARS = 25
    aircraft.sort((a, b) => (Number(b.age) || 0) - (Number(a.age) || 0))

    const overlay = document.createElement("div")
    overlay.id = "aes-retirement-modal"
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center;"
    const cardR = document.createElement("div")
    cardR.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);max-width:840px;max-height:80vh;width:92%;display:flex;flex-direction:column;font:12px/1.4 sans-serif;"
    overlay.append(cardR)
    const closeRet = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        document.removeEventListener("keydown", onKeyRet)
    }
    const onKeyRet = (e) => { if (e.key === "Escape") closeRet() }
    document.addEventListener("keydown", onKeyRet)

    const headerR = document.createElement("div")
    headerR.style.cssText = "padding:10px 14px;border-bottom:1px solid #374151;display:flex;align-items:center;gap:10px;"
    const titleR = document.createElement("strong")
    const pastLife = aircraft.filter(a => (Number(a.age) || 0) > MAX_LIFE_YEARS).length
    titleR.innerHTML = "🛩 Aircraft retirement planner "
        + "<span style='color:#9ca3af;font-weight:normal;font-size:11px;'>"
        + "— " + aircraft.length + " owned"
        + (pastLife ? " · <span style='color:#f87171;'>" + pastLife + " past life</span>" : "")
        + "</span>"
    titleR.style.flex = "1"
    titleR.style.color = "#34d399"
    headerR.append(titleR)
    const closeBtnR = document.createElement("button")
    closeBtnR.type = "button"
    closeBtnR.textContent = "×"
    closeBtnR.style.cssText = "background:transparent;color:#9ca3af;border:none;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;"
    closeBtnR.addEventListener("click", closeRet)
    headerR.append(closeBtnR)
    cardR.append(headerR)

    const tools = document.createElement("div")
    tools.style.cssText = "padding:8px 14px;border-bottom:1px solid #374151;display:flex;gap:10px;align-items:center;color:#9ca3af;font-size:11px;"
    const lab = document.createElement("label")
    lab.textContent = "Highlight aircraft retiring within "
    const thrInput = document.createElement("input")
    thrInput.type = "number"
    thrInput.min = "0"
    thrInput.max = "120"
    thrInput.step = "1"
    thrInput.value = "24"
    thrInput.style.cssText = "width:60px;background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;padding:1px 4px;font-size:11px;"
    const monthsLabel = document.createElement("span")
    monthsLabel.textContent = " months"
    lab.append(thrInput, monthsLabel)
    tools.append(lab)
    const summary = document.createElement("span")
    summary.style.color = "#fde68a"
    tools.append(summary)
    cardR.append(tools)

    const bodyR = document.createElement("div")
    bodyR.style.cssText = "padding:6px 14px;overflow-y:auto;flex:1;"
    cardR.append(bodyR)

    const renderTable = () => {
        bodyR.innerHTML = ""
        const monthsThr = Math.max(0, Number(thrInput.value) || 0)
        const yearsThr = monthsThr / 12
        const soonCutoff = MAX_LIFE_YEARS - yearsThr
        const soonCount = aircraft.filter(a => {
            const age = Number(a.age) || 0
            return age >= soonCutoff && age <= MAX_LIFE_YEARS
        }).length
        summary.textContent = soonCount + " retiring within " + monthsThr + " months"
        if (!aircraft.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:18px 0;color:#9ca3af;text-align:center;"
            empty.textContent = "No fleet records found. Visit /app/fleets to populate the cache, then re-open this planner."
            bodyR.append(empty)
            return
        }
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const thead = document.createElement("thead")
        const headTr = document.createElement("tr")
        for (const colTitle of ["Reg.", "Equipment", "Age (yr)", "Until retire (yr)", "Status", ""]) {
            const th = document.createElement("th")
            th.textContent = colTitle
            th.style.cssText = "padding:5px 8px;color:#9ca3af;font-weight:600;font-size:11px;"
                + "text-align:" + (["Age (yr)", "Until retire (yr)"].indexOf(colTitle) >= 0 ? "right" : "left") + ";"
                + "border-bottom:1px solid #374151;"
            headTr.append(th)
        }
        thead.append(headTr)
        tbl.append(thead)
        const tbody = document.createElement("tbody")
        for (const a of aircraft) {
            const age = Number(a.age) || 0
            const remaining = MAX_LIFE_YEARS - age
            const isPast = age > MAX_LIFE_YEARS
            const isSoon = !isPast && remaining <= yearsThr
            const tr = document.createElement("tr")
            if (isPast)       tr.style.background = "rgba(248,113,113,0.10)"
            else if (isSoon)  tr.style.background = "rgba(251,191,36,0.10)"
            const td = (text, align, color) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:4px 8px;color:" + (color || "#e5e7eb") + ";"
                    + "text-align:" + (align || "left") + ";border-bottom:1px solid #1f2937;font-variant-numeric:tabular-nums;"
                c.textContent = text
                return c
            }
            tr.append(td(a.registration || "—", "left", "#cbd5e1"))
            tr.append(td(a.equipment || "(unknown)", "left"))
            tr.append(td(age.toFixed(1), "right", isPast ? "#f87171" : (isSoon ? "#fde68a" : "#e5e7eb")))
            tr.append(td(remaining > 0 ? remaining.toFixed(1) : ("expired " + Math.abs(remaining).toFixed(1)),
                "right", isPast ? "#f87171" : (isSoon ? "#fde68a" : "#9ca3af")))
            const statusTd = document.createElement("td")
            statusTd.style.cssText = "padding:4px 8px;border-bottom:1px solid #1f2937;"
            if (isPast)       statusTd.innerHTML = '<span style="color:#f87171;font-weight:600;">⌛ past life</span>'
            else if (isSoon)  statusTd.innerHTML = '<span style="color:#fde68a;font-weight:600;">⏳ retiring soon</span>'
            else              statusTd.innerHTML = '<span style="color:#9ca3af;">—</span>'
            tr.append(statusTd)
            const actionTd = document.createElement("td")
            actionTd.style.cssText = "padding:4px 8px;border-bottom:1px solid #1f2937;text-align:right;"
            if (a.typeId) {
                const link = document.createElement("a")
                link.href = "/app/enterprise/dashboard"
                link.target = "_blank"
                link.textContent = "Find replacement →"
                link.title = "Open the dashboard's Used Aircraft Scanner. Filter to type \"" + (a.equipment || "?") + "\" once it loads."
                link.style.cssText = "color:#60a5fa;font-size:11px;text-decoration:none;"
                actionTd.append(link)
            } else {
                actionTd.innerHTML = '<span style="color:#6b7280;font-size:10px;">no typeId</span>'
            }
            tr.append(actionTd)
            tbody.append(tr)
        }
        tbl.append(tbody)
        bodyR.append(tbl)
    }
    thrInput.addEventListener("input", renderTable)
    renderTable()

    const footR = document.createElement("div")
    footR.style.cssText = "padding:8px 14px;border-top:1px solid #374151;color:#6b7280;font-size:10px;line-height:1.5;"
    footR.textContent = "Aircraft retire at " + MAX_LIFE_YEARS + " years per AS rules. "
        + "\"Until retire\" is years remaining; \"past life\" rows are flying on borrowed time. "
        + "Visit /app/fleets to refresh the cache if these numbers look stale."
    cardR.append(footR)

    document.body.append(overlay)
}

/**
 * U6 — swap a single override cell for an <input> bound to one
 * field of `row.override` (paxLF / yieldPerKm / cargoYieldPerKgKm).
 * ⏎ saves, ⎋ cancels, blur saves, empty saves clear that one
 * field while preserving the rest of the override (full-replace
 * store is merged-with-existing here). Goes through
 * `_undoableSave` so a misclick reverts in one toast click.
 */
}

window.RouteAssistantRetirementPlanner = RouteAssistantRetirementPlanner;
