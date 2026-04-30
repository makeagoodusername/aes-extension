"use strict"

/**
 * Aircraft Flight Plan Assistant — Slice B (spec resolver).
 *
 * Resolves the on-page aircraft's type spec and renders a compact summary
 * card into AesAfp.slot("spec"). Subscribes to AesAfp.bus.on("ctx:ready")
 * to kick off; emits "spec:resolved" with {spec} (spec is null on
 * failure — emitted always so downstream slices can react to both
 * outcomes).
 *
 * Resolution ladder:
 *   1) typeId from RouteAssistantFleetStore (equipment string match)
 *   2) typeId from page-scan link a[href*="aircraftsType?id="]
 *   3) cache check via RouteAssistantTypeSpecsStore.get(typeId)
 *   4) fresh fetch via AESAircraftTypeSpecs.fetchById(typeId), saved back
 *      to the same store (mirrors panel.js:2134-2139 recipe so the cache
 *      stays warm across both /scheduling and /fleets pages)
 *   →  null when typeId can't be resolved or fetch fails — renders an
 *      "unavailable" message with a Retry button.
 *
 * Public API:
 *   AesAfpSpecResolver.resolveForCurrent({forceFetch?}) -> Promise<Spec|null>
 *   AesAfpSpecResolver.last                              -> Spec | null
 *   AesAfpSpecResolver.renderSummaryCard(host, spec)     -> void
 *
 * Spec shape:
 *   {typeId, typeName, seats, cargoCapacity, cruiseSpeedKmh, range,
 *    paxSatisfaction, source}
 *   source ∈ "cached" | "fleet-store" | "heuristic" | "as-fetched"
 *
 * Notes on naming: the underlying RouteAssistantTypeSpecsStore record uses
 * `speed` (km/h) as the field name — the resolver normalises that to
 * `cruiseSpeedKmh` on output to match the master-plan public API while
 * preserving compatibility with existing store consumers on the save path.
 */
