"use strict"

/**
 * One-line totals strip rendered above the AS fleet table, alongside the
 * existing "Currently N aircrafts stored" panel that content_fleetManagement.js
 * creates at fltmng_display(). The strip aggregates cross-module signals:
 *
 *   12 aircraft · 3 plans drafted · 5 live schedules · hubs: JFK 4 · ATL 3 · LAX 5 · last scrape 14:32
 */
class FleetHubSummaryStrip {

    static FLAG_ATTR = "data-aes-fleet-hub-summary"

    /**
     * @param {HTMLElement} anchor - the existing AES fleet panel; the strip
     *   is appended as a child paragraph so it inherits panel styling.
     * @param {Array} rows - RowRecord[]
     * @param {string} lastScrape - "HH:MM" or "" — sourced from
     *   aircraftFleet[0].time when available
     */
    static render(anchor, rows, lastScrape) {
        if (!anchor) return

        // Idempotent — replace prior strip on repaint.
        const prev = anchor.querySelector("[" + FleetHubSummaryStrip.FLAG_ATTR + "]")
        if (prev) prev.remove()

        const total = rows.length
        let drafted = 0
        let live = 0
        const hubCounts = new Map()
        for (const r of rows) {
            if (r.hasDraftedPlan) drafted++
            if (r.scheduleStatus === "live") live++
            const hub = r.hub || "?"
            hubCounts.set(hub, (hubCounts.get(hub) || 0) + 1)
        }

        const hubsSorted = Array.from(hubCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([hub, n]) => hub + " " + n)
            .join(" · ")

        const strip = document.createElement("p")
        strip.className = "aes-meta"
        strip.setAttribute(FleetHubSummaryStrip.FLAG_ATTR, "1")
        strip.style.marginTop = "6px"

        const parts = [
            total + " aircraft",
            drafted + " plan" + (drafted === 1 ? "" : "s") + " drafted",
            live + " hub" + (live === 1 ? "" : "s") + " w/ live schedule"
        ]
        if (hubsSorted) parts.push("hubs: " + hubsSorted)
        if (lastScrape) parts.push("last scrape " + lastScrape)
        strip.textContent = parts.join(" · ")

        anchor.appendChild(strip)
    }
}

if (typeof window !== "undefined") {
    window.FleetHubSummaryStrip = FleetHubSummaryStrip
}
