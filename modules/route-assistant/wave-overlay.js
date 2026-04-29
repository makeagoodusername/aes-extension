/**
 * Wave overlay (Roadmap H slice 1) — bridges Route Assistant scored rows
 * into the existing schedule-management ScheduleBuilder and renders a
 * Gantt-style wave timeline as a panel mode.
 *
 * Pure functions only. No chrome.storage reads, no DOM listeners that
 * capture external state. The panel calls these helpers and wires the
 * click handler via opts.onFlightClick.
 *
 * Data flow:
 *   panel.js: this.scoredRows
 *     → buildRoutesFromScoredRows(scoredRows, opts)
 *     → ScheduleBuilder(preset, ctx).assignRoutes(routes)
 *     → ScheduleBuilder(preset, ctx).evaluateFlights(placements)
 *     → renderGantt(host, build, opts)
 *
 * The overlay itself stays read-only against ScheduleStore — buildSchedule
 * runs in-memory and never writes. Slice 2 lifted persistence into the
 * panel via an explicit "💾 Save schedule" CTA in the header strip
 * (`RouteAssistantPanel._saveWaveScheduleToStore`); that click handler is
 * the SOLE write path. Don't add a save call inside this module — the
 * panel's invariant ledger names that boundary explicitly.
 */
class RouteAssistantWaveOverlay {

    /**
     * Map RA scored rows → routes shape that ScheduleBuilder accepts.
     * Skips rows missing distance, OOR rows, and (if `requireFit`) rows
     * the picked aircraft can't fly. Returns the trimmed list plus the
     * exclusion log so the caller can surface "skipped" feedback.
     *
     * @param {Array} scoredRows - this.scoredRows from the panel
     * @param {object} opts
     *   - topN: number, default 20
     *   - selectedSpec: optional aircraft spec (provides aircraftType + range)
     *   - hubIata: hub IATA for context-only logging
     *   - turnaroundMinutes: optional default per route
     * @returns {object} {routes, skipped: [{destIata, reason}]}
     */
    static buildRoutesFromScoredRows(scoredRows, opts) {
        const o = opts || {}
        const topN = Math.max(1, Math.min(100, Number(o.topN) || 20))
        const spec = o.selectedSpec || null
        const aircraftType    = spec && (spec.typeName || spec.name) || null
        const aircraftRangeNm = spec && spec.range
            ? ScheduleFactors.kmToNm(Number(spec.range))
            : null

        const routes = []
        const skipped = []
        for (const r of scoredRows || []) {
            if (routes.length >= topN) {
                skipped.push({destIata: r.destIata, reason: "beyond top-N"})
                continue
            }
            if (!r || !r.destIata) {
                skipped.push({destIata: "?", reason: "missing destination"})
                continue
            }
            if (typeof r.distanceKm !== "number" || !isFinite(r.distanceKm) || r.distanceKm <= 0) {
                skipped.push({destIata: r.destIata, reason: "no distance"})
                continue
            }
            // OOR rows are dropped here (they'd just produce range warnings).
            // No-aircraft mode keeps OOR-unknown rows since fit can't be evaluated.
            if (r.aircraftFit === "oor") {
                skipped.push({destIata: r.destIata, reason: "out-of-range for picked aircraft"})
                continue
            }
            const distanceNm = ScheduleFactors.kmToNm(r.distanceKm)
            routes.push({
                destination:        String(r.destIata).toUpperCase(),
                distanceNm:         distanceNm,
                aircraftType:       aircraftType,
                aircraftRangeNm:    aircraftRangeNm,
                turnaroundMinutes:  Number(o.turnaroundMinutes) || undefined,
                _scoredRow:         r        // back-reference for tooltip enrichment
            })
        }
        return {routes, skipped}
    }

