"use strict"

/**
 * Flight Studio — compose panel (Slice S1).
 *
 * Mounts at `AesAfp.slot("studio")` and renders a compose UI for one
 * FlightSpec. Preview fills the AS "New Flight Number" form for review.
 * Apply opens the shared confirmation modal and uses the background-tab
 * submit pipeline; it never posts directly from this visible page.
 *
 * SAFETY INVARIANT (mirrors form-driver.js:10-24):
 *   The panel never calls submitBtn.click() or form.submit() from the
 *   visible page. Preview reads option values via AesAfpFormDriver.dryRun();
 *   Apply goes through the confirmed background-tab submit queue.
 *
 * Public API (window.AesAfpFlightStudio):
 *   attach()         — idempotent; wires bus listeners + initial render
 *   render()         — replace-render into AesAfp.slot("studio")
 *   open()           — scrolls panel into view, focuses first input,
 *                      emits studio:opened {trigger}
 *   getSpec()        — returns the current in-memory FlightSpec
 *
 * Bus contract (additions to EVENTS.md §1):
 *   in:  ctx:ready                         → re-render on remount
 *   out: studio:opened       {trigger}
 *   out: studio:draft-changed {spec}        (debounced 300ms)
 *   out: studio:dry-run-rendered {spec, dryRun}
 *
 * Slices S2+ extend this same module with multi-leg compose, paste-import,
 * pre-fill mode, and submit mode. Keep the public API stable.
 */
