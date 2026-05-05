"use strict"

/**
 * AFP Dashboard — deep-link helper.
 *
 * Constructs the URL pattern the user wired this slice around:
 *   https://<server>.airlinesim.aero/app/fleets/aircraft/<aircraftId>/0?<flightNumberId>&aes-debug
 *
 * The bare `?<flightNumberId>` form is what AS itself emits when linking
 * to a specific flight-number row from the Visual Flight Plan; AS's Wicket
 * routing reads the bare numeric segment as the page version / target row
 * marker. `aes-debug` is read by `modules/aircraft-flight-plan/diagnostics.js`
 * to enable AFP debug logging on landing (persists to localStorage).
 *
 * When no flightNumberId is known we just emit `?aes-debug`.
 */
class AesAfpDashboardDeepLink {
    static buildAircraftUrl(server, aircraftId, flightNumberId) {
        const base = "https://" + String(server || "") + ".airlinesim.aero"
                   + "/app/fleets/aircraft/" + String(aircraftId || "") + "/0"
        const qs = []
        if (flightNumberId != null && String(flightNumberId).trim() !== "") {
            qs.push(encodeURIComponent(String(flightNumberId).trim()))
        }
        qs.push("aes-debug")
        return base + "?" + qs.join("&")
    }
}

if (typeof window !== "undefined") {
    window.AesAfpDashboardDeepLink = AesAfpDashboardDeepLink
}
