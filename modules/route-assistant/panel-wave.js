/**
 * Wave Overlay UI features for RouteAssistantPanel.
 * Mixed into RouteAssistantPanel.prototype.
 */

if (typeof window.RouteAssistantPanel !== "undefined") {
    /**
     * H slice 1 — Wave View toggle. When ON, _renderRows() takes the
     * wave-overlay branch which replaces the table with a Gantt timeline
     * built from this.scoredRows (top-N) + the user's selected preset.
     * Persisted to settings.waveView so the mode survives page reloads.
     */
    window.RouteAssistantPanel.prototype._toggleWaveView = async function() {
        const next = !(this.settings && this.settings.waveView)
        await this._setPanelMode(next ? "waves" : "table")
        // Invalidate cached build so toggling re-runs against current rows.
        this._waveBuild = null
        this._render()
    }

    /**
     * H slice 1 — Wave View render path. Replaces the table with a
     * Gantt timeline of the recommended schedule for the top-N scored
     * rows, built via ScheduleBuilder + the user's selected preset.
     *
     * Read-only against ScheduleStore — slice 1 visualises only.
     */
    window.RouteAssistantPanel.prototype._renderWaveOverlay = async function(sorted) {
        this.tableHost.innerHTML = ""

        const wo = (this.settings && this.settings.waveOverlay) || {}
        const topN = Math.max(1, Math.min(100, Number(wo.topN) || 20))

        if (!this._wavePresets) {
            this._wavePresets = await SchedulePresets.load()
        }
        const presets = (this._wavePresets && this._wavePresets.presets) || []
        const pickedId = wo.lastPresetId
            || (this._wavePresets && this._wavePresets.defaultPresetId)
            || (presets[0] && presets[0].id)
            || null
        const preset = pickedId ? presets.find(p => p.id === pickedId) : null

        // Slice 2 — multi-hub. Picker memory falls back to the panel's
        // mounted hub. recentHubs is already capped at 5 by Q15.
        const recentHubs = (this.settings && this.settings.recentHubs) || []
        const pickedHub  = (wo.lastHub && /^[A-Z]{3}$/i.test(wo.lastHub))
            ? String(wo.lastHub).toUpperCase()
            : this.hubIata

        // F slice 4 — Draft awareness. Load the per-hub draft record so
        // the header / banner can detect "this preset is the draft of X"
        // and surface the promote / discard / save-as-variant actions.
        let draftRec = null
        if (typeof RouteAssistantWaveDraftStore !== "undefined") {
            draftRec = await RouteAssistantWaveDraftStore.load(pickedHub)
        }
        const isDraft = !!(draftRec && preset && preset.id === draftRec.draftPresetId)
        this._waveDraftRecord = draftRec
        this._waveIsDraft = isDraft

        this.tableHost.append(
            this._buildWaveHeader(preset, presets, topN, pickedHub, recentHubs, {
                draftRecord: draftRec, isDraft: isDraft
            })
        )

        if (isDraft && typeof RouteAssistantWaveDraftStore !== "undefined") {
            const draftBanner = await this._renderWaveDraftBanner(
                draftRec, presets, pickedHub)
            if (draftBanner) this.tableHost.append(draftBanner)
        }

        // Slice D — empty-state CTA. Was a dead-end "open the dashboard"
        // hint; now creates a starter preset directly via SchedulePresets.
        if (!preset) {
            if (typeof RouteAssistantWaveEditor !== "undefined") {
                const emptyHost = document.createElement("div")
                this.tableHost.append(emptyHost)
                RouteAssistantWaveEditor.renderEmptyState(emptyHost, pickedHub, {
                    dashboardUrl: "/app/enterprise/dashboard",
                    onCreated: async (created) => {
                        // Make the new preset the active one + reload caches
                        // so the next render shows the editable Gantt.
                        this._wavePresets = null
                        this.settings.waveOverlay = Object.assign({},
                            this.settings.waveOverlay || {}, {lastPresetId: created.id})
                        try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
                        catch (e) { /* non-fatal */ }
                        this._waveBuild = null
                        this._renderRows()
                    }
                })
            } else {
                const empty = document.createElement("div")
                empty.style.cssText = "margin:18px 0;padding:14px;border:1px dashed #4c1d95;"
                    + "background:rgba(124,58,237,0.06);border-radius:4px;color:#d8b4fe;"
                empty.innerHTML = "<strong>No wave preset configured.</strong>"
                this.tableHost.append(empty)
            }
            return
        }

        const waveFleetCtx = (typeof this._fleetContext === "function")
            ? this._fleetContext() : null
        if (!waveFleetCtx) {
            const banner = document.createElement("div")
            banner.style.cssText = "margin:6px 0;padding:6px 10px;font-size:11px;"
                + "background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.30);"
                + "border-radius:3px;color:#fde68a;"
            banner.textContent = "No aircraft context — pick Fleet, type, or tail in the panel header to size haul buckets and skip OOR routes."
            this.tableHost.append(banner)
        }

        // Slice 2 — preset.hub mismatch warning. Build still proceeds; the
        // builder treats preset.hub as the hub label, not a constraint.
        if (preset.hub && pickedHub
            && String(preset.hub).toUpperCase() !== pickedHub) {
            const banner = document.createElement("div")
            banner.style.cssText = "margin:6px 0;padding:6px 10px;font-size:11px;"
                + "background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.30);"
                + "border-radius:3px;color:#fde68a;"
            banner.textContent = "Preset hub \"" + preset.hub
                + "\" doesn't match picked hub \"" + pickedHub
                + "\" — flights use the preset's hub field as origin label."
            this.tableHost.append(banner)
        }

        // Slice 2 — resolve which routes feed the build. Same hub returns
        // the panel's sorted scoredRows; cross-hub falls back to the
        // per-hub topRoutes cache populated by _publishTopRoutes.
        const {routes: hubRoutes, banner: hubBanner} =
            await this._resolvePickedHubRoutes(pickedHub, sorted)

        // Coherence slice — hydrate the interline cache for the picked
        // hub so cross-hub waves render pills. No-op when pickedHub
        // matches the panel's primary hub (already hydrated in refresh)
        // or when the hub has been hydrated previously.
        if (pickedHub
            && this.hubIata
            && String(pickedHub).toUpperCase() !== String(this.hubIata).toUpperCase()
            && Array.isArray(hubRoutes) && hubRoutes.length) {
            const dests = hubRoutes.map(r => r && r.destIata).filter(Boolean)
            await this._hydrateInterlineCacheForHub(pickedHub, dests)
        }
        if (hubBanner) {
            const banner = document.createElement("div")
            banner.style.cssText = "margin:6px 0;padding:6px 10px;font-size:11px;"
                + "background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.30);"
                + "border-radius:3px;color:#fde68a;"
            banner.textContent = hubBanner
            this.tableHost.append(banner)
        }

        // Slice E — load per-(hub, preset) wave overrides up front so
        // the build signature includes them. GC stale entries pointing
        // at deleted wave ids — slice D made delete a one-click action.
        const overridesMap = (typeof RouteAssistantWaveOverridesStore !== "undefined")
            ? await RouteAssistantWaveOverridesStore.pruneToWaves(
                pickedHub, preset.id, (preset.waves || []).map(w => w.id))
            : {}
        const ovSig = Object.keys(overridesMap).sort()
            .map(k => k + "=" + overridesMap[k]).join(",")

        // F slice 3 — optimizeMode supersedes the legacy `optimize` boolean.
        // Backwards-compat: `optimize: true` is read as "connection".
        const optimizeMode = wo.optimizeMode
            || (wo.optimize ? "connection" : "greedy")
        const useProfit = optimizeMode === "profit"
        const useConnection = optimizeMode === "connection"

        const fleetSig = waveFleetCtx && Array.isArray(waveFleetCtx.fleetSpecs)
            ? waveFleetCtx.fleetSpecs.map(s => s && s.typeId || "?").sort().join(",")
            : ""

        const buildSig = (preset.id || "?") + ":" + topN
            + ":" + (this.selectedSpec ? this.selectedSpec.typeId : "none")
            + ":" + fleetSig
            + ":" + (hubRoutes ? hubRoutes.length : 0)
            + ":" + pickedHub
            + ":" + ovSig
            + ":" + optimizeMode
        if (!this._waveBuild
            || this._waveBuild._sig !== buildSig
            || this._waveBuildHub !== pickedHub) {
            this._waveBuild = RouteAssistantWaveOverlay.buildSchedule(preset, hubRoutes, {
                server:            this.server,
                airlineCode:       this._currentAirlineCode(),
                hubIata:           pickedHub,
                selectedSpec:      this.selectedSpec,
                topN:              topN,
                carrierClassifier: this._carrierClassifierForFlight(),
                // H slice 3b.2 — interline-share callback so the renderer
                // can pin a "Y 30%" pill on the curve midpoint of every
                // connection that has a recorded codeshare partner.
                interlineShareLookup: this._interlineShareLookup(pickedHub),
                overrides:         overridesMap,
                optimize:          useConnection,
                mode:              useProfit ? "profit" : null,
                fleetSpecs:        waveFleetCtx && waveFleetCtx.fleetSpecs || null
            })
            this._waveBuild._sig = buildSig
            this._waveBuildHub   = pickedHub
        }

        const hasWaveValidationErrors = !!(this._waveBuild.validation && this._waveBuild.validation.length)
        if (hasWaveValidationErrors) {
            const vbox = document.createElement("div")
            vbox.style.cssText = "margin:8px 0;padding:8px 10px;"
                + "background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.40);"
                + "border-radius:3px;color:#fca5a5;font-size:11px;"
            const h = document.createElement("strong")
            h.textContent = "Preset \"" + preset.name + "\" has issues — fix the editable wave fields below:"
            h.style.cssText = "display:block;margin-bottom:4px;"
            vbox.append(h)
            for (const err of this._waveBuild.validation) {
                const line = document.createElement("div")
                line.textContent = "• " + err
                vbox.append(line)
            }
            this.tableHost.append(vbox)
        }

        const automationCtx = await this._buildWaveAutomationContext(
            pickedHub, preset, this._wavePresets, hubRoutes)
        if (automationCtx) {
            this._waveAutomationContext = automationCtx
            this.tableHost.append(this._renderWaveAutomationStrip(
                automationCtx, preset, pickedHub, {
                    hasValidationErrors: hasWaveValidationErrors
                }))
        }

        if (!hubRoutes || !hubRoutes.length) {
            const hint = document.createElement("div")
            hint.style.cssText = "margin:18px 0;padding:14px;color:#9ca3af;"
                + "background:rgba(75,85,99,0.10);border-radius:4px;"
            hint.textContent = "No scored routes available for " + pickedHub
                + " — run the demand seed, wait for distance enrichment, "
                + "or visit /app/com/scheduling/" + pickedHub + " once."
            this.tableHost.append(hint)
            return
        }

        // Slice 8a — Fleet apply CTA. Slots between the per-build banners
        // and the Gantt so the action is visible above the fold. Loaded
        // only when both fleet modules are present (manifest-gated to
        // /app/com/scheduling and AFP pages); otherwise we skip the strip
        // silently rather than confuse the user with a dead button.
        if (typeof window.AesAfpFleetPickerModal !== "undefined"
                && typeof window.AesAfpFleetApplyOrchestrator !== "undefined"
                && !hasWaveValidationErrors
                && this._waveBuild && Array.isArray(this._waveBuild.flights)
                && this._waveBuild.flights.length) {
            const strip = document.createElement("div")
            strip.style.cssText = "margin:6px 0;padding:6px 10px;font-size:11px;"
                + "background:rgba(124,45,18,0.10);border:1px solid rgba(154,52,18,0.50);"
                + "border-radius:3px;color:#fed7aa;display:flex;align-items:center;gap:10px;"
            const text = document.createElement("span")
            text.style.cssText = "flex:1 1 auto;color:#fdba74;"
            text.textContent = this._waveBuild.flights.length + " leg(s) ready · "
                + (preset.name || "preset") + " · hub " + pickedHub
            const btnOne = document.createElement("button")
            btnOne.type = "button"
            btnOne.textContent = "Open in flight plan…"
            btnOne.style.cssText = "background:transparent;color:#fdba74;"
                + "border:1px solid #9a3412;border-radius:3px;padding:3px 10px;"
                + "font-size:11px;cursor:pointer;"
            btnOne.title = "Pick a single aircraft, hand the wave plan off via the"
                + " shared handoff store, and open its AFP page with the preset preloaded."
            btnOne.addEventListener("click", () =>
                this._handoffWaveToAircraft(preset, pickedHub))
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = "Apply to fleet…"
            btn.style.cssText = "background:#7c2d12;color:#fed7aa;border:1px solid #9a3412;"
                + "border-radius:3px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;"
            btn.title = "Pick fleet aircraft and run aes:afp:apply-batch per aircraft serially."
            btn.addEventListener("click", () => this._applyWaveToFleet(preset, pickedHub))
            strip.appendChild(text)
            strip.appendChild(btnOne)
            strip.appendChild(btn)
            this.tableHost.append(strip)
        }

        const ganttHost = document.createElement("div")
        ganttHost.style.marginTop = "4px"
        this.tableHost.append(ganttHost)

        // Slice D — wire the wave-editor callbacks so each lane label
        // becomes a live editor (composition spinners, time inputs,
        // delete) and the gantt grows an "+ Add wave" footer.
        const editorOpts = (typeof RouteAssistantWaveEditor !== "undefined") ? {
            onEnhanceLabel: (labelEl, wave, p) => {
                RouteAssistantWaveEditor.enhanceLaneLabel(labelEl, wave, p, {
                    onComposition: (waveId, partial) =>
                        this._editWaveComposition(preset.id, waveId, partial),
                    onTime: (waveId, field, time) =>
                        this._editWaveTime(preset.id, waveId, field, time),
                    onRemoveWave: (waveId) =>
                        this._editRemoveWave(preset.id, waveId)
                })
            },
            onAddWave: () => this._editAddWave(preset.id)
        } : {}

        // Slice E — drag/drop + forced-release + auto-fill callbacks.
        // The Unplaced strip turns chips into drag sources; lane strips
        // become drop targets; clicking a 📌-marked bar releases the
        // override; Auto-fill bumps composition counts until everything
        // unplaced fits.
        const dndOpts = (typeof RouteAssistantWaveOverridesStore !== "undefined") ? {
            onPlace:         (destIata, waveId) =>
                this._waveOverridePlace(pickedHub, preset.id, destIata, waveId),
            onReleaseForced: (destIata) =>
                this._waveOverrideRelease(pickedHub, preset.id, destIata),
            onAutoFill:      () =>
                this._waveAutoFill(preset.id, this._waveBuild.unplaced || [])
        } : {}

        RouteAssistantWaveOverlay.renderGantt(ganttHost, this._waveBuild, Object.assign({
            hubIata:         pickedHub,
            showConnections: wo.showConnections !== false,
            onFlightClick: (flight) => {
                const partner = (flight.direction === "inbound")
                    ? flight.origin
                    : flight.destination
                if (pickedHub && partner) {
                    const url = "/app/com/scheduling/"
                        + encodeURIComponent(pickedHub) + encodeURIComponent(partner)
                    window.open(url, "_blank", "noopener")
                }
            },
            // H slice 3b.2 follow-up — pill click-through opens the per-route
            // popover. Hub-pinned popover only works when the pill's hub
            // matches the panel's hub; cross-hub views fall back to opening
            // the destination's scheduling page in a new tab.
            onInterlinePillClick: (destIata, anchorEl) => {
                if (this.hubIata && pickedHub
                        && String(this.hubIata).toUpperCase() === String(pickedHub).toUpperCase()) {
                    this._openInterlinePopover({destIata: String(destIata).toUpperCase()}, anchorEl)
                } else if (pickedHub && destIata) {
                    const url = "/app/com/scheduling/"
                        + encodeURIComponent(pickedHub) + encodeURIComponent(destIata)
                    window.open(url, "_blank", "noopener")
                }
            }
        }, editorOpts, dndOpts))

        // F slice 1 — Plan diagnostics card. Pure additive: when the
        // module isn't loaded (older manifest), or the build has no
        // flights, render nothing. Score badge in the header gets its
        // value backfilled here so the header doesn't have to wait on
        // the build.
        if (typeof RouteAssistantWavePlanDiagnostics !== "undefined"
                && this._waveBuild && Array.isArray(this._waveBuild.flights)) {
            const fleetCtx = (typeof this._fleetContext === "function")
                ? this._fleetContext() : null
            const fleetCount = fleetCtx
                ? (Array.isArray(fleetCtx.fleetSpecs) && fleetCtx.fleetSpecs.length
                    ? fleetCtx.fleetSpecs.length : 1)
                : 0
            const diag = RouteAssistantWavePlanDiagnostics.scorePlan(
                this._waveBuild, this.scoredRows, {
                    hubIata:           pickedHub,
                    selectedSpec:      this.selectedSpec,
                    fleetSpecs:        fleetCtx && fleetCtx.fleetSpecs || null,
                    carrierClassifier: this._carrierClassifierForFlight(),
                    fleetCount:        fleetCount
                })
            this._waveDiagnostics = diag

            const diagHost = document.createElement("div")
            this.tableHost.append(diagHost)
            this._renderDiagnosticsCard(diagHost, diag, {hubIata: pickedHub})

            const slot = this.tableHost.querySelector("[data-aes-plan-score]")
            if (slot) {
                const color = RouteAssistantWavePlanDiagnostics.colorForScore(diag.planScore)
                slot.textContent = "Score " + diag.planScore + "/100 · " + diag.planGrade
                slot.style.color = color
                slot.style.borderColor = color + "55"
                slot.style.background = color + "12"
            }
        }

        // F slice 2 — Route-fit-against-plan workspace. Renders below
        // the diagnostics card when sub-mode is "routes" — every scored
        // row categorised + ranked + actionable. Pure additive; older
        // manifest just hides the toggle and skips the panel.
        if ((wo.subMode === "routes")
                && typeof RouteAssistantWaveRouteFitter !== "undefined"
                && this._waveBuild) {
            const fitFleetCtx = (typeof this._fleetContext === "function")
                ? this._fleetContext() : null
            const fit = RouteAssistantWaveRouteFitter.rankRoutesByPlanFit(
                this.scoredRows, this._waveBuild, {
                    hubIata:      pickedHub,
                    selectedSpec: this.selectedSpec,
                    fleetSpecs:   fitFleetCtx ? fitFleetCtx.fleetSpecs : null,
                    topN:         topN
                })
            this._waveRouteFit = fit
            const fitHost = document.createElement("div")
            this.tableHost.append(fitHost)
            this._renderRouteFitterPanel(fitHost, fit, {
                hubIata:  pickedHub,
                presetId: preset.id,
                preset:   preset
            })
        }
    }

    /**
     * F slice 1 — One per-wave row in the diagnostics table. Includes a
     * tiny utilization bar, profit, and connection mix pills.
     */
    window.RouteAssistantPanel.prototype._renderWaveDiagnosticRow = function(pw, diag, fmtMoney) {
        const row = document.createElement("div")
        row.style.cssText = "display:grid;grid-template-columns:90px 1fr 70px 90px 110px 18px;"
            + "gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #161e2c;"
            + "font-size:11px;"

        const lbl = document.createElement("span")
        lbl.textContent = pw.label
        lbl.style.cssText = "color:#cbd5e1;font-weight:600;font-size:11px;"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        lbl.title = (pw.arrivalWindow ? "arr " + pw.arrivalWindow.start + "–" + pw.arrivalWindow.end : "")
            + (pw.departureWindow ? "  ·  dep " + pw.departureWindow.start + "–" + pw.departureWindow.end : "")
        row.append(lbl)

        const barWrap = document.createElement("div")
        barWrap.style.cssText = "position:relative;height:8px;background:#0f1623;"
            + "border:1px solid #1f2937;border-radius:2px;overflow:hidden;"
        const ratio = pw.slotsTotal > 0 ? Math.min(1, pw.slotsUsed / pw.slotsTotal) : 0
        const barColor = pw.utilizationPct >= 80 ? "#10b981"
            : pw.utilizationPct >= 50 ? "#fbbf24" : "#ef4444"
        const bar = document.createElement("div")
        bar.style.cssText = "position:absolute;inset:0;width:" + (ratio * 100) + "%;"
            + "background:" + barColor + ";opacity:0.7;"
        barWrap.append(bar)
        row.append(barWrap)

        const used = document.createElement("span")
        used.textContent = pw.slotsUsed + "/" + pw.slotsTotal
        used.style.cssText = "color:#cbd5e1;font-family:var(--aes-font-mono,monospace);"
            + "font-size:11px;text-align:right;"
        row.append(used)

        const prof = document.createElement("span")
        prof.textContent = pw.profitKnown ? fmtMoney(pw.profitPerWeek) : "—"
        prof.style.cssText = "color:" + (pw.profitPerWeek > 0 ? "#86efac"
            : pw.profitKnown ? "#fda4af" : "#6b7280") + ";"
            + "font-family:var(--aes-font-mono,monospace);font-size:11px;text-align:right;"
        if (pw.profitMissing > 0) {
            prof.title = pw.profitMissing + " route(s) here have no profit estimate"
                + " — pick Fleet, type, or tail to populate."
        }
        row.append(prof)

        const conn = document.createElement("div")
        conn.style.cssText = "display:flex;gap:3px;font-size:9px;align-items:center;"
        const total = pw.ownConn + pw.interlineConn + pw.allianceConn
        if (total === 0) {
            const empty = document.createElement("span")
            empty.textContent = "no conn"
            empty.style.cssText = "color:#6b7280;font-style:italic;"
            conn.append(empty)
        } else {
            const mkPill = (n, color, glyph, title) => {
                if (!n) return null
                const p = document.createElement("span")
                p.textContent = glyph + n
                p.style.cssText = "padding:1px 4px;border-radius:6px;"
                    + "color:" + color + ";border:1px solid " + color + "55;"
                    + "background:" + color + "10;font-size:9px;"
                p.title = title
                return p
            }
            const own = mkPill(pw.ownConn, "#60a5fa", "● ", "Own / intra-airline")
            const inl = mkPill(pw.interlineConn, "#fbbf24", "▬", "Interline")
            const ali = mkPill(pw.allianceConn, "#a78bfa", "╴", "Alliance")
            for (const p of [own, inl, ali]) if (p) conn.append(p)
        }
        row.append(conn)

        const fitColor = RouteAssistantWavePlanDiagnostics.colorForFit(pw.fitQuality)
        const fit = document.createElement("span")
        fit.textContent = pw.fitQuality === "good" ? "✓"
            : pw.fitQuality === "warn" ? "!" : "✗"
        fit.title = pw.fitQuality === "good" ? "Healthy"
            : pw.fitQuality === "warn" ? "Underutilised or no connections"
            : pw.slotsTotal === 0 ? "No capacity configured" : "Empty / poor fit"
        fit.style.cssText = "color:" + fitColor + ";font-weight:bold;text-align:center;"
        row.append(fit)

        return row
    }

    /** F slice 2 — inline wave picker for pin-to-any-wave. */
    window.RouteAssistantPanel.prototype._mkRouteFitWavePicker = function(row, opts, waves) {
        const pick = document.createElement("select")
        pick.title = "Pin this route to a specific wave (forces placement even if buckets are full)."
        pick.style.cssText = "background:#0f1623;color:#cbd5e1;"
            + "border:1px solid #475569;border-radius:2px;"
            + "padding:1px 4px;font-size:9px;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "📌 Pin to…"
        pick.append(placeholder)
        for (const w of waves) {
            const o = document.createElement("option")
            o.value = w.id
            o.textContent = w.label || ("Wave " + (waves.indexOf(w) + 1))
            pick.append(o)
        }
        pick.addEventListener("change", () => {
            const wid = pick.value
            if (!wid) return
            this._waveOverridePlace(opts.hubIata, opts.presetId, row.destIata, wid)
        })
        return pick
    }

    /**
     * F slice 4 — Render the amber draft banner shown beneath the
     * header while a draft is active. Includes baseline name, Δ profit /
     * Δ utilisation / Δ unplaced + three actions: Promote → live ·
     * Save as variant · Discard.
     */
    window.RouteAssistantPanel.prototype._renderWaveDraftBanner = async function(draftRec, presets, pickedHub) {
        if (!draftRec) return null
        const baseline = (presets || []).find(p => p.id === draftRec.baselineId) || null
        const drifted = baseline && Number(baseline.updatedAt || 0)
            > Number(draftRec.baselineUpdatedAt || 0)

        const banner = document.createElement("div")
        banner.style.cssText = "margin:6px 0;padding:8px 12px;font-size:11px;"
            + "background:rgba(251,146,60,0.10);"
            + "border:1px solid rgba(251,146,60,0.50);border-radius:4px;"
            + "color:#fed7aa;display:flex;flex-wrap:wrap;align-items:center;gap:10px;"

        const head = document.createElement("strong")
        head.textContent = "🟧 Draft mode"
        head.style.color = "#fed7aa"
        banner.append(head)

        const text = document.createElement("span")
        text.style.cssText = "color:#fdba74;flex:1 1 auto;min-width:120px;"
        text.textContent = baseline
            ? "comparing to “" + baseline.name + "”"
            : "(baseline preset deleted — promote will save as a new preset)"
        banner.append(text)

        if (typeof RouteAssistantWavePlanDiagnostics !== "undefined"
                && this._waveBuild && this.scoredRows && baseline) {
            const baselineBuild = RouteAssistantWaveOverlay.buildSchedule(
                baseline, this.scoredRows, {
                    server:            this.server,
                    airlineCode:       this._currentAirlineCode(),
                    hubIata:           pickedHub,
                    selectedSpec:      this.selectedSpec,
                    topN:              Math.max(1, Math.min(100,
                                          Number((this.settings.waveOverlay || {}).topN) || 20)),
                    carrierClassifier: this._carrierClassifierForFlight(),
                    overrides:         {},
                    optimize:          false
                })
            const baseDiag = RouteAssistantWavePlanDiagnostics.scorePlan(
                baselineBuild, this.scoredRows, {
                    hubIata:           pickedHub,
                    selectedSpec:      this.selectedSpec,
                    carrierClassifier: this._carrierClassifierForFlight(),
                    fleetCount:        1
                })
            const draftDiag = this._waveDiagnostics
            if (baseDiag && draftDiag) {
                banner.append(this._renderDraftDeltaStrip(baseDiag, draftDiag))
            }
        }

        const mkBtn = (label, title, bg, fg, onClick) => {
            const b = document.createElement("button")
            b.type = "button"
            b.textContent = label
            b.title = title
            b.style.cssText = "background:" + bg + ";color:" + fg + ";"
                + "border:1px solid " + bg + ";border-radius:3px;"
                + "padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;"
            b.addEventListener("click", (e) => { e.preventDefault(); onClick() })
            return b
        }
        banner.append(mkBtn("Promote → live",
            "Copy the draft's waves + factors back into the baseline preset, then delete the draft.",
            "#065f46", "#a7f3d0",
            () => this._draftPromote(pickedHub)))
        banner.append(mkBtn("Save as variant",
            "Keep the baseline untouched; rename the draft to a permanent variant.",
            "#1e3a8a", "#bfdbfe",
            () => this._draftSaveAsVariant(pickedHub)))
        banner.append(mkBtn("Discard",
            "Delete the draft and return to the baseline preset.",
            "#7f1d1d", "#fecaca",
            () => this._draftDiscard(pickedHub)))

        if (drifted) {
            const drift = document.createElement("div")
            drift.style.cssText = "flex-basis:100%;color:#fcd34d;font-size:10px;"
                + "font-style:italic;margin-top:4px;"
            drift.textContent = "⚠ Live preset has been edited since this draft started."
                + " The Δ values may be misleading."
            banner.append(drift)
        }

        return banner
    }

    /**
     * F slice 5 — Run the backtest engine against the active preset and
     * render the results modal. Caches the result by (presetId, baseline
     * updatedAt) on this._waveBacktest so re-opening is instant.
     */
    window.RouteAssistantPanel.prototype._runWaveBacktest = async function(pickedHub, preset) {
        if (typeof RouteAssistantWavePlanBacktest === "undefined") return
        if (typeof RouteAssistantYieldHistoryStore === "undefined") return
        const cacheKey = (preset.id || "?") + ":" + (preset.updatedAt || 0)
            + ":" + pickedHub
        if (!this._waveBacktest || this._waveBacktest._cacheKey !== cacheKey) {
            const pairs = []
            for (const row of (this.scoredRows || [])) {
                if (!row || !row.destIata) continue
                pairs.push([pickedHub, String(row.destIata).toUpperCase()])
            }
            const yieldHistoryByPair = await RouteAssistantYieldHistoryStore.getMany(pairs)
            const result = RouteAssistantWavePlanBacktest.backtestPlan(
                preset, this.scoredRows, yieldHistoryByPair, {
                    hubIata:      pickedHub,
                    server:       this.server,
                    airlineCode:  this._currentAirlineCode(),
                    selectedSpec: this.selectedSpec,
                    weeksWindow:  RouteAssistantWavePlanBacktest.DEFAULT_WEEKS,
                    topN:         50
                })
            result._cacheKey = cacheKey
            this._waveBacktest = result
        }
        this._renderWaveBacktestModal(this._waveBacktest, preset, pickedHub)
    }

    /**
     * F slice 5 — Modal: weekly chart + summary + winner/loser routes.
     * Built fresh each time so dispose is clean (close-button removes it).
     */
    window.RouteAssistantPanel.prototype._renderWaveBacktestModal = function(result, preset, pickedHub) {
        document.querySelectorAll("[data-aes-wave-backtest-modal]")
            .forEach(n => n.remove())

        const overlay = document.createElement("div")
        overlay.dataset.aesWaveBacktestModal = "1"
        overlay.style.cssText = "position:fixed;inset:0;z-index:99999;"
            + "background:rgba(2,6,23,0.78);display:flex;align-items:center;"
            + "justify-content:center;padding:24px;"

        const modal = document.createElement("div")
        modal.style.cssText = "max-width:760px;width:100%;max-height:85vh;"
            + "overflow:auto;background:#0f1623;border:1px solid #1f2937;"
            + "border-radius:6px;color:#e5e7eb;font-size:11px;"
            + "box-shadow:0 20px 60px rgba(0,0,0,0.5);"

        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;gap:10px;"
            + "padding:10px 14px;background:#1e3a8a;border-bottom:1px solid #1e40af;"
        const title = document.createElement("strong")
        title.textContent = "📈 Plan backtest"
        title.style.cssText = "color:#dbeafe;font-size:13px;flex:1;"
        const sub = document.createElement("span")
        sub.textContent = "“" + (preset.name || "preset") + "” · hub " + pickedHub
        sub.style.cssText = "color:#bfdbfe;font-size:10px;"
        header.append(title, sub)
        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "✕"
        closeBtn.title = "Close"
        closeBtn.style.cssText = "background:transparent;color:#dbeafe;border:0;"
            + "font-size:14px;cursor:pointer;padding:0 6px;"
        closeBtn.addEventListener("click", () => overlay.remove())
        header.append(closeBtn)
        modal.append(header)

        const body = document.createElement("div")
        body.style.cssText = "padding:14px;"

        if (result.insufficient) {
            const banner = document.createElement("div")
            banner.style.cssText = "padding:12px;background:rgba(251,191,36,0.10);"
                + "border:1px solid rgba(251,191,36,0.40);border-radius:4px;"
                + "color:#fde68a;font-size:11px;"
            banner.textContent = "Insufficient yield history — backtest needs at least "
                + RouteAssistantWavePlanBacktest.MIN_WEEKS
                + " weeks of snapshots across your scored routes."
                + " Enable auto-snapshot in the Route Assistant settings, then return"
                + " in a few weeks once data has accumulated."
            body.append(banner)
            modal.append(body)
            overlay.append(modal)
            document.body.append(overlay)
            return
        }

        const caveat = document.createElement("div")
        caveat.style.cssText = "padding:6px 10px;margin-bottom:10px;font-size:10px;"
            + "background:rgba(99,102,241,0.10);border:1px solid rgba(99,102,241,0.30);"
            + "border-radius:3px;color:#c7d2fe;"
        caveat.innerHTML = "<strong>Note:</strong> this measures route-selection quality, "
            + "not full counterfactual revenue. Demand reflects what you actually flew "
            + "in those weeks; the plan may have benefited from network effects this "
            + "model can't simulate."
        body.append(caveat)

        const fmtMoney = (v) => {
            if (!isFinite(v) || v === 0) return "$0"
            const abs = Math.abs(v), sign = v < 0 ? "−" : "+"
            if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M"
            if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(0) + "k"
            return sign + "$" + abs.toFixed(0)
        }
        const fmtMoneyAbs = (v) => {
            if (!isFinite(v) || v === 0) return "$0"
            const abs = Math.abs(v)
            if (abs >= 1e6) return "$" + (abs / 1e6).toFixed(2) + "M"
            if (abs >= 1e3) return "$" + (abs / 1e3).toFixed(0) + "k"
            return "$" + abs.toFixed(0)
        }
        const sumStrip = document.createElement("div")
        sumStrip.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);"
            + "gap:10px;padding:10px;background:#0a1120;border:1px solid #1f2937;"
            + "border-radius:4px;margin-bottom:14px;"
        const mkSum = (lbl, val, color) => {
            const w = document.createElement("div")
            w.style.cssText = "display:flex;flex-direction:column;gap:2px;"
            const k = document.createElement("span")
            k.textContent = lbl
            k.style.cssText = "color:#6b7280;font-size:9px;text-transform:uppercase;"
                + "letter-spacing:0.5px;"
            const v = document.createElement("span")
            v.textContent = val
            v.style.cssText = "color:" + (color || "#cbd5e1") + ";font-size:14px;"
                + "font-weight:600;font-family:var(--aes-font-mono,monospace);"
            w.append(k, v)
            return w
        }
        const s = result.summary
        sumStrip.append(mkSum("Avg Δ /wk", fmtMoney(s.avgDelta),
            s.avgDelta >= 0 ? "#86efac" : "#fca5a5"))
        sumStrip.append(mkSum("Total Δ ("  + s.weekCount + " wks)",
            fmtMoney(s.totalDelta),
            s.totalDelta >= 0 ? "#86efac" : "#fca5a5"))
        sumStrip.append(mkSum("Win rate",
            Math.round(s.winRate * 100) + "%",
            s.winRate >= 0.5 ? "#86efac" : "#fcd34d"))
        sumStrip.append(mkSum("Volatility", fmtMoneyAbs(s.volatility), null))
        body.append(sumStrip)

        body.append(this._renderBacktestSparkline(result))

        const splits = document.createElement("div")
        splits.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:14px;"
            + "margin-top:14px;"
        splits.append(this._renderBacktestRouteList("Top winners",
            "Routes the plan kept that paid off",
            "#10b981", result.winnerRoutes, fmtMoneyAbs))
        splits.append(this._renderBacktestRouteList("Top losers",
            "Routes the plan dropped that you actually earned on",
            "#ef4444", result.loserRoutes, fmtMoneyAbs))
        body.append(splits)

        modal.append(body)
        overlay.append(modal)
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.remove()
        })
        document.body.append(overlay)
    }

    /**
     * Slice E — write a forced placement to the overrides store and
     * re-render so the route appears in the picked wave with a 📌 badge.
     */
    window.RouteAssistantPanel.prototype._waveOverridePlace = async function(hubIata, presetId, destIata, waveId) {
        if (typeof RouteAssistantWaveOverridesStore === "undefined") return
        await RouteAssistantWaveOverridesStore.set(hubIata, presetId, destIata, waveId)
        if (typeof RouteAssistantToast !== "undefined") {
            RouteAssistantToast.show(destIata + " → " + (waveId || "wave") + " (forced placement saved)",
                {duration: 3000})
        }
        await this._afterWavePresetEdit()
    }

    /**
     * Route-fit workspace — demote an auto-placed route by excluding it
     * from this preset's generated build until the user restores or pins it.
     */
    window.RouteAssistantPanel.prototype._waveOverrideExclude = async function(hubIata, presetId, destIata) {
        if (typeof RouteAssistantWaveOverridesStore === "undefined") return
        if (typeof RouteAssistantWaveOverridesStore.exclude !== "function") return
        await RouteAssistantWaveOverridesStore.exclude(hubIata, presetId, destIata)
        if (typeof RouteAssistantToast !== "undefined") {
            RouteAssistantToast.show(destIata + " demoted from this wave build",
                {duration: 3000})
        }
        await this._afterWavePresetEdit()
    }

    /**
     * Slice E — drop one route's override and re-render. Toast offers a
     * quick-undo by re-placing on the same wave id we just released from.
     */
    window.RouteAssistantPanel.prototype._waveOverrideRelease = async function(hubIata, presetId, destIata) {
        if (typeof RouteAssistantWaveOverridesStore === "undefined") return
        const before = await RouteAssistantWaveOverridesStore.load(hubIata, presetId)
        const releasedFrom = before[String(destIata).toUpperCase()] || null
        await RouteAssistantWaveOverridesStore.clear(hubIata, presetId, destIata)
        if (typeof RouteAssistantToast !== "undefined" && releasedFrom) {
            RouteAssistantToast.show(destIata + " override released — back to greedy fill",
                {duration: 4000})
        }
        await this._afterWavePresetEdit()
    }

    /**
     * Slice 2 — explicit Save schedule CTA. Hands the current in-memory
     * wave build to ScheduleStore so it surfaces in the dashboard's
     * Schedule Management history. Slice 1's invariant ("read-only
     * against ScheduleStore") survives because this is the SOLE write
     * path — never auto-fired on render. The toast carries an Undo that
     * removes the just-saved record.
     *
     * Refuses (with a non-blocking toast) when:
     *   - no build is cached (hasn't run yet),
     *   - the airline code isn't loaded,
     *   - the preset has validation errors (would persist a broken plan),
     *   - the build produced no flights (nothing to save).
     */
    window.RouteAssistantPanel.prototype._saveWaveScheduleToStore = async function() {
        const build = this._waveBuild
        const preset = build && build.preset
        const toastFn = (typeof RouteAssistantToast !== "undefined") ? RouteAssistantToast : null
        if (!build || !preset) {
            if (toastFn) toastFn.warn("No build to save — pick a preset and let the Gantt run first.")
            return
        }
        const airlineCode = this._currentAirlineCode()
        if (!airlineCode) {
            if (toastFn) toastFn.warn("Airline not loaded — wait for fleet sync to finish.")
            return
        }
        if (build.validation && build.validation.length) {
            if (toastFn) toastFn.error("Preset has validation errors — fix them before saving.")
            return
        }
        if (!build.flights || !build.flights.length) {
            if (toastFn) toastFn.warn("Build has no flights — nothing to save.")
            return
        }

        const wo = (this.settings && this.settings.waveOverlay) || {}
        const pickedHub = (wo.lastHub && /^[A-Z]{3}$/i.test(wo.lastHub))
            ? String(wo.lastHub).toUpperCase()
            : this.hubIata

        const record = ScheduleStore.newSchedule({
            server:      this.server,
            airlineCode: airlineCode,
            presetId:    preset.id,
            presetName:  preset.name,
            hub:         pickedHub
        })
        record.flights = build.flights.slice()
        record.warnings = (build.warnings || []).slice()

        // Mirror ScheduleBuilder.build() and surface unplaced + shortfall
        // as warnings on the persisted record so the dashboard's history
        // pill reflects the full picture, not just factor violations.
        for (const route of (build.unplaced || [])) {
            record.warnings.push({
                seq: 0, type: "routeUnplaced",
                message: route.destination + " (" + route.distanceNm
                    + "nm) — no wave with matching bucket capacity"
            })
        }
        for (const key in (build.shortfall || {})) {
            const [waveId, bucket] = key.split(":")
            record.warnings.push({
                seq: 0, type: "shortfall",
                message: "wave " + waveId + " " + bucket + ": needs "
                    + build.shortfall[key] + " more route(s) of this haul-length"
            })
        }

        await this._undoableSave({
            label: "Schedule saved · " + record.flights.length + " flights"
                + (record.warnings.length ? " · " + record.warnings.length + " warning(s)" : ""),
            perform: async () => { await ScheduleStore.save(record) },
            restore: async () => {
                await ScheduleStore.remove(record.server, record.airlineCode, record.scheduleId)
            }
        })
    }

    /**
     * Wave View header strip — preset picker + hub picker (slice 2) +
     * top-N + aircraft display + connection toggle (slice 2) + re-run +
     * edit-presets. Returns the assembled DOM node.
     */
    window.RouteAssistantPanel.prototype._buildWaveHeader = function(preset, presets, topN, pickedHub, recentHubs, hdrOpts) {
        const wrap = document.createElement("div")
        const isDraft = !!(hdrOpts && hdrOpts.isDraft)
        const headerBg = isDraft
            ? "background:rgba(251,146,60,0.10);border:1px solid rgba(251,146,60,0.45);"
            : "background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.25);"
        wrap.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "padding:6px 8px;margin:4px 0 6px 0;font-size:11px;"
            + headerBg
            + "border-radius:4px;"

        const presetSel = document.createElement("select")
        presetSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;"
        if (!presets.length) {
            const o = document.createElement("option")
            o.value = ""
            o.textContent = "(no presets — create one in dashboard)"
            presetSel.append(o)
            presetSel.disabled = true
        } else {
            for (const p of presets) {
                const o = document.createElement("option")
                o.value = p.id
                o.textContent = p.name + (p.hub ? " · " + p.hub : "")
                if (preset && p.id === preset.id) o.selected = true
                presetSel.append(o)
            }
        }
        presetSel.addEventListener("change", async () => {
            const id = presetSel.value
            this.settings.waveOverlay = Object.assign({}, this.settings.waveOverlay || {},
                {lastPresetId: id})
            try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
            catch (e) { /* non-fatal */ }
            this._waveBuild = null
            this._renderRows()
        })
        const presetLbl = document.createElement("label")
        presetLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        presetLbl.append(document.createTextNode("Preset:"), presetSel)
        wrap.append(presetLbl)

        // F slice 1 — Plan score badge. Placeholder filled in by
        // _renderWaveOverlay once diagnostics computes (the build runs
        // after the header is mounted, so we backfill via querySelector).
        if (preset && typeof RouteAssistantWavePlanDiagnostics !== "undefined") {
            const scoreBadge = document.createElement("span")
            scoreBadge.dataset.aesPlanScore = "1"
            scoreBadge.style.cssText = "padding:1px 6px;border-radius:8px;font-size:10px;"
                + "color:#9ca3af;border:1px solid #37415155;background:#37415112;"
                + "font-weight:600;"
            scoreBadge.textContent = "Score …"
            scoreBadge.title = "Plan score — utilisation, profit, connections, demand,"
                + " and warning health combined into a single 0–100 grade."
            wrap.append(scoreBadge)
        }

        // Slice 2 — multi-hub picker. Renders nothing when only one hub
        // has been visited (clean start; no controls bar clutter).
        const hubSel = this._buildWaveHubPicker(pickedHub, recentHubs)
        if (hubSel) {
            const hubLbl = document.createElement("label")
            hubLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            hubLbl.append(document.createTextNode("Hub:"), hubSel)
            wrap.append(hubLbl)
        }

        const topInput = document.createElement("input")
        topInput.type = "number"
        topInput.min = "5"
        topInput.max = "100"
        topInput.step = "1"
        topInput.value = String(topN)
        topInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;width:55px;"
        topInput.addEventListener("change", async () => {
            const n = Math.max(5, Math.min(100, Number(topInput.value) || 20))
            topInput.value = String(n)
            this.settings.waveOverlay = Object.assign({}, this.settings.waveOverlay || {}, {topN: n})
            try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
            catch (e) { /* non-fatal */ }
            this._waveBuild = null
            this._renderRows()
        })
        const topLbl = document.createElement("label")
        topLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        topLbl.append(document.createTextNode("Top N:"), topInput)
        wrap.append(topLbl)

        const acLbl = document.createElement("span")
        acLbl.style.color = "#9ca3af"
        const acName = this.selectedSpec
            ? (this.selectedSpec.typeName || this.selectedSpec.name || "?")
            : ((this.settings && this.settings.aircraft
                    && this.settings.aircraft.mode === "fleet"
                    && this.fleetSpecs && this.fleetSpecs.length)
                ? this._fleetSummaryLabel()
                : "(none)")
        acLbl.innerHTML = "Aircraft: <strong style='color:#cbd5e1;'>" + escapeHtml(acName) + "</strong>"
        wrap.append(acLbl)

        const rerunBtn = document.createElement("button")
        rerunBtn.textContent = "⟳ Re-run"
        rerunBtn.title = "Re-build the Gantt against the current scored rows"
        Object.assign(rerunBtn.style, smallBtnStyle())
        rerunBtn.style.background = "#1e40af"
        rerunBtn.addEventListener("click", () => {
            this._waveBuild = null
            this._renderRows()
        })
        wrap.append(rerunBtn)

        // F slice 2 — Sub-mode toggle. "plan" shows Gantt + diagnostics
        // card (default); "routes" adds a per-route fit-against-the-plan
        // workspace below where the user can promote / demote / pin
        // routes against the active wave plan without leaving Wave View.
        if (typeof RouteAssistantWaveRouteFitter !== "undefined") {
            const subMode = (this.settings && this.settings.waveOverlay
                && this.settings.waveOverlay.subMode) || "plan"
            const subBtn = document.createElement("button")
            subBtn.type = "button"
            subBtn.textContent = subMode === "routes" ? "📋 Routes" : "📊 Plan"
            subBtn.title = subMode === "routes"
                ? "Showing the route-fit workspace below the Gantt. Click to switch back to plan diagnostics."
                : "Switch to the route-fit workspace — every scored route ranked by fit against this plan, with promote / demote actions."
            Object.assign(subBtn.style, smallBtnStyle())
            subBtn.style.background  = subMode === "routes" ? "#4c1d95" : "#1f2937"
            subBtn.style.borderColor = subMode === "routes" ? "#4c1d95" : "#475569"
            subBtn.style.color       = subMode === "routes" ? "#ddd6fe" : "#cbd5e1"
            subBtn.addEventListener("click", async () => {
                const next = subMode === "routes" ? "plan" : "routes"
                this.settings.waveOverlay = Object.assign({}, this.settings.waveOverlay || {},
                    {subMode: next})
                try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
                catch (e) { /* non-fatal */ }
                this._renderRows()
            })
            wrap.append(subBtn)
        }

        // Slice 2 — Connections SVG toggle. Legend renders regardless so
        // the user knows the feature exists; this just gates the curves.
        const wo = (this.settings && this.settings.waveOverlay) || {}
        const connOn = wo.showConnections !== false
        const connBtn = document.createElement("button")
        connBtn.textContent = connOn ? "🔗 Connections" : "🔗 Connections (off)"
        connBtn.title = "Toggle the SVG connection-graph overlay on the Gantt"
        Object.assign(connBtn.style, smallBtnStyle())
        connBtn.style.background = connOn ? "#0f3a5c" : "#1f2937"
        connBtn.style.opacity     = connOn ? "1" : "0.7"
        connBtn.addEventListener("click", async () => {
            const next = !connOn
            this.settings.waveOverlay = Object.assign({}, this.settings.waveOverlay || {},
                {showConnections: next})
            try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
            catch (e) { /* non-fatal */ }
            this._renderRows()
        })
        wrap.append(connBtn)

        // H slice 3 + F slice 3 — Assignment-mode picker. Replaces the
        // earlier two-state Optimise toggle with three modes:
        //   greedy:     bucket-greedy fill (default; matches pre-F3)
        //   connection: hill-climb maximising the connection-graph count
        //   profit:     per-slot greedy-best-marginal scored by
        //               RouteAssistantWaveSlotScorer
        // Legacy `wo.optimize: true` reads as "connection" so users on
        // older settings keep their previous behaviour.
        const currentMode = wo.optimizeMode
            || (wo.optimize ? "connection" : "greedy")
        const modeLabel = (m) => m === "profit"     ? "💰 Per-slot profit"
            : m === "connection" ? "🎯 Connection graph"
            : "▦ Bucket greedy"
        const modeBg = (m) => m === "profit" ? "#065f46"
            : m === "connection" ? "#7c2d12"
            : "#1f2937"
        const modeFg = (m) => m === "profit" ? "#a7f3d0"
            : m === "connection" ? "#fed7aa"
            : "#cbd5e1"
        const modeBtn = document.createElement("button")
        modeBtn.type = "button"
        const profitAvailable = typeof RouteAssistantWaveSlotScorer !== "undefined"
        modeBtn.textContent = modeLabel(currentMode)
        modeBtn.title = "Assignment mode — click to cycle.\n"
            + "  ▦ Bucket greedy: fill each wave's S/M/L composition by distance.\n"
            + "  🎯 Connection graph: hill-climb to maximise inbound→outbound pairs.\n"
            + (profitAvailable
                ? "  💰 Per-slot profit: rank (route × wave) by profit + range + demand + connections + aircraft fit, then greedy-best-marginal.\n"
                : "  💰 Per-slot profit: (module not loaded — skipping)\n")
            + "Composition counts are CAPS in connection / profit modes — waves may land below their wanted count."
        Object.assign(modeBtn.style, smallBtnStyle())
        modeBtn.style.background  = modeBg(currentMode)
        modeBtn.style.borderColor = modeBg(currentMode)
        modeBtn.style.color       = modeFg(currentMode)
        modeBtn.addEventListener("click", async () => {
            const cycle = profitAvailable
                ? ["greedy", "connection", "profit"]
                : ["greedy", "connection"]
            const idx = cycle.indexOf(currentMode)
            const next = cycle[(idx + 1) % cycle.length] || "greedy"
            this.settings.waveOverlay = Object.assign({}, this.settings.waveOverlay || {},
                {optimizeMode: next, optimize: next === "connection"})
            try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
            catch (e) { /* non-fatal */ }
            this._waveBuild = null
            this._renderRows()
        })
        wrap.append(modeBtn)

        // F slice 4 — Draft toggle. Forks the active preset into a
        // sandboxed copy so the user can iterate without polluting the
        // live preset. While drafting, the header turns amber and a
        // banner with promote / discard / save-as-variant appears
        // beneath. Hidden when no preset is active (nothing to fork).
        if (preset && typeof RouteAssistantWaveDraftStore !== "undefined") {
            const draftBtn = document.createElement("button")
            draftBtn.type = "button"
            if (isDraft) {
                draftBtn.textContent = "🟧 Drafting"
                draftBtn.title = "Currently editing a draft fork of the live preset."
                    + " See banner below for promote / discard / save-as-variant."
                Object.assign(draftBtn.style, smallBtnStyle())
                draftBtn.style.background  = "#7c2d12"
                draftBtn.style.borderColor = "#7c2d12"
                draftBtn.style.color       = "#fed7aa"
                draftBtn.disabled = true
                draftBtn.style.cursor = "default"
                draftBtn.style.opacity = "0.85"
            } else {
                draftBtn.textContent = "🟧 Draft"
                draftBtn.title = "Fork the active preset into a sandboxed draft."
                    + " You can edit it freely; promote back to the live preset"
                    + " when satisfied, or save as a new variant."
                Object.assign(draftBtn.style, smallBtnStyle())
                draftBtn.style.background  = "#1f2937"
                draftBtn.style.borderColor = "#475569"
                draftBtn.style.color       = "#cbd5e1"
                draftBtn.addEventListener("click", () => this._draftStart(pickedHub, preset))
            }
            wrap.append(draftBtn)
        }

        // F slice 5 — Backtest button. Opens a modal that replays the
        // active plan against historical yield-history snapshots and
        // shows would-have-been profit per week. Hidden when no preset
        // is active (nothing to backtest).
        if (preset && typeof RouteAssistantWavePlanBacktest !== "undefined") {
            const backtestBtn = document.createElement("button")
            backtestBtn.type = "button"
            backtestBtn.textContent = "📈 Backtest"
            backtestBtn.title = "Replay this plan against historical yield-history"
                + " snapshots to see how its route selection would have performed."
                + " Needs at least 4 weeks of snapshots."
            Object.assign(backtestBtn.style, smallBtnStyle())
            backtestBtn.style.background  = "#1f2937"
            backtestBtn.style.borderColor = "#475569"
            backtestBtn.style.color       = "#cbd5e1"
            backtestBtn.addEventListener("click", () =>
                this._runWaveBacktest(pickedHub, preset))
            wrap.append(backtestBtn)
        }

        // Slice 2 — Save schedule CTA. Lifts the slice-1 read-only
        // invariant on the explicit-action path only: the click handler
        // is the SOLE write into ScheduleStore. The header is built
        // before the build runs on first render, so disabled-state
        // signaling here would be stale; instead, _saveWaveScheduleToStore
        // validates at click time and shows a non-blocking toast when the
        // build isn't ready.
        const saveBtn = document.createElement("button")
        saveBtn.type = "button"
        saveBtn.textContent = "💾 Save schedule"
        saveBtn.title = "Persist the current wave build to ScheduleStore — appears in the dashboard's Schedule Management history. Toast offers Undo for 6 seconds."
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.background = "#065f46"
        saveBtn.style.borderColor = "#065f46"
        saveBtn.style.color = "#ecfdf5"
        saveBtn.addEventListener("click", () => this._saveWaveScheduleToStore())
        wrap.append(saveBtn)

        // Slice D — in-panel preset CRUD strip. Replaces the read-only
        // "📅 Edit presets →" link that dumped the user onto the dashboard.
        // New / Duplicate / Rename / Delete all act on the active preset
        // and write straight to SchedulePresets — no context switch.
        if (typeof RouteAssistantWaveEditor !== "undefined") {
            const crudWrap = document.createElement("span")
            crudWrap.style.cssText = "display:flex;gap:4px;align-items:center;margin-left:auto;"
            crudWrap.append(RouteAssistantWaveEditor.renderPresetActions(preset, presets, {
                hubIata: pickedHub,
                onPickPreset: async (id) => {
                    this.settings.waveOverlay = Object.assign({},
                        this.settings.waveOverlay || {}, {lastPresetId: id})
                    try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
                    catch (e) { /* non-fatal */ }
                    await this._afterWavePresetEdit()
                },
                onAfterCreate: async (created) => {
                    this.settings.waveOverlay = Object.assign({},
                        this.settings.waveOverlay || {}, {lastPresetId: created.id})
                    try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
                    catch (e) { /* non-fatal */ }
                    await this._afterWavePresetEdit()
                },
                onAfterDuplicate: async (dup) => {
                    this.settings.waveOverlay = Object.assign({},
                        this.settings.waveOverlay || {}, {lastPresetId: dup.id})
                    try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
                    catch (e) { /* non-fatal */ }
                    await this._afterWavePresetEdit()
                },
                onAfterRename: async () => { await this._afterWavePresetEdit() },
                onAfterDelete: async () => {
                    // Picker memory now points at a deleted id — clear it
                    // so the next render falls back to the first preset
                    // (or the empty-state CTA if none remain).
                    this.settings.waveOverlay = Object.assign({},
                        this.settings.waveOverlay || {}, {lastPresetId: null})
                    try { await RouteAssistantSettings.save({waveOverlay: this.settings.waveOverlay}) }
                    catch (e) { /* non-fatal */ }
                    await this._afterWavePresetEdit()
                }
            }))
            wrap.append(crudWrap)
        }

        return wrap
    }

    /** F slice 4 — Compact Δ strip rendered inside the draft banner. */
    window.RouteAssistantPanel.prototype._renderDraftDeltaStrip = function(baseDiag, draftDiag) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;gap:10px;align-items:center;"
            + "padding:0 6px;border-left:1px solid rgba(251,146,60,0.50);"
            + "border-right:1px solid rgba(251,146,60,0.50);"
        const fmtMoney = (v) => {
            if (!isFinite(v) || v === 0) return "$0"
            const abs = Math.abs(v), sign = v < 0 ? "−" : "+"
            if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M"
            if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(0) + "k"
            return sign + "$" + abs.toFixed(0)
        }
        const fmtPp = (v) => (v >= 0 ? "+" : "") + Math.round(v) + "pp"
        const fmtN  = (v) => (v >= 0 ? "+" : "") + v
        const colorFor = (v) => v > 0 ? "#86efac" : v < 0 ? "#fca5a5" : "#cbd5e1"

        const dProfit = (draftDiag.profitPerWeek || 0) - (baseDiag.profitPerWeek || 0)
        const dUtil   = (draftDiag.componentScores.utilization || 0)
                      - (baseDiag.componentScores.utilization || 0)
        const dUnpl   = (draftDiag.unplaceable.count || 0) - (baseDiag.unplaceable.count || 0)
        const dConn   = (draftDiag.connectionCount || 0) - (baseDiag.connectionCount || 0)
        const dScore  = (draftDiag.planScore || 0) - (baseDiag.planScore || 0)

        const mkChip = (lbl, txt, color) => {
            const span = document.createElement("span")
            span.style.cssText = "color:" + color + ";font-size:10px;"
                + "font-family:var(--aes-font-mono,monospace);"
            span.innerHTML = "<span style='color:#9ca3af;'>" + lbl + "</span> " + txt
            return span
        }
        wrap.append(mkChip("Δ score",   fmtN(dScore),     colorFor(dScore)))
        wrap.append(mkChip("Δ profit",  fmtMoney(dProfit), colorFor(dProfit)))
        wrap.append(mkChip("Δ util",    fmtPp(dUtil),     colorFor(dUtil)))
        wrap.append(mkChip("Δ conn",    fmtN(dConn),      colorFor(dConn)))
        // Unplaced is "lower-is-better" → invert color sign.
        wrap.append(mkChip("Δ unplaced", fmtN(dUnpl),     colorFor(-dUnpl)))
        return wrap
    }

    /** F slice 5 — Render the weekly profit sparkline as inline SVG. */
    window.RouteAssistantPanel.prototype._renderBacktestSparkline = function(result) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:10px;background:#0a1120;border:1px solid #1f2937;"
            + "border-radius:4px;"
        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;"
            + "font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;"
        head.innerHTML = "<strong style='color:#cbd5e1;'>Weekly profit</strong>"
            + "<span style='color:#60a5fa;'>● Plan</span>"
            + "<span style='color:#9ca3af;'>● Actual</span>"
        wrap.append(head)

        const W = 700, H = 160, M = 24
        const SVGNS = "http://www.w3.org/2000/svg"
        const svg = document.createElementNS(SVGNS, "svg")
        svg.setAttribute("viewBox", "0 0 " + W + " " + H)
        svg.setAttribute("width", "100%")
        svg.setAttribute("height", "160")
        svg.style.cssText = "display:block;"

        const weeks = result.weeks || []
        if (!weeks.length) { wrap.append(svg); return wrap }
        let maxV = 0
        for (const w of weeks) {
            if (Math.abs(w.planProfit)   > maxV) maxV = Math.abs(w.planProfit)
            if (Math.abs(w.actualProfit) > maxV) maxV = Math.abs(w.actualProfit)
        }
        if (maxV === 0) maxV = 1
        const xStep = (W - M * 2) / Math.max(1, weeks.length - 1)
        const yMid  = H / 2
        const yScale = (H / 2 - M) / maxV
        const ptFor = (i, v) => [M + i * xStep, yMid - v * yScale]
        const mkPath = (key, color, dash) => {
            let d = ""
            for (let i = 0; i < weeks.length; i++) {
                const [x, y] = ptFor(i, weeks[i][key])
                d += (i === 0 ? "M " : " L ") + x.toFixed(1) + " " + y.toFixed(1)
            }
            const path = document.createElementNS(SVGNS, "path")
            path.setAttribute("d", d)
            path.setAttribute("fill", "none")
            path.setAttribute("stroke", color)
            path.setAttribute("stroke-width", "1.6")
            if (dash) path.setAttribute("stroke-dasharray", dash)
            return path
        }
        const zero = document.createElementNS(SVGNS, "line")
        zero.setAttribute("x1", M); zero.setAttribute("x2", W - M)
        zero.setAttribute("y1", yMid); zero.setAttribute("y2", yMid)
        zero.setAttribute("stroke", "#1f2937")
        zero.setAttribute("stroke-dasharray", "3 3")
        svg.append(zero)

        svg.append(mkPath("actualProfit", "#9ca3af", "3 2"))
        svg.append(mkPath("planProfit",   "#60a5fa", null))

        const ticks = [0, Math.floor(weeks.length / 2), weeks.length - 1]
        for (const i of ticks) {
            const lbl = document.createElementNS(SVGNS, "text")
            lbl.setAttribute("x", M + i * xStep)
            lbl.setAttribute("y", H - 4)
            lbl.setAttribute("fill", "#6b7280")
            lbl.setAttribute("font-size", "9")
            lbl.setAttribute("text-anchor", "middle")
            lbl.textContent = weeks[i].weekIso
            svg.append(lbl)
        }
        wrap.append(svg)
        return wrap
    }

    /** F slice 5 — Top-winners / top-losers list block. */
    window.RouteAssistantPanel.prototype._renderBacktestRouteList = function(title, subtitle, accent, entries, fmtMoneyAbs) {
        const block = document.createElement("div")
        block.style.cssText = "padding:8px;background:#0a1120;"
            + "border:1px solid #1f2937;border-radius:4px;"
        const head = document.createElement("div")
        head.style.cssText = "color:" + accent + ";font-size:11px;"
            + "font-weight:600;margin-bottom:2px;"
        head.textContent = title
        const sub = document.createElement("div")
        sub.style.cssText = "color:#6b7280;font-size:9px;font-style:italic;margin-bottom:6px;"
        sub.textContent = subtitle
        block.append(head, sub)
        if (!entries || !entries.length) {
            const empty = document.createElement("div")
            empty.textContent = "(no data)"
            empty.style.cssText = "color:#6b7280;font-size:10px;font-style:italic;"
            block.append(empty)
            return block
        }
        for (const e of entries) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0;"
                + "font-size:11px;"
            const code = document.createElement("strong")
            code.textContent = e.destIata
            code.style.cssText = "font-family:var(--aes-font-mono,monospace);"
                + "color:#cbd5e1;width:42px;"
            const val = document.createElement("span")
            const sign = e.totalDelta >= 0 ? "+" : "−"
            val.textContent = sign + fmtMoneyAbs(e.totalDelta)
            val.style.cssText = "color:" + (e.totalDelta >= 0 ? "#86efac" : "#fca5a5") + ";"
                + "font-family:var(--aes-font-mono,monospace);font-size:10px;flex:1;"
            const wks = document.createElement("span")
            wks.textContent = e.weeks + "w"
            wks.style.cssText = "color:#6b7280;font-size:9px;"
            row.append(code, val, wks)
            block.append(row)
        }
        return block
    }

}
