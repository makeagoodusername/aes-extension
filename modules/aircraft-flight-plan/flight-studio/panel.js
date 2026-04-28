"use strict"

/**
 * Flight Studio — compose panel (Slice S1).
 *
 * Mounts at `AesAfp.slot("studio")` and renders a compose UI for one
 * FlightSpec. S1 ships **dry-run only**: the user types a leg, clicks
 * Preview, sees the would-be POST body. NO live form interaction, NO
 * programmatic Submit.
 *
 * SAFETY INVARIANT (mirrors form-driver.js:10-24):
 *   The panel never calls submitBtn.click(), form.submit(), or any
 *   chrome.runtime message that triggers a submit. Preview reads option
 *   values via AesAfpFormDriver.dryRun(); that path does not POST.
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
                                  // dry-run pane always reflects the last attempt
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

    // F2 — Flight Studio templates. Cached per-server Template[] so the
    // dropdown can render synchronously; _paintTemplatesRow refreshes it
    // after every save/delete and on initial mount.
    let _templates = []

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
        return base
    }

    function _seedSpec(ctx) {
        return window.AesAfpLegSpec.createSpec({
            server:      ctx ? ctx.server     : "",
            aircraftId:  ctx ? ctx.aircraftId : "",
            origin:      ctx ? ctx.currentLocationIata : null,
            source:      "manual",
            dryRun:      true
        })
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
        _scheduleSave()
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
        sub.textContent = "compose · dry-run"
        sub.style.cssText = "color:#9ca3af;font-size:10px;"
        const flex = document.createElement("span")
        flex.style.cssText = "flex:1 1 auto;"
        const modeBadge = document.createElement("span")
        modeBadge.dataset.aesStudioMode = "1"
        modeBadge.textContent = "DRY-RUN"
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
                    paxScore:   demand ? demand.paxScore   : null,
                    cargoScore: demand ? demand.cargoScore : null,
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
                            paxScore:   demand && Number.isFinite(Number(demand.paxScore))
                                            ? Number(demand.paxScore) : null,
                            distanceKm: routeRec && Number(routeRec.distanceKm) > 0
                                            ? Number(routeRec.distanceKm) : null,
                            topN:       3
                        })
                } catch (_) { sisterFleet = [] }
            }
        }
        if (myCtrl.aborted) return

        _paintSidebar(host, {from, to, demand, routeRec, estimate, hasSpec: !!acSpec,
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
                            _paintSidebar(host, {from, to, demand, routeRec, estimate,
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
            const hub = ctx.currentLocationIata || "??"
            hint.textContent = "Hub: " + hub + " · " + ctx.registration + " · " + ctx.equipment
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
        const addBtn = _mkBtn("+ Add leg", "default", () => {
            const next = window.AesAfpLegSpec.addLeg(_spec)
            _updateSpec(next)
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
        const rm = _mkBtn("✕", "default", () => {
            const next = window.AesAfpLegSpec.removeLeg(_spec, idx)
            _updateSpec(next)
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

    /** Append a fresh leg seeded from a route-candidates drag payload.
     *  Insert position is currently always tail — `insertAtIdx` is captured
     *  for a future "drop between rows" affordance but addLeg only appends.
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

        const ctx  = _ctx()
        const hub  = (ctx && ctx.currentLocationIata || "").toUpperCase()
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
        if (snap.origin) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "origin", snap.origin)
        }
        if (snap.destination) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "destination", snap.destination)
        }
        if (snap.depTimeLocal) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "depTimeLocal", snap.depTimeLocal)
        }
        if (snap.pricePct != null) {
            next = window.AesAfpLegSpec.setLegField(next, 0, "pricePct", snap.pricePct)
        }
        if (typeof snap.service === "string" && snap.service.length) {
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
                const overlaid = _overlayAsSnapshotOnSpec(_spec, snap)
                if (overlaid !== _spec) {
                    _updateSpec(overlaid)
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
        // "Next" button — clicks AS's "find first available" anchor and
        // mirrors the result back into the spec. AS already implements the
        // global per-airline next-available lookup, so we delegate rather
        // than duplicate it client-side.
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
        // Repeated clicks must advance past whatever's already shown — AS's
        // "find first available" does not change the value when it would
        // re-suggest the number that's already in the input, so without this
        // we'd get the same value forever (and _pushToAsForm would just keep
        // re-stamping it onto the AS form). Treat the current spec value as
        // "in flight" and pass it to the local scan as already-used.
        const currentNum = String(_spec.flightNumberText || "").replace(/[^0-9]/g, "")
        const extraUsed = currentNum ? [currentNum] : []
        let next = null
        // Only ask AS when the form is already on the page (silent path)
        // OR when the user explicitly clicked Next (full path, may flip tab).
        const formAlreadyVisible = !!(window.AesAfp
            && typeof window.AesAfp.getNewFlightForm === "function"
            && window.AesAfp.getNewFlightForm())
        if ((!silent || formAlreadyVisible)
            && window.AesAfpFormDriver
            && typeof window.AesAfpFormDriver.findNextAvailableFlightNumber === "function") {
            try { next = await window.AesAfpFormDriver.findNextAvailableFlightNumber() }
            catch (e) { console.warn("[AES studio] findNextAvailable threw", e) }
        }
        // AS may return null (timeout because the value didn't change) or the
        // same value the user already has — both mean "no advance". Fall
        // through to the per-aircraft scan with the current value excluded.
        if (!next || extraUsed.indexOf(String(next)) !== -1) {
            next = _scanScheduleNextAvailable(extraUsed)
        }
        if (!next) {
            if (!silent) _renderHint("warn", "Couldn't find next available flight number — switch to AS's 'New Flight Number' tab and try again.")
            return
        }
        _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText", next))
        _pushToAsForm("flightNumberText", next)
        _renderBody()
        if (!silent) _renderHint("info", "Suggested next flight number: " + next)
    }

    /** Read existing flight codes off the AFP page's Visual Flight Plan and
     *  return the smallest unused positive integer (as a string). This is a
     *  per-aircraft view — the AS server-side lookup is authoritative for
     *  the whole airline — but it's a sane fallback when the AS anchor
     *  isn't on the page. Returns null if we can't enumerate. */
    function _scanScheduleNextAvailable(extraUsed) {
        const vfp = (window.AesAfp && typeof window.AesAfp.readSchedule === "function")
            ? window.AesAfp.readSchedule()
            : null
        const legs = (vfp && vfp.legs) || (vfp && Array.isArray(vfp) ? vfp : [])
        const used = new Set()
        for (const leg of legs || []) {
            const code = leg && (leg.flightCode || leg.flightNumber)
            if (!code) continue
            // flightCode shape: "PAA 1", "PAA 47", or "47" (some airlines).
            const m = String(code).match(/(\d+)\s*$/)
            if (m) used.add(parseInt(m[1], 10))
        }
        if (extraUsed && extraUsed.length) {
            for (const raw of extraUsed) {
                const v = parseInt(String(raw).replace(/[^0-9]/g, ""), 10)
                if (v > 0) used.add(v)
            }
        }
        if (!used.size) return "1"
        for (let n = 1; n < 10000; n++) if (!used.has(n)) return String(n)
        return null
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
        else                        { label = "DRY-RUN";    color = "#fde68a"; bg = "#1f2937" }
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
     *  inbound/outbound colour cues as auto-build's. flightNumberText is
     *  attached to leg #0 only — AS won't honour duplicates on subsequent
     *  POSTs in a multi-leg batch. */
    function _legsForApply() {
        if (!_spec || !_spec.legs || !_spec.legs.length) return []
        const ctx = _ctx()
        const hub = (ctx && ctx.currentLocationIata || "").toUpperCase()
        const fn  = (_spec.flightNumberText || "").trim()
        return _spec.legs.map((leg, i) => {
            const out = {
                seq:         leg.seq != null ? leg.seq : (i + 1),
                origin:      leg.origin,
                destination: leg.destination,
                depTime:     leg.depTimeLocal,
                pricePct:    leg.pricePct,
                service:     typeof leg.service === "string" ? leg.service : "",
                direction:   (leg.origin && hub && leg.origin === hub) ? "outbound" : "inbound"
            }
            if (i === 0 && fn) out.flightNumberText = fn
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
            _updateSpec(next)
            await _flushSave()
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
        const validation = window.AesAfpLegSpec.validateSpec(_spec)
        if (!validation.ok) {
            _renderHint("error", "Cannot apply: " + validation.errors.map(e => e.path + " — " + e.reason).join("; "))
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
        const ctx = _ctx()
        const hub = (ctx && ctx.currentLocationIata || "").toUpperCase()
        _spec.legs.forEach((leg, i) => {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:8px;padding:2px 0;"
            const arrowOut = (leg.origin && hub && leg.origin === hub)
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

        const automateBtn = _mkBtn("🎯 Automate", "primary", _runAutomate)
        automateBtn.title = "Build the optimal plan and create all flights in one click"
        _setDisabled(automateBtn, busy || !canBuild || !canApply,
            !canBuild ? "Auto-scheduler not loaded"
            : !canApply ? "Apply-batch pipeline not loaded"
            : "In flight…")

        const buildBtn = _mkBtn("Auto-Build", "default", _runAutoBuild)
        buildBtn.title = "Run the optimiser and populate the spec without applying"
        _setDisabled(buildBtn, busy || !canBuild,
            !canBuild ? "Auto-scheduler not loaded" : "In flight…")

        const applyBtn = _mkBtn("Apply", "default", _runApply)
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
            _spec = _seedSpec(ctx)
            _autoSuggested = false   // user reset → re-arm auto-suggest
            await _flushSave()
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

        // Continue → / ← Continue back: advance (or retreat) the form for
        // the next leg of a wave by `flightTime + turnaround`. Forward
        // anchors FROM = prev.TO; backward anchors TO = prev.FROM. Pure
        // form-state — no AS submit needed between presses.
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
        bwdBtn.title = "Seed previous leg: TO = current FROM, FROM blank, "
            + "DEP retreats by flight time + turnaround"
        const fwdBtn = _mkBtn("Continue →", "default",
            () => { _continueLeg("forward") })
        fwdBtn.title = "Seed next leg: FROM = current TO, TO blank, "
            + "DEP advances by flight time + turnaround"

        row.append(previewBtn, resetBtn, undoBtn,
                   turnLbl, turnInp, bwdBtn, fwdBtn)
        return row
    }

    /**
     * Append (Forward) or prepend (Backward) a fresh leg in the multi-leg
     * tray. Forward anchors on the tray's TAIL leg: new leg gets
     * FROM = tail.destination, TO = blank, DEP = tail.dep + flightTime + turn.
     * Backward anchors on the tray's HEAD leg: new leg gets TO = head.origin,
     * FROM = blank, DEP = head.dep − head's flightTime − turn.
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

        let distanceKm = null
        try {
            if (typeof RouteAssistantDistanceResolver === "function") {
                const resolver = new RouteAssistantDistanceResolver(server)
                const rec = await resolver.resolve(origin, dest)
                if (rec && Number(rec.distanceKm) > 0) distanceKm = Number(rec.distanceKm)
            }
        } catch (e) {
            console.warn("[AES studio] distance resolve threw", e)
        }
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
            // addLeg defaults origin to tail.destination + service/pricePct
            // from tail; we only need to override depTime + null TO.
            next = window.AesAfpLegSpec.addLeg(_spec, {
                destination:  null,
                depTimeLocal: newDep
            })
        } else {
            // Prepend — addLeg only appends, so build the legs array directly
            // and re-normalise to densify seq.
            const cloned = window.AesAfpLegSpec.cloneSpec(_spec)
            cloned.legs.unshift({
                origin:       null,
                destination:  origin,
                depTimeLocal: newDep,
                service:      typeof anchor.service === "string" ? anchor.service : "",
                pricePct:     anchor.pricePct
            })
            next = window.AesAfpLegSpec.normalizeSpec(cloned)
        }

        if (window.AesAfpStudioDraftStore) {
            try {
                await window.AesAfpStudioDraftStore.save(server, ctx.aircraftId, next, {pushPrev: true})
            } catch (e) {
                console.warn("[AES studio] save threw on Continue", e)
            }
        }
        _updateSpec(next)
        _renderBody()
        // Leg 0 may have shifted (backward prepend) — sync the AS form mirror
        // to match. Forward-append leaves leg 0 unchanged, but pushing again
        // is idempotent and keeps the two surfaces in lockstep.
        _pushAllToAsForm()
        _renderHint("info", (fwd ? "Forward" : "Backward")
            + " · " + flightMin + " min flight + " + turn + " min turn = "
            + deltaMin + " min " + (fwd ? "added" : "subtracted") + ".")
        _emit("studio:draft-changed", {spec: _spec})
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
            sum.textContent = "Dry-run output (click Preview to populate)"
            pre.textContent = "(no dry-run yet — Preview to compute)"
            wrap.appendChild(sum)
            wrap.appendChild(pre)
            return wrap
        }

        // Always expand once Preview has run, regardless of outcome.
        wrap.open = true

        if (outcome.validationErrors && outcome.validationErrors.length) {
            sum.textContent = "Spec invalid — fix and re-Preview"
            sum.style.color = "#fca5a5"
            const lines = outcome.validationErrors
                .map(e => "• " + e.path + " — " + e.reason)
            pre.textContent = lines.join("\n")
        } else if (outcome.error) {
            sum.textContent = "Preview error"
            sum.style.color = "#fca5a5"
            pre.textContent = outcome.error
        } else if (outcome.dryRun) {
            const r = outcome.dryRun
            const formMissing = Array.isArray(r.missed) && r.missed.indexOf("form-not-found") >= 0
            sum.textContent = formMissing ? "AS form not on the page" : "Dry-run POST body"
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
            sum.textContent = "Dry-run output"
            pre.textContent = "(empty outcome)"
        }

        wrap.appendChild(sum)
        wrap.appendChild(pre)
        return wrap
    }

    // ── Preview pipeline ─────────────────────────────────────────────────

    /**
     * Mutates _lastDryRun/_lastDryRunOutcome and re-renders the body so the
     * dry-run pane reflects the latest Preview attempt. Always populates the
     * pane visibly — validation errors, form-not-found, and successful POST
     * bodies all show inline rather than as easy-to-miss side hints.
     */
    function _renderDryRunPaneWith(outcome) {
        _lastDryRunOutcome = outcome || null
        _lastDryRun = (outcome && outcome.dryRun) || null
        _renderBody()
    }

    async function _runPreview() {
        const validation = window.AesAfpLegSpec.validateSpec(_spec)
        if (!validation.ok) {
            _renderDryRunPaneWith({validationErrors: validation.errors})
            return
        }
        const fd = window.AesAfpFormDriver
        if (!fd || typeof fd.dryRun !== "function") {
            _renderDryRunPaneWith({error: "Form driver not loaded — cannot dry-run."})
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
        b.addEventListener("click", onClick)
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
        // Candidate-row click: mirror the picked destination (and depTime /
        // wave-leg origin) into the Studio sidebar's leg-0 inputs and push
        // the current `flightNumberText` into AS's `<input id="ida4">`.
        // form-driver.js already fills AS's destination/dep selects; this
        // handler covers the sidebar inputs that bind to `_spec` and the
        // flight-number text input that fill() leaves alone when the leg
        // didn't carry one.
        bus.on("candidate:selected", (payload) => {
            if (!_spec || !_spec.legs || !_spec.legs.length) return
            const c = payload && payload.candidate
            if (!c || !c.destIata) return
            let next = window.AesAfpLegSpec.setLegField(_spec, 0, "destination", c.destIata)
            if (typeof payload.depTime === "string" && /^\d{1,2}:\d{2}$/.test(payload.depTime)) {
                next = window.AesAfpLegSpec.setLegField(next, 0, "depTimeLocal", payload.depTime)
            }
            if (payload.source === "wave-leg" && c.__wave && c.__wave.origin) {
                next = window.AesAfpLegSpec.setLegField(next, 0, "origin", c.__wave.origin)
            }
            _updateSpec(next)
            _renderBody()
            _pushToAsForm("flightNumberText", _spec.flightNumberText || "")
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
