/**
 * Restructure slice F — Master-detail inspector pane.
 *
 * The Route Assistant table grew to 50+ columns to surface every signal
 * a route can carry — score breakdown, fleet fit, profit, market share,
 * ORS rank, override state, note text, status history, alerts, etc.
 * That's too many columns for any reasonable viewport, so the user
 * either runs in Compact mode (hides half the data) or scrolls.
 *
 * The inspector is a 380px side pane that surfaces the *selected
 * route's* full record in a stacked layout — quick to glance, quick to
 * act on. Clicking a route in the table view selects it; the inspector
 * updates without re-rendering the table. The pane can be toggled with
 * the 🔍 header button (panel default: off).
 *
 * The inspector renders directly from the `scoredRow` shape that the
 * panel already builds. It does NOT duplicate the panel's existing
 * popovers — those keep working as before via row clicks. The pane is
 * a complement, not a replacement.
 */
class RouteAssistantInspector {

    /**
     * Render the inspector into `host`. Wipes prior contents.
     *
     * @param {HTMLElement} host
     * @param {object} opts
     *   - row: the selected scoredRow (or null for the empty state)
     *   - hubIata: hub label, used for "open scheduling page" links
     *   - onSelectRoute: (destIata) => void  (jump from inspector → table)
     *   - onOpenOverride / onOpenNote / onOpenSandbox / onPlaceOnWave:
     *     optional quick-action callbacks. Pane omits a button when its
     *     callback is missing so the inspector degrades gracefully when
     *     a feature isn't loaded.
     */
    static render(host, opts) {
        if (!host) return
        host.innerHTML = ""
        const o = opts || {}

        Object.assign(host.style, {
            display:        "flex",
            flexDirection:  "column",
            gap:            "var(--aes-sp-2)",
            padding:        "var(--aes-sp-2) var(--aes-sp-3)",
            background:     "var(--aes-bone)",
            color:          "var(--aes-oxide)",
            fontFamily:     "var(--aes-font-display)",
            fontSize:       "var(--aes-fs-small)",
            overflowY:      "auto"
        })

        // Header
        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;"
            + "padding-bottom:var(--aes-sp-1);"
            + "border-bottom:var(--aes-bw-1) solid var(--aes-paper-rule);"
        const title = document.createElement("strong")
        title.textContent = "INSPECTOR"
        title.style.cssText = "flex:1;text-transform:uppercase;"
            + "letter-spacing:var(--aes-tracking-caps);"
            + "font-size:var(--aes-fs-lead);font-weight:var(--aes-fw-display);"
        head.append(title)
        if (o.onClose) {
            const x = document.createElement("button")
            x.type = "button"
            x.textContent = "✕"
            x.title = "Close inspector"
            x.style.cssText = "background:transparent;color:var(--aes-oxide);"
                + "border:var(--aes-bw-1) solid var(--aes-paper-rule);"
                + "padding:2px 8px;cursor:pointer;line-height:1;"
            x.addEventListener("click", () => o.onClose())
            head.append(x)
        }
        host.append(head)

        const row = o.row
        if (!row) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:18px 8px;color:#94a3b8;font-size:11px;"
                + "font-style:italic;text-align:center;"
            empty.textContent = "Click a route in the table to inspect it here."
            host.append(empty)
            return
        }

        // Title row — IATA + city + status
        const head2 = document.createElement("div")
        head2.style.cssText = "display:flex;align-items:baseline;gap:8px;"
        const iata = document.createElement("strong")
        iata.textContent = row.destIata || "?"
        iata.style.cssText = "font-family:var(--aes-font-mono);"
            + "font-size:18px;color:var(--aes-rust);letter-spacing:0.04em;"
        const name = document.createElement("span")
        name.textContent = row.destName || ""
        name.style.cssText = "color:#cbd5e1;font-size:11px;flex:1;"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        const status = document.createElement("span")
        status.textContent = row.status || ""
        status.style.cssText = "padding:1px 6px;background:#1f2937;border:1px solid #475569;"
            + "border-radius:2px;font-size:10px;color:#cbd5e1;"
        head2.append(iata, name, status)
        host.append(head2)

        // Quick stats grid — score / distance / weekly flights / profit
        host.append(RouteAssistantInspector._mkStatGrid([
            ["Score",      row.score        != null ? Math.round(row.score) : "—"],
            ["Distance",   row.distanceKm   != null ? Math.round(row.distanceKm) + " km" : "—"],
            ["Pax demand", row.paxScore     != null ? row.paxScore + " /10" : "—"],
            ["Cargo dem.", row.cargoScore   != null ? row.cargoScore + " /10" : "—"],
            ["Flights/wk", row.weeklyFlights != null ? row.weeklyFlights : "—"],
            ["$/week",     row.profitPerWeek != null
                ? RouteAssistantInspector._formatMoney(row.profitPerWeek) : "—"],
            ["$/flight",   row.profitPerFlight != null
                ? RouteAssistantInspector._formatMoney(row.profitPerFlight) : "—"],
            ["Pax LF",     row.lf != null ? Math.round(row.lf * 100) + "%" : "—"]
        ]))

        // Fleet fit
        if (row.aircraftFit != null) {
            host.append(RouteAssistantInspector._mkSection("Fleet fit",
                RouteAssistantInspector._mkKvList([
                    ["Aircraft", row.aircraftType || "(none picked)"],
                    ["Fit",      row.aircraftFit || "?"],
                    ["Range",    row.aircraftRangeKm != null ? row.aircraftRangeKm + " km" : "—"],
                    ["Status",   row.status || "—"]
                ])
            ))
        }