    /**
     * Run the build. Returns flights + warnings + placements + unplaced
     * + shortfall + skipped + validation + connections in a single rich
     * object so the renderer can show the full picture without re-running
     * phases.
     *
     * @param {object} preset - SchedulePresets record
     * @param {Array} scoredRows
     * @param {object} ctx - {server, airlineCode, hubIata, selectedSpec, topN,
     *                        carrierClassifier?, overrides?, optimize?}
     * @returns {object} {validation, routes, flights, warnings, placements,
     *   unplaced, shortfall, skipped, connections, preset, optimised,
     *   optimiseIters, optimiseScore}
     */
    static buildSchedule(preset, scoredRows, ctx) {
        const c = ctx || {}
        const out = {
            validation: [], routes: [], flights: [], warnings: [],
            placements: [], unplaced: [], shortfall: {}, skipped: [],
            connections: [],
            forcedDests: [],
            preset: preset || null
        }
        if (!preset) {
            out.validation.push("no preset selected")
            return out
        }

        const builder = new ScheduleBuilder(preset, {
            server:      c.server || "",
            airlineCode: c.airlineCode || ""
        })
        out.validation = builder.validatePreset()

        const {routes, skipped} = RouteAssistantWaveOverlay.buildRoutesFromScoredRows(
            scoredRows, {
                topN:         c.topN,
                selectedSpec: c.selectedSpec,
                hubIata:      c.hubIata
            }
        )
        out.routes = routes
        out.skipped = skipped

        if (out.validation.length) return out
        if (!routes.length) return out

        // Slice E — pass user overrides into the assignment so dragged
        // routes land on their picked wave even if it's bucket-saturated.
        // H slice 3 — `c.optimize` flips placement onto the
        // connection-graph-maximising hill-climb (still respects
        // overrides; forced routes stay pinned).
        // F slice 3 — `c.mode === "profit"` flips placement onto the
        // per-slot profit greedy-best-marginal in
        // `ScheduleBuilder._assignRoutesProfit`. Older callers pass no
        // mode and keep the bucket-greedy / connection-hill-climb path.
        const assignment = builder.assignRoutes(routes, {
            overrides:    c.overrides,
            optimize:     !!c.optimize,
            mode:         c.mode || null,
            selectedSpec: c.selectedSpec,
            fleetSpecs:   c.fleetSpecs,
            demandHourMap: c.demandHourMap
        })
        out.placements   = assignment.placements
        out.unplaced     = assignment.unplaced
        out.shortfall    = assignment.shortfall
        out.forcedDests  = assignment.forcedDests || []
        out.optimised    = !!assignment.optimised
        out.optimiseIters = assignment.optimiseIters || 0
        out.optimiseScore = assignment.optimiseScore || 0

        const evaluation = builder.evaluateFlights(assignment.placements)
        out.flights  = evaluation.flights
        out.warnings = evaluation.warnings

        // Slice 2 — connection-graph: derive valid inbound→outbound pairs.
        // The classifier callback (panel-supplied) sorts pairs into own /
        // interline / alliance buckets using the F slice 3 partner cache.
        out.connections = builder.computeConnections(out.flights, {
            carrierClassifier: c.carrierClassifier
        })

        // H slice 3b.2 — annotate each interline-classified connection
        // with the recorded per-route partner share so the renderer can
        // surface a "Y 30%" pill on the curve. Panel passes the lookup
        // callback; missing records leave `interlineShare` undefined and
        // the renderer skips the pill.
        const interlineShareLookup = typeof c.interlineShareLookup === "function"
            ? c.interlineShareLookup
            : null
        if (interlineShareLookup) {
            for (const conn of out.connections) {
                if (!conn || conn.classification !== "interline") continue
                if (!conn.outboundDest) continue
                try {
                    const share = interlineShareLookup(conn.outboundDest)
                    if (share && (share.paxPercent > 0 || share.cargoPercent > 0)) {
                        conn.interlineShare = share
                    }
                } catch (_) { /* lookup outage — skip silently */ }
            }
        }
        return out
    }

