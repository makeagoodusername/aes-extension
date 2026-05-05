"use strict"

/**
 * Track 7 slice 7b — turnaround popover reader.
 *
 * Each `.block.turnaround` in the visual-flight-plan Gantt embeds a
 * Bootstrap modal (`.modal#ta-NN`) with a per-side activity decomposition
 * — the "Turnaround Activities" table the user sees on hover. The table
 * has three `<tbody>` blocks:
 *
 *   1. Inbound activities  — Taxi In / De-Boarding / Baggage Cargo unloading /
 *                            Catering unloading / Cabin Cleaning. Each row:
 *                            name | earliest/latest start | duration HH:MM |
 *                            earliest/latest end | float HH:MM
 *   2. Outbound activities — Refueling / Catering loading / Maintenance
 *                            Check / Baggage Cargo loading / Boarding /
 *                            Pushback Taxi Out. Same shape.
 *   3. Split Turnaround    — caption rows for "Duration of inbound
 *                            activities", "Duration of outbound activities",
 *                            "Maintenance time window". The first two carry
 *                            the totals we need for downstream consumers
 *                            (auto-scheduler per-station turnaround budget).
 *
 * All times in the popover are HH:MM offsets RELATIVE to the turnaround
 * start (so 00:00 is when the inbound aircraft starts taxiing in, and
 * the boarding row's earliestStart of 00:29 is 29 minutes after that).
 *
 * Defensive: every read is wrapped — a malformed table returns the empty
 * payload (`activities: []`, both totals null), never throws.
 *
 * Slice 7a left `block.turnaround = {inboundDurationMin: null,
 * outboundDurationMin: null, activities: []}` as a stub. This module's
 * `parse(blockEl)` populates that shape from the `.modal table` inside
 * the block. `vfp-reader.js` calls into it opportunistically if loaded;
 * 7a's stub stays valid when 7b isn't on the page.
 */
