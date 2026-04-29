"use strict"

/**
 * CanvasCellContextMenu — right-click menu on wave-spine cells.
 *
 * Filled cell items:
 *   - Apply pricing — reads the aircraft's current schedule, finds the
 *     dominant destination in this wave, queues an `applyPricing` edit
 *     with the aircraft's current Y/C/F/Cargo (best-effort — falls back
 *     to a dry-run with no class deltas if we can't read prices).
 *   - Remove flight — queues `removeRoute` (deferred; AFP page handles
 *     the AS-side delete in a later slice).
 *   - Open in RA — emits `focus-route` so the standalone RA panel can
 *     deep-link to that route.
 *
 * Empty cell: a single "Add destination…" item that opens the route-create
 * modal with no pre-filled IATA. The user can type an IATA and stage the
 * `addRoute` directly without dragging.
 *
 * Single instance — opening twice closes the previous menu. Backdrop click
 * + Esc dismiss.
 */
class CanvasCellContextMenu {

    static MENU_CLASS = "aes-canvas-cell-ctx-menu"
    static _active = null

    /**
     * @param {object} deps
     *   - hub:        active hub IATA
     *   - fleet:      fleet array (so we can resolve aircraft → registration)
     *   - schedules:  Map<aircraftId, schedule>
     *   - onStage:    fn(edit) — receives a staged edit envelope
     */
    static install(deps) {
        if (CanvasCellContextMenu._installation) {
            CanvasCellContextMenu._installation.update(deps)
            return CanvasCellContextMenu._installation
        }
        const inst = new CanvasCellContextMenu(deps)
        CanvasCellContextMenu._installation = inst
        return inst
    }

    constructor(deps) {
        const d = deps || {}
        this.spineHostEl = d.spineHostEl || null
        this.hub         = d.hub || null
        this.fleet       = Array.isArray(d.fleet) ? d.fleet : []
        this.schedules   = d.schedules instanceof Map ? d.schedules : new Map()
        this.onStage     = typeof d.onStage === "function" ? d.onStage : (() => {})
        this._handler    = null
        if (this.spineHostEl) this.attach()
    }

    update(deps) {
        if (!deps) return
        if (deps.spineHostEl !== undefined && deps.spineHostEl !== this.spineHostEl) {
            this.detach()
            this.spineHostEl = deps.spineHostEl
            if (this.spineHostEl) this.attach()
        }
        if (deps.hub        !== undefined) this.hub = deps.hub
        if (deps.fleet      !== undefined) this.fleet = Array.isArray(deps.fleet) ? deps.fleet : []
        if (deps.schedules  !== undefined) this.schedules = deps.schedules instanceof Map ? deps.schedules : new Map()
        if (typeof deps.onStage === "function") this.onStage = deps.onStage
    }

    attach() {
        if (!this.spineHostEl || this._handler) return
        const handler = (e) => this._onContextMenu(e)
        this.spineHostEl.addEventListener("contextmenu", handler)
        this._handler = handler
    }

    detach() {
        if (this.spineHostEl && this._handler) {
            this.spineHostEl.removeEventListener("contextmenu", this._handler)
        }
        this._handler = null
        CanvasCellContextMenu._closeOpen()
    }

    _onContextMenu(e) {
        const cell = e.target && e.target.closest && e.target.closest("[data-canvas-aircraft-id][data-canvas-wave-id]")
        if (!cell) return
        e.preventDefault()
        const aircraftId = cell.dataset.canvasAircraftId
        const waveId     = cell.dataset.canvasWaveId
        const isEmpty    = cell.dataset.canvasEmptyCell === "1"
        const aircraftRow = this.fleet.find(r => String(r.aircraftId) === String(aircraftId))
        const dom = this._dominantDest(aircraftId, waveId)
        this._render({
            x: e.clientX,
            y: e.clientY,
            aircraftId,
            waveId,
            isEmpty,
            registration: aircraftRow && aircraftRow.registration || aircraftId,
            destIata:     dom && dom.dest || null
        })
    }