    /**
     * Render the Gantt into a host element. Pure DOM build. Caller wires
     * click handlers via opts.onFlightClick(flight, route).
     *
     * Layout: one swim-lane per wave. Time axis = 0..24h cropped to the
     * preset's slot window when configured. Each flight is an
     * absolutely-positioned div whose left/width are percentages of the
     * lane width.
     *
     * @param {HTMLElement} host
     * @param {object} build - output of buildSchedule()
     * @param {object} opts
     *   - hubIata: string
     *   - onFlightClick: (flight, route) => void
     *   - hourMin / hourMax: optional crop override (0..24)
     */
    static renderGantt(host, build, opts) {
        if (!host) return
        host.innerHTML = ""

        const o = opts || {}
        const preset = build.preset
        const slot = (preset && preset.factors && preset.factors.slotWindow) || null
        const cropMin = (typeof o.hourMin === "number") ? o.hourMin
            : slot ? Math.floor(ScheduleFactors.parseHHMM(slot.start) / 60) : 0
        const cropMax = (typeof o.hourMax === "number") ? o.hourMax
            : slot ? Math.ceil(ScheduleFactors.parseHHMM(slot.end) / 60) : 24
        const totalMin = Math.max(60, (cropMax - cropMin) * 60)
        const startMin = cropMin * 60

        // ----- Hour ruler header -----
        const ruler = document.createElement("div")
        ruler.style.cssText = "position:relative;display:flex;align-items:flex-end;"
            + "height:18px;border-bottom:1px solid #374151;margin:6px 0 4px 140px;"
            + "color:#6b7280;font-size:9px;font-family:monospace;"
        for (let h = cropMin; h <= cropMax; h++) {
            const tick = document.createElement("div")
            const left = ((h - cropMin) * 60 / totalMin) * 100
            Object.assign(tick.style, {
                position:    "absolute",
                left:        left + "%",
                bottom:      "0",
                width:       "1px",
                height:      "6px",
                background:  "#374151"
            })
            ruler.append(tick)
            if (h % 2 === 0 || (cropMax - cropMin) <= 12) {
                const label = document.createElement("div")
                Object.assign(label.style, {
                    position:    "absolute",
                    left:        left + "%",
                    bottom:      "8px",
                    transform:   "translateX(-50%)",
                    whiteSpace:  "nowrap"
                })
                label.textContent = String(h).padStart(2, "0") + ":00"
                ruler.append(label)
            }
        }
        host.append(ruler)

        // ----- Per-wave swim lanes -----
        const flightsByWave = new Map()
        for (const f of build.flights) {
            const arr = flightsByWave.get(f.waveId) || []
            arr.push(f)
            flightsByWave.set(f.waveId, arr)
        }

        for (const wave of (preset.waves || [])) {
            const lane = RouteAssistantWaveOverlay._renderLane(
                wave, flightsByWave.get(wave.id) || [], build, {
                    cropMin, cropMax, startMin, totalMin,
                    onFlightClick:   o.onFlightClick,
                    hubIata:         o.hubIata,
                    // Slice D — editor mode. When `onEnhanceLabel` is
                    // supplied, the lane's label column is handed to the
                    // wave-editor for spinner / time-input / delete UI.
                    // Read-only callers (other panel modes, eventual
                    // dashboard preview) pass nothing → static label.
                    onEnhanceLabel:  o.onEnhanceLabel,
                    preset:          preset,
                    // Slice E — drop target + forced-bar release wiring
                    // travel down to the lane through ctx.
                    onPlace:         o.onPlace,
                    onReleaseForced: o.onReleaseForced
                }
            )
            host.append(lane)
        }

        // Slice D — "+ Add wave" footer. Visible only in editor mode
        // (i.e. when the panel passed an `onAddWave` callback). Sits
        // below the swim lanes; clicking it appends a wave to the
        // active preset and re-renders.
        if (typeof o.onAddWave === "function") {
            const addRow = document.createElement("div")
            addRow.style.cssText = "margin-top:4px;display:flex;justify-content:flex-start;"
            const addBtn = document.createElement("button")
            addBtn.type = "button"
            addBtn.textContent = "+ Add wave"
            addBtn.title = "Append a new wave to this preset (staggered ~4h after the last)."
            addBtn.style.cssText = "background:#1f2937;color:#cbd5e1;"
                + "border:1px dashed #475569;border-radius:3px;padding:4px 12px;"
                + "font-size:11px;cursor:pointer;"
            addBtn.addEventListener("click", (e) => {
                e.preventDefault()
                o.onAddWave()
            })
            addRow.append(addBtn)
            host.append(addRow)
        }

        // ----- Slice 2 connection-graph SVG overlay -----
        // Lanes are now in the live DOM, so getBoundingClientRect() returns
        // valid coords. The overlay's <svg> sits above the lanes with
        // pointer-events:none so flight-bar tooltips/clicks still work.
        if (o.showConnections !== false
            && build.connections && build.connections.length) {
            RouteAssistantWaveOverlay._renderConnectionsOverlay(host, build.connections, {
                onInterlinePillClick: typeof o.onInterlinePillClick === "function"
                    ? o.onInterlinePillClick : null
            })
        }

        // ----- Warnings panel -----
        if (build.warnings && build.warnings.length) {
            const wbox = document.createElement("div")
            wbox.style.cssText = "margin-top:10px;padding:6px 8px;"
                + "background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.30);"
                + "border-radius:4px;font-size:11px;color:#fca5a5;"
            const h = document.createElement("strong")
            h.textContent = "Warnings (" + build.warnings.length + ")"
            h.style.cssText = "color:#fca5a5;display:block;margin-bottom:4px;"
            wbox.append(h)
            for (const w of build.warnings.slice(0, 50)) {
                const line = document.createElement("div")
                line.style.cssText = "margin:2px 0;color:#fda4af;"
                line.textContent = "• " + w.message
                wbox.append(line)
            }
            if (build.warnings.length > 50) {
                const more = document.createElement("div")
                more.style.cssText = "margin-top:4px;color:#9ca3af;font-style:italic;"
                more.textContent = "… " + (build.warnings.length - 50) + " more (truncated)"
                wbox.append(more)
            }
            host.append(wbox)
        }

        // ----- Unplaced strip -----
        // Slice E — chips are now draggable. Drop on any wave lane to
        // force-place a route there (override stored per (hub, preset)).
        // The "Auto-fill" button bumps the haul-bucket on the first wave
        // with capacity headroom for every unplaced route in one click.
        if (build.unplaced && build.unplaced.length) {
            const ubox = document.createElement("div")
            ubox.style.cssText = "margin-top:8px;padding:6px 8px;"
                + "background:rgba(107,114,128,0.10);border:1px solid #374151;"
                + "border-radius:4px;font-size:11px;color:#cbd5e1;"
            const headRow = document.createElement("div")
            headRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px;"
            const h = document.createElement("strong")
            h.textContent = "Unplaced (" + build.unplaced.length + ")"
            h.style.cssText = "color:#cbd5e1;flex:1;"
            headRow.append(h)
            const draggable = typeof o.onPlace === "function"
            if (draggable) {
                const hint = document.createElement("span")
                hint.textContent = "drag onto a wave →"
                hint.style.cssText = "color:#6b7280;font-size:10px;font-style:italic;"
                headRow.append(hint)
                if (typeof o.onAutoFill === "function") {
                    const auto = document.createElement("button")
                    auto.type = "button"
                    auto.textContent = "Auto-fill"
                    auto.title = "Bump each wave's S/M/L capacity until every unplaced route fits."
                    auto.style.cssText = "background:#1e40af;color:#dbeafe;"
                        + "border:1px solid #3b82f6;border-radius:3px;"
                        + "padding:2px 8px;font-size:10px;cursor:pointer;"
                    auto.addEventListener("click", (e) => { e.preventDefault(); o.onAutoFill() })
                    headRow.append(auto)
                }
            }
            ubox.append(headRow)
            const chips = document.createElement("div")
            chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
            for (const r of build.unplaced) {
                const chip = document.createElement("span")
                chip.style.cssText = "padding:2px 6px;background:#374151;border-radius:3px;"
                    + "font-family:monospace;font-size:10px;color:#cbd5e1;"
                    + (draggable ? "cursor:grab;" : "")
                chip.textContent = r.destination + " " + r.distanceNm + "nm"
                chip.title = draggable
                    ? "Drag onto a wave to place. (No "
                        + (ScheduleFactors.bucketize(r.distanceNm,
                            preset.factors && preset.factors.rangeBuckets) || "?")
                        + " capacity in any wave currently.)"
                    : "No wave with matching "
                        + (ScheduleFactors.bucketize(r.distanceNm,
                            preset.factors && preset.factors.rangeBuckets) || "?")
                        + " capacity"
                if (draggable) {
                    chip.draggable = true
                    chip.dataset.dest = r.destination
                    chip.addEventListener("dragstart", (e) => {
                        chip.style.cursor = "grabbing"
                        chip.style.opacity = "0.5"
                        e.dataTransfer.effectAllowed = "move"
                        e.dataTransfer.setData("text/plain",
                            "aes-wave-route:" + r.destination)
                        RouteAssistantWaveOverlay._emitGestureBus("dragschedule:gesture-start", {
                            gestureId: "ra.unplaced.toLane", surface: "ra",
                            kind: "native", destination: r.destination, presetId: preset.id
                        })
                    })
                    chip.addEventListener("dragend", (e) => {
                        chip.style.cursor = "grab"
                        chip.style.opacity = "1"
                        // dropEffect "none" on dragend → drop was cancelled (ESC,
                        // dragged outside any drop target, etc). Browser-native
                        // ESC works on HTML5 drag — emit cancelled outcome.
                        const cancelled = !e.dataTransfer || e.dataTransfer.dropEffect === "none"
                        RouteAssistantWaveOverlay._emitGestureBus("dragschedule:gesture-end", {
                            gestureId: "ra.unplaced.toLane", surface: "ra",
                            outcome:   cancelled ? "cancelled" : "applied",
                            destination: r.destination, presetId: preset.id
                        })
                    })
                }
                chips.append(chip)
            }
            ubox.append(chips)
            host.append(ubox)
        }

        // ----- Skipped strip (rows the panel had but wave-overlay dropped) -----
        if (build.skipped && build.skipped.length) {
            const sbox = document.createElement("div")
            sbox.style.cssText = "margin-top:6px;font-size:10px;color:#6b7280;"
            sbox.textContent = "Skipped " + build.skipped.length + " row(s): "
                + build.skipped.slice(0, 10).map(s => s.destIata + " (" + s.reason + ")").join(", ")
                + (build.skipped.length > 10 ? "…" : "")
            host.append(sbox)
        }

        // ----- Slice 2 connection-graph legend -----
        // Always renders so the user knows the feature exists, even when the
        // SVG overlay is toggled off via showConnections.
        RouteAssistantWaveOverlay._renderConnectionLegend(
            host, build.connections || [], (preset && preset.factors) || {}
        )
    }