;(function () {
    /** Section heading texts that delimit the three tbody blocks. The
     *  first two are activity sections; the third is the totals section. */
    const SECTION_INBOUND  = "inbound"
    const SECTION_OUTBOUND = "outbound"
    const SECTION_SPLIT    = "split turnaround"

    /** Parse "HH:MM" → minutes. Accepts plain HH:MM only — the popover
     *  uses single-day offsets so we never see "Nd HH:MM" in the activity
     *  table. (The split-turnaround "completed at <span>6d 11:51</span>"
     *  lives in a different row that we don't promote into Activity[].) */
    function hhmmToMin(s) {
        if (!s || typeof s !== "string") return null
        const m = s.match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
    }

    /** First non-empty text in a cell — strips whitespace + collapses
     *  spans. Used because activity-cell content is `<span>00:13</span>
     *  / <span>00:13</span>` and we want the FIRST span. */
    function firstSpanText(cell) {
        if (!cell) return null
        const span = cell.querySelector("span")
        if (span) return (span.textContent || "").trim()
        return (cell.textContent || "").trim()
    }

    /** Second span text in a cell — the "latest" half of "earliest / latest". */
    function secondSpanText(cell) {
        if (!cell) return null
        const spans = cell.querySelectorAll("span")
        if (spans.length >= 2) return (spans[1].textContent || "").trim()
        return null
    }

    /**
     * Read one activity row. Returns null if the row doesn't have a
     * `.name` cell — that's how we filter out the section-heading
     * `<tr><th colspan="5">Inbound</th></tr>` rows.
     */
    function readActivityRow(tr, side) {
        const nameCell = tr.querySelector("td.name")
        if (!nameCell) return null
        const name = (nameCell.textContent || "").trim()
        if (!name) return null

        // Cells AFTER the name cell: [name, start-pair, duration-bar, completion-pair, float]
        const cells = Array.from(tr.querySelectorAll("td"))
        const startCell      = cells[1] || null
        const durationBar    = cells[2] || null
        const completionCell = cells[3] || null
        const floatCell      = cells[4] || null

        // Duration is inside the .progress-bar > span — grab the first span
        // text under the duration cell.
        const durationStr = durationBar
            ? (durationBar.querySelector(".progress-bar span")?.textContent || "").trim() || null
            : null

        return {
            name,
            side,
            earliestStart: firstSpanText(startCell),
            latestStart:   secondSpanText(startCell),
            durationMin:   hhmmToMin(durationStr),
            earliestEnd:   firstSpanText(completionCell),
            latestEnd:     secondSpanText(completionCell),
            floatMin:      hhmmToMin((floatCell ? (floatCell.textContent || "").trim() : null))
        }
    }

    /**
     * Decide which section a tbody is by reading its first `<th colspan>`
     * heading row. Returns "inbound" / "outbound" / "split turnaround" or
     * null when the tbody has no leading section header.
     */
    function detectSection(tbody) {
        const heading = tbody.querySelector("tr th[colspan]")
        if (!heading) return null
        const txt = (heading.textContent || "").trim().toLowerCase()
        if (txt.indexOf(SECTION_INBOUND) === 0)  return "inbound"
        if (txt.indexOf(SECTION_OUTBOUND) === 0) return "outbound"
        if (txt.indexOf(SECTION_SPLIT) === 0)    return "split"
        return null
    }

    /** Parse the totals tbody (Split Turnaround) — looks for caption rows
     *  ("Duration of inbound activities", "Duration of outbound activities",
     *  "Maintenance time window") and pulls the first span value from the
     *  next cell. */
    function readSplitTotals(tbody) {
        const out = {
            inboundDurationMin:  null,
            outboundDurationMin: null,
            maintenanceWindowLocal: null
        }
        const rows = Array.from(tbody.querySelectorAll("tr"))
        for (const tr of rows) {
            const cells = Array.from(tr.querySelectorAll("td"))
            if (cells.length < 2) continue
            const caption = (cells[0].textContent || "").trim().toLowerCase()
            const valueCell = cells[1]
            const valueStr  = firstSpanText(valueCell) || (valueCell.textContent || "").trim()
            if (caption.indexOf("duration of inbound") === 0)        out.inboundDurationMin  = hhmmToMin(valueStr)
            else if (caption.indexOf("duration of outbound") === 0)  out.outboundDurationMin = hhmmToMin(valueStr)
            else if (caption.indexOf("maintenance time window") === 0) out.maintenanceWindowLocal = valueStr || null
        }
        return out
    }

    /**
     * Public: parse one `.block.turnaround` element's popover modal.
     * Always returns a TurnaroundPayload (never null) so callers can
     * unconditionally assign the result.
     */
    function parse(blockEl) {
        const empty = {
            inboundDurationMin:     null,
            outboundDurationMin:    null,
            maintenanceWindowLocal: null,
            activities:             []
        }
        if (!blockEl || !blockEl.classList || !blockEl.classList.contains("turnaround")) {
            return empty
        }
        const modal = blockEl.querySelector(".modal table.table")
        if (!modal) return empty

        const tbodies = Array.from(modal.querySelectorAll("tbody"))
        const activities = []
        let inboundTotal = null, outboundTotal = null, maintenanceWindow = null

        for (const tbody of tbodies) {
            const section = detectSection(tbody)
            if (section === "inbound" || section === "outbound") {
                for (const tr of tbody.querySelectorAll("tr")) {
                    const a = readActivityRow(tr, section)
                    if (a) activities.push(a)
                }
            } else if (section === "split") {
                const totals = readSplitTotals(tbody)
                if (totals.inboundDurationMin    != null) inboundTotal      = totals.inboundDurationMin
                if (totals.outboundDurationMin   != null) outboundTotal     = totals.outboundDurationMin
                if (totals.maintenanceWindowLocal != null) maintenanceWindow = totals.maintenanceWindowLocal
            }
        }

        return {
            inboundDurationMin:     inboundTotal,
            outboundDurationMin:    outboundTotal,
            maintenanceWindowLocal: maintenanceWindow,
            activities
        }
    }

    if (typeof window !== "undefined") {
        window.AesAfpTurnaroundReader = {
            parse,
            _internals: { hhmmToMin, firstSpanText, secondSpanText, detectSection, readActivityRow, readSplitTotals }
        }
    }
})()
