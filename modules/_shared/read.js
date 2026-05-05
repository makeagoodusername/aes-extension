"use strict"

/**
 * AesRead — unified read API for the airline's current state.
 *
 * Thin facade over `AesStrategy.snapshot()`. The strategy snapshot already
 * does the hard work of loading + normalizing fleet, routes, crew, cash,
 * alliance, competitor intel, settings into one envelope; AesRead exposes
 * scoped slices of it so an LLM tool-use turn (Slice 28) or the public
 * read-only API (Slice 30) can ask narrow questions without paying the cost
 * of re-loading every store on every call.
 *
 * Design:
 *   - One TTL-cached snapshot (default 5s). LLM tool-use sequences will
 *     typically call several reads in one turn — they should share data.
 *   - Every method is async and returns an envelope; never throws.
 *   - Filters are applied AFTER the snapshot loads (post-cache slice),
 *     so different filter args don't bypass the cache.
 *   - Returns plain JSON-friendly objects: no Maps, Sets, or class
 *     instances leak out. The snapshot has Sets in `alliance`; we coerce
 *     them to arrays here.
 *
 * Public API (window.AesRead):
 *   snapshot({server?, airlineCode?, includeStaleDemand?, force?})
 *     → {ok, data: Snapshot} | {ok:false, error}
 *
 *   routes({hub?, dest?, status?, watchlistedOnly?, limit?})
 *     → {ok, count, hubs: [{iata, routes: [...]}]} | {ok:false, error}
 *     - Filters hubs[].byRoute. Hub filter narrows to one hub IATA.
 *     - dest filter is exact-match.
 *     - status: 'scheduled'|'unscheduled'|'all' (default 'all').
 *     - watchlistedOnly: only routes with watchlisted:true.
 *
 *   hubs() → {ok, hubs: [{iata, routeCount, scheduledCount}]}
 *     - Cheap roll-up; doesn't include per-route detail.
 *
 *   fleet({status?, typeId?, equipment?, limit?})
 *     → {ok, count, fleet: [...]} | {ok:false, error}
 *
 *   crew() → {ok, crew: {bySkillLabel, byPosition, pressure, ...}}
 *
 *   cash() → {ok, cash: {bankBalance, weeklyResult, runwayWeeks}, sisters?}
 *
 *   competitors({hub?, eid?})
 *     → {ok, rivals: [...], byHub?: {...}}
 *
 *   alliance() → {ok, alliance: {...}}  // Sets coerced to arrays
 *
 *   settings({section?})
 *     → {ok, settings: {...}}
 *     - section: 'scoring'|'economics'|'ors'|'autoScheduler'|'serviceProfiles'
 *
 *   missing() → {ok, missing: [string]}
 *     - Which stores were unavailable on the last snapshot. Useful for an
 *       LLM to know "I can't see crew" before recommending a crew change.
 *
 *   refresh() → invalidates the cache; next call re-loads.
 *
 * **Self-registration with AesTools.** This module registers each public
 * method as an AesTools tool on a microtask delay, so AesTools.invoke()
 * exposes the read surface immediately on load. The bootstrap is
 * defensive — if AesTools didn't load, AesRead still works.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesRead) return

    const TTL_MS = 5 * 1000

    let _cache = null   // {key, snapshot, at}
    let _inflight = null // Promise<snapshot> while a load is in progress

    function _err(msg) { return {ok: false, error: String(msg || "unknown")} }

    function _cacheKey(opts) {
        // Different (server, airlineCode, includeStaleDemand) tuples are
        // different snapshots. Most callers pass nothing — undefined keys
        // all map to the same cache entry.
        return [opts.server || "_", opts.airlineCode || "_", !!opts.includeStaleDemand].join("|")
    }

    async function _loadSnapshot(opts) {
        const o = opts || {}
        if (!window.AesStrategy || typeof window.AesStrategy.snapshot !== "function") {
            throw new Error("AesStrategy.snapshot unavailable (not loaded on this page?)")
        }
        const key = _cacheKey(o)
        const fresh = _cache && _cache.key === key && (Date.now() - _cache.at) < TTL_MS && !o.force
        if (fresh) return _cache.snapshot
        if (_inflight) return _inflight
        _inflight = window.AesStrategy.snapshot(o).then(snap => {
            _cache = {key, snapshot: snap, at: Date.now()}
            _inflight = null
            return snap
        }).catch(e => {
            _inflight = null
            throw e
        })
        return _inflight
    }

    async function snapshot(opts) {
        try {
            const snap = await _loadSnapshot(opts || {})
            return {ok: true, data: _serialize(snap)}
        } catch (e) {
            return _err((e && e.message) || e)
        }
    }

    async function routes(opts) {
        const o = opts || {}
        try {
            const snap = await _loadSnapshot(o)
            const hubFilter   = o.hub ? String(o.hub).toUpperCase() : null
            const destFilter  = o.dest ? String(o.dest).toUpperCase() : null
            const statusFlt   = o.status === "scheduled" ? true
                                 : o.status === "unscheduled" ? false
                                 : null
            const wlOnly      = !!o.watchlistedOnly
            const limit       = Number.isFinite(o.limit) ? Math.max(1, o.limit) : null
            const out = []
            let total = 0
            for (const hub of (snap.hubs || [])) {
                if (hubFilter && hub.iata !== hubFilter) continue
                let list = hub.byRoute || []
                if (destFilter) list = list.filter(r => r.dest === destFilter)
                if (statusFlt !== null) list = list.filter(r => !!r.alreadyScheduled === statusFlt)
                if (wlOnly) list = list.filter(r => !!r.watchlisted)
                if (limit && list.length > limit) list = list.slice(0, limit)
                total += list.length
                out.push({iata: hub.iata, routes: list.map(_routeRow)})
            }
            return {ok: true, count: total, hubs: out}
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function hubs() {
        try {
            const snap = await _loadSnapshot({})
            return {
                ok: true,
                hubs: (snap.hubs || []).map(h => ({
                    iata:           h.iata,
                    routeCount:     (h.byRoute || []).length,
                    scheduledCount: (h.byRoute || []).filter(r => r.alreadyScheduled).length
                }))
            }
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function fleet(opts) {
        const o = opts || {}
        try {
            const snap = await _loadSnapshot({})
            let list = snap.fleet || []
            if (o.status)    list = list.filter(a => a.status === o.status)
            if (o.typeId)    list = list.filter(a => a.typeId === o.typeId)
            if (o.equipment) list = list.filter(a => a.equipment === o.equipment)
            const limit = Number.isFinite(o.limit) ? Math.max(1, o.limit) : null
            if (limit && list.length > limit) list = list.slice(0, limit)
            return {ok: true, count: list.length, fleet: list}
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function crew() {
        try {
            const snap = await _loadSnapshot({})
            return {ok: true, crew: snap.crew || null}
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function cash() {
        try {
            const snap = await _loadSnapshot({})
            return {ok: true, cash: snap.cash || null, sisters: snap.sisters || null}
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function competitors(opts) {
        const o = opts || {}
        try {
            const snap = await _loadSnapshot({})
            const rivals = snap.rivals || []
            if (o.eid) {
                const eid = String(o.eid)
                return {ok: true, rivals: rivals.filter(r => String(r.enterpriseId) === eid)}
            }
            if (o.hub) {
                const h = String(o.hub).toUpperCase()
                return {ok: true, rivals: rivals.filter(r => Array.isArray(r.hubs) && r.hubs.includes(h))}
            }
            return {ok: true, rivals}
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function alliance() {
        try {
            const snap = await _loadSnapshot({})
            const a = snap.alliance
            if (!a) return {ok: true, alliance: null}
            return {
                ok: true,
                alliance: {
                    membership:        a.membership || null,
                    partners:          a.partners || [],
                    partnerIds:        a.partnerIds        instanceof Set ? Array.from(a.partnerIds)        : (a.partnerIds || []),
                    allianceMemberIds: a.allianceMemberIds instanceof Set ? Array.from(a.allianceMemberIds) : (a.allianceMemberIds || []),
                    ourEnterpriseId:   a.ourEnterpriseId || null
                }
            }
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function settings(opts) {
        const o = opts || {}
        try {
            const snap = await _loadSnapshot({})
            const s = snap.settings || {}
            if (o.section) {
                if (!Object.prototype.hasOwnProperty.call(s, o.section)) {
                    return {ok: true, settings: null}
                }
                return {ok: true, settings: {[o.section]: s[o.section]}}
            }
            return {ok: true, settings: s}
        } catch (e) { return _err((e && e.message) || e) }
    }

    async function missing() {
        try {
            const snap = await _loadSnapshot({})
            return {ok: true, missing: snap.missing || []}
        } catch (e) { return _err((e && e.message) || e) }
    }

    /**
     * Recent strategy journal entries — narrative log of decisions, weight
     * changes, overrides, watchlist toggles. Newest first; sliced to `limit`.
     * Filterable by action kind. Useful for an LLM to ask "what's been
     * happening?" without parsing raw bus events.
     */
    async function journal(opts) {
        const o = opts || {}
        if (!window.AesStrategyJournal || typeof window.AesStrategyJournal.loadAll !== "function") {
            return {ok: false, error: "AesStrategyJournal.loadAll unavailable"}
        }
        try {
            const all = await window.AesStrategyJournal.loadAll(o.accountId)
            let entries = Array.isArray(all) ? all.slice() : []
            if (o.action) entries = entries.filter(e => e && e.action === o.action)
            const limit = Number.isFinite(o.limit) ? Math.max(1, o.limit) : 50
            if (entries.length > limit) entries = entries.slice(0, limit)
            return {ok: true, count: entries.length, entries}
        } catch (e) { return _err((e && e.message) || e) }
    }

    /**
     * Active strategy signals — the LLM's "what should I pay attention to?"
     * surface. Reads `signal:*` events from the bus history (last `windowMs`
     * ms, default 1h), deduplicates by signal kind keeping the most recent,
     * and returns the latest hint payload.
     *
     * Doesn't depend on AesStrategy.snapshot — bus history is independent
     * of the snapshot cache, so this works on pages where strategy/context
     * isn't loaded.
     */
    function signals(opts) {
        const o = opts || {}
        const windowMs = Number.isFinite(o.windowMs) ? o.windowMs : 60 * 60 * 1000
        if (!window.AesDataBus || typeof window.AesDataBus.history !== "function") {
            return {ok: false, error: "AesDataBus.history unavailable"}
        }
        const cutoff = Date.now() - windowMs
        const recent = window.AesDataBus.history({limit: 500}) || []
        const byKind = new Map()
        for (const ev of recent) {
            if (!ev || typeof ev.topic !== "string") continue
            if (ev.topic.indexOf("signal:") !== 0) continue
            if (Number(ev.at) < cutoff) continue
            const prev = byKind.get(ev.topic)
            if (!prev || ev.at > prev.at) byKind.set(ev.topic, ev)
        }
        const out = Array.from(byKind.values())
            .sort((a, b) => b.at - a.at)
            .map(ev => ({topic: ev.topic, at: ev.at, ageMs: Date.now() - ev.at, hint: ev.hint || null}))
        return {ok: true, count: out.length, windowMs, signals: out}
    }

    /**
     * Compact text digest of the airline's current state. Designed for
     * cheap LLM context priming — typically 200-500 tokens vs. tens of
     * thousands for the full snapshot. Includes airline ID, fleet count,
     * hub count, route counts, cash + runway, top 3 active signals,
     * crew-pressure summary, and the `missing` diagnostic. Returns text;
     * the JSON envelope wraps it for tool-use uniformity.
     */
    async function summary() {
        try {
            const snap = await _loadSnapshot({})
            const lines = []
            lines.push("Airline: " + (snap.airlineCode || "(unknown)") + " on server " + (snap.server || "(unknown)"))

            const fleetCount = (snap.fleet || []).length
            const fleetByType = {}
            for (const a of (snap.fleet || [])) {
                const k = a.equipment || a.typeId || "?"
                fleetByType[k] = (fleetByType[k] || 0) + 1
            }
            const fleetSummary = Object.entries(fleetByType)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([k, n]) => n + "× " + k)
                .join(", ")
            lines.push("Fleet: " + fleetCount + " aircraft" + (fleetSummary ? " (" + fleetSummary + ")" : ""))

            const hubsList = snap.hubs || []
            const totalRoutes = hubsList.reduce((s, h) => s + (h.byRoute || []).length, 0)
            const totalScheduled = hubsList.reduce((s, h) => s + (h.byRoute || []).filter(r => r.alreadyScheduled).length, 0)
            lines.push("Hubs: " + hubsList.length + " (" + hubsList.map(h => h.iata).join(", ")
                + "), routes: " + totalRoutes + " (" + totalScheduled + " scheduled)")

            if (snap.cash) {
                const c = snap.cash
                const wk = Number.isFinite(c.weeklyResult)
                    ? (c.weeklyResult >= 0 ? "+" : "") + Math.round(c.weeklyResult).toLocaleString()
                    : "?"
                const bank = Number.isFinite(c.bankBalance) ? Math.round(c.bankBalance).toLocaleString() : "?"
                const runway = Number.isFinite(c.runwayWeeks) ? c.runwayWeeks.toFixed(1) + "wk" : "?"
                lines.push("Cash: bank " + bank + ", weekly " + wk + ", runway " + runway)
            } else {
                lines.push("Cash: unavailable")
            }

            const sig = signals({windowMs: 60 * 60 * 1000})
            if (sig.ok && sig.count > 0) {
                lines.push("Active signals: " + sig.signals.slice(0, 3).map(s => {
                    const kind = s.topic.split(":").slice(2).join(":")
                    const ageMin = Math.round(s.ageMs / 60000)
                    return kind + " (" + ageMin + "m ago)"
                }).join("; "))
            } else {
                lines.push("Active signals: none in last hour")
            }

            if (snap.crew && snap.crew.pressure) {
                const p = snap.crew.pressure
                if (p.severity > 0) {
                    lines.push("Crew pressure: severity " + p.severity.toFixed(2)
                        + (p.shortPositions ? " (short: " + p.shortPositions.join(", ") + ")" : ""))
                }
            }

            if (snap.alliance && snap.alliance.membership) {
                lines.push("Alliance: " + snap.alliance.membership.name
                    + " (" + (snap.alliance.partners || []).length + " IL partners)")
            }

            const missingCount = (snap.missing || []).length
            if (missingCount > 0) {
                lines.push("Missing: " + missingCount + " stores not loaded ("
                    + snap.missing.slice(0, 4).join(", ")
                    + (missingCount > 4 ? ", …" : "") + ")")
            }

            return {ok: true, text: lines.join("\n"), at: snap.ts}
        } catch (e) { return _err((e && e.message) || e) }
    }

    function refresh() {
        _cache = null
        return {ok: true}
    }

    // ── Serialization helpers ──────────────────────────────────────────
    // The snapshot contains a few non-JSON values (Sets in `alliance`).
    // _serialize is shallow-aware: it only fixes the known-non-JSON
    // branches; everything else is passed through as a reference (no deep
    // clone — keeps it cheap, and consumers shouldn't mutate the result).
    function _serialize(snap) {
        if (!snap) return null
        const out = Object.assign({}, snap)
        if (snap.alliance) {
            out.alliance = Object.assign({}, snap.alliance, {
                partnerIds:        snap.alliance.partnerIds        instanceof Set ? Array.from(snap.alliance.partnerIds)        : snap.alliance.partnerIds,
                allianceMemberIds: snap.alliance.allianceMemberIds instanceof Set ? Array.from(snap.alliance.allianceMemberIds) : snap.alliance.allianceMemberIds
            })
        }
        return out
    }

    function _routeRow(r) {
        // Pass-through; the snapshot already returns plain objects for routes.
        return r
    }

    window.AesRead = {
        snapshot, routes, hubs, fleet, crew, cash,
        competitors, alliance, settings, missing, signals, journal, summary, refresh
    }

    // ─── AesTools registration ───────────────────────────────────────
    // Wraps each method as a tool descriptor. Deferred to a microtask so
    // AesTools (loaded just before us) has finished its own bootstrap.

    function _registerTools() {
        if (!window.AesTools || typeof window.AesTools.register !== "function") return

        const tag = ["read", "domain"]

        window.AesTools.register({
            name:        "read.snapshot",
            description: "Full airline state snapshot — fleet, hubs, routes, crew, cash, alliance, settings. Heavy; cached for 5s. For narrow queries prefer read.routes / read.fleet / read.crew etc.",
            params:      {server: "string?", airlineCode: "string?", includeStaleDemand: "boolean?", force: "boolean? bypass cache"},
            returns:     "{ok, data: Snapshot} | {ok:false, error}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         (a) => snapshot(a || {})
        })
        window.AesTools.register({
            name:        "read.routes",
            description: "Routes from each hub with demand, competitor, override, and pricing context. Filterable by hub, dest, status, or watchlist.",
            params:      {hub: "IATA?", dest: "IATA?", status: "'scheduled'|'unscheduled'|'all'?", watchlistedOnly: "boolean?", limit: "number?"},
            returns:     "{ok, count, hubs: [{iata, routes}]}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         (a) => routes(a || {})
        })
        window.AesTools.register({
            name:        "read.hubs",
            description: "List of hub IATAs with route + scheduled counts (cheap roll-up).",
            params:      null,
            returns:     "{ok, hubs: [{iata, routeCount, scheduledCount}]}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         () => hubs()
        })
        window.AesTools.register({
            name:        "read.fleet",
            description: "Aircraft roster with wear, profit, equipment, type. Filterable by status, typeId, equipment.",
            params:      {status: "string?", typeId: "string?", equipment: "string?", limit: "number?"},
            returns:     "{ok, count, fleet: [...]}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         (a) => fleet(a || {})
        })
        window.AesTools.register({
            name:        "read.crew",
            description: "Crew counts by skill label and by position, plus crew pressure summary.",
            params:      null,
            returns:     "{ok, crew}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         () => crew()
        })
        window.AesTools.register({
            name:        "read.cash",
            description: "Bank balance, weekly result, runway in weeks, plus sister-airline rollup.",
            params:      null,
            returns:     "{ok, cash, sisters}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         () => cash()
        })
        window.AesTools.register({
            name:        "read.competitors",
            description: "Rival airlines on shared routes. Filter by hub IATA or by eid.",
            params:      {hub: "IATA?", eid: "string?"},
            returns:     "{ok, rivals: [...]}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         (a) => competitors(a || {})
        })
        window.AesTools.register({
            name:        "read.alliance",
            description: "Alliance membership + partner relations. Sets are coerced to arrays for JSON safety.",
            params:      null,
            returns:     "{ok, alliance}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         () => alliance()
        })
        window.AesTools.register({
            name:        "read.settings",
            description: "Strategy settings (scoring, economics, ORS, autoScheduler, serviceProfiles). `section` narrows to one block.",
            params:      {section: "'scoring'|'economics'|'ors'|'autoScheduler'|'serviceProfiles'?"},
            returns:     "{ok, settings}",
            sideEffects: "read-cached",
            tags:        tag,
            run:         (a) => settings(a || {})
        })
        window.AesTools.register({
            name:        "read.missing",
            description: "Diagnostic list of stores unavailable on this page (e.g. AFP wear-model only loads on aircraft-detail). Use to know when state is partial before recommending a change.",
            params:      null,
            returns:     "{ok, missing: [string]}",
            sideEffects: "read",
            tags:        ["meta", "introspection"],
            run:         () => missing()
        })
        window.AesTools.register({
            name:        "read.signals",
            description: "Active strategy signals (cash-low / crew-pressure / competitor-threat / wear-pressure) emitted in the last `windowMs` ms (default 1h). Deduplicated by signal kind, latest first. The 'what should I pay attention to?' surface.",
            params:      {windowMs: "number? (default 3600000)"},
            returns:     "{ok, count, windowMs, signals: [{topic, at, ageMs, hint}]}",
            sideEffects: "read",
            tags:        ["read", "signals"],
            run:         (a) => signals(a || {})
        })
        window.AesTools.register({
            name:        "read.journal",
            description: "Recent strategy journal entries — narrative log of decisions, weight changes, overrides, watchlist toggles. Newest first. Filter by `action` (override-save | note-save | watchlist-toggle | apply-decision | weight-change).",
            params:      {action: "string?", limit: "number? (default 50)", accountId: "string?"},
            returns:     "{ok, count, entries: [...]}",
            sideEffects: "read",
            tags:        ["read", "journal"],
            run:         (a) => journal(a || {})
        })
        window.AesTools.register({
            name:        "read.summary",
            description: "Compact text digest of airline state — designed for cheap LLM context priming (200-500 tokens vs. tens of thousands for read.snapshot). Includes airline ID, fleet, hubs, routes, cash + runway, top signals, crew pressure, alliance, missing diagnostics.",
            params:      null,
            returns:     "{ok, text, at}",
            sideEffects: "read-cached",
            tags:        ["read", "digest"],
            run:         () => summary()
        })
        window.AesTools.register({
            name:        "read.refresh",
            description: "Invalidate the AesRead snapshot cache so the next read forces a fresh load. Returns immediately.",
            params:      null,
            returns:     "{ok}",
            sideEffects: "read",
            tags:        ["meta"],
            run:         () => refresh()
        })
    }

    queueMicrotask(_registerTools)
})()