    /**
     * Render one wave swim-lane. Internal helper — caller is renderGantt.
     */
    static _renderLane(wave, flights, build, ctx) {
        const lane = document.createElement("div")
        lane.style.cssText = "display:flex;align-items:stretch;margin-bottom:3px;"
            + "border:1px solid #2a3444;border-radius:3px;background:#0f1623;"

        // Wave label (fixed-width left column). Slice D: when
        // `ctx.onEnhanceLabel` is supplied, hand the label element to the
        // editor so spinners / time inputs replace the static text.
        // Read-only callers fall through to the original markup.
        const label = document.createElement("div")
        label.style.cssText = "width:160px;flex-shrink:0;padding:6px 8px;"
            + "border-right:1px solid #2a3444;background:#111827;color:#cbd5e1;font-size:11px;"
        const comp = wave.composition || {}
        const compStr = [comp.shortHaul || 0, comp.mediumHaul || 0, comp.longHaul || 0].join("/")
        if (typeof ctx.onEnhanceLabel === "function") {
            ctx.onEnhanceLabel(label, wave, ctx.preset)
        } else {
            label.innerHTML = "<strong>" + escapeHtml(wave.label || "Wave") + "</strong>"
                + "<br><span style='color:#6b7280;font-size:9px;font-family:monospace;'>"
                + compStr + " S/M/L</span>"
                + "<br><span style='color:#6b7280;font-size:9px;'>"
                + "arr " + escapeHtml(wave.arrivalWindow.start) + "–" + escapeHtml(wave.arrivalWindow.end)
                + "<br>dep " + escapeHtml(wave.departureWindow.start) + "–" + escapeHtml(wave.departureWindow.end)
                + "</span>"
        }

        // Flight strip (relative-positioned canvas for absolute children)
        const strip = document.createElement("div")
        strip.style.cssText = "position:relative;flex:1;height:48px;"
            + "background-image:linear-gradient(to right, #1a2233 1px, transparent 1px);"
            + "background-size:" + (100 / Math.max(1, ctx.cropMax - ctx.cropMin)) + "% 100%;"

        // Slice E — drop target for dragged Unplaced chips. The
        // wave-overlay's caller wires `onPlace(destIata, waveId)` to
        // persist the override + re-render.
        if (typeof ctx.onPlace === "function") {
            strip.addEventListener("dragover", (e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = "move"
                strip.style.outline = "2px dashed #60a5fa"
                strip.style.outlineOffset = "-2px"
            })
            strip.addEventListener("dragleave", () => {
                strip.style.outline = ""
                strip.style.outlineOffset = ""
            })
            strip.addEventListener("drop", (e) => {
                e.preventDefault()
                strip.style.outline = ""
                strip.style.outlineOffset = ""
                const data = e.dataTransfer.getData("text/plain") || ""
                const m = data.match(/^aes-wave-route:(.+)$/)
                if (!m) return
                ctx.onPlace(m[1], wave.id)
                RouteAssistantWaveOverlay._emitGestureBus("dragschedule:applied", {
                    gestureId: "ra.unplaced.toLane",
                    effect: {kind: "ra-unplaced-place", destination: m[1], waveId: wave.id}
                })
            })
        }

        // Wave window bands (subtle shaded backgrounds for arr+dep windows)
        const arrStart = ScheduleFactors.parseHHMM(wave.arrivalWindow.start)
        const arrEnd   = ScheduleFactors.parseHHMM(wave.arrivalWindow.end)
        const depStart = ScheduleFactors.parseHHMM(wave.departureWindow.start)
        const depEnd   = ScheduleFactors.parseHHMM(wave.departureWindow.end)
        strip.append(RouteAssistantWaveOverlay._mkBand(arrStart, arrEnd, ctx,
            "rgba(16,185,129,0.10)", "arrival"))
        strip.append(RouteAssistantWaveOverlay._mkBand(depStart, depEnd, ctx,
            "rgba(59,130,246,0.10)", "departure"))

        // Flight bars
        const FLIGHT_DURATION_MIN = 22  // visual duration; tooltip carries the real time
        for (const f of flights) {
            const tMin = ScheduleFactors.parseHHMM(f.depTimeLocal)
            if (!isFinite(tMin)) continue
            const left  = ((tMin - ctx.startMin) / ctx.totalMin) * 100
            const width = (FLIGHT_DURATION_MIN / ctx.totalMin) * 100
            const isOut = f.direction === "outbound"
            const top   = isOut ? "2px" : "26px"

            const bar = document.createElement("div")
            // Slice 2 — connection-graph hover keys off these dataset attrs.
            // seq is unique per build; direction lets the SVG anchor logic
            // pick which edge of the bar to attach the curve to.
            bar.dataset.flightSeq = String(f.seq)
            bar.dataset.direction = f.direction
            Object.assign(bar.style, {
                position:    "absolute",
                top:         top,
                left:        Math.max(0, left) + "%",
                width:       Math.max(2, width) + "%",
                height:      "20px",
                background:  isOut ? "#3b82f6" : "#10b981",
                borderRadius: "2px",
                cursor:       "pointer",
                fontSize:     "9px",
                color:        "#0f172a",
                fontWeight:   "600",
                padding:      "1px 4px",
                whiteSpace:   "nowrap",
                overflow:     "hidden",
                textOverflow: "ellipsis",
                boxSizing:    "border-box",
                display:      "flex",
                alignItems:   "center"
            })
            const peer = isOut ? f.destination : f.origin
            // Slice E — surface forced placements with a 📌 prefix in
            // both the bar text and the tooltip so the user can spot
            // overridden routes at a glance and click → release.
            bar.textContent = (f.forced ? "📌" : "") + peer
            bar.title = (isOut ? "OUT " : "IN  ")
                + f.origin + "→" + f.destination
                + "  " + f.depTimeLocal
                + "  " + f.distanceNm + "nm"
                + (f.aircraftType ? "  " + f.aircraftType : "")
                + (f.rangeBucket ? "  [" + f.rangeBucket + "]" : "")
                + (f.forced ? "  · FORCED (manual placement). Click → release override."
                            : "")
            // Range bucket — colored left edge: short=lighter, long=darker
            if (f.rangeBucket === "longHaul")        bar.style.borderLeft = "3px solid #1e40af"
            else if (f.rangeBucket === "mediumHaul") bar.style.borderLeft = "3px solid #2563eb"
            else if (f.rangeBucket === "shortHaul")  bar.style.borderLeft = "3px solid #60a5fa"
            // Slice E — dashed outline marks forced placements.
            if (f.forced) {
                bar.style.border = "1.5px dashed #fbbf24"
                bar.style.background = isOut
                    ? "linear-gradient(45deg, #3b82f6 75%, #2563eb 75%)"
                    : "linear-gradient(45deg, #10b981 75%, #059669 75%)"
            }

            if (ctx.onFlightClick) {
                bar.addEventListener("click", (e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    // Slice E — click on a forced bar releases the
                    // override (returns the route to the bucket-driven
                    // assignment). Non-forced bars open the AS
                    // scheduling page as before.
                    if (f.forced && typeof ctx.onReleaseForced === "function") {
                        ctx.onReleaseForced(isOut ? f.destination : f.origin)
                    } else {
                        ctx.onFlightClick(f, ctx.hubIata)
                    }
                })
            }
            strip.append(bar)
        }

        // Empty-strip hint. Slice D: when this wave has zero capacity
        // (composition 0/0/0) point the user at the spinners instead of
        // the unhelpful "no flights placed" — that's the most common
        // first-run reason a wave is empty, and the fix is one click left.
        if (!flights.length) {
            const hint = document.createElement("div")
            hint.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;"
                + "justify-content:center;color:#4b5563;font-size:10px;font-style:italic;"
            const totalCap = (comp.shortHaul || 0) + (comp.mediumHaul || 0) + (comp.longHaul || 0)
            if (totalCap === 0) {
                hint.textContent = "← set S / M / L capacity to place flights here"
                hint.style.color = "#fbbf24"
            } else {
                hint.textContent = "no flights placed in this wave"
            }
            strip.append(hint)
        }

        lane.append(label, strip)
        return lane
    }

