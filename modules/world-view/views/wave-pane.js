"use strict"

/**
 * WorldViewWavePane — network-scale wave Gantt for the focused hub.
 *
 * Synthesizes a 3-bank preset (morning / midday / evening) from the
 * WorldViewNetwork.destinations list, runs it through
 * RouteAssistantWaveOverlay.buildSchedule, and hands the result to
 * RouteAssistantWaveOverlay.renderGantt. The overlay's existing
 * connection-graph + carrier-class hover behavior comes for free.
 *
 * Post-processes the rendered DOM to mark "loose-end" outbound bars —
 * outbounds with no valid inbound connection — with a dashed crimson
 * border so the user sees orphaned banks at a glance.
 *
 * Strict graceful-degradation: if wave-overlay or schedule-builder
 * isn't loaded on the current route, render an explanation instead of
 * throwing.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewWavePane) return

    function _haveDeps() {
        return !!(window.RouteAssistantWaveOverlay
            && typeof window.RouteAssistantWaveOverlay.buildSchedule === "function"
            && typeof window.RouteAssistantWaveOverlay.renderGantt === "function"
            && window.ScheduleFactors
            && window.SchedulePresets)
    }

    function _bucketCount(destinations, factors) {
        let s = 0, m = 0, l = 0
        if (!Array.isArray(destinations)) return {s: 0, m: 0, l: 0}
        for (const d of destinations) {
            const km = Number(d && d.distanceKm) || 0
            if (!km) continue
            const nm = window.ScheduleFactors.kmToNm(km)
            const bucket = window.ScheduleFactors.bucketize
                ? window.ScheduleFactors.bucketize(nm, factors)
                : (nm < 1500 ? "shortHaul" : nm < 3500 ? "mediumHaul" : "longHaul")
            if (bucket === "shortHaul") s++
            else if (bucket === "mediumHaul") m++
            else l++
        }
        return {s: s, m: m, l: l}
    }

    function _split3(n) {
        if (!isFinite(n) || n <= 0) return [0, 0, 0]
        const base = Math.floor(n / 3)
        const rem = n - base * 3
        return [base + (rem > 0 ? 1 : 0), base + (rem > 1 ? 1 : 0), base]
    }

    function _synthesizePreset(network) {
        const factors = window.ScheduleFactors.defaultFactors()
        // Tweak the connection window to mirror the panel's typical hub-bank
        // values; the defaults work but a 60–240 min window is what real
        // hubs run on.
        if (factors && typeof factors === "object") {
            factors.minTransferMinutes = 60
            factors.maxTransferMinutes = 240
        }

        const counts = _bucketCount(network && network.destinations, factors)
        const sSplit = _split3(counts.s)
        const mSplit = _split3(counts.m)
        const lSplit = _split3(counts.l)

        const banks = [
            {
                label: "Morning bank",
                arrivalWindow:   {start: "05:30", end: "07:30"},
                departureWindow: {start: "06:00", end: "08:00"},
                composition: {shortHaul: sSplit[0], mediumHaul: mSplit[0], longHaul: lSplit[0]}
            },
            {
                label: "Midday bank",
                arrivalWindow:   {start: "11:30", end: "13:30"},
                departureWindow: {start: "12:00", end: "14:00"},
                composition: {shortHaul: sSplit[1], mediumHaul: mSplit[1], longHaul: lSplit[1]}
            },
            {
                label: "Evening bank",
                arrivalWindow:   {start: "18:30", end: "20:30"},
                departureWindow: {start: "19:00", end: "21:00"},
                composition: {shortHaul: sSplit[2], mediumHaul: mSplit[2], longHaul: lSplit[2]}
            }
        ].map((b, i) => Object.assign({id: "wv-bank-" + (i + 1)}, b))

        return {
            id: "world-view-synthetic",
            name: "World View — synthetic 3-bank",
            hub: network && network.hub || "",
            waves: banks,
            factors: factors,
            notes: "Synthesized from WorldViewNetwork destinations (3 banks).",
            createdAt: 0,
            updatedAt: 0
        }
    }

    function _scoredRowsFromNetwork(network) {
        const rows = []
        if (!network || !Array.isArray(network.destinations)) return rows
        for (const d of network.destinations) {
            if (!d || !d.dest) continue
            if (!isFinite(d.distanceKm) || d.distanceKm <= 0) continue
            const dominantId = d.competition && d.competition.dominantEnterpriseId
            rows.push({
                destIata: d.dest,
                distanceKm: d.distanceKm,
                weeklyFlights: d.weeklyFlights,
                paxScore: d.paxScore,
                cargoScore: d.cargoScore,
                aircraftFit: "unknown",     // we don't pick a type for the network view
                marketSharePax: dominantId
                    ? [{enterpriseId: dominantId, share: 1}]
                    : [],
                _wvDest: d
            })
        }
        return rows
    }

    function _markLooseEnds(host, build) {
        if (!host || !build || !Array.isArray(build.connections)) return 0
        const T = window.AESTokens
        const overflow = build.connections.some(c => c && c.overflow)
        const seenOutbounds = new Set()
        for (const c of build.connections) {
            if (!c || c.overflow) continue
            const seq = c.outboundSeq != null ? String(c.outboundSeq)
                : c.outbound && c.outbound.flightId != null ? String(c.outbound.flightId)
                : null
            if (seq) seenOutbounds.add(seq)
        }
        let loose = 0
        const bars = host.querySelectorAll('[data-flight-seq][data-direction="outbound"]')
        for (const bar of bars) {
            if (overflow) break       // can't tell loose from cap-hidden
            const seq = bar.dataset.flightSeq
            if (!seq) continue
            if (!seenOutbounds.has(seq)) {
                bar.style.outline = "1.5px dashed " + T.color.crimson
                bar.style.outlineOffset = "-1px"
                bar.title = (bar.title || "") + "\n⚠ no inbound connection in this bank"
                loose++
            }
        }
        return overflow ? -1 : loose
    }

    function render(host, network, opts) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        host.textContent = ""

        const wrapper = document.createElement("div")
        wrapper.style.cssText = ws.panelBox()
            + ";margin-bottom:" + T.sp[3] + ";"

        const title = document.createElement("h4")
        title.style.cssText = ws.paneTitle()
        title.textContent = "WAVE — three banks (morning · midday · evening)"
        wrapper.appendChild(title)

        host.appendChild(wrapper)

        if (!_haveDeps()) {
            const note = document.createElement("p")
            note.style.cssText = "margin:0;color:" + T.color.slate
                + ";font-family:" + T.font.display
                + ";font-size:" + T.fs.body + ";"
            note.textContent = "Wave overlay unavailable — wave-overlay.js or schedule-builder isn't loaded on this page."
            wrapper.appendChild(note)
            return
        }

        if (!network || !Array.isArray(network.destinations) || !network.destinations.length) {
            const note = document.createElement("p")
            note.style.cssText = "margin:0;color:" + T.color.slate + ";"
            note.textContent = "No destinations to schedule."
            wrapper.appendChild(note)
            return
        }

        const preset = _synthesizePreset(network)
        const scoredRows = _scoredRowsFromNetwork(network)

        // Build the carrier classifier closure.
        let classifier = null
        if (window.WorldViewCarrierClassifier) {
            const partners = new Map()
            const carrierIdx = network.carrierIndex || {}
            const partnerArr = Array.isArray(carrierIdx.partnerByEnterpriseId)
                ? carrierIdx.partnerByEnterpriseId
                : []
            for (const e of partnerArr) {
                if (e && e.id != null) partners.set(String(e.id), e.rels || [])
            }
            const ownIds = new Set((carrierIdx.ownEnterpriseIds || []).map(String))
            const leadByDest = window.WorldViewCarrierClassifier.leadByDestFromNetwork(network)
            classifier = window.WorldViewCarrierClassifier.build({
                ownEnterpriseIds: ownIds,
                partnerByEnterpriseId: partners,
                leadByDest: leadByDest,
                fallback: "own"     // empty-competition routes render in cobalt
            })
        }

        let build
        try {
            build = window.RouteAssistantWaveOverlay.buildSchedule(preset, scoredRows, {
                server:      network.server || "",
                airlineCode: network.airlineCode || "",
                hubIata:     network.hub,
                topN:        scoredRows.length,
                carrierClassifier: classifier
            })
        } catch (e) {
            console.warn("[AES WorldView] buildSchedule failed", e)
            const note = document.createElement("p")
            note.style.cssText = "margin:0;color:" + T.color.crimson + ";"
            note.textContent = "Wave build failed (see console)."
            wrapper.appendChild(note)
            return
        }

        // Stats strip — placements / connections / loose ends.
        const stats = document.createElement("div")
        stats.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[3]
            + ";margin-bottom:" + T.sp[2]
            + ";font-family:" + T.font.mono + ";font-size:" + T.fs.small
            + ";color:" + T.color.oxide2 + ";"
        const placedN  = (build.placements || []).filter(p => p && !p.unplaced).length
        const totalN   = (build.routes || []).length
        const connN    = (build.connections || []).filter(c => c && !c.overflow).length
        const overflow = (build.connections || []).some(c => c && c.overflow)
        stats.append(
            _statCell("Placed",      placedN + " / " + totalN),
            _statCell("Connections", connN + (overflow ? "+ (capped)" : "")),
            _statCell("Warnings",    (build.warnings || []).length)
        )
        wrapper.appendChild(stats)

        const ganttHost = document.createElement("div")
        ganttHost.style.cssText = "background:#0b1220;border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";padding:6px;color:#f3f4f6;"
        wrapper.appendChild(ganttHost)

        try {
            window.RouteAssistantWaveOverlay.renderGantt(ganttHost, build, {
                hubIata: network.hub,
                onFlightClick: (flight, route) => {
                    if (opts && typeof opts.onFlightClick === "function") {
                        try { opts.onFlightClick(flight, route) } catch (_) {}
                    }
                }
            })
        } catch (e) {
            console.warn("[AES WorldView] renderGantt failed", e)
            const note = document.createElement("p")
            note.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.crimson + ";"
            note.textContent = "Wave render failed (see console)."
            wrapper.appendChild(note)
            return
        }

        const looseCount = _markLooseEnds(ganttHost, build)
        if (looseCount > 0) {
            const note = document.createElement("div")
            note.style.cssText = "margin-top:" + T.sp[2] + ";font-family:" + T.font.display
                + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
                + ";text-transform:uppercase;color:" + T.color.crimson + ";"
            note.textContent = looseCount + " loose-end outbound" + (looseCount === 1 ? "" : "s")
                + " — no banked inbound connection (dashed crimson border)"
            wrapper.appendChild(note)
        } else if (looseCount < 0) {
            const note = document.createElement("div")
            note.style.cssText = "margin-top:" + T.sp[2] + ";color:" + T.color.amber
                + ";font-family:" + T.font.display + ";font-size:" + T.fs.micro + ";"
            note.textContent = "Connection graph capped — loose-end detection skipped."
            wrapper.appendChild(note)
        }

        // Optional: collapsed warnings.
        const filteredWarns = (build.warnings || [])
            .filter(w => w && !/slot/i.test(w))    // 24h synthetic window — slot warnings are noise
        if (filteredWarns.length) {
            const det = document.createElement("details")
            det.style.cssText = "margin-top:" + T.sp[2] + ";color:" + T.color.slate + ";"
                + "font-family:" + T.font.display + ";font-size:" + T.fs.micro + ";"
            const sum = document.createElement("summary")
            sum.textContent = filteredWarns.length + " build warning" + (filteredWarns.length === 1 ? "" : "s")
            sum.style.cursor = "pointer"
            det.appendChild(sum)
            const ul = document.createElement("ul")
            ul.style.cssText = "margin:" + T.sp[1] + " 0 0 " + T.sp[3] + ";padding:0;"
            for (const w of filteredWarns.slice(0, 12)) {
                const li = document.createElement("li")
                li.textContent = String(w)
                ul.appendChild(li)
            }
            det.appendChild(ul)
            wrapper.appendChild(det)
        }
    }

    function _statCell(label, value) {
        const T = window.AESTokens
        const span = document.createElement("span")
        span.style.cssText = "display:inline-flex;align-items:baseline;gap:" + T.sp[1] + ";"
        const lbl = document.createElement("span")
        lbl.textContent = label
        lbl.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
        const val = document.createElement("span")
        val.textContent = String(value)
        val.style.cssText = "color:" + T.color.oxide + ";"
        span.append(lbl, val)
        return span
    }

    window.WorldViewWavePane = {render: render}
})()
