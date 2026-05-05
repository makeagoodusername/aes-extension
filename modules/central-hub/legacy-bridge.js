"use strict"

/**
 * CentralHubLegacy — bridge to the legacy `content_dashboard.js` while it
 * still runs on the dashboard page (slices CH-1 → CH-3). Tiles whose full
 * UI lives in a `displayX()` legacy handler call switchDropdownTo(value)
 * to flip the legacy `<select id="aes-select-dashboard-main">` to that
 * pane and scroll it into view, so the user lands on the rich UI without
 * leaving the dashboard.
 *
 * After CH-4 cutover the dropdown won't exist; this helper becomes inert
 * (no-ops gracefully) and the tile authors will switch to direct rendering
 * inside the tile body.
 */
class CentralHubLegacy {
    static DROPDOWN_ID = "aes-select-dashboard-main"

    static switchDropdownTo(value) {
        const sel = document.getElementById(CentralHubLegacy.DROPDOWN_ID)
        if (!sel) {
            console.info("[AES Hub] legacy dropdown not present — section unavailable in this build")
            return false
        }
        sel.value = value
        sel.dispatchEvent(new Event("change", {bubbles: true}))
        const target = document.getElementById("aes-div-dashboard") || sel
        try { target.scrollIntoView({behavior: "smooth", block: "start"}) } catch (_) { /* noop */ }
        return true
    }

    static hasLegacy() {
        return !!document.getElementById(CentralHubLegacy.DROPDOWN_ID)
    }
}

if (typeof window !== "undefined") {
    window.CentralHubLegacy = CentralHubLegacy
}
