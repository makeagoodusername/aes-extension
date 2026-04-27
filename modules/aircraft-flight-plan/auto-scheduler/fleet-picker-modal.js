"use strict"

/**
 * Track 8 slice 8b — fleet-picker modal.
 *
 * Lets the user pick N aircraft from their fleet for a fleet-wide apply
 * run. Renders one row per aircraft from `AesFleetRoster.loadCurrent()`
 * with checkboxes, range-fit (✓ / ✗ vs the preset's max-distance haul),
 * draft-pending warning, and an at-hub filter.
 *
 * The modal is intentionally minimal: it returns the picked aircraftIds.
 * The caller is responsible for materialising per-aircraft leg lists
 * (typically via ScheduleBuilder per aircraft + spec) and handing them
 * to AesAfpFleetApplyOrchestrator.
 *
 * Public API (window.AesAfpFleetPickerModal):
 *   .open(opts) → Promise<{aircraftIds:[], cancelled:bool}>
 *
 * opts shape:
 *   {
 *     preset:        SchedulePresets record  // for range-fit display + max distance
 *     hub:           "JFK"                   // optional; pre-checks at-hub filter
 *     title:         "Apply wave to fleet"   // optional
 *     server:        "simulator-1"           // optional; defaults to AES.getServer()
 *     airlineCode:   "PAA"                   // optional
 *     allowMultiHub: bool                    // default true; when false, only at-hub aircraft are pickable
 *   }
 *
 * Esc / overlay click → cancelled. Default "primary" button is disabled
 * until at least one aircraft is checked.
 */
