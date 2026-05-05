"use strict"

/**
 * Lane B — Fleet Command panel (federated aircraft modal).
 *
 * Phase 2 shipped the read-only three-pane modal (filters / group table /
 * detail). Phase 4 adds:
 *   - multi-select checkbox per tail row
 *   - center-pane Map toggle (renders region-map-view over the same tails)
 *   - right-pane action drawer when ≥2 tails are selected: preset pick →
 *     preview → bulk apply via fleet-command-bulk-apply
 *
 *   ┌──────── Filters ─────────┐  Table | Map · Pivot: org / hub / type / region
 *   │ view + pivot toggles     │
 *   │ search input             │
 *   │ classification chips     │
 *   │ org / region multiselect │
 *   ├──── Group table OR map ──┤
 *   │ group (count) ▾          │  Click group → expand rows
 *   │   ☐ tail rows            │  Click tail → detail; checkbox → multi-select
 *   ├──── Detail / drawer ─────┤
 *   │ One tail: identity rows  │
 *   │ Multi: bulk apply drawer │
 *   └──────────────────────────┘
 *
 * Per-account filter persistence:
 *   aesCanopy:fleetCommand:filters:acct:<id>
 *     = {pivot, search, classFilter, viewMode, bulkPresetId}
 *
 * Multi-select is ephemeral (in-memory only — survives a re-render but
 * not a modal close). Bulk-apply runs go through AesFleetCommandBulkApply
 * which writes the cross-account audit ring at aesCanopy:bulkApply:log.
 */
