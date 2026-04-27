"use strict"

/**
 * Augments the AS fleet management table with cross-module columns:
 *   Loc  — current airport IATA, link to /app/info/airports/<id> (station mgmt)
 *   Plan — DRFT badge if AFP module has a saved drafted plan for this tail
 *   Sched — live badge if any saved schedule exists for the aircraft's hub
 *   Actions — R (Routes/Scheduling), S (inline SchedulePanel toggle), P (Flight Plan)
 *
 * Insertion is idempotent: a `data-aes-fleet-hub` flag on the thead prevents
 * a second mount from doubling cells. Re-rendering individual rows happens
 * via repaint(rows) — the host swaps existing cells in place when storage
 * changes (e.g. AFP just persisted a new location for one tail).
 *
 * The buttons emit DOM CustomEvents on the table (bubble) so the host owns
 * the click-handler wiring without this module needing to import the host
 * or the overlay module. Events:
 *   aes-fleet-hub:action-r {aircraftId, hub, fallbackHub}
 *   aes-fleet-hub:action-s {aircraftId, hub, fallbackHub}
 *   aes-fleet-hub:action-p {aircraftId}
 *   aes-fleet-hub:action-d {aircraftId, hub, fallbackHub}  // AFP Dashboard (Tier 1)
 */
class FleetHubInlineTable {

    static AUGMENTED_FLAG = "data-aes-fleet-hub"

    static EVENT = {
        R: "aes-fleet-hub:action-r",
        S: "aes-fleet-hub:action-s",
        P: "aes-fleet-hub:action-p",
        D: "aes-fleet-hub:action-d"
    }
    static MARKER = {
        R: "aes-fleet-hub-action-r",
        S: "aes-fleet-hub-action-s",
        P: "aes-fleet-hub-action-p",
        D: "aes-fleet-hub-action-d"
    }

    /**
     * @param {jQuery|HTMLElement} table - the AS fleet table from
     *   `.as-page-fleet-management > .row > .col-md-9 > .as-panel:eq(0) table`
     * @param {Array} rows - RowRecord[] from FleetHubAircraftAggregator.enrich
     */
    static augment(table, rows) {
        const tableEl = table && table.jquery ? table[0] : table
        if (!tableEl) return
        const thead = tableEl.querySelector("thead")
        const tbody = tableEl.querySelector("tbody")
        if (!thead || !tbody) return

        const fallbackHub = FleetHubAircraftAggregator.fallbackHub(rows)

        const byId = new Map()
        for (const r of rows) byId.set(String(r.aircraftId), r)

        if (thead.getAttribute(FleetHubInlineTable.AUGMENTED_FLAG) === "1") {
            FleetHubInlineTable._repaintBody(tbody, byId, fallbackHub)
            return
        }

        // Header — the AS table's first thead row is the column-name row;
        // content_fleetManagement.js already appends two <th rowspan="2">
        // cells (Profit/Loss, Extract date) at fltmng_displayAircraftProfit
        // (line 204). We append four more after those.
        const headRow = thead.querySelector("tr")
        if (headRow) {
            headRow.insertAdjacentHTML("beforeend",
                "<th rowspan=\"2\">Loc</th>" +
                "<th rowspan=\"2\">Plan</th>" +
                "<th rowspan=\"2\">Sched</th>" +
                "<th rowspan=\"2\">Actions</th>"
            )
        }
        thead.setAttribute(FleetHubInlineTable.AUGMENTED_FLAG, "1")

        FleetHubInlineTable._repaintBody(tbody, byId, fallbackHub)

        // Single delegated click handler — survives row repaints since it
        // lives on the table, not on individual buttons.
        tableEl.addEventListener("click", FleetHubInlineTable._onClick)
    }

    /** Re-render every row's hub-owned cells without rebuilding the AS columns. */
    static _repaintBody(tbody, byId, fallbackHub) {
        for (const tr of tbody.querySelectorAll("tr")) {
            const aircraftId = FleetHubInlineTable._readAircraftId(tr)
            if (!aircraftId) continue
            const row = byId.get(String(aircraftId))
            if (!row) continue
            FleetHubInlineTable._paintRow(tr, row, fallbackHub)
        }
    }

    /** Same path as fltmng_getAircraftId at content_fleetManagement.js:82. */
    static _readAircraftId(tr) {
        const link = tr.querySelector("td:nth-child(7) > div > div:nth-child(2) > a")
        if (!link) return null
        return fltmng_getAircraftId(link.getAttribute("href")) || null
    }

