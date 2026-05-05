"use strict"

/**
 * Fleet Schedule Grid — drop confirmation popover.
 *
 * Opens at the drop position after a destination card is dropped on a lane.
 * Shows the resolved leg (origin from form context, destination, depTime,
 * pricePct, service, days[]) and offers live Apply.
 *
 * Slice 4: Apply is enabled when `autoScheduler.enabled === true && tier
 * === "apply-on-confirm"`; banner explains how to flip the gate otherwise.
 *
 * Mounts as a floating absolutely-positioned card anchored to the drop
 * point. Uses viewport-collision flipping so a drop near the right edge
 * still shows the popover fully on-screen.
 *
 * Outside-click and Esc close the popover; while open, no other DnD
 * actions reach the grid.
 */
class FleetScheduleGridDropPopover {

    static OPEN_CLASS = "aes-fsg-drop-popover"
    static FORM_CTX_FRESH_MS = 55 * 1000   // refetch form context if older than this at Apply
    static _active = null

    /**
     * @param {object} args
     *   - dropCtx: {aircraftId, dayIdx, dropMin, destIata, destName, sourceWaveLayerId?, anchorRect, conflictBlock?}
     *   - deps: {server, fleetRow, schedule, formContextProvider, sourceWaveLayer?}
     *   - onApplied: (result) => void
     *   - onCancel: () => void
     */
    static async openAt(args) {
        if (FleetScheduleGridDropPopover._active) FleetScheduleGridDropPopover._active.close()
        const popover = new FleetScheduleGridDropPopover(args)
        FleetScheduleGridDropPopover._active = popover
        await popover._mount()
        return popover
    }

    constructor(args) {
        const a = args || {}
        this.dropCtx = a.dropCtx || {}
        this.deps = a.deps || {}
        this.onApplied = typeof a.onApplied === "function" ? a.onApplied : (() => {})
        this.onCancel = typeof a.onCancel === "function" ? a.onCancel : (() => {})
        this._rootEl = null
        this._formContext = null
        this._tierBlock = null
        this._working = false
    }

    close() {
        if (this._rootEl && this._rootEl.parentElement) {
            this._rootEl.parentElement.removeChild(this._rootEl)
        }
        if (this._keydown) document.removeEventListener("keydown", this._keydown, true)
        if (this._outsideClick) document.removeEventListener("mousedown", this._outsideClick, true)
        if (FleetScheduleGridDropPopover._active === this) FleetScheduleGridDropPopover._active = null
    }

    async _mount() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const root = document.createElement("div")
        root.className = FleetScheduleGridDropPopover.OPEN_CLASS
        root.style.cssText = "position:fixed;z-index:" + (T ? "calc(" + T.z.modal + " + 5)" : "10005") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "box-shadow:0 12px 32px rgba(0,0,0,0.35);"
            + "min-width:340px;max-width:420px;font-size:12px;"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
        document.body.appendChild(root)
        this._rootEl = root
        this._positionAnchored(root, this.dropCtx.anchorRect)

        // Loading state.
        const loading = document.createElement("div")
        loading.style.cssText = "padding:14px;text-align:center;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        loading.textContent = "Resolving form context…"
        root.appendChild(loading)

        // Wire close handlers.
        this._keydown = (e) => { if (e.key === "Escape") { e.preventDefault(); this._cancel() } }
        document.addEventListener("keydown", this._keydown, true)
        this._outsideClick = (e) => {
            if (this._rootEl && !this._rootEl.contains(e.target)) {
                this._cancel()
            }
        }
        // Defer outside-click so the drop event itself doesn't immediately fire it.
        setTimeout(() => document.addEventListener("mousedown", this._outsideClick, true), 0)

