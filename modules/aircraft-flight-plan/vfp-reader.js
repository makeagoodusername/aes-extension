"use strict"

/**
 * Track 7 slice 7a — Visual-Flight-Plan reader.
 *
 * Walks `.as-panel.visual-flight-plan .vfp.vfp-main .day` and returns a
 * full Schedule (every `.block` kind, not just `.block.flight`).
 *
 *   .block.flight       — active flight leg (the only kind host.js:197
 *                         used to read). Carries `<span class="code">`,
 *                         a flight-numbers anchor, and an `.overlay`
 *                         with info/edit/delete CTAs.
 *   .block.location     — origin/destination IATA tab around each flight.
 *                         `<span class="outbound|inbound" title>` carries
 *                         the IATA. Width = ground time.
 *   .block.maintenance  — gray bar; aircraft is grounded for maintenance.
 *                         Width = downtime in minutes.
 *   .block.turnaround   — between segments; the `data-target="#ta-NN"`
 *                         anchor exposes a popover modal with the per-side
 *                         activity decomposition (Taxi In / De-Boarding /
 *                         Boarding / Pushback / Taxi Out etc.). Slice 7b
 *                         parses that popover; 7a leaves activities = [].
 *   .block.ready        — ready-for-departure padding before the next
 *                         flight bar.
 *   .block.overlap      — boundary marker (day-spanning).
 *
 * Time encoding: AS positions every block by CSS `margin-left` / `width`
 * as a percentage of the 24h day. So `margin-left: 25.0%` = 360 min = 06:00.
 * The `.times` `<span class="start|end">` text is unreliable on short bars
 * (HHMM for long, just minutes for short — see host.js:178), so percent is
 * the source of truth.
 *
 * Origin / destination on a flight: the location bar immediately preceding
 * the flight carries the `outbound` IATA; the one following carries the
 * `inbound` IATA. We walk the sibling list with a small finder that skips
 * intervening turnaround / ready / overlap markers (mirrors host.js:312).
 *
 * Day-spanning bars: `started && !ended` runs into the next day;
 * `ended && !started` is the continuation. The classifiers structure
 * surfaces both; the legacy adapter folds them into spansIntoNext /
 * spansFromPrev for back-compat.
 *
 * Defensive: every read is wrapped — a malformed block falls back to
 * returning what we have, rather than throwing and dropping the whole
 * day. Validated against the 6968:0?1802 capture (six block kinds + 14
 * `.block.flight` entries) and the legacy 13536:0?6 capture (the one
 * host.js:192 was originally validated against).
 */