;(function () {
    if (window.AesAfpSpecResolver) return

    /** In-flight de-dup: <equipment[:force]> -> Promise<Spec|null>. */
    const _pending = new Map()

    /**
     * Resolve typeId from fleet store first, page-scan link second.
     * Returns {typeId, viaPath: "fleet" | "page" | null}.
     */
    async function _resolveTypeId(ctx) {
        if (ctx && ctx.equipment && ctx.server
            && typeof RouteAssistantFleetStore !== "undefined") {
            try {
                const fleet = await RouteAssistantFleetStore.loadFleet(
                    ctx.server, ctx.airlineCode || null
                )
                const wanted = String(ctx.equipment).trim().toLowerCase()
                for (const slot of (fleet.byType || new Map()).values()) {
                    if (!slot || !slot.typeId) continue
                    if (String(slot.typeName || "").trim().toLowerCase() === wanted) {
                        return {typeId: slot.typeId, viaPath: "fleet"}
                    }
                }
            } catch (e) {
                console.warn("[AFP-B] fleet-store lookup failed", e)
            }
        }
        const link = document.querySelector('a[href*="aircraftsType?id="]')
        if (link) {
            const m = (link.getAttribute("href") || "").match(/aircraftsType\?id=(\d+)/)
            if (m) return {typeId: parseInt(m[1], 10), viaPath: "page"}
        }
        return {typeId: null, viaPath: null}
    }

    /** Build the public Spec from a store record + ctx + source tag. */
    function _buildSpec(record, ctx, source) {
        return {
            typeId:          record.typeId,
            typeName:        (ctx && ctx.equipment) || record.typeName || "",
            seats:           record.seats != null ? record.seats : null,
            cargoCapacity:   record.cargoCapacity != null ? record.cargoCapacity : null,
            cruiseSpeedKmh:  record.speed != null ? record.speed : null,
            range:           record.range != null ? record.range : null,
            paxSatisfaction: record.paxSatisfaction != null ? record.paxSatisfaction : null,
            source
        }
    }

    function _emit(spec) {
        if (window.AesAfp && AesAfp.bus) {
            try { AesAfp.bus.emit("spec:resolved", {spec}) }
            catch (e) { console.warn("[AFP-B] bus emit failed", e) }
        }
    }

    function _slot() {
        return (window.AesAfp && AesAfp.slot) ? AesAfp.slot("spec") : null
    }

    /** Inner ladder. Renders + emits + returns. Never throws. */
    async function _doResolve(ctx, opts) {
        const forceFetch = !!(opts && opts.forceFetch)

        if (!ctx || !ctx.equipment) {
            renderSummaryCard(_slot(), null)
            _emit(null)
            return null
        }

        const {typeId, viaPath} = await _resolveTypeId(ctx)
        AesAfpSpecResolver.lastTypeId = typeId || null
        if (!typeId) {
            renderSummaryCard(_slot(), null)
            _emit(null)
            return null
        }

        if (!forceFetch && typeof RouteAssistantTypeSpecsStore !== "undefined") {
            try {
                const cached = await RouteAssistantTypeSpecsStore.get(typeId)
                if (cached) {
                    const spec = _buildSpec(cached, ctx, "cached")
                    AesAfpSpecResolver.last = spec
                    renderSummaryCard(_slot(), spec)
                    _emit(spec)
                    return spec
                }
            } catch (e) {
                console.warn("[AFP-B] cache read failed", e)
            }
        }

        if (typeof AESAircraftTypeSpecs === "undefined") {
            console.warn("[AFP-B] AESAircraftTypeSpecs not loaded — manifest order?")
            renderSummaryCard(_slot(), null)
            _emit(null)
            return null
        }

        const fetched = await AESAircraftTypeSpecs.fetchById(typeId)
        if (!fetched) {
            renderSummaryCard(_slot(), null)
            _emit(null)
            return null
        }

        const record = Object.assign({typeId, typeName: ctx.equipment}, fetched)
        if (typeof RouteAssistantTypeSpecsStore !== "undefined") {
            try { await RouteAssistantTypeSpecsStore.save(record) }
            catch (e) { console.warn("[AFP-B] cache save failed", e) }
        }

        const source = (viaPath === "fleet") ? "fleet-store" : "as-fetched"
        const spec = _buildSpec(record, ctx, source)
        AesAfpSpecResolver.last = spec
        renderSummaryCard(_slot(), spec)
        _emit(spec)
        return spec
    }

    /**
     * Public entry. Returns the in-flight Promise if already resolving the
     * same equipment + force-mode; otherwise starts a new resolution. The
     * promise NEVER rejects — it resolves to null on failure.
     */
    function resolveForCurrent(opts) {
        const ctx = (window.AesAfp && AesAfp.ctx) ? AesAfp.ctx : null
        const equipment = (ctx && ctx.equipment) ? ctx.equipment : "(none)"
        const forceFetch = !!(opts && opts.forceFetch)
        const key = equipment + (forceFetch ? ":force" : "")

        if (_pending.has(key)) return _pending.get(key)

        // Show "Resolving spec…" only on the initial path. The Refresh
        // button has already swapped its own label to "Refreshing…", so
        // replacing the whole card here would lose that affordance.
        if (!forceFetch) _renderLoadingCard(_slot())

        const p = _doResolve(ctx, opts).catch(e => {
            console.warn("[AFP-B] resolve threw", e)
            renderSummaryCard(_slot(), null)
            _emit(null)
            return null
        }).finally(() => {
            _pending.delete(key)
        })
        _pending.set(key, p)
        return p
    }

    function _renderLoadingCard(host) {
        if (!host) return
        host.innerHTML = '<div data-aes-afp-spec-card="loading" '
            + 'style="font-size:12px;color:#9ca3af;padding:6px 0;">'
            + 'Resolving spec…</div>'
    }

    /** Public renderer. spec === null draws the unavailable state. */
    function renderSummaryCard(host, spec) {
        if (!host) return

        if (!spec) {
            const tid = AesAfpSpecResolver.lastTypeId
            const remediation = tid
                ? 'Type id <code>' + tid + '</code> couldn\'t be fetched. Open '
                  + '<a href="/app/aircraft/aircraftsType?id=' + tid
                  + '" target="_blank" rel="noopener">the type page</a> '
                  + 'once to warm the spec cache, then Retry.'
                : 'No type id resolved from fleet store or page link. Visit '
                  + '<a href="/app/fleets" target="_blank" rel="noopener">/app/fleets</a> '
                  + 'to populate fleet store, then Retry.'
            host.innerHTML = '<div data-aes-afp-spec-card="unavailable" '
                + 'style="font-size:12px;color:#fca5a5;padding:6px 0;">'
                + '<div>Spec unavailable.</div>'
                + '<div style="margin-top:3px;color:#cbd5e1;">' + remediation + '</div>'
                + '<button type="button" data-aes-afp-spec-retry '
                + 'style="margin-top:6px;font-size:11px;">Retry</button>'
                + '</div>'
            const btn = host.querySelector("[data-aes-afp-spec-retry]")
            if (btn) {
                btn.addEventListener("click", () => {
                    btn.disabled = true
                    btn.textContent = "Retrying…"
                    resolveForCurrent({forceFetch: true})
                })
            }
            return
        }

        const parts = []
        if (spec.seats != null)           parts.push(escapeHtml(String(spec.seats)) + " seats")
        if (spec.range != null)           parts.push(_fmtNum(spec.range) + " km")
        if (spec.cruiseSpeedKmh != null)  parts.push(_fmtNum(spec.cruiseSpeedKmh) + " km/h")
        if (spec.paxSatisfaction != null) parts.push(escapeHtml(String(spec.paxSatisfaction)) + "% pax sat")

        const reg = (window.AesAfp && AesAfp.ctx && AesAfp.ctx.registration)
            ? AesAfp.ctx.registration : ""
        const headline = escapeHtml(spec.typeName || "")
            + (reg ? ' · <span style="color:#9ca3af;">' + escapeHtml(reg) + "</span>" : "")
        const metrics = parts.length
            ? parts.join(" · ")
            : '<span style="color:#9ca3af;">no metrics resolved</span>'

        host.innerHTML = ''
            + '<div data-aes-afp-spec-card="resolved" data-source="' + escapeHtml(spec.source) + '" '
            + 'style="font-size:12px;padding:6px 0;">'
            + '<div style="font-weight:600;">' + headline + '</div>'
            + '<div style="margin-top:2px;">' + metrics + '</div>'
            + '<button type="button" data-aes-afp-spec-refresh '
            + 'style="margin-top:6px;font-size:11px;">Refresh spec</button>'
            + '</div>'

        const btn = host.querySelector("[data-aes-afp-spec-refresh]")
        if (btn) {
            btn.addEventListener("click", () => {
                btn.disabled = true
                btn.textContent = "Refreshing…"
                resolveForCurrent({forceFetch: true})
            })
        }
    }

    function _fmtNum(n) {
        try { return escapeHtml(new Intl.NumberFormat().format(n)) }
        catch (_) { return escapeHtml(String(n)) }
    }

    const AesAfpSpecResolver = {
        resolveForCurrent,
        last: null,
        lastTypeId: null,
        renderSummaryCard
    }

    window.AesAfpSpecResolver = AesAfpSpecResolver

    // Bus wiring — poll-retry attach so spec-resolver isn't dead-wired when
    // it parses ahead of host.js. The /app/fleets/aircraft/*/0* page loads
    // spec-resolver.js (manifest block A) BEFORE host.js (manifest block B
    // matching /app/fleets*); without the retry, the IIFE-bottom guard
    // `if (window.AesAfp && window.AesAfp.bus)` was false at parse time and
    // the listener never subscribed — leaving `AesAfpSpecResolver.last`
    // stuck at null and route-candidates frozen on "Waiting for aircraft
    // spec…" forever. Mirrors the route-candidates.js:1337 _attach pattern.
    function _attach() {
        if (!window.AesAfp || !window.AesAfp.bus
                || typeof window.AesAfp.bus.on !== "function") {
            setTimeout(_attach, 50)
            return
        }
        window.AesAfp.bus.on("ctx:ready", () => {
            resolveForCurrent().catch(e => console.warn("[AFP-B] resolve failed", e))
        })
        // Race-safe one-shot: ctx may already be populated when we attach
        // (host.js's mount() ran during the retry interval and emitted
        // ctx:ready before this listener subscribed). Kick off resolution
        // ourselves so we don't wait for the next Wicket re-mount.
        if (window.AesAfp.ctx) {
            resolveForCurrent().catch(e => console.warn("[AFP-B] resolve failed", e))
        }
    }
    _attach()
})()