        // Resolve dependencies in parallel.
        const [fc, tier] = await Promise.all([
            this._loadFormContext(),
            this._loadTierGate()
        ])
        this._formContext = fc
        this._formContextAt = fc ? Date.now() : 0
        this._tierBlock = tier
        this._render()
    }

    async _loadFormContext() {
        const provider = this.deps.formContextProvider
        if (typeof provider === "function") {
            try { return await provider(this.dropCtx.aircraftId) } catch (_) { return null }
        }
        if (typeof AesAfpProxyPageFetcher === "undefined") return null
        try {
            const fetcher = window.__aesFsgProxyFetcher = window.__aesFsgProxyFetcher
                || new AesAfpProxyPageFetcher(this.deps.server || "")
            const r = await fetcher.fetchAircraftFormContext(this.dropCtx.aircraftId)
            return r && r.ok ? r.formContext : null
        } catch (_) { return null }
    }

    async _loadTierGate() {
        if (typeof AesAfpSettings === "undefined") return {enabled: true, tier: "apply-on-confirm"}
        try {
            const s = await AesAfpSettings.load()
            const a = (s && s.autoScheduler) || {}
            return {enabled: !!a.enabled, tier: a.tier || "preview-only", maxLegs: +a.maxLegsPerApply || 28}
        } catch (_) { return {enabled: true, tier: "apply-on-confirm"} }
    }

    _positionAnchored(root, rect) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const vw = window.innerWidth, vh = window.innerHeight
        // First place to the right of the anchor, top-aligned.
        let x = rect.right + 8
        let y = rect.top
        // Defer width measurement to after paint — measure once.
        requestAnimationFrame(() => {
            const r = root.getBoundingClientRect()
            if (x + r.width > vw - 12) x = Math.max(12, rect.left - r.width - 8)
            if (y + r.height > vh - 12) y = Math.max(12, vh - r.height - 12)
            root.style.left = x + "px"
            root.style.top = y + "px"
        })
        root.style.left = x + "px"
        root.style.top = y + "px"
    }

    _render() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this._rootEl.innerHTML = ""

        const ctx = this.dropCtx
        const fc = this._formContext
        const tier = this._tierBlock
        const layer = this.deps.sourceWaveLayer || null

        // Header.
        const header = document.createElement("div")
        header.style.cssText = "padding:10px 12px;display:flex;align-items:center;gap:10px;"
            + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"
        const title = document.createElement("div")
        title.style.cssText = "flex:1 1 auto;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;font-size:12px;"
        title.textContent = "Schedule Flight"
        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "×"
        close.style.cssText = "padding:2px 8px;cursor:pointer;border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2B2520") + ";font-size:14px;"
        close.addEventListener("click", () => this._cancel())
        header.append(title, close)
        this._rootEl.appendChild(header)

        // Body.
        const body = document.createElement("div")
        body.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:8px;"

        // Aircraft + origin line.
        const fleetRow = this.deps.fleetRow || {}
        const reg = fleetRow.registration || ctx.aircraftId
        const equipment = fleetRow.equipment || ""
        const origin = (fc && fc.currentLocationIata) || fleetRow.hub || "?"
        const summary = document.createElement("div")
        summary.style.cssText = "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        summary.innerHTML = "<b>" + this._esc(reg) + "</b> · " + this._esc(equipment)
            + "<br>Origin (current location): <span style=\"font-family:" + (T ? T.font.mono : "monospace") + ";font-weight:700;\">" + this._esc(origin) + "</span>"
            + " → Destination: <span style=\"font-family:" + (T ? T.font.mono : "monospace") + ";font-weight:700;\">" + this._esc(ctx.destIata) + "</span>"
        body.appendChild(summary)

        // Reachability + range checks.
        const checks = this._renderChecks(fc, fleetRow, T)
        if (checks) body.appendChild(checks)

        // Conflict notice.
        if (ctx.conflictBlock) {
            const conf = document.createElement("div")
            conf.style.cssText = "padding:6px 8px;font-size:11px;"
                + "background:" + (T ? T.color.amberSoft : "rgba(184,134,31,0.14)") + ";"
                + "border:1px solid " + (T ? T.color.amber : "#B8861F") + ";"
            const codeStr = (ctx.conflictBlock.flight && ctx.conflictBlock.flight.flightCode) || "(unknown)"
            conf.innerHTML = "<b>Conflict:</b> overlaps existing flight " + this._esc(codeStr)
                + ". Apply will be rejected until you delete that flight first (covered in a follow-up slice)."
            body.appendChild(conf)
        }

        // Form fields.
        const form = document.createElement("div")
        form.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 8px;align-items:center;font-size:11px;"
        const initialDepTime = this._fmtMin(ctx.dropMin)
        const depTimeInput = this._field(form, T, "Dep time", () => {
            const i = document.createElement("input")
            i.type = "text"; i.value = initialDepTime
            i.style.cssText = this._inputCss(T) + "width:80px;"
            return i
        })
        const pricePctInput = this._field(form, T, "Price %", () => {
            const i = document.createElement("input")
            i.type = "number"; i.min = "50"; i.max = "200"; i.step = "5"; i.value = "100"
            i.style.cssText = this._inputCss(T) + "width:80px;"
            return i
        })
        const serviceSelect = this._field(form, T, "Service", () => {
            const s = document.createElement("select")
            s.style.cssText = this._inputCss(T) + "width:160px;"
            const opts = (fc && Array.isArray(fc.serviceOptions)) ? fc.serviceOptions : []
            // Always allow blank → server default.
            const blank = document.createElement("option")
            blank.value = ""; blank.textContent = "(default)"
            s.appendChild(blank)
            for (const o of opts) {
                const optEl = document.createElement("option")
                optEl.value = o.value
                optEl.textContent = o.text || o.value
                s.appendChild(optEl)
            }
            return s
        })
        body.appendChild(form)

        // Day toggles — default just-today, or layer.days if drop came from a wave band.
        const initialDays = layer && Array.isArray(layer.days)
            ? layer.days.slice()
            : [false, false, false, false, false, false, false]
        if (!layer) initialDays[ctx.dayIdx] = true
        const dayWrap = document.createElement("div")
        dayWrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;"
        const dayLabel = document.createElement("span")
        dayLabel.textContent = "Days"
        dayLabel.style.cssText = "flex:0 0 auto;color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-weight:700;letter-spacing:0.04em;"
        const dayBtns = document.createElement("div")
        dayBtns.style.cssText = "display:flex;gap:2px;flex:1 1 auto;"
        const DN = ["M","T","W","T","F","S","S"]
        const dayState = initialDays.slice()
        for (let i = 0; i < 7; i++) {
            const b = document.createElement("button")
            b.type = "button"; b.textContent = DN[i]
            b.dataset.dayIdx = String(i)
            b.style.cssText = "flex:1 1 0;padding:3px 0;cursor:pointer;font-size:11px;"
                + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "background:" + (dayState[i] ? (T ? T.color.cobalt : "#3656A8") : "transparent") + ";"
                + "color:" + (dayState[i] ? (T ? T.color.boneFg : "#F4F1EA") : (T ? T.color.oxide : "#2B2520")) + ";"
                + "font-weight:" + (dayState[i] ? "700" : "400") + ";"
            b.addEventListener("click", () => {
                dayState[i] = !dayState[i]
                b.style.background = dayState[i] ? (T ? T.color.cobalt : "#3656A8") : "transparent"
                b.style.color = dayState[i] ? (T ? T.color.boneFg : "#F4F1EA") : (T ? T.color.oxide : "#2B2520")
                b.style.fontWeight = dayState[i] ? "700" : "400"
            })
            dayBtns.appendChild(b)
        }
        dayWrap.append(dayLabel, dayBtns)
        body.appendChild(dayWrap)

        // Tier-gate banner.
        const canApply = this._canApply(fc, fleetRow, tier)
        if (!canApply.ok) {
            const banner = document.createElement("div")
            banner.style.cssText = "padding:8px 10px;font-size:11px;"
                + "background:" + (T ? T.color.amberSoft : "rgba(184,134,31,0.14)") + ";"
                + "border:1px solid " + (T ? T.color.amber : "#B8861F") + ";"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            banner.innerHTML = "🔒 " + canApply.reason
            body.appendChild(banner)
        }

        // Result line (filled in after dry-run / apply).
        const resultLine = document.createElement("div")
        resultLine.style.cssText = "font-size:11px;font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "min-height:14px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        body.appendChild(resultLine)

        this._rootEl.appendChild(body)

        // Footer with action buttons.
        const footer = document.createElement("div")
        footer.style.cssText = "display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        const cancelBtn = document.createElement("button")
        cancelBtn.type = "button"; cancelBtn.textContent = "Cancel"
        cancelBtn.style.cssText = this._btnCss(T, "default")
        cancelBtn.addEventListener("click", () => this._cancel())
        const applyBtn = document.createElement("button")
        applyBtn.type = "button"; applyBtn.textContent = "Apply"
        applyBtn.style.cssText = this._btnCss(T, canApply.ok ? "rust" : "default")
        applyBtn.disabled = !canApply.ok
        if (!canApply.ok) applyBtn.style.opacity = "0.4"
        applyBtn.title = canApply.ok
            ? "Dispatch the leg to AS via the apply pipeline."
            : canApply.reason
        applyBtn.addEventListener("click", async () => {
            if (!canApply.ok) return
            await this._runApply({
                depTime: depTimeInput.value,
                pricePct: +pricePctInput.value || 100,
                service: serviceSelect.value || "",
                days: dayState.slice(),
                resultLine
            })
        })
        footer.append(cancelBtn, applyBtn)
        this._rootEl.appendChild(footer)

        // Re-position after first paint to handle viewport collisions.
        this._positionAnchored(this._rootEl, this.dropCtx.anchorRect)
    }

    _renderChecks(fc, fleetRow, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;font-size:11px;"
        const dest = this.dropCtx.destIata
        // Reachability.
        const reach = (fc && Array.isArray(fc.destOptions))
            ? fc.destOptions.some(o => (o.text || "").toUpperCase().indexOf(dest) !== -1 || (o.value || "").toUpperCase().indexOf(dest) !== -1)
            : null
        const reachRow = document.createElement("div")
        reachRow.style.cssText = "display:flex;gap:6px;align-items:center;"
        if (reach === true) {
            reachRow.innerHTML = '<span style="color:' + (T ? T.color.moss : "#2F5F3F") + '">✓</span>'
                + ' <span>Destination is in the aircraft\'s licensed dest list.</span>'
        } else if (reach === false) {
            reachRow.innerHTML = '<span style="color:' + (T ? T.color.crimson : "#8B2727") + '">✗</span>'
                + ' <span>Destination is <b>not</b> in the licensed list — Apply will be rejected by AS until the route is licensed and the aircraft can reach it.</span>'
        } else {
            reachRow.innerHTML = '<span style="color:' + (T ? T.color.amber : "#B8861F") + '">⚠</span>'
                + ' <span>Form context unavailable — reachability not checked.</span>'
        }
        wrap.appendChild(reachRow)
        return wrap
    }

    _canApply(fc, fleetRow, tier) {
        if (!fc) return {ok: false, reason: "Form context not loaded — refetch and try again."}
        if (!tier || !tier.enabled) {
            return {ok: false, reason: "Tier-gated — set settings.aircraftFlightPlan.autoScheduler.enabled = true + .tier = \"apply-on-confirm\" to unlock Apply."}
        }
        if (tier.tier !== "apply-on-confirm") {
            return {ok: false, reason: "autoScheduler.tier === \"" + tier.tier + "\" — needs \"apply-on-confirm\" to unlock Apply."}
        }
        return {ok: true}
    }

    async _runApply(args) {
        if (this._working) return
        this._working = true
        const ctx = this.dropCtx
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        args.resultLine.textContent = "Applying…"
        args.resultLine.style.color = (T ? T.color.oxide2 : "#4A413B")
        try {
            if (typeof AesAfpFnApplier === "undefined") {
                args.resultLine.textContent = "AesAfpFnApplier missing — module load failed."
                args.resultLine.style.color = (T ? T.color.crimson : "#8B2727")
                return
            }
            // Form-context freshness gate (R2): AS Wicket form actions
            // rotate per GET. Refetch if our cached fc is older than the
            // freshness window, so Apply doesn't blow up with PageExpired
            // when the popover sits open for a while.
            let fc = this._formContext
            const fcAge = this._formContextAt ? (Date.now() - this._formContextAt) : Infinity
            if (fcAge > FleetScheduleGridDropPopover.FORM_CTX_FRESH_MS) {
                args.resultLine.textContent = "Refreshing form context…"
                const fresh = await this._loadFormContext()
                if (fresh) {
                    fc = fresh
                    this._formContext = fresh
                    this._formContextAt = Date.now()
                }
            }
            const leg = {
                origin:       (fc && fc.currentLocationIata) || (this.deps.fleetRow && this.deps.fleetRow.hub) || "",
                destination:  ctx.destIata,
                depTime:      args.depTime,
                pricePct:     args.pricePct,
                service:      args.service
            }
            if (typeof AesAfpFleetApplyOrchestrator === "undefined") {
                args.resultLine.textContent = "AesAfpFleetApplyOrchestrator missing."
                args.resultLine.style.color = (T ? T.color.crimson : "#8B2727")
                return
            }
            const result = await AesAfpFleetApplyOrchestrator.start({
                runs: [{aircraftId: ctx.aircraftId, legs: [leg]}],
                ctx:  {server: this.deps.server},
                source: "drag-drop-grid"
            })
            if (result && result.ok && result.totalSucceeded > 0) {
                args.resultLine.textContent = "✓ Flight created. " + (result.totalSucceeded || 1) + " leg succeeded."
                args.resultLine.style.color = (T ? T.color.moss : "#2F5F3F")
                this.onApplied(result)
                this._offerOpenInFlightStudio(args.resultLine, T)
            } else {
                const reason = (result && (result.abortReason || result.error)) || "apply failed"
                args.resultLine.textContent = "✗ " + reason
                args.resultLine.style.color = (T ? T.color.crimson : "#8B2727")
            }
        } catch (e) {
            args.resultLine.textContent = "✗ " + ((e && e.message) || String(e))
            args.resultLine.style.color = (T ? T.color.crimson : "#8B2727")
        } finally {
            this._working = false
        }
    }

    _cancel() {
        try { this.onCancel() } catch (_) {}
        this.close()
    }

    /**
     * Track C — after Apply succeeds, write a dnd-grid handoff
     * and surface an "Open in Flight Studio" button. The AFP page consumes
     * the handoff on mount, scrolls its candidates table to the matching
     * destination row, and (when Flight Studio is mounted) pre-fills the
     * dropMin in any new-flight form.
     */
    _offerOpenInFlightStudio(resultLine, T) {
        if (typeof window.AesHandoffStore === "undefined") return
        if (this._openBtnAttached) return
        this._openBtnAttached = true
        const ctx = this.dropCtx
        const aircraftId = ctx.aircraftId
        const destIata = ctx.destIata
        if (!aircraftId || !destIata) return

        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = "Open in Flight Studio →"
        btn.style.cssText = "margin-left:8px;padding:3px 10px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.cobalt : "#3656A8") + ";"
            + "background:" + (T ? T.color.cobalt : "#3656A8") + ";"
            + "color:" + (T ? T.color.boneFg : "#F4F1EA") + ";"
            + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.04em;font-weight:700;"
        btn.title = "Write a cross-page handoff and open this aircraft's Flight Plan in a new tab. The candidates table will scroll to " + destIata + "."
        btn.addEventListener("click", async () => {
            btn.disabled = true
            try {
                await window.AesHandoffStore.set({
                    aircraftId: aircraftId,
                    destIata:   destIata,
                    dropMin:    ctx.dropMin,
                    source:     "dnd-grid"
                })
            } catch (e) {
                console.warn("[AES fsg] handoff write failed", e)
            }
            const url = "/app/fleets/aircraft/" + encodeURIComponent(aircraftId) + "/0"
            try { window.open(url, "_blank", "noopener") }
            catch (_) { window.location.href = url }
        })
        resultLine.appendChild(btn)
    }

    _field(parent, T, label, builder) {
        const lbl = document.createElement("span")
        lbl.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-weight:700;letter-spacing:0.04em;font-size:11px;"
        lbl.textContent = label
        const ctrl = builder()
        parent.append(lbl, ctrl)
        return ctrl
    }

    _inputCss(T) {
        return "padding:3px 6px;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
    }

    _btnCss(T, variant) {
        const base = "padding:5px 12px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "border-radius:0;font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        if (variant === "rust") {
            return base + "background:" + (T ? T.color.rust : "#B8472A") + ";"
                + "color:" + (T ? T.color.rustFg : "#F4F1EA") + ";"
        }
        return base + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
    }

    _fmtMin(min) {
        if (min == null || !isFinite(min)) return "09:00"
        const m = Math.max(0, Math.min(1439, Math.round(min)))
        const h = Math.floor(m / 60), mm = m % 60
        return (h < 10 ? "0" + h : h) + ":" + (mm < 10 ? "0" + mm : mm)
    }

    _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridDropPopover = FleetScheduleGridDropPopover
}
