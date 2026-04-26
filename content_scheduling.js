"use strict"

/**
 * AirlineSim scheduling page hook — mounts the Route Assistant side panel
 * once the Wicket editor is visible.
 *
 * The scheduling editor is Wicket-rendered and its origin-airport selector
 * isn't a stable DOM anchor, so we try a handful of selectors to find the
 * current "from" airport; users can also override via the panel's Refresh
 * button after changing the origin in the editor.
 */

const AES_FF_SCHED = {
    // First non-null result wins. Looks for an IATA code (3 uppercase letters)
    // in several common AirlineSim scheduler anchors.
    ORIGIN_IATA_LOOKUPS: [
        () => readIataFromSelectedOption("select[name*='origin']"),
        () => readIataFromSelectedOption("select[name*='departure']"),
        () => readIataFromSelectedOption("select[name*='from']"),
        () => readIataFromText(".origin, .from, [class*='origin'], [class*='departure']"),
        () => readIataFromAncestorLabel("Origin"),
        () => readIataFromAncestorLabel("From"),
        () => readIataFromUrl()
    ]
}

function readIataFromSelectedOption(selectSelector) {
    const el = document.querySelector(selectSelector)
    if (!el) return null
    const opt = el.options[el.selectedIndex]
    if (!opt) return null
    return matchIata(opt.textContent) || matchIata(opt.value)
}

function readIataFromText(selector) {
    for (const el of document.querySelectorAll(selector)) {
        const hit = matchIata(el.textContent)
        if (hit) return hit
    }
    return null
}

function readIataFromAncestorLabel(labelText) {
    const labels = Array.from(document.querySelectorAll("label, .control-label, th, dt"))
    for (const lbl of labels) {
        if (!new RegExp("\\b" + labelText + "\\b", "i").test(lbl.textContent || "")) continue
        const sibling = lbl.nextElementSibling || lbl.parentElement
        if (!sibling) continue
        const hit = matchIata(sibling.textContent)
        if (hit) return hit
    }
    return null
}

function readIataFromUrl() {
    const m = /[?&]origin=([A-Z]{3})\b/i.exec(window.location.href)
    return m ? m[1].toUpperCase() : null
}

function matchIata(text) {
    if (!text) return null
    // Prefer a code in parentheses — "London Heathrow (LHR)" — since options
    // often contain the city name first and a non-IATA three-letter token.
    const paren = /\(([A-Z]{3})\)/.exec(text)
    if (paren) return paren[1]
    const m = /\b([A-Z]{3})\b/.exec(text)
    return m ? m[1] : null
}

;(function aesRouteAssistantMain() {
    // Wait briefly for the Wicket editor to render before mounting.
    const start = Date.now()
    const tryMount = () => {
        const editorReady = document.querySelector("select, .as-panel, .scheduling, form") != null
        if (editorReady || Date.now() - start > 15000) {
            const panel = new RouteAssistantPanel({
                resolveOriginIata: () => {
                    for (const fn of AES_FF_SCHED.ORIGIN_IATA_LOOKUPS) {
                        try {
                            const out = fn()
                            if (out) return out.toUpperCase()
                        } catch (e) { /* noop */ }
                    }
                    return null
                }
            })
            panel.mount()
            captureLivePriceIfRoutePage()
            return
        }
        setTimeout(tryMount, 500)
    }
    tryMount()
})()

/**
 * If the current URL is a specific-route scheduling page
 * (`/app/com/scheduling/<HUB><DEST>` — 6 uppercase letters), run the
 * ticket-price scraper against the live DOM and write the result into the
 * cache. Free per-route capture organic to the user's navigation. The
 * route-assistant panel picks up the value on its next refresh.
 */
function captureLivePriceIfRoutePage() {
    if (typeof RouteAssistantTicketPriceScraper === "undefined") return
    const m = /\/app\/com\/scheduling\/([A-Z]{3})([A-Z]{3})(?:[/?#]|$)/.exec(window.location.pathname)
    if (!m) return
    const hub  = m[1]
    const dest = m[2]

    // Wicket pages can render async — give the DOM a moment to settle so
    // the scraper sees the populated fares/ORS rows. 1.5 s is long enough
    // in practice without making the read feel laggy.
    setTimeout(() => {
        try {
            const fields = RouteAssistantTicketPriceScraper.parseFromDoc(document)
            // Only persist if we actually parsed something useful, else
            // we'd overwrite a good cached record with all-nulls on a
            // Wicket sub-page that lacks the schedule table.
            const haveSomething = fields && (
                (fields.flights && fields.flights.length)
                || fields.cruiseSpeedKmh
                || fields.ourPrice !== null
                || fields.ourYield !== null
                || fields.orsRank !== null
            )
            if (!haveSomething) return
            RouteAssistantTicketPriceScraper.saveRecord(hub, dest, fields, "live").then(() => {
                console.log("[AES priceScraper] live-captured", hub + "→" + dest, fields)
            })
        } catch (e) {
            console.warn("[AES priceScraper] live capture failed", e)
        }
    }, 1500)
}