    static _mkBand(startMin, endMin, ctx, color, kind) {
        const band = document.createElement("div")
        const left  = ((startMin - ctx.startMin) / ctx.totalMin) * 100
        const width = ((endMin - startMin) / ctx.totalMin) * 100
        Object.assign(band.style, {
            position:    "absolute",
            top:         (kind === "arrival" ? "0" : "24px"),
            left:        Math.max(0, left) + "%",
            width:       Math.max(0, width) + "%",
            height:      "24px",
            background:  color,
            pointerEvents: "none"
        })
        return band
    }

    /**
     * Slice 2 — render curved SVG connection lines over the lanes.
     *
     * One <svg> overlays the host, sized to its bounding box. For each
     * connection record, look up the matching inbound + outbound bar via
     * data-flight-seq, anchor a cubic bezier between the inbound's right
     * edge and the outbound's left edge, stroke-style by classification.
     * pointer-events:none on the SVG so existing bar tooltips/clicks still
     * work; hover wiring lives on the host via event delegation.
     *
     * Caller has already verified build.connections.length > 0.
     */
    static _renderConnectionsOverlay(host, connections, opts) {
        const onPillClick = (opts && typeof opts.onInterlinePillClick === "function")
            ? opts.onInterlinePillClick
            : null
        host.style.position = "relative"
        const hostRect = host.getBoundingClientRect()
        const SVGNS = "http://www.w3.org/2000/svg"
        const svg = document.createElementNS(SVGNS, "svg")
        svg.setAttribute("data-aes-conn-overlay", "1")
        svg.setAttribute("width", "100%")
        svg.setAttribute("height", "100%")
        Object.assign(svg.style, {
            position:      "absolute",
            inset:         "0",
            pointerEvents: "none",
            zIndex:        "5",
            overflow:      "visible"
        })

        const styleByCls = {
            own:       {stroke: "#60a5fa", dash: null},
            interline: {stroke: "#fbbf24", dash: "4 3"},
            alliance:  {stroke: "#a78bfa", dash: "2 2 6 2"}
        }

        let drawn = 0
        for (const c of connections) {
            if (c.overflow) continue
            const inb = host.querySelector('[data-flight-seq="' + c.inboundSeq + '"]')
            const out = host.querySelector('[data-flight-seq="' + c.outboundSeq + '"]')
            if (!inb || !out) continue
            const ir = inb.getBoundingClientRect()
            const or = out.getBoundingClientRect()
            // Local coords (px relative to host's top-left).
            const x1 = ir.right - hostRect.left
            const y1 = ir.top + ir.height / 2 - hostRect.top
            const x2 = or.left - hostRect.left
            const y2 = or.top + or.height / 2 - hostRect.top
            // Cubic bezier with control points pulled inward 40% horizontally
            // for a smooth S-curve when y1 ≠ y2 (cross-lane connections).
            const dx = Math.max(20, Math.abs(x2 - x1) * 0.4)
            const cx1 = x1 + dx
            const cx2 = x2 - dx
            const d = "M " + x1 + " " + y1
                + " C " + cx1 + " " + y1
                + " " + cx2 + " " + y2
                + " " + x2 + " " + y2
            const style = styleByCls[c.classification] || styleByCls.own
            const path = document.createElementNS(SVGNS, "path")
            path.setAttribute("d", d)
            path.setAttribute("fill", "none")
            path.setAttribute("stroke", style.stroke)
            path.setAttribute("stroke-width", "1.5")
            path.setAttribute("stroke-linecap", "round")
            if (style.dash) path.setAttribute("stroke-dasharray", style.dash)
            path.setAttribute("opacity", "0.55")
            path.dataset.inSeq  = String(c.inboundSeq)
            path.dataset.outSeq = String(c.outboundSeq)
            svg.append(path)
            drawn++

            // H slice 3b.2 — interline share pill at curve midpoint.
            // Bezier with control points (x1+dx, y1) and (x2-dx, y2) has
            // midpoint = ((x1+x2)/2, (y1+y2)/2) — the dx terms cancel at
            // t=0.5 so the linear midpoint formula is exact for our shape.
            if (c.interlineShare) {
                const label = RouteAssistantWaveOverlay._formatInterlineShareLabel(c.interlineShare)
                if (label) {
                    const midX = (x1 + x2) / 2
                    const midY = (y1 + y2) / 2
                    const pad = 3
                    const fontSize = 9
                    const charW = fontSize * 0.55
                    const w = label.length * charW + pad * 2
                    const h = fontSize + pad * 2
                    const rect = document.createElementNS(SVGNS, "rect")
                    rect.setAttribute("x", String(midX - w / 2))
                    rect.setAttribute("y", String(midY - h / 2))
                    rect.setAttribute("width", String(w))
                    rect.setAttribute("height", String(h))
                    rect.setAttribute("rx", "2")
                    rect.setAttribute("fill", "rgba(15,23,42,0.85)")
                    rect.setAttribute("stroke", style.stroke)
                    rect.setAttribute("stroke-width", "1")
                    rect.dataset.inSeq  = String(c.inboundSeq)
                    rect.dataset.outSeq = String(c.outboundSeq)
                    rect.dataset.aesInterlinePill = "1"
                    rect.dataset.aesDest = String(c.outboundDest || "")
                    // Tooltip via SVG <title> — surfaces per-class detail
                    // and partner names on hover without a custom popover.
                    const tip = RouteAssistantWaveOverlay._formatInterlineShareTooltip(c.interlineShare)
                    if (tip) {
                        const titleNode = document.createElementNS(SVGNS, "title")
                        titleNode.textContent = tip
                        rect.append(titleNode)
                    }
                    svg.append(rect)
                    const text = document.createElementNS(SVGNS, "text")
                    text.setAttribute("x", String(midX))
                    text.setAttribute("y", String(midY))
                    text.setAttribute("text-anchor", "middle")
                    text.setAttribute("dominant-baseline", "central")
                    text.setAttribute("font-size", String(fontSize))
                    text.setAttribute("font-family", "monospace")
                    text.setAttribute("fill", "#fbbf24")
                    text.setAttribute("opacity", "0.95")
                    text.dataset.inSeq  = String(c.inboundSeq)
                    text.dataset.outSeq = String(c.outboundSeq)
                    text.dataset.aesInterlinePill = "1"
                    text.dataset.aesDest = String(c.outboundDest || "")
                    text.textContent = label
                    if (tip) {
                        const titleNode2 = document.createElementNS(SVGNS, "title")
                        titleNode2.textContent = tip
                        text.append(titleNode2)
                    }
                    svg.append(text)
                    // Click-through to the panel's per-route popover. The
                    // SVG sits behind a pointer-events:none wrapper, so we
                    // re-enable pointer events on the pill nodes only.
                    if (onPillClick && c.outboundDest) {
                        rect.style.pointerEvents = "auto"
                        rect.style.cursor = "pointer"
                        text.style.pointerEvents = "auto"
                        text.style.cursor = "pointer"
                        const handler = (ev) => {
                            ev.preventDefault()
                            ev.stopPropagation()
                            try { onPillClick(String(c.outboundDest), rect) }
                            catch (_) { /* swallow — pill click never blocks */ }
                        }
                        rect.addEventListener("click", handler)
                        text.addEventListener("click", handler)
                    }
                }
            }
        }

        if (!drawn) return
        host.append(svg)
        RouteAssistantWaveOverlay._wireConnectionHover(host, svg)
    }