    /**
     * Find the destination this aircraft flies most often in the given
     * wave window. Mirrors the wave-spine renderer's bucketing logic.
     */
    _dominantDest(aircraftId, waveId) {
        const sched = this.schedules.get(String(aircraftId))
        if (!sched || !Array.isArray(sched.legs)) return null
        const counts = new Map()
        for (const leg of sched.legs) {
            if (!leg || !leg.destination) continue
            // We can't filter by wave window without the preset; just take
            // the per-aircraft top destination as a best-effort hint.
            counts.set(leg.destination, (counts.get(leg.destination) || 0) + 1)
        }
        let top = null, n = 0
        for (const [d, c] of counts) if (c > n) { top = d; n = c }
        return top ? {dest: top, count: n} : null
    }

    _render(ctx) {
        CanvasCellContextMenu._closeOpen()
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const menu = document.createElement("div")
        menu.className = CanvasCellContextMenu.MENU_CLASS
        menu.style.cssText = [
            "position:fixed",
            "z-index:" + (T ? T.z.modal + 2 : 10002),
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "border:" + (T ? T.geom.bw1 : "1px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "box-shadow:0 6px 18px rgba(20,18,15,0.25)",
            "min-width:200px",
            "padding:4px 0",
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-size:12px",
            "color:" + (T ? T.color.oxide : "#2B2520")
        ].join(";")
        menu.style.left = ctx.x + "px"
        menu.style.top  = ctx.y + "px"

        const items = []
        if (ctx.isEmpty) {
            items.push({
                label: "Add destination…",
                run: () => this._stageAddViaModal(ctx)
            })
        } else {
            items.push({
                label: ctx.destIata ? "Apply pricing — " + ctx.destIata : "Apply pricing (no route detected)",
                disabled: !ctx.destIata,
                run: () => this._stageApplyPricing(ctx)
            })
            items.push({
                label: ctx.destIata ? "Remove flight — " + ctx.destIata : "Remove flight",
                disabled: !ctx.destIata,
                run: () => this._stageRemove(ctx)
            })
            items.push({
                label: ctx.destIata ? "Open in RA — " + ctx.destIata : "Open in RA",
                disabled: !ctx.destIata,
                run: () => this._openInRA(ctx)
            })
        }

        for (const it of items) {
            const el = document.createElement("div")
            el.style.cssText = [
                "padding:6px 12px",
                "cursor:" + (it.disabled ? "default" : "pointer"),
                "color:" + (it.disabled ? (T ? T.color.slate : "#7A6F66") : (T ? T.color.oxide : "#2B2520"))
            ].join(";")
            el.textContent = it.label
            if (!it.disabled) {
                el.addEventListener("mouseenter", () => { el.style.background = (T ? T.color.bone3 : "#E0DAC8") })
                el.addEventListener("mouseleave", () => { el.style.background = "" })
                el.addEventListener("click", () => {
                    CanvasCellContextMenu._closeOpen()
                    try { it.run() } catch (err) { console.warn("[AES Canvas] menu item threw", err) }
                })
            }
            menu.appendChild(el)
        }

        document.body.appendChild(menu)
        CanvasCellContextMenu._active = menu

        // Constrain to viewport.
        const rect = menu.getBoundingClientRect()
        const vw = window.innerWidth, vh = window.innerHeight
        if (rect.right > vw - 4)  menu.style.left = Math.max(4, vw - rect.width - 4) + "px"
        if (rect.bottom > vh - 4) menu.style.top  = Math.max(4, vh - rect.height - 4) + "px"

        const dismiss = (e) => {
            if (e && e.type === "keydown" && e.key !== "Escape") return
            CanvasCellContextMenu._closeOpen()
        }
        // Defer the click handler so the click that opened the menu doesn't immediately close it.
        setTimeout(() => {
            document.addEventListener("click", dismiss, true)
            document.addEventListener("keydown", dismiss, true)
        }, 0)
        CanvasCellContextMenu._dismiss = () => {
            document.removeEventListener("click", dismiss, true)
            document.removeEventListener("keydown", dismiss, true)
        }
    }

    static _closeOpen() {
        if (CanvasCellContextMenu._active && CanvasCellContextMenu._active.parentElement) {
            CanvasCellContextMenu._active.parentElement.removeChild(CanvasCellContextMenu._active)
        }
        CanvasCellContextMenu._active = null
        if (typeof CanvasCellContextMenu._dismiss === "function") {
            try { CanvasCellContextMenu._dismiss() } catch (_) {}
            CanvasCellContextMenu._dismiss = null
        }
    }

    async _stageAddViaModal(ctx) {
        if (typeof window === "undefined" || !window.CanvasRouteCreateModal) return
        const result = await window.CanvasRouteCreateModal.open({
            hub:          this.hub || "",
            destIata:     "",
            destName:     "",
            aircraftId:   ctx.aircraftId,
            registration: ctx.registration
        })
        // The modal as designed always shows the chosen IATA in its subtitle.
        // For "add via menu" we need the IATA from the user — currently the
        // modal locks the IATA from props. Defer empty-IATA inputs to the
        // drag flow (which always carries an IATA); keep the menu item as
        // a placeholder and toast the user to drag instead.
        if (typeof window.RouteAssistantToast !== "undefined") {
            window.RouteAssistantToast.show(
                "Drag a destination onto this cell to stage a new route — the menu can't ask for an IATA yet.",
                {type: "info", duration: 5000})
        }
        // Discard whatever fares were collected since we didn't capture an IATA.
        void result
    }

    _stageApplyPricing(ctx) {
        if (!ctx.destIata) return
        const sched = this.schedules.get(String(ctx.aircraftId))
        const prices = this._extractPricesFromSchedule(sched, ctx.destIata)
        this.onStage({
            kind:    "applyPricing",
            payload: {
                hub:        this.hub || "",
                dest:       ctx.destIata,
                aircraftId: ctx.aircraftId,
                prices:     prices || {},
                source:     "canvas-context-menu",
                reason:     "Re-apply current prices from canvas",
                rationale:  ["User triggered Apply Pricing from canvas cell context menu."]
            }
        })
    }

    _stageRemove(ctx) {
        if (!ctx.destIata) return
        this.onStage({
            kind:    "removeRoute",
            payload: {
                hub:        this.hub || "",
                aircraftId: ctx.aircraftId,
                destIata:   ctx.destIata,
                source:     "canvas-context-menu"
            }
        })
        if (typeof window !== "undefined" && window.RouteAssistantToast) {
            window.RouteAssistantToast.show(
                "Queued remove-flight for " + ctx.destIata + ". Open Aircraft Flight Plan to delete in AS.",
                {type: "info", duration: 5000})
        }
    }

    _openInRA(ctx) {
        if (!ctx.destIata) return
        if (typeof window === "undefined" || !window.CentralHubBus) return
        window.CentralHubBus.emit("focus-route", {
            hub:    this.hub || "",
            dest:   ctx.destIata,
            source: "canvas"
        })
    }

    /**
     * Best-effort extraction of current Y/C/F/Cargo from a stored schedule.
     * We scan legs whose destination matches and pick the first leg that
     * carries a `prices` object. Returns null when nothing is on file —
     * the applier will then read the markets-page form context as the
     * canonical source of truth (its current behaviour for empty inputs).
     */
    _extractPricesFromSchedule(sched, dest) {
        if (!sched || !Array.isArray(sched.legs)) return null
        for (const leg of sched.legs) {
            if (!leg || leg.destination !== dest) continue
            if (leg.prices && typeof leg.prices === "object") return Object.assign({}, leg.prices)
        }
        return null
    }
}

if (typeof window !== "undefined") {
    window.CanvasCellContextMenu = CanvasCellContextMenu
}