;(function () {
    if (window.AesAfpFleetPickerModal) return

    const KM_PER_NM = 1.852

    let _modalEl = null
    let _onKey   = null
    let _resolve = null

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
        if (r) r(payload || {aircraftIds: [], cancelled: true})
    }

    /**
     * Pull the longest haul from a preset by reading its waves' composition
     * + matching against the rangeBuckets factor. Falls back to 6500nm
     * (~12000km, A380 territory) when the preset has no buckets defined.
     */
    function _maxHaulNm(preset) {
        if (!preset || !preset.factors) return 6500
        const buckets = preset.factors.rangeBuckets
        if (!buckets || typeof buckets !== "object") return 6500
        let usedBuckets = new Set()
        for (const w of (preset.waves || [])) {
            for (const k in (w.composition || {})) {
                if ((w.composition[k] | 0) > 0) usedBuckets.add(k)
            }
        }
        let max = 0
        for (const key of usedBuckets) {
            const b = buckets[key]
            if (!b) continue
            const top = (typeof b.maxNm === "number") ? b.maxNm
                      : (typeof b.toNm === "number")  ? b.toNm
                      : (typeof b.max === "number")   ? b.max
                      : 0
            if (top > max) max = top
        }
        return max || 6500
    }

    /**
     * Resolve range (in nm) for one aircraft. Best-effort — uses cached
     * spec via AesAircraftSpec.get when available; returns null when
     * spec not resolvable. Range-fit display falls back to "?".
     */
    async function _aircraftRangeNm(aircraft, server, airlineCode) {
        if (!aircraft) return null
        if (typeof window.AesAircraftSpec === "undefined") return null
        try {
            const spec = await window.AesAircraftSpec.get({
                aircraftId:  aircraft.aircraftId,
                equipment:   aircraft.equipment,
                typeId:      aircraft.typeId,
                server:      server,
                airlineCode: airlineCode
            })
            if (!spec || !spec.range) return null
            return Math.round(spec.range / KM_PER_NM)
        } catch (e) {
            return null
        }
    }

    /**
     * Best-effort maintenance-window lookup. Returns a short label
     * ("🔧 due") when AesAfpMaintenanceStore reports a pending item,
     * else null. Soft dependency — when the store isn't loaded, returns
     * null and the row simply omits the badge.
     */
    async function _maintenanceBadge(aircraftId, server) {
        if (typeof window.AesAfpMaintenanceStore === "undefined") return null
        if (!aircraftId || !server) return null
        try {
            const rec = await window.AesAfpMaintenanceStore.load(server, aircraftId)
            if (!rec) return null
            const items = rec.items || rec.forecast || rec.windows || []
            if (!Array.isArray(items) || !items.length) return null
            // Coarse signal: any pending / forecast item within next 7 days.
            const horizon = Date.now() + 7 * 24 * 60 * 60 * 1000
            for (const it of items) {
                const at = it && (it.at || it.startUtc || it.dueUtc)
                const t = at ? Date.parse(at) : null
                if (t != null && isFinite(t) && t <= horizon) return "🔧 7d"
            }
            return null
        } catch (e) { return null }
    }

    /**
     * Best-effort active-draft warning. Returns short label when the
     * aircraft already has an active draft pending. Soft dep.
     */
    async function _draftBadge(aircraftId, server) {
        if (typeof window.AesAfpActiveDraftStore === "undefined") return null
        if (!aircraftId || !server) return null
        try {
            const draft = await window.AesAfpActiveDraftStore.load(server, aircraftId)
            if (!draft) return null
            const flightCount = (draft.flights && draft.flights.length) || 0
            if (!flightCount) return null
            return "📝 draft (" + flightCount + ")"
        } catch (e) { return null }
    }

    function _renderEmptyBody(body, message) {
        body.textContent = ""
        const empty = document.createElement("p")
        empty.style.cssText = "color:#9ca3af;margin:8px 0;font-style:italic;"
        empty.textContent = message
        body.appendChild(empty)
    }

    /**
     * Build one aircraft row (header + checkbox + meta). Returns the row
     * element + a `applyState({checked})` mutator the caller invokes when
     * filters change.
     */
    function _buildRow(aircraft, ctx) {
        const tr = document.createElement("tr")
        tr.dataset.aircraftId = String(aircraft.aircraftId || "")
        tr.dataset.location   = String(aircraft.currentLocationIata || aircraft.locationIata || "")
        tr.dataset.fitOk      = "1"   // updated below

        const tdSel = document.createElement("td")
        tdSel.style.cssText = "padding:4px 6px;text-align:center;width:24px;"
        const cb = document.createElement("input")
        cb.type = "checkbox"
        cb.dataset.aesPicker = "1"
        cb.addEventListener("change", () => ctx.recount())
        tdSel.appendChild(cb)
        tr.appendChild(tdSel)

        const cells = [
            {key: "registration", text: aircraft.registration || "(no reg)"},
            {key: "equipment",    text: aircraft.equipment    || "(no type)"},
            {key: "location",     text: aircraft.currentLocationIata || aircraft.locationIata || "—"},
            {key: "range",        text: "…"},   // filled async
            {key: "fit",          text: "…"},
            {key: "badges",       text: ""}
        ]
        for (const c of cells) {
            const td = document.createElement("td")
            td.dataset.col = c.key
            td.textContent = c.text
            td.style.cssText = "padding:4px 6px;border-bottom:1px solid #1f2937;"
                + "color:#cbd5e1;font-size:11px;font-family:monospace;white-space:nowrap;"
            if (c.key === "registration") td.style.color = "#e5e7eb"
            tr.appendChild(td)
        }

        return {tr, cb}
    }

    function _enrichRow(tr, aircraft, ctx) {
        const tdRange  = tr.querySelector('[data-col="range"]')
        const tdFit    = tr.querySelector('[data-col="fit"]')
        const tdBadges = tr.querySelector('[data-col="badges"]')

        Promise.all([
            _aircraftRangeNm(aircraft, ctx.server, ctx.airlineCode),
            _maintenanceBadge(aircraft.aircraftId, ctx.server),
            _draftBadge(aircraft.aircraftId, ctx.server)
        ]).then(([rangeNm, maint, draft]) => {
            if (rangeNm == null) {
                tdRange.textContent = "?"
                tdFit.textContent = "?"
                tdFit.style.color = "#9ca3af"
            } else {
                tdRange.textContent = rangeNm + "nm"
                const ok = rangeNm >= ctx.maxHaulNm * 0.95   // 5% margin (matches ScheduleFactors.aircraftCanFly)
                tr.dataset.fitOk = ok ? "1" : "0"
                tdFit.textContent = ok ? "✓ fit" : "✗ short"
                tdFit.style.color = ok ? "#10b981" : "#ef4444"
            }
            const badges = []
            if (maint) badges.push(maint)
            if (draft) badges.push(draft)
            tdBadges.textContent = badges.join("  ")
            tdBadges.style.color = badges.length ? "#fbbf24" : "#374151"
            ctx.applyFilters()
        }).catch(() => {})
    }

    /**
     * Main entry. Loads the fleet, paints the modal, returns a promise.
     */
    async function open(opts) {
        if (_modalEl) return Promise.resolve({aircraftIds: [], cancelled: true})
        const o = opts || {}
        const title = o.title || "Apply wave to fleet"
        const preset = o.preset || null
        const hubFilterDefault = !!o.hub
        const hub = o.hub || ""
        const allowMultiHub = o.allowMultiHub !== false   // default true

        // Resolve identity. Prefer caller-provided; fall back to AES helpers.
        let server = o.server || ""
        let airlineCode = o.airlineCode || ""
        if (!server && typeof AES !== "undefined") {
            try { server = AES.getServerName ? AES.getServerName() : (AES.getServer ? AES.getServer() : "") } catch (_) {}
        }
        if (!airlineCode && typeof AES !== "undefined") {
            try { airlineCode = AES.getAirlineCode ? AES.getAirlineCode()
                              : AES.getAirlineIdentity ? AES.getAirlineIdentity()
                              : "" } catch (_) {}
        }

        return new Promise((resolve) => {
            _resolve = resolve

            const overlay = document.createElement("div")
            overlay.setAttribute("data-aes-fleet-picker", "1")
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);"
                + "z-index:10010;display:flex;align-items:center;justify-content:center;"
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) _close({aircraftIds: [], cancelled: true})
            })

            const modal = document.createElement("div")
            modal.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #374151;"
                + "border-radius:6px;min-width:680px;max-width:90vw;max-height:85vh;"
                + "display:flex;flex-direction:column;font:12px/1.4 sans-serif;"
                + "box-shadow:0 10px 40px rgba(0,0,0,0.5);"

            const head = document.createElement("div")
            head.style.cssText = "padding:10px 14px;border-bottom:1px solid #1f2937;"
                + "background:#111827;display:flex;align-items:center;gap:10px;"
            const titleEl = document.createElement("strong")
            titleEl.textContent = title
            titleEl.style.cssText = "color:#e5e7eb;font-size:13px;flex:1 1 auto;"
            const meta = document.createElement("span")
            meta.style.cssText = "color:#9ca3af;font-size:10px;font-family:monospace;"
            meta.textContent = (preset ? preset.name || "(unnamed preset)" : "(no preset)")
                + (hub ? " · " + hub : "")
            head.appendChild(titleEl)
            head.appendChild(meta)
            modal.appendChild(head)

            const filterBar = document.createElement("div")
            filterBar.style.cssText = "padding:8px 14px;border-bottom:1px solid #1f2937;"
                + "background:#0d1320;display:flex;gap:14px;align-items:center;"
                + "color:#cbd5e1;font-size:11px;flex-wrap:wrap;"
            const fHub = document.createElement("label")
            fHub.style.cssText = "display:inline-flex;align-items:center;gap:5px;cursor:pointer;"
            const fHubCb = document.createElement("input")
            fHubCb.type = "checkbox"
            fHubCb.checked = hubFilterDefault
            fHubCb.disabled = !hub
            fHub.appendChild(fHubCb)
            fHub.appendChild(document.createTextNode("At hub" + (hub ? " (" + hub + ")" : "")))
            const fFit = document.createElement("label")
            fFit.style.cssText = fHub.style.cssText
            const fFitCb = document.createElement("input")
            fFitCb.type = "checkbox"
            fFitCb.checked = true
            fFit.appendChild(fFitCb)
            fFit.appendChild(document.createTextNode("Range-fit only"))
            const fBulk = document.createElement("button")
            fBulk.type = "button"
            fBulk.textContent = "Select all visible"
            fBulk.style.cssText = "background:transparent;color:#60a5fa;"
                + "border:1px solid #1e3a8a;border-radius:3px;padding:3px 8px;"
                + "font-size:10px;cursor:pointer;"
            const fNone = document.createElement("button")
            fNone.type = "button"
            fNone.textContent = "Deselect all"
            fNone.style.cssText = fBulk.style.cssText
            filterBar.appendChild(fHub)
            filterBar.appendChild(fFit)
            filterBar.appendChild(fBulk)
            filterBar.appendChild(fNone)
            modal.appendChild(filterBar)

            const body = document.createElement("div")
            body.style.cssText = "padding:8px 14px;overflow-y:auto;flex:1 1 auto;"
            modal.appendChild(body)

            const footer = document.createElement("div")
            footer.style.cssText = "padding:10px 14px;border-top:1px solid #1f2937;"
                + "background:#111827;display:flex;gap:8px;align-items:center;"
            const counter = document.createElement("span")
            counter.style.cssText = "color:#9ca3af;font-size:11px;flex:1 1 auto;font-family:monospace;"
            counter.textContent = "0 picked"
            footer.appendChild(counter)
            const btnCancel = document.createElement("button")
            btnCancel.type = "button"
            btnCancel.textContent = "Cancel"
            btnCancel.style.cssText = "background:transparent;color:#cbd5e1;"
                + "border:1px solid #374151;border-radius:3px;padding:5px 12px;"
                + "font-size:11px;cursor:pointer;"
            btnCancel.addEventListener("click", () => _close({aircraftIds: [], cancelled: true}))
            footer.appendChild(btnCancel)
            const btnApply = document.createElement("button")
            btnApply.type = "button"
            btnApply.textContent = "Apply to 0 aircraft"
            btnApply.disabled = true
            btnApply.style.cssText = "background:#374151;color:#9ca3af;"
                + "border:1px solid #374151;border-radius:3px;padding:5px 14px;"
                + "font-size:11px;font-weight:600;cursor:not-allowed;"
            btnApply.addEventListener("click", () => {
                if (btnApply.disabled) return
                const picked = []
                modal.querySelectorAll('input[data-aes-picker]:checked').forEach(cb => {
                    const tr = cb.closest("tr")
                    if (tr && tr.dataset.aircraftId && tr.style.display !== "none") {
                        picked.push(tr.dataset.aircraftId)
                    }
                })
                _close({aircraftIds: picked, cancelled: false})
            })
            footer.appendChild(btnApply)
            modal.appendChild(footer)

            overlay.appendChild(modal)
            document.body.appendChild(overlay)
            _modalEl = overlay

            _onKey = (e) => { if (e.key === "Escape") _close({aircraftIds: [], cancelled: true}) }
            document.addEventListener("keydown", _onKey)

            // Async fleet load
            _renderEmptyBody(body, "Loading fleet…")

            const maxHaulNm = _maxHaulNm(preset)
            const ctx = {
                server: server,
                airlineCode: airlineCode,
                maxHaulNm: maxHaulNm,
                applyFilters: function () {
                    const hubOnly = fHubCb.checked && !!hub
                    const fitOnly = fFitCb.checked
                    const trs = body.querySelectorAll("tr[data-aircraft-id]")
                    let visible = 0
                    let pickedVisible = 0
                    trs.forEach(tr => {
                        let show = true
                        if (hubOnly && tr.dataset.location !== hub) show = false
                        if (fitOnly && tr.dataset.fitOk === "0")    show = false
                        if (!allowMultiHub && tr.dataset.location !== hub) show = false
                        tr.style.display = show ? "" : "none"
                        const cb = tr.querySelector('input[data-aes-picker]')
                        if (cb) cb.disabled = !show
                        if (show) visible++
                        if (show && cb && cb.checked) pickedVisible++
                    })
                    counter.textContent = pickedVisible + " picked · " + visible + " visible"
                    btnApply.disabled = pickedVisible === 0
                    btnApply.textContent = "Apply to " + pickedVisible + " aircraft"
                    if (!btnApply.disabled) {
                        btnApply.style.background  = "#1d4ed8"
                        btnApply.style.color       = "#eff6ff"
                        btnApply.style.borderColor = "#1e40af"
                        btnApply.style.cursor      = "pointer"
                    } else {
                        btnApply.style.background  = "#374151"
                        btnApply.style.color       = "#9ca3af"
                        btnApply.style.borderColor = "#374151"
                        btnApply.style.cursor      = "not-allowed"
                    }
                },
                recount: function () { ctx.applyFilters() }
            }

            fHubCb.addEventListener("change", ctx.applyFilters)
            fFitCb.addEventListener("change", ctx.applyFilters)
            fBulk.addEventListener("click", () => {
                body.querySelectorAll('input[data-aes-picker]').forEach(cb => {
                    const tr = cb.closest("tr")
                    if (tr && tr.style.display !== "none") cb.checked = true
                })
                ctx.applyFilters()
            })
            fNone.addEventListener("click", () => {
                body.querySelectorAll('input[data-aes-picker]').forEach(cb => { cb.checked = false })
                ctx.applyFilters()
            })

            // Load + render. Catches all to ensure modal still resolves on storage errors.
            (async () => {
                let fleet = null
                try {
                    if (typeof window.AesFleetRoster === "undefined") {
                        _renderEmptyBody(body, "AesFleetRoster not loaded — fleet unavailable.")
                        return
                    }
                    fleet = await window.AesFleetRoster.load(server, airlineCode)
                } catch (e) {
                    _renderEmptyBody(body, "Failed to load fleet: " + ((e && e.message) || e))
                    return
                }
                const aircraft = (fleet && fleet.aircraft) || []
                if (!aircraft.length) {
                    _renderEmptyBody(body, "No aircraft in fleet roster. Visit /app/fleets to populate it.")
                    return
                }

                body.textContent = ""
                const table = document.createElement("table")
                table.style.cssText = "width:100%;border-collapse:collapse;"
                const thead = document.createElement("thead")
                const trh = document.createElement("tr")
                for (const lbl of ["", "Reg", "Type", "Loc", "Range", "Fit", ""]) {
                    const th = document.createElement("th")
                    th.textContent = lbl
                    th.style.cssText = "padding:4px 6px;border-bottom:1px solid #374151;"
                        + "color:#9ca3af;font-size:10px;font-weight:600;text-align:left;"
                        + "font-family:monospace;text-transform:uppercase;letter-spacing:0.5px;"
                        + "position:sticky;top:0;background:#0f1623;z-index:1;"
                    trh.appendChild(th)
                }
                thead.appendChild(trh)
                table.appendChild(thead)
                const tbody = document.createElement("tbody")
                for (const a of aircraft) {
                    const {tr} = _buildRow(a, ctx)
                    tbody.appendChild(tr)
                    _enrichRow(tr, a, ctx)
                }
                table.appendChild(tbody)
                body.appendChild(table)
                ctx.applyFilters()
            })()
        })
    }

    window.AesAfpFleetPickerModal = {open: open}

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof window.AesAfpFleetPickerModal.open === "function",
                "[AES auto-8b smoke] open() exposed")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