;(function () {
    if (window.AesAfpFlightStudio) return

    const SLOT_NAME       = "studio"
    const SAVE_DEBOUNCE_MS = 300
    const TRIGGER_INIT     = "menu"

    let _spec      = null         // current FlightSpec
    let _attached  = false
    let _saveTimer = null
    let _renderInFlight = false   // re-entrancy guard
    let _lastDryRun = null        // most recent dryRun result, for diagnostics
    let _lastDryRunOutcome = null // {validationErrors?, dryRun?, info?, error?}
                                  // — full Preview outcome remembered so the
                                  // form-output pane always reflects the last attempt
    let _autoSuggested = false    // one-shot guard so we only auto-pick a
                                  // flight number once per panel mount
    let _automateInFlight = false // true while auto-build is computing
    let _applyInFlight    = false // true while apply-batch is running
    let _applyTotal       = 0     // legs count for the currently applying batch
    let _busListenersAttached = false
    let _lastBuild        = null  // most recent Build object from the auto-scheduler
    // Decision sidebar (F1) — dedupe key + in-flight cancel + debounce timer.
    // Sidebar reacts to FROM/TO changes only; PRICE/SERVICE/FLIGHT# edits
    // don't refetch since the profit estimator doesn't consume those fields.
    let _lastSidebarKey       = null
    let _sidebarCtrl          = null   // AbortController-shaped flag (uses .aborted)
    let _sidebarRenderTimer   = null
    let _turnMin          = 30    // minutes between this leg's arrival and the
                                  // next leg's departure for Continue → /
                                  // ← Continue back. Default 30 = AS minimum
                                  // turn; user-editable inline. Module-scoped
                                  // so it persists across button presses but
                                  // not across page mounts.
    let _planner = {
        hub:          "",
        airports:     "",
        flightCount:  4,
        startTime:    "09:00",
        turnMin:      30,
        pattern:      "roundtrip",
        priceMode:    "demand",
        longDrift:    true,
        lastMock:     [],
        lastMessage:  ""
    }
    // F2 — Flight Studio templates. Cached per-server Template[] so the
    // dropdown can render synchronously; _paintTemplatesRow refreshes it
    // after every save/delete and on initial mount.
    let _templates = []
    let _templatesLoadedFor = null

    // AS form mirror (transitional bridge). Wires AS's "New Flight Number"
    // form values into the spec live so the two never disagree on what's
    // about to be POSTed. One-way (AS → Studio); _pushToAsForm covers the
    // reverse on Preview / paste / Reset. When Studio learns to submit on
    // its own, this block + the _suppressAsMirror wrap on _pushToAsForm +
    // the AS-overlay branch in _resolveInitialSpec all delete cleanly.
    let _suppressAsMirror = false  // gates listeners during _pushToAsForm
                                   //   to break the feedback loop on the
                                   //   flight-# input (form-driver.js:345
                                   //   dispatches `input`/`change`/`blur`
                                   //   on programmatic writes there)
    let _lastAsFormNode   = null   // form node we last attached to;
                                   //   identity-compare to detect tab-swap
                                   //   remounts (no event fires on tab
                                   //   switch — see form-driver.js:266-289)
    let _asMirrorHandlers = null   // listener handle bag for clean detach
    let _asMirrorTimer    = null   // 750ms re-poll for self-healing attach

    // ── ctx helpers ──────────────────────────────────────────────────────
    function _ctx()    { return (window.AesAfp && window.AesAfp.ctx) || null }
    function _bus()    { return (window.AesAfp && window.AesAfp.bus) || null }
    function _defaultDayMask() { return [true, true, true, true, true, true, true] }
    function _legDayMask(leg) {
        return leg && Array.isArray(leg.dayMask) && leg.dayMask.length >= 7
            ? leg.dayMask.slice(0, 7).map(Boolean)
            : _defaultDayMask()
    }
    function _activeHubIata() {
        try {
            const hub = window.AesAfp && typeof window.AesAfp.getActiveHub === "function"
                ? window.AesAfp.getActiveHub()
                : null
            const norm = _normIata(hub)
            if (norm) return norm
        } catch (_) { /* fall back to page ctx */ }
        const ctx = _ctx()
        return _normIata(ctx && ctx.currentLocationIata)
    }
    function _emit(name, payload) {
        const bus = _bus()
        if (bus && typeof bus.emit === "function") {
            try { bus.emit(name, payload) } catch (_) { /* bus self-isolates */ }
        }
    }
    function _slot() {
        try {
            return (window.AesAfp && typeof window.AesAfp.slot === "function")
                ? window.AesAfp.slot(SLOT_NAME) : null
        } catch (_) { return null }
    }

    // ── Spec lifecycle ───────────────────────────────────────────────────

    /** Resolve initial spec: load draft from store, else seed from ctx.
     *  When AS's "New Flight Number" form is mounted, overlay its current
     *  field values onto leg 0 so Studio doesn't paint a stale draft that
     *  disagrees with what the green "Create new flight number" button
     *  would POST. Skipped for multi-leg specs to preserve auto-build
     *  state — the user's own Studio→AS Preview is the authoritative
     *  push for multi-leg work. */
    async function _resolveInitialSpec() {
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            return _seedSpec(ctx)
        }
        let base = null
        if (window.AesAfpStudioDraftStore) {
            try {
                const rec = await window.AesAfpStudioDraftStore.load(ctx.server, ctx.aircraftId)
                if (rec && rec.spec) base = window.AesAfpLegSpec.normalizeSpec(rec.spec)
            } catch (e) {
                console.warn("[AES studio] draft load threw", e)
            }
        }
        if (!base) base = _seedSpec(ctx)
        if (Array.isArray(base.legs) && base.legs.length === 1) {
            const snap = _readAsFormSnapshot()
            if (snap) base = _overlayAsSnapshotOnSpec(base, snap)
        }
        return _syncBlankDraftOriginToActiveHub(base)
    }

    function _seedSpec(ctx) {
        return window.AesAfpLegSpec.createSpec({
            server:      ctx ? ctx.server     : "",
            aircraftId:  ctx ? ctx.aircraftId : "",
            origin:      _activeHubIata(),
            source:      "manual",
            dryRun:      false
        })
    }

    function _isBlankSingleLegDraft(spec) {
        if (!spec || !Array.isArray(spec.legs) || spec.legs.length !== 1) return false
        if (spec.source === "auto-build") return false
        const leg = spec.legs[0] || {}
        return !_normIata(leg.destination)
    }

    function _syncBlankDraftOriginToActiveHub(spec) {
        const hub = _activeHubIata()
        if (!hub || !_isBlankSingleLegDraft(spec)) return spec
        const leg = spec.legs[0] || {}
        if (_normIata(leg.origin) === hub) return spec
        return window.AesAfpLegSpec.setLegField(spec, 0, "origin", hub)
    }

    /** Save current spec to draft store, debounced. Emits draft-changed. */
    function _scheduleSave() {
        if (_saveTimer) clearTimeout(_saveTimer)
        _saveTimer = setTimeout(_flushSave, SAVE_DEBOUNCE_MS)
    }

    async function _flushSave() {
        _saveTimer = null
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) return
        if (!_spec) return
        try {
            if (window.AesAfpStudioDraftStore) {
                await window.AesAfpStudioDraftStore.save(ctx.server, ctx.aircraftId, _spec)
            }
        } catch (e) {
            console.warn("[AES studio] draft save threw", e)
        }
        _emit("studio:draft-changed", {spec: _spec})
    }

    function _updateSpec(nextSpec) {
        _spec = nextSpec
        _clearDryRunOutcome()
        _scheduleSave()
    }

    async function _updateSpecWithHistory(nextSpec) {
        if (_saveTimer) {
            clearTimeout(_saveTimer)
            await _flushSave()
        }
        _spec = nextSpec
        _clearDryRunOutcome()
        const ctx = _ctx()
        let saved = false
        if (ctx && ctx.server && ctx.aircraftId && window.AesAfpStudioDraftStore) {
            try {
                await window.AesAfpStudioDraftStore.save(ctx.server, ctx.aircraftId, _spec, {pushPrev: true})
                saved = true
            } catch (e) {
                console.warn("[AES studio] history save threw", e)
            }
        }
        if (saved) {
            _emit("studio:draft-changed", {spec: _spec})
        } else {
            _scheduleSave()
        }
    }

    function _clearDryRunOutcome() {
        _lastDryRun = null
        _lastDryRunOutcome = null
    }

    // ── Render ───────────────────────────────────────────────────────────

    /**
     * Idempotent render into AesAfp.slot("studio"). Replaces slot contents
     * — the panel owns the slot. Safe to call repeatedly (e.g. on every
     * ctx:ready re-emit).
     */
    async function render() {
        if (_renderInFlight) return
        _renderInFlight = true
        try {
            const host = _slot()
            if (!host) return
            if (!_spec) _spec = await _resolveInitialSpec()
            host.innerHTML = ""
            host.appendChild(_buildShell())
            _renderBody()
            // First-mount auto-suggest: when the user hasn't pinned a number
            // (spec.flightNumberText is null/empty) we ask AS for the next
            // available so the field reflects what AS would assign on
            // submit. Guarded by _autoSuggested so re-renders driven by
            // ctx:ready don't keep re-clicking the AS anchor.
            if (!_autoSuggested && (!_spec.flightNumberText)) {
                _autoSuggested = true
                _populateNextAvailable({silent: true}).catch(() => {})
            }
        } finally {
            _renderInFlight = false
        }
    }

    function _buildShell() {
        const root = document.createElement("div")
        root.className = "aes-afp-studio"
        root.setAttribute("data-aes-studio-root", "1")
        root.style.cssText = [
            "border-top:1px solid #1f2937",
            "padding:10px 0 8px;margin-top:8px;",
            "color:#cbd5e1;font-size:11px;line-height:1.4;"
        ].join("")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;"
        const title = document.createElement("strong")
        title.textContent = "Flight Studio"
        title.style.cssText = "font-size:12px;color:#e2e8f0;letter-spacing:0.4px;"
        const sub = document.createElement("span")
        sub.textContent = "compose · preview · apply"
        sub.style.cssText = "color:#9ca3af;font-size:10px;"
        const flex = document.createElement("span")
        flex.style.cssText = "flex:1 1 auto;"
        const modeBadge = document.createElement("span")
        modeBadge.dataset.aesStudioMode = "1"
        modeBadge.textContent = "DRAFT"
        modeBadge.style.cssText = "font-family:var(--aes-font-mono,monospace);font-size:10px;letter-spacing:0.5px;"
            + "color:#fde68a;background:#1f2937;padding:2px 6px;border-radius:3px;"
        head.append(title, sub, flex, modeBadge)
        root.appendChild(head)

        // Flex wrapper holds the form body and the F1 decision sidebar
        // side-by-side at ≥900 px panel width and stacks them vertically
        // below 900 px (the sidebar's 240 px min-width forces the wrap).
        const flexWrap = document.createElement("div")
        flexWrap.dataset.aesStudioFlex = "1"
        flexWrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;"

        // Body container — _renderBody fills it.
        const body = document.createElement("div")
        body.dataset.aesStudioBody = "1"
        body.style.cssText = "flex:1 1 600px;min-width:0;"
        flexWrap.appendChild(body)
        flexWrap.appendChild(_buildDecisionSidebar())
        root.appendChild(flexWrap)

        return root
    }

    function _renderBody() {
        const host = _slot()
        if (!host) return
        const body = host.querySelector("[data-aes-studio-body]")
        if (!body) return
        body.innerHTML = ""

        body.appendChild(_buildHint())
        body.appendChild(_buildTemplatesRow())
        body.appendChild(_buildSchedulePlanner())
        body.appendChild(_buildLegTray())
        body.appendChild(_buildSpecMeta())
        body.appendChild(_buildActions())
        if (_spec.source === "auto-build" && _spec.legs.length > 1) {
            body.appendChild(_buildAutoBuildSummary())
        }
        body.appendChild(_buildAutomateActions())
        body.appendChild(_buildScheduleDiagnostics())
        body.appendChild(_buildDryRunPane())
        _updateModeBadge()
        // Repaint the F1 decision sidebar against the latest spec. Cheap
        // when the OD pair hasn't changed (deduped via _lastSidebarKey).
        _renderSidebarFor(_spec).catch(() => { /* sidebar self-isolates */ })
        // F2 — async-fill the templates dropdown after the body lands so
        // the synchronous render path stays fast. Self-isolates on error.
        _paintTemplatesRow().catch(() => { /* templates row self-isolates */ })
    }

    // ── F1 — Decision-support sidebar ────────────────────────────────────
    //
    // Surfaces, for the current FROM→TO leg: route distance, pax/cargo
    // demand bars (RouteAssistantDemandStore — no hourly source exists),
    // top-3 current operators (FlightsFromStore.routes[].airlines), and a
    // static profit estimate (RouteAssistantProfitEstimator with the
    // standard economics block — NOT PRICE-reactive). Each section fails
    // soft so a missing demand record doesn't blank the operators row.
    //
    // Reactivity: subscribes to studio:draft-changed (debounced 200 ms)
    // and dedupes on FROM:TO so PRICE/SERVICE/FLIGHT# edits don't refetch.
    //
    // CB2 (FACET overhaul): when body.aes-cubist is set, _paintSidebar
    // and _renderSidebarPlaceholder dispatch to bone-toned totem renderers
    // built on AESCubistPrimitives. The data path is unchanged — only the
    // visual surface differs. Toggle via central-hub Settings tile.

    function _isCubist() {
        try {
            return typeof document !== "undefined"
                && document.body && document.body.classList
                && document.body.classList.contains("aes-cubist")
                && !!window.AESCubistPrimitives
        } catch (_) { return false }
    }

    function _buildDecisionSidebar() {
        const sidebar = document.createElement("div")
        sidebar.dataset.aesStudioSidebar = "1"
        sidebar.style.cssText = "flex:0 1 280px;min-width:240px;"
            + "border:1px solid #1f2937;border-radius:4px;padding:8px 10px;"
            + "background:#0a0e16;font-size:11px;line-height:1.5;"
        _renderSidebarPlaceholder(sidebar, "Pick a destination to see decision context.")
        return sidebar
    }

    function _sidebarHost() {
        const host = _slot()
        return host ? host.querySelector("[data-aes-studio-sidebar]") : null
    }

    function _renderSidebarPlaceholder(host, message) {
        if (!host) return
        host.innerHTML = ""
        if (_isCubist()) return _renderSidebarPlaceholderCubist(host, message)
        const head = document.createElement("div")
        head.style.cssText = "color:#e2e8f0;font-weight:600;letter-spacing:0.4px;margin-bottom:4px;"
        head.textContent = "Decision context"
        const p = document.createElement("div")
        p.style.cssText = "color:#9ca3af;font-size:10px;"
        p.textContent = message
        host.append(head, p)
    }

    function _renderSidebarPlaceholderCubist(host, message) {
        const T = window.AESTokens
        const P = window.AESCubistPrimitives
        _applyCubistSidebarHostStyle(host)
        const headFacet = P.Facet({
            shape: "wedge-tl",
            perspective: "identity",
            content: _buildStencilHeader("Decision", "context")
        })
        _applyCubistFacetFrame(headFacet, T)
        const noteFacet = P.Facet({
            shape: "trapezoid-t",
            perspective: "placeholder",
            content: _buildSidebarNoteCubist(message, T)
        })
        _applyCubistFacetFrame(noteFacet, T)
        const totem = P.Composition({preset: "totem", children: [headFacet, noteFacet]})
        host.appendChild(totem)
    }

    async function _renderSidebarFor(spec) {
        const host = _sidebarHost()
        if (!host) return
        if (!spec || !Array.isArray(spec.legs) || !spec.legs.length) {
            _renderSidebarPlaceholder(host, "Pick a destination to see decision context.")
            _lastSidebarKey = null
            return
        }
        const leg = spec.legs[0]
        const from = String((leg && leg.origin) || "").toUpperCase()
        const to   = String((leg && leg.destination) || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
            _renderSidebarPlaceholder(host, "Fill FROM + TO to see decision context.")
            _lastSidebarKey = null
            return
        }
        const key = from + ":" + to
        if (key === _lastSidebarKey) return
        _lastSidebarKey = key
        if (_sidebarCtrl) _sidebarCtrl.aborted = true
        const myCtrl = _sidebarCtrl = {aborted: false}

        const [demand, hubDemand, ffData, settings] = await Promise.all([
            (typeof RouteAssistantDemandStore !== "undefined")
                ? RouteAssistantDemandStore.get(to).catch(() => null)
                : Promise.resolve(null),
            (typeof RouteAssistantDemandStore !== "undefined")
                ? RouteAssistantDemandStore.get(from).catch(() => null)
                : Promise.resolve(null),
            (typeof FlightsFromStore !== "undefined")
                ? FlightsFromStore.loadAirport(from).catch(() => null)
                : Promise.resolve(null),
            (typeof RouteAssistantSettings !== "undefined")
                ? RouteAssistantSettings.load().catch(() => null)
                : Promise.resolve(null)
        ])
        if (myCtrl.aborted) return

        // Airport metadata for both ends (cache-only first; lazy fetch
        // missing airports without blocking the first paint).
        let hubMeta = null, destMeta = null
        const hubAirportId  = hubDemand  && hubDemand.airportId  ? String(hubDemand.airportId)  : null
        const destAirportId = demand     && demand.airportId     ? String(demand.airportId)     : null
        if (typeof RouteAssistantAirportMetaScraper !== "undefined") {
            const ids = [hubAirportId, destAirportId].filter(Boolean)
            if (ids.length) {
                try {
                    const map = await RouteAssistantAirportMetaScraper.bulkLoadCache(
                        ids, {maxAgeDays: 30})
                    if (hubAirportId)  hubMeta  = map.get(hubAirportId)  || null
                    if (destAirportId) destMeta = map.get(destAirportId) || null
                } catch (e) { /* non-fatal */ }
            }
        }
        if (myCtrl.aborted) return

        const routeRec = (ffData && Array.isArray(ffData.routes))
            ? ffData.routes.find(r => String(r && r.destIata || "").toUpperCase() === to)
            : null
        let effectiveDemand = demand
        if (!_hasPaxDemand(effectiveDemand) && routeRec && typeof FlightsFromStore !== "undefined"
                && typeof FlightsFromStore.demandForRoute === "function") {
            const ctx = (ffData && Array.isArray(ffData.routes)
                    && typeof FlightsFromStore.buildDemandContext === "function")
                ? FlightsFromStore.buildDemandContext(ffData.routes)
                : null
            effectiveDemand = FlightsFromStore.demandForRoute(routeRec, ctx)
            if (effectiveDemand) effectiveDemand.scrapedAt = ffData ? ffData.scrapedAt : null
        }
        const acSpec    = (window.AesAfpSpecResolver && window.AesAfpSpecResolver.last) || null
        const economics = (settings && settings.economics) || null

        let estimate = null
        if (typeof RouteAssistantProfitEstimator !== "undefined"
                && routeRec && Number(routeRec.distanceKm) > 0
                && acSpec && economics) {
            try {
                estimate = RouteAssistantProfitEstimator.estimate({
                    distanceKm: Number(routeRec.distanceKm),
                    spec:       acSpec,
                    paxScore:   effectiveDemand ? effectiveDemand.paxScore   : null,
                    cargoScore: effectiveDemand ? effectiveDemand.cargoScore : null,
                    economics:  economics,
                    falloffPct: settings.falloffPct
                })
            } catch (e) {
                console.warn("[AES studio] profit estimate threw", e)
            }
        }
        if (myCtrl.aborted) return

        // Cross-airline sister-fleet lookup. Hidden when the matcher
        // module is missing or the feature flag is off (handled inside
        // findForRoute). Failure-soft: empty array → no section.
        let sisterFleet = []
        if (typeof window.AesCrossAirlineOpps !== "undefined") {
            const sfCtx = _ctx()
            if (sfCtx && sfCtx.server) {
                try {
                    sisterFleet = await window.AesCrossAirlineOpps.findForRoute(
                        sfCtx.server, from, to, {
                            paxScore:   effectiveDemand && Number.isFinite(Number(effectiveDemand.paxScore))
                                            ? Number(effectiveDemand.paxScore) : null,
                            distanceKm: routeRec && Number(routeRec.distanceKm) > 0
                                            ? Number(routeRec.distanceKm) : null,
                            topN:       3
                        })
                } catch (_) { sisterFleet = [] }
            }
        }
        if (myCtrl.aborted) return

        _paintSidebar(host, {from, to, demand: effectiveDemand, routeRec, estimate, hasSpec: !!acSpec,
                             hubMeta, destMeta, sisterFleet})

        // Lazy-fetch any missing airport meta, then repaint once. Capped at
        // 2 ids (hub + dest) so this never lights up a fan-out scrape.
        const missingIds = []
        if (hubAirportId  && !hubMeta)  missingIds.push(hubAirportId)
        if (destAirportId && !destMeta) missingIds.push(destAirportId)
        if (missingIds.length && typeof RouteAssistantAirportMetaScraper !== "undefined") {
            const ctx = _ctx()
            if (ctx && ctx.server) {
                const scraper = new RouteAssistantAirportMetaScraper(ctx.server)
                scraper.bulkScrape(missingIds, {concurrency: 2, staggerMs: 600})
                    .then(async () => {
                        if (myCtrl.aborted) return
                        try {
                            const fresh = await RouteAssistantAirportMetaScraper.bulkLoadCache(
                                [hubAirportId, destAirportId].filter(Boolean), {maxAgeDays: 30})
                            const fHub  = hubAirportId  ? fresh.get(hubAirportId)  || null : null
                            const fDest = destAirportId ? fresh.get(destAirportId) || null : null
                            if (myCtrl.aborted) return
                            _paintSidebar(host, {from, to, demand: effectiveDemand, routeRec, estimate,
                                                 hasSpec: !!acSpec, hubMeta: fHub, destMeta: fDest,
                                                 sisterFleet})
                        } catch (e) { /* non-fatal */ }
                    })
                    .catch(() => { /* non-fatal */ })
            }
        }
    }

    function _paintSidebar(host, data) {
        host.innerHTML = ""
        if (_isCubist()) return _paintSidebarCubist(host, data)
        const {from, to, demand, routeRec, estimate, hasSpec, hubMeta, destMeta,
               sisterFleet} = data

        const header = document.createElement("div")
        header.style.cssText = "color:#e2e8f0;font-weight:600;letter-spacing:0.4px;margin-bottom:6px;"
        const distKm = routeRec && Number(routeRec.distanceKm) > 0
            ? Math.round(routeRec.distanceKm) : null
        const blockH = (estimate && estimate.blockHours != null) ? estimate.blockHours : null
        header.textContent = from + " → " + to
            + " · " + (distKm != null ? distKm + " km" : "— km")
            + (blockH != null ? " · " + blockH + " h block" : "")
        host.appendChild(header)

        host.appendChild(_buildSidebarSection("Demand", _buildDemandRows(demand)))
        host.appendChild(_buildSidebarSection("Operators", _buildOperatorRows(routeRec)))
        if (Array.isArray(sisterFleet) && sisterFleet.length) {
            host.appendChild(_buildSidebarSection("Sister fleet",
                _buildSisterFleetRows(sisterFleet, from)))
        }
        host.appendChild(_buildSidebarSection("Airport facts",
            _buildAirportFactsRows(from, hubMeta, to, destMeta)))
        host.appendChild(_buildSidebarSection("Profit estimate",
            _buildProfitRows(estimate, hasSpec)))
    }

    // ── CB2 — Cubist totem rendering ─────────────────────────────────────
    //
    // Mirrors _paintSidebar's section list but routes each through cubist
    // Facet primitives wrapped in a Composition(totem). The inner content
    // is rebuilt against AESTokens (bone/oxide/slate) so labels and bars
    // read correctly on the bone background — the dark-slate hex palette
    // used by F1's orthogonal mode would clash on bone.
    //
    // Section shapes alternate to create interlocking diagonal seams:
    // identity wedge-tl → demand trapezoid-t → operators trapezoid-b →
    // [sister lozenge-c?] → airport wedge-br → profit pentagon-r.

    function _paintSidebarCubist(host, data) {
        const T = window.AESTokens
        const P = window.AESCubistPrimitives
        const {from, to, demand, routeRec, estimate, hasSpec, hubMeta, destMeta,
               sisterFleet} = data

        _applyCubistSidebarHostStyle(host)

        const distKm = routeRec && Number(routeRec.distanceKm) > 0
            ? Math.round(routeRec.distanceKm) : null
        const blockH = (estimate && estimate.blockHours != null) ? estimate.blockHours : null

        const facets = []

        // Identity wedge — route + distance/block as a stencil
        const identity = P.Facet({
            shape: "wedge-tl",
            perspective: "identity",
            content: _buildIdentityCubist(from, to, distKm, blockH, T)
        })
        _applyCubistFacetFrame(identity, T)
        facets.push(identity)

        // Demand
        const demandFacet = P.Facet({
            shape: "trapezoid-t",
            perspective: "demand",
            content: _buildSidebarSectionCubist("Demand",
                _buildDemandRowsCubist(demand, T), T)
        })
        _applyCubistFacetFrame(demandFacet, T)
        facets.push(demandFacet)

        // Operators
        const opsFacet = P.Facet({
            shape: "trapezoid-b",
            perspective: "operators",
            content: _buildSidebarSectionCubist("Operators",
                _buildOperatorRowsCubist(routeRec, T), T)
        })
        _applyCubistFacetFrame(opsFacet, T)
        facets.push(opsFacet)

        if (Array.isArray(sisterFleet) && sisterFleet.length) {
            const sisterFacet = P.Facet({
                shape: "lozenge-c",
                perspective: "sister",
                content: _buildSidebarSectionCubist("Sister fleet",
                    _buildSisterFleetRowsCubist(sisterFleet, from, T), T)
            })
            _applyCubistFacetFrame(sisterFacet, T)
            facets.push(sisterFacet)
        }

        // Airport facts
        const airportFacet = P.Facet({
            shape: "wedge-br",
            perspective: "airport",
            content: _buildSidebarSectionCubist("Airport facts",
                _buildAirportFactsRowsCubist(from, hubMeta, to, destMeta, T), T)
        })
        _applyCubistFacetFrame(airportFacet, T)
        facets.push(airportFacet)

        // Profit
        const profitFacet = P.Facet({
            shape: "pentagon-r",
            perspective: "profit",
            content: _buildSidebarSectionCubist("Profit estimate",
                _buildProfitRowsCubist(estimate, hasSpec, T), T)
        })
        _applyCubistFacetFrame(profitFacet, T)
        facets.push(profitFacet)

        const totem = P.Composition({preset: "totem", children: facets})
        host.appendChild(totem)
    }

    function _applyCubistSidebarHostStyle(host) {
        const T = window.AESTokens
        host.style.cssText = [
            "flex:0 1 280px",
            "min-width:240px",
            "padding:" + T.sp[3],
            "background:" + T.color.bone,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "color:" + T.color.oxide,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "line-height:" + T.lh.body,
            "box-sizing:border-box"
        ].join(";")
    }

    function _applyCubistFacetFrame(facet, T) {
        facet.style.cssText += ";background:" + T.color.bone2
            + ";color:" + T.color.oxide
            + ";padding:" + T.sp[3]
            + ";min-height:64px"
            + ";box-sizing:border-box"
    }

    function _buildStencilHeader(text, subtext) {
        const P = window.AESCubistPrimitives
        const wrap = document.createElement("div")
        wrap.appendChild(P.Stencil({text: text, subtext: subtext || ""}))
        return wrap
    }

    function _buildIdentityCubist(from, to, distKm, blockH, T) {
        const P = window.AESCubistPrimitives
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1]

        const route = document.createElement("div")
        route.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.h3,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide
        ].join(";")
        route.textContent = (from || "—") + " → " + (to || "—")

        const meta = document.createElement("div")
        meta.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "color:" + T.color.slate
        ].join(";")
        const parts = []
        if (distKm != null) parts.push(distKm + " km")
        if (blockH  != null) parts.push(blockH + " h block")
        meta.textContent = parts.length ? parts.join(" · ") : "— km · — h block"

        const stencil = P.Stencil({text: "Identity"})
        wrap.append(stencil, route, meta)
        return wrap
    }

    function _buildSidebarSectionCubist(label, contentEl, T) {
        const P = window.AESCubistPrimitives
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1]
        wrap.appendChild(P.Stencil({text: label}))
        wrap.appendChild(contentEl)
        return wrap
    }

    function _buildSidebarNoteCubist(text, T) {
        const note = document.createElement("div")
        note.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "color:" + T.color.slate,
            "font-style:italic"
        ].join(";")
        note.textContent = text
        return note
    }

    function _buildDemandRowsCubist(demand, T) {
        if (!demand) return _buildSidebarNoteCubist(
            "No demand data — run the route-assistant demand scan.", T)
        if (demand.source === "flightsfrom" || demand.demandSource === "flightsfrom") {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1]
            const src = document.createElement("div")
            src.style.cssText = "font-family:" + T.font.display + ";font-size:" + T.fs.micro
                + ";color:" + T.color.slate + ";text-transform:uppercase;letter-spacing:" + T.track.caps
            src.textContent = "FlightsFrom frequency"
            wrap.appendChild(src)
            wrap.appendChild(_makeScoreBarCubist("Pax", demand.paxScore, T.color.cobalt, T))
            const meta = document.createElement("div")
            meta.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro
                + ";color:" + T.color.oxide2 + ";letter-spacing:" + T.track.mono
            meta.textContent = demand.demandBasis || (
                demand.weeklyFlights != null ? demand.weeklyFlights + "×/wk" : "frequency present")
            wrap.appendChild(meta)
            const cargo = document.createElement("div")
            cargo.style.cssText = "font-family:" + T.font.display + ";font-size:" + T.fs.micro
                + ";color:" + T.color.slate
            cargo.textContent = "Cargo unavailable from FlightsFrom."
            wrap.appendChild(cargo)
            return wrap
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1]
        wrap.appendChild(_makeScoreBarCubist("Pax",   demand.paxScore,   T.color.cobalt, T))
        wrap.appendChild(_makeScoreBarCubist("Cargo", demand.cargoScore, T.color.amber,  T))
        if (demand.scrapedAt && Date.now() - demand.scrapedAt > 7 * 86400000) {
            const stale = document.createElement("div")
            stale.style.cssText = "font-family:" + T.font.display
                + ";font-size:" + T.fs.micro + ";color:" + T.color.amber
            stale.textContent = "stale (>7 days)"
            wrap.appendChild(stale)
        }
        return wrap
    }

    function _makeScoreBarCubist(label, score, fillColor, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:" + T.sp[2]
            + ";font-size:" + T.fs.micro
        const lbl = document.createElement("span")
        lbl.style.cssText = "color:" + T.color.slate + ";width:36px;flex:0 0 36px;"
            + "font-family:" + T.font.display + ";text-transform:uppercase;"
            + "letter-spacing:" + T.track.caps + ";"
        lbl.textContent = label
        const bar = document.createElement("span")
        bar.style.cssText = "flex:1 1 auto;display:inline-flex;gap:1px;"
        const filled = (score == null) ? 0 : Math.max(0, Math.min(10, Math.round(Number(score) || 0)))
        for (let i = 0; i < 10; i++) {
            const cell = document.createElement("span")
            cell.style.cssText = "flex:1 1 0;height:8px;"
                + "background:" + (i < filled ? fillColor : T.color.bone3) + ";"
            bar.appendChild(cell)
        }
        const num = document.createElement("span")
        num.textContent = (score == null) ? "—" : (filled + "/10")
        num.style.cssText = "color:" + T.color.oxide + ";width:36px;flex:0 0 36px;text-align:right;"
            + "font-family:" + T.font.mono + ";letter-spacing:" + T.track.mono + ";"
        wrap.append(lbl, bar, num)
        return wrap
    }

    function _buildOperatorRowsCubist(routeRec, T) {
        if (!routeRec) return _buildSidebarNoteCubist(
            "Hub data missing — run ↻ Update / Scan flightsfrom.com.", T)
        if (!Array.isArray(routeRec.airlines) || !routeRec.airlines.length) {
            return _buildSidebarNoteCubist("Carrier list not yet scanned for this route.", T)
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1]
        const sorted = routeRec.airlines.slice()
            .sort((a, b) => (Number(b && b.frequency) || 0) - (Number(a && a.frequency) || 0))
        for (const a of sorted.slice(0, 3)) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;"
                + "color:" + T.color.oxide + ";font-size:" + T.fs.small + ";"
                + "border-bottom:" + T.geom.bw1 + " dashed " + T.color.paperRule
                + ";padding-bottom:" + T.sp[1]
            const name = document.createElement("span")
            name.style.cssText = "font-family:" + T.font.display + ";font-weight:" + T.fw.bold
            name.textContent = a.code || a.name || "—"
            const freq = document.createElement("span")
            freq.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono
                + ";letter-spacing:" + T.track.mono
            freq.textContent = (Number(a.frequency) || 0) + "×/wk"
            row.append(name, freq)
            wrap.appendChild(row)
        }
        return wrap
    }

    function _buildSisterFleetRowsCubist(matches, originIata, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1]
        for (const m of matches) {
            const row = document.createElement("div")
            row.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2]
                + ";background:" + T.color.bone + ";border:" + T.geom.bw1 + " solid "
                + T.color.paperRule + ";line-height:" + T.lh.tight
            const lineA = document.createElement("div")
            lineA.style.cssText = "color:" + T.color.oxide + ";font-size:" + T.fs.small
                + ";font-family:" + T.font.mono
            lineA.textContent = (m.idleAircraft.equipment || "?")
                + " · " + (m.idleAircraft.registration || "—")
            row.appendChild(lineA)

            const lineB = document.createElement("div")
            lineB.style.cssText = "color:" + T.color.oxide2 + ";font-size:" + T.fs.micro
            const ident = m.idleAirline.displayName || m.idleAirline.airline
            const base = m.idleAircraft.baseIata
            const atOrigin = base === originIata
            lineB.textContent = ident + " · idle " + Math.round(m.headroomHours) + "h"
                + (base ? " · at " + base + (atOrigin ? " ✓" : "") : "")
            row.appendChild(lineB)

            if (base && !atOrigin) {
                const ferry = document.createElement("div")
                ferry.style.cssText = "color:" + T.color.amber + ";font-size:" + T.fs.micro
                ferry.textContent = "ferry " + base + "→" + originIata
                    + (m.ferryKm > 0 ? " (" + Math.round(m.ferryKm) + "km)" : "")
                row.appendChild(ferry)
            }
            wrap.appendChild(row)
        }
        return wrap
    }

    function _buildAirportFactsRowsCubist(fromIata, hubMeta, toIata, destMeta, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:" + T.sp[2]
            + ";font-size:" + T.fs.micro

        const card = (iata, meta) => {
            const box = document.createElement("div")
            box.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2]
                + ";background:" + T.color.bone + ";border:" + T.geom.bw1
                + " solid " + T.color.paperRule + ";line-height:" + T.lh.body
            const head = document.createElement("div")
            head.style.cssText = "color:" + T.color.oxide + ";font-weight:" + T.fw.bold
                + ";font-size:" + T.fs.small + ";font-family:" + T.font.mono
                + ";letter-spacing:" + T.track.mono
            head.textContent = iata
            box.appendChild(head)

            if (!meta) {
                const note = document.createElement("div")
                note.textContent = "loading…"
                note.style.cssText = "color:" + T.color.slate + ";font-style:italic"
                box.appendChild(note)
                return box
            }

            const fact = (label, value, color) => {
                const r = document.createElement("div")
                r.style.cssText = "display:flex;justify-content:space-between;gap:" + T.sp[1]
                const lbl = document.createElement("span")
                lbl.style.color = T.color.slate
                lbl.textContent = label
                const val = document.createElement("span")
                val.style.color = color || T.color.oxide
                val.textContent = value
                r.append(lbl, val)
                box.appendChild(r)
            }

            fact("Size", meta.sizeClass || "—",
                meta.sizeClass ? T.color.oxide : T.color.slate)
            fact("Runway", meta.runwayLengthM != null ? meta.runwayLengthM + " m" : "—")
            fact("Curfew",
                meta.curfewLabel || (meta.nightCurfew ? "yes" :
                    meta.nightCurfew === false ? "none" : "—"),
                meta.nightCurfew ? T.color.rust : null)
            fact("Noise",
                meta.noiseLabel || (meta.noiseRestricted ? "yes" :
                    meta.noiseRestricted === false ? "none" : "—"),
                meta.noiseRestricted ? T.color.amber : null)
            fact("Turn",
                meta.turnaroundMin != null ? meta.turnaroundMin + " min" : "—")
            return box
        }

        wrap.appendChild(card(fromIata, hubMeta))
        wrap.appendChild(card(toIata,   destMeta))
        return wrap
    }

    function _buildProfitRowsCubist(estimate, hasSpec, T) {
        if (!hasSpec) return _buildSidebarNoteCubist("Resolving aircraft spec…", T)
        if (!estimate || !estimate.specOk) {
            return _buildSidebarNoteCubist("Profit estimate unavailable.", T)
        }
        if (estimate.fit === "oor") {
            return _buildSidebarNoteCubist("Out of range for this aircraft.", T)
        }
        if (estimate.profitPerFlight == null) {
            return _buildSidebarNoteCubist(estimate.isCargoOnly
                ? "Cargo-only spec — profit math out of scope (block "
                    + (estimate.blockHours || "—") + " h)."
                : "Profit estimate unavailable.", T)
        }
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1]
        const fmt = new Intl.NumberFormat("en-US",
            {style: "currency", currency: "USD", maximumFractionDigits: 0})
        const big = document.createElement("div")
        const profitColor = estimate.profitPerFlight >= 0 ? T.color.moss : T.color.crimson
        big.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.h3
            + ";font-weight:" + T.fw.display + ";color:" + profitColor
            + ";letter-spacing:" + T.track.mono
        big.textContent = fmt.format(estimate.profitPerFlight)
        const sub = document.createElement("div")
        sub.style.cssText = "font-family:" + T.font.display + ";font-size:" + T.fs.small
            + ";color:" + T.color.oxide2
        sub.textContent = fmt.format(estimate.profitPerWeek) + " /wk · per flight ↑"
        const fitBadge = document.createElement("div")
        fitBadge.style.cssText = "font-size:" + T.fs.micro + ";color:"
            + (estimate.fit === "falloff" ? T.color.amber : T.color.slate)
        fitBadge.textContent = "fit · " + estimate.fit
        wrap.append(big, sub, fitBadge)
        return wrap
    }

    function _buildSisterFleetRows(matches, originIata) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:5px;"
        for (const m of matches) {
            const row = document.createElement("div")
            row.style.cssText = "padding:4px 6px;border:1px solid #1f2937;border-radius:3px;"
                + "background:#0f1623;line-height:1.4;"
            const lineA = document.createElement("div")
            lineA.style.cssText = "color:#e2e8f0;font-size:11px;"
            lineA.textContent = "✈ " + (m.idleAircraft.equipment || "?")
                + " · " + (m.idleAircraft.registration || "—")
            row.appendChild(lineA)

            const lineB = document.createElement("div")
            lineB.style.cssText = "color:#cbd5e1;font-size:10px;"
            const ident = m.idleAirline.displayName || m.idleAirline.airline
            const base = m.idleAircraft.baseIata
            const atOrigin = base === originIata
            lineB.textContent = ident + " · idle " + Math.round(m.headroomHours) + "h"
                + (base ? " · at " + base + (atOrigin ? " ✓" : "") : "")
            row.appendChild(lineB)

            const lineC = document.createElement("div")
            lineC.style.cssText = "color:#9ca3af;font-size:10px;margin-top:1px;"
            lineC.textContent = "seatFit " + (Number(m.seatFit) || 0).toFixed(2)
            row.appendChild(lineC)

            if (base && !atOrigin) {
                const ferry = document.createElement("div")
                ferry.style.cssText = "color:#fde68a;font-size:9px;margin-top:1px;"
                ferry.textContent = "⚠ ferry " + base + "→" + originIata
                    + (m.ferryKm > 0 ? " (" + Math.round(m.ferryKm) + "km)" : "")
                row.appendChild(ferry)
            }
            if (m.staleAirline) {
                const stale = document.createElement("div")
                stale.style.cssText = "color:#9ca3af;font-size:9px;margin-top:1px;font-style:italic;"
                stale.textContent = "⚠ stale data"
                row.appendChild(stale)
            }
            wrap.appendChild(row)
        }
        return wrap
    }

    function _buildSidebarSection(label, contentEl) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-bottom:8px;"
        const lbl = document.createElement("div")
        lbl.textContent = label
        lbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;"
            + "letter-spacing:0.5px;margin-bottom:3px;"
        wrap.append(lbl, contentEl)
        return wrap
    }

    function _buildDemandRows(demand) {
        if (!demand) return _sidebarNote("No demand data — run the route-assistant demand scan.")
        if (demand.source === "flightsfrom" || demand.demandSource === "flightsfrom") {
            const wrap = document.createElement("div")
            const src = document.createElement("div")
            src.textContent = "FlightsFrom frequency"
            src.style.cssText = "color:#9ca3af;font-size:9px;text-transform:uppercase;"
                + "letter-spacing:0.5px;margin-bottom:2px;"
            wrap.appendChild(src)
            wrap.appendChild(_makeScoreBar("Pax", demand.paxScore, "#60a5fa"))
            const meta = document.createElement("div")
            meta.textContent = demand.demandBasis || (
                demand.weeklyFlights != null ? demand.weeklyFlights + "×/wk" : "frequency present")
            meta.style.cssText = "color:#cbd5e1;font-size:10px;font-family:var(--aes-font-mono,monospace);"
                + "margin-top:2px;"
            wrap.appendChild(meta)
            const cargo = document.createElement("div")
            cargo.textContent = "Cargo unavailable from FlightsFrom."
            cargo.style.cssText = "color:#6b7280;font-size:9px;margin-top:2px;"
            wrap.appendChild(cargo)
            return wrap
        }
        const wrap = document.createElement("div")
        wrap.appendChild(_makeScoreBar("Pax",   demand.paxScore,   "#60a5fa"))
        wrap.appendChild(_makeScoreBar("Cargo", demand.cargoScore, "#fbbf24"))
        if (demand.scrapedAt && Date.now() - demand.scrapedAt > 7 * 86400000) {
            const stale = document.createElement("div")
            stale.textContent = "⚠ stale (>7 days)"
            stale.style.cssText = "color:#fde68a;font-size:9px;margin-top:2px;"
            wrap.appendChild(stale)
        }
        return wrap
    }

    function _hasPaxDemand(demand) {
        return !!(demand && demand.paxScore !== null && demand.paxScore !== undefined
            && isFinite(Number(demand.paxScore)))
    }

    function _buildOperatorRows(routeRec) {
        if (!routeRec) return _sidebarNote("Hub data missing — run ↻ Update / Scan flightsfrom.com.")
        if (!Array.isArray(routeRec.airlines) || !routeRec.airlines.length) {
            return _sidebarNote("Carrier list not yet scanned for this route.")
        }
        const wrap = document.createElement("div")
        const sorted = routeRec.airlines.slice()
            .sort((a, b) => (Number(b && b.frequency) || 0) - (Number(a && a.frequency) || 0))
        for (const a of sorted.slice(0, 3)) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;justify-content:space-between;color:#cbd5e1;font-size:11px;"
            const name = document.createElement("span")
            name.textContent = a.code || a.name || "—"
            const freq = document.createElement("span")
            freq.style.color = "#9ca3af"
            freq.textContent = (Number(a.frequency) || 0) + "×/wk"
            row.append(name, freq)
            wrap.appendChild(row)
        }
        return wrap
    }

    function _buildAirportFactsRows(fromIata, hubMeta, toIata, destMeta) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;"
            + "font-size:10px;color:#cbd5e1;"

        const card = (iata, meta) => {
            const box = document.createElement("div")
            box.style.cssText = "padding:5px 6px;border:1px solid #1f2937;border-radius:4px;"
                + "background:#0f1623;line-height:1.45;"
            const head = document.createElement("div")
            head.style.cssText = "color:#e2e8f0;font-weight:600;font-size:11px;margin-bottom:2px;"
            head.textContent = iata
            box.appendChild(head)

            if (!meta) {
                const note = document.createElement("div")
                note.textContent = "— loading…"
                note.style.cssText = "color:#6b7280;font-style:italic;"
                box.appendChild(note)
                return box
            }

            const fact = (label, value, color) => {
                const row = document.createElement("div")
                row.style.cssText = "display:flex;justify-content:space-between;gap:4px;"
                const lbl = document.createElement("span")
                lbl.style.color = "#9ca3af"
                lbl.textContent = label
                const val = document.createElement("span")
                val.style.color = color || "#cbd5e1"
                val.textContent = value
                row.append(lbl, val)
                box.appendChild(row)
            }

            fact("Size",
                meta.sizeClass || "—",
                meta.sizeClass ? "#f3f4f6" : "#6b7280")
            fact("Runway",
                meta.runwayLengthM != null ? meta.runwayLengthM + " m" : "—")
            fact("Curfew",
                meta.curfewLabel || (meta.nightCurfew ? "yes" : meta.nightCurfew === false ? "none" : "—"),
                meta.nightCurfew ? "#a78bfa" : null)
            fact("Noise",
                meta.noiseLabel || (meta.noiseRestricted ? "yes" : meta.noiseRestricted === false ? "none" : "—"),
                meta.noiseRestricted ? "#fbbf24" : null)
            fact("Turn",
                meta.turnaroundMin != null ? meta.turnaroundMin + " min" : "—")
            return box
        }

        wrap.appendChild(card(fromIata, hubMeta))
        wrap.appendChild(card(toIata,   destMeta))
        return wrap
    }

    function _buildProfitRows(estimate, hasSpec) {
        if (!hasSpec) return _sidebarNote("Resolving aircraft spec…")
        if (!estimate || !estimate.specOk) return _sidebarNote("Profit estimate unavailable.")
        if (estimate.fit === "oor") return _sidebarNote("Out of range for this aircraft.")
        if (estimate.profitPerFlight == null) {
            return _sidebarNote(estimate.isCargoOnly
                ? "Cargo-only spec — profit math out of scope (block " + (estimate.blockHours || "—") + " h)."
                : "Profit estimate unavailable.")
        }
        const wrap = document.createElement("div")
        const fmt = new Intl.NumberFormat("en-US",
            {style: "currency", currency: "USD", maximumFractionDigits: 0})
        const row = document.createElement("div")
        row.style.color = "#cbd5e1"
        row.textContent = fmt.format(estimate.profitPerFlight) + " /flight · "
            + fmt.format(estimate.profitPerWeek) + " /week"
        wrap.appendChild(row)
        const fitBadge = document.createElement("div")
        fitBadge.style.cssText = "color:" + (estimate.fit === "falloff" ? "#fde68a" : "#9ca3af")
            + ";font-size:9px;margin-top:2px;"
        fitBadge.textContent = "fit: " + estimate.fit
        wrap.appendChild(fitBadge)
        return wrap
    }

    function _sidebarNote(text) {
        const note = document.createElement("div")
        note.style.cssText = "color:#94a3b8;font-size:10px;"
        note.textContent = text
        return note
    }

    function _makeScoreBar(label, score, color) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:2px;"
        const lbl = document.createElement("span")
        lbl.textContent = label
        lbl.style.cssText = "color:#9ca3af;width:36px;flex:0 0 36px;"
        const bar = document.createElement("span")
        bar.style.cssText = "flex:1 1 auto;display:inline-flex;gap:1px;"
        const filled = (score == null) ? 0 : Math.max(0, Math.min(10, Math.round(Number(score) || 0)))
        for (let i = 0; i < 10; i++) {
            const cell = document.createElement("span")
            cell.style.cssText = "flex:1 1 0;height:8px;border-radius:1px;"
                + "background:" + (i < filled ? color : "#1f2937") + ";"
            bar.appendChild(cell)
        }
        const num = document.createElement("span")
        num.textContent = (score == null) ? "—" : (filled + "/10")
        num.style.cssText = "color:#cbd5e1;width:30px;flex:0 0 30px;text-align:right;"
            + "font-family:var(--aes-font-mono,monospace);"
        wrap.append(lbl, bar, num)
        return wrap
    }

    // ── Schedule Diagnostics — Time-window rebalance ─────────────────────

    const DAY_NAMES_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    /**
     * Scan the AS planning matrix for active days where the "Time window"
     * row is ✗ (round-trip + ground time exceeds the daily slot). Render
     * a banner offering to disable just those days — never alters routes.
     *
     * Returns an empty fragment when the matrix is healthy (or absent),
     * keeping Studio's body clean on well-configured aircraft.
     */
    function _buildScheduleDiagnostics() {
        const wrap = document.createElement("div")
        wrap.dataset.aesStudioDiag = "1"

        if (typeof window.AesAfpPlanningMatrixReader === "undefined") return wrap
        let matrix
        try { matrix = window.AesAfpPlanningMatrixReader.read() }
        catch (e) { return wrap }
        if (!matrix || !matrix.isPresent || !Array.isArray(matrix.segments)) return wrap

        // Collect failing days. A day fails if it's currently active
        // (matrix.daysActive[d] === true) and ANY segment reports
        // timeWindowOk === false for that day. Per-day dedupe via Set.
        const failingDays = new Set()
        for (const seg of matrix.segments) {
            if (!seg || !Array.isArray(seg.cells)) continue
            for (const cell of seg.cells) {
                if (!cell) continue
                if (!cell.enabled) continue
                if (cell.timeWindowOk === false) failingDays.add(cell.dayIdx)
            }
        }
        if (!failingDays.size) return wrap

        const days = [...failingDays].sort((a, b) => a - b)
        const dayLabels = days.map(d => DAY_NAMES_SHORT[d] || ("D" + d))

        const banner = document.createElement("div")
        banner.style.cssText = "margin:6px 0;padding:6px 8px;border-radius:3px;"
            + "background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.45);"
            + "display:flex;align-items:center;gap:8px;flex-wrap:wrap;"

        const icon = document.createElement("span")
        icon.textContent = "⚠"
        icon.style.cssText = "color:#fbbf24;font-size:13px;"
        banner.appendChild(icon)

        const text = document.createElement("span")
        text.style.cssText = "color:#fde68a;font-size:11px;flex:1;line-height:1.4;"
        text.textContent = "Time window fails on " + dayLabels.join(", ")
            + " — round-trip won't fit the slot."
        banner.appendChild(text)

        const btn = _mkBtn("Disable failing days", "primary", async () => {
            const fd = window.AesAfpFormDriver
            if (!fd || typeof fd.setDayActive !== "function") {
                _renderHint("error", "Form driver not loaded — cannot toggle day selection.")
                return
            }
            btn.disabled = true
            const toggled = []
            for (const d of days) {
                if (fd.setDayActive(d, false)) toggled.push(d)
            }
            if (window.AesAfpAuditLog && typeof window.AesAfpAuditLog.add === "function") {
                try {
                    await window.AesAfpAuditLog.add({
                        action: "time-window-disable-days",
                        days: toggled,
                        dayNames: toggled.map(d => DAY_NAMES_SHORT[d] || ("D" + d))
                    })
                } catch (_) { /* non-fatal */ }
            }
            _renderHint("info", "Disabled " + toggled.map(d => DAY_NAMES_SHORT[d]).join(", ")
                + " — review and click 'Apply schedule settings' on AS to commit.")
            // AS dispatches its own change handler on the checkboxes; the
            // matrix repaints async, so re-render after a short tick to
            // refresh (or remove) this banner from the user's view.
            setTimeout(() => _renderBody(), 250)
        })
        btn.style.fontSize = "10px"
        banner.appendChild(btn)

        wrap.appendChild(banner)
        return wrap
    }

    /**
     * MutationObserver on the AS planning-matrix tbody — when AS re-renders
     * a row (e.g. user changed a departure offset and Wicket re-validated
     * the time window), re-paint Studio's body so the banner reflects the
     * latest state. One observer per Studio mount; debounced 200ms so a
     * burst of Wicket updates triggers a single render.
     */
    let _matrixObserver = null
    let _matrixObserverTimer = null
    function _attachMatrixObserver() {
        if (_matrixObserver) return
        const tbody = document.querySelector("form table.flight-planning-matrix tbody")
        if (!tbody) return
        _matrixObserver = new MutationObserver(() => {
            if (_matrixObserverTimer) return
            _matrixObserverTimer = setTimeout(() => {
                _matrixObserverTimer = null
                _renderBody()
            }, 200)
        })
        _matrixObserver.observe(tbody, {childList: true, subtree: true, characterData: true})
    }

    function _buildHint() {
        const ctx = _ctx()
        const hint = document.createElement("div")
        hint.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            hint.textContent = "Aircraft context not yet resolved — open this from an aircraft Flight Plan page."
            hint.style.color = "#fca5a5"
        } else {
            const activeHub = _activeHubIata()
            const loc = _normIata(ctx.currentLocationIata)
            const parts = ["Plan hub: " + (activeHub || "??")]
            if (loc && activeHub && loc !== activeHub) parts.push("aircraft at " + loc)
            parts.push(ctx.registration)
            parts.push(ctx.equipment)
            hint.textContent = parts.filter(Boolean).join(" · ")
        }
        return hint
    }

    // ── F2 — Templates row + Save/Manage modals ──────────────────────────
    //
    // Compact dropdown above the form lets the user reload a previously
    // saved {pricePct, service, depTimeLocal, turnMin, notes} pattern.
    // Templates never overwrite the OD pair — applyTemplate (in leg-spec.js)
    // iterates every leg's pricePct/service while preserving origin /
    // destination / depTimeLocal. `_turnMin` is panel state (not on the
    // spec), so this layer applies the captured turnMin directly.
    //
    // depTimeLocal IS captured at save time (template metadata) but is
    // NOT applied back — the form's DEP stays where the user set it.

    function _buildTemplatesRow() {
        const row = document.createElement("div")
        row.dataset.aesStudioTemplatesRow = "1"
        row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;"

        const label = _mkLabel("Template")
        const sel = document.createElement("select")
        sel.dataset.aesStudioTemplatesSelect = "1"
        sel.style.cssText = "background:#0f1419;color:#e2e8f0;"
            + "border:1px solid #374151;border-radius:3px;padding:3px 6px;font-size:11px;"
            + "font-family:var(--aes-font-mono,monospace);min-width:140px;max-width:260px;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "(loading…)"
        sel.appendChild(placeholder)
        sel.disabled = true
        sel.title = "Pick a saved template to overlay PRICE / SERVICE / TURN onto the current form"
        sel.addEventListener("change", () => {
            const id = sel.value
            sel.value = ""   // reset so re-picking the same template re-applies
            if (!id) return
            const tmpl = _templates.find(t => t.id === id)
            if (tmpl) _applyTemplate(tmpl)
        })

        const saveBtn = _mkBtn("Save as…", "default", () => _openTemplateSaveModal())
        saveBtn.title = "Save current PRICE / SERVICE / DEP / TURN as a named template"
        const manageBtn = _mkBtn("Manage", "default", () => _openTemplateManageModal())
        manageBtn.title = "Rename or delete saved templates"

        row.append(label, sel, saveBtn, manageBtn)
        return row
    }

    /** Async-fill the dropdown built by _buildTemplatesRow. Reads templates
     *  for ctx.server, caches in `_templates`, and populates option rows.
     *  Safe to call repeatedly — each call replaces option contents. */
    async function _paintTemplatesRow() {
        const host = _slot()
        if (!host) return
        const sel = host.querySelector("[data-aes-studio-templates-select]")
        if (!sel) return
        const ctx = _ctx()
        const store = window.AesAfpFlightStudioTemplatesStore
        if (!ctx || !ctx.server || !store) {
            sel.innerHTML = ""
            const opt = document.createElement("option")
            opt.value = ""
            opt.textContent = "(unavailable)"
            sel.appendChild(opt)
            sel.disabled = true
            return
        }
        try {
            _templates = await store.loadAll(ctx.server)
            _templatesLoadedFor = ctx.server
        } catch (e) {
            console.warn("[AES studio] templates load threw", e)
            _templates = []
        }
        sel.innerHTML = ""
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = _templates.length
            ? "(pick template — " + _templates.length + " saved)"
            : "(no templates saved yet)"
        sel.appendChild(placeholder)
        for (const t of _templates) {
            const opt = document.createElement("option")
            opt.value = t.id
            const summary = [t.pricePct + "%"]
            if (t.service) summary.push(t.service)
            if (Number.isFinite(t.turnMin)) summary.push(t.turnMin + "m turn")
            if (t.fromIata) summary.push("@" + t.fromIata)
            opt.textContent = t.name + " — " + summary.join(" · ")
            opt.title = (t.notes || "")
                + (t.notes ? "\n" : "")
                + "DEP " + t.depTimeLocal + " · saved " + new Date(t.updatedAt).toLocaleDateString()
            sel.appendChild(opt)
        }
        sel.disabled = !_templates.length
    }

    /** Apply a template: merge into the spec, set panel turnMin, push
     *  to the AS form, emit studio:draft-changed, surface a hint. */
    function _applyTemplate(tmpl) {
        if (!tmpl || !_spec) return
        const next = window.AesAfpLegSpec.applyTemplate(_spec, tmpl)
        if (Number.isFinite(tmpl.turnMin) && tmpl.turnMin >= 0 && tmpl.turnMin < 1440) {
            _turnMin = tmpl.turnMin
        }
        _updateSpec(next)
        _renderBody()
        _pushAllToAsForm()
        _emit("studio:draft-changed", {spec: _spec, source: "template", templateId: tmpl.id})
        _renderHint("info", "Applied template '" + tmpl.name + "' — "
            + tmpl.pricePct + "% · " + (tmpl.service || "default service")
            + " · " + tmpl.turnMin + "m turn.")
    }

    /** Build the snapshot a new template captures. Reads leg[0] + panel
     *  state. fromIata is captured for metadata only; never applied back. */
    function _currentTemplateSnapshot() {
        const leg = (_spec && _spec.legs && _spec.legs[0]) || {}
        const snap = {
            pricePct:     Number.isFinite(leg.pricePct) ? leg.pricePct : 100,
            service:      typeof leg.service === "string" ? leg.service : "",
            depTimeLocal: leg.depTimeLocal || "09:00",
            turnMin:      Number.isFinite(_turnMin) ? _turnMin : 30
        }
        const from = String(leg.origin || "").toUpperCase()
        if (/^[A-Z]{3}$/.test(from)) snap.fromIata = from
        if (typeof _spec.note === "string" && _spec.note) snap.notes = _spec.note
        return snap
    }

    /** Shared modal scaffold — overlay + centered card with title bar,
     *  body region, and footer. Returns `{overlay, body, footer, close}`.
     *  Esc + click-outside both call close("cancel") which removes the
     *  overlay and detaches the keyup handler. */
    function _buildAesStudioModal(opts) {
        const o = opts || {}
        const overlay = document.createElement("div")
        overlay.dataset.aesStudioModal = "1"
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);"
            + "z-index:10010;display:flex;align-items:center;justify-content:center;"

        const modal = document.createElement("div")
        modal.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #374151;"
            + "border-radius:6px;min-width:420px;max-width:80vw;max-height:80vh;"
            + "display:flex;flex-direction:column;font:12px/1.4 sans-serif;"
            + "box-shadow:0 10px 40px rgba(0,0,0,0.5);"

        const head = document.createElement("div")
        head.style.cssText = "padding:10px 14px;border-bottom:1px solid #1f2937;"
            + "background:#111827;display:flex;align-items:center;gap:10px;"
        const title = document.createElement("strong")
        title.textContent = o.title || ""
        title.style.cssText = "color:#fbbf24;font-size:13px;flex:1 1 auto;"
        head.appendChild(title)
        if (o.subtitle) {
            const sub = document.createElement("span")
            sub.textContent = o.subtitle
            sub.style.cssText = "color:#9ca3af;font-size:10px;font-family:monospace;"
            head.appendChild(sub)
        }
        modal.appendChild(head)

        const body = document.createElement("div")
        body.style.cssText = "padding:10px 14px;overflow-y:auto;flex:1 1 auto;"
        modal.appendChild(body)

        const footer = document.createElement("div")
        footer.style.cssText = "padding:10px 14px;border-top:1px solid #1f2937;"
            + "background:#111827;display:flex;gap:8px;align-items:center;"
        const hint = document.createElement("span")
        hint.style.cssText = "color:#6b7280;font-size:10px;flex:1 1 auto;font-style:italic;"
        hint.textContent = "Esc / click outside = cancel"
        footer.appendChild(hint)
        modal.appendChild(footer)

        overlay.appendChild(modal)
        document.body.appendChild(overlay)

        const onKey = (e) => {
            if (e.key === "Escape") close("cancel")
        }
        document.addEventListener("keyup", onKey)
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close("cancel")
        })

        let _closed = false
        function close(reason) {
            if (_closed) return
            _closed = true
            document.removeEventListener("keyup", onKey)
            try { overlay.remove() } catch (_) { /* gone already */ }
            if (typeof o.onClose === "function") {
                try { o.onClose(reason) } catch (_) { /* host self-isolates */ }
            }
        }
        return {overlay, modal, body, footer, close}
    }

    function _openTemplateSaveModal() {
        const ctx = _ctx()
        const store = window.AesAfpFlightStudioTemplatesStore
        if (!ctx || !ctx.server) {
            _renderHint("warn", "Aircraft context not resolved — open the Studio from an aircraft page first.")
            return
        }
        if (!store) {
            _renderHint("error", "Templates store not loaded — reload the extension.")
            return
        }
        const snapshot = _currentTemplateSnapshot()

        const m = _buildAesStudioModal({title: "Save Flight Studio template", subtitle: ctx.server})

        const intro = document.createElement("p")
        intro.style.cssText = "margin:0 0 8px 0;color:#cbd5e1;font-size:12px;line-height:1.5;"
        intro.textContent = "Captures the current parametric fields. The OD pair stays untouched when applied."
        m.body.appendChild(intro)

        const summaryParts = [
            snapshot.pricePct + "% price",
            (snapshot.service || "default service"),
            "DEP " + snapshot.depTimeLocal,
            snapshot.turnMin + " min turn"
        ]
        if (snapshot.fromIata) summaryParts.push("from " + snapshot.fromIata)
        const summary = document.createElement("div")
        summary.style.cssText = "color:#9ca3af;font-size:11px;font-family:monospace;"
            + "background:#0f1419;border:1px solid #1f2937;border-radius:3px;padding:6px 8px;margin-bottom:10px;"
        summary.textContent = summaryParts.join(" · ")
        m.body.appendChild(summary)

        const nameLabel = document.createElement("label")
        nameLabel.style.cssText = "display:block;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;"
        nameLabel.textContent = "Name *"
        m.body.appendChild(nameLabel)

        const nameInp = document.createElement("input")
        nameInp.type = "text"
        nameInp.maxLength = store.MAX_NAME_LEN || 60
        nameInp.placeholder = "e.g. Morning shuttle"
        nameInp.style.cssText = "background:#0f1419;color:#e2e8f0;border:1px solid #374151;"
            + "border-radius:3px;padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box;margin-bottom:10px;"
        m.body.appendChild(nameInp)
        setTimeout(() => { try { nameInp.focus() } catch (_) {} }, 0)

        const notesLabel = document.createElement("label")
        notesLabel.style.cssText = nameLabel.style.cssText
        notesLabel.textContent = "Notes (optional)"
        m.body.appendChild(notesLabel)

        const notesInp = document.createElement("textarea")
        notesInp.maxLength = store.MAX_NOTES_LEN || 500
        notesInp.rows = 3
        notesInp.placeholder = "Free text — surfaces in the dropdown tooltip."
        notesInp.style.cssText = "background:#0f1419;color:#e2e8f0;border:1px solid #374151;"
            + "border-radius:3px;padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box;"
            + "font-family:inherit;resize:vertical;"
        if (snapshot.notes) notesInp.value = snapshot.notes
        m.body.appendChild(notesInp)

        const errLine = document.createElement("div")
        errLine.style.cssText = "color:#fca5a5;font-size:11px;margin-top:8px;min-height:14px;"
        m.body.appendChild(errLine)

        const cancelBtn = document.createElement("button")
        cancelBtn.type = "button"
        cancelBtn.textContent = "Cancel"
        cancelBtn.style.cssText = "background:transparent;color:#cbd5e1;border:1px solid #374151;"
            + "border-radius:3px;padding:5px 12px;font-size:11px;cursor:pointer;"
        cancelBtn.addEventListener("click", () => m.close("cancel"))
        m.footer.appendChild(cancelBtn)

        const saveBtn = document.createElement("button")
        saveBtn.type = "button"
        saveBtn.textContent = "Save"
        saveBtn.style.cssText = "background:#1e40af;color:#dbeafe;border:1px solid #1d4ed8;"
            + "border-radius:3px;padding:5px 14px;font-size:11px;cursor:pointer;font-weight:600;"
        async function commit() {
            const name = nameInp.value.trim()
            if (!name) {
                errLine.textContent = "Name is required."
                return
            }
            const dupe = _templates.find(t => t.name.toLowerCase() === name.toLowerCase())
            if (dupe) {
                errLine.textContent = "A template named '" + dupe.name + "' already exists."
                return
            }
            saveBtn.disabled = true
            const tmpl = Object.assign({}, snapshot, {
                name,
                notes: notesInp.value.trim() || undefined
            })
            try {
                const saved = await store.save(ctx.server, tmpl)
                if (!saved) {
                    errLine.textContent = "Save failed — name may be a duplicate or fields invalid."
                    saveBtn.disabled = false
                    return
                }
                m.close("save")
                _emit("studio:templates-changed", {server: ctx.server, action: "save", id: saved.id})
                _paintTemplatesRow().catch(() => {})
                _renderHint("info", "Saved template '" + saved.name + "'.")
            } catch (e) {
                console.warn("[AES studio] template save threw", e)
                errLine.textContent = "Save threw: " + ((e && e.message) || String(e))
                saveBtn.disabled = false
            }
        }
        saveBtn.addEventListener("click", commit)
        nameInp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); commit() }
        })
        m.footer.appendChild(saveBtn)
    }

    async function _openTemplateManageModal() {
        const ctx = _ctx()
        const store = window.AesAfpFlightStudioTemplatesStore
        if (!ctx || !ctx.server || !store) {
            _renderHint("warn", "Templates unavailable — aircraft context not resolved.")
            return
        }
        // Refresh the parent dropdown when the modal closes — repaintList
        // updates `_templates` (module state) but the dropdown DOM lives
        // outside this modal.
        const m = _buildAesStudioModal({
            title:    "Manage templates",
            subtitle: ctx.server,
            onClose:  () => _paintTemplatesRow().catch(() => {})
        })
        m.modal.style.minWidth = "560px"

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        m.body.appendChild(list)

        async function repaintList() {
            list.innerHTML = ""
            let templates = []
            try { templates = await store.loadAll(ctx.server) } catch (_) { templates = [] }
            _templates = templates
            if (!templates.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "color:#9ca3af;font-size:12px;padding:14px;text-align:center;"
                empty.textContent = "No saved templates yet. Configure the form, then click 'Save as…'."
                list.appendChild(empty)
                return
            }
            for (const t of templates) {
                const row = document.createElement("div")
                row.style.cssText = "display:flex;align-items:center;gap:8px;"
                    + "padding:6px 8px;border:1px solid #1f2937;border-radius:4px;background:#0f1419;"
                const nameSpan = document.createElement("strong")
                nameSpan.textContent = t.name
                nameSpan.style.cssText = "color:#e2e8f0;font-size:12px;flex:0 0 auto;min-width:120px;max-width:200px;"
                    + "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                row.appendChild(nameSpan)
                const summary = document.createElement("span")
                summary.style.cssText = "color:#9ca3af;font-size:11px;font-family:monospace;flex:1 1 auto;"
                const parts = [t.pricePct + "%"]
                if (t.service) parts.push(t.service)
                parts.push(t.turnMin + "m turn")
                parts.push("DEP " + t.depTimeLocal)
                if (t.fromIata) parts.push("@" + t.fromIata)
                summary.textContent = parts.join(" · ")
                row.appendChild(summary)
                const renameBtn = _mkBtn("Rename", "default", async () => {
                    const next = window.prompt("New name for '" + t.name + "'", t.name)
                    if (next == null) return
                    const trimmed = next.trim()
                    if (!trimmed || trimmed === t.name) return
                    const renamed = Object.assign({}, t, {name: trimmed})
                    const saved = await store.save(ctx.server, renamed)
                    if (!saved) {
                        _renderHint("warn", "Rename failed — name may be a duplicate.")
                        return
                    }
                    _emit("studio:templates-changed", {server: ctx.server, action: "rename", id: t.id})
                    await repaintList()
                })
                const deleteBtn = _mkBtn("Delete", "default", async () => {
                    if (!window.confirm("Delete template '" + t.name + "'?")) return
                    await store.remove(ctx.server, t.id)
                    _emit("studio:templates-changed", {server: ctx.server, action: "remove", id: t.id})
                    await repaintList()
                })
                deleteBtn.style.color = "#fca5a5"
                deleteBtn.style.borderColor = "#7f1d1d"
                row.appendChild(renameBtn)
                row.appendChild(deleteBtn)
                list.appendChild(row)
            }
        }
        await repaintList()

        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "Close"
        closeBtn.style.cssText = "background:transparent;color:#cbd5e1;border:1px solid #374151;"
            + "border-radius:3px;padding:5px 12px;font-size:11px;cursor:pointer;"
        closeBtn.addEventListener("click", () => m.close("close"))
        m.footer.appendChild(closeBtn)
    }

    // ── Schedule Planner — mock timetable generator ─────────────────────
    //
    // Creates a FlightSpec from a user-selected airport list and leg count.
    // The generated mock keeps absolute day offsets in `_planner.lastMock`
    // while the spec carries AS-compatible HH:MM + dayMask fields.

    const PLANNER_CLASSES = ["Y", "C", "F", "Cargo"]

    function _buildSchedulePlanner() {
        const wrap = document.createElement("details")
        wrap.dataset.aesSchedulePlanner = "1"
        wrap.open = true
        wrap.style.cssText = "margin:6px 0 8px;border:1px solid #1f2937;border-radius:3px;background:#0b1220;"

        const sum = document.createElement("summary")
        sum.style.cssText = "cursor:pointer;padding:6px 8px;font-size:11px;color:#cbd5e1;font-weight:700;"
        const legs = (_spec && Array.isArray(_spec.legs)) ? _spec.legs.length : 0
        const hub = _plannerHub()
        sum.textContent = "Schedule Planner"
            + (hub ? " · " + hub : "")
            + (legs ? " · " + legs + " legs" : "")
        wrap.appendChild(sum)

        const body = document.createElement("div")
        body.style.cssText = "padding:0 8px 8px;display:flex;flex-direction:column;gap:6px;"
        body.appendChild(_buildPlannerControls())
        body.appendChild(_buildPlannerMockTable())
        if (_planner.lastMessage) {
            const msg = document.createElement("div")
            msg.dataset.aesPlannerMessage = "1"
            msg.style.cssText = "font-size:10px;color:#9ca3af;"
            msg.textContent = _planner.lastMessage
            body.appendChild(msg)
        }
        wrap.appendChild(body)
        return wrap
    }

    function _buildPlannerControls() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"

        const row1 = document.createElement("div")
        row1.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;"

        row1.appendChild(_mkLabel("Hub"))
        const hubInput = _mkBaseInput(_planner.hub || _plannerHub() || "", 3, "56px")
        hubInput.dataset.aesPlannerHub = "1"
        hubInput.placeholder = "HUB"
        hubInput.style.textTransform = "uppercase"
        hubInput.addEventListener("input", () => {
            const v = hubInput.value.toUpperCase()
            if (hubInput.value !== v) hubInput.value = v
            _planner.hub = v
        })
        row1.appendChild(hubInput)

        row1.appendChild(_mkLabel("Airports"))
        const airportsInput = _mkBaseInput(_planner.airports || _plannerAirportList().join(" "), 240, "230px")
        airportsInput.dataset.aesPlannerAirports = "1"
        airportsInput.placeholder = "CDG LHR NRT"
        airportsInput.style.textTransform = "uppercase"
        airportsInput.addEventListener("input", () => {
            const v = airportsInput.value.toUpperCase()
            if (airportsInput.value !== v) airportsInput.value = v
            _planner.airports = v
        })
        row1.appendChild(airportsInput)

        row1.appendChild(_mkLabel("Flights"))
        const countInput = _mkBaseInput(String(_planner.flightCount || 4), 2, "44px")
        countInput.dataset.aesPlannerCount = "1"
        countInput.placeholder = "4"
        countInput.addEventListener("input", () => {
            const n = _plannerParseCount(countInput.value)
            if (n) _planner.flightCount = n
        })
        row1.appendChild(countInput)

        const useVisibleBtn = _mkBtn("Use visible", "default", () => _plannerSetFromVisibleCandidates())
        useVisibleBtn.dataset.aesPlannerUseVisible = "1"
        useVisibleBtn.title = "Fill airports from the currently visible candidate rows"
        row1.appendChild(useVisibleBtn)

        const recommendBtn = _mkBtn("Recommend count", "default", () => {
            _planner.flightCount = _plannerRecommendedCount()
            _planner.lastMessage = "Recommended " + _planner.flightCount + " legs from the selected airports and pattern."
            _renderBody()
        })
        recommendBtn.dataset.aesPlannerRecommend = "1"
        recommendBtn.title = "Set the leg count from the selected airport structure"
        row1.appendChild(recommendBtn)

        const row2 = document.createElement("div")
        row2.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;"

        row2.appendChild(_mkLabel("Pattern"))
        const patternSelect = _plannerSelect([
            ["roundtrip", "Hub shuttle"],
            ["chain", "Chain loop"]
        ], _planner.pattern || "roundtrip")
        patternSelect.dataset.aesPlannerPattern = "1"
        patternSelect.title = "Hub shuttle alternates HUB->station->HUB. Chain loop walks through every selected airport."
        patternSelect.addEventListener("change", () => { _planner.pattern = patternSelect.value })
        row2.appendChild(patternSelect)

        row2.appendChild(_mkLabel("Start"))
        const startInput = _mkTimeInput(_planner.startTime || "09:00", (v) => { _planner.startTime = v })
        startInput.dataset.aesPlannerStart = "1"
        row2.appendChild(startInput)

        row2.appendChild(_mkLabel("Turn"))
        const turnInput = _mkBaseInput(String(_planner.turnMin || _turnMin || 30), 4, "44px")
        turnInput.dataset.aesPlannerTurn = "1"
        turnInput.placeholder = "min"
        turnInput.addEventListener("input", () => {
            const n = parseInt(turnInput.value, 10)
            if (isFinite(n) && n >= 0 && n < 1440) {
                _planner.turnMin = n
                _turnMin = n
            }
        })
        row2.appendChild(turnInput)

        row2.appendChild(_mkLabel("Price"))
        const priceSelect = _plannerSelect([
            ["demand", "Demand"],
            ["flat", "Flat"]
        ], _planner.priceMode || "demand")
        priceSelect.dataset.aesPlannerPriceMode = "1"
        priceSelect.title = "Demand mode adjusts the AS creation price percent from candidate demand and competition signals"
        priceSelect.addEventListener("change", () => { _planner.priceMode = priceSelect.value })
        row2.appendChild(priceSelect)

        const sequentialLabel = document.createElement("label")
        sequentialLabel.style.cssText = "display:inline-flex;align-items:center;gap:4px;color:#9ca3af;font-size:10px;"
        const sequentialInput = document.createElement("input")
        sequentialInput.type = "checkbox"
        sequentialInput.checked = _planner.longDrift !== false
        sequentialInput.dataset.aesPlannerSequential = "1"
        sequentialInput.addEventListener("change", () => { _planner.longDrift = !!sequentialInput.checked })
        sequentialLabel.appendChild(sequentialInput)
        sequentialLabel.appendChild(document.createTextNode("Sequential"))
        row2.appendChild(sequentialLabel)

        const generateBtn = _mkBtn("Generate draft", "primary", async () => {
            await _generatePlannerSchedule()
        })
        generateBtn.dataset.aesPlannerGenerate = "1"
        generateBtn.title = "Build the mock timetable and replace the Flight Studio legs below"
        row2.appendChild(generateBtn)

        const previewBtn = _mkBtn("Preview first", "default", () => _runPreview())
        previewBtn.dataset.aesPlannerPreview = "1"
        previewBtn.title = "Preview the first generated leg against AS's New Flight Number form"
        row2.appendChild(previewBtn)

        const createBtn = _mkBtn("Create generated", "default", async () => {
            const hasGenerated = _planner.lastMock && _planner.lastMock.length
            if (!hasGenerated) {
                const ok = await _generatePlannerSchedule()
                if (!ok) return
            }
            await _runApply()
        })
        createBtn.dataset.aesPlannerCreate = "1"
        createBtn.title = "Open the apply confirmation for the generated timetable"
        row2.appendChild(createBtn)

        wrap.appendChild(row1)
        wrap.appendChild(row2)
        return wrap
    }

    function _buildPlannerMockTable() {
        const wrap = document.createElement("div")
        wrap.dataset.aesPlannerMock = "1"
        wrap.style.cssText = "overflow:auto;border-top:1px dashed #1f2937;padding-top:6px;"

        const legs = (_spec && Array.isArray(_spec.legs)) ? _spec.legs : []
        const mock = Array.isArray(_planner.lastMock) ? _planner.lastMock : []
        if (!legs.length || !mock.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:#6b7280;font-size:10px;"
            empty.textContent = "Generate a draft to populate the mock schedule."
            wrap.appendChild(empty)
            return wrap
        }

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:10px;font-family:var(--aes-font-mono,monospace);"
        const thead = document.createElement("thead")
        const hr = document.createElement("tr")
        ;["#", "Flight#", "Day", "Route", "Dep", "Block", "Arr", "Days", "Price", "Y/C/F/Cargo"].forEach(h => {
            const th = document.createElement("th")
            th.textContent = h
            th.style.cssText = "text-align:left;color:#9ca3af;font-weight:600;padding:2px 4px;border-bottom:1px solid #1f2937;"
            hr.appendChild(th)
        })
        thead.appendChild(hr)
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        legs.forEach((leg, idx) => {
            const m = mock[idx] || {}
            const tr = document.createElement("tr")
            tr.dataset.aesPlannerMockRow = String(idx)
            tr.style.cssText = "border-bottom:1px solid rgba(31,41,55,0.65);"
            _plannerTd(tr, String(idx + 1), "#6b7280")
            _plannerTd(tr, _plannerFlightNumberForIndex(idx), "#cbd5e1")
            _plannerTd(tr, _plannerDayLabel(m.dayOffset), "#fde68a")
            _plannerTd(tr, (leg.origin || "???") + "->" + (leg.destination || "???"), "#e2e8f0")

            const depTd = document.createElement("td")
            depTd.style.cssText = "padding:2px 4px;"
            const depInput = _mkBaseInput(leg.depTimeLocal || "", 5, "58px")
            depInput.dataset.aesPlannerDep = String(idx)
            depInput.placeholder = "HH:MM"
            depInput.addEventListener("blur", () => {
                _plannerCommitDepTime(idx, depInput.value).catch(e => {
                    console.warn("[AES planner] dep edit failed", e)
                    _renderHint("error", "Planner DEP edit failed: " + ((e && e.message) || String(e)))
                })
            })
            depTd.appendChild(depInput)
            tr.appendChild(depTd)

            _plannerTd(tr, _plannerBlockLabel(m.flightMin), "#cbd5e1")
            _plannerTd(tr, _plannerDayTimeLabel(m.arrDayOffset, m.arrTimeLocal), "#cbd5e1")
            _plannerTd(tr, _plannerDayMaskText(leg.dayMask), "#9ca3af")
            _plannerTd(tr, (leg.pricePct != null ? String(leg.pricePct) : "100") + "%", "#a7f3d0")
            _plannerTd(tr, _plannerClassPriceLabel(m.priceByClass), "#bfdbfe")
            tbody.appendChild(tr)
        })
        table.appendChild(tbody)
        wrap.appendChild(table)
        return wrap
    }

    function _plannerSelect(options, value) {
        const sel = document.createElement("select")
        sel.style.cssText = "background:#0f1419;color:#e2e8f0;"
            + "border:1px solid #374151;border-radius:3px;padding:3px 6px;font-size:11px;"
            + "font-family:var(--aes-font-mono,monospace);"
        for (const pair of options) {
            const opt = document.createElement("option")
            opt.value = pair[0]
            opt.textContent = pair[1]
            sel.appendChild(opt)
        }
        sel.value = value
        return sel
    }

    function _plannerTd(tr, text, color) {
        const td = document.createElement("td")
        td.textContent = text == null || text === "" ? "-" : String(text)
        td.style.cssText = "padding:2px 4px;color:" + (color || "#cbd5e1") + ";white-space:nowrap;"
        tr.appendChild(td)
        return td
    }

    function _plannerHub() {
        return _normIata(_planner.hub) || _activeHubIata() || _routeBaseIata()
    }

    function _plannerVisibleIatas() {
        const out = []
        const push = (v) => {
            const i = _normIata(v)
            if (i && out.indexOf(i) < 0) out.push(i)
        }
        try {
            const rc = window.AesAfpRouteCandidates
            if (rc && typeof rc.visibleIatas === "function") {
                for (const i of rc.visibleIatas()) push(i)
            }
            if (!out.length && rc && Array.isArray(rc.last)) {
                for (const c of rc.last) push(c && c.destIata)
            }
        } catch (_) { /* fall back below */ }
        return out
    }

    function _plannerAirportList() {
        const hub = _plannerHub()
        const parsed = _plannerParseAirports(_planner.airports)
        if (parsed.length) return parsed.filter(i => i !== hub)

        const out = []
        const push = (v) => {
            const i = _normIata(v)
            if (i && i !== hub && out.indexOf(i) < 0) out.push(i)
        }
        const legs = (_spec && Array.isArray(_spec.legs)) ? _spec.legs : []
        for (const leg of legs) push(leg && leg.destination)
        for (const i of _plannerVisibleIatas()) push(i)
        return out
    }

    function _plannerParseAirports(raw) {
        const out = []
        const matches = String(raw || "").toUpperCase().match(/[A-Z]{3}/g) || []
        for (const m of matches) {
            const i = _normIata(m)
            if (i && out.indexOf(i) < 0) out.push(i)
        }
        return out
    }

    function _plannerParseCount(raw) {
        const n = Math.round(Number(raw))
        if (!isFinite(n)) return null
        return Math.max(1, Math.min(32, n))
    }

    function _plannerSetFromVisibleCandidates() {
        const hub = _plannerHub()
        const limit = Math.max(1, Math.min(20, Math.ceil((_planner.flightCount || 4) / 2) || 6))
        const visible = _plannerVisibleIatas().filter(i => i !== hub).slice(0, limit)
        if (!visible.length) {
            _renderHint("warn", "No visible candidate airports to import.")
            return
        }
        _planner.airports = visible.join(" ")
        _planner.lastMessage = "Loaded " + visible.length + " visible candidate airports."
        _renderBody()
    }

    function _plannerRecommendedCount() {
        const stations = _plannerAirportList()
        if (!stations.length) return 2
        if ((_planner.pattern || "roundtrip") === "chain") {
            return Math.max(2, Math.min(32, stations.length + 1))
        }
        return Math.max(2, Math.min(32, stations.length * 2))
    }

    async function _generatePlannerSchedule() {
        const ctx = _ctx()
        const server = ctx && ctx.server
        const hub = _plannerHub()
        const stations = _plannerAirportList()
        const count = _plannerParseCount(_planner.flightCount) || 4
        const start = _plannerHHMMToMinutes(_planner.startTime || "09:00")
        const turn = Math.max(0, Math.min(1439, Math.round(Number(_planner.turnMin != null ? _planner.turnMin : _turnMin) || 30)))
        if (!hub) {
            _planner.lastMessage = "Pick a hub before generating."
            _renderBody()
            return false
        }
        if (!stations.length) {
            _planner.lastMessage = "Pick at least one destination airport."
            _renderBody()
            return false
        }
        if (start == null) {
            _planner.lastMessage = "Start time must be HH:MM."
            _renderBody()
            return false
        }

        _planner.flightCount = count
        _planner.turnMin = turn
        _turnMin = turn

        const baseLeg = (_spec && _spec.legs && _spec.legs[0]) || {}
        const baseDayMask = _legDayMask(baseLeg)
        const legs = []
        const mock = []
        const state = {stationIdx: 0}
        let current = hub
        let abs = start

        for (let i = 0; i < count; i++) {
            const dest = _plannerNextDestination(_planner.pattern, current, hub, stations, state)
            if (!dest || dest === current) break
            const cand = _plannerCandidateFor(current, dest)
            const flightMin = await _plannerFlightMinutes(server, current, dest, cand)
            const dayOffset = Math.floor(abs / 1440)
            const depTimeLocal = _plannerMinutesToHHMM(abs)
            const arrAbs = abs + flightMin
            const arrDayOffset = Math.floor(arrAbs / 1440)
            const price = _plannerPriceForCandidate(cand, baseLeg.pricePct)
            const priceByClass = _plannerClassPricePlan(cand, price)

            legs.push({
                seq: i + 1,
                origin: current,
                destination: dest,
                depTimeLocal: depTimeLocal,
                service: typeof baseLeg.service === "string" ? baseLeg.service : "",
                pricePct: price,
                dayMask: _plannerShiftDayMask(baseDayMask, dayOffset)
            })
            mock.push({
                seq: i + 1,
                origin: current,
                destination: dest,
                dayOffset,
                depAbs: abs,
                depTimeLocal,
                flightMin,
                turnMin: turn,
                arrAbs,
                arrDayOffset,
                arrTimeLocal: _plannerMinutesToHHMM(arrAbs),
                candidateScore: cand && (cand.scoreBlend != null ? cand.scoreBlend : cand.score),
                pricePct: price,
                priceByClass
            })
            current = dest
            abs = (_planner.longDrift !== false)
                ? arrAbs + turn
                : start + ((i + 1) * Math.max(60, turn || 60))
        }

        if (!legs.length) {
            _planner.lastMessage = "No valid planner legs could be generated."
            _renderBody()
            return false
        }
        await _applyPlannerLegs(legs, mock)
        _planner.lastMessage = "Generated " + legs.length + " sequential legs from " + hub
            + " using " + stations.join(", ") + "."
        _renderBody()
        await _plannerPopulateAvailableRange(legs.length)
        _renderHint("info", _planner.lastMessage)
        return true
    }

    function _plannerNextDestination(pattern, current, hub, stations, state) {
        const p = pattern || "roundtrip"
        if (p === "chain") {
            const path = [hub].concat(stations)
            const idx = path.indexOf(current)
            if (idx < 0) return hub
            return path[(idx + 1) % path.length]
        }
        if (current !== hub) return hub
        const dest = stations[state.stationIdx % stations.length]
        state.stationIdx += 1
        return dest
    }

    async function _plannerFlightMinutes(server, origin, dest, candidate) {
        const fromCand = candidate && Number(candidate.blockMin)
        if (isFinite(fromCand) && fromCand > 0) return Math.max(20, Math.round(fromCand))

        let distanceKm = candidate && Number(candidate.distanceKm)
        if (!(isFinite(distanceKm) && distanceKm > 0)) {
            distanceKm = await _resolveDistanceKm(server, origin, dest)
        }
        const resolved = window.AesAfpSpecResolver && window.AesAfpSpecResolver.last
        const kmh = resolved && Number(resolved.cruiseSpeedKmh)
        if (isFinite(distanceKm) && distanceKm > 0 && isFinite(kmh) && kmh > 0) {
            return Math.max(20, Math.round((distanceKm / kmh) * 60))
        }
        return 90
    }

    function _applyPlannerLegs(legs, mock) {
        const ctx = _ctx() || {}
        const base = _spec
            ? window.AesAfpLegSpec.cloneSpec(_spec)
            : window.AesAfpLegSpec.createSpec({
                server: ctx.server || "",
                aircraftId: ctx.aircraftId || "",
                origin: legs[0] && legs[0].origin,
                source: "manual",
                dryRun: false
            })
        const next = window.AesAfpLegSpec.normalizeSpec(Object.assign({}, base, {
            server: ctx.server || base.server || "",
            aircraftId: ctx.aircraftId || base.aircraftId || "",
            legs,
            source: "manual",
            dryRun: false
        }))
        _planner.lastMock = Array.isArray(mock) ? mock : []
        return _updateSpecWithHistory(next).then(() => {
            _pushAllToAsForm()
            _emit("studio:planner-generated", {spec: _spec, mock: _planner.lastMock})
            return true
        })
    }

    async function _plannerCommitDepTime(idx, raw) {
        const t = _plannerNormalizeHHMM(raw)
        if (!t || !_spec || !Array.isArray(_spec.legs) || !_spec.legs[idx]) return
        const next = window.AesAfpLegSpec.setLegField(_spec, idx, "depTimeLocal", t)
        const mock = Array.isArray(_planner.lastMock) ? _planner.lastMock.slice() : []
        if (mock[idx]) {
            const prevAbs = Number(mock[idx].depAbs)
            const dayOffset = isFinite(prevAbs) ? Math.floor(prevAbs / 1440) : (mock[idx].dayOffset || 0)
            const localMin = _plannerHHMMToMinutes(t)
            const depAbs = (dayOffset * 1440) + (localMin == null ? 0 : localMin)
            const flightMin = Number(mock[idx].flightMin) || 0
            mock[idx] = Object.assign({}, mock[idx], {
                depAbs,
                depTimeLocal: t,
                arrAbs: depAbs + flightMin,
                arrDayOffset: Math.floor((depAbs + flightMin) / 1440),
                arrTimeLocal: _plannerMinutesToHHMM(depAbs + flightMin)
            })
            _planner.lastMock = mock
        }
        await _updateSpecWithHistory(next)
        _pushAllToAsForm()
        _renderBody()
        _renderHint("info", "Updated mock departure for leg #" + (idx + 1) + " to " + t + ".")
    }

    function _plannerCandidateFor(origin, dest) {
        const o = _normIata(origin)
        const d = _normIata(dest)
        if (!o || !d) return null
        const rc = window.AesAfpRouteCandidates
        const rows = rc && Array.isArray(rc.last) ? rc.last : []
        let fallback = null
        for (const c of rows) {
            const co = _normIata(c && c.originIata)
            const cd = _normIata(c && c.destIata)
            if (!cd) continue
            if (cd === d && (!co || co === o)) return c
            if (cd === o && (!co || co === d)) return c
            if (!fallback && cd === d) fallback = c
        }
        return fallback
    }

    function _plannerPriceForCandidate(candidate, fallbackPct) {
        const base = Number.isFinite(Number(fallbackPct)) ? Number(fallbackPct) : 100
        if ((_planner.priceMode || "demand") === "flat") return Math.round(Math.max(50, Math.min(200, base)))
        const c = candidate || {}
        let delta = 0
        const score = Number(c.scoreBlend != null ? c.scoreBlend : c.score)
        const pax = Number(c.paxScore)
        const cargo = Number(c.cargoScore)
        const airlines = Number(c.airlineCount)
        const weekly = Number(c.weeklyFlights)
        if (isFinite(score)) delta += (score - 50) / 10
        if (isFinite(pax)) delta += (pax - 5) * 2.5
        if (isFinite(cargo)) delta += (cargo - 5) * 1.2
        if (isFinite(airlines)) delta -= Math.min(7, airlines * 1.2)
        if (isFinite(weekly)) delta += Math.min(5, weekly / 30)
        return Math.round(Math.max(70, Math.min(150, base + delta)))
    }

    function _plannerClassPricePlan(candidate, routePct) {
        const c = candidate || {}
        const pax = Number(c.paxScore)
        const cargo = Number(c.cargoScore)
        const alphaY = Number(c.alphaY)
        const alphaC = Number(c.alphaC)
        const alphaF = Number(c.alphaF)
        const demandLift = isFinite(pax) ? (pax - 5) : 0
        const cargoLift = isFinite(cargo) ? (cargo - 5) : 0
        const alpha = (v) => isFinite(v) ? Math.max(-8, Math.min(12, (v - 1) * 8)) : 0
        const clamp = (v) => Math.round(Math.max(50, Math.min(200, v)))
        return {
            Y: clamp(routePct + demandLift * 1.4 + alpha(alphaY)),
            C: clamp(routePct + 4 + demandLift * 1.8 + alpha(alphaC)),
            F: clamp(routePct + 8 + demandLift * 2.2 + alpha(alphaF)),
            Cargo: clamp(routePct + cargoLift * 2.0)
        }
    }

    function _plannerShiftDayMask(mask, offset) {
        const src = Array.isArray(mask) && mask.length >= 7
            ? mask.slice(0, 7).map(Boolean)
            : _defaultDayMask()
        const off = ((Math.round(Number(offset) || 0) % 7) + 7) % 7
        if (!off) return src
        const out = [false, false, false, false, false, false, false]
        for (let i = 0; i < 7; i++) if (src[i]) out[(i + off) % 7] = true
        return out
    }

    function _plannerDayMaskText(mask) {
        const src = Array.isArray(mask) && mask.length >= 7 ? mask.slice(0, 7).map(Boolean) : _defaultDayMask()
        if (src.every(Boolean)) return "Daily"
        const names = ["M", "T", "W", "Th", "F", "Sa", "Su"]
        const out = []
        for (let i = 0; i < 7; i++) if (src[i]) out.push(names[i])
        return out.length ? out.join("") : "None"
    }

    function _plannerFlightNumberForIndex(idx) {
        const raw = String((_spec && _spec.flightNumberText) || "").trim()
        if (!raw) return "auto"
        if (!/^\d+$/.test(raw)) return idx === 0 ? raw : "auto"
        return String(parseInt(raw, 10) + idx)
    }

    function _plannerHHMMToMinutes(hhmm) {
        const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        const h = parseInt(m[1], 10)
        const min = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null
        return h * 60 + min
    }

    function _plannerNormalizeHHMM(hhmm) {
        const min = _plannerHHMMToMinutes(hhmm)
        return min == null ? null : _plannerMinutesToHHMM(min)
    }

    function _plannerMinutesToHHMM(total) {
        let t = Math.round(Number(total) || 0) % 1440
        if (t < 0) t += 1440
        const h = Math.floor(t / 60)
        const m = t % 60
        return (h < 10 ? "0" + h : "" + h) + ":" + (m < 10 ? "0" + m : "" + m)
    }

    function _plannerDayLabel(offset) {
        const n = Math.floor(Number(offset) || 0)
        return n > 0 ? "D+" + n : "D0"
    }

    function _plannerDayTimeLabel(offset, hhmm) {
        return _plannerDayLabel(offset) + " " + (hhmm || "--:--")
    }

    function _plannerBlockLabel(min) {
        const n = Math.round(Number(min))
        if (!isFinite(n) || n <= 0) return "-"
        const h = Math.floor(n / 60)
        const m = n % 60
        return h + ":" + (m < 10 ? "0" + m : "" + m)
    }

    function _plannerClassPriceLabel(priceByClass) {
        if (!priceByClass) return "-"
        return PLANNER_CLASSES.map(cls => {
            const v = priceByClass[cls]
            return cls + (v == null ? "-" : String(v))
        }).join("/")
    }

    async function _plannerPopulateAvailableRange(count) {
        const legCount = Math.max(1, Math.min(32, Math.round(Number(count) || 1)))
        const base = await _plannerFindAvailableNumberRange(legCount)
        if (base) {
            _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText", base))
            _pushToAsForm("flightNumberText", base)
            _renderBody()
            return base
        }
        await _populateNextAvailable({silent: true})
        return (_spec && _spec.flightNumberText) || null
    }

    async function _plannerFindAvailableNumberRange(count) {
        const nums = await _plannerFetchRosterNumbers()
        if (!nums || !nums.length) return null
        const used = new Set()
        for (const raw of nums) {
            const n = parseInt(raw, 10)
            if (n > 0 && n < 10000) used.add(n)
        }
        const need = Math.max(1, Math.min(32, Math.round(Number(count) || 1)))
        for (let base = 1; base < 10000; base++) {
            let ok = true
            for (let i = 0; i < need; i++) {
                if (base + i >= 10000 || used.has(base + i)) { ok = false; break }
            }
            if (ok) return String(base)
        }
        return null
    }

    async function _plannerFetchRosterNumbers() {
        if (typeof fetch !== "function" || typeof DOMParser === "undefined") return null
        let ctrl = null
        let timer = null
        try {
            if (typeof AbortController !== "undefined") {
                ctrl = new AbortController()
                timer = setTimeout(() => ctrl.abort(), 9000)
            }
            const res = await fetch("/app/com/numbers", {
                credentials: "include",
                cache: "no-store",
                signal: ctrl ? ctrl.signal : undefined
            })
            if (!res || !res.ok) return null
            const html = await res.text()
            const doc = new DOMParser().parseFromString(html, "text/html")
            const nums = _plannerCollectRosterNumbers(doc)
            const expected = _plannerExpectedRosterCount(doc)
            if (!nums.length) return null
            if (expected && nums.length < expected) return null
            return nums
        } catch (_) {
            return null
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    function _plannerCollectRosterNumbers(doc) {
        const seen = new Set()
        if (!doc || !doc.querySelectorAll) return []
        for (const tr of doc.querySelectorAll("tr")) {
            const cells = tr.cells ? Array.from(tr.cells) : []
            if (!cells.length) continue
            for (const cell of cells) {
                const txt = (cell.innerText || cell.textContent || "").trim()
                if (!/^\d{1,4}$/.test(txt)) continue
                const n = parseInt(txt, 10)
                if (n > 0 && n < 10000) seen.add(n)
                break
            }
        }
        return Array.from(seen).sort((a, b) => a - b)
    }

    function _plannerExpectedRosterCount(doc) {
        const text = doc && doc.body ? (doc.body.innerText || doc.body.textContent || "") : ""
        let max = 0
        const re = /flight numbers\s*\((\d+)\)/gi
        let m
        while ((m = re.exec(text))) max = Math.max(max, parseInt(m[1], 10) || 0)
        return max || null
    }

    async function _validateFlightNumberRangeForApply(legs) {
        const fn = String((_spec && _spec.flightNumberText) || "").trim()
        if (!/^\d+$/.test(fn)) return {ok: true}
        const base = parseInt(fn, 10)
        if (!(base > 0 && base < 10000)) return {ok: true}
        const nums = await _plannerFetchRosterNumbers()
        if (!nums || !nums.length) return {ok: true}
        const used = new Set(nums.map(n => parseInt(n, 10)).filter(n => n > 0 && n < 10000))
        const collisions = []
        for (let i = 0; i < (legs || []).length; i++) {
            const n = base + i
            if (used.has(n)) collisions.push(n)
        }
        if (!collisions.length) return {ok: true}
        return {
            ok: false,
            message: "flight number(s) already exist: #" + collisions.join(", #")
                + ". Generate draft again to reserve a contiguous free range."
        }
    }

    // F3a — multi-leg tray. Wraps one row per leg, each with a drag handle
    // for reorder + a ✕ remove button. The tray itself is a drop target for
    // both leg-reorder (drag handle on another leg) and candidate (drag from
    // route-candidates table). Drops at end-of-tray when no row catches them.
    const REORDER_MIME   = "application/x-aes-leg-reorder"
    const CANDIDATE_MIME = "application/x-aes-candidate"

    function _buildLegTray() {
        const tray = document.createElement("div")
        tray.dataset.aesStudioTray = "1"
        tray.style.cssText = "display:flex;flex-direction:column;gap:0;margin-bottom:6px;"

        const legs = (_spec && Array.isArray(_spec.legs)) ? _spec.legs : []
        legs.forEach((leg, idx) => tray.appendChild(_buildLegTrayRow(leg, idx, legs.length)))

        // End-of-tray drop zone (catches drops past the last leg row).
        tray.addEventListener("dragover", _onTrayDragOver)
        tray.addEventListener("dragleave", _onTrayDragLeave)
        tray.addEventListener("drop",      ev => _onTrayDrop(ev, legs.length))

        const addRow = document.createElement("div")
        addRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:4px;"
        const addBtn = _mkBtn("+ Add leg", "default", async () => {
            const next = window.AesAfpLegSpec.addLeg(_spec)
            await _updateSpecWithHistory(next)
            _renderBody()
        })
        addBtn.title = "Append a fresh leg seeded from the previous leg's destination"
        addRow.appendChild(addBtn)
        const dropHint = document.createElement("span")
        dropHint.style.cssText = "color:#6b7280;font-size:10px;"
        dropHint.textContent = "or drag a candidate row into the tray"
        addRow.appendChild(dropHint)
        tray.appendChild(addRow)

        return tray
    }

    function _buildLegTrayRow(leg, idx, total) {
        const wrap = document.createElement("div")
        wrap.dataset.aesStudioLegIdx = String(idx)
        wrap.style.cssText = "display:flex;align-items:flex-start;gap:6px;"
            + "padding:4px 0;border-top:" + (idx === 0 ? "0" : "1px dashed #1f2937") + ";"

        // Drag handle (left). Only this is HTML5-draggable; the inputs in
        // _buildLegRow stay native-editable. Hover hints show reorder intent.
        const handle = document.createElement("span")
        handle.textContent = "☰"
        handle.title = "Drag to reorder · #" + (idx + 1)
        handle.draggable = true
        handle.style.cssText = "color:#6b7280;cursor:grab;user-select:none;"
            + "font-size:13px;padding:2px 4px;align-self:center;"
        handle.addEventListener("dragstart", ev => {
            try {
                ev.dataTransfer.setData(REORDER_MIME, String(idx))
                ev.dataTransfer.setData("text/plain", "leg#" + (idx + 1))
                ev.dataTransfer.effectAllowed = "move"
            } catch (_) { /* fall through */ }
            wrap.style.opacity = "0.5"
        })
        handle.addEventListener("dragend", () => { wrap.style.opacity = "" })
        wrap.appendChild(handle)

        // Leg label (#N) — visible counter so users see the tray ordering
        // without counting rows.
        const num = document.createElement("span")
        num.textContent = "#" + (idx + 1)
        num.style.cssText = "color:#6b7280;font-size:10px;font-variant-numeric:tabular-nums;"
            + "min-width:22px;align-self:center;"
        wrap.appendChild(num)

        // Field row (inherits the existing input wiring for this leg index).
        const fieldRow = _buildLegRow(leg, idx)
        fieldRow.style.flex = "1 1 auto"
        wrap.appendChild(fieldRow)

        // Remove button. Hidden when only one leg remains (spec invariant).
        const rm = _mkBtn("✕", "default", async () => {
            const next = window.AesAfpLegSpec.removeLeg(_spec, idx)
            await _updateSpecWithHistory(next)
            _renderBody()
        })
        rm.title = "Remove this leg"
        rm.style.padding = "2px 6px"
        if (total <= 1) {
            rm.disabled = true
            rm.style.opacity = "0.4"
            rm.style.cursor = "not-allowed"
            rm.title = "Cannot remove the last leg"
        }
        wrap.appendChild(rm)

        // Per-row drop target — drops insert before this row.
        wrap.addEventListener("dragover", ev => _onLegRowDragOver(ev, wrap))
        wrap.addEventListener("dragleave", () => _clearDropCue(wrap))
        wrap.addEventListener("drop", ev => {
            _clearDropCue(wrap)
            _onTrayDrop(ev, idx)
        })

        return wrap
    }

    function _onTrayDragOver(ev) {
        const types = ev.dataTransfer && ev.dataTransfer.types
        if (!types) return
        if (Array.from(types).some(t => t === REORDER_MIME || t === CANDIDATE_MIME)) {
            ev.preventDefault()
            ev.dataTransfer.dropEffect = (Array.from(types).includes(REORDER_MIME)) ? "move" : "copy"
        }
    }
    function _onTrayDragLeave(_ev) { /* tray-level cue is per-row; nothing to clear here */ }
    function _onLegRowDragOver(ev, wrap) {
        const types = ev.dataTransfer && ev.dataTransfer.types
        if (!types) return
        if (Array.from(types).some(t => t === REORDER_MIME || t === CANDIDATE_MIME)) {
            ev.preventDefault()
            ev.stopPropagation()
            ev.dataTransfer.dropEffect = (Array.from(types).includes(REORDER_MIME)) ? "move" : "copy"
            wrap.style.boxShadow = "inset 0 2px 0 0 #3b82f6"
        }
    }
    function _clearDropCue(wrap) {
        if (wrap) wrap.style.boxShadow = ""
    }

    function _onTrayDrop(ev, insertAtIdx) {
        const dt = ev.dataTransfer
        if (!dt) return
        const reorderRaw = (() => { try { return dt.getData(REORDER_MIME) } catch (_) { return "" } })()
        if (reorderRaw) {
            ev.preventDefault()
            ev.stopPropagation()
            const fromIdx = parseInt(reorderRaw, 10)
            if (!isFinite(fromIdx)) return
            // Insert-before semantics: when dragging downward, the slot at
            // insertAtIdx shifts up by one once the source is removed, so
            // adjust to land in the visually-expected position.
            let toIdx = insertAtIdx
            if (fromIdx < toIdx) toIdx -= 1
            if (toIdx === fromIdx) return
            const next = window.AesAfpLegSpec.reorderLeg(_spec, fromIdx, toIdx)
            _updateSpec(next)
            _renderBody()
            return
        }
        const candidateRaw = (() => { try { return dt.getData(CANDIDATE_MIME) } catch (_) { return "" } })()
        if (candidateRaw) {
            ev.preventDefault()
            ev.stopPropagation()
            _appendLegFromCandidatePayload(candidateRaw, insertAtIdx)
        }
    }

    /** Fill the newest open station slot from a route-candidates drag
     *  payload, or append a fresh leg when there is no open slot.
     *
     *  FROM = previous leg's destination (or the hub when the tray is empty
     *  / the previous leg has no destination yet). TO = payload.destIata.
     *  DEP = previous leg's depTimeLocal + flightMin (from payload distance
     *  ÷ AesAfpSpecResolver cruise speed) + _turnMin. Falls back to
     *  previous depTime + _turnMin when cruise speed is unresolved. */
    function _appendLegFromCandidatePayload(raw, _insertAtIdx) {
        let payload = null
        try { payload = JSON.parse(raw) } catch (_) { return }
        if (!payload || typeof payload !== "object") return
        const destIata = String(payload.destIata || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(destIata)) return

        const targetIdx = _candidateFillTargetIndex("candidate-drag")
        if (targetIdx > 0) {
            const leg = _spec && _spec.legs && _spec.legs[targetIdx]
            if (leg && _normIata(leg.origin) && !_normIata(leg.destination)) {
                _fillCandidateDestination(targetIdx, {candidate: payload, source: "candidate-drag"})
                return
            }
        }

        const hub  = _activeHubIata()
        const tail = (_spec && _spec.legs && _spec.legs.length)
                     ? _spec.legs[_spec.legs.length - 1] : null
        const fromIata = (tail && /^[A-Z]{3}$/.test(String(tail.destination || "").toUpperCase()))
                         ? String(tail.destination).toUpperCase()
                         : hub || null

        const distanceKm = Number(payload.distanceKm)
        const resolved   = window.AesAfpSpecResolver && window.AesAfpSpecResolver.last
        const kmh        = resolved && Number(resolved.cruiseSpeedKmh)
        const turn       = Number(_turnMin) || 0
        let deltaMin     = turn
        if (isFinite(distanceKm) && distanceKm > 0 && isFinite(kmh) && kmh > 0) {
            deltaMin = Math.round((distanceKm / kmh) * 60) + turn
        }

        const baseTime = (tail && tail.depTimeLocal) ? tail.depTimeLocal : "09:00"
        const depTimeLocal = _addMinutesHHMM(baseTime, deltaMin)

        const next = window.AesAfpLegSpec.addLeg(_spec, {
            origin:       fromIata,
            destination:  destIata,
            depTimeLocal: depTimeLocal
        })
        _updateSpec(next)
        _renderBody()
        _renderHint("info",
            "Added " + (fromIata || "?") + " → " + destIata
            + (isFinite(distanceKm) && distanceKm > 0
                ? " · " + Math.round(distanceKm) + " km"
                : "")
            + " · dep " + depTimeLocal)
        _emit("studio:draft-changed", {spec: _spec})
    }

    /** Add `delta` minutes to an HH:MM string, modulo 24 h. Mirrors the
     *  helper in leg-spec.js `_addMinutesHHMM` — kept panel-local so the
     *  candidate-drop path doesn't reach into a private leg-spec helper. */
    function _addMinutesHHMM(hhmm, delta) {
        const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return "09:00"
        const h  = parseInt(m[1], 10)
        const mn = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return "09:00"
        let total = (h * 60 + mn + Math.round(Number(delta) || 0)) % 1440
        if (total < 0) total += 1440
        const oh = Math.floor(total / 60)
        const om = total % 60
        return (oh < 10 ? "0" + oh : "" + oh) + ":" + (om < 10 ? "0" + om : "" + om)
    }

    function _buildLegRow(leg, idx) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;"

        row.appendChild(_mkLabel("From"))
        row.appendChild(_mkIataInput(leg.origin, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "origin", v))
            if (idx === 0) _pushToAsForm("origin", v)
        }))
        row.appendChild(_mkArrow())
        row.appendChild(_mkLabel("To"))
        row.appendChild(_mkIataInput(leg.destination, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "destination", v))
            if (idx === 0) _pushToAsForm("destination", v)
        }))
        row.appendChild(_mkLabel("Dep"))
        row.appendChild(_mkTimeInput(leg.depTimeLocal, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "depTimeLocal", v))
            if (idx === 0) _pushToAsForm("depTime", v)
        }))
        row.appendChild(_mkLabel("Price"))
        row.appendChild(_mkPctInput(leg.pricePct, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "pricePct", v))
            if (idx === 0) _pushToAsForm("pricePct", v)
        }))
        row.appendChild(_mkLabel("Service"))
        row.appendChild(_mkServiceInput(leg.service, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "service", v))
            if (idx === 0) _pushToAsForm("service", v)
        }))
        return row
    }

    /** Forward one Flight Studio field straight to the AS "New Flight
     *  Number" form so the user sees their edits land above immediately —
     *  no need to click Preview to make Flight Studio non-redundant. The
     *  setters return false silently when the AS form isn't on the page
     *  (Existing tab active, mid-render, etc); we don't toast on that
     *  because typing while the form is gone is already user-visible.
     *
     *  IATA fields require a 3-char code (`AAA`) before AS's select can
     *  match an option, so we gate on length. Time fields require `HH:MM`. */
    function _pushToAsForm(field, raw) {
        const fd = window.AesAfpFormDriver
        if (!fd) return
        // Suppress the AS→Studio mirror while we drive AS ourselves. The
        // select setters in form-driver deliberately don't fire `change`
        // (form-driver.js:182-213, Wicket round-trip avoidance), but the
        // flight-number input setter does dispatch `input`/`change`/`blur`
        // (form-driver.js:345-358), which would otherwise feedback into
        // _onAsFlightNumberInput. The Promise.resolve reset covers the
        // synchronous event burst then clears so future user input
        // resumes mirroring normally.
        _suppressAsMirror = true
        try {
            switch (field) {
                case "origin":
                case "destination": {
                    const v = String(raw || "").toUpperCase()
                    if (!/^[A-Z]{3}$/.test(v)) return
                    if (field === "origin")      fd.setOrigin(v)
                    else                         fd.setDestination(v)
                    return
                }
                case "depTime": {
                    const v = String(raw || "")
                    if (!/^\d{1,2}:\d{2}$/.test(v)) return
                    fd.setDepartureTime(v)
                    return
                }
                case "pricePct": {
                    const n = parseInt(raw, 10)
                    if (!isFinite(n)) return
                    fd.setPricePercent(n)
                    return
                }
                case "service": {
                    fd.setService(raw == null ? "" : String(raw))
                    return
                }
                case "flightNumberText": {
                    if (typeof fd.setFlightNumber === "function") fd.setFlightNumber(raw == null ? "" : String(raw))
                    return
                }
            }
        } catch (e) { console.warn("[AES studio] _pushToAsForm threw", e) }
        finally {
            Promise.resolve().then(() => { _suppressAsMirror = false })
        }
    }

    /** Push every Flight Studio field for leg #0 + the spec's flight
     *  number into the AS form in one go. Used after Reset / Undo / auto-
     *  suggest so the AS form mirrors Flight Studio's full state without
     *  the user having to re-type each field. */
    function _pushAllToAsForm() {
        if (!_spec || !_spec.legs || !_spec.legs.length) return
        const leg = _spec.legs[0]
        _pushToAsForm("origin",           leg.origin)
        _pushToAsForm("destination",      leg.destination)
        _pushToAsForm("depTime",          leg.depTimeLocal)
        _pushToAsForm("pricePct",         leg.pricePct)
        _pushToAsForm("service",          leg.service)
        _pushToAsForm("flightNumberText", _spec.flightNumberText || "")
    }

    // ── AS form mirror — read side (transitional bridge) ─────────────────

    /** Snapshot AS's "New Flight Number" form into the leg/spec field
     *  shape. Returns null when the form isn't mounted (e.g. user is on
     *  the "Existing Flight Number" tab). */
    function _readAsFormSnapshot() {
        const fd = window.AesAfpFormDriver
        if (!fd || typeof fd.findForm !== "function") return null
        const f = fd.findForm()
        if (!f || !f.form) return null
        return {
            origin:           _asSelectToIata(f.originSelect),
            destination:      _asSelectToIata(f.destSelect),
            depTimeLocal:     _asTimeToHHMM(f.hoursSelect, f.minsSelect),
            pricePct:         _asSelectToInt(f.priceSelect),
            service:          (f.serviceSelect && f.serviceSelect.value != null)
                              ? String(f.serviceSelect.value) : "",
            flightNumberText: f.flightNumberInput
                              ? String(f.flightNumberInput.value || "") : ""
        }
    }

    /** Read the IATA out of the selected option's label (e.g.
     *  "New York (JFK)" → "JFK"). Mirrors form-driver.js:_findOptByIata,
     *  which writes by matching the same parenthesised IATA token. */
    function _asSelectToIata(sel) {
        if (!sel || sel.selectedIndex < 0) return null
        const opt = sel.options[sel.selectedIndex]
        if (!opt) return null
        const m = (opt.textContent || "").match(/\(([A-Z]{3})\)/)
        return m ? m[1] : null
    }

    function _asSelectToInt(sel) {
        if (!sel) return null
        const v = parseInt(sel.value, 10)
        return isFinite(v) ? v : null
    }

    function _asTimeToHHMM(hSel, mSel) {
        if (!hSel || !mSel) return null
        const h = parseInt(hSel.value, 10)
        const m = parseInt(mSel.value, 10)
        if (!isFinite(h) || h < 0 || h > 23) return null
        if (!isFinite(m) || m < 0 || m > 59) return null
        return (h < 10 ? "0" + h : "" + h) + ":" + (m < 10 ? "0" + m : "" + m)
    }

    /** Overlay an AS snapshot onto a spec's leg 0 + flight number. Only
     *  fields with non-empty AS values overwrite — an empty AS field
     *  leaves the spec untouched, so a transient null between user clicks
     *  doesn't clobber Studio's value. */
    function _overlayAsSnapshotOnSpec(spec, snap) {
        let next = spec
        const hub = _activeHubIata()
        const keepPlanHubForBlankDraft = !!(hub
            && _isBlankSingleLegDraft(spec)
            && !snap.destination
            && snap.origin
            && snap.origin !== hub)
        if (snap.origin && !keepPlanHubForBlankDraft) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "origin", snap.origin)
        }
        if (snap.destination) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "destination", snap.destination)
        }
        // A transient Wicket re-render can expose AS's blank New Flight form
        // with time defaulted to 00:00 while origin/destination are empty.
        // Do not let that blank form clobber a Studio route that the user
        // just composed.
        const hasRouteSelection = !!(snap.origin || snap.destination)
        if (hasRouteSelection && snap.depTimeLocal) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "depTimeLocal", snap.depTimeLocal)
        }
        if (hasRouteSelection && snap.pricePct != null) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "pricePct", snap.pricePct)
        }
        if (hasRouteSelection && typeof snap.service === "string" && snap.service.length) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "service", snap.service)
        }
        if (snap.flightNumberText && snap.flightNumberText.length) {
            next = window.AesAfpLegSpec.setSpecField(next, "flightNumberText", snap.flightNumberText)
        }
        return next
    }

    // ── AS form mirror — listeners ───────────────────────────────────────

    function _onAsOriginChange() {
        if (_suppressAsMirror || !_spec) return
        const h = _asMirrorHandlers
        if (!h) return
        const iata = _asSelectToIata(h.originSelect)
        _updateSpec(window.AesAfpLegSpec.setLegField(_spec, 0, "origin", iata || ""))
        _renderBody()
    }

    function _onAsDestChange() {
        if (_suppressAsMirror || !_spec) return
        const h = _asMirrorHandlers
        if (!h) return
        const iata = _asSelectToIata(h.destSelect)
        _updateSpec(window.AesAfpLegSpec.setLegField(_spec, 0, "destination", iata || ""))
        _renderBody()
    }

    function _onAsTimeChange() {
        if (_suppressAsMirror || !_spec) return
        const h = _asMirrorHandlers
        if (!h) return
        const hhmm = _asTimeToHHMM(h.hoursSelect, h.minsSelect)
        if (!hhmm) return
        _updateSpec(window.AesAfpLegSpec.setLegField(_spec, 0, "depTimeLocal", hhmm))
        _renderBody()
    }

    function _onAsPriceChange() {
        if (_suppressAsMirror || !_spec) return
        const h = _asMirrorHandlers
        if (!h) return
        const pct = _asSelectToInt(h.priceSelect)
        if (pct == null) return
        _updateSpec(window.AesAfpLegSpec.setLegField(_spec, 0, "pricePct", pct))
        _renderBody()
    }

    function _onAsServiceChange() {
        if (_suppressAsMirror || !_spec) return
        const h = _asMirrorHandlers
        if (!h) return
        const v = (h.serviceSelect && h.serviceSelect.value != null)
            ? String(h.serviceSelect.value) : ""
        _updateSpec(window.AesAfpLegSpec.setLegField(_spec, 0, "service", v))
        _renderBody()
    }

    function _onAsFlightNumberInput() {
        if (_suppressAsMirror || !_spec) return
        const h = _asMirrorHandlers
        if (!h || !h.flightNumberInput) return
        const raw = String(h.flightNumberInput.value || "")
        _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText",
            raw.length ? raw : null))
        _renderBody()
    }

    function _detachAsMirrorListeners() {
        const h = _asMirrorHandlers
        if (!h) return
        if (h.originSelect)      h.originSelect.removeEventListener("change", h.onOrigin)
        if (h.destSelect)        h.destSelect.removeEventListener("change",   h.onDest)
        if (h.hoursSelect)       h.hoursSelect.removeEventListener("change",  h.onTime)
        if (h.minsSelect)        h.minsSelect.removeEventListener("change",   h.onTime)
        if (h.priceSelect)       h.priceSelect.removeEventListener("change",  h.onPrice)
        if (h.serviceSelect)     h.serviceSelect.removeEventListener("change", h.onService)
        if (h.flightNumberInput) h.flightNumberInput.removeEventListener("input", h.onFn)
        _asMirrorHandlers = null
        _lastAsFormNode   = null
    }

    /** Attach AS-form listeners idempotently and self-heal across tab
     *  swaps. Polls every 750 ms because no event fires when AS swaps the
     *  Existing↔New Flight Number panels. On every tick: if the form
     *  node identity changed (or appeared / disappeared), detach old
     *  listeners and re-attach to the current node. On first attach to
     *  a freshly-mounted form, also overlay AS's current values onto
     *  the spec so Studio matches what AS will POST. */
    function _attachAsMirror() {
        if (_asMirrorTimer) clearTimeout(_asMirrorTimer)
        _asMirrorTimer = setTimeout(_attachAsMirror, 750)

        const fd = window.AesAfpFormDriver
        if (!fd || typeof fd.findForm !== "function") return
        const f = fd.findForm()
        const formNode = f && f.form ? f.form : null

        if (!formNode) {
            if (_asMirrorHandlers) _detachAsMirrorListeners()
            return
        }
        if (formNode === _lastAsFormNode) return

        _detachAsMirrorListeners()

        const h = {
            originSelect:      f.originSelect,
            destSelect:        f.destSelect,
            hoursSelect:       f.hoursSelect,
            minsSelect:        f.minsSelect,
            priceSelect:       f.priceSelect,
            serviceSelect:     f.serviceSelect,
            flightNumberInput: f.flightNumberInput,
            onOrigin:  _onAsOriginChange,
            onDest:    _onAsDestChange,
            onTime:    _onAsTimeChange,
            onPrice:   _onAsPriceChange,
            onService: _onAsServiceChange,
            onFn:      _onAsFlightNumberInput
        }
        if (h.originSelect)      h.originSelect.addEventListener("change", h.onOrigin)
        if (h.destSelect)        h.destSelect.addEventListener("change",   h.onDest)
        if (h.hoursSelect)       h.hoursSelect.addEventListener("change",  h.onTime)
        if (h.minsSelect)        h.minsSelect.addEventListener("change",   h.onTime)
        if (h.priceSelect)       h.priceSelect.addEventListener("change",  h.onPrice)
        if (h.serviceSelect)     h.serviceSelect.addEventListener("change", h.onService)
        if (h.flightNumberInput) h.flightNumberInput.addEventListener("input", h.onFn)

        _asMirrorHandlers = h
        _lastAsFormNode   = formNode

        // Fresh-mount overlay: pull AS's current values into leg 0 so
        // Studio doesn't render stale values for a form that just
        // appeared (e.g. user clicked the New Flight Number tab).
        // Multi-leg specs preserve their auto-build state — only single-
        // leg manual/draft specs get overlaid.
        if (_spec && Array.isArray(_spec.legs) && _spec.legs.length === 1) {
            const snap = _readAsFormSnapshot()
            if (snap) {
                const overlaid = _syncBlankDraftOriginToActiveHub(
                    _overlayAsSnapshotOnSpec(_spec, snap))
                if (overlaid !== _spec) {
                    _updateSpec(overlaid)
                    const hub = _activeHubIata()
                    if (hub) _pushToAsForm("origin", hub)
                    _renderBody()
                }
            }
        }
    }

    function _buildSpecMeta() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;"
        row.appendChild(_mkLabel("Flight#"))
        const fnInput = _mkTextInput(_spec.flightNumberText || "", 4, "60px", (v) => {
            // Strip non-digits + clamp to AS's 4-char input.
            const cleaned = String(v || "").replace(/[^0-9]/g, "").slice(0, 4)
            _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText", cleaned))
            _pushToAsForm("flightNumberText", cleaned)
        })
        fnInput.dataset.aesStudioFn = "1"
        fnInput.placeholder = "auto"
        row.appendChild(fnInput)
        // "Next" button — asks the form driver to resolve against AS's full
        // Flight Number Management roster, then mirrors the result back into
        // the spec and AS form.
        const nextBtn = _mkBtn("Next", "default", _populateNextAvailable)
        nextBtn.title = "Ask AS for the next available flight number"
        nextBtn.style.padding = "2px 8px"
        nextBtn.style.fontSize = "10px"
        row.appendChild(nextBtn)
        const note = document.createElement("span")
        note.textContent = "(blank = AS auto-assigns on submit)"
        note.style.cssText = "color:#6b7280;font-size:10px;"
        row.appendChild(note)
        return row
    }

    /** Click AS's "find first available" anchor, read the populated value
     *  back, and stamp it into the spec. Falls back to a client-side scan
     *  of the visible Flight Plan if the anchor isn't reachable (e.g. user
     *  is on the Existing Flight Number tab and tab-flip is racing).
     *
     *  `opts.silent` skips the AS-tab-flip path so the auto-suggest on
     *  first mount can't yank the user off the Existing tab unexpectedly.
     *  The button click leaves opts undefined → full path. */
    async function _populateNextAvailable(opts) {
        const silent = !!(opts && opts.silent)
        // Repeated clicks must advance past whatever's already shown. The
        // form driver resolves against AS's full Flight Number Management
        // roster and treats this current field value as in-flight, so gaps
        // such as 1,2,_,4 are handled without reusing the current draft.
        const currentNum = String(_spec.flightNumberText || "").replace(/[^0-9]/g, "")
        let next = null
        // Only ask AS when the form is already on the page (silent path)
        // OR when the user explicitly clicked Next (full path, may flip tab).
        const formAlreadyVisible = !!(window.AesAfp
            && typeof window.AesAfp.getNewFlightForm === "function"
            && window.AesAfp.getNewFlightForm())
        if ((!silent || formAlreadyVisible)
            && window.AesAfpFormDriver
            && typeof window.AesAfpFormDriver.findNextAvailableFlightNumber === "function") {
            const prevSuppress = _suppressAsMirror
            _suppressAsMirror = true
            try {
                next = await Promise.race([
                    window.AesAfpFormDriver.findNextAvailableFlightNumber({after: currentNum}),
                    new Promise(resolve => setTimeout(() => resolve(null), 9000))
                ])
            }
            catch (e) { console.warn("[AES studio] findNextAvailable threw", e) }
            finally { _suppressAsMirror = prevSuppress }
        }
        if (!next) {
            if (!silent) _renderHint("warn", "Couldn't verify the next available flight number from AS Flight Number Management.")
            return
        }
        _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText", next))
        _pushToAsForm("flightNumberText", next)
        _renderBody()
        if (!silent) _renderHint("info", "Suggested next flight number: " + next)
    }

    // ── Automation pipeline ──────────────────────────────────────────────
    //
    // Three buttons, one shared bus listener:
    //   "🎯 Automate"  → _runAutomate  → auto-build + apply (one click)
    //   "Auto-Build"   → _runAutoBuild → optimiser only, populates spec
    //   "Apply"        → _runApply     → reuses preview-panel's confirm
    //                                    modal, then apply-batch
    //
    // The submit click is gated by background.js + form-driver.js — the
    // panel never calls submitBtn.click() directly. We only express the
    // user's intent through `aes:afp:apply-batch`, which preview-panel's
    // shared modal confirms first (mandatory ack + duration estimate +
    // locked-leg detection).

    /** Update the panel's mode badge (DRY-RUN / AUTO-BUILD / BUILDING /
     *  APPLYING) without re-building the shell. Cheap — query + style. */
    function _updateModeBadge() {
        const host = _slot()
        if (!host) return
        const badge = host.querySelector("[data-aes-studio-mode]")
        if (!badge) return
        let label, color, bg
        if (_applyInFlight)         { label = "APPLYING";   color = "#bfdbfe"; bg = "#1e3a8a" }
        else if (_automateInFlight) { label = "BUILDING";   color = "#fde68a"; bg = "#92400e" }
        else if (_spec && _spec.source === "auto-build")
                                    { label = "AUTO-BUILD"; color = "#bbf7d0"; bg = "#065f46" }
        else                        { label = "DRAFT";      color = "#fde68a"; bg = "#1f2937" }
        badge.textContent = label
        badge.style.color = color
        badge.style.background = bg
    }

    /** Defensive snapshot of the user's AFP settings — used to pull
     *  default service / pricePct when an auto-built leg is missing them.
     *  AesAfpSettings.load() returns the merged AFP block directly (not
     *  wrapped under `aircraftFlightPlan`); pass it through verbatim.
     *  Returns `{}` when the settings module isn't loaded. */
    async function _settingsSnapshot() {
        if (!window.AesAfpSettings || typeof window.AesAfpSettings.load !== "function") return {}
        try { return (await window.AesAfpSettings.load()) || {} }
        catch (_) { return {} }
    }

    /** Convert _spec into the shape preview-panel's modal renders
     *  (origin/dest/depTime/pricePct/service/direction). Direction is
     *  inferred from hub vs origin so Flight Studio's modal has the same
     *  inbound/outbound colour cues as auto-build's. When the draft carries
     *  a numeric base flight number, issue sequential numbers per leg so the
     *  background scheduler can resolve each newly-created AS flight record
     *  before applying the operating-day schedule. */
    function _legsForApply() {
        if (!_spec || !_spec.legs || !_spec.legs.length) return []
        const hub = _activeHubIata()
        const fn  = (_spec.flightNumberText || "").trim()
        const fnBase = /^\d+$/.test(fn) ? parseInt(fn, 10) : null
        return _spec.legs.map((leg, i) => {
            const origin = _normIata(leg.origin)
            const out = {
                seq:         leg.seq != null ? leg.seq : (i + 1),
                origin:      leg.origin,
                destination: leg.destination,
                depTime:     leg.depTimeLocal,
                pricePct:    leg.pricePct,
                service:     typeof leg.service === "string" ? leg.service : "",
                dayMask:     _legDayMask(leg),
                direction:   (origin && hub && origin === hub) ? "outbound" : "inbound"
            }
            if (fnBase != null) out.flightNumberText = String(fnBase + i)
            else if (i === 0 && fn) out.flightNumberText = fn
            return out
        })
    }

    /** Run the auto-scheduler to populate _spec with an optimal multi-leg
     *  plan. Reuses (no duplication):
     *    - AesAfpAutoScheduler.run         — greedy+swap allocation
     *    - AesAfpRouteCandidates.last       — scored candidates
     *    - allocator's preset resolution    — settings.lastSelectedPresetId
     *  Returns the Build, or null on failure (with a hint already rendered). */
    async function _runAutoBuild() {
        if (_automateInFlight || _applyInFlight) return null
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            _renderHint("error", "Aircraft context not yet resolved.")
            return null
        }
        const sched = window.AesAfpAutoScheduler
        if (!sched || typeof sched.run !== "function") {
            _renderHint("error", "Auto-scheduler not loaded.")
            return null
        }
        _automateInFlight = true
        _updateModeBadge()
        _renderHint("info", "Building optimal plan…")
        try {
            const build = await sched.run({
                aircraftId: ctx.aircraftId,
                hubIata:    _activeHubIata(),
                persist:    false   // panel writes the spec; allocator's draft store stays untouched
            })
            if (!build) {
                _renderHint("error", "Auto-build returned no result.")
                return null
            }
            const validation = Array.isArray(build.validation) ? build.validation : []
            if (validation.length) {
                _renderHint("error", "Auto-build validation: " + validation.map(v => (v && (v.reason || v.message || v.code)) || v).join("; "))
                _lastBuild = build
                return null
            }
            const flights = Array.isArray(build.flights) ? build.flights : []
            if (!flights.length) {
                _renderHint("warn", "Auto-build placed 0 legs — check candidates / preset / budget.")
                _lastBuild = build
                return null
            }
            _lastBuild = build
            const settings = await _settingsSnapshot()
            const next = window.AesAfpLegSpec.setLegsFromBuild(_spec, flights, settings)
            await _updateSpecWithHistory(next)
            // Re-render after clearing the busy flag so the action row does
            // not keep the "In flight..." disabled state from the build run.
            _automateInFlight = false
            _renderBody()
            const wn = (build.placements   && build.placements.length)   || 0
            const cn = (build.connections  && build.connections.length)  || 0
            _renderHint("info",
                "Built " + flights.length + " legs"
                + (wn ? " · " + wn + " waves" : "")
                + (cn ? " · " + cn + " connections" : ""))
            _emit("studio:auto-build-done", {spec: _spec, build})
            return build
        } catch (e) {
            console.warn("[AES studio] auto-build threw", e)
            _renderHint("error", "Auto-build threw: " + ((e && e.message) || String(e)))
            return null
        } finally {
            _automateInFlight = false
            _updateModeBadge()
        }
    }

    /** Open the shared confirmation modal (mandatory ack + duration
     *  estimate + locked-leg detection) and dispatch on confirm. The modal
     *  itself calls back into apply-batch, which streams progress events
     *  the panel mirrors via _attachAutoApplyListener. */
    async function _runApply() {
        if (_automateInFlight || _applyInFlight) return
        const validation = await _validateSpecForAsForm()
        if (!validation.ok) {
            _renderHint("error", "Cannot apply: " + _formatValidationErrors(validation.errors).join("; "))
            return
        }
        const preview = window.AesAfpAutoSchedulerPreview
        if (!preview || typeof preview.openConfirmModal !== "function") {
            _renderHint("error", "Confirmation modal not available — auto-scheduler preview not loaded.")
            return
        }
        if (!window.AesAfpAutoApplyBatch || typeof window.AesAfpAutoApplyBatch.start !== "function") {
            _renderHint("error", "Apply-batch pipeline not loaded — cannot submit.")
            return
        }
        const legs = _legsForApply()
        if (!legs.length) {
            _renderHint("error", "Spec has no legs to apply.")
            return
        }
        const numberRange = await _validateFlightNumberRangeForApply(legs)
        if (!numberRange.ok) {
            _renderHint("error", "Cannot apply: " + numberRange.message)
            return
        }
        _emit("studio:apply-requested", {spec: _spec})
        _renderHint("info", "Opening confirmation…")
        try {
            preview.openConfirmModal(legs, {source: "flight-studio"})
        } catch (e) {
            console.warn("[AES studio] openConfirmModal threw", e)
            _renderHint("error", "Confirm modal threw: " + ((e && e.message) || String(e)))
        }
    }

    /** End-to-end: optimise + apply. The user's primary CTA. Auto-build
     *  always runs (even if the spec is populated) — that's the contract:
     *  Automate is the "rebuild + create" button. To apply an existing
     *  manual spec without rebuilding, use the Apply button instead. */
    async function _runAutomate() {
        if (_automateInFlight || _applyInFlight) return
        _emit("studio:automate-requested", {spec: _spec})
        const build = await _runAutoBuild()
        if (!build || !build.flights || !build.flights.length) return
        await _runApply()
    }

    /** Subscribe to apply-batch bus events so the panel mirrors progress.
     *  Idempotent — runs once. Survives Wicket re-mounts because attach()
     *  guards on _attached. */
    function _attachAutoApplyListener() {
        if (_busListenersAttached) return
        const bus = _bus()
        if (!bus || typeof bus.on !== "function") return
        _busListenersAttached = true
        bus.on("auto-apply:start", (p) => {
            _applyInFlight = true
            _applyTotal = (p && p.total) || 0
            _updateModeBadge()
            _renderHint("info", "Applying " + _applyTotal + " legs to AS…")
        })
        bus.on("auto-apply:progress", (p) => {
            if (!p || !_applyInFlight) return
            if (p.phase !== "leg-done") return
            const idx = (typeof p.legIdx === "number") ? p.legIdx : -1
            if (idx < 0) return
            const ok = !!p.ok
            _renderHint(ok ? "info" : "warn",
                "Leg " + (idx + 1)
                + (_applyTotal ? " of " + _applyTotal : "")
                + " " + (ok ? "succeeded" : ("failed: " + (p.error || "?"))))
        })
        bus.on("auto-apply:done", (p) => {
            _applyInFlight = false
            _applyTotal = 0
            _updateModeBadge()
            const succ = (p && p.succeeded != null) ? p.succeeded : 0
            const fail = (p && p.failed    != null) ? p.failed    : 0
            const tot  = succ + fail
            _renderHint(fail ? "warn" : "info",
                "Applied " + succ + " of " + tot + (fail ? " (" + fail + " failed)" : ""))
            _flushSave().catch(() => {})
            _emit("studio:applied", {spec: _spec, results: (p && p.results) || []})
        })
        bus.on("auto-apply:aborted", (p) => {
            _applyInFlight = false
            _applyTotal = 0
            _updateModeBadge()
            _renderHint("error", "Apply aborted at leg " + ((p && p.completed) || 0))
        })
        bus.on("auto-apply:error", (p) => {
            _applyInFlight = false
            _applyTotal = 0
            _updateModeBadge()
            _renderHint("error", "Apply error: " + ((p && p.error) || "unknown"))
        })
        // F1 decision sidebar — react to spec edits. Debounced 200 ms so a
        // burst of keystrokes coalesces to one fetch; deduped on FROM:TO so
        // PRICE/SERVICE edits don't refetch (estimator doesn't read them).
        bus.on("studio:draft-changed", (p) => {
            if (_sidebarRenderTimer) clearTimeout(_sidebarRenderTimer)
            _sidebarRenderTimer = setTimeout(() => {
                _sidebarRenderTimer = null
                _renderSidebarFor((p && p.spec) || _spec).catch(() => {})
            }, 200)
        })
    }

    /** Render a collapsible summary of the current auto-built spec — leg
     *  count, wave count, connection count, plus a per-leg list. Visible
     *  only when source is "auto-build" (manual specs use the leg-row
     *  editor for leg #0; multi-leg manual entry is via Continue →). */
    function _buildAutoBuildSummary() {
        const wrap = document.createElement("details")
        wrap.dataset.aesStudioAutoBuild = "1"
        wrap.style.cssText = "margin:6px 0 4px;border:1px solid #1f2937;border-radius:3px;background:#0f1623;"
        wrap.open = (_spec && _spec.legs && _spec.legs.length <= 4)

        const sum = document.createElement("summary")
        sum.style.cssText = "cursor:pointer;padding:5px 8px;font-size:11px;color:#cbd5e1;font-weight:600;"
        const wn = (_lastBuild && _lastBuild.placements   && _lastBuild.placements.length)  || 0
        const cn = (_lastBuild && _lastBuild.connections  && _lastBuild.connections.length) || 0
        sum.textContent = "Auto-build · " + (_spec.legs.length) + " legs"
            + (wn ? " · " + wn + " waves" : "")
            + (cn ? " · " + cn + " connections" : "")
        wrap.appendChild(sum)

        const list = document.createElement("div")
        list.style.cssText = "padding:0 8px 6px;font-family:var(--aes-font-mono,monospace);font-size:10px;color:#9ca3af;"
        const hub = _activeHubIata()
        _spec.legs.forEach((leg, i) => {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:8px;padding:2px 0;"
            const arrowOut = (_normIata(leg.origin) && hub && _normIata(leg.origin) === hub)
            const dir = arrowOut ? "→" : "←"
            const dirCol = arrowOut ? "#3b82f6" : "#10b981"
            const idx = document.createElement("span")
            idx.textContent = String(i + 1).padStart(2, " ")
            idx.style.color = "#6b7280"
            idx.style.width = "18px"
            row.appendChild(idx)
            const od = document.createElement("span")
            od.style.color = "#e2e8f0"
            od.style.flex = "1 1 auto"
            od.innerHTML = (leg.origin || "???")
                + " <span style=\"color:" + dirCol + ";font-weight:600;\">" + dir + "</span> "
                + (leg.destination || "???")
            row.appendChild(od)
            const t = document.createElement("span")
            t.textContent = leg.depTimeLocal || "—"
            t.style.color = "#cbd5e1"
            t.style.width = "44px"
            row.appendChild(t)
            const p = document.createElement("span")
            p.textContent = (leg.pricePct != null ? leg.pricePct : 100) + "%"
            p.style.color = "#9ca3af"
            p.style.width = "40px"
            p.style.textAlign = "right"
            row.appendChild(p)
            if (leg.appliedAt) {
                const a = document.createElement("span")
                a.textContent = "✓"
                a.style.color = "#34d399"
                a.style.width = "14px"
                row.appendChild(a)
            }
            list.appendChild(row)
        })
        wrap.appendChild(list)
        return wrap
    }

    /** Second action row — the automation pipeline buttons. Separates
     *  spec-editing actions (Preview / Reset / Undo / Continue) from the
     *  apply-pipeline actions to keep the user's mental model clean. */
    function _buildAutomateActions() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;"
            + "padding-top:6px;border-top:1px dashed #1f2937;"

        const sched   = window.AesAfpAutoScheduler
        const preview = window.AesAfpAutoSchedulerPreview
        const batch   = window.AesAfpAutoApplyBatch
        const busy    = _automateInFlight || _applyInFlight
        const canBuild = !!(sched && typeof sched.run === "function")
        const canApply = !!(preview && typeof preview.openConfirmModal === "function"
                          && batch && typeof batch.start === "function")

        function _setDisabled(btn, disabled, tooltip) {
            if (!disabled) return
            btn.disabled = true
            btn.style.opacity = "0.5"
            btn.style.cursor = "not-allowed"
            if (tooltip) btn.title = tooltip
        }

        const automateBtn = _mkBtn("Build + create", "primary", _runAutomate)
        automateBtn.title = "Build the optimal plan and create all flights in one click"
        _setDisabled(automateBtn, busy || !canBuild || !canApply,
            !canBuild ? "Auto-scheduler not loaded"
            : !canApply ? "Apply-batch pipeline not loaded"
            : "In flight…")

        const buildBtn = _mkBtn("Build draft", "default", _runAutoBuild)
        buildBtn.title = "Run the optimiser and populate the spec without applying"
        _setDisabled(buildBtn, busy || !canBuild,
            !canBuild ? "Auto-scheduler not loaded" : "In flight…")

        const applyBtn = _mkBtn("Create flights", "default", _runApply)
        applyBtn.title = "Apply the current spec via background-tab pipeline"
        _setDisabled(applyBtn, busy || !canApply,
            !canApply ? "Apply-batch pipeline not loaded" : "In flight…")

        row.append(automateBtn, buildBtn, applyBtn)
        return row
    }

    function _buildActions() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;"
        const previewBtn = _mkBtn("Preview", "primary", () => {
            _runPreview()
        })
        const resetBtn = _mkBtn("Reset", "default", async () => {
            const ctx = _ctx()
            const next = _seedSpec(ctx)
            _autoSuggested = false   // user reset → re-arm auto-suggest
            await _updateSpecWithHistory(next)
            _renderBody()
            // Clear the AS form's flight-number input so it matches the
            // reset spec. Other fields are left alone — a candidate-row
            // click may have populated origin/dest, and we don't want
            // Reset to clobber that side-channel work.
            _pushToAsForm("flightNumberText", "")
            if (!_spec.flightNumberText) {
                _autoSuggested = true
                _populateNextAvailable({silent: true}).catch(() => {})
            }
        })
        const undoBtn = _mkBtn("Undo", "default", async () => {
            const ctx = _ctx()
            if (!ctx || !window.AesAfpStudioDraftStore) return
            const restored = await window.AesAfpStudioDraftStore.popHistory(ctx.server, ctx.aircraftId)
            if (restored && restored.spec) {
                _spec = window.AesAfpLegSpec.normalizeSpec(restored.spec)
                _renderBody()
                _pushAllToAsForm()
                _emit("studio:draft-changed", {spec: _spec})
            }
        })

        // Continue → / ← Continue back: advance (or retreat) the route cycle.
        // Forward turns an outbound BASE→STATION leg into its return
        // STATION→BASE; after the return, the next Continue opens a fresh
        // BASE→blank row for the user to fill from the station table.
        // Pure form-state — no AS submit needed between presses.
        const turnLbl = _mkLabel("Turn")
        const turnInp = _mkBaseInput(String(_turnMin), 4, "44px")
        turnInp.placeholder = "min"
        turnInp.title = "Minutes between this leg's arrival and the next leg's departure"
        turnInp.addEventListener("input", () => {
            const n = parseInt(turnInp.value, 10)
            if (isFinite(n) && n >= 0 && n < 1440) _turnMin = n
        })
        const bwdBtn = _mkBtn("← Continue back", "default",
            () => { _continueLeg("backward") })
        bwdBtn.title = "Seed the previous route-cycle leg and retreat DEP by flight time + turnaround"
        const fwdBtn = _mkBtn("Continue →", "default",
            () => { _continueLeg("forward") })
        fwdBtn.title = "Return to the route base, or open the next blank station row"

        row.append(previewBtn, resetBtn, undoBtn,
                   turnLbl, turnInp, bwdBtn, fwdBtn)
        return row
    }

    /**
     * Append (Forward) or prepend (Backward) a fresh leg in the multi-leg
     * tray. Forward anchors on the tray's TAIL leg and keeps the user on a
     * base-station-base cycle:
     *   - BASE→STATION     adds STATION→BASE
     *   - STATION→BASE     adds BASE→blank, so the next candidate click
     *                       fills that row's destination
     * Backward mirrors the same cycle for prepending.
     *
     * Reuses `RouteAssistantDistanceResolver` for distance (cached symmetric
     * pair-key, so JFK→LAX shares storage with LAX→JFK; misses fetch from AS
     * scheduling page) and `AesAfpSpecResolver.last.cruiseSpeedKmh` for cruise
     * speed (set on `ctx:ready`). Flight-time formula mirrors
     * `auto-scheduler/allocator.js:252` minus the `cycleMinutes` overhead —
     * the editable Turn field already covers ground-side time and the user
     * can extend it.
     *
     * F3a contract: previous behaviour replaced the spec; current behaviour
     * preserves the existing legs and grows the tray. The Undo button still
     * walks the draft-store history; we push the pre-Continue spec to history
     * so one Undo press rewinds one Continue, same as before.
     */
    async function _continueLeg(direction) {
        const fwd = direction !== "backward"
        if (!_spec || !_spec.legs || !_spec.legs.length) {
            _renderHint("warn", "No leg to continue from yet — fill the form first.")
            return
        }
        const anchor = fwd ? _spec.legs[_spec.legs.length - 1] : _spec.legs[0]
        const origin = String(anchor.origin || "").toUpperCase()
        const dest   = String(anchor.destination || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(dest)) {
            _renderHint("warn", "Fill FROM + TO before Continue.")
            return
        }
        if (!anchor.depTimeLocal || !/^\d{1,2}:\d{2}$/.test(anchor.depTimeLocal)) {
            _renderHint("warn", "Set DEP before Continue.")
            return
        }
        const ctx = _ctx()
        const server = ctx && ctx.server
        if (!server || !ctx.aircraftId) {
            _renderHint("warn", "Aircraft context not yet resolved — open this from an AFP page.")
            return
        }
        const resolvedSpec = window.AesAfpSpecResolver && window.AesAfpSpecResolver.last
        const kmh = resolvedSpec && Number(resolvedSpec.cruiseSpeedKmh)
        if (!isFinite(kmh) || kmh <= 0) {
            _renderHint("warn", "Spec not yet resolved — wait a moment, then retry.")
            return
        }

        const base = _routeBaseIata()
        if (!base) {
            _renderHint("warn", "Set the first FROM airport before Continue.")
            return
        }

        const addingReturn = fwd
            ? (origin === base && dest !== base)
            : (dest === base && origin !== base)
        const openingStationSlot = fwd
            ? (dest === base && origin !== base)
            : (origin === base && dest !== base)
        if (!addingReturn && !openingStationSlot) {
            _renderHint("warn", "Continue follows " + base
                + " station cycles. Change this leg to return to " + base
                + " before opening another station.")
            return
        }

        const distanceKm = await _resolveDistanceKm(server, origin, dest)
        if (!distanceKm) {
            _renderHint("warn", "Couldn't resolve distance for " + origin + "→" + dest
                + " — type the next DEP manually.")
            return
        }

        const flightMin = Math.round((distanceKm / kmh) * 60)
        const turn      = Number(_turnMin) || 0
        const deltaMin  = flightMin + turn
        const newDep    = _addMinutesHHMM(anchor.depTimeLocal, fwd ? deltaMin : -deltaMin)

        let next
        if (fwd) {
            // addLeg defaults origin to tail.destination; override both
            // fields so a return leg always targets the route base, while the
            // post-return row opens BASE→blank for the next station pick.
            next = window.AesAfpLegSpec.addLeg(_spec, {
                origin:       addingReturn ? dest : base,
                destination:  addingReturn ? base : null,
                depTimeLocal: newDep
            })
        } else {
            // Prepend — addLeg only appends, so build the legs array directly
            // and re-normalise to densify seq. A prepended return-slot is
            // intentionally blank on origin so the user can choose the
            // previous station later.
            const cloned = window.AesAfpLegSpec.cloneSpec(_spec)
            cloned.legs.unshift({
                origin:       addingReturn ? base : null,
                destination:  addingReturn ? origin : base,
                depTimeLocal: newDep,
                service:      typeof anchor.service === "string" ? anchor.service : "",
                pricePct:     anchor.pricePct
            })
            next = window.AesAfpLegSpec.normalizeSpec(cloned)
        }

        await _updateSpecWithHistory(next)
        _renderBody()
        // Leg 0 may have shifted (backward prepend) — sync the AS form mirror
        // to match. Forward-append leaves leg 0 unchanged, but pushing again
        // is idempotent and keeps the two surfaces in lockstep.
        _pushAllToAsForm()
        _renderHint("info", (fwd ? "Forward" : "Backward")
            + " · " + (addingReturn
                ? (fwd ? dest + "→" + base : base + "→" + origin)
                : (fwd ? base + "→(pick station)" : "(pick station)→" + base))
            + " · " + flightMin + " min flight + " + turn + " min turn = "
            + deltaMin + " min " + (fwd ? "added" : "subtracted") + ".")
        _emit("studio:draft-changed", {spec: _spec})
    }

    function _normIata(v) {
        const s = String(v == null ? "" : v).trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : null
    }

    function _routeBaseIata() {
        const legs = (_spec && Array.isArray(_spec.legs)) ? _spec.legs : []
        for (const leg of legs) {
            const o = _normIata(leg && leg.origin)
            if (o) return o
        }
        return _activeHubIata()
    }

    function _candidateFillTargetIndex(source) {
        if (source === "wave-leg") return 0
        const legs = (_spec && Array.isArray(_spec.legs)) ? _spec.legs : []
        for (let i = legs.length - 1; i >= 0; i--) {
            const leg = legs[i] || {}
            if (_normIata(leg.origin) && !_normIata(leg.destination)) return i
        }
        return 0
    }

    function _fillCandidateDestination(idx, payload) {
        if (!_spec || !_spec.legs || !_spec.legs.length) return false
        const p = payload || {}
        const c = p.candidate || p
        const destIata = _normIata(c && c.destIata)
        if (!destIata) return false

        const targetIdx = Number.isFinite(idx)
            ? Math.max(0, Math.min(_spec.legs.length - 1, Math.round(idx)))
            : 0
        const previousLeg = _spec.legs[targetIdx] || {}
        const wasBlankSlot = targetIdx > 0
            && _normIata(previousLeg.origin)
            && !_normIata(previousLeg.destination)

        let next = window.AesAfpLegSpec.setLegField(_spec, targetIdx, "destination", destIata)
        if (!wasBlankSlot && typeof p.depTime === "string" && /^\d{1,2}:\d{2}$/.test(p.depTime)) {
            next = window.AesAfpLegSpec.setLegField(next, targetIdx, "depTimeLocal", p.depTime)
        }
        if (p.source === "wave-leg" && c.__wave && c.__wave.origin) {
            next = window.AesAfpLegSpec.setLegField(next, targetIdx, "origin", c.__wave.origin)
        }
        _updateSpec(next)
        _renderBody()
        if (targetIdx === 0) _pushToAsForm("flightNumberText", _spec.flightNumberText || "")
        else setTimeout(() => _pushAllToAsForm(), 0)
        if (wasBlankSlot) {
            _renderHint("info", "Filled leg #" + (targetIdx + 1) + " destination: "
                + previousLeg.origin + "→" + destIata + ".")
        }
        return true
    }

    async function _resolveDistanceKm(server, origin, dest) {
        const o = _normIata(origin)
        const d = _normIata(dest)
        if (!o || !d) return null
        let distanceKm = null
        try {
            if (typeof RouteAssistantDistanceResolver === "function") {
                const resolver = new RouteAssistantDistanceResolver(server)
                const rec = await resolver.resolve(o, d)
                if (rec && Number(rec.distanceKm) > 0) distanceKm = Number(rec.distanceKm)
            }
        } catch (e) {
            console.warn("[AES studio] distance resolve threw", e)
        }
        return distanceKm
    }

    function _buildDryRunPane() {
        const wrap = document.createElement("details")
        wrap.dataset.aesStudioDry = "1"
        wrap.style.marginTop = "4px"

        const outcome = _lastDryRunOutcome
        const sum = document.createElement("summary")
        sum.style.cssText = "cursor:pointer;font-size:11px;color:#9ca3af;"

        const pre = document.createElement("pre")
        pre.dataset.aesStudioDryBody = "1"
        pre.style.cssText = "margin:4px 0 0;padding:6px;background:#0f1419;color:#e2e8f0;font-size:10px;line-height:1.4;overflow:auto;max-height:240px;border-radius:3px;"

        if (!outcome) {
            sum.textContent = "Live form output (click Preview to populate)"
            pre.textContent = "(no form output yet — Preview to compute)"
            wrap.appendChild(sum)
            wrap.appendChild(pre)
            return wrap
        }

        // Always expand once Preview has run, regardless of outcome.
        wrap.open = true

        if (outcome.validationErrors && outcome.validationErrors.length) {
            sum.textContent = "Spec invalid — fix and re-Preview"
            sum.style.color = "#fca5a5"
            const lines = _formatValidationErrors(outcome.validationErrors)
                .map(line => "• " + line)
            pre.textContent = lines.join("\n")
        } else if (outcome.error) {
            sum.textContent = "Preview error"
            sum.style.color = "#fca5a5"
            pre.textContent = outcome.error
        } else if (outcome.dryRun) {
            const r = outcome.dryRun
            const formMissing = Array.isArray(r.missed) && r.missed.indexOf("form-not-found") >= 0
            sum.textContent = formMissing ? "AS form not on the page" : "Live POST body"
            if (formMissing) sum.style.color = "#fde68a"
            const parts = []
            if (formMissing) {
                parts.push(
                    "AS's New Flight Number form isn't in the DOM yet —",
                    "switch to the 'New Flight Number' tab and Preview again.",
                    ""
                )
            }
            if (outcome.info) { parts.push(outcome.info, "") }
            parts.push(_formatDryRun(r))
            pre.textContent = parts.join("\n")
        } else {
            sum.textContent = "Live form output"
            pre.textContent = "(empty outcome)"
        }

        wrap.appendChild(sum)
        wrap.appendChild(pre)
        return wrap
    }

    // ── Preview pipeline ─────────────────────────────────────────────────

    /**
     * Mutates _lastDryRun/_lastDryRunOutcome and re-renders the body so the
     * form-output pane reflects the latest Preview attempt. Always populates the
     * pane visibly — validation errors, form-not-found, and successful POST
     * bodies all show inline rather than as easy-to-miss side hints.
     */
    function _renderDryRunPaneWith(outcome) {
        _lastDryRunOutcome = outcome || null
        _lastDryRun = (outcome && outcome.dryRun) || null
        _renderBody()
    }

    async function _validateSpecForAsForm() {
        const pure = window.AesAfpLegSpec.validateSpec(_spec)
        if (!pure.ok) return pure
        const fd = window.AesAfpFormDriver
        if (!fd || typeof fd.findForm !== "function"
                || typeof window.AesAfpLegSpec.validateAgainstForm !== "function") {
            return pure
        }
        try {
            if (!fd.findForm() && typeof fd.ensureNewTabActive === "function") {
                await fd.ensureNewTabActive()
            }
            const form = fd.findForm()
            return form ? window.AesAfpLegSpec.validateAgainstForm(_spec, form) : pure
        } catch (e) {
            console.warn("[AES studio] AS-form validation failed", e)
            return pure
        }
    }

    function _formatValidationErrors(errors) {
        return (errors || []).map(_formatValidationError)
    }

    function _formatValidationError(error) {
        const e = error || {}
        if (e.reason === "iata-not-in-airline-options") {
            const m = /^legs\.(\d+)\.(origin|destination)$/.exec(String(e.path || ""))
            if (m) {
                const idx = parseInt(m[1], 10)
                const field = m[2]
                const leg = _spec && _spec.legs && _spec.legs[idx]
                const code = leg && (field === "origin" ? leg.origin : leg.destination)
                const label = field === "origin" ? "FROM" : "TO"
                return "leg #" + (idx + 1) + " " + label + " " + (code || "???")
                    + " is not available in AS's route list for this airline. Open the station or pick an airport from the native New Flight Number form."
            }
        }
        return String(e.path || "spec") + " — " + String(e.reason || "invalid")
    }

    async function _runPreview() {
        const validation = await _validateSpecForAsForm()
        if (!validation.ok) {
            _renderDryRunPaneWith({validationErrors: validation.errors})
            return
        }
        const fd = window.AesAfpFormDriver
        if (!fd || typeof fd.dryRun !== "function") {
            _renderDryRunPaneWith({error: "Form driver not loaded — cannot inspect the live form."})
            return
        }
        // Auto-flip to the "New Flight Number" tab if AS is currently on
        // "Existing Flight Number" — the form only mounts in the New tab,
        // so without this dryRun would always come back form-not-found.
        if (!fd.findForm() && typeof fd.ensureNewTabActive === "function") {
            try { await fd.ensureNewTabActive() } catch (_) { /* fall through */ }
        }
        // S1: single-leg only. Multi-leg dry-run lands in S2 alongside the
        // form-driver-x addVia plumbing.
        const formLeg = window.AesAfpLegSpec.toFormDriverLeg(_spec.legs[0], _spec.flightNumberText || "")
        const result = fd.dryRun(formLeg)
        // Also pre-fill AS's "New Flight Number" form so the user can review
        // and click Submit. fill() never POSTs (safety invariant in
        // form-driver.js:10-24); the user remains in control of the green
        // "Create new flight number" button. Awaited so the info string is
        // ready when we paint the pane (the previous fire-and-forget pattern
        // raced with _renderBody and lost the confirmation).
        let info = null
        if (typeof fd.fill === "function") {
            try {
                const r = await fd.fill(formLeg)
                if (r && r.ok) {
                    info = "AS form pre-filled — review and click 'Create new flight number' to confirm."
                } else if (r && r.missed && r.missed.length) {
                    info = "AS form partially filled — missed: " + r.missed.join(", ")
                }
            } catch (_) { /* dry-run still useful */ }
        }
        _renderDryRunPaneWith({dryRun: result, info: info})
        _emit("studio:dry-run-rendered", {spec: _spec, dryRun: result})
    }

    function _formatDryRun(result) {
        const lines = []
        lines.push("POST " + (result.url || "(unknown)"))
        lines.push("")
        const keys = Object.keys(result.body || {}).sort()
        if (!keys.length) {
            lines.push("(no fields)")
        } else {
            const max = Math.max.apply(null, keys.map(k => k.length))
            for (const k of keys) lines.push(k.padEnd(max) + " = " + result.body[k])
        }
        if (result.missed && result.missed.length) {
            lines.push("")
            lines.push("missed: " + result.missed.join(", "))
            if (result.missed.indexOf("form-not-found") >= 0) {
                lines.push("→ Switch AS to the 'New Flight Number' tab so the form is in the DOM, then re-Preview.")
            }
        }
        return lines.join("\n")
    }

    function _renderHint(kind, message) {
        const host = _slot()
        if (!host) return
        const body = host.querySelector("[data-aes-studio-body]")
        if (!body) return
        let hint = body.querySelector("[data-aes-studio-hint]")
        if (!hint) {
            hint = document.createElement("div")
            hint.dataset.aesStudioHint = "1"
            hint.style.cssText = "font-size:10px;margin-top:4px;line-height:1.4;"
            body.appendChild(hint)
        }
        hint.style.color = (kind === "error") ? "#fca5a5"
                        : (kind === "warn")  ? "#fde68a"
                        : "#a7f3d0"
        hint.textContent = message
    }

    // ── Input factories ──────────────────────────────────────────────────

    function _mkLabel(text) {
        const s = document.createElement("span")
        s.textContent = text
        s.style.cssText = "color:#9ca3af;font-size:10px;letter-spacing:0.4px;text-transform:uppercase;"
        return s
    }
    function _mkArrow() {
        const s = document.createElement("span")
        s.textContent = "→"
        s.style.cssText = "color:#6b7280;font-size:12px;"
        return s
    }
    function _mkBaseInput(value, maxlen, width) {
        const inp = document.createElement("input")
        inp.type = "text"
        inp.value = value == null ? "" : String(value)
        if (maxlen != null) inp.maxLength = maxlen
        inp.style.cssText = [
            "background:#0f1419;color:#e2e8f0;",
            "border:1px solid #374151;border-radius:3px;",
            "padding:3px 6px;font-size:11px;",
            "font-family:var(--aes-font-mono,monospace);",
            "width:" + (width || "auto") + ";"
        ].join("")
        return inp
    }
    function _mkIataInput(value, onChange) {
        const inp = _mkBaseInput((value || "").toUpperCase(), 3, "56px")
        inp.placeholder = "IATA"
        inp.style.textTransform = "uppercase"
        inp.addEventListener("input", () => {
            const v = inp.value.toUpperCase()
            if (inp.value !== v) inp.value = v
            onChange(v)
        })
        return inp
    }
    function _mkTimeInput(value, onChange) {
        const inp = _mkBaseInput(value || "", 5, "60px")
        inp.placeholder = "HH:MM"
        inp.addEventListener("input", () => onChange(inp.value))
        inp.addEventListener("blur", () => {
            const v = inp.value.trim()
            if (/^\d{1,2}:\d{2}$/.test(v)) {
                const [h, m] = v.split(":").map(Number)
                if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                    const padded = (h < 10 ? "0" + h : "" + h) + ":" + (m < 10 ? "0" + m : "" + m)
                    if (inp.value !== padded) {
                        inp.value = padded
                        onChange(padded)
                    }
                }
            }
        })
        return inp
    }
    function _mkPctInput(value, onChange) {
        const inp = _mkBaseInput(value == null ? "100" : String(value), 3, "48px")
        inp.placeholder = "100"
        inp.title = "50–200"
        inp.addEventListener("input", () => {
            const v = parseInt(inp.value, 10)
            if (isFinite(v)) onChange(v)
        })
        return inp
    }
    function _mkServiceInput(value, onChange) {
        // S1 ships a free-text input; S2's paste-import will introduce
        // label-fallback (e.g. "Standard" → "719"). The form-driver's
        // setService matches the option `value` directly, so blank or
        // numeric strings both work here.
        const inp = _mkBaseInput(value || "", 24, "120px")
        inp.placeholder = "(default)"
        inp.title = "Service profile option value (e.g. '719' for Standard). Blank = AS default."
        inp.addEventListener("input", () => onChange(inp.value))
        return inp
    }
    function _mkTextInput(value, maxlen, width, onChange) {
        const inp = _mkBaseInput(value || "", maxlen, width)
        inp.addEventListener("input", () => onChange(inp.value))
        return inp
    }
    function _mkBtn(label, kind, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        const isPrimary = kind === "primary"
        b.style.cssText = [
            "background:" + (isPrimary ? "#1e40af" : "#0f1623"),
            "color:" + (isPrimary ? "#dbeafe" : "#cbd5e1"),
            "border:1px solid " + (isPrimary ? "#1d4ed8" : "#374151"),
            "border-radius:3px;padding:4px 10px;font-size:11px;",
            "font-weight:600;cursor:pointer;"
        ].join(";")
        b.addEventListener("click", (event) => {
            let result
            try {
                result = onClick(event)
            } catch (e) {
                console.warn("[AES studio] button threw", e)
                _renderHint("error", label + " failed: " + ((e && e.message) || String(e)))
                return
            }
            if (result && typeof result.catch === "function") {
                result.catch((e) => {
                    console.warn("[AES studio] button rejected", e)
                    _renderHint("error", label + " failed: " + ((e && e.message) || String(e)))
                })
            }
        })
        return b
    }

    // ── Public ───────────────────────────────────────────────────────────

    /** Programmatic open — scrolls panel into view, focuses first input,
     *  emits studio:opened. Tolerant of slot-not-yet-mounted (will render
     *  on next ctx:ready if necessary). */
    async function open(trigger) {
        await render()
        const host = _slot()
        if (host) {
            try { host.scrollIntoView({behavior: "smooth", block: "center"}) }
            catch (_) { /* old browsers — noop */ }
            const firstInput = host.querySelector("input")
            if (firstInput) {
                try { firstInput.focus() } catch (_) {}
            }
        }
        _emit("studio:opened", {trigger: trigger || TRIGGER_INIT})
    }

    function getSpec() { return _spec }

    function attach() {
        if (_attached) return
        const bus = _bus()
        if (!bus) return
        _attached = true
        // Re-render on every ctx:ready — covers initial mount AND Wicket
        // re-mount paths. render() is idempotent. _attachAsMirror() is
        // self-healing across tab swaps (polls every 750ms), so calling
        // it once per render is enough to bootstrap.
        bus.on("ctx:ready", () => {
            render()
                .then(() => {
                    _attachMatrixObserver()
                    _attachAsMirror()
                })
                .catch(e => console.warn("[AES studio] render threw", e))
        })
        // schedule:updated fires when other modules persist a new schedule
        // record (route-candidates.js:836); the matrix may have changed too,
        // so refresh diagnostics. Body-level re-render is cheap.
        bus.on("schedule:updated", () => {
            if (_renderInFlight) return
            _renderBody()
        })
        bus.on("hub:changed", () => {
            if (!_spec) return
            const next = _syncBlankDraftOriginToActiveHub(_spec)
            if (next === _spec) return
            _updateSpec(next)
            const hub = _activeHubIata()
            if (hub) _pushToAsForm("origin", hub)
            _renderBody()
            _emit("studio:draft-changed", {spec: _spec})
        })
        // Candidate-row click: fill the newest BASE→blank station row when
        // Continue opened one; otherwise mirror the picked destination (and
        // depTime / wave-leg origin) into leg #1.
        // form-driver.js already fills AS's destination/dep selects; this
        // handler covers the sidebar inputs that bind to `_spec` and the
        // flight-number text input that fill() leaves alone when leg #1
        // is the active target.
        bus.on("candidate:selected", (payload) => {
            if (!_spec || !_spec.legs || !_spec.legs.length) return
            const c = payload && payload.candidate
            if (!c || !c.destIata) return
            const idx = _candidateFillTargetIndex(payload.source)
            _fillCandidateDestination(idx, payload)
            _emit("studio:draft-changed", {spec: _spec})
        })
        // Subscribe to apply-batch progress so the panel can show live
        // status during a Flight Studio "Apply" / "Automate" run.
        _attachAutoApplyListener()
        // If ctx is already ready by the time we attach (manifest order
        // may have dispatched ctx:ready before our handler subscribed),
        // render eagerly.
        if (window.AesAfp && window.AesAfp.ctx) {
            render()
                .then(() => {
                    _attachMatrixObserver()
                    _attachAsMirror()
                })
                .catch(e => console.warn("[AES studio] initial render threw", e))
        }
    }

    window.AesAfpFlightStudio = {
        attach,
        render,
        open,
        getSpec
    }

    // Late-load guard — Slice A's bus may not be live yet when this
    // module evaluates (manifest order should put us after host.js but
    // parse-vs-execute timing isn't strict). Mirror form-driver.js's
    // poll pattern.
    if (window.AesAfp && window.AesAfp.bus) {
        attach()
    } else {
        let tries = 0
        const id = setInterval(() => {
            if (window.AesAfp && window.AesAfp.bus) {
                clearInterval(id)
                attach()
            } else if (++tries > 50) {
                clearInterval(id)
            }
        }, 100)
    }

    // ?aes-debug smoke asserts — fire only when the user adds the query
    // string to the AS URL. Mirrors auto-scheduler/preview-panel.js:2059.
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof _runPreview === "function",
                "[AES studio smoke] _runPreview defined")
            console.assert(typeof _buildScheduleDiagnostics === "function",
                "[AES studio smoke] _buildScheduleDiagnostics defined")
            console.assert(typeof _renderDryRunPaneWith === "function",
                "[AES studio smoke] _renderDryRunPaneWith defined")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
