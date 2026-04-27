"use strict"

/**
 * Aircraft Flight Plan Assistant — host module (Slice A foundation).
 *
 * Owns the `window.AesAfp` global that the other AFP slices attach
 * sub-namespaces to. Mounts TWO scaffolds on the per-aircraft Flight
 * Plan page (`/app/fleets/aircraft/<id>/0`):
 *
 *   1. Sidebar host  (`.col-md-2`) — header / spec / audit
 *   2. Wide host     (`.col-md-10`, above the Visual Flight Plan) —
 *      candidates / driver / wave / tools
 *
 * The wide host gives the Gantt + candidates table room to render at the
 * width they were designed for; the sidebar keeps informational readouts
 * tidy. Slices B-F still call `AesAfp.slot(name)` — they don't know which
 * host owns which slot.
 *
 * Public API (consumed by every other AFP slice):
 *   AesAfp.version            — "0.2.0"
 *   AesAfp.ctx                — PageContext (populated on mount)
 *   AesAfp.bus                — {emit, on, off}
 *   AesAfp.host               — sidebar `.as-panel` root (back-compat)
 *   AesAfp.wideHost           — main-column `.as-panel` root
 *   AesAfp.slot(name)         — returns div[data-aes-afp-slot=name]
 *   AesAfp.getCurrentSchedule()  — VFP reader → Leg[]
 *   AesAfp.getNewFlightForm()    — form locator → FormHandles | null
 *   AesAfp.mount()            — idempotent; re-runs from MutationObserver
 */