    static _paintRow(tr, row, fallbackHub) {
        for (const cell of tr.querySelectorAll("td.aes-fleet-hub-cell")) {
            cell.remove()
        }

        tr.appendChild(FleetHubInlineTable._locCell(row))
        tr.appendChild(FleetHubInlineTable._planCell(row))
        tr.appendChild(FleetHubInlineTable._schedCell(row))
        tr.appendChild(FleetHubInlineTable._actionsCell(row, fallbackHub))
    }

    static _locCell(row) {
        const td = document.createElement("td")
        td.className = "aes-fleet-hub-cell aes-mono"
        if (row.locIata && row.locAirportId) {
            const a = document.createElement("a")
            a.href = "/app/info/airports/" + row.locAirportId
            a.textContent = row.locIata
            if (row.locName) a.title = row.locName + " — open station details"
            td.appendChild(a)
        } else if (row.locIata) {
            td.textContent = row.locIata
        } else {
            td.className += " aes-meta"
            td.textContent = "—"
        }
        return td
    }

    static _planCell(row) {
        const td = document.createElement("td")
        td.className = "aes-fleet-hub-cell"
        if (row.hasDraftedPlan) {
            const b = document.createElement("span")
            b.className = "aes-badge aes-badge--cobalt"
            b.textContent = "DRFT"
            b.title = "Aircraft Flight Plan has a saved draft for this aircraft"
            td.appendChild(b)
        } else {
            td.className += " aes-meta"
            td.textContent = "—"
        }
        return td
    }

    static _schedCell(row) {
        const td = document.createElement("td")
        td.className = "aes-fleet-hub-cell"
        if (row.scheduleStatus === "live") {
            const b = document.createElement("span")
            b.className = "aes-badge aes-badge--moss"
            b.textContent = "live"
            b.title = "A saved schedule exists for this aircraft's hub (" + (row.hub || "?") + ")"
            td.appendChild(b)
        } else {
            td.className += " aes-meta"
            td.textContent = "—"
        }
        return td
    }

    static _actionsCell(row, fallbackHub) {
        const td = document.createElement("td")
        td.className = "aes-fleet-hub-cell aes-no-text-wrap"
        td.style.whiteSpace = "nowrap"

        const r = FleetHubInlineTable._actionBtn("R",
            "Open scheduling/route assistant for this aircraft's hub",
            FleetHubInlineTable.MARKER.R)
        const s = FleetHubInlineTable._actionBtn("S",
            "Open Schedule Management overlay",
            FleetHubInlineTable.MARKER.S)
        const p = FleetHubInlineTable._actionBtn("P",
            "Open the Flight Plan tab (AFP module)",
            FleetHubInlineTable.MARKER.P)
        const d = FleetHubInlineTable._actionBtn("D",
            "Open AFP Schedule Control (proxy dry-run · Tier 1)",
            FleetHubInlineTable.MARKER.D)

        for (const btn of [r, s, p, d]) {
            btn.dataset.aircraftId  = String(row.aircraftId)
            btn.dataset.hub         = row.hub || ""
            btn.dataset.fallbackHub = fallbackHub || ""
        }

        td.appendChild(r)
        td.appendChild(document.createTextNode(" "))
        td.appendChild(s)
        td.appendChild(document.createTextNode(" "))
        td.appendChild(p)
        td.appendChild(document.createTextNode(" "))
        td.appendChild(d)
        return td
    }

    static _actionBtn(label, title, marker) {
        const b = document.createElement("button")
        b.type = "button"
        b.className = "aes-btn aes-btn--sm " + marker
        b.textContent = label
        b.title = title
        return b
    }

    static _onClick(e) {
        const btn = e.target.closest("button.aes-btn")
        if (!btn) return
        const aircraftId = btn.dataset.aircraftId
        if (!aircraftId) return

        const M = FleetHubInlineTable.MARKER
        const E = FleetHubInlineTable.EVENT
        const evtName = btn.classList.contains(M.R) ? E.R
                      : btn.classList.contains(M.S) ? E.S
                      : btn.classList.contains(M.P) ? E.P
                      : btn.classList.contains(M.D) ? E.D
                      : null
        if (!evtName) return

        e.preventDefault()
        e.stopPropagation()
        const detail = {
            aircraftId,
            hub:         btn.dataset.hub || null,
            fallbackHub: btn.dataset.fallbackHub || null
        }
        e.currentTarget.dispatchEvent(new CustomEvent(evtName, {detail, bubbles: true}))
    }
}

if (typeof window !== "undefined") {
    window.FleetHubInlineTable = FleetHubInlineTable
}