    /**
     * H slice 3b.2 — compact label like "Y 30%" or "Y/C 45%" for the
     * interline pill. Picks the dominant class (PAX > CARGO when both
     * non-zero; abbreviates Y/C/F as the umbrella when paxPercent is the
     * sum of subclasses). Returns null when neither side carries share.
     */
    static _formatInterlineShareLabel(share) {
        if (!share) return null
        const pax = Math.round(Number(share.paxPercent) || 0)
        const cargo = Math.round(Number(share.cargoPercent) || 0)
        if (!pax && !cargo) return null
        if (pax && cargo) return "P " + pax + "% · C " + cargo + "%"
        if (pax) return "Y " + pax + "%"
        return "C " + cargo + "%"
    }

    /**
     * H slice 3b.2 follow-up — multi-line tooltip for the pill. SVG <title>
     * elements support newlines, so we surface the per-class breakdown
     * (Y / C / F) when an asymmetric record exists. Falls back to the
     * aggregate paxPercent when only umbrella PAX entries are present.
     */
    static _formatInterlineShareTooltip(share) {
        if (!share) return null
        const lines = []
        const byClass = share.byClass || null
        if (byClass) {
            for (const cls of ["Y", "C", "F"]) {
                const v = Math.round(Number(byClass[cls]) || 0)
                if (v > 0) lines.push("• " + cls + ": " + v + "% interlined")
            }
        }
        if (!lines.length && share.paxPercent > 0) {
            lines.push("• Pax: " + Math.round(share.paxPercent) + "% interlined")
        }
        if (share.cargoPercent > 0) {
            lines.push("• Cargo: " + Math.round(share.cargoPercent) + "% interlined")
        }
        if (!lines.length) return null
        // H slice 3b.2.2 — sensitivity surfacing. Estimator-derived loss in
        // weekly revenue (cost stays fixed regardless of codeshare share,
        // so revenue loss == profit loss). Surfaced when the panel's
        // lookup decorated the share with non-zero figures.
        const lossPerWeek = Number(share.revenueLossPerWeek) || 0
        if (lossPerWeek > 0) {
            lines.push("")
            lines.push("Forgone revenue ≈ "
                + RouteAssistantWaveOverlay._formatMoneyShort(lossPerWeek) + "/wk")
            lines.push("(cost stays the same — make sure the deal is worth it)")
        }
        return "Interline share on this route\n" + lines.join("\n") + "\nClick to edit partners."
    }

