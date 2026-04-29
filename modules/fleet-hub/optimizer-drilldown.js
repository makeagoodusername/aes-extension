"use strict"

/**
 * Lane C — Fleet Optimizer drill-down modal (read-only Phase 1).
 *
 * Opens via the Fleet Optimizer tile's "Open drill-down" CTA. Displays
 * the full FleetUtilSummary as a filterable table:
 *
 *   filter ribbon (org / hub / region / type / classification)
 *   per-aircraft table (sortable cols)
 *   right-side detail pane for the focused tail
 *
 * Phase 1 is read-only — no Apply buttons. Phase 4 will add the action
 * drawer with rebalance proposals + two-gate apply.
 *
 * Public API:
 *   AesFleetHubOptimizerDrilldown.open({summary?})
 *   AesFleetHubOptimizerDrilldown.close()
 *   AesFleetHubOptimizerDrilldown.isOpen()
 *
 * If `summary` is omitted, the drill-down recomputes via
 * `AesStrategyFleetUtilization.compute(...)` over a fresh snapshot.
 */
;(function () {
    if (window.AesFleetHubOptimizerDrilldown) return

    let _modal = null
    let _state = {
        summary: null,
        proposals: null,    // Phase 3 — RebalanceProposal[] | null until first compute
        settings: null,     // Phase 4 — fleet-optimizer settings incl. apply gates
        applying: new Set(),// Phase 4 — proposalIds mid-apply
        toast: null,        // Phase 4 — most-recent apply outcome for footer hint
        filter: {org: null, hub: null, region: null, typeId: null, classification: null},
        sort: {col: "ratioGap", dir: -1},     // descending = biggest gap first
        focusedAircraftId: null
    }

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    async function _resolveSummary() {
        if (_state.summary) return _state.summary
        if (typeof window.AesStrategy === "undefined" || !window.AesStrategy.snapshot) return null
        if (typeof window.AesStrategyFleetUtilization === "undefined") return null
        let snapshot = null
        try { snapshot = await window.AesStrategy.snapshot({}) } catch (_) {}
        if (!snapshot) return null
        let settings = null
        if (window.AesStrategyFleetOptimizerSettings) {
            try { settings = await window.AesStrategyFleetOptimizerSettings.load() }
            catch (_) {}
        }
        _state.settings = settings
        const summary = window.AesStrategyFleetUtilization.compute({snapshot, settings})
        // Phase 3 — also compute rebalance proposals while we have the
        // snapshot in hand. Preview-only; cards render in detail pane when
        // no aircraft is focused.
        if (window.AesStrategy && typeof window.AesStrategy.proposeRebalanceMoves === "function") {
            try {
                _state.proposals = window.AesStrategy.proposeRebalanceMoves(
                    snapshot, summary, {fleetOptimizer: settings})
            } catch (_) { _state.proposals = [] }
        }
        return summary
    }

    function _filteredRows() {
        const s = _state.summary
        if (!s) return []
        const f = _state.filter
        return s.perAircraft.filter(r => {
            if (f.org && r.org !== f.org) return false
            if (f.hub && r.hub !== f.hub) return false
            if (f.region && r.regionId !== f.region) return false
            if (f.typeId && Number(r.typeId) !== Number(f.typeId)) return false
            if (f.classification && r.classification !== f.classification) return false
            return true
        }).slice().sort(_sortFn)
    }

    function _sortFn(a, b) {
        const col = _state.sort.col
        const dir = _state.sort.dir
        const va = a[col]
        const vb = b[col]
        if (va == null && vb == null) return 0
        if (va == null) return 1
        if (vb == null) return -1
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir
        return String(va).localeCompare(String(vb)) * dir
    }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-optimizer-drilldown"
        root.style.cssText =
            "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999985;" +
            "display:none;align-items:flex-start;justify-content:center;padding-top:6vh;"
        root.addEventListener("click", (e) => { if (e.target === root) close() })

        const box = document.createElement("div")
        box.style.cssText =
            "width:min(1200px,95vw);height:84vh;background:#0f172a;color:#e2e8f0;" +
            "border:1px solid rgba(148,163,184,0.25);border-radius:8px;display:flex;" +
            "flex-direction:column;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif;"
        root.appendChild(box)

        // Header
        const header = document.createElement("div")
        header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(148,163,184,0.18);"
        const title = document.createElement("div")
        title.id = "aes-opt-title"
        title.innerHTML = '<span style="font-weight:600;font-size:14px">Fleet Optimizer</span>' +
            ' <span id="aes-opt-mode" style="color:#94a3b8;font-size:11px;margin-left:8px">advisory</span>'
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px;"
        closeBtn.addEventListener("click", () => close())
        header.appendChild(title); header.appendChild(closeBtn)
        box.appendChild(header)

        // Body grid: filter | table | detail
        const body = document.createElement("div")
        body.style.cssText = "display:grid;grid-template-columns:200px 1fr 280px;flex:1;overflow:hidden;"
        body.innerHTML =
            '<div id="aes-opt-filter" style="border-right:1px solid rgba(148,163,184,0.18);overflow-y:auto;padding:12px;font-size:12px"></div>' +
            '<div id="aes-opt-table"  style="overflow:auto"></div>' +
            '<div id="aes-opt-detail" style="border-left:1px solid rgba(148,163,184,0.18);overflow-y:auto;padding:12px;font-size:12px"></div>'
        box.appendChild(body)

        // Footer
        const footer = document.createElement("div")
        footer.id = "aes-opt-footer"
        footer.style.cssText = "padding:8px 16px;border-top:1px solid rgba(148,163,184,0.18);font-size:11px;color:#94a3b8;"
        box.appendChild(footer)

        document.body.appendChild(root)
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && root.style.display !== "none") close()
        })
        _modal = root
        return root
    }

    function _renderFilter() {
        const host = document.getElementById("aes-opt-filter")
        if (!host || !_state.summary) return
        const s = _state.summary
        const f = _state.filter
        const html = []
        html.push('<div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Classification</div>')
        for (const cls of ["stress", "cold", "on-target", "unknown"]) {
            const count = s.perAircraft.filter(r => r.classification === cls).length
            const active = (f.classification === cls)
            html.push(
                '<div data-filter="classification" data-value="' + cls + '" style="' +
                'cursor:pointer;padding:4px 6px;border-radius:3px;margin-bottom:2px;' +
                (active ? 'background:rgba(59,130,246,0.18);' : '') +
                '">' + cls + ' <span style="float:right;color:#64748b">' + count + '</span></div>'
            )
        }
        if (s.rollups.byHub.length) {
            html.push('<div style="margin-top:12px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Hub</div>')
            for (const h of s.rollups.byHub.slice(0, 12)) {
                const active = (f.hub === h.iata)
                html.push(
                    '<div data-filter="hub" data-value="' + _esc(h.iata) + '" style="' +
                    'cursor:pointer;padding:4px 6px;border-radius:3px;margin-bottom:2px;' +
                    (active ? 'background:rgba(59,130,246,0.18);' : '') +
                    '">' + _esc(h.iata) + ' <span style="float:right;color:#64748b">' + h.count + '</span></div>'
                )
            }
        }
        if (s.rollups.byRegion.length) {
            html.push('<div style="margin-top:12px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Region</div>')
            for (const r of s.rollups.byRegion.slice(0, 12)) {
                const active = (f.region === r.regionId)
                html.push(
                    '<div data-filter="region" data-value="' + _esc(r.regionId) + '" style="' +
                    'cursor:pointer;padding:4px 6px;border-radius:3px;margin-bottom:2px;' +
                    (active ? 'background:rgba(59,130,246,0.18);' : '') +
                    '">' + _esc(r.regionId || "(none)") + ' <span style="float:right;color:#64748b">' + r.count + '</span></div>'
                )
            }
        }
        // Reset button
        html.push('<div style="margin-top:16px"><button data-reset="1" style="background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px;width:100%">Clear filters</button></div>')

        host.innerHTML = html.join("")
        host.querySelectorAll("[data-filter]").forEach(el => {
            el.addEventListener("click", () => {
                const k = el.dataset.filter
                const v = el.dataset.value
                _state.filter[k] = (_state.filter[k] === v) ? null : v
                _renderAll()
            })
        })
        const reset = host.querySelector("[data-reset]")
        if (reset) reset.addEventListener("click", () => {
            _state.filter = {org: null, hub: null, region: null, typeId: null, classification: null}
            _renderAll()
        })
    }

    function _renderTable() {
        const host = document.getElementById("aes-opt-table")
        if (!host) return
        const rows = _filteredRows()
        const cols = [
            {key: "registration",     label: "Reg",       w: 80,  fmt: v => _esc(v || "—")},
            {key: "equipment",        label: "Type",      w: 80,  fmt: v => _esc(v || "—")},
            {key: "hub",              label: "Hub",       w: 50,  fmt: v => _esc(v || "—")},
            {key: "currentRatio",     label: "Ratio",     w: 60,  fmt: v => v == null ? "—" : v.toFixed(0) + "%"},
            {key: "ratioForecast14d", label: "14d",       w: 60,  fmt: v => v == null ? "—" : v.toFixed(1) + "%"},
            {key: "targetEquilibriumPct", label: "Target", w: 60, fmt: v => v == null ? "—" : v.toFixed(0) + "%"},
            {key: "ratioGap",         label: "Gap",       w: 60,  fmt: v => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "pp"},
            {key: "weeklyHoursPlanned", label: "Hr/wk",   w: 55,  fmt: v => v == null ? "—" : v.toFixed(0)},
            {key: "headroomHours",    label: "Slack",     w: 55,  fmt: v => v == null ? "—" : v.toFixed(0) + "h"},
            {key: "utilizationPct",   label: "Util%",     w: 55,  fmt: v => v == null ? "—" : v.toFixed(0) + "%"},
            {key: "classification",   label: "Class",     w: 80,  fmt: v => _esc(v)}
        ]
        const html = []
        html.push('<table style="width:100%;border-collapse:collapse;font-size:12px">')
        html.push('<thead><tr style="background:rgba(148,163,184,0.10);position:sticky;top:0">')
        for (const c of cols) {
            const arrow = (_state.sort.col === c.key) ? (_state.sort.dir < 0 ? " ↓" : " ↑") : ""
            html.push(
                '<th data-sort="' + c.key + '" style="text-align:left;padding:6px 8px;cursor:pointer;font-weight:500;color:#94a3b8;border-bottom:1px solid rgba(148,163,184,0.18);width:' + c.w + 'px">' +
                _esc(c.label) + arrow + '</th>'
            )
        }
        html.push('</tr></thead><tbody>')
        for (const r of rows) {
            const focused = (_state.focusedAircraftId === String(r.aircraftId))
            const tint = r.classification === "stress" ? "rgba(239,68,68,0.10)"
                       : r.classification === "cold"   ? "rgba(59,130,246,0.10)"
                       : r.classification === "unknown"? "rgba(148,163,184,0.05)"
                       : "transparent"
            html.push('<tr data-aircraft="' + _esc(r.aircraftId) + '" style="cursor:pointer;background:' +
                     (focused ? "rgba(59,130,246,0.18)" : tint) + '">')
            for (const c of cols) {
                html.push('<td style="padding:5px 8px;border-bottom:1px solid rgba(148,163,184,0.08)">' +
                          c.fmt(r[c.key]) + '</td>')
            }
            html.push('</tr>')
        }
        html.push('</tbody></table>')
        if (!rows.length) {
            html.push('<div style="padding:24px;text-align:center;color:#64748b;font-size:12px">No tails match the filters.</div>')
        }
        host.innerHTML = html.join("")
        host.querySelectorAll("[data-sort]").forEach(el => {
            el.addEventListener("click", () => {
                const k = el.dataset.sort
                if (_state.sort.col === k) _state.sort.dir *= -1
                else { _state.sort.col = k; _state.sort.dir = -1 }
                _renderTable()
            })
        })
        host.querySelectorAll("[data-aircraft]").forEach(el => {
            el.addEventListener("click", () => {
                _state.focusedAircraftId = el.dataset.aircraft
                _renderTable()
                _renderDetail()
                if (window.CentralHubBus) {
                    window.CentralHubBus.emit("focus-aircraft", {aircraftId: _state.focusedAircraftId})
                }
            })
        })
    }

    function _renderDetail() {
        const host = document.getElementById("aes-opt-detail")
        if (!host) return
        const aid = _state.focusedAircraftId
        const tail = aid && _state.summary
            ? _state.summary.perAircraft.find(r => String(r.aircraftId) === String(aid))
            : null
        if (!tail) {
            host.innerHTML = ""
            const empty = document.createElement("div")
            empty.style.cssText = "color:#64748b;font-size:12px;text-align:center;padding:16px"
            empty.textContent = "Select a tail to inspect"
            host.appendChild(empty)
            // Phase 3 — surface preview-only rebalance proposals when no
            // aircraft is focused. Each proposal renders as a card with
            // [gap]/[hub]/[fix]/[predict] rationale lines.
            const proposals = Array.isArray(_state.proposals) ? _state.proposals : null
            if (proposals && proposals.length) {
                const head = document.createElement("div")
                head.style.cssText = "margin-top:6px;padding:6px 8px;font-size:10px;color:#94a3b8;"
                    + "text-transform:uppercase;letter-spacing:.04em;border-top:1px solid rgba(148,163,184,0.18);"
                head.textContent = "Suggested rebalances · preview-only"
                host.appendChild(head)
                for (const p of proposals) {
                    host.appendChild(_renderProposalCard(p))
                }
            } else if (proposals) {
                const empty2 = document.createElement("div")
                empty2.style.cssText = "margin-top:8px;padding:8px;font-size:11px;color:#64748b;"
                    + "font-style:italic;border-top:1px solid rgba(148,163,184,0.18);"
                empty2.textContent = "No rebalance suggestions — every tail is on-target."
                host.appendChild(empty2)
            }
            return
        }
        const html = []
        html.push('<div style="font-size:14px;font-weight:600;margin-bottom:4px">' + _esc(tail.registration || tail.aircraftId) + '</div>')
        html.push('<div style="color:#94a3b8;font-size:11px;margin-bottom:12px">' + _esc(tail.equipment || "") + ' · ' + _esc(tail.hub || "—") + '</div>')
        const fields = [
            ["current ratio",       tail.currentRatio,        v => v == null ? "—" : v.toFixed(1) + "%"],
            ["forecast 14d",        tail.ratioForecast14d,    v => v == null ? "—" : v.toFixed(1) + "%"],
            ["target ratio",        tail.targetEquilibriumPct, v => v == null ? "—" : v.toFixed(1) + "%"],
            ["gap",                 tail.ratioGap,            v => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "pp"],
            ["weekly hours planned", tail.weeklyHoursPlanned, v => v == null ? "—" : v.toFixed(1) + "h"],
            ["target weekly hours", tail.targetWeeklyHours,   v => v == null ? "—" : v.toFixed(1) + "h"],
            ["max weekly (wear)",   tail.maxWeeklyBlockHours, v => v == null ? "—" : v.toFixed(1) + "h"],
            ["headroom",            tail.headroomHours,       v => v == null ? "—" : v.toFixed(1) + "h"],
            ["utilization",         tail.utilizationPct,      v => v == null ? "—" : v.toFixed(0) + "%"],
            ["classification",      tail.classification,      v => _esc(v)]
        ]
        for (const [label, val, fmt] of fields) {
            html.push('<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid rgba(148,163,184,0.08)">')
            html.push('<span style="color:#94a3b8">' + label + '</span>')
            html.push('<span style="font-family:ui-monospace,monospace">' + fmt(val) + '</span>')
            html.push('</div>')
        }
        if (Array.isArray(tail.rationale) && tail.rationale.length) {
            html.push('<div style="margin-top:12px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Rationale</div>')
            for (const line of tail.rationale) {
                html.push('<div style="font-size:11px;color:#cbd5e1;padding:2px 0">' + _esc(line) + '</div>')
            }
        }
        host.innerHTML = html.join("")
    }

    function _renderProposalCard(p) {
        const card = document.createElement("div")
        card.style.cssText = "margin:8px 0;padding:8px;border-radius:4px;"
            + "background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.25);"
        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"
        const kindLabel = document.createElement("span")
        kindLabel.style.cssText = "font-size:10px;color:#dbeafe;font-weight:600;text-transform:uppercase;letter-spacing:.04em;"
        kindLabel.textContent = (p.kind || "").replace(/-/g, " ")
        const ratio = document.createElement("span")
        const rd = (p.predicted && typeof p.predicted.ratioDeltaPp === "number")
            ? p.predicted.ratioDeltaPp : null
        ratio.style.cssText = "font-size:11px;font-family:ui-monospace,monospace;"
            + "color:" + (rd != null && rd >= 0 ? "#86efac" : "#fbbf24") + ";"
        ratio.textContent = (rd == null) ? "—"
            : (rd >= 0 ? "+" : "") + rd.toFixed(2) + "pp · 14d"
        head.appendChild(kindLabel); head.appendChild(ratio)
        card.appendChild(head)
        const lines = Array.isArray(p.rationale) ? p.rationale : []
        for (const line of lines) {
            const row = document.createElement("div")
            row.style.cssText = "font-size:11px;color:#cbd5e1;padding:1px 0;font-family:ui-monospace,monospace;"
            row.textContent = line
            card.appendChild(row)
        }
        card.appendChild(_renderProposalAction(p))
        return card
    }

    function _renderProposalAction(p) {
        const ag = (_state.settings && _state.settings.apply) || {}
        const enabled  = ag.enabled === true
        const dryRun   = ag.dryRunOnly !== false
        const advisory = (p.kind === "service-profile-promote")
        const inFlight = _state.applying.has(p.id)

        const row = document.createElement("div")
        row.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
            + "margin-top:6px;gap:8px;"

        const status = document.createElement("span")
        status.style.cssText = "font-size:10px;color:#64748b;font-style:italic;flex:1;"
        if (advisory) status.textContent = "Advisory — wire profile-id mapping in a future slice."
        else if (!enabled) status.textContent = "Apply gate off — flip apply.enabled in settings."
        else if (dryRun)   status.textContent = "Dry-run preview will write to the apply log."
        else               status.textContent = "Live apply mutates the wave plan for " + (p.hubIata || "this hub") + "."

        const btn = document.createElement("button")
        btn.type = "button"
        const liveLabel = dryRun ? "Preview · DRY-RUN" : "Apply"
        btn.textContent = inFlight ? "…" : (advisory ? "Open AS profiles" : liveLabel)
        btn.disabled = inFlight || (!enabled && !advisory)
        const tint = advisory ? "#a78bfa"
                   : !enabled ? "#475569"
                   : dryRun   ? "#fbbf24"
                              : "#86efac"
        btn.style.cssText = "background:rgba(15,23,42,0.6);border:1px solid " + tint + ";"
            + "color:" + tint + ";cursor:" + (btn.disabled ? "not-allowed" : "pointer") + ";"
            + "padding:3px 10px;font-size:10px;font-weight:600;border-radius:3px;"
            + "letter-spacing:.04em;text-transform:uppercase;"

        btn.addEventListener("click", () => _onApplyClick(p, btn))

        row.appendChild(status)
        row.appendChild(btn)
        return row
    }

    async function _onApplyClick(p, btn) {
        if (p.kind === "service-profile-promote") {
            // Open the AS profiles page in a new tab. The user picks the
            // upgrade profile manually; Phase 5 wires this to an applier
            // once the profile-id mapping lands.
            try { window.open("/app/enterprise/serviceProfiles", "_blank") } catch (_) {}
            return
        }
        if (typeof window.AesStrategyRebalanceApplier === "undefined") {
            _state.toast = {ok: false, message: "Rebalance applier not loaded on this page."}
            _renderFooter()
            return
        }
        const ag = (_state.settings && _state.settings.apply) || {}
        if (ag.enabled !== true) return
        // Live apply (not dry-run) gets a confirm prompt.
        if (ag.dryRunOnly !== true) {
            const summary = (Array.isArray(p.rationale) ? p.rationale : []).join("\n")
            const msg = "Apply rebalance: " + (p.kind || "") + "\n\n" + summary
                + "\n\nThis writes to your wave plan for " + (p.hubIata || "this hub") + ". Continue?"
            if (!window.confirm(msg)) return
        }
        _state.applying.add(p.id)
        if (btn) { btn.disabled = true; btn.textContent = "…" }
        let result = null
        try {
            result = await window.AesStrategyRebalanceApplier.apply(p, {source: "drilldown"})
        } catch (e) {
            result = {status: "failed", error: (e && e.message) || String(e)}
        }
        _state.applying.delete(p.id)
        const ok = result && (result.status === "applied" || result.status === "dry-run")
        _state.toast = {
            ok: ok,
            status: result && result.status,
            message: _toastMessageFor(result, p)
        }
        // Re-resolve summary so the proposals list reflects the new wave
        // shape; preserves filters/sort/focused state.
        if (result && result.status === "applied") {
            _state.summary = null   // force recompute
            try { _state.summary = await _resolveSummary() } catch (_) {}
        }
        _renderAll()
    }

    function _toastMessageFor(result, p) {
        if (!result) return "Apply failed: no result returned."
        if (result.status === "applied") {
            return "Applied " + (result.kind || p.kind) + " · "
                + (result.hubIata || p.hubIata || "—")
                + (result.presetId ? " · preset " + result.presetId.slice(0, 12) : "")
        }
        if (result.status === "dry-run") {
            return "Dry-run · " + (result.kind || p.kind) + " · would touch "
                + (result.hubIata || p.hubIata || "—")
        }
        if (result.status === "skipped") return "Skipped: " + (result.reason || "unknown")
        if (result.status === "advisory") return "Advisory: " + (result.reason || "not yet wireable")
        return "Failed: " + (result.error || "unknown")
    }

    function _renderFooter() {
        const host = document.getElementById("aes-opt-footer")
        if (!host || !_state.summary) return
        const r = _state.summary.rollups
        const d = _state.summary.diagnostics
        const f = _filteredRows().length
        const t = _state.summary.perAircraft.length
        const gap = (r.ratioGapHeadlinePct == null) ? "—"
            : (r.ratioGapHeadlinePct >= 0 ? "+" : "") + r.ratioGapHeadlinePct.toFixed(1) + "pp"
        const ag = (_state.settings && _state.settings.apply) || {}
        const mode = (ag.enabled === true)
            ? (ag.dryRunOnly === false ? "live · Phase 4" : "live · DRY-RUN · Phase 4")
            : "advisory · gates off"
        const toast = _state.toast
            ? ' · <span style="color:' + (toast.ok ? "#86efac" : "#f87171") + '">'
              + _esc(toast.message) + '</span>'
            : ''
        host.innerHTML = 'Showing ' + f + ' of ' + t + ' tails · fleet ratio gap ' + gap +
            ' · regression ' + d.regressionAircraft + ' · fallback ' + d.fallbackAircraft
            + (d.missingFit ? ' · missing fit ' + d.missingFit : '')
            + ' · ' + mode + toast
        const modeBadge = document.getElementById("aes-opt-mode")
        if (modeBadge) modeBadge.textContent = mode
    }

    function _renderAll() {
        _renderFilter()
        _renderTable()
        _renderDetail()
        _renderFooter()
    }

    async function open(opts) {
        _ensureModal()
        _state.summary = (opts && opts.summary) || await _resolveSummary()
        _state.focusedAircraftId = null
        _modal.style.display = "flex"
        _renderAll()
    }

    function close() {
        if (_modal) _modal.style.display = "none"
    }

    function isOpen() { return !!(_modal && _modal.style.display !== "none") }

    window.AesFleetHubOptimizerDrilldown = {open, close, isOpen}
})()
