"use strict"

/**
 * Live-capture hook for the AS Market Analysis page
 * (`/app/com/markets/<HUB><DEST>`).
 *
 * When the user navigates to a per-route markets page, parse the current DOM
 * after a short Wicket-render delay and persist the four split records
 * (competitors, ownPricing, marketShare, historic) under the
 * `routeAssistant:markets:*:<HUB>-<DEST>` keys. The Route Assistant panel on
 * the scheduling page picks them up on its next refresh.
 *
 * Mirrors content_scheduling.js's captureLivePriceIfRoutePage pattern.
 */
;(function aesMarketsLiveCapture() {
    if (typeof RouteAssistantMarketsPageScraper === "undefined") return
    const m = /\/app\/com\/markets\/([A-Z]{3})([A-Z]{3})(?:[/?#]|$)/.exec(window.location.pathname)
    if (!m) return
    const hub  = m[1]
    const dest = m[2]

    // Wicket pages render async — wait for the inventory table + pricing
    // fieldset to settle. 1.5s in practice catches the full rendered page
    // without making the read feel laggy.
    setTimeout(() => {
        try {
            const parsed = RouteAssistantMarketsPageScraper.parseFromDoc(document)
            const haveSomething = parsed && (
                parsed.competitors || parsed.ownPricing || parsed.marketShare || parsed.historic
            )
            if (!haveSomething) return
            RouteAssistantMarketsPageScraper.saveAllRecords(hub, dest, parsed, "live").then(() => {
                const cN = parsed.competitors ? parsed.competitors.competitors.length : 0
                const oP = parsed.ownPricing  ? Object.keys(parsed.ownPricing.prices).join("/") : "—"
                const mS = parsed.marketShare ? (parsed.marketShare.pax.length + parsed.marketShare.cargo.length) : 0
                const hN = parsed.historic    ? parsed.historic.periods.length : 0
                console.log("[AES marketsScraper] live-captured " + hub + "→" + dest
                    + " competitors=" + cN + " pricing=" + oP + " share=" + mS + " hist=" + hN)
            })
        } catch (e) {
            console.warn("[AES marketsScraper] live capture failed", e)
        }
    }, 1500)
})()
