"use strict"

/**
 * Flight Studio — compose panel (Slice S1).
 *
 * Mounts at `AesAfp.slot("studio")` and renders a compose UI for one
 * FlightSpec. S1 ships **dry-run only**: the user types a leg, clicks
 * Preview, sees the would-be POST body. NO live form interaction, NO
 * programmatic Submit.
 *
 * SAFETY INVARIANT (mirrors form-driver.js:10-24):
 *   The panel never calls submitBtn.click(), form.submit(), or any
 *   chrome.runtime message that triggers a submit. Preview reads option
 *   values via AesAfpFormDriver.dryRun(); that path does not POST.
 *
 * Public API (window.AesAfpFlightStudio):
 *   attach()         — idempotent; wires bus listeners + initial render
 *   render()         — replace-render into AesAfp.slot("studio")
 *   open()           — scrolls panel into view, focuses first input,
 *                      emits studio:opened {trigger}
 *   getSpec()        — returns the current in-memory FlightSpec
 *
 * Bus contract (additions to EVENTS.md §1):
 *   in:  ctx:ready                         → re-render on remount
 *   out: studio:opened       {trigger}
 *   out: studio:draft-changed {spec}        (debounced 300ms)
 *   out: studio:dry-run-rendered {spec, dryRun}
 *
 * Slices S2+ extend this same module with multi-leg compose, paste-import,
 * pre-fill mode, and submit mode. Keep the public API stable.
 */
