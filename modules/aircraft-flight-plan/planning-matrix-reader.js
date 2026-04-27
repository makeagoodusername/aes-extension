"use strict"

/**
 * Track 7 slice 7b — Planning matrix reader.
 *
 * Parses `form[action*='flight.planning.form']` (capture line 2381) into
 * the `PlanningMatrix` shape that lives on `Schedule.planningMatrix`.
 *
 * The form is a 7-column matrix (Mon..Sun) of per-segment settings:
 *
 *   - Day selection checkboxes      `input[name='days:daySelection:N:ticked']`
 *   - Currently assigned aircraft    (display only — registration link)
 *   - Per-segment header             "<orig> - <dest>" + slot navigation
 *   - Base departure hh:mm           `select[name='segmentSettings:N:newDeparture:hours/minutes']`
 *   - Departure / arrival terminals  `select[name='segmentSettings:N:originTerminal/destinationTerminal']`
 *   - Per-day departure offset       `select[name='segmentsContainer:segments:N:departure-offsets:D:departureOffset']`
 *   - Per-day fixed-arrival flag     `input[name='segmentsContainer:segments:N:fixedArrivalSelection:D:fixedArrival']`
 *   - Per-day arrival hh:mm          `select[name='segmentsContainer:segments:N:newArrivals:D:newArrival:hours/minutes']`
 *   - Validation rows (Departure Time Validity, Aircraft performance,
 *     Route Restrictions) — checkmark per day
 *   - Per-airport rows (Departure slots / Nighttime / Noise at origin;
 *     Arrival slots / Nighttime / Noise at destination) — checkmark per day
 *
 * `isPresent: false` is the safe default — returned when the form isn't on
 * the page (Existing-Flight tab open, aircraft with no flights yet, etc).
 * Consumers must guard on `if (matrix.isPresent)` before reading segments.
 *
 * The validation / per-airport check rows return per-day booleans where
 * a `<span class="fa fa-check">` (or any other "ok" icon) is true and
 * anything else (including red `fa-times` or empty cells) is false.
 *
 * Defensive: pure DOM read; no writes. Wraps each segment in try/catch so
 * a malformed row can't drop the whole matrix.
 */
