"use strict"

/**
 * Mock-schedule studio — the GUI panel that lets the user select a set of
 * airports + a target flight count, get a recommended weekly schedule from
 * AesAfpMockScheduleBuilder, optionally edit per-leg departure times + day
 * masks, and apply the resulting legs sequentially through the existing
 * AesAfpSubmitBridge.submitLegInBackground sacred path.
 *
 * Mounting:
 *   - Lives in WIDE_SLOT_NAMES.mock-schedule (host.js line 50).
 *   - Mounts whenever AesAfp.bus emits "ctx:ready" with a usable spec + hub.
 *   - Tolerates being mounted multiple times (idempotent renders).
 *
 * Inputs:
 *   - Airport multi-select — populated from the AS destination dropdown
 *     intersected with FlightsFromStore for the active hub. Distance comes
 *     from FlightsFrom data, falling back to a haversine if the hub +
 *     destination both have lat/lng on hand. (Defensive: if neither exists
 *     for a given dest the row is dropped before recommend().)
 *   - Number-of-flights — integer 1..200.
 *   - Working window (hub-local hours) — defaults 06:00–22:00.
 *
 * The "Apply all" button is gated behind `dryRun` (default true). When the
 * user flips dryRun off the row glows red; clicking Apply still requires a
 * confirm prompt before the actual write loop fires.
 *
 * No new POST paths — every write goes through AesAfpSubmitBridge, which is
 * already wired through the gated background queue.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesAfpMockScheduleStudio) return

    const VERSION = "0.1.0"
    const MOUNT_ATTR  = "data-aes-mock-schedule-studio"
    const SLOT_NAME   = "mock-schedule"

    const COLOR_FG     = "#e5e7eb"
    const COLOR_DIM    = "#9ca3af"
    const COLOR_RULE   = "#374151"
    const COLOR_PANEL  = "#1f2937"
    const COLOR_HOT    = "#dc2626"
    const COLOR_OK     = "#10b981"

    const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    function _slot() {
        return (window.AesAfp && typeof AesAfp.slot === "function")
            ? AesAfp.slot(SLOT_NAME) : null
    }

    function _haversineKm(a, b) {
        if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null
        const R = 6371
        const toRad = (d) => d * Math.PI / 180
        const dLat = toRad(b.lat - a.lat)
        const dLng = toRad(b.lng - a.lng)
        const lat1 = toRad(a.lat), lat2 = toRad(b.lat)
        const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
        return 2 * R * Math.asin(Math.sqrt(h))
    }

    /**
     * Build the candidate list of airports the user can pick from. Source
     * order:
     *   1. AS destination dropdown options on the New Flight Number form
     *      (the gate that decides what's actually fillable).
     *   2. FlightsFromStore[hub] — gives us distance + per-route metadata.
     *   3. Fallback haversine when FlightsFrom has the iata but no
     *      distance, and the hub has lat/lng cached from spec-resolver.
     *
     * Output: [{iata, name, distanceKm, inAsDropdown, inFlightsFrom}],
     * sorted by distance ascending, deduped by iata.
     */
    async function _gatherCandidateAirports(ctx, hub) {
        const out = []
        const seen = new Set()
        const formTabs = window.AesAfp && AesAfp.getNewFlightForm && AesAfp.getNewFlightForm()
        const ds = formTabs && formTabs.destSelect
        const dropdown = new Map()
        if (ds) {
            for (const opt of ds.options) {
                const m = (opt.textContent || "").match(/\(([A-Z]{3})\)/)
                if (m) dropdown.set(m[1], {
                    iata: m[1],
                    label: (opt.textContent || "").trim(),
                    asValue: opt.value
                })
            }
        }
        let ff = null
        if (hub && window.FlightsFromStore && typeof FlightsFromStore.loadAirport === "function") {
            try { ff = await FlightsFromStore.loadAirport(hub) } catch (_) { ff = null }
        }
        const ffByIata = new Map()
        for (const r of (ff && ff.routes) || []) {
            const iata = String(r && (r.iata || r.destIata) || "").toUpperCase()
            if (!iata) continue
            ffByIata.set(iata, r)
        }
        // Take the union, but flag presence in each so the picker can show
        // the user *why* a destination is excluded (no permits / no FF data).
        const allIatas = new Set([...dropdown.keys(), ...ffByIata.keys()])
        for (const iata of allIatas) {
            if (seen.has(iata)) continue
            seen.add(iata)
            const dd  = dropdown.get(iata) || null
            const ffr = ffByIata.get(iata) || null
            const dist = ffr && (Number(ffr.distanceKm) || Number(ffr.distance)) || null
            out.push({
                iata,
                name:           (dd && dd.label) || (ffr && ffr.name) || iata,
                distanceKm:     isFinite(dist) ? dist : null,
                asValue:        dd ? dd.asValue : null,
                inAsDropdown:   !!dd,
                inFlightsFrom:  !!ffr,
                // Pickable when AS allows the route (has a permit). Distance
                // can be supplied manually via the per-row input when FF
                // hasn't been scraped — the recommend step skips rows whose
                // final distance is still null and warns the user.
                pickable:       !!dd
            })
        }
        out.sort((a, b) => {
            if (a.pickable !== b.pickable) return a.pickable ? -1 : 1
            return (a.distanceKm || Infinity) - (b.distanceKm || Infinity)
        })
        return out
    }

    function _btn(label, onClick, opts) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.className = "btn btn-default btn-xs"
        b.style.cssText = "padding:3px 10px;font-size:11px;"
        if (opts && opts.primary) b.style.background = COLOR_OK + "33"
        if (opts && opts.danger) b.style.background = COLOR_HOT + "33"
        b.addEventListener("click", (e) => { e.preventDefault(); onClick(e) })
        return b
    }

    function _append(el, child) {
        if (child == null) return
        if (Array.isArray(child)) {
            for (const c of child) _append(el, c)
            return
        }
        if (typeof Node !== "undefined" && child instanceof Node) {
            el.appendChild(child)
            return
        }
        el.appendChild(document.createTextNode(String(child)))
    }

    function _h(tag, attrs, ...children) {
        const el = document.createElement(tag)
        if (attrs) for (const k in attrs) {
            if (k === "style") el.style.cssText = attrs[k]
            else el.setAttribute(k, attrs[k])
        }
        for (const child of children) _append(el, child)
        return el
    }

    function _row(...children) {
        const r = _h("div", {style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;"})
        for (const c of children) if (c) r.appendChild(c)
        return r
    }

    /** Public entry — render or refresh the studio inside its slot. */
    async function render(ctx) {
        const slot = _slot()
        if (!slot) return
        const c = ctx || (window.AesAfp && AesAfp.ctx) || null
        if (!c || !c.aircraftId) {
            _renderEmpty(slot, "Mock Schedule Studio: no aircraft context")
            return
        }
        const hub = String(c.currentLocationIata || "").toUpperCase()
        if (!hub) {
            _renderEmpty(slot, "Mock Schedule Studio: hub not yet resolved")
            return
        }

        // Mounting guard — render the shell once.
        let host = slot.querySelector("[" + MOUNT_ATTR + "]")
        if (!host) {
            host = _h("div", {style: "background:" + COLOR_PANEL + ";color:" + COLOR_FG +
                                     ";padding:10px;border-radius:6px;border:1px solid " + COLOR_RULE + ";"})
            host.setAttribute(MOUNT_ATTR, "")
            slot.appendChild(host)
        }
        host.textContent = ""

        // Header
        const header = _row(
            _h("h4", {style: "margin:0;font-size:13px;letter-spacing:0.04em;"}, "MOCK SCHEDULE STUDIO"),
            _h("span", {style: "color:" + COLOR_DIM + ";font-size:11px;"},
                hub + " · " + (c.equipment || "?") + " · v" + VERSION)
        )
        host.appendChild(header)

        const status = _h("div", {style: "color:" + COLOR_DIM + ";font-size:11px;margin:6px 0;"}, "Loading airports…")
        host.appendChild(status)

        // Pre-existing draft
        const store = window.AesAfpMockScheduleStore
        let saved = null
        if (store && typeof store.load === "function") {
            try { saved = await store.load(c.server, c.aircraftId) } catch (_) {}
        }

        const candidates = await _gatherCandidateAirports(c, hub)
        if (!candidates.length) {
            status.textContent = "No candidate airports — open the AS New Flight Number tab so the destination dropdown loads."
            return
        }
        status.textContent = candidates.length + " airports available; "
            + candidates.filter(a => a.pickable).length + " usable for routing."

        // ── Inputs row ────────────────────────────────────────────────
        const flightsInput = _h("input", {
            type: "number", min: "1", max: "200",
            value: String(saved && saved.flightsTarget || 14),
            style: "width:60px;background:#111827;color:" + COLOR_FG + ";border:1px solid " + COLOR_RULE + ";padding:3px 6px;font-size:11px;"
        })
        const winStartInput = _h("input", {
            type: "number", min: "0", max: "23",
            value: String((saved && saved.opts && saved.opts.workingHoursLocal && saved.opts.workingHoursLocal.start) || 6),
            style: "width:48px;background:#111827;color:" + COLOR_FG + ";border:1px solid " + COLOR_RULE + ";padding:3px 6px;font-size:11px;"
        })
        const winEndInput = _h("input", {
            type: "number", min: "1", max: "24",
            value: String((saved && saved.opts && saved.opts.workingHoursLocal && saved.opts.workingHoursLocal.end) || 22),
            style: "width:48px;background:#111827;color:" + COLOR_FG + ";border:1px solid " + COLOR_RULE + ";padding:3px 6px;font-size:11px;"
        })
        const dryRunCb = _h("input", {type: "checkbox"})
        dryRunCb.checked = saved ? saved.dryRun !== false : true

        const inputsRow = _row(
            _h("label", {style: "font-size:11px;"}, "Flights/wk:"), flightsInput,
            _h("label", {style: "font-size:11px;margin-left:8px;"}, "Hub window:"),
            winStartInput, _h("span", null, "→"), winEndInput, _h("span", {style: "color:" + COLOR_DIM + ";font-size:10px;"}, "(local h)"),
            _h("label", {style: "font-size:11px;margin-left:8px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;"},
                dryRunCb, _h("span", null, "Dry run"))
        )
        inputsRow.style.margin = "8px 0"
        host.appendChild(inputsRow)

        // ── Airport picker ────────────────────────────────────────────
        const pickerWrap = _h("div", {
            style: "max-height:160px;overflow:auto;border:1px solid " + COLOR_RULE +
                   ";padding:6px;background:#111827;font-size:11px;display:grid;" +
                   "grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:2px 8px;"
        })
        const savedDistByIata = new Map(
            ((saved && saved.selectedAirports) || []).map(a => [a.iata, a.distanceKm]))
        const savedSel = new Set(((saved && saved.selectedAirports) || []).map(a => a.iata))
        const pickerInputs = new Map()
        for (const a of candidates) {
            const row = _h("div", {style: "display:flex;align-items:center;gap:6px;"})
            const cb = _h("input", {type: "checkbox"})
            cb.checked = savedSel.has(a.iata)
            cb.disabled = !a.pickable
            row.appendChild(cb)
            const tag = _h("span", {style: "min-width:36px;font-weight:600;color:"
                + (a.pickable ? COLOR_FG : COLOR_DIM) + ";"}, a.iata)
            row.appendChild(tag)
            const distInput = _h("input", {
                type: "number", min: "1", max: "20000", step: "10",
                value: a.distanceKm
                    ? String(Math.round(a.distanceKm))
                    : (savedDistByIata.has(a.iata) && savedDistByIata.get(a.iata) != null
                        ? String(Math.round(savedDistByIata.get(a.iata))) : ""),
                placeholder: "km",
                style: "width:60px;background:#111827;color:" + COLOR_FG +
                    ";border:1px solid " + COLOR_RULE + ";padding:1px 4px;font-size:10px;"
            })
            distInput.title = "Distance from hub in km — auto-filled from FlightsFrom; type a value when FF data isn't cached"
            row.appendChild(distInput)
            const tags = _h("span", {style: "color:" + COLOR_DIM + ";font-size:10px;"})
            const tagsParts = []
            if (!a.inAsDropdown)  tagsParts.push("<span style='color:" + COLOR_HOT + "'>no permit</span>")
            if (!a.inFlightsFrom) tagsParts.push("no FF")
            tags.innerHTML = tagsParts.join(" · ")
            row.appendChild(tags)
            pickerWrap.appendChild(row)
            pickerInputs.set(a.iata, {cb, distInput, info: a})
        }
        host.appendChild(pickerWrap)

        // ── Action row ────────────────────────────────────────────────
        const actionRow = _row()
        actionRow.style.margin = "8px 0"
        const recommendBtn = _btn("Recommend schedule", () => onRecommend(), {primary: true})
        const clearBtn = _btn("Clear", () => onClear())
        const saveBtn = _btn("Save draft", () => onSave())
        actionRow.appendChild(recommendBtn)
        actionRow.appendChild(clearBtn)
        actionRow.appendChild(saveBtn)
        host.appendChild(actionRow)

        // ── Recommendation output ─────────────────────────────────────
        const outputBox = _h("div", {style: "margin-top:6px;"})
        host.appendChild(outputBox)

        // Restore last recommendation if present
        let liveLegs = (saved && Array.isArray(saved.legs)) ? saved.legs.slice() : []
        let liveWarnings = (saved && Array.isArray(saved.warnings)) ? saved.warnings.slice() : []
        let liveTotals = (saved && saved.totals) || null
        if (liveLegs.length) renderOutput(outputBox, liveLegs, liveWarnings, liveTotals, () => onApplyAll())

        // ── Action handlers ───────────────────────────────────────────
        function readSelectedAirports() {
            const chosen = []
            for (const [iata, {cb, distInput, info}] of pickerInputs) {
                if (!cb.checked || !info.pickable) continue
                const typed = Number(distInput && distInput.value)
                const dist = isFinite(info.distanceKm) && info.distanceKm > 0
                    ? info.distanceKm
                    : (isFinite(typed) && typed > 0 ? typed : null)
                chosen.push({iata, distanceKm: dist, name: info.name})
            }
            return chosen
        }

        function readOpts() {
            return {
                workingHoursLocal: {
                    start: Math.max(0, Math.min(23, Number(winStartInput.value) || 6)),
                    end:   Math.max(1, Math.min(24, Number(winEndInput.value) || 22))
                }
            }
        }

        function spec() {
            const sr = window.AesAfpSpecResolver
            return (sr && sr.last) || (window.AesAfp && AesAfp.spec) || null
        }

        function onRecommend() {
            const B = window.AesAfpMockScheduleBuilder
            if (!B) { outputBox.textContent = "Mock builder not loaded."; return }
            const sel = readSelectedAirports()
            if (!sel.length) { outputBox.textContent = "Select at least one airport."; return }
            const flightsTarget = Math.max(1, Math.min(200, parseInt(flightsInput.value, 10) || 0))
            const sp = spec()
            if (!sp) { outputBox.textContent = "Aircraft spec not yet resolved."; return }
            const out = B.recommend({
                hub, spec: sp, destinations: sel, flightsTarget, opts: readOpts()
            })
            liveLegs = out.legs
            liveWarnings = out.warnings
            liveTotals = out.totals
            renderOutput(outputBox, out.legs, out.warnings, out.totals, () => onApplyAll())
        }

        function onClear() {
            liveLegs = []; liveWarnings = []; liveTotals = null
            outputBox.textContent = ""
            for (const {cb} of pickerInputs.values()) cb.checked = false
        }

        async function onSave() {
            if (!store) { alert("Store not loaded."); return }
            const sel = readSelectedAirports()
            const r = await store.save({
                server: c.server, aircraftId: c.aircraftId, hub,
                spec: spec(),
                selectedAirports: sel,
                flightsTarget: Math.max(1, parseInt(flightsInput.value, 10) || 0),
                opts: readOpts(),
                legs: liveLegs,
                warnings: liveWarnings,
                totals: liveTotals,
                dryRun: dryRunCb.checked
            })
            saveBtn.textContent = r.ok ? "Saved ✓" : "Save failed"
            setTimeout(() => { saveBtn.textContent = "Save draft" }, 1500)
        }

        async function onApplyAll() {
            if (!liveLegs.length) return
            const dryRun = !!dryRunCb.checked
            const proceed = dryRun
                ? confirm("DRY RUN: validate " + liveLegs.length + " legs without writing to AS?")
                : confirm("LIVE: this will create " + liveLegs.length + " flight numbers on AS via the submit bridge. Continue?")
            if (!proceed) return
            await applyAllLegs(c, liveLegs, dryRun, outputBox)
        }
    }

    function _renderEmpty(slot, msg) {
        slot.textContent = ""
        const el = _h("div", {style: "color:" + COLOR_DIM + ";font-size:11px;padding:6px;"}, msg)
        slot.appendChild(el)
    }

    function renderOutput(host, legs, warnings, totals, onApply) {
        host.textContent = ""
        const summary = _h("div", {style: "font-size:11px;margin-bottom:6px;"})
        if (totals) {
            const parts = []
            parts.push((totals.scheduledFlights || 0) + " flights")
            if (totals.byClassification) {
                if (totals.byClassification.SHORT)  parts.push("S " + totals.byClassification.SHORT)
                if (totals.byClassification.MEDIUM) parts.push("M " + totals.byClassification.MEDIUM)
                if (totals.byClassification.LONG)   parts.push("L " + totals.byClassification.LONG)
            }
            summary.textContent = parts.join(" · ")
        }
        host.appendChild(summary)

        if (warnings && warnings.length) {
            const w = _h("ul", {style: "font-size:10px;color:" + COLOR_DIM + ";margin:4px 0 6px 14px;padding:0;"})
            for (const t of warnings) w.appendChild(_h("li", null, t))
            host.appendChild(w)
        }

        if (!legs.length) return

        // Legs table — destination · classification · depTime · day mask · pricePct.
        const table = _h("table", {style: "width:100%;font-size:11px;border-collapse:collapse;"})
        const thead = _h("thead")
        const trh = _h("tr")
        for (const t of ["Dest", "Class", "Dep", "Days", "Dist (km)", "RT (h)"]) {
            trh.appendChild(_h("th", {style: "text-align:left;padding:2px 4px;border-bottom:1px solid " + COLOR_RULE + ";color:" + COLOR_DIM + ";"}, t))
        }
        thead.appendChild(trh); table.appendChild(thead)

        const tbody = _h("tbody")
        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i]
            const tr = _h("tr", {style: "border-bottom:1px solid " + COLOR_RULE + ";"})
            tr.appendChild(_h("td", {style: "padding:2px 4px;font-weight:600;"}, leg.destination))

            const clsCell = _h("td", {style: "padding:2px 4px;"})
            const cls = String(leg.classification || "?")
            clsCell.innerHTML = cls + (leg.irregularTime ? " <span style='color:" + COLOR_HOT +";font-size:9px'>irreg</span>" : "")
            tr.appendChild(clsCell)

            const depInput = _h("input", {
                type: "text", value: leg.depTime || "",
                style: "width:54px;background:#111827;color:" + COLOR_FG + ";border:1px solid " + COLOR_RULE +
                    ";padding:1px 4px;font-size:11px;font-family:monospace;"
            })
            depInput.addEventListener("change", () => {
                const v = depInput.value.trim()
                if (/^\d{1,2}:\d{2}$/.test(v)) leg.depTime = v
                else depInput.value = leg.depTime
            })
            const depCell = _h("td", {style: "padding:2px 4px;"})
            depCell.appendChild(depInput)
            tr.appendChild(depCell)

            const daysCell = _h("td", {style: "padding:2px 4px;display:flex;gap:2px;"})
            for (let d = 0; d < 7; d++) {
                const cb = _h("input", {type: "checkbox"})
                cb.checked = !!leg.dayMask[d]
                cb.title = DAY_LABELS[d]
                cb.style.cssText = "width:14px;height:14px;"
                cb.addEventListener("change", () => { leg.dayMask[d] = cb.checked })
                daysCell.appendChild(cb)
            }
            tr.appendChild(daysCell)

            tr.appendChild(_h("td", {style: "padding:2px 4px;text-align:right;color:" + COLOR_DIM + ";"},
                leg.distanceKm ? String(Math.round(leg.distanceKm)) : "—"))
            tr.appendChild(_h("td", {style: "padding:2px 4px;text-align:right;color:" + COLOR_DIM + ";"},
                leg.roundTripH ? leg.roundTripH.toFixed(1) : "—"))

            tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        host.appendChild(table)

        const applyRow = _row(
            _btn("Apply all (gated)", onApply, {primary: true}),
            _h("span", {style: "color:" + COLOR_DIM + ";font-size:10px;"},
                "uses AesAfpSubmitBridge — same gated path as Route Builder")
        )
        applyRow.style.marginTop = "8px"
        host.appendChild(applyRow)
    }

    /** Sequential per-leg apply through submit-bridge. Streams progress
     *  back to the output panel; aborts on the first hard failure. */
    async function applyAllLegs(ctx, legs, dryRun, host) {
        const bridge = window.AesAfpSubmitBridge
        if (!bridge || typeof bridge.submitLegInBackground !== "function") {
            host.appendChild(_h("div", {style: "color:" + COLOR_HOT + ";"},
                "AesAfpSubmitBridge not available — refresh the AFP tab."))
            return
        }

        const log = _h("ol", {style: "font-size:11px;margin:8px 0 0 16px;color:" + COLOR_FG + ";"})
        host.appendChild(log)
        const append = (status, leg, info) => {
            const li = _h("li")
            const colorMap = {ok: COLOR_OK, fail: COLOR_HOT, dry: COLOR_DIM}
            li.style.color = colorMap[status] || COLOR_FG
            li.textContent = leg.origin + "→" + leg.destination + " " + (leg.depTime || "")
                + " · " + status + (info ? " · " + info : "")
            log.appendChild(li)
        }

        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i]
            if (dryRun) { append("dry", leg, "no POST"); continue }
            const driver = window.AesAfpFormDriver
            let chosenFn = leg.flightNumberText || ""
            if (!chosenFn && driver && typeof driver.findNextAvailableFlightNumber === "function") {
                try { chosenFn = await driver.findNextAvailableFlightNumber({}) || "" } catch (_) {}
            }
            const payload = {
                server: ctx.server,
                aircraftId: ctx.aircraftId,
                hub: ctx.currentLocationIata,
                leg: {
                    origin: leg.origin,
                    destination: leg.destination,
                    depTime: leg.depTime,
                    dayMask: leg.dayMask,
                    pricePct: leg.pricePct,
                    service: leg.service,
                    flightNumberText: chosenFn
                },
                timeoutMs: 90000
            }
            try {
                const r = await bridge.submitLegInBackground(payload)
                if (r && r.ok) append("ok", leg, "fn " + (r.flightNumberText || chosenFn))
                else { append("fail", leg, (r && r.error) || "no response"); break }
            } catch (e) {
                append("fail", leg, (e && e.message) || String(e))
                break
            }
        }
    }

    function _wireBus() {
        if (!window.AesAfp || !AesAfp.bus) return
        let pending = false
        const tick = () => {
            if (pending) return
            pending = true
            setTimeout(() => { pending = false; render(AesAfp.ctx) }, 100)
        }
        AesAfp.bus.on("ctx:ready", tick)
        AesAfp.bus.on("spec:resolved", tick)
        AesAfp.bus.on("flightsfrom:ready", tick)
        // Initial mount in case ctx:ready already fired before this module
        // loaded — common when manifest order puts the host before us.
        tick()
    }

    window.AesAfpMockScheduleStudio = {
        render,
        VERSION,
        SLOT_NAME
    }
    _wireBus()
})()
