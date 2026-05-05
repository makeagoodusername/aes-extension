/**
 * ORS Sandbox UI features for RouteAssistantPanel.
 * Mixed into RouteAssistantPanel.prototype.
 */

if (typeof window.RouteAssistantPanel !== "undefined") {
    /**
     * Right-click drill-in target — pins the route on the sandbox state
     * and enables sandbox mode in one step. Persists `lastRouteIata` and
     * `enabled = true` so the next mount restores the same view.
     */
    window.RouteAssistantPanel.prototype._openInOrsSandbox = async function(row) {
        if (!row || !row.destIata) return
        this._orsSandboxRoute  = {hub: this.hubIata, dest: row.destIata, _row: row}
        this._orsSandboxResult = null
        this._orsSandboxPinnedResult = null
        const cfg = Object.assign({}, this.settings.orsSandbox || {})
        cfg.enabled = true
        cfg.lastRouteIata = row.destIata
        this.settings.orsSandbox = cfg
        try { await RouteAssistantSettings.save({orsSandbox: cfg}) } catch (e) { /* non-fatal */ }
        this._render()
    }

    /**
     * Letter I slice 1 — ORS Sandbox toggle. When ON, _renderRows() takes
     * the sandbox branch which replaces the table with a per-route
     * pricing simulator (rank/share/$/wk projections from cached
     * ORS + markets + demand-derivator data).
     * Persisted to settings.orsSandbox.enabled so the mode survives
     * page reloads. Mutually exclusive with Wave View — Wave wins when
     * both are on (Wave's render branch fires first).
     */
    window.RouteAssistantPanel.prototype._toggleOrsSandbox = async function() {
        const cfg = (this.settings && this.settings.orsSandbox) || {}
        const next = !cfg.enabled
        await this._setPanelMode(next ? "sandbox" : "table")
        // Invalidate cached projection so toggling re-runs against current cache.
        this._orsSandboxResult = null
        this._orsSandboxPinnedResult = null
        this._render()
    }

    window.RouteAssistantPanel.prototype._renderOrsSandbox = function(sorted) {
        // Slice 4d — stash the visible row list so the batch-projection
        // helper can reach top-N without re-running the score pipeline.
        this._orsSandboxLastSorted = sorted || []
        this.tableHost.innerHTML = ""
        const cfg = (this.settings && this.settings.orsSandbox) || {}

        // Restore last-used route on first render after toggle-on.
        if (!this._orsSandboxRoute && cfg.lastRouteIata) {
            const restored = (sorted || []).find(r => String(r.destIata).toUpperCase() === String(cfg.lastRouteIata).toUpperCase())
            if (restored) this._orsSandboxRoute = {hub: this.hubIata, dest: restored.destIata, _row: restored}
        }

        this.tableHost.append(this._buildOrsSandboxHeader(sorted))

        if (!this._orsSandboxRoute) {
            this.tableHost.append(this._buildOrsSandboxRoutePicker(sorted))
            return
        }

        const row = this._orsSandboxRoute._row
            || (sorted || []).find(r => String(r.destIata).toUpperCase() === String(this._orsSandboxRoute.dest).toUpperCase())
        if (!row) {
            const empty = document.createElement("div")
            empty.style.cssText = "margin:18px 0;padding:14px;border:1px dashed #475569;"
                + "background:rgba(100,116,139,0.08);border-radius:4px;color:#cbd5e1;"
            empty.textContent = "Selected route is not in the current view (filters may have hidden it). "
                + "Pick another route or relax filters."
            this.tableHost.append(empty)
            return
        }
        this._orsSandboxRoute._row = row

        const route = this._assembleOrsSandboxRoute(row)
        if (!route.orsByClass || !Object.keys(route.orsByClass).length) {
            this.tableHost.append(this._buildOrsSandboxNoOrsBanner(row))
            return
        }

        // Per-route scenario — pick the saved entry for this exact route, OR
        // the one-time legacy scenario (settings-store surfaces it via
        // `_legacyLastScenario` for the route the user had open last
        // pre-upgrade), OR neutral defaults.
        const routeKey = String(this.hubIata).toUpperCase() + "-" + String(row.destIata).toUpperCase()
        const savedForRoute = (cfg.lastScenarioByRoute && cfg.lastScenarioByRoute[routeKey]) || null
        const legacyFallback = (!savedForRoute
                                && cfg._legacyLastScenario
                                && String(cfg.lastRouteIata || "").toUpperCase() === String(row.destIata).toUpperCase())
            ? cfg._legacyLastScenario : null
        const scenario = RouteAssistantOrsModel._normaliseScenario(savedForRoute || legacyFallback)
        // First render — kick off a synchronous compute so baseline/projected
        // cards are populated before paint.
        this._orsSandboxResult = RouteAssistantOrsModel.project({
            route:              route,
            scenario:           scenario,
            modelParams:        Object.assign({}, cfg.modelParams || {},
                {perRouteT: (cfg.perRouteTemperature || {})[routeKey]}),
            economics:          this.settings.economics || {},
            useRealDemandForLF: !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
        })

        const body = document.createElement("div")
        body.style.cssText = "display:grid;grid-template-columns:minmax(360px, 1fr) minmax(420px, 1.2fr);"
            + "gap:14px;margin-top:10px;"
        this._orsSandboxScenarioHost = this._buildOrsSandboxScenarioCard(route, scenario)
        this._orsSandboxResultsHost  = this._buildOrsSandboxResultsCard(this._orsSandboxResult, route)
        body.append(this._orsSandboxScenarioHost, this._orsSandboxResultsHost)
        this.tableHost.append(body)

        this.tableHost.append(this._buildOrsSandboxNotes(this._orsSandboxResult))
    }

    /**
     * Header strip for the sandbox: title · route label · "Pick another"
     * button · open-on-AS link. Always present, before the picker or body.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxHeader = function(sorted) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 10px;"
            + "background:rgba(100,116,139,0.10);border:1px solid rgba(100,116,139,0.35);"
            + "border-radius:4px;color:#e5e7eb;font-size:12px;"
        const title = document.createElement("strong")
        title.textContent = "🧪 ORS Sandbox"
        wrap.append(title)

        const route = this._orsSandboxRoute
        if (route && route.dest) {
            const label = document.createElement("span")
            label.textContent = " · " + String(this.hubIata || "").toUpperCase() + " → " + String(route.dest).toUpperCase()
            label.style.color = "#cbd5e1"
            wrap.append(label)

            const link = document.createElement("a")
            link.textContent = "↗ Open route in AS"
            link.href = "/app/com/scheduling/" + String(this.hubIata || "").toUpperCase() + String(route.dest).toUpperCase()
            link.target = "_blank"
            link.style.cssText = "margin-left:6px;color:#60a5fa;text-decoration:none;font-size:11px;"
            wrap.append(link)

            const pick = document.createElement("button")
            pick.textContent = "Pick another"
            pick.style.cssText = "margin-left:auto;background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
                + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;"
            pick.addEventListener("click", () => {
                this._orsSandboxRoute = null
                this._orsSandboxResult = null
                this._orsSandboxPinnedResult = null
                this._render()
            })
            wrap.append(pick)
        } else {
            const hint = document.createElement("span")
            hint.style.color = "#9ca3af"
            hint.textContent = " · Pick a route to begin."
            wrap.append(hint)
        }

        const help = document.createElement("span")
        help.textContent = " · read-only · sourced from cache"
        help.style.cssText = "color:#6b7280;font-size:10px;"
        wrap.append(help)

        return wrap
    }

    /**
     * Route picker — dropdown of every visible row that has cached ORS
     * data, sorted by score. Selecting a route stores it on
     * `_orsSandboxRoute` and re-renders.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxRoutePicker = function(sorted) {
        const candidates = (sorted || []).filter(r => r.orsByClass && Object.keys(r.orsByClass).length)
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:14px;padding:14px;border:1px solid #475569;border-radius:4px;"
            + "background:rgba(15,22,35,0.7);color:#e5e7eb;"
        const title = document.createElement("div")
        title.style.cssText = "font-size:12px;color:#cbd5e1;margin-bottom:8px;"
        if (!candidates.length) {
            title.innerHTML = "<strong>No routes have cached ORS data yet.</strong> " +
                "Open Settings (⚙) → ORS Rank → Sync ORS rank for all visible routes, " +
                "then return here to pick a route."
            wrap.append(title)
            return wrap
        }
        title.innerHTML = "<strong>Pick a route to simulate.</strong> " +
            "Routes are sorted by current score. Only routes with cached ORS data are listed " +
            "(<span style='color:#9ca3af;'>" + candidates.length + " of " + (sorted || []).length + " visible</span>)."
        wrap.append(title)

        const sel = document.createElement("select")
        sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;"
            + "padding:4px 6px;font-size:12px;width:100%;max-width:520px;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "— select a route —"
        placeholder.selected = true
        sel.append(placeholder)
        for (const r of candidates) {
            const opt = document.createElement("option")
            opt.value = r.destIata
            const score = (typeof r.score === "number") ? Math.round(r.score) : "—"
            opt.textContent = String(r.destIata).toUpperCase() + " · " + (r.destName || "")
                + "  (score " + score + ")"
            sel.append(opt)
        }
        sel.addEventListener("change", () => {
            const dest = sel.value
            if (!dest) return
            const row = candidates.find(r => r.destIata === dest)
            if (!row) return
            this._orsSandboxRoute = {hub: this.hubIata, dest: row.destIata, _row: row}
            this._orsSandboxResult = null
            this._orsSandboxPinnedResult = null
            // Persist last-used route.
            const cfg = Object.assign({}, this.settings.orsSandbox || {})
            cfg.lastRouteIata = row.destIata
            this.settings.orsSandbox = cfg
            RouteAssistantSettings.save({orsSandbox: cfg}).catch(() => {})
            this._render()
        })
        wrap.append(sel)
        return wrap
    }

    /**
     * Banner shown when a route is picked but has no cached ORS data
     * (rare — picker filters these out, but possible if cache expired
     * between selection and render).
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxNoOrsBanner = function(row) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:14px;padding:14px;border:1px dashed #475569;border-radius:4px;"
            + "background:rgba(100,116,139,0.08);color:#cbd5e1;font-size:12px;line-height:1.5;"
        wrap.innerHTML = "<strong>No ORS data cached for this route.</strong><br>"
            + "The sandbox needs at least one cabin class scraped from /app/info/ors. "
            + "Open Settings (⚙) → ORS Rank → Sync ORS rank for all visible routes, "
            + "then re-pick the route."
        return wrap
    }

    /**
     * Scenario controls card — three sliders (Y price multiplier, freq,
     * comfort) + Calibrate-T affordance. Each slider's input handler
     * persists the new scenario (debounced via storage save) and kicks
     * the rAF-coalesced recompute.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxScenarioCard = function(route, scenario) {
        const card = document.createElement("div")
        card.style.cssText = "padding:12px;border:1px solid rgba(100,116,139,0.35);border-radius:4px;"
            + "background:rgba(15,22,35,0.45);color:#e5e7eb;font-size:12px;"
        const h = document.createElement("div")
        h.style.cssText = "color:#cbd5e1;margin-bottom:8px;"
        h.innerHTML = "<strong>Scenario</strong> <span style='color:#6b7280;font-size:11px;'>"
            + "— sliders re-project live · ↺ resets to baseline</span>"
        card.append(h)

        // Slice 6d — small ↺ button next to each control that restores
        // the route's actual current value. Dispatches the control's
        // native input/change event so the existing onChange() runs.
        const mkResetBtn = (title, onClick) => {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = "↺"
            btn.title = title
            btn.style.cssText = "background:transparent;border:none;color:#9ca3af;cursor:pointer;"
                + "font-size:13px;padding:0 4px;line-height:1;align-self:center;margin-left:4px;"
            btn.addEventListener("mouseenter", () => { btn.style.color = "#fbbf24" })
            btn.addEventListener("mouseleave", () => { btn.style.color = "#9ca3af" })
            btn.addEventListener("click", (e) => {
                e.preventDefault()
                e.stopPropagation()
                onClick()
            })
            return btn
        }

        // ----- Per-class price multiplier sliders -----------------------
        // Render one slider per cabin class with a cached observed fare.
        // Routes with only Y cached collapse to a single slider, visually
        // identical to slice 1.
        const prices = (route.ownPricing && route.ownPricing.prices) || {}
        const observedByCls = {Y: prices.Y || null, C: prices.C || null, F: prices.F || null}
        const sliders = {}
        const readouts = {}
        for (const cls of ["Y", "C", "F"]) {
            const observed = observedByCls[cls]
            if (observed == null) continue
            const initial = Number(scenario.priceMultipliers && scenario.priceMultipliers[cls]) || 1
            const built   = this._buildOrsSandboxPriceSliderRow(cls, observed, initial)
            sliders[cls]  = built.slider
            readouts[cls] = built.updateReadout
            const resetBtn = mkResetBtn("Reset " + cls + " price to baseline (" + observed + ")", () => {
                built.slider.value = "1.00"
                built.slider.dispatchEvent(new Event("input", {bubbles: true}))
            })
            built.row.append(resetBtn)
            card.append(built.row)
        }

        // ----- Cargo multiplier slider (slice 2d) -----------------------
        // Renders only when CARGO connection list is cached. Scales the
        // cargo yield only — no rating/share shift modelled.
        const hasCargo = !!(route.orsByClass && route.orsByClass.CARGO
            && Array.isArray(route.orsByClass.CARGO.connections)
            && route.orsByClass.CARGO.connections.length)
        let cargoSlider = null
        let cargoReadout = null
        const cargoPool = Number(route.cargoDemandPool)
        if (hasCargo || (isFinite(cargoPool) && cargoPool > 0)) {
            const cargoRow = this._mkOrsSandboxRow("Cargo yield",
                "scales cargo yield only · no rating shift")
            cargoSlider = document.createElement("input")
            cargoSlider.type = "range"
            cargoSlider.min = "0.30"
            cargoSlider.max = "3.00"
            cargoSlider.step = "0.01"
            cargoSlider.value = String(Number(scenario.cargoMultiplier) || 1.0)
            cargoSlider.style.cssText = "width:100%;accent-color:#10b981;"
            const cargoOut = document.createElement("span")
            cargoOut.style.cssText = "color:#cbd5e1;font-variant-numeric:tabular-nums;font-size:11px;min-width:80px;text-align:right;"
            cargoReadout = () => {
                const m = Number(cargoSlider.value) || 1
                cargoOut.textContent = m.toFixed(2) + "x"
            }
            cargoReadout()
            cargoRow.append(cargoSlider, cargoOut)
            cargoRow.append(mkResetBtn("Reset cargo multiplier to 1×", () => {
                cargoSlider.value = "1.00"
                cargoSlider.dispatchEvent(new Event("input", {bubbles: true}))
            }))
            card.append(cargoRow)
        }

        // ----- Frequency input ------------------------------------------
        const baseFreq = Number(route.currentFrequency) || 0
        const freqWrap = this._mkOrsSandboxRow("Frequency",
            baseFreq ? baseFreq + "/wk current" : "no scheduled flights")
        const freqInput = document.createElement("input")
        freqInput.type = "number"
        freqInput.min = "0"
        freqInput.max = "200"
        freqInput.step = "1"
        freqInput.value = String(scenario.frequency != null ? scenario.frequency : baseFreq)
        freqInput.style.cssText = "width:80px;background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;"
        const freqHint = document.createElement("span")
        freqHint.style.cssText = "color:#6b7280;font-size:10px;margin-left:6px;"
        freqHint.textContent = "/wk · synthesises own-connections when above current"
        freqWrap.append(freqInput, freqHint)
        freqWrap.append(mkResetBtn("Reset frequency to current (" + baseFreq + "/wk)", () => {
            freqInput.value = String(baseFreq)
            freqInput.dispatchEvent(new Event("input", {bubbles: true}))
        }))
        card.append(freqWrap)

        // ----- Comfort selector -----------------------------------------
        const comfortWrap = this._mkOrsSandboxRow("Comfort",
            "−2 budget … 0 standard … +2 premium")
        const comfortSel = document.createElement("select")
        comfortSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;"
        const cd = Number(scenario.comfortDelta) || 0
        for (const v of [-2, -1, 0, 1, 2]) {
            const o = document.createElement("option")
            o.value = String(v)
            const labels = {"-2": "−2 (budget)", "-1": "−1", "0": "0 (current)", "1": "+1", "2": "+2 (premium)"}
            o.textContent = labels[String(v)]
            if (v === cd) o.selected = true
            comfortSel.append(o)
        }
        comfortWrap.append(comfortSel)
        comfortWrap.append(mkResetBtn("Reset comfort to 0 (current)", () => {
            comfortSel.value = "0"
            comfortSel.dispatchEvent(new Event("change", {bubbles: true}))
        }))
        card.append(comfortWrap)

        // ----- Live recompute wiring ------------------------------------
        const onChange = () => {
            const pm = {Y: 1, C: 1, F: 1}
            for (const cls of ["Y", "C", "F"]) {
                if (sliders[cls]) pm[cls] = Number(sliders[cls].value) || 1
            }
            const cargoMult = cargoSlider ? (Number(cargoSlider.value) || 1) : 1
            this._recomputeOrsSandbox({
                priceMultipliers: pm,
                cargoMultiplier:  cargoMult,
                frequency:        Number(freqInput.value),
                comfortDelta:     Number(comfortSel.value) || 0
            })
        }
        for (const cls of ["Y", "C", "F"]) {
            if (!sliders[cls]) continue
            sliders[cls].addEventListener("input", () => { readouts[cls](); onChange() })
        }
        if (cargoSlider) {
            cargoSlider.addEventListener("input", () => { cargoReadout(); onChange() })
        }
        freqInput.addEventListener("input",   onChange)
        comfortSel.addEventListener("change", onChange)

        // Slice 5a — expose control refs so the sparkline in the results
        // card (built separately) can dispatch input events on click.
        this._orsSandboxControlRefs = {
            sliders:     sliders,
            cargoSlider: cargoSlider,
            freqInput:   freqInput,
            comfortSel:  comfortSel
        }

        // ----- Calibrate T affordance + per-route T banner --------------
        const calibrateRow = document.createElement("div")
        calibrateRow.style.cssText = "margin-top:10px;padding-top:10px;border-top:1px solid rgba(100,116,139,0.30);"
            + "display:flex;flex-direction:column;gap:6px;"
        const tBanner = document.createElement("div")
        tBanner.style.cssText = "color:#9ca3af;font-size:10px;"
        const calBtn = document.createElement("button")
        calBtn.textContent = "Calibrate T from this route's actual share"
        calBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
            + "border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;align-self:flex-start;"
        calBtn.addEventListener("click", () => this._calibrateOrsSandboxT(route, tBanner))

        calibrateRow.append(calBtn, tBanner)
        this._orsSandboxTBanner = tBanner
        this._refreshOrsSandboxTBanner(route)
        card.append(calibrateRow)

        // ----- Tier 3 — apply this scenario as price ------------------
        // Bridge from sandbox simulation to the real markets-page write.
        // The sandbox has already projected prices via the Y/C/F sliders
        // ($baseline × multiplier); we hand those to the apply modal as
        // pre-filled inputs along with the projected delta envelope.
        const applyRow = document.createElement("div")
        applyRow.style.cssText = "margin-top:10px;padding-top:10px;border-top:1px solid rgba(100,116,139,0.30);"
            + "display:flex;flex-direction:column;gap:4px;"
        const applyHint = document.createElement("div")
        applyHint.style.cssText = "color:#9ca3af;font-size:10px;"
        applyHint.textContent = "Push these prices to AS via the markets-page form."
        const applyBtn = document.createElement("button")
        applyBtn.textContent = "Apply this scenario as price…"
        applyBtn.style.cssText = "background:#7c3aed;color:#fff;border:1px solid #6d28d9;"
            + "border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;align-self:flex-start;"
        applyBtn.addEventListener("click", () => {
            // Compute the prices the sliders have produced. The model
            // exposes `result.perClass.<cls>.scenarioPrice`; fall back
            // to baseline × multiplier when the result hasn't been
            // recomputed yet (modal can still show what would post).
            const result = this._orsSandboxResult || {}
            const sliderPrices = {}
            for (const cls of ["Y", "C", "F"]) {
                const cur = (route.ownPricing && route.ownPricing.prices && route.ownPricing.prices[cls]) || null
                const slider = sliders[cls]
                const mult = slider ? (Number(slider.value) || 1) : 1
                const projected = (result.perClass && result.perClass[cls] && result.perClass[cls].scenarioPrice) || null
                if (projected != null && isFinite(projected)) sliderPrices[cls] = Math.round(projected)
                else if (cur != null) sliderPrices[cls] = Math.round(cur * mult)
            }
            if (cargoSlider) {
                const m = Number(cargoSlider.value) || 1
                const cur = (route.ownPricing && route.ownPricing.prices && route.ownPricing.prices.Cargo) || null
                if (cur != null) {
                    const projectedCargo = cur * m
                    sliderPrices.Cargo = Math.abs(projectedCargo) < 10
                        ? Math.round(projectedCargo * 100) / 100
                        : Math.round(projectedCargo)
                }
            }
            // Capture the projected delta so the apply log carries the
            // sandbox's view of what should happen (basis for slice 3b
            // back-test joins later).
            const projectedDelta = {}
            if (result && result.delta) {
                for (const k of ["paxPerWeek", "revenuePerWeek", "profitPerWeek", "share", "rating"]) {
                    if (result.delta[k] != null) projectedDelta[k] = result.delta[k]
                }
            }
            this._openPricingApplyModal({
                hub:    route.hub  || this.hubIata,
                dest:   route.dest || (this._orsSandboxRoute && this._orsSandboxRoute.dest),
                source: "sandbox",
                prefilledPrices: sliderPrices,
                sandboxScenario: result.scenario || null,
                projectedDelta:  Object.keys(projectedDelta).length ? projectedDelta : null,
                sandboxProjected:   (result && result.projected)   || null,
                sandboxModelParams: (result && result.modelParams) || null,
                row: this._orsSandboxRoute && this._orsSandboxRoute._row
            })
        })
        applyRow.append(applyHint, applyBtn)
        card.append(applyRow)

        // ----- Slice 4a — sweet-spot finder ------------------------------
        // Scans a uniform price multiplier across [0.7, 1.3] in 5% steps
        // and surfaces the profit-maximising point. Click the result line
        // to apply: snaps every cabin slider to the optimal multiplier and
        // dispatches their input event so the existing recompute pipeline
        // picks the change up.
        const scanRow = document.createElement("div")
        scanRow.style.cssText = "margin-top:10px;padding-top:10px;border-top:1px solid rgba(100,116,139,0.30);"
            + "display:flex;flex-direction:column;gap:4px;"
        const scanBtn = document.createElement("button")
        scanBtn.type = "button"
        scanBtn.textContent = "Find optimal price"
        scanBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
            + "border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;align-self:flex-start;"
        const scanOut = document.createElement("div")
        scanOut.style.cssText = "color:#9ca3af;font-size:11px;min-height:14px;"
        scanBtn.addEventListener("click", () => {
            const out = this._runOrsSandboxScan(route)
            if (!out) {
                scanOut.textContent = "No projection signal — need own connection + spec/fuel inputs."
                scanOut.style.color = "#fbbf24"
                return
            }
            const mult = out.optimal.multiplier
            const pct  = (out.optimal.deltaPct != null)
                ? ((out.optimal.deltaPct >= 0 ? "+" : "") + (out.optimal.deltaPct * 100).toFixed(1) + "%")
                : "—"
            scanOut.innerHTML = ""
            const pre = document.createElement("span")
            pre.textContent = "Optimal: "
            const link = document.createElement("a")
            link.href = "#"
            link.textContent = mult.toFixed(2) + "× → " + pct + " profit/wk"
            link.style.cssText = "color:#fbbf24;text-decoration:underline;cursor:pointer;"
            link.addEventListener("click", (e) => {
                e.preventDefault()
                for (const cls of ["Y", "C", "F"]) {
                    if (!sliders[cls]) continue
                    sliders[cls].value = mult.toFixed(2)
                    sliders[cls].dispatchEvent(new Event("input", {bubbles: true}))
                }
            })
            scanOut.style.color = "#9ca3af"
            scanOut.append(pre, link)
            if (mult === 1) {
                const tail = document.createElement("span")
                tail.textContent = " (current price already optimal)"
                tail.style.color = "#6b7280"
                scanOut.append(tail)
            }
        })
        scanRow.append(scanBtn, scanOut)
        card.append(scanRow)

        // ----- Slice 4d — multi-route batch projection -------------------
        // Apply the live scenario to the top-N visible rows in one shot
        // and roll up the profit delta. Read-only — never writes back.
        const batchRow = document.createElement("div")
        batchRow.style.cssText = "margin-top:10px;padding-top:10px;border-top:1px solid rgba(100,116,139,0.30);"
            + "display:flex;flex-direction:column;gap:4px;"
        const batchControls = document.createElement("div")
        batchControls.style.cssText = "display:flex;align-items:center;gap:6px;"
        const batchN = document.createElement("input")
        batchN.type = "number"
        batchN.min = "2"
        batchN.max = "100"
        batchN.step = "1"
        batchN.value = "20"
        batchN.style.cssText = "width:56px;background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;"
        const batchBtn = document.createElement("button")
        batchBtn.type = "button"
        batchBtn.textContent = "Run scenario across top-N routes"
        batchBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
            + "border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;"
        batchControls.append(batchN, batchBtn)
        const batchOut = document.createElement("div")
        batchOut.style.cssText = "color:#9ca3af;font-size:11px;"
        batchBtn.addEventListener("click", () => {
            const n = Math.max(2, Math.min(100, Number(batchN.value) || 20))
            const scenario = this._readOrsSandboxControls(sliders, cargoSlider, freqInput, comfortSel)
            const out = this._runOrsSandboxBatch(scenario, n)
            batchOut.innerHTML = ""
            batchOut.append(this._buildOrsSandboxBatchCard(out))
        })
        batchRow.append(batchControls, batchOut)
        card.append(batchRow)

        // ----- Slice 4c — saved named scenarios --------------------------
        // Mounted ABOVE the sliders for quick "I want to revisit X" recall.
        // Build the row now; populate it asynchronously once the per-route
        // store has resolved. References sliders / cargoSlider / freqInput /
        // comfortSel via closure — those `const`s are in scope by the time
        // any click handler fires.
        const savedRow = document.createElement("div")
        savedRow.style.cssText = "margin:0 0 8px 0;padding:6px 8px;background:rgba(30,41,59,0.40);"
            + "border:1px dashed rgba(100,116,139,0.30);border-radius:4px;display:flex;align-items:center;"
            + "gap:6px;flex-wrap:wrap;font-size:11px;color:#9ca3af;"
        savedRow.textContent = "Loading saved scenarios…"
        // Insert immediately after the header so it sits above every control.
        card.insertBefore(savedRow, h.nextSibling)
        const renderSaved = (items) => {
            savedRow.innerHTML = ""
            const lab = document.createElement("span")
            lab.textContent = "Saved:"
            lab.style.color = "#cbd5e1"
            savedRow.append(lab)
            const sel = document.createElement("select")
            sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
                + "border-radius:3px;padding:2px 4px;font-size:11px;min-width:160px;"
            const placeholder = document.createElement("option")
            placeholder.value = ""
            placeholder.textContent = items.length
                ? "— pick a scenario —"
                : "(none yet)"
            sel.append(placeholder)
            for (const it of items) {
                const o = document.createElement("option")
                o.value = it.id
                o.textContent = it.name
                sel.append(o)
            }
            sel.addEventListener("change", () => {
                const id = sel.value
                if (!id) return
                const item = items.find(x => x.id === id)
                if (!item || !item.scenario) return
                this._applyOrsSandboxScenarioToControls(item.scenario, sliders, cargoSlider, freqInput, comfortSel)
                // Reset the select so re-picking the same item still re-applies.
                sel.value = ""
            })
            savedRow.append(sel)

            const saveBtn = document.createElement("button")
            saveBtn.type = "button"
            saveBtn.textContent = "Save current…"
            saveBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
                + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;"
            saveBtn.addEventListener("click", async () => {
                const name = (typeof prompt === "function")
                    ? prompt("Name this scenario (max 60 chars):", "") : null
                if (name == null) return
                const trimmed = String(name).trim()
                if (!trimmed) return
                const scenario = this._readOrsSandboxControls(sliders, cargoSlider, freqInput, comfortSel)
                try {
                    await RouteAssistantSandboxScenariosStore.save(
                        route.hub || this.hubIata, route.dest, {name: trimmed, scenario}
                    )
                    const next = await RouteAssistantSandboxScenariosStore.list(
                        route.hub || this.hubIata, route.dest
                    )
                    renderSaved(next)
                } catch (e) { /* non-fatal */ }
            })
            savedRow.append(saveBtn)

            if (items.length) {
                const delBtn = document.createElement("button")
                delBtn.type = "button"
                delBtn.textContent = "Delete…"
                delBtn.title = "Remove the scenario currently picked in the dropdown."
                delBtn.style.cssText = "background:transparent;color:#f87171;border:1px solid rgba(248,113,113,0.5);"
                    + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;"
                delBtn.addEventListener("click", async () => {
                    const id = sel.value
                    if (!id) return
                    try {
                        await RouteAssistantSandboxScenariosStore.remove(
                            route.hub || this.hubIata, route.dest, id
                        )
                        const next = await RouteAssistantSandboxScenariosStore.list(
                            route.hub || this.hubIata, route.dest
                        )
                        renderSaved(next)
                    } catch (e) { /* non-fatal */ }
                })
                savedRow.append(delBtn)
                const hint = document.createElement("span")
                hint.style.cssText = "color:#6b7280;font-size:10px;margin-left:auto;"
                hint.textContent = items.length + "/5 saved · cap evicts oldest"
                savedRow.append(hint)
            }
        }
        if (typeof RouteAssistantSandboxScenariosStore !== "undefined") {
            RouteAssistantSandboxScenariosStore.list(route.hub || this.hubIata, route.dest)
                .then(renderSaved).catch(() => renderSaved([]))
        } else {
            renderSaved([])
        }

        return card
    }

    /**
     * Slice 4d — apply the given scenario to the top-N visible routes
     * and return per-route projections + a roll-up. Reuses the same
     * modelParams the live projection just used (cached on
     * `_orsSandboxResult.modelParams`) so the batch matches what the
     * single-route panel showed.
     */
    window.RouteAssistantPanel.prototype._runOrsSandboxBatch = function(scenario, n) {
        const sorted = this._orsSandboxLastSorted || []
        const top = sorted.slice(0, Math.max(2, Math.min(100, Number(n) || 20)))
        const cached = this._orsSandboxResult || {}
        const mp = (cached && cached.modelParams) || {}
        const rows = []
        const economics = this.settings.economics || {}
        const useReal = !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
        let baseTotal = 0, projTotal = 0, baseAny = false, projAny = false, skipped = 0
        for (const row of top) {
            const route = this._assembleOrsSandboxRoute(row)
            if (!route || !route.orsByClass || !Object.keys(route.orsByClass).length) {
                skipped++
                continue
            }
            const res = RouteAssistantOrsModel.project({
                route:     route,
                scenario:  scenario,
                modelParams: {
                    ratingPriceElasticity:        mp.ratingPriceElasticity,
                    ratingComfortLift:            mp.ratingComfortLift,
                    ratingPriceElasticityByClass: mp.ratingPriceElasticityByClass,
                    alphaSourceByClass:           mp.alphaSourceByClass
                    // Per-route T from the cached single-route projection
                    // would bias every batch row toward that route's T —
                    // intentionally omitted; the model falls back to the
                    // global temperature for routes without their own.
                },
                economics:          economics,
                useRealDemandForLF: useReal
            })
            const baseProfit = (res && res.baseline)  ? Number(res.baseline.profitPerWeek)  : null
            const projProfit = (res && res.projected) ? Number(res.projected.profitPerWeek) : null
            const delta = (isFinite(baseProfit) && isFinite(projProfit)) ? (projProfit - baseProfit) : null
            if (isFinite(baseProfit)) { baseTotal += baseProfit; baseAny = true }
            if (isFinite(projProfit)) { projTotal += projProfit; projAny = true }
            rows.push({
                hub:        route.hub || this.hubIata,
                dest:       route.dest,
                baseProfit: isFinite(baseProfit) ? baseProfit : null,
                projProfit: isFinite(projProfit) ? projProfit : null,
                delta:      delta
            })
        }
        return {
            scenario:  scenario,
            rows:      rows,
            skipped:   skipped,
            requested: top.length,
            totals: {
                baseProfit: baseAny ? Math.round(baseTotal) : null,
                projProfit: projAny ? Math.round(projTotal) : null,
                deltaProfit: (baseAny && projAny) ? Math.round(projTotal - baseTotal) : null,
                deltaPct:    (baseAny && projAny && baseTotal !== 0)
                    ? (projTotal - baseTotal) / Math.abs(baseTotal) : null
            }
        }
    }

    /** Slice 4d — render the batch-projection summary card. */
    window.RouteAssistantPanel.prototype._buildOrsSandboxBatchCard = function(out) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:6px;padding:8px;border:1px solid rgba(100,116,139,0.30);"
            + "border-radius:4px;background:rgba(15,22,35,0.45);"
        if (!out || !out.rows || !out.rows.length) {
            wrap.style.color = "#fbbf24"
            wrap.textContent = "No projectable routes in the visible set "
                + "(need cached ORS data + spec + fuel inputs)."
            return wrap
        }
        const totals = out.totals || {}
        const fmtMoney = (v) => (v == null || !isFinite(v))
            ? "—"
            : (v >= 0 ? "" : "−") + "$" + Math.abs(Math.round(v)).toLocaleString()
        const head = document.createElement("div")
        head.style.cssText = "color:#cbd5e1;font-size:12px;margin-bottom:6px;"
        const pct = (totals.deltaPct != null)
            ? ((totals.deltaPct >= 0 ? "+" : "") + (totals.deltaPct * 100).toFixed(1) + "%")
            : "—"
        const deltaColor = (totals.deltaProfit == null) ? "#9ca3af"
            : (totals.deltaProfit > 0 ? "#34d399" : (totals.deltaProfit < 0 ? "#f87171" : "#9ca3af"))
        head.innerHTML = "<strong>" + out.rows.length + " routes</strong> "
            + "<span style='color:#6b7280;'>across the top " + out.requested + " visible"
            + (out.skipped ? " · " + out.skipped + " skipped (no ORS)" : "") + "</span>"
            + " &nbsp; Σ profit/wk: <span style='color:#e5e7eb;'>" + fmtMoney(totals.baseProfit) + "</span>"
            + " → <span style='color:#e5e7eb;'>" + fmtMoney(totals.projProfit) + "</span>"
            + " (<span style='color:" + deltaColor + ";'>" + fmtMoney(totals.deltaProfit) + " · " + pct + "</span>)"
        wrap.append(head)
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const trH = document.createElement("tr")
        for (const t of ["Route", "Base profit/wk", "Projected", "Δ"]) {
            const th = document.createElement("th")
            th.style.cssText = "padding:2px 6px;color:#6b7280;font-weight:normal;"
                + "border-bottom:1px solid rgba(100,116,139,0.3);text-align:right;"
            if (t === "Route") th.style.textAlign = "left"
            th.textContent = t
            trH.append(th)
        }
        tbl.append(trH)
        // Sort the rows by absolute delta — the routes with the largest
        // movement (positive or negative) are what the user wants to eyeball.
        const ordered = out.rows.slice().sort((a, b) =>
            Math.abs(b.delta || 0) - Math.abs(a.delta || 0))
        for (const r of ordered) {
            const tr = document.createElement("tr")
            const lab = document.createElement("td")
            lab.style.cssText = "padding:2px 6px;color:#cbd5e1;"
            lab.textContent = (r.hub || "") + "→" + (r.dest || "")
            tr.append(lab)
            for (const v of [r.baseProfit, r.projProfit]) {
                const td = document.createElement("td")
                td.style.cssText = "padding:2px 6px;text-align:right;font-variant-numeric:tabular-nums;color:#e5e7eb;"
                td.textContent = fmtMoney(v)
                tr.append(td)
            }
            const dtd = document.createElement("td")
            dtd.style.cssText = "padding:2px 6px;text-align:right;font-variant-numeric:tabular-nums;width:80px;"
            dtd.textContent = fmtMoney(r.delta)
            dtd.style.color = (r.delta == null) ? "#6b7280"
                : (r.delta > 0 ? "#34d399" : (r.delta < 0 ? "#f87171" : "#9ca3af"))
            tr.append(dtd)
            tbl.append(tr)
        }
        wrap.append(tbl)
        return wrap
    }

    /**
     * Slice 4c — read the current scenario card controls into a model-
     * compatible scenario object. Mirrors the `onChange` reader inside
     * `_buildOrsSandboxScenarioCard` so saving and live recompute stay
     * in lockstep.
     */
    window.RouteAssistantPanel.prototype._readOrsSandboxControls = function(sliders, cargoSlider, freqInput, comfortSel) {
        const pm = {Y: 1, C: 1, F: 1}
        for (const cls of ["Y", "C", "F"]) {
            if (sliders && sliders[cls]) pm[cls] = Number(sliders[cls].value) || 1
        }
        return {
            priceMultipliers: pm,
            cargoMultiplier:  cargoSlider ? (Number(cargoSlider.value) || 1) : 1,
            frequency:        freqInput ? Number(freqInput.value) : null,
            comfortDelta:     comfortSel ? (Number(comfortSel.value) || 0) : 0
        }
    }

    /**
     * Slice 4c — write a saved scenario back into the live controls and
     * dispatch the events the live recompute pipeline listens to. Skips
     * controls that don't exist on this route (e.g. a cabin without
     * cached fares has no slider).
     */
    window.RouteAssistantPanel.prototype._applyOrsSandboxScenarioToControls = function(scenario, sliders, cargoSlider, freqInput, comfortSel) {
        const pm = (scenario && scenario.priceMultipliers) || {}
        for (const cls of ["Y", "C", "F"]) {
            if (!sliders || !sliders[cls]) continue
            const v = Number(pm[cls])
            if (isFinite(v) && v > 0) {
                sliders[cls].value = v.toFixed(2)
                sliders[cls].dispatchEvent(new Event("input", {bubbles: true}))
            }
        }
        if (cargoSlider && isFinite(Number(scenario && scenario.cargoMultiplier))) {
            cargoSlider.value = Number(scenario.cargoMultiplier).toFixed(2)
            cargoSlider.dispatchEvent(new Event("input", {bubbles: true}))
        }
        if (freqInput && scenario && scenario.frequency != null && isFinite(Number(scenario.frequency))) {
            freqInput.value = String(Math.round(Number(scenario.frequency)))
            freqInput.dispatchEvent(new Event("input", {bubbles: true}))
        }
        if (comfortSel && scenario && isFinite(Number(scenario.comfortDelta))) {
            comfortSel.value = String(Math.round(Number(scenario.comfortDelta)))
            comfortSel.dispatchEvent(new Event("change", {bubbles: true}))
        }
    }

    /**
     * Slice 4a — run a uniform-multiplier price sweep against the model
     * using the same modelParams the live projection just consumed (cached
     * on `_orsSandboxResult.modelParams`). Returns null when no projection
     * has run yet for this route.
     */
    window.RouteAssistantPanel.prototype._runOrsSandboxScan = function(route) {
        if (!route) return null
        const cached = this._orsSandboxResult || null
        if (!cached || !cached.modelParams) return null
        const mp = cached.modelParams
        const baseScenario = (cached.scenario && typeof cached.scenario === "object")
            ? cached.scenario : {}
        return RouteAssistantOrsModel.scanPriceCurve({
            route:              route,
            scenario:           baseScenario,
            modelParams: {
                ratingPriceElasticity:        mp.ratingPriceElasticity,
                ratingComfortLift:            mp.ratingComfortLift,
                ratingPriceElasticityByClass: mp.ratingPriceElasticityByClass,
                alphaSourceByClass:           mp.alphaSourceByClass,
                perRouteT:                    mp.T
            },
            economics:          this.settings.economics || {},
            useRealDemandForLF: !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF),
            scan: {lo: 0.7, hi: 1.3, step: 0.05}
        })
    }

    /** Small label + sublabel + control container row. */
    window.RouteAssistantPanel.prototype._mkOrsSandboxRow = function(label, sublabel) {
        const row = document.createElement("div")
        row.style.cssText = "margin:6px 0;display:flex;flex-direction:column;gap:2px;"
        const lab = document.createElement("div")
        lab.style.cssText = "color:#cbd5e1;font-size:11px;"
        lab.innerHTML = "<strong>" + label + "</strong> "
            + "<span style='color:#6b7280;font-weight:normal;font-size:10px;'>" + sublabel + "</span>"
        row.append(lab)
        const inner = document.createElement("div")
        inner.style.cssText = "display:flex;align-items:center;gap:8px;"
        row.append(inner)
        // The caller appends its inputs to the inner div via row.append (last child).
        // We expose `append` on the row that forwards to inner for ergonomics.
        const origAppend = row.append.bind(row)
        row.append = (...nodes) => { inner.append(...nodes) }
        row.appendOuter = (...nodes) => origAppend(...nodes)
        return row
    }

    /**
     * Build one price-multiplier slider for a cabin class. Returns
     * `{row, slider, updateReadout}` — caller wires `slider`'s input
     * event to call `updateReadout()` then trigger a recompute.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxPriceSliderRow = function(cls, observed, initialValue) {
        const labels = {Y: "Y price", C: "C price", F: "F price"}
        const row = this._mkOrsSandboxRow(labels[cls] || (cls + " price"),
            "$" + Math.round(observed) + " baseline")
        const slider = document.createElement("input")
        slider.type = "range"
        slider.min = "0.30"
        slider.max = "3.00"
        slider.step = "0.01"
        slider.value = String(initialValue || 1.0)
        slider.style.cssText = "width:100%;accent-color:#60a5fa;"
        const readout = document.createElement("span")
        readout.style.cssText = "color:#cbd5e1;font-variant-numeric:tabular-nums;font-size:11px;min-width:80px;text-align:right;"
        const updateReadout = () => {
            const m = Number(slider.value) || 1
            const newPrice = Math.round(observed * m)
            readout.textContent = "$" + newPrice + " (" + m.toFixed(2) + "x)"
        }
        updateReadout()
        row.append(slider, readout)
        return {row, slider, updateReadout}
    }

    window.RouteAssistantPanel.prototype._refreshOrsSandboxTBanner = function(route) {
        if (!this._orsSandboxTBanner) return
        const cfg = (this.settings && this.settings.orsSandbox) || {}
        const key = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest || "").toUpperCase()
        const perRouteT = cfg.perRouteTemperature && cfg.perRouteTemperature[key]
        const calibratedAt = cfg.perRouteTemperatureCalibratedAt && cfg.perRouteTemperatureCalibratedAt[key]
        const globalT = (cfg.modelParams && cfg.modelParams.shareTemperature) || 25
        if (perRouteT != null) {
            // Surface calibration age. Markets drift — a 30-day-old T is
            // worth re-running. Color the age badge amber/red as it crosses
            // the staleness thresholds (30d / 90d).
            let ageHtml = ""
            if (calibratedAt) {
                const ageDays = Math.max(0, Math.round((Date.now() - calibratedAt) / 86400000))
                const stale   = ageDays >= 30
                const ancient = ageDays >= 90
                const ageColor = ancient ? "#fca5a5" : (stale ? "#fbbf24" : "#6b7280")
                const suffix   = ancient ? " — recalibrate" : (stale ? " — consider recalibrating" : "")
                ageHtml = " <span style='color:" + ageColor + ";'>· calibrated "
                    + (ageDays === 0 ? "today" : ageDays + "d ago") + suffix + "</span>"
            } else {
                ageHtml = " <span style='color:#6b7280;'>· calibration age unknown</span>"
            }
            this._orsSandboxTBanner.innerHTML = "Using calibrated T = <strong>" + perRouteT + "</strong> "
                + "<span style='color:#6b7280;'>for this route · global T = " + globalT + "</span>"
                + ageHtml
                + " <a href='#' data-action='reset-t' style='color:#fbbf24;text-decoration:none;'>[reset]</a>"
            const resetLink = this._orsSandboxTBanner.querySelector("[data-action='reset-t']")
            if (resetLink) resetLink.addEventListener("click", async (e) => {
                e.preventDefault()
                const next       = Object.assign({}, cfg.perRouteTemperature || {})
                const nextStamps = Object.assign({}, cfg.perRouteTemperatureCalibratedAt || {})
                delete next[key]
                delete nextStamps[key]
                this.settings.orsSandbox = Object.assign({}, cfg, {
                    perRouteTemperature:             next,
                    perRouteTemperatureCalibratedAt: nextStamps
                })
                await RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox}).catch(() => {})
                this._orsSandboxResult = null
                this._render()
            })
        } else {
            this._orsSandboxTBanner.textContent = "Using global T = " + globalT
                + " (sets the share/rating sensitivity; lower = sharper share-by-rank)"
        }
    }

    /**
     * Results card — three columns: baseline / projected / Δ for
     * rating, rank, share, pax/wk, rev/wk, profit/wk.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxResultsCard = function(result, route) {
        const card = document.createElement("div")
        card.style.cssText = "padding:12px;border:1px solid rgba(100,116,139,0.35);border-radius:4px;"
            + "background:rgba(15,22,35,0.45);color:#e5e7eb;font-size:12px;"
        const h = document.createElement("div")
        h.style.cssText = "color:#cbd5e1;margin-bottom:8px;display:flex;align-items:center;gap:8px;"
        const hLabel = document.createElement("span")
        // Slice 4b — header copy mentions the pinned column when active.
        const pinned = this._orsSandboxPinForRoute(route)
        hLabel.innerHTML = pinned
            ? "<strong>Outcome</strong> <span style='color:#6b7280;font-size:11px;'>— baseline · pinned · projected · Δ</span>"
            : "<strong>Outcome</strong> <span style='color:#6b7280;font-size:11px;'>— baseline · projected · Δ</span>"
        h.append(hLabel)
        // Slice 4b — pin/unpin toggle.
        const pinBtn = document.createElement("button")
        pinBtn.type = "button"
        pinBtn.style.cssText = "margin-left:auto;background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;"
        pinBtn.textContent = pinned ? "✕ Clear pin" : "📌 Pin scenario"
        pinBtn.title = pinned
            ? "Drop the pinned A/B comparison column."
            : "Snapshot this projection as 'A'; the live sliders become 'B' for side-by-side comparison."
        pinBtn.addEventListener("click", () => {
            if (this._orsSandboxPinForRoute(route)) {
                this._orsSandboxPinnedResult = null
            } else if (result && result.projected) {
                this._orsSandboxPinnedResult = {
                    hub:       (route && route.hub)  || this.hubIata,
                    dest:      (route && route.dest) || null,
                    snapshot:  result
                }
            }
            // Re-render the results card via the recompute pipeline so the
            // notes footer and pin label both stay in sync.
            if (this._orsSandboxResultsHost && this._orsSandboxResultsHost.parentNode) {
                const next = this._buildOrsSandboxResultsCard(this._orsSandboxResult, route)
                this._orsSandboxResultsHost.parentNode.replaceChild(next, this._orsSandboxResultsHost)
                this._orsSandboxResultsHost = next
            }
        })
        h.append(pinBtn)
        card.append(h)

        // Slice 3a — confidence pill above the table.
        const confidence = this._orsSandboxConfidence(route, result)
        const pill = this._buildOrsSandboxConfidencePill(confidence)
        if (pill) {
            const pillRow = document.createElement("div")
            pillRow.append(pill)
            card.append(pillRow)
        }

        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
        const fmt = this._formatOrsSandboxValue.bind(this)
        // Slice 4b — when a pinned snapshot exists, inject a Pinned column
        // (with its own delta-vs-baseline) between Base and the live
        // Projected. `pinned` is null when no pin is active or when the
        // pinned route doesn't match the visible one.
        const renderRow = (label, fmtKey, baseVal, projVal, deltaVal, tooltip, annotation, pinVal, pinDelta) => {
            const tr = document.createElement("tr")
            const lab = document.createElement("td")
            lab.style.cssText = "padding:3px 6px;color:#9ca3af;width:90px;"
            lab.textContent = label
            if (tooltip) lab.title = tooltip
            tr.append(lab)
            const mkValueCell = (v, isProjected) => {
                const td = document.createElement("td")
                td.style.cssText = "padding:3px 6px;text-align:right;font-variant-numeric:tabular-nums;color:#e5e7eb;"
                td.textContent = fmt(v, fmtKey)
                if (isProjected && annotation && annotation.marker) {
                    td.textContent = td.textContent + annotation.marker
                    td.style.color = "#fbbf24"
                    if (annotation.tooltip) td.title = annotation.tooltip
                }
                return td
            }
            const mkDeltaCell = (d) => {
                const td = document.createElement("td")
                td.style.cssText = "padding:3px 6px;text-align:right;font-variant-numeric:tabular-nums;width:80px;"
                td.textContent = fmt(d, fmtKey, true)
                if (typeof d === "number" && isFinite(d)) {
                    td.style.color = d > 0 ? "#34d399" : (d < 0 ? "#f87171" : "#9ca3af")
                } else {
                    td.style.color = "#6b7280"
                }
                return td
            }
            tr.append(mkValueCell(baseVal, false))
            if (pinned) {
                tr.append(mkValueCell(pinVal, false))
                tr.append(mkDeltaCell(pinDelta))
            }
            tr.append(mkValueCell(projVal, true))
            tr.append(mkDeltaCell(deltaVal))
            return tr
        }
        const head = document.createElement("tr")
        const headerCols = pinned ? ["", "Base", "Pinned", "Δ", "Projected", "Δ"] : ["", "Base", "Projected", "Δ"]
        for (const t of headerCols) {
            const th = document.createElement("th")
            th.style.cssText = "padding:3px 6px;color:#6b7280;font-weight:normal;text-align:right;border-bottom:1px solid rgba(100,116,139,0.3);"
            if (t === "") th.style.textAlign = "left"
            th.textContent = t
            head.append(th)
        }
        tbl.append(head)

        const baseline = (result && result.baseline) || {}
        const projected = (result && result.projected) || {}
        const delta = (result && result.delta) || {}
        // Pinned snapshot — pulled from `_orsSandboxPinForRoute` above so we
        // never render a pin from a stale route.
        const pinSnap   = pinned ? (pinned.snapshot || {}) : null
        const pinProj   = pinSnap ? (pinSnap.projected || {}) : null
        const pinDelta  = pinSnap ? (pinSnap.delta     || {}) : null
        const pin = (k) => pinProj ? pinProj[k] : null
        const pinD = (k) => pinDelta ? pinDelta[k] : null

        // Rank — only show the most useful flavor (`nonstop` if any, else `any`).
        const baseRank = (baseline.rank && (baseline.rank.nonstop != null ? baseline.rank.nonstop : baseline.rank.any)) || null
        const projRank = (projected.rank && (projected.rank.nonstop != null ? projected.rank.nonstop : projected.rank.any)) || null
        const rankDelta = (typeof baseRank === "number" && typeof projRank === "number") ? (projRank - baseRank) : null
        const pinRank = (pinProj && pinProj.rank) ? (pinProj.rank.nonstop != null ? pinProj.rank.nonstop : pinProj.rank.any) : null
        const pinRankDelta = (typeof baseRank === "number" && typeof pinRank === "number") ? (pinRank - baseRank) : null

        const ratingAnnotation = this._clampedClasses(result)
        tbl.append(renderRow("Rating",     "rating", baseline.rating,        projected.rating,        delta.rating, "Our top per-class rating from the cached connection list. Projection applies a linear-in-percent rating shift then clamps to ±50% of the baseline.", ratingAnnotation, pin("rating"), pinD("rating")))
        tbl.append(renderRow("Rank",       "rank",   baseRank,               projRank,                rankDelta != null ? -rankDelta : null, "Rank in the ORS connection list for the primary class (nonstop preferred over any). Lower rank position = better, so Δ is sign-flipped here.", null, pinRank, pinRankDelta != null ? -pinRankDelta : null))
        tbl.append(renderRow("Share",      "share",  baseline.share,         projected.share,         delta.share, "Numeric-stable softmax over connection ratings, summed across our connections. Default temperature T=25; calibrate per-route from the markets-page leaderboard.", null, pin("share"), pinD("share")))
        tbl.append(renderRow("Pax/wk",     "pax",    baseline.paxPerWeek,    projected.paxPerWeek,    delta.paxPerWeek, "Demand pool × projected share. Pool comes from the markets-page historic chart; price-side elasticity (from demand-derivator) shifts the pool proportionally to (newPrice/observedPrice)^elasticity.", null, pin("paxPerWeek"), pinD("paxPerWeek")))
        if (baseline.cargoPerWeek != null || projected.cargoPerWeek != null || (pinProj && pinProj.cargoPerWeek != null)) {
            tbl.append(renderRow("Cargo/wk", "pax", baseline.cargoPerWeek, projected.cargoPerWeek, delta.cargoPerWeek, "Cargo demand pool × projected cargo share. Cargo multiplier scales yield only — share doesn't shift with price in the current model.", null, pin("cargoPerWeek"), pinD("cargoPerWeek")))
        }
        tbl.append(renderRow("Revenue/wk", "money",  baseline.revenuePerWeek, projected.revenuePerWeek, delta.revenuePerWeek, "Estimator's revenue × frequency. Override paxLF = projected pax/(seats×freq), override yieldPerKm = newPriceY/distance. Cargo revenue folds in via cargoLoadFactor × effectiveCargoYield × distance.", null, pin("revenuePerWeek"), pinD("revenuePerWeek")))
        tbl.append(renderRow("Profit/wk",  "money",  baseline.profitPerWeek,  projected.profitPerWeek,  delta.profitPerWeek, "Estimator's profit × frequency. Costs unchanged; revenue moves with both price and projected pax.", null, pin("profitPerWeek"), pinD("profitPerWeek")))

        card.append(tbl)

        // Slice 5b — historical pax/wk overlay (last 8–12 weeks) for context.
        const paxHist = this._buildOrsSandboxPaxHistory(result, route)
        if (paxHist) card.append(paxHist)

        // Slice 5a — price-vs-profit sparkline below the outcome table.
        const spark = this._buildOrsSandboxSparkline(result, route)
        if (spark) card.append(spark)

        // Slice 5c — sensitivity sweep heatmap (price × frequency).
        const heatmap = this._buildOrsSandboxHeatmap(result, route)
        if (heatmap) card.append(heatmap)

        // Slice 2c — collapsed per-class α override expander.
        const alphaExpander = this._buildOrsSandboxAlphaExpander(result, route)
        if (alphaExpander) card.append(alphaExpander)

        return card
    }

    /**
     * Slice 5a — inline SVG sparkline of profit/wk over priceMultiplier
     * across [0.7, 1.3] in 5% steps. Reuses `RouteAssistantOrsModel.
     * scanPriceCurve` (the same helper slice 4a's "Find optimal price"
     * button uses). Marks the current Y multiplier with a dashed green
     * line, the optimal point with an amber dot, and the 1.0× baseline
     * with a subdued tick. Click a point to apply that multiplier.
     *
     * Memoized on `this._orsSandboxCurveCache` keyed on every input
     * except priceMultipliers — Y-slider drags hit cache, frequency /
     * cargo / comfort / α / T / route changes bust it.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxSparkline = function(result, route) {
        if (!result || !result.modelParams) return null
        if (!route || !route.dest) return null
        const mp = result.modelParams
        const baseScenario = (result.scenario && typeof result.scenario === "object") ? result.scenario : {}
        const useReal = !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
        const econ    = this.settings.economics || {}
        // Cache key: stable across priceMultiplier changes only.
        const econFingerprint = [
            econ.fuelPriceASc, econ.cargoYieldPerKgKm, econ.crewCostPerKm,
            econ.maintCostPerKm, econ.depreciationPerKm, econ.miscOpsPerKm
        ].map(v => (v == null ? "_" : String(v))).join(",")
        // Route fingerprint covers the inputs scanPriceCurve actually
        // reads via project(): observed prices, demand pools, distance,
        // seats, current frequency. A bulk scrape that shifts any of
        // these busts the cache without manual invalidation at the 13
        // _orsSandboxResult reset sites.
        const obs = (route.ownPricing && route.ownPricing.prices) || {}
        const routeFingerprint = [
            obs.Y != null ? obs.Y : "_",
            obs.C != null ? obs.C : "_",
            obs.F != null ? obs.F : "_",
            route.paxDemandPool   != null ? route.paxDemandPool   : "_",
            route.cargoDemandPool != null ? route.cargoDemandPool : "_",
            route.distanceKm      != null ? route.distanceKm      : "_",
            (route.spec && route.spec.seats != null) ? route.spec.seats : "_",
            route.currentFrequency != null ? route.currentFrequency : "_"
        ].join(",")
        const cacheKey = [
            String(route.hub  || this.hubIata || "").toUpperCase(),
            String(route.dest || "").toUpperCase(),
            routeFingerprint,
            baseScenario.cargoMultiplier != null ? Number(baseScenario.cargoMultiplier) : 1,
            baseScenario.frequency       != null ? Number(baseScenario.frequency)       : "_",
            baseScenario.comfortDelta    != null ? Number(baseScenario.comfortDelta)    : 0,
            mp.T != null ? Number(mp.T) : "_",
            mp.ratingPriceElasticity != null ? Number(mp.ratingPriceElasticity) : "_",
            JSON.stringify(mp.ratingPriceElasticityByClass || {}),
            useReal ? 1 : 0,
            econFingerprint
        ].join("|")
        let sweep = (this._orsSandboxCurveCache && this._orsSandboxCurveCache.key === cacheKey)
            ? this._orsSandboxCurveCache.sweep : null
        if (!sweep) {
            sweep = RouteAssistantOrsModel.scanPriceCurve({
                route:              route,
                scenario:           baseScenario,
                modelParams: {
                    ratingPriceElasticity:        mp.ratingPriceElasticity,
                    ratingComfortLift:            mp.ratingComfortLift,
                    ratingPriceElasticityByClass: mp.ratingPriceElasticityByClass,
                    alphaSourceByClass:           mp.alphaSourceByClass,
                    perRouteT:                    mp.T
                },
                economics:          econ,
                useRealDemandForLF: useReal,
                scan:               {lo: 0.7, hi: 1.3, step: 0.05}
            })
            if (sweep) this._orsSandboxCurveCache = {key: cacheKey, sweep: sweep}
        }
        if (!sweep || !sweep.points || !sweep.points.length) return null
        const profitPts = sweep.points.filter(p => p.profitPerWeek != null && isFinite(p.profitPerWeek))
        if (!profitPts.length) return null

        const W = 360, H = 56, PAD_L = 4, PAD_R = 4, PAD_T = 6, PAD_B = 12
        const innerW = W - PAD_L - PAD_R
        const innerH = H - PAD_T - PAD_B
        const profits = profitPts.map(p => p.profitPerWeek)
        const minP = Math.min.apply(null, profits)
        const maxP = Math.max.apply(null, profits)
        const range = (maxP - minP) || 1
        const lo = sweep.points[0].multiplier
        const hi = sweep.points[sweep.points.length - 1].multiplier
        const xRange = (hi - lo) || 1
        const xOf = (m) => PAD_L + (innerW * (m - lo) / xRange)
        const yOf = (p) => PAD_T + innerH - (innerH * ((p - minP) / range))

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid rgba(100,116,139,0.30);"
        const head = document.createElement("div")
        head.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:4px;"
        const optMult  = sweep.optimal.multiplier
        const optDelta = sweep.optimal.deltaPct
        const deltaTxt = (optDelta != null)
            ? ((optDelta >= 0 ? "+" : "") + (optDelta * 100).toFixed(1) + "%")
            : "—"
        head.innerHTML = "<strong style='color:#cbd5e1;'>Profit curve</strong> "
            + "<span>0.70× → 1.30× · click any point to apply · optimal "
            + "<span style='color:#fbbf24;'>" + optMult.toFixed(2) + "×</span> "
            + "(" + deltaTxt + " vs current price)</span>"
        wrap.append(head)

        const svgNs = "http://www.w3.org/2000/svg"
        const svg = document.createElementNS(svgNs, "svg")
        svg.setAttribute("width", String(W))
        svg.setAttribute("height", String(H))
        svg.setAttribute("viewBox", "0 0 " + W + " " + H)
        svg.style.cssText = "display:block;background:rgba(15,22,35,0.45);"
            + "border:1px solid rgba(100,116,139,0.20);border-radius:3px;cursor:crosshair;"
        const tip = document.createElementNS(svgNs, "title")
        tip.textContent = "click a point to set Y/C/F price multiplier"
        svg.append(tip)

        // 1.0× baseline tick (subdued grey, dashed).
        if (lo <= 1 && hi >= 1) {
            const xb = xOf(1)
            const tick = document.createElementNS(svgNs, "line")
            tick.setAttribute("x1", String(xb)); tick.setAttribute("x2", String(xb))
            tick.setAttribute("y1", String(PAD_T)); tick.setAttribute("y2", String(PAD_T + innerH))
            tick.setAttribute("stroke", "#475569")
            tick.setAttribute("stroke-width", "1")
            tick.setAttribute("stroke-dasharray", "1,2")
            svg.append(tick)
        }

        // Profit polyline.
        const poly = document.createElementNS(svgNs, "polyline")
        poly.setAttribute("points", profitPts.map(p => xOf(p.multiplier) + "," + yOf(p.profitPerWeek)).join(" "))
        poly.setAttribute("fill", "none")
        poly.setAttribute("stroke", "#60a5fa")
        poly.setAttribute("stroke-width", "1.5")
        poly.setAttribute("stroke-linecap", "round")
        poly.setAttribute("stroke-linejoin", "round")
        svg.append(poly)

        // Optimal dot (amber).
        const optProfit = sweep.optimal.profitPerWeek
        if (optProfit != null && isFinite(optProfit)) {
            const dot = document.createElementNS(svgNs, "circle")
            dot.setAttribute("cx", String(xOf(optMult)))
            dot.setAttribute("cy", String(yOf(optProfit)))
            dot.setAttribute("r", "3")
            dot.setAttribute("fill", "#fbbf24")
            dot.setAttribute("stroke", "rgba(15,22,35,0.85)")
            dot.setAttribute("stroke-width", "1")
            svg.append(dot)
        }

        // Current Y multiplier marker (green dashed vertical).
        const yMult = (baseScenario.priceMultipliers && Number(baseScenario.priceMultipliers.Y)) || 1
        if (yMult >= lo && yMult <= hi) {
            const xm = xOf(yMult)
            const cur = document.createElementNS(svgNs, "line")
            cur.setAttribute("x1", String(xm)); cur.setAttribute("x2", String(xm))
            cur.setAttribute("y1", String(PAD_T)); cur.setAttribute("y2", String(PAD_T + innerH))
            cur.setAttribute("stroke", "#34d399")
            cur.setAttribute("stroke-width", "1.2")
            cur.setAttribute("stroke-dasharray", "3,2")
            svg.append(cur)
        }

        // X-axis labels (lo / 1× / hi).
        const xLabels = (lo <= 1 && hi >= 1) ? [lo, 1, hi] : [lo, hi]
        for (const m of xLabels) {
            const t = document.createElementNS(svgNs, "text")
            t.setAttribute("x", String(xOf(m)))
            t.setAttribute("y", String(H - 2))
            t.setAttribute("fill", "#6b7280")
            t.setAttribute("font-size", "9")
            t.setAttribute("text-anchor", m === lo ? "start" : (m === hi ? "end" : "middle"))
            t.textContent = m.toFixed(2) + "×"
            svg.append(t)
        }

        // Hover tooltip via the SVG's <title> element — updates on move.
        const findNearest = (clientX) => {
            const rect = svg.getBoundingClientRect()
            const px = clientX - rect.left
            const m = lo + ((px - PAD_L) / innerW) * xRange
            let nearest = null, nearestDiff = Infinity
            for (const p of sweep.points) {
                const d = Math.abs(p.multiplier - m)
                if (d < nearestDiff) { nearest = p; nearestDiff = d }
            }
            return nearest
        }
        const fmtMoney = (v) => (v == null || !isFinite(v))
            ? "—"
            : (v >= 0 ? "" : "−") + "$" + Math.abs(Math.round(v)).toLocaleString()
        svg.addEventListener("mousemove", (e) => {
            const n = findNearest(e.clientX)
            if (!n || n.profitPerWeek == null || !isFinite(n.profitPerWeek)) return
            const dp = (n.deltaProfit != null && isFinite(n.deltaProfit))
                ? " (" + (n.deltaProfit >= 0 ? "+" : "") + fmtMoney(n.deltaProfit) + " vs base)"
                : ""
            tip.textContent = n.multiplier.toFixed(2) + "× → " + fmtMoney(n.profitPerWeek) + "/wk" + dp
        })
        svg.addEventListener("click", (e) => {
            const n = findNearest(e.clientX)
            if (!n) return
            this._applyOrsSandboxPriceMultiplier(n.multiplier)
        })

        wrap.append(svg)
        return wrap
    }

    /**
     * Slice 5a click-to-apply — snap every cabin price slider to the
     * given multiplier and dispatch its input event so the existing
     * recompute pipeline picks the change up. No-ops if the scenario
     * card hasn't built yet (refs missing).
     */
    window.RouteAssistantPanel.prototype._applyOrsSandboxPriceMultiplier = function(mult) {
        const refs = this._orsSandboxControlRefs
        if (!refs || !refs.sliders) return
        const v = Number(mult)
        if (!isFinite(v) || v <= 0) return
        for (const cls of ["Y", "C", "F"]) {
            const slider = refs.sliders[cls]
            if (!slider) continue
            slider.value = v.toFixed(2)
            slider.dispatchEvent(new Event("input", {bubbles: true}))
        }
    }

    /**
     * Slice 5c — heatmap click-to-apply. Snaps cabin sliders to the cell's
     * price multiplier AND sets the frequency input to the cell's frequency,
     * then dispatches one consolidated `input` event so the existing
     * onChange path runs `project()` exactly once for the new state.
     */
    window.RouteAssistantPanel.prototype._applyOrsSandboxPriceFreq = function(priceMult, frequency) {
        const refs = this._orsSandboxControlRefs
        if (!refs || !refs.sliders) return
        const pm = Number(priceMult), fq = Number(frequency)
        if (!isFinite(pm) || pm <= 0) return
        for (const cls of ["Y", "C", "F"]) {
            const slider = refs.sliders[cls]
            if (slider) slider.value = pm.toFixed(2)
        }
        if (refs.freqInput && isFinite(fq) && fq > 0) {
            refs.freqInput.value = String(Math.round(fq))
        }
        const fire = refs.freqInput || refs.sliders.Y || refs.sliders.C || refs.sliders.F
        if (fire) fire.dispatchEvent(new Event("input", {bubbles: true}))
    }

    /**
     * Slice 5c — sensitivity sweep heatmap. 5×N grid of price multiplier ×
     * frequency, cell-coloured by profit/wk delta vs the (1.0×, current freq)
     * baseline. Click any cell to apply both axes simultaneously. Mounted
     * between the slice-5a profit-curve sparkline and the slice-2c α expander
     * inside the results card.
     *
     * Reuses the same modelParams + economics fingerprint as slice 5a's
     * cache so a Y/C/F drag hits both caches and the only real recompute
     * is `project()` itself plus the result-card swap.
     *
     * Returns null when scan produces no profit signal (degenerate route)
     * or when current frequency is 0 (no synthesis basis).
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxHeatmap = function(result, route) {
        if (!result || !result.modelParams) return null
        if (!route || !route.dest) return null
        const baseFreq = Number(route.currentFrequency) || 0
        if (baseFreq <= 0) return null
        const mp = result.modelParams
        const baseScenario = (result.scenario && typeof result.scenario === "object") ? result.scenario : {}
        const useReal = !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
        const econ    = this.settings.economics || {}

        const econFp = [
            econ.fuelPriceASc, econ.cargoYieldPerKgKm, econ.crewCostPerKm,
            econ.maintCostPerKm, econ.depreciationPerKm, econ.miscOpsPerKm
        ].map(v => (v == null ? "_" : String(v))).join(",")
        const obs = (route.ownPricing && route.ownPricing.prices) || {}
        const routeFp = [
            obs.Y != null ? obs.Y : "_",
            obs.C != null ? obs.C : "_",
            obs.F != null ? obs.F : "_",
            route.paxDemandPool   != null ? route.paxDemandPool   : "_",
            route.cargoDemandPool != null ? route.cargoDemandPool : "_",
            route.distanceKm      != null ? route.distanceKm      : "_",
            (route.spec && route.spec.seats != null) ? route.spec.seats : "_",
            route.currentFrequency != null ? route.currentFrequency : "_"
        ].join(",")
        const cacheKey = [
            String(route.hub  || this.hubIata || "").toUpperCase(),
            String(route.dest || "").toUpperCase(),
            routeFp,
            baseScenario.cargoMultiplier != null ? Number(baseScenario.cargoMultiplier) : 1,
            baseScenario.comfortDelta    != null ? Number(baseScenario.comfortDelta)    : 0,
            mp.T != null ? Number(mp.T) : "_",
            mp.ratingPriceElasticity != null ? Number(mp.ratingPriceElasticity) : "_",
            JSON.stringify(mp.ratingPriceElasticityByClass || {}),
            useReal ? 1 : 0,
            econFp
        ].join("|")
        let grid = (this._orsSandboxHeatmapCache && this._orsSandboxHeatmapCache.key === cacheKey)
            ? this._orsSandboxHeatmapCache.grid : null
        if (!grid) {
            grid = RouteAssistantOrsModel.scanPriceFreqGrid({
                route:              route,
                scenario:           baseScenario,
                modelParams: {
                    ratingPriceElasticity:        mp.ratingPriceElasticity,
                    ratingComfortLift:            mp.ratingComfortLift,
                    ratingPriceElasticityByClass: mp.ratingPriceElasticityByClass,
                    alphaSourceByClass:           mp.alphaSourceByClass,
                    perRouteT:                    mp.T
                },
                economics:          econ,
                useRealDemandForLF: useReal
            })
            if (grid) this._orsSandboxHeatmapCache = {key: cacheKey, grid: grid}
        }
        if (!grid || !grid.cells || !grid.cells.length) return null

        const valid = grid.cells.filter(c => c.deltaProfit != null && isFinite(c.deltaProfit))
        if (valid.length < 2) return null
        let absMax = 0
        for (const c of valid) {
            const a = Math.abs(c.deltaProfit)
            if (a > absMax) absMax = a
        }
        if (absMax === 0) absMax = 1

        const priceMults = grid.priceMultipliers
        const frequencies = grid.frequencies
        const cellByKey = new Map()
        for (const c of grid.cells) cellByKey.set(c.priceMultiplier + "|" + c.frequency, c)

        const Y_LABEL = 38, X_LABEL = 14
        const CELL_W = 56, CELL_H = 24
        const totalW = Y_LABEL + frequencies.length * CELL_W + 4
        const totalH = X_LABEL + priceMults.length * CELL_H + 4

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid rgba(100,116,139,0.30);"
        const head = document.createElement("div")
        head.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:4px;"
        const opt = grid.optimal
        const optDelta = (opt && opt.deltaProfit != null && grid.baselineProfit != null && grid.baselineProfit !== 0)
            ? ((opt.deltaProfit / Math.abs(grid.baselineProfit)) * 100)
            : null
        const optTxt = (opt && opt.priceMultiplier != null && opt.frequency != null)
            ? (opt.priceMultiplier.toFixed(2) + "× · " + opt.frequency + "/wk")
            : "—"
        const deltaTxt = (optDelta != null) ? ((optDelta >= 0 ? "+" : "") + optDelta.toFixed(1) + "%") : "—"
        head.innerHTML = "<strong style='color:#cbd5e1;'>Sensitivity</strong> "
            + "<span>price × freq · click any cell to apply · best <span style='color:#fbbf24;'>"
            + optTxt + "</span> (" + deltaTxt + " vs current)</span>"
        wrap.append(head)

        const svgNs = "http://www.w3.org/2000/svg"
        const svg = document.createElementNS(svgNs, "svg")
        svg.setAttribute("width", String(totalW))
        svg.setAttribute("height", String(totalH))
        svg.setAttribute("viewBox", "0 0 " + totalW + " " + totalH)
        svg.style.cssText = "display:block;background:rgba(15,22,35,0.45);"
            + "border:1px solid rgba(100,116,139,0.20);border-radius:3px;"

        for (let j = 0; j < frequencies.length; j++) {
            const t = document.createElementNS(svgNs, "text")
            t.setAttribute("x", String(Y_LABEL + j * CELL_W + CELL_W / 2))
            t.setAttribute("y", "10")
            t.setAttribute("text-anchor", "middle")
            t.setAttribute("font-size", "9")
            t.setAttribute("fill", "#94a3b8")
            t.textContent = frequencies[j] + "/wk"
            svg.append(t)
        }

        const fmtMoney = (v) => {
            if (v == null || !isFinite(v)) return "—"
            const a = Math.abs(v)
            if (a >= 1e6) return (v / 1e6).toFixed(1) + "M"
            if (a >= 1e3) return Math.round(v / 1e3) + "K"
            return Math.round(v).toString()
        }
        const tintFor = (delta) => {
            if (delta == null || !isFinite(delta)) return "rgba(100,116,139,0.20)"
            const ratio = Math.max(-1, Math.min(1, delta / absMax))
            const intensity = Math.abs(ratio) * 0.55
            if (ratio >= 0) return "rgba(52,211,153," + intensity.toFixed(2) + ")"
            return "rgba(248,113,113," + intensity.toFixed(2) + ")"
        }

        for (let i = 0; i < priceMults.length; i++) {
            const m = priceMults[i]
            const yLabel = document.createElementNS(svgNs, "text")
            yLabel.setAttribute("x", String(Y_LABEL - 4))
            yLabel.setAttribute("y", String(X_LABEL + i * CELL_H + CELL_H / 2 + 3))
            yLabel.setAttribute("text-anchor", "end")
            yLabel.setAttribute("font-size", "9")
            yLabel.setAttribute("fill", "#94a3b8")
            yLabel.textContent = m.toFixed(2) + "×"
            svg.append(yLabel)
            for (let j = 0; j < frequencies.length; j++) {
                const f = frequencies[j]
                const cell = cellByKey.get(m + "|" + f)
                const x = Y_LABEL + j * CELL_W
                const y = X_LABEL + i * CELL_H
                const rect = document.createElementNS(svgNs, "rect")
                rect.setAttribute("x", String(x))
                rect.setAttribute("y", String(y))
                rect.setAttribute("width",  String(CELL_W - 1))
                rect.setAttribute("height", String(CELL_H - 1))
                rect.setAttribute("fill", tintFor(cell ? cell.deltaProfit : null))
                rect.setAttribute("stroke", "rgba(100,116,139,0.30)")
                rect.setAttribute("stroke-width", "0.5")
                if (cell && opt && cell === opt) {
                    rect.setAttribute("stroke", "#fbbf24")
                    rect.setAttribute("stroke-width", "1.5")
                }
                rect.style.cursor = "pointer"
                const tip = document.createElementNS(svgNs, "title")
                if (cell && cell.profitPerWeek != null) {
                    const dPct = (cell.deltaProfit != null && grid.baselineProfit != null && grid.baselineProfit !== 0)
                        ? ((cell.deltaProfit / Math.abs(grid.baselineProfit)) * 100) : null
                    const dPctTxt = (dPct != null) ? ((dPct >= 0 ? "+" : "") + dPct.toFixed(1) + "%") : "—"
                    tip.textContent = m.toFixed(2) + "× · " + f + "/wk\n"
                        + "Profit/wk: $" + fmtMoney(cell.profitPerWeek) + "\n"
                        + "Δ vs current: " + dPctTxt + "\n"
                        + "Click to apply."
                } else {
                    tip.textContent = m.toFixed(2) + "× · " + f + "/wk · no projection"
                }
                rect.append(tip)
                if (cell) {
                    rect.addEventListener("click", () => {
                        this._applyOrsSandboxPriceFreq(cell.priceMultiplier, cell.frequency)
                    })
                }
                svg.append(rect)

                if (cell && cell.deltaProfit != null && grid.baselineProfit != null && grid.baselineProfit !== 0) {
                    const dPct = (cell.deltaProfit / Math.abs(grid.baselineProfit)) * 100
                    const tx = document.createElementNS(svgNs, "text")
                    tx.setAttribute("x", String(x + CELL_W / 2))
                    tx.setAttribute("y", String(y + CELL_H / 2 + 3))
                    tx.setAttribute("text-anchor", "middle")
                    tx.setAttribute("font-size", "9")
                    tx.setAttribute("fill", Math.abs(dPct) > 5 ? "#f3f4f6" : "#9ca3af")
                    tx.style.pointerEvents = "none"
                    tx.textContent = (dPct >= 0 ? "+" : "") + dPct.toFixed(0) + "%"
                    svg.append(tx)
                }
            }
        }
        wrap.append(svg)
        return wrap
    }

    /**
     * Slice 5b — historical pax/wk overlay. Reads the last 8–12 weeks of
     * the PAX bookings/wk series stashed on the route by `_applyCachedDemand`
     * and renders an inline 360×40 SVG. A horizontal dashed reference line
     * marks the projection's `paxDemandPool` (the average over the window),
     * so the user can see at a glance whether the projection's pool number
     * sits above or below the recent trend.
     *
     * No new fetches — the series is already in memory once demand-depth
     * has resolved. Returns null when the route lacks the series (route
     * never demand-derived, or markets-historic missing/expired).
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxPaxHistory = function(result, route) {
        if (!route) return null
        const series = route.paxHistorySeries
        if (!series || !Array.isArray(series.capacities) || !series.capacities.length) return null
        const periods = Array.isArray(series.periods) ? series.periods : []
        const caps    = series.capacities
            .map(v => (v == null || !isFinite(v)) ? null : Number(v))
        const valid   = caps.filter(v => v != null && v >= 0)
        if (valid.length < 2) return null

        const W = 360, H = 40, PAD_L = 4, PAD_R = 4, PAD_T = 4, PAD_B = 12
        const innerW = W - PAD_L - PAD_R
        const innerH = H - PAD_T - PAD_B
        const minV = Math.min.apply(null, valid)
        const maxV = Math.max.apply(null, valid)
        const range = (maxV - minV) || 1
        const N = caps.length
        const xOf = (i) => (N === 1) ? (PAD_L + innerW / 2)
            : PAD_L + (innerW * i / (N - 1))
        const yOf = (v) => PAD_T + innerH - (innerH * ((v - minV) / range))

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid rgba(100,116,139,0.30);"
        const head = document.createElement("div")
        head.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:4px;"
        const last  = caps[caps.length - 1]
        const first = caps.find(v => v != null) || null
        const trendTxt = (last != null && first != null && first !== 0)
            ? (((last - first) / first) >= 0 ? "+" : "")
              + (((last - first) / first) * 100).toFixed(0) + "%"
            : "—"
        const pool = (route.paxDemandPool != null) ? Math.round(route.paxDemandPool) : null
        head.innerHTML = "<strong style='color:#cbd5e1;'>Pax/wk · last " + N + " weeks</strong> "
            + "<span>min " + Math.round(minV).toLocaleString()
            + " · max " + Math.round(maxV).toLocaleString()
            + (pool != null ? " · pool " + pool.toLocaleString() : "")
            + " · trend <span style='color:" + (trendTxt.startsWith("-") ? "#f87171" : (trendTxt === "—" ? "#6b7280" : "#34d399")) + ";'>"
            + trendTxt + "</span></span>"
        wrap.append(head)

        const svgNs = "http://www.w3.org/2000/svg"
        const svg = document.createElementNS(svgNs, "svg")
        svg.setAttribute("width", String(W))
        svg.setAttribute("height", String(H))
        svg.setAttribute("viewBox", "0 0 " + W + " " + H)
        svg.style.cssText = "display:block;background:rgba(15,22,35,0.45);"
            + "border:1px solid rgba(100,116,139,0.20);border-radius:3px;"
        const tip = document.createElementNS(svgNs, "title")
        tip.textContent = "Hover any point for the period's pax/wk."
        svg.append(tip)

        // Pool reference line (dashed, subdued) — only renders when pool
        // sits inside the rendered range so the line stays informative.
        if (pool != null && pool >= minV && pool <= maxV) {
            const yp = yOf(pool)
            const ref = document.createElementNS(svgNs, "line")
            ref.setAttribute("x1", String(PAD_L)); ref.setAttribute("x2", String(PAD_L + innerW))
            ref.setAttribute("y1", String(yp));    ref.setAttribute("y2", String(yp))
            ref.setAttribute("stroke", "#475569")
            ref.setAttribute("stroke-width", "1")
            ref.setAttribute("stroke-dasharray", "2,3")
            svg.append(ref)
        }

        // Polyline of the series — gaps drawn as separate sub-segments so
        // a missing period doesn't create a phantom interpolation.
        const segs = []
        let cur = []
        for (let i = 0; i < N; i++) {
            const v = caps[i]
            if (v == null || !isFinite(v)) {
                if (cur.length) { segs.push(cur); cur = [] }
                continue
            }
            cur.push(xOf(i) + "," + yOf(v))
        }
        if (cur.length) segs.push(cur)
        for (const seg of segs) {
            if (seg.length < 2) continue
            const poly = document.createElementNS(svgNs, "polyline")
            poly.setAttribute("points", seg.join(" "))
            poly.setAttribute("fill", "none")
            poly.setAttribute("stroke", "#a78bfa")
            poly.setAttribute("stroke-width", "1.5")
            poly.setAttribute("stroke-linecap", "round")
            poly.setAttribute("stroke-linejoin", "round")
            svg.append(poly)
        }

        // Most-recent-period dot — anchors "current" in the trend visually.
        if (last != null && isFinite(last)) {
            const dot = document.createElementNS(svgNs, "circle")
            dot.setAttribute("cx", String(xOf(N - 1)))
            dot.setAttribute("cy", String(yOf(last)))
            dot.setAttribute("r", "2.5")
            dot.setAttribute("fill", "#c4b5fd")
            dot.setAttribute("stroke", "rgba(15,22,35,0.85)")
            dot.setAttribute("stroke-width", "1")
            svg.append(dot)
        }

        // X-axis: just the oldest and newest period labels.
        const oldestLabel = (periods[0] != null) ? String(periods[0]) : "wk -" + (N - 1)
        const newestLabel = (periods[N - 1] != null) ? String(periods[N - 1]) : "wk 0"
        const tStart = document.createElementNS(svgNs, "text")
        tStart.setAttribute("x", String(PAD_L)); tStart.setAttribute("y", String(H - 2))
        tStart.setAttribute("fill", "#6b7280"); tStart.setAttribute("font-size", "9")
        tStart.setAttribute("text-anchor", "start")
        tStart.textContent = oldestLabel
        const tEnd = document.createElementNS(svgNs, "text")
        tEnd.setAttribute("x", String(PAD_L + innerW)); tEnd.setAttribute("y", String(H - 2))
        tEnd.setAttribute("fill", "#6b7280"); tEnd.setAttribute("font-size", "9")
        tEnd.setAttribute("text-anchor", "end")
        tEnd.textContent = newestLabel
        svg.append(tStart, tEnd)

        // Hover tooltip: pick the closest period's value and surface it.
        svg.addEventListener("mousemove", (e) => {
            const rect = svg.getBoundingClientRect()
            const px = e.clientX - rect.left
            const norm = Math.max(0, Math.min(1, (px - PAD_L) / innerW))
            const idx  = (N === 1) ? 0 : Math.round(norm * (N - 1))
            const v    = caps[idx]
            const periodLabel = (periods[idx] != null) ? String(periods[idx]) : ("wk " + (idx - (N - 1)))
            tip.textContent = (v == null || !isFinite(v))
                ? periodLabel + ": no data"
                : periodLabel + ": " + Math.round(v).toLocaleString() + " pax/wk"
        })

        wrap.append(svg)
        return wrap
    }

    /**
     * Slice 2c — collapsed per-class α override expander mounted inside
     * the Outcome card. Surfaces the resolved α + source per class and
     * lets the user pin a manual override per class. Save wraps in
     * `_undoableSave` so a misclick is one-click recoverable.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxAlphaExpander = function(result, route) {
        if (!route || !route.dest || !this.hubIata) return null
        if (typeof RouteAssistantRatingAlphaStore === "undefined") return null
        const hubU  = String(this.hubIata).toUpperCase()
        const destU = String(route.dest).toUpperCase()
        const wrap = document.createElement("details")
        wrap.style.cssText = "margin-top:10px;border:1px dashed rgba(100,116,139,0.30);border-radius:4px;"
        const summary = document.createElement("summary")
        summary.style.cssText = "padding:6px 10px;cursor:pointer;color:#cbd5e1;font-size:11px;"
        summary.textContent = "Per-class α overrides (advanced)"
        wrap.append(summary)
        const body = document.createElement("div")
        body.style.cssText = "padding:6px 10px 10px;"
        const help = document.createElement("div")
        help.style.cssText = "color:#9ca3af;font-size:10px;line-height:1.4;margin-bottom:6px;"
        help.textContent = "α_price is rating points lost per +100% price. Default 8. Higher = more "
            + "price-sensitive route. Range 0–50. Set 0 to disable rating shift on price for a class."
        body.append(help)

        const mp        = (result && result.modelParams) || {}
        const resolved  = mp.ratingPriceElasticityByClass || {}
        const sources   = mp.alphaSourceByClass           || {}
        const counts    = (route && route.ratingObservationCounts) || {Y: 0, C: 0, F: 0}
        const fleet     = (route && route.fleetMedianAlpha)        || {sampleSizes: {Y: 0, C: 0, F: 0}}
        const ovr       = (route && route.ratingAlphaOverride)     || {}
        const inputs    = {Y: null, C: null, F: null}

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:24px 70px 1fr;gap:4px 10px;align-items:center;"
        for (const cls of ["Y", "C", "F"]) {
            const lab = document.createElement("div")
            lab.style.cssText = "color:#9ca3af;font-size:11px;"
            lab.textContent = cls + ":"
            grid.append(lab)
            const input = document.createElement("input")
            input.type = "number"; input.min = "0"; input.max = "50"; input.step = "0.5"
            input.placeholder = "auto"
            input.value = (Number.isFinite(ovr[cls]) ? ovr[cls] : "")
            input.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
                + "border-radius:3px;padding:2px 6px;font-size:11px;width:70px;"
            grid.append(input)
            inputs[cls] = input
            const hint = document.createElement("div")
            hint.style.cssText = "color:#6b7280;font-size:10px;"
            const a = Number.isFinite(resolved[cls]) ? resolved[cls] : null
            const src = sources[cls] || "global"
            const aTxt = (a == null) ? "—" : a
            const label = (src === "override")       ? "currently: manual override"
                        : (src === "derived")        ? "auto: " + aTxt + " (derived from " + (counts[cls] || 0) + " obs)"
                        : (src === "siblingDerived") ? "auto: " + aTxt + " (borrowed from sibling class)"
                        : (src === "fleetMedian")    ? "auto: " + aTxt + " (fleet median, n=" + ((fleet.sampleSizes && fleet.sampleSizes[cls]) || 0) + ")"
                                                     : "auto: " + aTxt + " (global default — only " + (counts[cls] || 0) + " obs)"
            hint.textContent = label
            grid.append(hint)
        }
        body.append(grid)

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px;"
        const saveBtn = document.createElement("button")
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.textContent = "Save"
        saveBtn.addEventListener("click", async () => {
            const fields = {}
            for (const cls of ["Y", "C", "F"]) {
                const raw = inputs[cls].value
                if (raw === null || raw === undefined || raw === "") continue
                const n = Number(raw)
                if (isFinite(n) && n >= 0 && n <= 50) fields[cls] = n
            }
            const prev = (route && route.ratingAlphaOverride) ? Object.assign({}, route.ratingAlphaOverride) : null
            await this._undoableSave({
                label:    "α override saved for " + hubU + "→" + destU,
                perform:  async () => {
                    await RouteAssistantRatingAlphaStore.save(hubU, destU, fields)
                },
                restore:  async () => {
                    if (prev && (Number.isFinite(prev.Y) || Number.isFinite(prev.C) || Number.isFinite(prev.F))) {
                        await RouteAssistantRatingAlphaStore.save(hubU, destU, {Y: prev.Y, C: prev.C, F: prev.F})
                    } else {
                        await RouteAssistantRatingAlphaStore.remove(hubU, destU)
                    }
                },
                afterRestore: () => this.refresh()
            })
            await this.refresh()
        })
        const clearBtn = document.createElement("button")
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.textContent = "Clear all"
        clearBtn.style.background = "#7f1d1d"
        clearBtn.disabled = !(ovr && (Number.isFinite(ovr.Y) || Number.isFinite(ovr.C) || Number.isFinite(ovr.F)))
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            const prev = Object.assign({}, ovr || {})
            await this._undoableSave({
                label:    "α overrides cleared for " + hubU + "→" + destU,
                perform:  async () => { await RouteAssistantRatingAlphaStore.remove(hubU, destU) },
                restore:  async () => {
                    await RouteAssistantRatingAlphaStore.save(hubU, destU, {Y: prev.Y, C: prev.C, F: prev.F})
                },
                afterRestore: () => this.refresh()
            })
            await this.refresh()
        })
        btnRow.append(saveBtn, clearBtn)
        body.append(btnRow)
        wrap.append(body)
        return wrap
    }

    /** Format a number for the Outcome card by metric type. */
    window.RouteAssistantPanel.prototype._formatOrsSandboxValue = function(v, key, isDelta) {
        if (v == null || !isFinite(v)) return "—"
        const sign = isDelta ? (v > 0 ? "+" : (v < 0 ? "" : "")) : ""
        if (key === "rating") return sign + (Math.round(v * 10) / 10)
        if (key === "rank")   return (sign === "+" ? "" : sign) + (v >= 0 ? "#" + Math.round(v) : Math.round(v))   // ranks shown as #N; deltas plain
        if (key === "share")  return sign + (Math.round(v * 1000) / 10) + "%"
        if (key === "pax")    return sign + Math.round(v)
        if (key === "money")  return sign + "$" + Math.round(v).toLocaleString()
        return sign + String(v)
    }

    /**
     * Render the confidence pill above the Outcome table. Single line:
     *   `Confidence: high · T calibrated 12d ago · ORS 4d old · 18 conns`
     * Hover tooltip lists each signal's full description.
     */
    window.RouteAssistantPanel.prototype._buildOrsSandboxConfidencePill = function(confidence) {
        if (!confidence) return null
        const colors = {
            high:   {fg: "#34d399", bg: "rgba(52,211,153,0.10)", bd: "rgba(52,211,153,0.35)"},
            medium: {fg: "#fbbf24", bg: "rgba(251,191,36,0.10)", bd: "rgba(251,191,36,0.35)"},
            low:    {fg: "#fca5a5", bg: "rgba(252,165,165,0.10)", bd: "rgba(252,165,165,0.35)"}
        }
        const c = colors[confidence.level] || colors.medium
        const pill = document.createElement("div")
        pill.style.cssText = "display:inline-flex;gap:6px;align-items:center;"
            + "padding:3px 8px;margin-bottom:8px;font-size:11px;border-radius:10px;"
            + "background:" + c.bg + ";border:1px solid " + c.bd + ";color:" + c.fg + ";"
        const summary = confidence.reasons.map(r => r.short).join(" · ")
        pill.innerHTML = "<strong>Confidence: " + confidence.level + "</strong>"
            + " <span style='color:#9ca3af;'>· " + summary + "</span>"
        pill.title = confidence.reasons.map(r => "• " + r.full).join("\n")
        return pill
    }

    /**
     * Slice 3c — aggregate bias + RMSE across every per-route back-test
     * record. Counts only routes with ≥3 entries that have observed
     * data back-filled (avoids noise from single-observation routes).
     *
     * Returns:
     *   {bias, rmse, routeCount, totalObservations}  (shares as 0..1)
     *   null  when totalObservations < 3 across the whole user
     *
     * `bias` is the mean signed error (observed − projected) — positive
     * means the model under-projects share. `rmse` is the root mean of
     * squared errors. Both reported as percentage points in the UI.
     */
    window.RouteAssistantPanel.prototype._computeOrsSandboxModelFit = function(allBacktests) {
        let totalObservations = 0
        let routeCount = 0
        let sumSigned = 0
        let sumSquared = 0
        if (!allBacktests || typeof allBacktests.forEach !== "function") return null
        allBacktests.forEach(rec => {
            if (!rec || !Array.isArray(rec.entries)) return
            const valid = rec.entries.filter(e =>
                e && e.observed && isFinite(Number(e.observed.share))
                && e.projected && isFinite(Number(e.projected.share))
            )
            if (valid.length < 3) return
            routeCount++
            for (const e of valid) {
                const err = Number(e.observed.share) - Number(e.projected.share)
                sumSigned  += err
                sumSquared += err * err
                totalObservations++
            }
        })
        if (totalObservations < 3) return null
        return {
            bias:              sumSigned  / totalObservations,
            rmse:              Math.sqrt(sumSquared / totalObservations),
            routeCount:        routeCount,
            totalObservations: totalObservations
        }
    }

    /**
     * Mount the model-fit info row inside a host element. Loads back-test
     * records via loadAll() (heavy — only call from the settings drawer).
     * Refresh button re-reads + recomputes without a page reload.
     */
    window.RouteAssistantPanel.prototype._renderOrsSandboxModelFitRow = function(host) {
        const row = document.createElement("div")
        row.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"
        const text = document.createElement("span")
        text.textContent = "Loading model-fit summary…"
        row.append(text)
        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = "Refresh"
        Object.assign(refreshBtn.style, smallBtnStyle())
        refreshBtn.style.padding  = "1px 6px"
        refreshBtn.style.fontSize = "10px"
        row.append(refreshBtn)
        host.append(row)

        const renderFit = (fit) => {
            if (!fit) {
                text.textContent = "Model fit: insufficient back-test data — calibrate at least 3 routes (3+ observations each) to see model fit"
                text.style.color = "#6b7280"
                text.title       = "The model-fit summary needs ≥ 3 routes with ≥ 3 back-filled observations each. "
                    + "Each Calibrate-T click adds one observation; subsequent market scrapes back-fill projections that haven't been calibrated."
                return
            }
            const sign = fit.bias > 0 ? "+" : (fit.bias < 0 ? "−" : "")
            const biasPP = Math.round(Math.abs(fit.bias) * 1000) / 10
            const rmsePP = Math.round(fit.rmse * 1000) / 10
            text.innerHTML = "Model fit: <strong>bias " + sign + biasPP + "pp</strong>"
                + " · <strong>RMSE " + rmsePP + "pp</strong>"
                + " <span style='color:#6b7280;'>· " + fit.routeCount + " routes · "
                + fit.totalObservations + " observations</span>"
            text.title = "Bias = mean(observed − projected) — positive means the model under-projects our share. "
                + "RMSE = root-mean-square error. Both in percentage points (0–100). "
                + "Only routes with ≥ 3 back-filled entries contribute."
            text.style.color = "#cbd5e1"
        }

        const reload = async () => {
            text.textContent = "Loading model-fit summary…"
            text.style.color = "#9ca3af"
            try {
                const all = await RouteAssistantSandboxBacktestStore.loadAll()
                const fit = this._computeOrsSandboxModelFit(all)
                renderFit(fit)
            } catch (e) {
                text.textContent = "Model fit: failed to load back-test data"
                text.style.color = "#fca5a5"
                console.warn("[AES sandboxBacktest] model-fit load failed", e)
            }
        }
        refreshBtn.addEventListener("click", () => reload())
        reload()
    }

    /** Footer notes — every fallback / clamp / data-gap surfaced by the model. */
    window.RouteAssistantPanel.prototype._buildOrsSandboxNotes = function(result) {
        const notes = (result && result.notes) || []
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:8px 10px;background:rgba(15,22,35,0.45);"
            + "border:1px solid rgba(100,116,139,0.25);border-radius:4px;color:#9ca3af;font-size:10px;"
        if (!notes.length) {
            wrap.textContent = "No model caveats."
            return wrap
        }
        const heading = document.createElement("div")
        heading.style.cssText = "color:#cbd5e1;margin-bottom:4px;"
        heading.innerHTML = "<strong>Model notes (" + notes.length + ")</strong>"
        wrap.append(heading)
        const ul = document.createElement("ul")
        ul.style.cssText = "margin:0;padding-left:18px;line-height:1.5;"
        for (const n of notes) {
            const li = document.createElement("li")
            li.textContent = n
            ul.append(li)
        }
        wrap.append(ul)
        return wrap
    }

    /**
     * Pull every cached field the model needs into a single bundle. Reads
     * from the row decorations (`row.orsByClass`, `row.ownPricing`, etc.)
     * + the panel's `_fleetContext` for the spec/economics half.
     */
    window.RouteAssistantPanel.prototype._assembleOrsSandboxRoute = function(row) {
        if (!row) return {}
        const ctx = (typeof this._fleetContext === "function") ? this._fleetContext() : null
        const spec = (ctx && ctx.selectedSpec) || row.aircraftSpec || null
        // Resolve currentFrequency from row.weeklyFlights or row.ownTotalFreq.
        const currentFreq = row.ownTotalFreq != null ? row.ownTotalFreq
            : (row.weeklyFlights != null ? row.weeklyFlights : 0)
        // Our enterprise id — pulled from the carriers settings myEnterpriseIds (first entry).
        let ourEnterpriseId = null
        const myIds = (this.settings && this.settings.carriers && this.settings.carriers.myEnterpriseIds) || []
        if (myIds.length) ourEnterpriseId = myIds[0]
        const falloffPct = (this.settings && this.settings.aircraft && this.settings.aircraft.falloffPct) || 10
        const useDistFuel = !!(this.settings && this.settings.economics && this.settings.economics.fuelPriceAutoEnabled)
        const fleetMedAlpha = this._ratingAlphaFleetMedian || null

        // Slice 6a — memoize the bundle on the row reference. The bundle
        // reads ~25 fields; rebuilding it on every recompute (60Hz during
        // a slider drag) is wasteful when row + settings + fleet haven't
        // changed. WeakMap keying auto-GCs old entries when the panel
        // rebuilds rows. The signature array catches mutation paths the
        // row reference doesn't (`_applyCachedDemand` mutates row fields
        // in-place, leaving the reference stable but data fresh — so
        // every field the bundle reads goes into the signature).
        const cache = this._orsSandboxRouteCache || (this._orsSandboxRouteCache = new WeakMap())
        const sig = [
            // Settings + fleet inputs (panel-instance state, not row data).
            spec, ourEnterpriseId, falloffPct, useDistFuel ? 1 : 0, fleetMedAlpha,
            // Row data — every field the bundle reads. Order is part of
            // the contract; do not reshuffle without checking the build
            // block below stays in sync.
            row.destIata, row.distanceKm,
            row.ownPricing, row.ownPriceDefaults,
            row.orsByClass, row.marketSharePax,
            row.orsOurFlightIds, row.orsOurCarrierPrefixes,
            currentFreq,
            row.paxDemandPool, row.cargoDemandPool, row.paxHistorySeries,
            row.paxElasticity, row.cargoElasticity,
            row.paxScore, row.cargoScore,
            row.fuelPriceASc,
            row.ratingPriceElasticityByClass, row.ratingObservationCounts,
            row.ratingAlphaOverride, row.ratingDerivationNotes,
            row.demandDerivedAt
        ]
        const entry = cache.get(row)
        if (entry && entry.sig.length === sig.length) {
            let same = true
            for (let i = 0; i < sig.length; i++) {
                if (!Object.is(entry.sig[i], sig[i])) { same = false; break }
            }
            if (same) return entry.bundle
        }

        const bundle = {
            hub:                this.hubIata,
            dest:               row.destIata,
            distanceKm:         row.distanceKm,
            ownPricing:         row.ownPricing ? {prices: row.ownPricing, defaults: row.ownPriceDefaults || null} : null,
            orsByClass:         row.orsByClass || {},
            marketSharePax:     row.marketSharePax || [],
            ourEnterpriseId:    ourEnterpriseId,
            ourFlightIds:       row.orsOurFlightIds || [],
            ourCarrierPrefixes: row.orsOurCarrierPrefixes || [],
            spec:               spec,
            currentFrequency:   currentFreq,
            paxDemandPool:      row.paxDemandPool != null ? row.paxDemandPool : null,
            cargoDemandPool:    row.cargoDemandPool != null ? row.cargoDemandPool : null,
            // Slice 5b — slim PAX history series for the outcome card overlay.
            paxHistorySeries:   row.paxHistorySeries || null,
            paxElasticity:      row.paxElasticity != null ? row.paxElasticity : null,
            cargoElasticity:    row.cargoElasticity != null ? row.cargoElasticity : null,
            paxScore:           row.paxScore,
            cargoScore:         row.cargoScore,
            aircraftAge:        spec && spec.aircraftAge,
            falloffPct:         falloffPct,
            useDistanceFuel:    useDistFuel,
            fuelPriceASc:       row.fuelPriceASc != null ? row.fuelPriceASc : null,
            // Slice 2c — per-route per-class rating-price elasticity bundle.
            // The cascade resolver in `_recomputeOrsSandbox` consumes these
            // along with the panel's `_ratingAlphaFleetMedian` to produce
            // the final per-class α map passed into the model.
            ratingPriceElasticityByClass: row.ratingPriceElasticityByClass || null,
            ratingObservationCounts:      row.ratingObservationCounts      || {Y: 0, C: 0, F: 0},
            ratingAlphaOverride:          row.ratingAlphaOverride          || null,
            fleetMedianAlpha:             fleetMedAlpha,
            ratingDerivationNotes:        row.ratingDerivationNotes        || []
        }
        cache.set(row, {sig: sig, bundle: bundle})
        return bundle
    }

    /**
     * rAF-coalesced recompute. Cancels any pending frame and schedules a
     * single project() + result-card swap on the next animation frame.
     * Persists the new scenario to settings (debounced via storage).
     */
    window.RouteAssistantPanel.prototype._recomputeOrsSandbox = function(scenario) {
        // Persist scenario opportunistically, keyed per-route. Storage saves
        // coalesce naturally via the timer below. Drop the legacy global
        // fields (`lastScenario`, `_legacyLastScenario`) on first save so
        // they don't keep round-tripping after the migration.
        const cfg = Object.assign({}, this.settings.orsSandbox || {})
        delete cfg.lastScenario
        delete cfg._legacyLastScenario
        const route = this._orsSandboxRoute
        if (route && route.dest) {
            const routeKey = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest).toUpperCase()
            const map = Object.assign({}, cfg.lastScenarioByRoute || {})
            map[routeKey] = RouteAssistantOrsModel._normaliseScenario(scenario)
            cfg.lastScenarioByRoute = map
        }
        this.settings.orsSandbox = cfg
        // Fire-and-forget save — failure is non-fatal, we'll just not persist.
        clearTimeout(this._orsSandboxSaveTimer)
        this._orsSandboxSaveTimer = setTimeout(() => {
            RouteAssistantSettings.save({orsSandbox: this.settings.orsSandbox}).catch(() => {})
        }, 250)

        if (this._orsSandboxRaf) cancelAnimationFrame(this._orsSandboxRaf)
        // Slice 6b — paint the overlay BEFORE scheduling the heavy work
        // when the previous project() was slow. project() runs synchronously
        // inside the rAF, so a setTimeout watchdog inside the rAF can't fire
        // until project() returns; only an upfront paint can show feedback.
        // The card swap at the end of the rAF removes the overlay along
        // with the previous results-card subtree.
        if (this._orsSandboxLastProjectMs > 100 && this._orsSandboxResultsHost) {
            this._paintOrsSandboxComputingOverlay(this._orsSandboxResultsHost)
        }
        this._orsSandboxRaf = requestAnimationFrame(() => {
            this._orsSandboxRaf = 0
            const route = this._orsSandboxRoute && this._orsSandboxRoute._row
                ? this._assembleOrsSandboxRoute(this._orsSandboxRoute._row)
                : null
            if (!route) return
            const key = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest || "").toUpperCase()
            const cfgNow = (this.settings && this.settings.orsSandbox) || {}
            // Slice 2c — per-class α cascade resolver. Order:
            //   override > derived (≥minObs) > siblingDerived > fleetMedian > global default.
            // siblingDerived only fires from classes whose source is already
            // "derived" on this route (otherwise we'd be cascading off another
            // cascade — slight bias creep). Read with `Number.isFinite`, never
            // `||`, so a zero override is preserved.
            const globalAlpha = (cfgNow.modelParams && Number.isFinite(cfgNow.modelParams.ratingPriceElasticity))
                ? cfgNow.modelParams.ratingPriceElasticity : 8
            const ovr      = (route && route.ratingAlphaOverride) || {}
            const derived  = (route && route.ratingPriceElasticityByClass) || {}
            const fleet    = (route && route.fleetMedianAlpha) || {}
            const counts   = (route && route.ratingObservationCounts) || {}
            const ratingOpts = cfgNow.ratingObservations || {}
            const minObs   = Number.isFinite(ratingOpts.minObservationsForDerivation)
                ? ratingOpts.minObservationsForDerivation : 4
            const allowSibling = ratingOpts.allowSiblingClassFallback !== false
            const allowFleet   = ratingOpts.allowFleetMedianFallback  !== false
            const alphaResolvedByClass = {Y: null, C: null, F: null}
            const alphaSourceByClass   = {Y: null, C: null, F: null}
            // Pass 1 — override and derived only.
            for (const cls of ["Y", "C", "F"]) {
                if (Number.isFinite(ovr[cls])) {
                    alphaResolvedByClass[cls] = ovr[cls]
                    alphaSourceByClass[cls]   = "override"
                } else if (Number.isFinite(derived[cls]) && (Number(counts[cls]) || 0) >= minObs) {
                    alphaResolvedByClass[cls] = derived[cls]
                    alphaSourceByClass[cls]   = "derived"
                }
            }
            // Pass 2 — sibling-class on this route → fleet median → global.
            for (const cls of ["Y", "C", "F"]) {
                if (alphaResolvedByClass[cls] != null) continue
                let resolved = false
                if (allowSibling) {
                    const sibVals = ["Y", "C", "F"]
                        .filter(s => s !== cls && alphaSourceByClass[s] === "derived")
                        .map(s => alphaResolvedByClass[s])
                    if (sibVals.length) {
                        alphaResolvedByClass[cls] = _median(sibVals)
                        alphaSourceByClass[cls]   = "siblingDerived"
                        resolved = true
                    }
                }
                if (!resolved && allowFleet && Number.isFinite(fleet[cls])) {
                    alphaResolvedByClass[cls] = fleet[cls]
                    alphaSourceByClass[cls]   = "fleetMedian"
                    resolved = true
                }
                if (!resolved) {
                    alphaResolvedByClass[cls] = globalAlpha
                    alphaSourceByClass[cls]   = "global"
                }
            }
            // Slice 6b — measure project() so subsequent recomputes know
            // whether to paint the upfront overlay. performance.now() is
            // monotonic across the rAF boundary; falls back to Date.now()
            // when performance is missing (older test contexts).
            const _t0 = (typeof performance !== "undefined") ? performance.now() : Date.now()
            this._orsSandboxResult = RouteAssistantOrsModel.project({
                route:              route,
                scenario:           scenario,
                modelParams:        Object.assign({}, cfgNow.modelParams || {},
                    {perRouteT: (cfgNow.perRouteTemperature || {})[key]},
                    {ratingPriceElasticityByClass: alphaResolvedByClass,
                     alphaSourceByClass:           alphaSourceByClass}),
                economics:          this.settings.economics || {},
                useRealDemandForLF: !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
            })
            this._orsSandboxLastProjectMs = ((typeof performance !== "undefined") ? performance.now() : Date.now()) - _t0
            // Swap just the results card + notes — leaves the controls card alone
            // (preserves slider drag focus + cursor position).
            if (this._orsSandboxResultsHost && this._orsSandboxResultsHost.parentNode) {
                const next = this._buildOrsSandboxResultsCard(this._orsSandboxResult, route)
                this._orsSandboxResultsHost.parentNode.replaceChild(next, this._orsSandboxResultsHost)
                this._orsSandboxResultsHost = next
            }
            // Notes footer is the last child of tableHost — replace it too.
            const lastChild = this.tableHost.lastChild
            if (lastChild && lastChild.previousElementSibling) {
                const newNotes = this._buildOrsSandboxNotes(this._orsSandboxResult)
                this.tableHost.replaceChild(newNotes, lastChild)
            }
        })
    }

    /**
     * Slice 6b — paint a faint "computing…" overlay on the results card
     * while the next projection runs. Idempotent: a second call before the
     * card swap clears returns the existing node. The overlay is removed
     * implicitly when `_recomputeOrsSandbox` swaps the results-card subtree.
     */
    window.RouteAssistantPanel.prototype._paintOrsSandboxComputingOverlay = function(host) {
        if (!host || host.querySelector("[data-aes-ors-computing]")) return
        const cs = window.getComputedStyle ? getComputedStyle(host) : null
        if (cs && cs.position === "static") host.style.position = "relative"
        const veil = document.createElement("div")
        veil.setAttribute("data-aes-ors-computing", "1")
        veil.style.cssText = "position:absolute;inset:0;display:flex;align-items:flex-start;"
            + "justify-content:flex-end;padding:6px 10px;pointer-events:none;"
            + "background:rgba(15,22,35,0.35);color:#94a3b8;font-size:10px;"
            + "letter-spacing:0.4px;text-transform:uppercase;border-radius:inherit;"
        veil.textContent = "computing…"
        host.append(veil)
    }

    /**
     * Solve T from the cached marketShare leaderboard observation for
     * this route. Refuses calibration if marketShare is missing, the
     * user's enterprise isn't in the leaderboard, or the freshness
     * window between marketShare and ORS data is > 7 days.
     */
    window.RouteAssistantPanel.prototype._calibrateOrsSandboxT = async function(route, banner) {
        const out = (msg, ok) => {
            if (!banner) return
            banner.style.color = ok ? "#34d399" : "#fbbf24"
            banner.textContent = msg
            setTimeout(() => this._refreshOrsSandboxTBanner(route), 6000)
        }
        const ourId = route.ourEnterpriseId
        const result = RouteAssistantOrsModel.calibrateRouteT({
            orsByClass:      route.orsByClass,
            marketSharePax:  route.marketSharePax,
            ourEnterpriseId: ourId
        })
        if (!result.ok) {
            const messages = {
                "no-marketShare":      "Calibration unavailable — no market-share data cached for this route.",
                "no-ourEnterpriseId":  "Calibration unavailable — set your enterprise id in Settings → Carriers → Contractual partners.",
                "not-in-leaderboard":  "Your enterprise (id " + ourId + ") isn't in this route's leaderboard. Confirm Settings → Carriers → my enterprise IDs.",
                "no-share":            "Calibration unavailable — leaderboard row has no share%.",
                "no-connections":      "Calibration unavailable — no ORS connection list cached for any class.",
                "no-own-connections":  "Calibration unavailable — no own connections in the ORS data.",
                "solver-failed":       "Calibration failed — solver did not converge."
            }
            return out(messages[result.code] || ("Calibration unavailable — " + result.code), false)
        }
        const T = result.T
        const observedShare = result.observedShare

        // Persist per-route T + the calibration timestamp so the results
        // card can flag stale calibrations (markets drift; 30+ day-old
        // calibrations should be re-run when new marketShare lands).
        const cfg = Object.assign({}, this.settings.orsSandbox || {})
        const map = Object.assign({}, cfg.perRouteTemperature || {})
        const tsMap = Object.assign({}, cfg.perRouteTemperatureCalibratedAt || {})
        const key = String(this.hubIata || "").toUpperCase() + "-" + String(route.dest || "").toUpperCase()
        map[key] = T
        tsMap[key] = Date.now()
        cfg.perRouteTemperature = map
        cfg.perRouteTemperatureCalibratedAt = tsMap
        this.settings.orsSandbox = cfg
        try { await RouteAssistantSettings.save({orsSandbox: cfg}) } catch (e) { /* non-fatal */ }

        // Slice 3b — back-test log. Re-project with the new T to capture the
        // projection that matches the calibrated state, then persist alongside
        // the observed share that drove the calibration. Observed is filled
        // immediately (we already have it); future markets-page scrapes won't
        // overwrite an entry that already has `observed.share`.
        try {
            const scenario = (cfg.lastScenarioByRoute || {})[key]
                || RouteAssistantOrsModel._normaliseScenario({})
            const projection = RouteAssistantOrsModel.project({
                route:              route,
                scenario:           scenario,
                modelParams:        Object.assign({}, cfg.modelParams || {}, {perRouteT: T}),
                economics:          this.settings.economics || {},
                useRealDemandForLF: !!(this.settings.demandDepth && this.settings.demandDepth.useRealDemandForLF)
            })
            await RouteAssistantSandboxBacktestStore.log(this.hubIata, route.dest, {
                ts:          Date.now(),
                trigger:     "calibrate",
                scenario:    scenario,
                modelParams: projection.modelParams,
                projected: {
                    share:          projection.projected && projection.projected.share,
                    paxPerWeek:     projection.projected && projection.projected.paxPerWeek,
                    revenuePerWeek: projection.projected && projection.projected.revenuePerWeek,
                    profitPerWeek:  projection.projected && projection.projected.profitPerWeek
                },
                observed: {
                    share:  observedShare,
                    period: null
                },
                backfilledAt: Date.now()
            })
        } catch (e) { console.warn("[AES sandboxBacktest] log on calibrate failed", e) }

        out("Calibrated T = " + T + " (from " + (Math.round(observedShare * 1000) / 10) + "% observed share). Re-projecting…", true)
        if (typeof RouteAssistantToast !== "undefined") {
            const routeKey = String(this.hubIata || "").toUpperCase() + "→" + String(route.dest || "").toUpperCase()
            RouteAssistantToast.success("Calibrated T = " + T + " for " + routeKey, {duration: 5000})
        }
        this._orsSandboxResult = null
        this._render()
    }

}
