/**
 * Auto-Pricing and Tier 3 UI features for RouteAssistantPanel.
 * Mixed into RouteAssistantPanel.prototype.
 */

if (typeof window.RouteAssistantPanel !== "undefined") {
    /**
     * Bulk-load the per-route cache and project both the live-data fields
     * (aircraft / departure / freq pattern / cruise speed) and the Tier 2
     * placeholders (ourPrice/ourYield/orsRank — currently always null) onto
     * each row.
     */
    window.RouteAssistantPanel.prototype._applyCachedPrices = async function() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cfg = (this.settings && this.settings.pricing) || {}
        const maxAgeDays = cfg.priceMaxAgeDays
        const cache = await RouteAssistantSchedulePageScraper.bulkLoadCache(pairs, {maxAgeDays: maxAgeDays})
        for (const r of this.rows) {
            const key = RouteAssistantSchedulePageScraper._pairKey(this.hubIata, r.destIata)
            const rec = cache.get(key)
            if (!rec) continue
            // Tier 2 placeholders — wired up so columns stay reactive once
            // the price/ORS scrapers land in a follow-up.
            r.ourPrice       = rec.ourPrice
            r.ourYield       = rec.ourYield
            r.orsRank        = rec.orsRank
            r.priceScrapedAt = rec.scrapedAt
            // Live route data scraped from /app/com/scheduling/<HUB><DEST>.
            r.liveAircraftType   = rec.primaryAircraftType
            r.liveAircraftTypeId = rec.primaryAircraftTypeId
            r.liveAircraftReg    = rec.primaryAircraftReg
            r.liveDeparture      = rec.departureTime
            r.liveDaysPerWeek    = rec.daysPerWeek
            r.liveCruiseSpeed    = rec.cruiseSpeedKmh
            r.liveScrapedAt      = rec.scrapedAt
            // Cross-reference primary registration against the cached fleet
            // so the Eq cell can deep-link to /app/fleets/aircraft/<id>/1
            // (the page that writes the aircraftFlights record consumed by
            // the yield-feedback snapshot). Falls back to null silently
            // when the fleet hasn't been refreshed since the tail was added.
            if (rec.primaryAircraftReg && this.fleet) {
                const fleetRec = RouteAssistantFleetStore.findByRegistration(
                    this.fleet, rec.primaryAircraftReg
                )
                r.liveAircraftId = fleetRec && fleetRec.aircraftId || null
            } else {
                r.liveAircraftId = null
            }

            // Per-day flight counts. Prefer the new shape; synthesize from
            // the legacy `frequencyPattern` (days-flown digits) for records
            // written before the parser learned about multi-daily. Lossy
            // when the legacy route was multi-daily — user can re-Sync to
            // get the precise per-day breakdown.
            if (Array.isArray(rec.dailyFlights) && rec.dailyFlights.length === 7) {
                r.liveDailyFlights  = rec.dailyFlights
                r.liveWeeklyFlights = (rec.weeklyFlights != null)
                    ? rec.weeklyFlights
                    : rec.dailyFlights.reduce((s, n) => s + n, 0)
            } else if (typeof rec.frequencyPattern === "string" && rec.frequencyPattern.length >= 7) {
                const synth = [0, 0, 0, 0, 0, 0, 0]
                for (let i = 0; i < 7; i++) {
                    const ch = rec.frequencyPattern.charAt(i)
                    if (ch >= "1" && ch <= "7") synth[i] = 1
                }
                r.liveDailyFlights  = synth
                r.liveWeeklyFlights = synth.reduce((s, n) => s + n, 0)
            } else if (rec.daysPerWeek > 0) {
                // Last-ditch: only the count survived. Show the count with a
                // null pattern so the cell renders something rather than "—".
                r.liveDailyFlights  = null
                r.liveWeeklyFlights = rec.daysPerWeek
            }
        }
    }

    /**
     * Background fuel-price scrape. Idempotent — flag prevents two scrapes
     * racing. On success, re-renders the settings drawer (if open) so the
     * "AS fuel index" line picks up the new value without a manual refresh.
     */
    window.RouteAssistantPanel.prototype._scrapeFuelPriceAsync = async function() {
        if (this._fuelScrapeInFlight || this._disposed) return
        this._fuelScrapeInFlight = true
        try {
            const scraper = new RouteAssistantFuelPriceScraper(this.server)
            const rec = await scraper.scrape()
            if (rec) this.fuelPrice = rec
        } catch (e) { /* graceful */ }
        finally {
            this._fuelScrapeInFlight = false
            if (!this._disposed && this.settingsHost && (this._drawerHost.dataset.open === "1" || this._modalHost)) {
                this._renderSettings()
            }
        }
    }

    /**
     * Renders the Auto-Pricing block inside the settings drawer:
     *   - status line (last scrape, K/N routes priced)
     *   - "Show pricing columns" toggle
     *   - "Scan prices for all visible routes" CTA + progress
     *   - placeholder note for Tier 2 / Tier 3 controls
     */
    window.RouteAssistantPanel.prototype._renderAutoPricingSection = function() {
        const cfg = this.settings.pricing = Object.assign(
            {showPricingColumns: true, concurrency: 4, staggerMs: 800, lastBulkScrapeAt: null},
            this.settings.pricing || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(244, 63, 94, 0.06);border:1px solid rgba(244, 63, 94, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#fda4af;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Live route data</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Captures aircraft, departure time, "
            + "frequency and cruise speed from /app/com/scheduling/&lt;HUB&gt;&lt;DEST&gt;. "
            + "Tier 2 will add prices and ORS rank from /app/com/markets/&lt;HUB&gt;&lt;DEST&gt;.</span>"
        wrap.append(header)

        // Status line — refreshed on every render; live progress updates
        // happen on this._priceStatusEl when a bulk scrape is running.
        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.liveAircraftType || r.liveDeparture).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Captured: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._priceStatusEl = status

        // Controls row: toggle + scan button
        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showPricingColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fda4af;"
        showLbl.append(showCb, document.createTextNode("Show live-data columns"))
        showCb.addEventListener("change", async () => {
            this.settings.pricing.showPricingColumns = showCb.checked
            await RouteAssistantSettings.save({pricing: this.settings.pricing})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._priceScrapeRunning
            ? "Syncing routes…"
            : "Sync live route data for visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#9f1239"
        scanBtn.disabled = !!this._priceScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkPriceScrape())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        // Pricing diagnostics — single-glance status of WHY (or whether)
        // prices are changing. Renders before the Tier 3 / silent-auto
        // blocks so the user sees the chain of gates + data health at a
        // glance. The blocks below own the actual toggles.
        wrap.append(this._renderPricingDiagnostics(cfg))

        // Tier 3 — apply / write-back. Permanent live mode defaults mapped
        // writers to real POSTs.
        wrap.append(this._renderTier3ApplyBlock(cfg))

        // Silent auto-pricing sub-block — always rendered so the user
        // sees the activity feed even when the loop is off; the toggle
        // gates first-activation behind a confirmation modal.
        wrap.append(this._renderSilentAutoBlock(cfg))

        this.settingsHost.append(wrap)
    }

    /**
     * Tier 3 sub-block under the Auto-Pricing expander. Surfaces:
     *   - "Apply enabled" toggle (kill switch, live by default)
     *   - default scope checkboxes (4 — airportPair / flightNumbers /
     *     returnAirportPair / returnFlightNumbers)
     *   - "Open bulk apply…" CTA
     *   - "Recent applies" log preview (last 10) — clicking a row
     *     scrolls to that route in the table
     */
    window.RouteAssistantPanel.prototype._renderTier3ApplyBlock = function(cfg) {
        const block = document.createElement("div")
        block.style.cssText = "margin-top:8px;padding:6px 8px;background:rgba(168, 85, 247, 0.06);"
            + "border:1px solid rgba(168, 85, 247, 0.30);border-radius:4px;"

        const apply = cfg.apply = Object.assign({
            enabled: true,
            dryRunOnly: false,
            defaultScope: {airportPair: true, flightNumbers: true, returnAirportPair: false, returnFlightNumbers: false},
            cooldownMinPerRoute: 60,
            cooldownMinGlobal: 5,
            warnAboveDeltaPct: 5,
            recentApplyPreviewCount: 10,
            showRecentApplies: true,
            submitButton: "submit-prices",
            liveScopes: {manual: true, bulk: true, silentAuto: true, bulkRecommended: true}
        }, cfg.apply || {})
        apply.defaultScope = Object.assign(
            {airportPair: true, flightNumbers: true, returnAirportPair: false, returnFlightNumbers: false},
            apply.defaultScope || {}
        )
        if (apply.permanentLiveMode !== false) {
            apply.enabled = true
            apply.dryRunOnly = false
        }

        const head = document.createElement("div")
        head.style.cssText = "color:#c4b5fd;font-size:11px;margin-bottom:4px;display:flex;"
            + "align-items:center;justify-content:space-between;gap:6px;"
        const title = document.createElement("strong")
        title.textContent = "Tier 3 · Apply"
        const stage = document.createElement("span")
        const stageLbl = apply.enabled ? "LIVE writes ENABLED" : "Live writes disabled"
        stage.textContent = stageLbl
        stage.style.cssText = "font-size:10px;font-weight:normal;color:"
            + (apply.enabled ? "#34d399" : "#9ca3af")
        head.append(title, stage)
        block.append(head)

        const rationale = document.createElement("div")
        rationale.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;line-height:1.4;"
        rationale.innerHTML = apply.enabled
                ? "<strong style='color:#34d399;'>LIVE.</strong> Apply will POST to the AS markets-page form. Each route has a "
                    + apply.cooldownMinPerRoute + "-minute cooldown after a successful write. Successful applies show an Undo toast for 6 s."
                : "Live writes are disabled. Flip the Apply enabled toggle below to commit real writes."
        block.append(rationale)

        // Apply-enabled kill switch.
        const enableRow = document.createElement("div")
        enableRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:11px;color:#c4b5fd;margin-bottom:4px;"
        const enableCb = mkInput("checkbox", null)
        enableCb.checked = !!apply.enabled
        const enableLbl = document.createElement("label")
        enableLbl.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer;"
        enableLbl.append(enableCb, document.createTextNode("Apply enabled"))
        enableCb.addEventListener("change", async () => {
            apply.enabled = enableCb.checked
            this.settings.pricing.apply = apply
            try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) } catch (e) { /* ignore */ }
            this._render()
        })
        // Live pipeline CTA — runs the most-eligible route through the real
        // pricing applier using the current live gates. Lands a row in Recent
        // applies so the user can see the audit trail moving in real time.
        const verifyBtn = document.createElement("button")
        verifyBtn.type = "button"
        verifyBtn.textContent = "Run live pipeline now"
        Object.assign(verifyBtn.style, smallBtnStyle())
        verifyBtn.style.fontSize = "10px"
        verifyBtn.style.marginLeft = "6px"
        verifyBtn.title = "Pick the most eligible route and run the live pricing applier "
            + "through GET handshake → parse → preflight → POST → verify → log."
        verifyBtn.addEventListener("click", async () => {
            verifyBtn.disabled = true
            const prev = verifyBtn.textContent
            verifyBtn.textContent = "Verifying…"
            try { await this._runVerifyPipelineCta() }
            finally {
                verifyBtn.disabled = false
                verifyBtn.textContent = prev
            }
        })
        enableRow.append(enableLbl, verifyBtn)
        block.append(enableRow)

        // Tier 3.2 — cooldown tuning. Per-route is the primary throttle;
        // global is the floor-level safety net for rapid-fire chains
        // (single-route apply across N hubs in 30 s). Both 0 = disabled.
        const cdRow = document.createElement("div")
        cdRow.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;align-items:center;"
            + "font-size:11px;color:#c4b5fd;margin-bottom:4px;"
        const perRouteWrap = document.createElement("label")
        perRouteWrap.style.cssText = "display:flex;gap:4px;align-items:center;"
        perRouteWrap.title = "Block apply on the same route within this many minutes "
            + "after a successful write. 0 = disabled. Default 60 minutes."
        const perRouteInput = mkNumberInput(apply.cooldownMinPerRoute,
            {min: 0, max: 1440, step: 5, width: "55px"})
        perRouteWrap.append(document.createTextNode("Per-route cooldown (min):"), perRouteInput)
        const globalWrap = document.createElement("label")
        globalWrap.style.cssText = "display:flex;gap:4px;align-items:center;"
        globalWrap.title = "Block apply on ANY route within this many minutes after the "
            + "most recent successful write — catches rapid-fire chains. Bulk applies "
            + "bypass this gate (the bulk confirm modal is your guardrail there). "
            + "0 = disabled. Default 5 minutes."
        const globalInput = mkNumberInput(apply.cooldownMinGlobal,
            {min: 0, max: 1440, step: 1, width: "55px"})
        globalWrap.append(document.createTextNode("Global cooldown (min):"), globalInput)
        const persistCd = async () => {
            const pr = parseFloat(perRouteInput.value)
            const gl = parseFloat(globalInput.value)
            apply.cooldownMinPerRoute = (isFinite(pr) && pr >= 0) ? Math.floor(pr) : 60
            apply.cooldownMinGlobal   = (isFinite(gl) && gl >= 0) ? Math.floor(gl) : 5
            this.settings.pricing.apply = apply
            try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) } catch (e) { /* ignore */ }
        }
        perRouteInput.addEventListener("change", persistCd)
        globalInput.addEventListener("change",   persistCd)
        cdRow.append(perRouteWrap, globalWrap)
        block.append(cdRow)

        // Pre-apply refresh — runs the schedule + ORS orchestrator before
        // each Apply (per-route + bulk). Catches the silent corruption
        // path where ORS reads `getOurFlightNumbers` from the legacy cache
        // and tags freshly-added routes as "not ours" — which would mislead
        // the user into picking the wrong Δ%. Two freshness floors:
        // projection (5 min default) for picking-time UI; apply (1 min
        // default) tighter floor for the live POST.
        const refreshRow = document.createElement("div")
        refreshRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:11px;color:#c4b5fd;margin-bottom:4px;"
        const refreshCb = mkInput("checkbox", null)
        refreshCb.checked = apply.refreshBeforeApply !== false
        const refreshLbl = document.createElement("label")
        refreshLbl.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer;"
        refreshLbl.title = "Runs schedule + ORS scrapes before each apply, threading the freshly-harvested "
            + "flight numbers into ORS so projections aren't fooled by a stale legacy cache. Recommended ON."
        refreshLbl.append(refreshCb, document.createTextNode("Pre-apply data refresh"))
        refreshCb.addEventListener("change", async () => {
            apply.refreshBeforeApply = !!refreshCb.checked
            this.settings.pricing.apply = apply
            try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) } catch (e) { /* ignore */ }
            this._render()
        })
        refreshRow.append(refreshLbl)
        block.append(refreshRow)

        // Tuning row — freshness floors. Hidden behind the same row as the
        // checkbox to keep the block compact; only visible when the master
        // toggle is on.
        if (refreshCb.checked) {
            const ageRow = document.createElement("div")
            ageRow.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;align-items:center;"
                + "font-size:10px;color:#9ca3af;margin:0 0 6px 18px;"
            const projAgeWrap = document.createElement("label")
            projAgeWrap.style.cssText = "display:flex;gap:4px;align-items:center;"
            projAgeWrap.title = "Skip the orchestrator pass on modal-open and the bulk-modal "
                + "Refresh visible button when cached data is fresher than this many minutes. "
                + "Default 5 minutes."
            const projAgeInput = mkNumberInput(
                isFinite(apply.refreshMaxAgeMinProjection) ? apply.refreshMaxAgeMinProjection : 5,
                {min: 0, max: 240, step: 1, width: "50px"})
            projAgeWrap.append(document.createTextNode("Projection freshness (min):"), projAgeInput)
            const applyAgeWrap = document.createElement("label")
            applyAgeWrap.style.cssText = "display:flex;gap:4px;align-items:center;"
            applyAgeWrap.title = "Skip the secondary orchestrator pass on Apply click when cached "
                + "data is fresher than this many minutes. Tighter than projection because Apply "
                + "commits real money. Default 1 minute."
            const applyAgeInput = mkNumberInput(
                isFinite(apply.refreshMaxAgeMinApply) ? apply.refreshMaxAgeMinApply : 1,
                {min: 0, max: 240, step: 1, width: "50px"})
            applyAgeWrap.append(document.createTextNode("Apply freshness (min):"), applyAgeInput)
            const persistAge = async () => {
                const pr = parseFloat(projAgeInput.value)
                const ap = parseFloat(applyAgeInput.value)
                apply.refreshMaxAgeMinProjection = (isFinite(pr) && pr >= 0) ? Math.floor(pr) : 5
                apply.refreshMaxAgeMinApply      = (isFinite(ap) && ap >= 0) ? Math.floor(ap) : 1
                this.settings.pricing.apply = apply
                try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) } catch (e) { /* ignore */ }
            }
            projAgeInput.addEventListener("change",  persistAge)
            applyAgeInput.addEventListener("change", persistAge)
            ageRow.append(projAgeWrap, applyAgeWrap)
            block.append(ageRow)
        }

        // Circuit-breaker cooldown banner. Appears only while a recent
        // 429/503 streak has tripped the breaker and the cooldown window
        // hasn't expired. Reset clears trippedAt; the next apply runs
        // without the gate.
        const cooldownMs = isFinite(apply.circuitBreakerCooldownMs) ? apply.circuitBreakerCooldownMs : 600000
        if (apply.circuitBreakerTrippedAt
            && Date.now() - apply.circuitBreakerTrippedAt < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - (Date.now() - apply.circuitBreakerTrippedAt)) / 60000)
            const banner = document.createElement("div")
            banner.style.cssText = "background:#7f1d1d33;border:1px solid #b91c1c;border-radius:3px;"
                + "padding:6px 8px;margin:4px 0;font-size:10px;color:#fecaca;display:flex;"
                + "align-items:center;justify-content:space-between;gap:6px;"
            const txt = document.createElement("div")
            txt.innerHTML = "<strong>Circuit breaker tripped.</strong> Apply will short-circuit until cooldown expires (~"
                + remaining + " min remaining). Reason: "
                + (apply.circuitBreakerHaltReason || "consecutive AS rate-limit responses") + "."
            const resetBtn = document.createElement("button")
            resetBtn.textContent = "Reset breaker"
            Object.assign(resetBtn.style, smallBtnStyle())
            resetBtn.style.background = "#7f1d1d"
            resetBtn.addEventListener("click", async () => {
                if (!confirm("Reset the pricing-apply circuit breaker? Only do this if you understand why AS was rate-limiting (e.g. you've waited a few minutes).")) return
                apply.circuitBreakerTrippedAt  = null
                apply.circuitBreakerHaltReason = null
                this.settings.pricing.apply = apply
                try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) } catch (e) { /* ignore */ }
                this._render()
            })
            banner.append(txt, resetBtn)
            block.append(banner)
        }

        // Default scope.
        const scopeWrap = document.createElement("div")
        scopeWrap.style.cssText = "margin:4px 0 6px 0;font-size:10px;color:#c4b5fd;"
        const scopeHead = document.createElement("div")
        scopeHead.textContent = "Default scope (when Apply runs):"
        scopeHead.style.cssText = "color:#9ca3af;margin-bottom:2px;"
        scopeWrap.append(scopeHead)
        const scopeRow = document.createElement("div")
        scopeRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;"
        const scopeFields = [
            ["airportPair",         "Airport pair"],
            ["flightNumbers",       "Flight numbers"],
            ["returnAirportPair",   "Return pair"],
            ["returnFlightNumbers", "Return flight numbers"]
        ]
        for (const [k, lbl] of scopeFields) {
            const cb = mkInput("checkbox", null)
            cb.checked = !!apply.defaultScope[k]
            const l = document.createElement("label")
            l.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer;"
            l.append(cb, document.createTextNode(lbl))
            cb.addEventListener("change", async () => {
                apply.defaultScope[k] = cb.checked
                this.settings.pricing.apply = apply
                try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) } catch (e) { /* ignore */ }
            })
            scopeRow.append(l)
        }
        scopeWrap.append(scopeRow)
        block.append(scopeWrap)

        // Tier 3.4 — Live-write scopes. All proven pricing write paths
        // default live; turning a box off clamps that call-site.
        const liveScopes = apply.liveScopes = Object.assign(
            {manual: true, bulk: true, silentAuto: true, bulkRecommended: true},
            apply.liveScopes || {}
        )
        const lsWrap = document.createElement("div")
        lsWrap.style.cssText = "display:flex;flex-direction:column;gap:2px;"
            + "font-size:11px;color:#c4b5fd;margin-top:6px;"
            + "border-top:1px dashed rgba(168,85,247,0.30);padding-top:6px;"
        const lsHead = document.createElement("div")
        lsHead.style.cssText = "color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;"
        lsHead.textContent = "Live-write scopes"
        lsWrap.append(lsHead)
        const lsHint = document.createElement("div")
        lsHint.style.cssText = "color:#9ca3af;font-size:10px;"
        lsHint.textContent = "Each axis can clamp independently. The top-level Apply enabled toggle still has to be on for any real write."
        lsWrap.append(lsHint)
        const lsRow = document.createElement("div")
        lsRow.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;align-items:center;"
        for (const [k, lbl, hint] of [
            ["manual",     "Manual",      "Single-route apply modal."],
            ["bulk",       "Bulk",        "Multi-row bulk apply modal."],
            ["silentAuto", "Silent-auto", "Foreground/dashboard automatic loop."],
            ["bulkRecommended", "Bulk recommended", "AS flightsPrices recommendation panel."]
        ]) {
            const l = document.createElement("label")
            l.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer;"
            l.title = hint
            const cb = mkInput("checkbox", null)
            cb.checked = !!liveScopes[k]
            l.append(cb, document.createTextNode(lbl))
            cb.addEventListener("change", async () => {
                liveScopes[k] = cb.checked
                this.settings.pricing.apply = apply
                try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) }
                catch (e) { /* ignore */ }
            })
            lsRow.append(l)
        }
        lsWrap.append(lsRow)
        block.append(lsWrap)

        // Tier 3.4 — Advanced tunables. Surfaces values previously hard-
        // coded in source (dedup window, competitor min count, ORS cache
        // age, snapshot freshness, sync timeout, stale-competitor warn
        // window). Defaults match prior baked-in behaviour. Wrapped in a
        // <details> so it's collapsed by default.
        const advWrap = document.createElement("details")
        advWrap.style.cssText = "margin-top:6px;border-top:1px dashed rgba(168,85,247,0.30);padding-top:6px;"
        const advSum = document.createElement("summary")
        advSum.textContent = "Advanced (tunables — change with care)"
        advSum.style.cssText = "cursor:pointer;color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;"
        advWrap.append(advSum)
        const advWarn = document.createElement("div")
        advWarn.style.cssText = "color:#fbbf24;font-size:10px;margin:4px 0;"
        advWarn.textContent = "These knobs can change pricing behaviour materially. Defaults match production. Reset by deleting the corresponding settings keys."
        advWrap.append(advWarn)
        const advGrid = document.createElement("div")
        advGrid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:11px;color:#c4b5fd;"
        const advField = (key, label, def, min, max, step, hint) => {
            const cur = isFinite(apply[key]) ? apply[key] : def
            const l = document.createElement("label")
            l.style.cssText = "display:flex;gap:4px;align-items:center;justify-content:space-between;"
            l.title = hint
            l.append(document.createTextNode(label))
            const inp = mkNumberInput(cur, {min, max, step, width: "60px"})
            inp.addEventListener("change", async () => {
                const v = parseFloat(inp.value)
                if (!isFinite(v)) { inp.value = String(cur); return }
                const clamped = Math.max(min, Math.min(max, v))
                apply[key] = clamped
                inp.value = String(clamped)
                this.settings.pricing.apply = apply
                try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) }
                catch (e) { /* ignore */ }
            })
            l.append(inp)
            advGrid.append(l)
        }
        advField("pricingApplyLogDedupWindowMin",        "Dedup window (min)",        5,     0,    60,  1,
            "Collapse identical apply-log entries within this window into one with a count. 0 = disable dedup.")
        advField("preApplySyncTimeoutMs",                "Pre-apply sync timeout (ms)", 30000, 5000, 300000, 1000,
            "Hard timeout for the pre-apply orchestrator pass. On timeout the apply continues with cached data.")
        advField("silentAutoCompetitorMinCount",         "Silent-auto · min competitors", 2,    1,    10,  1,
            "Competitor-median proposer requires at least this many competitor Y prices before computing a median.")
        advField("silentAutoOrsMaxAgeMin",               "Silent-auto · ORS max age (min)", 60,   1,    1440, 5,
            "ors-elasticity proposer skips routes whose ORS cache is older than this. Stale ORS = bad projections.")
        advField("silentAutoStrategySnapshotMaxAgeMin",  "Silent-auto · strategy snapshot age (min)", 10, 0, 240, 5,
            "Reuse the AesStrategy snapshot for this many minutes before rebuilding. Snapshots are network-wide; rebuilding is mildly expensive.")
        advField("silentAutoStaleCompetitorWarnDays",    "Silent-auto · stale competitor warn (days)", 7, 0,  90, 1,
            "Surface a warning in the silent-auto trace when the last bulk competitor scrape is older than this. 0 = disabled.")
        advWrap.append(advGrid)
        const blockOnStaleRow = document.createElement("label")
        blockOnStaleRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:11px;color:#c4b5fd;margin-top:6px;"
        blockOnStaleRow.title = "When on, silent-auto refuses to apply when competitor data is older than the warn window above."
        const blockOnStaleCb = mkInput("checkbox", null)
        blockOnStaleCb.checked = !!apply.silentAutoBlockOnStaleCompetitors
        blockOnStaleRow.append(blockOnStaleCb,
            document.createTextNode("Block silent-auto when competitor data exceeds the warn window"))
        blockOnStaleCb.addEventListener("change", async () => {
            apply.silentAutoBlockOnStaleCompetitors = blockOnStaleCb.checked
            this.settings.pricing.apply = apply
            try { await RouteAssistantSettings.save({pricing: this.settings.pricing}) }
            catch (e) { /* ignore */ }
        })
        advWrap.append(blockOnStaleRow)
        block.append(advWrap)

        // Bulk-apply CTA.
        const bulkBtn = document.createElement("button")
        bulkBtn.textContent = "Open bulk apply…"
        Object.assign(bulkBtn.style, smallBtnStyle())
        bulkBtn.style.background = "#7c3aed"
        bulkBtn.disabled = !this.hubIata || !(this.rows && this.rows.length)
        bulkBtn.addEventListener("click", () => this._openBulkPricingApplyModal())
        block.append(bulkBtn)

        // Recent applies log preview + Open audit log CTA.
        if (apply.showRecentApplies) {
            const logHeaderRow = document.createElement("div")
            logHeaderRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
                + "gap:8px;margin-top:8px;margin-bottom:2px;"
            const logHeader = document.createElement("div")
            logHeader.style.cssText = "color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;"
            logHeader.textContent = "Recent applies (preview)"
            const auditBtn = document.createElement("button")
            auditBtn.textContent = "Open audit log…"
            Object.assign(auditBtn.style, smallBtnStyle())
            auditBtn.style.fontSize = "10px"
            auditBtn.title = "Open the full audit log: every apply (manual, silent-auto, sandbox, batch) "
                + "with filters, per-route history, and JSON/CSV export."
            auditBtn.addEventListener("click", () => this._openAuditLogModal())
            logHeaderRow.append(logHeader, auditBtn)
            block.append(logHeaderRow)

            const logHost = document.createElement("div")
            logHost.style.cssText = "margin-top:4px;font-size:10px;color:#9ca3af;"
            logHost.textContent = "Loading apply log…"
            block.append(logHost)
            this._refreshTier3LogPreview(logHost, apply.recentApplyPreviewCount || 10)
        }

        return block
    }

    window.RouteAssistantPanel.prototype._buildAuditPricesTable = function(e) {
        const classes = ["Y", "C", "F", "Cargo"]
        const prev = e.prevPrices     || {}
        const next = e.newPrices      || e.requestedPrices || {}
        const ver  = e.verifiedPrices || {}
        let any = false
        const tbl = document.createElement("div")
        tbl.style.cssText = "display:grid;grid-template-columns:48px 1fr 1.4fr 1fr;gap:4px 12px;"
            + "background:rgba(15,23,42,0.50);border:1px solid #1f2937;border-radius:3px;"
            + "padding:6px 10px;font-variant-numeric:tabular-nums;"
        for (const h of ["", "Was", "→ Requested", "Verified"]) {
            const c = document.createElement("div")
            c.textContent = h
            c.style.cssText = "color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;"
            tbl.append(c)
        }
        for (const cls of classes) {
            const p = prev[cls], n = next[cls], v = ver[cls]
            if (p == null && n == null && v == null) continue
            any = true
            const cn = document.createElement("div")
            cn.textContent = cls
            cn.style.cssText = "color:#cbd5e1;font-weight:600;"
            const cp = document.createElement("div")
            cp.textContent = p != null ? String(p) : "—"
            cp.style.cssText = "color:#cbd5e1;"
            const cnp = document.createElement("div")
            cnp.style.cssText = "color:#cbd5e1;"
            if (p != null && n != null && p !== n) {
                const dPct = p > 0 ? ((n - p) / p * 100) : 0
                const moveColor = n > p ? "#86efac" : "#fcd34d"
                cnp.innerHTML = String(n) + " <span style=\"color:" + moveColor + "\">("
                    + (n > p ? "+" : "") + dPct.toFixed(1) + "%)</span>"
            } else {
                cnp.textContent = n != null ? String(n) : "—"
            }
            const cv = document.createElement("div")
            cv.style.cssText = "color:#cbd5e1;"
            if (v != null && n != null && Math.round(v) !== Math.round(n)) {
                cv.innerHTML = "<span style=\"color:#fca5a5\">" + v + " (mismatch)</span>"
            } else {
                cv.textContent = v != null ? String(v) : "—"
            }
            tbl.append(cn, cp, cnp, cv)
        }
        return any ? tbl : null
    }

    /**
     * Pricing diagnostics block — single-glance status of WHY (or
     * whether) prices are changing. Three sections:
     *   1. Outcome banner  — one sentence about what WILL happen
     *   2. Pipeline gates  — checklist of dry-run / apply-enabled /
     *                        breaker / silent-auto / mute, with one-line
     *                        fix copy per blocked gate
     *   3. Data health     — hub + visible-route counts at each stage
     *                        of the silent-auto eligibility filter so
     *                        the user can see whether the loop is fed
     *
     * The Tier 3 + silent-auto blocks below own the actual toggles;
     * this one is purely a diagnostic.
     */
    window.RouteAssistantPanel.prototype._renderPricingDiagnostics = function(cfg) {
        const apply = (cfg && cfg.apply) || {}
        const sa = this._silentAutoCfg()
        const now = Date.now()
        const breakerMs = apply.circuitBreakerCooldownMs || 600000
        const breakerCooling = !!apply.circuitBreakerTrippedAt
            && (now - apply.circuitBreakerTrippedAt) < breakerMs
        const breakerRemainingMin = breakerCooling
            ? Math.ceil((breakerMs - (now - apply.circuitBreakerTrippedAt)) / 60000)
            : 0
        const muted = !!sa.silentAutoMutedUntil && sa.silentAutoMutedUntil > now
        const muteRemainingMin = muted ? Math.ceil((sa.silentAutoMutedUntil - now) / 60000) : 0
        const dryRunOnly = apply.dryRunOnly === true
        const applyEnabled = !!apply.enabled
        const writesUnlocked = !dryRunOnly && applyEnabled && !breakerCooling
        // Silent-auto needs a third gate beyond the manual-write pair:
        // `apply.liveScopes.silentAuto` must be true. Without it the loop
        // ticks but every proposal lands as `dry-run` even when the other
        // two gates are open — easy to miss because the manual + bulk
        // apply paths still POST. Surface the third gate explicitly so
        // the banner can enumerate every blocker for silent-auto, not
        // just the first one it hits.
        const liveScopes = apply.liveScopes || {}
        const silentAutoScopeLive = liveScopes.silentAuto !== false

        const block = document.createElement("div")
        block.setAttribute("data-aes-pricing-diagnostics", "1")
        block.style.cssText = "margin-top:8px;padding:8px 10px;"
            + "background:rgba(56, 189, 248, 0.06);"
            + "border:1px solid rgba(56, 189, 248, 0.30);border-radius:4px;"

        const head = document.createElement("div")
        head.style.cssText = "color:#7dd3fc;font-size:11px;margin-bottom:6px;font-weight:600;"
        head.textContent = "Pricing diagnostics"
        block.append(head)

        const cadenceLabel = this._silentAutoCadenceLabel(sa)
        block.append(this._buildPricingOutcomeBanner({
            writesUnlocked, applyEnabled, dryRunOnly,
            silentAutoEnabled: sa.silentAutoEnabled,
            silentAutoScopeLive,
            breakerCooling, breakerRemainingMin,
            muted, muteRemainingMin,
            cadenceLabel
        }))

        // ----- Pipeline gates checklist
        const gates = document.createElement("div")
        gates.style.cssText = "background:rgba(15, 23, 42, 0.55);"
            + "border:1px solid #1f2937;border-radius:3px;"
            + "padding:6px 8px;font-size:11px;color:#cbd5e1;"
            + "margin:6px 0;display:flex;flex-direction:column;gap:2px;"
        const gatesTitle = document.createElement("div")
        gatesTitle.style.cssText = "color:#94a3b8;font-size:10px;"
            + "text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px;"
        gatesTitle.textContent = "Pipeline gates"
        gates.append(gatesTitle)
        gates.append(this._buildPricingDiagnosticsGate({
            ok:    !dryRunOnly,
            label: "Dry-run only",
            state: dryRunOnly ? "ON" : "off",
            hint:  dryRunOnly
                ? "Preflight + body run, but POST is skipped. Toggle off below to commit real writes."
                : null
        }))
        gates.append(this._buildPricingDiagnosticsGate({
            ok:    applyEnabled,
            label: "Apply enabled",
            state: applyEnabled ? "on" : "OFF",
            hint:  !applyEnabled
                ? "Top-level kill switch — flip on below to commit real writes."
                : null
        }))
        gates.append(this._buildPricingDiagnosticsGate({
            ok:    !breakerCooling,
            label: "Circuit breaker",
            state: breakerCooling ? ("tripped (" + breakerRemainingMin + " min)") : "armed",
            hint:  breakerCooling
                ? "Wait for cooldown, or use Reset breaker in the Tier 3 block."
                : null
        }))
        gates.append(this._buildPricingDiagnosticsGate({
            ok:    sa.silentAutoEnabled,
            label: "Silent-auto loop",
            state: sa.silentAutoEnabled
                ? ("running · " + cadenceLabel + " cadence")
                : "off",
            hint:  !sa.silentAutoEnabled
                ? "Manual Apply still works. Enable below for autonomous ticks."
                : null
        }))
        if (sa.silentAutoEnabled) {
            gates.append(this._buildPricingDiagnosticsGate({
                ok:    silentAutoScopeLive,
                label: "Live writes → Silent-auto",
                state: silentAutoScopeLive ? "on" : "OFF",
                hint:  !silentAutoScopeLive
                    ? "Third gate, separate from manual writes. Tick the Silent-auto checkbox under Live writes scopes to commit loop ticks."
                    : null
            }))
            gates.append(this._buildPricingDiagnosticsGate({
                ok:    !muted,
                label: "Auto-mute",
                state: muted ? ("active (" + muteRemainingMin + " min)") : "inactive",
                hint:  muted
                    ? "Auto-disabled after 5 consecutive failures. Click Resume now in the silent-auto block."
                    : null
            }))
        }
        block.append(gates)

        // ----- Data health
        const stats = this._computePricingDiagnostics(sa.silentAutoFollowMode)
        const data = document.createElement("div")
        data.style.cssText = gates.style.cssText
        const dataTitle = document.createElement("div")
        dataTitle.style.cssText = gatesTitle.style.cssText
        dataTitle.textContent = "Data health · hub " + (this.hubIata || "?")
        data.append(dataTitle)
        const ageBulk = cfg.lastBulkScrapeAt
            ? Math.round((now - cfg.lastBulkScrapeAt) / 60000) + " min ago"
            : "never"
        data.append(this._buildPricingDiagnosticsLine("Visible routes", stats.totalRows))
        data.append(this._buildPricingDiagnosticsLine(
            "Cached own pricing",
            stats.withOwnPricing + " (last bulk sync " + ageBulk + ")",
            stats.withOwnPricing === 0
                ? "Click Sync live route data above to populate own-pricing cache."
                : null
        ))
        data.append(this._buildPricingDiagnosticsLine(
            "≥2 cached competitors (Y)",
            stats.withCompetitors,
            stats.withCompetitors === 0 && stats.withOwnPricing > 0
                ? "Competitor medians improve the per-class proposer and are required only by the Y-only competitor-median strategy."
                : null
        ))
        data.append(this._buildPricingDiagnosticsLine("Watchlisted (★)", stats.starred))
        data.append(this._buildPricingDiagnosticsLine(
            "Manual price pins",
            stats.pinned,
            stats.pinned > 0
                ? "Pinned routes are excluded from silent-auto until the pin is cleared or expires."
                : null
        ))
        const followLabel = sa.silentAutoFollowMode === "all" ? "all routes" : "watchlist"
        data.append(this._buildPricingDiagnosticsLine(
            "Eligible right now (follow: " + followLabel + ")",
            stats.eligible,
            stats.eligible === 0 && sa.silentAutoEnabled
                ? "Silent-auto would skip every tick — no routes pass the eligibility filter."
                : null
        ))
        block.append(data)

        // ----- Run-now CTA
        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:8px;align-items:center;"
            + "flex-wrap:wrap;font-size:11px;color:#94a3b8;margin-top:6px;"
        const verboseBtn = document.createElement("button")
        verboseBtn.textContent = this._silentAutoRunning
            ? "Tick in flight…"
            : "▶ Run silent-auto now"
        Object.assign(verboseBtn.style, smallBtnStyle())
        verboseBtn.style.fontSize = "11px"
        const cantRun = !sa.silentAutoEnabled || !!this._silentAutoRunning
        verboseBtn.disabled = cantRun
        verboseBtn.title = !sa.silentAutoEnabled
            ? "Enable silent-auto in the block below before firing a tick."
            : "Fire one silent-auto tick immediately. Results land in the activity feed below with a per-route trace."
        verboseBtn.addEventListener("click", async () => {
            verboseBtn.disabled = true
            verboseBtn.textContent = "Ticking…"
            try { await this._silentAutoTickNow() }
            finally {
                verboseBtn.disabled = false
                verboseBtn.textContent = "▶ Run silent-auto now"
            }
        })
        ctrlRow.append(verboseBtn)
        if (sa.silentAutoLastTickAt) {
            const ago = this._formatSilentAutoElapsed(now - sa.silentAutoLastTickAt)
            const lbl = document.createElement("span")
            lbl.textContent = "Last tick " + ago + " ago"
            ctrlRow.append(lbl)
        }
        block.append(ctrlRow)

        return block
    }

    /**
     * Compact one-line auto-pricing pill rendered in the panel statusBar.
     * Always visible regardless of Settings drawer state — answers "is the
     * pipeline armed and what scopes are live?" at a glance. Click expands
     * the Settings drawer and scrolls to Auto-Pricing diagnostics.
     */
    window.RouteAssistantPanel.prototype._renderAutoPricingPill = function(host) {
        if (!host) return
        host.innerHTML = ""
        const pricing = (this.settings && this.settings.pricing) || {}
        const apply = pricing.apply || {}
        const sa = this._silentAutoCfg()
        const now = Date.now()
        const breakerMs = isFinite(apply.circuitBreakerCooldownMs) ? apply.circuitBreakerCooldownMs : 600000
        const breakerCooling = !!apply.circuitBreakerTrippedAt
            && (now - apply.circuitBreakerTrippedAt) < breakerMs
        const breakerRemainingMin = breakerCooling
            ? Math.ceil((breakerMs - (now - apply.circuitBreakerTrippedAt)) / 60000)
            : 0
        const muted = !!sa.silentAutoMutedUntil && sa.silentAutoMutedUntil > now
        const muteRemainingMin = muted ? Math.ceil((sa.silentAutoMutedUntil - now) / 60000) : 0
        const dryRunOnly = apply.dryRunOnly === true
        const applyEnabled = !!apply.enabled
        const writesUnlocked = !dryRunOnly && applyEnabled && !breakerCooling
        const liveScopes = apply.liveScopes || {}
        const manualLive = writesUnlocked && liveScopes.manual !== false
        const bulkLive   = writesUnlocked && !!liveScopes.bulk
        const autoLive   = writesUnlocked && !!liveScopes.silentAuto && !!sa.silentAutoEnabled

        let dot, fg, label, tooltip
        if (breakerCooling) {
            dot = "#ef4444"; fg = "#fca5a5"
            label = "Pricing: breaker (" + breakerRemainingMin + "m)"
            tooltip = "Circuit breaker tripped after consecutive AS rate-limit responses. "
                + "Resets in " + breakerRemainingMin + " min, or click to expand and Reset breaker manually."
        } else if (muted && sa.silentAutoEnabled) {
            dot = "#ef4444"; fg = "#fca5a5"
            label = "Pricing: muted (" + muteRemainingMin + "m)"
            tooltip = "Silent-auto auto-muted after 5 consecutive failures. Click to expand and Resume."
        } else if (autoLive) {
            dot = "#22c55e"; fg = "#86efac"
            const scopes = ["M", bulkLive ? "B" : "", "A"].filter(Boolean).join("+")
            const ago = sa.silentAutoLastTickAt
                ? this._formatSilentAutoElapsed(now - sa.silentAutoLastTickAt)
                : "—"
            label = "Pricing: live (" + scopes + ") · tick " + ago
            tooltip = "Live writes: manual" + (bulkLive ? " + bulk" : "") + " + silent-auto. "
                + "Last tick " + ago + " ago · cadence " + this._silentAutoCadenceLabel(sa) + ". Click to expand."
        } else if (manualLive) {
            dot = "#22c55e"; fg = "#86efac"
            const scopes = ["M", bulkLive ? "B" : ""].filter(Boolean).join("+")
            label = "Pricing: live (" + scopes + ")"
            tooltip = "Manual" + (bulkLive ? " + bulk" : "") + " writes live; silent-auto loop is OFF. Click to expand."
        } else if (sa.silentAutoEnabled) {
            dot = "#fbbf24"; fg = "#fcd34d"
            label = "Pricing: dry-run loop"
            tooltip = "Silent-auto ticking on " + this._silentAutoCadenceLabel(sa) + " cadence but writes are gated. "
                + (dryRunOnly ? "Turn OFF Dry-run only" : (!applyEnabled ? "Turn ON Apply enabled"
                    : "Turn ON liveScopes.silentAuto")) + " in Settings to commit. Click to expand."
        } else if (dryRunOnly && applyEnabled) {
            dot = "#fbbf24"; fg = "#fcd34d"
            label = "Pricing: dry-run only"
            tooltip = "Apply paths exercise the full pipeline but skip POST. "
                + "Turn OFF Dry-run only in Settings to commit. Click to expand."
        } else {
            dot = "#9ca3af"; fg = "#cbd5e1"
            label = "Pricing: off"
            tooltip = "No automation enabled. Manual route applies are gated until you turn ON Apply enabled. Click to expand."
        }

        const pill = document.createElement("button")
        pill.type = "button"
        pill.style.cssText = "display:inline-flex;align-items:center;gap:6px;"
            + "padding:1px 8px;background:transparent;border:1px solid " + dot + ";"
            + "border-radius:11px;color:" + fg + ";font-size:11px;cursor:pointer;"
            + "font-family:var(--aes-font-mono);letter-spacing:0.02em;line-height:1.5;"
        pill.title = tooltip
        const dotEl = document.createElement("span")
        dotEl.style.cssText = "display:inline-block;width:8px;height:8px;border-radius:50%;background:" + dot
        pill.append(dotEl, document.createTextNode(label))
        pill.addEventListener("click", () => this._jumpToAutoPricingSection())
        host.append(pill)
    }

    /**
     * Light refresh that updates the pill in place without rebuilding the
     * entire statusBar. No-op if the pill host hasn't been created yet
     * (statusBar is lazy — built only after `mount` runs `refresh`).
     */
    window.RouteAssistantPanel.prototype._refreshAutoPricingPill = function() {
        if (!this.statusBar) return
        const host = this.statusBar.querySelector("[data-aes-auto-pricing-pill]")
        if (!host) return
        this._renderAutoPricingPill(host)
    }

    window.RouteAssistantPanel.prototype._openPricingApplyModal = function(args) {
        if (!args || !args.hub || !args.dest) return
        this._closePricingApplyModal()
        const hub  = String(args.hub).toUpperCase()
        const dest = String(args.dest).toUpperCase()
        const source = args.source || "manual"
        const sandboxScenario   = args.sandboxScenario   || null
        const projectedDelta    = args.projectedDelta    || null
        const sandboxProjected  = args.sandboxProjected  || null
        const sandboxModelParams = args.sandboxModelParams || null

        let cachedOwn = this._lookupCachedOwnPricing(hub, dest)
        const cur = Object.assign({}, (cachedOwn && cachedOwn.prices) || {})
        const sliderRanges = Object.assign({}, (cachedOwn && cachedOwn.sliderRanges) || {})
        const prefilled = args.prefilledPrices || {}

        const seedPrice = (cls) => {
            if (prefilled[cls] != null) return prefilled[cls]
            if (cur[cls] != null) return cur[cls]
            return ""
        }

        const overlay = document.createElement("div")
        overlay.id = "aes-pricing-apply-modal"
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;"
            + "display:flex;align-items:flex-start;justify-content:center;padding:60px 20px 20px 20px;"

        const dialog = document.createElement("div")
        dialog.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #475569;"
            + "border-radius:6px;padding:14px 18px;width:560px;max-width:95vw;font:12px/1.4 sans-serif;"
            + "max-height:calc(100vh - 80px);overflow-y:auto;box-shadow:0 12px 36px rgba(0,0,0,0.5);"

        const apply = (this.settings.pricing && this.settings.pricing.apply) || {}
        const dryRunOnly = apply.dryRunOnly === true
        const manualGate = this._pricingApplyGate("manual")
        const stage = dryRunOnly ? "Dry-run only"
            : (!manualGate.applyEnabled ? "Live writes disabled"
                : (manualGate.scopeLiveAllowed ? "LIVE writes" : "Manual scope dry-run"))
        const stageColor = dryRunOnly ? "#fbbf24"
            : (manualGate.liveWrites ? "#34d399" : "#9ca3af")

        const close = () => this._closePricingApplyModal()
        const onKey = (e) => { if (e.key === "Escape") close() }
        const onOverlayClick = (e) => { if (e.target === overlay) close() }

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;"
        const title = document.createElement("div")
        title.innerHTML = "<strong style='font-size:13px;'>Apply price · " + hub + "→" + dest + "</strong>"
            + "<div style='color:#9ca3af;font-size:10px;margin-top:2px;'>"
            + "source: " + source
            + (sandboxScenario ? " · sandbox scenario attached" : "")
            + "</div>"
        const stageBadge = document.createElement("span")
        stageBadge.textContent = stage
        stageBadge.style.cssText = "color:" + stageColor + ";font-size:10px;padding:2px 6px;"
            + "border:1px solid " + stageColor + "55;border-radius:3px;background:" + stageColor + "10;"
        head.append(title, stageBadge)
        dialog.append(head)

        const cacheNoteEl = document.createElement("div")
        cacheNoteEl.style.cssText = "color:#6b7280;font-size:10px;margin-bottom:4px;"
        const refreshCacheNote = () => {
            if (cachedOwn && cachedOwn.scrapedAt) {
                const ageMs   = Date.now() - cachedOwn.scrapedAt
                const ageMin  = ageMs / 60000
                const ageDays = ageMs / 86400000
                const ageStr = ageMin < 1 ? "just now"
                    : ageMin < 60 ? Math.round(ageMin) + "m ago"
                    : ageDays < 1 ? Math.round(ageMin / 60) + "h ago"
                    : Math.round(ageDays) + "d ago"
                cacheNoteEl.textContent = "Cached pricing snapshot from " + new Date(cachedOwn.scrapedAt).toLocaleString()
                    + " (" + ageStr + ")"
                cacheNoteEl.style.color = ageMin < 5 ? "#34d399" : "#6b7280"
            } else {
                cacheNoteEl.textContent = "No cached pricing — Apply will fetch live form context from /app/com/markets/" + hub + dest
                cacheNoteEl.style.color = "#9ca3af"
            }
        }
        refreshCacheNote()
        dialog.append(cacheNoteEl)

        const pricesGrid = document.createElement("div")
        pricesGrid.style.cssText = "display:grid;grid-template-columns:auto 1fr auto auto;gap:6px 12px;"
            + "align-items:center;margin:8px 0;"
        const inputs = {}
        const curEls = {}
        const updateDeltas = {}
        for (const h of ["Class", "New", "Current", "Δ%"]) {
            const th = document.createElement("div")
            th.textContent = h
            th.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;"
            pricesGrid.append(th)
        }
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const lbl = document.createElement("div")
            lbl.textContent = cls
            lbl.style.cssText = "color:#cbd5e1;font-weight:600;"
            const input = document.createElement("input")
            input.type = "number"
            input.min = "0"
            input.step = cls === "Cargo" ? "0.01" : "1"
            input.value = seedPrice(cls) === "" ? "" : this._formatRoutePrice(cls, seedPrice(cls))
            input.style.cssText = "width:100%;background:#1f2937;color:#f3f4f6;border:1px solid #374151;"
                + "border-radius:3px;padding:3px 6px;font-size:12px;font-variant-numeric:tabular-nums;"
            inputs[cls] = input
            const curEl = document.createElement("span")
            curEl.textContent = cur[cls] != null ? this._formatRoutePrice(cls, cur[cls]) : "—"
            curEl.style.cssText = "color:#9ca3af;font-variant-numeric:tabular-nums;text-align:right;"
            curEls[cls] = curEl
            const deltaEl = document.createElement("span")
            deltaEl.style.cssText = "color:#cbd5e1;font-variant-numeric:tabular-nums;font-size:11px;text-align:right;min-width:60px;"
            const updateDelta = () => {
                const newV = this._parseRoutePriceInput(cls, input.value)
                const c = cur[cls]
                if (!isFinite(newV) || c == null || c <= 0) { deltaEl.textContent = ""; return }
                const pct = ((newV - c) / c) * 100
                const sign = pct > 0 ? "+" : ""
                deltaEl.textContent = sign + pct.toFixed(1) + "%"
                deltaEl.style.color = Math.abs(pct) >= (apply.warnAboveDeltaPct || 5)
                    ? (Math.abs(pct) >= (apply.requireConfirmAboveDeltaPct || 15) ? "#f87171" : "#fbbf24")
                    : "#9ca3af"
            }
            updateDeltas[cls] = updateDelta
            updateDelta()
            input.addEventListener("input", updateDelta)
            const r = sliderRanges[cls]
            if (r) lbl.title = cls + " allowed range " + r[0] + " – " + r[1]
            // Detect cargo-incapable routes: when no current cargo price AND
            // no slider range AND no seed value, AS doesn't accept a cargo
            // price for this route. Disable the input so accidental entry
            // doesn't produce a body that AS rejects (or worse, silently
            // drops). The detection is per-modal-open — the refreshCacheNote
            // path below will re-evaluate after a Refresh data click.
            if (cls === "Cargo" && cur[cls] == null && !r && (seedPrice(cls) === "" || seedPrice(cls) == null)) {
                input.disabled = true
                input.placeholder = "n/a"
                input.title = "This route does not carry cargo (no current price, no slider range)."
                lbl.style.color = "#6b7280"
                lbl.title = "Cargo not offered on this route"
            }
            pricesGrid.append(lbl, input, curEl, deltaEl)
        }
        dialog.append(pricesGrid)

        // Re-paint Current column + Δ% display after a fresh orchestrator
        // pass updates the cached snapshot. Inputs that the user has not
        // touched (still equal old cur) follow to the new cur — that way
        // a freshly-opened modal seeds off fresh data instead of stale,
        // but a user who has already typed a custom price is not stomped.
        const applyCachedSnapshot = () => {
            if (!this._pricingApplyModal || this._pricingApplyModal.overlay !== overlay) return
            const fresh = this._lookupCachedOwnPricing(hub, dest)
            if (!fresh) return
            cachedOwn = fresh
            const freshPrices = fresh.prices || {}
            const freshRanges = fresh.sliderRanges || {}
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const old  = cur[cls]
                const next = freshPrices[cls]
                if (curEls[cls]) curEls[cls].textContent = next != null ? this._formatRoutePrice(cls, next) : "—"
                const inputVal = this._parseRoutePriceInput(cls, inputs[cls].value)
                const inputMatchedOld = old != null && isFinite(inputVal)
                    && this._pricesEqualForClass(cls, inputVal, old)
                cur[cls] = next != null ? next : null
                if (inputMatchedOld && next != null) inputs[cls].value = this._formatRoutePrice(cls, next)
                if (freshRanges[cls]) sliderRanges[cls] = freshRanges[cls]
                if (updateDeltas[cls]) updateDeltas[cls]()
                if (cls === "Cargo" && inputs[cls]) {
                    // Re-evaluate cargo-capability after refresh: if AS now
                    // reports a cargo price or range, re-enable the input.
                    const stillIncapable = cur[cls] == null && !sliderRanges[cls]
                    inputs[cls].disabled = stillIncapable
                    if (!stillIncapable) inputs[cls].placeholder = ""
                }
            }
            refreshCacheNote()
        }

        const scopeWrap = document.createElement("div")
        scopeWrap.style.cssText = "margin:8px 0 6px 0;padding:6px 8px;background:rgba(255,255,255,0.02);"
            + "border:1px solid #1f2937;border-radius:3px;"
        const scopeHead = document.createElement("div")
        scopeHead.textContent = "Apply scope"
        scopeHead.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;"
        scopeWrap.append(scopeHead)
        const scopeRow = document.createElement("div")
        scopeRow.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;font-size:11px;"
        const scopeBoxes = {}
        const defaultScope = (apply.defaultScope) || {airportPair: true, flightNumbers: true}
        for (const [k, lbl] of [
            ["airportPair", "Airport pair"], ["flightNumbers", "Flight numbers"],
            ["returnAirportPair", "Return pair"], ["returnFlightNumbers", "Return FN"]]) {
            const cb = mkInput("checkbox", null)
            cb.checked = !!defaultScope[k]
            scopeBoxes[k] = cb
            const l = document.createElement("label")
            l.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer;color:#cbd5e1;"
            l.append(cb, document.createTextNode(lbl))
            scopeRow.append(l)
        }
        scopeWrap.append(scopeRow)
        dialog.append(scopeWrap)

        const reasonWrap = document.createElement("div")
        reasonWrap.style.cssText = "margin:6px 0;"
        const reasonLbl = document.createElement("div")
        reasonLbl.textContent = "Reason (optional, persisted to audit log)"
        reasonLbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;"
        const reasonInput = document.createElement("input")
        reasonInput.type = "text"
        reasonInput.maxLength = 240
        reasonInput.placeholder = "e.g. cutting Y after AA price drop, monitoring 2-week trial"
        reasonInput.style.cssText = "width:100%;background:#1f2937;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box;"
        reasonWrap.append(reasonLbl, reasonInput)
        dialog.append(reasonWrap)

        if (projectedDelta) {
            const proj = document.createElement("div")
            proj.style.cssText = "margin:6px 0;padding:6px 8px;background:rgba(168, 85, 247, 0.06);"
                + "border:1px solid rgba(168, 85, 247, 0.30);border-radius:3px;"
            const ph = document.createElement("div")
            ph.textContent = "Sandbox projection"
            ph.style.cssText = "color:#c4b5fd;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;"
            proj.append(ph)
            const fmt = (v, kind) => {
                if (kind === "money")  return (v >= 0 ? "+" : "") + "$" + Math.abs(Math.round(v))
                if (kind === "share")  return (v >= 0 ? "+" : "") + (Math.round(v * 1000) / 10) + "pp"
                if (kind === "rating") return (v >= 0 ? "+" : "") + (Math.round(v * 10) / 10)
                return (v >= 0 ? "+" : "") + Math.round(v)
            }
            const parts = []
            if (projectedDelta.paxPerWeek    != null) parts.push("pax " + fmt(projectedDelta.paxPerWeek))
            if (projectedDelta.profitPerWeek != null) parts.push("profit " + fmt(projectedDelta.profitPerWeek, "money") + "/wk")
            if (projectedDelta.share         != null) parts.push("share "  + fmt(projectedDelta.share, "share"))
            if (projectedDelta.rating        != null) parts.push("rating " + fmt(projectedDelta.rating, "rating"))
            const body = document.createElement("div")
            body.textContent = parts.join("  ·  ")
            body.style.cssText = "color:#e5e7eb;font-size:11px;font-variant-numeric:tabular-nums;"
            proj.append(body)
            dialog.append(proj)
        }

        const preflightHost = document.createElement("div")
        preflightHost.style.cssText = "margin:8px 0;"
        dialog.append(preflightHost)

        const bodyDetails = document.createElement("details")
        bodyDetails.style.cssText = "margin:6px 0;font-size:10px;color:#9ca3af;"
        const bodySummary = document.createElement("summary")
        bodySummary.textContent = "What gets posted (raw form body preview)"
        bodySummary.style.cssText = "cursor:pointer;color:#9ca3af;"
        const bodyPre = document.createElement("pre")
        bodyPre.style.cssText = "white-space:pre-wrap;word-break:break-all;font:10px/1.4 monospace;"
            + "color:#94a3b8;background:#0a0f1a;padding:6px 8px;border-radius:3px;margin-top:4px;max-height:120px;overflow-y:auto;"
        bodyPre.textContent = "(populates after Apply preflight)"
        bodyDetails.append(bodySummary, bodyPre)
        dialog.append(bodyDetails)

        const actionRow = document.createElement("div")
        actionRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:10px;"
            + "padding-top:8px;border-top:1px solid #1f2937;"
        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        cancelBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #374151;"
            + "border-radius:3px;padding:5px 14px;font-size:11px;cursor:pointer;"
        cancelBtn.addEventListener("click", close)

        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = "Refresh data"
        refreshBtn.title = "Run schedule + ORS scrapes for this route now. "
            + "Updates the Current column, sandbox projections, and the apply cooldown gate."
        refreshBtn.style.cssText = "background:#1e3a5f;color:#bfdbfe;border:1px solid #1d4ed8;"
            + "border-radius:3px;padding:5px 14px;font-size:11px;cursor:pointer;"

        const liveAvailable = manualGate.liveWrites
        const applyBtn = document.createElement("button")
        applyBtn.textContent = liveAvailable ? "Apply" : "Apply (gated)"
        applyBtn.disabled    = !liveAvailable
        applyBtn.title       = liveAvailable
            ? "POST new prices to AS"
            : (dryRunOnly
                ? "Dry-run gate is on. Settings → Auto-Pricing → Tier 3 · Apply: turn off \"Dry-run only\" to commit a write."
                : (!manualGate.applyEnabled
                    ? "Apply enabled is off. Settings → Auto-Pricing → Tier 3 · Apply: flip \"Apply enabled\" to commit a write."
                    : "Manual live scope is off. Settings → Auto-Pricing → live scopes: enable Manual to commit a write."))
        applyBtn.style.cssText = "background:" + (liveAvailable ? "#7c3aed" : "#374151") + ";"
            + "color:" + (liveAvailable ? "#fff" : "#9ca3af") + ";"
            + "border:1px solid " + (liveAvailable ? "#6d28d9" : "#475569") + ";"
            + "border-radius:3px;padding:5px 14px;font-size:11px;"
            + "cursor:" + (liveAvailable ? "pointer" : "not-allowed") + ";"

        actionRow.append(cancelBtn, refreshBtn, applyBtn)
        dialog.append(actionRow)

        // Spinner overlay used during the orchestrator pre-apply pass.
        // Gates user input on the dialog itself (z-index'd above the modal
        // body) so the user cannot click Apply mid-refresh against partial
        // data. Created lazily; toggled via `setRefreshing()`.
        const spinnerOverlay = document.createElement("div")
        spinnerOverlay.style.cssText = "position:absolute;inset:0;background:rgba(15, 22, 35, 0.65);"
            + "display:none;align-items:center;justify-content:center;border-radius:6px;z-index:1;"
        const spinnerBox = document.createElement("div")
        spinnerBox.style.cssText = "color:#bfdbfe;font-size:12px;background:#0b1220;"
            + "border:1px solid #1e3a5f;border-radius:4px;padding:10px 16px;"
        spinnerBox.textContent = "Refreshing schedule + ORS…"
        spinnerOverlay.append(spinnerBox)
        // Position the dialog as the spinner anchor.
        dialog.style.position = "relative"
        dialog.append(spinnerOverlay)

        const setRefreshing = (on, message) => {
            if (on) {
                spinnerBox.textContent = message || "Refreshing schedule + ORS…"
                spinnerOverlay.style.display = "flex"
                refreshBtn.disabled = true
                applyBtn.disabled   = true
            } else {
                spinnerOverlay.style.display = "none"
                refreshBtn.disabled = false
                applyBtn.disabled   = !liveAvailable
            }
        }

        // Run the orchestrator pre-apply pass for this single route, then
        // re-paint the Current column / Δ% / cache-age note. Detached-DOM
        // safe — the helper itself guards against writes after the modal
        // is closed (see `applyCachedSnapshot` above).
        const runPreApplyRefresh = async (maxAgeMin, headline) => {
            setRefreshing(true, headline)
            let result = null
            try {
                result = await this._orchestratorPreApplySync([{hub, dest}], {
                    maxAgeMin:       isFinite(maxAgeMin) ? maxAgeMin : 0,
                    progressId:      "route-sync-pre-single",
                    progressMessage: headline || "Pre-apply sync · " + hub + "→" + dest
                })
                applyCachedSnapshot()
            } catch (e) {
                console.warn("[AES preApplySync · per-route] threw", e)
            } finally {
                setRefreshing(false)
            }
            return result
        }

        refreshBtn.addEventListener("click", async () => {
            const projectionMaxAge = isFinite(apply.refreshMaxAgeMinProjection) ? apply.refreshMaxAgeMinProjection : 5
            const sync = await runPreApplyRefresh(projectionMaxAge, "Refreshing " + hub + "→" + dest + "…")
            if (sync && sync.halted && this._pricingApplyModal && this._pricingApplyModal.overlay === overlay) {
                preflightHost.innerHTML = ""
                preflightHost.append(this._buildTier3FlashRow(
                    "warn", "Pre-flight halted: " + (sync.reason || "rate limit") + " — Apply will use cached data."
                ))
            }
        })

        const collectArgs = (forcedDryRun, lastApplyAt, lastApplyAtGlobal) => {
            const prices = {}
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const v = this._parseRoutePriceInput(cls, inputs[cls].value)
                if (isFinite(v) && v >= 0) prices[cls] = v
            }
            const scope = {}
            for (const k in scopeBoxes) scope[k] = !!scopeBoxes[k].checked
            return {
                hub, dest, prices,
                opts: {
                    scope, source, sandboxScenario, projectedDelta,
                    reason: (reasonInput.value || "").trim() || null,
                    dryRun: !!forcedDryRun,
                    submitButton:      apply.submitButton || "submit-prices",
                    lastApplyAt:       lastApplyAt       || null,
                    lastApplyAtGlobal: lastApplyAtGlobal || null,
                    classGates:        apply.classes     || null
                }
            }
        }

        const fetchLastApplyAt = async () => {
            try {
                const log = this._getPricingApplyLog()
                if (log && typeof log.getLastSuccessAt === "function") {
                    return await log.getLastSuccessAt(hub, dest)
                }
            } catch (e) { console.warn("[AES pricing] getLastSuccessAt failed", e) }
            return null
        }

        const fetchLastApplyAtGlobal = async () => {
            try {
                const log = this._getPricingApplyLog()
                if (log && typeof log.getLastSuccessGlobal === "function") {
                    return await log.getLastSuccessGlobal()
                }
            } catch (e) { console.warn("[AES pricing] getLastSuccessGlobal failed", e) }
            return null
        }

        const renderResult = (result, applierUsed) => {
            // Detached-DOM guard — the user may have closed the modal mid-async.
            const stillMounted = !!(this._pricingApplyModal && this._pricingApplyModal.overlay === overlay)
            if (stillMounted) {
                preflightHost.innerHTML = ""
                if (result.preflight) preflightHost.append(this._buildTier3PreflightView(result.preflight))
                if (result.bodyPreview) bodyPre.textContent = result.bodyPreview
            }
            this._refreshAllOpenTier3LogPreviews()
            const msg = (result.status === "dry-run" ? "Dry-run logged · " : (result.status + " · "))
                + hub + "→" + dest
            const successWithUndo = (result.status === "verified" || result.status === "posted")
                && result.prevPrices && Object.keys(result.prevPrices).length > 0
            if (typeof RouteAssistantToast !== "undefined") {
                if (result.error && result.error.code === "rateLimit") {
                    const n = result.error.consecutiveErrors || 1
                    const minsCooling = Math.round((this.settings.pricing.apply.circuitBreakerCooldownMs || 600000) / 60000)
                    if (result.error.breakerTripped) {
                        RouteAssistantToast.warn("Pricing apply halted: HTTP " + result.error.httpStatus
                            + " ×" + n + " in a row · cooling " + minsCooling + " min")
                    } else {
                        RouteAssistantToast.error(msg + " — rateLimit (HTTP " + result.error.httpStatus + ", " + n + "× in a row)")
                    }
                } else if (result.error && result.error.code === "breakerCooldown") {
                    RouteAssistantToast.warn("Pricing apply skipped — circuit breaker cooldown ("
                        + (result.error.remainingMin || "?") + " min remaining)")
                } else if (result.status === "failed" || result.status === "aborted") {
                    RouteAssistantToast.error(msg + " — " + (result.error && result.error.code))
                } else if (result.status === "dry-run") {
                    RouteAssistantToast.info(msg)
                } else if (successWithUndo) {
                    RouteAssistantToast.success(msg, {
                        duration: 6000,
                        action: {
                            label: "Undo",
                            fn: async () => {
                                try {
                                    const undoApplier = applierUsed || this._getPricingApplier()
                                    const undoEndpointOpts = await this._resolveEndpointOpts(hub, dest)
                                    const undoResult = await undoApplier.apply(hub, dest, result.prevPrices, Object.assign({
                                        scope:        result.scope,
                                        source:       "undo",
                                        reason:       "Undo of " + (result.logId || result.fingerprint || "previous apply"),
                                        submitButton: result.submitButton,
                                        lastApplyAt:  null
                                    }, undoEndpointOpts))
                                    if (undoResult.status === "verified" || undoResult.status === "posted") {
                                        RouteAssistantToast.info("Reverted " + hub + "→" + dest)
                                    } else {
                                        RouteAssistantToast.error("Undo failed: " + ((undoResult.error && undoResult.error.code) || undoResult.status))
                                    }
                                } catch (e) {
                                    RouteAssistantToast.error("Undo threw: " + (e && e.message || e))
                                }
                            }
                        }
                    })
                } else if (result.status === "verified") {
                    RouteAssistantToast.success(msg)
                } else {
                    RouteAssistantToast.warn(msg)
                }
            }

            // Slice 3b — back-test log on Tier 3 apply. Only fires when the
            // modal was launched from the ORS Sandbox (sandboxProjected is
            // populated only on that path; manual row-context-menu applies
            // have no projection to compare against). Real writes only
            // ("verified"/"posted") — dry-run is skipped because the
            // back-fill loop would otherwise associate the projected
            // share with a marketShare snapshot whose prices never
            // actually changed, corrupting slice 3c's bias/RMSE metric.
            if (sandboxProjected
                && (result.status === "verified" || result.status === "posted")
                && typeof RouteAssistantSandboxBacktestStore !== "undefined") {
                try {
                    RouteAssistantSandboxBacktestStore.log(hub, dest, {
                        ts:          Date.now(),
                        trigger:     "tier3-apply",
                        scenario:    sandboxScenario,
                        modelParams: sandboxModelParams,
                        projected:   {
                            share:          sandboxProjected.share,
                            paxPerWeek:     sandboxProjected.paxPerWeek,
                            revenuePerWeek: sandboxProjected.revenuePerWeek,
                            profitPerWeek:  sandboxProjected.profitPerWeek
                        }
                    }).catch((e) => console.warn("[AES sandboxBacktest] log on tier3-apply failed", e))
                } catch (e) { console.warn("[AES sandboxBacktest] log on tier3-apply threw", e) }
            }
        }

        applyBtn.addEventListener("click", async () => {
            if (!liveAvailable) return
            applyBtn.disabled = true
            applyBtn.textContent = "Applying…"
            try {
                // Defensive secondary pre-flight before the POST. The
                // modal-open refresh anchored projections; this catches
                // the user who paused several minutes between open and
                // Apply, when the freshness window for *real money* is
                // tighter than for picking-time UI.
                if (apply.refreshBeforeApply !== false) {
                    const applyMaxAge = isFinite(apply.refreshMaxAgeMinApply) ? apply.refreshMaxAgeMinApply : 1
                    const sync = await runPreApplyRefresh(applyMaxAge, "Pre-flight · " + hub + "→" + dest)
                    if (sync && sync.halted && this._pricingApplyModal && this._pricingApplyModal.overlay === overlay) {
                        renderResult({
                            status: "aborted",
                            error:  {code: "preApplySyncHalted", message: sync.reason || "Pre-flight halted"}
                        }, null)
                        return
                    }
                }
                const [lastApplyAt, lastApplyAtGlobal] = await Promise.all([
                    fetchLastApplyAt(), fetchLastApplyAtGlobal()
                ])
                const a = collectArgs(false, lastApplyAt, lastApplyAtGlobal)
                Object.assign(a.opts, await this._resolveEndpointOpts(a.hub, a.dest))
                if (cachedOwn && cachedOwn.scrapedAt) {
                    a.opts.preApplySync = {
                        scheduleAt: cachedOwn.scrapedAt,
                        orsAt:      cachedOwn.scrapedAt,
                        halted:     false
                    }
                }
                const applier = this._getPricingApplier()
                const result = await applier.apply(a.hub, a.dest, a.prices, a.opts)
                renderResult(result, applier)
                if (result.status === "verified" || result.status === "posted") {
                    setTimeout(close, 600)
                }
            } catch (e) {
                if (this._pricingApplyModal && this._pricingApplyModal.overlay === overlay) {
                    preflightHost.innerHTML = ""
                    preflightHost.append(this._buildTier3FlashRow("error", "Apply threw: " + (e && e.message || e)))
                }
            } finally {
                applyBtn.disabled = !liveAvailable
                applyBtn.textContent = liveAvailable ? "Apply" : "Apply (gated)"
            }
        })

        overlay.append(dialog)
        document.body.append(overlay)
        document.addEventListener("keydown", onKey)
        overlay.addEventListener("click", onOverlayClick)
        this._pricingApplyModal = {overlay, onKey}
        if (inputs.Y) setTimeout(() => inputs.Y.focus(), 30)

        // Auto-refresh on modal open — runs the orchestrator pass against
        // this single route so the Current column + sandbox projections
        // reflect fresh ORS rank before the user picks Δ%. Gated by
        // setting + freshness floor so opening twice in quick succession
        // doesn't burn extra ORS scrapes.
        if (apply.refreshBeforeApply !== false) {
            const projectionMaxAge = isFinite(apply.refreshMaxAgeMinProjection) ? apply.refreshMaxAgeMinProjection : 5
            // Fire-and-forget; spinner manages user-visible state.
            runPreApplyRefresh(projectionMaxAge, "Refreshing " + hub + "→" + dest + "…")
                .catch((e) => console.warn("[AES preApplySync · open] threw", e))
        }
    }

    window.RouteAssistantPanel.prototype._openBulkPricingApplyModal = function() {
        this._closePricingApplyModal()
        const apply = (this.settings.pricing && this.settings.pricing.apply) || {}
        const dryRunOnly = apply.dryRunOnly === true
        const bulkGate = this._pricingApplyGate("bulk")
        const liveAvailable = bulkGate.liveWrites

        const rows = this._collectBulkApplyRows()
        const state = {
            selected:    new Set(),
            deltaPct:    {Y: 0, C: 0, F: 0, Cargo: 0},
            scope:       Object.assign({}, apply.defaultScope || {}),
            running:     false,
            results:     new Map(),  // destIata → {status, msg}
            cooldownMap: new Map(),  // destIata → minutes until cooldown clears
            refreshBeforeApply: apply.refreshBeforeApply !== false
        }

        const overlay = document.createElement("div")
        overlay.id = "aes-pricing-apply-modal"
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;"
            + "display:flex;align-items:flex-start;justify-content:center;padding:60px 20px 20px 20px;"
        const dialog = document.createElement("div")
        dialog.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #475569;border-radius:6px;"
            + "padding:14px 18px;width:880px;max-width:95vw;font:12px/1.4 sans-serif;"
            + "max-height:calc(100vh - 80px);overflow-y:auto;"
        const stage = dryRunOnly ? "Dry-run only"
            : (!bulkGate.applyEnabled ? "Live writes disabled"
                : (bulkGate.scopeLiveAllowed ? "LIVE writes" : "Bulk scope dry-run"))
        const stageColor = dryRunOnly ? "#fbbf24"
            : (bulkGate.liveWrites ? "#34d399" : "#9ca3af")
        const head = document.createElement("div")
        head.innerHTML = "<strong style='font-size:13px;'>Bulk apply price · " + (this.hubIata || "?") + "</strong>"
            + " <span style='color:" + stageColor + ";font-size:10px;font-weight:normal;'>" + stage + "</span>"
            + "<div style='color:#9ca3af;font-size:10px;margin-top:2px;'>"
            + "Apply a uniform Δ% to selected routes. Each route's current cached price × (1 + Δ%/100) "
            + "becomes the new price. Empty fields are sent at their current value."
            + "</div>"
        dialog.append(head)

        if (!rows.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:#9ca3af;font-size:11px;margin:12px 0;"
            empty.textContent = "No routes have cached pricing yet — run the Market Analysis sync first."
            dialog.append(empty)
            const foot = document.createElement("div")
            foot.style.cssText = "display:flex;justify-content:flex-end;margin-top:10px;"
            const closeBtn = document.createElement("button")
            closeBtn.textContent = "Close"
            closeBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #374151;"
                + "border-radius:3px;padding:5px 14px;font-size:11px;cursor:pointer;"
            closeBtn.addEventListener("click", () => this._closePricingApplyModal())
            foot.append(closeBtn)
            dialog.append(foot)
            const onKeyEmpty = (e) => { if (e.key === "Escape") this._closePricingApplyModal() }
            const onClickEmpty = (e) => { if (e.target === overlay) this._closePricingApplyModal() }
            overlay.append(dialog)
            document.body.append(overlay)
            document.addEventListener("keydown", onKeyEmpty)
            overlay.addEventListener("click", onClickEmpty)
            this._pricingApplyModal = {overlay, onKey: onKeyEmpty}
            return
        }

        // Per-class Δ% editor.
        const deltaWrap = document.createElement("div")
        deltaWrap.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;"
            + "padding:8px 10px;background:#0b1220;border:1px solid #1f2937;border-radius:4px;margin-top:8px;"
        const deltaTitle = document.createElement("strong")
        deltaTitle.textContent = "Δ%"
        deltaTitle.style.cssText = "color:#c4b5fd;font-size:11px;"
        deltaWrap.append(deltaTitle)
        const deltaInputs = {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;font-size:11px;"
            lbl.append(document.createTextNode(cls))
            const input = document.createElement("input")
            input.type = "number"
            input.step = "0.5"
            input.value = "0"
            input.style.cssText = "width:62px;background:#1e293b;color:#fff;border:1px solid #475569;"
                + "border-radius:3px;padding:3px 5px;font-size:11px;font-variant-numeric:tabular-nums;"
            input.addEventListener("input", () => {
                const v = parseFloat(input.value)
                state.deltaPct[cls] = isFinite(v) ? v : 0
                renderTable()
                refreshFooter()
            })
            lbl.append(input)
            deltaInputs[cls] = input
            deltaWrap.append(lbl)
        }
        const allBtn = document.createElement("button")
        allBtn.textContent = "Match Y across C/F/Cargo"
        Object.assign(allBtn.style, smallBtnStyle())
        allBtn.style.fontSize = "10px"
        allBtn.addEventListener("click", () => {
            const v = parseFloat(deltaInputs.Y.value)
            const pct = isFinite(v) ? v : 0
            for (const cls of ["C", "F", "Cargo"]) {
                deltaInputs[cls].value = String(pct)
                state.deltaPct[cls] = pct
            }
            renderTable()
            refreshFooter()
        })
        deltaWrap.append(allBtn)
        dialog.append(deltaWrap)

        // Selection summary row.
        const selRow = document.createElement("div")
        selRow.style.cssText = "display:flex;gap:10px;align-items:center;margin-top:8px;font-size:11px;"
        const selCount = document.createElement("span")
        selCount.style.cssText = "color:#c4b5fd;"
        const selectAllBtn = document.createElement("button")
        selectAllBtn.textContent = "Select all"
        Object.assign(selectAllBtn.style, smallBtnStyle())
        selectAllBtn.style.fontSize = "10px"
        selectAllBtn.addEventListener("click", () => {
            for (const {r} of rows) state.selected.add(r.destIata)
            renderTable()
            refreshFooter()
        })
        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.fontSize = "10px"
        clearBtn.addEventListener("click", () => {
            state.selected.clear()
            renderTable()
            refreshFooter()
        })
        selRow.append(selCount, selectAllBtn, clearBtn)
        dialog.append(selRow)

        // Pre-apply refresh row — wired through _orchestratorPreApplySync.
        // The "Refresh visible" button runs against any row whose cached
        // schedule + ORS data is older than `refreshMaxAgeMinProjection`,
        // updating the table previews so the user picks Δ% off fresh data.
        // The checkbox controls whether Apply auto-runs the orchestrator
        // over the selected rows before each POST (defensive, gated by the
        // tighter `refreshMaxAgeMinApply` floor).
        const refreshRow = document.createElement("div")
        refreshRow.style.cssText = "display:flex;gap:10px;align-items:center;margin-top:6px;font-size:11px;"
            + "padding:6px 10px;background:rgba(124, 58, 237, 0.06);border:1px solid rgba(124, 58, 237, 0.25);"
            + "border-radius:4px;"
        const refreshLbl = document.createElement("label")
        refreshLbl.style.cssText = "display:flex;gap:6px;align-items:center;color:#cbd5e1;cursor:pointer;"
        const refreshCb = document.createElement("input")
        refreshCb.type = "checkbox"
        refreshCb.checked = state.refreshBeforeApply
        refreshCb.addEventListener("change", () => { state.refreshBeforeApply = !!refreshCb.checked })
        refreshLbl.append(refreshCb, document.createTextNode("Refresh data before each apply"))
        refreshLbl.title = "Runs schedule + ORS scrapes for selected routes before each POST so projections "
            + "and the cooldown gate see fresh data. Halts gracefully on rate-limit; you can choose to apply "
            + "to the synced subset and skip the rest."
        refreshRow.append(refreshLbl)

        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = "Refresh visible"
        Object.assign(refreshBtn.style, smallBtnStyle())
        refreshBtn.style.fontSize = "10px"
        refreshBtn.title = "Manually run schedule + ORS scrapes against any visible row whose cached data "
            + "is older than the projection freshness window. Updates the current → proposed previews."
        refreshBtn.addEventListener("click", async () => {
            if (state.running) return
            state.running = true
            refreshBtn.disabled = true
            refreshBtn.textContent = "Refreshing…"
            // Disable Apply while pre-flight is in flight; the
            // user can't apply against partial mid-refresh state.
            try { refreshFooter() } catch (e) { /* refreshFooter not yet defined on first call — safe */ }
            try {
                const projectionMaxAge = isFinite(apply.refreshMaxAgeMinProjection)
                    ? apply.refreshMaxAgeMinProjection : 5
                const pairs = rows.map(({r}) => ({hub: this.hubIata, dest: r.destIata}))
                const sync = await this._orchestratorPreApplySync(pairs, {
                    maxAgeMin:       projectionMaxAge,
                    progressId:      "route-sync-pre-bulk-visible",
                    progressMessage: "Refreshing visible rows…"
                })
                // Re-collect cached snapshots from the freshly-loaded rows
                for (const item of rows) {
                    const fresh = this._lookupCachedOwnPricing(this.hubIata, item.r.destIata)
                    if (fresh) item.cached = fresh
                }
                renderTable()
                if (sync.halted && typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.warn("Refresh halted: " + (sync.reason || "rate limit"))
                }
            } catch (e) {
                console.warn("[AES bulk-modal refresh] threw", e)
            } finally {
                state.running = false
                refreshBtn.disabled = false
                refreshBtn.textContent = "Refresh visible"
                try { refreshFooter() } catch (e) { /* defensive */ }
            }
        })
        refreshRow.append(refreshBtn)
        dialog.append(refreshRow)

        // Table.
        const tableWrap = document.createElement("div")
        tableWrap.style.cssText = "max-height:380px;overflow-y:auto;margin-top:6px;border:1px solid #1f2937;border-radius:4px;"
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const thead = document.createElement("thead")
        thead.style.cssText = "background:#0b1220;position:sticky;top:0;"
        const trH = document.createElement("tr")
        for (const h of ["", "Route", "Y now → new", "C now → new", "F now → new", "Cargo now → new", "Cooldown", "Status"]) {
            const th = document.createElement("th")
            th.textContent = h
            th.style.cssText = "text-align:left;padding:4px 6px;color:#9ca3af;font-size:10px;"
                + "text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #1f2937;"
            trH.append(th)
        }
        thead.append(trH); tbl.append(thead)
        const tbody = document.createElement("tbody")
        tbl.append(tbody)
        tableWrap.append(tbl)
        dialog.append(tableWrap)

        this._hydrateBulkCooldownMap(rows, state.cooldownMap).then(() => renderTable())

        const renderTable = () => {
            tbody.innerHTML = ""
            for (const {r, cached} of rows) {
                const dest = r.destIata
                const trr = document.createElement("tr")
                trr.style.cssText = "border-bottom:1px solid rgba(31, 41, 55, 0.5);"
                if (state.selected.has(dest)) trr.style.background = "rgba(124, 58, 237, 0.08)"
                const cbTd = document.createElement("td")
                cbTd.style.cssText = "padding:3px 6px;"
                const cb = document.createElement("input")
                cb.type = "checkbox"
                cb.checked = state.selected.has(dest)
                cb.disabled = state.running
                cb.addEventListener("change", () => {
                    if (cb.checked) state.selected.add(dest)
                    else state.selected.delete(dest)
                    trr.style.background = cb.checked ? "rgba(124, 58, 237, 0.08)" : ""
                    refreshFooter()
                })
                cbTd.append(cb)
                trr.append(cbTd)
                const routeTd = document.createElement("td")
                routeTd.textContent = dest
                routeTd.style.cssText = "padding:3px 6px;color:#cbd5e1;font-weight:600;"
                trr.append(routeTd)
                const p = this._silentAutoPrices(cached) || {}
                for (const cls of ["Y", "C", "F", "Cargo"]) {
                    const cur = p[cls]
                    const td = document.createElement("td")
                    td.style.cssText = "padding:3px 6px;font-variant-numeric:tabular-nums;color:#cbd5e1;"
                    if (cur == null) {
                        td.textContent = "—"
                    } else {
                        const prop = this._computeBulkProposedPrice(cur, state.deltaPct[cls], cls)
                        if (prop === cur) {
                            td.textContent = this._formatRoutePrice(cls, cur)
                        } else {
                            const arrow = prop > cur ? "↑" : "↓"
                            const color = prop > cur ? "#34d399" : "#f87171"
                            td.innerHTML = this._formatRoutePrice(cls, cur)
                                + " → <span style='color:" + color + ";font-weight:600;'>"
                                + this._formatRoutePrice(cls, prop) + " " + arrow + "</span>"
                        }
                    }
                    trr.append(td)
                }
                const cdTd = document.createElement("td")
                cdTd.style.cssText = "padding:3px 6px;font-size:10px;"
                const cdMin = state.cooldownMap.get(dest)
                if (isFinite(cdMin) && cdMin > 0) {
                    cdTd.innerHTML = "<span style='color:#fbbf24;'>" + cdMin + "m left</span>"
                    trr.style.opacity = "0.65"
                } else {
                    cdTd.textContent = "—"
                }
                trr.append(cdTd)
                const stTd = document.createElement("td")
                stTd.style.cssText = "padding:3px 6px;font-size:10px;"
                const res = state.results.get(dest)
                if (res) {
                    const palette = {
                        verified: "#34d399", posted: "#34d399",
                        "dry-run": "#60a5fa",
                        skipped:  "#9ca3af",
                        failed:   "#f87171", aborted: "#f87171"
                    }
                    stTd.innerHTML = "<span style='color:" + (palette[res.status] || "#cbd5e1") + ";'>"
                        + res.status + (res.msg ? " · " + res.msg : "") + "</span>"
                }
                trr.append(stTd)
                tbody.append(trr)
            }
        }
        renderTable()

        // Footer.
        const foot = document.createElement("div")
        foot.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:10px;"
            + "padding-top:8px;border-top:1px solid #1f2937;"
        const summary = document.createElement("span")
        summary.style.cssText = "color:#9ca3af;font-size:10px;"
        const actBtns = document.createElement("div")
        actBtns.style.cssText = "display:flex;gap:6px;"
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "Close"
        closeBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #374151;"
            + "border-radius:3px;padding:5px 14px;font-size:11px;cursor:pointer;"
        closeBtn.addEventListener("click", () => this._closePricingApplyModal())
        const applyBtn = document.createElement("button")
        applyBtn.textContent = "Apply selected"
        Object.assign(applyBtn.style, smallBtnStyle())
        applyBtn.style.background = liveAvailable ? "#7c3aed" : "#374151"
        applyBtn.style.borderColor = liveAvailable ? "#6d28d9" : "#475569"
        applyBtn.style.color = liveAvailable ? "#fff" : "#9ca3af"
        applyBtn.addEventListener("click", () => onApplyClick())
        actBtns.append(closeBtn, applyBtn)
        foot.append(summary, actBtns)
        dialog.append(foot)

        const refreshFooter = () => {
            const n = state.selected.size
            const anyDelta = ["Y", "C", "F", "Cargo"].some(c => state.deltaPct[c] !== 0)
            selCount.textContent = n + " of " + rows.length + " selected"
            summary.textContent = n + " selected · "
                + (anyDelta ? "Δ% set — proposed prices in green/red" : "no Δ% — Apply round-trips current prices")
            const armed = n > 0 && !state.running
            applyBtn.disabled = !armed || !liveAvailable
            applyBtn.title = !liveAvailable
                ? (dryRunOnly
                    ? "Dry-run gate is on. Settings → Auto-Pricing → turn off \"Dry-run only\" to commit writes."
                    : (!bulkGate.applyEnabled
                        ? "Apply enabled is off. Settings → Auto-Pricing → flip \"Apply enabled\" to commit writes."
                        : "Bulk live scope is off. Settings → Auto-Pricing → live scopes: enable Bulk to commit writes."))
                : (n === 0 ? "Select at least one route." : "POST new prices to AS for " + n + " routes.")
        }
        refreshFooter()

        const onApplyClick = async () => {
            if (state.running) return
            if (!state.selected.size) return
            const selected = rows.filter(({r}) => state.selected.has(r.destIata))
            const ok = await this._openBulkApplyConfirmModal({
                selected, deltaPct: state.deltaPct, hub: this.hubIata
            })
            if (!ok) return
            state.running = true
            applyBtn.disabled = true
            applyBtn.textContent = "Applying…"
            try {
                await this._runBulkPricingApply({
                    selected, deltaPct: state.deltaPct, scope: state.scope, dryRun: false,
                    refreshBeforeApply: state.refreshBeforeApply,
                    onRowResult: (dest, result) => {
                        state.results.set(dest, this._summariseBulkResult(result))
                        renderTable()
                    }
                })
                this._refreshAllOpenTier3LogPreviews()
            } catch (e) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.error("Bulk apply threw: " + (e && e.message || e))
                }
            } finally {
                state.running = false
                applyBtn.disabled = false
                applyBtn.textContent = "Apply selected"
                refreshFooter()
            }
        }

        const onKey = (e) => { if (e.key === "Escape") this._closePricingApplyModal() }
        const onOverlayClick = (e) => { if (e.target === overlay) this._closePricingApplyModal() }
        overlay.append(dialog)
        document.body.append(overlay)
        document.addEventListener("keydown", onKey)
        overlay.addEventListener("click", onOverlayClick)
        this._pricingApplyModal = {overlay, onKey}
    }

    /**
     * Bulk apply orchestrator. Iterates selected routes serially —
     * concurrency 1 is the right call here because (a) AS Wicket sessions
     * don't parallelise across applies on the same session anyway and (b)
     * a serial loop keeps the circuit-breaker counter monotonic. A single
     * applier instance is reused across every row so the breaker state
     * spans the whole batch (a 429 on row 3 trips for rows 4+).
     */
    window.RouteAssistantPanel.prototype._runBulkPricingApply = async function({selected, deltaPct, scope, dryRun, refreshBeforeApply, onRowResult}) {
        const applier = this._getPricingApplier()
        const log = this._getPricingApplyLog()
        const apply = (this.settings.pricing && this.settings.pricing.apply) || {}
        const submitButton = apply.submitButton || "submit-prices"
        // Tier 3.4 — narrow live-writes scope. When the bulk scope is
        // locked, force dry-run regardless of `enabled`/`dryRunOnly`.
        // Lets the user unlock manual writes first and trial silent-auto +
        // bulk separately. Surface the override in a toast so the user
        // isn't surprised by their bulk applies all landing as dry-runs.
        const bulkGate = this._pricingApplyGate("bulk", {forceDryRun: !!dryRun})
        dryRun = bulkGate.dryRun
        // Tier 3.4 — every entry written by this bulk pass carries the same
        // `batchId` so the audit modal can collapse the group. Generated
        // up-front so synthetic "skipped" entries (orchestrator halt) also
        // share it.
        const batchId   = "batch-" + Date.now().toString(36) + "-"
                        + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        const batchSize = selected.length
        let okCount = 0
        let failCount = 0
        let skippedCount = 0

        // Pre-flight orchestrator pass — only on real applies. Dry-run is
        // a pure GET that can't move markets, so refreshing data first is
        // wasted work. Halts open the confirm sub-modal so the user can
        // choose to apply to the synced subset or abort wholesale.
        const preApplyMap = new Map()  // destIata → preApplySync envelope
        if (!dryRun && refreshBeforeApply) {
            const applyMaxAge = isFinite(apply.refreshMaxAgeMinApply) ? apply.refreshMaxAgeMinApply : 1
            const pairs = selected.map(({r}) => ({hub: this.hubIata, dest: r.destIata}))
            // Tier 3.4 — preapply sync timeout. The orchestrator is normally
            // bounded by its own per-scrape timeouts, but a hung Wicket
            // session or a flaky network can leave the await pending
            // indefinitely. Race against `preApplySyncTimeoutMs` (default
            // 30s) so the user is never stuck waiting on the sync — on
            // timeout the apply continues against the cached snapshot.
            const syncTimeoutMs = isFinite(apply.preApplySyncTimeoutMs)
                ? Math.max(5000, apply.preApplySyncTimeoutMs) : 30000
            const sync = await this._raceWithTimeout(
                this._orchestratorPreApplySync(pairs, {
                    maxAgeMin:       applyMaxAge,
                    progressId:      "route-sync-pre-bulk-apply",
                    progressMessage: "Pre-apply sync · " + pairs.length + " route" + (pairs.length === 1 ? "" : "s")
                }),
                syncTimeoutMs,
                {kind: "preApplySync", pairs: pairs.length}
            )
            if (sync && sync.timedOut) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.warn("Pre-apply sync timed out after "
                        + Math.round(syncTimeoutMs / 1000) + "s — applying with cached data")
                }
                // Replace timed-out envelope with an empty results shape so
                // the per-row loop falls through to the cached path.
                sync.results = sync.results instanceof Map ? sync.results : new Map()
                sync.halted  = false
            }
            // Re-collect cached snapshots since orchestrator may have
            // refreshed prices that are now stored in scoredRows.
            for (const item of selected) {
                const fresh = this._lookupCachedOwnPricing(this.hubIata, item.r.destIata)
                if (fresh) item.cached = fresh
            }
            // Halt → user decides
            if (sync.halted) {
                const decision = await this._openHaltConfirmModal({
                    doneCount:  sync.doneCount,
                    totalCount: pairs.length,
                    reason:     sync.reason
                })
                if (decision === "abort") {
                    if (typeof RouteAssistantToast !== "undefined") {
                        RouteAssistantToast.warn("Bulk apply aborted · pre-flight halted")
                    }
                    return
                }
            }
            for (const [dest, env] of sync.results) preApplyMap.set(dest, env)
        }

        for (const {r, cached} of selected) {
            const dest = r.destIata
            // Synthetic skipped entry for routes the orchestrator halted on
            // before reaching them. Preserves audit-trail symmetry — every
            // selected route lands either an apply log entry or a skip log
            // entry, no silent drops.
            const preSync = preApplyMap.has(dest) ? preApplyMap.get(dest) : null
            if (preSync && preSync.halted) {
                const skippedResult = {
                    status: "skipped",
                    error:  {code: "preApplySyncSkipped", message: "Pre-flight halted before this route"}
                }
                if (log && typeof log.add === "function") {
                    try {
                        await log.add({
                            hub: this.hubIata, dest, status: "skipped", source: "bulk",
                            error: skippedResult.error, preApplySync: preSync, dryRun: false,
                            scope, submitButton, batchId, batchSize
                        })
                    } catch (e) { /* non-fatal */ }
                }
                if (typeof onRowResult === "function") onRowResult(dest, skippedResult)
                skippedCount++
                continue
            }

            const p = this._silentAutoPrices(cached) || {}
            const prices = {}
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const cur = p[cls]
                if (cur == null) continue
                prices[cls] = this._computeBulkProposedPrice(cur, deltaPct[cls], cls)
            }
            let lastApplyAt = null
            try {
                if (!dryRun && log && typeof log.getLastSuccessAt === "function") {
                    lastApplyAt = await log.getLastSuccessAt(this.hubIata, dest)
                }
            } catch (e) { /* ignore */ }
            try {
                // Per-route cooldown still applies to each route in the
                // bulk pass; the global cooldown is intentionally NOT
                // threaded — the bulk action is itself the rapid-fire
                // chain the global gate exists to prevent, and the user
                // already cleared a confirm modal before reaching here.
                const opts = {
                    scope, source: "bulk", submitButton,
                    lastApplyAt, lastApplyAtGlobal: null, dryRun,
                    batchId, batchSize,
                    classGates: apply.classes || null
                }
                if (preSync) opts.preApplySync = preSync
                Object.assign(opts, await this._resolveEndpointOpts(this.hubIata, dest))
                const result = await applier.apply(this.hubIata, dest, prices, opts)
                if (typeof onRowResult === "function") onRowResult(dest, result)
                if (result.status === "verified" || result.status === "posted" || result.status === "dry-run") okCount++
                else failCount++
            } catch (e) {
                const fakeResult = {status: "failed", error: {code: "applierThrew", message: String(e && e.message || e)}}
                if (typeof onRowResult === "function") onRowResult(dest, fakeResult)
                failCount++
            }
        }
        if (typeof RouteAssistantToast !== "undefined") {
            const verb = dryRun ? "Bulk dry-run" : "Bulk apply"
            const tail = skippedCount > 0 ? " · " + skippedCount + " skipped" : ""
            const msg = verb + " complete · " + okCount + " ok · " + failCount + " failed" + tail
            if (failCount === 0 && skippedCount === 0) RouteAssistantToast.success(msg)
            else if (okCount === 0) RouteAssistantToast.error(msg)
            else RouteAssistantToast.warn(msg)
        }
    }

    /**
     * Cross-tab-aware tick gate. Re-reads the persisted
     * `silentAutoLastTickAt` (NOT `this.settings`, which can be stale
     * on a tab that hasn't received the latest `chrome.storage.onChanged`
     * yet) and skips when another tab ticked within ~0.9× the cadence.
     *
     * The 0.9× factor allows a slightly-late alarm or a slightly-early
     * setInterval to still fire on time without double-ticking — the
     * gate's only job is "another tab obviously ticked recently."
     * Tight races where two tabs both pass the gate are acceptable: the
     * applier's per-route cooldown + the per-tick caps absorb the
     * duplicate work, and the next persisted `lastTickAt` write
     * deterministically picks one as the authoritative timestamp.
     */
    window.RouteAssistantPanel.prototype._silentAutoTickIfDue = async function() {
        const cfg = this._silentAutoCfg()
        if (!cfg.silentAutoEnabled) return
        if (this._silentAutoRunning) return
        let freshLastTickAt = 0
        try {
            const fresh = (typeof RouteAssistantSettings !== "undefined"
                && typeof RouteAssistantSettings.load === "function")
                ? await RouteAssistantSettings.load()
                : null
            const pricing = fresh && fresh.pricing || {}
            if (isFinite(pricing.silentAutoLastTickAt)) freshLastTickAt = pricing.silentAutoLastTickAt
        } catch (_) { /* fall through to running the tick */ }
        if (freshLastTickAt > 0) {
            const requiredGapMs = Math.max(1000, this._silentAutoTickMs(cfg) * 0.9)
            if ((Date.now() - freshLastTickAt) < requiredGapMs) return
        }
        await this._silentAutoTick()
    }

    /**
     * One silent-auto tick. Pure audit-log emitting — every terminal
     * branch persists `silentAutoLastTickResult` so the panel sub-block
     * can render the most recent run. Re-entry guarded by
     * `_silentAutoRunning` so a slow tick (bulk apply against many
     * routes) can't double-fire on the next interval.
     */
    window.RouteAssistantPanel.prototype._silentAutoTick = async function() {
        if (this._silentAutoRunning) return
        this._silentAutoRunning = true
        const ranAt = Date.now()
        const result = {
            ranAt,
            eligible: 0, proposed: 0, applied: 0,
            capped: 0, blocked: 0, skipped: 0,
            dryRun: false, error: null,
            // Per-route trace — one entry per eligible route describing
            // its outcome this tick: skipped (proposer rejected),
            // capped (over budget), applied (with applyStatus + Δ),
            // failed (applier threw / aborted). Capped at 50 entries
            // so a 100-route hub can't blow up the persisted envelope.
            perRoute: []
        }
        const pushTrace = (entry) => {
            if (result.perRoute.length < 50) result.perRoute.push(entry)
        }
        try {
            const cfg = this._silentAutoCfg()
            if (!cfg.silentAutoEnabled) {
                result.error = {code: "disabled", message: "silent-auto is off"}
                return
            }
            if (cfg.silentAutoMutedUntil && cfg.silentAutoMutedUntil > ranAt) {
                const remainingMin = Math.ceil((cfg.silentAutoMutedUntil - ranAt) / 60000)
                result.error = {code: "muted", message: "muted (" + remainingMin + " min remaining)", remainingMin}
                return
            }
            const apply = (this.settings.pricing && this.settings.pricing.apply) || {}
            // Tier 3.4 — silent-auto live-writes scope. Even if both
            // top-level gates are open (apply.enabled=true and
            // dryRunOnly=false), keep silent-auto dry-run unless its
            // scope flag is explicitly true. The operator should sign off
            // separately on autonomous writes vs manual.
            const silentGate = this._pricingApplyGate("silentAuto")
            const silentLiveAllowed = silentGate.scopeLiveAllowed
            const dryRun = silentGate.dryRun
            result.dryRun = dryRun
            result.silentLiveAllowed = silentLiveAllowed
            // Breaker — if Tier 3 breaker is tripped, we still tick (so
            // we can surface "waiting on breaker" in the activity feed)
            // but skip the dispatch step.
            if (!dryRun && apply.circuitBreakerTrippedAt
                && (ranAt - apply.circuitBreakerTrippedAt) < (apply.circuitBreakerCooldownMs || 600000)) {
                const remaining = Math.ceil((apply.circuitBreakerCooldownMs - (ranAt - apply.circuitBreakerTrippedAt)) / 60000)
                result.error = {code: "breakerTripped", message: "breaker cooling (" + remaining + " min)", remainingMin: remaining}
                return
            }

            // 1. Eligible routes by follow mode.
            const eligibleRows = await this._silentAutoCollectEligibleRows(cfg.silentAutoFollowMode)
            result.eligible = eligibleRows.length
            if (!eligibleRows.length) {
                if (typeof window !== "undefined"
                        && window.AesRoutePriceAutomator
                        && typeof window.AesRoutePriceAutomator.runTickIfDue === "function") {
                    const fallback = await window.AesRoutePriceAutomator.runTickIfDue({
                        server: this.server,
                        airline: this.airlineCode
                    }, {
                        source: "panel-empty-cache-fallback",
                        followMode: cfg.silentAutoFollowMode,
                        maxRoutes: 1
                    })
                    if (fallback && !fallback.skipped) {
                        Object.assign(result, fallback)
                        result.fallback = "dashboard-cache"
                        return
                    }
                    if (fallback && fallback.skipped) {
                        result.fallback = "dashboard-cache"
                        pushTrace({
                            dest: "*",
                            stage: "skipped",
                            reason: "dashboard-cache fallback skipped: " + fallback.skipped
                        })
                    }
                }
                result.error = {code: "noEligibleRoutes", message: "no eligible routes (check follow mode + cached competitor data)"}
                return
            }

            // Tier 3.4 — stale-competitor-data guard. The bulk markets
            // scrape populates `pricing.lastBulkScrapeAt`; if it's older
            // than `silentAutoStaleCompetitorWarnDays`, surface a warning
            // in the tick trace. When `silentAutoBlockOnStaleCompetitors`
            // is true the tick aborts before any apply, since stale
            // competitor medians can drive the proposer into bad moves.
            const lastBulk = isFinite(this.settings.pricing && this.settings.pricing.lastBulkScrapeAt)
                ? this.settings.pricing.lastBulkScrapeAt : null
            const warnDays = isFinite(cfg.silentAutoStaleCompetitorWarnDays)
                ? cfg.silentAutoStaleCompetitorWarnDays : 7
            if (lastBulk && warnDays > 0) {
                const ageDays = (ranAt - lastBulk) / 86400000
                if (ageDays > warnDays) {
                    const ageStr = ageDays.toFixed(1) + " days old"
                    pushTrace({
                        dest:   "*",
                        stage:  "warning",
                        reason: "competitor data " + ageStr + " (>" + warnDays + " day warn threshold)"
                    })
                    if (cfg.silentAutoBlockOnStaleCompetitors) {
                        result.error = {
                            code:    "staleCompetitorData",
                            message: "blocked: competitor data " + ageStr
                                   + " (run a Markets bulk scrape, or unset Block-on-stale)"
                        }
                        return
                    }
                }
            } else if (!lastBulk && warnDays > 0) {
                pushTrace({
                    dest:   "*",
                    stage:  "warning",
                    reason: "no competitor bulk-scrape timestamp recorded yet"
                })
            }

            // 2. Per-route proposals.
            //    Build the proposer context once per tick — strategies that
            //    need expensive shared state (snapshot, ORS bulk fetch)
            //    populate it here so the per-route loop is a cheap lookup.
            const proposerCtx = await this._silentAutoBuildProposerContext(cfg)
            const proposals = []
            for (const {r, prices} of eligibleRows) {
                const prop = this._silentAutoProposeForRoute(r, prices, cfg, proposerCtx)
                if (!prop || !prop.ok) {
                    result.skipped += 1
                    pushTrace({
                        dest:   (prop && prop.dest) || String(r.destIata || "").toUpperCase(),
                        stage:  "skipped",
                        reason: (prop && prop.skipReason) || "proposer returned null"
                    })
                    continue
                }
                prop.prevPrices = Object.assign({}, prices)
                proposals.push(prop)
            }
            result.proposed = proposals.length
            if (!proposals.length) {
                result.error = {code: "noProposals", message: "no route met the min Δ% threshold"}
                return
            }

            // 3. Hard caps — daily + hourly silent-auto write count.
            const log = this._getPricingApplyLog()
            const remaining = await this._silentAutoCheckCaps(log, cfg, dryRun)
            if (remaining.dailyRemaining <= 0 || remaining.hourlyRemaining <= 0) {
                result.error = {
                    code: "capExhausted",
                    message: "cap reached (day " + remaining.dailyUsed + "/" + cfg.silentAutoMaxPerDay
                        + " · hour " + remaining.hourlyUsed + "/" + cfg.silentAutoMaxPerHour + ")"
                }
                result.blocked = proposals.length
                for (const prop of proposals) {
                    pushTrace({
                        dest:    prop.dest,
                        stage:   "blocked",
                        reason:  "tick cap exhausted before dispatch",
                        prevY:   prop.prevY, newY: prop.newY, deltaPct: prop.deltaPct,
                        priceSummary: this._summarisePriceMove(prop.prevPrices, prop.prices)
                    })
                }
                return
            }
            const budget = Math.min(remaining.dailyRemaining, remaining.hourlyRemaining, proposals.length)
            const cappedOff = proposals.length - budget
            result.capped = Math.max(0, cappedOff)
            const toApply = proposals.slice(0, budget)
            for (const prop of proposals.slice(budget)) {
                pushTrace({
                    dest:    prop.dest,
                    stage:   "capped",
                    reason:  "over per-tick budget (" + budget + " applied this tick)",
                    prevY:   prop.prevY, newY: prop.newY, deltaPct: prop.deltaPct,
                    priceSummary: this._summarisePriceMove(prop.prevPrices, prop.prices)
                })
            }

            // 4. Dispatch through the shared applier. Serial — the
            // applier breaker counter has to stay monotonic, same
            // reason _runBulkPricingApply uses concurrency 1.
            const applier = this._getPricingApplier()
            const submitButton = apply.submitButton || "submit-prices"
            const scope = Object.assign({}, apply.defaultScope || {})

            // Hoist the cooldown-timestamp lookups out of the per-route
            // loop. `getLastSuccessGlobal` is route-independent and
            // `getLastSuccessMap` bulk-fetches the per-route timestamps
            // in one storage round-trip, replacing what would otherwise
            // be 2N gets across N proposals.
            let lastApplyAtGlobal = null
            const perRouteLast = new Map()
            if (!dryRun && log) {
                try {
                    if (typeof log.getLastSuccessGlobal === "function") {
                        lastApplyAtGlobal = await log.getLastSuccessGlobal()
                    }
                    if (typeof log.getLastSuccessMap === "function") {
                        const pairs = toApply.map(p => ({hub: this.hubIata, dest: p.dest}))
                        const m = await log.getLastSuccessMap(pairs)
                        for (const [k, v] of m) perRouteLast.set(k, v)
                    }
                } catch (e) { /* non-fatal */ }
            }

            for (const prop of toApply) {
                const pairKey = String(this.hubIata || "").toUpperCase() + "-" + prop.dest
                const lastApplyAt = perRouteLast.has(pairKey) ? perRouteLast.get(pairKey) : null
                let applyResult = null
                try {
                    const silentEndpointOpts = await this._resolveEndpointOpts(this.hubIata, prop.dest)
                    applyResult = await applier.apply(this.hubIata, prop.dest, prop.prices, Object.assign({
                        scope,
                        source: "silent-auto",
                        submitButton,
                        lastApplyAt,
                        lastApplyAtGlobal,
                        dryRun,
                        reason:           prop.reason,
                        proposerStrategy: cfg.silentAutoStrategy || "per-class-elasticity",
                        rationale:        prop.rationale  || null,
                        objective:        prop.objective  || null,
                        projectedDelta:   prop.projectedDelta || null,
                        classGates:       apply.classes || null
                    }, silentEndpointOpts))
                } catch (e) {
                    applyResult = {status: "failed", error: {code: "applierThrew", message: String(e && e.message || e)}}
                }
                const applyStatus = applyResult && applyResult.status || "failed"
                const ok = applyStatus === "verified" || applyStatus === "posted" || applyStatus === "dry-run"
                pushTrace({
                    dest:        prop.dest,
                    stage:       ok ? "applied" : "failed",
                    applyStatus,
                    reason:      ok
                        ? prop.reason
                        : ((applyResult && applyResult.error && applyResult.error.message) || "applier returned non-success"),
                    prevY:       prop.prevY,
                    newY:        prop.newY,
                    deltaPct:    prop.deltaPct,
                    priceSummary: this._summarisePriceMove(prop.prevPrices, prop.prices),
                    errorCode:   (applyResult && applyResult.error && applyResult.error.code) || null
                })
                if (ok) {
                    result.applied += 1
                    this._silentAutoConsecutiveErrors = 0
                } else {
                    this._silentAutoConsecutiveErrors += 1
                    if (this._silentAutoConsecutiveErrors >= 5) {
                        // Mute window scales with the tick interval (so a
                        // long-cadence loop pauses long enough for an
                        // operator-led recovery) but caps at 6h so a
                        // 240-min tick can't suppress for a workday.
                        const muteMs = Math.min(
                            6 * 60 * 60 * 1000,
                            Math.max(2 * 60 * 60 * 1000, this._silentAutoTickMs(cfg) * 4)
                        )
                        await this._persistSilentAutoMute(ranAt + muteMs)
                        result.error = {
                            code: "autoMuted",
                            message: "auto-muted after " + this._silentAutoConsecutiveErrors
                                + " consecutive failures · " + Math.round(muteMs / 60000) + " min"
                        }
                        break
                    }
                }
            }
        } catch (e) {
            result.error = {code: "tickThrew", message: String(e && e.message || e)}
            console.warn("[AES silent-auto] tick threw", e)
        } finally {
            this._silentAutoRunning = false
            try { await this._persistSilentAutoTickResult(result) }
            catch (e) { /* non-fatal */ }
            // Refresh the open settings sub-block so the activity feed
            // updates without waiting for a full panel re-render.
            try { this._refreshSilentAutoActivity() }
            catch (e) { /* sub-block may not be mounted */ }
            try { this._refreshAutoPricingPill() }
            catch (e) { /* pill host may not be mounted */ }
        }
    }

    /** Allow the user to fire one tick by hand (the "Run a tick now" CTA). */
    window.RouteAssistantPanel.prototype._silentAutoTickNow = async function() {
        // Bypasses the in-flight guard's normal usage by deferring to
        // the same tick path; if a tick is already running, we no-op
        // gracefully (the running tick will surface its result).
        if (this._silentAutoRunning) {
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.warn("Silent-auto tick already in flight — wait for it to finish.")
            }
            return
        }
        await this._silentAutoTick()
    }

    /**
     * Renders the silent-auto sub-block under the Auto-Pricing expander.
     * Surfaces (top to bottom):
     *   - header + stage badge
     *   - kill-switch toggle (opens confirm modal on first flip)
     *   - strategy + follow-mode selectors
     *   - tick interval + caps row (4 numeric inputs)
     *   - "Run a tick now" CTA + next-tick countdown
     *   - "Recent silent-auto activity" — last 8 silent-auto entries
     *     from the global apply-log, plus the most recent tick-result
     *     summary
     *
     * The host carries `data-aes-silent-auto-host="1"` so the tick path
     * can refresh just this sub-block via `_refreshSilentAutoActivity`
     * without rebuilding the whole settings drawer.
     */
    window.RouteAssistantPanel.prototype._renderSilentAutoBlock = function(cfg) {
        const block = document.createElement("div")
        block.setAttribute("data-aes-silent-auto-host", "1")
        block.style.cssText = "margin-top:8px;padding:6px 8px;background:rgba(244, 114, 182, 0.05);"
            + "border:1px solid rgba(244, 114, 182, 0.30);border-radius:4px;"
        const sa = this._silentAutoCfg()
        const apply = (cfg && cfg.apply) || {}
        const dryRun = this._pricingApplyGate("silentAuto").dryRun

        const head = document.createElement("div")
        head.style.cssText = "color:#f9a8d4;font-size:11px;margin-bottom:4px;display:flex;"
            + "align-items:center;justify-content:space-between;gap:6px;"
        const title = document.createElement("strong")
        title.textContent = "Tier 3.3 · Silent auto-pricing"
        const stage = document.createElement("span")
        const STAGE_BADGES = {
            off:   {lbl: "Off",           color: "#9ca3af"},
            muted: {lbl: "Muted",         color: "#fbbf24"},
            dry:   {lbl: "Dry-run loop",  color: "#fbbf24"},
            live:  {lbl: "LIVE loop",     color: "#34d399"}
        }
        const stageKey = !sa.silentAutoEnabled ? "off"
            : (sa.silentAutoMutedUntil && sa.silentAutoMutedUntil > Date.now()) ? "muted"
            : dryRun ? "dry" : "live"
        const badge = STAGE_BADGES[stageKey]
        stage.textContent = badge.lbl
        stage.style.cssText = "font-size:10px;font-weight:normal;color:" + badge.color
        head.append(title, stage)
        block.append(head)

        const rationale = document.createElement("div")
        rationale.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;line-height:1.4;"
        rationale.innerHTML = "Polls every <code>" + this._silentAutoCadenceLabel(sa) + "</code> while this panel is mounted, "
            + "auto-derives a Δ% per route via <code>" + sa.silentAutoStrategy + "</code>, and applies through the same "
            + "pipeline the manual modals use. Hard caps on per-day / per-hour writes; respects per-route + global cooldowns; "
            + "circuit-breaker is shared with manual applies."
        block.append(rationale)

        // Toggle row.
        const toggleRow = document.createElement("div")
        toggleRow.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;margin-bottom:6px;"
        const toggleLbl = document.createElement("label")
        toggleLbl.style.cssText = "display:flex;gap:6px;align-items:center;color:#fbcfe8;cursor:pointer;"
        const toggleCb = document.createElement("input")
        toggleCb.type = "checkbox"
        toggleCb.checked = !!sa.silentAutoEnabled
        toggleCb.addEventListener("change", async () => {
            const want = toggleCb.checked
            if (want && !sa.silentAutoConfirmedAt) {
                // First flip — gate behind the confirmation modal. Roll
                // the checkbox back if the user cancels.
                toggleCb.disabled = true
                const ok = await this._openSilentAutoConfirmModal()
                toggleCb.disabled = false
                if (!ok) {
                    toggleCb.checked = false
                    return
                }
                this.settings.pricing.silentAutoConfirmedAt = Date.now()
            }
            this.settings.pricing.silentAutoEnabled = want
            this.settings = await RouteAssistantSettings.save({pricing: this.settings.pricing})
            this._restartSilentAutoLoop()
            this._renderSettings()
        })
        toggleLbl.append(toggleCb, document.createTextNode("Silent-auto enabled"))
        toggleLbl.title = "Top-level kill switch for the silent-auto loop. First activation prompts a confirmation modal; "
            + "subsequent toggles flip silently. Loop runs on the cadence below while this panel is mounted."
        toggleRow.append(toggleLbl)
        if (sa.silentAutoEnabled) {
            const tickBtn = document.createElement("button")
            tickBtn.textContent = "Run a tick now"
            Object.assign(tickBtn.style, smallBtnStyle())
            tickBtn.style.fontSize = "10px"
            tickBtn.title = "Fire one tick immediately — useful for verifying the proposer + caps pipeline. Bypasses the "
                + "scheduled cadence; the next regular tick still fires on its interval."
            tickBtn.addEventListener("click", async () => {
                tickBtn.disabled = true
                tickBtn.textContent = "Ticking…"
                try { await this._silentAutoTickNow() }
                finally {
                    tickBtn.disabled = false
                    tickBtn.textContent = "Run a tick now"
                }
            })
            toggleRow.append(tickBtn)
        }
        block.append(toggleRow)

        // Strategy + follow-mode selectors.
        const selectorsRow = document.createElement("div")
        selectorsRow.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;margin-bottom:6px;"
        const stratLbl = document.createElement("label")
        stratLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;"
        stratLbl.append(document.createTextNode("Strategy"))
        const stratSel = document.createElement("select")
        stratSel.style.cssText = "background:#1e293b;color:#fff;border:1px solid #475569;border-radius:3px;padding:2px 4px;font-size:11px;"
        // Tier 3.4 — pull options from the proposer registry so adding a
        // new strategy is one entry in silent-auto-proposers.js. Falls
        // back to the two built-in options if the registry isn't loaded
        // (script-order regression in manifest).
        const stratOptions = (typeof window !== "undefined"
                              && window.RouteAssistantSilentAutoProposers
                              && typeof window.RouteAssistantSilentAutoProposers.list === "function")
            ? window.RouteAssistantSilentAutoProposers.list()
            : [
                {key: "per-class-elasticity", label: "Per-class elasticity (Y / C / F / Cargo)", description: "Default Y/C/F/Cargo demand-aware autopricer."},
                {key: "competitor-median", label: "Competitor median (Y only)", description: "Legacy Y-only competitor-median tracker."}
            ]
        for (const so of stratOptions) {
            const opt = document.createElement("option")
            opt.value = so.key
            opt.textContent = so.label
            if (so.description) opt.title = so.description
            if (so.key === sa.silentAutoStrategy) opt.selected = true
            stratSel.append(opt)
        }
        const stratHint = document.createElement("span")
        stratHint.style.cssText = "color:#94a3b8;font-size:10px;margin-left:4px;"
        const setStratHint = (key) => {
            const found = stratOptions.find(s => s.key === key)
            stratHint.textContent = found && found.description ? "— " + found.description : ""
        }
        setStratHint(sa.silentAutoStrategy)
        stratSel.addEventListener("change", async () => {
            this.settings.pricing.silentAutoStrategy = stratSel.value
            setStratHint(stratSel.value)
            await RouteAssistantSettings.save({pricing: this.settings.pricing})
            this.settings = await RouteAssistantSettings.load()
            this._renderSettings()
        })
        stratLbl.append(stratSel)
        selectorsRow.append(stratLbl)
        selectorsRow.append(stratHint)

        const followLbl = document.createElement("label")
        followLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;"
        followLbl.append(document.createTextNode("Follow"))
        const followSel = document.createElement("select")
        followSel.style.cssText = stratSel.style.cssText
        for (const [val, label] of [["watchlist", "Watchlist (★) only"], ["all", "All eligible routes"]]) {
            const opt = document.createElement("option")
            opt.value = val; opt.textContent = label
            if (val === sa.silentAutoFollowMode) opt.selected = true
            followSel.append(opt)
        }
        followSel.addEventListener("change", async () => {
            this.settings.pricing.silentAutoFollowMode = followSel.value
            this.settings = await RouteAssistantSettings.save({pricing: this.settings.pricing})
        })
        followLbl.append(followSel)
        selectorsRow.append(followLbl)
        block.append(selectorsRow)

        // Tick interval + caps row.
        const capsRow = document.createElement("div")
        capsRow.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;margin-bottom:6px;"
        const numField = (label, key, min, max, step, title) => {
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;"
            lbl.title = title
            lbl.append(document.createTextNode(label))
            const inp = mkNumberInput(sa[key], {min, max, step, width: "54px"})
            inp.addEventListener("change", async () => {
                const v = parseFloat(inp.value)
                if (!isFinite(v)) return
                const clamped = Math.max(min, Math.min(max, v))
                this.settings.pricing[key] = clamped
                inp.value = String(clamped)
                this.settings = await RouteAssistantSettings.save({pricing: this.settings.pricing})
                if (key === "silentAutoTickMin") this._restartSilentAutoLoop()
            })
            lbl.append(inp)
            return lbl
        }
        const cadenceField = () => {
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;"
            lbl.title = "Seconds between ticks. Foreground tabs support a 5-second minimum; background alarms are a coarser fallback."
            lbl.append(document.createTextNode("Tick (sec)"))
            const inp = mkNumberInput(Math.round(this._silentAutoTickMs(sa) / 1000), {
                min: 5,
                max: 14400,
                step: 1,
                width: "62px"
            })
            inp.addEventListener("change", async () => {
                const v = parseFloat(inp.value)
                if (!isFinite(v)) return
                const seconds = Math.max(5, Math.min(14400, v))
                this.settings.pricing.silentAutoTickSec = seconds
                this.settings.pricing.silentAutoTickMin = seconds / 60
                inp.value = String(seconds)
                this.settings = await RouteAssistantSettings.save({pricing: this.settings.pricing})
                this._restartSilentAutoLoop()
            })
            lbl.append(inp)
            return lbl
        }
        capsRow.append(cadenceField())
        capsRow.append(numField("Max/day", "silentAutoMaxPerDay", 0, 200, 1,
            "Hard cap on successful silent-auto applies in any 24h window. 0 = disabled."))
        capsRow.append(numField("Max/hour", "silentAutoMaxPerHour", 0, 50, 1,
            "Hard cap in any 1h window. 0 = disabled. Acts as the floor-level rate limit."))
        capsRow.append(numField("Min Δ%", "silentAutoMinDeltaPct", 0, 50, 0.5,
            "Proposer noise floor. Routes whose computed |Δ%| is below this are skipped."))
        capsRow.append(numField("Max step %", "silentAutoMaxStepPct", 0.5, 50, 0.5,
            "Per-tick clamp on |Δ%|. The proposer never moves a route more than this in a single tick — convergence over multiple ticks is intentional."))
        block.append(capsRow)

        if (sa.silentAutoStrategy === "per-class-elasticity") {
            const pcWrap = document.createElement("div")
            pcWrap.style.cssText = "margin:6px 0 8px 0;padding:6px 8px;background:rgba(15,23,42,0.55);"
                + "border:1px solid #1f2937;border-radius:3px;font-size:10px;"
            const pcGrid = document.createElement("div")
            pcGrid.style.cssText = "display:grid;grid-template-columns:58px 66px 92px 92px;gap:4px 8px;align-items:center;"
            for (const h of ["Class", "Enabled", "Max step", "Min pool"]) {
                const hd = document.createElement("div")
                hd.textContent = h
                hd.style.cssText = "color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;"
                pcGrid.append(hd)
            }
            const saveClassMap = async (key, cls, value) => {
                const map = Object.assign({}, this.settings.pricing[key] || {})
                map[cls] = value
                this.settings.pricing[key] = map
                this.settings = await RouteAssistantSettings.save({pricing: this.settings.pricing})
            }
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const clsEl = document.createElement("div")
                clsEl.textContent = cls
                clsEl.style.cssText = "color:#e2e8f0;font-weight:600;font-variant-numeric:tabular-nums;"

                const enabled = document.createElement("input")
                enabled.type = "checkbox"
                enabled.checked = !sa.silentAutoPerClassEnabled
                    || sa.silentAutoPerClassEnabled[cls] !== false
                enabled.title = cls + " proposer gate"
                enabled.addEventListener("change", async () => {
                    await saveClassMap("silentAutoPerClassEnabled", cls, !!enabled.checked)
                })

                const cap = mkNumberInput(
                    sa.silentAutoPerClassMaxStepPct && sa.silentAutoPerClassMaxStepPct[cls],
                    {min: 0, max: 50, step: 0.5, width: "70px"}
                )
                cap.placeholder = "global"
                cap.title = cls + " max step %. Empty uses global Max step."
                cap.addEventListener("change", async () => {
                    const v = parseFloat(cap.value)
                    if (!isFinite(v)) {
                        cap.value = ""
                        await saveClassMap("silentAutoPerClassMaxStepPct", cls, null)
                        return
                    }
                    const clamped = Math.max(0, Math.min(50, v))
                    cap.value = String(clamped)
                    await saveClassMap("silentAutoPerClassMaxStepPct", cls, clamped)
                })

                const minPool = mkNumberInput(
                    sa.silentAutoPerClassMinDemandPool && sa.silentAutoPerClassMinDemandPool[cls],
                    {min: 0, max: 1000000, step: cls === "Cargo" ? 100 : 1, width: "74px"}
                )
                minPool.placeholder = "default"
                minPool.title = cls + " minimum demand pool. Empty uses the per-class default."
                minPool.addEventListener("change", async () => {
                    const v = parseFloat(minPool.value)
                    if (!isFinite(v)) {
                        minPool.value = ""
                        await saveClassMap("silentAutoPerClassMinDemandPool", cls, null)
                        return
                    }
                    const clamped = Math.max(0, Math.min(1000000, v))
                    minPool.value = String(clamped)
                    await saveClassMap("silentAutoPerClassMinDemandPool", cls, clamped)
                })

                pcGrid.append(clsEl, enabled, cap, minPool)
            }
            pcWrap.append(pcGrid)
            block.append(pcWrap)
        }

        // Activity feed host — refreshed in-place by `_refreshSilentAutoActivity`.
        const activityHost = document.createElement("div")
        activityHost.setAttribute("data-aes-silent-auto-activity", "1")
        activityHost.style.cssText = "margin-top:6px;"
        block.append(activityHost)
        this._renderSilentAutoActivity(activityHost, sa)

        return block
    }

    window.RouteAssistantPanel.prototype._closePricingApplyModal = function() {
        if (!this._pricingApplyModal) return
        const {overlay, onKey} = this._pricingApplyModal
        if (onKey) document.removeEventListener("keydown", onKey)
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
        this._pricingApplyModal = null
    }

}
