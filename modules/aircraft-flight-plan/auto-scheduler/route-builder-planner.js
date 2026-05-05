"use strict"

/**
 * Route Builder Planner
 *
 * Pure planner used by the AFP auto-build panel as an explicit route-builder
 * entry point: the user picks destination airports + a desired flight count,
 * then this module produces an editable mock schedule build. The build shape
 * intentionally matches AesAfpAutoScheduler/RouteAssistantWaveOverlay output
 * so the existing active-draft store and apply-all pipeline can consume it.
 */
;(function () {
    if (window.AesAfpRouteBuilderPlanner) return

    const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    const WEEK_MIN = 7 * 24 * 60

    function _normaliseIata(value) {
        const s = String(value || "").trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : ""
    }

    function _normaliseScheduleType(value) {
        const s = String(value || "").trim().toLowerCase()
        if (s === "chain" || s === "chainloop" || s === "loop" || s === "sequential") return "chainLoop"
        return "hubShuttle"
    }

    function _finite(value, fallback) {
        const n = Number(value)
        return Number.isFinite(n) ? n : fallback
    }

    function _parseHHMM(value, fallback) {
        if (typeof ScheduleFactors !== "undefined" && ScheduleFactors.parseHHMM) {
            const n = ScheduleFactors.parseHHMM(String(value || ""))
            if (Number.isFinite(n)) return n
        }
        const m = String(value || "").match(/^([0-2]?\d):([0-5]\d)$/)
        if (m) {
            const h = Number(m[1])
            const mm = Number(m[2])
            if (h >= 0 && h <= 23) return h * 60 + mm
        }
        return fallback
    }

    function _formatHHMM(minutes) {
        if (typeof ScheduleFactors !== "undefined" && ScheduleFactors.formatHHMM) {
            return ScheduleFactors.formatHHMM(minutes)
        }
        const m = ((Math.round(minutes) % 1440) + 1440) % 1440
        return String(Math.floor(m / 60)).padStart(2, "0")
            + ":" + String(m % 60).padStart(2, "0")
    }

    function _kmToNm(km) {
        if (typeof ScheduleFactors !== "undefined" && ScheduleFactors.kmToNm) {
            return ScheduleFactors.kmToNm(km)
        }
        return Math.round(Number(km) * 0.539957)
    }

    function _nmToKm(nm) {
        if (typeof ScheduleFactors !== "undefined" && ScheduleFactors.nmToKm) {
            return ScheduleFactors.nmToKm(nm)
        }
        return Math.round(Number(nm) * 1.852)
    }

    function _bucketize(distanceNm, factors) {
        const buckets = factors && factors.rangeBuckets
        if (typeof ScheduleFactors !== "undefined" && ScheduleFactors.bucketize) {
            return ScheduleFactors.bucketize(distanceNm, buckets)
        }
        if (distanceNm < 1500) return "shortHaul"
        if (distanceNm < 3500) return "mediumHaul"
        return "longHaul"
    }

    function _defaultFactors(config) {
        const base = (typeof ScheduleFactors !== "undefined" && ScheduleFactors.defaultFactors)
            ? ScheduleFactors.defaultFactors()
            : {
                minTransferMinutes: 45,
                maxTransferMinutes: 240,
                turnaroundBuffer: 10,
                rangeBuckets: {
                    shortHaul:  {label: "Short haul", min: 0, max: 1500},
                    mediumHaul: {label: "Medium haul", min: 1500, max: 3500},
                    longHaul:   {label: "Long haul", min: 3500, max: 99999}
                },
                slotWindow: {start: "00:00", end: "23:59"},
                dayPattern: "custom",
                dayMask: [1, 1, 1, 1, 1, 1, 1],
                nightArrivalsAllowed: true,
                timezoneAware: true
            }
        return Object.assign({}, base, {
            minTransferMinutes: config.turnaroundMin,
            slotWindow: {start: "00:00", end: "23:59"},
            dayPattern: "custom",
            dayMask: [1, 1, 1, 1, 1, 1, 1],
            nightArrivalsAllowed: true
        })
    }

    function _singleDayMask(dayIdx) {
        const out = [0, 0, 0, 0, 0, 0, 0]
        out[((Number(dayIdx) || 0) % 7 + 7) % 7] = 1
        return out
    }

    function _dayIdx(absMin) {
        return ((Math.floor(absMin / 1440) % 7) + 7) % 7
    }

    function _dayName(dayIdx) {
        return DAY_NAMES[((Number(dayIdx) || 0) % 7 + 7) % 7] || "Day"
    }

    function _scoreCandidate(c) {
        const direct = _finite(c && (c.scoreBlend != null ? c.scoreBlend : c && c.score), NaN)
        if (Number.isFinite(direct)) return direct
        return (_finite(c && c.paxScore, 0) * 10)
            + (_finite(c && c.cargoScore, 0) * 4)
            + Math.min(40, _finite(c && c.weeklyFlights, 0))
    }

    function _candidateDistance(c) {
        const km = _finite(c && c.distanceKm, NaN)
        const nm = _finite(c && c.distanceNm, NaN)
        if (Number.isFinite(km) && km > 0) return {km, nm: Number.isFinite(nm) && nm > 0 ? nm : _kmToNm(km)}
        if (Number.isFinite(nm) && nm > 0) return {km: _nmToKm(nm), nm}
        return {km: null, nm: null}
    }

    function _flightMinutes(c, spec, config) {
        const d = _candidateDistance(c)
        if (!d.km) return null
        const speed = _finite(spec && (spec.cruiseSpeedKmh || spec.speedKmh || spec.speed), 800)
        const cycle = _finite(config.cycleMinutes, 30)
        return Math.max(1, Math.round((d.km / Math.max(1, speed)) * 60 + cycle))
    }

    function _nextDayAt(absMin, baseMin, offsetMin) {
        const day = Math.floor(absMin / 1440) + 1
        return day * 1440 + baseMin + (offsetMin || 0)
    }

    function _normaliseConfig(input, candidates) {
        const raw = input || {}
        const requestedFlights = Math.max(2, Math.min(56, Math.round(_finite(raw.targetFlights, 4))))
        const scheduleType = _normaliseScheduleType(raw.scheduleType || raw.structure || raw.pattern)
        const includedIatas = Array.isArray(raw.includedIatas)
            ? raw.includedIatas.map(_normaliseIata).filter(Boolean)
            : String(raw.includedIatas || "").split(/[,\s]+/).map(_normaliseIata).filter(Boolean)
        const unique = []
        const seen = new Set()
        for (const iata of includedIatas) {
            if (seen.has(iata)) continue
            seen.add(iata)
            unique.push(iata)
        }
        const airportCount = Math.max(1, Math.min(30, Math.round(_finite(
            raw.airportCount,
            unique.length || Math.ceil(requestedFlights / 2) || 1
        ))))
        return {
            includedIatas: unique,
            airportCount,
            scheduleType,
            targetFlights: requestedFlights,
            targetRoundTrips: scheduleType === "hubShuttle" ? Math.ceil(requestedFlights / 2) : requestedFlights,
            baseDeparture: String(raw.baseDeparture || "09:00"),
            baseDepartureMin: _parseHHMM(raw.baseDeparture || "09:00", 9 * 60),
            startDayIdx: Math.max(0, Math.min(6, Math.round(_finite(raw.startDayIdx, 0)))),
            turnaroundMin: Math.max(20, Math.min(360, Math.round(_finite(raw.turnaroundMin, 45)))),
            shortGapMin: Math.max(0, Math.min(360, Math.round(_finite(raw.shortGapMin, 45)))),
            longGapMin: Math.max(0, Math.min(1440, Math.round(_finite(raw.longGapMin, 120)))),
            staggerMin: Math.max(0, Math.min(360, Math.round(_finite(raw.staggerMin, 73)))),
            longHaulThresholdNm: Math.max(1000, Math.round(_finite(raw.longHaulThresholdNm, 3500))),
            latestLongHaulDepartureMin: _parseHHMM(raw.latestLongHaulDeparture || "18:00", 18 * 60),
            sequentialLongHaul: raw.sequentialLongHaul !== false,
            cycleMinutes: Math.max(0, Math.min(120, Math.round(_finite(raw.cycleMinutes, 30)))),
            source: String(raw.source || "route-builder-workbench").slice(0, 48),
            candidateCount: Array.isArray(candidates) ? candidates.length : 0
        }
    }

    function _selectCandidates(candidates, config, hubIata) {
        const byIata = new Map()
        for (const c of Array.isArray(candidates) ? candidates : []) {
            if (!c) continue
            const iata = _normaliseIata(c.destIata || c.dest || c.destination || c.airportIata)
            if (!iata || iata === hubIata) continue
            if (!_candidateDistance(c).km) continue
            const cur = byIata.get(iata)
            if (!cur || _scoreCandidate(c) > _scoreCandidate(cur)) {
                byIata.set(iata, Object.assign({}, c, {destIata: iata}))
            }
        }

        if (config.includedIatas.length) {
            return config.includedIatas.map(iata => byIata.get(iata)).filter(Boolean)
        }

        return Array.from(byIata.values())
            .sort((a, b) => _scoreCandidate(b) - _scoreCandidate(a)
                || String(a.destIata).localeCompare(String(b.destIata)))
            .slice(0, config.airportCount)
    }

    function _candidateForLeg(allCandidates, selected, origin, destination, hubIata) {
        const from = _normaliseIata(origin)
        const to = _normaliseIata(destination)
        const hub = _normaliseIata(hubIata)
        if (!from || !to) return null

        const pool = []
            .concat(Array.isArray(allCandidates) ? allCandidates : [])
            .concat(Array.isArray(selected) ? selected : [])
        for (const c of pool) {
            if (!c) continue
            const cFrom = _normaliseIata(c.originIata || c.origin || c.hubIata || c.hub || hub)
            const cTo = _normaliseIata(c.destIata || c.dest || c.destination || c.airportIata)
            if (cFrom === from && cTo === to && _candidateDistance(c).km) {
                return Object.assign({}, c, {originIata: from, destIata: to})
            }
            if (cFrom === to && cTo === from && _candidateDistance(c).km) {
                return Object.assign({}, c, {originIata: from, destIata: to})
            }
        }

        const byDest = new Map()
        for (const c of Array.isArray(selected) ? selected : []) {
            const iata = _normaliseIata(c && c.destIata)
            if (iata && _candidateDistance(c).km) byDest.set(iata, c)
        }
        const originCand = byDest.get(from) || null
        const destCand = byDest.get(to) || null
        if (from === hub && destCand) return Object.assign({}, destCand, {originIata: from, destIata: to})
        if (to === hub && originCand) return Object.assign({}, originCand, {originIata: from, destIata: to})
        if (originCand && destCand) {
            const od = _candidateDistance(originCand)
            const dd = _candidateDistance(destCand)
            const base = od.km >= dd.km ? originCand : destCand
            return Object.assign({}, base, {
                originIata: from,
                destIata: to,
                derivedInterstation: true,
                scoreBlend: Math.max(_scoreCandidate(originCand), _scoreCandidate(destCand))
            })
        }
        const fallback = destCand || originCand
        return fallback ? Object.assign({}, fallback, {originIata: from, destIata: to, derivedInterstation: true}) : null
    }

    function _routeKey(origin, destination) {
        return _normaliseIata(origin) + "-" + _normaliseIata(destination)
    }

    function _ensureRoute(build, routeIndex, origin, destination, dist, spec, config, cand) {
        const key = _routeKey(origin, destination)
        if (!routeIndex.has(key)) {
            routeIndex.set(key, build.routes.length)
            build.routes.push({
                origin,
                destination,
                distanceNm: dist.nm,
                aircraftType: spec.typeName || spec.name || null,
                aircraftRangeNm: spec.range ? _kmToNm(Number(spec.range)) : null,
                turnaroundMinutes: config.turnaroundMin,
                _scoredRow: cand
            })
        }
        return build.routes[routeIndex.get(key)]
    }

    function recommend(args) {
        const a = args || {}
        const hubIata = _normaliseIata(a.hubIata || a.hub || a.originIata)
        const config = _normaliseConfig(a.config || {}, a.candidates || [])
        const spec = a.spec || {}
        const factors = _defaultFactors(config)
        const selected = _selectCandidates(a.candidates || [], config, hubIata)
        const warnings = []
        const validation = []

        if (!hubIata) validation.push("hubIata is required")
        if (!selected.length) validation.push("no selected airports have usable route distance")
        if (config.scheduleType === "hubShuttle" && config.targetFlights % 2 === 1) {
            warnings.push({
                seq: 0,
                type: "oddFlightTargetRounded",
                message: "Target " + config.targetFlights + " flights requires round-trips; generated "
                    + (config.targetRoundTrips * 2) + " legs."
            })
        }

        const preset = {
            id: "rbp-" + Date.now().toString(36),
            name: "Route builder mock schedule",
            hub: hubIata,
            waves: [],
            factors,
            notes: "Generated by Route Builder Planner",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            schedule: {weekPattern: "custom", dayMask: [1, 1, 1, 1, 1, 1, 1]}
        }

        const build = {
            validation,
            routes: [],
            flights: [],
            warnings,
            placements: [],
            unplaced: [],
            shortfall: {},
            skipped: [],
            connections: [],
            preset,
            metadata: {
                algo: "route-builder-planner-v1",
                scheduleOriginIata: hubIata || null,
                scheduleOriginSource: "explicit",
                scheduleType: config.scheduleType,
                requestedFlights: config.targetFlights,
                generatedFlights: 0,
                targetRoundTrips: config.targetRoundTrips,
                selectedAirports: [],
                candidatePoolAirports: selected.map(c => c.destIata),
                candidateCount: config.candidateCount,
                sequentialLongHaul: config.sequentialLongHaul,
                generatedAt: Date.now()
            }
        }

        if (validation.length) return {config, selectedCandidates: selected, rows: [], build}

        const routeIndex = new Map()
        const rows = []
        let seq = 0
        let previousEnd = null
        let previousLong = false
        let cursor = config.startDayIdx * 1440 + config.baseDepartureMin

        if (config.scheduleType === "chainLoop") {
            const stations = selected.map(c => c.destIata).filter(Boolean)
            const cycle = [hubIata].concat(stations).concat([hubIata])
            const cycleLegs = Math.max(1, cycle.length - 1)
            for (let i = 0; i < config.targetFlights; i++) {
                const origin = cycle[i % cycleLegs]
                const destination = cycle[(i % cycleLegs) + 1]
                if (!origin || !destination || origin === destination) continue
                const cand = _candidateForLeg(a.candidates || [], selected, origin, destination, hubIata)
                const dist = _candidateDistance(cand)
                const flightMin = _flightMinutes(cand, spec, config)
                if (!dist.km || !dist.nm || !flightMin) continue

                const bucket = _bucketize(dist.nm, factors)
                const isLong = bucket === "longHaul"
                    || dist.nm >= config.longHaulThresholdNm
                    || flightMin >= 6 * 60
                if (previousEnd != null) {
                    const groundGap = Math.max(
                        config.turnaroundMin,
                        (isLong || previousLong) ? config.longGapMin : config.shortGapMin
                    )
                    cursor = previousEnd + groundGap
                    if (config.sequentialLongHaul && isLong) {
                        const tod = ((cursor % 1440) + 1440) % 1440
                        if (tod > config.latestLongHaulDepartureMin) {
                            cursor = _nextDayAt(cursor, config.baseDepartureMin, (i * config.staggerMin) % 360)
                        }
                    }
                }
                const tod = ((cursor % 1440) + 1440) % 1440
                if (!isLong && tod + flightMin > 1440) {
                    cursor = _nextDayAt(cursor, config.baseDepartureMin, (i * config.staggerMin) % 360)
                }
                cursor = ((cursor % WEEK_MIN) + WEEK_MIN) % WEEK_MIN

                const depAbs = cursor
                const arrAbs = depAbs + flightMin
                const depDay = _dayIdx(depAbs)
                const arrDay = _dayIdx(arrAbs)
                const waveId = "rbw-chain-" + String(i + 1)
                const waveLabel = (isLong ? "Sequential long-haul leg " : "Chain loop leg ") + String(i + 1)
                const seqNo = ++seq
                const direction = origin === hubIata ? "outbound"
                    : destination === hubIata ? "inbound" : "continuation"
                const route = _ensureRoute(build, routeIndex, origin, destination, dist, spec, config, cand)

                const wave = {
                    id: waveId,
                    label: waveLabel,
                    arrivalWindow: {
                        start: _formatHHMM(arrAbs - 15),
                        end: _formatHHMM(arrAbs + 15)
                    },
                    departureWindow: {
                        start: _formatHHMM(depAbs),
                        end: _formatHHMM(depAbs)
                    },
                    composition: {shortHaul: 0, mediumHaul: 0, longHaul: 0},
                    priority: isLong ? 80 : 50,
                    pinDestinations: [destination],
                    routePolicy: "lockedSet",
                    notes: "Planner chain leg " + String(i + 1)
                }
                wave.composition[bucket || "mediumHaul"] = 1
                preset.waves.push(wave)

                build.flights.push({
                    seq: seqNo,
                    waveId,
                    waveLabel,
                    direction,
                    origin,
                    destination,
                    aircraftType: spec.typeName || spec.name || null,
                    depTimeLocal: _formatHHMM(depAbs),
                    arrTimeLocal: _formatHHMM(arrAbs),
                    distanceNm: dist.nm,
                    rangeBucket: bucket,
                    dayMask: _singleDayMask(depDay)
                })
                build.placements.push({waveId, route, direction})

                rows.push({
                    rowId: waveId,
                    waveId,
                    waveLabel,
                    origin,
                    destination,
                    distanceNm: dist.nm,
                    rangeBucket: bucket,
                    flightMin,
                    blockMin: flightMin + config.turnaroundMin,
                    outSeq: seqNo,
                    inSeq: null,
                    outDayIdx: depDay,
                    inDayIdx: depDay,
                    arrDayIdx: arrDay,
                    outDayName: _dayName(depDay),
                    inDayName: _dayName(depDay),
                    outDepTime: _formatHHMM(depAbs),
                    outArrTime: _formatHHMM(arrAbs),
                    inDepTime: "",
                    inArrTime: "",
                    sequential: isLong || previousLong,
                    scheduleType: "chainLoop",
                    reason: isLong
                        ? "long chain leg sequenced after the prior arrival"
                        : "chain loop leg from selected airport order"
                })

                previousEnd = arrAbs
                previousLong = isLong
            }
        } else {
        for (let i = 0; i < config.targetRoundTrips; i++) {
            const cand = selected[i % selected.length]
            const dist = _candidateDistance(cand)
            const flightMin = _flightMinutes(cand, spec, config)
            if (!dist.km || !dist.nm || !flightMin) continue

            const bucket = _bucketize(dist.nm, factors)
            const isLong = bucket === "longHaul"
                || dist.nm >= config.longHaulThresholdNm
                || flightMin >= 6 * 60
            const blockMin = (flightMin * 2) + config.turnaroundMin

            if (previousEnd != null) {
                cursor = previousEnd + ((isLong || previousLong) ? config.longGapMin : config.shortGapMin)
                if (config.sequentialLongHaul && isLong) {
                    const tod = ((cursor % 1440) + 1440) % 1440
                    if (tod > config.latestLongHaulDepartureMin) {
                        cursor = _nextDayAt(cursor, config.baseDepartureMin, (i * config.staggerMin) % 360)
                    }
                }
            }
            const tod = ((cursor % 1440) + 1440) % 1440
            if (!isLong && blockMin <= 1440 && tod + blockMin > 1440) {
                cursor = _nextDayAt(cursor, config.baseDepartureMin, (i * config.staggerMin) % 360)
            }
            cursor = ((cursor % WEEK_MIN) + WEEK_MIN) % WEEK_MIN

            const outDepAbs = cursor
            const outArrAbs = outDepAbs + flightMin
            const inDepAbs = outArrAbs + config.turnaroundMin
            const inArrAbs = inDepAbs + flightMin
            const outDay = _dayIdx(outDepAbs)
            const inDay = _dayIdx(inDepAbs)
            const waveId = "rbw-" + String(i + 1)
            const waveLabel = (isLong ? "Sequential long-haul " : "Recommended route ") + String(i + 1)
            const outSeq = ++seq
            const inSeq = ++seq

            const wave = {
                id: waveId,
                label: waveLabel,
                arrivalWindow: {
                    start: _formatHHMM(inArrAbs - 15),
                    end: _formatHHMM(inArrAbs + 15)
                },
                departureWindow: {
                    start: _formatHHMM(outDepAbs),
                    end: _formatHHMM(outDepAbs)
                },
                composition: {shortHaul: 0, mediumHaul: 0, longHaul: 0},
                priority: isLong ? 80 : 50,
                pinDestinations: [cand.destIata],
                routePolicy: "lockedSet",
                notes: "Planner row " + String(i + 1)
            }
            wave.composition[bucket || "mediumHaul"] = 1
            preset.waves.push(wave)

            if (!routeIndex.has(cand.destIata)) {
                routeIndex.set(cand.destIata, build.routes.length)
                build.routes.push({
                    origin: hubIata,
                    destination: cand.destIata,
                    distanceNm: dist.nm,
                    aircraftType: spec.typeName || spec.name || null,
                    aircraftRangeNm: spec.range ? _kmToNm(Number(spec.range)) : null,
                    turnaroundMinutes: config.turnaroundMin,
                    _scoredRow: cand
                })
            }

            build.flights.push({
                seq: outSeq,
                waveId,
                waveLabel,
                direction: "outbound",
                origin: hubIata,
                destination: cand.destIata,
                aircraftType: spec.typeName || spec.name || null,
                depTimeLocal: _formatHHMM(outDepAbs),
                arrTimeLocal: _formatHHMM(outArrAbs),
                distanceNm: dist.nm,
                rangeBucket: bucket,
                dayMask: _singleDayMask(outDay)
            })
            build.flights.push({
                seq: inSeq,
                waveId,
                waveLabel,
                direction: "inbound",
                origin: cand.destIata,
                destination: hubIata,
                aircraftType: spec.typeName || spec.name || null,
                depTimeLocal: _formatHHMM(inDepAbs),
                arrTimeLocal: _formatHHMM(inArrAbs),
                distanceNm: dist.nm,
                rangeBucket: bucket,
                dayMask: _singleDayMask(inDay)
            })
            build.placements.push({waveId, route: build.routes[routeIndex.get(cand.destIata)], direction: "outbound"})
            build.placements.push({waveId, route: build.routes[routeIndex.get(cand.destIata)], direction: "inbound"})

            rows.push({
                rowId: waveId,
                waveId,
                waveLabel,
                destination: cand.destIata,
                distanceNm: dist.nm,
                rangeBucket: bucket,
                flightMin,
                blockMin,
                outSeq,
                inSeq,
                outDayIdx: outDay,
                inDayIdx: inDay,
                outDayName: _dayName(outDay),
                inDayName: _dayName(inDay),
                outDepTime: _formatHHMM(outDepAbs),
                outArrTime: _formatHHMM(outArrAbs),
                inDepTime: _formatHHMM(inDepAbs),
                inArrTime: _formatHHMM(inArrAbs),
                sequential: isLong || previousLong,
                reason: isLong
                    ? "long route sequenced after prior return"
                    : "ranked by demand and score"
            })

            previousEnd = inArrAbs
            previousLong = isLong
        }
        }

        build.metadata.generatedFlights = build.flights.length
        build.metadata.generatedRoundTrips = config.scheduleType === "hubShuttle" ? rows.length : 0
        build.metadata.generatedScheduleRows = rows.length
        build.metadata.selectedAirports = Array.from(new Set(rows
            .map(r => r.destination)
            .filter(iata => iata && iata !== hubIata)))
        build.metadata.flightOnlyHoursUsed = build.flights.reduce((sum, f) => {
            const row = rows.find(r => r.outSeq === f.seq || r.inSeq === f.seq)
            return sum + (row ? row.flightMin / 60 : 0)
        }, 0)
        build.metadata.budgetUsedHours = build.metadata.flightOnlyHoursUsed
        build.metadata.totalScore = selected.reduce((sum, c) => sum + _scoreCandidate(c), 0)

        return {config, selectedCandidates: selected, rows, build}
    }

    window.AesAfpRouteBuilderPlanner = {
        DAY_NAMES,
        normaliseConfig: _normaliseConfig,
        selectCandidates: _selectCandidates,
        recommend
    }
})()
