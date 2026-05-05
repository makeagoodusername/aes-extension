"use strict"

/**
 * Competitor Intel Hub — modal shell.
 *
 * Owns the overlay scrim, header (title + server picker + change-log link
 * + close), tab bar, search input, and the per-tab content host. Receives
 * data from `AesCompetitorIntelHost.open()` and dispatches to per-view
 * renderers.
 *
 * Singleton — calling open() while already mounted re-renders with the
 * new context. Closing tears down listeners + DOM.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelShell) return

    const TABS = [
        {id: "map",           label: "Map",           glyph: "🗺"},
        {id: "companies",     label: "Companies",     glyph: "🏢"},
        {id: "routes",        label: "Routes",        glyph: "↔"},
        {id: "ors",           label: "ORS",           glyph: "◎"},
        {id: "flightnumbers", label: "Flight numbers", glyph: "🔢"}
    ]

    let _instance = null

    function open(ctx) {
        if (_instance) {
            // Re-mount with the new context.
            _instance.ctx = ctx
            if (_instance.state) {
                _instance.state.ctx = ctx
                if (_validTab(ctx && ctx.initialTab)) {
                    _instance.state.tab = ctx.initialTab
                    _instance.state.sort = _defaultSortFor(ctx.initialTab)
                }
                if (ctx && typeof ctx.initialSearch === "string") {
                    _instance.state.search = ctx.initialSearch
                }
                // Re-open with a fresh airline focus when caller supplies one.
                // null is a valid clear; undefined means "preserve existing".
                if (ctx && Object.prototype.hasOwnProperty.call(ctx, "initialAirlineId")) {
                    _instance.state.airlineId = ctx.initialAirlineId
                        ? String(ctx.initialAirlineId) : null
                } else if (ctx && Object.prototype.hasOwnProperty.call(ctx, "airlineId")) {
                    _instance.state.airlineId = ctx.airlineId
                        ? String(ctx.airlineId) : null
                }
            }
            _instance.render()
            return
        }
        _instance = _build(ctx)
        _instance.render()
    }

    function close() {
        if (!_instance) return
        if (_instance.cleanup) _instance.cleanup()
        if (_instance.overlay && _instance.overlay.parentNode) {
            _instance.overlay.parentNode.removeChild(_instance.overlay)
        }
        _instance = null
    }

    function isOpen() { return !!_instance }

    function _build(ctx) {
        const initialAirline = ctx && (ctx.initialAirlineId || ctx.airlineId)
            ? String(ctx.initialAirlineId || ctx.airlineId) : null
        const state = {
            tab:    _validTab(ctx && ctx.initialTab) ? ctx.initialTab : "companies",
            search: (ctx && typeof ctx.initialSearch === "string") ? ctx.initialSearch : "",
            sort:   _defaultSortFor(_validTab(ctx && ctx.initialTab) ? ctx.initialTab : "companies"),
            airlineId: initialAirline,
            ctx
        }

        const overlay = document.createElement("div")
        overlay.id = "aes-competitor-intel-overlay"
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10005;"
            + "display:flex;align-items:center;justify-content:center;"

        const dialog = document.createElement("div")
        dialog.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #38bdf8;border-radius:6px;"
            + "width:1180px;max-width:96vw;height:88vh;max-height:88vh;"
            + "display:flex;flex-direction:column;font:12px/1.4 sans-serif;overflow:hidden;position:relative;"
        overlay.append(dialog)

        // ---- Header (title + server picker + actions + close) -----------
        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
            + "padding:12px 18px;border-bottom:1px solid #1f2937;flex-shrink:0;"
        const headLeft = document.createElement("div")
        headLeft.style.cssText = "display:flex;gap:14px;align-items:center;"
        const title = document.createElement("div")
        title.style.cssText = "color:#7dd3fc;font-size:14px;font-weight:600;"
        title.textContent = "Competitor Intel"
        headLeft.append(title)

        const serverWrap = document.createElement("div")
        serverWrap.style.cssText = "display:flex;align-items:center;gap:6px;color:#94a3b8;font-size:11px;"
        serverWrap.append(document.createTextNode("Server:"))
        const serverSelect = document.createElement("select")
        serverSelect.style.cssText = "background:#1e293b;color:#e5e7eb;border:1px solid #334155;"
            + "border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;"
        serverWrap.append(serverSelect)
        headLeft.append(serverWrap)

        const headRight = document.createElement("div")
        headRight.style.cssText = "display:flex;gap:8px;align-items:center;"

        const logBtn = document.createElement("button")
        logBtn.textContent = "📋 Change log"
        logBtn.title = "Open the cross-domain change log filtered to competitor-intel events."
        logBtn.style.cssText = "background:#1e3a8a;color:#e5e7eb;border:1px solid #38bdf8;"
            + "border-radius:3px;padding:4px 10px;cursor:pointer;font-size:11px;"
        logBtn.addEventListener("click", () => {
            if (window.AesChangeLogModal && window.AesChangeLogModal.open) {
                window.AesChangeLogModal.open({initialDomains: ["competitor-intel"]})
            }
        })
        headRight.append(logBtn)

        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;color:#94a3b8;border:none;cursor:pointer;"
            + "font-size:16px;padding:0 4px;"
        closeBtn.addEventListener("click", close)
        headRight.append(closeBtn)

        head.append(headLeft, headRight)
        dialog.append(head)

        // ---- Tab bar -----------------------------------------------------
        const tabBar = document.createElement("div")
        tabBar.style.cssText = "display:flex;gap:0;padding:0 14px;border-bottom:1px solid #1f2937;"
            + "background:rgba(15,23,42,0.5);flex-shrink:0;"
        dialog.append(tabBar)

        // ---- Search bar --------------------------------------------------
        const searchBar = document.createElement("div")
        searchBar.style.cssText = "padding:8px 18px;display:flex;gap:10px;align-items:center;"
            + "border-bottom:1px solid #1f2937;flex-shrink:0;"
        const searchIcon = document.createElement("span")
        searchIcon.textContent = "🔍"
        searchIcon.style.cssText = "color:#94a3b8;font-size:12px;"
        const searchInput = document.createElement("input")
        searchInput.type = "search"
        searchInput.placeholder = "Search…"
        searchInput.style.cssText = "flex:1;background:#1e293b;color:#e5e7eb;border:1px solid #334155;"
            + "border-radius:3px;padding:4px 8px;font-size:12px;"
        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        clearBtn.style.cssText = "background:#1e293b;color:#cbd5e1;border:1px solid #334155;"
            + "border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;"
        clearBtn.addEventListener("click", () => {
            searchInput.value = ""
            state.search = ""
            renderActiveView()
        })
        searchBar.append(searchIcon, searchInput, clearBtn)
        dialog.append(searchBar)

        let searchTimer = null
        searchInput.addEventListener("input", () => {
            clearTimeout(searchTimer)
            searchTimer = setTimeout(() => {
                state.search = searchInput.value || ""
                renderActiveView()
            }, 150)
        })

        // ---- Content host ------------------------------------------------
        const contentHost = document.createElement("div")
        contentHost.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;"
        dialog.append(contentHost)

        // ---- Footer ------------------------------------------------------
        const footer = document.createElement("div")
        footer.style.cssText = "padding:6px 18px;border-top:1px solid #1f2937;color:#6b7280;font-size:10px;"
            + "display:flex;justify-content:space-between;flex-shrink:0;"
        const footLeft = document.createElement("span")
        const footRight = document.createElement("span")
        footRight.innerHTML = `<kbd style="background:#1e293b;border:1px solid #334155;border-radius:2px;padding:0 4px;">Esc</kbd> close`
        footer.append(footLeft, footRight)
        dialog.append(footer)

        // Esc close + scrim click ------------------------------------------
        const onKey = e => { if (e.key === "Escape") close() }
        document.addEventListener("keydown", onKey)
        overlay.addEventListener("click", e => {
            if (e.target === overlay) close()
        })

        // Storage onChange listener — refresh when underlying data mutates.
        const onStorage = (changes, area) => {
            if (area !== "local") return
            const server = state.ctx && state.ctx.server ? String(state.ctx.server) : ""
            for (const k in changes) {
                if (k.startsWith("competitorIntel:") || k.startsWith("routeAssistant:ors:")) {
                    _refreshData()
                    break
                }
                if (k.endsWith("competitorMonitoring")
                        || (server && k.startsWith(server) && k.endsWith("schedule"))) {
                    _refreshData()
                    break
                }
            }
        }
        if (chrome && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(onStorage)
        }

        async function _refreshData() {
            try {
                const next = await ctx.reload(state.ctx.server)
                state.ctx.data = next.data
                renderActiveView()
                renderFooter()
            } catch (e) { /* graceful */ }
        }

        // Subscribe to the cross-tile focus-enterprise event so clicking an
        // airline on the world-map / competitor-monitoring tile / alliance
        // tile drops the user straight into the airline-detail view.
        // Returns the unsubscribe handle for cleanup.
        let focusOff = null
        if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
            try {
                focusOff = window.CentralHubBus.on("focus-enterprise", (payload) => {
                    const id = payload && (payload.enterpriseId || payload.id)
                    if (!id) return
                    state.airlineId = String(id)
                    renderTabs()
                    renderActiveView()
                })
            } catch (e) {
                console.warn("[AES competitor-intel] focus-enterprise subscribe failed", e)
            }
        }

        const cleanup = () => {
            document.removeEventListener("keydown", onKey)
            if (chrome && chrome.storage && chrome.storage.onChanged) {
                chrome.storage.onChanged.removeListener(onStorage)
            }
            if (typeof focusOff === "function") {
                try { focusOff() } catch (_) {}
            }
            if (window.AesCompetitorIntelDrilldown) window.AesCompetitorIntelDrilldown.close()
            if (window.AesCompetitorIntelFlightNumbersView
                    && window.AesCompetitorIntelFlightNumbersView.invalidateCache) {
                window.AesCompetitorIntelFlightNumbersView.invalidateCache()
            }
        }

        // ---- Renderers ---------------------------------------------------
        function renderTabs() {
            tabBar.innerHTML = ""
            for (const t of TABS) {
                const btn = document.createElement("button")
                // When airlineId is focused the static tabs render dim (the
                // airline-detail view owns the content area); a separate
                // "Detail · <name>" pill on the right is the active one.
                const dim = !!state.airlineId
                const active = !dim && state.tab === t.id
                const color = active ? "#67e8f9" : (dim ? "#475569" : "#94a3b8")
                const border = active ? "#67e8f9" : "transparent"
                btn.style.cssText = "background:transparent;border:none;color:" + color + ";"
                    + "padding:8px 14px;font-size:12px;cursor:pointer;border-bottom:2px solid " + border + ";"
                    + "font-weight:" + (active ? "600" : "400") + ";display:flex;align-items:center;gap:6px;"
                btn.innerHTML = `<span>${t.glyph}</span><span>${t.label}</span>`
                btn.addEventListener("click", () => {
                    state.airlineId = null
                    state.tab = t.id
                    state.sort = _defaultSortFor(t.id)
                    renderTabs()
                    renderActiveView()
                })
                tabBar.append(btn)
            }
            if (state.airlineId) {
                const data = state.ctx && state.ctx.data
                const rec = data && data.enterprises ? data.enterprises.get(String(state.airlineId)) : null
                const name = (rec && rec.name) || ("#" + state.airlineId)
                const pill = document.createElement("button")
                pill.style.cssText = "margin-left:auto;background:#1e3a8a;border:1px solid #67e8f9;color:#67e8f9;"
                    + "padding:6px 12px;font-size:11px;cursor:default;border-radius:3px;font-weight:600;"
                    + "display:flex;align-items:center;gap:6px;"
                pill.innerHTML = `<span>✈</span><span>${name.replace(/[<>&]/g, "")}</span>`
                tabBar.append(pill)
                const exitBtn = document.createElement("button")
                exitBtn.title = "Close airline detail"
                exitBtn.textContent = "✕"
                exitBtn.style.cssText = "background:transparent;border:1px solid #334155;color:#94a3b8;"
                    + "padding:6px 8px;font-size:11px;cursor:pointer;border-radius:3px;margin-left:6px;"
                exitBtn.addEventListener("click", () => {
                    state.airlineId = null
                    renderTabs()
                    renderActiveView()
                })
                tabBar.append(exitBtn)
            }
        }

        function renderServerPicker() {
            serverSelect.innerHTML = ""
            const servers = state.ctx.servers || []
            for (const s of servers) {
                const opt = document.createElement("option")
                opt.value = s; opt.textContent = s
                if (s === state.ctx.server) opt.selected = true
                serverSelect.append(opt)
            }
            serverSelect.onchange = async () => {
                const next = await ctx.reload(serverSelect.value)
                state.ctx.server = next.server
                state.ctx.data = next.data
                renderActiveView()
                renderFooter()
            }
        }

        function renderFooter() {
            const d = state.ctx.data
            const counts = []
            if (d.enterprises) counts.push(d.enterprises.size + " enterprises")
            if (d.edges)       counts.push(d.edges.size + " edges")
            if (d.orsRoutes)   counts.push(d.orsRoutes.size + " ORS routes")
            footLeft.textContent = "Cache: " + counts.join(" · ")
                + (d.scannedAt ? " · scanned " + _fmtRelative(d.scannedAt) : "")
        }

        function renderActiveView() {
            contentHost.innerHTML = ""
            const opts = {
                search: state.search,
                sort:   state.sort,
                airlineId: state.airlineId,
                onSort: (next) => { state.sort = next; renderActiveView() },
                onSelect: (sel) => {
                    // openAirline — switch the content area to the airline-detail
                    // view for the given enterprise id. Tab state is preserved
                    // so the back button returns to the right list. Triggered
                    // from Companies row click (via drilldown's "Open detail"),
                    // Map tab carrier panel, and the focus-enterprise bus event.
                    if (sel && sel.kind === "openAirline" && sel.airlineId) {
                        state.airlineId = String(sel.airlineId)
                        renderTabs()
                        renderActiveView()
                        return
                    }
                    // The map view emits {kind:"switchTab", tab, search?} — used
                    // when the user clicks an airline row's "Filter ↑" button so
                    // the Companies tab opens pre-filtered to that airline. All
                    // other selection envelopes (company / route / ors row) flow
                    // through the existing drilldown side-panel.
                    if (sel && sel.kind === "switchTab" && _validTab(sel.tab)) {
                        // Switching tabs always exits the airline-detail
                        // overlay so the user sees the requested list view.
                        state.airlineId = null
                        state.tab = sel.tab
                        state.sort = _defaultSortFor(sel.tab)
                        if (typeof sel.search === "string") {
                            state.search = sel.search
                            searchInput.value = sel.search
                        }
                        renderTabs()
                        renderActiveView()
                        return
                    }
                    if (window.AesCompetitorIntelDrilldown) {
                        window.AesCompetitorIntelDrilldown.open(dialog, sel, state.ctx)
                    }
                }
            }
            const data = state.ctx.data
            // Airline-detail overlay takes precedence over the tab views: when
            // a specific airline is selected, render the rich detail view in
            // the content area and skip the tab dispatch.
            if (state.airlineId) {
                const detail = window.AesCompetitorIntelAirlineDetailView
                if (detail && typeof detail.render === "function") {
                    detail.render(contentHost, data, opts)
                    return
                }
                contentHost.textContent = "Airline detail view not loaded."
                return
            }
            const view = _viewFor(state.tab)
            if (!view) {
                contentHost.textContent = "View not loaded: " + state.tab
                return
            }
            const result = view.render(contentHost, data, opts)
            // flight-numbers-view returns a promise (lazy load)
            if (result && typeof result.catch === "function") result.catch(() => {})
        }

        function render() {
            searchInput.value = state.search || ""
            renderServerPicker()
            renderTabs()
            renderActiveView()
            renderFooter()
        }

        document.body.append(overlay)
        return {overlay, dialog, ctx: state.ctx, state, render, cleanup}
    }

    function _viewFor(tabId) {
        switch (tabId) {
            case "map":           return window.AesCompetitorIntelExploreMapView
            case "companies":     return window.AesCompetitorIntelCompaniesView
            case "routes":        return window.AesCompetitorIntelRoutesView
            case "ors":           return window.AesCompetitorIntelOrsView
            case "flightnumbers": return window.AesCompetitorIntelFlightNumbersView
        }
        return null
    }

    function _defaultSortFor(tabId) {
        const v = _viewFor(tabId)
        return (v && v.DEFAULT_SORT) ? Object.assign({}, v.DEFAULT_SORT) : null
    }

    function _validTab(tabId) {
        if (!tabId) return false
        return TABS.some(t => t.id === tabId) ? tabId : false
    }

    function _fmtRelative(ts) {
        if (!isFinite(ts) || ts <= 0) return "never"
        const diff = Date.now() - ts
        if (diff < 60_000)         return Math.max(1, Math.round(diff / 1000)) + "s ago"
        if (diff < 3600_000)       return Math.round(diff / 60000) + "m ago"
        if (diff < 86400_000)      return Math.round(diff / 3600000) + "h ago"
        return new Date(ts).toLocaleDateString()
    }

    window.AesCompetitorIntelShell = {open, close, isOpen}
})()
