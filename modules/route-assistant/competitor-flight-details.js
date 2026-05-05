"use strict";

/**
 * Joins the markets-page "Current Availability" flight list to the
 * Route Assistant's per-enterprise competitor rows.
 *
 * The markets page gives per-flight facts (flight number, departure,
 * aircraft, class, available seats, price) but not enterprise ids. The
 * market-share table gives enterprise ids/names but not the flight rows.
 * This helper connects them through the carrier prefix/IATA code and
 * produces compact display summaries for the competitor popover.
 */
(function() {
    "use strict"

    const CLASS_ORDER = ["Y", "C", "F", "Cargo"]

    function num(v) {
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    function normaliseClassKey(label) {
        const raw = String(label || "").trim().toUpperCase().replace(/\s+/g, " ")
        if (!raw) return null
        if (raw === "Y" || raw === "ECONOMY" || raw === "ECONOMY CLASS") return "Y"
        if (raw === "C" || raw === "BUSINESS" || raw === "BUSINESS CLASS") return "C"
        if (raw === "F" || raw === "FIRST" || raw === "FIRST CLASS") return "F"
        if (raw === "CARGO" || raw === "FREIGHT" || raw === "MAIL") return "Cargo"
        return null
    }

    function flightPrefix(flightCode) {
        const code = String(flightCode || "").trim().toUpperCase()
        if (!code) return null
        const spaced = /^([A-Z0-9]{1,4})\s+\d/.exec(code)
        if (spaced) return spaced[1]
        const compact = /^([A-Z]{2,4})(?=\d)/.exec(code)
        if (compact) return compact[1]
        const first = /^([A-Z0-9]{1,4})/.exec(code)
        return first ? first[1] : null
    }

    function addPrefix(set, value) {
        const p = String(value || "").trim().toUpperCase()
        if (!p || !/^[A-Z0-9]{1,4}$/.test(p)) return
        set.add(p)
    }

    function prefixesForEntry(entry) {
        const set = new Set()
        if (!entry) return []
        addPrefix(set, entry.iata)
        addPrefix(set, entry.flightPrefix)
        addPrefix(set, entry.routeFlightPrefix)
        addPrefix(set, entry.prefix)
        addPrefix(set, entry.carrierPrefix)
        if (entry.fromFlightList && entry.name) {
            const m = /^([A-Z0-9]{1,4})\b/.exec(String(entry.name).trim().toUpperCase())
            if (m) addPrefix(set, m[1])
        }
        return Array.from(set)
    }

    function typeSpecFor(typeId, typeSpecs) {
        if (typeId == null || !typeSpecs) return null
        if (typeSpecs instanceof Map) {
            return typeSpecs.get(typeId) || typeSpecs.get(String(typeId)) || null
        }
        return typeSpecs[typeId] || typeSpecs[String(typeId)] || null
    }

    function normaliseFlight(flight, typeSpecs) {
        if (!flight || flight.isOurs) return null
        const prefix = flight.carrierPrefix || flight.operatorPrefix || flightPrefix(flight.flightCode)
        if (!prefix) return null
        const cls = normaliseClassKey(flight.serviceClass)
        const typeId = num(flight.typeId)
        const spec = typeSpecFor(typeId, typeSpecs)
        const seatCapacity = num(flight.seatCapacity) != null ? num(flight.seatCapacity)
            : (num(flight.seats) != null ? num(flight.seats) : (spec && num(spec.seats)))
        const cargoCapacity = num(flight.cargoCapacity) != null ? num(flight.cargoCapacity)
            : (spec && num(spec.cargoCapacity))
        return {
            prefix,
            hub:           flight.hub || null,
            dest:          flight.dest || flight.destination || null,
            routePair:     flight.routePair || null,
            dir:           flight.dir || null,
            flightCode:    flight.flightCode || null,
            flightId:      flight.flightId != null ? flight.flightId : null,
            typeCode:      flight.typeCode || (spec && spec.typeName) || null,
            typeId:        typeId,
            depDateLocal:  flight.depDateLocal || null,
            depTimeLocal:  flight.depTimeLocal || null,
            depTimeUtc:    flight.depTimeUtc || null,
            arrTimeLocal:  flight.arrTimeLocal || null,
            serviceClass:  cls || flight.serviceClass || null,
            availability:  num(flight.availability),
            capacity:      num(flight.capacity),
            booked:        num(flight.booked),
            loadPct:       num(flight.loadPct),
            price:         num(flight.price),
            status:        flight.status || null,
            seatCapacity:  seatCapacity,
            cargoCapacity: cargoCapacity
        }
    }

    function instanceKey(f) {
        return [
            f.flightId != null ? "id:" + f.flightId : "",
            f.flightCode || "",
            f.depDateLocal || "",
            f.depTimeLocal || "",
            f.typeId != null ? f.typeId : (f.typeCode || "")
        ].join("|")
    }

    function median(values) {
        const xs = (values || []).filter(v => isFinite(Number(v))).map(Number).sort((a, b) => a - b)
        if (!xs.length) return null
        const mid = Math.floor(xs.length / 2)
        return (xs.length % 2) ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
    }

    function priceStats(values) {
        const xs = (values || []).filter(v => isFinite(Number(v))).map(Number).sort((a, b) => a - b)
        if (!xs.length) return null
        return {
            count:  xs.length,
            min:    xs[0],
            max:    xs[xs.length - 1],
            median: median(xs)
        }
    }

    function buildFlightInstances(flights, opts) {
        opts = opts || {}
        const typeSpecs = opts.typeSpecs || null
        const rows = []
        for (const f of (flights || [])) {
            const nf = normaliseFlight(f, typeSpecs)
            if (nf) rows.push(nf)
        }
        const instances = new Map()
        for (const f of rows) {
            const ik = instanceKey(f)
            let inst = instances.get(ik)
            if (!inst) {
                inst = {
                    prefix:        f.prefix,
                    hub:           f.hub,
                    dest:          f.dest,
                    routePair:     f.routePair,
                    dir:           f.dir,
                    flightCode:    f.flightCode,
                    flightId:      f.flightId,
                    typeCode:      f.typeCode,
                    typeId:        f.typeId,
                    depDateLocal:  f.depDateLocal,
                    depTimeLocal:  f.depTimeLocal,
                    depTimeUtc:    f.depTimeUtc,
                    arrTimeLocal:  f.arrTimeLocal,
                    arrTimeUtc:    f.arrTimeUtc,
                    status:        f.status,
                    seatCapacity:  f.seatCapacity,
                    cargoCapacity: f.cargoCapacity,
                    classes:       {}
                }
                instances.set(ik, inst)
            }
            if (f.serviceClass) {
                inst.classes[f.serviceClass] = {
                    price:        f.price,
                    availability: f.availability,
                    capacity:     f.capacity,
                    booked:       f.booked,
                    loadPct:      f.loadPct
                }
            }
        }
        return Array.from(instances.values()).sort((a, b) => {
            const ad = String(a.depDateLocal || "") + " " + String(a.depTimeLocal || a.depTimeUtc || "")
            const bd = String(b.depDateLocal || "") + " " + String(b.depTimeLocal || b.depTimeUtc || "")
            const cmp = ad.localeCompare(bd)
            if (cmp) return cmp
            return String(a.flightCode || "").localeCompare(String(b.flightCode || ""))
        })
    }

    function summariseFlights(flights, opts) {
        opts = opts || {}
        const typeSpecs = opts.typeSpecs || null
        const rows = []
        for (const f of (flights || [])) {
            const nf = normaliseFlight(f, typeSpecs)
            if (nf) rows.push(nf)
        }
        if (!rows.length) return null

        const byClass = {}
        for (const cls of CLASS_ORDER) byClass[cls] = []
        const aircraft = new Map()
        const instArr = buildFlightInstances(flights, opts)
        for (const f of rows) {
            if (f.serviceClass && byClass[f.serviceClass]) byClass[f.serviceClass].push(f)
            const ak = (f.typeId != null ? "id:" + f.typeId : "code:" + (f.typeCode || "?"))
            let ac = aircraft.get(ak)
            if (!ac) {
                ac = {
                    typeCode:      f.typeCode,
                    typeId:        f.typeId,
                    seatCapacity:  f.seatCapacity,
                    cargoCapacity: f.cargoCapacity,
                    flights:       0
                }
                aircraft.set(ak, ac)
            }
        }
        for (const inst of instArr) {
            const ak = (inst.typeId != null ? "id:" + inst.typeId : "code:" + (inst.typeCode || "?"))
            const ac = aircraft.get(ak)
            if (ac) ac.flights += 1
        }

        const pricesByClass = {}
        for (const cls of CLASS_ORDER) {
            const stats = priceStats(byClass[cls].map(f => f.price))
            if (stats) pricesByClass[cls] = stats
        }

        const depTimes = []
        const depSeen = new Set()
        for (const f of instArr) {
            if (!f.depTimeLocal || depSeen.has(f.depTimeLocal)) continue
            depSeen.add(f.depTimeLocal)
            depTimes.push(f.depTimeLocal)
            if (depTimes.length >= 5) break
        }

        let totalSeatCapacity = 0
        let seatKnown = 0
        let totalCargoCapacity = 0
        let cargoKnown = 0
        for (const f of instArr) {
            if (f.seatCapacity != null) {
                totalSeatCapacity += f.seatCapacity
                seatKnown++
            }
            if (f.cargoCapacity != null) {
                totalCargoCapacity += f.cargoCapacity
                cargoKnown++
            }
        }

        return {
            prefixes:           Array.from(new Set(rows.map(f => f.prefix))).sort(),
            flightCount:        instArr.length,
            rowCount:           rows.length,
            pricesByClass,
            aircraft:           Array.from(aircraft.values()).sort((a, b) => b.flights - a.flights),
            departures:         depTimes,
            totalSeatCapacity:  seatKnown ? totalSeatCapacity : null,
            totalCargoCapacity: cargoKnown ? totalCargoCapacity : null,
            sampleFlights:      instArr.slice(0, opts.sampleLimit || 6),
            capacityComplete:   seatKnown === instArr.length || cargoKnown === instArr.length
        }
    }

    function attachFlightDetails(entries, marketFlights, opts) {
        opts = opts || {}
        const list = Array.isArray(entries) ? entries : []
        const grouped = new Map()
        for (const f of (marketFlights || [])) {
            if (!f || f.isOurs) continue
            const p = flightPrefix(f.flightCode)
            if (!p) continue
            if (!grouped.has(p)) grouped.set(p, [])
            grouped.get(p).push(f)
        }
        if (!list.length || !grouped.size) return list

        for (const entry of list) {
            const prefixes = prefixesForEntry(entry)
            let flights = []
            for (const p of prefixes) {
                const bucket = grouped.get(p)
                if (bucket && bucket.length) flights = flights.concat(bucket)
            }
            if (!flights.length && Array.isArray(entry.routeFlights) && entry.routeFlights.length) {
                flights = entry.routeFlights.slice()
            }
            if (!flights.length && list.length === 1 && grouped.size === 1) {
                flights = Array.from(grouped.values())[0].slice()
            }
            const detail = summariseFlights(flights, opts)
            if (detail) {
                entry.routeFlightDetail = detail
                entry.routeFlights = detail.sampleFlights
                if (!entry.flightPrefix && detail.prefixes.length === 1) entry.flightPrefix = detail.prefixes[0]
            }
        }
        return list
    }

    function decorateRow(row, opts) {
        if (!row) return row
        opts = opts || {}
        const flights = row.marketCompetitorFlights || row.competitorMarketFlights
            || row.competitorFlights || []
        if (!Array.isArray(flights) || !flights.length) return row
        attachFlightDetails(row.competitorEntries, flights, opts)
        attachFlightDetails(row.marketSharePax, flights, opts)
        attachFlightDetails(row.marketShareCargo, flights, opts)
        return row
    }

    function collectTypeIdsFromRows(rows) {
        const ids = new Set()
        for (const row of (rows || [])) {
            const flights = row && (row.marketCompetitorFlights || row.competitorMarketFlights
                || row.competitorFlights)
            if (!Array.isArray(flights)) continue
            for (const f of flights) {
                const id = num(f && f.typeId)
                if (id != null) ids.add(id)
            }
        }
        return Array.from(ids)
    }

    function fmtInt(v) {
        return v == null || !isFinite(Number(v)) ? null : Number(v).toLocaleString()
    }

    function fmtPrice(cls, v) {
        if (v == null || !isFinite(Number(v))) return null
        if (cls === "Cargo" && Math.abs(Number(v)) < 20) return Number(v).toFixed(2) + " AS$/kg"
        return Math.round(Number(v)).toLocaleString() + " AS$"
    }

    function formatFlightClasses(flight) {
        const parts = []
        const classes = (flight && flight.classes) || {}
        for (const cls of CLASS_ORDER) {
            const c = classes[cls]
            if (!c) continue
            const bits = []
            const price = fmtPrice(cls, c.price)
            if (price) bits.push(price)
            if (c.capacity != null) bits.push("cap " + fmtInt(c.capacity))
            if (c.booked != null) bits.push("bkd " + fmtInt(c.booked))
            if (c.loadPct != null) bits.push("load " + c.loadPct + "%")
            if (c.availability != null) bits.push("avail " + fmtInt(c.availability))
            parts.push(cls + (bits.length ? " " + bits.join(" ") : ""))
        }
        return parts.join(" / ")
    }

    function formatFlightLine(flight) {
        if (!flight) return ""
        const parts = []
        if (flight.routePair) parts.push(flight.routePair)
        if (flight.depTimeLocal || flight.depTimeUtc) parts.push("dep " + (flight.depTimeLocal || flight.depTimeUtc))
        if (flight.arrTimeLocal || flight.arrTimeUtc) parts.push("arr " + (flight.arrTimeLocal || flight.arrTimeUtc))
        if (flight.typeCode) parts.push(flight.typeCode)
        if (flight.seatCapacity != null) parts.push(fmtInt(flight.seatCapacity) + " seats")
        else if (flight.cargoCapacity != null) parts.push(fmtInt(flight.cargoCapacity) + " kg cargo")
        const cls = formatFlightClasses(flight)
        if (cls) parts.push(cls)
        return ((flight.flightCode || "flight") + (parts.length ? " | " + parts.join(" | ") : ""))
    }

    function formatSummary(detail) {
        if (!detail || !detail.flightCount) return ""
        const parts = [detail.flightCount + " flt"]
        if (detail.totalSeatCapacity != null) parts.push(fmtInt(detail.totalSeatCapacity) + " seats")
        const priceBits = []
        for (const cls of CLASS_ORDER) {
            const st = detail.pricesByClass && detail.pricesByClass[cls]
            const p = st && fmtPrice(cls, st.median)
            if (p) priceBits.push(cls + " med " + p)
            if (priceBits.length >= 2) break
        }
        if (priceBits.length) parts.push(priceBits.join(" / "))
        if (detail.departures && detail.departures.length) {
            parts.push("dep " + detail.departures.slice(0, 3).join("/"))
        }
        if (detail.aircraft && detail.aircraft.length) {
            const a = detail.aircraft[0]
            let txt = a.typeCode || (a.typeId != null ? "type " + a.typeId : "aircraft")
            if (a.seatCapacity != null) txt += " " + fmtInt(a.seatCapacity) + " seats"
            if (a.flights > 1) txt += " x" + a.flights
            parts.push(txt)
        }
        return parts.join(" | ")
    }

    function formatTooltip(detail) {
        if (!detail || !detail.flightCount) return ""
        const lines = []
        lines.push("Flight detail from AS Market Analysis")
        lines.push("Flights: " + detail.flightCount + " (" + (detail.prefixes || []).join(", ") + ")")
        if (detail.totalSeatCapacity != null) {
            lines.push("Visible seat capacity: " + fmtInt(detail.totalSeatCapacity))
        }
        if (detail.totalCargoCapacity != null) {
            lines.push("Visible cargo capacity: " + fmtInt(detail.totalCargoCapacity) + " kg")
        }
        for (const cls of CLASS_ORDER) {
            const st = detail.pricesByClass && detail.pricesByClass[cls]
            if (!st) continue
            lines.push(cls + " prices: median " + fmtPrice(cls, st.median)
                + " | min " + fmtPrice(cls, st.min)
                + " | max " + fmtPrice(cls, st.max)
                + " | n=" + st.count)
        }
        if (detail.aircraft && detail.aircraft.length) {
            lines.push("Aircraft:")
            for (const a of detail.aircraft.slice(0, 6)) {
                let s = "  " + (a.typeCode || (a.typeId != null ? "type " + a.typeId : "?"))
                    + " x" + a.flights
                if (a.seatCapacity != null) s += " | " + fmtInt(a.seatCapacity) + " seats"
                if (a.cargoCapacity != null) s += " | " + fmtInt(a.cargoCapacity) + " kg cargo"
                lines.push(s)
            }
        }
        if (detail.sampleFlights && detail.sampleFlights.length) {
            lines.push("Sample flights:")
            for (const f of detail.sampleFlights) {
                const clsBits = []
                for (const cls of CLASS_ORDER) {
                    const c = f.classes && f.classes[cls]
                    if (!c) continue
                    const p = fmtPrice(cls, c.price)
                    const avail = c.availability != null ? " avail " + c.availability : ""
                    const cap = c.capacity != null ? " cap " + fmtInt(c.capacity) : ""
                    const booked = c.booked != null ? " bkd " + fmtInt(c.booked) : ""
                    const load = c.loadPct != null ? " load " + c.loadPct + "%" : ""
                    clsBits.push(cls + (p ? " " + p : "") + cap + booked + load + avail)
                }
                let s = "  " + (f.flightCode || "?")
                    + " " + (f.depTimeLocal || "?")
                    + " " + (f.typeCode || "")
                if (f.seatCapacity != null) s += " " + fmtInt(f.seatCapacity) + " seats"
                if (clsBits.length) s += " | " + clsBits.join(" / ")
                lines.push(s)
            }
        }
        return lines.join("\n")
    }

    const api = {
        CLASS_ORDER,
        normaliseClassKey,
        flightPrefix,
        prefixesForEntry,
        normaliseMarketFlight: normaliseFlight,
        buildFlightInstances,
        summariseFlights,
        attachFlightDetails,
        decorateRow,
        collectTypeIdsFromRows,
        formatFlightClasses,
        formatFlightLine,
        formatSummary,
        formatTooltip
    }

    if (typeof window !== "undefined") {
        window.RouteAssistantCompetitorFlightDetails = api
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api
    }
})()