;(function () {
    // Idempotent — fleet-schedule-grid loads this file on the broader
    // /app/fleets* match too, which overlaps the per-aircraft AFP match,
    // so the IIFE may run twice in the same isolated world. Skip the
    // second pass when our public surface already advertises readFromRoot.
    if (typeof window !== "undefined"
            && window.AesAfpVfpReader
            && typeof window.AesAfpVfpReader.readFromRoot === "function") {
        return
    }

    /** Order matters: detect more-specific kinds first so a `.block.flight`
     *  isn't mis-classified as a generic block. The classList always has
     *  exactly one of these strings. */
    const KIND_ORDER = ["flight", "maintenance", "turnaround", "location", "ready", "overlap"]

    /** 100% of width = 1440 min (24h). 1% = 14.4 min. Matches host.js:285. */
    const PERCENT_TO_MINUTES = 14.4

    /** Day-of-week labels in the order AS renders them (Mon..Sun). */
    const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    function classifiersFrom(classList) {
        const has = c => !!(classList && classList.contains(c))
        const started = has("started")
        const ended   = has("ended")
        return {
            started,
            ended,
            short:         has("short"),
            dimmed:        has("dimmed"),
            locked:        has("locked"),
            spansIntoNext: started && !ended,
            spansFromPrev: ended   && !started
        }
    }

    function detectKind(classList) {
        if (!classList) return null
        for (const k of KIND_ORDER) {
            if (classList.contains(k)) return k
        }
        return null
    }

    function percentToMinutes(cssVal) {
        if (!cssVal) return null
        const n = parseFloat(String(cssVal))
        if (!isFinite(n)) return null
        return Math.round(n * PERCENT_TO_MINUTES)
    }

    function minToHHMM(min) {
        if (min == null || !isFinite(min)) return null
        const m = ((min % 1440) + 1440) % 1440
        const h  = Math.floor(m / 60)
        const mm = m % 60
        return (h < 10 ? "0" + h : String(h)) + ":" + (mm < 10 ? "0" + mm : String(mm))
    }

    function hhmmToMin(s) {
        if (!s || typeof s !== "string") return null
        const m = s.match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
    }

    /** Read a `.block.location` payload (IATA, direction, full name when title is wider). */
    function readLocationPayload(block) {
        let iata = null, direction = null, airportName = null
        const span = block.querySelector(".outbound, .inbound")
        if (span) {
            direction = span.classList.contains("outbound") ? "outbound" : "inbound"
            const title = span.getAttribute("title")
            const txt   = (span.textContent || "").trim()
            if (title && /^[A-Z]{3}$/.test(title.trim())) {
                iata = title.trim()
            } else {
                const m = txt.match(/\b([A-Z]{3})\b/)
                if (m) iata = m[1]
                if (title && title.length > 3) airportName = title
            }
        }
        return { iata, direction, airportName }
    }

    /**
     * Read a `.block.flight` payload — flight number anchor + the
     * info/edit/delete overlay. The overlay anchors are wicket-ajax URLs
     * (capture line 4713 — `?1802-1.-tabs-panel-visualFlightPlan-days-N
     * -blocks-M-content-overlay-{edit|delete}`); we capture them as-is so
     * a future track-7 writer can emulate the click via Wicket's Ajax bus.
     */
    function readFlightPayload(block) {
        const codeSpan = block.querySelector(".code")
        const flightCode = codeSpan ? (codeSpan.textContent || "").trim() : null
        const fnLink = block.querySelector("a[href*='/numbers/']")
        let flightLink = null
        let flightId   = null
        if (fnLink) {
            const href = fnLink.getAttribute("href") || ""
            const m = href.match(/numbers\/(\d+)/)
            if (m) {
                flightId = m[1]
                flightLink = "/app/com/numbers/" + flightId
            }
        }

        const overlayActions = { infoHref: null, editHref: null, deleteHref: null }
        const overlay = block.querySelector(".overlay")
        if (overlay) {
            for (const a of overlay.querySelectorAll("a[href]")) {
                const t = (a.title || a.getAttribute("title") || "").toLowerCase()
                const href = a.getAttribute("href") || ""
                if (!href) continue
                if (t.includes("view flight number")  || t.includes("view flight"))   overlayActions.infoHref   = href
                else if (t.includes("set planner")    || t.includes("edit"))           overlayActions.editHref   = href
                else if (t.includes("delete")         || t.includes("remove"))         overlayActions.deleteHref = href
            }
        }

        return {
            flightCode,
            flightId,
            flightLink,
            origin:       null,   // resolved by neighbour walk after readDay()
            destination:  null,
            overlayActions
        }
    }

    /**
     * Read the turnaround popover, when the Slice 7b reader is loaded.
     * Falls through to a stub when 7b isn't present (e.g. on a page where
     * only schedule-model + vfp-reader were registered) so callers can
     * unconditionally read `block.turnaround.activities` without crashing.
     */
    function readTurnaroundPayload(block) {
        if (typeof window !== "undefined"
            && window.AesAfpTurnaroundReader
            && typeof window.AesAfpTurnaroundReader.parse === "function") {
            try { return window.AesAfpTurnaroundReader.parse(block) }
            catch (e) { console.warn("[AES AFP] turnaround-popover-reader threw", e) }
        }
        return {
            inboundDurationMin:     null,
            outboundDurationMin:    null,
            maintenanceWindowLocal: null,
            activities:             []
        }
    }

    /** Walk siblings in a direction until a `.block.location` is found; return
     *  its IATA via the matching `.outbound|.inbound` span. Skips intervening
     *  turnaround / ready / overlap blocks. Mirrors host.js:312. */
    function findAdjacentIata(siblings, idx, direction, spanSelector) {
        const step = direction < 0 ? -1 : 1
        for (let j = idx + step; j >= 0 && j < siblings.length; j += step) {
            const sib = siblings[j]
            if (!sib.classList) continue
            if (sib.classList.contains("location")) {
                const span = sib.querySelector(spanSelector)
                if (span) {
                    const title = span.getAttribute("title")
                    if (title && /^[A-Z]{3}$/.test(title.trim())) return title.trim()
                    const txt = (span.textContent || "").trim()
                    const m = txt.match(/\b([A-Z]{3})\b/)
                    if (m) return m[1]
                }
                return null
            }
        }
        return null
    }

    /** Find adjacent `.block.turnaround` width in minutes, in given direction.
     *  Walks past `.location` / `.ready` / `.overlap` / `.maintenance`
     *  siblings (which visually overlap the same airport-side time slot
     *  as the turnaround) and only stops at the next `.block.flight` —
     *  if we hit a flight before a turnaround, there's no TA between
     *  this flight and that one. Used to stitch turnaroundBeforeMin /
     *  turnaroundAfterMin onto each flight leg so the auto-scheduler can
     *  read real per-station ground time instead of a hard-coded constant. */
    function findAdjacentTurnaroundMin(siblings, idx, direction) {
        const step = direction < 0 ? -1 : 1
        for (let j = idx + step; j >= 0 && j < siblings.length; j += step) {
            const sib = siblings[j]
            if (!sib.classList) continue
            if (sib.classList.contains("turnaround")) {
                return percentToMinutes(sib.style.width)
            }
            if (sib.classList.contains("flight")) {
                return null
            }
            // Skip location / ready / overlap / maintenance — these
            // visually overlap with the TA's time slot at the airport,
            // not represent a gap between flights.
        }
        return null
    }

    function readBlock(block, dayIdx, dayName) {
        if (!block || !block.classList) return null
        const kind = detectKind(block.classList)
        if (!kind) return null

        const classifiers = classifiersFrom(block.classList)
        const startMin    = percentToMinutes(block.style.marginLeft)
        const widthMin    = percentToMinutes(block.style.width)
        const endMin      = (startMin != null && widthMin != null) ? startMin + widthMin : null

        const out = {
            kind,
            seq:        0,    // assigned after sort
            dayIdx,
            dayName,
            startMin,
            endMin,
            durationMin: widthMin,
            startLocal: minToHHMM(startMin),
            endLocal:   endMin == null ? null : minToHHMM(endMin),
            classifiers,
            raw:        block
        }

        if      (kind === "location")    out.location    = readLocationPayload(block)
        else if (kind === "flight")      out.flight      = readFlightPayload(block)
        else if (kind === "maintenance") out.maintenance = { isMaintenance: true }
        else if (kind === "turnaround")  out.turnaround  = readTurnaroundPayload(block)
        else if (kind === "ready")       out.ready       = { isReady: true }
        else if (kind === "overlap")     out.overlap     = { isOverlap: true }

        return out
    }

    /** Read one `.day` element into a DaySchedule. */
    function readDay(dayEl, dayIdx) {
        const dayNameRaw = dayEl.querySelector(".dayName")?.textContent?.trim() || null
        const dayName    = dayNameRaw || DAY_NAMES[dayIdx] || null
        const blocksRoot = dayEl.querySelector(".blocks")
        if (!blocksRoot) {
            return { dayIdx, dayName, blocks: [], flights: [], isEmpty: true }
        }
        const children = Array.from(blocksRoot.children)
        const blocks = []
        for (let i = 0; i < children.length; i++) {
            const b = readBlock(children[i], dayIdx, dayName)
            if (b) blocks.push(b)
        }

        // Origin / destination resolution + turnaround stitching for flight blocks.
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i]
            if (b.kind !== "flight") continue
            b.flight.origin              = findAdjacentIata(children, i, -1, ".outbound")
            b.flight.destination         = findAdjacentIata(children, i, +1, ".inbound")
            b.flight.turnaroundBeforeMin = findAdjacentTurnaroundMin(blocks, i, -1)
            b.flight.turnaroundAfterMin  = findAdjacentTurnaroundMin(blocks, i, +1)
        }

        const flights = blocks.filter(b => b.kind === "flight")
        return { dayIdx, dayName, blocks, flights, isEmpty: blocks.length === 0 }
    }

    /** Walk all `.day` elements under a root (Document or Element); returns
     *  DaySchedule[] (length 7 on a populated AFP page; 0 if no VFP at all).
     *  Default root = `document` — preserves the original signature. The
     *  optional root arg is what fleet-schedule-grid uses to parse a fetched
     *  HTML doc into the same Schedule shape without navigating the user. */
    function readDays(root) {
        const r = root || (typeof document !== "undefined" ? document : null)
        if (!r) return []
        const out = []
        const days = r.querySelectorAll(".as-panel.visual-flight-plan .vfp.vfp-main .day")
        days.forEach((day, dayIdx) => {
            try { out.push(readDay(day, dayIdx)) }
            catch (e) { console.warn("[AES AFP] vfp-reader.readDay threw at dayIdx=" + dayIdx, e) }
        })
        return out
    }

    /** Build the flat ScheduleLeg[] view from the days. Sorted by (dayIdx,
     *  depTimeLocal asc); seq is reassigned 1..N after the sort so consumers
     *  (slice 6b's schedule-diff) can use it as a stable per-week id. */
    function buildLegs(days) {
        const out = []
        for (const day of days) {
            for (const b of day.blocks) {
                if (b.kind !== "flight") continue
                const f = b.flight || {}
                out.push({
                    seq:                 0,    // post-sort
                    dayIdx:              b.dayIdx,
                    dayName:             b.dayName,
                    depTimeLocal:        b.startLocal,
                    arrTimeLocal:        b.endLocal,
                    durationMin:         b.durationMin,
                    origin:              f.origin || null,
                    destination:         f.destination || null,
                    flightCode:          f.flightCode || null,
                    flightNumber:        f.flightCode || null,   // legacy alias
                    flightId:            f.flightId || null,
                    flightLink:          f.flightLink || null,
                    turnaroundBeforeMin: (f.turnaroundBeforeMin == null) ? null : f.turnaroundBeforeMin,
                    turnaroundAfterMin:  (f.turnaroundAfterMin  == null) ? null : f.turnaroundAfterMin,
                    spansIntoNext:       !!b.classifiers.spansIntoNext,
                    spansFromPrev:       !!b.classifiers.spansFromPrev,
                    modifiers:           { dimmed: !!b.classifiers.dimmed, locked: !!b.classifiers.locked },
                    overlayActions:      f.overlayActions || null,
                    raw:                 b.raw
                })
            }
        }
        out.sort((a, b) => {
            if (a.dayIdx !== b.dayIdx) return a.dayIdx - b.dayIdx
            const aMin = a.depTimeLocal ? hhmmToMin(a.depTimeLocal) : 1e9
            const bMin = b.depTimeLocal ? hhmmToMin(b.depTimeLocal) : 1e9
            return aMin - bMin
        })
        for (let s = 0; s < out.length; s++) out[s].seq = s + 1
        return out
    }

    /** Sum widths by kind across all days; pick the first .block.location
     *  IATA as a best-effort hub fallback when ctx hub is null. */
    function summariseDays(days) {
        let weeklyBlockMinutes    = 0
        let weeklyMaintenanceMin  = 0
        let weeklyTurnaroundMin   = 0
        let weeklyReadyMin        = 0
        let flightCount           = 0
        let firstHubIata          = null

        for (const day of days) {
            for (const b of day.blocks) {
                if (b.durationMin == null) continue
                if      (b.kind === "flight")      { weeklyBlockMinutes += b.durationMin; flightCount++ }
                else if (b.kind === "maintenance")   weeklyMaintenanceMin += b.durationMin
                else if (b.kind === "turnaround")    weeklyTurnaroundMin  += b.durationMin
                else if (b.kind === "ready")         weeklyReadyMin       += b.durationMin
                else if (b.kind === "location" && firstHubIata == null && b.location && b.location.iata) {
                    firstHubIata = b.location.iata
                }
            }
        }
        return { flightCount, weeklyBlockMinutes, weeklyMaintenanceMin, weeklyTurnaroundMin, weeklyReadyMin, firstHubIata }
    }

    /**
     * Read the page into a Schedule. Caller passes server / aircraftId /
     * hubIata via opts (host.js:readSchedule supplies them from AesAfp.ctx).
     * Slice 7b will fold the planning matrix in via planning-matrix-reader.
     */
    function read(opts) {
        return readFromRoot(typeof document !== "undefined" ? document : null, opts)
    }

    /**
     * Same as `read(opts)` but takes an explicit root (Document or Element),
     * so callers like fleet-schedule-grid can parse a fetched HTML document
     * (DOMParser) without temporarily attaching it to the live DOM.
     * Planning matrix is skipped here — its reader is DOM-coupled to live
     * Wicket forms and the form fields aren't trustworthy on a static fetch.
     */
    function readFromRoot(root, opts) {
        opts = opts || {}
        const days    = readDays(root)
        const legs    = buildLegs(days)
        const summary = summariseDays(days)
        const matrix  = (root === document
                         && typeof window !== "undefined"
                         && typeof window.AesAfpPlanningMatrixReader !== "undefined"
                         && typeof window.AesAfpPlanningMatrixReader.read === "function")
            ? window.AesAfpPlanningMatrixReader.read()
            : (typeof window !== "undefined" && window.AesAfpScheduleModel
                ? window.AesAfpScheduleModel.emptyMatrix()
                : { isPresent: false, segments: [], daysActive: [false,false,false,false,false,false,false] })

        return {
            schemaVersion:  1,
            server:         String(opts.server     || ""),
            aircraftId:     String(opts.aircraftId || ""),
            scrapedAt:      Date.now(),
            hubIata:        opts.hubIata || summary.firstHubIata || null,
            days,
            planningMatrix: matrix,
            legs,
            summary: {
                flightCount:          summary.flightCount,
                weeklyBlockMinutes:   summary.weeklyBlockMinutes,
                weeklyMaintenanceMin: summary.weeklyMaintenanceMin,
                weeklyTurnaroundMin:  summary.weeklyTurnaroundMin,
                weeklyReadyMin:       summary.weeklyReadyMin
            }
        }
    }

    if (typeof window !== "undefined") {
        window.AesAfpVfpReader = {
            read,
            readFromRoot,
            // Internals exposed for diagnostics and future slices' tests.
            _internals: { readDay, readDays, readBlock, classifiersFrom, detectKind, percentToMinutes, minToHHMM, hhmmToMin, findAdjacentIata, findAdjacentTurnaroundMin }
        }
    }
})()