;(function () {
    /** Match `segmentSettings:N:...`, `segmentsContainer:segments:N:...`,
     *  and the per-day positional N inside both. */
    const RE_SEG_SEGMENT_IDX = /segmentSettings:(\d+):/
    const RE_DAY_OFFSET      = /departure-offsets:(\d+):/
    const RE_DAY_FIXED       = /fixedArrivalSelection:(\d+):/
    const RE_DAY_ARRIVAL     = /newArrivals:(\d+):/
    const RE_DAY_SELECTION   = /daySelection:(\d+):/

    /** Read a `<select>`'s selected `option.value` (string), null if absent. */
    function selectedValue(sel) {
        if (!sel) return null
        const opt = sel.options ? sel.options[sel.selectedIndex] : null
        if (opt && opt.value != null) return String(opt.value)
        return null
    }

    /** Convert a string-or-null numeric to integer; null on parse failure. */
    function intOrNull(v) {
        if (v == null) return null
        const n = parseInt(String(v), 10)
        return isFinite(n) ? n : null
    }

    /**
     * Detect "ok" status from a check-icon cell. AS uses Font Awesome
     * `fa fa-check` for green-tick and `fa fa-times` (or `fa-remove`)
     * for red-cross. Any cell containing a `.fa-check` is considered
     * passing; anything else fails.
     */
    function cellIsOk(cell) {
        if (!cell) return null
        if (cell.querySelector(".fa-check"))                  return true
        if (cell.querySelector(".fa-times, .fa-remove, .fa-ban")) return false
        // Empty cells appear when AS hasn't validated yet — return null
        // (unknown), not false, so consumers can distinguish "no data"
        // from "explicit fail".
        const text = (cell.textContent || "").trim()
        if (!text) return null
        return null
    }

    /** Extract IATA from a `<a href*='/airports/<id>'>IATA</a>` anchor or
     *  any token-like 3-letter uppercase substring. */
    function iataFromCell(cell) {
        if (!cell) return null
        const a = cell.querySelector("a[href*='/airports/']")
        if (a) {
            const txt = (a.textContent || "").trim().toUpperCase()
            if (/^[A-Z]{3}$/.test(txt)) return txt
        }
        const txt = (cell.textContent || "").trim()
        const m = txt.match(/\b([A-Z]{3})\b/)
        return m ? m[1] : null
    }

    /**
     * Find the table cells under the given row, skipping the leading
     * caption / colspan cells. Returns an array length 7 (one per day);
     * callers index by dayIdx 0..6. When a row uses colspans (e.g. the
     * base departure cell spans 3 days), the same cell can be indexed
     * for multiple days — that's what `expandCellsToDays` handles.
     */
    function expandCellsToDays(tr) {
        // The matrix uses `<th colspan="2">caption</th>` followed by 7
        // `<td>`s, OR `<th colspan="1"></th><td class="caption">caption</td>`
        // followed by content cells with their own colspans. We collapse
        // to a per-day array by walking children and replicating each
        // cell `colspan` times — but only AFTER skipping leading th /
        // caption cells.
        const out = []
        const all = Array.from(tr.children)
        let leadingSkipped = false
        for (const cell of all) {
            const tag  = cell.tagName ? cell.tagName.toLowerCase() : ""
            const cls  = cell.classList || { contains: () => false }
            const isLeading = !leadingSkipped && (tag === "th" || cls.contains("caption") || cls.contains("empty"))
            if (isLeading) continue
            leadingSkipped = true
            const span = parseInt(cell.getAttribute("colspan") || "1", 10) || 1
            for (let i = 0; i < span; i++) out.push(cell)
            if (out.length >= 7) break
        }
        // Pad to exactly 7 in case the row is short (shouldn't happen on
        // a well-formed AS form, but defends against partial Wicket renders).
        while (out.length < 7) out.push(null)
        return out.slice(0, 7)
    }

    /** Find a row in `tbody` whose first `td.caption` text matches `re`.
     *  Returns the `<tr>` or null. */
    function findRowByCaption(tbody, re) {
        if (!tbody) return null
        for (const tr of tbody.querySelectorAll("tr")) {
            const cap = tr.querySelector("td.caption, th")
            const txt = cap ? (cap.textContent || "").trim() : ""
            if (re.test(txt)) return tr
        }
        return null
    }

    /** Read the day-selection row → boolean[7] of `enabled` per day. */
    function readDaySelections(form) {
        const out = [false, false, false, false, false, false, false]
        const inputs = form.querySelectorAll("input[type='checkbox'][name*='daySelection:'][name*=':ticked']")
        for (const cb of inputs) {
            const m = (cb.name || "").match(RE_DAY_SELECTION)
            if (!m) continue
            const idx = parseInt(m[1], 10)
            if (idx >= 0 && idx < 7) out[idx] = !!cb.checked
        }
        return out
    }

    /** Group form selects/inputs by segmentIdx. Returns Map<segmentIdx,
     *  {hours,select|null, minutes:select|null, originTerminal, destTerminal,
     *  offsets[7], fixed[7], arrivalsHours[7], arrivalsMinutes[7]}>. */
    function collectSegmentInputs(form) {
        const segs = new Map()
        const ensure = idx => {
            if (!segs.has(idx)) {
                segs.set(idx, {
                    segmentIdx:        idx,
                    hoursSelect:       null,
                    minutesSelect:     null,
                    originTerminal:    null,
                    destTerminal:      null,
                    offsets:           [null, null, null, null, null, null, null],
                    fixed:             [false, false, false, false, false, false, false],
                    arrivalsHours:     [null, null, null, null, null, null, null],
                    arrivalsMinutes:   [null, null, null, null, null, null, null]
                })
            }
            return segs.get(idx)
        }

        // segmentSettings:N:newDeparture:hours / minutes
        for (const sel of form.querySelectorAll("select[name*='segmentSettings:'][name*='newDeparture']")) {
            const m = (sel.name || "").match(RE_SEG_SEGMENT_IDX)
            if (!m) continue
            const seg = ensure(parseInt(m[1], 10))
            if (sel.name.endsWith(":hours"))   seg.hoursSelect   = sel
            if (sel.name.endsWith(":minutes")) seg.minutesSelect = sel
        }
        // segmentSettings:N:originTerminal / destinationTerminal
        for (const sel of form.querySelectorAll("select[name*='segmentSettings:'][name$='Terminal'], select[name*='segmentSettings:'][name$='terminal']")) {
            const m = (sel.name || "").match(RE_SEG_SEGMENT_IDX)
            if (!m) continue
            const seg = ensure(parseInt(m[1], 10))
            const isOrigin = /origin/i.test(sel.name)
            const val = (selectedValue(sel) || "").trim()
            if (isOrigin) seg.originTerminal = val || null
            else          seg.destTerminal   = val || null
        }
        // segmentsContainer:segments:N:departure-offsets:D:departureOffset
        for (const sel of form.querySelectorAll("select[name*='segments:'][name*='departure-offsets']")) {
            const segM = (sel.name || "").match(/segments:(\d+):/)
            const dayM = (sel.name || "").match(RE_DAY_OFFSET)
            if (!segM || !dayM) continue
            const seg = ensure(parseInt(segM[1], 10))
            const d   = parseInt(dayM[1], 10)
            if (d >= 0 && d < 7) seg.offsets[d] = intOrNull(selectedValue(sel))
        }
        // segmentsContainer:segments:N:fixedArrivalSelection:D:fixedArrival
        for (const cb of form.querySelectorAll("input[type='checkbox'][name*='fixedArrivalSelection']")) {
            const segM = (cb.name || "").match(/segments:(\d+):/)
            const dayM = (cb.name || "").match(RE_DAY_FIXED)
            if (!segM || !dayM) continue
            const seg = ensure(parseInt(segM[1], 10))
            const d   = parseInt(dayM[1], 10)
            if (d >= 0 && d < 7) seg.fixed[d] = !!cb.checked
        }
        // segmentsContainer:segments:N:newArrivals:D:newArrival:hours / minutes
        for (const sel of form.querySelectorAll("select[name*='newArrivals'][name*='newArrival']")) {
            const segM = (sel.name || "").match(/segments:(\d+):/)
            const dayM = (sel.name || "").match(RE_DAY_ARRIVAL)
            if (!segM || !dayM) continue
            const seg = ensure(parseInt(segM[1], 10))
            const d   = parseInt(dayM[1], 10)
            if (d < 0 || d >= 7) continue
            const v = intOrNull(selectedValue(sel))
            if (sel.name.endsWith(":hours"))   seg.arrivalsHours[d]   = v
            if (sel.name.endsWith(":minutes")) seg.arrivalsMinutes[d] = v
        }
        return segs
    }

    /** Find the segment caption row (e.g. "JFK - MCO") for segmentIdx N.
     *  AS doesn't tag this row with the segment id, so we order them by
     *  appearance and match on segmentIdx. Returns {originIata, destIata}
     *  or {null, null} when not found. */
    function findSegmentIatas(form, segmentIdx) {
        const captions = form.querySelectorAll("td.caption")
        let seen = 0
        for (const cap of captions) {
            const text = (cap.textContent || "").trim()
            const links = cap.querySelectorAll("a[href*='/airports/']")
            if (links.length < 2) continue
            // Heuristic: the segment-header captions are the only td.caption
            // cells that carry TWO airport anchors. Match on appearance order.
            if (seen === segmentIdx) {
                return {
                    originIata: iataFromCell(links[0].parentElement) || iataFromCell(links[0]),
                    destIata:   iataFromCell(links[1].parentElement) || iataFromCell(links[1])
                }
            }
            seen++
        }
        return { originIata: null, destIata: null }
    }

    /** Read a per-airport restriction row: returns boolean[7] (or null[7]
     *  when row is absent). Used for Departure slots / Nighttime / Noise. */
    function readCheckRowByCaption(tbody, captionRe) {
        const out = [null, null, null, null, null, null, null]
        const tr  = findRowByCaption(tbody, captionRe)
        if (!tr) return out
        const cells = expandCellsToDays(tr)
        for (let d = 0; d < 7; d++) out[d] = cellIsOk(cells[d])
        return out
    }

    function readPerAirport(tbody) {
        // Origin restrictions: "Departure slots" / "Nighttime departure" / "Noise restrictions" (origin block)
        // Destination restrictions: "Arrival slots" / "Nighttime arrival" / "Noise restrictions" (dest block)
        // The two "Noise restrictions" rows share the same caption — we
        // read the FIRST as origin and the SECOND as destination. AS
        // separates them with a heading row containing the airport name
        // (e.g. "New York (JFK)" vs "Orlando International (MCO)").
        return {
            origin: {
                departureSlots: readCheckRowByCaption(tbody, /^Departure slots$/i),
                nighttime:      readCheckRowByCaption(tbody, /^Nighttime departure$/i),
                noise:          readCheckRowByCaption(tbody, /^Noise restrictions$/i)
            },
            destination: {
                arrivalSlots: readCheckRowByCaption(tbody, /^Arrival slots$/i),
                nighttime:    readCheckRowByCaption(tbody, /^Nighttime arrival$/i),
                noise:        readNthCheckRow(tbody, /^Noise restrictions$/i, 1)
            }
        }
    }

    /** Like readCheckRowByCaption but returns the Nth match (0-based). */
    function readNthCheckRow(tbody, captionRe, n) {
        const out = [null, null, null, null, null, null, null]
        if (!tbody) return out
        let seen = 0
        for (const tr of tbody.querySelectorAll("tr")) {
            const cap = tr.querySelector("td.caption, th")
            const txt = cap ? (cap.textContent || "").trim() : ""
            if (!captionRe.test(txt)) continue
            if (seen === n) {
                const cells = expandCellsToDays(tr)
                for (let d = 0; d < 7; d++) out[d] = cellIsOk(cells[d])
                return out
            }
            seen++
        }
        return out
    }

    /** Read a single segment's per-day cells, plus its perAirport restrictions
     *  (origin + destination). */
    function readSegment(form, segData, daysActive) {
        const segmentIdx = segData.segmentIdx
        const baseHours   = intOrNull(selectedValue(segData.hoursSelect))
        const baseMinutes = intOrNull(selectedValue(segData.minutesSelect))
        const departureBase = (baseHours != null && baseMinutes != null)
            ? { hours: baseHours, minutes: baseMinutes }
            : null

        const { originIata, destIata } = findSegmentIatas(form, segmentIdx)

        // Validation rows (departure-time-validity, aircraft-performance, route-restrictions)
        // and per-airport rows live inside the same tbody; pick the one
        // closest to this segment's selects.
        const tbody = form.querySelector("table.flight-planning-matrix tbody")
        const departureValid     = readCheckRowByCaption(tbody, /^Departure Time Validity$/i)
        const aircraftPerformance = readCheckRowByCaption(tbody, /^Aircraft performance$/i)
        const routeRestrictions  = readCheckRowByCaption(tbody, /^Route Restrictions$/i)
        const perAirport         = readPerAirport(tbody)

        const cells = []
        for (let d = 0; d < 7; d++) {
            const offset = segData.offsets[d]
            const ah     = segData.arrivalsHours[d]
            const am     = segData.arrivalsMinutes[d]
            cells.push({
                dayIdx:               d,
                enabled:              !!daysActive[d],
                departureOffsetMin:   offset == null ? 0 : offset,
                arrival:              (ah != null && am != null) ? { hours: ah, minutes: am } : null,
                fixedArrival:         !!segData.fixed[d],
                departureTimeValid:   departureValid[d],
                aircraftPerformanceOk: aircraftPerformance[d],
                routeRestrictionsOk:  routeRestrictions[d]
            })
        }

        return {
            segmentIdx,
            originIata:   originIata || null,
            destIata:     destIata   || null,
            departureBase,
            originTerminal: segData.originTerminal || null,
            destTerminal:   segData.destTerminal   || null,
            cells,
            perAirport
        }
    }

    /**
     * Public: read the planning-matrix form into a PlanningMatrix object.
     * `isPresent: false` when the form isn't on the page.
     */
    function read() {
        const form = document.querySelector("form[action*='flight.planning.form']")
        if (!form) {
            return { isPresent: false, segments: [], daysActive: [false, false, false, false, false, false, false] }
        }

        try {
            const daysActive  = readDaySelections(form)
            const segMap      = collectSegmentInputs(form)
            const segmentIdxs = Array.from(segMap.keys()).sort((a, b) => a - b)
            const segments    = []
            for (const idx of segmentIdxs) {
                try {
                    segments.push(readSegment(form, segMap.get(idx), daysActive))
                } catch (e) {
                    console.warn("[AES AFP] planning-matrix-reader segment " + idx + " threw", e)
                }
            }
            return { isPresent: true, segments, daysActive }
        } catch (e) {
            console.warn("[AES AFP] planning-matrix-reader.read threw", e)
            return { isPresent: false, segments: [], daysActive: [false, false, false, false, false, false, false] }
        }
    }

    if (typeof window !== "undefined") {
        window.AesAfpPlanningMatrixReader = {
            read,
            _internals: { readDaySelections, collectSegmentInputs, findSegmentIatas, readSegment, expandCellsToDays, cellIsOk }
        }
    }
})()