;(function () {
    if (window.AesAfpFlightStudio) return

    const SLOT_NAME       = "studio"
    const SAVE_DEBOUNCE_MS = 300
    const TRIGGER_INIT     = "menu"

    let _spec      = null         // current FlightSpec
    let _attached  = false
    let _saveTimer = null
    let _renderInFlight = false   // re-entrancy guard
    let _lastDryRun = null        // most recent dryRun result, for diagnostics
    let _lastDryRunOutcome = null // {validationErrors?, dryRun?, info?, error?}
                                  // — full Preview outcome remembered so the
                                  // dry-run pane always reflects the last attempt
    let _autoSuggested = false    // one-shot guard so we only auto-pick a
                                  // flight number once per panel mount
    let _automateInFlight = false // true while auto-build is computing
    let _applyInFlight    = false // true while apply-batch is running
    let _applyTotal       = 0     // legs count for the currently applying batch
    let _busListenersAttached = false
    let _lastBuild        = null  // most recent Build object from the auto-scheduler
    // Decision sidebar (F1) — dedupe key + in-flight cancel + debounce timer.
    // Sidebar reacts to FROM/TO changes only; PRICE/SERVICE/FLIGHT# edits
    // don't refetch since the profit estimator doesn't consume those fields.
    let _lastSidebarKey       = null
    let _sidebarCtrl          = null   // AbortController-shaped flag (uses .aborted)
    let _sidebarRenderTimer   = null
    let _turnMin          = 30    // minutes between this leg's arrival and the
                                  // next leg's departure for Continue → /
                                  // ← Continue back. Default 30 = AS minimum
                                  // turn; user-editable inline. Module-scoped
                                  // so it persists across button presses but
                                  // not across page mounts.

    // ── ctx helpers ──────────────────────────────────────────────────────
    function _ctx()    { return (window.AesAfp && window.AesAfp.ctx) || null }
    function _bus()    { return (window.AesAfp && window.AesAfp.bus) || null }
    function _emit(name, payload) {
        const bus = _bus()
        if (bus && typeof bus.emit === "function") {
            try { bus.emit(name, payload) } catch (_) { /* bus self-isolates */ }
        }
    }
    function _slot() {
        try {
            return (window.AesAfp && typeof window.AesAfp.slot === "function")
                ? window.AesAfp.slot(SLOT_NAME) : null
        } catch (_) { return null }
    }

    // ── Spec lifecycle ───────────────────────────────────────────────────

    /** Resolve initial spec: load draft from store, else seed from ctx. */
    async function _resolveInitialSpec() {
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            return _seedSpec(ctx)
        }
        if (window.AesAfpStudioDraftStore) {
            try {
                const rec = await window.AesAfpStudioDraftStore.load(ctx.server, ctx.aircraftId)
                if (rec && rec.spec) return window.AesAfpLegSpec.normalizeSpec(rec.spec)
            } catch (e) {
                console.warn("[AES studio] draft load threw", e)
            }
        }
        return _seedSpec(ctx)
    }

    function _seedSpec(ctx) {
        return window.AesAfpLegSpec.createSpec({
            server:      ctx ? ctx.server     : "",
            aircraftId:  ctx ? ctx.aircraftId : "",
            origin:      ctx ? ctx.currentLocationIata : null,
            source:      "manual",
            dryRun:      true
        })
    }

    /** Save current spec to draft store, debounced. Emits draft-changed. */
    function _scheduleSave() {
        if (_saveTimer) clearTimeout(_saveTimer)
        _saveTimer = setTimeout(_flushSave, SAVE_DEBOUNCE_MS)
    }

    async function _flushSave() {
        _saveTimer = null
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) return
        if (!_spec) return
        try {
            if (window.AesAfpStudioDraftStore) {
                await window.AesAfpStudioDraftStore.save(ctx.server, ctx.aircraftId, _spec)
            }
        } catch (e) {
            console.warn("[AES studio] draft save threw", e)
        }
        _emit("studio:draft-changed", {spec: _spec})
    }

    function _updateSpec(nextSpec) {
        _spec = nextSpec
        _scheduleSave()
    }

    // ── Render ───────────────────────────────────────────────────────────

    /**
     * Idempotent render into AesAfp.slot("studio"). Replaces slot contents
     * — the panel owns the slot. Safe to call repeatedly (e.g. on every
     * ctx:ready re-emit).
     */
    async function render() {
        if (_renderInFlight) return
        _renderInFlight = true
        try {
            const host = _slot()
            if (!host) return
            if (!_spec) _spec = await _resolveInitialSpec()
            host.innerHTML = ""
            host.appendChild(_buildShell())
            _renderBody()
            // First-mount auto-suggest: when the user hasn't pinned a number
            // (spec.flightNumberText is null/empty) we ask AS for the next
            // available so the field reflects what AS would assign on
            // submit. Guarded by _autoSuggested so re-renders driven by
            // ctx:ready don't keep re-clicking the AS anchor.
            if (!_autoSuggested && (!_spec.flightNumberText)) {
                _autoSuggested = true
                _populateNextAvailable({silent: true}).catch(() => {})
            }
        } finally {
            _renderInFlight = false
        }
    }

    function _buildShell() {
        const root = document.createElement("div")
        root.className = "aes-afp-studio"
        root.setAttribute("data-aes-studio-root", "1")
        root.style.cssText = [
            "border-top:1px solid #1f2937",
            "padding:10px 0 8px;margin-top:8px;",
            "color:#cbd5e1;font-size:11px;line-height:1.4;"
        ].join("")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;"
        const title = document.createElement("strong")
        title.textContent = "Flight Studio"
        title.style.cssText = "font-size:12px;color:#e2e8f0;letter-spacing:0.4px;"
        const sub = document.createElement("span")
        sub.textContent = "compose · dry-run"
        sub.style.cssText = "color:#9ca3af;font-size:10px;"
        const flex = document.createElement("span")
        flex.style.cssText = "flex:1 1 auto;"
        const modeBadge = document.createElement("span")
        modeBadge.dataset.aesStudioMode = "1"
        modeBadge.textContent = "DRY-RUN"
        modeBadge.style.cssText = "font-family:var(--aes-font-mono,monospace);font-size:10px;letter-spacing:0.5px;"
            + "color:#fde68a;background:#1f2937;padding:2px 6px;border-radius:3px;"
        head.append(title, sub, flex, modeBadge)
        root.appendChild(head)

        // Flex wrapper holds the form body and the F1 decision sidebar
        // side-by-side at ≥900 px panel width and stacks them vertically
        // below 900 px (the sidebar's 240 px min-width forces the wrap).
        const flexWrap = document.createElement("div")
        flexWrap.dataset.aesStudioFlex = "1"
        flexWrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;"

        // Body container — _renderBody fills it.
        const body = document.createElement("div")
        body.dataset.aesStudioBody = "1"
        body.style.cssText = "flex:1 1 600px;min-width:0;"
        flexWrap.appendChild(body)
        flexWrap.appendChild(_buildDecisionSidebar())
        root.appendChild(flexWrap)

        return root
    }

    function _renderBody() {
        const host = _slot()
        if (!host) return
        const body = host.querySelector("[data-aes-studio-body]")
        if (!body) return
        body.innerHTML = ""

        body.appendChild(_buildHint())
        body.appendChild(_buildLegRow(_spec.legs[0], 0))
        body.appendChild(_buildSpecMeta())
        body.appendChild(_buildActions())
        if (_spec.source === "auto-build" && _spec.legs.length > 1) {
            body.appendChild(_buildAutoBuildSummary())
        }
        body.appendChild(_buildAutomateActions())
        body.appendChild(_buildScheduleDiagnostics())
        body.appendChild(_buildDryRunPane())
        _updateModeBadge()
        // Repaint the F1 decision sidebar against the latest spec. Cheap
        // when the OD pair hasn't changed (deduped via _lastSidebarKey).
        _renderSidebarFor(_spec).catch(() => { /* sidebar self-isolates */ })
    }

    // ── F1 — Decision-support sidebar ────────────────────────────────────
    //
    // Surfaces, for the current FROM→TO leg: route distance, pax/cargo
    // demand bars (RouteAssistantDemandStore — no hourly source exists),
    // top-3 current operators (FlightsFromStore.routes[].airlines), and a
    // static profit estimate (RouteAssistantProfitEstimator with the
    // standard economics block — NOT PRICE-reactive). Each section fails
    // soft so a missing demand record doesn't blank the operators row.
    //
    // Reactivity: subscribes to studio:draft-changed (debounced 200 ms)
    // and dedupes on FROM:TO so PRICE/SERVICE/FLIGHT# edits don't refetch.

    function _buildDecisionSidebar() {
        const sidebar = document.createElement("div")
        sidebar.dataset.aesStudioSidebar = "1"
        sidebar.style.cssText = "flex:0 1 280px;min-width:240px;"
            + "border:1px solid #1f2937;border-radius:4px;padding:8px 10px;"
            + "background:#0a0e16;font-size:11px;line-height:1.5;"
        _renderSidebarPlaceholder(sidebar, "Pick a destination to see decision context.")
        return sidebar
    }

    function _sidebarHost() {
        const host = _slot()
        return host ? host.querySelector("[data-aes-studio-sidebar]") : null
    }

    function _renderSidebarPlaceholder(host, message) {
        if (!host) return
        host.innerHTML = ""
        const head = document.createElement("div")
        head.style.cssText = "color:#e2e8f0;font-weight:600;letter-spacing:0.4px;margin-bottom:4px;"
        head.textContent = "Decision context"
        const p = document.createElement("div")
        p.style.cssText = "color:#9ca3af;font-size:10px;"
        p.textContent = message
        host.append(head, p)
    }

    async function _renderSidebarFor(spec) {
        const host = _sidebarHost()
        if (!host) return
        if (!spec || !Array.isArray(spec.legs) || !spec.legs.length) {
            _renderSidebarPlaceholder(host, "Pick a destination to see decision context.")
            _lastSidebarKey = null
            return
        }
        const leg = spec.legs[0]
        const from = String((leg && leg.origin) || "").toUpperCase()
        const to   = String((leg && leg.destination) || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
            _renderSidebarPlaceholder(host, "Fill FROM + TO to see decision context.")
            _lastSidebarKey = null
            return
        }
        const key = from + ":" + to
        if (key === _lastSidebarKey) return
        _lastSidebarKey = key
        if (_sidebarCtrl) _sidebarCtrl.aborted = true
        const myCtrl = _sidebarCtrl = {aborted: false}

        const [demand, ffData, settings] = await Promise.all([
            (typeof RouteAssistantDemandStore !== "undefined")
                ? RouteAssistantDemandStore.get(to).catch(() => null)
                : Promise.resolve(null),
            (typeof FlightsFromStore !== "undefined")
                ? FlightsFromStore.loadAirport(from).catch(() => null)
                : Promise.resolve(null),
            (typeof RouteAssistantSettings !== "undefined")
                ? RouteAssistantSettings.load().catch(() => null)
                : Promise.resolve(null)
        ])
        if (myCtrl.aborted) return

        const routeRec = (ffData && Array.isArray(ffData.routes))
            ? ffData.routes.find(r => String(r && r.destIata || "").toUpperCase() === to)
            : null
        const acSpec    = (window.AesAfpSpecResolver && window.AesAfpSpecResolver.last) || null
        const economics = (settings && settings.economics) || null

        let estimate = null
        if (typeof RouteAssistantProfitEstimator !== "undefined"
                && routeRec && Number(routeRec.distanceKm) > 0
                && acSpec && economics) {
            try {
                estimate = RouteAssistantProfitEstimator.estimate({
                    distanceKm: Number(routeRec.distanceKm),
                    spec:       acSpec,
                    paxScore:   demand ? demand.paxScore   : null,
                    cargoScore: demand ? demand.cargoScore : null,
                    economics:  economics,
                    falloffPct: settings.falloffPct
                })
            } catch (e) {
                console.warn("[AES studio] profit estimate threw", e)
            }
        }
        if (myCtrl.aborted) return
        _paintSidebar(host, {from, to, demand, routeRec, estimate, hasSpec: !!acSpec})
    }

    function _paintSidebar(host, data) {
        host.innerHTML = ""
        const {from, to, demand, routeRec, estimate, hasSpec} = data

        const header = document.createElement("div")
        header.style.cssText = "color:#e2e8f0;font-weight:600;letter-spacing:0.4px;margin-bottom:6px;"
        const distKm = routeRec && Number(routeRec.distanceKm) > 0
            ? Math.round(routeRec.distanceKm) : null
        const blockH = (estimate && estimate.blockHours != null) ? estimate.blockHours : null
        header.textContent = from + " → " + to
            + " · " + (distKm != null ? distKm + " km" : "— km")
            + (blockH != null ? " · " + blockH + " h block" : "")
        host.appendChild(header)

        host.appendChild(_buildSidebarSection("Demand", _buildDemandRows(demand)))
        host.appendChild(_buildSidebarSection("Operators", _buildOperatorRows(routeRec)))
        host.appendChild(_buildSidebarSection("Profit estimate",
            _buildProfitRows(estimate, hasSpec)))
    }

    function _buildSidebarSection(label, contentEl) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-bottom:8px;"
        const lbl = document.createElement("div")
        lbl.textContent = label
        lbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;"
            + "letter-spacing:0.5px;margin-bottom:3px;"
        wrap.append(lbl, contentEl)
        return wrap
    }

    function _buildDemandRows(demand) {
        if (!demand) return _sidebarNote("No demand data — run the route-assistant demand scan.")
        const wrap = document.createElement("div")
        wrap.appendChild(_makeScoreBar("Pax",   demand.paxScore,   "#60a5fa"))
        wrap.appendChild(_makeScoreBar("Cargo", demand.cargoScore, "#fbbf24"))
        if (demand.scrapedAt && Date.now() - demand.scrapedAt > 7 * 86400000) {
            const stale = document.createElement("div")
            stale.textContent = "⚠ stale (>7 days)"
            stale.style.cssText = "color:#fde68a;font-size:9px;margin-top:2px;"
            wrap.appendChild(stale)
        }
        return wrap
    }

    function _buildOperatorRows(routeRec) {
        if (!routeRec) return _sidebarNote("Hub data missing — run ↻ Update / Scan flightsfrom.com.")
        if (!Array.isArray(routeRec.airlines) || !routeRec.airlines.length) {
            return _sidebarNote("Carrier list not yet scanned for this route.")
        }
        const wrap = document.createElement("div")
        const sorted = routeRec.airlines.slice()
            .sort((a, b) => (Number(b && b.frequency) || 0) - (Number(a && a.frequency) || 0))
        for (const a of sorted.slice(0, 3)) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;justify-content:space-between;color:#cbd5e1;font-size:11px;"
            const name = document.createElement("span")
            name.textContent = a.code || a.name || "—"
            const freq = document.createElement("span")
            freq.style.color = "#9ca3af"
            freq.textContent = (Number(a.frequency) || 0) + "×/wk"
            row.append(name, freq)
            wrap.appendChild(row)
        }
        return wrap
    }

    function _buildProfitRows(estimate, hasSpec) {
        if (!hasSpec) return _sidebarNote("Resolving aircraft spec…")
        if (!estimate || !estimate.specOk) return _sidebarNote("Profit estimate unavailable.")
        if (estimate.fit === "oor") return _sidebarNote("Out of range for this aircraft.")
        if (estimate.profitPerFlight == null) {
            return _sidebarNote(estimate.isCargoOnly
                ? "Cargo-only spec — profit math out of scope (block " + (estimate.blockHours || "—") + " h)."
                : "Profit estimate unavailable.")
        }
        const wrap = document.createElement("div")
        const fmt = new Intl.NumberFormat("en-US",
            {style: "currency", currency: "USD", maximumFractionDigits: 0})
        const row = document.createElement("div")
        row.style.color = "#cbd5e1"
        row.textContent = fmt.format(estimate.profitPerFlight) + " /flight · "
            + fmt.format(estimate.profitPerWeek) + " /week"
        wrap.appendChild(row)
        const fitBadge = document.createElement("div")
        fitBadge.style.cssText = "color:" + (estimate.fit === "falloff" ? "#fde68a" : "#9ca3af")
            + ";font-size:9px;margin-top:2px;"
        fitBadge.textContent = "fit: " + estimate.fit
        wrap.appendChild(fitBadge)
        return wrap
    }

    function _sidebarNote(text) {
        const note = document.createElement("div")
        note.style.cssText = "color:#94a3b8;font-size:10px;"
        note.textContent = text
        return note
    }

    function _makeScoreBar(label, score, color) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:2px;"
        const lbl = document.createElement("span")
        lbl.textContent = label
        lbl.style.cssText = "color:#9ca3af;width:36px;flex:0 0 36px;"
        const bar = document.createElement("span")
        bar.style.cssText = "flex:1 1 auto;display:inline-flex;gap:1px;"
        const filled = (score == null) ? 0 : Math.max(0, Math.min(10, Math.round(Number(score) || 0)))
        for (let i = 0; i < 10; i++) {
            const cell = document.createElement("span")
            cell.style.cssText = "flex:1 1 0;height:8px;border-radius:1px;"
                + "background:" + (i < filled ? color : "#1f2937") + ";"
            bar.appendChild(cell)
        }
        const num = document.createElement("span")
        num.textContent = (score == null) ? "—" : (filled + "/10")
        num.style.cssText = "color:#cbd5e1;width:30px;flex:0 0 30px;text-align:right;"
            + "font-family:var(--aes-font-mono,monospace);"
        wrap.append(lbl, bar, num)
        return wrap
    }

    // ── Schedule Diagnostics — Time-window rebalance ─────────────────────

    const DAY_NAMES_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    /**
     * Scan the AS planning matrix for active days where the "Time window"
     * row is ✗ (round-trip + ground time exceeds the daily slot). Render
     * a banner offering to disable just those days — never alters routes.
     *
     * Returns an empty fragment when the matrix is healthy (or absent),
     * keeping Studio's body clean on well-configured aircraft.
     */
    function _buildScheduleDiagnostics() {
        const wrap = document.createElement("div")
        wrap.dataset.aesStudioDiag = "1"

        if (typeof window.AesAfpPlanningMatrixReader === "undefined") return wrap
        let matrix
        try { matrix = window.AesAfpPlanningMatrixReader.read() }
        catch (e) { return wrap }
        if (!matrix || !matrix.isPresent || !Array.isArray(matrix.segments)) return wrap

        // Collect failing days. A day fails if it's currently active
        // (matrix.daysActive[d] === true) and ANY segment reports
        // timeWindowOk === false for that day. Per-day dedupe via Set.
        const failingDays = new Set()
        for (const seg of matrix.segments) {
            if (!seg || !Array.isArray(seg.cells)) continue
            for (const cell of seg.cells) {
                if (!cell) continue
                if (!cell.enabled) continue
                if (cell.timeWindowOk === false) failingDays.add(cell.dayIdx)
            }
        }
        if (!failingDays.size) return wrap

        const days = [...failingDays].sort((a, b) => a - b)
        const dayLabels = days.map(d => DAY_NAMES_SHORT[d] || ("D" + d))

        const banner = document.createElement("div")
        banner.style.cssText = "margin:6px 0;padding:6px 8px;border-radius:3px;"
            + "background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.45);"
            + "display:flex;align-items:center;gap:8px;flex-wrap:wrap;"

        const icon = document.createElement("span")
        icon.textContent = "⚠"
        icon.style.cssText = "color:#fbbf24;font-size:13px;"
        banner.appendChild(icon)

        const text = document.createElement("span")
        text.style.cssText = "color:#fde68a;font-size:11px;flex:1;line-height:1.4;"
        text.textContent = "Time window fails on " + dayLabels.join(", ")
            + " — round-trip won't fit the slot."
        banner.appendChild(text)

        const btn = _mkBtn("Disable failing days", "primary", async () => {
            const fd = window.AesAfpFormDriver
            if (!fd || typeof fd.setDayActive !== "function") {
                _renderHint("error", "Form driver not loaded — cannot toggle day selection.")
                return
            }
            btn.disabled = true
            const toggled = []
            for (const d of days) {
                if (fd.setDayActive(d, false)) toggled.push(d)
            }
            if (window.AesAfpAuditLog && typeof window.AesAfpAuditLog.add === "function") {
                try {
                    await window.AesAfpAuditLog.add({
                        action: "time-window-disable-days",
                        days: toggled,
                        dayNames: toggled.map(d => DAY_NAMES_SHORT[d] || ("D" + d))
                    })
                } catch (_) { /* non-fatal */ }
            }
            _renderHint("info", "Disabled " + toggled.map(d => DAY_NAMES_SHORT[d]).join(", ")
                + " — review and click 'Apply schedule settings' on AS to commit.")
            // AS dispatches its own change handler on the checkboxes; the
            // matrix repaints async, so re-render after a short tick to
            // refresh (or remove) this banner from the user's view.
            setTimeout(() => _renderBody(), 250)
        })
        btn.style.fontSize = "10px"
        banner.appendChild(btn)

        wrap.appendChild(banner)
        return wrap
    }

    /**
     * MutationObserver on the AS planning-matrix tbody — when AS re-renders
     * a row (e.g. user changed a departure offset and Wicket re-validated
     * the time window), re-paint Studio's body so the banner reflects the
     * latest state. One observer per Studio mount; debounced 200ms so a
     * burst of Wicket updates triggers a single render.
     */
    let _matrixObserver = null
    let _matrixObserverTimer = null
    function _attachMatrixObserver() {
        if (_matrixObserver) return
        const tbody = document.querySelector("form table.flight-planning-matrix tbody")
        if (!tbody) return
        _matrixObserver = new MutationObserver(() => {
            if (_matrixObserverTimer) return
            _matrixObserverTimer = setTimeout(() => {
                _matrixObserverTimer = null
                _renderBody()
            }, 200)
        })
        _matrixObserver.observe(tbody, {childList: true, subtree: true, characterData: true})
    }

    function _buildHint() {
        const ctx = _ctx()
        const hint = document.createElement("div")
        hint.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            hint.textContent = "Aircraft context not yet resolved — open this from an aircraft Flight Plan page."
            hint.style.color = "#fca5a5"
        } else {
            const hub = ctx.currentLocationIata || "??"
            hint.textContent = "Hub: " + hub + " · " + ctx.registration + " · " + ctx.equipment
        }
        return hint
    }

    function _buildLegRow(leg, idx) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;"

        row.appendChild(_mkLabel("From"))
        row.appendChild(_mkIataInput(leg.origin, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "origin", v))
            if (idx === 0) _pushToAsForm("origin", v)
        }))
        row.appendChild(_mkArrow())
        row.appendChild(_mkLabel("To"))
        row.appendChild(_mkIataInput(leg.destination, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "destination", v))
            if (idx === 0) _pushToAsForm("destination", v)
        }))
        row.appendChild(_mkLabel("Dep"))
        row.appendChild(_mkTimeInput(leg.depTimeLocal, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "depTimeLocal", v))
            if (idx === 0) _pushToAsForm("depTime", v)
        }))
        row.appendChild(_mkLabel("Price"))
        row.appendChild(_mkPctInput(leg.pricePct, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "pricePct", v))
            if (idx === 0) _pushToAsForm("pricePct", v)
        }))
        row.appendChild(_mkLabel("Service"))
        row.appendChild(_mkServiceInput(leg.service, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "service", v))
            if (idx === 0) _pushToAsForm("service", v)
        }))
        return row
    }

    /** Forward one Flight Studio field straight to the AS "New Flight
     *  Number" form so the user sees their edits land above immediately —
     *  no need to click Preview to make Flight Studio non-redundant. The
     *  setters return false silently when the AS form isn't on the page
     *  (Existing tab active, mid-render, etc); we don't toast on that
     *  because typing while the form is gone is already user-visible.
     *
     *  IATA fields require a 3-char code (`AAA`) before AS's select can
     *  match an option, so we gate on length. Time fields require `HH:MM`. */
    function _pushToAsForm(field, raw) {
        const fd = window.AesAfpFormDriver
        if (!fd) return
        try {
            switch (field) {
                case "origin":
                case "destination": {
                    const v = String(raw || "").toUpperCase()
                    if (!/^[A-Z]{3}$/.test(v)) return
                    if (field === "origin")      fd.setOrigin(v)
                    else                         fd.setDestination(v)
                    return
                }
                case "depTime": {
                    const v = String(raw || "")
                    if (!/^\d{1,2}:\d{2}$/.test(v)) return
                    fd.setDepartureTime(v)
                    return
                }
                case "pricePct": {
                    const n = parseInt(raw, 10)
                    if (!isFinite(n)) return
                    fd.setPricePercent(n)
                    return
                }
                case "service": {
                    fd.setService(raw == null ? "" : String(raw))
                    return
                }
                case "flightNumberText": {
                    if (typeof fd.setFlightNumber === "function") fd.setFlightNumber(raw == null ? "" : String(raw))
                    return
                }
            }
        } catch (e) { console.warn("[AES studio] _pushToAsForm threw", e) }
    }

    /** Push every Flight Studio field for leg #0 + the spec's flight
     *  number into the AS form in one go. Used after Reset / Undo / auto-
     *  suggest so the AS form mirrors Flight Studio's full state without
     *  the user having to re-type each field. */
    function _pushAllToAsForm() {
        if (!_spec || !_spec.legs || !_spec.legs.length) return
        const leg = _spec.legs[0]
        _pushToAsForm("origin",           leg.origin)
        _pushToAsForm("destination",      leg.destination)
        _pushToAsForm("depTime",          leg.depTimeLocal)
        _pushToAsForm("pricePct",         leg.pricePct)
        _pushToAsForm("service",          leg.service)
        _pushToAsForm("flightNumberText", _spec.flightNumberText || "")
    }

    function _buildSpecMeta() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;"
        row.appendChild(_mkLabel("Flight#"))
        const fnInput = _mkTextInput(_spec.flightNumberText || "", 4, "60px", (v) => {
            // Strip non-digits + clamp to AS's 4-char input.
            const cleaned = String(v || "").replace(/[^0-9]/g, "").slice(0, 4)
            _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText", cleaned))
            _pushToAsForm("flightNumberText", cleaned)
        })
        fnInput.dataset.aesStudioFn = "1"
        fnInput.placeholder = "auto"
        row.appendChild(fnInput)
        // "Next" button — clicks AS's "find first available" anchor and
        // mirrors the result back into the spec. AS already implements the
        // global per-airline next-available lookup, so we delegate rather
        // than duplicate it client-side.
        const nextBtn = _mkBtn("Next", "default", _populateNextAvailable)
        nextBtn.title = "Ask AS for the next available flight number"
        nextBtn.style.padding = "2px 8px"
        nextBtn.style.fontSize = "10px"
        row.appendChild(nextBtn)
        const note = document.createElement("span")
        note.textContent = "(blank = AS auto-assigns on submit)"
        note.style.cssText = "color:#6b7280;font-size:10px;"
        row.appendChild(note)
        return row
    }

    /** Click AS's "find first available" anchor, read the populated value
     *  back, and stamp it into the spec. Falls back to a client-side scan
     *  of the visible Flight Plan if the anchor isn't reachable (e.g. user
     *  is on the Existing Flight Number tab and tab-flip is racing).
     *
     *  `opts.silent` skips the AS-tab-flip path so the auto-suggest on
     *  first mount can't yank the user off the Existing tab unexpectedly.
     *  The button click leaves opts undefined → full path. */
    async function _populateNextAvailable(opts) {
        const silent = !!(opts && opts.silent)
        let next = null
        // Only ask AS when the form is already on the page (silent path)
        // OR when the user explicitly clicked Next (full path, may flip tab).
        const formAlreadyVisible = !!(window.AesAfp
            && typeof window.AesAfp.getNewFlightForm === "function"
            && window.AesAfp.getNewFlightForm())
        if ((!silent || formAlreadyVisible)
            && window.AesAfpFormDriver
            && typeof window.AesAfpFormDriver.findNextAvailableFlightNumber === "function") {
            try { next = await window.AesAfpFormDriver.findNextAvailableFlightNumber() }
            catch (e) { console.warn("[AES studio] findNextAvailable threw", e) }
        }
        if (!next) next = _scanScheduleNextAvailable()
        if (!next) {
            if (!silent) _renderHint("warn", "Couldn't find next available flight number — switch to AS's 'New Flight Number' tab and try again.")
            return
        }
        _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText", next))
        _pushToAsForm("flightNumberText", next)
        _renderBody()
        if (!silent) _renderHint("info", "Suggested next flight number: " + next)
    }

    /** Read existing flight codes off the AFP page's Visual Flight Plan and
     *  return the smallest unused positive integer (as a string). This is a
     *  per-aircraft view — the AS server-side lookup is authoritative for
     *  the whole airline — but it's a sane fallback when the AS anchor
     *  isn't on the page. Returns null if we can't enumerate. */
    function _scanScheduleNextAvailable() {
        const vfp = (window.AesAfp && typeof window.AesAfp.readSchedule === "function")
            ? window.AesAfp.readSchedule()
            : null
        const legs = (vfp && vfp.legs) || (vfp && Array.isArray(vfp) ? vfp : [])
        const used = new Set()
        for (const leg of legs || []) {
            const code = leg && (leg.flightCode || leg.flightNumber)
            if (!code) continue
            // flightCode shape: "PAA 1", "PAA 47", or "47" (some airlines).
            const m = String(code).match(/(\d+)\s*$/)
            if (m) used.add(parseInt(m[1], 10))
        }
        if (!used.size) return "1"
        for (let n = 1; n < 10000; n++) if (!used.has(n)) return String(n)
        return null
    }

    // ── Automation pipeline ──────────────────────────────────────────────
    //
    // Three buttons, one shared bus listener:
    //   "🎯 Automate"  → _runAutomate  → auto-build + apply (one click)
    //   "Auto-Build"   → _runAutoBuild → optimiser only, populates spec
    //   "Apply"        → _runApply     → reuses preview-panel's confirm
    //                                    modal, then apply-batch
    //
    // The submit click is gated by background.js + form-driver.js — the
    // panel never calls submitBtn.click() directly. We only express the
    // user's intent through `aes:afp:apply-batch`, which preview-panel's
    // shared modal confirms first (mandatory ack + duration estimate +
    // locked-leg detection).

    /** Update the panel's mode badge (DRY-RUN / AUTO-BUILD / BUILDING /
     *  APPLYING) without re-building the shell. Cheap — query + style. */
    function _updateModeBadge() {
        const host = _slot()
        if (!host) return
        const badge = host.querySelector("[data-aes-studio-mode]")
        if (!badge) return
        let label, color, bg
        if (_applyInFlight)         { label = "APPLYING";   color = "#bfdbfe"; bg = "#1e3a8a" }
        else if (_automateInFlight) { label = "BUILDING";   color = "#fde68a"; bg = "#92400e" }
        else if (_spec && _spec.source === "auto-build")
                                    { label = "AUTO-BUILD"; color = "#bbf7d0"; bg = "#065f46" }
        else                        { label = "DRY-RUN";    color = "#fde68a"; bg = "#1f2937" }
        badge.textContent = label
        badge.style.color = color
        badge.style.background = bg
    }

    /** Defensive snapshot of the user's AFP settings — used to pull
     *  default service / pricePct when an auto-built leg is missing them.
     *  AesAfpSettings.load() returns the merged AFP block directly (not
     *  wrapped under `aircraftFlightPlan`); pass it through verbatim.
     *  Returns `{}` when the settings module isn't loaded. */
    async function _settingsSnapshot() {
        if (!window.AesAfpSettings || typeof window.AesAfpSettings.load !== "function") return {}
        try { return (await window.AesAfpSettings.load()) || {} }
        catch (_) { return {} }
    }

    /** Convert _spec into the shape preview-panel's modal renders
     *  (origin/dest/depTime/pricePct/service/direction). Direction is
     *  inferred from hub vs origin so Flight Studio's modal has the same
     *  inbound/outbound colour cues as auto-build's. flightNumberText is
     *  attached to leg #0 only — AS won't honour duplicates on subsequent
     *  POSTs in a multi-leg batch. */
    function _legsForApply() {
        if (!_spec || !_spec.legs || !_spec.legs.length) return []
        const ctx = _ctx()
        const hub = (ctx && ctx.currentLocationIata || "").toUpperCase()
        const fn  = (_spec.flightNumberText || "").trim()
        return _spec.legs.map((leg, i) => {
            const out = {
                seq:         leg.seq != null ? leg.seq : (i + 1),
                origin:      leg.origin,
                destination: leg.destination,
                depTime:     leg.depTimeLocal,
                pricePct:    leg.pricePct,
                service:     typeof leg.service === "string" ? leg.service : "",
                direction:   (leg.origin && hub && leg.origin === hub) ? "outbound" : "inbound"
            }
            if (i === 0 && fn) out.flightNumberText = fn
            return out
        })
    }

    /** Run the auto-scheduler to populate _spec with an optimal multi-leg
     *  plan. Reuses (no duplication):
     *    - AesAfpAutoScheduler.run         — greedy+swap allocation
     *    - AesAfpRouteCandidates.last       — scored candidates
     *    - allocator's preset resolution    — settings.lastSelectedPresetId
     *  Returns the Build, or null on failure (with a hint already rendered). */
    async function _runAutoBuild() {
        if (_automateInFlight || _applyInFlight) return null
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            _renderHint("error", "Aircraft context not yet resolved.")
            return null
        }
        const sched = window.AesAfpAutoScheduler
        if (!sched || typeof sched.run !== "function") {
            _renderHint("error", "Auto-scheduler not loaded.")
            return null
        }
        _automateInFlight = true
        _updateModeBadge()
        _renderHint("info", "Building optimal plan…")
        try {
            const build = await sched.run({
                aircraftId: ctx.aircraftId,
                persist:    false   // panel writes the spec; allocator's draft store stays untouched
            })
            if (!build) {
                _renderHint("error", "Auto-build returned no result.")
                return null
            }
            const validation = Array.isArray(build.validation) ? build.validation : []
            if (validation.length) {
                _renderHint("error", "Auto-build validation: " + validation.map(v => (v && (v.reason || v.message || v.code)) || v).join("; "))
                _lastBuild = build
                return null
            }
            const flights = Array.isArray(build.flights) ? build.flights : []
            if (!flights.length) {
                _renderHint("warn", "Auto-build placed 0 legs — check candidates / preset / budget.")
                _lastBuild = build
                return null
            }
            _lastBuild = build
            const settings = await _settingsSnapshot()
            const next = window.AesAfpLegSpec.setLegsFromBuild(_spec, flights, settings)
            _updateSpec(next)
            await _flushSave()
            _renderBody()
            const wn = (build.placements   && build.placements.length)   || 0
            const cn = (build.connections  && build.connections.length)  || 0
            _renderHint("info",
                "Built " + flights.length + " legs"
                + (wn ? " · " + wn + " waves" : "")
                + (cn ? " · " + cn + " connections" : ""))
            _emit("studio:auto-build-done", {spec: _spec, build})
            return build
        } catch (e) {
            console.warn("[AES studio] auto-build threw", e)
            _renderHint("error", "Auto-build threw: " + ((e && e.message) || String(e)))
            return null
        } finally {
            _automateInFlight = false
            _updateModeBadge()
        }
    }

    /** Open the shared confirmation modal (mandatory ack + duration
     *  estimate + locked-leg detection) and dispatch on confirm. The modal
     *  itself calls back into apply-batch, which streams progress events
     *  the panel mirrors via _attachAutoApplyListener. */
    async function _runApply() {
        if (_automateInFlight || _applyInFlight) return
        const validation = window.AesAfpLegSpec.validateSpec(_spec)
        if (!validation.ok) {
            _renderHint("error", "Cannot apply: " + validation.errors.map(e => e.path + " — " + e.reason).join("; "))
            return
        }
        const preview = window.AesAfpAutoSchedulerPreview
        if (!preview || typeof preview.openConfirmModal !== "function") {
            _renderHint("error", "Confirmation modal not available — auto-scheduler preview not loaded.")
            return
        }
        if (!window.AesAfpAutoApplyBatch || typeof window.AesAfpAutoApplyBatch.start !== "function") {
            _renderHint("error", "Apply-batch pipeline not loaded — cannot submit.")
            return
        }
        const legs = _legsForApply()
        if (!legs.length) {
            _renderHint("error", "Spec has no legs to apply.")
            return
        }
        _emit("studio:apply-requested", {spec: _spec})
        _renderHint("info", "Opening confirmation…")
        try {
            preview.openConfirmModal(legs, {source: "flight-studio"})
        } catch (e) {
            console.warn("[AES studio] openConfirmModal threw", e)
            _renderHint("error", "Confirm modal threw: " + ((e && e.message) || String(e)))
        }
    }

    /** End-to-end: optimise + apply. The user's primary CTA. Auto-build
     *  always runs (even if the spec is populated) — that's the contract:
     *  Automate is the "rebuild + create" button. To apply an existing
     *  manual spec without rebuilding, use the Apply button instead. */
    async function _runAutomate() {
        if (_automateInFlight || _applyInFlight) return
        _emit("studio:automate-requested", {spec: _spec})
        const build = await _runAutoBuild()
        if (!build || !build.flights || !build.flights.length) return
        await _runApply()
    }

    /** Subscribe to apply-batch bus events so the panel mirrors progress.
     *  Idempotent — runs once. Survives Wicket re-mounts because attach()
     *  guards on _attached. */
    function _attachAutoApplyListener() {
        if (_busListenersAttached) return
        const bus = _bus()
        if (!bus || typeof bus.on !== "function") return
        _busListenersAttached = true
        bus.on("auto-apply:start", (p) => {
            _applyInFlight = true
            _applyTotal = (p && p.total) || 0
            _updateModeBadge()
            _renderHint("info", "Applying " + _applyTotal + " legs to AS…")
        })
        bus.on("auto-apply:progress", (p) => {
            if (!p || !_applyInFlight) return
            if (p.phase !== "leg-done") return
            const idx = (typeof p.legIdx === "number") ? p.legIdx : -1
            if (idx < 0) return
            const ok = !!p.ok
            _renderHint(ok ? "info" : "warn",
                "Leg " + (idx + 1)
                + (_applyTotal ? " of " + _applyTotal : "")
                + " " + (ok ? "succeeded" : ("failed: " + (p.error || "?"))))
        })
        bus.on("auto-apply:done", (p) => {
            _applyInFlight = false
            _applyTotal = 0
            _updateModeBadge()
            const succ = (p && p.succeeded != null) ? p.succeeded : 0
            const fail = (p && p.failed    != null) ? p.failed    : 0
            const tot  = succ + fail
            _renderHint(fail ? "warn" : "info",
                "Applied " + succ + " of " + tot + (fail ? " (" + fail + " failed)" : ""))
            _flushSave().catch(() => {})
            _emit("studio:applied", {spec: _spec, results: (p && p.results) || []})
        })
        bus.on("auto-apply:aborted", (p) => {
            _applyInFlight = false
            _applyTotal = 0
            _updateModeBadge()
            _renderHint("error", "Apply aborted at leg " + ((p && p.completed) || 0))
        })
        bus.on("auto-apply:error", (p) => {
            _applyInFlight = false
            _applyTotal = 0
            _updateModeBadge()
            _renderHint("error", "Apply error: " + ((p && p.error) || "unknown"))
        })
        // F1 decision sidebar — react to spec edits. Debounced 200 ms so a
        // burst of keystrokes coalesces to one fetch; deduped on FROM:TO so
        // PRICE/SERVICE edits don't refetch (estimator doesn't read them).
        bus.on("studio:draft-changed", (p) => {
            if (_sidebarRenderTimer) clearTimeout(_sidebarRenderTimer)
            _sidebarRenderTimer = setTimeout(() => {
                _sidebarRenderTimer = null
                _renderSidebarFor((p && p.spec) || _spec).catch(() => {})
            }, 200)
        })
    }

    /** Render a collapsible summary of the current auto-built spec — leg
     *  count, wave count, connection count, plus a per-leg list. Visible
     *  only when source is "auto-build" (manual specs use the leg-row
     *  editor for leg #0; multi-leg manual entry is via Continue →). */
    function _buildAutoBuildSummary() {
        const wrap = document.createElement("details")
        wrap.dataset.aesStudioAutoBuild = "1"
        wrap.style.cssText = "margin:6px 0 4px;border:1px solid #1f2937;border-radius:3px;background:#0f1623;"
        wrap.open = (_spec && _spec.legs && _spec.legs.length <= 4)

        const sum = document.createElement("summary")
        sum.style.cssText = "cursor:pointer;padding:5px 8px;font-size:11px;color:#cbd5e1;font-weight:600;"
        const wn = (_lastBuild && _lastBuild.placements   && _lastBuild.placements.length)  || 0
        const cn = (_lastBuild && _lastBuild.connections  && _lastBuild.connections.length) || 0
        sum.textContent = "Auto-build · " + (_spec.legs.length) + " legs"
            + (wn ? " · " + wn + " waves" : "")
            + (cn ? " · " + cn + " connections" : "")
        wrap.appendChild(sum)

        const list = document.createElement("div")
        list.style.cssText = "padding:0 8px 6px;font-family:var(--aes-font-mono,monospace);font-size:10px;color:#9ca3af;"
        const ctx = _ctx()
        const hub = (ctx && ctx.currentLocationIata || "").toUpperCase()
        _spec.legs.forEach((leg, i) => {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:8px;padding:2px 0;"
            const arrowOut = (leg.origin && hub && leg.origin === hub)
            const dir = arrowOut ? "→" : "←"
            const dirCol = arrowOut ? "#3b82f6" : "#10b981"
            const idx = document.createElement("span")
            idx.textContent = String(i + 1).padStart(2, " ")
            idx.style.color = "#6b7280"
            idx.style.width = "18px"
            row.appendChild(idx)
            const od = document.createElement("span")
            od.style.color = "#e2e8f0"
            od.style.flex = "1 1 auto"
            od.innerHTML = (leg.origin || "???")
                + " <span style=\"color:" + dirCol + ";font-weight:600;\">" + dir + "</span> "
                + (leg.destination || "???")
            row.appendChild(od)
            const t = document.createElement("span")
            t.textContent = leg.depTimeLocal || "—"
            t.style.color = "#cbd5e1"
            t.style.width = "44px"
            row.appendChild(t)
            const p = document.createElement("span")
            p.textContent = (leg.pricePct != null ? leg.pricePct : 100) + "%"
            p.style.color = "#9ca3af"
            p.style.width = "40px"
            p.style.textAlign = "right"
            row.appendChild(p)
            if (leg.appliedAt) {
                const a = document.createElement("span")
                a.textContent = "✓"
                a.style.color = "#34d399"
                a.style.width = "14px"
                row.appendChild(a)
            }
            list.appendChild(row)
        })
        wrap.appendChild(list)
        return wrap
    }

    /** Second action row — the automation pipeline buttons. Separates
     *  spec-editing actions (Preview / Reset / Undo / Continue) from the
     *  apply-pipeline actions to keep the user's mental model clean. */
    function _buildAutomateActions() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;"
            + "padding-top:6px;border-top:1px dashed #1f2937;"

        const sched   = window.AesAfpAutoScheduler
        const preview = window.AesAfpAutoSchedulerPreview
        const batch   = window.AesAfpAutoApplyBatch
        const busy    = _automateInFlight || _applyInFlight
        const canBuild = !!(sched && typeof sched.run === "function")
        const canApply = !!(preview && typeof preview.openConfirmModal === "function"
                          && batch && typeof batch.start === "function")

        function _setDisabled(btn, disabled, tooltip) {
            if (!disabled) return
            btn.disabled = true
            btn.style.opacity = "0.5"
            btn.style.cursor = "not-allowed"
            if (tooltip) btn.title = tooltip
        }

        const automateBtn = _mkBtn("🎯 Automate", "primary", _runAutomate)
        automateBtn.title = "Build the optimal plan and create all flights in one click"
        _setDisabled(automateBtn, busy || !canBuild || !canApply,
            !canBuild ? "Auto-scheduler not loaded"
            : !canApply ? "Apply-batch pipeline not loaded"
            : "In flight…")

        const buildBtn = _mkBtn("Auto-Build", "default", _runAutoBuild)
        buildBtn.title = "Run the optimiser and populate the spec without applying"
        _setDisabled(buildBtn, busy || !canBuild,
            !canBuild ? "Auto-scheduler not loaded" : "In flight…")

        const applyBtn = _mkBtn("Apply", "default", _runApply)
        applyBtn.title = "Apply the current spec via background-tab pipeline"
        _setDisabled(applyBtn, busy || !canApply,
            !canApply ? "Apply-batch pipeline not loaded" : "In flight…")

        row.append(automateBtn, buildBtn, applyBtn)
        return row
    }

    function _buildActions() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;"
        const previewBtn = _mkBtn("Preview", "primary", () => {
            _runPreview()
        })
        const resetBtn = _mkBtn("Reset", "default", async () => {
            const ctx = _ctx()
            _spec = _seedSpec(ctx)
            _autoSuggested = false   // user reset → re-arm auto-suggest
            await _flushSave()
            _renderBody()
            // Clear the AS form's flight-number input so it matches the
            // reset spec. Other fields are left alone — a candidate-row
            // click may have populated origin/dest, and we don't want
            // Reset to clobber that side-channel work.
            _pushToAsForm("flightNumberText", "")
            if (!_spec.flightNumberText) {
                _autoSuggested = true
                _populateNextAvailable({silent: true}).catch(() => {})
            }
        })
        const undoBtn = _mkBtn("Undo", "default", async () => {
            const ctx = _ctx()
            if (!ctx || !window.AesAfpStudioDraftStore) return
            const restored = await window.AesAfpStudioDraftStore.popHistory(ctx.server, ctx.aircraftId)
            if (restored && restored.spec) {
                _spec = window.AesAfpLegSpec.normalizeSpec(restored.spec)
                _renderBody()
                _pushAllToAsForm()
                _emit("studio:draft-changed", {spec: _spec})
            }
        })

        // Continue → / ← Continue back: advance (or retreat) the form for
        // the next leg of a wave by `flightTime + turnaround`. Forward
        // anchors FROM = prev.TO; backward anchors TO = prev.FROM. Pure
        // form-state — no AS submit needed between presses.
        const turnLbl = _mkLabel("Turn")
        const turnInp = _mkBaseInput(String(_turnMin), 4, "44px")
        turnInp.placeholder = "min"
        turnInp.title = "Minutes between this leg's arrival and the next leg's departure"
        turnInp.addEventListener("input", () => {
            const n = parseInt(turnInp.value, 10)
            if (isFinite(n) && n >= 0 && n < 1440) _turnMin = n
        })
        const bwdBtn = _mkBtn("← Continue back", "default",
            () => { _continueLeg("backward") })
        bwdBtn.title = "Seed previous leg: TO = current FROM, FROM blank, "
            + "DEP retreats by flight time + turnaround"
        const fwdBtn = _mkBtn("Continue →", "default",
            () => { _continueLeg("forward") })
        fwdBtn.title = "Seed next leg: FROM = current TO, TO blank, "
            + "DEP advances by flight time + turnaround"

        row.append(previewBtn, resetBtn, undoBtn,
                   turnLbl, turnInp, bwdBtn, fwdBtn)
        return row
    }

    /**
     * Capture the current spec's tail leg, compute `flightTime + turnaround`,
     * and seed a fresh single-leg spec for the next (or previous) leg.
     *
     * Reuses `RouteAssistantDistanceResolver` for distance (cached symmetric
     * pair-key, so JFK→LAX shares storage with LAX→JFK; misses fetch from AS
     * scheduling page) and `AesAfpSpecResolver.last.cruiseSpeedKmh` for cruise
     * speed (set on `ctx:ready`). Flight-time formula mirrors
     * `auto-scheduler/allocator.js:252` minus the `cycleMinutes` overhead —
     * the editable Turn field already covers ground-side time and the user
     * can extend it.
     *
     * Pushes the previous spec onto the draft store's history so a single
     * Undo press rewinds one Continue. Hints back to the user whenever a
     * required input (cruise speed, distance, complete origin/dest pair) is
     * missing rather than silently no-op'ing.
     */
    async function _continueLeg(direction) {
        const fwd = direction !== "backward"
        if (!_spec || !_spec.legs || !_spec.legs.length) {
            _renderHint("warn", "No leg to continue from yet — fill the form first.")
            return
        }
        const leg = _spec.legs[_spec.legs.length - 1]
        const origin = String(leg.origin || "").toUpperCase()
        const dest   = String(leg.destination || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(dest)) {
            _renderHint("warn", "Fill FROM + TO before Continue.")
            return
        }
        if (!leg.depTimeLocal || !/^\d{1,2}:\d{2}$/.test(leg.depTimeLocal)) {
            _renderHint("warn", "Set DEP before Continue.")
            return
        }
        const ctx = _ctx()
        const server = ctx && ctx.server
        if (!server || !ctx.aircraftId) {
            _renderHint("warn", "Aircraft context not yet resolved — open this from an AFP page.")
            return
        }
        const resolvedSpec = window.AesAfpSpecResolver && window.AesAfpSpecResolver.last
        const kmh = resolvedSpec && Number(resolvedSpec.cruiseSpeedKmh)
        if (!isFinite(kmh) || kmh <= 0) {
            _renderHint("warn", "Spec not yet resolved — wait a moment, then retry.")
            return
        }

        let distanceKm = null
        try {
            if (typeof RouteAssistantDistanceResolver === "function") {
                const resolver = new RouteAssistantDistanceResolver(server)
                const rec = await resolver.resolve(origin, dest)
                if (rec && Number(rec.distanceKm) > 0) distanceKm = Number(rec.distanceKm)
            }
        } catch (e) {
            console.warn("[AES studio] distance resolve threw", e)
        }
        if (!distanceKm) {
            _renderHint("warn", "Couldn't resolve distance for " + origin + "→" + dest
                + " — type the next DEP manually.")
            return
        }

        const flightMin = Math.round((distanceKm / kmh) * 60)
        const turn      = Number(_turnMin) || 0
        const deltaMin  = flightMin + turn

        const next = window.AesAfpLegSpec.nextSpecAfter(_spec, leg, deltaMin, direction)
        if (window.AesAfpStudioDraftStore) {
            try {
                await window.AesAfpStudioDraftStore.save(server, ctx.aircraftId, next, {pushPrev: true})
            } catch (e) {
                console.warn("[AES studio] save threw on Continue", e)
            }
        }
        _spec = next
        // Each new leg deserves a fresh next-flight-number suggestion — the
        // previous leg's number is no longer the right hint after the swap.
        _autoSuggested = false
        _renderBody()
        _pushAllToAsForm()
        if (!_spec.flightNumberText) {
            _autoSuggested = true
            _populateNextAvailable({silent: true}).catch(() => {})
        }
        _renderHint("info", (fwd ? "Forward" : "Backward")
            + " · " + flightMin + " min flight + " + turn + " min turn = "
            + deltaMin + " min " + (fwd ? "added" : "subtracted") + ".")
        _emit("studio:draft-changed", {spec: _spec})
    }

    function _buildDryRunPane() {
        const wrap = document.createElement("details")
        wrap.dataset.aesStudioDry = "1"
        wrap.style.marginTop = "4px"

        const outcome = _lastDryRunOutcome
        const sum = document.createElement("summary")
        sum.style.cssText = "cursor:pointer;font-size:11px;color:#9ca3af;"

        const pre = document.createElement("pre")
        pre.dataset.aesStudioDryBody = "1"
        pre.style.cssText = "margin:4px 0 0;padding:6px;background:#0f1419;color:#e2e8f0;font-size:10px;line-height:1.4;overflow:auto;max-height:240px;border-radius:3px;"

        if (!outcome) {
            sum.textContent = "Dry-run output (click Preview to populate)"
            pre.textContent = "(no dry-run yet — Preview to compute)"
            wrap.appendChild(sum)
            wrap.appendChild(pre)
            return wrap
        }

        // Always expand once Preview has run, regardless of outcome.
        wrap.open = true

        if (outcome.validationErrors && outcome.validationErrors.length) {
            sum.textContent = "Spec invalid — fix and re-Preview"
            sum.style.color = "#fca5a5"
            const lines = outcome.validationErrors
                .map(e => "• " + e.path + " — " + e.reason)
            pre.textContent = lines.join("\n")
        } else if (outcome.error) {
            sum.textContent = "Preview error"
            sum.style.color = "#fca5a5"
            pre.textContent = outcome.error
        } else if (outcome.dryRun) {
            const r = outcome.dryRun
            const formMissing = Array.isArray(r.missed) && r.missed.indexOf("form-not-found") >= 0
            sum.textContent = formMissing ? "AS form not on the page" : "Dry-run POST body"
            if (formMissing) sum.style.color = "#fde68a"
            const parts = []
            if (formMissing) {
                parts.push(
                    "AS's New Flight Number form isn't in the DOM yet —",
                    "switch to the 'New Flight Number' tab and Preview again.",
                    ""
                )
            }
            if (outcome.info) { parts.push(outcome.info, "") }
            parts.push(_formatDryRun(r))
            pre.textContent = parts.join("\n")
        } else {
            sum.textContent = "Dry-run output"
            pre.textContent = "(empty outcome)"
        }

        wrap.appendChild(sum)
        wrap.appendChild(pre)
        return wrap
    }

    // ── Preview pipeline ─────────────────────────────────────────────────

    /**
     * Mutates _lastDryRun/_lastDryRunOutcome and re-renders the body so the
     * dry-run pane reflects the latest Preview attempt. Always populates the
     * pane visibly — validation errors, form-not-found, and successful POST
     * bodies all show inline rather than as easy-to-miss side hints.
     */
    function _renderDryRunPaneWith(outcome) {
        _lastDryRunOutcome = outcome || null
        _lastDryRun = (outcome && outcome.dryRun) || null
        _renderBody()
    }

    async function _runPreview() {
        const validation = window.AesAfpLegSpec.validateSpec(_spec)
        if (!validation.ok) {
            _renderDryRunPaneWith({validationErrors: validation.errors})
            return
        }
        const fd = window.AesAfpFormDriver
        if (!fd || typeof fd.dryRun !== "function") {
            _renderDryRunPaneWith({error: "Form driver not loaded — cannot dry-run."})
            return
        }
        // Auto-flip to the "New Flight Number" tab if AS is currently on
        // "Existing Flight Number" — the form only mounts in the New tab,
        // so without this dryRun would always come back form-not-found.
        if (!fd.findForm() && typeof fd.ensureNewTabActive === "function") {
            try { await fd.ensureNewTabActive() } catch (_) { /* fall through */ }
        }
        // S1: single-leg only. Multi-leg dry-run lands in S2 alongside the
        // form-driver-x addVia plumbing.
        const formLeg = window.AesAfpLegSpec.toFormDriverLeg(_spec.legs[0], _spec.flightNumberText || "")
        const result = fd.dryRun(formLeg)
        // Also pre-fill AS's "New Flight Number" form so the user can review
        // and click Submit. fill() never POSTs (safety invariant in
        // form-driver.js:10-24); the user remains in control of the green
        // "Create new flight number" button. Awaited so the info string is
        // ready when we paint the pane (the previous fire-and-forget pattern
        // raced with _renderBody and lost the confirmation).
        let info = null
        if (typeof fd.fill === "function") {
            try {
                const r = await fd.fill(formLeg)
                if (r && r.ok) {
                    info = "AS form pre-filled — review and click 'Create new flight number' to confirm."
                } else if (r && r.missed && r.missed.length) {
                    info = "AS form partially filled — missed: " + r.missed.join(", ")
                }
            } catch (_) { /* dry-run still useful */ }
        }
        _renderDryRunPaneWith({dryRun: result, info: info})
        _emit("studio:dry-run-rendered", {spec: _spec, dryRun: result})
    }

    function _formatDryRun(result) {
        const lines = []
        lines.push("POST " + (result.url || "(unknown)"))
        lines.push("")
        const keys = Object.keys(result.body || {}).sort()
        if (!keys.length) {
            lines.push("(no fields)")
        } else {
            const max = Math.max.apply(null, keys.map(k => k.length))
            for (const k of keys) lines.push(k.padEnd(max) + " = " + result.body[k])
        }
        if (result.missed && result.missed.length) {
            lines.push("")
            lines.push("missed: " + result.missed.join(", "))
            if (result.missed.indexOf("form-not-found") >= 0) {
                lines.push("→ Switch AS to the 'New Flight Number' tab so the form is in the DOM, then re-Preview.")
            }
        }
        return lines.join("\n")
    }

    function _renderHint(kind, message) {
        const host = _slot()
        if (!host) return
        const body = host.querySelector("[data-aes-studio-body]")
        if (!body) return
        let hint = body.querySelector("[data-aes-studio-hint]")
        if (!hint) {
            hint = document.createElement("div")
            hint.dataset.aesStudioHint = "1"
            hint.style.cssText = "font-size:10px;margin-top:4px;line-height:1.4;"
            body.appendChild(hint)
        }
        hint.style.color = (kind === "error") ? "#fca5a5"
                        : (kind === "warn")  ? "#fde68a"
                        : "#a7f3d0"
        hint.textContent = message
    }

    // ── Input factories ──────────────────────────────────────────────────

    function _mkLabel(text) {
        const s = document.createElement("span")
        s.textContent = text
        s.style.cssText = "color:#9ca3af;font-size:10px;letter-spacing:0.4px;text-transform:uppercase;"
        return s
    }
    function _mkArrow() {
        const s = document.createElement("span")
        s.textContent = "→"
        s.style.cssText = "color:#6b7280;font-size:12px;"
        return s
    }
    function _mkBaseInput(value, maxlen, width) {
        const inp = document.createElement("input")
        inp.type = "text"
        inp.value = value == null ? "" : String(value)
        if (maxlen != null) inp.maxLength = maxlen
        inp.style.cssText = [
            "background:#0f1419;color:#e2e8f0;",
            "border:1px solid #374151;border-radius:3px;",
            "padding:3px 6px;font-size:11px;",
            "font-family:var(--aes-font-mono,monospace);",
            "width:" + (width || "auto") + ";"
        ].join("")
        return inp
    }
    function _mkIataInput(value, onChange) {
        const inp = _mkBaseInput((value || "").toUpperCase(), 3, "56px")
        inp.placeholder = "IATA"
        inp.style.textTransform = "uppercase"
        inp.addEventListener("input", () => {
            const v = inp.value.toUpperCase()
            if (inp.value !== v) inp.value = v
            onChange(v)
        })
        return inp
    }
    function _mkTimeInput(value, onChange) {
        const inp = _mkBaseInput(value || "", 5, "60px")
        inp.placeholder = "HH:MM"
        inp.addEventListener("input", () => onChange(inp.value))
        inp.addEventListener("blur", () => {
            const v = inp.value.trim()
            if (/^\d{1,2}:\d{2}$/.test(v)) {
                const [h, m] = v.split(":").map(Number)
                if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                    const padded = (h < 10 ? "0" + h : "" + h) + ":" + (m < 10 ? "0" + m : "" + m)
                    if (inp.value !== padded) {
                        inp.value = padded
                        onChange(padded)
                    }
                }
            }
        })
        return inp
    }
    function _mkPctInput(value, onChange) {
        const inp = _mkBaseInput(value == null ? "100" : String(value), 3, "48px")
        inp.placeholder = "100"
        inp.title = "50–200"
        inp.addEventListener("input", () => {
            const v = parseInt(inp.value, 10)
            if (isFinite(v)) onChange(v)
        })
        return inp
    }
    function _mkServiceInput(value, onChange) {
        // S1 ships a free-text input; S2's paste-import will introduce
        // label-fallback (e.g. "Standard" → "719"). The form-driver's
        // setService matches the option `value` directly, so blank or
        // numeric strings both work here.
        const inp = _mkBaseInput(value || "", 24, "120px")
        inp.placeholder = "(default)"
        inp.title = "Service profile option value (e.g. '719' for Standard). Blank = AS default."
        inp.addEventListener("input", () => onChange(inp.value))
        return inp
    }
    function _mkTextInput(value, maxlen, width, onChange) {
        const inp = _mkBaseInput(value || "", maxlen, width)
        inp.addEventListener("input", () => onChange(inp.value))
        return inp
    }
    function _mkBtn(label, kind, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        const isPrimary = kind === "primary"
        b.style.cssText = [
            "background:" + (isPrimary ? "#1e40af" : "#0f1623"),
            "color:" + (isPrimary ? "#dbeafe" : "#cbd5e1"),
            "border:1px solid " + (isPrimary ? "#1d4ed8" : "#374151"),
            "border-radius:3px;padding:4px 10px;font-size:11px;",
            "font-weight:600;cursor:pointer;"
        ].join(";")
        b.addEventListener("click", onClick)
        return b
    }

    // ── Public ───────────────────────────────────────────────────────────

    /** Programmatic open — scrolls panel into view, focuses first input,
     *  emits studio:opened. Tolerant of slot-not-yet-mounted (will render
     *  on next ctx:ready if necessary). */
    async function open(trigger) {
        await render()
        const host = _slot()
        if (host) {
            try { host.scrollIntoView({behavior: "smooth", block: "center"}) }
            catch (_) { /* old browsers — noop */ }
            const firstInput = host.querySelector("input")
            if (firstInput) {
                try { firstInput.focus() } catch (_) {}
            }
        }
        _emit("studio:opened", {trigger: trigger || TRIGGER_INIT})
    }

    function getSpec() { return _spec }

    function attach() {
        if (_attached) return
        const bus = _bus()
        if (!bus) return
        _attached = true
        // Re-render on every ctx:ready — covers initial mount AND Wicket
        // re-mount paths. render() is idempotent.
        bus.on("ctx:ready", () => {
            render()
                .then(() => _attachMatrixObserver())
                .catch(e => console.warn("[AES studio] render threw", e))
        })
        // schedule:updated fires when other modules persist a new schedule
        // record (route-candidates.js:836); the matrix may have changed too,
        // so refresh diagnostics. Body-level re-render is cheap.
        bus.on("schedule:updated", () => {
            if (_renderInFlight) return
            _renderBody()
        })
        // Subscribe to apply-batch progress so the panel can show live
        // status during a Flight Studio "Apply" / "Automate" run.
        _attachAutoApplyListener()
        // If ctx is already ready by the time we attach (manifest order
        // may have dispatched ctx:ready before our handler subscribed),
        // render eagerly.
        if (window.AesAfp && window.AesAfp.ctx) {
            render()
                .then(() => _attachMatrixObserver())
                .catch(e => console.warn("[AES studio] initial render threw", e))
        }
    }

    window.AesAfpFlightStudio = {
        attach,
        render,
        open,
        getSpec
    }

    // Late-load guard — Slice A's bus may not be live yet when this
    // module evaluates (manifest order should put us after host.js but
    // parse-vs-execute timing isn't strict). Mirror form-driver.js's
    // poll pattern.
    if (window.AesAfp && window.AesAfp.bus) {
        attach()
    } else {
        let tries = 0
        const id = setInterval(() => {
            if (window.AesAfp && window.AesAfp.bus) {
                clearInterval(id)
                attach()
            } else if (++tries > 50) {
                clearInterval(id)
            }
        }, 100)
    }

    // ?aes-debug smoke asserts — fire only when the user adds the query
    // string to the AS URL. Mirrors auto-scheduler/preview-panel.js:2059.
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof _runPreview === "function",
                "[AES studio smoke] _runPreview defined")
            console.assert(typeof _buildScheduleDiagnostics === "function",
                "[AES studio smoke] _buildScheduleDiagnostics defined")
            console.assert(typeof _renderDryRunPaneWith === "function",
                "[AES studio smoke] _renderDryRunPaneWith defined")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
