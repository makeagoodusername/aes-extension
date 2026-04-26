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
 * Slice 1 is read-only against ScheduleStore. The build runs in-memory
 * only; nothing persists. Slice 2 will add an explicit "Save schedule"
 * CTA that hands the build to ScheduleStore.save().
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
     * + shortfall + skipped + validation in a single rich object so the
     * renderer can show the full picture without re-running phases.
     *
     * @param {object} preset - SchedulePresets record
     * @param {Array} scoredRows
     * @param {object} ctx - {server, airlineCode, hubIata, selectedSpec, topN}
     * @returns {object} {validation, routes, flights, warnings, placements, unplaced, shortfall, skipped, preset}
     */
    static buildSchedule(preset, scoredRows, ctx) {
        const c = ctx || {}
        const out = {
            validation: [], routes: [], flights: [], warnings: [],
            placements: [], unplaced: [], shortfall: {}, skipped: [],
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

        const assignment = builder.assignRoutes(routes)
        out.placements = assignment.placements
        out.unplaced   = assignment.unplaced
        out.shortfall  = assignment.shortfall

        const evaluation = builder.evaluateFlights(assignment.placements)
        out.flights  = evaluation.flights
        out.warnings = evaluation.warnings
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
                    onFlightClick: o.onFlightClick,
                    hubIata: o.hubIata
                }
            )
            host.append(lane)
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
        if (build.unplaced && build.unplaced.length) {
            const ubox = document.createElement("div")
            ubox.style.cssText = "margin-top:8px;padding:6px 8px;"
                + "background:rgba(107,114,128,0.10);border:1px solid #374151;"
                + "border-radius:4px;font-size:11px;color:#cbd5e1;"
            const h = document.createElement("strong")
            h.textContent = "Unplaced (" + build.unplaced.length + ")"
            h.style.cssText = "color:#cbd5e1;display:block;margin-bottom:4px;"
            ubox.append(h)
            const chips = document.createElement("div")
            chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
            for (const r of build.unplaced) {
                const chip = document.createElement("span")
                chip.style.cssText = "padding:2px 6px;background:#374151;border-radius:3px;"
                    + "font-family:monospace;font-size:10px;color:#cbd5e1;"
                chip.textContent = r.destination + " " + r.distanceNm + "nm"
                chip.title = "No wave with matching " + (ScheduleFactors.bucketize(r.distanceNm,
                    preset.factors && preset.factors.rangeBuckets) || "?") + " capacity"
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
    }

    /**
     * Render one wave swim-lane. Internal helper — caller is renderGantt.
     */
    static _renderLane(wave, flights, build, ctx) {
        const lane = document.createElement("div")
        lane.style.cssText = "display:flex;align-items:stretch;margin-bottom:3px;"
            + "border:1px solid #2a3444;border-radius:3px;background:#0f1623;"

        // Wave label (fixed-width left column)
        const label = document.createElement("div")
        label.style.cssText = "width:140px;flex-shrink:0;padding:6px 8px;"
            + "border-right:1px solid #2a3444;background:#111827;color:#cbd5e1;font-size:11px;"
        const comp = wave.composition || {}
        const compStr = [comp.shortHaul || 0, comp.mediumHaul || 0, comp.longHaul || 0].join("/")
        label.innerHTML = "<strong>" + escapeHtml(wave.label || "Wave") + "</strong>"
            + "<br><span style='color:#6b7280;font-size:9px;font-family:monospace;'>"
            + compStr + " S/M/L</span>"
            + "<br><span style='color:#6b7280;font-size:9px;'>"
            + "arr " + escapeHtml(wave.arrivalWindow.start) + "–" + escapeHtml(wave.arrivalWindow.end)
            + "<br>dep " + escapeHtml(wave.departureWindow.start) + "–" + escapeHtml(wave.departureWindow.end)
            + "</span>"

        // Flight strip (relative-positioned canvas for absolute children)
        const strip = document.createElement("div")
        strip.style.cssText = "position:relative;flex:1;height:48px;"
            + "background-image:linear-gradient(to right, #1a2233 1px, transparent 1px);"
            + "background-size:" + (100 / Math.max(1, ctx.cropMax - ctx.cropMin)) + "% 100%;"

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
            bar.textContent = peer
            bar.title = (isOut ? "OUT " : "IN  ")
                + f.origin + "→" + f.destination
                + "  " + f.depTimeLocal
                + "  " + f.distanceNm + "nm"
                + (f.aircraftType ? "  " + f.aircraftType : "")
                + (f.rangeBucket ? "  [" + f.rangeBucket + "]" : "")
            // Range bucket — colored left edge: short=lighter, long=darker
            if (f.rangeBucket === "longHaul")        bar.style.borderLeft = "3px solid #1e40af"
            else if (f.rangeBucket === "mediumHaul") bar.style.borderLeft = "3px solid #2563eb"
            else if (f.rangeBucket === "shortHaul")  bar.style.borderLeft = "3px solid #60a5fa"

            if (ctx.onFlightClick) {
                bar.addEventListener("click", (e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    ctx.onFlightClick(f, ctx.hubIata)
                })
            }
            strip.append(bar)
        }

        // Empty-strip hint
        if (!flights.length) {
            const hint = document.createElement("div")
            hint.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;"
                + "justify-content:center;color:#4b5563;font-size:10px;font-style:italic;"
            hint.textContent = "no flights placed in this wave"
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
}
