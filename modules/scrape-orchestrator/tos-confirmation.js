"use strict"

/**
 * ScrapeTosConfirmation — first-run modal that surfaces the bulk-scrape
 * implications (page count, runtime estimate, AS ToS uncertainty) and
 * captures the user's two optional-phase toggles.
 *
 * Resolves to:
 *   {confirmed: true, includePerCompetitor: bool, includeFlightsFrom: bool}
 *   {confirmed: false}
 *
 * Persists `scrapeOrchestrator:tosAccepted: true` to skip the modal on
 * subsequent runs (the two toggles still appear inside the progress
 * modal header so the user can change them per run).
 */
class ScrapeTosConfirmation {
    static STORAGE_KEY = "scrapeOrchestrator:tosAccepted"

    static async hasAccepted() {
        const blob = await chrome.storage.local.get([ScrapeTosConfirmation.STORAGE_KEY])
        return !!blob[ScrapeTosConfirmation.STORAGE_KEY]
    }

    static async show(estimate) {
        return new Promise((resolve) => {
            const T = window.AESTokens
            const overlay = ScrapeTosConfirmation._buildOverlay(T)
            const card    = ScrapeTosConfirmation._buildCard(T, estimate, (result) => {
                document.body.removeChild(overlay)
                if (result.confirmed) {
                    chrome.storage.local.set({[ScrapeTosConfirmation.STORAGE_KEY]: true}).catch(() => {})
                }
                resolve(result)
            })
            overlay.appendChild(card)
            document.body.appendChild(overlay)
        })
    }

    static _buildOverlay(T) {
        const el = document.createElement("div")
        el.className = "aes-scrape-tos-overlay"
        el.style.cssText = [
            "position:fixed",
            "inset:0",
            "background:rgba(20, 20, 20, 0.6)",
            "z-index:99998",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:" + T.sp[4]
        ].join(";")
        return el
    }

    static _buildCard(T, est, onResult) {
        const card = document.createElement("div")
        card.className = "aes-scrape-tos-card aes-panel"
        card.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[4],
            "max-width:640px",
            "width:100%",
            "max-height:90vh",
            "overflow-y:auto",
            "font-family:" + T.font.display
        ].join(";")

        const heading = document.createElement("h2")
        heading.textContent = "Scrape everything"
        heading.style.cssText = [
            "margin:0 0 " + T.sp[3] + " 0",
            "font-size:" + T.fs.h2,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps
        ].join(";")
        card.appendChild(heading)

        const intro = document.createElement("p")
        intro.style.cssText = "margin:0 0 " + T.sp[3] + " 0;color:" + T.color.oxide2 + ";"
        intro.textContent = "This opens hidden background tabs and walks every AS page the extension knows how to scrape, then closes them. You can keep using your foreground tab while it runs."
        card.appendChild(intro)

        const breakdown = document.createElement("ul")
        breakdown.style.cssText = [
            "list-style:none",
            "margin:0 0 " + T.sp[3] + " 0",
            "padding:0",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide2
        ].join(";")
        const lines = [
            "Foundation (fleet, finance, alliance, crew)" + ScrapeTosConfirmation._countSuffix(est.foundation),
            est.hubs + " hub" + (est.hubs === 1 ? "" : "s") + " — scheduling pages" + ScrapeTosConfirmation._countSuffix(est.perHub),
            est.aircraft + " aircraft × 2 pages each" + ScrapeTosConfirmation._countSuffix(est.perAircraft),
            est.routes + " route" + (est.routes === 1 ? "" : "s") + " — markets + inventory" + ScrapeTosConfirmation._countSuffix(est.perRoute),
            est.competitors + " tracked competitor" + (est.competitors === 1 ? "" : "s") + " (optional)" + ScrapeTosConfirmation._countSuffix(est.perCompetitor),
            est.airports + " airport" + (est.airports === 1 ? "" : "s") + " — flightsfrom.com (optional)" + ScrapeTosConfirmation._countSuffix(est.flightsFrom)
        ]
        for (const text of lines) {
            const li = document.createElement("li")
            li.textContent = "• " + text
            li.style.padding = "2px 0"
            breakdown.appendChild(li)
        }
        card.appendChild(breakdown)

