"use strict"

/**
 * Dashboard-safe route price automator.
 *
 * The Route Assistant panel owns the rich in-page silent-auto loop on
 * /app/com/scheduling/<HUB>. This module gives other AS pages, especially
 * the enterprise dashboard / Central Hub, the same cached-data path:
 * topRoutes + markets caches -> silent-auto proposer -> pricing applier.
 *
 * It deliberately reuses RouteAssistantPricingApplier and the same
 * settings gates. A dashboard tick cannot write unless the existing
 * Route Assistant switches allow silent-auto live writes:
 *   pricing.apply.enabled === true
 *   pricing.apply.dryRunOnly === false
 *   pricing.apply.liveScopes.silentAuto !== false
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesRoutePriceAutomator) return

    const TOP_ROUTES_KEY = "routeAssistant:topRoutes"
    const TOP_ROUTES_PREFIX = TOP_ROUTES_KEY + ":"
    const OWN_PREFIX = "routeAssistant:markets:ownPricing"
    const COMP_PREFIX = "routeAssistant:markets:competitors"
    const HIST_PREFIX = "routeAssistant:markets:historic"
    const SCHEDULE_PREFIX = "routeAssistant:ticketPrice"
    const OVERRIDE_PREFIX = "routeAssistant:override"
    const MIN_SILENT_AUTO_TICK_MIN = 1 / 12

    let _tickIfDueInFlight = false
    let _foregroundTickTimer = null

    function _u(v) { return String(v || "").toUpperCase() }
    function _pairKey(hub, dest) { return _u(hub) + "-" + _u(dest) }
    function _now() { return Date.now() }
    function _num(v, fallback) {
        if (v === null || v === undefined || v === "") return fallback
        const n = Number(v)
        return isFinite(n) ? n : fallback
    }
    function _firstNum() {
        for (let i = 0; i < arguments.length; i++) {
            if (arguments[i] === null || arguments[i] === undefined || arguments[i] === "") continue
            const n = Number(arguments[i])
            if (isFinite(n)) return n
        }
        return null
    }
    function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
    function _silentAutoTickMin(value, fallback) {
        const n = Number(value)
        if (!isFinite(n)) return fallback != null ? fallback : MIN_SILENT_AUTO_TICK_MIN
        return _clamp(n, MIN_SILENT_AUTO_TICK_MIN, 240)
    }
    function _silentAutoTickMs(value, fallback) {
        return Math.max(5000, Math.round(_silentAutoTickMin(value, fallback) * 60000))
    }
    function _silentAutoTickLabel(value) {
        const ms = _silentAutoTickMs(value)
        return ms < 60000
            ? Math.round(ms / 1000) + " sec"
            : Math.round(ms / 60000) + " min"
    }
    function _silentAutoTickMsFromPricing(pricing) {
        const p = pricing || {}
        const sec = _firstNum(p.silentAutoTickSec, p.silentAutoTickSeconds)
        if (sec != null && sec > 0) return _clamp(sec, 5, 240 * 60) * 1000
        return _silentAutoTickMs(p.silentAutoTickMin)
    }
    function _silentAutoTickLabelFromPricing(pricing) {
        const ms = _silentAutoTickMsFromPricing(pricing)
        return ms < 60000
            ? Math.round(ms / 1000) + " sec"
            : Math.round(ms / 60000) + " min"
    }
    function _pricingPlumbing() {
        return typeof window !== "undefined" && window.RouteAssistantPricingPlumbing
            ? window.RouteAssistantPricingPlumbing : null
    }
    function _resolveApplyGate(apply, scopeName, opts) {
        const plumbing = _pricingPlumbing()
        if (plumbing && typeof plumbing.resolveApplyGate === "function") {
            return plumbing.resolveApplyGate(apply, scopeName, opts)
        }
        const src = apply && typeof apply === "object" ? apply : {}
        const enabled = src.enabled !== false
        const dryRunOnly = src.permanentLiveMode === true ? false : src.dryRunOnly === true
        const liveScopes = Object.assign(
            {manual: true, bulk: true, silentAuto: true, bulkRecommended: true},
            src.liveScopes && typeof src.liveScopes === "object" ? src.liveScopes : {}
        )
        if (src.permanentLiveMode === true) {
            liveScopes.manual = true
            liveScopes.bulk = true
            liveScopes.silentAuto = true
            liveScopes.bulkRecommended = true
        }
        const scopeLiveAllowed = scopeName ? liveScopes[scopeName] !== false : true
        const forcedDryRun = !!(opts && opts.forceDryRun)
        const dryRun = forcedDryRun || dryRunOnly || !enabled || !scopeLiveAllowed
        return {
            applyEnabled: enabled,
            dryRunOnly,
            scopeName: scopeName || null,
            scopeLiveAllowed,
            forcedDryRun,
            dryRun,
            liveWrites: !dryRun,
            reason: forcedDryRun ? "forced-dry-run"
                : dryRunOnly ? "dry-run-only"
                : !enabled ? "apply-disabled"
                : !scopeLiveAllowed ? "scope-disabled:" + scopeName
                : "live"
        }
    }
    function _formatPriceForClass(cls, value) {
        const plumbing = _pricingPlumbing()
        if (plumbing && typeof plumbing.formatPriceForClass === "function") {
            return plumbing.formatPriceForClass(cls, value)
        }
        const n = Number(value)
        if (!isFinite(n)) return ""
        return cls === "Cargo"
            ? (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "")
            : String(Math.round(n))
    }
    function _summarizePriceMove(prevPrices, nextPrices) {
        const plumbing = _pricingPlumbing()
        if (plumbing && typeof plumbing.summarizePriceMove === "function") {
            return plumbing.summarizePriceMove(prevPrices, nextPrices)
        }
        const prev = prevPrices || {}
        const next = nextPrices || {}
        const parts = []
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            if (next[cls] == null) continue
            if (prev[cls] == null) {
                parts.push(cls + " → " + _formatPriceForClass(cls, next[cls]))
                continue
            }
            const p = Number(prev[cls])
            const n = Number(next[cls])
            const same = cls === "Cargo" ? Math.abs(n - p) < 0.005 : Math.round(n) === Math.round(p)
            if (same) continue
            const pct = p > 0 ? ((n - p) / p) * 100 : null
            parts.push(cls + " " + _formatPriceForClass(cls, p) + "→" + _formatPriceForClass(cls, n)
                + (pct != null ? " (" + (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%)" : ""))
        }
        return parts.length ? parts.join(" · ") : "no-op"
    }
    function _classNumberMap() {
        const out = {}
        for (let i = 0; i < arguments.length; i++) {
            const src = arguments[i]
            if (!src || typeof src !== "object") continue
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                if (out[cls] != null) continue
                if (src[cls] === null || src[cls] === undefined || src[cls] === "") continue
                const n = Number(src[cls])
                if (isFinite(n)) out[cls] = n
            }
        }
        return out
    }
    function _classEnabledMap(src) {
        const out = {Y: true, C: true, F: true, Cargo: true}
        if (!src || typeof src !== "object") return out
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            if (typeof src[cls] === "boolean") out[cls] = src[cls]
        }
        return out
    }

    function _hostFromPage(fallback) {
        const out = Object.assign({}, fallback || {})
        if (!out.server) {
            try { out.server = AES.getServerName() } catch (_) { /* noop */ }
        }
        if (!out.airline) {
            try {
                const code = AES.getAirlineCode && AES.getAirlineCode()
                out.airline = (code && code.code) || ""
            } catch (_) { /* noop */ }
        }
        if (!out.airline) {
            try { out.airline = AES.getAirlineIdentity && AES.getAirlineIdentity() || "" } catch (_) { /* noop */ }
        }
        return out
    }

    async function _loadSettings() {
        if (typeof RouteAssistantSettings !== "undefined"
                && typeof RouteAssistantSettings.load === "function") {
            return await RouteAssistantSettings.load()
        }
        return {pricing: {}}
    }

    function configFromSettings(settings) {
        const p = settings && settings.pricing || {}
        const apply = p.apply || {}
        const tickMs = _silentAutoTickMsFromPricing(p)
        return {
            silentAutoEnabled:      !!p.silentAutoEnabled,
            silentAutoTickMin:       tickMs / 60000,
            silentAutoTickSec:       tickMs / 1000,
            silentAutoTickMs:        tickMs,
            silentAutoTickLabel:     _silentAutoTickLabelFromPricing(p),
            silentAutoMaxPerDay:     isFinite(p.silentAutoMaxPerDay)   ? p.silentAutoMaxPerDay   : 0,
            silentAutoMaxPerHour:    isFinite(p.silentAutoMaxPerHour)  ? p.silentAutoMaxPerHour  : 0,
            silentAutoMinDeltaPct:   isFinite(p.silentAutoMinDeltaPct) ? p.silentAutoMinDeltaPct : 3,
            silentAutoMaxStepPct:    isFinite(p.silentAutoMaxStepPct)  ? p.silentAutoMaxStepPct  : 10,
            silentAutoStrategy:      p.silentAutoStrategy || "per-class-elasticity",
            silentAutoFollowMode:    p.silentAutoFollowMode || "all",
            silentAutoLastTickAt:    isFinite(p.silentAutoLastTickAt) ? p.silentAutoLastTickAt : null,
            silentAutoLastTickResult: p.silentAutoLastTickResult || null,
            silentAutoMutedUntil:    isFinite(p.silentAutoMutedUntil) ? p.silentAutoMutedUntil : null,
            silentAutoCompetitorMinCount: isFinite(apply.silentAutoCompetitorMinCount)
                ? apply.silentAutoCompetitorMinCount : 2,
            silentAutoOrsMaxAgeMin: isFinite(apply.silentAutoOrsMaxAgeMin)
                ? apply.silentAutoOrsMaxAgeMin : 60,
            silentAutoStrategySnapshotMaxAgeMin: isFinite(apply.silentAutoStrategySnapshotMaxAgeMin)
                ? apply.silentAutoStrategySnapshotMaxAgeMin : 10,
            silentAutoControlVariablesEnabled: apply.silentAutoControlVariablesEnabled !== false,
            silentAutoPerClassEnabled: _classEnabledMap(p.silentAutoPerClassEnabled),
            silentAutoPerClassMaxStepPct: _classNumberMap(p.silentAutoPerClassMaxStepPct),
            silentAutoPerClassMinDemandPool: _classNumberMap(p.silentAutoPerClassMinDemandPool),
            silentAutoIncludeCargo:   p.silentAutoIncludeCargo !== false,
            // ORS playstyle controls live under settings.ors; the per-class
            // proposer uses this to damp ORS/elasticity pressure on monopoly
            // lanes and raise service/ORS pressure on contested lanes.
            orsCompetition: settings && settings.ors || null,
            // Per-class apply gates from `pricing.apply.classes.<cls>`.
            // Threaded through so the per-class proposer can defense-in-depth
            // skip a cabin disabled at the apply layer — otherwise the
            // proposer would emit a move that the applier silently filters,
            // making the skip invisible to the user.
            applyClassGates: (apply && apply.classes && typeof apply.classes === "object")
                ? apply.classes : null
        }
    }

    function describeSettings(settings, opts) {
        const pricing = settings && settings.pricing || {}
        const apply = pricing.apply || {}
        const gate = _resolveApplyGate(apply, "silentAuto", opts)
        const tickMs = _silentAutoTickMsFromPricing(pricing)
        return {
            silentAutoEnabled: !!pricing.silentAutoEnabled,
            dryRun: gate.dryRun,
            liveWrites: gate.liveWrites,
            applyEnabled: gate.applyEnabled,
            dryRunOnly: gate.dryRunOnly,
            silentLiveAllowed: gate.scopeLiveAllowed,
            applyGate: gate,
            strategy: pricing.silentAutoStrategy || "per-class-elasticity",
            followMode: opts && opts.followMode
                ? (opts.followMode === "all" ? "all" : "watchlist")
                : (pricing.silentAutoFollowMode || "all"),
            tickMin: tickMs / 60000,
            tickSec: tickMs / 1000,
            tickMs,
            tickLabel: _silentAutoTickLabelFromPricing(pricing),
            mutedUntil: isFinite(pricing.silentAutoMutedUntil) ? pricing.silentAutoMutedUntil : null
        }
    }

    async function setSilentAutoEnabled(enabled) {
        const settings = await _loadSettings()
        settings.pricing = settings.pricing || {}
        settings.pricing.silentAutoEnabled = !!enabled
        if (enabled && !settings.pricing.silentAutoConfirmedAt) {
            settings.pricing.silentAutoConfirmedAt = _now()
        }
        if (typeof RouteAssistantSettings !== "undefined"
                && typeof RouteAssistantSettings.save === "function") {
            return await RouteAssistantSettings.save({pricing: settings.pricing})
        }
        return settings
    }

    async function configureAutomaticLiveMode(opts) {
        const o = opts || {}
        const settings = await _loadSettings()
        settings.pricing = settings.pricing || {}
        const pricing = settings.pricing
        const apply = Object.assign({}, pricing.apply || {})
        const liveScopes = Object.assign({}, apply.liveScopes || {})
        const defaultScope = Object.assign(
            {},
            (window.RouteAssistantPricingApplier && window.RouteAssistantPricingApplier.DEFAULT_SCOPE) || {
                airportPair: true,
                flightNumbers: true,
                returnAirportPair: false,
                returnFlightNumbers: false
            },
            apply.defaultScope || {}
        )
        defaultScope.airportPair = true
        defaultScope.flightNumbers = true

        liveScopes.manual = true
        liveScopes.bulk = true
        liveScopes.silentAuto = true
        liveScopes.bulkRecommended = true
        apply.permanentLiveMode = true
        apply.enabled = true
        apply.dryRunOnly = false
        apply.liveScopes = liveScopes
        apply.defaultScope = defaultScope
        if (o.endpointMode === "flightNumbers" || o.endpointMode === "markets") {
            apply.endpointMode = o.endpointMode
        }
        if (o.cooldowns === false) {
            apply.cooldownMinPerRoute = 0
            apply.cooldownMinGlobal = 0
        }

        pricing.apply = apply
        pricing.silentAutoEnabled = true
        pricing.silentAutoConfirmedAt = _now()
        pricing.silentAutoFollowMode = o.followMode === "watchlist" ? "watchlist" : "all"
        pricing.silentAutoStrategy = o.strategy || pricing.silentAutoStrategy || "per-class-elasticity"
        if (isFinite(o.maxPerDay)) pricing.silentAutoMaxPerDay = Math.max(0, Number(o.maxPerDay))
        if (isFinite(o.maxPerHour)) pricing.silentAutoMaxPerHour = Math.max(0, Number(o.maxPerHour))
        if (!isFinite(o.tickMin) && !isFinite(o.tickSec) && !isFinite(o.tickSeconds)) {
            pricing.silentAutoTickSec = 5
            pricing.silentAutoTickMin = 5 / 60
        }
        if (isFinite(o.tickMin)) {
            pricing.silentAutoTickMin = _silentAutoTickMin(o.tickMin, pricing.silentAutoTickMin)
            pricing.silentAutoTickSec = pricing.silentAutoTickMin * 60
        }
        if (isFinite(o.tickSec) || isFinite(o.tickSeconds)) {
            const sec = isFinite(o.tickSec) ? Number(o.tickSec) : Number(o.tickSeconds)
            pricing.silentAutoTickSec = _clamp(sec, 5, 240 * 60)
            pricing.silentAutoTickMin = pricing.silentAutoTickSec / 60
        }
        if (isFinite(o.minDeltaPct)) pricing.silentAutoMinDeltaPct = Math.max(0, Number(o.minDeltaPct))
        if (isFinite(o.maxStepPct)) pricing.silentAutoMaxStepPct = Math.max(0, Number(o.maxStepPct))
        pricing.silentAutoMutedUntil = null

        if (typeof RouteAssistantSettings !== "undefined"
                && typeof RouteAssistantSettings.save === "function") {
            return await RouteAssistantSettings.save({pricing})
        }
        return settings
    }

    async function _loadTopRoutes(host, opts) {
        const limit = Math.max(1, Math.min(500, Number(opts && opts.limit) || 150))
        const got = await chrome.storage.local.get(null)
        const rows = []
        const seen = new Set()
        const addRow = (hub, dest, row, scrapedAt, source) => {
            hub = _u(hub)
            dest = _u(dest)
            if (!hub || !dest) return
            const pair = _pairKey(hub, dest)
            if (seen.has(pair)) return
            seen.add(pair)
            rows.push({
                hub,
                dest,
                pair,
                row: row || {destIata: dest},
                topRoutesScrapedAt: scrapedAt || 0,
                source: source || "topRoutes"
            })
        }
        const candidates = []
        const exactRec = got[TOP_ROUTES_KEY]
        if (exactRec && Array.isArray(exactRec.rows) && _topRoutesRecordMatches(exactRec, host)) {
            candidates.push({
                key: TOP_ROUTES_KEY,
                rec: exactRec,
                scoped: false,
                exact: true,
                hub: _u(exactRec.hub),
                scrapedAt: exactRec.scrapedAt || exactRec.snapshotAt || 0
            })
        }
        for (const key in got) {
            if (key.indexOf(TOP_ROUTES_PREFIX) !== 0) continue
            const keyInfo = _topRoutesKeyInfo(key)
            if (!keyInfo) continue
            const rec = got[key]
            if (!rec || !Array.isArray(rec.rows)) continue
            if (!_topRoutesRecordMatches(rec, host)) continue
            candidates.push({
                key,
                rec,
                scoped: keyInfo.scoped,
                exact: false,
                hub: _u(rec.hub || keyInfo.hub),
                scrapedAt: rec.scrapedAt || rec.snapshotAt || 0
            })
        }
        candidates.sort((a, b) => {
            const ap = a.scoped ? 0 : (a.exact ? 2 : 1)
            const bp = b.scoped ? 0 : (b.exact ? 2 : 1)
            if (ap !== bp) return ap - bp
            return (b.scrapedAt || 0) - (a.scrapedAt || 0)
        })
        for (const c of candidates) {
            const rec = c.rec
            for (const r of rec.rows) {
                const hub = _u(c.hub || r && (r.hub || r.originIata || r.origin))
                const dest = _u(r && (r.destIata || r.dest))
                addRow(hub, dest, r, c.scrapedAt, c.scoped ? "topRoutes:acct" : "topRoutes")
            }
        }
        _addMarketCacheRoutes(got, rows, seen, host)
        _addScheduleCacheRoutes(got, rows, seen, host)
        rows.sort((a, b) => {
            const ap = a.source === "topRoutes" ? 0
                : a.source === "market-cache:ownPricing" ? 1
                : a.source === "market-cache:competitors" ? 2 : 3
            const bp = b.source === "topRoutes" ? 0
                : b.source === "market-cache:ownPricing" ? 1
                : b.source === "market-cache:competitors" ? 2 : 3
            if (ap !== bp) return ap - bp
            return (b.topRoutesScrapedAt || 0) - (a.topRoutesScrapedAt || 0)
        })
        return rows.slice(0, limit)
    }

    function _topRoutesKeyInfo(key) {
        const suffix = String(key || "").substring(TOP_ROUTES_PREFIX.length)
        if (!suffix) return null
        if (suffix.indexOf("acct:") === 0) {
            const parts = suffix.split(":")
            const acctId = window.__aesAccountId || null
            if (parts.length < 3 || !acctId || parts[1] !== acctId) return null
            return {hub: _u(parts.slice(2).join(":")), scoped: true}
        }
        if (suffix.indexOf(":") >= 0) return null
        return {hub: _u(suffix), scoped: false}
    }

    function _topRoutesRecordMatches(rec, host) {
        if (host && host.server && rec && rec.server && rec.server !== host.server) return false
        if (rec && rec.accountId) {
            const acctId = window.__aesAccountId || null
            if (!acctId || rec.accountId !== acctId) return false
        }
        return true
    }

    function _addMarketCacheRoutes(all, rows, seen, host) {
        const byPair = new Map()
        for (const key in all) {
            const isOwn = key.indexOf(OWN_PREFIX + ":") === 0
            const isCompetitor = key.indexOf(COMP_PREFIX + ":") === 0
            if (!isOwn && !isCompetitor) continue
            if (!_keyMatchesCurrentAccount(key)) continue
            const rec = all[key]
            const pairInfo = _routeFromMarketRecord(key, rec)
            if (!pairInfo) continue
            if (host && host.server && rec && rec.server && rec.server !== host.server) continue
            const pair = _pairKey(pairInfo.hub, pairInfo.dest)
            if (seen.has(pair)) continue
            const prev = byPair.get(pair) || {
                hub: pairInfo.hub,
                dest: pairInfo.dest,
                pair,
                hasOwnPricing: false,
                hasCompetitors: false,
                scrapedAt: 0,
                rec: null
            }
            if (isOwn) prev.hasOwnPricing = true
            if (isCompetitor) prev.hasCompetitors = true
            const scrapedAt = rec && rec.scrapedAt || 0
            if (scrapedAt >= (prev.scrapedAt || 0)) {
                prev.scrapedAt = scrapedAt
                prev.rec = rec
            }
            byPair.set(pair, prev)
        }
        const marketRows = Array.from(byPair.values()).sort((a, b) => {
            if (a.hasOwnPricing !== b.hasOwnPricing) return a.hasOwnPricing ? -1 : 1
            if (a.hasCompetitors !== b.hasCompetitors) return a.hasCompetitors ? -1 : 1
            return (b.scrapedAt || 0) - (a.scrapedAt || 0)
        })
        for (const r of marketRows) {
            const pair = r.pair
            if (seen.has(pair)) continue
            const rec = r.rec
            seen.add(pair)
            rows.push({
                hub: r.hub,
                dest: r.dest,
                pair,
                row: {
                    destIata: r.dest,
                    destName: rec && (rec.destName || rec.destinationName) || null,
                    status: "market-cache"
                },
                topRoutesScrapedAt: r.scrapedAt || 0,
                source: r.hasOwnPricing ? "market-cache:ownPricing" : "market-cache:competitors"
            })
        }
    }

    function _addScheduleCacheRoutes(all, rows, seen, host) {
        const found = []
        for (const key in all) {
            if (key.indexOf(SCHEDULE_PREFIX + ":") !== 0) continue
            if (!_keyMatchesCurrentAccount(key)) continue
            const rec = all[key]
            if (!_recordMatchesHost(rec, host)) continue
            const pairInfo = _routeFromScheduleRecord(key, rec)
            if (!pairInfo) continue
            const pair = _pairKey(pairInfo.hub, pairInfo.dest)
            if (seen.has(pair)) continue
            found.push({
                hub: pairInfo.hub,
                dest: pairInfo.dest,
                pair,
                scrapedAt: rec && rec.scrapedAt || 0,
                rec
            })
        }
        found.sort((a, b) => (b.scrapedAt || 0) - (a.scrapedAt || 0))
        for (const r of found) {
            if (seen.has(r.pair)) continue
            seen.add(r.pair)
            rows.push({
                hub: r.hub,
                dest: r.dest,
                pair: r.pair,
                row: {
                    destIata: r.dest,
                    destName: r.rec && (r.rec.destName || r.rec.destinationName) || null,
                    weeklyFlights: r.rec && r.rec.weeklyFlights || null,
                    status: "schedule-cache"
                },
                topRoutesScrapedAt: r.scrapedAt || 0,
                source: "schedule-cache"
            })
        }
    }

    function _keyAccountId(key) {
        const m = /:acct:([^:]+):/.exec(String(key || ""))
        return m ? m[1] : null
    }

    function _keyMatchesCurrentAccount(key) {
        const keyAcct = _keyAccountId(key)
        if (!keyAcct) return true
        const acctId = window.__aesAccountId || null
        return !!acctId && keyAcct === acctId
    }

    function _routeFromMarketRecord(key, rec) {
        const hub = _u(rec && rec.hub)
        const dest = _u(rec && (rec.dest || rec.destIata))
        if (hub && dest) return {hub, dest}
        const tail = String(key || "").split(":").pop() || ""
        const m = /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})$/i.exec(tail)
        if (!m) return null
        return {hub: _u(m[1]), dest: _u(m[2])}
    }

    function _routeFromScheduleRecord(key, rec) {
        const hub = _u(rec && rec.hub)
        const dest = _u(rec && (rec.dest || rec.destIata))
        if (hub && dest) return {hub, dest}
        const tail = String(key || "").split(":").pop() || ""
        const m = /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})$/i.exec(tail)
        if (!m) return null
        return {hub: _u(m[1]), dest: _u(m[2])}
    }

    async function _loadWatchlist() {
        if (typeof RouteAssistantWatchlistStore !== "undefined"
                && typeof RouteAssistantWatchlistStore.loadKeys === "function") {
            try { return await RouteAssistantWatchlistStore.loadKeys() } catch (_) { /* fallback */ }
        }
        return new Set()
    }

    async function _loadPricePins(rows) {
        const out = new Map()
        if (!rows || !rows.length) return out
        let all = {}
        try { all = await chrome.storage.local.get(null) || {} }
        catch (_) { return out }
        const seen = new Set()
        for (const r of rows) {
            const pair = r && r.pair || _pairKey(r && r.hub, r && r.dest)
            if (!pair || seen.has(pair)) continue
            seen.add(pair)
            const rec = _readOverrideFallback(all, pair)
            const pin = _activePricePin(rec)
            if (pin != null) out.set(pair, pin)
        }
        return out
    }

    function _readOverrideFallback(all, pair) {
        if (!all || !pair) return null
        const acctId = window.__aesAccountId || null
        const scoped = acctId ? OVERRIDE_PREFIX + ":acct:" + acctId + ":" + pair : null
        const legacy = OVERRIDE_PREFIX + ":" + pair
        if (scoped && all[scoped]) return all[scoped]
        if (all[legacy]) return all[legacy]
        if (!acctId) return null
        const suffix = ":" + pair
        const scopedPrefix = OVERRIDE_PREFIX + ":acct:" + acctId + ":"
        for (const k in all) {
            if (k.indexOf(scopedPrefix) === 0 && k.endsWith(suffix)) return all[k]
        }
        return null
    }

    function _activePricePin(rec) {
        if (!rec || rec.pricePin == null) return null
        const exp = Number(rec.expiresAt)
        if (isFinite(exp) && exp > 0 && exp <= Date.now()) return null
        const pin = Number(rec.pricePin)
        return isFinite(pin) ? pin : null
    }

    function _sourcePageFromLocation() {
        try {
            const path = String(location && location.pathname || "")
            if (/\/app\/enterprise\/dashboard(?:\/|$)/.test(path)) return "dashboard"
            if (/\/app\/com\/scheduling(?:\/|$)/.test(path)) return "scheduling"
            if (/\/app\/com\/markets(?:\/|$)/.test(path)) return "markets"
            if (/\/app\/fleets(?:\/|$)/.test(path)) return "fleets"
        } catch (_) { /* noop */ }
        return "cached-route"
    }

    function _recordMatchesHost(rec, host) {
        return !host || !host.server || !rec || !rec.server || rec.server === host.server
    }

    async function _loadMarkets(rows, host, settings) {
        if (!rows.length) return new Map()
        let out = new Map()
        const ddCfg = settings && settings.demandDepth || {}
        if (typeof RouteAssistantMarketsPageScraper !== "undefined"
                && typeof RouteAssistantMarketsPageScraper.bulkLoadCache === "function") {
            out = await RouteAssistantMarketsPageScraper.bulkLoadCache(
                    rows.map(r => ({hub: r.hub, dest: r.dest})),
                    {
                        families: ["ownPricing", "competitors", "historic"],
                        maxAge: {historic: ddCfg.historicMaxAgeDays}
                    }
                ) || new Map()
        }
        const all = await chrome.storage.local.get(null)
        for (const r of rows) {
            const bucket = out.get(r.pair) || {}
            if (bucket.ownPricing && !_recordMatchesHost(bucket.ownPricing, host)) delete bucket.ownPricing
            if (bucket.competitors && !_recordMatchesHost(bucket.competitors, host)) delete bucket.competitors
            if (bucket.historic && !_recordMatchesHost(bucket.historic, host)) delete bucket.historic
            if (!bucket.ownPricing) {
                const own = _readFamilyFallback(all, OWN_PREFIX, r.pair, host)
                if (own) bucket.ownPricing = own
            }
            if (!bucket.competitors) {
                const comp = _readFamilyFallback(all, COMP_PREFIX, r.pair, host)
                if (comp) bucket.competitors = comp
            }
            if (!bucket.historic) {
                const hist = _readFamilyFallback(all, HIST_PREFIX, r.pair, host)
                if (hist) bucket.historic = hist
            }
            if (bucket.ownPricing || bucket.competitors || bucket.historic) out.set(r.pair, bucket)
            else out.delete(r.pair)
        }
        return out
    }

    function _readFamilyFallback(all, prefix, pair, host) {
        const acctId = window.__aesAccountId || null
        const preferred = acctId ? prefix + ":acct:" + acctId + ":" + pair : prefix + ":" + pair
        if (all[preferred] && _recordMatchesHost(all[preferred], host)) return all[preferred]
        const legacy = prefix + ":" + pair
        if (all[legacy] && _recordMatchesHost(all[legacy], host)) return all[legacy]
        const suffix = ":" + pair
        const scopedPrefix = acctId ? prefix + ":acct:" + acctId + ":" : null
        let best = null
        for (const k in all) {
            if (k.indexOf(prefix + ":") !== 0 || !k.endsWith(suffix)) continue
            if (k.indexOf(":acct:") !== -1) {
                if (scopedPrefix && k.indexOf(scopedPrefix) === 0
                        && _recordMatchesHost(all[k], host)) return all[k]
                continue
            }
            if (_recordMatchesHost(all[k], host)
                    && (!best || ((all[k] && all[k].scrapedAt) || 0) > ((best && best.scrapedAt) || 0))) {
                best = all[k]
            }
        }
        return best
    }

    function _prices(ownPricing) {
        if (!ownPricing) return null
        if (ownPricing.prices && typeof ownPricing.prices === "object"
                && Object.keys(ownPricing.prices).length) return ownPricing.prices
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            if (isFinite(ownPricing[cls])) return ownPricing
        }
        return null
    }

    function _normalisePriceClass(v) {
        const s = String(v || "").trim().toUpperCase()
        if (s === "Y" || s === "ECONOMY" || s === "ECONOMY CLASS") return "Y"
        if (s === "C" || s === "BUSINESS" || s === "BUSINESS CLASS") return "C"
        if (s === "F" || s === "FIRST" || s === "FIRST CLASS") return "F"
        if (s === "CARGO" || s === "FREIGHT" || s === "MAIL") return "Cargo"
        return null
    }

    function _competitorClass(c) {
        if (!c) return null
        if (c.isCargo === true) return "Cargo"
        return _normalisePriceClass(
            c.serviceClass || c.classKey || c.bookingClass || c.cabinClass
            || c.cabin || c.payloadClass || c.payload || c.className
            || c.classLabel || c["class"]
        )
    }

    function _competitorPrice(c, cls) {
        if (!c) return null
        let price = _firstNum(c.price, c.fare, c.avgPrice, c.currentPrice, c.unitPrice)
        if (price == null && cls && c.prices && typeof c.prices === "object") {
            price = _firstNum(c.prices[cls])
        }
        return price
    }

    function _roundPriceForClass(cls, value) {
        const n = Number(value)
        if (!isFinite(n)) return null
        return cls === "Cargo" && Math.abs(n) < 10
            ? Math.round(n * 100) / 100
            : Math.round(n)
    }

    function _median(arr, cls) {
        const vals = (arr || []).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b)
        if (!vals.length) return null
        const mid = Math.floor(vals.length / 2)
        const raw = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
        return _roundPriceForClass(cls, raw)
    }

    function _competitorStats(rec) {
        const all = rec && Array.isArray(rec.competitors) ? rec.competitors : []
        const byClass = {Y: [], C: [], F: [], Cargo: []}
        for (const c of all) {
            if (!c || c.isOurs) continue
            const cls = _competitorClass(c)
            const price = _competitorPrice(c, cls)
            if (cls && isFinite(price) && price > 0) byClass[cls].push(price)
        }
        const medians = {}
        const counts = {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const m = _median(byClass[cls], cls)
            if (m != null) medians[cls] = m
            counts[cls] = byClass[cls].length
        }
        return {
            competitorMedianPriceY: medians.Y != null ? medians.Y : null,
            competitorYsCount: counts.Y || 0,
            competitorPricesByClass: medians,
            competitorCountsByClass: counts
        }
    }

    function _normaliseOrsPricingIndex(idx) {
        if (!idx || typeof idx !== "object") return null
        if (idx.error) return idx
        const classes = idx.classes || idx.byClass || {}
        const prices = Object.assign({}, idx.competitorPricesByClass || {})
        const counts = Object.assign({}, idx.competitorCountsByClass || {})
        const ownPrices = Object.assign({}, idx.ownPricesByClass || {})
        const pressure = Object.assign({}, idx.orsPressureByClass || idx.pressureByClass || {})
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const c = classes && classes[cls]
            if (!c) continue
            const p = _firstNum(c.competitorMedianPrice, c.competitorMedian, c.bestCompetitorPrice, c.topCompetitorPrice)
            const n = _firstNum(c.competitorCount, c.competitorConnectionCount, c.competitorCarrierCount)
            const own = _firstNum(c.ownMedianPrice, c.ownPrice)
            const op = _firstNum(c.pressurePct, c.orsPressurePct, c.ratingPressurePct)
            if (prices[cls] == null && p != null) prices[cls] = _roundPriceForClass(cls, p)
            if (counts[cls] == null && n != null) counts[cls] = n
            if (ownPrices[cls] == null && own != null) ownPrices[cls] = _roundPriceForClass(cls, own)
            if (pressure[cls] == null && op != null) pressure[cls] = op
        }
        return Object.assign({}, idx, {
            classes,
            byClass: idx.byClass || classes,
            competitorPricesByClass: prices,
            competitorCountsByClass: counts,
            ownPricesByClass: ownPrices,
            orsPressureByClass: pressure
        })
    }

    function _orsPricingIndex(rec, settings, prices) {
        if (!rec) return null
        const embedded = _normaliseOrsPricingIndex(rec.pricingIndex)
        if (embedded) return embedded
        const opts = {rankTarget: settings && settings.ors && settings.ors.targetRank}
        try {
            const legacy = _orsPriceIndex(rec, prices || null, opts)
            const idx = _normaliseOrsPricingIndex(legacy)
            if (idx) return idx
        } catch (e) {
            return {error: e && e.message || String(e)}
        }
        try {
            if (typeof RouteAssistantOrsScraper !== "undefined"
                    && typeof RouteAssistantOrsScraper.buildPricingIndex === "function") {
                const idx = _normaliseOrsPricingIndex(RouteAssistantOrsScraper.buildPricingIndex(rec, opts))
                if (idx) return idx
            }
        } catch (_) { /* best-effort */ }
        return null
    }

    function _mergeCompetitorStatsWithOrs(comp, orsPricing) {
        const base = comp || {}
        const prices = Object.assign({}, base.competitorPricesByClass || {})
        const counts = Object.assign({Y: 0, C: 0, F: 0, Cargo: 0}, base.competitorCountsByClass || {})
        const orsPrices = orsPricing && orsPricing.competitorPricesByClass || {}
        const orsCounts = orsPricing && orsPricing.competitorCountsByClass || {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const priceOk = cls !== "Cargo" || Number(orsPrices[cls]) < 10
            if ((prices[cls] == null || !isFinite(prices[cls])) && isFinite(orsPrices[cls]) && priceOk) {
                prices[cls] = orsPrices[cls]
            }
            if (isFinite(orsCounts[cls])) {
                counts[cls] = Math.max(Number(counts[cls]) || 0, Number(orsCounts[cls]))
            }
        }
        return {
            competitorMedianPriceY: base.competitorMedianPriceY != null
                ? base.competitorMedianPriceY
                : (prices.Y != null ? prices.Y : null),
            competitorYsCount: Math.max(Number(base.competitorYsCount) || 0, Number(counts.Y) || 0),
            competitorPricesByClass: prices,
            competitorCountsByClass: counts,
            competitorSourceByClass: Object.fromEntries(Object.keys(counts).map(cls => [
                cls,
                ((base.competitorCountsByClass || {})[cls] || (base.competitorPricesByClass || {})[cls])
                    ? "markets"
                    : ((orsCounts[cls] || orsPrices[cls]) ? "ors-search" : null)
            ])),
            marketCompetitorPricesByClass: Object.assign({}, base.competitorPricesByClass || {}),
            marketCompetitorCountsByClass: Object.assign({}, base.competitorCountsByClass || {}),
            orsCompetitorPricesByClass: Object.assign({}, orsPrices),
            orsCompetitorCountsByClass: Object.assign({}, orsCounts)
        }
    }

    function _orsPriceIndex(rec, prices, opts) {
        if (!rec) return null
        const embedded = _normaliseOrsPricingIndex(rec.pricingIndex)
        if (embedded) return embedded
        if (typeof window !== "undefined" && window.RouteAssistantOrsPriceIndex
                && typeof window.RouteAssistantOrsPriceIndex.indexRecord === "function") {
            try {
                return _normaliseOrsPricingIndex(window.RouteAssistantOrsPriceIndex.indexRecord(rec,
                    Object.assign({currentPrices: prices || {}}, opts || {})))
            } catch (_) { /* best-effort */ }
        }
        try {
            if (typeof RouteAssistantOrsScraper !== "undefined"
                    && typeof RouteAssistantOrsScraper.buildPricingIndex === "function") {
                return _normaliseOrsPricingIndex(RouteAssistantOrsScraper.buildPricingIndex(rec))
            }
        } catch (_) { /* best-effort */ }
        return null
    }

    async function _loadControlMaps(rows, host, settings, marketMap) {
        const pairs = (rows || []).map(r => ({hub: r.hub, dest: r.dest}))
        const dests = Array.from(new Set((rows || []).map(r => r.dest).filter(Boolean)))
        const out = {
            demandMap:   new Map(),
            inventoryMap: new Map(),
            orsMap:      new Map(),
            yieldHistoryMap: new Map(),
            airborneMap: await _loadAirborneByRoute(host)
        }
        if (dests.length && typeof RouteAssistantDemandStore !== "undefined"
                && typeof RouteAssistantDemandStore.getMany === "function") {
            try { out.demandMap = await RouteAssistantDemandStore.getMany(dests) || new Map() }
            catch (_) { out.demandMap = new Map() }
        }
        if (pairs.length && typeof RouteAssistantInventoryPageScraper !== "undefined"
                && typeof RouteAssistantInventoryPageScraper.bulkLoadCache === "function") {
            try {
                out.inventoryMap = await RouteAssistantInventoryPageScraper.bulkLoadCache(pairs, {
                    maxAgeDays: settings && settings.demandDepth && settings.demandDepth.inventoryMaxAgeDays
                }) || new Map()
            } catch (_) { out.inventoryMap = new Map() }
        }
        if (pairs.length && typeof RouteAssistantOrsIntelligence !== "undefined"
                && typeof RouteAssistantOrsIntelligence.bulkLoadRecords === "function") {
            try {
                out.orsMap = await RouteAssistantOrsIntelligence.bulkLoadRecords(pairs, {
                    maxAgeDays: settings && settings.ors && settings.ors.rankMaxAgeDays
                }) || new Map()
            } catch (_) { out.orsMap = new Map() }
        } else if (pairs.length && typeof RouteAssistantOrsScraper !== "undefined"
                && typeof RouteAssistantOrsScraper.bulkLoadCache === "function") {
            try {
                out.orsMap = await RouteAssistantOrsScraper.bulkLoadCache(pairs, {
                    maxAgeDays: settings && settings.ors && settings.ors.rankMaxAgeDays
                }) || new Map()
            } catch (_) { out.orsMap = new Map() }
        }
        if (pairs.length && typeof RouteAssistantYieldHistoryStore !== "undefined"
                && typeof RouteAssistantYieldHistoryStore.getMany === "function") {
            try {
                out.yieldHistoryMap = await RouteAssistantYieldHistoryStore.getMany(pairs, {
                    maxAgeDays: settings && settings.yieldFeedback
                        && (settings.yieldFeedback.maxAgeDays || settings.yieldFeedback.historyMaxAgeDays)
                }) || new Map()
            } catch (_) { out.yieldHistoryMap = new Map() }
        }
        out.marketMap = marketMap || new Map()
        return out
    }

    async function _loadLiveCooldownState(settings, state, rows) {
        if (!settings || !settings.pricing || !settings.pricing.apply) return null
        if (state && state.dryRun) return null
        const apply = settings.pricing.apply || {}
        const perRouteMin = isFinite(apply.cooldownMinPerRoute)
            ? Math.max(0, Number(apply.cooldownMinPerRoute)) : 60
        const globalMin = isFinite(apply.cooldownMinGlobal)
            ? Math.max(0, Number(apply.cooldownMinGlobal)) : 5
        if (perRouteMin <= 0 && globalMin <= 0) return null
        const log = _pricingApplyLog(settings)
        if (!log) return null
        const out = {
            now: Date.now(),
            perRouteMin,
            globalMin,
            lastGlobalAt: null,
            perRouteLast: new Map()
        }
        try {
            if (globalMin > 0 && typeof log.getLastSuccessGlobal === "function") {
                out.lastGlobalAt = await log.getLastSuccessGlobal()
            }
            if (perRouteMin > 0 && typeof log.getLastSuccessMap === "function") {
                out.perRouteLast = await log.getLastSuccessMap((rows || []).map(r => ({
                    hub: r.hub,
                    dest: r.dest
                }))) || new Map()
            }
        } catch (_) {
            return null
        }
        return out
    }

    function _cooldownBlockFor(pair, cooldowns) {
        if (!pair || !cooldowns) return null
        const parts = []
        let remainingMin = 0
        if (cooldowns.globalMin > 0 && cooldowns.lastGlobalAt) {
            const elapsed = (cooldowns.now - cooldowns.lastGlobalAt) / 60000
            if (elapsed < cooldowns.globalMin) {
                const rem = Math.ceil(cooldowns.globalMin - elapsed)
                remainingMin = Math.max(remainingMin, rem)
                parts.push("global " + rem + "m")
            }
        }
        const routeAt = cooldowns.perRouteLast && cooldowns.perRouteLast.get(pair)
        if (cooldowns.perRouteMin > 0 && routeAt) {
            const elapsed = (cooldowns.now - routeAt) / 60000
            if (elapsed < cooldowns.perRouteMin) {
                const rem = Math.ceil(cooldowns.perRouteMin - elapsed)
                remainingMin = Math.max(remainingMin, rem)
                parts.push("route " + rem + "m")
            }
        }
        if (!parts.length) return null
        return {
            code: "cooldownActive",
            remainingMin,
            message: "cooldown active: " + parts.join(" · ")
        }
    }

    async function _loadLiveCapBlock(settings, cfg, state) {
        if (state && state.dryRun) return null
        const log = _pricingApplyLog(settings)
        if (!log) return null
        let caps = null
        try { caps = await _checkCaps(log, cfg, false) }
        catch (_) { return null }
        if (!caps) return null
        if (caps.dailyRemaining > 0 && caps.hourlyRemaining > 0) return null
        const parts = []
        if (caps.hourlyRemaining <= 0) parts.push("hourly cap")
        if (caps.dailyRemaining <= 0) parts.push("daily cap")
        return {
            code: "capExhausted",
            dailyUsed: caps.dailyUsed,
            hourlyUsed: caps.hourlyUsed,
            dailyRemaining: caps.dailyRemaining,
            hourlyRemaining: caps.hourlyRemaining,
            message: parts.join(" + ") + " exhausted"
        }
    }

    function _flightInfoFor(all, server, airline, flightId) {
        if (flightId == null) return null
        const ids = []
        if (server && airline) ids.push(String(server) + String(airline) + "flightInfo" + flightId)
        if (server) ids.push(String(server) + "flightInfo" + flightId)
        for (const k of ids) if (all[k]) return all[k]
        return null
    }

    function _aircraftFlightsRecordMatches(key, rec, host) {
        if (!rec || rec.type !== "aircraftFlights" || !Array.isArray(rec.flights)) return false
        const server = host && host.server || ""
        if (server && rec.server && String(rec.server) !== String(server)) return false
        if (server && String(key || "").indexOf(String(server)) !== 0) return false
        if (String(key || "").indexOf("aircraftFlights") < 0) return false
        return true
    }

    async function _loadAirborneByRoute(host) {
        const map = new Map()
        let all = {}
        try { all = await chrome.storage.local.get(null) || {} }
        catch (_) { return map }
        const server = host && host.server || ""
        const airline = host && host.airline || ""
        const seenFlights = new Set()
        for (const key in all) {
            const rec = all[key]
            if (!_aircraftFlightsRecordMatches(key, rec, host)) continue
            for (const env of rec.flights || []) {
                if (!env) continue
                const status = String(env.status || "").toLowerCase()
                if (status !== "inflight") continue
                const hub = _u(env.originIata)
                const dest = _u(env.destinationIata)
                if (!hub || !dest) continue
                const unique = env.flightId != null
                    ? "id:" + String(env.flightId)
                    : "row:" + [env.flightNumber || "", env.flightNumberId || "",
                                env.depUtc || "", hub, dest].join("|")
                if (seenFlights.has(unique)) continue
                seenFlights.add(unique)
                const fi = _flightInfoFor(all, server, rec.airline || airline, env.flightId)
                    || _flightInfoFor(all, server, airline, env.flightId)
                const cm5 = fi && fi.money && fi.money.CM5 ? Number(fi.money.CM5.Total) : NaN
                const actualPair = _pairKey(hub, dest)
                const routePairs = [actualPair]
                const reversePair = _pairKey(dest, hub)
                if (reversePair !== actualPair) routePairs.push(reversePair)
                for (const pair of routePairs) {
                    let slot = map.get(pair)
                    if (!slot) {
                        slot = {
                            inflight: 0,
                            cm5Total: 0,
                            cm5Count: 0,
                            missingFinancials: 0,
                            tailRegs: new Set(),
                            flightNumbers: new Set(),
                            flightIds: new Set(),
                            fnIds: new Set(),
                            sourcePairs: new Set(),
                            newestDepUtc: null
                        }
                        map.set(pair, slot)
                    }
                    slot.inflight++
                    slot.sourcePairs.add(actualPair)
                    if (rec.registration) slot.tailRegs.add(rec.registration)
                    if (env.flightNumber) slot.flightNumbers.add(String(env.flightNumber))
                    if (env.flightId != null) slot.flightIds.add(String(env.flightId))
                    if (env.flightNumberId != null) slot.fnIds.add(String(env.flightNumberId))
                    if (env.depUtc && (!slot.newestDepUtc || String(env.depUtc) > String(slot.newestDepUtc))) {
                        slot.newestDepUtc = env.depUtc
                    }
                    if (isFinite(cm5)) {
                        slot.cm5Total += cm5
                        slot.cm5Count++
                    } else {
                        slot.missingFinancials++
                    }
                }
            }
        }
        for (const [pair, slot] of map) {
            map.set(pair, {
                inflight:          slot.inflight,
                avgCm5:            slot.cm5Count ? slot.cm5Total / slot.cm5Count : null,
                cm5Total:          slot.cm5Count ? slot.cm5Total : null,
                cm5Count:          slot.cm5Count,
                missingFinancials: slot.missingFinancials,
                tailRegs:          Array.from(slot.tailRegs).slice(0, 8),
                flightNumbers:     Array.from(slot.flightNumbers).slice(0, 12),
                flightIds:         Array.from(slot.flightIds).slice(0, 12),
                fnIds:             Array.from(slot.fnIds).slice(0, 12),
                sourcePairs:        Array.from(slot.sourcePairs).slice(0, 12),
                newestDepUtc:      slot.newestDepUtc
            })
        }
        return map
    }

    function _deriveDemandControl(baseRow, marketBucket, inventory, demandRec, settings) {
        const out = {
            paxScore:      _firstNum(baseRow && baseRow.paxScore, demandRec && demandRec.paxScore),
            cargoScore:    _firstNum(baseRow && baseRow.cargoScore, demandRec && demandRec.cargoScore),
            paxDemandPool: _firstNum(baseRow && baseRow.paxDemandPool),
            cargoDemandPool: _firstNum(baseRow && baseRow.cargoDemandPool),
            paxElasticity: _firstNum(baseRow && baseRow.paxElasticity),
            cargoElasticity: _firstNum(baseRow && baseRow.cargoElasticity),
            rmTightness:   _firstNum(baseRow && baseRow.rmTightness),
            demandPoolByClass: _classNumberMap(baseRow && baseRow.demandPoolByClass),
            avgPriceByClass: _classNumberMap(baseRow && baseRow.avgPriceByClass),
            priceElasticityByClass: _classNumberMap(baseRow && baseRow.priceElasticityByClass),
            rmTightnessByClass: _classNumberMap(baseRow && baseRow.rmTightnessByClass),
            ratingPriceElasticityByClass: _classNumberMap(baseRow && baseRow.ratingPriceElasticityByClass),
            scrapedAt:     _firstNum(demandRec && demandRec.scrapedAt, baseRow && baseRow.demandDerivedAt),
            notes:         []
        }
        if (typeof RouteAssistantDemandDerivator !== "undefined"
                && typeof RouteAssistantDemandDerivator.derive === "function") {
            try {
                const ddCfg = settings && settings.demandDepth || {}
                const ratingCfg = settings && settings.orsSandbox
                    && settings.orsSandbox.ratingObservations || {}
                const derived = RouteAssistantDemandDerivator.derive(
                    marketBucket && marketBucket.historic || null,
                    inventory || null,
                    marketBucket && marketBucket.ownPricing || null,
                    null,
                    {
                        window:                  ddCfg.historicWindowPeriods || 12,
                        minObservations:         ratingCfg.minObservationsForDerivation,
                        priceDevRangeGate:       ratingCfg.priceDevRangeGate,
                        distinctBucketsRequired: ratingCfg.distinctBucketsRequired
                    }
                )
                if (derived) {
                    for (const k of ["paxDemandPool", "cargoDemandPool", "paxAvgPrice",
                                     "cargoAvgPrice", "paxElasticity", "cargoElasticity",
                                     "rmTightness"]) {
                        if (derived[k] === null || derived[k] === undefined || derived[k] === "") continue
                        const n = Number(derived[k])
                        if (isFinite(n)) out[k] = n
                    }
                    for (const k of ["demandPoolByClass", "avgPriceByClass",
                                     "priceElasticityByClass", "rmTightnessByClass",
                                     "ratingPriceElasticityByClass"]) {
                        out[k] = _classNumberMap(out[k], derived[k])
                    }
                    if (isFinite(derived.scrapedAt)) out.scrapedAt = derived.scrapedAt
                    if (derived.derivationNotes) out.notes.push(String(derived.derivationNotes))
                }
            } catch (e) {
                out.notes.push("demand derivation failed: " + (e && e.message || String(e)))
            }
        }
        if (inventory && isFinite(inventory.scrapedAt)) {
            out.inventoryScrapedAt = inventory.scrapedAt
        }
        return out
    }

    function _orsClassKeys(classKey) {
        switch (String(classKey || "")) {
            case "Y": return ["ECONOMY", "Y"]
            case "C": return ["BUSINESS", "C"]
            case "F": return ["FIRST", "F"]
            case "Cargo": return ["CARGO", "Cargo"]
            default: return []
        }
    }

    function _orsSummary(rec, classKey) {
        if (!rec) return null
        const byClass = rec.byClass && typeof rec.byClass === "object" ? rec.byClass : null
        let primaryKey = null
        if (byClass) {
            const preferred = _orsClassKeys(classKey)
            for (const k of preferred) {
                if (byClass[k]) { primaryKey = k; break }
            }
            if (!primaryKey && preferred.length) return null
            if (!primaryKey && byClass.ECONOMY) primaryKey = "ECONOMY"
            else if (!primaryKey && byClass.Y) primaryKey = "Y"
            else if (!primaryKey && byClass.BUSINESS) primaryKey = "BUSINESS"
            else if (!primaryKey && byClass.FIRST) primaryKey = "FIRST"
        }
        const primary = primaryKey ? byClass[primaryKey] : null
        const classKeys = byClass ? Object.keys(byClass) : []
        const from = primary || rec
        if (!from) return null
        return {
            rankAny:             _firstNum(from.rankAny, rec.rankAny),
            rankNonstop:         _firstNum(from.rankNonstop, rec.rankNonstop),
            rankBookable:        _firstNum(from.rankBookable, rec.rankBookable),
            ourTopRating:        _firstNum(from.ourTopRating, rec.ourTopRating),
            topCompetitorRating: _firstNum(from.topCompetitorRating, rec.topCompetitorRating),
            ratingGapToTop:      _firstNum(from.ratingGapToTop, rec.ratingGapToTop),
            totalConnections:    _firstNum(from.totalConnections, rec.totalConnections),
            scrapedAt:           _firstNum(rec.scrapedAt, from.scrapedAt),
            classCount:          classKeys.length,
            primaryClass:        primaryKey || (classKeys[0] || null)
        }
    }

    function _orsControlsByPriceClass(rec) {
        if (!rec || !rec.byClass) return null
        const out = {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const summary = _orsSummary(rec, cls)
            if (summary) out[cls] = summary
        }
        return Object.keys(out).length ? out : null
    }

    function _orsReadiness(rec, settings) {
        if (!rec || typeof RouteAssistantOrsIntelligence === "undefined") return null
        try {
            const svc = new RouteAssistantOrsIntelligence(null, {settings})
            const composite = svc.getComposite({orsByClass: rec.byClass}, settings)
            const warnings = []
            if (rec.oursDetection && rec.oursDetection.prefixFallbackOnly) {
                warnings.push("prefix-fallback-only")
            }
            const usable = !!(composite && (composite.rankAny != null || composite.rankNonstop != null
                || composite.ourTopRating != null))
            if (!usable) warnings.push("no-usable-ors-rank")
            return {
                usable,
                warnings,
                oursDetection: rec.oursDetection || null
            }
        } catch (_) { return null }
    }

    function _finiteSnapshotNumber(snapshot, key) {
        if (!snapshot || snapshot[key] === null || snapshot[key] === undefined || snapshot[key] === "") return null
        const n = Number(snapshot[key])
        return isFinite(n) ? n : null
    }

    function _yieldHistorySummary(record) {
        if (!record || !Array.isArray(record.snapshots) || !record.snapshots.length) return null
        const snapshots = record.snapshots.slice()
            .filter(Boolean)
            .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
        if (!snapshots.length) return null
        const latest = snapshots[snapshots.length - 1]
        let previous = null
        for (let i = snapshots.length - 2; i >= 0; i--) {
            if (_finiteSnapshotNumber(snapshots[i], "profitPerFlight") != null) {
                previous = snapshots[i]
                break
            }
        }
        const lastProfitPerFlight = _finiteSnapshotNumber(latest, "profitPerFlight")
        const previousProfitPerFlight = _finiteSnapshotNumber(previous, "profitPerFlight")
        const lastProfitPerWeek = _finiteSnapshotNumber(latest, "profitPerWeek")
        const frequency = _finiteSnapshotNumber(latest, "frequency")
        const recent = snapshots.slice(Math.max(0, snapshots.length - 4))
            .map(s => _finiteSnapshotNumber(s, "profitPerFlight"))
            .filter(v => v != null)
        const avgProfitPerFlight = recent.length
            ? recent.reduce((sum, v) => sum + v, 0) / recent.length
            : null
        let trendPct = null
        if (lastProfitPerFlight != null && previousProfitPerFlight != null
                && Math.abs(previousProfitPerFlight) > 1) {
            trendPct = ((lastProfitPerFlight - previousProfitPerFlight)
                / Math.abs(previousProfitPerFlight)) * 100
        }
        const lossMaking = (lastProfitPerFlight != null && lastProfitPerFlight < 0)
            || (avgProfitPerFlight != null && avgProfitPerFlight < 0)
        const profitable = (lastProfitPerFlight != null && lastProfitPerFlight > 0)
            || (avgProfitPerFlight != null && avgProfitPerFlight > 0)
        return {
            sampleCount: snapshots.length,
            lastSnapshotAt: latest.timestamp || record.lastSnapshotAt || null,
            latestProfitPerFlight: lastProfitPerFlight,
            previousProfitPerFlight,
            avgProfitPerFlight,
            latestProfitPerWeek: lastProfitPerWeek,
            frequency,
            trendPct,
            lossMaking,
            profitable,
            improving: trendPct != null && trendPct >= 15,
            deteriorating: trendPct != null && trendPct <= -15,
            attributionMode: latest.attributionMode || latest.mode || record.attributionMode || null,
            contributingTails: _finiteSnapshotNumber(latest, "contributingTails"),
            totalKnownTails: _finiteSnapshotNumber(latest, "totalKnownTails")
        }
    }

    function _pricingSignalSummary(route) {
        const labels = []
        if (route && route.ownPricing) labels.push("current")
        if (route && route.demandControls && (
                route.demandControls.paxDemandPool != null
             || route.demandControls.cargoDemandPool != null
             || route.demandControls.rmTightness != null
             || Object.keys(route.demandControls.demandPoolByClass || {}).length)) {
            labels.push("demand")
        }
        const compCounts = route && route.competitorCountsByClass || {}
        const orsCompCounts = route && route.orsCompetitorCountsByClass || {}
        if (["Y", "C", "F", "Cargo"].some(cls => Number(compCounts[cls]) > 0)) labels.push("competition")
        if (["Y", "C", "F", "Cargo"].some(cls => Number(orsCompCounts[cls]) > 0)) labels.push("ORS-price")
        if (route && route.yieldControls) labels.push("history")
        if (route && route.orsControls) labels.push("ORS")
        if (route && route.activeFlightControls && Number(route.activeFlightControls.inflight) > 0) labels.push("flights")
        const byClassOrs = route && route.orsControlsByClass || {}
        return {
            labels,
            current: !!(route && route.ownPricing),
            demand: labels.indexOf("demand") >= 0,
            competition: labels.indexOf("competition") >= 0,
            history: !!(route && route.yieldControls),
            ors: !!(route && route.orsControls),
            flights: labels.indexOf("flights") >= 0,
            byClass: {
                Y:     {competition: Number(compCounts.Y) > 0 || Number(orsCompCounts.Y) > 0, ors: !!(byClassOrs.Y || route && route.orsControls), demandSide: "pax"},
                C:     {competition: Number(compCounts.C) > 0 || Number(orsCompCounts.C) > 0, ors: !!(byClassOrs.C || route && route.orsControls), demandSide: "pax"},
                F:     {competition: Number(compCounts.F) > 0 || Number(orsCompCounts.F) > 0, ors: !!(byClassOrs.F || route && route.orsControls), demandSide: "pax"},
                Cargo: {competition: Number(compCounts.Cargo) > 0 || Number(orsCompCounts.Cargo) > 0, ors: !!byClassOrs.Cargo, demandSide: "cargo"}
            }
        }
    }

    function _composeControlVariables(route, classKey) {
        const cls = classKey || "Y"
        const d = route && route.demandControls || {}
        const byClassOrs = route && route.orsControlsByClass || {}
        const classSpecificOrs = byClassOrs[cls] || null
        const o = classSpecificOrs || (cls === "Cargo" ? {} : (route && route.orsControls || {}))
        const a = route && route.activeFlightControls || {}
        const y = route && route.yieldControls || {}
        const pax = _firstNum(d.paxScore, route && route.paxScore)
        const cargo = _firstNum(d.cargoScore, route && route.cargoScore)
        const classPoolMap = _classNumberMap(d.demandPoolByClass, route && route.demandPoolByClass)
        const classRmMap = _classNumberMap(d.rmTightnessByClass, route && route.rmTightnessByClass)
        const classElastMap = _classNumberMap(d.priceElasticityByClass, route && route.priceElasticityByClass)
        const paxElast = _firstNum(d.paxElasticity, route && route.paxElasticity)
        const cargoElast = _firstNum(d.cargoElasticity, route && route.cargoElasticity)
        const score = cls === "Cargo" ? cargo : pax
        const pool = classPoolMap[cls] != null ? classPoolMap[cls]
            : cls === "Cargo"
                ? _firstNum(d.cargoDemandPool, route && route.cargoDemandPool)
                : _firstNum(d.paxDemandPool, route && route.paxDemandPool)
        const rm = classRmMap[cls] != null ? classRmMap[cls]
            : _firstNum(d.rmTightness, route && route.rmTightness)
        const elast = classElastMap[cls] != null ? classElastMap[cls]
            : cls === "Cargo"
                ? cargoElast
                : paxElast
        // ORS rank + rating gap must be class-specific. Cargo may use the
        // CARGO ORS search result when present, but never falls back to a
        // passenger ORS row.
        const isCargo = cls === "Cargo"
        const orsApplies = !isCargo || !!classSpecificOrs
        const rank = orsApplies ? _firstNum(o.rankAny) : null
        const gap = orsApplies ? _firstNum(o.ratingGapToTop) : null
        const ourRating = orsApplies ? _firstNum(o.ourTopRating) : null
        const topRating = orsApplies ? _firstNum(o.topCompetitorRating) : null
        const ratingGap = gap != null ? gap
            : (ourRating != null && topRating != null ? ourRating - topRating : null)
        const demandStrong = (score != null && score >= 8) || (rm != null && rm >= 0.85)
        const demandWeak = (score != null && score <= 3) || (rm != null && rm < 0.50)
        const highlyElastic = elast != null && elast <= -2
        // Competition-density modulation. ORS rank/rating only matters when
        // customers can choose between operators — on monopoly routes there's
        // nowhere to defect. Use the count from competitorCountsByClass when
        // available (richer per-class data), fall back to the legacy Y-only
        // count. Cargo always gets weight=0 since pax ORS doesn't apply.
        const compCountsByClass = _classNumberMap(route && route.competitorCountsByClass)
        const orsCompCountsByClass = _classNumberMap(route && route.orsCompetitorCountsByClass)
        const compCount = isCargo
            ? 0
            : Math.max(
                compCountsByClass[cls] != null
                    ? compCountsByClass[cls]
                    : _firstNum(route && route.competitorYsCount, 0),
                orsCompCountsByClass[cls] != null ? orsCompCountsByClass[cls] : 0
            )
        const cw = (typeof window !== "undefined" && window.AesOrsCompetitionWeight)
            ? window.AesOrsCompetitionWeight
            : null
        const competitionWeight = cw && !isCargo
            ? cw.weightFromCompetitorCount(compCount)
            : (isCargo ? 0 : 1)
        const effectiveRank = (rank != null && competitionWeight > 0)
            ? rank * competitionWeight + 1 * (1 - competitionWeight)  // pull toward "rank 1" (good) at low weight
            : null
        const effectiveGap = (ratingGap != null) ? ratingGap * competitionWeight : null
        // Apply the weighted thresholds: monopoly routes (weight 0.20) need
        // a much-worse raw rank/gap to trip orsWeak/orsSevere, because
        // there's effectively no penalty for under-investing in ORS quality.
        // ratingGapToTop follows the scraper/UI convention:
        //   positive = our best rating beats the top competitor
        //   negative = top competitor beats our best rating
        const orsStrong = (effectiveRank != null && effectiveRank <= 3) || (effectiveGap != null && effectiveGap >= -2)
        const orsWeak = (effectiveRank != null && effectiveRank >= 8) || (effectiveGap != null && effectiveGap <= -6)
        const orsSevere = (effectiveRank != null && effectiveRank >= 15) || (effectiveGap != null && effectiveGap <= -12)
        const historicalProfit = _firstNum(y.latestProfitPerFlight, y.avgProfitPerFlight)
        const historyWeak = !!(y && (y.lossMaking || y.deteriorating))
            || (historicalProfit != null && historicalProfit < 0)
        const historyStrong = !!(y && y.profitable && !y.deteriorating)
            && (historicalProfit == null || historicalProfit > 0)
        return {
            demandStrong,
            demandWeak,
            highlyElastic,
            orsStrong,
            orsWeak,
            orsSevere,
            competitionWeight,
            competitorCount: compCount,
            effectiveRank,
            effectiveGap,
            historyWeak,
            historyStrong,
            historyLoss: !!(y && y.lossMaking),
            historyDeteriorating: !!(y && y.deteriorating),
            historySampleCount: y && y.sampleCount || 0,
            historyLatestProfitPerFlight: historicalProfit,
            historyTrendPct: y && y.trendPct != null ? y.trendPct : null,
            airborne: !!(a && a.inflight > 0),
            classKey: cls,
            demandSide: cls === "Cargo" ? "cargo" : "pax",
            classScore: score,
            classDemandPool: pool,
            classElasticity: elast,
            paxScore: pax,
            cargoScore: cargo,
            rmTightness: rm,
            paxElasticity: paxElast,
            cargoElasticity: cargoElast,
            rankAny: rank,
            ratingGapToTop: ratingGap,
            inflight: a && a.inflight || 0,
            avgCm5: a && a.avgCm5 != null ? a.avgCm5 : null
        }
    }

    function _controlDeltaPolicy(rawDelta, c) {
        const notes = []
        let factor = 1
        let block = null
        if (rawDelta > 0) {
            if (c.orsSevere) {
                factor *= 0.35
                notes.push("[control:ORS] weak ORS rank/gap; upward move heavily damped")
            } else if (c.orsWeak) {
                factor *= 0.60
                notes.push("[control:ORS] below-pack ORS; upward move damped")
            }
            if (c.demandWeak) {
                factor *= 0.65
                notes.push("[control:demand] weak demand/headroom; upward move damped")
            }
            if (c.highlyElastic) {
                factor *= 0.75
                notes.push("[control:demand] highly elastic pax demand; upward move damped")
            }
            if (c.historyWeak) {
                factor *= 0.70
                notes.push("[control:history] realised yield history is weak; upward move damped")
            }
            if (c.airborne && c.avgCm5 != null && c.avgCm5 < 0) {
                factor *= 0.50
                notes.push("[control:airborne] in-air route is currently CM5-negative; upward move damped")
            }
            if (c.airborne && c.orsSevere && c.demandWeak) {
                block = "control variables blocked upward move: in-air route has weak demand and poor ORS"
            }
            if (c.airborne && c.avgCm5 != null && c.avgCm5 < 0 && c.orsWeak) {
                block = "control variables blocked upward move: in-air route is CM5-negative with weak ORS"
            }
            if (c.historyLoss && c.orsWeak && c.demandWeak) {
                block = "control variables blocked upward move: realised yield is negative with weak demand and ORS"
            }
        } else {
            if (c.demandStrong) {
                factor *= 0.55
                notes.push("[control:demand] strong demand or tight inventory; discount damped")
            }
            if (c.orsStrong) {
                factor *= 0.75
                notes.push("[control:ORS] strong ORS position; discount damped")
            }
            if (c.historyStrong) {
                factor *= 0.80
                notes.push("[control:history] realised yield is profitable; discount damped")
            }
            if (c.airborne && c.avgCm5 != null && c.avgCm5 > 0 && c.demandStrong) {
                factor *= 0.80
                notes.push("[control:airborne] in-air route is profitable with strong demand; discount damped")
            }
        }
        return {factor, notes, block}
    }

    function _roundControlledPrice(cls, current, deltaPct) {
        const raw = current * (1 + deltaPct / 100)
        const scale = cls === "Cargo" && current < 10 ? 100 : 1
        const next = deltaPct > 0
            ? Math.floor(raw * scale) / scale
            : deltaPct < 0
                ? Math.ceil(raw * scale) / scale
                : Math.round(raw * scale) / scale
        return Math.max(scale === 1 ? 1 : 1 / scale, next)
    }

    function _classStepCap(cfg, cls) {
        const candidates = []
        const perClass = cfg && cfg.silentAutoPerClassMaxStepPct || {}
        if (perClass[cls] !== null && perClass[cls] !== undefined && perClass[cls] !== "") {
            const v = Number(perClass[cls])
            if (isFinite(v) && v >= 0) candidates.push(v)
        }
        const gate = cfg && cfg.applyClassGates && cfg.applyClassGates[cls]
        if (gate && gate.maxMove !== null && gate.maxMove !== undefined && gate.maxMove !== "") {
            const v = Number(gate.maxMove)
            if (isFinite(v) && v > 0) candidates.push(v)
        }
        if (candidates.length) return Math.min.apply(null, candidates)
        return Math.max(0, _num(cfg && cfg.silentAutoMaxStepPct, 10))
    }

    function _applyControlVariables(prop, route, prices, cfg) {
        if (!prop || !prop.ok || !cfg || cfg.silentAutoControlVariablesEnabled === false) return prop
        const proposedMap = prop.prices || {}
        // Symmetric per-class control evaluation. Each class (Y / C / F / Cargo)
        // is judged on its own signals — block / dampen / cap — and only the
        // surviving classes are kept. The headline (used by the audit log +
        // dedup fingerprint) is the highest-priority surviving class:
        // Y > C > F > Cargo. Pre-fix, a Y block killed the entire proposal,
        // sacrificing independent cargo or premium-cabin moves; the symmetric
        // form lets each cabin succeed or fail on its own merits.
        const minDelta = _num(cfg.silentAutoMinDeltaPct, 3)
        const adjustedPrices = {}
        const perClassDeltas = {}
        const notes = []
        const blockMessages = []
        const skipMessages = []
        let firstSurvivor = null
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const propCls = Number(proposedMap && proposedMap[cls])
            const prevCls = Number(prices && prices[cls])
            if (!isFinite(propCls) || propCls <= 0) continue
            if (!isFinite(prevCls) || prevCls <= 0) continue
            const gate = cfg.applyClassGates && cfg.applyClassGates[cls]
            if (gate && gate.enabled === false) {
                notes.push("[" + cls + "] disabled by per-class apply gate")
                skipMessages.push("[" + cls + "] disabled by per-class apply gate")
                continue
            }
            const rawCls = ((propCls - prevCls) / prevCls) * 100
            if (!isFinite(rawCls) || rawCls === 0) continue
            const clsControl = _composeControlVariables(route, cls)
            const clsPolicy = _controlDeltaPolicy(rawCls, clsControl)
            if (clsPolicy.block) {
                notes.push("[" + cls + "] " + clsPolicy.block)
                blockMessages.push(clsPolicy.block)
                continue
            }
            let controlledCls = rawCls * clsPolicy.factor
            const clsCap = _classStepCap(cfg, cls)
            controlledCls = _clamp(controlledCls, -clsCap, clsCap)
            if (Math.abs(controlledCls) < minDelta) {
                const msg = "controls reduced Δ% " + controlledCls.toFixed(1) + " below min " + minDelta + "%"
                notes.push("[" + cls + "] " + msg)
                skipMessages.push("[" + cls + "] " + msg)
                continue
            }
            const newCls = _roundControlledPrice(cls, prevCls, controlledCls)
            const clsTolerance = cls === "Cargo" && prevCls < 10 ? 0.005 : 0.5
            if (Math.abs(newCls - prevCls) < clsTolerance) {
                const msg = "controls rounded back to current price"
                notes.push("[" + cls + "] " + msg)
                skipMessages.push("[" + cls + "] " + msg)
                continue
            }
            adjustedPrices[cls] = newCls
            perClassDeltas[cls] = controlledCls
            if (clsPolicy.notes.length) {
                for (const n of clsPolicy.notes) notes.push("[" + cls + "] " + n)
            }
            if (firstSurvivor == null) firstSurvivor = cls
        }

        if (firstSurvivor == null) {
            const headlineCls = proposedMap.Y != null && prices && prices.Y != null
                ? "Y"
                : ["C", "F", "Cargo"].find(cls => proposedMap[cls] != null && prices && prices[cls] != null) || "Y"
            const fallbackControlVars = _composeControlVariables(route, headlineCls)
            // Surface the underlying block message when one or more classes
            // hit a hard `_controlDeltaPolicy.block`. Preserves the historic
            // "blocked upward move: ..." wording the audit log + tests expect.
            const skipReason = blockMessages.length
                ? blockMessages[0]
                : (skipMessages.length
                    ? "control variables left no class with a non-noise move (" + skipMessages.join("; ") + ")"
                    : "control variables left no class with a non-noise move")
            return {ok: false, dest: prop.dest, skipReason,
                    controlVariables: Object.assign({}, fallbackControlVars,
                        {factor: 1, notes: notes.slice()}),
                    originalProposal: prop}
        }

        const headlineCls = firstSurvivor
        const headlineControl = _composeControlVariables(route, headlineCls)
        const controlVariables = Object.assign({}, headlineControl, {
            factor: 1,
            notes:  notes.slice()
        })
        const headlineDelta = perClassDeltas[headlineCls]
        const prevHeadline = Number(prices && prices[headlineCls])
        const newHeadline = adjustedPrices[headlineCls]
        const rawDelta = isFinite(prop.deltaPct) ? Number(prop.deltaPct) : headlineDelta

        const rationale = Array.isArray(prop.rationale) ? prop.rationale.slice() : []
        for (const n of notes) rationale.push(n)
        const signalTags = []
        const noteText = notes.join(" ")
        if (noteText.indexOf("[control:history]") >= 0) signalTags.push("history")
        if (noteText.indexOf("[control:ORS]") >= 0) signalTags.push("ORS")
        if (noteText.indexOf("[control:demand]") >= 0) signalTags.push("demand")
        if (noteText.indexOf("[control:airborne]") >= 0) signalTags.push("flights")
        const reason = (prop.reason || "silent-auto proposal")
            + " · controls Δ " + (isFinite(rawDelta) ? rawDelta.toFixed(1) : "?") + "%"
            + " → " + headlineDelta.toFixed(1) + "%"
            + (signalTags.length ? " · signals " + signalTags.join("/") : "")

        const ourY = Number(prices && prices.Y)
        return Object.assign({}, prop, {
            prices: adjustedPrices,
            deltaPct: headlineDelta,
            prevY: adjustedPrices.Y != null && isFinite(ourY) ? Math.round(ourY) : prop.prevY,
            newY:  adjustedPrices.Y != null ? adjustedPrices.Y : prop.newY,
            headlineClass: headlineCls,
            prevHeadline: isFinite(prevHeadline) ? prevHeadline : null,
            newHeadline,
            reason,
            rationale,
            controlVariables,
            perClassDeltas
        })
    }

    async function _buildProposerContext(host, cfg, settings) {
        const strategy = cfg.silentAutoStrategy || "per-class-elasticity"
        const ctx = {
            now: Date.now(),
            strategy,
            settings: settings || null,
            hub: null,
            modelParams: settings && settings.orsSandbox && settings.orsSandbox.modelParams || {},
            economics: settings && settings.economics || {},
            useRealDemandForLF: !!(settings && settings.demandDepth
                && settings.demandDepth.useRealDemandForLF)
        }
        if (strategy !== "strategy-objective") return ctx
        if (!window.AesStrategy || typeof window.AesStrategy.snapshot !== "function"
                || typeof window.AesStrategy.proposePriceMoves !== "function") return ctx
        try {
            const snapshot = await window.AesStrategy.snapshot({
                server: host && host.server || null,
                airlineCode: host && host.airline || null
            })
            ctx.strategySnapshot = snapshot
            const moves = window.AesStrategy.proposePriceMoves(snapshot, {
                deadband: cfg.silentAutoMinDeltaPct || 3,
                maxMovePerWindow: cfg.silentAutoMaxStepPct || 10,
                includeCargo: cfg.silentAutoIncludeCargo !== false
            })
            // Slice E1 — per-class strategy moves. Engine + proposer emit
            // separate Y/C/F/Cargo records; keep them grouped by pair so
            // `_strategyObjective` can build a 4-class price object instead
            // of writing only Y. Y is preferred as the headline when present,
            // but cargo/premium-only strategy moves can still flow through.
            const byPair = new Map()
            for (const m of (moves || [])) {
                if (!m || !m.classKey) continue
                const key = _pairKey(m.hub, m.dest)
                let bucket = byPair.get(key)
                if (!bucket) { bucket = {Y: null, C: null, F: null, Cargo: null}; byPair.set(key, bucket) }
                bucket[m.classKey] = m
            }
            ctx.strategyMovesByPair = byPair
        } catch (e) {
            console.warn("[AES route-price-auto] strategy context failed", e)
        }
        return ctx
    }

    async function preview(hostArg, opts) {
        const host = _hostFromPage(hostArg)
        const settings = await _loadSettings()
        const cfg = configFromSettings(settings)
        if (opts && opts.followMode) cfg.silentAutoFollowMode = opts.followMode
        const state = describeSettings(settings, opts)
        const top = await _loadTopRoutes(host, opts)
        const watchlist = await _loadWatchlist()
        const pricePins = await _loadPricePins(top)
        const marketMap = await _loadMarkets(top, host, settings)
        const controlMaps = await _loadControlMaps(top, host, settings, marketMap)
        const proposerCtx = await _buildProposerContext(host, cfg, settings)
        const cooldowns = await _loadLiveCooldownState(settings, state, top)
        const capBlock = await _loadLiveCapBlock(settings, cfg, state)

        const rows = []
        const proposals = []
        for (const base of top) {
            const bucket = marketMap.get(base.pair) || {}
            const prices = _prices(bucket.ownPricing)
            const rawComp = _competitorStats(bucket.competitors)
            const demandBasic = controlMaps.demandMap.get(base.dest) || null
            const inventory = controlMaps.inventoryMap.get(base.pair) || null
            const orsRec = controlMaps.orsMap.get(base.pair) || null
            const orsPricingIndex = _orsPricingIndex(orsRec, settings, prices)
            const comp = _mergeCompetitorStatsWithOrs(rawComp, orsPricingIndex)
            const yieldRec = controlMaps.yieldHistoryMap.get(base.pair) || null
            const demandControls = _deriveDemandControl(base.row || {}, bucket, inventory, demandBasic, settings)
            const orsControls = _orsSummary(orsRec)
            const orsControlsByClass = _orsControlsByPriceClass(orsRec)
            const orsPriceIndex = orsPricingIndex
            const yieldControls = _yieldHistorySummary(yieldRec)
            const activeFlightControls = controlMaps.airborneMap.get(base.pair) || null
            const watchlisted = watchlist.has(base.pair)
            const manualPricePin = pricePins.has(base.pair) ? pricePins.get(base.pair) : null
            const route = Object.assign({}, base.row || {}, comp, {
                hub: base.hub,
                destIata: base.dest,
                paxScore: _firstNum(base.row && base.row.paxScore, demandControls.paxScore),
                cargoScore: _firstNum(base.row && base.row.cargoScore, demandControls.cargoScore),
                paxDemandPool: demandControls.paxDemandPool,
                cargoDemandPool: demandControls.cargoDemandPool,
                paxElasticity: demandControls.paxElasticity,
                cargoElasticity: demandControls.cargoElasticity,
                rmTightness: demandControls.rmTightness,
                demandPoolByClass: demandControls.demandPoolByClass,
                avgPriceByClass: demandControls.avgPriceByClass,
                priceElasticityByClass: demandControls.priceElasticityByClass,
                rmTightnessByClass: demandControls.rmTightnessByClass,
                ratingPriceElasticityByClass: demandControls.ratingPriceElasticityByClass,
                competitorPricesByClass: comp.competitorPricesByClass,
                competitorCountsByClass: comp.competitorCountsByClass,
                competitorSourceByClass: comp.competitorSourceByClass,
                marketCompetitorPricesByClass: comp.marketCompetitorPricesByClass,
                marketCompetitorCountsByClass: comp.marketCompetitorCountsByClass,
                orsPricingIndex,
                orsPriceIndex,
                orsCompetitorPricesByClass: comp.orsCompetitorPricesByClass
                    || (orsPriceIndex && orsPriceIndex.competitorPricesByClass) || {},
                orsCompetitorCountsByClass: comp.orsCompetitorCountsByClass
                    || (orsPriceIndex && orsPriceIndex.competitorCountsByClass) || {},
                orsOwnPricesByClass: orsPriceIndex && orsPriceIndex.ownPricesByClass || {},
                orsPressureByClass: orsPriceIndex && orsPriceIndex.orsPressureByClass || {},
                demandDerivedAt: demandControls.scrapedAt,
                ownPricing: bucket.ownPricing || null,
                orsByClass: orsRec && orsRec.byClass || null,
                orsScrapedAt: orsRec && orsRec.scrapedAt || null,
                orsReadiness: _orsReadiness(orsRec, settings),
                demandControls,
                orsControls,
                orsControlsByClass,
                yieldControls,
                activeFlightControls,
                ownPricingScrapedAt: bucket.ownPricing && bucket.ownPricing.scrapedAt || null,
                competitorScrapedAt: bucket.competitors && bucket.competitors.scrapedAt || null
            })
            route.controlVariables = _composeControlVariables(route)
            route.pricingSignals = _pricingSignalSummary(route)
            const eligibleByMode = cfg.silentAutoFollowMode !== "watchlist" || watchlisted
            let prop = null
            let stage = "skipped"
            let reason = ""
            const cooldown = _cooldownBlockFor(base.pair, cooldowns)
            if (!eligibleByMode) {
                reason = "not watchlisted"
            } else if (manualPricePin != null) {
                reason = "manual price pin " + Math.round(manualPricePin) + "%"
            } else if (!prices || !Object.keys(prices).length) {
                reason = "no own pricing cached"
            } else if (window.RouteAssistantSilentAutoProposers
                    && typeof window.RouteAssistantSilentAutoProposers.dispatch === "function") {
                prop = window.RouteAssistantSilentAutoProposers.dispatch(
                    cfg.silentAutoStrategy || "per-class-elasticity",
                    route,
                    prices,
                    cfg,
                    proposerCtx
                )
                if (prop && prop.ok) {
                    prop = _applyControlVariables(prop, route, prices, cfg)
                }
                if (prop && prop.ok) {
                    if (cooldown) {
                        stage = "cooldown"
                        reason = cooldown.message
                    } else if (capBlock) {
                        stage = "cap"
                        reason = capBlock.message
                    } else {
                        stage = "proposed"
                        reason = prop.reason || ""
                        proposals.push(Object.assign({}, prop, {
                            hub: base.hub,
                            pair: base.pair,
                            activeFlightControls,
                            pricingSignals: route.pricingSignals,
                            prevPrices: Object.assign({}, prices)
                        }))
                    }
                } else {
                    reason = prop && prop.skipReason || "proposer skipped"
                }
            } else {
                reason = "proposer registry not loaded"
            }
            rows.push({
                hub: base.hub,
                dest: base.dest,
                pair: base.pair,
                source: base.source,
                sourceRow: base.row,
                watchlisted,
                prices,
                competitorMedianPriceY: comp.competitorMedianPriceY,
                competitorYsCount: comp.competitorYsCount,
                competitorPricesByClass: comp.competitorPricesByClass,
                competitorCountsByClass: comp.competitorCountsByClass,
                competitorSourceByClass: comp.competitorSourceByClass,
                marketCompetitorPricesByClass: comp.marketCompetitorPricesByClass,
                marketCompetitorCountsByClass: comp.marketCompetitorCountsByClass,
                orsPricingIndex,
                orsPriceIndex,
                orsCompetitorPricesByClass: route.orsCompetitorPricesByClass,
                orsCompetitorCountsByClass: route.orsCompetitorCountsByClass,
                orsOwnPricesByClass: route.orsOwnPricesByClass,
                orsPressureByClass: route.orsPressureByClass,
                manualPricePin,
                demandControls,
                orsControls,
                orsControlsByClass,
                yieldControls,
                activeFlightControls,
                pricingSignals: route.pricingSignals,
                controlVariables: (prop && prop.controlVariables) || route.controlVariables,
                ownPricingScrapedAt: route.ownPricingScrapedAt,
                competitorScrapedAt: route.competitorScrapedAt,
                orsScrapedAt: route.orsScrapedAt,
                yieldHistorySnapshotAt: yieldControls && yieldControls.lastSnapshotAt || null,
                cooldown,
                capBlock: stage === "cap" ? capBlock : null,
                stage,
                reason,
                proposal: prop && prop.ok ? prop : null
            })
        }
        const counts = {
            routes: rows.length,
            watchlisted: rows.filter(r => r.watchlisted).length,
            pinned: rows.filter(r => r.manualPricePin != null).length,
            proposed: proposals.length,
            withOwnPricing: rows.filter(r => r.prices && Object.keys(r.prices).length).length,
            withCompetitors: rows.filter(r => r.competitorYsCount > 0).length,
            withYieldHistory: rows.filter(r => !!r.yieldControls).length,
            withOrs: rows.filter(r => !!r.orsControls).length,
            withActiveFlights: rows.filter(r =>
                r.activeFlightControls && Number(r.activeFlightControls.inflight) > 0).length,
            cooldownBlocked: rows.filter(r => r.stage === "cooldown").length,
            capBlocked: rows.filter(r => r.stage === "cap").length,
            withOrsIndex: rows.filter(r => !!r.orsPricingIndex).length,
            withOrsPriceIndex: rows.filter(r => !!r.orsPriceIndex).length
        }
        const notices = []
        if (counts.routes === 0) {
            notices.push({
                code: "no-route-data",
                severity: "info",
                message: "No cached routes or market-pricing records are available for auto-pricing. Visit a Route Assistant scheduling hub or run a Markets bulk scrape, then retry."
            })
        }
        if (cfg.silentAutoFollowMode === "watchlist" && counts.watchlisted === 0 && counts.routes > 0) {
            notices.push({
                code: "watchlist-empty",
                severity: "info",
                message: "Silent-auto follow mode is 'watchlist' but no routes are starred — every row will be skipped with reason 'not watchlisted'. "
                    + "Star routes in the Route Assistant panel, or set settings.routeAssistant.pricing.silentAutoFollowMode = 'all' for fleet-wide proposals."
            })
        }
        if (counts.routes > 0 && counts.withCompetitors === 0 && counts.withOrs === 0
            && counts.withYieldHistory === 0 && counts.withOrsIndex === 0) {
            notices.push({
                code: "no-cached-signals",
                severity: "info",
                message: "No competitor / ORS / yield-history data is cached for any route. Run a Markets bulk-scrape from the Route Assistant panel before silent-auto can produce proposals."
            })
        }
        if (counts.routes > 0 && counts.withOwnPricing === 0) {
            notices.push({
                code: "no-own-pricing-cache",
                severity: "info",
                message: "Routes are known from scheduling/top-route cache, but no own-pricing records are cached yet. Open each route's Market Analysis page or run the pricing scrape before silent-auto can apply fare moves."
            })
        }
        return {host, settings, cfg, state, rows, proposals, counts, notices}
    }

    function _pricingApplyLog(settings) {
        const apply = settings && settings.pricing && settings.pricing.apply || {}
        if (typeof RouteAssistantPricingApplyLog === "undefined") return null
        return new RouteAssistantPricingApplyLog({
            limit: apply.pricingApplyLogLimit || 200,
            perRouteLimit: apply.perRouteApplyLogLimit || 20,
            dedupWindowMin: isFinite(apply.pricingApplyLogDedupWindowMin)
                ? apply.pricingApplyLogDedupWindowMin : 5
        })
    }

    function _recordPriceDiagnostic(kind, info) {
        try {
            if (typeof window === "undefined" || !window.AesPriceDiagnostics) return
            const d = window.AesPriceDiagnostics
            if (kind === "proposed" && typeof d.recordProposal === "function") d.recordProposal(info)
            else if (kind === "apply" && typeof d.recordApply === "function") d.recordApply(info)
            else if (kind === "skip" && typeof d.recordSkip === "function") d.recordSkip(info)
            else if (kind === "context" && typeof d.recordContext === "function") d.recordContext(info)
        } catch (_) { /* diagnostics writes must never affect pricing */ }
    }

    function _pricingApplier(host, settings, log, opts) {
        const apply = settings && settings.pricing && settings.pricing.apply || {}
        const gate = _resolveApplyGate(apply, "silentAuto", opts)
        return new RouteAssistantPricingApplier(host.server, {
            dryRunOnly: gate.dryRunOnly,
            applyEnabled: gate.applyEnabled,
            liveScopes: apply.liveScopes || {},
            cooldownMinPerRoute: apply.cooldownMinPerRoute,
            cooldownMinGlobal: apply.cooldownMinGlobal,
            warnAboveDeltaPct: apply.warnAboveDeltaPct,
            applyLog: log,
            circuitBreakerThreshold: apply.circuitBreakerThreshold,
            circuitBreakerCooldownMs: apply.circuitBreakerCooldownMs,
            circuitBreakerTrippedAt: apply.circuitBreakerTrippedAt,
            onBreakerTrip: async (reason, trippedAt) => {
                settings.pricing.apply.circuitBreakerTrippedAt = trippedAt
                settings.pricing.apply.circuitBreakerHaltReason = String(reason || "")
                await RouteAssistantSettings.save({pricing: settings.pricing})
            },
            onBreakerReset: async () => {
                if (!settings.pricing || !settings.pricing.apply) return
                settings.pricing.apply.circuitBreakerTrippedAt = null
                settings.pricing.apply.circuitBreakerHaltReason = null
                await RouteAssistantSettings.save({pricing: settings.pricing})
            }
        })
    }

    async function _checkCaps(log, cfg, dryRun) {
        const now = Date.now()
        let dailyUsed = 0
        let hourlyUsed = 0
        if (log && typeof log.countSilentAutoIn === "function" && !dryRun) {
            try {
                const c = await log.countSilentAutoIn({
                    daily: now - 24 * 3600 * 1000,
                    hourly: now - 1 * 3600 * 1000
                })
                dailyUsed = c.daily || 0
                hourlyUsed = c.hourly || 0
            } catch (_) { /* fail open; applier cooldowns still gate */ }
        }
        const dayCap = cfg.silentAutoMaxPerDay > 0 ? cfg.silentAutoMaxPerDay : Infinity
        const hourCap = cfg.silentAutoMaxPerHour > 0 ? cfg.silentAutoMaxPerHour : Infinity
        return {
            dailyUsed,
            hourlyUsed,
            dailyRemaining: Math.max(0, dayCap - dailyUsed),
            hourlyRemaining: Math.max(0, hourCap - hourlyUsed)
        }
    }

    async function _resolveEndpointOpts(host, settings, hub, dest) {
        const apply = settings && settings.pricing && settings.pricing.apply || {}
        if (apply.endpointMode !== "flightNumbers") return {}
        const fallback = apply.flightNumbersFallbackToMarkets !== false
        const Resolver = window.AesRouteAssistantFlightNumberResolver
        if (!Resolver || typeof Resolver.resolve !== "function") {
            return fallback ? {} : {endpoint: "flightNumbers", flightNumberId: null, legIndex: 0}
        }
        let hit = null
        try { hit = await Resolver.resolve(host.server, hub, dest) }
        catch (_) { hit = null }
        if (!hit || hit.flightNumberId == null) {
            return fallback ? {} : {endpoint: "flightNumbers", flightNumberId: null, legIndex: 0}
        }
        return {endpoint: "flightNumbers", flightNumberId: hit.flightNumberId, legIndex: hit.legIndex || 0}
    }

    async function runTick(hostArg, opts) {
        const ranAt = Date.now()
        const result = {
            ranAt,
            sourcePage: _sourcePageFromLocation(),
            eligible: 0,
            proposed: 0,
            applied: 0,
            simulated: 0,
            capped: 0,
            blocked: 0,
            skipped: 0,
            dryRun: false,
            error: null,
            perRoute: []
        }
        const pushTrace = (entry) => {
            if (result.perRoute.length < 50) result.perRoute.push(entry)
        }
        let settings = null
        try {
            const prev = await preview(hostArg, opts)
            settings = prev.settings
            const host = prev.host
            const cfg = prev.cfg
            const state = prev.state
            result.dryRun = state.dryRun
            if (!host.server) {
                result.error = {code: "noServer", message: "server context unavailable"}
                return result
            }
            if (!cfg.silentAutoEnabled && !(opts && opts.force)) {
                result.error = {code: "disabled", message: "silent-auto is off"}
                return result
            }
            if (cfg.silentAutoMutedUntil && cfg.silentAutoMutedUntil > ranAt) {
                const remainingMin = Math.ceil((cfg.silentAutoMutedUntil - ranAt) / 60000)
                result.error = {code: "muted", message: "muted (" + remainingMin + " min remaining)", remainingMin}
                return result
            }

            const eligibleRows = prev.rows.filter(r =>
                r.manualPricePin == null
                    && (cfg.silentAutoFollowMode !== "watchlist" || r.watchlisted))
            result.eligible = eligibleRows.length
            result.skipped = prev.rows.filter(r => r.stage === "skipped").length
            result.proposed = prev.proposals.length
            if (!prev.rows.length) {
                result.error = {
                    code: "noCachedRoutes",
                    message: "no cached routes are available for automatic pricing; run Route Assistant or the dashboard scrape first"
                }
                return result
            }
            if (!prev.proposals.length) {
                const cooldownRows = prev.rows.filter(r => r.stage === "cooldown")
                const capRows = prev.rows.filter(r => r.stage === "cap")
                if (cooldownRows.length || capRows.length) {
                    const blockedRows = cooldownRows.concat(capRows)
                    const parts = []
                    if (cooldownRows.length) parts.push(cooldownRows.length + " cooldown")
                    if (capRows.length) parts.push(capRows.length + " capped")
                    result.blocked = blockedRows.length
                    result.error = {
                        code: cooldownRows.length ? "cooldownActive" : "capExhausted",
                        message: parts.join(" · ") + " proposal"
                            + (blockedRows.length === 1 ? " is" : "s are")
                            + " waiting on live apply gates"
                    }
                    for (const r of blockedRows.slice(0, 20)) {
                        pushTrace({
                            pair: r.pair,
                            dest: r.dest,
                            stage: r.stage,
                            reason: r.reason,
                            cooldown: r.cooldown || null,
                            capBlock: r.capBlock || null
                        })
                    }
                    return result
                }
                result.error = {code: "noProposals", message: "no route met the min delta threshold"}
                for (const r of prev.rows.slice(0, 20)) {
                    pushTrace({dest: r.dest, stage: r.stage, reason: r.reason})
                }
                return result
            }

            const log = _pricingApplyLog(settings)
            const remaining = await _checkCaps(log, cfg, state.dryRun)
            if (remaining.dailyRemaining <= 0 || remaining.hourlyRemaining <= 0) {
                result.error = {code: "capExhausted", message: "silent-auto cap exhausted"}
                result.blocked = prev.proposals.length
                for (const p of prev.proposals) {
                    pushTrace({
                        dest: p.dest,
                        stage: "blocked",
                        reason: "tick cap exhausted",
                        priceSummary: _summarizePriceMove(p.prevPrices, p.prices)
                    })
                }
                return result
            }

            const runLimit = opts && isFinite(opts.maxRoutes)
                ? Math.max(0, Math.floor(Number(opts.maxRoutes)))
                : Infinity
            const budget = Math.min(
                remaining.dailyRemaining,
                remaining.hourlyRemaining,
                runLimit,
                prev.proposals.length
            )
            const toApply = prev.proposals.slice(0, budget)
            result.capped = Math.max(0, prev.proposals.length - budget)
            for (const p of prev.proposals.slice(budget)) {
                pushTrace({
                    dest: p.dest,
                    stage: "capped",
                    reason: "over tick budget",
                    priceSummary: _summarizePriceMove(p.prevPrices, p.prices)
                })
            }

            if (typeof RouteAssistantPricingApplier === "undefined") {
                result.error = {code: "applierMissing", message: "pricing applier is not loaded on this page"}
                result.blocked = toApply.length
                return result
            }

            const applier = _pricingApplier(host, settings, log, opts)
            const apply = settings.pricing && settings.pricing.apply || {}
            const submitButton = apply.submitButton || "submit-prices"
            const scope = Object.assign(
                {},
                RouteAssistantPricingApplier.DEFAULT_SCOPE || {},
                apply.defaultScope || {}
            )

            let lastApplyAtGlobal = null
            const perRouteLast = new Map()
            if (!state.dryRun && log) {
                try {
                    if (typeof log.getLastSuccessGlobal === "function") {
                        lastApplyAtGlobal = await log.getLastSuccessGlobal()
                    }
                    if (typeof log.getLastSuccessMap === "function") {
                        const m = await log.getLastSuccessMap(toApply.map(p => ({hub: p.hub, dest: p.dest})))
                        for (const [k, v] of m) perRouteLast.set(k, v)
                    }
                } catch (_) { /* optional cooldown hint */ }
            }

            for (const prop of toApply) {
                const pair = _pairKey(prop.hub, prop.dest)
                let applyResult = null
                try {
                    const endpointOpts = await _resolveEndpointOpts(host, settings, prop.hub, prop.dest)
                    _recordPriceDiagnostic("proposed", {
                        hub: prop.hub,
                        dest: prop.dest,
                        reason: prop.reason,
                        prices: prop.prices,
                        context: {
                            prevPrices: prop.prevPrices || null,
                            proposedPrices: prop.prices || null,
                            controlVariables: prop.controlVariables || null,
                            rationale: prop.rationale || null,
                            strategy: cfg.silentAutoStrategy || "per-class-elasticity"
                        }
                    })
                    applyResult = await applier.apply(prop.hub, prop.dest, prop.prices, Object.assign({
                        scope,
                        source: "silent-auto",
                        submitButton,
                        lastApplyAt: perRouteLast.has(pair) ? perRouteLast.get(pair) : null,
                        lastApplyAtGlobal,
                        dryRun: state.dryRun,
                        reason: "dashboard route management - " + (prop.reason || "silent-auto proposal"),
                        proposerStrategy: cfg.silentAutoStrategy || "per-class-elasticity",
                        rationale: prop.rationale || null,
                        objective: prop.objective || null,
                        projectedDelta: prop.projectedDelta || null,
                        classGates: apply.classes || null
                    }, endpointOpts))
                } catch (e) {
                    applyResult = {status: "failed", error: {code: "applierThrew", message: String(e && e.message || e)}}
                }
                const applyStatus = applyResult && applyResult.status || "failed"
                const ok = applyStatus === "verified" || applyStatus === "posted" || applyStatus === "dry-run"
                _recordPriceDiagnostic("apply", {
                    hub: prop.hub,
                    dest: prop.dest,
                    ok,
                    status: applyStatus,
                    logId: applyResult && applyResult.logId || null,
                    prices: applyResult && applyResult.newPrices || prop.prices,
                    context: {
                        prevPrices: prop.prevPrices || null,
                        requestedPrices: prop.prices || null,
                        verifiedPrices: applyResult && applyResult.verifiedPrices || null,
                        controlVariables: prop.controlVariables || null,
                        error: ok ? null : (applyResult && applyResult.error || null)
                    }
                })
                pushTrace({
                    pair: prop.pair || _pairKey(prop.hub, prop.dest),
                    dest: prop.dest,
                    stage: ok ? (state.dryRun ? "simulated" : "applied") : "failed",
                    applyStatus,
                    reason: ok
                        ? prop.reason
                        : ((applyResult && applyResult.error && applyResult.error.message) || "applier returned non-success"),
                    prevY: prop.prevY,
                    newY: prop.newY,
                    deltaPct: prop.deltaPct,
                    priceSummary: _summarizePriceMove(prop.prevPrices, prop.prices),
                    prices: prop.prices || null,
                    activeFlightControls: prop.activeFlightControls || null,
                    controlVariables: prop.controlVariables || null,
                    errorCode: applyResult && applyResult.error && applyResult.error.code || null
                })
                if (ok) {
                    result.applied += 1
                    if (state.dryRun) result.simulated += 1
                }
                else result.blocked += 1
            }
            if (!result.applied && result.blocked) {
                result.error = {
                    code: "allBlocked",
                    message: result.blocked + " proposal"
                        + (result.blocked === 1 ? "" : "s")
                        + " failed or could not be verified"
                }
            }
            return result
        } catch (e) {
            result.error = {code: "tickThrew", message: String(e && e.message || e)}
            console.warn("[AES route-price-auto] tick threw", e)
            return result
        } finally {
            if (settings && settings.pricing && typeof RouteAssistantSettings !== "undefined") {
                try {
                    settings.pricing.silentAutoLastTickAt = result.ranAt
                    settings.pricing.silentAutoLastTickResult = result
                    await RouteAssistantSettings.save({pricing: settings.pricing})
                } catch (e) {
                    console.warn("[AES route-price-auto] tick persist failed", e)
                }
            }
        }
    }

    function _attachAlarmListener() {
        if (!chrome.runtime || !chrome.runtime.onMessage) return
        chrome.runtime.onMessage.addListener((msg) => {
            if (!msg || msg.type !== "aes:silent-auto:tick") return
            runTickIfDue(_hostFromPage({}), {source: "alarm"})
                .catch(e => console.warn("[AES route-price-auto] alarm tick failed", e))
        })
    }

    function _isDashboardPage() {
        try { return /\/app\/enterprise\/dashboard/.test(location && location.pathname || "") }
        catch (_) { return false }
    }

    async function runTickIfDue(hostArg, opts) {
        const ranAt = Date.now()
        if (_tickIfDueInFlight) return {ranAt, skipped: "running"}
        _tickIfDueInFlight = true
        try {
            const settings = await _loadSettings()
            const cfg = configFromSettings(settings)
            if (!cfg.silentAutoEnabled) return {ranAt, skipped: "disabled"}
            if (cfg.silentAutoMutedUntil && cfg.silentAutoMutedUntil > ranAt) {
                return {ranAt, skipped: "muted", mutedUntil: cfg.silentAutoMutedUntil}
            }
            const tickMs = cfg.silentAutoTickMs || _silentAutoTickMs(cfg.silentAutoTickMin)
            const last = isFinite(cfg.silentAutoLastTickAt) ? Number(cfg.silentAutoLastTickAt) : 0
            if (last > 0 && (ranAt - last) < Math.max(4000, tickMs * 0.9)) {
                return {ranAt, skipped: "recent", lastTickAt: last, nextDueAt: last + tickMs}
            }
            return await runTick(hostArg || _hostFromPage({}), opts || {source: "due"})
        } catch (e) {
            console.warn("[AES route-price-auto] due tick failed", e)
            return {
                ranAt,
                skipped: "threw",
                error: {code: "tickIfDueThrew", message: String(e && e.message || e)}
            }
        } finally {
            _tickIfDueInFlight = false
        }
    }

    window.AesRoutePriceAutomator = {
        preview,
        runTick,
        runTickIfDue,
        configFromSettings,
        describeSettings,
        setSilentAutoEnabled,
        configureAutomaticLiveMode,
        _private: {
            _competitorStats,
            _prices,
            _pairKey,
            _silentAutoTickMin,
            _silentAutoTickMs,
            _silentAutoTickLabel,
            _silentAutoTickMsFromPricing,
            _silentAutoTickLabelFromPricing,
            _activePricePin,
            _loadAirborneByRoute,
            _orsPriceIndex,
            _orsPricingIndex,
            _mergeCompetitorStatsWithOrs,
            _deriveDemandControl,
            _orsSummary,
            _orsControlsByPriceClass,
            _yieldHistorySummary,
            _pricingSignalSummary,
            _composeControlVariables,
            _applyControlVariables
        }
    }

    _attachAlarmListener()
    if (_isDashboardPage()) {
        const fire = () => { runTickIfDue(_hostFromPage({}), {source: "foreground"}).catch(() => {}) }
        const kickoff = setTimeout(fire, 5000)
        if (kickoff && typeof kickoff.unref === "function") kickoff.unref()
        _foregroundTickTimer = setInterval(fire, 5000)
        if (_foregroundTickTimer && typeof _foregroundTickTimer.unref === "function") _foregroundTickTimer.unref()
    }
})()
