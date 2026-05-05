"use strict"

/**
 * WorldViewSummaryStrip — small grid of headline metrics for the focused
 * hub. render(host, network) writes a 5-cell flex row.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewSummaryStrip) return

    function _fmtPct(x) {
        if (!isFinite(x)) return "—"
        return Math.round(x * 100) + "%"
    }

    function _fmtCount(x) {
        if (!isFinite(x)) return "—"
        return String(Math.round(x))
    }

    function _scoreTone(score) {
        if (!isFinite(score)) return "muted"
        if (score >= 0.66) return "fierce"
        if (score >= 0.33) return "contested"
        return "quiet"
    }

    function _toneFg(tone) {
        const T = window.AESTokens
        switch (tone) {
            case "fierce":    return T.color.crimson
            case "contested": return T.color.amber
            case "quiet":     return T.color.moss
            default:          return T.color.oxide
        }
    }

    function render(host, network) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        host.textContent = ""

        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(auto-fit, minmax(140px, 1fr))",
            "gap:" + T.sp[2],
            "margin-bottom:" + T.sp[3]
        ].join(";")

        const m = (network && network.metrics) || {}
        const ally = network && network.myAlliance
        const partnerCount = network && network.carrierIndex
            ? (network.carrierIndex.partnerByEnterpriseId || []).length
            : 0
        const allianceLabel = ally
            ? (ally.name || "Alliance") + " · " + ((ally.members && ally.members.length) || 0)
            : "Solo"

        const compTone = _scoreTone(m.avgCompetitionScore)
        const compToneColor = _toneFg(compTone)

        const cells = [
            {label: "ROUTES", value: _fmtCount(m.routeCount), tone: T.color.oxide},
            {label: "WEEKLY DEPARTURES", value: _fmtCount(m.weeklyDepartures), tone: T.color.oxide},
            {label: "TOP COMPETITOR SHARE", value: _fmtPct(m.topCompetitorShare), tone: T.color.oxide2},
            {label: "AVG PRESSURE", value: _fmtPct(m.avgCompetitionScore), tone: compToneColor},
            {label: "ALLIANCE", value: allianceLabel, tone: ally ? T.color.cobalt : T.color.slate},
            {label: "PARTNERS", value: _fmtCount(partnerCount), tone: T.color.oxide2}
        ]

        for (const c of cells) {
            const cell = document.createElement("div")
            cell.style.cssText = ws.metricCell()

            const lbl = document.createElement("span")
            lbl.style.cssText = ws.metricLabel()
            lbl.textContent = c.label

            const val = document.createElement("span")
            val.style.cssText = ws.metricValue() + ";color:" + c.tone + ";"
            val.textContent = c.value

            cell.append(lbl, val)
            wrap.appendChild(cell)
        }

        host.appendChild(wrap)

        // Source freshness footnote.
        const fresh = network && network.sourceFreshness
        if (fresh && fresh.snapshotTs) {
            const note = document.createElement("div")
            note.style.cssText = "color:" + T.color.slate
                + ";font-family:" + T.font.display
                + ";font-size:" + T.fs.micro
                + ";letter-spacing:" + T.track.caps
                + ";text-transform:uppercase"
                + ";margin-top:-" + T.sp[2]
                + ";margin-bottom:" + T.sp[2] + ";"
            const parts = ["snapshot " + new Date(fresh.snapshotTs).toLocaleTimeString()]
            if (fresh.allianceTs) parts.push("alliance " + new Date(fresh.allianceTs).toLocaleDateString())
            note.textContent = parts.join(" · ")
            host.appendChild(note)
        }
    }

    window.WorldViewSummaryStrip = {render: render}
})()