        const totalRequired = est.foundation + est.perHub + est.perAircraft + est.perRoute
        const totalEstimateMin = Math.ceil((est.foundation + est.perHub + est.perAircraft) * 2 / 60 + est.perRoute * 3 / 60)
        const total = document.createElement("p")
        total.style.cssText = "margin:0 0 " + T.sp[3] + " 0;font-family:" + T.font.mono + ";color:" + T.color.oxide + ";"
        total.textContent = "Required: ~" + totalRequired + " page loads · estimated ~" + totalEstimateMin + " min (ORS dominates the per-route phase)"
        card.appendChild(total)

        const warn = document.createElement("p")
        warn.style.cssText = [
            "margin:0 0 " + T.sp[3] + " 0",
            "padding:" + T.sp[2],
            "background:" + T.color.amberSoft,
            "color:" + T.color.amber,
            "border:" + T.geom.bw1 + " solid " + T.color.amber,
            "border-radius:" + T.geom.radius,
            "font-size:" + T.fs.body
        ].join(";")
        warn.textContent = "AirlineSim's Terms of Service do not explicitly authorise multi-tab automation. You assume responsibility for whether this fits your account's acceptable use. The orchestrator halts on 3× rate-limit (429/503) for a 10-minute cooldown."
        card.appendChild(warn)

        const optWrap = document.createElement("div")
        optWrap.style.cssText = "margin-bottom:" + T.sp[3] + ";"
        const competitorChk = ScrapeTosConfirmation._buildCheckbox(T, "include-competitor", "Include per-competitor enrichment (" + est.perCompetitor + " pages)")
        const flightsfromChk = ScrapeTosConfirmation._buildCheckbox(T, "include-flightsfrom", "Include flightsfrom.com (" + est.flightsFrom + " pages, slower)")
        optWrap.append(competitorChk.label, competitorChk.divider, flightsfromChk.label)
        card.appendChild(optWrap)

        const buttons = document.createElement("div")
        buttons.style.cssText = "display:flex;gap:" + T.sp[2] + ";justify-content:flex-end;"
        const cancel = ScrapeTosConfirmation._buildBtn(T, "Cancel", "ghost")
        cancel.addEventListener("click", () => onResult({confirmed: false}))
        const proceed = ScrapeTosConfirmation._buildBtn(T, "I understand · proceed", "primary")
        proceed.addEventListener("click", () => onResult({
            confirmed:            true,
            includePerCompetitor: competitorChk.input.checked,
            includeFlightsFrom:   flightsfromChk.input.checked
        }))
        buttons.append(cancel, proceed)
        card.appendChild(buttons)

        return card
    }

    static _countSuffix(n) {
        if (n == null) return ""
        return " — ~" + n + " pages"
    }

    static _buildCheckbox(T, id, labelText) {
        const wrap = document.createElement("label")
        wrap.style.cssText = "display:flex;align-items:center;gap:" + T.sp[2] + ";cursor:pointer;padding:" + T.sp[1] + " 0;"
        const input = document.createElement("input")
        input.type = "checkbox"
        input.id   = "aes-scrape-tos-" + id
        const text = document.createElement("span")
        text.textContent = labelText
        text.style.cssText = "color:" + T.color.oxide2 + ";font-size:" + T.fs.body + ";"
        wrap.append(input, text)
        const divider = document.createElement("div")
        divider.style.height = "0"
        return {label: wrap, input: input, divider: divider}
    }

    static _buildBtn(T, label, kind) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = label
        const isPrimary = kind === "primary"
        btn.style.cssText = [
            "background:" + (isPrimary ? T.color.oxide : "transparent"),
            "color:"      + (isPrimary ? T.color.bone  : T.color.oxide),
            "border:"     + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";")
        return btn
    }
}

if (typeof window !== "undefined") {
    window.ScrapeTosConfirmation = ScrapeTosConfirmation
}
