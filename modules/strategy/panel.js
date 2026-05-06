"use strict"

/**
 * AES Strategy — Preview / Apply modal (Slice 4 — first writing PR).
 *
 * Full-screen overlay that:
 *   1. Builds a fresh `Snapshot` via `AesStrategy.snapshot()`.
 *   2. Scores routes via `AesStrategy.scoreRoutes()`.
 *   3. Allocates a `FleetPlan` via `AesStrategy.allocateFleet()`.
 *   4. Diffs via `AesStrategy.diffPlan()`.
 *   5. Renders three regions:
 *        • Header — title + tier badge + Refresh + Close
 *        • Body   — settings strip + decisions list (checkboxed, grouped
 *                   by domain) + per-aircraft schedule accordion
 *        • Footer — tier select + per-domain flags + Apply selected
 *   6. Threads the user's selection + the live settings into
 *      `AesStrategy.apply()` and reports per-decision outcomes inline.
 *
 * Public API (window.AesStrategyPanel):
 *   AesStrategyPanel.open(opts?) → Promise<void>
 *   AesStrategyPanel.close()     → void
 *
 * `opts.snapshot` / `opts.plan` are passthroughs for testing — production
 * callers omit them and the panel composes its own.
 *
 * `opts.preselect` (string[] of decision ids) — landing-page selection,
 * useful for "quick-apply N high-confidence" entry points.
 * `opts.filter` (partial filter override) — applied over default filter,
 * e.g. `{selectedOnly: true, sort: "impact"}` pairs with preselect.
 * `opts.skipSeed` — compose from current cache on first open instead of
 * running the store-readiness seed pump first.
 *
 * Mounts an isolated stylesheet via inline cssText so the modal renders
 * the same on dashboard, fleet, and scheduling pages regardless of which
 * skin CSS is active. No external CSS deps.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyPanel) return

    const COLOR = {
        bg:       "#0f172a",
        panel:    "#1f2937",
        rule:     "#374151",
        text:     "#f3f4f6",
        muted:    "#9ca3af",
        accent:   "#a78bfa",
        ok:       "#10b981",
        warn:     "#f59e0b",
        err:      "#ef4444",
        chipBg:   "#111827",
        chipBgOk: "rgba(16,185,129,0.15)",
        chipBgWarn:"rgba(245,158,11,0.15)",
        chipBgErr:"rgba(239,68,68,0.15)"
    }

    const DOMAIN_LABEL = {
        schedule:           "Schedules",
        service:            "Service profiles",
        price:              "Pricing",
        crew:               "Crew",
        routeCreation:      "New routes",
        competitorReaction: "Competitor reactions",
        alliance:           "Alliance & Interline",
        slotBid:            "Slot bids",
        sister:             "Cross-Airline & Sister Coordination",
        "fleet-renewal":    "Fleet renewal",
        marketing:          "Marketing & Brand",
        hubDesigner:        "Hub Network Designer"
    }
    const DOMAIN_ORDER = ["schedule", "service", "price", "crew", "routeCreation",
        "competitorReaction", "alliance", "slotBid", "sister", "fleet-renewal", "marketing", "hubDesigner"]

    const FILTER_DEFAULT = {
        search:         "",
        domain:         "all",
        applicableOnly: false,
        advisoryOnly:   false,
        selectedOnly:   false,
        sort:           "order"  // "order" | "impact" | "hub"
    }

    const SECTION_MENU = [
        {id: "overview",  label: "Overview"},
        {id: "readiness", label: "Data"},
        {id: "settings",  label: "Settings"},
        {id: "decisions", label: "Decisions"},
        {id: "aircraft",  label: "Schedules"},
        {id: "learning",  label: "Learning"},
        {id: "journal",   label: "Journal"}
    ]

    const SECTION_ALIASES = {
        summary: "overview",
        data: "readiness",
        stores: "readiness",
        store: "readiness",
        readiness: "readiness",
        tuning: "settings",
        tune: "settings",
        settings: "settings",
        decisions: "decisions",
        decision: "decisions",
        pricing: "decisions",
        price: "decisions",
        service: "decisions",
        schedule: "decisions",
        schedules: "aircraft",
        aircraft: "aircraft",
        fleet: "aircraft",
        learn: "learning",
        learning: "learning",
        journal: "journal",
        log: "journal"
    }

    const DOMAIN_ALIASES = {
        schedules: "schedule",
        schedule: "schedule",
        service: "service",
        services: "service",
        pricing: "price",
        prices: "price",
        price: "price",
        crew: "crew",
        route: "routeCreation",
        routes: "routeCreation",
        routecreation: "routeCreation",
        "route-creation": "routeCreation",
        alliance: "alliance",
        interline: "alliance",
        slot: "slotBid",
        slots: "slotBid",
        slotbid: "slotBid",
        "slot-bid": "slotBid",
        slotbids: "slotBid",
        "slot-bids": "slotBid"
    }

    function _copyFilter(overrides) {
        const out = Object.assign({}, FILTER_DEFAULT,
            (overrides && typeof overrides === "object") ? overrides : {})
        const domainRaw = String(out.domain || "all")
        const alias = DOMAIN_ALIASES[domainRaw.toLowerCase()]
        out.domain = alias || domainRaw
        if (out.domain !== "all" && !DOMAIN_LABEL[out.domain]) out.domain = "all"
        out.applicableOnly = !!out.applicableOnly
        out.advisoryOnly   = !!out.advisoryOnly
        out.selectedOnly   = !!out.selectedOnly
        out.sort = (out.sort === "impact" || out.sort === "hub") ? out.sort : "order"
        return out
    }

    function _baseState() {
        return {
            overlay:    null,
            plan:       null,
            snapshot:   null,
            diff:       null,
            settings:   null,
            selected:   new Set(),     // decision-ids the user has checked
            applying:   false,
            focusSection: "overview",
            focusTimer: null,
            // Multi-account: knownServers + the user-selected server scope.
            // Default = current page's server. Switching forces a re-snapshot
            // scoped to that server so the user can preview plans for sister
            // airlines on the same server, or for entirely different worlds.
            server:        null,
            knownServers:  [],
            // Sister-airline (one game world) scope. portfolio holds the
            // current server's airlines + overlap data so the picker, the
            // overlap card, and the tile portfolio can all consume one read.
            airline:       null,        // display name from AesAccountRegistry
            portfolio:     null,        // {airlines, overlapHubs, overlapRoutes}
            filter:        _copyFilter()
        }
    }

    let _state = _baseState()

    /**
     * Discover servers for which we have cached strategy inputs. Scans
     * `aircraftFlightPlan:schedule:<server>:*` (the most reliable signal —
     * AFP page scrape persists this on every visit) and `<server>…aircraftFleet`
     * (the fleet roster). Returns a deduped, sorted server slug list.
     */
    async function _listKnownServers() {
        const out = new Set()
        try {
            const all = await chrome.storage.local.get(null)
            for (const k of Object.keys(all)) {
                if (k.indexOf("aircraftFlightPlan:schedule:") === 0) {
                    const tail = k.slice("aircraftFlightPlan:schedule:".length)
                    const i = tail.indexOf(":")
                    if (i > 0) out.add(tail.slice(0, i))
                } else if (k.endsWith("aircraftFleet")) {
                    // <server><airlineCode>aircraftFleet — the airlineCode
                    // is variable-length so we can't slice deterministically;
                    // peek the record's `server` field instead, which the
                    // fleet scraper writes alongside the fleet array.
                    const rec = all[k]
                    if (rec && typeof rec === "object" && typeof rec.server === "string" && rec.server) {
                        out.add(rec.server)
                    }
                }
            }
        } catch (_) { /* best-effort discovery */ }
        return Array.from(out).sort()
    }

    function _currentPageServer() {
        try {
            if (typeof AES !== "undefined" && AES.getServer) return AES.getServer() || null
        } catch (_) {}
        return null
    }

    function _currentPageAirline() {
        try {
            if (typeof AES !== "undefined" && AES.getAirlineIdentity) return AES.getAirlineIdentity() || null
        } catch (_) {}
        return null
    }

    /**
     * Resolve the per-account id for the currently SELECTED scope
     * (`_state.server` + `_state.airline`). Used to scope per-airline
     * learning + outcomes — the user might be sitting on sister A's page
     * while previewing sister B in the modal, and we want B's history.
     */
    async function _scopedAccountId() {
        if (!_state.server || !_state.airline) return null
        if (window.AesStrategy && typeof window.AesStrategy.computeAccountId === "function") {
            try { return await window.AesStrategy.computeAccountId(_state.server, _state.airline) }
            catch (_) {}
        }
        if (window.AesAccountRegistry && typeof window.AesAccountRegistry.computeId === "function") {
            try { return await window.AesAccountRegistry.computeId(_state.server, _state.airline) }
            catch (_) {}
        }
        return null
    }

    /** Run AesStrategyPortfolio.scanServer for the currently-scoped server.
     *  Returns the empty shape on missing module / errors. */
    async function _scanPortfolio(server) {
        if (!server || !window.AesStrategyPortfolio
                || typeof window.AesStrategyPortfolio.scanServer !== "function") {
            return {server, airlines: [], overlapHubs: [], overlapRoutes: []}
        }
        try { return await window.AesStrategyPortfolio.scanServer(server) }
        catch (_) { return {server, airlines: [], overlapHubs: [], overlapRoutes: []} }
    }

    /** Pick the airline to default to when entering or switching server.
     *  Prefer the current page's airline (likely what the user is staring
     *  at); else the airline with the largest fleet on this server. */
    function _defaultAirline(portfolio) {
        const airlines = (portfolio && portfolio.airlines) || []
        if (!airlines.length) return null
        const cur = _currentPageAirline()
        if (cur) {
            const match = airlines.find(a => a.airline === cur || a.displayName === cur)
            if (match) return match.airline
        }
        return airlines[0].airline
    }

    /** Most recent scrape timestamp backing the currently-scoped airline.
     *  Returns null when we can't tell. The header pill turns amber/red
     *  past 24h/72h so the user knows when stale data is driving the
     *  recommendations. */
    function _scopedFreshnessMs() {
        const portfolio = _state.portfolio
        if (!portfolio || !_state.airline) return null
        const airlines = portfolio.airlines || []
        const me = airlines.find(a => a.airline === _state.airline)
        if (!me) return null
        const ts = Number(me.lastScrape) || 0
        return ts > 0 ? ts : null
    }

    /** Compact "Xm/Xh/Xd ago" string. Used by the data freshness pill. */
    function _fmtAgo(ms) {
        if (ms == null || !isFinite(ms) || ms < 0) return "?"
        const s = ms / 1000
        if (s < 60)        return Math.round(s) + "s ago"
        if (s < 3600)      return Math.round(s / 60) + "m ago"
        if (s < 86_400)    return Math.round(s / 3600) + "h ago"
        return Math.round(s / 86_400) + "d ago"
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _el(tag, cssText, text) {
        const el = document.createElement(tag)
        if (cssText) el.style.cssText = cssText
        if (text != null) el.textContent = text
        return el
    }
    function _btn(label, primary) {
        const b = _el("button", [
            "background:" + (primary ? COLOR.accent : "transparent"),
            "color:"      + (primary ? "#0f172a"   : COLOR.text),
            "border:1px solid " + (primary ? COLOR.accent : COLOR.rule),
            "border-radius:4px",
            "padding:6px 12px",
            "font:600 12px sans-serif",
            "letter-spacing:0.04em",
            "text-transform:uppercase",
            "cursor:pointer",
            "transition:background 0.12s, color 0.12s"
        ].join(";"), label)
        b.type = "button"
        return b
    }
    function _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
    function _seedTimeoutMs(opts) {
        const o = opts || {}
        if (o.timeoutMs != null) return Math.max(1000, Number(o.timeoutMs) || 0)
        if (o.firstOpen) return 12000
        if (o.forceFull) return 120000
        return 90000
    }
    function _badge(text, tone) {
        const bg =
            tone === "ok"   ? COLOR.chipBgOk   :
            tone === "warn" ? COLOR.chipBgWarn :
            tone === "err"  ? COLOR.chipBgErr  : COLOR.chipBg
        const fg =
            tone === "ok"   ? COLOR.ok    :
            tone === "warn" ? COLOR.warn  :
            tone === "err"  ? COLOR.err   : COLOR.muted
        return _el("span", [
            "display:inline-block",
            "padding:2px 8px",
            "background:" + bg,
            "color:" + fg,
            "border:1px solid " + fg,
            "border-radius:10px",
            "font:600 10px sans-serif",
            "letter-spacing:0.06em",
            "text-transform:uppercase"
        ].join(";"), text)
    }

    function _emptyState(label) {
        return _el("p", "color:" + COLOR.muted + ";font-style:italic;margin:6px 0;font-size:12px;", label)
    }

    function _normaliseSection(section) {
        if (!section) return null
        const key = String(section).trim().replace(/\s+/g, "-").toLowerCase()
        if (!key) return null
        if (SECTION_ALIASES[key]) return SECTION_ALIASES[key]
        for (const item of SECTION_MENU) if (item.id === key) return item.id
        return null
    }

    function _normaliseDomain(domain) {
        if (!domain) return null
        const raw = String(domain).trim()
        if (!raw || raw === "all") return "all"
        const key = raw.replace(/\s+/g, "-").toLowerCase()
        if (DOMAIN_ALIASES[key]) return DOMAIN_ALIASES[key]
        for (const k of Object.keys(DOMAIN_LABEL)) {
            if (String(k).toLowerCase() === key) return k
        }
        return null
    }

    function _markSection(host, section) {
        if (!host) return host
        host.dataset.aesStrategySection = section
        host.classList.add("aes-strategy-section")
        host.style.scrollMarginTop = "84px"
        return host
    }

    function _resetSectionHosts() {
        _state.summaryHost   = _markSection(_el("div", ""), "overview")
        _state.readinessHost = _markSection(_el("div", ""), "readiness")
        _state.settingsHost  = _markSection(_el("div", ""), "settings")
        _state.tuningHost    = _markSection(_el("div", ""), "settings")
        _state.overlapHost   = _markSection(_el("div", ""), "overview")
        _state.decisionsHost = _markSection(_el("div", "flex:0 0 auto;overflow:visible;"), "decisions")
        _state.aircraftHost  = _markSection(_el("div", "border-top:1px solid " + COLOR.rule + ";"), "aircraft")
        _state.learningHost  = _markSection(_el("div", "border-top:1px solid " + COLOR.rule + ";"), "learning")
        _state.journalHost   = _markSection(_el("div", "border-top:1px solid " + COLOR.rule + ";"), "journal")
    }

    function _appendSectionHosts() {
        _state.bodyHost.append(_state.summaryHost, _state.readinessHost, _state.settingsHost,
                               _state.tuningHost, _state.overlapHost,
                               _state.decisionsHost, _state.aircraftHost, _state.learningHost,
                               _state.journalHost)
    }

    function _renderSectionMenu(host) {
        if (!host) return
        host.textContent = ""
        const wrap = _el("div", [
            "display:flex","align-items:center","gap:6px","flex-wrap:wrap",
            "padding:8px 16px","border-bottom:1px solid " + COLOR.rule,
            "background:#111827"
        ].join(";"))
        const active = _normaliseSection(_state.focusSection) || "overview"
        for (const item of SECTION_MENU) {
            const isActive = item.id === active
            const btn = _el("button", [
                "background:" + (isActive ? COLOR.accent : COLOR.chipBg),
                "color:" + (isActive ? COLOR.bg : COLOR.text),
                "border:1px solid " + (isActive ? COLOR.accent : COLOR.rule),
                "border-radius:4px",
                "padding:5px 10px",
                "font:600 11px sans-serif",
                "letter-spacing:0.04em",
                "text-transform:uppercase",
                "cursor:pointer"
            ].join(";"), item.label)
            btn.type = "button"
            btn.dataset.aesStrategyMenu = item.id
            if (isActive) btn.dataset.active = "1"
            btn.addEventListener("click", () => _focusSection(item.id))
            wrap.appendChild(btn)
        }
        host.appendChild(wrap)
    }

    function _focusSection(section, opts) {
        const targetSection = _normaliseSection(section) || "overview"
        _state.focusSection = targetSection
        _renderSectionMenu(_state.menuHost)
        if (targetSection === "journal" && _state.journalHost) {
            if (!_state.journalHost._aesJournalState) {
                _state.journalHost._aesJournalState = {expanded: true, filter: "all", search: ""}
            } else {
                _state.journalHost._aesJournalState.expanded = true
            }
            void _renderJournalSection(_state.journalHost)
        }
        if (!_state.overlay) return false
        const target = _state.overlay.querySelector('[data-aes-strategy-section="' + targetSection + '"]')
        if (!target) return false
        const instant = !!(opts && opts.instant)
        setTimeout(() => {
            try { target.scrollIntoView({behavior: instant ? "auto" : "smooth", block: "start"}) }
            catch (_) { try { target.scrollIntoView() } catch (__) {} }
            try {
                target.style.boxShadow = "inset 3px 0 0 " + COLOR.accent
                if (_state.focusTimer) clearTimeout(_state.focusTimer)
                _state.focusTimer = setTimeout(() => {
                    try { target.style.boxShadow = "" } catch (_) {}
                    _state.focusTimer = null
                }, 1200)
            } catch (_) {}
        }, 0)
        return true
    }

    function _applyOpenOptions(opts) {
        opts = opts || {}
        let filterChanged = false
        if (opts.filter && typeof opts.filter === "object") {
            _state.filter = _copyFilter(Object.assign({}, _state.filter || _copyFilter(), opts.filter))
            filterChanged = true
        }
        const domain = _normaliseDomain(opts.domain || opts.kind)
        if (domain) {
            if (_state.filter.domain !== domain) filterChanged = true
            _state.filter.domain = domain
            _state.focusSection = "decisions"
        }
        if (opts.search != null) {
            const v = String(opts.search)
            if (_state.filter.search !== v) filterChanged = true
            _state.filter.search = v
        }
        if (opts.sort != null) {
            const v = String(opts.sort)
            const next = (v === "impact" || v === "hub") ? v : "order"
            if (_state.filter.sort !== next) filterChanged = true
            _state.filter.sort = next
        }
        for (const key of ["applicableOnly", "advisoryOnly", "selectedOnly"]) {
            if (opts[key] != null) {
                const v = !!opts[key]
                if (_state.filter[key] !== v) filterChanged = true
                _state.filter[key] = v
            }
        }
        if (_state.filter.applicableOnly && _state.filter.advisoryOnly) {
            _state.filter.advisoryOnly = false
            filterChanged = true
        }
        _state.filter = _copyFilter(_state.filter)
        const section = _normaliseSection(opts.section || opts.focus || opts.tab)
        if (section) _state.focusSection = section
        return {filterChanged: filterChanged, section: section || _state.focusSection}
    }

    async function _applyScopeOptions(opts) {
        opts = opts || {}
        const optServer  = opts.server || null
        const optAirline = opts.airlineCode || opts.airline || opts.airlineIdentity || null
        let changed = false
        if (optServer && optServer !== _state.server) {
            if (_state.knownServers.indexOf(optServer) < 0) {
                _state.knownServers = _state.knownServers.concat([optServer]).sort()
            }
            _state.server = optServer
            _state.portfolio = await _scanPortfolio(_state.server)
            _state.airline = _defaultAirline(_state.portfolio)
            _state.selected.clear()
            changed = true
        }
        if (optAirline) {
            if (!_state.portfolio) _state.portfolio = await _scanPortfolio(_state.server)
            const match = ((_state.portfolio && _state.portfolio.airlines) || [])
                .find(a => a.airline === optAirline || a.displayName === optAirline)
            const nextAirline = match ? match.airline : optAirline
            if (nextAirline !== _state.airline) {
                _state.airline = nextAirline
                _state.selected.clear()
                changed = true
            }
        }
        return changed
    }

    // ── Store readiness ──────────────────────────────────────────────────

    /**
     * Render the store-readiness diagnostic. Sits at the top of the body
     * (right under the count chips) so the user sees "what's empty and
     * why" before scrolling. Auto-expanded when any store reports empty
     * or partial; collapsed once everything is filled. The "Seed all
     * missing" button is the same code path as the auto-seed-on-open
     * flow — running it twice is idempotent (the markets scraper short-
     * circuits on cache hits, etc.).
     */
    async function _renderReadiness(host) {
        host.textContent = ""
        if (!window.AesStrategyStoreReadiness) return
        const wrap = _el("div", [
            "padding:8px 16px","border-bottom:1px solid " + COLOR.rule,
            "background:#0b1220"
        ].join(";"))
        host.appendChild(wrap)

        // Scope-vs-session mismatch banner. The remote-refresh foundation
        // phase opens /app/fleets in a background tab — that URL binds to
        // whatever airline the AS session is currently logged into. If the
        // panel is scoped to a different airline (sister, alliance pick),
        // every "Fetch …" button below silently scrapes the session airline
        // instead. Surface that loudly here so the user doesn't misread the
        // empty rows as "scrape failed" when they're actually "scrape went
        // to the wrong airline".
        const pageAirlineForReadiness = _currentPageAirline()
        const scopeAirline = _state.airline
        const norm = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase()
        const scopeMismatch = !!(scopeAirline && pageAirlineForReadiness
            && norm(scopeAirline) !== norm(pageAirlineForReadiness))
        if (scopeMismatch) {
            const banner = _el("div", [
                "padding:8px 10px","margin-bottom:8px","border-radius:4px",
                "background:rgba(239, 68, 68, 0.10)",
                "border:1px solid rgba(239, 68, 68, 0.40)",
                "color:#fca5a5","font:11px sans-serif","line-height:1.5"
            ].join(";"))
            banner.appendChild(_el("strong", "color:#fecaca;font-weight:600;",
                "⚠ Scope mismatch — seeds will hit the wrong airline"))
            banner.appendChild(_el("div", "margin-top:4px;color:#fca5a5;",
                "Panel is scoped to " + scopeAirline + " but the AS session on this tab is "
                + pageAirlineForReadiness + ". The Fetch buttons below open background tabs that "
                + "inherit the session airline, so they'll scrape " + pageAirlineForReadiness
                + "'s data — not " + scopeAirline + "'s. Switch airline in the AS masthead first, "
                + "or change scope above to match the tab."))
            wrap.appendChild(banner)
        }

        // Probe + cache the items so the seed button can re-use the
        // same action callbacks without re-probing.
        let items = []
        try {
            items = await window.AesStrategyStoreReadiness.probe({
                snapshot:         _state.snapshot,
                server:           _state.server,
                airline:          _state.airline,
                accountId:        (_state.snapshot && _state.snapshot.accountId) || null,
                currentSchedules: _state.currentSchedules,
                portfolio:        _state.portfolio,
                fleetsDoc:        document
            })
        } catch (e) {
            wrap.appendChild(_el("p", "color:" + COLOR.err + ";font:12px sans-serif;",
                "Readiness probe threw: " + ((e && e.message) || String(e))))
            return
        }
        if (!Array.isArray(items)) {
            wrap.appendChild(_el("p", "color:" + COLOR.err + ";font:12px sans-serif;",
                "Readiness probe returned unexpected data. Refresh the page and try again."))
            items = []
        }

        const tallies = {filled: 0, partial: 0, empty: 0, missing: 0}
        for (const it of items) {
            if (it.status === "filled")        tallies.filled++
            else if (it.status === "partial")  tallies.partial++
            else if (it.status === "empty")    tallies.empty++
            else if (it.status === "module-missing") tallies.missing++
        }
        const seedables = items.filter(it =>
            it.action && it.action.kind === "seed" && it.status !== "filled")
        const everythingFilled = (tallies.empty === 0 && tallies.partial === 0 && tallies.missing === 0)

        const det = _el("details", "")
        det.open = !everythingFilled

        const sum = _el("summary", [
            "cursor:pointer","list-style:none","display:flex","align-items:center","gap:8px","flex-wrap:wrap"
        ].join(";"))
        sum.appendChild(_el("strong",
            "color:" + COLOR.accent + ";font:600 11px sans-serif;letter-spacing:0.06em;text-transform:uppercase;",
            "Store readiness"))
        const tallyBits = []
        if (tallies.filled)  tallyBits.push(tallies.filled  + " filled")
        if (tallies.partial) tallyBits.push(tallies.partial + " partial")
        if (tallies.empty)   tallyBits.push(tallies.empty   + " empty")
        if (tallies.missing) tallyBits.push(tallies.missing + " module missing")
        const tone =
            (tallies.empty + tallies.missing > 0) ? "warn" :
            (tallies.partial > 0)                ? "muted" : "ok"
        sum.appendChild(_badge(tallyBits.join(" · ") || "—",
            tone === "ok" ? "ok" : tone === "warn" ? "warn" : null))
        const hint = _el("span", "color:" + COLOR.muted + ";font:11px sans-serif;flex:1;min-width:200px;",
            everythingFilled
                ? "All inputs the proposers need are populated and fresh."
                : "Some stores are empty — proposers will return zero decisions until they're seeded.")
        sum.appendChild(hint)

        // "Seed all" button right on the summary line so the user can
        // act without expanding. Disabled while a seed is running.
        if (seedables.length) {
            const seedAllBtn = _btn("Seed all (" + seedables.length + ") →", true)
            seedAllBtn.style.padding = "4px 10px"
            seedAllBtn.style.fontSize = "11px"
            seedAllBtn.addEventListener("click", async (ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                await _runSeedThenRefresh({forceFull: true})
            })
            sum.appendChild(seedAllBtn)
        }
        det.appendChild(sum)

        // Per-row table
        const list = _el("div", "margin-top:8px;display:flex;flex-direction:column;gap:4px;")
        for (const it of items) list.appendChild(_renderReadinessRow(it))
        det.appendChild(list)
        wrap.appendChild(det)
    }

    function _renderReadinessRow(item) {
        const row = _el("div", [
            "display:flex","align-items:center","gap:8px","padding:4px 0",
            "border-bottom:1px dotted " + COLOR.rule,
            "color:" + COLOR.text,"font:12px sans-serif"
        ].join(";"))
        const tone =
            item.status === "filled" ? "ok" :
            item.status === "partial" ? "warn" :
            item.status === "module-missing" ? "muted" : "err"
        row.appendChild(_badge(item.status === "module-missing" ? "no module"
                              : item.status === "filled" ? "filled"
                              : item.status === "partial" ? "partial"
                              : "empty", tone))
        const labelCell = _el("span", "min-width:240px;color:" + COLOR.text + ";font-weight:600;", item.label)
        row.appendChild(labelCell)
        row.appendChild(_el("span", "color:" + COLOR.muted + ";flex:1;font-size:11px;", item.detail || ""))

        const action = item.action
        if (action) {
            if (action.kind === "seed") {
                const b = _btn(action.label, false)
                b.style.padding = "3px 8px"
                b.style.fontSize = "11px"
                b.addEventListener("click", async () => {
                    b.disabled = true
                    const orig = b.textContent
                    b.textContent = "Seeding…"
                    try {
                        await action.run({onProgress: (p) => {
                            if (p && p.sub) b.textContent = "Seeding " + p.sub
                        }})
                        await _refresh({skipSeed: true})
                    } catch (e) {
                        _toast("Seed failed: " + ((e && e.message) || String(e)), "err")
                        b.disabled = false
                        b.textContent = orig
                    }
                })
                row.appendChild(b)
            } else if (action.kind === "nav") {
                const a = _navLink(action.label, action.url)
                row.appendChild(a)
            } else if (action.kind === "nav-list") {
                const wrap = _el("span", "display:flex;flex-wrap:wrap;gap:4px;align-items:center;")
                if (action.label) {
                    wrap.appendChild(_el("span", "color:" + COLOR.muted + ";font:11px sans-serif;", action.label))
                }
                for (const it of (action.items || [])) {
                    wrap.appendChild(_navLink(it.label, it.url))
                }
                row.appendChild(wrap)
            }
        }
        // Always offer a direct AS-page link for stores that have a
        // canonical view URL, so the user can verify state by hand even
        // when the seed button is broken (wrong scope, rate limit, etc).
        // The action above may or may not be a nav — when it's a seed
        // the user otherwise has no escape hatch back to the AS page.
        const viewTarget = _readinessViewTarget(item)
        if (viewTarget && !(action && action.kind === "nav" && action.url === viewTarget.url)) {
            const view = _navLink(viewTarget.label, viewTarget.url)
            view.style.marginLeft = "4px"
            view.style.opacity = "0.75"
            view.title = "Open the AirlineSim page this store reads from"
            row.appendChild(view)
        }
        return row
    }

    /**
     * Canonical AirlineSim page each readiness store reads from. Returned
     * as a secondary nav link beside whatever auto-action the row already
     * offers, so the user can always see the source-of-truth page even
     * when the auto-seed is broken or the store has no auto path.
     */
    function _readinessViewTarget(item) {
        if (!item || !item.key) return null
        switch (item.key) {
            case "fleet":      return {label: "View /app/fleets",       url: "/app/fleets"}
            case "schedules":  return {label: "View /app/fleets",       url: "/app/fleets"}
            case "routes":     return {label: "View accounting",        url: "/app/finance/accounting/0"}
            case "crewPilots": return {label: "View staff",             url: "/action/enterprise/staffPilots"}
            // markets / ors are per-route — no single page summarises them
            // outcomes is in-extension only, no AS page
            default:           return null
        }
    }

    /** Build a same-server in-app nav link. Anchor (not <button>) so the
     *  user can middle-click into a new tab. */
    function _navLink(label, url) {
        const a = _el("a", [
            "color:" + COLOR.accent,"text-decoration:underline dotted","cursor:pointer",
            "font:11px sans-serif","padding:2px 6px","border:1px solid " + COLOR.rule,
            "border-radius:3px","background:" + COLOR.chipBg
        ].join(";"), label)
        const server = _state.server || _currentPageServer()
        const base = server ? ("https://" + server + ".airlinesim.aero") : ""
        const host = location && location.hostname || ""
        const localHarness = !/\.airlinesim\.aero$/i.test(host)
        a.href = localHarness ? url : (base + url)
        if (localHarness && base) a.dataset.aesExternalHref = base + url
        a.target = "_blank"
        a.rel = "noopener"
        return a
    }

    /**
     * Run seedMissing then compose. Used by the Refresh button (when the
     * user clicks it explicitly) and the first-open path. Other callers
     * (settings change, tuning slider) bypass via _refresh({skipSeed:true})
     * so a slider drag doesn't re-burn the network.
     *
     * On first-open the panel has no snapshot yet, so we do a quick
     * pre-compose to give the readiness probe something to enumerate
     * routes from — otherwise the markets seeder has no pairs to work
     * with and silently no-ops.
     */
    async function _runSeedThenRefresh(opts) {
        const o = opts || {}
        if (!window.AesStrategyStoreReadiness) {
            await _refresh({skipSeed: true})
            return
        }
        if (!_state.bodyHost) return
        _state.bodyHost.textContent = ""
        const banner = _el("div", "padding:32px;color:" + COLOR.muted + ";text-align:center;font:13px sans-serif;",
            "Composing initial snapshot…")
        _state.bodyHost.appendChild(banner)

        // Pre-compose if we don't have a snapshot — gives the route
        // enumerator a chance to find pairs from snapshot.hubs[] before
        // falling back to currentSchedules/portfolio/DOM.
        if (!_state.snapshot) {
            try {
                const composed = await _composePlan()
                _state.snapshot         = composed.snapshot
                _state.plan             = composed.plan
                _state.diff             = composed.diff
                _state.currentSchedules = composed.currentSchedules
            } catch (e) {
                console.warn("[AES strategy panel] pre-seed compose failed", e)
                // Fall through — seedMissing will still try whatever
                // sources it can find (currentSchedules, portfolio, DOM).
            }
        }

        try {
            const seedPromise = window.AesStrategyStoreReadiness.seedMissing({
                snapshot:         _state.snapshot,
                server:           _state.server,
                airline:          _state.airline,
                accountId:        (_state.snapshot && _state.snapshot.accountId) || null,
                currentSchedules: _state.currentSchedules,
                portfolio:        _state.portfolio,
                fleetsDoc:        document
            }, (p) => {
                if (!p) return
                if (p.stage === "start") {
                    banner.textContent = p.total
                        ? "Seeding " + p.total + " store" + (p.total === 1 ? "" : "s") + "…"
                        : "All stores already populated. Composing…"
                } else if (p.stage === "seeding") {
                    banner.textContent = "Seeding · " + (p.label || "?")
                        + " · " + ((p.done || 0) + 1) + "/" + p.total
                        + (p.sub ? " · " + p.sub : "")
                } else if (p.stage === "done") {
                    banner.textContent = "Composing snapshot + plan…"
                }
            })
            const settled = seedPromise
                .then(report => ({report}))
                .catch(error => ({error}))
            const seedResult = await Promise.race([
                settled,
                _delay(_seedTimeoutMs(o)).then(() => ({timeout: true}))
            ])
            if (seedResult.timeout) {
                banner.textContent = "Seeding is still running. Composing with current cache…"
                _toast("Strategy seeding is still running; showing the current cache.", "warn")
                settled.then(result => {
                    if (!_state.overlay) return
                    if (result && result.error) {
                        _toast("Background seed finished with an error: "
                            + ((result.error && result.error.message) || String(result.error)), "warn")
                    } else {
                        _toast("Background seed finished. Refresh to fold in the new data.", "ok")
                    }
                })
            } else if (seedResult.error) {
                console.warn("[AES strategy panel] seedMissing threw", seedResult.error)
            }
        } catch (e) {
            console.warn("[AES strategy panel] seedMissing threw", e)
        }
        await _refresh({skipSeed: true})
    }

    // ── Compose snapshot + plan ──────────────────────────────────────────

    /**
     * Load every per-aircraft current schedule from `AesAfpScheduleStore`
     * for the tails in the plan. Returns a `Map<aircraftId, legs[]>`
     * containing only the tails the store had cached — missing tails
     * are silently absent so `diffPlan` can fall back to its v1 stub
     * for those individually rather than for the whole plan.
     *
     * Per-aircraft schedules are persisted by the AFP page on every visit
     * (`schedule-broadcaster.js`), and by Fleet Schedule Grid's bulk
     * scrape — so the dashboard usually has data for every tail the user
     * has touched. Tails that have never been opened return null.
     */
    async function _loadCurrentSchedules(plan, server) {
        const out = new Map()
        if (!plan || !Array.isArray(plan.perAircraft) || !server) return out
        if (typeof window.AesAfpScheduleStore === "undefined"
                || typeof window.AesAfpScheduleStore.load !== "function") return out
        // Load in parallel — chrome.storage.local.get is the bottleneck and
        // a few hundred per-key gets in flight are fine.
        await Promise.all(plan.perAircraft.map(async a => {
            if (!a || !a.aircraftId) return
            try {
                const sched = await window.AesAfpScheduleStore.load(server, a.aircraftId)
                if (sched && Array.isArray(sched.legs) && sched.legs.length) {
                    out.set(String(a.aircraftId), sched.legs)
                }
            } catch (_) { /* missing tail → no entry, diffPlan falls back */ }
        }))
        return out
    }

    async function _composePlan() {
        const ns = window.AesStrategy
        if (!ns) throw new Error("AesStrategy not loaded")
        if (typeof ns.snapshot !== "function" || typeof ns.scoreRoutes !== "function"
                || typeof ns.allocateFleet !== "function" || typeof ns.diffPlan !== "function") {
            throw new Error("AesStrategy missing required APIs (snapshot/scoreRoutes/allocateFleet/diffPlan)")
        }
        // Per-account scope so sister A's learn / route-objective overrides
        // don't leak into B. Resolved once and threaded into snapshot opts so
        // context.js can scope its routeObjectives read in the same call.
        const acctId = await _scopedAccountId()
        const snapOpts = {}
        if (_state.server)  snapOpts.server      = _state.server
        if (_state.airline) snapOpts.airlineCode = _state.airline
        if (acctId)         snapOpts.accountId   = acctId
        const snapshot = await ns.snapshot(snapOpts)
        let weights = null
        if (window.AesStrategyLearn && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
            try { weights = await window.AesStrategyLearn.getCurrentWeights(acctId) } catch (_) { weights = null }
        }
        const scored   = ns.scoreRoutes(snapshot, weights || undefined)
        const plan     = await ns.allocateFleet(snapshot, scored, {})
        const currentSchedules = await _loadCurrentSchedules(plan, snapshot && snapshot.server)
        // Slice 12 — alliance & IL codeshare proposer threads in here.
        // Defensive (older installs without alliance.js degrade to []) and
        // best-effort (a proposer throw must never break plan composition).
        let allianceMoves = []
        if (typeof ns.proposeAllianceMoves === "function") {
            const allianceOpts = (snapshot && snapshot.strategySettings
                && snapshot.strategySettings.alliance
                && snapshot.strategySettings.alliance.proposers) || undefined
            try { allianceMoves = await ns.proposeAllianceMoves(snapshot, allianceOpts) }
            catch (e) {
                console.warn("[AesStrategy panel] proposeAllianceMoves threw", e)
                allianceMoves = []
            }
        }
        let advisory = []
        if (typeof ns.collectAdvisoryDecisions === "function") {
            try { advisory = await ns.collectAdvisoryDecisions(snapshot, {server: snapshot && snapshot.server}) }
            catch (e) { console.warn("[AesStrategy panel] collectAdvisoryDecisions threw", e) }
        }
        const diff     = ns.diffPlan(plan, snapshot, {currentSchedules, allianceMoves, advisoryDecisions: advisory})
        return {snapshot, scored, plan, diff, weights, currentSchedules, allianceMoves, advisory}
    }

    // ── Render ───────────────────────────────────────────────────────────

    function _renderHeader(host, plan, settings, diff) {
        host.textContent = ""
        const wrap = _el("div", [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:12px",
            "padding:12px 16px",
            "border-bottom:1px solid " + COLOR.rule,
            "background:#0b1220"
        ].join(";"))
        const left = _el("div", "display:flex;align-items:center;gap:10px;")
        const title = _el("h2", "margin:0;font:600 16px sans-serif;letter-spacing:0.04em;text-transform:uppercase;color:" + COLOR.text + ";", "Strategy preview")
        left.appendChild(title)

        const tier = settings ? settings.tier : "preview-only"
        const tone = tier === "preview-only" ? "warn" : (tier === "apply-auto" ? "err" : "ok")
        left.appendChild(_badge("tier · " + tier, tone))

        if (plan) {
            // Diff summary provides the complete aggregated dollar impact across all domains,
            // while plan.summary.predictedWeeklyProfit only sees initial schedule placements.
            const profit = (diff && diff.summary && typeof diff.summary.dollarImpactWeekly === "number")
                ? diff.summary.dollarImpactWeekly
                : (plan.summary && plan.summary.predictedWeeklyProfit)
            const ors    = plan.summary && plan.summary.predictedOrsAvg
            const sub = _el("span", "color:" + COLOR.muted + ";font:13px sans-serif;",
                            (plan.server || "?") + (plan.airlineCode ? " · " + plan.airlineCode : "")
                                + (plan.planId ? " · plan " + plan.planId : "")
                                + (profit != null ? " · pred $" + Math.round(profit).toLocaleString() + "/wk" : "")
                                + (ors != null ? " · ORS " + Number(ors).toFixed(2) : ""))
            left.appendChild(sub)

            // Data freshness pill — the most recent scrape backing the
            // scoped airline. Stale data (> 24h) is amber, very stale
            // (> 72h) is red. Tells the user when to revisit AFP/markets
            // before trusting the recommendations.
            const freshness = _scopedFreshnessMs()
            if (freshness != null) {
                const hours = freshness / 3_600_000
                const tone = hours > 72 ? COLOR.err
                          : hours > 24 ? COLOR.warn
                          : COLOR.muted
                const text = "Data " + _fmtAgo(Date.now() - freshness)
                const pill = _el("span", [
                    "display:inline-flex","align-items:center",
                    "padding:2px 8px","border-radius:10px",
                    "border:1px solid " + tone,"color:" + tone,
                    "background:" + (tone === COLOR.muted ? "transparent" : "rgba(245,158,11,0.10)"),
                    "font:600 10px sans-serif","letter-spacing:0.04em","text-transform:uppercase",
                    "margin-left:6px"
                ].join(";"), text)
                pill.title = "Most recent scrape across this airline's fleet + schedules"
                left.appendChild(pill)
            }
        }
        wrap.appendChild(left)

        const right = _el("div", "display:flex;align-items:center;gap:6px;")
        // Multi-account server picker — appears whenever 2+ servers have
        // cached strategy inputs. A single-server install shows nothing.
        if (Array.isArray(_state.knownServers) && _state.knownServers.length > 1) {
            const sel = _el("select", "background:" + COLOR.chipBg + ";color:" + COLOR.text
                + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:4px 6px;font:12px sans-serif;")
            const cur = _state.server || _currentPageServer()
            for (const s of _state.knownServers) {
                const o = _el("option", "", s)
                o.value = s
                if (s === cur) o.selected = true
                sel.appendChild(o)
            }
            sel.addEventListener("change", async () => {
                _state.server = sel.value
                _state.selected.clear()
                // New server → re-scan portfolio + reset airline scope.
                _state.portfolio = await _scanPortfolio(_state.server)
                _state.airline   = _defaultAirline(_state.portfolio)
                _refresh()
            })
            const lbl = _el("span", "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;margin-right:4px;", "Server")
            right.append(lbl, sel)
        }
        // Sister-airline picker — appears when 2+ airlines on the current
        // server have cached strategy data. The user picks one to scope
        // every downstream snapshot/plan/apply through that airline; the
        // engine never silently writes to a sister.
        const portfolioAirlines = (_state.portfolio && _state.portfolio.airlines) || []
        if (portfolioAirlines.length > 1) {
            const sel = _el("select", "background:" + COLOR.chipBg + ";color:" + COLOR.text
                + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:4px 6px;font:12px sans-serif;")
            const cur = _state.airline
            for (const a of portfolioAirlines) {
                const label = (a.displayName || a.airline)
                    + " · " + a.fleetCount + " tail" + (a.fleetCount === 1 ? "" : "s")
                const o = _el("option", "", label)
                o.value = a.airline
                if (a.airline === cur) o.selected = true
                sel.appendChild(o)
            }
            sel.addEventListener("change", () => {
                _state.airline = sel.value
                _state.selected.clear()
                _refresh()
            })
            const lbl = _el("span", "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;margin-right:4px;", "Airline")
            right.append(lbl, sel)

            // Scope-mismatch indicator: lights up red when the modal's
            // chosen airline differs from the active page tab. Apply
            // would post the modal's plan to the page's airline, so we
            // surface that risk upfront — not just at confirm time.
            const pageAirline = _currentPageAirline()
            const norm = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase()
            const mismatch = !!(pageAirline && cur && norm(pageAirline) !== norm(cur))
            const tabBadge = _el("span", [
                "display:inline-flex","align-items:center","gap:4px",
                "padding:2px 8px","border-radius:10px",
                "border:1px solid " + (mismatch ? COLOR.err : COLOR.rule),
                "color:" + (mismatch ? COLOR.err : COLOR.muted),
                "background:" + (mismatch ? "rgba(239,68,68,0.10)" : "transparent"),
                "font:600 10px sans-serif","letter-spacing:0.04em","text-transform:uppercase",
                "margin-left:4px"
            ].join(";"), (mismatch ? "⚠ Tab " : "Tab ") + (pageAirline || "?"))
            tabBadge.title = mismatch
                ? "Apply would hit the page tab's airline (" + pageAirline + "), not "
                  + cur + ". Switch tabs before applying."
                : "Tab and modal scope match."
            right.appendChild(tabBadge)
        }
        const refreshBtn = _btn("⟳ Refresh", false)
        // The Refresh button re-runs the auto-seed pump too — clicking it
        // is the user's signal that they want the freshest possible data.
        // Slider drags + lane-checkbox toggles bypass the seed step via
        // _refresh({skipSeed: true}) so we don't re-fetch on every tweak.
        refreshBtn.addEventListener("click", () => _runSeedThenRefresh())
        const closeBtn = _btn("Close", false)
        closeBtn.addEventListener("click", close)
        right.append(refreshBtn, closeBtn)
        wrap.appendChild(right)

        host.appendChild(wrap)
    }

    /**
     * Sister-overlap card (Slice 11). Surfaces hubs and routes the
     * scoped airline shares with another sister on the same server, so
     * the user can spot self-competition before applying. Read-only —
     * no decisions, just signal. Each shared route shows concrete
     * weekly leg counts ("me 7/wk · SisterB 5/wk") and is tagged
     * "⚠ planned" if the current plan would change something on it.
     * Returns null (host stays empty) when there's no scoped airline
     * or no overlap involving it.
     */
    function _renderOverlapCard(host) {
        host.textContent = ""
        const portfolio = _state.portfolio
        const me        = _state.airline
        if (!portfolio || !me) return
        const airlines  = portfolio.airlines || []
        if (airlines.length < 2) return

        // Filter overlaps to those that involve the currently scoped
        // airline — the user wants to know "what does my plan overlap
        // with my sisters", not "what do all sisters share among each
        // other".
        const myHubs = (portfolio.overlapHubs || []).filter(h => h.airlines.indexOf(me) >= 0)
        const myRoutes = (portfolio.overlapRoutes || []).filter(r => r.airlines.indexOf(me) >= 0)
        if (!myHubs.length && !myRoutes.length) return

        // Routes the current plan touches — used to highlight overlaps
        // the user is about to actively change vs. ones that are just
        // a steady-state coexistence.
        const plannedPairs = new Set()
        const decisions = (_state.diff && _state.diff.decisions) || []
        for (const d of decisions) {
            const p = d && d.payload
            if (p && p.hub && p.dest) {
                plannedPairs.add(String(p.hub).toUpperCase() + "-" + String(p.dest).toUpperCase())
            }
        }
        const plannedHubs = new Set()
        for (const r of myRoutes) {
            if (plannedPairs.has(r.route)) plannedHubs.add(r.route.split("-")[0])
        }

        const wrap = _el("div", [
            "padding:10px 16px","border-bottom:1px solid " + COLOR.rule,
            "background:#0b1220"
        ].join(";"))
        const head = _el("div", "display:flex;align-items:center;gap:8px;margin-bottom:6px;")
        head.appendChild(_el("strong",
            "color:" + COLOR.accent + ";font:600 11px sans-serif;letter-spacing:0.06em;text-transform:uppercase;",
            "Sister overlap"))
        const plannedRouteHits = myRoutes.filter(r => plannedPairs.has(r.route)).length
        const subBits = ["advisory · plan still applies only to " + me]
        if (plannedRouteHits > 0) {
            subBits.push(plannedRouteHits + " planned change"
                + (plannedRouteHits === 1 ? "" : "s") + " on shared routes")
        }
        head.appendChild(_el("span", "color:" + COLOR.muted + ";font:11px sans-serif;",
            subBits.join(" · ")))
        wrap.appendChild(head)

        const renderList = (label, items, makeChip) => {
            if (!items.length) return
            const block = _el("div", "margin-top:4px;font:12px sans-serif;color:" + COLOR.text + ";")
            block.appendChild(_el("span",
                "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;margin-right:6px;",
                label + " · " + items.length))
            const inner = _el("div", "display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;")
            for (const it of items.slice(0, 12)) inner.appendChild(makeChip(it))
            if (items.length > 12) {
                inner.appendChild(_el("span", "color:" + COLOR.muted + ";font:11px sans-serif;align-self:center;",
                    "+ " + (items.length - 12) + " more"))
            }
            block.appendChild(inner)
            wrap.appendChild(block)
        }

        const _chipBase = (planned) => [
            "display:inline-block","padding:2px 8px","border-radius:10px",
            "border:1px solid " + (planned ? COLOR.err : COLOR.warn),
            "color:" + (planned ? COLOR.err : COLOR.warn),
            "background:" + (planned ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.10)"),
            "font:600 11px sans-serif"
        ].join(";")

        renderList("Shared hubs", myHubs, (h) => {
            const planned = plannedHubs.has(h.iata)
            const sisters = h.airlines.filter(a => a !== me)
            const text = (planned ? "⚠ " : "") + h.iata + " · with " + sisters.join(", ")
            return _el("span", _chipBase(planned), text)
        })
        renderList("Shared routes", myRoutes, (r) => {
            const planned = plannedPairs.has(r.route)
            const sisters = r.airlines.filter(a => a !== me)
            const legs = r.legs || {}
            const myLegs = Number(legs[me]) || 0
            const sisterLegs = sisters.map(s => s + " " + (Number(legs[s]) || 0) + "/wk")
            const tail = "me " + myLegs + "/wk · " + sisterLegs.join(" · ")
            const text = (planned ? "⚠ " : "") + r.route + " · " + tail
            return _el("span", _chipBase(planned), text)
        })

        host.appendChild(wrap)
    }

    function _summaryFilterActive(filter) {
        const cur = _copyFilter(_state.filter)
        const next = _copyFilter(filter)
        return cur.domain === next.domain
            && cur.applicableOnly === next.applicableOnly
            && cur.advisoryOnly === next.advisoryOnly
            && !cur.selectedOnly
            && !(cur.search || "").trim()
    }

    function _setDecisionFilter(filter, opts) {
        const base = _copyFilter(_state.filter)
        const next = _copyFilter(Object.assign({}, base, filter || {}))
        if (filter && Object.prototype.hasOwnProperty.call(filter, "domain")) {
            next.search = ""
            next.selectedOnly = false
            if (!Object.prototype.hasOwnProperty.call(filter, "applicableOnly")) next.applicableOnly = false
            if (!Object.prototype.hasOwnProperty.call(filter, "advisoryOnly")) next.advisoryOnly = false
        }
        if (filter && (filter.applicableOnly || filter.advisoryOnly)) {
            next.search = ""
            next.selectedOnly = false
        }
        if (filter && filter.applicableOnly) next.advisoryOnly = false
        if (filter && filter.advisoryOnly) next.applicableOnly = false
        if (filter && Object.prototype.hasOwnProperty.call(filter, "applicableOnly")
                && !filter.applicableOnly) next.applicableOnly = false
        if (filter && Object.prototype.hasOwnProperty.call(filter, "advisoryOnly")
                && !filter.advisoryOnly) next.advisoryOnly = false
        if (next.domain !== "all") {
            next.applicableOnly = !!(filter && filter.applicableOnly)
            next.advisoryOnly = !!(filter && filter.advisoryOnly)
        }
        _state.filter = next
        if (_state.summaryHost && _state.diff) _renderSummaryStrip(_state.summaryHost, _state.diff)
        if (_state.decisionsHost && _state.diff) _renderDecisions(_state.decisionsHost, _state.diff)
        if (opts && opts.scroll && _state.decisionsHost && typeof _state.decisionsHost.scrollIntoView === "function") {
            try { _state.decisionsHost.scrollIntoView({behavior: "smooth", block: "start"}) } catch (_) {}
        }
    }

    function _renderSummaryStrip(host, diff) {
        host.textContent = ""
        const s = diff && diff.summary || {}
        const realDiff = s.scheduleDiffMode === "real"
        const items = [
            ["Schedules", s.byKind && s.byKind.schedule || 0, null, {domain: "schedule"}],
            ["Service",   s.byKind && s.byKind.service  || 0, null, {domain: "service"}],
            ["Pricing",   s.byKind && s.byKind.price    || 0, null, {domain: "price"}],
            ["Crew",      s.byKind && s.byKind.crew     || 0, null, {domain: "crew"}],
            ["New routes",s.byKind && s.byKind.routeCreation || 0, null, {domain: "routeCreation"}],
            ["Alliance",  s.byKind && s.byKind.alliance || 0, null, {domain: "alliance"}],
            ["Slot bids", s.byKind && s.byKind["slot-bid"] || 0, null, {domain: "slotBid"}],
            ["Applicable",s.applicableTotal || 0, null, {domain: "all", applicableOnly: true}],
            ["Advisory",  s.advisoryTotal   || 0, null, {domain: "all", advisoryOnly: true}]
        ]
        // Schedule-leg diff chips appear only when we have real cached
        // schedules — otherwise the numbers would be misleading.
        if (realDiff) {
            items.push(["+ Legs",  s.addedLegs   || 0, "ok"])
            items.push(["- Legs",  s.removedLegs || 0, "err"])
            items.push(["= Kept",  s.keptLegs    || 0, "muted"])
            if (s.lockedLegs)
                items.push(["Locked", s.lockedLegs, "warn"])
        }
        const row = _el("div", "display:flex;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid " + COLOR.rule + ";align-items:center;")
        for (const [label, n, tone, filter] of items) {
            const accent = tone === "ok"   ? COLOR.ok
                        : tone === "err"   ? COLOR.err
                        : tone === "warn"  ? COLOR.warn
                        : tone === "muted" ? COLOR.muted
                        : COLOR.text
            const active = filter && _summaryFilterActive(filter)
            const chip = _el(filter ? "button" : "div", [
                "display:flex",
                "flex-direction:column",
                "align-items:center",
                "justify-content:center",
                "padding:6px 10px",
                "background:" + COLOR.chipBg,
                "border:1px solid " + (active ? COLOR.accent : (tone ? accent : COLOR.rule)),
                "border-radius:4px",
                "min-width:64px",
                "color:" + COLOR.text,
                filter ? "cursor:pointer" : "",
                filter ? "text-align:center" : ""
            ].join(";"))
            if (filter) {
                chip.type = "button"
                chip.dataset.aesStrategyFilter = filter.domain || "all"
                chip.dataset.active = active ? "1" : "0"
                chip.title = "Show " + label.toLowerCase() + " decisions"
                chip.addEventListener("click", () => _setDecisionFilter(filter, {scroll: true}))
            }
            chip.appendChild(_el("span", "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;", label))
            chip.appendChild(_el("span", "color:" + accent + ";font:600 16px sans-serif;", String(n)))
            row.appendChild(chip)
        }
        // Diff coverage / fallback banner — tells the user at a glance
        // whether the diff numbers are real or v1-stub for some tails.
        if (s.byKind && s.byKind.schedule) {
            const note = _el("span", "color:" + COLOR.muted + ";font:11px sans-serif;margin-left:6px;")
            if (realDiff && s.aircraftMissingDiff) {
                note.style.color = COLOR.warn
                note.textContent = "diff: " + s.aircraftWithDiff + " of "
                    + (s.aircraftWithDiff + s.aircraftMissingDiff)
                    + " tails (open AFP page for the rest to seed cached schedules)"
            } else if (realDiff) {
                note.textContent = "diff: real (" + s.aircraftWithDiff + " tails)"
            } else {
                note.style.color = COLOR.warn
                note.textContent = "diff: stub — no cached schedules; +legs counts every plan leg"
            }
            row.appendChild(note)
        }
        host.appendChild(row)
    }

    function _renderSettingsStrip(host, settings) {
        host.textContent = ""
        if (!window.AesStrategySettings) {
            host.appendChild(_emptyState("Settings store missing — flip slices manually."))
            return
        }
        const wrap = _el("div", [
            "display:flex","align-items:center","gap:10px","flex-wrap:wrap",
            "padding:10px 16px","border-bottom:1px solid " + COLOR.rule,
            "background:#0b1220"
        ].join(";"))

        // Tier select
        const tierLbl = _el("label", "color:" + COLOR.muted + ";font:600 11px sans-serif;letter-spacing:0.04em;text-transform:uppercase;", "Tier")
        const tierSel = _el("select", "background:" + COLOR.chipBg + ";color:" + COLOR.text + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:4px 6px;font:12px sans-serif;")
        for (const t of window.AesStrategySettings.TIERS) {
            const o = _el("option", "", t)
            o.value = t
            if (settings.tier === t) o.selected = true
            tierSel.appendChild(o)
        }
        tierSel.addEventListener("change", async () => {
            await window.AesStrategySettings.save({tier: tierSel.value})
            _state.settings = await window.AesStrategySettings.load()
            _renderHeader(_state.headerHost, _state.plan, _state.settings, _state.diff)
            _renderSettingsStrip(_state.settingsHost, _state.settings)
            _renderFooter(_state.footerHost)
        })
        wrap.append(tierLbl, tierSel)

        // Objective selector (Slice S1)
        const sep1 = _el("span", "color:" + COLOR.rule + ";", "│")
        wrap.appendChild(sep1)
        const objLbl = _el("label", "color:" + COLOR.muted + ";font:600 11px sans-serif;letter-spacing:0.04em;text-transform:uppercase;", "Goal")
        const objSel = _el("select", "background:" + COLOR.chipBg + ";color:" + COLOR.text + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:4px 6px;font:12px sans-serif;")
        const OBJ_LABELS = {maxShare: "Max market share", maxProfit: "Max profit", balanced: "Balanced", custom: "Custom"}
        const kinds = (window.AesStrategySettings && window.AesStrategySettings.OBJECTIVE_KINDS)
            || ["maxShare", "maxProfit", "balanced", "custom"]
        const currentKind = (settings && settings.objective && settings.objective.kind) || "balanced"
        for (const k of kinds) {
            const o = _el("option", "", OBJ_LABELS[k] || k)
            o.value = k
            if (currentKind === k) o.selected = true
            objSel.appendChild(o)
        }
        objSel.addEventListener("change", async () => {
            const next = Object.assign({}, settings.objective || {kind: "balanced"})
            next.kind = objSel.value
            await window.AesStrategySettings.save({objective: next})
            _state.settings = await window.AesStrategySettings.load()
            // Recompose so the proposers re-rank under the new objective.
            await _refresh()
        })
        wrap.append(objLbl, objSel)

        // When custom, surface three tiny number inputs for the weights.
        if (currentKind === "custom") {
            const cust = (settings && settings.objective && settings.objective.custom)
                || {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
            const mkSlider = (label, key) => {
                const span = _el("span", "display:inline-flex;align-items:center;gap:4px;color:" + COLOR.muted + ";font:11px sans-serif;")
                span.appendChild(_el("span", "", label))
                const inp = _el("input")
                inp.type = "number"
                inp.min = "0"
                inp.max = "1"
                inp.step = "0.05"
                inp.value = String(_round(cust[key] != null ? cust[key] : 0, 2))
                inp.style.cssText = "width:50px;background:" + COLOR.chipBg + ";color:" + COLOR.text
                    + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:2px 4px;font:11px sans-serif;"
                inp.addEventListener("change", async () => {
                    const v = Math.max(0, Math.min(1, Number(inp.value) || 0))
                    const nextCustom = Object.assign({}, cust, {[key]: v})
                    await window.AesStrategySettings.save({objective: {kind: "custom", custom: nextCustom}})
                    _state.settings = await window.AesStrategySettings.load()
                    await _refresh()
                })
                span.appendChild(inp)
                return span
            }
            wrap.append(mkSlider("share", "shareWeight"))
            wrap.append(mkSlider("profit", "profitWeight"))
            wrap.append(mkSlider("rank", "rankWeight"))
        }

        // Per-domain flags
        const sep2 = _el("span", "color:" + COLOR.rule + ";", "│")
        wrap.appendChild(sep2)
        const flagDefs = [
            ["scheduleApplyEnabled", "Schedules"],
            ["serviceMovesEnabled",  "Service"],
            ["priceMovesEnabled",    "Pricing"],
            ["crewMovesEnabled",     "Crew"],
            ["routeCreationEnabled", "New routes"],
            ["allianceMovesEnabled", "Alliance"],
            ["slotBidApplyEnabled",  "Slot bids"],
            ["crossAirlineEnabled",  "X-airline hints"]
        ]
        for (const [key, label] of flagDefs) {
            const lbl = _el("label", "display:inline-flex;align-items:center;gap:4px;color:" + COLOR.text + ";font:12px sans-serif;cursor:pointer;")
            const cb = _el("input")
            cb.type = "checkbox"
            cb.checked = !!settings[key]
            cb.addEventListener("change", async () => {
                await window.AesStrategySettings.save({[key]: cb.checked})
                _state.settings = await window.AesStrategySettings.load()
                _renderFooter(_state.footerHost)
            })
            lbl.append(cb, _el("span", "", label))
            wrap.appendChild(lbl)
        }

        const sep3 = _el("span", "color:" + COLOR.rule + ";", "│")
        wrap.appendChild(sep3)
        const seedLbl = _el("label", "display:inline-flex;align-items:center;gap:4px;color:" + COLOR.text + ";font:12px sans-serif;cursor:pointer;")
        const seedCb = _el("input")
        seedCb.type = "checkbox"
        seedCb.checked = !settings.autoSeedDisabled
        seedCb.addEventListener("change", async () => {
            await window.AesStrategySettings.save({autoSeedDisabled: !seedCb.checked})
            _state.settings = await window.AesStrategySettings.load()
            _renderSettingsStrip(_state.settingsHost, _state.settings)
        })
        seedLbl.append(seedCb, _el("span", "", "Auto-seed on open"))
        wrap.appendChild(seedLbl)
        host.appendChild(wrap)
    }

    function _round(v, d) {
        const f = Math.pow(10, d || 0)
        return Math.round((Number(v) || 0) * f) / f
    }

    /**
     * Apply the user's filter+sort to the decision list. Pure function
     * over `_state.filter` — search is case-insensitive substring match
     * over title + subtitle + rationale; sort by impact ranks $/wk
     * decisions descending and falls back to original order for non-$
     * decisions.
     */
    function _filteredDecisions(decisions) {
        const f = _copyFilter(_state.filter)
        _state.filter = f
        const q = (f.search || "").trim().toLowerCase()
        const domain = (f.domain && f.domain !== "all") ? f.domain : null
        const out = decisions.filter(d => {
            if (domain && d.domain !== domain) return false
            if (f.applicableOnly && !d.applicable) return false
            if (f.advisoryOnly   && d.applicable) return false
            if (f.selectedOnly   && !_state.selected.has(d.id)) return false
            if (q) {
                const haystack = [
                    d.title || "", d.subtitle || "", d.domain || "",
                    DOMAIN_LABEL[d.domain] || "",
                    Array.isArray(d.rationale) ? d.rationale.join(" ") : ""
                ].join(" ").toLowerCase()
                if (haystack.indexOf(q) < 0) return false
            }
            return true
        })
        if (f.sort === "impact") {
            out.sort((a, b) => {
                const av = a._impact && a._impact.unit === "$/wk" ? Number(a._impact.value) || 0 : -Infinity
                const bv = b._impact && b._impact.unit === "$/wk" ? Number(b._impact.value) || 0 : -Infinity
                return bv - av
            })
        } else if (f.sort === "hub") {
            // Best-effort hub extraction: pull the first 3-letter caps token
            // from the title (works for schedule "[NXXX] B737 · ATL" hint
            // in subtitle, and for price/route titles "ATL → MCO").
            const hubOf = d => {
                const m = (d.title + " " + (d.subtitle || "")).match(/\b([A-Z]{3})\b/)
                return m ? m[1] : "ZZZ"
            }
            out.sort((a, b) => {
                const ah = hubOf(a), bh = hubOf(b)
                if (ah !== bh) return ah < bh ? -1 : 1
                return a.id < b.id ? -1 : 1
            })
        }
        return out
    }

    /**
     * Per-route objective override strip — read/write
     * `aesStrategy:routeObjective:<HUB>-<DEST>` so the proposers pick up
     * a per-route goal next refresh. Cached look-up uses the snapshot's
     * routeObjectives map so we don't pound storage on every re-render.
     */
    function _buildOverrideStrip(decision, refresh) {
        const wrap = _el("div", "display:flex;align-items:center;gap:6px;margin-top:4px;color:" + COLOR.muted + ";font:11px sans-serif;")
        const hub  = String(decision.payload.hub).toUpperCase()
        const dest = String(decision.payload.dest).toUpperCase()
        const k    = hub + "-" + dest
        const map  = (_state.snapshot && _state.snapshot.routeObjectives) || null
        const cur  = map && (typeof map.get === "function" ? map.get(k) : map[k])
        const curKind = (cur && cur.kind) || "(global)"
        wrap.appendChild(_el("span", "color:" + COLOR.muted + ";", "Goal override:"))
        const sel = _el("select", "background:" + COLOR.chipBg + ";color:" + COLOR.text + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:1px 4px;font:11px sans-serif;")
        const OBJ_LABELS = {maxShare: "Max market share", maxProfit: "Max profit", balanced: "Balanced", custom: "Custom"}
        const opts = [["", "(use global)"], ["maxShare", OBJ_LABELS.maxShare], ["maxProfit", OBJ_LABELS.maxProfit], ["balanced", OBJ_LABELS.balanced]]
        for (const [val, label] of opts) {
            const opt = _el("option", "", label)
            opt.value = val
            if (curKind === val || (val === "" && !cur)) opt.selected = true
            sel.appendChild(opt)
        }
        sel.addEventListener("change", async (ev) => {
            ev.preventDefault()
            const acctId = (_state.snapshot && _state.snapshot.accountId) || null
            try {
                if (sel.value === "") {
                    await window.AesStrategyRouteObjectiveStore.remove(hub, dest, acctId)
                } else {
                    await window.AesStrategyRouteObjectiveStore.save(hub, dest, {kind: sel.value}, acctId)
                }
            } catch (e) {
                console.warn("[AES strategy panel] route objective override write failed", e)
            }
            await refresh()
        })
        // Stop click propagation so clicking the dropdown doesn't toggle
        // the row checkbox.
        sel.addEventListener("click", (ev) => { ev.stopPropagation() })
        wrap.appendChild(sel)
        return wrap
    }

    /**
     * Per-row pin control. When clicked, prompts for a price pct, writes
     * `pricePin` to RouteAssistantRouteOverridesStore, and refreshes — the
     * route then drops out of price decisions until the user clears it.
     */
    function _buildPinControl(decision, refresh) {
        const wrap = _el("span", "display:inline-flex;align-items:center;gap:6px;margin-left:8px;")
        const hub  = String(decision.payload.hub).toUpperCase()
        const dest = String(decision.payload.dest).toUpperCase()
        const proposedPct = Number(decision.payload.toPct)
        const btn = _el("button", [
            "background:" + COLOR.chipBg, "color:" + COLOR.accent,
            "border:1px solid " + COLOR.rule, "border-radius:3px",
            "padding:2px 8px", "font:600 11px sans-serif", "cursor:pointer"
        ].join(";"), "Pin @ " + (isFinite(proposedPct) ? proposedPct : "?") + "%")
        btn.title = "Pin this route's price; auto-driver will not touch it until cleared."
        btn.addEventListener("click", async (ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            if (typeof window.RouteAssistantRouteOverridesStore !== "function"
                && typeof RouteAssistantRouteOverridesStore === "undefined") {
                alert("Route override store unavailable.")
                return
            }
            const Store = window.RouteAssistantRouteOverridesStore
                       || (typeof RouteAssistantRouteOverridesStore !== "undefined"
                           ? RouteAssistantRouteOverridesStore : null)
            if (!Store) return
            const seed = isFinite(proposedPct) ? proposedPct : 100
            const raw = window.prompt(
                "Pin " + hub + "-" + dest + " price at what %? (50–200, blank to cancel)",
                String(seed))
            if (raw == null || raw === "") return
            const v = Number(raw)
            if (!isFinite(v) || v < 50 || v > 200) {
                alert("Pin must be a number between 50 and 200.")
                return
            }
            try {
                await Store.save(hub, dest, {pricePin: v})
            } catch (e) {
                console.warn("[AES strategy panel] pricePin save failed", e)
                return
            }
            await refresh()
        })
        wrap.appendChild(btn)
        return wrap
    }

    /**
     * Active price pins strip — one row summarising routes the user has
     * pinned, with a Clear button per pin. Reads from the snapshot's
     * per-route `override.pricePin` (wired via context.js _attachOverrides).
     */
    function _buildActivePinsStrip(refresh) {
        const snap = _state.snapshot
        if (!snap || !Array.isArray(snap.hubs)) return null
        const pins = []
        for (const h of snap.hubs) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                const pct = r && r.override && r.override.pricePin
                if (pct != null && isFinite(pct)) {
                    pins.push({hub: h.iata, dest: r.dest, pct: pct})
                }
            }
        }
        if (!pins.length) return null
        const Store = window.RouteAssistantRouteOverridesStore
                   || (typeof RouteAssistantRouteOverridesStore !== "undefined"
                       ? RouteAssistantRouteOverridesStore : null)
        const wrap = _el("div", [
            "display:flex","align-items:center","flex-wrap:wrap","gap:6px",
            "padding:8px 12px","border:1px solid " + COLOR.rule,
            "border-radius:4px","margin-bottom:8px",
            "background:rgba(255,255,255,0.02)",
            "color:" + COLOR.muted, "font:11px sans-serif"
        ].join(";"))
        wrap.appendChild(_el("span", "color:" + COLOR.accent + ";font-weight:600;letter-spacing:0.04em;text-transform:uppercase;",
            "Pinned (" + pins.length + ")"))
        for (const p of pins) {
            const chip = _el("span", [
                "display:inline-flex","align-items:center","gap:4px",
                "padding:2px 6px","border:1px solid " + COLOR.rule,
                "border-radius:3px","background:" + COLOR.chipBg,
                "color:" + COLOR.text
            ].join(";"))
            chip.appendChild(_el("span", "", p.hub + "-" + p.dest + " @ " + Math.round(p.pct) + "%"))
            const x = _el("button", [
                "background:transparent","color:" + COLOR.warn,
                "border:none","padding:0 2px","cursor:pointer",
                "font:600 11px sans-serif"
            ].join(";"), "✕")
            x.title = "Clear pin (auto-driver resumes)"
            x.addEventListener("click", async (ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                if (!Store) return
                try {
                    const cur = await Store.get(p.hub, p.dest)
                    const next = Object.assign({}, cur || {})
                    delete next.pricePin
                    delete next.createdAt
                    delete next.updatedAt
                    delete next.hub
                    delete next.dest
                    if (Object.keys(next).length === 0) {
                        await Store.remove(p.hub, p.dest)
                    } else {
                        await Store.save(p.hub, p.dest, next)
                    }
                } catch (e) {
                    console.warn("[AES strategy panel] pricePin clear failed", e)
                    return
                }
                await refresh()
            })
            chip.appendChild(x)
            wrap.appendChild(chip)
        }
        return wrap
    }

    function _renderDecisions(host, diff) {
        host.textContent = ""
        const decisions = (diff && diff.decisions) || []
        const noDecisions = !decisions.length
        const visible = _filteredDecisions(decisions)
        // Group by domain (over the already-filtered list)
        const groups = new Map()
        for (const d of visible) {
            if (!groups.has(d.domain)) groups.set(d.domain, [])
            groups.get(d.domain).push(d)
        }

        // Filter + sort toolbar
        const filterBar = _el("div", [
            "display:flex","gap:8px","padding:10px 16px 0","align-items:center","flex-wrap:wrap",
            "color:" + COLOR.muted,"font:12px sans-serif"
        ].join(";"))
        const search = _el("input")
        search.type = "search"
        search.placeholder = "Search decisions (hub, route, rationale)…"
        search.value = _state.filter.search
        search.style.cssText = "flex:1;min-width:220px;padding:5px 8px;background:" + COLOR.chipBg
            + ";color:" + COLOR.text + ";border:1px solid " + COLOR.rule
            + ";border-radius:3px;font:12px sans-serif;"
        search.addEventListener("input", () => {
            _state.filter.search = search.value
            _renderDecisions(host, diff)
            if (_state.summaryHost) _renderSummaryStrip(_state.summaryHost, diff)
        })
        filterBar.appendChild(search)

        const domainLbl = _el("label", "display:inline-flex;align-items:center;gap:4px;color:" + COLOR.text + ";")
        domainLbl.appendChild(_el("span", "color:" + COLOR.muted + ";font-size:11px;text-transform:uppercase;letter-spacing:0.04em;", "Domain"))
        const domainSel = _el("select", "background:" + COLOR.chipBg + ";color:" + COLOR.text + ";border:1px solid "
            + COLOR.rule + ";border-radius:3px;padding:5px 8px;font:12px sans-serif;")
        domainSel.dataset.aesStrategyDomainFilter = "1"
        const domainOptions = [["all", "All domains"]]
            .concat(DOMAIN_ORDER.map(k => [k, DOMAIN_LABEL[k]]))
        for (const [value, label] of domainOptions) {
            const o = _el("option", "", label)
            o.value = value
            if ((_state.filter.domain || "all") === value) o.selected = true
            domainSel.appendChild(o)
        }
        domainSel.addEventListener("change", () => {
            _setDecisionFilter({domain: domainSel.value || "all", applicableOnly: false, advisoryOnly: false}, {scroll: false})
        })
        domainLbl.appendChild(domainSel)
        filterBar.appendChild(domainLbl)

        const toggle = (label, key) => {
            const lbl = _el("label", "display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:" + COLOR.text + ";")
            const cb = _el("input")
            cb.type = "checkbox"
            cb.checked = !!_state.filter[key]
            cb.addEventListener("change", () => {
                _state.filter = _copyFilter(_state.filter)
                _state.filter[key] = cb.checked
                if (key === "applicableOnly" && cb.checked) _state.filter.advisoryOnly = false
                if (key === "advisoryOnly" && cb.checked) _state.filter.applicableOnly = false
                _renderDecisions(host, diff)
                if (_state.summaryHost) _renderSummaryStrip(_state.summaryHost, diff)
            })
            lbl.append(cb, _el("span", "", label))
            return lbl
        }
        filterBar.appendChild(toggle("Applicable only", "applicableOnly"))
        filterBar.appendChild(toggle("Advisory only",   "advisoryOnly"))
        filterBar.appendChild(toggle("Selected only",   "selectedOnly"))

        const sortLbl = _el("label", "display:inline-flex;align-items:center;gap:4px;color:" + COLOR.text + ";")
        sortLbl.appendChild(_el("span", "color:" + COLOR.muted + ";font-size:11px;text-transform:uppercase;letter-spacing:0.04em;", "Sort"))
        const sortSel = _el("select", "background:" + COLOR.chipBg + ";color:" + COLOR.text + ";border:1px solid "
            + COLOR.rule + ";border-radius:3px;padding:3px 6px;font:12px sans-serif;")
        for (const [v, label] of [["order", "Order"], ["impact", "Impact $/wk"], ["hub", "Hub"]]) {
            const o = _el("option", "", label)
            o.value = v
            if (_state.filter.sort === v) o.selected = true
            sortSel.appendChild(o)
        }
        sortSel.addEventListener("change", () => {
            _state.filter.sort = sortSel.value
            _renderDecisions(host, diff)
        })
        sortLbl.appendChild(sortSel)
        filterBar.appendChild(sortLbl)
        const hasActiveFilter = !!((_state.filter.search || "").trim()
            || ((_state.filter.domain || "all") !== "all")
            || _state.filter.applicableOnly
            || _state.filter.advisoryOnly
            || _state.filter.selectedOnly)
        if (hasActiveFilter) {
            const clearBtn = _btn("Clear filters", false)
            clearBtn.dataset.aesStrategyClearFilters = "1"
            clearBtn.addEventListener("click", () => {
                _state.filter = _copyFilter({sort: _state.filter.sort})
                _renderDecisions(host, diff)
                if (_state.summaryHost) _renderSummaryStrip(_state.summaryHost, diff)
            })
            filterBar.appendChild(clearBtn)
        }
        host.appendChild(filterBar)

        if (!visible.length) {
            host.appendChild(_emptyState(noDecisions
                ? "No decisions in plan. Try refreshing after seeding stores on /app/com/scheduling/<HUB>."
                : "No decisions match the current filter."))
            return
        }

        // Bulk toggles row — operates on the filtered/visible list so the
        // user can "select all applicable in this filtered subset."
        const tools = _el("div", "display:flex;gap:6px;padding:10px 16px 6px;align-items:center;color:" + COLOR.muted + ";font:11px sans-serif;")
        const allBtn  = _btn("Select all applicable", false)
        allBtn.addEventListener("click", () => {
            for (const d of visible) if (d.applicable) _state.selected.add(d.id)
            _renderDecisions(host, diff)
            _renderFooter(_state.footerHost)
        })
        const noneBtn = _btn("Clear visible", false)
        noneBtn.addEventListener("click", () => {
            for (const d of visible) _state.selected.delete(d.id)
            _renderDecisions(host, diff)
            _renderFooter(_state.footerHost)
        })
        tools.append(allBtn, noneBtn)
        // Counts: visible / total
        if (visible.length !== decisions.length) {
            tools.appendChild(_el("span", "margin-left:6px;color:" + COLOR.muted + ";",
                visible.length + " of " + decisions.length + " shown"))
        }
        host.appendChild(tools)

        const list = _el("div", "padding:0 16px 16px;")
        const pinsStrip = _buildActivePinsStrip(_refresh)
        if (pinsStrip) list.appendChild(pinsStrip)
        // Domain-grouped only when sort = "order"; impact/hub sorts go
        // flat so the user can read the global ranking without domain
        // headings breaking the visual order.
        const grouped = _state.filter.sort === "order"
        const renderRow = d => {
            const row = _el("label", [
                "display:flex","gap:10px","padding:8px 0","cursor:" + (d.applicable ? "pointer" : "default"),
                "border-bottom:1px solid " + COLOR.rule,
                "opacity:" + (d.applicable ? "1" : "0.65")
            ].join(";"))
            const cb = _el("input")
            cb.type = "checkbox"
            cb.disabled = !d.applicable
            cb.checked  = _state.selected.has(d.id)
            cb.style.marginTop = "3px"
            cb.addEventListener("change", () => {
                if (cb.checked) _state.selected.add(d.id)
                else _state.selected.delete(d.id)
                _renderFooter(_state.footerHost)
            })
            row.appendChild(cb)

            const text = _el("div", "flex:1;min-width:0;")
            const titleLine = _el("div", "display:flex;gap:6px;align-items:center;color:" + COLOR.text + ";font:600 13px sans-serif;", d.title || "(decision)")
            if (!d.applicable) titleLine.appendChild(_badge("advisory", "warn"))
            // When sort != order, the domain heading goes away — surface
            // the domain inline as a tiny pill so the user still sees it.
            if (!grouped) titleLine.appendChild(_badge(DOMAIN_LABEL[d.domain] || d.domain, "muted"))
            text.appendChild(titleLine)
            if (d.subtitle) {
                text.appendChild(_el("div", "color:" + COLOR.muted + ";font:12px sans-serif;margin-top:2px;", d.subtitle))
            }
            if (Array.isArray(d.rationale) && d.rationale.length) {
                const ul = _el("ul", "margin:4px 0 0 18px;padding:0;color:" + COLOR.muted + ";font:11px/1.4 sans-serif;")
                for (const r of d.rationale.slice(0, 6)) ul.appendChild(_el("li", "", r))
                if (d.rationale.length > 6) ul.appendChild(_el("li", "color:" + COLOR.muted + ";font-style:italic;", "+ " + (d.rationale.length - 6) + " more"))
                text.appendChild(ul)
            }
            if (!d.applicable && d.applicableNote) {
                text.appendChild(_el("div", "color:" + COLOR.warn + ";font:11px sans-serif;margin-top:2px;", d.applicableNote))
            }
            if (d._result) {
                const r = d._result
                text.appendChild(_el("div",
                    "color:" + (r.ok ? COLOR.ok : COLOR.err) + ";font:11px sans-serif;margin-top:4px;",
                    (r.ok ? "✓ applied" : "✗ failed") + (r.error ? " — " + String(r.error).slice(0, 200) : "")))
                // Slice 12 — IL applier envelope: surface dry-run / verified
                // status, formAvailable hint, bodyPreview disclosure. Always
                // show bodyPreview when present (§11.6 "show me what'd post").
                if (d.domain === "alliance" && r.envelope) {
                    const env = r.envelope
                    const statusTone = (env.status === "verified" || env.status === "posted") ? COLOR.ok
                        : (env.status === "dry-run") ? COLOR.warn
                        : (env.status === "noop") ? COLOR.muted
                        : COLOR.err
                    text.appendChild(_el("div",
                        "color:" + statusTone + ";font:600 11px sans-serif;margin-top:4px;letter-spacing:0.04em;text-transform:uppercase;",
                        "status · " + env.status
                            + (env.formAvailable ? " · form found" : " · no form")
                            + (env.httpStatus != null ? " · HTTP " + env.httpStatus : "")))
                    if (env.warning) {
                        text.appendChild(_el("div",
                            "color:" + COLOR.warn + ";font:11px sans-serif;margin-top:2px;",
                            "⚠ " + String(env.warning).slice(0, 240)))
                    }
                    if (env.bodyPreview) {
                        const det = _el("details", "margin-top:4px;color:" + COLOR.muted + ";font:11px sans-serif;")
                        det.appendChild(_el("summary",
                            "cursor:pointer;color:" + COLOR.accent + ";",
                            "Preview body that would post"))
                        det.appendChild(_el("pre",
                            "white-space:pre-wrap;word-break:break-all;margin:4px 0 0;padding:6px 8px;"
                            + "background:rgba(255,255,255,0.04);border-radius:3px;font:11px monospace;color:" + COLOR.text + ";",
                            String(env.bodyPreview)))
                        text.appendChild(det)
                    }
                }
            }
            // Slice 12 — per-card affordance for alliance moves. il-request
            // routes through `AesStrategy.applyDecision` (single-decision
            // dispatch); alliance-join opens /app/alliance because AS lacks
            // a one-click join API.
            if (d.domain === "alliance") {
                const actions = _el("div",
                    "display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap;")
                const payloadKind = (d.payload && d.payload.kind) || null
                if (payloadKind === "il-request") {
                    const sendBtn = _btn("Send IL request", false)
                    sendBtn.addEventListener("click", async (ev) => {
                        ev.preventDefault()
                        ev.stopPropagation()
                        if (sendBtn.disabled) return
                        sendBtn.disabled = true
                        sendBtn.textContent = "Sending…"
                        try {
                            const ns = window.AesStrategy
                            if (!ns || typeof ns.applyDecision !== "function") {
                                d._result = {ok: false, error: "applyDecision not loaded"}
                            } else {
                                const ctx = {server: _state.server || _currentPageServer(),
                                              airlineCode: _state.airline || _currentPageAirline()}
                                const report = await ns.applyDecision(d, {ctx, source: "strategy-card"})
                                const env = report && Array.isArray(report.applied) && report.applied[0]
                                    ? report.applied[0].result : null
                                const skipReason = report && Array.isArray(report.skipped) && report.skipped[0]
                                    ? report.skipped[0].reason : null
                                if (env) {
                                    const ok = env.status === "verified" || env.status === "posted" || env.status === "dry-run"
                                    d._result = {
                                        ok:       ok,
                                        envelope: env,
                                        error:    ok ? null
                                            : (env.error && env.error.message) || env.warning || env.status
                                    }
                                } else if (skipReason) {
                                    d._result = {ok: false, error: "skipped · " + skipReason}
                                } else if (report && report.aborted) {
                                    d._result = {ok: false, error: report.abortReason || "aborted"}
                                } else {
                                    d._result = {ok: false, error: "no result"}
                                }
                            }
                        } catch (e) {
                            d._result = {ok: false, error: (e && e.message) || String(e)}
                        }
                        sendBtn.disabled = false
                        sendBtn.textContent = "Send IL request"
                        if (typeof _renderDecisions === "function" && _state.decisionsHost) {
                            _renderDecisions(_state.decisionsHost, _state.diff)
                        } else {
                            _refresh({skipSeed: true})
                        }
                    })
                    actions.appendChild(sendBtn)
                } else if (payloadKind === "alliance-join") {
                    const openBtn = _btn("Open alliance page", false)
                    openBtn.addEventListener("click", (ev) => {
                        ev.preventDefault()
                        ev.stopPropagation()
                        const server = _state.server || _currentPageServer()
                        if (!server) return
                        window.open("https://" + server + ".airlinesim.aero/app/alliance", "_blank", "noopener")
                    })
                    actions.appendChild(openBtn)
                }
                // Always offer a "Open partner page" link for alliance rows
                // — gives the user a manual escape hatch when the applier
                // returns noop or fails.
                if (d.payload && d.payload.partnerEnterpriseId) {
                    const server = _state.server || _currentPageServer()
                    if (server) {
                        const link = _el("a",
                            "color:" + COLOR.muted + ";font:11px sans-serif;text-decoration:underline;",
                            "Open partner page")
                        link.href = "https://" + server + ".airlinesim.aero/app/info/enterprises/"
                            + encodeURIComponent(String(d.payload.partnerEnterpriseId)) + "?tab=1"
                        link.target = "_blank"
                        link.rel = "noopener"
                        actions.appendChild(link)
                    }
                }
                if (actions.children.length) text.appendChild(actions)
            }

            // Per-route goal override (Slice S1). Only meaningful for
            // route-scoped domains where the proposers consult the
            // route-objective store: price + routeCreation.
            if (d.domain === "price" && d.payload && d.payload.hub && d.payload.dest
                    && window.AesStrategyRouteObjectiveStore) {
                const strip = _buildOverrideStrip(d, _refresh)
                strip.appendChild(_buildPinControl(d, _refresh))
                text.appendChild(strip)
            }
            row.appendChild(text)
            // Per-decision impact chip — sits to the right of the
            // text column. Estimates: $/wk for schedule/price/route
            // creation, ORS lift for service, headcount for crew.
            if (d._impact) {
                const tone = d._impact.tone
                const accent = tone === "ok" ? COLOR.ok : tone === "err" ? COLOR.err
                            : tone === "warn" ? COLOR.warn : COLOR.muted
                const chip = _el("div", [
                    "align-self:flex-start","white-space:nowrap","margin-left:8px",
                    "padding:3px 8px","border-radius:4px",
                    "border:1px solid " + accent,"color:" + accent,
                    "background:rgba(255,255,255,0.02)",
                    "font:600 11px sans-serif","letter-spacing:0.04em"
                ].join(";"), d._impact.label)
                row.appendChild(chip)
            }
            list.appendChild(row)
        }

        if (grouped) {
            for (const domain of DOMAIN_ORDER) {
                const items = groups.get(domain) || []
                if (!items.length) continue
                list.appendChild(_el("div", [
                    "display:flex","align-items:center","justify-content:space-between",
                    "padding:10px 0 6px","border-top:1px solid " + COLOR.rule,
                    "color:" + COLOR.accent,"font:600 11px sans-serif",
                    "letter-spacing:0.06em","text-transform:uppercase"
                ].join(";"), DOMAIN_LABEL[domain] + " · " + items.length))
                for (const d of items) renderRow(d)
            }
        } else {
            for (const d of visible) renderRow(d)
        }
        host.appendChild(list)
    }

    function _renderFooter(host) {
        host.textContent = ""
        const wrap = _el("div", [
            "display:flex","align-items:center","justify-content:space-between","gap:12px",
            "padding:10px 16px","border-top:1px solid " + COLOR.rule,
            "background:#0b1220"
        ].join(";"))

        const left = _el("div", "display:flex;align-items:center;gap:10px;color:" + COLOR.muted + ";font:12px sans-serif;")
        const selectedCount = _state.selected.size
        left.appendChild(_el("span", "", selectedCount + " selected"))
        if (_state.diff && _state.diff.summary) {
            left.appendChild(_el("span", "color:" + COLOR.muted + ";", "·"))
            left.appendChild(_el("span", "", _state.diff.summary.applicableTotal + " applicable in plan"))
            // Selected $/wk impact — sums per-decision _impact across the
            // user's checkbox selection so they can read the dollar bet
            // without scrolling the decision list.
            const decisions = (_state.diff && _state.diff.decisions) || []
            let selectedDollar = 0
            for (const d of decisions) {
                if (!_state.selected.has(d.id)) continue
                if (d._impact && d._impact.unit === "$/wk") selectedDollar += Number(d._impact.value) || 0
            }
            if (selectedDollar !== 0) {
                const tone = selectedDollar > 0 ? COLOR.ok : COLOR.err
                const sign = selectedDollar > 0 ? "+" : "-"
                left.appendChild(_el("span", "color:" + COLOR.muted + ";", "·"))
                left.appendChild(_el("span", "color:" + tone + ";font:600 12px sans-serif;",
                    "selected impact " + sign + "$" + Math.abs(Math.round(selectedDollar)).toLocaleString() + "/wk est."))
            }
            const totalDollar = Number(_state.diff.summary.dollarImpactWeekly) || 0
            if (totalDollar !== 0) {
                left.appendChild(_el("span", "color:" + COLOR.muted + ";", "·"))
                left.appendChild(_el("span", "",
                    "plan total " + (totalDollar > 0 ? "+$" : "-$")
                    + Math.abs(Math.round(totalDollar)).toLocaleString() + "/wk"))
            }
        }
        wrap.appendChild(left)

        const right = _el("div", "display:flex;align-items:center;gap:6px;")
        const tier = _state.settings ? _state.settings.tier : "preview-only"
        const applyBtn = _btn(_state.applying ? "Applying…" : ("Apply " + selectedCount + " selected"), true)
        applyBtn.disabled = _state.applying || selectedCount === 0 || tier === "preview-only"
        if (applyBtn.disabled) applyBtn.style.opacity = "0.5"
        applyBtn.addEventListener("click", _onApply)
        if (tier === "preview-only" && selectedCount > 0) {
            right.appendChild(_el("span", "color:" + COLOR.warn + ";font:11px sans-serif;", "Tier blocks apply — flip to apply-on-confirm"))
        }
        right.appendChild(applyBtn)
        wrap.appendChild(right)
        host.appendChild(wrap)
    }

    // ── Slice 5 — learning panel ────────────────────────────────────────

    async function _renderLearningSection(host) {
        host.textContent = ""
        if (!window.AesStrategyLearn) {
            host.appendChild(_emptyState("Learning module not loaded — modules/strategy/learn.js missing."))
            return
        }
        const heading = _el("div", "padding:10px 16px 6px;color:" + COLOR.accent + ";font:600 11px sans-serif;letter-spacing:0.06em;text-transform:uppercase;", "Closed-loop learning")
        host.appendChild(heading)

        const wrap = _el("div", "padding:0 16px 16px;display:flex;flex-direction:column;gap:8px;")

        // Outcome counts strip — scope to the SELECTED airline so the
        // user sees their sister's own outcomes when switching scope,
        // not whatever the current page's airline has accumulated.
        const acctId = await _scopedAccountId()
        const counts = window.AesStrategyOutcomes
            ? await window.AesStrategyOutcomes.countReady(undefined, acctId)
            : {recorded: 0, ready: 0, attributed: 0}
        const countsRow = _el("div", "display:flex;gap:8px;flex-wrap:wrap;")
        for (const [label, n] of [["Recorded", counts.recorded], ["Ready", counts.ready], ["Attributed", counts.attributed]]) {
            const chip = _el("div", [
                "display:flex","flex-direction:column","align-items:center",
                "padding:6px 10px",
                "background:" + COLOR.chipBg, "border:1px solid " + COLOR.rule,
                "border-radius:4px","min-width:64px"
            ].join(";"))
            chip.appendChild(_el("span", "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;", label))
            chip.appendChild(_el("span", "color:" + COLOR.text + ";font:600 16px sans-serif;", String(n)))
            countsRow.appendChild(chip)
        }
        wrap.appendChild(countsRow)

        // Controls
        const settings = _state.settings || {}
        const controls = _el("div", "display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:" + COLOR.text + ";font:12px sans-serif;")

        // Pause toggle
        const pauseLbl = _el("label", "display:inline-flex;align-items:center;gap:4px;cursor:pointer;")
        const pauseCb = _el("input")
        pauseCb.type = "checkbox"
        pauseCb.checked = !!settings.learningEnabled
        pauseCb.addEventListener("change", async () => {
            await window.AesStrategySettings.save({learningEnabled: pauseCb.checked})
            _state.settings = await window.AesStrategySettings.load()
        })
        pauseLbl.append(pauseCb, _el("span", "", "Learning enabled"))
        controls.appendChild(pauseLbl)

        // Step-size slider
        const stepWrap = _el("label", "display:inline-flex;align-items:center;gap:6px;color:" + COLOR.text + ";font:12px sans-serif;")
        stepWrap.appendChild(_el("span", "color:" + COLOR.muted + ";font:11px sans-serif;", "Step"))
        const stepInput = _el("input")
        stepInput.type = "range"
        stepInput.min = "0"; stepInput.max = "0.20"; stepInput.step = "0.01"
        stepInput.value = String(settings.learningStepSize != null ? settings.learningStepSize : 0.05)
        stepInput.style.width = "100px"
        const stepReadout = _el("span", "color:" + COLOR.muted + ";font:11px monospace;min-width:30px;",
                                Number(stepInput.value).toFixed(2))
        stepInput.addEventListener("input", () => { stepReadout.textContent = Number(stepInput.value).toFixed(2) })
        stepInput.addEventListener("change", async () => {
            await window.AesStrategySettings.save({learningStepSize: Number(stepInput.value)})
            _state.settings = await window.AesStrategySettings.load()
        })
        stepWrap.append(stepInput, stepReadout)
        controls.appendChild(stepWrap)
        wrap.appendChild(controls)

        // Action buttons
        const actions = _el("div", "display:flex;gap:6px;flex-wrap:wrap;")
        const captureBtn = _btn("Capture pending outcomes", false)
        captureBtn.addEventListener("click", async () => {
            captureBtn.disabled = true
            captureBtn.textContent = "…"
            try {
                const r = await window.AesStrategyOutcomes.tryCaptureAfter({
                    minWindowHours: 24,
                    snapshot:       _state.snapshot,
                    plan:           _state.plan,
                    accountId:      acctId
                })
                _toast("Captured " + r.captured + " outcome" + (r.captured === 1 ? "" : "s"), "ok")
                await _renderLearningSection(host)
            } catch (e) {
                _toast("Capture failed: " + ((e && e.message) || String(e)), "err")
            } finally {
                captureBtn.disabled = false
                captureBtn.textContent = "Capture pending outcomes"
            }
        })
        actions.appendChild(captureBtn)

        const learnBtn = _btn("Run learn cycle", true)
        learnBtn.addEventListener("click", async () => {
            learnBtn.disabled = true
            learnBtn.textContent = "…"
            try {
                const r = await window.AesStrategyLearn.learn({force: true, accountId: acctId})
                if (r.applied) {
                    _toast("Learn cycle applied · " + r.sampleCount + " samples · step " + Number(r.stepSize).toFixed(2), "ok")
                } else {
                    _toast("Learn cycle: " + r.reason + (r.have != null ? " (" + r.have + "/" + r.need + ")" : ""), "warn")
                }
                await _renderLearningSection(host)
            } catch (e) {
                _toast("Learn failed: " + ((e && e.message) || String(e)), "err")
            } finally {
                learnBtn.disabled = false
                learnBtn.textContent = "Run learn cycle"
            }
        })
        actions.appendChild(learnBtn)

        const resetBtn = _btn("Reset weights", false)
        resetBtn.addEventListener("click", async () => {
            if (!window.confirm("Reset strategy weights to defaults? Current weights archived to history.")) return
            try {
                await window.AesStrategyLearn.resetWeights("user-reset", acctId)
                _toast("Weights reset to defaults", "ok")
                await _renderLearningSection(host)
            } catch (e) {
                _toast("Reset failed: " + ((e && e.message) || String(e)), "err")
            }
        })
        actions.appendChild(resetBtn)
        wrap.appendChild(actions)

        // Current weights summary (per-airline)
        const cur = await window.AesStrategyLearn.getCurrentWeights(acctId)
        if (cur) {
            const wTbl = _el("div", "border:1px solid " + COLOR.rule + ";border-radius:4px;padding:8px 10px;background:" + COLOR.chipBg + ";")
            wTbl.appendChild(_el("div", "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;", "Current weights"))
            const grid = _el("div", "display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:4px;font:11px monospace;color:" + COLOR.text + ";")
            for (const k of Object.keys(cur)) {
                const row = _el("div", "display:flex;justify-content:space-between;border-bottom:1px dotted " + COLOR.rule + ";padding:2px 0;")
                row.appendChild(_el("span", "color:" + COLOR.muted + ";", k))
                row.appendChild(_el("span", "", Number(cur[k]).toFixed(3)))
                grid.appendChild(row)
            }
            wTbl.appendChild(grid)
            wrap.appendChild(wTbl)
        }

        // Recent history (per-airline)
        const history = await window.AesStrategyLearn.getHistory(acctId)
        if (history.length) {
            const histWrap = _el("div", "border:1px solid " + COLOR.rule + ";border-radius:4px;padding:8px 10px;background:" + COLOR.chipBg + ";")
            histWrap.appendChild(_el("div", "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;",
                                      "Weight changes (last " + Math.min(history.length, 5) + ")"))
            for (const h of history.slice(0, 5)) {
                const ts = h.ts ? new Date(h.ts).toLocaleString() : "?"
                const samples = h.sampleCount != null ? " · " + h.sampleCount + " samples" : ""
                const stepNote = h.stepSize != null ? " · step " + Number(h.stepSize).toFixed(2) : ""
                const li = _el("div", "color:" + COLOR.text + ";font:11px sans-serif;padding:2px 0;border-bottom:1px dotted " + COLOR.rule + ";",
                                ts + " · " + (h.reason || "?") + samples + stepNote)
                histWrap.appendChild(li)
            }
            wrap.appendChild(histWrap)
        }

        host.appendChild(wrap)
    }

    /**
     * Slice 26 — Journal section. Delegates rendering to the dedicated
     * journal-panel.js module so the strategy panel stays thin. Account
     * scope mirrors the learning section so switching the airline picker
     * shows that sister's journal.
     */
    async function _renderJournalSection(host) {
        if (!host) return
        if (!window.AesStrategyJournalPanel || typeof window.AesStrategyJournalPanel.render !== "function") {
            host.textContent = ""
            host.appendChild(_emptyState("Journal panel not loaded — modules/strategy/journal-panel.js missing."))
            return
        }
        const acctId = await _scopedAccountId()
        if (_state.focusSection === "journal") {
            if (!host._aesJournalState) host._aesJournalState = {expanded: true, filter: "all", search: ""}
            else host._aesJournalState.expanded = true
        }
        await window.AesStrategyJournalPanel.render(host, {accountId: acctId})
    }

    function _renderAircraftAccordion(host, plan, diff) {
        host.textContent = ""
        const aircraft = (plan && plan.perAircraft) || []
        if (!aircraft.length) {
            host.appendChild(_emptyState("No fleet placements (no scheduled aircraft visible on this page or all idle)."))
            return
        }
        // Index schedule decisions by aircraftId so we can pull each tail's
        // diff payload without re-doing the lookup work.
        const diffByAircraft = new Map()
        if (diff && Array.isArray(diff.decisions)) {
            for (const d of diff.decisions) {
                if (d.kind !== "schedule") continue
                if (!d.payload || !d.payload.aircraftId) continue
                diffByAircraft.set(String(d.payload.aircraftId), d._diff || null)
            }
        }
        const heading = _el("div", "padding:10px 16px 6px;color:" + COLOR.accent + ";font:600 11px sans-serif;letter-spacing:0.06em;text-transform:uppercase;", "Per-aircraft schedules · " + aircraft.length)
        host.appendChild(heading)

        // Sort aircraft by predicted profit descending so the engine's
        // biggest bets bubble to the top (when plannedProfit is exposed
        // by allocate-fleet — falls back to original order if not).
        const sortedAircraft = aircraft.slice().sort((a, b) => {
            const av = Number(a.plannedProfit) || 0
            const bv = Number(b.plannedProfit) || 0
            return bv - av
        })
        const list = _el("div", "padding:0 16px 16px;")
        for (const a of sortedAircraft) {
            const det = _el("details", "margin:6px 0;border:1px solid " + COLOR.rule + ";border-radius:4px;background:" + COLOR.chipBg + ";")
            const sum = _el("summary", "padding:8px 12px;cursor:pointer;color:" + COLOR.text + ";font:600 13px sans-serif;display:flex;align-items:center;gap:8px;flex-wrap:wrap;")
            const head = _el("span", "",
                            (a.registration || a.aircraftId) + " · " + (a.equipment || ("type " + a.typeId))
                              + " · " + (a.legs ? a.legs.length : 0) + " legs"
                              + " · " + (a.utilization ? Number(a.utilization.weeklyHours || 0).toFixed(1) + "h" : "0h"))
            sum.appendChild(head)
            // Per-aircraft predicted profit chip — pulled from
            // plan.perAircraft.plannedProfit (allocate-fleet exposes it).
            const profit = Number(a.plannedProfit)
            if (isFinite(profit) && profit !== 0) {
                const tone = profit > 0 ? COLOR.ok : COLOR.err
                sum.appendChild(_el("span", [
                    "display:inline-block","padding:1px 6px","border-radius:9px",
                    "border:1px solid " + tone,"color:" + tone,
                    "background:rgba(255,255,255,0.02)",
                    "font:600 10px sans-serif","letter-spacing:0.04em"
                ].join(";"), (profit > 0 ? "+$" : "-$")
                    + Math.abs(Math.round(profit)).toLocaleString() + "/wk"))
            }
            // Per-aircraft diff badges — tiny inline pills next to the
            // summary line so the user can scan "what's actually changing
            // on this tail" without expanding.
            const adiff = diffByAircraft.get(String(a.aircraftId))
            if (adiff) {
                const pill = (label, n, tone) => {
                    if (!n) return null
                    const accent = tone === "ok" ? COLOR.ok : tone === "err" ? COLOR.err
                                : tone === "warn" ? COLOR.warn : COLOR.muted
                    return _el("span", [
                        "display:inline-block","padding:1px 6px","border-radius:9px",
                        "border:1px solid " + accent,"color:" + accent,
                        "background:rgba(255,255,255,0.02)",
                        "font:600 10px sans-serif","letter-spacing:0.04em","text-transform:uppercase"
                    ].join(";"), label + " " + n)
                }
                const pills = [
                    pill("keep", adiff.kept, "muted"),
                    pill("+", adiff.added, "ok"),
                    pill("-", adiff.removed, "err"),
                    pill("locked", adiff.locked, "warn")
                ].filter(Boolean)
                for (const p of pills) sum.appendChild(p)
            } else if (diff && diff.summary && diff.summary.scheduleDiffMode === "real") {
                sum.appendChild(_el("span", "color:" + COLOR.warn + ";font:600 10px sans-serif;", "(no cached schedule)"))
            }
            det.appendChild(sum)
            const body = _el("div", "padding:6px 12px 10px;border-top:1px solid " + COLOR.rule + ";")
            const ratUl = _el("ul", "margin:0 0 6px 18px;padding:0;color:" + COLOR.muted + ";font:11px/1.4 sans-serif;")
            for (const r of (a.rationale || []).slice(0, 8)) ratUl.appendChild(_el("li", "", r))
            body.appendChild(ratUl)
            const legTbl = _el("table", "width:100%;border-collapse:collapse;font:11px sans-serif;color:" + COLOR.text + ";")
            const thead = _el("thead", "")
            const trh = _el("tr", "")
            for (const h of ["#", "Origin", "Dest", "Dep", "Service", "Price%", "Score"]) {
                trh.appendChild(_el("th", "padding:3px 6px;border-bottom:1px solid " + COLOR.rule + ";text-align:left;color:" + COLOR.muted + ";font-weight:600;", h))
            }
            thead.appendChild(trh)
            legTbl.appendChild(thead)
            const tbody = _el("tbody", "")
            for (const l of a.legs || []) {
                const tr = _el("tr", "")
                tr.append(
                    _el("td", "padding:3px 6px;", String(l.seq || "")),
                    _el("td", "padding:3px 6px;", l.origin || ""),
                    _el("td", "padding:3px 6px;", l.destination || ""),
                    _el("td", "padding:3px 6px;", l.depTime || l.depTimeLocal || ""),
                    _el("td", "padding:3px 6px;", l.service || "—"),
                    _el("td", "padding:3px 6px;text-align:right;", String(l.pricePct ?? "")),
                    _el("td", "padding:3px 6px;text-align:right;color:" + COLOR.muted + ";",
                        l._strategy && l._strategy.tupleScore != null ? l._strategy.tupleScore.toFixed(3) : "")
                )
                tbody.appendChild(tr)
            }
            legTbl.appendChild(tbody)
            body.appendChild(legTbl)
            det.appendChild(body)
            list.appendChild(det)
        }
        host.appendChild(list)
    }

    // ── Apply flow ───────────────────────────────────────────────────────

    /**
     * Tally what the current selection looks like by domain so the
     * confirm modal can surface counts, tier, and predicted dollar
     * impact in one read. Also classifies the apply as high-stakes when
     * route creations, > 5 price moves, or > 20 schedule adds are
     * involved — those require the user to type APPLY.
     */
    function _summarizeSelection() {
        const out = {
            schedule: 0, service: 0, price: 0, crew: 0, routeCreation: 0, alliance: 0, slotBid: 0,
            scheduleAddedLegs: 0,
            dollarImpact: 0, ors: 0, headcount: 0,
            highStakes: false
        }
        const decisions = (_state.diff && _state.diff.decisions) || []
        for (const d of decisions) {
            if (!_state.selected.has(d.id)) continue
            out[d.domain] = (out[d.domain] || 0) + 1
            if (d._impact && d._impact.unit === "$/wk") out.dollarImpact += Number(d._impact.value) || 0
            if (d._impact && d._impact.unit === "ORS")   out.ors          += Number(d._impact.value) || 0
            if (d._impact && d._impact.unit === "ppl")   out.headcount    += Number(d._impact.value) || 0
            if (d.kind === "schedule" && d._diff) out.scheduleAddedLegs += d._diff.added
            else if (d.kind === "schedule" && d.payload && d.payload.legs)
                out.scheduleAddedLegs += d.payload.legs.length
        }
        out.highStakes = (out.routeCreation > 0)
                       || (out.slotBid > 0)
                       || (out.price > 5)
                       || (out.scheduleAddedLegs > 20)
        return out
    }

    function _confirmModal(summary, tier, onConfirm) {
        const overlay = _el("div", [
            "position:fixed","inset:0","background:rgba(0,0,0,0.7)",
            "z-index:10003","display:flex","align-items:center","justify-content:center"
        ].join(";"))
        overlay.className = "aes-strategy-confirm-overlay"
        const card = _el("div", [
            "background:" + COLOR.bg,"color:" + COLOR.text,
            "border:1px solid " + COLOR.rule,"border-radius:6px",
            "width:min(540px,92vw)","padding:20px",
            "box-shadow:0 12px 48px rgba(0,0,0,0.6)","font-family:sans-serif"
        ].join(";"))
        card.className = "aes-strategy-confirm-modal"
        card.setAttribute("role", "dialog")
        card.setAttribute("aria-modal", "true")
        card.setAttribute("aria-label", "Confirm strategy apply")
        overlay.appendChild(card)

        const close = () => { try { overlay.parentNode.removeChild(overlay) } catch (_) {} }
        overlay.addEventListener("click", e => { if (e.target === overlay) close() })

        card.appendChild(_el("h3",
            "margin:0 0 8px 0;font:600 16px sans-serif;letter-spacing:0.04em;"
            + "text-transform:uppercase;color:" + COLOR.text + ";",
            "Confirm apply"))
        const sub = _el("p", "margin:0 0 14px 0;color:" + COLOR.muted + ";font:13px sans-serif;",
            "Tier · " + tier + ". Strategy will route through existing actuators (apply-batch, "
            + "service profile, pricing, route-creation, staff-pilots).")
        card.appendChild(sub)

        // Multi-account scope guard: actuators call live game endpoints
        // that hit whatever airline is signed in on this tab, NOT the
        // airline picked in the modal dropdown. If those don't match,
        // applying would post sister B's plan to sister A's account.
        // Show a red banner + name-typing gate to make the mismatch
        // impossible to miss.
        const pageAirline   = _currentPageAirline()
        const scopedAirline = _state.airline
        const scopeMismatch = !!(pageAirline && scopedAirline
            && String(pageAirline).replace(/[^A-Za-z0-9]/g, "").toLowerCase()
                !== String(scopedAirline).replace(/[^A-Za-z0-9]/g, "").toLowerCase())
        if (scopeMismatch) {
            const banner = _el("div", [
                "padding:10px 12px","border-radius:4px","margin-bottom:12px",
                "border:1px solid " + COLOR.err,"background:rgba(239,68,68,0.10)",
                "color:" + COLOR.err,"font:12px sans-serif"
            ].join(";"))
            banner.appendChild(_el("div", "font:600 12px sans-serif;margin-bottom:4px;",
                "⚠ Wrong-account hazard"))
            banner.appendChild(_el("div", "",
                "This tab is signed in as " + pageAirline + " but the plan is for " + scopedAirline + "."
                + " Applying now would post " + scopedAirline + "'s changes to "
                + pageAirline + "'s account."))
            banner.appendChild(_el("div", "color:" + COLOR.muted + ";font:11px sans-serif;margin-top:4px;",
                "Switch to a tab logged in as " + scopedAirline + " (or cancel and pick " + pageAirline + " in the modal scope)."))
            card.appendChild(banner)
        }

        // Counts
        const countsList = _el("ul", "margin:0 0 14px 0;padding-left:18px;font:13px sans-serif;color:" + COLOR.text + ";")
        const lineMaybe = (n, label) => {
            if (!n) return
            const li = _el("li", "padding:2px 0;", label.replace("{n}", String(n)))
            countsList.appendChild(li)
        }
        lineMaybe(summary.schedule,      "{n} aircraft schedule(s) — adds " + summary.scheduleAddedLegs + " leg(s) (per real diff or v1 stub)")
        lineMaybe(summary.service,       "{n} service profile upgrade(s)")
        lineMaybe(summary.price,         "{n} price move(s)")
        lineMaybe(summary.crew,          "{n} crew action(s) — total " + summary.headcount + " people")
        lineMaybe(summary.routeCreation, "{n} new route creation(s) — these post legs to NEW aircraft schedules")
        lineMaybe(summary.alliance,      "{n} alliance / interline action(s)")
        lineMaybe(summary.slotBid,       "{n} slot bid action(s) — blocked until the AS bid form mapping is complete")
        if (!countsList.children.length) {
            countsList.appendChild(_el("li", "color:" + COLOR.muted + ";font-style:italic;", "No applicable decisions selected."))
        }
        card.appendChild(countsList)

        // Impact summary
        const impactBox = _el("div", "padding:10px 12px;background:" + COLOR.chipBg + ";border:1px solid " + COLOR.rule
            + ";border-radius:4px;margin-bottom:12px;font:13px sans-serif;")
        const dollarLine = _el("div", "color:" + (summary.dollarImpact >= 0 ? COLOR.ok : COLOR.err) + ";",
            "Predicted impact (selection): "
            + (summary.dollarImpact >= 0 ? "+$" : "-$")
            + Math.abs(Math.round(summary.dollarImpact)).toLocaleString() + "/wk")
        impactBox.appendChild(dollarLine)
        if (summary.ors) impactBox.appendChild(_el("div", "color:" + COLOR.muted + ";font-size:12px;margin-top:2px;",
            "Plus ORS lift across selected service moves: +" + summary.ors.toFixed(3)))
        impactBox.appendChild(_el("div", "color:" + COLOR.muted + ";font-size:11px;margin-top:4px;",
            "Estimates use coarse heuristics (Slice 9 elasticity-fit deepens these). "
            + "Apply, then check learn.js outcomes after one game-week."))
        card.appendChild(impactBox)

        const high = !!summary.highStakes
        // Combine the two gate conditions. Scope mismatch wins: a wrong-
        // account post is much worse than a high-stakes typo.
        const requiredPhrase = scopeMismatch
            ? String(scopedAirline)
            : (high ? "APPLY" : null)
        const placeholder = requiredPhrase
            ? "Type " + requiredPhrase + " to confirm"
            : null
        const note = _el("p", "margin:0 0 12px 0;font:12px sans-serif;color:"
            + (scopeMismatch ? COLOR.err : (high ? COLOR.warn : COLOR.muted)) + ";",
            scopeMismatch
                ? "Type the scoped airline name above to override the wrong-account guard. Strongly consider cancelling and switching tabs instead."
                : (high
                    ? "High-stakes plan: includes new route creations, slot bids, > 5 price moves, "
                      + "or > 20 schedule adds. Type APPLY to enable Confirm."
                    : "Review the counts above. You can cancel and untick decisions in the modal."))
        card.appendChild(note)

        let confirmGate = null
        if (requiredPhrase) {
            confirmGate = _el("input")
            confirmGate.type = "text"
            confirmGate.placeholder = placeholder
            confirmGate.style.cssText = "width:100%;padding:6px 10px;background:" + COLOR.chipBg
                + ";color:" + COLOR.text + ";border:1px solid " + COLOR.rule
                + ";border-radius:3px;font:13px sans-serif;margin-bottom:12px;"
            card.appendChild(confirmGate)
        }

        const row = _el("div", "display:flex;gap:8px;justify-content:flex-end;")
        const cancelBtn = _btn("Cancel", false)
        cancelBtn.addEventListener("click", close)
        const confirmBtn = _btn("Confirm apply", true)
        const _normPhrase = (s) => String(s || "").trim().replace(/[^A-Za-z0-9]/g, "").toLowerCase()
        const updateGate = () => {
            const gateOk = !requiredPhrase
                || (confirmGate && _normPhrase(confirmGate.value) === _normPhrase(requiredPhrase))
            confirmBtn.disabled = !gateOk
            confirmBtn.style.opacity = gateOk ? "1" : "0.5"
        }
        updateGate()
        if (confirmGate) confirmGate.addEventListener("input", updateGate)
        confirmBtn.addEventListener("click", () => {
            if (confirmBtn.disabled) return
            close()
            try { onConfirm() } catch (e) { console.warn("[AesStrategyPanel] confirm onConfirm threw", e) }
        })
        row.append(cancelBtn, confirmBtn)
        card.appendChild(row)

        document.body.appendChild(overlay)
        if (confirmGate) confirmGate.focus()
        else confirmBtn.focus()
    }

    async function _onApply() {
        if (_state.applying) return
        if (!_state.plan || !_state.diff) return
        if (!window.AesStrategy || typeof window.AesStrategy.apply !== "function") {
            alert("AesStrategy.apply not available — apply-pipeline.js missing")
            return
        }
        const sel = new Set(_state.selected)
        if (!sel.size) return
        const tier = _state.settings ? _state.settings.tier : "preview-only"
        if (tier === "preview-only") return
        const summary = _summarizeSelection()
        _confirmModal(summary, tier, () => { _doApply(sel) })
    }

    async function _doApply(sel) {
        _state.applying = true
        _renderFooter(_state.footerHost)

        try {
            const report = await window.AesStrategy.apply(_state.plan, {
                selected: sel,
                source:   "strategy-panel",
                snapshot: _state.snapshot,     // thread through so outcomes.record skips a 2nd snapshot fetch
                diff:     _state.diff          // apply exactly the reviewed decision set, including advisory tuners
            })
            // Decorate decision rows with results
            const byId = new Map()
            for (const a of report.applied) byId.set(a.decisionId, a)
            for (const s of report.skipped) byId.set(s.decisionId, {ok: false, error: "skipped: " + s.reason})
            for (const d of _state.diff.decisions) {
                const r = byId.get(d.id)
                if (r) d._result = {ok: !!r.ok, error: r.error || null}
            }
            _state.applying = false
            _renderDecisions(_state.decisionsHost, _state.diff)
            _renderFooter(_state.footerHost)

            const t = report.totals || {}
            const tone = report.aborted ? "err" : (t.failed ? "warn" : "ok")
            const msg = report.aborted
                ? ("Apply aborted: " + (report.abortReason || "unknown"))
                : (t.ok + " applied · " + t.failed + " failed · " + t.skipped + " skipped")
            _toast(msg, tone)
        } catch (e) {
            _state.applying = false
            _renderFooter(_state.footerHost)
            _toast("Apply threw: " + ((e && e.message) || String(e)), "err")
        }
    }

    function _toast(msg, tone) {
        const t = _el("div", [
            "position:fixed","right:20px","bottom:20px",
            "padding:10px 14px","border-radius:4px",
            "background:" + (tone === "err" ? COLOR.chipBgErr : tone === "warn" ? COLOR.chipBgWarn : COLOR.chipBgOk),
            "color:" + (tone === "err" ? COLOR.err : tone === "warn" ? COLOR.warn : COLOR.ok),
            "border:1px solid " + (tone === "err" ? COLOR.err : tone === "warn" ? COLOR.warn : COLOR.ok),
            "font:13px sans-serif","z-index:10005","max-width:480px"
        ].join(";"), msg)
        document.body.appendChild(t)
        setTimeout(() => { try { t.parentNode && t.parentNode.removeChild(t) } catch (_) {} }, 6000)
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    async function _refresh(opts) {
        if (!_state.overlay) return
        const skipSeed = !!(opts && opts.skipSeed)
        _state.bodyHost.textContent = ""
        _state.bodyHost.appendChild(_el("div", "padding:32px;color:" + COLOR.muted + ";text-align:center;font:13px sans-serif;", "Composing snapshot + plan…"))
        try {
            const composed = await _composePlan()
            _state.snapshot         = composed.snapshot
            _state.plan             = composed.plan
            _state.diff             = composed.diff
            _state.currentSchedules = composed.currentSchedules
            // Don't auto-clear selection on refresh — preserve what the user picked.
            const validIds = new Set(_state.diff.decisions.map(d => d.id))
            for (const id of Array.from(_state.selected)) {
                if (!validIds.has(id)) _state.selected.delete(id)
            }

            _state.bodyHost.textContent = ""
            _renderHeader(_state.headerHost, _state.plan, _state.settings, _state.diff)
            _renderSectionMenu(_state.menuHost)
            _resetSectionHosts()
            _renderSummaryStrip(_state.summaryHost, _state.diff)
            _renderReadiness(_state.readinessHost)
            _renderSettingsStrip(_state.settingsHost, _state.settings)
            if (window.AesStrategyTuningPanel) {
                window.AesStrategyTuningPanel.render(_state.tuningHost, {
                    settings: _state.settings,
                    // Tuning slider drags re-score routes via _refresh, but
                    // we don't want a slider drag to re-fire the network
                    // seeders — those should only run on first open + the
                    // explicit Refresh button.
                    onChange: () => _refresh({skipSeed: true})
                })
            }
            _renderOverlapCard(_state.overlapHost)
            _renderDecisions(_state.decisionsHost, _state.diff)
            _renderAircraftAccordion(_state.aircraftHost, _state.plan, _state.diff)
            _renderLearningSection(_state.learningHost)
            _renderJournalSection(_state.journalHost)
            _appendSectionHosts()
            _renderFooter(_state.footerHost)
            _focusSection(_state.focusSection || "overview", {instant: true})
            // skipSeed signals "this is a re-render after a seed already
            // ran, or a non-network-burn event like a slider drag". Only
            // the explicit user-driven entry points (first open, Refresh
            // button, settings change that wants fresh data) ever pass
            // skipSeed=false to actually trigger a seed pump.
            void skipSeed
        } catch (e) {
            _state.bodyHost.textContent = ""
            const err = _el("div", "padding:24px;color:" + COLOR.err + ";font:13px sans-serif;", "Failed to compose plan: " + ((e && e.message) || String(e)))
            _state.bodyHost.appendChild(err)
            console.error("[AesStrategyPanel] compose failed", e)
        }
    }

    async function open(opts) {
        opts = opts || {}
        if (_state.overlay) {
            const scopeChanged = await _applyScopeOptions(opts)
            const applied = _applyOpenOptions(opts)
            if (scopeChanged) {
                await _refresh({skipSeed: true})
            } else {
                if (applied.filterChanged && _state.decisionsHost && _state.diff) {
                    if (_state.summaryHost) _renderSummaryStrip(_state.summaryHost, _state.diff)
                    _renderDecisions(_state.decisionsHost, _state.diff)
                    _renderFooter(_state.footerHost)
                }
                _focusSection(applied.section || _state.focusSection || "overview")
            }
            return
        }
        const settings = window.AesStrategySettings ? await window.AesStrategySettings.load() : null
        _state.settings = settings || {tier: "preview-only"}
        _state.selected = Array.isArray(opts.preselect)
            ? new Set(opts.preselect.map(String))
            : new Set()
        _state.applying = false
        _state.filter = _copyFilter(opts.filter)
        _applyOpenOptions(opts)
        // Discover servers + default to current page's server. The picker
        // in the header only appears when 2+ servers have cached data.
        // opts.server / opts.airlineCode let callers (the tile portfolio's
        // click-to-switch) jump straight into a sister's preview without
        // the user having to use the dropdown.
        _state.knownServers = await _listKnownServers()
        const cur = _currentPageServer()
        const optServer  = opts.server  || null
        const optAirline = opts.airlineCode || opts.airline || opts.airlineIdentity || null
        if (optServer && _state.knownServers.indexOf(optServer) < 0) {
            // Server passed by caller but not in the cached set — add it
            // anyway so the picker can render and we don't silently
            // re-default to the current page's server.
            _state.knownServers = _state.knownServers.concat([optServer]).sort()
        }
        _state.server = optServer
                       || ((cur && _state.knownServers.indexOf(cur) >= 0) ? cur : null)
                       || _state.knownServers[0]
                       || cur
                       || null
        // Discover sister airlines on the current server + pick default.
        // Empty shape is fine — the picker just doesn't render.
        _state.portfolio = await _scanPortfolio(_state.server)
        if (optAirline) {
            const match = (_state.portfolio.airlines || []).find(a => a.airline === optAirline || a.displayName === optAirline)
            _state.airline = match ? match.airline : optAirline
        } else {
            _state.airline = _defaultAirline(_state.portfolio)
        }

        const overlay = _el("div", [
            "position:fixed","inset:0","background:rgba(0,0,0,0.6)",
            "z-index:10001","display:flex","align-items:stretch","justify-content:center"
        ].join(";"))
        overlay.className = "aes-strategy-panel"
        overlay.dataset.aesStrategyPanel = "1"
        const modal = _el("div", [
            "background:" + COLOR.bg,
            "color:" + COLOR.text,
            "border:1px solid " + COLOR.rule,
            "border-radius:6px",
            "width:min(1100px, 95vw)",
            "height:min(88vh, 1000px)",
            "margin:auto",
            "display:flex","flex-direction:column",
            "box-shadow:0 12px 48px rgba(0,0,0,0.5)",
            "font-family:sans-serif"
        ].join(";"))
        modal.className = "aes-strategy-modal"
        modal.setAttribute("role", "dialog")
        modal.setAttribute("aria-modal", "true")
        modal.setAttribute("aria-label", "Strategy preview")
        overlay.appendChild(modal)
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })
        document.addEventListener("keydown", _onEsc)

        _state.overlay     = overlay
        _state.headerHost  = _el("div", "")
        _state.menuHost    = _el("div", "")
        _state.bodyHost    = _el("div", "flex:1;display:flex;flex-direction:column;overflow:auto;")
        _state.footerHost  = _el("div", "")
        modal.append(_state.headerHost, _state.menuHost, _state.bodyHost, _state.footerHost)

        document.body.appendChild(overlay)
        _renderSectionMenu(_state.menuHost)

        // Optional pre-supplied plan/snapshot for tests
        if (opts && opts.plan && opts.snapshot && opts.diff) {
            _state.plan     = opts.plan
            _state.snapshot = opts.snapshot
            _state.diff     = opts.diff
            _renderHeader(_state.headerHost, _state.plan, _state.settings, _state.diff)
            _renderSectionMenu(_state.menuHost)
            _resetSectionHosts()
            _renderSummaryStrip(_state.summaryHost, _state.diff)
            _renderReadiness(_state.readinessHost)
            _renderSettingsStrip(_state.settingsHost, _state.settings)
            if (window.AesStrategyTuningPanel) {
                window.AesStrategyTuningPanel.render(_state.tuningHost, {
                    settings: _state.settings,
                    onChange: () => _refresh({skipSeed: true})
                })
            }
            _renderOverlapCard(_state.overlapHost)
            _renderDecisions(_state.decisionsHost, _state.diff)
            _renderAircraftAccordion(_state.aircraftHost, _state.plan, _state.diff)
            _renderLearningSection(_state.learningHost)
            _renderJournalSection(_state.journalHost)
            _appendSectionHosts()
            _renderFooter(_state.footerHost)
            _focusSection(_state.focusSection || "overview", {instant: true})
        } else {
            _renderHeader(_state.headerHost, null, _state.settings, null)
            // First open: probe + auto-seed any missing/stale stores
            // before composing. Seeders are idempotent — if everything's
            // already filled, _runSeedThenRefresh degrades to a plain
            // _refresh after a single probe pass. The opt-out flag lives
            // on AesStrategySettings (autoSeedDisabled) so power users who
            // don't want surprise HTTP traffic on open can flip it off.
            const skipAutoSeed = !!(_state.settings && _state.settings.autoSeedDisabled)
                || !!(opts && (opts.skipSeed || opts.skipAutoSeed))
            if (skipAutoSeed) {
                await _refresh({skipSeed: true})
            } else {
                await _runSeedThenRefresh({firstOpen: true})
            }
        }
    }

    function _onEsc(e) {
        if (e.key === "Escape") close()
    }

    function close() {
        if (!_state.overlay) return
        if (_state.focusTimer) {
            try { clearTimeout(_state.focusTimer) } catch (_) {}
        }
        try { _state.overlay.parentNode && _state.overlay.parentNode.removeChild(_state.overlay) } catch (_) {}
        document.removeEventListener("keydown", _onEsc)
        _state = _baseState()
    }

    window.AesStrategyPanel = {
        open: open,
        close: close,
        focus: _focusSection,
        sections: SECTION_MENU.map(s => s.id)
    }
})()