;(function () {
    if (window.AesAfp) return  // already loaded — content_aircraftFlightPlan.js will call mount()

    const VERSION = "0.2.0"
    const HOST_ATTR      = "data-aes-afp-host"
    const WIDE_HOST_ATTR = "data-aes-afp-wide-host"
    const SIDEBAR_SLOT_NAMES = ["header", "spec", "maintenance", "audit"]
    // "auto-preview" is owned by Track 5's preview-panel.js. Inserted right
    // under "tools" so the auto-build summary + Apply-all CTA become the
    // first thing the user sees in the wide host, sitting visually above
    // the candidate table and the legacy form-driver toolbar.
    const WIDE_SLOT_NAMES    = ["tools", "auto-preview", "candidates", "driver", "wave"]
    const REMOUNT_DEBOUNCE_MS = 200

    /** Wrap a thunk; swallow errors and return null on throw. */
    function safeCall(fn) {
        try { return fn() } catch (_) { return null }
    }

    /**
     * Tiny event bus. Map<eventName, Set<handler>>. Each handler runs in
     * its own try/catch so a buggy subscriber can't break the bus or
     * starve other subscribers.
     */
    function createBus() {
        const handlers = new Map()
        return {
            on(name, h) {
                if (typeof h !== "function") return
                let set = handlers.get(name)
                if (!set) { set = new Set(); handlers.set(name, set) }
                set.add(h)
            },
            off(name, h) {
                const set = handlers.get(name)
                if (set) set.delete(h)
            },
            emit(name, payload) {
                const set = handlers.get(name)
                if (!set) return
                for (const h of Array.from(set)) {
                    try { h(payload) } catch (e) {
                        console.warn("[AES AFP] bus handler threw for '" + name + "'", e)
                    }
                }
            }
        }
    }

    /**
     * Read aircraft + airline + location context from the page DOM.
     * Mirrors content_aircraftFlights.js:325-345 (h1 spans + pathname
     * regex). currentLocationIata pulls from the sidebar's "Last airport"
     * row (the captured snapshot has it at /app/info/airports/<id>; we
     * read the IATA from the link text).
     */
    function extractPageContext() {
        const spans = document.querySelectorAll(".as-page-aircraft h1 span")
        const idMatch = window.location.pathname.match(/(?<=\/aircraft\/)(\d+)/)

        let currentLocationIata = null
        let currentLocationName = null
        let currentLocationAirportId = null
        const sidebarTable = document.querySelector(".as-page-aircraft .col-md-2 .as-table-well table")
        if (sidebarTable) {
            for (const tr of sidebarTable.querySelectorAll("tr")) {
                const th = tr.querySelector("th")
                if (!th) continue
                if (/^last airport/i.test(th.textContent.trim())) {
                    const a = tr.querySelector("td a")
                    if (a) {
                        const txt = (a.innerText || "").trim().toUpperCase()
                        currentLocationIata = txt || null
                        currentLocationName = a.title || null
                        const idM = (a.getAttribute("href") || "").match(/\/airports\/(\d+)/)
                        if (idM) currentLocationAirportId = parseInt(idM[1], 10)
                    }
                    break
                }
            }
        }

        // AES.getAirlineCode reads `.facts table` which is dashboard-only;
        // wrap it so a missing table doesn't crash mount on the aircraft
        // page. AES.getAirlineIdentity is the multi-page-safe variant.
        const airline   = safeCall(() => AES.getAirlineCode())     || {name: "", code: ""}
        const airlineId = safeCall(() => AES.getAirlineIdentity()) || ""
        const server    = safeCall(() => AES.getServerName())      || ""

        return {
            aircraftId:          idMatch ? idMatch[1] : null,
            registration:        spans[0]?.innerText?.trim() || null,
            equipment:           spans[1]?.innerText?.trim() || null,
            nickname:            spans[2]?.innerText?.trim() || null,
            currentLocationIata,
            currentLocationName,
            currentLocationAirportId,
            server,
            airlineCode:         airline.code || "",
            airlineName:         airline.name || "",
            airlineId
        }
    }

    /**
     * Fire-and-forget: write the freshly-extracted location into AFP state
     * so cross-page consumers (Fleet Hub on /app/fleets) can render a Loc
     * column without re-scraping each aircraft detail page.
     *
     * Skip the write when iata + airportId are unchanged from the stored
     * record — a no-op save still fires `chrome.storage.onChanged` and
     * triggers a Fleet Hub repaint on every other tab. Same-day mounts on
     * a single aircraft would thrash the hub otherwise.
     */
    function persistLocation(ctx) {
        if (!ctx || !ctx.server || !ctx.aircraftId) return
        if (!window.AesAfpStateStore) return
        try {
            AesAfpStateStore.load(ctx.server, ctx.aircraftId).then(existing => {
                if (existing
                    && existing.currentLocationIata      === ctx.currentLocationIata
                    && existing.currentLocationAirportId === ctx.currentLocationAirportId
                    && existing.currentLocationName      === ctx.currentLocationName) {
                    return
                }
                return AesAfpStateStore.save(ctx.server, ctx.aircraftId, {
                    currentLocationIata:      ctx.currentLocationIata,
                    currentLocationName:      ctx.currentLocationName,
                    currentLocationAirportId: ctx.currentLocationAirportId,
                    lastSeenAt:               Date.now()
                })
            }).catch(err => {
                console.warn("[AES AFP] persistLocation save rejected", err)
            })
        } catch (e) {
            console.warn("[AES AFP] persistLocation threw", e)
        }
    }

    /**
     * Visual Flight Plan reader. Walks `.day .blocks` Mon-Sun and emits
     * one entry per `.block.flight` child (skipping the location /
     * turnaround / ready slivers around each flight bar).
     *
     * Time encoding: AS positions every block by CSS `margin-left` /
     * `width` as a percentage of the 24h day. So a flight block with
     * `margin-left: 25.0%` starts at 6:00 (25% × 1440min = 360min). The
     * `<span class="start">` text inside is unreliable across short vs
     * long bars (HHMM for long, just minutes for short), so we treat
     * margin-left as the source of truth and round to the nearest minute.
     *
     * Origin / destination: the location bars sandwiching the flight bar
     * carry the IATA in `<span class="outbound" title>` (the bar before)
     * and `<span class="inbound" title>` (the bar after). We prefer the
     * `title` attribute over textContent because AS sometimes wraps the
     * label in extra elements.
     *
     * Each leg gets a synthetic 1-based `seq` ordered by (dayIdx, depTime)
     * so callers (Track 6's ScheduleDiff) can refer to a current leg by
     * an integer key the way ScheduleBuilder-produced legs do.
     *
     * Slice 6a-followup: a long-haul flight that visually splits across
     * midnight (a `block flight started` half on day N + a
     * `block flight ended` half on day N+1, sharing the same `flightId`)
     * is now collapsed into ONE merged leg with `crossesMidnight: true`.
     * The pre-followup `spansIntoNext` / `spansFromPrev` flags are
     * stripped from output legs; only `crossesMidnight` survives. See
     * `_collapseDayCrossPairs` for the pairing rules.
     *
     * Validated against:
     * - `CLAUDE/...:13536:0?6 flight plan.html` — 14 same-day flights;
     *   collapse is a no-op (no `started`/`ended` halves).
     * - `CLAUDE/...:21944:0?13 MULTIDAYROUTES.html` — 20 raw flight bars
     *   collapse to 14 logical legs (8 same-day + 6 cross-midnight).
     * - The 6968 capture's empty .blocks paths still return [].
     * See `CLAUDE/handover-fragments/AFP-VFP-parser.md` for the audit.
     */
    function readVisualFlightPlan() {
        const out = []
        const days = document.querySelectorAll(".as-panel.visual-flight-plan .vfp.vfp-main .day")
        days.forEach((day, dayIdx) => {
            const dayName = day.querySelector(".dayName")?.textContent?.trim() || null
            const blocks = day.querySelector(".blocks")
            if (!blocks) return
            const children = Array.from(blocks.children)
            for (let i = 0; i < children.length; i++) {
                const block = children[i]
                if (!block.classList || !block.classList.contains("flight")) continue
                out.push(_readVfpFlightBlock(block, children, i, dayIdx, dayName))
            }
        })
        out.sort((a, b) => {
            if (a.dayIdx !== b.dayIdx) return a.dayIdx - b.dayIdx
            const aMin = _hhmmToMin(a.depTimeLocal)
            const bMin = _hhmmToMin(b.depTimeLocal)
            return (aMin == null ? 1e9 : aMin) - (bMin == null ? 1e9 : bMin)
        })
        for (let s = 0; s < out.length; s++) out[s].seq = s + 1
        return _collapseDayCrossPairs(out)
    }

    /** Internal: extract one flight leg from a `.block.flight` element. */
    function _readVfpFlightBlock(block, children, idx, dayIdx, dayName) {
        const codeSpan = block.querySelector(".code")
        const flightCode = codeSpan ? (codeSpan.textContent || "").trim() : null
        const fnLink = block.querySelector("a[href*='/numbers/']")
        let flightLink = null
        let flightId = null
        if (fnLink) {
            const href = fnLink.getAttribute("href") || ""
            // Hrefs are AS-relative like "../../../com/numbers/9135?segment=0";
            // strip the query + leading dots so callers always see "/app/com/numbers/<id>".
            const m = href.match(/numbers\/(\d+)/)
            if (m) {
                flightId = m[1]
                flightLink = "/app/com/numbers/" + flightId
            }
        }

        const startMin = _percentToMinutes(block.style.marginLeft)
        const widthMin = _percentToMinutes(block.style.width)
        const depTimeLocal = startMin == null ? null : _minToHHMM(startMin)
        const arrTimeLocal = (startMin != null && widthMin != null)
            ? _minToHHMM((startMin + widthMin) % 1440) : null
        const durationMin  = widthMin != null ? Math.round(widthMin) : null

        // Origin = `outbound` IATA from the `.block.location` immediately
        // before the flight bar (or earlier if intervening turnaround
        // blocks were emitted by AS). Destination = `inbound` IATA from
        // the location bar AFTER the flight bar.
        const origin = _findAdjacentIata(children, idx, -1, ".outbound")
        const destination = _findAdjacentIata(children, idx, +1, ".inbound")

        // Day-spanning markers: classList "started" without "ended" means
        // bar runs into the next day; "ended" without "started" means it
        // continues from the previous day. Track 6 diff treats both shapes
        // as a single leg keyed off (origin, dest, depTime).
        const cl = block.classList
        const spansIntoNext = cl.contains("started") && !cl.contains("ended")
        const spansFromPrev = cl.contains("ended")   && !cl.contains("started")

        return {
            seq: 0,                       // assigned after sort
            dayIdx,
            dayName,
            depTimeLocal,
            arrTimeLocal,
            durationMin,
            origin,
            destination,
            flightCode,                   // "79", "FGM 1" — suffix only, no airline prefix
            flightNumber: flightCode,     // alias for callers expecting `flightNumber`
            flightId,                     // numeric AS id, e.g. "9135"
            flightLink,                   // "/app/com/numbers/9135"
            spansIntoNext,
            spansFromPrev,
            raw: block
        }
    }

    /** Internal: resolve a CSS percent ("25.0%") to minutes-of-day (0..1440). */
    function _percentToMinutes(cssVal) {
        if (!cssVal) return null
        const n = parseFloat(String(cssVal))
        if (!isFinite(n)) return null
        return Math.round(n * 14.4)
    }

    /** Internal: format minute count (0..1439) as "HH:MM". */
    function _minToHHMM(min) {
        if (min == null || !isFinite(min)) return null
        const m = ((min % 1440) + 1440) % 1440
        const h  = Math.floor(m / 60)
        const mm = m % 60
        return (h < 10 ? "0" + h : String(h)) + ":" + (mm < 10 ? "0" + mm : String(mm))
    }

    /** Internal: parse "HH:MM" → minutes. */
    function _hhmmToMin(s) {
        if (!s || typeof s !== "string") return null
        const m = s.match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
    }

    /**
     * Internal: walk neighbours of a flight block looking for a `.block.location`
     * containing the requested IATA span. `direction` = -1 for previous siblings,
     * +1 for next siblings. Stops at the first location bar found in each
     * direction; returns the IATA via the span's `title` attr (preferred) with
     * textContent as fallback.
     */
    function _findAdjacentIata(children, idx, direction, spanSelector) {
        const step = direction < 0 ? -1 : 1
        for (let j = idx + step; j >= 0 && j < children.length; j += step) {
            const sib = children[j]
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
            // Skip turnaround / ready / odd-even background slivers.
        }
        return null
    }

    /**
     * Internal (slice 6a-followup): collapse VFP day-cross pairs.
     *
     * AS renders a flight that crosses midnight as TWO bars sharing the
     * same `flightId`: a `.block.flight.started` (no `ended` class) at
     * the tail of day N, and a `.block.flight.ended` (no `started` class)
     * at the head of day N+1. The pre-followup parser emitted both as
     * separate legs with the `ended` half stamped `depTimeLocal: "00:00"`
     * — diff treats those as non-matchable, but they pollute the array
     * for any consumer iterating one-row-per-leg.
     *
     * This pass pairs the two halves by `flightId` (and verifies
     * adjacency via `dayIdx + 1` mod 7 so a Sun→Mon wrap pairs correctly),
     * keeps the `started` half as the canonical merged leg, and folds
     * in the `ended` half's destination + arrTime + width-half-duration.
     *
     * Pre-followup leg flags `spansIntoNext` / `spansFromPrev` are
     * retired here — every output leg gets a `crossesMidnight: boolean`
     * field set instead. Pathological shapes (a `started` with no
     * matching `ended`, or vice versa) emit a `console.warn` and stay
     * in the output as same-day legs (`crossesMidnight: false`) so
     * downstream consumers can still see them.
     *
     * No-op when no leg carries the span flags (e.g. when a future
     * upstream reader already collapsed pairs internally) — the
     * function still strips the retired flags + stamps `crossesMidnight`
     * for shape consistency.
     */
    function _collapseDayCrossPairs(legs) {
        if (!Array.isArray(legs) || !legs.length) return legs || []

        const buckets = new Map()
        for (const leg of legs) {
            if (!leg || !leg.flightId) continue
            if (!leg.spansIntoNext && !leg.spansFromPrev) continue
            if (!buckets.has(leg.flightId)) buckets.set(leg.flightId, {started: [], ended: []})
            const b = buckets.get(leg.flightId)
            if (leg.spansIntoNext) b.started.push(leg)
            if (leg.spansFromPrev) b.ended.push(leg)
        }

        const toRemove = new Set()
        for (const [flightId, bucket] of buckets) {
            for (const s of bucket.started) {
                const expectedEndedDay = (s.dayIdx + 1) % 7
                const e = bucket.ended.find(x => x.dayIdx === expectedEndedDay && !x._claimed)
                if (!e) {
                    console.warn("[AES afp-6a] unpaired day-cross started half", {flightId, dayIdx: s.dayIdx})
                    continue
                }
                e._claimed = true
                s.arrTimeLocal    = e.arrTimeLocal
                s.durationMin     = (s.durationMin || 0) + (e.durationMin || 0)
                if (!s.destination) s.destination = e.destination
                s.crossesMidnight = true
                toRemove.add(e)
            }
            for (const e of bucket.ended) {
                if (!e._claimed) {
                    console.warn("[AES afp-6a] unpaired day-cross ended half", {flightId, dayIdx: e.dayIdx})
                }
                delete e._claimed
            }
        }

        const out = []
        for (const leg of legs) {
            if (toRemove.has(leg)) continue
            if (leg && typeof leg === "object") {
                if (leg.crossesMidnight === undefined) leg.crossesMidnight = false
                delete leg.spansIntoNext
                delete leg.spansFromPrev
            }
            out.push(leg)
        }
        for (let i = 0; i < out.length; i++) {
            if (out[i]) out[i].seq = i + 1
        }
        return out
    }

    /**
     * Locate the New Flight Number form and return field handles.
     *
     * Anchors on the green "Create new flight number" submit button — its
     * value text is unique on the page (the Transfer-flight-plan submit
     * uses "Transfer Flight Plan", and the sidebar Settings uses
     * "Apply..."). closest("form") gives the form root; from there every
     * other field is found by name within that scope, which protects us
     * from the sidebar Transfer form's `name="destination-group:..."`
     * select that would otherwise match a global `[name*='destination']`.
     *
     * Returns null when the form isn't on the page (the page is showing
     * an Existing Flight Number tab, the form is mid-render, etc).
     */
    function findNewFlightForm() {
        const submitBtn = document.querySelector(
            "input[type='submit'][value*='Create new flight']"
        )
        if (!submitBtn) return null
        const form = submitBtn.closest("form")
        if (!form) return null

        const originSelect  = form.querySelector("select[name='origin']")
                           || form.querySelector("select[name*='origin']")
        const destSelect    = form.querySelector("select[name='destination']")
                           || form.querySelector("select[name*='destination']")
        const hoursSelect   = form.querySelector("select[name='departure:hours']")
        const minsSelect    = form.querySelector("select[name='departure:minutes']")
        const priceSelect   = form.querySelector("select[name='price']")
        const serviceSelect = form.querySelector("select[name='service']")

        // Reverse-O/D link sits in the same form's .as-action-bar.
        // Match by href (toggle~stations) first, fall back to text.
        let reverseBtn = form.querySelector("a.btn.btn-default[href*='toggle~stations']")
        if (!reverseBtn) {
            for (const a of form.querySelectorAll("a.btn.btn-default")) {
                if (/reverse/i.test(a.textContent || "")) { reverseBtn = a; break }
            }
        }

        return {
            form,
            originSelect,
            destSelect,
            hoursSelect,
            minsSelect,
            priceSelect,
            serviceSelect,
            submitBtn,
            reverseBtn
        }
    }

    /**
     * Locate the "New Flight Number" / "Existing Flight Number" tabs that
     * gate the form's visibility. Returns the two anchor elements + which
     * tab is currently active. We match by visible text first because
     * Wicket's `id<NNNN>` attributes reshuffle on every page render; the
     * `toggle~new` / `toggle~existing` href substrings are a backup.
     *
     * Used by form-driver to auto-flip to the New tab when the user clicks
     * a candidate while the Existing tab is showing — the form's submit
     * button only exists in the New tab's panel, so findNewFlightForm()
     * returns null until the panel is swapped in.
     */
    function findFormTabs() {
        let navTabs = null
        for (const nav of document.querySelectorAll(".nav-tabs")) {
            const t = (nav.textContent || "").toLowerCase()
            if (t.includes("new flight number") && t.includes("existing flight number")) {
                navTabs = nav
                break
            }
        }
        if (!navTabs) navTabs = document.querySelector(".as-page-aircraft .col-md-10 .nav-tabs")
        if (!navTabs) return {newTab: null, existingTab: null, activeTab: "unknown"}

        let newTab = null, existingTab = null
        for (const a of navTabs.querySelectorAll("a")) {
            const t = (a.textContent || "").trim().toLowerCase()
            if (!newTab && t === "new flight number") newTab = a
            if (!existingTab && t === "existing flight number") existingTab = a
        }
        if (!newTab) {
            newTab = navTabs.querySelector("a[href*='newFlightNumber'], a[href*='toggle~new']")
        }
        if (!existingTab) {
            existingTab = navTabs.querySelector("a[href*='existingFlightNumber'], a[href*='toggle~existing']")
        }

        const activeLi = navTabs.querySelector("li.active")
        const activeText = (activeLi ? activeLi.textContent : "").trim().toLowerCase()
        const activeTab = activeText.includes("new flight")  ? "new"
                        : activeText.includes("existing")    ? "existing"
                        : "unknown"
        return {newTab, existingTab, activeTab}
    }

    /** Build the sidebar scaffold (header / spec / audit). */
    function buildSidebarScaffold() {
        const wrap = document.createDocumentFragment()
        const heading = document.createElement("h3")
        heading.textContent = "AES Route Assistant"
        wrap.appendChild(heading)

        const panel = document.createElement("div")
        panel.className = "as-panel"
        panel.setAttribute(HOST_ATTR, "")

        const well = document.createElement("div")
        well.className = "as-table-well"
        well.style.padding = "8px"

        for (const name of SIDEBAR_SLOT_NAMES) {
            const slot = document.createElement("div")
            slot.setAttribute("data-aes-afp-slot", name)
            if (name === "header") {
                slot.style.fontSize = "11px"
                slot.style.color = "#9ca3af"
                slot.style.marginBottom = "6px"
            }
            well.appendChild(slot)
        }

        panel.appendChild(well)
        wrap.appendChild(panel)
        return {fragment: wrap, panel}
    }

    /** Build the wide main-column scaffold (tools / candidates / driver / wave). */
    function buildWideScaffold() {
        const wrap = document.createDocumentFragment()
        const heading = document.createElement("h3")
        heading.textContent = "AES Route Builder"
        wrap.appendChild(heading)

        const panel = document.createElement("div")
        panel.className = "as-panel"
        panel.setAttribute(WIDE_HOST_ATTR, "")
        // RouteAssistantWaveOverlay.renderGantt positions its connection
        // SVG against host.getBoundingClientRect() (wave-overlay.js:440-441).
        // Mark the panel as the positioning context so the overlay layers
        // correctly when nested inside the wide host.
        panel.style.position = "relative"

        const well = document.createElement("div")
        well.className = "as-table-well"
        well.style.padding = "10px"

        for (const name of WIDE_SLOT_NAMES) {
            const slot = document.createElement("div")
            slot.setAttribute("data-aes-afp-slot", name)
            if (name !== "tools") slot.style.marginTop = "8px"
            well.appendChild(slot)
        }

        panel.appendChild(well)
        wrap.appendChild(panel)
        return {fragment: wrap, panel}
    }

    /** Render the header status strip — sidebar slot. */
    function renderHeaderStrip(slot, ctx) {
        if (!slot) return
        const reg  = escapeHtml(ctx.registration || "—")
        const eq   = escapeHtml(ctx.equipment    || "—")
        const iata = escapeHtml(ctx.currentLocationIata || "—")
        slot.innerHTML =
            "<span>" + reg + "</span>" +
            " · <span>" + eq + "</span>" +
            " · <span title=\"current location\">" + iata + "</span>" +
            " · <span>v" + escapeHtml(VERSION) + "</span>" +
            " · <a href=\"#\" data-aes-afp-refresh>Refresh</a>"
        const refreshLink = slot.querySelector("[data-aes-afp-refresh]")
        if (refreshLink) {
            refreshLink.addEventListener("click", (e) => {
                e.preventDefault()
                // Re-extract ctx in case the sidebar updated, then re-emit
                // ctx:ready so subscribers can re-resolve. No DOM teardown.
                AesAfp.ctx = extractPageContext()
                renderHeaderStrip(slot, AesAfp.ctx)
                renderToolsStrip(AesAfp.slot("tools"), AesAfp.ctx)
                persistLocation(AesAfp.ctx)
                AesAfp.bus.emit("ctx:ready", {ctx: AesAfp.ctx})
            })
        }
    }

    /**
     * Render the wide-host tools strip: Open Stations modal, Open Route
     * Assistant on this hub (new tab), and a hub-watchlist toggle. Each
     * action defensively guards on its dependency so a missed manifest
     * load degrades gracefully rather than crashing the slot.
     */
    function renderToolsStrip(slot, ctx) {
        if (!slot) return
        slot.innerHTML = ""
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;"
            + "font-size:11px;color:#cbd5e1;"

        const hub = (ctx && ctx.currentLocationIata) || null

        // Hub label (no-op clickable that shows where actions are scoped).
        const label = document.createElement("span")
        label.style.cssText = "color:#9ca3af;margin-right:4px;"
        label.textContent = hub ? ("Hub: " + hub) : "Hub: unresolved"
        wrap.appendChild(label)

        // Open Stations modal — opens with the current hub pre-selected.
        const stationsBtn = mkToolButton("Open stations…",
            hub ? "Bulk-open stations using top routes / watchlist / FlightsFrom for " + hub
                : "Hub not yet resolved — refresh once Slice A finds the aircraft's last airport.",
            !!hub && typeof OpenStationsModal !== "undefined" && !!ctx.server && !!ctx.airlineCode,
            () => {
                if (typeof OpenStationsModal === "undefined") {
                    console.warn("[AES AFP] OpenStationsModal not loaded — check manifest order")
                    return
                }
                try {
                    const modal = new OpenStationsModal({
                        server:      ctx.server,
                        airlineCode: ctx.airlineCode || ctx.airlineId || "",
                        currentHub:  hub
                    })
                    modal.open()
                } catch (e) {
                    console.warn("[AES AFP] OpenStationsModal threw", e)
                }
            })
        wrap.appendChild(stationsBtn)

        // Jump to the full Route Assistant panel on the scheduling page,
        // pre-rooted at this aircraft's hub (the panel reads ?origin).
        const raBtn = mkToolButton("Open Route Assistant",
            hub ? "Open the full RA panel on the scheduling page rooted at " + hub
                : "Hub not yet resolved.",
            !!hub,
            () => {
                if (!hub) return
                try { window.open("/app/com/scheduling?origin=" + encodeURIComponent(hub), "_blank") }
                catch (_) { /* noop */ }
            })
        wrap.appendChild(raBtn)

        // Hub-watchlist toggle. Watchlist keys are "<HUB>-<DEST>"; we use
        // a synthetic "<HUB>-HUB" sentinel to mark the hub itself as a
        // tracked target so the OpenStationsModal can prefer this hub on
        // future runs.
        if (typeof RouteAssistantWatchlistStore !== "undefined" && hub) {
            const wlBtn = document.createElement("button")
            wlBtn.type = "button"
            wlBtn.style.cssText = toolButtonCss(true)
            wlBtn.textContent = "★ Watchlist this hub"
            wlBtn.title = "Add/remove " + hub + " from the Route Assistant watchlist."
            const refreshState = async () => {
                try {
                    const has = await RouteAssistantWatchlistStore.has(hub, "HUB")
                    wlBtn.textContent = has ? "★ Watchlisted" : "☆ Watchlist this hub"
                    wlBtn.style.background = has ? "#92400e" : "transparent"
                    wlBtn.style.color      = has ? "#fef3c7" : "#cbd5e1"
                    wlBtn.style.borderColor = has ? "#b45309" : "#374151"
                } catch (_) { /* keep static label */ }
            }
            wlBtn.addEventListener("click", async () => {
                try {
                    await RouteAssistantWatchlistStore.toggle(hub, "HUB")
                    await refreshState()
                } catch (e) { console.warn("[AES AFP] watchlist toggle threw", e) }
            })
            wrap.appendChild(wlBtn)
            refreshState()
        }

        slot.appendChild(wrap)
    }

    function toolButtonCss(enabled) {
        return "background:" + (enabled ? "#0f1623" : "#1f2937") + ";"
            + "color:" + (enabled ? "#cbd5e1" : "#6b7280") + ";"
            + "border:1px solid #374151;border-radius:4px;"
            + "padding:4px 10px;font-size:11px;font-weight:600;"
            + "cursor:" + (enabled ? "pointer" : "not-allowed") + ";"
    }

    function mkToolButton(label, title, enabled, onClick) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = label
        btn.title = title
        btn.disabled = !enabled
        btn.style.cssText = toolButtonCss(enabled)
        if (enabled) btn.addEventListener("click", onClick)
        return btn
    }

    let _observer = null
    let _remountTimer = null

    /**
     * Attach a MutationObserver to the page row. Wicket re-renders the
     * sidebar when the user submits the Settings or Schedule-transfer
     * form; the main column re-renders on tab switches and form submits.
     * Either teardown should trigger a re-mount of any missing scaffolds.
     */
    function attachObserver(rowEl) {
        if (_observer) {
            try { _observer.disconnect() } catch (_) { /* noop */ }
            _observer = null
        }
        if (!rowEl) return
        _observer = new MutationObserver(() => {
            if (_remountTimer) clearTimeout(_remountTimer)
            _remountTimer = setTimeout(() => {
                _remountTimer = null
                const haveSidebar = !!document.querySelector("[" + HOST_ATTR + "]")
                const haveWide    = !!document.querySelector("[" + WIDE_HOST_ATTR + "]")
                if (!haveSidebar || !haveWide) {
                    AesAfp.mount().catch(err => {
                        console.warn("[AES AFP] re-mount failed", err)
                    })
                }
            }, REMOUNT_DEBOUNCE_MS)
        })
        _observer.observe(rowEl, {childList: true, subtree: true})
    }

    /**
     * Find the wide-host insertion target. We anchor on the Visual Flight
     * Plan widget so the new panel sits between AS's Create-new-flight
     * form and the VFP — i.e., the user can read the schedule then build
     * candidates against it without scrolling. Returns the element to
     * insertBefore as the second item in a tuple [parent, anchor]; the
     * anchor may be null to mean "append to parent".
     */
    function findWideInsertionPoint() {
        const vfp = document.querySelector(".as-page-aircraft .col-md-10 .as-panel.visual-flight-plan")
        if (vfp && vfp.parentElement) return [vfp.parentElement, vfp]
        // VFP isn't always present (e.g., aircraft with no schedule yet).
        // Fall back to the end of the main column.
        const mainCol = document.querySelector(".as-page-aircraft .col-md-10")
        if (mainCol) return [mainCol, null]
        return [null, null]
    }

    /**
     * Idempotent mount. If a scaffold is already in the DOM, leave it.
     * Re-extract ctx (in case the page has been updated), re-emit
     * ctx:ready, and leave existing slot contents alone. Other slices'
     * rendered output survives a no-op mount call.
     */
    async function mount() {
        const sidebarCol = document.querySelector(".as-page-aircraft .col-md-2")
        if (!sidebarCol) {
            console.warn("[AES AFP] sidebar .col-md-2 not found; bailing")
            return
        }

        // Sidebar scaffold (header / spec / audit).
        let sidebarPanel = sidebarCol.querySelector("[" + HOST_ATTR + "]")
        if (!sidebarPanel) {
            const built = buildSidebarScaffold()
            sidebarCol.appendChild(built.fragment)
            sidebarPanel = built.panel
        }
        AesAfp.host = sidebarPanel

        // Wide scaffold (tools / candidates / driver / wave). Skip silently
        // when the main column hasn't been found — sidebar still works.
        let widePanel = document.querySelector("[" + WIDE_HOST_ATTR + "]")
        if (!widePanel) {
            const [parent, anchor] = findWideInsertionPoint()
            if (parent) {
                const built = buildWideScaffold()
                if (anchor) parent.insertBefore(built.fragment, anchor)
                else        parent.appendChild(built.fragment)
                widePanel = built.panel
            }
        }
        AesAfp.wideHost = widePanel || null

        AesAfp.ctx = extractPageContext()
        renderHeaderStrip(AesAfp.slot("header"), AesAfp.ctx)
        renderToolsStrip(AesAfp.slot("tools"),   AesAfp.ctx)

        // Watch the whole page row so a Wicket re-render of either column
        // triggers re-mount.
        const row = document.querySelector(".as-page-aircraft .row") || sidebarCol.parentElement
        attachObserver(row)
        persistLocation(AesAfp.ctx)
        AesAfp.bus.emit("ctx:ready", {ctx: AesAfp.ctx})
    }

    /** Resolve a slot name to its DOM node. Wide slots take precedence
     *  when both hosts exist, but in practice each slot name lives in
     *  exactly one host (no overlap between SIDEBAR_SLOT_NAMES and
     *  WIDE_SLOT_NAMES). */
    function resolveSlot(name) {
        if (WIDE_SLOT_NAMES.indexOf(name) !== -1 && AesAfp.wideHost) {
            return AesAfp.wideHost.querySelector("[data-aes-afp-slot='" + name + "']")
        }
        if (SIDEBAR_SLOT_NAMES.indexOf(name) !== -1 && AesAfp.host) {
            return AesAfp.host.querySelector("[data-aes-afp-slot='" + name + "']")
        }
        // Defensive fallback for unknown slot names — search both hosts.
        if (AesAfp.wideHost) {
            const w = AesAfp.wideHost.querySelector("[data-aes-afp-slot='" + name + "']")
            if (w) return w
        }
        if (AesAfp.host) {
            return AesAfp.host.querySelector("[data-aes-afp-slot='" + name + "']")
        }
        return null
    }

    const AesAfp = {
        version: VERSION,
        ctx: null,
        bus: createBus(),
        host: null,
        wideHost: null,
        slot: resolveSlot,
        getCurrentSchedule: readVisualFlightPlan,
        getNewFlightForm:   findNewFlightForm,
        getFormTabs:        findFormTabs,
        mount
    }

    window.AesAfp = AesAfp
})()
