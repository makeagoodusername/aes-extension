"use strict"

/**
 * Sidebar maintenance widget (Track 2 slice 2d).
 *
 * Renders one line into the new `maintenance` slot inside AesAfp's sidebar
 * scaffold:
 *
 *     Maintenance 124.8% · Condition 100% · Budget 85h/wk · Forecast 110% in 7d
 *
 * Click expands the line to a tiny inline SVG scatter plot of the wear-
 * model regression — y = Δratio per week, x = weeklyBlockHours — so the
 * user can sanity-check the slope before trusting the budget.
 *
 * Only registers on `/0` (where AesAfp + the sidebar slot exist). On `/1`
 * the storage writes still happen but no widget is mounted.
 *
 * Bus events listened to:
 *   - "maintenance:scraped" → re-read MaintenanceStore + recompute budget
 *   - "wear:updated"        → recompute budget (regression coefficients)
 *   - "ctx:ready"           → first paint
 *
 * Storage events listened to:
 *   - aircraftFlightPlan:maintenance:<server>:<aircraftId>     → repaint
 *   - aircraftFlightPlan:wearObservations:<server>:<aircraftId>→ repaint
 */
;(function () {
    if (typeof window === "undefined" || window.AesAfpMaintenanceWidget) return

    const STATUS_COLOR = {good: "#34d399", warn: "#facc15", bad: "#f87171"}
    const NEUTRAL_COLOR = "#cbd5e1"
    const MUTED_COLOR   = "#9ca3af"

    function _esc(s) {
        if (typeof escapeHtml === "function") return escapeHtml(s)
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    }

    function _fmtPct(v, digits) {
        if (!isFinite(v)) return "—"
        const d = isFinite(digits) ? digits : 1
        return Number(v).toFixed(d) + "%"
    }

    function _fmtHours(v) {
        if (!isFinite(v)) return "—"
        return Math.round(Number(v)) + "h/wk"
    }

    function _statusColor(status) {
        return STATUS_COLOR[status] || NEUTRAL_COLOR
    }

    function _forecastColor(forecast, floor) {
        if (!isFinite(forecast)) return NEUTRAL_COLOR
        if (forecast < floor)        return STATUS_COLOR.bad
        if (forecast < floor + 5)    return STATUS_COLOR.warn
        return NEUTRAL_COLOR
    }

    /**
     * Render the regression scatter plot. samples are newest-first.
     * Returns SVG markup, or "" if there's nothing to plot.
     */
    function _scatterSvg(samples, fit) {
        if (!Array.isArray(samples) || samples.length < 2) {
            return '<div style="color:' + MUTED_COLOR + ';font-style:italic;font-size:11px;">'
                + 'Need 3+ weekly samples to fit a regression. Currently '
                + samples.length + '.</div>'
        }
        const ordered = samples.slice().reverse()
        const points = []
        for (let i = 1; i < ordered.length; i++) {
            const prev = ordered[i - 1]
            const cur  = ordered[i]
            if (!prev || !cur) continue
            if (!isFinite(cur.weeklyBlockHours) || !isFinite(cur.ratio) || !isFinite(prev.ratio)) continue
            points.push({x: cur.weeklyBlockHours, y: cur.ratio - prev.ratio})
        }
        if (!points.length) {
            return '<div style="color:' + MUTED_COLOR + ';font-style:italic;font-size:11px;">'
                + 'Not enough comparable pairs yet.</div>'
        }

        const W = 240, H = 100, P = 18
        let xMin =  Infinity, xMax = -Infinity
        let yMin =  Infinity, yMax = -Infinity
        for (const p of points) {
            if (p.x < xMin) xMin = p.x
            if (p.x > xMax) xMax = p.x
            if (p.y < yMin) yMin = p.y
            if (p.y > yMax) yMax = p.y
        }
        if (yMin === yMax) { yMin -= 1; yMax += 1 }
        if (xMin === xMax) { xMin -= 1; xMax += 1 }
        const sx = x => P + (x - xMin) / (xMax - xMin) * (W - 2 * P)
        const sy = y => H - P - (y - yMin) / (yMax - yMin) * (H - 2 * P)

        let dots = ""
        for (const p of points) {
            dots += '<circle cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1)
                + '" r="3" fill="#60a5fa"/>'
        }

        let line = ""
        if (fit && fit.valid && isFinite(fit.slope) && isFinite(fit.intercept)) {
            const x1 = xMin, y1 = fit.slope * x1 + fit.intercept
            const x2 = xMax, y2 = fit.slope * x2 + fit.intercept
            line = '<line x1="' + sx(x1).toFixed(1) + '" y1="' + sy(y1).toFixed(1)
                + '" x2="' + sx(x2).toFixed(1) + '" y2="' + sy(y2).toFixed(1)
                + '" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3,2"/>'
        }

        const zeroY = sy(0)
        const zeroLine = (zeroY > P && zeroY < H - P)
            ? '<line x1="' + P + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - P)
              + '" y2="' + zeroY.toFixed(1) + '" stroke="#374151" stroke-width="1"/>'
            : ""

        return '<svg width="' + W + '" height="' + H
            + '" style="background:#0f1623;border:1px solid #1f2937;border-radius:4px;">'
            + zeroLine + line + dots
            + '<text x="' + (W - P) + '" y="' + (H - 4) + '" text-anchor="end" '
            + 'fill="' + MUTED_COLOR + '" font-size="9">block h/wk →</text>'
            + '<text x="4" y="12" fill="' + MUTED_COLOR + '" font-size="9">Δratio/wk</text>'
            + '</svg>'
    }

    function _headlineHtml(budget) {
        const rColor = _statusColor(budget.ratioStatus)
        const cColor = _statusColor(budget.conditionStatus)
        const fcastColor = _forecastColor(budget.forecastRatio7d, budget.ratioFloor)

        const parts = []
        parts.push('<span style="color:' + rColor + ';">Maint '
            + _fmtPct(budget.currentRatio) + '</span>')
        parts.push('<span style="color:' + cColor + ';">Cond '
            + _fmtPct(budget.currentCondition, 0) + '</span>')
        parts.push('<span title="Equilibrium weekly block hours' + (budget.source === "fallback"
            ? ' (fallback — wear regression not fitted yet)' : '')
            + '">Budget ' + _fmtHours(budget.maxWeeklyBlockHours) + '</span>')
        if (isFinite(budget.forecastRatio7d)) {
            parts.push('<span style="color:' + fcastColor
                + ';" title="Projected ratio in 7d at current schedule">'
                + 'Fcast ' + _fmtPct(budget.forecastRatio7d) + ' in 7d</span>')
        }
        return parts.join(' · ')
    }

    /**
     * Build the expanded body — extra metadata + the scatter plot.
     */
    async function _expandedBody(server, aircraftId, budget) {
        const samples = (typeof AesAfpWearModel !== "undefined")
            ? await AesAfpWearModel.loadSamples(server, aircraftId)
            : []
        const fit = budget && budget.fit ? budget.fit : null

        const meta = []
        meta.push('Source: <b>' + _esc(budget.source) + '</b>')
        if (isFinite(budget.currentScheduledWeeklyHours)) {
            meta.push('Scheduled: ' + Math.round(budget.currentScheduledWeeklyHours) + 'h/wk')
        }
        if (isFinite(budget.equilibriumRatio)) {
            meta.push('Asymptote: ' + _fmtPct(budget.equilibriumRatio))
        }
        if (fit && isFinite(fit.sampleCount)) {
            meta.push('Samples: ' + fit.sampleCount + ' (pairs: ' + (fit.pairCount || 0) + ')')
        }
        if (fit && fit.reason && !fit.valid) {
            meta.push('Fit: ' + _esc(fit.reason))
        }

        return '<div style="font-size:10px;color:' + MUTED_COLOR + ';margin:4px 0 6px 0;">'
            + meta.join(' · ') + '</div>'
            + _scatterSvg(samples, fit)
    }

    let _expanded = false

    async function _renderInto(slot) {
        if (!slot) return
        const ctx = (window.AesAfp && AesAfp.ctx) || null
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            slot.innerHTML = ''
            return
        }
        if (typeof AesAfpMaintenanceBudget === "undefined") {
            slot.innerHTML = '<div style="color:' + MUTED_COLOR + ';font-size:11px;">'
                + 'Budget API not loaded.</div>'
            return
        }

        const spec = (window.AesAfpSpecResolver && AesAfpSpecResolver.last) || null
        const settings = (typeof AesAfpSettings !== "undefined")
            ? await AesAfpSettings.load() : {}
        const budget = await AesAfpMaintenanceBudget.compute({
            server: ctx.server, aircraftId: ctx.aircraftId, spec, settings
        })
        if (!budget) {
            slot.innerHTML = '<div style="color:' + MUTED_COLOR + ';font-size:11px;">'
                + 'No maintenance reading yet.</div>'
            return
        }

        const headline = _headlineHtml(budget)
        const html = []
        html.push('<div data-aes-afp-maint style="font-size:11px;padding:4px 0;cursor:pointer;" '
            + 'title="Click to expand the wear-model regression chart.">')
        html.push('  <div data-aes-afp-maint-headline>' + headline + '</div>')
        if (_expanded) {
            const body = await _expandedBody(ctx.server, ctx.aircraftId, budget)
            html.push('  <div data-aes-afp-maint-body style="margin-top:6px;">' + body + '</div>')
        }
        html.push('</div>')
        slot.innerHTML = html.join("")

        const root = slot.querySelector("[data-aes-afp-maint]")
        if (root) {
            root.addEventListener("click", async (e) => {
                if (e.target && e.target.closest && e.target.closest("a, button")) return
                _expanded = !_expanded
                await _renderInto(slot)
            })
        }
    }

    function _slot() {
        return (window.AesAfp && typeof AesAfp.slot === "function")
            ? AesAfp.slot("maintenance") : null
    }

    let _renderTimer = null
    function _scheduleRender() {
        if (_renderTimer) clearTimeout(_renderTimer)
        _renderTimer = setTimeout(() => {
            _renderTimer = null
            _renderInto(_slot()).catch(err =>
                console.warn("[AES AFP maintenance-widget] render failed", err))
        }, 60)
    }

    function _whenReady(cb) {
        const start = Date.now()
        const tick = () => {
            if (window.AesAfp && AesAfp.bus && typeof AesAfp.slot === "function") {
                cb()
                return
            }
            if (Date.now() - start > 30000) return
            setTimeout(tick, 200)
        }
        tick()
    }

    function _wire(bus) {
        bus.on("ctx:ready",          () => _scheduleRender())
        bus.on("maintenance:scraped",() => _scheduleRender())
        bus.on("wear:updated",       () => _scheduleRender())
        bus.on("spec:resolved",      () => _scheduleRender())

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            const ctx = (window.AesAfp && AesAfp.ctx) || null
            if (!ctx || !ctx.server || !ctx.aircraftId) return
            const maintKey = "aircraftFlightPlan:maintenance:" + ctx.server + ":" + ctx.aircraftId
            const wearKey  = "aircraftFlightPlan:wearObservations:" + ctx.server + ":" + ctx.aircraftId
            if (Object.prototype.hasOwnProperty.call(changes, maintKey)
             || Object.prototype.hasOwnProperty.call(changes, wearKey)) {
                _scheduleRender()
            }
        })

        _scheduleRender()
    }

    const AesAfpMaintenanceWidget = {render: () => _scheduleRender()}
    window.AesAfpMaintenanceWidget = AesAfpMaintenanceWidget

    _whenReady(() => {
        try { _wire(window.AesAfp.bus) }
        catch (e) { console.warn("[AES AFP maintenance-widget] wiring failed", e) }
    })
})()