        // Override (if present)
        if (row.override) {
            host.append(RouteAssistantInspector._mkSection("Override",
                RouteAssistantInspector._mkKvList([
                    ["Pax LF",     row.override.lf != null ? Math.round(row.override.lf * 100) + "%" : "—"],
                    ["Pax yield",  row.override.yieldPerKm != null ? row.override.yieldPerKm.toFixed(3) : "—"],
                    ["Cargo LF",   row.override.cargoLf != null ? Math.round(row.override.cargoLf * 100) + "%" : "—"],
                    ["Note",       row.override.note || "—"],
                    ["Expires",    row.override.expiresAt
                        ? new Date(row.override.expiresAt).toISOString().slice(0, 10) : "never"]
                ])
            ))
        }

        // Note (if present)
        if (row.routeNoteText) {
            const noteSec = RouteAssistantInspector._mkSection("Note", null)
            const noteBody = document.createElement("div")
            noteBody.style.cssText = "padding:6px 8px;background:#1f2937;border-radius:3px;"
                + "color:#fde68a;font-size:11px;white-space:pre-wrap;"
            noteBody.textContent = row.routeNoteText
            noteSec.append(noteBody)
            host.append(noteSec)
        }

        // Actions strip
        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;"
            + "padding-top:var(--aes-sp-1);"
            + "border-top:var(--aes-bw-1) solid var(--aes-paper-rule);"
        const mkAction = (label, title, onClick) => {
            const b = document.createElement("button")
            b.type = "button"
            b.textContent = label
            b.title = title
            b.style.cssText = "background:var(--aes-bone-2);color:var(--aes-oxide);"
                + "border:var(--aes-bw-1) solid var(--aes-paper-rule);"
                + "padding:4px 10px;cursor:pointer;font-size:11px;"
                + "text-transform:uppercase;letter-spacing:var(--aes-tracking-caps);"
            b.addEventListener("click", onClick)
            return b
        }
        if (o.hubIata && row.destIata) {
            actions.append(mkAction("Open in AS",
                "Open the AS scheduling page for this route in a new tab.",
                () => window.open("/app/com/scheduling/"
                    + encodeURIComponent(o.hubIata) + encodeURIComponent(row.destIata),
                    "_blank", "noopener")))
        }
        if (typeof o.onPlaceOnWave === "function") {
            actions.append(mkAction("Place on wave →",
                "Switch to Waves view with this route pre-selected for placement.",
                () => o.onPlaceOnWave(row.destIata)))
        }
        if (actions.children.length) host.append(actions)
    }

    /** Internal — 2-column key/value grid for the quick-stats block. */
    static _mkStatGrid(pairs) {
        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;"
            + "gap:6px 10px;padding:8px;background:#0f1623;"
            + "border:1px solid #1f2937;border-radius:3px;"
        for (const [k, v] of pairs) {
            const cell = document.createElement("div")
            cell.style.cssText = "display:flex;flex-direction:column;gap:1px;"
            const lbl = document.createElement("span")
            lbl.textContent = k
            lbl.style.cssText = "font-size:9px;color:#6b7280;"
                + "text-transform:uppercase;letter-spacing:var(--aes-tracking-caps);"
            const val = document.createElement("span")
            val.textContent = String(v)
            val.style.cssText = "font-family:var(--aes-font-mono);"
                + "font-size:12px;color:#cbd5e1;font-weight:bold;"
            cell.append(lbl, val)
            grid.append(cell)
        }
        return grid
    }

    /** Internal — boxed section with a small caps title. */
    static _mkSection(title, body) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        const h = document.createElement("strong")
        h.textContent = title
        h.style.cssText = "font-size:9px;color:#94a3b8;"
            + "text-transform:uppercase;letter-spacing:var(--aes-tracking-caps);"
        wrap.append(h)
        if (body) wrap.append(body)
        return wrap
    }

    /** Internal — flat key/value list for section bodies. */
    static _mkKvList(pairs) {
        const list = document.createElement("dl")
        list.style.cssText = "display:grid;grid-template-columns:auto 1fr;"
            + "gap:2px 8px;margin:0;padding:6px 8px;background:#0f1623;"
            + "border:1px solid #1f2937;border-radius:3px;font-size:11px;"
        for (const [k, v] of pairs) {
            const dt = document.createElement("dt")
            dt.textContent = k
            dt.style.cssText = "color:#94a3b8;font-size:10px;"
            const dd = document.createElement("dd")
            dd.textContent = String(v)
            dd.style.cssText = "margin:0;color:#cbd5e1;"
                + "font-family:var(--aes-font-mono);font-size:11px;"
            list.append(dt, dd)
        }
        return list
    }

    /** Compact AS$ formatter — k/M suffixes for big numbers. */
    static _formatMoney(n) {
        const x = Number(n)
        if (!isFinite(x)) return "—"
        const sign = x < 0 ? "-" : ""
        const abs = Math.abs(x)
        if (abs >= 1e6) return sign + "AS$" + (abs / 1e6).toFixed(1) + "M"
        if (abs >= 1e3) return sign + "AS$" + (abs / 1e3).toFixed(1) + "k"
        return sign + "AS$" + Math.round(abs)
    }
}
