"use strict"

/**
 * Route Builder tile — opens the standalone Route Builder modal from the
 * Central Hub dashboard.
 *
 * The full GUI lives in `modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js`.
 * This tile is the dashboard-side entry point: a small body that surfaces
 * the active aircraft + last-build info, plus an "Open route builder"
 * button that pops the modal.
 *
 * No state of its own — the modal owns aircraft + airport + planner state.
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return
    if (window.CentralHubRouteBuilderTile) return

    class CentralHubRouteBuilderTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id              = "route-builder"
            this.title           = "Route Builder"
            this.section         = "fleet"
            this.priority        = 17
            this.requiresAirline = true
        }

        watchedStorageKeys(ctx) {
            const s = (ctx && ctx.server) || ""
            return [
                "aircraftFlightPlan:draft:" + s + ":",
                "fleetRoster:" + s
            ]
        }

        async loadStatus(ctx) {
            const K = window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND
            if (!window.AesAfpRouteBuilderModal) {
                return {badge: "—", badgeKind: K && K.MUTED, summary: "Modal not loaded"}
            }
            const fleet = window.AesFleetRoster
                ? await window.AesFleetRoster.loadCurrent().catch(() => null)
                : null
            const count = (fleet && fleet.aircraft && fleet.aircraft.length) || 0
            return {
                badge:    count ? String(count) + "AC" : "0",
                badgeKind: K && (count ? K.INFO : K.MUTED),
                summary:  count
                    ? "Plan & build routes across " + count + " aircraft"
                    : "No fleet cached"
            }
        }

        async renderBody(ctx, host) {
            const T = window.AESTokens || {color: {slate: "#9ca3af"}, sp: ["0", "4px", "8px", "12px"]}
            host.textContent = ""

            if (!window.AesAfpRouteBuilderModal) {
                const p = document.createElement("p")
                p.style.cssText = "color:" + T.color.slate + ";margin:8px 0;font-style:italic;"
                p.textContent = "Route Builder modal module not loaded — check manifest order on /app/enterprise/dashboard*."
                host.appendChild(p)
                return
            }

            const intro = document.createElement("p")
            intro.style.cssText = "color:#cbd5e1;margin:6px 0;line-height:1.4;font-size:12px;"
            intro.textContent = "Pick airports, set how many flights to create, edit the mock schedule's HH:MM, then apply. Long-haul legs are sequenced after the prior return automatically."
            host.appendChild(intro)

            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;"

            const open = document.createElement("button")
            open.type = "button"
            open.textContent = "Open route builder…"
            open.title = "Open the Route Builder modal — pick airports, edit times, apply."
            open.style.cssText = "background:#1d4ed8;color:#f8fafc;border:1px solid #1e3a8a;"
                + "border-radius:3px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;"
            open.addEventListener("click", () => {
                try {
                    window.AesAfpRouteBuilderModal.open({
                        server:  ctx && ctx.server,
                        airline: ctx && ctx.airline
                    }).catch(err => console.warn("[AES route-builder-tile] open threw", err))
                } catch (e) {
                    console.warn("[AES route-builder-tile] open sync threw", e)
                }
            })
            row.appendChild(open)

            const hint = document.createElement("span")
            hint.style.cssText = "color:#6b7280;font-size:10px;"
            hint.textContent = "Esc to cancel · uses Active draft store + AesAfpAutoApplyBatch"
            row.appendChild(hint)

            host.appendChild(row)
        }
    }

    window.CentralHubRouteBuilderTile = CentralHubRouteBuilderTile

    if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register({
            id:       "route-builder",
            section:  "fleet",
            priority: 17,
            factory:  () => new CentralHubRouteBuilderTile()
        })
    }
})()
