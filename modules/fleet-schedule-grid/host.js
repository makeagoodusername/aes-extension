"use strict"

/**
 * Fleet Schedule Grid — host.
 *
 * Mounts a launcher button on the AS fleet management page (`/app/fleets*`)
 * — appended to the AES summary panel right after `FleetHubSummaryStrip`.
 * Click opens `FleetScheduleGridPanel`, which runs the bulk scrape and
 * paints the multi-aircraft Gantt with the route overlay.
 *
 * Self-mounting: the constructor schedules `mount()` after a short delay
 * so it runs ahead of the user but after `content_fleetManagement.js` has
 * had a chance to write the AES summary panel. If the anchor isn't found
 * yet, mount() falls back to a one-shot MutationObserver — same idea as
 * `content_fleetHub.js`. We don't depend on FleetHubHost; if it's mounted,
 * great, our button just sits beside its strip.
 *
 * Idempotent: a second mount call replaces the prior button.
 */
class FleetScheduleGridHost {
    static BUTTON_ATTR = "data-aes-fsg-launcher"
    static HARD_TIMEOUT_MS = 6000

    constructor() {
        this.server      = ""
        this.airlineCode = ""
        this._observer   = null
        this._timeout    = null
        this._buttonEl   = null
    }

    init(opts) {
        const o = opts || {}
        this.server = o.server || (typeof AES !== "undefined" && AES.getServerName ? AES.getServerName() : "")
        this.airlineCode = o.airlineCode
            || (typeof fltmng_getAirlineName === "function" ? fltmng_getAirlineName() : "")
            || ""
    }

    mount() {
        if (!document.querySelector(".as-page-fleet-management")) return
        if (this._tryRender()) return

        // Anchor not present yet — wait for content_fleetManagement.js to
        // write the "Currently N aircrafts stored" panel.
        const root = document.querySelector(".as-page-fleet-management")
        if (!root) return
        this._observer = new MutationObserver(() => {
            if (this._tryRender()) {
                try { this._observer.disconnect() } catch (_) {}
                this._observer = null
                if (this._timeout) { clearTimeout(this._timeout); this._timeout = null }
            }
        })
        this._observer.observe(root, {childList: true, subtree: true})
        this._timeout = setTimeout(() => {
            // Fallback: render once even without the AES summary panel — we
            // can append to the page root if needed.
            this._tryRender({allowFallback: true})
            if (this._observer) { try { this._observer.disconnect() } catch (_) {} this._observer = null }
        }, FleetScheduleGridHost.HARD_TIMEOUT_MS)
    }

    _tryRender(opts) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const allowFallback = !!(opts && opts.allowFallback)

        let anchor = (typeof FleetHubHost !== "undefined" && FleetHubHost._findFltmngPanel)
            ? FleetHubHost._findFltmngPanel()
            : null
        if (!anchor) {
            const candidates = document.querySelectorAll(".as-page-fleet-management .as-panel")
            for (const el of candidates) {
                if (/aircrafts? stored/i.test(el.textContent || "")) { anchor = el; break }
            }
        }
        if (!anchor && !allowFallback) return false
        if (!anchor) anchor = document.querySelector(".as-page-fleet-management") || document.body
        if (!anchor) return false

        // Idempotent — replace any prior launcher.
        const prior = anchor.querySelector("[" + FleetScheduleGridHost.BUTTON_ATTR + "]")
        if (prior && prior.parentElement) prior.parentElement.removeChild(prior)

        const wrap = document.createElement("div")
        wrap.setAttribute(FleetScheduleGridHost.BUTTON_ATTR, "1")
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;"
            + "margin-top:" + (T ? T.sp[2] : "8px") + ";"
            + "padding-top:" + (T ? T.sp[2] : "8px") + ";"
            + "border-top:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        const btn = document.createElement("button")
        btn.type = "button"
        btn.style.cssText = "padding:6px 14px;cursor:pointer;font-size:12px;"
            + "background:" + (T ? T.color.rust : "#B8472A") + ";"
            + "color:" + (T ? T.color.rustFg : "#F4F1EA") + ";"
            + "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.rustDeep : "#8B3520") + ";"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:" + (T ? T.fw.bold : "700") + ";"
        btn.textContent = "✈ Open Fleet Schedule Grid"
        btn.title = "Open a side-by-side schedule view for every aircraft, with cross-fleet route overlay"
        btn.addEventListener("click", () => this._openPanel())
        this._buttonEl = btn

        const note = document.createElement("span")
        note.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;"
        note.textContent = "Stacks every aircraft's Mon–Sun timeline; colors flights by route so you can spot overlaps and gaps across the fleet."

        wrap.append(btn, note)
        anchor.appendChild(wrap)
        return true
    }

    _openPanel() {
        if (typeof FleetScheduleGridPanel === "undefined") {
            console.warn("[AES Fleet Schedule Grid] panel module not loaded — check manifest order on /app/fleets*")
            return
        }
        if (!this.server) {
            this.server = (typeof AES !== "undefined" && AES.getServerName) ? AES.getServerName() : ""
        }
        if (!this.airlineCode && typeof fltmng_getAirlineName === "function") {
            try { this.airlineCode = fltmng_getAirlineName() || "" } catch (_) {}
        }
        FleetScheduleGridPanel.open({
            server:      this.server,
            airlineCode: this.airlineCode
        }).catch(err => console.warn("[AES Fleet Schedule Grid] open failed", err))
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridHost = FleetScheduleGridHost
}

// Self-mount on the fleet management page.
;(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return
    if (!document.querySelector(".as-page-fleet-management")) return
    const host = new FleetScheduleGridHost()
    host.init({})
    host.mount()
    if (typeof window !== "undefined") window.__aesFleetScheduleGridHost = host
})()
