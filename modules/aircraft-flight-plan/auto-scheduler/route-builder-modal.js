"use strict"

/**
 * Standalone Route Builder modal — second entry point for the planner.
 *
 * The AFP page already has a fully-wired Route Builder workbench inside
 * preview-panel.js. That surface lives at the bottom of an aircraft's
 * /app/fleets/aircraft/<id>/0 page and isn't reachable from the
 * enterprise dashboard. This module is the standalone version: a modal
 * that opens from any AS surface (dashboard tile, slash command, console),
 * reuses the same engine + draft store + apply pipeline, and exposes the
 * same edit + apply contract as the in-page workbench.
 *
 * Public API (window.AesAfpRouteBuilderModal):
 *   open({server, airline, aircraftId?, hub?, defaultIatas?, defaultFlights?})
 *     → Promise<{applied, cancelled, plannerResult, payload}>
 *   close()
 *   _internal — pure helpers used by audit-jihwan tests:
 *     parseIataList(text)                → [iata, ...]
 *     materialiseLegs(build, draft)      → leg[]
 *     buildApplyPayload(state)           → {ctx, legs}
 *     defaultConfig(overrides)           → planner config object
 *
 * Reuses (no production-code edits required):
 *   AesAfpRouteBuilderPlanner.recommend  — engine
 *   AesAfpActiveDraftStore.setEdit       — per-leg HH:MM + dayMask edits
 *   AesAfpAutoApplyBatch.start           — fan-out to background submit queue
 *   AesFleetRoster.loadCurrent           — aircraft picker
 *   FlightsFromStore.loadAirport         — destination candidates per hub
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesAfpRouteBuilderModal) return

    const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    const DEFAULT_FLIGHTS  = 4
    const DEFAULT_TURN_MIN = 45
    const DEFAULT_DEPART   = "06:00"
    const ESTIMATED_SECONDS_PER_LEG = 18
    const TOP_ROUTES_PREFIX = "routeAssistant:topRoutes"

    let _modalEl = null
    let _onKey   = null
    let _resolve = null
    let _state   = null

    // ─────────────────────────────────────────────────────────────────
    // Pure helpers — exposed via _internal for tests.
    // ─────────────────────────────────────────────────────────────────

    function _normaliseIata(value) {
        const s = String(value || "").trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : ""
    }

    function _parseIataList(value) {
        const seen = new Set()
        const out = []
        for (const part of String(value || "").split(/[\s,;]+/)) {
            const iata = _normaliseIata(part)
            if (!iata || seen.has(iata)) continue
            seen.add(iata)
            out.push(iata)
        }
        return out
    }

    function _singleDayMask(dayIdx) {
        const out = [0, 0, 0, 0, 0, 0, 0]
        out[((Number(dayIdx) || 0) % 7 + 7) % 7] = 1
        return out
    }

    function _dayFromMask(mask, fallback) {
        if (Array.isArray(mask)) {
            for (let i = 0; i < mask.length; i++) if (mask[i]) return i
        }
        return Number.isFinite(fallback) ? fallback : 0
    }

    function _legDayMask(eff) {
        if (Array.isArray(eff && eff.dayMask)) return eff.dayMask.slice()
        return [1, 0, 0, 0, 0, 0, 0]
    }

    function _defaultConfig(overrides) {
        const o = overrides || {}
        return Object.assign({
            includedIatas:        [],
            airportCount:         0,
            targetFlights:        DEFAULT_FLIGHTS,
            baseDeparture:        DEFAULT_DEPART,
            startDayIdx:          0,
            turnaroundMin:        DEFAULT_TURN_MIN,
            longGapMin:           120,
            shortGapMin:          45,
            staggerMin:           73,
            longHaulThresholdNm:  3500,
            latestLongHaulDeparture: "18:00",
            sequentialLongHaul:   true,
            hideScheduled:        true
        }, o)
    }

    function _num(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    function _maxNum() {
        let best = null
        for (let i = 0; i < arguments.length; i++) {
            const n = _num(arguments[i])
            if (n == null) continue
            best = best == null ? n : Math.max(best, n)
        }
        return best
    }

    function _firstNum() {
        for (let i = 0; i < arguments.length; i++) {
            const n = _num(arguments[i])
            if (n != null) return n
        }
        return null
    }

    function _firstText() {
        for (let i = 0; i < arguments.length; i++) {
            const s = String(arguments[i] || "").trim()
            if (s) return s
        }
        return null
    }

    function _pairKey(hub, dest) {
        return _normaliseIata(hub) + "-" + _normaliseIata(dest)
    }

    function _routePairFromString(value) {
        const matches = String(value || "").toUpperCase().match(/[A-Z]{3}-[A-Z]{3}/g)
        if (!matches || !matches.length) return null
        const parts = matches[matches.length - 1].split("-")
        return {hub: parts[0], dest: parts[1]}
    }

    function _keyAccountId(key) {
        const m = /:acct:([^:]+):/.exec(String(key || ""))
        return m ? m[1] : null
    }

    function _keyMatchesCurrentAccount(key, rec) {
        const acct = (typeof window !== "undefined" && window.__aesAccountId) || null
        const keyAcct = _keyAccountId(key)
        if (keyAcct) return !!acct && keyAcct === acct
        if (rec && rec.accountId) return !!acct && String(rec.accountId) === String(acct)
        return true
    }

    function _recordMatchesServer(rec, server) {
        return !server || !rec || !rec.server || String(rec.server) === String(server)
    }

    function _distanceKmFromRecord(rec) {
        const km = _num(rec && (rec.distanceKm || rec.distance))
        if (km != null && km > 0) return km
        const nm = _num(rec && rec.distanceNm)
        if (nm != null && nm > 0) {
            if (typeof ScheduleFactors !== "undefined" && ScheduleFactors.nmToKm) {
                return ScheduleFactors.nmToKm(nm)
            }
            return Math.round(nm * 1.852)
        }
        return null
    }

    function _candidateSortScore(c) {
        return _maxNum(
            c && c.scoreBlend,
            c && c.score,
            c && c.actualProfitPerWeek != null ? Math.max(0, Number(c.actualProfitPerWeek) / 1000) : null,
            c && c.competitorCount != null ? 80 - Number(c.competitorCount) : null,
            c && c.paxScore != null ? Number(c.paxScore) * 10 : null,
            c && c.weeklyFlights
        ) || 0
    }

    function _noteCandidateSource(row, source) {
        if (!row || !source) return
        const sources = Array.isArray(row.sources) ? row.sources.slice() : []
        if (sources.indexOf(source) < 0) sources.push(source)
        row.sources = sources
        row.sourceSummary = sources.join(" + ") || row.sourceSummary || source
    }

    function _directionalPairKey(hub, dest) {
        return _normaliseIata(hub) + "-" + _normaliseIata(dest)
    }

    function _distancePairKey(hub, dest) {
        const h = _normaliseIata(hub)
        const d = _normaliseIata(dest)
        return h < d ? h + "-" + d : d + "-" + h
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

    function _median(values, cls) {
        const vals = (values || []).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b)
        if (!vals.length) return null
        const mid = Math.floor(vals.length / 2)
        const raw = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
        return _roundPriceForClass(cls, raw)
    }

    function _competitorStats(rec) {
        const all = rec && Array.isArray(rec.competitors) ? rec.competitors : []
        const byClass = {Y: [], C: [], F: [], Cargo: []}
        const prefixes = new Map()
        for (const c of all) {
            if (!c || c.isOurs) continue
            const cls = _competitorClass(c)
            const price = _competitorPrice(c, cls)
            if (cls && isFinite(price) && price > 0) byClass[cls].push(price)
            if (c.flightCode) {
                const m = /^([A-Z0-9]+)/.exec(String(c.flightCode).trim().toUpperCase())
                if (m) {
                    const p = m[1]
                    const slot = prefixes.get(p) || {prefix: p, flights: 0, sampleType: c.typeCode || null}
                    slot.flights += 1
                    if (!slot.sampleType && c.typeCode) slot.sampleType = c.typeCode
                    prefixes.set(p, slot)
                }
            }
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
            competitorCountsByClass: counts,
            competitorFlightPrefixes: Array.from(prefixes.values())
        }
    }

    function _ourEnterpriseIdsFromDom() {
        const ids = new Set()
        try {
            for (const a of document.querySelectorAll(".as-navbar-main a[href*='dashboard?select=']")) {
                const m = /select=(\d+)/.exec(a.getAttribute("href") || "")
                if (m) ids.add(parseInt(m[1], 10))
            }
        } catch (_) { /* ignore */ }
        return ids
    }

    function _ourAirlineNameLow() {
        try {
            const name = (typeof AES !== "undefined" && AES.getAirlineIdentity)
                ? AES.getAirlineIdentity() : ""
            return String(name || "").toLowerCase().trim()
        } catch (_) {
            return ""
        }
    }

    function _sumPctValid(arr) {
        if (!Array.isArray(arr) || !arr.length) return null
        let sum = 0
        let seen = 0
        for (const e of arr) {
            if (typeof e.sharePct === "number" && isFinite(e.sharePct)) {
                sum += e.sharePct
                seen++
            }
        }
        return seen ? sum : null
    }

    function _isOurMarketShareEntry(e, ourEnterpriseIds, ourNameLow) {
        if (!e) return false
        if (e.enterpriseId != null && ourEnterpriseIds && ourEnterpriseIds.has(e.enterpriseId)) return true
        return !!(ourNameLow && e.name && e.name.toLowerCase().trim() === ourNameLow)
    }

    function _candidateSourceLabel(raw, fallback) {
        return _firstText(raw && raw.sourceLabel, raw && raw.demandSource,
            raw && raw.source, fallback, "cached route intel")
    }

    function _mergeCandidateSources(sourceGroups, opts) {
        const hub = _normaliseIata(opts && opts.hub)
        const scheduledDestSet = (opts && opts.scheduledDestSet) || new Set()
        const scheduledCounts = (opts && opts.scheduledCounts) || new Map()
        const byDest = new Map()

        const add = (raw, fallbackSource) => {
            const dest = _normaliseIata(raw && (raw.destIata || raw.iata
                || raw.dest || raw.destination || raw.airportIata))
            if (!dest || dest === hub) return
            const cur = byDest.get(dest) || {
                destIata: dest,
                sources: [],
                _sourceSet: new Set()
            }
            const source = _candidateSourceLabel(raw, fallbackSource)
            if (source && !cur._sourceSet.has(source)) {
                cur._sourceSet.add(source)
                cur.sources.push(source)
            }

            cur.destName = _firstText(cur.destName, raw && (raw.destName || raw.name || raw.destinationName))
            cur.distanceKm = _maxNum(cur.distanceKm, _distanceKmFromRecord(raw))
            cur.distanceNm = _maxNum(cur.distanceNm, raw && raw.distanceNm)
            cur.weeklyFlights = _maxNum(cur.weeklyFlights, raw && raw.weeklyFlights)
            cur.seatsPerWeek = _maxNum(cur.seatsPerWeek, raw && raw.seatsPerWeek)
            cur.airlineCount = _maxNum(cur.airlineCount,
                raw && (raw.airlineCount != null ? raw.airlineCount
                    : (Array.isArray(raw.airlines) ? raw.airlines.length : null)))
            cur.paxScore = _maxNum(cur.paxScore, raw && raw.paxScore)
            cur.cargoScore = _maxNum(cur.cargoScore, raw && raw.cargoScore)
            cur.score = _maxNum(cur.score, raw && raw.score)
            cur.scoreBlend = _maxNum(cur.scoreBlend, raw && raw.scoreBlend, raw && raw.score)
            cur.demandSource = _firstText(cur.demandSource, raw && raw.demandSource, source)
            cur.demandBasis = _firstText(cur.demandBasis, raw && raw.demandBasis, raw && raw.status)
            cur.suggestedDepTime = _firstText(cur.suggestedDepTime, raw && raw.suggestedDepTime, raw && raw.departureTime)
            cur.status = _firstText(cur.status, raw && raw.status)
            cur.alreadyScheduled = cur.alreadyScheduled || scheduledDestSet.has(dest) || !!(raw && raw.alreadyScheduled)
            cur.scheduledFlights = _maxNum(cur.scheduledFlights, scheduledCounts.get(dest), raw && raw.scheduledFlights)
            byDest.set(dest, cur)
        }

        for (const group of Array.isArray(sourceGroups) ? sourceGroups : []) {
            const routes = group && Array.isArray(group.routes) ? group.routes : []
            for (const r of routes) add(r, group && group.label)
        }

        return Array.from(byDest.values()).map(c => {
            delete c._sourceSet
            if (c.scoreBlend == null) c.scoreBlend = _candidateSortScore(c)
            if (c.score == null) c.score = c.scoreBlend
            c.sourceSummary = c.sources.join(" + ") || c.demandSource || "cached route intel"
            return c
        }).sort((a, b) => {
            if (!!a.alreadyScheduled !== !!b.alreadyScheduled) return a.alreadyScheduled ? 1 : -1
            return _candidateSortScore(b) - _candidateSortScore(a)
                || String(a.destIata).localeCompare(String(b.destIata))
        })
    }

    function _addScheduledLeg(info, origin, destination, flightId) {
        const hub = _normaliseIata(info && info.hub)
        const a = _normaliseIata(origin)
        const b = _normaliseIata(destination)
        if (!hub || (!a && !b)) return
        const dests = []
        if (a === hub && b && b !== hub) dests.push(b)
        else if (b === hub && a && a !== hub) dests.push(a)
        else {
            if (a && a !== hub) dests.push(a)
            if (b && b !== hub) dests.push(b)
        }
        for (const d of dests) {
            info.destSet.add(d)
            info.counts.set(d, (info.counts.get(d) || 0) + 1)
        }
        if (flightId != null) info.flightIds.add(String(flightId))
    }

    function _scheduledInfoFromSchedule(schedule, hub) {
        const info = {
            hub: _normaliseIata(hub),
            destSet: new Set(),
            counts: new Map(),
            flightIds: new Set(),
            flightCount: 0,
            scrapedAt: schedule && schedule.scrapedAt || null,
            source: schedule ? "schedule-store" : null
        }
        const legs = schedule && Array.isArray(schedule.legs) ? schedule.legs : []
        for (const leg of legs) {
            _addScheduledLeg(info, leg && leg.origin, leg && leg.destination, leg && leg.flightId)
        }
        info.flightCount = legs.length
        return info
    }

    function _latestRouteAnalysis(rec) {
        const dateBlock = rec && rec.date
        if (!dateBlock || typeof dateBlock !== "object") return null
        const dates = Object.keys(dateBlock).sort()
        for (let i = dates.length - 1; i >= 0; i--) {
            const entry = dateBlock[dates[i]]
            if (entry && entry.data) return entry.data
        }
        return null
    }

    function _fieldsFromCachedRouteRecord(rec, key) {
        const fields = {
            source: "AS in-game cache",
            demandSource: "AS in-game cache",
            demandBasis: "Cached Route Assistant record"
        }
        if (!rec || typeof rec !== "object") return fields
        if (rec.destName || rec.name || rec.destinationName) {
            fields.destName = rec.destName || rec.name || rec.destinationName
        }
        if (_distanceKmFromRecord(rec) != null) fields.distanceKm = _distanceKmFromRecord(rec)
        if (rec.distanceNm != null) fields.distanceNm = _num(rec.distanceNm)
        if (rec.weeklyFlights != null) fields.weeklyFlights = _num(rec.weeklyFlights)
        if (rec.seatsPerWeek != null) fields.seatsPerWeek = _num(rec.seatsPerWeek)
        if (rec.departureTime) fields.suggestedDepTime = String(rec.departureTime)
        if (rec.score != null) fields.score = _num(rec.score)
        if (rec.scoreBlend != null) fields.scoreBlend = _num(rec.scoreBlend)
        if (rec.paxScore != null) fields.paxScore = _num(rec.paxScore)
        if (rec.cargoScore != null) fields.cargoScore = _num(rec.cargoScore)

        if (/ticketPrice/.test(key)) {
            fields.source = "ticket-price cache"
            fields.demandSource = "ticket-price cache"
            fields.demandBasis = "Cached ticket-price route"
            fields.paxScore = fields.paxScore != null ? fields.paxScore : 5
            fields.score = fields.score != null ? fields.score : fields.paxScore * 10
        } else if (/ownPricing|markets:ownPricing/.test(key)) {
            fields.source = "pricing cache"
            fields.demandSource = "pricing cache"
            fields.demandBasis = "Cached own-pricing route"
            fields.paxScore = fields.paxScore != null ? fields.paxScore : 5
            fields.score = fields.score != null ? fields.score : 50
        } else if (/routeAnalysis/.test(key) || rec.type === "routeAnalysis") {
            const latest = _latestRouteAnalysis(rec)
            if (latest) {
                const y = latest.Y && Number(latest.Y.totalBkd) && Number(latest.Y.totalCap)
                    ? Math.round((Number(latest.Y.totalBkd) / Number(latest.Y.totalCap)) * 10) : null
                const c = latest.Cargo && Number(latest.Cargo.totalBkd) && Number(latest.Cargo.totalCap)
                    ? Math.round((Number(latest.Cargo.totalBkd) / Number(latest.Cargo.totalCap)) * 10) : null
                fields.paxScore = Number.isFinite(y) ? Math.max(1, Math.min(10, y)) : 6
                fields.cargoScore = Number.isFinite(c) ? Math.max(1, Math.min(10, c)) : fields.cargoScore || null
                fields.score = fields.paxScore * 10
                fields.source = "route analysis"
                fields.demandSource = "route analysis"
                fields.demandBasis = "Cached booking/load analysis"
            }
        }
        return fields
    }

    /**
     * Mirror of preview-panel.js:_materialiseLegs (the production confirm
     * modal's payload builder). Overlays draft.perLegEdits on top of the
     * planner's flights so the user's edited HH:MM + dayMask reach
     * AesAfpAutoApplyBatch.start. Kept aligned with the production helper —
     * if that drifts (e.g. new fields), update both.
     */
    function _materialiseLegs(build, draft, settings) {
        const flights = (build && build.flights) || []
        const overlays = (draft && draft.perLegEdits) || {}
        const dpct = (settings && isFinite(Number(settings.defaultPricePct)))
            ? Number(settings.defaultPricePct) : 100
        const dsvc = (settings && typeof settings.defaultService === "string")
            ? settings.defaultService : ""
        const out = []
        for (const f of flights) {
            const o = overlays[f.seq] || {}
            const eff = Object.assign({}, f, o)
            out.push({
                seq:         f.seq,
                waveId:      f.waveId,
                waveLabel:   f.waveLabel,
                direction:   eff.direction || f.direction,
                origin:      eff.origin      || f.origin      || null,
                destination: eff.destination || f.destination || null,
                depTime:     eff.depTimeLocal || f.depTimeLocal || null,
                distanceNm:  f.distanceNm,
                pricePct:    isFinite(Number(eff.pricePct)) ? Number(eff.pricePct) : dpct,
                service:     (typeof eff.service === "string") ? eff.service : dsvc,
                dayMask:     _legDayMask(eff)
            })
        }
        return out
    }

    /**
     * Build the {ctx, legs} payload that AesAfpAutoApplyBatch.start consumes.
     * Pure — no I/O. The materialised legs reflect any per-leg edits the
     * user has made in the modal, with the planner's recommendation as the
     * fallback for fields the user hasn't touched.
     */
    function _buildApplyPayload(state) {
        const s = state || {}
        const build = s.plannerResult && s.plannerResult.build
        const draft = s.draft || null
        const legs = _materialiseLegs(build, draft, s.settings || null)
            .filter(l => l.origin && l.destination && l.depTime)
        return {
            ctx: {
                server:     s.server,
                aircraftId: s.aircraftId,
                currentLocationIata: s.hub
            },
            legs:    legs,
            preset:  build && build.preset || null,
            source:  "route-builder-modal"
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Modal lifecycle.
    // ─────────────────────────────────────────────────────────────────

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
        _state = null
        if (r) r(payload || {applied: false, cancelled: true})
    }

    async function _open(opts) {
        const o = opts || {}
        _close({applied: false, cancelled: true})
        if (typeof document === "undefined" || !document.body) {
            return {applied: false, cancelled: true, error: "no document.body"}
        }

        _state = {
            server:        String(o.server || _resolveServer() || ""),
            airline:       String(o.airline || _resolveAirline() || ""),
            aircraftId:    o.aircraftId ? String(o.aircraftId) : null,
            registration:  o.registration || null,
            hub:           _normaliseIata(o.hub) || null,
            spec:          o.spec || null,
            settings:      o.settings || null,
            config:        _defaultConfig({
                includedIatas: Array.isArray(o.defaultIatas) ? o.defaultIatas.map(_normaliseIata).filter(Boolean) : [],
                targetFlights: Number(o.defaultFlights) || DEFAULT_FLIGHTS
            }),
            candidates:    [],
            candidateSourceSummary: null,
            scheduledInfo: null,
            plannerResult: null,
            draft:         null,
            running:       false,
            error:         null
        }

        const overlay = _buildShell()
        document.body.appendChild(overlay)
        _modalEl = overlay

        _onKey = (e) => { if (e.key === "Escape") _close({applied: false, cancelled: true}) }
        document.addEventListener("keydown", _onKey)

        await _hydrateAircraft()
        await _hydrateCandidates()
        await _hydrateDraft()
        _renderBody()

        return new Promise(resolve => { _resolve = resolve })
    }

    function _resolveServer() {
        try { return window.AES && window.AES.getServerName && window.AES.getServerName() }
        catch (_) { return null }
    }

    function _resolveAirline() {
        try {
            const code = window.AES && window.AES.getAirlineCode && window.AES.getAirlineCode()
            return (code && code.code) || (code && typeof code === "string" ? code : "")
        } catch (_) { return null }
    }

    async function _hydrateAircraft() {
        if (_state.aircraftId && _state.hub) return
        if (typeof window.AesFleetRoster === "undefined") return
        let fleet
        try { fleet = await window.AesFleetRoster.loadCurrent() }
        catch (_) { fleet = null }
        if (!fleet || !Array.isArray(fleet.aircraft) || !fleet.aircraft.length) return
        if (!_state.aircraftId) {
            const first = fleet.aircraft[0]
            _state.aircraftId  = String(first.aircraftId)
            _state.registration = first.registration || null
            if (!_state.hub) _state.hub = _normaliseIata(first.location) || null
        } else {
            const match = fleet.aircraft.find(a => String(a.aircraftId) === String(_state.aircraftId))
            if (match) {
                _state.registration = _state.registration || match.registration || null
                if (!_state.hub) _state.hub = _normaliseIata(match.location) || null
            }
        }
        _state._fleet = fleet
    }

    async function _hydrateCandidates() {
        _state.candidates = []
        _state.candidateSourceSummary = null
        _state.scheduledInfo = null
        if (!_state.hub) return

        const scheduledInfo = await _loadScheduledInfo()
        _state.scheduledInfo = scheduledInfo

        const ffRoutes = await _loadFlightsFromRoutes(_state.hub)
        const cachedRoutes = await _loadCachedRouteRows(_state.hub, _state.server)
        const merged = _mergeCandidateSources([
            {label: "FlightsFrom", routes: ffRoutes},
            {label: "AS in-game", routes: cachedRoutes}
        ], {
            hub: _state.hub,
            scheduledDestSet: scheduledInfo.destSet,
            scheduledCounts: scheduledInfo.counts
        })
        _state.candidates = await _enrichCandidatesFromRouteAssistantCaches(merged, _state.hub)
        _state.candidateSourceSummary = _summariseCandidateSources(_state.candidates, scheduledInfo)
    }

    async function _loadFlightsFromRoutes(hub) {
        if (typeof window.FlightsFromStore === "undefined") return []
        if (typeof window.FlightsFromStore.loadAirport !== "function") return []
        try {
            const rec = await window.FlightsFromStore.loadAirport(hub)
            if (!rec || !Array.isArray(rec.routes)) return []
            return rec.routes.map(r => Object.assign({}, r, {
                destIata: _normaliseIata(r && (r.destIata || r.iata)),
                source: "FlightsFrom",
                demandSource: r && r.demandSource || "FlightsFrom"
            })).filter(r => r.destIata && r.destIata !== hub)
        } catch (_) {
            return []
        }
    }

    async function _loadCachedRouteRows(hub, server) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return []
        const h = _normaliseIata(hub)
        if (!h) return []
        let all = {}
        try { all = await chrome.storage.local.get(null) || {} }
        catch (_) { return [] }

        const rows = []
        const push = (dest, fields) => {
            const d = _normaliseIata(dest)
            if (!d || d === h) return
            rows.push(Object.assign({destIata: d}, fields || {}))
        }

        for (const key in all) {
            const rec = all[key]
            if (!rec || typeof rec !== "object") continue
            if (!_keyMatchesCurrentAccount(key, rec) || !_recordMatchesServer(rec, server)) continue

            if (key.indexOf(TOP_ROUTES_PREFIX) === 0
                    && _normaliseIata(rec.hub) === h
                    && Array.isArray(rec.rows)) {
                for (const row of rec.rows) {
                    push(row && row.destIata, Object.assign({}, row, {
                        source: "Route Assistant top routes",
                        demandSource: row && row.demandSource || "Route Assistant top routes",
                        demandBasis: row && row.demandBasis || "AS top-routes cache"
                    }))
                }
                continue
            }

            if (/^routeAssistant:watchlist(?::|$)/.test(key)
                    && rec.routes && typeof rec.routes === "object") {
                for (const routeKey of Object.keys(rec.routes)) {
                    const pair = _routePairFromString(routeKey)
                    if (pair && pair.hub === h) push(pair.dest, {
                        paxScore: 5,
                        score: 50,
                        source: "watchlist",
                        demandSource: "watchlist",
                        demandBasis: "Route Assistant watchlist"
                    })
                }
                continue
            }

            const recHub = _normaliseIata(rec.hub || rec.origin || rec.originIata)
            const recDest = _normaliseIata(rec.dest || rec.destIata || rec.destination || rec.destinationIata)
            if (recHub === h && recDest) {
                push(recDest, _fieldsFromCachedRouteRecord(rec, key))
                continue
            }

            const pair = _routePairFromString(key)
            if (pair && pair.hub === h) {
                push(pair.dest, _fieldsFromCachedRouteRecord(rec, key))
            }
        }
        return rows
    }

    async function _enrichCandidatesFromRouteAssistantCaches(rows, hub) {
        if (!Array.isArray(rows) || !rows.length) return []
        const hubIata = _normaliseIata(hub)
        const iatas = Array.from(new Set(rows.map(r => _normaliseIata(r && r.destIata)).filter(Boolean)))
        const pairs = iatas.map(dest => ({hub: hubIata, dest}))

        const demandMap  = await _loadDemandMap(iatas)
        const distMap    = await _loadDistanceMap(hubIata, iatas)
        const scheduleMap = await _loadScheduleRouteMap(pairs)
        const marketsMap = await _loadMarketsRouteMap(pairs)
        const yieldMap   = await _loadYieldHistoryRouteMap(pairs)

        const ourEnterpriseIds = _ourEnterpriseIdsFromDom()
        const ourNameLow = _ourAirlineNameLow()

        return rows.map(row => {
            const dest = _normaliseIata(row && row.destIata)
            const pair = _directionalPairKey(hubIata, dest)
            const distPair = _distancePairKey(hubIata, dest)
            const demand = demandMap.get(dest)
            const dist = distMap.get(distPair)
            const next = Object.assign({}, row)

            if (next.distanceKm == null && dist && _num(dist.distanceKm) != null) {
                next.distanceKm = _num(dist.distanceKm)
                next.distanceSource = dist.source || "distance cache"
                _noteCandidateSource(next, "distance cache")
            }
            if (demand) _projectDemandRecord(next, demand)
            _projectScheduleRecord(next, scheduleMap.get(pair))
            _projectMarketsBucket(next, marketsMap.get(pair), ourEnterpriseIds, ourNameLow)
            _projectYieldHistoryRecord(next, yieldMap.get(pair))

            next.scoreBlend = _candidateSortScore(next)
            next.score = next.score == null ? next.scoreBlend : next.score
            return next
        }).sort((a, b) => {
            if (!!a.alreadyScheduled !== !!b.alreadyScheduled) return a.alreadyScheduled ? 1 : -1
            return _candidateSortScore(b) - _candidateSortScore(a)
                || String(a.destIata).localeCompare(String(b.destIata))
        })
    }

    async function _loadDemandMap(iatas) {
        if (!iatas.length || typeof window.RouteAssistantDemandStore === "undefined"
                || typeof window.RouteAssistantDemandStore.getMany !== "function") return new Map()
        try { return await window.RouteAssistantDemandStore.getMany(iatas) || new Map() }
        catch (_) { return new Map() }
    }

    async function _loadDistanceMap(hub, iatas) {
        if (!iatas.length || typeof window.RouteAssistantDistanceResolver === "undefined"
                || typeof window.RouteAssistantDistanceResolver.bulkLoadCache !== "function") return new Map()
        try {
            return await window.RouteAssistantDistanceResolver.bulkLoadCache(
                iatas.map(dest => [hub, dest]), {}
            ) || new Map()
        } catch (_) { return new Map() }
    }

    async function _loadScheduleRouteMap(pairs) {
        if (!pairs.length || typeof window.RouteAssistantSchedulePageScraper === "undefined"
                || typeof window.RouteAssistantSchedulePageScraper.bulkLoadCache !== "function") return new Map()
        try { return await window.RouteAssistantSchedulePageScraper.bulkLoadCache(pairs, {}) || new Map() }
        catch (_) { return new Map() }
    }

    async function _loadMarketsRouteMap(pairs) {
        if (!pairs.length || typeof window.RouteAssistantMarketsPageScraper === "undefined"
                || typeof window.RouteAssistantMarketsPageScraper.bulkLoadCache !== "function") return new Map()
        try {
            return await window.RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {
                families: ["competitors", "ownPricing", "marketShare", "historic"]
            }) || new Map()
        } catch (_) { return new Map() }
    }

    async function _loadYieldHistoryRouteMap(pairs) {
        if (!pairs.length || typeof window.RouteAssistantYieldHistoryStore === "undefined"
                || typeof window.RouteAssistantYieldHistoryStore.getMany !== "function") return new Map()
        try { return await window.RouteAssistantYieldHistoryStore.getMany(pairs) || new Map() }
        catch (_) { return new Map() }
    }

    function _projectDemandRecord(row, demand) {
        if (!row || !demand) return
        row.destName = _firstText(row.destName, demand.name)
        row.paxScore = _maxNum(row.paxScore, demand.paxScore)
        row.cargoScore = _maxNum(row.cargoScore, demand.cargoScore)
        row.demandSource = _firstText(row.demandSource, "AS demand")
        row.demandBasis = _firstText(row.demandBasis, "AS in-game demand bars")
        if (row.scoreBlend == null || row.scoreBlend < Number(demand.paxScore || 0) * 10) {
            row.scoreBlend = Number(demand.paxScore || 0) * 10
        }
        _noteCandidateSource(row, "AS demand")
    }

    function _projectScheduleRecord(row, rec) {
        if (!row || !rec) return
        const weekly = _num(rec.weeklyFlights)
        row.liveWeeklyFlights = weekly
        row.liveDaysPerWeek = _num(rec.daysPerWeek)
        row.liveDailyFlights = Array.isArray(rec.dailyFlights) ? rec.dailyFlights.slice() : null
        row.liveDeparture = _firstText(rec.departureTime, row.liveDeparture)
        row.liveAircraftType = _firstText(rec.primaryAircraftType, row.liveAircraftType)
        row.liveAircraftTypeId = _firstNum(rec.primaryAircraftTypeId, row.liveAircraftTypeId)
        row.liveAircraftReg = _firstText(rec.primaryAircraftReg, row.liveAircraftReg)
        row.liveCruiseSpeed = _firstNum(rec.cruiseSpeedKmh, row.liveCruiseSpeed)
        row.liveScrapedAt = _firstNum(rec.scrapedAt, row.liveScrapedAt)
        if (weekly != null && weekly > 0) {
            row.ownRouteFrequency = weekly
            row.scheduledFlights = _maxNum(row.scheduledFlights, weekly)
        }
        if (rec.ourPrice != null) row.ourPrice = _num(rec.ourPrice)
        if (rec.ourYield != null) row.ourYield = _num(rec.ourYield)
        if (rec.orsRank != null) row.orsRank = _num(rec.orsRank)
        _noteCandidateSource(row, "AS schedule")
    }

    function _projectMarketsBucket(row, bucket, ourEnterpriseIds, ourNameLow) {
        if (!row || !bucket) return
        row.marketsScrapedAt = _firstNum(
            bucket.competitors && bucket.competitors.scrapedAt,
            bucket.marketShare && bucket.marketShare.scrapedAt,
            bucket.ownPricing && bucket.ownPricing.scrapedAt,
            row.marketsScrapedAt
        )

        if (bucket.marketShare) {
            _projectMarketShare(row, bucket.marketShare, ourEnterpriseIds, ourNameLow)
            _noteCandidateSource(row, "AS market share")
        }
        if (bucket.ownPricing) {
            row.ownPricing = bucket.ownPricing.prices || null
            row.ownPriceDefaults = bucket.ownPricing.defaults || null
            row.hasOwnPricing = !!(row.ownPricing && Object.keys(row.ownPricing).length)
            row.serviceProfileName = bucket.ownPricing.generalSettings
                && bucket.ownPricing.generalSettings.serviceProfile || row.serviceProfileName || null
            row.originTerminal = bucket.ownPricing.generalSettings
                && bucket.ownPricing.generalSettings.originTerminal || row.originTerminal || null
            row.destinationTerminal = bucket.ownPricing.generalSettings
                && bucket.ownPricing.generalSettings.destinationTerminal || row.destinationTerminal || null
            _noteCandidateSource(row, "AS pricing")
        }
        if (bucket.competitors) {
            const stats = _competitorStats(bucket.competitors)
            Object.assign(row, stats)
            if (row.competitorCount == null) {
                const count = stats.competitorFlightPrefixes && stats.competitorFlightPrefixes.length
                row.competitorCount = count || null
            }
            if ((!Array.isArray(row.competitorEntries) || !row.competitorEntries.length)
                    && stats.competitorFlightPrefixes && stats.competitorFlightPrefixes.length) {
                row.competitorEntries = stats.competitorFlightPrefixes.map(slot => ({
                    enterpriseId: null,
                    name: slot.prefix + "  -  " + slot.flights + " flight" + (slot.flights === 1 ? "" : "s"),
                    flightsOnRoute: slot.flights,
                    sampleType: slot.sampleType,
                    fromFlightList: true
                }))
            }
            _noteCandidateSource(row, "AS competitors")
        }
        if (bucket.historic) {
            row.historicPeriods = bucket.historic.periods || null
            row.historicCapacities = bucket.historic.capacities || null
            row.historicPrices = bucket.historic.prices || null
            _noteCandidateSource(row, "AS historic")
        }
    }

    function _projectMarketShare(row, marketShare, ourEnterpriseIds, ourNameLow) {
        row.marketSharePeriod = marketShare.period || null
        row.marketSharePax = (marketShare.pax || []).map(e => Object.assign({}, e))
        row.marketShareCargo = (marketShare.cargo || []).map(e => Object.assign({}, e))

        let ourPaxShare = null
        for (const e of row.marketSharePax) {
            if (_isOurMarketShareEntry(e, ourEnterpriseIds, ourNameLow)) {
                ourPaxShare = e.sharePct
                break
            }
        }
        row.ourPaxShare = ourPaxShare

        const paxSum = _sumPctValid(row.marketSharePax)
        const cargoSum = _sumPctValid(row.marketShareCargo)
        row.marketSharePaxSumPct = paxSum
        row.marketShareCargoSumPct = cargoSum
        row.marketShareValidity = paxSum == null ? null
            : (ourPaxShare == null && row.marketSharePax.length > 0) ? "unmatched"
            : (paxSum >= 95 && paxSum <= 105) ? "ok"
            : paxSum >= 80 ? "partial" : "truncated"

        const ids = new Set()
        const merged = new Map()
        const addEntry = (e, kind) => {
            if (!e || _isOurMarketShareEntry(e, ourEnterpriseIds, ourNameLow)) return
            const key = e.enterpriseId != null ? "id:" + e.enterpriseId
                : "name:" + String(e.name || "").toLowerCase().trim()
            if (!key || key === "name:") return
            ids.add(key)
            const slot = merged.get(key) || {
                enterpriseId: e.enterpriseId != null ? e.enterpriseId : null,
                name: e.name || null,
                paxShare: null,
                cargoShare: null,
                paxRank: null,
                cargoRank: null,
                paxChange: null,
                cargoChange: null
            }
            if (e.name && !slot.name) slot.name = e.name
            if (kind === "pax") {
                slot.paxShare = e.sharePct
                slot.paxRank = e.rank
                slot.paxChange = e.change
            } else {
                slot.cargoShare = e.sharePct
                slot.cargoRank = e.rank
                slot.cargoChange = e.change
            }
            merged.set(key, slot)
        }
        for (const e of row.marketSharePax || []) addEntry(e, "pax")
        for (const e of row.marketShareCargo || []) addEntry(e, "cargo")
        row.competitorCount = ids.size || row.competitorCount || null
        row.competitorEntries = Array.from(merged.values())
    }

    function _projectYieldHistoryRecord(row, rec) {
        if (!row || !rec || !Array.isArray(rec.snapshots) || !rec.snapshots.length) return
        const latest = (typeof window.RouteAssistantYieldHistoryStore !== "undefined"
                && typeof window.RouteAssistantYieldHistoryStore.latestSnapshot === "function")
            ? window.RouteAssistantYieldHistoryStore.latestSnapshot(rec)
            : rec.snapshots[rec.snapshots.length - 1]
        if (!latest) return
        row.actualProfitPerFlight = _firstNum(latest.profitPerFlight, row.actualProfitPerFlight)
        row.actualProfitPerWeek = _firstNum(latest.profitPerWeek, row.actualProfitPerWeek)
        row.actualFrequency = _firstNum(latest.frequency, row.actualFrequency)
        row.actualSnapshotAt = _firstNum(latest.timestamp, rec.lastSnapshotAt, row.actualSnapshotAt)
        if (Array.isArray(latest.aircraftTypeNames) && latest.aircraftTypeNames.length) {
            row.actualAircraftTypes = latest.aircraftTypeNames.slice()
        }
        _noteCandidateSource(row, "AS actuals")
    }

    async function _loadScheduledInfo() {
        let schedule = null
        if (_state.server && _state.aircraftId
                && typeof window.AesAfpScheduleStore !== "undefined"
                && typeof window.AesAfpScheduleStore.load === "function") {
            try { schedule = await window.AesAfpScheduleStore.load(_state.server, _state.aircraftId) }
            catch (_) { schedule = null }
        }
        const info = _scheduledInfoFromSchedule(schedule, _state.hub)
        if (info.flightCount) return info

        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return info
        let all = {}
        try { all = await chrome.storage.local.get(null) || {} }
        catch (_) { return info }
        for (const key in all) {
            const rec = all[key]
            if (!rec || rec.type !== "aircraftFlights" || !Array.isArray(rec.flights)) continue
            if (_state.server && rec.server && String(rec.server) !== String(_state.server)) continue
            if (_state.aircraftId && String(rec.aircraftId) !== String(_state.aircraftId)) continue
            if (_state.registration && rec.registration
                    && String(rec.registration) !== String(_state.registration)) continue
            for (const f of rec.flights) {
                _addScheduledLeg(info, f && f.originIata, f && f.destinationIata, f && f.flightId)
            }
            info.flightCount += rec.flights.length
            info.scrapedAt = rec.date || rec.scrapedAt || info.scrapedAt
            info.source = "aircraft-flights"
        }
        return info
    }

    function _summariseCandidateSources(candidates, scheduledInfo) {
        const sourceCounts = {}
        let inGameRoutes = 0
        let priceRoutes = 0
        let marketRoutes = 0
        let actualRoutes = 0
        for (const c of candidates || []) {
            const sources = c && c.sources && c.sources.length ? c.sources : [c && c.demandSource || "cached route intel"]
            for (const source of sources) sourceCounts[source] = (sourceCounts[source] || 0) + 1
            if (_hasInGameCandidateData(c)) inGameRoutes++
            if (c && (c.hasOwnPricing || c.ownPricing || c.ourPrice != null)) priceRoutes++
            if (c && (c.marketSharePeriod || c.competitorCount != null || c.competitorMedianPriceY != null)) marketRoutes++
            if (c && (c.actualProfitPerFlight != null || c.actualProfitPerWeek != null)) actualRoutes++
        }
        return {
            total: (candidates || []).length,
            sourceCounts,
            inGameRoutes,
            priceRoutes,
            marketRoutes,
            actualRoutes,
            scheduledDestinations: scheduledInfo && scheduledInfo.destSet ? scheduledInfo.destSet.size : 0,
            scheduledFlights: scheduledInfo && scheduledInfo.flightCount || 0,
            scheduledSource: scheduledInfo && scheduledInfo.source || null
        }
    }

    function _hasInGameCandidateData(c) {
        return !!(c && (
            c.liveWeeklyFlights != null || c.ownRouteFrequency != null
            || c.ownPricing || c.hasOwnPricing || c.ourPrice != null
            || c.marketSharePeriod || c.competitorCount != null || c.competitorMedianPriceY != null
            || c.actualProfitPerFlight != null || c.actualProfitPerWeek != null
        ))
    }

    async function _hydrateDraft() {
        _state.draft = null
        if (typeof window.AesAfpActiveDraftStore === "undefined") return
        if (!_state.server || !_state.aircraftId) return
        try {
            _state.draft = await window.AesAfpActiveDraftStore.load(_state.server, _state.aircraftId)
        } catch (_) { _state.draft = null }
    }

    // ─────────────────────────────────────────────────────────────────
    // Rendering.
    // ─────────────────────────────────────────────────────────────────

    function _buildShell() {
        const overlay = document.createElement("div")
        overlay.setAttribute("data-aes-route-builder-modal", "1")
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.78);"
            + "z-index:99999;display:flex;align-items:flex-start;justify-content:center;"
            + "padding:32px 16px;overflow-y:auto;"
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) _close({applied: false, cancelled: true})
        })

        const modal = document.createElement("div")
        modal.style.cssText = "background:#0f1623;color:#e5e7eb;"
            + "border:1px solid #1f2937;border-radius:5px;"
            + "max-width:min(1080px,96vw);width:100%;"
            + "display:flex;flex-direction:column;overflow:hidden;"
            + "font-size:12px;font-family:'Inter',system-ui,sans-serif;"
        overlay.appendChild(modal)

        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;gap:8px;"
            + "padding:12px 16px;border-bottom:1px solid #1f2937;background:#111827;"
        const title = document.createElement("div")
        title.style.cssText = "font-weight:700;font-size:14px;color:#f3f4f6;flex:1;"
        title.textContent = "Route builder — pick airports → mock schedule → apply"
        header.appendChild(title)
        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "×"
        close.style.cssText = "background:transparent;color:#9ca3af;border:0;"
            + "font-size:20px;line-height:1;cursor:pointer;padding:0 6px;"
        close.title = "Close (Esc)"
        close.addEventListener("click", () => _close({applied: false, cancelled: true}))
        header.appendChild(close)
        modal.appendChild(header)

        const body = document.createElement("div")
        body.setAttribute("data-aes-rb-body", "1")
        body.style.cssText = "padding:14px 16px;display:flex;flex-direction:column;gap:12px;"
        modal.appendChild(body)

        return overlay
    }

    function _renderBody() {
        if (!_modalEl) return
        const body = _modalEl.querySelector("[data-aes-rb-body]")
        if (!body) return
        body.textContent = ""

        body.appendChild(_renderContextBar())
        body.appendChild(_renderConfigBar())
        body.appendChild(_renderAirportPicker())
        body.appendChild(_renderActions())
        if (_state.error) {
            const err = document.createElement("div")
            err.style.cssText = "color:#fca5a5;font-size:12px;"
            err.textContent = _state.error
            body.appendChild(err)
        }
        if (_state.plannerResult && _state.plannerResult.rows && _state.plannerResult.rows.length) {
            body.appendChild(_renderMockSchedule(_state.plannerResult))
            body.appendChild(_renderApplyBar(_state.plannerResult))
        }
    }

    function _renderContextBar() {
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;"
            + "padding:8px 10px;background:#0b1220;border:1px solid #1f2937;border-radius:3px;"

        const acLbl = document.createElement("span")
        acLbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;"
        acLbl.textContent = "Aircraft"
        bar.appendChild(acLbl)

        const fleet = _state._fleet && Array.isArray(_state._fleet.aircraft) ? _state._fleet.aircraft : []
        if (fleet.length) {
            const sel = document.createElement("select")
            sel.style.cssText = _inputCss()
            for (const a of fleet) {
                const opt = document.createElement("option")
                opt.value = String(a.aircraftId)
                opt.textContent = (a.registration || "#" + a.aircraftId)
                    + (a.location ? " @ " + a.location : "")
                    + (a.equipment ? " · " + a.equipment : "")
                if (String(a.aircraftId) === String(_state.aircraftId)) opt.selected = true
                sel.appendChild(opt)
            }
            sel.addEventListener("change", async () => {
                const next = fleet.find(a => String(a.aircraftId) === sel.value)
                if (!next) return
                _state.aircraftId  = String(next.aircraftId)
                _state.registration = next.registration || null
                _state.hub          = _normaliseIata(next.location) || null
                _state.plannerResult = null
                await _hydrateCandidates()
                await _hydrateDraft()
                _renderBody()
            })
            bar.appendChild(sel)
        } else {
            const fallback = document.createElement("input")
            fallback.type = "text"
            fallback.placeholder = "aircraftId"
            fallback.value = _state.aircraftId || ""
            fallback.style.cssText = _inputCss()
            fallback.addEventListener("change", () => { _state.aircraftId = fallback.value.trim() })
            bar.appendChild(fallback)
        }

        const hubLbl = document.createElement("span")
        hubLbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;margin-left:8px;"
        hubLbl.textContent = "Hub"
        bar.appendChild(hubLbl)
        const hub = document.createElement("input")
        hub.type = "text"
        hub.maxLength = 3
        hub.value = _state.hub || ""
        hub.placeholder = "JFK"
        hub.style.cssText = _inputCss() + "width:60px;text-transform:uppercase;"
        hub.addEventListener("change", async () => {
            const v = _normaliseIata(hub.value)
            if (!v) return
            _state.hub = v
            _state.plannerResult = null
            await _hydrateCandidates()
            _renderBody()
        })
        bar.appendChild(hub)

        const ctxInfo = document.createElement("span")
        ctxInfo.style.cssText = "color:#6b7280;font-size:10px;margin-left:auto;"
        ctxInfo.textContent = "server: " + (_state.server || "?") + " · airline: " + (_state.airline || "?")
        bar.appendChild(ctxInfo)
        return bar
    }

    function _renderConfigBar() {
        const bar = document.createElement("div")
        bar.style.cssText = "display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;"
        bar.appendChild(_numberField("Flights", _state.config.targetFlights, 2, 56, 1, v =>
            { _state.config.targetFlights = v; _renderBody() }))
        bar.appendChild(_numberField("Airport count (auto)", _state.config.airportCount, 0, 30, 1, v =>
            { _state.config.airportCount = v; _renderBody() }))
        bar.appendChild(_timeField("Base depart", _state.config.baseDeparture, v =>
            { _state.config.baseDeparture = v; _renderBody() }))
        bar.appendChild(_dayField("First day", _state.config.startDayIdx, v =>
            { _state.config.startDayIdx = v; _renderBody() }))
        bar.appendChild(_numberField("Turnaround (min)", _state.config.turnaroundMin, 20, 360, 5, v =>
            { _state.config.turnaroundMin = v; _renderBody() }))
        return bar
    }

    function _renderAirportPicker() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"

        const lbl = document.createElement("div")
        lbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;"
        lbl.textContent = "Candidate routes - Route Assistant in-game data + FlightsFrom"
        wrap.appendChild(lbl)

        const summary = _renderCandidateSummary()
        if (summary) wrap.appendChild(summary)

        const manual = document.createElement("input")
        manual.type = "text"
        manual.value = _state.config.includedIatas.join(", ")
        manual.placeholder = "Blank = use top scored candidates; or enter JFK, CDG, BOS"
        manual.style.cssText = _inputCss()
        manual.addEventListener("change", () => {
            _state.config.includedIatas = _parseIataList(manual.value)
            _renderBody()
        })
        wrap.appendChild(manual)

        const chips = document.createElement("div")
        chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
        const selected = new Set(_state.config.includedIatas)
        const candidates = _state.candidates.slice()
            .filter(c => !_state.config.hideScheduled || !c.alreadyScheduled || selected.has(c.destIata))
            .sort((a, b) => _candidateSortScore(b) - _candidateSortScore(a)
                || (Number(b.weeklyFlights) || 0) - (Number(a.weeklyFlights) || 0)
                || String(a.destIata).localeCompare(String(b.destIata)))
            .slice(0, 30)
        if (!candidates.length) {
            const empty = document.createElement("span")
            empty.style.cssText = "color:#6b7280;font-style:italic;font-size:11px;"
            empty.textContent = _state.hub
                ? (_state.config.hideScheduled
                    ? "No unscheduled cached candidates for " + _state.hub
                        + ". Turn off Hide scheduled, type IATAs, or scrape Route Assistant data."
                    : "No cached candidates for " + _state.hub
                        + ". Type IATAs above or run a FlightsFrom / Route Assistant scrape first.")
                : "Pick a hub first."
            chips.appendChild(empty)
        }
        for (const c of candidates) {
            const iata = _normaliseIata(c.destIata)
            if (!iata) continue
            const on = selected.has(iata)
            const chip = document.createElement("button")
            chip.type = "button"
            chip.textContent = iata
                + (c.paxScore != null ? " · D" + c.paxScore : (c.weeklyFlights ? " · " + c.weeklyFlights : ""))
                + (c.alreadyScheduled ? " · scheduled" : "")
            chip.title = (c.destName || iata)
                + (c.distanceKm ? " · " + Math.round(c.distanceKm) + "km" : "")
                + (c.sourceSummary ? " · " + c.sourceSummary : "")
                + (c.demandBasis ? " · " + c.demandBasis : "")
            chip.style.cssText = "background:" + (on ? "#1d4ed8" : "#111827") + ";"
                + "color:" + (on ? "#f8fafc" : (c.alreadyScheduled ? "#94a3b8" : "#cbd5e1")) + ";"
                + "border:1px solid " + (on ? "#2563eb" : (c.alreadyScheduled ? "#64748b" : "#374151")) + ";"
                + "border-radius:3px;padding:4px 8px;font-size:11px;cursor:pointer;"
                + "font-variant-numeric:tabular-nums;"
            chip.addEventListener("click", () => {
                const next = new Set(_state.config.includedIatas)
                if (next.has(iata)) next.delete(iata); else next.add(iata)
                _state.config.includedIatas = Array.from(next)
                _renderBody()
            })
            chips.appendChild(chip)
        }
        wrap.appendChild(chips)
        if (candidates.length) wrap.appendChild(_renderCandidateMatrix(candidates, selected))
        return wrap
    }

    function _renderCandidateSummary() {
        const s = _state.candidateSourceSummary
        if (!s) return null
        const el = document.createElement("div")
        el.style.cssText = "color:#6b7280;font-size:10px;line-height:1.35;"
        const sourceNames = Object.keys(s.sourceCounts || {}).slice(0, 4)
        const sourceText = sourceNames.length
            ? sourceNames.map(k => k + " " + s.sourceCounts[k]).join(" · ")
            : "no source data"
        el.textContent = s.total + " candidates from " + sourceText
            + (s.inGameRoutes ? " · " + s.inGameRoutes + " with AS data" : "")
            + (s.priceRoutes ? " · " + s.priceRoutes + " priced" : "")
            + (s.marketRoutes ? " · " + s.marketRoutes + " market" : "")
            + (s.actualRoutes ? " · " + s.actualRoutes + " actuals" : "")
            + (s.scheduledDestinations
                ? " · " + s.scheduledDestinations + " already scheduled"
                    + (s.scheduledSource ? " (" + s.scheduledSource + ")" : "")
                : "")
        return el
    }

    function _renderCandidateMatrix(candidates, selected) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border:1px solid #1f2937;border-radius:3px;overflow:auto;max-height:360px;"

        const grid = document.createElement("div")
        grid.style.cssText = "min-width:940px;"
        wrap.appendChild(grid)

        const header = document.createElement("div")
        header.style.cssText = _candidateRowCss(true)
        for (const label of ["Dest", "Score", "Demand", "Live", "Price", "Cmp", "Mkt", "Actual", "Source"]) {
            const cell = document.createElement("div")
            cell.textContent = label
            cell.style.cssText = "color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;"
            header.appendChild(cell)
        }
        grid.appendChild(header)

        const rows = candidates.slice(0, 20)
        for (const c of rows) grid.appendChild(_renderCandidateMatrixRow(c, selected))
        return wrap
    }

    function _renderCandidateMatrixRow(c, selected) {
        const iata = _normaliseIata(c && c.destIata)
        const on = selected.has(iata)
        const row = document.createElement("div")
        row.setAttribute("data-aes-rb-candidate-row", iata)
        row.setAttribute("data-aes-rb-selected", on ? "1" : "0")
        row.style.cssText = _candidateRowCss(false)
            + "background:" + (on ? "#172554" : (c.alreadyScheduled ? "#111827" : "#0b1220")) + ";"
            + "cursor:pointer;"
        row.title = (c.destName || iata)
            + (c.distanceKm ? " - " + Math.round(c.distanceKm) + "km" : "")
            + (c.sourceSummary ? " - " + c.sourceSummary : "")
        row.addEventListener("click", () => {
            const next = new Set(_state.config.includedIatas)
            if (next.has(iata)) next.delete(iata); else next.add(iata)
            _state.config.includedIatas = Array.from(next)
            _renderBody()
        })

        row.appendChild(_matrixCell(iata + (c.alreadyScheduled ? " *" : ""), "font-weight:700;color:" + (on ? "#bfdbfe" : "#f8fafc") + ";"))
        row.appendChild(_matrixCell(_fmtInt(_candidateSortScore(c)), "color:#e2e8f0;text-align:right;"))
        row.appendChild(_matrixCell(_fmtDemand(c), "color:#cbd5e1;"))
        row.appendChild(_matrixCell(_fmtLiveRoute(c), "color:#bae6fd;"))
        row.appendChild(_matrixCell(_fmtOwnPrice(c), "color:#fde68a;"))
        row.appendChild(_matrixCell(_fmtCompetitors(c), "color:#d8b4fe;"))
        row.appendChild(_matrixCell(_fmtMarketShare(c), "color:#a7f3d0;"))
        row.appendChild(_matrixCell(_fmtActual(c), "color:" + (_num(c.actualProfitPerFlight) != null && Number(c.actualProfitPerFlight) < 0 ? "#fca5a5" : "#c4b5fd") + ";"))
        row.appendChild(_matrixCell(_fmtSources(c), "color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"))
        return row
    }

    function _candidateRowCss(isHeader) {
        return "display:grid;grid-template-columns:64px 58px 84px 120px 96px 90px 80px 98px minmax(160px,1fr);"
            + "gap:8px;align-items:center;padding:" + (isHeader ? "6px 8px" : "7px 8px") + ";"
            + "border-bottom:1px solid #1f2937;font-size:11px;font-variant-numeric:tabular-nums;"
            + (isHeader ? "background:#111827;position:sticky;top:0;z-index:1;" : "")
    }

    function _matrixCell(text, extraCss) {
        const cell = document.createElement("div")
        cell.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" + (extraCss || "")
        cell.textContent = text || "-"
        return cell
    }

    function _fmtInt(v) {
        const n = _num(v)
        return n == null ? "-" : String(Math.round(n))
    }

    function _fmtDemand(c) {
        const p = _num(c && c.paxScore)
        const g = _num(c && c.cargoScore)
        const pp = p == null ? "-" : (p > 10 ? Math.round(p) : Math.round(p * 10) / 10)
        const gg = g == null ? "-" : (g > 10 ? Math.round(g) : Math.round(g * 10) / 10)
        return "P" + pp + " / C" + gg
    }

    function _fmtLiveRoute(c) {
        const wk = _num(c && (c.liveWeeklyFlights != null ? c.liveWeeklyFlights : c.ownRouteFrequency))
        if (wk == null || wk <= 0) return "-"
        const dep = c.liveDeparture ? " " + c.liveDeparture : ""
        return Math.round(wk) + "/wk" + dep
    }

    function _fmtOwnPrice(c) {
        const prices = c && c.ownPricing
        if (prices && typeof prices === "object") {
            const y = _num(prices.Y)
            const cargo = _num(prices.Cargo)
            if (y != null) return "Y " + _fmtCompactNumber(y)
            if (cargo != null) return "Cargo " + _fmtCompactNumber(cargo)
        }
        if (_num(c && c.ourPrice) != null) return "Y " + _fmtCompactNumber(c.ourPrice)
        return "-"
    }

    function _fmtCompetitors(c) {
        const count = _num(c && c.competitorCount)
        const y = _num(c && c.competitorMedianPriceY)
        if (count == null && y == null) return "-"
        return (count != null ? Math.round(count) + " AS" : "AS")
            + (y != null ? " / Y " + _fmtCompactNumber(y) : "")
    }

    function _fmtMarketShare(c) {
        const share = _num(c && c.ourPaxShare)
        if (share == null) return c && c.marketSharePeriod ? "seen" : "-"
        return (Math.round(share * 10) / 10) + "%"
    }

    function _fmtActual(c) {
        const pf = _num(c && c.actualProfitPerFlight)
        const pw = _num(c && c.actualProfitPerWeek)
        if (pw != null) return _fmtMoneyCompact(pw) + "/wk"
        if (pf != null) return _fmtMoneyCompact(pf) + "/flt"
        return "-"
    }

    function _fmtSources(c) {
        const sources = c && Array.isArray(c.sources) && c.sources.length
            ? c.sources
            : (c && c.sourceSummary ? [c.sourceSummary] : [])
        return sources.slice(0, 3).join(" + ") || "-"
    }

    function _fmtCompactNumber(v) {
        const n = _num(v)
        if (n == null) return "-"
        if (Math.abs(n) >= 1000000) return (Math.round(n / 100000) / 10) + "m"
        if (Math.abs(n) >= 1000) return Math.round(n / 1000) + "k"
        return String(Math.round(n))
    }

    function _fmtMoneyCompact(v) {
        const n = _num(v)
        if (n == null) return "-"
        const sign = n < 0 ? "-" : ""
        return sign + "$" + _fmtCompactNumber(Math.abs(n))
    }

    function _renderActions() {
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;gap:8px;align-items:center;"

        const seqWrap = document.createElement("label")
        seqWrap.style.cssText = "display:flex;align-items:center;gap:6px;color:#9ca3af;font-size:11px;cursor:pointer;"
        const seq = document.createElement("input")
        seq.type = "checkbox"
        seq.checked = _state.config.sequentialLongHaul !== false
        seq.style.cssText = "margin:0;"
        seq.addEventListener("change", () => { _state.config.sequentialLongHaul = seq.checked })
        seqWrap.appendChild(seq)
        const seqLbl = document.createElement("span")
        seqLbl.textContent = "Sequential long-haul placement"
        seqWrap.appendChild(seqLbl)
        bar.appendChild(seqWrap)

        const hideWrap = document.createElement("label")
        hideWrap.style.cssText = "display:flex;align-items:center;gap:6px;color:#9ca3af;font-size:11px;cursor:pointer;"
        const hide = document.createElement("input")
        hide.type = "checkbox"
        hide.checked = _state.config.hideScheduled !== false
        hide.style.cssText = "margin:0;"
        hide.addEventListener("change", () => {
            _state.config.hideScheduled = hide.checked
            _renderBody()
        })
        hideWrap.appendChild(hide)
        const hideLbl = document.createElement("span")
        hideLbl.textContent = "Hide scheduled"
        hideWrap.appendChild(hideLbl)
        bar.appendChild(hideWrap)

        const spacer = document.createElement("div")
        spacer.style.cssText = "flex:1;"
        bar.appendChild(spacer)

        const recBtn = document.createElement("button")
        recBtn.type = "button"
        recBtn.textContent = _state.running ? "Recommending…" : "Recommend schedule"
        recBtn.disabled = _state.running || !_state.hub
        recBtn.style.cssText = _btnCss(!recBtn.disabled, "#1d4ed8", "#1e3a8a")
        recBtn.addEventListener("click", () => { if (!recBtn.disabled) _runPlanner() })
        bar.appendChild(recBtn)
        return bar
    }

    function _renderMockSchedule(result) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border-top:1px solid #1f2937;padding-top:10px;"
        const hdr = document.createElement("div")
        hdr.style.cssText = "display:flex;gap:8px;align-items:baseline;margin-bottom:6px;"
        const t = document.createElement("div")
        t.style.cssText = "font-weight:700;color:#f3f4f6;flex:1;"
        const flightCt = (result.build && result.build.flights) ? result.build.flights.length : 0
        t.textContent = "Mock schedule (" + flightCt + " flights · "
            + result.rows.length + " round-trip" + (result.rows.length === 1 ? "" : "s") + ")"
        hdr.appendChild(t)
        const dests = (result.build.metadata.selectedAirports || []).join(", ")
        const subtitle = document.createElement("div")
        subtitle.style.cssText = "color:#9ca3af;font-size:10px;"
        subtitle.textContent = dests
        hdr.appendChild(subtitle)
        wrap.appendChild(hdr)

        const tbl = document.createElement("div")
        tbl.style.cssText = "border:1px solid #1f2937;border-radius:3px;overflow:hidden;"
        for (const row of result.rows) {
            tbl.appendChild(_renderScheduleRow(row))
        }
        wrap.appendChild(tbl)

        const hint = document.createElement("div")
        hint.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;"
        hint.textContent = "Edit any HH:MM or day to override the planner. Edits persist into the apply payload."
        wrap.appendChild(hint)
        return wrap
    }

    function _renderScheduleRow(row) {
        const out = _effectiveFlight(row.outSeq)
        const inn = _effectiveFlight(row.inSeq)
        const el = document.createElement("div")
        el.style.cssText = "display:grid;grid-template-columns:64px minmax(110px,1fr) 92px 76px 92px 76px 60px;"
            + "gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid #0f172a;"
            + "font-size:11px;color:#cbd5e1;"

        const tag = document.createElement("div")
        tag.style.cssText = "color:" + (row.sequential ? "#fbbf24" : "#6b7280") + ";font-size:10px;"
        tag.textContent = row.sequential ? "[seq]" : ""
        tag.title = row.reason || ""
        el.appendChild(tag)

        const route = document.createElement("div")
        route.style.cssText = "font-weight:600;color:#f8fafc;min-width:0;overflow:hidden;text-overflow:ellipsis;"
        route.textContent = (out && out.origin || _state.hub || "?") + " → " + row.destination
        route.title = "round-trip · " + row.flightMin + "min one-way · " + Math.round(row.distanceNm || 0) + "nm"
        el.appendChild(route)

        el.appendChild(_legDayInput("Out day", _dayFromMask(out && out.dayMask, row.outDayIdx), v =>
            _setLegEdit(row.outSeq, {dayMask: _singleDayMask(v)})))
        el.appendChild(_legTimeInput("Out dep", (out && out.depTimeLocal) || row.outDepTime, v =>
            _setLegEdit(row.outSeq, {depTimeLocal: v})))
        el.appendChild(_legDayInput("In day", _dayFromMask(inn && inn.dayMask, row.inDayIdx), v =>
            _setLegEdit(row.inSeq, {dayMask: _singleDayMask(v)})))
        el.appendChild(_legTimeInput("In dep", (inn && inn.depTimeLocal) || row.inDepTime, v =>
            _setLegEdit(row.inSeq, {depTimeLocal: v})))

        const bucket = document.createElement("div")
        bucket.style.cssText = "color:#9ca3af;text-align:right;font-size:10px;"
        bucket.textContent = row.rangeBucket === "longHaul" ? "long"
            : row.rangeBucket === "mediumHaul" ? "med"
            : row.rangeBucket === "shortHaul" ? "short" : "—"
        el.appendChild(bucket)

        return el
    }

    function _renderApplyBar(result) {
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;gap:8px;align-items:center;padding-top:6px;border-top:1px solid #1f2937;"

        const ctxInfo = document.createElement("div")
        ctxInfo.style.cssText = "color:#6b7280;font-size:10px;flex:1;"
        const flights = result.build && result.build.flights || []
        ctxInfo.textContent = "Apply will POST " + flights.length + " new flight numbers to AS · ~"
            + Math.round(flights.length * ESTIMATED_SECONDS_PER_LEG / 60) + " min total"
        bar.appendChild(ctxInfo)

        const cancel = document.createElement("button")
        cancel.type = "button"
        cancel.textContent = "Close"
        cancel.style.cssText = _btnCss(true, "#1f2937", "#374151")
        cancel.addEventListener("click", () => _close({applied: false, cancelled: true}))
        bar.appendChild(cancel)

        const apply = document.createElement("button")
        apply.type = "button"
        apply.textContent = "Apply schedule"
        apply.title = "Hand off to AesAfpAutoApplyBatch.start (background submit queue)."
        apply.disabled = !_canApply(result)
        apply.style.cssText = _btnCss(!apply.disabled, "#b91c1c", "#7f1d1d")
        apply.addEventListener("click", () => { if (!apply.disabled) _runApply() })
        bar.appendChild(apply)

        return bar
    }

    function _canApply(result) {
        if (!result || !result.build || !Array.isArray(result.build.flights)) return false
        if (!result.build.flights.length) return false
        if (typeof window.AesAfpAutoApplyBatch === "undefined") return false
        if (!_state.aircraftId || !_state.server) return false
        return true
    }

    // ─────────────────────────────────────────────────────────────────
    // Behaviour: planner run + per-leg edit + apply.
    // ─────────────────────────────────────────────────────────────────

    async function _runPlanner() {
        if (typeof window.AesAfpRouteBuilderPlanner === "undefined") {
            _state.error = "Route builder planner module not loaded."
            _renderBody()
            return
        }
        if (!_state.hub) {
            _state.error = "Pick a hub IATA first."
            _renderBody()
            return
        }
        _state.running = true
        _state.error = null
        _renderBody()
        try {
            // Synthetic candidate fallback when the user typed an IATA that's
            // not in cached FlightsFrom data — the planner needs at minimum a
            // destIata + distanceKm. 1500km is a safe medium-haul placeholder
            // so the route still scores; the user can refine later.
            const have = new Set(_state.candidates.map(c => c.destIata))
            const synth = []
            for (const iata of _state.config.includedIatas) {
                if (!iata || have.has(iata)) continue
                synth.push({destIata: iata, paxScore: 5, cargoScore: 3,
                    weeklyFlights: 7, distanceKm: 1500, scoreBlend: 50,
                    _synthetic: true})
            }
            const allCandidates = _plannerCandidatePool(_state.candidates.concat(synth))

            const result = window.AesAfpRouteBuilderPlanner.recommend({
                hubIata:    _state.hub,
                candidates: allCandidates,
                spec:       _state.spec || {},
                config:     _state.config
            })
            _state.plannerResult = result
            if (result.build && Array.isArray(result.build.validation) && result.build.validation.length) {
                _state.error = result.build.validation.join(" · ")
            }
            // Persist build into draft store so per-leg edits attach to a
            // canonical seq set. setFlights clears any old edits — that's
            // intentional, the planner produces fresh seq numbers.
            if (typeof window.AesAfpActiveDraftStore !== "undefined"
                    && _state.server && _state.aircraftId
                    && result.build && result.build.flights && result.build.flights.length) {
                _state.draft = await window.AesAfpActiveDraftStore.setFlights(
                    _state.server, _state.aircraftId, {
                        hub:      _state.hub,
                        presetId: result.build.preset && result.build.preset.id,
                        flights:  result.build.flights,
                        metadata: result.build.metadata
                    }
                ) || _state.draft
            }
        } catch (e) {
            _state.error = "Recommend failed: " + ((e && e.message) || String(e))
            console.warn("[AES route-builder-modal] recommend threw", e)
        } finally {
            _state.running = false
            _renderBody()
        }
    }

    function _plannerCandidatePool(candidates) {
        const manual = new Set((_state.config.includedIatas || []).map(_normaliseIata).filter(Boolean))
        if (!_state.config.hideScheduled || manual.size) {
            return (candidates || []).filter(c => {
                const iata = _normaliseIata(c && c.destIata)
                return iata && (!c.alreadyScheduled || manual.has(iata) || !_state.config.hideScheduled)
            })
        }
        return (candidates || []).filter(c => c && !c.alreadyScheduled)
    }

    async function _setLegEdit(seq, patch) {
        if (typeof window.AesAfpActiveDraftStore === "undefined") return
        if (!_state.server || !_state.aircraftId || seq == null) return
        try {
            const next = await window.AesAfpActiveDraftStore.setEdit(
                _state.server, _state.aircraftId, seq, patch
            )
            _state.draft = next || _state.draft
            _renderBody()
        } catch (e) {
            console.warn("[AES route-builder-modal] setEdit failed", e)
        }
    }

    async function _runApply() {
        if (!_state.plannerResult) return
        const payload = _buildApplyPayload(_state)
        if (!payload.legs.length) {
            _state.error = "No legs to apply (planner produced none)."
            _renderBody()
            return
        }
        if (typeof window.AesAfpAutoApplyBatch === "undefined"
                || typeof window.AesAfpAutoApplyBatch.start !== "function") {
            _state.error = "AesAfpAutoApplyBatch not loaded — cannot dispatch."
            _renderBody()
            return
        }
        _state.running = true
        _renderBody()
        try {
            const startResult = await window.AesAfpAutoApplyBatch.start({
                ctx:    payload.ctx,
                legs:   payload.legs,
                source: payload.source
            })
            _close({
                applied:        true,
                cancelled:      false,
                plannerResult:  _state.plannerResult,
                payload:        payload,
                startResult:    startResult || null
            })
        } catch (e) {
            _state.error = "Apply failed: " + ((e && e.message) || String(e))
            console.warn("[AES route-builder-modal] apply threw", e)
            _state.running = false
            _renderBody()
        }
    }

    function _effectiveFlight(seq) {
        const build = _state.plannerResult && _state.plannerResult.build
        const base = build && Array.isArray(build.flights)
            ? build.flights.find(f => f && f.seq === seq) : null
        if (!base) return null
        const overlay = (_state.draft && _state.draft.perLegEdits
            && _state.draft.perLegEdits[seq]) || null
        return overlay ? Object.assign({}, base, overlay) : base
    }

    // ─────────────────────────────────────────────────────────────────
    // Style helpers — DOM verbosity confined here.
    // ─────────────────────────────────────────────────────────────────

    function _inputCss() {
        return "background:#111827;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:4px 6px;font-size:11px;"
            + "font-variant-numeric:tabular-nums;width:100%;box-sizing:border-box;"
    }

    function _btnCss(enabled, bg, border) {
        return "background:" + (enabled ? bg : "#374151") + ";"
            + "color:" + (enabled ? "#f8fafc" : "#9ca3af") + ";"
            + "border:1px solid " + (enabled ? border : "#374151") + ";"
            + "border-radius:3px;padding:5px 14px;font-size:11px;font-weight:600;"
            + "cursor:" + (enabled ? "pointer" : "not-allowed") + ";"
    }

    function _fieldWrap(label) {
        const w = document.createElement("label")
        w.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0;"
        const lbl = document.createElement("span")
        lbl.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;"
        lbl.textContent = label
        w.appendChild(lbl)
        return w
    }

    function _numberField(label, value, min, max, step, onChange) {
        const w = _fieldWrap(label)
        const inp = document.createElement("input")
        inp.type = "number"
        inp.min = String(min); inp.max = String(max); inp.step = String(step || 1)
        inp.value = String(value == null ? min : value)
        inp.style.cssText = _inputCss()
        inp.addEventListener("change", () => {
            const n = Number(inp.value)
            if (!isFinite(n)) return
            onChange(Math.max(min, Math.min(max, Math.round(n))))
        })
        w.appendChild(inp)
        return w
    }

    function _timeField(label, value, onChange) {
        const w = _fieldWrap(label)
        const inp = document.createElement("input")
        inp.type = "time"
        inp.value = /^\d{2}:\d{2}$/.test(String(value || "")) ? value : "09:00"
        inp.style.cssText = _inputCss()
        inp.addEventListener("change", () => {
            if (/^\d{2}:\d{2}$/.test(inp.value)) onChange(inp.value)
        })
        w.appendChild(inp)
        return w
    }

    function _dayField(label, value, onChange) {
        const w = _fieldWrap(label)
        const sel = document.createElement("select")
        sel.style.cssText = _inputCss()
        DAY_NAMES.forEach((n, i) => {
            const o = document.createElement("option")
            o.value = String(i); o.textContent = n
            if (i === Number(value)) o.selected = true
            sel.appendChild(o)
        })
        sel.addEventListener("change", () => onChange(Number(sel.value)))
        w.appendChild(sel)
        return w
    }

    function _legDayInput(label, value, onChange) {
        const w = _fieldWrap(label)
        const sel = document.createElement("select")
        sel.style.cssText = _inputCss() + "padding:2px 4px;font-size:10px;"
        DAY_NAMES.forEach((n, i) => {
            const o = document.createElement("option")
            o.value = String(i); o.textContent = n
            if (i === Number(value)) o.selected = true
            sel.appendChild(o)
        })
        sel.addEventListener("change", () => onChange(Number(sel.value)))
        w.appendChild(sel)
        return w
    }

    function _legTimeInput(label, value, onChange) {
        const w = _fieldWrap(label)
        const inp = document.createElement("input")
        inp.type = "time"
        inp.value = /^\d{2}:\d{2}$/.test(String(value || "")) ? value : "00:00"
        inp.style.cssText = _inputCss() + "padding:2px 4px;font-size:10px;"
        inp.addEventListener("change", () => {
            if (/^\d{2}:\d{2}$/.test(inp.value)) onChange(inp.value)
        })
        w.appendChild(inp)
        return w
    }

    // ─────────────────────────────────────────────────────────────────
    // Public API.
    // ─────────────────────────────────────────────────────────────────

    window.AesAfpRouteBuilderModal = {
        open:  _open,
        close: () => _close({applied: false, cancelled: true}),
        // Pure helpers — exposed so audit-jihwan tests can exercise
        // the controller logic without a DOM.
        _internal: {
            parseIataList:    _parseIataList,
            normaliseIata:    _normaliseIata,
            materialiseLegs:  _materialiseLegs,
            buildApplyPayload: _buildApplyPayload,
            defaultConfig:    _defaultConfig,
            singleDayMask:    _singleDayMask,
            dayFromMask:      _dayFromMask,
            mergeCandidateSources: _mergeCandidateSources,
            scheduledInfoFromSchedule: _scheduledInfoFromSchedule,
            candidateSortScore: _candidateSortScore,
            competitorStats: _competitorStats,
            projectScheduleRecord: _projectScheduleRecord,
            projectMarketsBucket: _projectMarketsBucket,
            projectYieldHistoryRecord: _projectYieldHistoryRecord,
            summariseCandidateSources: _summariseCandidateSources
        }
    }
})()