    /**
     * H slice 3b.2.2 — compact money formatter for tooltip lines.
     * `123456` → `"$123K"`, `1234567` → `"$1.2M"`, smaller values rounded
     * to the nearest hundred. Negative values flow through with the sign.
     */
    static _formatMoneyShort(n) {
        const v = Number(n) || 0
        const sign = v < 0 ? "-" : ""
        const a = Math.abs(v)
        if (a >= 1e6) return sign + "$" + (Math.round(a / 1e5) / 10) + "M"
        if (a >= 1e3) return sign + "$" + Math.round(a / 1e3) + "K"
        return sign + "$" + Math.round(a / 100) * 100
    }

    /**
     * Slice 2 — hover wiring. Mouse over any flight bar (data-flight-seq
     * attribute) dims every non-matching connection path and brightens the
     * matching ones. Mouse out restores defaults. Event delegation so panel
     * re-renders that wipe + rebuild bars don't leak listeners.
     */
    static _wireConnectionHover(host, svg) {
        const setBaseline = () => {
            for (const p of svg.querySelectorAll("path")) {
                p.setAttribute("opacity", "0.55")
                p.setAttribute("stroke-width", "1.5")
            }
        }
        host.addEventListener("mouseover", (e) => {
            const t = e.target && e.target.closest && e.target.closest("[data-flight-seq]")
            if (!t) return
            const seq = t.dataset.flightSeq
            if (!seq) return
            for (const p of svg.querySelectorAll("path")) {
                const matches = p.dataset.inSeq === seq || p.dataset.outSeq === seq
                if (matches) {
                    p.setAttribute("opacity", "1")
                    p.setAttribute("stroke-width", "2.5")
                } else {
                    p.setAttribute("opacity", "0.08")
                    p.setAttribute("stroke-width", "0.8")
                }
            }
        })
        host.addEventListener("mouseout", (e) => {
            const t = e.target && e.target.closest && e.target.closest("[data-flight-seq]")
            if (!t) return
            // Only reset if we left the bar entirely (relatedTarget isn't another bar).
            const into = e.relatedTarget && e.relatedTarget.closest
                ? e.relatedTarget.closest("[data-flight-seq]")
                : null
            if (into) return
            setBaseline()
        })
    }