;(function () {
    if (window.AesFleetCommandPanel) return

    const FILTER_KEY_PREFIX = "aesCanopy:fleetCommand:filters"

    let _modal = null
    let _state = {
        view: null,
        pivot: "byOrg",
        viewMode: "table",  // "table" | "map"
        search: "",
        classFilter: null, // null|"stress"|"cold"|"on-target"|"unknown"
        selectedTailIdx: null,
        selectedTailIds: new Set(),  // aircraftId set — survives sort changes
        expandedGroups: new Set(),
        bulkPresetId: null,
        bulkPresets: null,           // SchedulePresets cache
        bulkPreview: null,           // {presetId, result}
        bulkInFlight: false,
        bulkLastResult: null,
        bulkAuditEntries: null
    }

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    function _filterStorageKey() {
        if (!window.AesAccountKey) return FILTER_KEY_PREFIX + ":filters"
        return window.AesAccountKey.acctKey(FILTER_KEY_PREFIX, "filters")
    }

    async function _loadFilters() {
        if (typeof chrome === "undefined") return null
        const key = _filterStorageKey()
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    async function _saveFilters() {
        if (typeof chrome === "undefined") return
        const key = _filterStorageKey()
        await chrome.storage.local.set({[key]: {
            pivot:        _state.pivot,
            viewMode:     _state.viewMode,
            search:       _state.search,
            classFilter:  _state.classFilter,
            bulkPresetId: _state.bulkPresetId
        }})
    }

    async function _refresh() {
        if (!window.AesFleetCommand) {
            _state.view = null
            _render()
            return
        }
        _state.view = await window.AesFleetCommand.build({})
        _render()
    }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-fleet-command"
        root.style.cssText =
            "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999986;" +
            "display:none;align-items:flex-start;justify-content:center;padding:6vh 4vw;"
        root.addEventListener("click", (e) => { if (e.target === root) close() })
        const box = document.createElement("div")
        box.style.cssText =
            "width:min(1280px,98vw);max-height:88vh;background:#0f172a;color:#e2e8f0;" +
            "border:1px solid rgba(148,163,184,0.25);border-radius:8px;display:flex;" +
            "flex-direction:column;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif;"
        root.appendChild(box)

        const header = document.createElement("div")
        header.style.cssText =
            "display:flex;justify-content:space-between;align-items:center;padding:10px 16px;" +
            "border-bottom:1px solid rgba(148,163,184,0.18);"
        header.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px">' +
            '<span style="font-weight:600;font-size:14px">Fleet Command</span>' +
            '<span id="aes-fc-headline" style="font-size:11px;color:#94a3b8"></span>' +
            '</div>'
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px"
        closeBtn.addEventListener("click", () => close())
        header.appendChild(closeBtn)
        box.appendChild(header)

        const body = document.createElement("div")
        body.style.cssText = "display:grid;grid-template-columns:240px 1fr 320px;flex:1;overflow:hidden;"
        body.innerHTML =
            '<div id="aes-fc-filters" style="border-right:1px solid rgba(148,163,184,0.18);overflow-y:auto;padding:12px"></div>' +
            '<div id="aes-fc-table"   style="overflow-y:auto;padding:12px;border-right:1px solid rgba(148,163,184,0.18)"></div>' +
            '<div id="aes-fc-detail"  style="overflow-y:auto;padding:12px"></div>'
        box.appendChild(body)

        document.body.appendChild(root)
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && root.style.display !== "none") close()
        })
        _modal = root
        return root
    }

    function _render() {
        _renderHeader()
        _renderFilters()
        _renderTable()
        if (_state.selectedTailIds.size >= 2) _renderActionDrawer()
        else                                  _renderDetail()
    }

    function _renderHeader() {
        const el = document.getElementById("aes-fc-headline")
        if (!el) return
        if (!_state.view || !_state.view.tails.length) {
            el.textContent = "no data"
            return
        }
        const t = _state.view.totals
        el.textContent = "Σ " + t.tails + " · " + t.accounts + " account" + (t.accounts === 1 ? "" : "s")
            + " · " + t.orgs + " org" + (t.orgs === 1 ? "" : "s")
            + " · " + t.regions + " region" + (t.regions === 1 ? "" : "s")
            + " · " + t.withRatio + "/" + t.tails + " with maint"
            + " · " + t.withSchedule + "/" + t.tails + " with schedule"
    }

    function _renderFilters() {
        const host = document.getElementById("aes-fc-filters")
        if (!host) return
        host.innerHTML = ""

        host.appendChild(_filterHeading("View"))
        host.appendChild(_viewModeControl())

        host.appendChild(_filterHeading("Pivot"))
        host.appendChild(_pivotControl())

        host.appendChild(_filterHeading("Search"))
        const search = document.createElement("input")
        search.type = "text"
        search.placeholder = "registration / hub / type"
        search.value = _state.search
        search.style.cssText = "width:100%;background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);" +
            "border-radius:3px;padding:5px 8px;font-size:11px;"
        search.addEventListener("input", () => {
            _state.search = (search.value || "").toLowerCase()
            _renderTable()
            _saveFilters()
        })
        host.appendChild(search)

        host.appendChild(_filterHeading("Classification"))
        const chips = document.createElement("div")
        chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;"
        const CLASSES = [
            ["all",       "All",       null],
            ["stress",    "Stress",    "stress"],
            ["cold",      "Cold",      "cold"],
            ["on-target", "On-target", "on-target"],
            ["unknown",   "Unknown",   "unknown"]
        ]
        for (const [key, label, val] of CLASSES) {
            const chip = document.createElement("button")
            chip.type = "button"
            chip.textContent = label
            const active = (_state.classFilter === val)
            chip.style.cssText = "padding:2px 8px;border-radius:10px;cursor:pointer;font-size:10px;"
                + "border:1px solid " + (active ? "#3b82f6" : "rgba(148,163,184,0.35)") + ";"
                + "background:" + (active ? "rgba(59,130,246,0.15)" : "transparent") + ";"
                + "color:" + (active ? "#dbeafe" : "#94a3b8") + ";"
            chip.addEventListener("click", () => {
                _state.classFilter = val
                _state.selectedTailIdx = null
                _saveFilters()
                _render()
            })
            chips.appendChild(chip)
        }
        host.appendChild(chips)

        host.appendChild(_filterHeading("Quick stats"))
        if (_state.view) {
            const t = _state.view.totals
            const stats = [
                ["Hubs",    t.hubs],
                ["Types",   t.types],
                ["Tails",   t.tails],
                ["Maint",   t.withRatio + "/" + t.tails]
            ]
            for (const [k, v] of stats) {
                const row = document.createElement("div")
                row.style.cssText = "display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;padding:2px 0;"
                row.innerHTML = '<span>' + _esc(k) + '</span><span style="color:#cbd5e1;font-family:ui-monospace,monospace">' + _esc(v) + '</span>'
                host.appendChild(row)
            }
        }
    }

    function _filterHeading(text) {
        const el = document.createElement("div")
        el.style.cssText = "font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px;"
        el.textContent = text
        return el
    }

    function _pivotControl() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;"
        const PIVOTS = [
            ["byOrg",    "Org"],
            ["byHub",    "Hub"],
            ["byType",   "Type"],
            ["byRegion", "Region"]
        ]
        for (const [key, label] of PIVOTS) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = label
            const active = (_state.pivot === key)
            const disabled = (_state.viewMode !== "table")
            btn.disabled = disabled
            btn.style.cssText = "padding:2px 8px;border-radius:3px;cursor:" + (disabled ? "not-allowed" : "pointer") + ";font-size:10px;"
                + "border:1px solid " + (active ? "#3b82f6" : "rgba(148,163,184,0.35)") + ";"
                + "background:" + (active ? "rgba(59,130,246,0.12)" : "transparent") + ";"
                + "color:" + (active ? "#cbd5e1" : (disabled ? "#475569" : "#94a3b8")) + ";"
                + "opacity:" + (disabled ? "0.55" : "1") + ";"
            btn.title = disabled ? "Pivot only applies to Table view." : "Group rows by " + label.toLowerCase()
            btn.addEventListener("click", () => {
                _state.pivot = key
                _state.expandedGroups = new Set()
                _saveFilters()
                _render()
            })
            wrap.appendChild(btn)
        }
        return wrap
    }

    function _viewModeControl() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;"
        const mapAvail = !!(window.AesRegionMapView && window.AesRegionMapView.isAvailable && window.AesRegionMapView.isAvailable())
        const VIEWS = [
            ["table", "Table", true],
            ["map",   "Map",   mapAvail]
        ]
        for (const [key, label, enabled] of VIEWS) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = label
            const active = (_state.viewMode === key)
            btn.disabled = !enabled
            btn.style.cssText = "padding:2px 10px;border-radius:3px;cursor:" + (enabled ? "pointer" : "not-allowed") + ";font-size:10px;"
                + "border:1px solid " + (active ? "#3b82f6" : "rgba(148,163,184,0.35)") + ";"
                + "background:" + (active ? "rgba(59,130,246,0.12)" : "transparent") + ";"
                + "color:" + (active ? "#cbd5e1" : (enabled ? "#94a3b8" : "#475569")) + ";"
                + "opacity:" + (enabled ? "1" : "0.55") + ";"
            btn.title = enabled
                ? (key === "map" ? "Plot tails on a region-colored world map." : "Pivot-grouped table view.")
                : "Map requires WorldViewAirportCoords (load /app/com/* once)."
            btn.addEventListener("click", () => {
                if (!enabled) return
                _state.viewMode = key
                _saveFilters()
                _render()
            })
            wrap.appendChild(btn)
        }
        return wrap
    }

    function _renderTable() {
        const host = document.getElementById("aes-fc-table")
        if (!host) return
        host.innerHTML = ""
        if (!_state.view) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px;font-style:italic">' +
                'AesFleetCommand aggregator not loaded on this page.</div>'
            return
        }
        if (!_state.view.tails.length) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px;font-style:italic">' +
                'No tails federated yet — visit each airline\'s /app/fleets page first.</div>'
            return
        }

        if (_state.viewMode === "map") {
            _renderMapInto(host)
            return
        }

        host.appendChild(_selectionBar())

        const groupMap = _state.view[_state.pivot] || {}
        const groups = Object.values(groupMap).sort((a, b) => b.count - a.count)
        const filteredTails = _filteredTailIndexes()

        for (const g of groups) {
            const visibleIdx = g.tails.filter(i => filteredTails.has(i))
            if (!visibleIdx.length) continue

            const groupKey = _groupKey(g)
            const expanded = _state.expandedGroups.has(groupKey)
            const groupSelectedCount = visibleIdx.reduce((acc, idx) => {
                const t = _state.view.tails[idx]
                return acc + (t && _state.selectedTailIds.has(String(t.aircraftId)) ? 1 : 0)
            }, 0)

            const head = document.createElement("div")
            head.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;padding:6px 8px;" +
                "background:rgba(148,163,184,0.06);border-radius:3px;margin-bottom:4px;font-size:12px;font-weight:600;"

            const groupCheck = document.createElement("input")
            groupCheck.type = "checkbox"
            groupCheck.style.cssText = "margin:0;cursor:pointer;flex:0 0 auto;"
            groupCheck.title = "Select all visible tails in this group"
            groupCheck.checked = (groupSelectedCount === visibleIdx.length && visibleIdx.length > 0)
            groupCheck.indeterminate = (groupSelectedCount > 0 && groupSelectedCount < visibleIdx.length)
            groupCheck.addEventListener("click", (e) => {
                e.stopPropagation()
                const targetState = !groupCheck.checked
                for (const idx of visibleIdx) {
                    const t = _state.view.tails[idx]
                    if (!t) continue
                    if (targetState) _state.selectedTailIds.add(String(t.aircraftId))
                    else             _state.selectedTailIds.delete(String(t.aircraftId))
                }
                _invalidateBulkPreview()
                _render()
            })
            head.appendChild(groupCheck)

            const headTxt = document.createElement("span")
            headTxt.style.cssText = "flex:1 1 auto;"
            headTxt.innerHTML =
                (expanded ? '▾ ' : '▸ ') + _esc(_groupLabel(g))
            head.appendChild(headTxt)

            const headCount = document.createElement("span")
            headCount.style.cssText = "color:#94a3b8;font-weight:400;"
            headCount.textContent = visibleIdx.length
                + (visibleIdx.length === g.count ? "" : " / " + g.count)
                + " tails"
                + (groupSelectedCount ? " · " + groupSelectedCount + " sel" : "")
            head.appendChild(headCount)

            head.addEventListener("click", () => {
                if (expanded) _state.expandedGroups.delete(groupKey)
                else          _state.expandedGroups.add(groupKey)
                _renderTable()
            })
            host.appendChild(head)

            if (expanded) {
                const rows = document.createElement("div")
                rows.style.cssText = "margin:4px 0 8px 12px;display:grid;grid-template-columns:22px 90px 1fr 60px 60px 60px 70px;gap:6px;font-size:11px;color:#cbd5e1;"
                const hdr = ["", "Reg", "Type", "Hub", "Ratio", "Hr/wk", "Class"]
                for (const h of hdr) {
                    const c = document.createElement("div")
                    c.style.cssText = "color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-size:9px;"
                    c.textContent = h
                    rows.appendChild(c)
                }
                for (const idx of visibleIdx) {
                    const t = _state.view.tails[idx]
                    if (!t) continue
                    const aircraftId = String(t.aircraftId)
                    const isMultiSelected = _state.selectedTailIds.has(aircraftId)
                    const isFocused = (idx === _state.selectedTailIdx)
                    const rowBg = isFocused
                        ? "rgba(59,130,246,0.18)"
                        : (isMultiSelected ? "rgba(217,70,239,0.10)" : "transparent")

                    const checkCell = document.createElement("div")
                    checkCell.style.cssText = "padding:3px 0;display:flex;align-items:center;justify-content:center;background:" + rowBg + ";"
                    const cb = document.createElement("input")
                    cb.type = "checkbox"
                    cb.checked = isMultiSelected
                    cb.style.cssText = "margin:0;cursor:pointer;"
                    cb.addEventListener("click", (e) => {
                        e.stopPropagation()
                        if (cb.checked) _state.selectedTailIds.add(aircraftId)
                        else            _state.selectedTailIds.delete(aircraftId)
                        _invalidateBulkPreview()
                        _render()
                    })
                    checkCell.appendChild(cb)
                    rows.appendChild(checkCell)

                    const c = (txt, color) => {
                        const span = document.createElement("div")
                        span.textContent = txt == null ? "—" : String(txt)
                        span.style.cssText = "padding:3px 4px;border-radius:2px;font-family:ui-monospace,monospace;cursor:pointer;"
                            + "background:" + rowBg + ";"
                            + (color ? ("color:" + color + ";") : "")
                        span.addEventListener("click", () => {
                            _state.selectedTailIdx = idx
                            _renderTable()
                            _renderDetail()
                        })
                        return span
                    }
                    rows.appendChild(c(t.registration))
                    rows.appendChild(c(t.equipment))
                    rows.appendChild(c(t.hub))
                    rows.appendChild(c(t.maintRatio == null ? null : t.maintRatio.toFixed(0) + "%",
                        _ratioColor(t.maintRatio)))
                    rows.appendChild(c(t.weeklyBlockHours == null ? null : t.weeklyBlockHours.toFixed(1) + "h"))
                    rows.appendChild(c(t.classification, _classColor(t.classification)))
                }
                host.appendChild(rows)
            }
        }
    }

    function _selectionBar() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;"
            + "padding:6px 8px;margin-bottom:6px;border:1px solid rgba(148,163,184,0.18);"
            + "border-radius:3px;background:rgba(15,23,42,0.5);font-size:11px;color:#cbd5e1;"
        const count = _state.selectedTailIds.size
        const left = document.createElement("span")
        left.style.cssText = "flex:1 1 auto;"
        if (count === 0) {
            left.style.color = "#64748b"
            left.textContent = "Tip: tick rows for bulk apply (preset → many tails)."
        } else {
            left.innerHTML = '<span style="color:#dbeafe;font-weight:600">'
                + count + ' tail' + (count === 1 ? '' : 's') + '</span> selected'
                + (count === 1 ? ' — pick at least 2 to enable bulk apply' : '')
        }
        wrap.appendChild(left)

        if (count > 0) {
            const clear = document.createElement("button")
            clear.type = "button"
            clear.textContent = "Clear"
            clear.style.cssText = "background:transparent;color:#94a3b8;border:1px solid rgba(148,163,184,0.35);"
                + "border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer;"
            clear.addEventListener("click", () => {
                _state.selectedTailIds = new Set()
                _invalidateBulkPreview()
                _render()
            })
            wrap.appendChild(clear)
        }
        return wrap
    }

    function _renderMapInto(host) {
        if (!window.AesRegionMapView || !window.AesRegionMapView.isAvailable()) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px;font-style:italic">' +
                'Map view not available — WorldViewAirportCoords missing.</div>'
            return
        }

        host.appendChild(_selectionBar())

        const tails = _state.view.tails
        const filtered = _filteredTailIndexes()
        const visible = []
        filtered.forEach(i => { if (tails[i]) visible.push(tails[i]) })

        const regions = _resolveRegionsBlock()
        const mapHost = document.createElement("div")
        mapHost.style.cssText = "min-height:380px;border:1px solid rgba(148,163,184,0.18);"
            + "border-radius:3px;background:rgba(15,23,42,0.4);"
        host.appendChild(mapHost)

        window.AesRegionMapView.render(mapHost, {
            tails: visible,
            regions: regions,
            selectedAircraftIds: _state.selectedTailIds,
            onHubClick: (hub, group) => {
                // Toggle every tail at this hub into the selection.
                const allSelected = group.tails.every(t =>
                    _state.selectedTailIds.has(String(t.aircraftId)))
                for (const t of group.tails) {
                    const id = String(t.aircraftId)
                    if (allSelected) _state.selectedTailIds.delete(id)
                    else             _state.selectedTailIds.add(id)
                }
                _invalidateBulkPreview()
                _render()
            }
        })
    }

    function _resolveRegionsBlock() {
        const block = (_state.view && _state.view.regionsBlock) || null
        if (block && block.regions) return block.regions
        // Fall back: derive {regionId → {name}} from tails themselves.
        const out = {}
        for (const t of (_state.view && _state.view.tails) || []) {
            if (t && t.regionId && !out[t.regionId]) {
                out[t.regionId] = {id: t.regionId, name: t.regionName || t.regionId}
            }
        }
        return out
    }

    function _filteredTailIndexes() {
        const set = new Set()
        const q = (_state.search || "").trim()
        const cls = _state.classFilter
        _state.view.tails.forEach((t, i) => {
            if (cls != null) {
                const tc = t.classification || (t.maintRatio == null ? "unknown" : "on-target")
                if (tc !== cls) return
            }
            if (q) {
                const hay = [
                    t.registration, t.equipment, t.hub, t.orgName, t.regionName, t.displayName
                ].filter(Boolean).join(" ").toLowerCase()
                if (hay.indexOf(q) === -1) return
            }
            set.add(i)
        })
        return set
    }

    function _groupKey(g) {
        return g.orgId || g.hub || (g.typeId != null ? "t:" + g.typeId : null) || g.regionId || "_unassigned"
    }

    function _groupLabel(g) {
        if (g.orgName)  return g.orgName
        if (g.hub)      return g.hub
        if (g.name)     return g.name
        return "Unassigned"
    }

    function _ratioColor(ratio) {
        if (ratio == null) return null
        if (ratio < 90) return "#ef4444"
        if (ratio < 95) return "#f59e0b"
        return "#86efac"
    }

    function _classColor(cls) {
        if (cls === "stress")    return "#ef4444"
        if (cls === "cold")      return "#3b82f6"
        if (cls === "on-target") return "#86efac"
        if (cls === "unknown")   return "#94a3b8"
        return null
    }

    function _renderDetail() {
        const host = document.getElementById("aes-fc-detail")
        if (!host) return
        host.innerHTML = ""
        if (_state.selectedTailIdx == null || !_state.view) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px">' +
                'Select a tail to inspect.</div>'
            return
        }
        const t = _state.view.tails[_state.selectedTailIdx]
        if (!t) return

        const title = document.createElement("div")
        title.style.cssText = "font-size:14px;font-weight:600;color:#e2e8f0;margin-bottom:4px;"
        title.textContent = t.registration || ("aircraft " + t.aircraftId)
        host.appendChild(title)

        const sub = document.createElement("div")
        sub.style.cssText = "font-size:11px;color:#94a3b8;margin-bottom:12px;"
        sub.textContent = (t.equipment || "?") + " · " + (t.airlineCode || "?") + " · " + (t.server || "?")
        host.appendChild(sub)

        const rows = [
            ["Account",       t.displayName || t.accountId],
            ["Hub",           t.hub || "—"],
            ["Location",      t.locName || t.locIata || "—"],
            ["Org",           t.orgName || "—"],
            ["Region",        t.regionName || "—"],
            ["Maint ratio",   t.maintRatio == null ? "—" : t.maintRatio.toFixed(1) + "%"],
            ["Ratio status",  t.ratioStatus || "—"],
            ["Weekly block",  t.weeklyBlockHours == null ? "—" : t.weeklyBlockHours.toFixed(1) + "h"],
            ["Leg count",     t.legCount == null ? "—" : t.legCount],
            ["Util %",        t.utilizationPct == null ? "—" : t.utilizationPct.toFixed(1) + "%"],
            ["Ratio (14d)",   t.ratioForecast14d == null ? "—" : t.ratioForecast14d.toFixed(1) + "%"],
            ["Target hr/wk",  t.targetWeeklyHours == null ? "—" : t.targetWeeklyHours.toFixed(1) + "h"],
            ["Classification", t.classification || "—"]
        ]
        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:11px;"
        for (const [k, v] of rows) {
            const lbl = document.createElement("span")
            lbl.style.cssText = "color:#94a3b8;"
            lbl.textContent = k
            const val = document.createElement("span")
            val.style.cssText = "color:#cbd5e1;font-family:ui-monospace,monospace;"
            val.textContent = v
            grid.appendChild(lbl); grid.appendChild(val)
        }
        host.appendChild(grid)

        // Cross-tile focus link.
        const cta = document.createElement("button")
        cta.type = "button"
        cta.textContent = "Focus this aircraft →"
        cta.style.cssText = "margin-top:12px;padding:6px 10px;background:transparent;color:#cbd5e1;" +
            "border:1px solid rgba(148,163,184,0.35);border-radius:3px;cursor:pointer;font-size:11px;"
        cta.addEventListener("click", () => {
            if (window.CentralHubBus) {
                window.CentralHubBus.emit("focus-aircraft", {aircraftId: t.aircraftId, server: t.server})
            }
        })
        host.appendChild(cta)
    }

    // ── Bulk action drawer (Phase 4) ──────────────────────────────────

    function _selectedTails() {
        if (!_state.view || !_state.selectedTailIds.size) return []
        return _state.view.tails.filter(t => t && _state.selectedTailIds.has(String(t.aircraftId)))
    }

    function _hubBreakdown(tails) {
        const by = new Map()
        for (const t of tails) {
            const hub = String(t.hub || t.locIata || "—").toUpperCase()
            by.set(hub, (by.get(hub) || 0) + 1)
        }
        return Array.from(by.entries()).sort((a, b) => b[1] - a[1])
    }

    function _invalidateBulkPreview() {
        _state.bulkPreview = null
    }

    async function _ensureBulkPresets() {
        if (_state.bulkPresets) return _state.bulkPresets
        if (typeof SchedulePresets === "undefined") {
            _state.bulkPresets = []
            return []
        }
        try {
            const block = await SchedulePresets.load()
            const list = (block && Array.isArray(block.presets)) ? block.presets : []
            _state.bulkPresets = list.filter(p => p && p.name && p.name.indexOf("__aes-auto-tmp-") !== 0)
        } catch (e) {
            console.warn("[fleet-command-panel] preset load failed", e)
            _state.bulkPresets = []
        }
        return _state.bulkPresets
    }

    async function _runBulkPreview() {
        if (typeof window.AesFleetCommandBulkApply === "undefined") return null
        const tails = _selectedTails()
        if (tails.length < 2 || !_state.bulkPresetId) return null
        try {
            const result = await window.AesFleetCommandBulkApply.preview({
                tails:    tails,
                presetId: _state.bulkPresetId,
                ctx:      {server: tails[0] && tails[0].server || ""}
            })
            _state.bulkPreview = {presetId: _state.bulkPresetId, result}
            return result
        } catch (e) {
            console.warn("[fleet-command-panel] preview threw", e)
            return null
        }
    }

    async function _runBulkApply() {
        if (typeof window.AesFleetCommandBulkApply === "undefined") return
        const tails = _selectedTails()
        if (tails.length < 2 || !_state.bulkPresetId) return
        if (_state.bulkInFlight) return

        _state.bulkInFlight = true
        _renderActionDrawer()
        try {
            const result = await window.AesFleetCommandBulkApply.execute({
                tails:    tails,
                presetId: _state.bulkPresetId,
                ctx:      {server: tails[0] && tails[0].server || ""},
                source:   "fleet-command-panel"
            })
            _state.bulkLastResult = result
            _toastResult(result)
        } catch (e) {
            console.warn("[fleet-command-panel] execute threw", e)
            _toast("error", "Bulk apply threw: " + ((e && e.message) || String(e)))
        } finally {
            _state.bulkInFlight = false
            await _refreshAuditEntries()
            _renderActionDrawer()
        }
    }

    function _toastResult(result) {
        if (typeof RouteAssistantToast === "undefined") return
        const verb = "Bulk apply"
        if (result.aborted && (result.blockers || []).length) {
            RouteAssistantToast.warn(verb + " aborted — " + result.blockers.join("; "))
            return
        }
        const tone = result.aborted ? "warn" : (result.failed ? "warn" : "success")
        const fn = (tone === "warn") ? RouteAssistantToast.warn : RouteAssistantToast.success
        try {
            fn.call(RouteAssistantToast, verb + " "
                + (result.aborted ? "aborted" : "done")
                + " — " + result.succeeded + " ok / " + result.failed + " failed across "
                + result.eligibleCount + " aircraft.")
        } catch (_) { /* noop */ }
    }

    function _toast(kind, msg) {
        if (typeof RouteAssistantToast === "undefined") return
        const fn = RouteAssistantToast[kind] || RouteAssistantToast.info
        try { fn.call(RouteAssistantToast, msg) } catch (_) { /* noop */ }
    }

    async function _refreshAuditEntries() {
        if (typeof window.AesFleetCommandBulkApply === "undefined") return
        try {
            _state.bulkAuditEntries = await window.AesFleetCommandBulkApply.loadAuditLog()
        } catch (_) { /* noop */ }
    }

    function _renderActionDrawer() {
        const host = document.getElementById("aes-fc-detail")
        if (!host) return
        host.innerHTML = ""

        const tails = _selectedTails()
        const title = document.createElement("div")
        title.style.cssText = "font-size:14px;font-weight:600;color:#e2e8f0;margin-bottom:4px;"
        title.textContent = "Bulk apply (" + tails.length + " selected)"
        host.appendChild(title)

        const sub = document.createElement("div")
        sub.style.cssText = "font-size:11px;color:#94a3b8;margin-bottom:10px;line-height:1.4;"
        sub.textContent = "Pick a wave preset; tails whose hub matches the preset hub will receive the same plan. Mismatched tails are advisory-skipped (never auto-ferried)."
        host.appendChild(sub)

        const hubs = _hubBreakdown(tails)
        const hubsRow = document.createElement("div")
        hubsRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;"
        for (const [hub, count] of hubs) {
            const pill = document.createElement("span")
            pill.style.cssText = "font-size:10px;padding:2px 8px;border-radius:10px;"
                + "background:rgba(59,130,246,0.10);color:#dbeafe;border:1px solid rgba(59,130,246,0.25);"
                + "font-family:ui-monospace,monospace;"
            pill.textContent = hub + " · " + count
            hubsRow.appendChild(pill)
        }
        host.appendChild(hubsRow)

        const presetLabel = document.createElement("div")
        presetLabel.style.cssText = "font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;"
        presetLabel.textContent = "Wave preset"
        host.appendChild(presetLabel)

        const sel = document.createElement("select")
        sel.style.cssText = "width:100%;background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);"
            + "border-radius:3px;padding:5px 8px;font-size:11px;margin-bottom:8px;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "(loading…)"
        sel.appendChild(placeholder)
        host.appendChild(sel)

        _ensureBulkPresets().then(presets => {
            sel.innerHTML = ""
            const blank = document.createElement("option")
            blank.value = ""
            blank.textContent = presets.length ? "(pick a preset)" : "(no presets defined)"
            sel.appendChild(blank)
            const dominantHub = hubs.length ? hubs[0][0] : null
            for (const p of presets) {
                const opt = document.createElement("option")
                opt.value = p.id
                const presetHub = String(p.hub || "").toUpperCase()
                const matches = !presetHub || (dominantHub && presetHub === dominantHub)
                opt.textContent = (matches ? "" : "↯ ") + (p.name || "(unnamed)")
                    + (presetHub ? " · " + presetHub : " · any-hub")
                sel.appendChild(opt)
            }
            sel.value = _state.bulkPresetId || ""
            sel.addEventListener("change", () => {
                _state.bulkPresetId = sel.value || null
                _saveFilters()
                _invalidateBulkPreview()
                _renderActionDrawer()
                if (_state.bulkPresetId) _runBulkPreview().then(() => _renderActionDrawer())
            })
        })

        // Preview block (eligibility + flight count + warnings).
        const prevHost = document.createElement("div")
        prevHost.style.cssText = "padding:8px;background:rgba(15,23,42,0.5);border:1px solid rgba(148,163,184,0.18);"
            + "border-radius:3px;margin-bottom:10px;font-size:11px;color:#cbd5e1;line-height:1.5;"
        host.appendChild(prevHost)
        _renderPreviewSummary(prevHost)

        // CTAs.
        const ctas = document.createElement("div")
        ctas.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;"

        const previewBtn = document.createElement("button")
        previewBtn.type = "button"
        previewBtn.textContent = _state.bulkInFlight ? "…" : "Preview"
        previewBtn.disabled = !_state.bulkPresetId || _state.bulkInFlight
        previewBtn.style.cssText = "background:transparent;color:#cbd5e1;border:1px solid rgba(148,163,184,0.35);"
            + "border-radius:3px;padding:4px 10px;font-size:11px;cursor:" + (previewBtn.disabled ? "not-allowed" : "pointer") + ";"
        previewBtn.title = "Run the preflight without dispatching anything."
        previewBtn.addEventListener("click", async () => {
            await _runBulkPreview()
            _renderActionDrawer()
        })
        ctas.appendChild(previewBtn)

        const applyBtn = document.createElement("button")
        applyBtn.type = "button"
        applyBtn.textContent = _state.bulkInFlight ? "Applying…" : "Apply to fleet"
        applyBtn.disabled = !_state.bulkPresetId || _state.bulkInFlight || !_isApplyable()
        applyBtn.style.cssText = "background:" + (applyBtn.disabled ? "#374151" : "#9a3412") + ";"
            + "color:" + (applyBtn.disabled ? "#9ca3af" : "#fed7aa") + ";"
            + "border:1px solid " + (applyBtn.disabled ? "#374151" : "#7c2d12") + ";"
            + "border-radius:3px;padding:4px 12px;font-size:11px;font-weight:600;"
            + "cursor:" + (applyBtn.disabled ? "not-allowed" : "pointer") + ";"
        applyBtn.title = applyBtn.disabled
            ? "Run Preview first; the apply button enables once the readiness gates pass."
            : "Dispatch the wave plan to every eligible tail. Per-aircraft tier-gates still apply."
        applyBtn.addEventListener("click", () => _runBulkApply())
        ctas.appendChild(applyBtn)

        host.appendChild(ctas)

        // Recent batches collapsible.
        if (_state.bulkAuditEntries == null) {
            _refreshAuditEntries().then(() => _renderActionDrawer())
        }
        const recent = (_state.bulkAuditEntries || []).slice(0, 5)
        if (recent.length) {
            const heading = document.createElement("div")
            heading.style.cssText = "font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 4px;"
            heading.textContent = "Recent batches"
            host.appendChild(heading)

            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:11px;"
            for (const e of recent) {
                const row = document.createElement("div")
                const ok = !e.aborted && !e.failed
                const tone = e.aborted ? "#fbbf24" : (e.failed ? "#fca5a5" : "#86efac")
                row.style.cssText = "padding:4px 6px;border-radius:3px;background:rgba(15,23,42,0.5);"
                    + "border:1px solid rgba(148,163,184,0.15);color:#cbd5e1;display:flex;flex-direction:column;gap:2px;"
                const head = document.createElement("div")
                head.style.cssText = "display:flex;justify-content:space-between;font-family:ui-monospace,monospace;font-size:10px;"
                head.innerHTML = '<span style="color:' + tone + '">'
                    + _esc(e.presetName || e.presetId || "?") + ' · ' + (e.presetHub || "any") + '</span>'
                    + '<span style="color:#94a3b8">' + _formatTs(e.ts) + '</span>'
                row.appendChild(head)
                const tail = document.createElement("div")
                tail.style.cssText = "font-size:10px;color:#94a3b8;"
                const tags = []
                tags.push(e.eligibleCount + " elig")
                if (e.skippedCount) tags.push(e.skippedCount + " skip")
                if (e.succeeded)    tags.push(e.succeeded + " ok")
                if (e.failed)       tags.push(e.failed + " fail")
                if (e.aborted)      tags.push("aborted")
                tail.textContent = tags.join(" · ")
                row.appendChild(tail)
                list.appendChild(row)
            }
            host.appendChild(list)
        }
    }

    function _renderPreviewSummary(host) {
        if (!_state.bulkPresetId) {
            host.innerHTML = '<span style="color:#64748b;font-style:italic">Pick a preset to preview eligibility.</span>'
            return
        }
        if (_state.bulkInFlight) {
            host.innerHTML = '<span style="color:#94a3b8">Running…</span>'
            return
        }
        const cached = _state.bulkPreview
        if (!cached || cached.presetId !== _state.bulkPresetId) {
            host.innerHTML = '<span style="color:#94a3b8">Click <em>Preview</em> to compute eligibility.</span>'
            return
        }
        const r = cached.result
        host.innerHTML = ""

        const hdr = document.createElement("div")
        hdr.style.cssText = "font-weight:600;color:#e2e8f0;"
        hdr.textContent = (r.preset && r.preset.name)
            ? r.preset.name + " · " + (r.presetHub || "any-hub")
            : "Preset not found"
        host.appendChild(hdr)

        const lines = [
            ["Eligible tails", r.eligible.length],
            ["Skipped (hub mismatch)", r.skipped.length],
            ["Flights in build", r.flightCount],
            ["Top-routes for hub", r.scoredRows.length]
        ]
        for (const [k, v] of lines) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;justify-content:space-between;font-family:ui-monospace,monospace;color:#cbd5e1;"
            row.innerHTML = '<span style="color:#94a3b8">' + _esc(k) + '</span><span>' + _esc(v) + '</span>'
            host.appendChild(row)
        }

        if (r.skipped && r.skipped.length) {
            const sk = document.createElement("div")
            sk.style.cssText = "margin-top:6px;padding:4px 6px;background:rgba(251,191,36,0.06);"
                + "border:1px solid rgba(251,191,36,0.20);border-radius:2px;color:#fde68a;font-size:10px;"
            const max = Math.min(r.skipped.length, 4)
            const lines2 = []
            for (let i = 0; i < max; i++) {
                const s = r.skipped[i]
                const reg = s.tail && (s.tail.registration || s.tail.aircraftId) || "?"
                lines2.push(reg + " — " + s.reason)
            }
            if (r.skipped.length > max) lines2.push("…+" + (r.skipped.length - max) + " more")
            sk.innerHTML = "<strong>Skipped:</strong><br>" + lines2.map(_esc).join("<br>")
            host.appendChild(sk)
        }

        if (!r.readiness.ok) {
            const blk = document.createElement("div")
            blk.style.cssText = "margin-top:6px;padding:4px 6px;background:rgba(239,68,68,0.07);"
                + "border:1px solid rgba(239,68,68,0.25);border-radius:2px;color:#fca5a5;font-size:10px;"
            blk.innerHTML = "<strong>Blockers:</strong><br>"
                + (r.readiness.blockers || []).map(_esc).join("<br>")
            host.appendChild(blk)
        }
    }

    function _isApplyable() {
        const cached = _state.bulkPreview
        if (!cached || cached.presetId !== _state.bulkPresetId) return false
        return !!cached.result.readiness.ok
    }

    function _formatTs(ts) {
        if (!ts) return "—"
        const d = new Date(ts)
        const mm = String(d.getMonth() + 1).padStart(2, "0")
        const dd = String(d.getDate()).padStart(2, "0")
        const HH = String(d.getHours()).padStart(2, "0")
        const MM = String(d.getMinutes()).padStart(2, "0")
        return mm + "-" + dd + " " + HH + ":" + MM
    }

    async function open(opts) {
        _ensureModal()
        const filt = await _loadFilters()
        if (filt) {
            if (filt.pivot)        _state.pivot       = filt.pivot
            if (filt.viewMode === "table" || filt.viewMode === "map")
                                    _state.viewMode    = filt.viewMode
            if (filt.search != null) _state.search    = filt.search
            if ("classFilter" in filt) _state.classFilter = filt.classFilter
            if (filt.bulkPresetId)  _state.bulkPresetId = filt.bulkPresetId
        }
        if (opts && opts.pivot)    _state.pivot     = opts.pivot
        if (opts && opts.viewMode) _state.viewMode  = opts.viewMode
        _state.expandedGroups   = new Set()
        _state.selectedTailIdx  = null
        _state.selectedTailIds  = new Set()
        _state.bulkPreview      = null
        _state.bulkInFlight     = false
        _state.bulkLastResult   = null
        _state.bulkAuditEntries = null
        await _refresh()
        _modal.style.display = "flex"
    }

    function close() {
        if (_modal) _modal.style.display = "none"
    }

    window.AesFleetCommandPanel = {open, close}
})()
