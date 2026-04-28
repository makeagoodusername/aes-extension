"use strict"

/**
 * WorldViewRecommendationsPane — renders alliance + interline cards.
 *
 * render(host, network, opts)
 *   opts: {
 *     allianceRecs: [{id, name, score, rationale, isMine, members}, ...],
 *     interlineRecs: [{enterpriseId, name, score, rationale, allianceName}, ...],
 *     onPickEnterprise?(enterpriseId, dest?)
 *   }
 *
 * If recs are not supplied, the pane shows seeding hints. The tile
 * pre-computes recs and passes them in so this view stays purely visual.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewRecommendationsPane) return

    function _scoreBadge(score) {
        const T = window.AESTokens
        const v = Math.round(score)
        const span = document.createElement("span")
        span.textContent = (v >= 0 ? "+" : "") + v
        span.style.cssText = [
            "display:inline-block",
            "min-width:32px",
            "padding:0 " + T.sp[1],
            "text-align:center",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + (v > 8 ? T.color.bone : T.color.oxide),
            "background:" + (v > 8 ? T.color.cobalt
                : v > 0 ? T.color.cobaltSoft : T.color.bone2),
            "border:" + T.geom.bw1 + " solid " + (v > 0 ? T.color.cobalt : T.color.paperRule),
            "border-radius:" + T.geom.radius
        ].join(";")
        return span
    }

    function _allianceCard(rec, opts) {
        const T = window.AESTokens
        const card = document.createElement("div")
        card.style.cssText = [
            "padding:" + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "background:" + T.color.bone,
            "margin-bottom:" + T.sp[2]
        ].join(";")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[1] + ";"
        const star = document.createElement("span")
        star.textContent = rec.isMine ? "★ MINE" : "★"
        star.style.cssText = "color:" + T.color.cobalt + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.small + ";flex:0 0 auto;"
        const name = document.createElement("span")
        name.textContent = rec.name || "Alliance"
        name.style.cssText = "font-family:" + T.font.display + ";font-weight:" + T.fw.display
            + ";color:" + T.color.oxide + ";flex:1 1 auto;letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;font-size:" + T.fs.small + ";"
        head.append(star, name, _scoreBadge(rec.score))
        card.appendChild(head)

        const body = document.createElement("div")
        body.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.body + ";line-height:" + T.lh.body + ";"
        body.textContent = rec.rationale || ""
        card.appendChild(body)

        const members = (rec.members || []).filter(m => m && m.name).slice(0, 5)
        if (members.length) {
            const mList = document.createElement("div")
            mList.style.cssText = "margin-top:" + T.sp[1] + ";display:flex;flex-wrap:wrap;gap:" + T.sp[1] + ";"
            for (const m of members) {
                const chip = document.createElement("button")
                chip.type = "button"
                chip.textContent = m.name
                chip.style.cssText = [
                    "padding:1px " + T.sp[1],
                    "background:transparent",
                    "color:" + T.color.cobalt,
                    "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                    "border-radius:" + T.geom.radius,
                    "font-family:" + T.font.mono,
                    "font-size:" + T.fs.micro,
                    "cursor:pointer"
                ].join(";")
                chip.addEventListener("click", () => {
                    if (opts && typeof opts.onPickEnterprise === "function") {
                        opts.onPickEnterprise(m.enterpriseId, null)
                    }
                })
                mList.appendChild(chip)
            }
            card.appendChild(mList)
        }
        return card
    }

    function _interlineCard(rec, opts) {
        const T = window.AESTokens
        const card = document.createElement("div")
        card.style.cssText = [
            "padding:" + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "background:" + T.color.bone,
            "margin-bottom:" + T.sp[2],
            "cursor:pointer",
            "transition:filter " + T.tr.fast
        ].join(";")

        card.addEventListener("mouseenter", () => { card.style.filter = "brightness(1.04)" })
        card.addEventListener("mouseleave", () => { card.style.filter = "none" })
        card.addEventListener("click", () => {
            if (opts && typeof opts.onPickEnterprise === "function") {
                opts.onPickEnterprise(rec.enterpriseId, null)
            }
        })

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[1] + ";"
        const arrow = document.createElement("span")
        arrow.textContent = "⇄"
        arrow.style.cssText = "color:" + T.color.amber + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.small + ";flex:0 0 auto;"
        const name = document.createElement("span")
        name.textContent = rec.name + (rec.iata ? " (" + rec.iata + ")" : "")
        name.style.cssText = "font-family:" + T.font.display + ";font-weight:" + T.fw.display
            + ";color:" + T.color.oxide + ";flex:1 1 auto;letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;font-size:" + T.fs.small + ";"
        head.append(arrow, name, _scoreBadge(rec.score))
        card.appendChild(head)

        const body = document.createElement("div")
        body.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.body + ";line-height:" + T.lh.body + ";"
        body.textContent = rec.rationale || ""
        card.appendChild(body)

        if (rec.allianceName) {
            const ally = document.createElement("div")
            ally.style.cssText = "margin-top:" + T.sp[1] + ";color:" + T.color.slate
                + ";font-family:" + T.font.display + ";font-size:" + T.fs.micro
                + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
            ally.textContent = "in " + rec.allianceName
            card.appendChild(ally)
        }

        return card
    }

    function _section(host, label, count) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        const head = document.createElement("h5")
        head.style.cssText = ws.paneTitle()
            + ";display:flex;align-items:center;justify-content:space-between;"
            + "margin-top:" + T.sp[2] + ";"
        const lbl = document.createElement("span")
        lbl.textContent = label
        const n = document.createElement("span")
        n.textContent = count + ""
        n.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";"
        head.append(lbl, n)
        host.appendChild(head)
    }

    function render(host, network, opts) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        host.textContent = ""

        const wrap = document.createElement("div")
        wrap.style.cssText = ws.panelBox()

        const title = document.createElement("h4")
        title.style.cssText = ws.paneTitle()
        title.textContent = "RECOMMENDATIONS"
        wrap.appendChild(title)

        const allianceRecs  = (opts && Array.isArray(opts.allianceRecs))  ? opts.allianceRecs  : []
        const interlineRecs = (opts && Array.isArray(opts.interlineRecs)) ? opts.interlineRecs : []
        const onPickEnterprise = opts && opts.onPickEnterprise

        if (!allianceRecs.length && !interlineRecs.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
                + "font-family:" + T.font.display + ";font-size:" + T.fs.body + ";"
            empty.textContent = "No competitor data cached for this hub yet. "
                + "Visit /app/info/airports/" + (network && network.hub || "<hub>")
                + " or scrape competitors to seed."
            wrap.appendChild(empty)
            host.appendChild(wrap)
            return
        }

        if (allianceRecs.length) {
            _section(wrap, "ALLIANCE FITS", allianceRecs.length)
            for (const rec of allianceRecs) wrap.appendChild(_allianceCard(rec, {onPickEnterprise: onPickEnterprise}))
        }

        if (interlineRecs.length) {
            _section(wrap, "INTERLINE CANDIDATES", interlineRecs.length)
            for (const rec of interlineRecs) wrap.appendChild(_interlineCard(rec, {onPickEnterprise: onPickEnterprise}))
        }

        host.appendChild(wrap)
    }

    window.WorldViewRecommendationsPane = {render: render}
})()
