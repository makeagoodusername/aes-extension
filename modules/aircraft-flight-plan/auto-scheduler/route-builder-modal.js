"use strict"

/**
 * Standalone Route Builder modal — second entry point for the planner.
 *
 * The AFP page already has a fully-wired Route Builder workbench inside
 * preview-panel.js. That surface lives at the bottom of an aircraft's
 * /app/fleets/aircraft/<id>/0 page and isn't reachable from the
 * enterprise dashboard. This module is the standalone version: a modal
 * that opens from any AS surface (dashboard tile, slash command, console),
 * reuses the same engine + draft store + apply pipeline, and exposes the
 * same edit + apply contract as the in-page workbench.
 *
 * Public API (window.AesAfpRouteBuilderModal):
 *   open({server, airline, aircraftId?, hub?, defaultIatas?, defaultFlights?})
 *     → Promise<{applied, cancelled, plannerResult, payload}>
 *   close()
 *   _internal — pure helpers used by audit-jihwan tests:
 *     parseIataList(text)                → [iata, ...]
 *     materialiseLegs(build, draft)      → leg[]
 *     buildApplyPayload(state)           → {ctx, legs}
 *     defaultConfig(overrides)           → planner config object
 *
 * Reuses (no production-code edits required):
 *   AesAfpRouteBuilderPlanner.recommend  — engine
 *   AesAfpActiveDraftStore.setEdit       — per-leg HH:MM + dayMask edits
 *   AesAfpAutoApplyBatch.start           — fan-out to background submit queue
 *   AesFleetRoster.loadCurrent           — aircraft picker
 *   FlightsFromStore.loadAirport         — destination candidates per hub
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesAfpRouteBuilderModal) return

    const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    const DEFAULT_FLIGHTS  = 4
    const DEFAULT_TURN_MIN = 45
    const DEFAULT_DEPART   = "06:00"
    const ESTIMATED_SECONDS_PER_LEG = 18

    let _modalEl = null
    let _onKey   = null
    let _resolve = null
    let _state   = null

    // ─────────────────────────────────────────────────────────────────
    // Pure helpers — exposed via _internal for tests.
    // ─────────────────────────────────────────────────────────────────

    function _normaliseIata(value) {
        const s = String(value || "").trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : ""
    }

    function _parseIataList(value) {
        const seen = new Set()
        const out = []
        for (const part of String(value || "").split(/[\s,;]+/)) {
            const iata = _normaliseIata(part)
            if (!iata || seen.has(iata)) continue
            seen.add(iata)
            out.push(iata)
        }
        return out
    }

    function _singleDayMask(dayIdx) {
        const out = [0, 0, 0, 0, 0, 0, 0]
        out[((Number(dayIdx) || 0) % 7 + 7) % 7] = 1
        return out
    }

    function _dayFromMask(mask, fallback) {
        if (Array.isArray(mask)) {
            for (let i = 0; i < mask.length; i++) if (mask[i]) return i
        }
        return Number.isFinite(fallback) ? fallback : 0
    }

    function _legDayMask(eff) {
        if (Array.isArray(eff && eff.dayMask)) return eff.dayMask.slice()
        return [1, 0, 0, 0, 0, 0, 0]
    }

    function _defaultConfig(overrides) {
        const o = overrides || {}
        return Object.assign({
            includedIatas:        [],
            airportCount:         0,
            targetFlights:        DEFAULT_FLIGHTS,
            baseDeparture:        DEFAULT_DEPART,
            startDayIdx:          0,
            turnaroundMin:        DEFAULT_TURN_MIN,
            longGapMin:           120,
            shortGapMin:          45,
            staggerMin:           73,
            longHaulThresholdNm:  3500,
            latestLongHaulDeparture: "18:00",
            sequentialLongHaul:   true
        }, o)
    }

    /**
     * Mirror of preview-panel.js:_materialiseLegs (the production confirm
     * modal's payload builder). Overlays draft.perLegEdits on top of the
     * planner's flights so the user's edited HH:MM + dayMask reach
     * AesAfpAutoApplyBatch.start. Kept aligned with the production helper —
     * if that drifts (e.g. new fields), update both.
     */
    function _materialiseLegs(build, draft, settings) {
        const flights = (build && build.flights) || []
        const overlays = (draft && draft.perLegEdits) || {}
        const dpct = (settings && isFinite(Number(settings.defaultPricePct)))
            ? Number(settings.defaultPricePct) : 100
        const dsvc = (settings && typeof settings.defaultService === "string")
            ? settings.defaultService : ""
        const out = []
        for (const f of flights) {
            const o = overlays[f.seq] || {}
            const eff = Object.assign({}, f, o)
            out.push({
                seq:         f.seq,
                waveId:      f.waveId,
                waveLabel:   f.waveLabel,
                direction:   eff.direction || f.direction,
                origin:      eff.origin      || f.origin      || null,
                destination: eff.destination || f.destination || null,
                depTime:     eff.depTimeLocal || f.depTimeLocal || null,
                distanceNm:  f.distanceNm,
                pricePct:    isFinite(Number(eff.pricePct)) ? Number(eff.pricePct) : dpct,
                service:     (typeof eff.service === "string") ? eff.service : dsvc,
                dayMask:     _legDayMask(eff)
            })
        }
        return out
    }

    /**
     * Build the {ctx, legs} payload that AesAfpAutoApplyBatch.start consumes.
     * Pure — no I/O. The materialised legs reflect any per-leg edits the
     * user has made in the modal, with the planner's recommendation as the
     * fallback for fields the user hasn't touched.
     */
    function _buildApplyPayload(state) {
        const s = state || {}
        const build = s.plannerResult && s.plannerResult.build
        const draft = s.draft || null
        const legs = _materialiseLegs(build, draft, s.settings || null)
            .filter(l => l.origin && l.destination && l.depTime)
        return {
            ctx: {
                server:     s.server,
                aircraftId: s.aircraftId,
                currentLocationIata: s.hub
            },
            legs:    legs,
            preset:  build && build.preset || null,
            source:  "route-builder-modal"
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Modal lifecycle.
    // ─────────────────────────────────────────────────────────────────

    function _close(payload) {
        if (_onKey) {
            try { document.removeEventListener("keydown", _onKey) } catch (_) { /* noop */ }
            _onKey = null
        }
        if (_modalEl && _modalEl.parentNode) {
            try { _modalEl.parentNode.removeChild(_modalEl) } catch (_) { /* noop */ }
        }
        _modalEl = null
        const r = _resolve
        _resolve = null
        _state = null
        if (r) r(payload || {applied: false, cancelled: true})
    }

    async function _open(opts) {
        const o = opts || {}
        _close({applied: false, cancelled: true})
        if (typeof document === "undefined" || !document.body) {
            return {applied: false, cancelled: true, error: "no document.body"}
        }

        _state = {
            server:        String(o.server || _resolveServer() || ""),
            airline:       String(o.airline || _resolveAirline() || ""),
            aircraftId:    o.aircraftId ? String(o.aircraftId) : null,
            registration:  o.registration || null,
            hub:           _normaliseIata(o.hub) || null,
            spec:          o.spec || null,
            settings:      o.settings || null,
            config:        _defaultConfig({
                includedIatas: Array.isArray(o.defaultIatas) ? o.defaultIatas.map(_normaliseIata).filter(Boolean) : [],
                targetFlights: Number(o.defaultFlights) || DEFAULT_FLIGHTS
            }),
            candidates:    [],
            plannerResult: null,
            draft:         null,
            running:       false,
            error:         null
        }

        const overlay = _buildShell()
        document.body.appendChild(overlay)
        _modalEl = overlay

        _onKey = (e) => { if (e.key === "Escape") _close({applied: false, cancelled: true}) }
        document.addEventListener("keydown", _onKey)

        await _hydrateAircraft()
        await _hydrateCandidates()
        await _hydrateDraft()
        _renderBody()

        return new Promise(resolve => { _resolve = resolve })
    }

    function _resolveServer() {
        try { return window.AES && window.AES.getServerName && window.AES.getServerName() }
        catch (_) { return null }
    }

    function _resolveAirline() {
        try {
            const code = window.AES && window.AES.getAirlineCode && window.AES.getAirlineCode()
            return (code && code.code) || (code && typeof code === "string" ? code : "")
        } catch (_) { return null }
    }

    async function _hydrateAircraft() {
        if (_state.aircraftId && _state.hub) return
        if (typeof window.AesFleetRoster === "undefined") return
        let fleet
        try { fleet = await window.AesFleetRoster.loadCurrent() }
        catch (_) { fleet = null }
        if (!fleet || !Array.isArray(fleet.aircraft) || !fleet.aircraft.length) return
        if (!_state.aircraftId) {
            const first = fleet.aircraft[0]
            _state.aircraftId  = String(first.aircraftId)
            _state.registration = first.registration || null
            if (!_state.hub) _state.hub = _normaliseIata(first.location) || null
        } else {
            const match = fleet.aircraft.find(a => String(a.aircraftId) === String(_state.aircraftId))
            if (match) {
                _state.registration = _state.registration || match.registration || null
                if (!_state.hub) _state.hub = _normaliseIata(match.location) || null
            }
        }
        _state._fleet = fleet
    }

    async function _hydrateCandidates() {
        _state.candidates = []
        if (!_state.hub) return
        if (typeof window.FlightsFromStore !== "undefined") {
            try {
                const rec = await window.FlightsFromStore.loadAirport(_state.hub)
                if (rec && Array.isArray(rec.routes)) {
                    _state.candidates = rec.routes.map(r => Object.assign({}, r, {
                        destIata: _normaliseIata(r.destIata || r.iata)
                    })).filter(r => r.destIata && r.destIata !== _state.hub)
                }
            } catch (_) { /* fall through */ }
        }
    }

    async function _hydrateDraft() {
        _state.draft = null
        if (typeof window.AesAfpActiveDraftStore === "undefined") return
        if (!_state.server || !_state.aircraftId) return
        try {
            _state.draft = await window.AesAfpActiveDraftStore.load(_state.server, _state.aircraftId)
        } catch (_) { _state.draft = null }
    }

    // ─────────────────────────────────────────────────────────────────
    // Rendering.
    // ─────────────────────────────────────────────────────────────────

    function _buildShell() {
        const overlay = document.createElement("div")
        overlay.setAttribute("data-aes-route-builder-modal", "1")
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.78);"
            + "z-index:99999;display:flex;align-items:flex-start;justify-content:center;"
            + "padding:32px 16px;overflow-y:auto;"
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) _close({applied: false, cancelled: true})
        })

        const modal = document.createElement("div")
        modal.style.cssText = "background:#0f1623;color:#e5e7eb;"
            + "border:1px solid #1f2937;border-radius:5px;"
            + "max-width:min(820px,96vw);width:100%;"
            + "display:flex;flex-direction:column;overflow:hidden;"
            + "font-size:12px;font-family:'Inter',system-ui,sans-serif;"
        overlay.appendChild(modal)

        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;gap:8px;"
            + "padding:12px 16px;border-bottom:1px solid #1f2937;background:#111827;"
        const title = document.createElement("div")
        title.style.cssText = "font-weight:700;font-size:14px;color:#f3f4f6;flex:1;"
        title.textContent = "Route builder — pick airports → mock schedule → apply"
        header.appendChild(title)
        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "×"
        close.style.cssText = "background:transparent;color:#9ca3af;border:0;"
            + "font-size:20px;line-height:1;cursor:pointer;padding:0 6px;"
        close.title = "Close (Esc)"
        close.addEventListener("click", () => _close({applied: false, cancelled: true}))
        header.appendChild(close)
        modal.appendChild(header)

        const body = document.createElement("div")
        body.setAttribute("data-aes-rb-body", "1")
        body.style.cssText = "padding:14px 16px;display:flex;flex-direction:column;gap:12px;"
        modal.appendChild(body)

        return overlay
    }

    function _renderBody() {
        if (!_modalEl) return
        const body = _modalEl.querySelector("[data-aes-rb-body]")
        if (!body) return
        body.textContent = ""

        body.appendChild(_renderContextBar())
        body.appendChild(_renderConfigBar())
        body.appendChild(_renderAirportPicker())
        body.appendChild(_renderActions())
        if (_state.error) {
            const err = document.createElement("div")
            err.style.cssText = "color:#fca5a5;font-size:12px;"
            err.textContent = _state.error
            body.appendChild(err)
        }
        if (_state.plannerResult && _state.plannerResult.rows && _state.plannerResult.rows.length) {
            body.appendChild(_renderMockSchedule(_state.plannerResult))
            body.appendChild(_renderApplyBar(_state.plannerResult))
        }
    }

    function _renderContextBar() {
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;"
            + "padding:8px 10px;background:#0b1220;border:1px solid #1f2937;border-radius:3px;"

        const acLbl = document.createElement("span")
        acLbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;"
        acLbl.textContent = "Aircraft"
        bar.appendChild(acLbl)

        const fleet = _state._fleet && Array.isArray(_state._fleet.aircraft) ? _state._fleet.aircraft : []
        if (fleet.length) {
            const sel = document.createElement("select")
            sel.style.cssText = _inputCss()
            for (const a of fleet) {
                const opt = document.createElement("option")
                opt.value = String(a.aircraftId)
                opt.textContent = (a.registration || "#" + a.aircraftId)
                    + (a.location ? " @ " + a.location : "")
                    + (a.equipment ? " · " + a.equipment : "")
                if (String(a.aircraftId) === String(_state.aircraftId)) opt.selected = true
                sel.appendChild(opt)
            }
            sel.addEventListener("change", async () => {
                const next = fleet.find(a => String(a.aircraftId) === sel.value)
                if (!next) return
                _state.aircraftId  = String(next.aircraftId)
                _state.registration = next.registration || null
                _state.hub          = _normaliseIata(next.location) || null
                _state.plannerResult = null
                await _hydrateCandidates()
                await _hydrateDraft()
                _renderBody()
            })
            bar.appendChild(sel)
        } else {
            const fallback = document.createElement("input")
            fallback.type = "text"
            fallback.placeholder = "aircraftId"
            fallback.value = _state.aircraftId || ""
            fallback.style.cssText = _inputCss()
            fallback.addEventListener("change", () => { _state.aircraftId = fallback.value.trim() })
            bar.appendChild(fallback)
        }

        const hubLbl = document.createElement("span")
        hubLbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;margin-left:8px;"
        hubLbl.textContent = "Hub"
        bar.appendChild(hubLbl)
        const hub = document.createElement("input")
        hub.type = "text"
        hub.maxLength = 3
        hub.value = _state.hub || ""
        hub.placeholder = "JFK"
        hub.style.cssText = _inputCss() + "width:60px;text-transform:uppercase;"
        hub.addEventListener("change", async () => {
            const v = _normaliseIata(hub.value)
            if (!v) return
            _state.hub = v
            _state.plannerResult = null
            await _hydrateCandidates()
            _renderBody()
        })
        bar.appendChild(hub)

        const ctxInfo = document.createElement("span")
        ctxInfo.style.cssText = "color:#6b7280;font-size:10px;margin-left:auto;"
        ctxInfo.textContent = "server: " + (_state.server || "?") + " · airline: " + (_state.airline || "?")
        bar.appendChild(ctxInfo)
        return bar
    }

    function _renderConfigBar() {
        const bar = document.createElement("div")
        bar.style.cssText = "display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;"
        bar.appendChild(_numberField("Flights", _state.config.targetFlights, 2, 56, 1, v =>
            { _state.config.targetFlights = v; _renderBody() }))
        bar.appendChild(_numberField("Airport count (auto)", _state.config.airportCount, 0, 30, 1, v =>
            { _state.config.airportCount = v; _renderBody() }))
        bar.appendChild(_timeField("Base depart", _state.config.baseDeparture, v =>
            { _state.config.baseDeparture = v; _renderBody() }))
        bar.appendChild(_dayField("First day", _state.config.startDayIdx, v =>
            { _state.config.startDayIdx = v; _renderBody() }))
        bar.appendChild(_numberField("Turnaround (min)", _state.config.turnaroundMin, 20, 360, 5, v =>
            { _state.config.turnaroundMin = v; _renderBody() }))
        return bar
    }

    function _renderAirportPicker() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"

        const lbl = document.createElement("div")
        lbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;"
        lbl.textContent = "Included airports — click chips or type IATA codes"
        wrap.appendChild(lbl)

        const manual = document.createElement("input")
        manual.type = "text"
        manual.value = _state.config.includedIatas.join(", ")
        manual.placeholder = "Blank = use top scored candidates; or enter JFK, CDG, BOS"
        manual.style.cssText = _inputCss()
        manual.addEventListener("change", () => {
            _state.config.includedIatas = _parseIataList(manual.value)
            _renderBody()
        })
        wrap.appendChild(manual)

        const chips = document.createElement("div")
        chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
        const selected = new Set(_state.config.includedIatas)
        const candidates = _state.candidates.slice()
            .sort((a, b) => (Number(b.weeklyFlights) || 0) - (Number(a.weeklyFlights) || 0))
            .slice(0, 30)
        if (!candidates.length) {
            const empty = document.createElement("span")
            empty.style.cssText = "color:#6b7280;font-style:italic;font-size:11px;"
            empty.textContent = _state.hub
                ? "No FlightsFrom data cached for " + _state.hub
                    + ". Type IATAs above or run a FlightsFrom scrape first."
                : "Pick a hub first."
            chips.appendChild(empty)
        }
        for (const c of candidates) {
            const iata = _normaliseIata(c.destIata)
            if (!iata) continue
            const on = selected.has(iata)
            const chip = document.createElement("button")
            chip.type = "button"
            chip.textContent = iata + (c.weeklyFlights ? " · " + c.weeklyFlights : "")
            chip.title = (c.destName || iata) + (c.distanceKm ? " · " + Math.round(c.distanceKm) + "km" : "")
            chip.style.cssText = "background:" + (on ? "#1d4ed8" : "#111827") + ";"
                + "color:" + (on ? "#f8fafc" : "#cbd5e1") + ";"
                + "border:1px solid " + (on ? "#2563eb" : "#374151") + ";"
                + "border-radius:3px;padding:4px 8px;font-size:11px;cursor:pointer;"
                + "font-variant-numeric:tabular-nums;"
            chip.addEventListener("click", () => {
                const next = new Set(_state.config.includedIatas)
                if (next.has(iata)) next.delete(iata); else next.add(iata)
                _state.config.includedIatas = Array.from(next)
                _renderBody()
            })
            chips.appendChild(chip)
        }
        wrap.appendChild(chips)
        return wrap
    }

    function _renderActions() {
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;gap:8px;align-items:center;"

        const seqWrap = document.createElement("label")
        seqWrap.style.cssText = "display:flex;align-items:center;gap:6px;color:#9ca3af;font-size:11px;cursor:pointer;"
        const seq = document.createElement("input")
        seq.type = "checkbox"
        seq.checked = _state.config.sequentialLongHaul !== false
        seq.style.cssText = "margin:0;"
        seq.addEventListener("change", () => { _state.config.sequentialLongHaul = seq.checked })
        seqWrap.appendChild(seq)
        const seqLbl = document.createElement("span")
        seqLbl.textContent = "Sequential long-haul placement"
        seqWrap.appendChild(seqLbl)
        bar.appendChild(seqWrap)

        const spacer = document.createElement("div")
        spacer.style.cssText = "flex:1;"
        bar.appendChild(spacer)

        const recBtn = document.createElement("button")
        recBtn.type = "button"
        recBtn.textContent = _state.running ? "Recommending…" : "Recommend schedule"
        recBtn.disabled = _state.running || !_state.hub
        recBtn.style.cssText = _btnCss(!recBtn.disabled, "#1d4ed8", "#1e3a8a")
        recBtn.addEventListener("click", () => { if (!recBtn.disabled) _runPlanner() })
        bar.appendChild(recBtn)
        return bar
    }

    function _renderMockSchedule(result) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border-top:1px solid #1f2937;padding-top:10px;"
        const hdr = document.createElement("div")
        hdr.style.cssText = "display:flex;gap:8px;align-items:baseline;margin-bottom:6px;"
        const t = document.createElement("div")
        t.style.cssText = "font-weight:700;color:#f3f4f6;flex:1;"
        const flightCt = (result.build && result.build.flights) ? result.build.flights.length : 0
        t.textContent = "Mock schedule (" + flightCt + " flights · "
            + result.rows.length + " round-trip" + (result.rows.length === 1 ? "" : "s") + ")"
        hdr.appendChild(t)
        const dests = (result.build.metadata.selectedAirports || []).join(", ")
        const subtitle = document.createElement("div")
        subtitle.style.cssText = "color:#9ca3af;font-size:10px;"
        subtitle.textContent = dests
        hdr.appendChild(subtitle)
        wrap.appendChild(hdr)

        const tbl = document.createElement("div")
        tbl.style.cssText = "border:1px solid #1f2937;border-radius:3px;overflow:hidden;"
        for (const row of result.rows) {
            tbl.appendChild(_renderScheduleRow(row))
        }
        wrap.appendChild(tbl)

        const hint = document.createElement("div")
        hint.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;"
        hint.textContent = "Edit any HH:MM or day to override the planner. Edits persist into the apply payload."
        wrap.appendChild(hint)
        return wrap
    }

    function _renderScheduleRow(row) {
        const out = _effectiveFlight(row.outSeq)
        const inn = _effectiveFlight(row.inSeq)
        const el = document.createElement("div")
        el.style.cssText = "display:grid;grid-template-columns:64px minmax(110px,1fr) 92px 76px 92px 76px 60px;"
            + "gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid #0f172a;"
            + "font-size:11px;color:#cbd5e1;"

        const tag = document.createElement("div")
        tag.style.cssText = "color:" + (row.sequential ? "#fbbf24" : "#6b7280") + ";font-size:10px;"
        tag.textContent = row.sequential ? "[seq]" : ""
        tag.title = row.reason || ""
        el.appendChild(tag)

        const route = document.createElement("div")
        route.style.cssText = "font-weight:600;color:#f8fafc;min-width:0;overflow:hidden;text-overflow:ellipsis;"
        route.textContent = (out && out.origin || _state.hub || "?") + " → " + row.destination
        route.title = "round-trip · " + row.flightMin + "min one-way · " + Math.round(row.distanceNm || 0) + "nm"
        el.appendChild(route)

        el.appendChild(_legDayInput("Out day", _dayFromMask(out && out.dayMask, row.outDayIdx), v =>
            _setLegEdit(row.outSeq, {dayMask: _singleDayMask(v)})))
        el.appendChild(_legTimeInput("Out dep", (out && out.depTimeLocal) || row.outDepTime, v =>
            _setLegEdit(row.outSeq, {depTimeLocal: v})))
        el.appendChild(_legDayInput("In day", _dayFromMask(inn && inn.dayMask, row.inDayIdx), v =>
            _setLegEdit(row.inSeq, {dayMask: _singleDayMask(v)})))
        el.appendChild(_legTimeInput("In dep", (inn && inn.depTimeLocal) || row.inDepTime, v =>
            _setLegEdit(row.inSeq, {depTimeLocal: v})))

        const bucket = document.createElement("div")
        bucket.style.cssText = "color:#9ca3af;text-align:right;font-size:10px;"
        bucket.textContent = row.rangeBucket === "longHaul" ? "long"
            : row.rangeBucket === "mediumHaul" ? "med"
            : row.rangeBucket === "shortHaul" ? "short" : "—"
        el.appendChild(bucket)

        return el
    }

    function _renderApplyBar(result) {
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;gap:8px;align-items:center;padding-top:6px;border-top:1px solid #1f2937;"

        const ctxInfo = document.createElement("div")
        ctxInfo.style.cssText = "color:#6b7280;font-size:10px;flex:1;"
        const flights = result.build && result.build.flights || []
        ctxInfo.textContent = "Apply will POST " + flights.length + " new flight numbers to AS · ~"
            + Math.round(flights.length * ESTIMATED_SECONDS_PER_LEG / 60) + " min total"
        bar.appendChild(ctxInfo)

        const cancel = document.createElement("button")
        cancel.type = "button"
        cancel.textContent = "Close"
        cancel.style.cssText = _btnCss(true, "#1f2937", "#374151")
        cancel.addEventListener("click", () => _close({applied: false, cancelled: true}))
        bar.appendChild(cancel)

        const apply = document.createElement("button")
        apply.type = "button"
        apply.textContent = "Apply schedule"
        apply.title = "Hand off to AesAfpAutoApplyBatch.start (background submit queue)."
        apply.disabled = !_canApply(result)
        apply.style.cssText = _btnCss(!apply.disabled, "#b91c1c", "#7f1d1d")
        apply.addEventListener("click", () => { if (!apply.disabled) _runApply() })
        bar.appendChild(apply)

        return bar
    }

    function _canApply(result) {
        if (!result || !result.build || !Array.isArray(result.build.flights)) return false
        if (!result.build.flights.length) return false
        if (typeof window.AesAfpAutoApplyBatch === "undefined") return false
        if (!_state.aircraftId || !_state.server) return false
        return true
    }

    // ─────────────────────────────────────────────────────────────────
    // Behaviour: planner run + per-leg edit + apply.
    // ─────────────────────────────────────────────────────────────────

    async function _runPlanner() {
        if (typeof window.AesAfpRouteBuilderPlanner === "undefined") {
            _state.error = "Route builder planner module not loaded."
            _renderBody()
            return
        }
        if (!_state.hub) {
            _state.error = "Pick a hub IATA first."
            _renderBody()
            return
        }
        _state.running = true
        _state.error = null
        _renderBody()
        try {
            // Synthetic candidate fallback when the user typed an IATA that's
            // not in cached FlightsFrom data — the planner needs at minimum a
            // destIata + distanceKm. 1500km is a safe medium-haul placeholder
            // so the route still scores; the user can refine later.
            const have = new Set(_state.candidates.map(c => c.destIata))
            const synth = []
            for (const iata of _state.config.includedIatas) {
                if (!iata || have.has(iata)) continue
                synth.push({destIata: iata, paxScore: 5, cargoScore: 3,
                    weeklyFlights: 7, distanceKm: 1500, scoreBlend: 50,
                    _synthetic: true})
            }
            const allCandidates = _state.candidates.concat(synth)

            const result = window.AesAfpRouteBuilderPlanner.recommend({
                hubIata:    _state.hub,
                candidates: allCandidates,
                spec:       _state.spec || {},
                config:     _state.config
            })
            _state.plannerResult = result
            if (result.build && Array.isArray(result.build.validation) && result.build.validation.length) {
                _state.error = result.build.validation.join(" · ")
            }
            // Persist build into draft store so per-leg edits attach to a
            // canonical seq set. setFlights clears any old edits — that's
            // intentional, the planner produces fresh seq numbers.
            if (typeof window.AesAfpActiveDraftStore !== "undefined"
                    && _state.server && _state.aircraftId
                    && result.build && result.build.flights && result.build.flights.length) {
                _state.draft = await window.AesAfpActiveDraftStore.setFlights(
                    _state.server, _state.aircraftId, {
                        hub:      _state.hub,
                        presetId: result.build.preset && result.build.preset.id,
                        flights:  result.build.flights,
                        metadata: result.build.metadata
                    }
                ) || _state.draft
            }
        } catch (e) {
            _state.error = "Recommend failed: " + ((e && e.message) || String(e))
            console.warn("[AES route-builder-modal] recommend threw", e)
        } finally {
            _state.running = false
            _renderBody()
        }
    }

    async function _setLegEdit(seq, patch) {
        if (typeof window.AesAfpActiveDraftStore === "undefined") return
        if (!_state.server || !_state.aircraftId || seq == null) return
        try {
            const next = await window.AesAfpActiveDraftStore.setEdit(
                _state.server, _state.aircraftId, seq, patch
            )
            _state.draft = next || _state.draft
            _renderBody()
        } catch (e) {
            console.warn("[AES route-builder-modal] setEdit failed", e)
        }
    }

    async function _runApply() {
        if (!_state.plannerResult) return
        const payload = _buildApplyPayload(_state)
        if (!payload.legs.length) {
            _state.error = "No legs to apply (planner produced none)."
            _renderBody()
            return
        }
        if (typeof window.AesAfpAutoApplyBatch === "undefined"
                || typeof window.AesAfpAutoApplyBatch.start !== "function") {
            _state.error = "AesAfpAutoApplyBatch not loaded — cannot dispatch."
            _renderBody()
            return
        }
        _state.running = true
        _renderBody()
        try {
            const startResult = await window.AesAfpAutoApplyBatch.start({
                ctx:    payload.ctx,
                legs:   payload.legs,
                source: payload.source
            })
            _close({
                applied:        true,
                cancelled:      false,
                plannerResult:  _state.plannerResult,
                payload:        payload,
                startResult:    startResult || null
            })
        } catch (e) {
            _state.error = "Apply failed: " + ((e && e.message) || String(e))
            console.warn("[AES route-builder-modal] apply threw", e)
            _state.running = false
            _renderBody()
        }
    }

    function _effectiveFlight(seq) {
        const build = _state.plannerResult && _state.plannerResult.build
        const base = build && Array.isArray(build.flights)
            ? build.flights.find(f => f && f.seq === seq) : null
        if (!base) return null
        const overlay = (_state.draft && _state.draft.perLegEdits
            && _state.draft.perLegEdits[seq]) || null
        return overlay ? Object.assign({}, base, overlay) : base
    }

    // ─────────────────────────────────────────────────────────────────
    // Style helpers — DOM verbosity confined here.
    // ─────────────────────────────────────────────────────────────────

    function _inputCss() {
        return "background:#111827;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:4px 6px;font-size:11px;"
            + "font-variant-numeric:tabular-nums;width:100%;box-sizing:border-box;"
    }

    function _btnCss(enabled, bg, border) {
        return "background:" + (enabled ? bg : "#374151") + ";"
            + "color:" + (enabled ? "#f8fafc" : "#9ca3af") + ";"
            + "border:1px solid " + (enabled ? border : "#374151") + ";"
            + "border-radius:3px;padding:5px 14px;font-size:11px;font-weight:600;"
            + "cursor:" + (enabled ? "pointer" : "not-allowed") + ";"
    }

    function _fieldWrap(label) {
        const w = document.createElement("label")
        w.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0;"
        const lbl = document.createElement("span")
        lbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;"
        lbl.textContent = label
        w.appendChild(lbl)
        return w
    }

    function _numberField(label, value, min, max, step, onChange) {
        const w = _fieldWrap(label)
        const inp = document.createElement("input")
        inp.type = "number"
        inp.min = String(min); inp.max = String(max); inp.step = String(step || 1)
        inp.value = String(value == null ? min : value)
        inp.style.cssText = _inputCss()
        inp.addEventListener("change", () => {
            const n = Number(inp.value)
            if (!isFinite(n)) return
            onChange(Math.max(min, Math.min(max, Math.round(n))))
        })
        w.appendChild(inp)
        return w
    }

    function _timeField(label, value, onChange) {
        const w = _fieldWrap(label)
        const inp = document.createElement("input")
        inp.type = "time"
        inp.value = /^\d{2}:\d{2}$/.test(String(value || "")) ? value : "09:00"
        inp.style.cssText = _inputCss()
        inp.addEventListener("change", () => {
            if (/^\d{2}:\d{2}$/.test(inp.value)) onChange(inp.value)
        })
        w.appendChild(inp)
        return w
    }

    function _dayField(label, value, onChange) {
        const w = _fieldWrap(label)
        const sel = document.createElement("select")
        sel.style.cssText = _inputCss()
        DAY_NAMES.forEach((n, i) => {
            const o = document.createElement("option")
            o.value = String(i); o.textContent = n
            if (i === Number(value)) o.selected = true
            sel.appendChild(o)
        })
        sel.addEventListener("change", () => onChange(Number(sel.value)))
        w.appendChild(sel)
        return w
    }

    function _legDayInput(label, value, onChange) {
        const w = _fieldWrap(label)
        const sel = document.createElement("select")
        sel.style.cssText = _inputCss() + "padding:2px 4px;font-size:10px;"
        DAY_NAMES.forEach((n, i) => {
            const o = document.createElement("option")
            o.value = String(i); o.textContent = n
            if (i === Number(value)) o.selected = true
            sel.appendChild(o)
        })
        sel.addEventListener("change", () => onChange(Number(sel.value)))
        w.appendChild(sel)
        return w
    }

    function _legTimeInput(label, value, onChange) {
        const w = _fieldWrap(label)
        const inp = document.createElement("input")
        inp.type = "time"
        inp.value = /^\d{2}:\d{2}$/.test(String(value || "")) ? value : "00:00"
        inp.style.cssText = _inputCss() + "padding:2px 4px;font-size:10px;"
        inp.addEventListener("change", () => {
            if (/^\d{2}:\d{2}$/.test(inp.value)) onChange(inp.value)
        })
        w.appendChild(inp)
        return w
    }

    // ─────────────────────────────────────────────────────────────────
    // Public API.
    // ─────────────────────────────────────────────────────────────────

    window.AesAfpRouteBuilderModal = {
        open:  _open,
        close: () => _close({applied: false, cancelled: true}),
        // Pure helpers — exposed so audit-jihwan tests can exercise
        // the controller logic without a DOM.
        _internal: {
            parseIataList:    _parseIataList,
            normaliseIata:    _normaliseIata,
            materialiseLegs:  _materialiseLegs,
            buildApplyPayload: _buildApplyPayload,
            defaultConfig:    _defaultConfig,
            singleDayMask:    _singleDayMask,
            dayFromMask:      _dayFromMask
        }
    }
})()