    /**
     * Slice 2 — render a small legend strip below the gantt explaining the
     * three connection visual styles + counts + transfer-time range. Always
     * rendered (even when the SVG overlay is toggled off) so users discover
     * the feature.
     */
    static _renderConnectionLegend(host, connections, factors) {
        const real = (connections || []).filter(c => !c.overflow)
        const overflow = (connections || []).find(c => c.overflow)
        const minXfr = Number(factors.minTransferMinutes) || 45
        const maxXfr = Number(factors.maxTransferMinutes) || 240

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:8px;padding:6px 8px;display:flex;"
            + "gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;"
            + "background:rgba(15,22,35,0.6);border:1px solid #1f2937;"
            + "border-radius:4px;color:#cbd5e1;"

        const head = document.createElement("strong")
        head.textContent = "🔗 Connections"
        head.style.cssText = "color:#e5e7eb;"
        wrap.append(head)

        if (!real.length) {
            const empty = document.createElement("span")
            empty.textContent = "No valid inbound→outbound pairs in this build."
            empty.style.cssText = "color:#6b7280;font-style:italic;"
            wrap.append(empty)
            host.append(wrap)
            return
        }

        const counts = {own: 0, interline: 0, alliance: 0}
        for (const c of real) counts[c.classification] = (counts[c.classification] || 0) + 1

        const mkPill = (glyph, label, color, count) => {
            const pill = document.createElement("span")
            pill.style.cssText = "display:inline-flex;align-items:center;gap:4px;"
                + "padding:2px 6px;border-radius:8px;font-size:10px;"
                + "color:" + color + ";border:1px solid " + color + "55;"
                + "background:" + color + "12;"
            pill.textContent = glyph + " " + label + " (" + count + ")"
            return pill
        }
        wrap.append(mkPill("●",   "own",       "#60a5fa", counts.own))
        wrap.append(mkPill("▬▬",  "interline", "#fbbf24", counts.interline))
        wrap.append(mkPill("╴╴╴", "alliance",  "#a78bfa", counts.alliance))

        const range = document.createElement("span")
        range.textContent = "⏱ " + minXfr + "–" + maxXfr + " min"
        range.style.cssText = "color:#9ca3af;font-size:10px;"
        wrap.append(range)

        if (overflow && overflow.count > 0) {
            const more = document.createElement("span")
            more.textContent = "+" + overflow.count + " more (capped)"
            more.style.cssText = "color:#fbbf24;font-size:10px;font-style:italic;"
            wrap.append(more)
        }

        host.append(wrap)
    }

    /**
     * Phase A1: emit gesture lifecycle to whichever buses are present so
     * the chip→lane HTML5 native drag participates in the same audit
     * trail as arbiter-routed manual drags. Browser ESC already cancels
     * HTML5 drag natively — this is purely instrumentation.
     */
    static _emitGestureBus(event, payload) {
        const buses = []
        try { if (window.AesAfp && window.AesAfp.bus) buses.push(window.AesAfp.bus) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) buses.push(window.AesStrategy.bus) } catch (_) {}
        try { if (window.CentralHubBus) buses.push(window.CentralHubBus) } catch (_) {}
        for (const bus of buses) {
            try { bus.emit(event, payload) } catch (_) {}
        }
    }
}
