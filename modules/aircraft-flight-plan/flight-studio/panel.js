"use strict"

/**
 * Flight Studio — compose panel (Slice S1).
 *
 * Mounts at `AesAfp.slot("studio")` and renders a compose UI for one
 * FlightSpec. S1 ships **dry-run only**: the user types a leg, clicks
 * Preview, sees the would-be POST body. NO live form interaction, NO
 * programmatic Submit.
 *
 * SAFETY INVARIANT (mirrors form-driver.js:10-24):
 *   The panel never calls submitBtn.click(), form.submit(), or any
 *   chrome.runtime message that triggers a submit. Preview reads option
 *   values via AesAfpFormDriver.dryRun(); that path does not POST.
 *
 * Public API (window.AesAfpFlightStudio):
 *   attach()         — idempotent; wires bus listeners + initial render
 *   render()         — replace-render into AesAfp.slot("studio")
 *   open()           — scrolls panel into view, focuses first input,
 *                      emits studio:opened {trigger}
 *   getSpec()        — returns the current in-memory FlightSpec
 *
 * Bus contract (additions to EVENTS.md §1):
 *   in:  ctx:ready                         → re-render on remount
 *   out: studio:opened       {trigger}
 *   out: studio:draft-changed {spec}        (debounced 300ms)
 *   out: studio:dry-run-rendered {spec, dryRun}
 *
 * Slices S2+ extend this same module with multi-leg compose, paste-import,
 * pre-fill mode, and submit mode. Keep the public API stable.
 */
;(function () {
    if (window.AesAfpFlightStudio) return

    const SLOT_NAME       = "studio"
    const SAVE_DEBOUNCE_MS = 300
    const TRIGGER_INIT     = "menu"

    let _spec      = null         // current FlightSpec
    let _attached  = false
    let _saveTimer = null
    let _renderInFlight = false   // re-entrancy guard
    let _lastDryRun = null        // most recent dryRun result, for diagnostics

    // ── ctx helpers ──────────────────────────────────────────────────────
    function _ctx()    { return (window.AesAfp && window.AesAfp.ctx) || null }
    function _bus()    { return (window.AesAfp && window.AesAfp.bus) || null }
    function _emit(name, payload) {
        const bus = _bus()
        if (bus && typeof bus.emit === "function") {
            try { bus.emit(name, payload) } catch (_) { /* bus self-isolates */ }
        }
    }
    function _slot() {
        try {
            return (window.AesAfp && typeof window.AesAfp.slot === "function")
                ? window.AesAfp.slot(SLOT_NAME) : null
        } catch (_) { return null }
    }

    // ── Spec lifecycle ───────────────────────────────────────────────────

    /** Resolve initial spec: load draft from store, else seed from ctx. */
    async function _resolveInitialSpec() {
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            return _seedSpec(ctx)
        }
        if (window.AesAfpStudioDraftStore) {
            try {
                const rec = await window.AesAfpStudioDraftStore.load(ctx.server, ctx.aircraftId)
                if (rec && rec.spec) return window.AesAfpLegSpec.normalizeSpec(rec.spec)
            } catch (e) {
                console.warn("[AES studio] draft load threw", e)
            }
        }
        return _seedSpec(ctx)
    }

    function _seedSpec(ctx) {
        return window.AesAfpLegSpec.createSpec({
            server:      ctx ? ctx.server     : "",
            aircraftId:  ctx ? ctx.aircraftId : "",
            origin:      ctx ? ctx.currentLocationIata : null,
            source:      "manual",
            dryRun:      true
        })
    }

    /** Save current spec to draft store, debounced. Emits draft-changed. */
    function _scheduleSave() {
        if (_saveTimer) clearTimeout(_saveTimer)
        _saveTimer = setTimeout(_flushSave, SAVE_DEBOUNCE_MS)
    }

    async function _flushSave() {
        _saveTimer = null
        const ctx = _ctx()
        if (!ctx || !ctx.server || !ctx.aircraftId) return
        if (!_spec) return
        try {
            if (window.AesAfpStudioDraftStore) {
                await window.AesAfpStudioDraftStore.save(ctx.server, ctx.aircraftId, _spec)
            }
        } catch (e) {
            console.warn("[AES studio] draft save threw", e)
        }
        _emit("studio:draft-changed", {spec: _spec})
    }

    function _updateSpec(nextSpec) {
        _spec = nextSpec
        _scheduleSave()
    }

    // ── Render ───────────────────────────────────────────────────────────

    /**
     * Idempotent render into AesAfp.slot("studio"). Replaces slot contents
     * — the panel owns the slot. Safe to call repeatedly (e.g. on every
     * ctx:ready re-emit).
     */
    async function render() {
        if (_renderInFlight) return
        _renderInFlight = true
        try {
            const host = _slot()
            if (!host) return
            if (!_spec) _spec = await _resolveInitialSpec()
            host.innerHTML = ""
            host.appendChild(_buildShell())
            _renderBody()
        } finally {
            _renderInFlight = false
        }
    }

    function _buildShell() {
        const root = document.createElement("div")
        root.className = "aes-afp-studio"
        root.setAttribute("data-aes-studio-root", "1")
        root.style.cssText = [
            "border-top:1px solid #1f2937",
            "padding:10px 0 8px;margin-top:8px;",
            "color:#cbd5e1;font-size:11px;line-height:1.4;"
        ].join("")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;"
        const title = document.createElement("strong")
        title.textContent = "Flight Studio"
        title.style.cssText = "font-size:12px;color:#e2e8f0;letter-spacing:0.4px;"
        const sub = document.createElement("span")
        sub.textContent = "compose · dry-run"
        sub.style.cssText = "color:#9ca3af;font-size:10px;"
        const flex = document.createElement("span")
        flex.style.cssText = "flex:1 1 auto;"
        const modeBadge = document.createElement("span")
        modeBadge.dataset.aesStudioMode = "1"
        modeBadge.textContent = "DRY-RUN"
        modeBadge.style.cssText = "font-family:var(--aes-font-mono,monospace);font-size:10px;letter-spacing:0.5px;"
            + "color:#fde68a;background:#1f2937;padding:2px 6px;border-radius:3px;"
        head.append(title, sub, flex, modeBadge)
        root.appendChild(head)

        // Body container — _renderBody fills it.
        const body = document.createElement("div")
        body.dataset.aesStudioBody = "1"
        root.appendChild(body)

        return root
    }

    function _renderBody() {
        const host = _slot()
        if (!host) return
        const body = host.querySelector("[data-aes-studio-body]")
        if (!body) return
        body.innerHTML = ""

        body.appendChild(_buildHint())
        body.appendChild(_buildLegRow(_spec.legs[0], 0))
        body.appendChild(_buildSpecMeta())
        body.appendChild(_buildActions())
        body.appendChild(_buildDryRunPane())
    }

    function _buildHint() {
        const ctx = _ctx()
        const hint = document.createElement("div")
        hint.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        if (!ctx || !ctx.server || !ctx.aircraftId) {
            hint.textContent = "Aircraft context not yet resolved — open this from an aircraft Flight Plan page."
            hint.style.color = "#fca5a5"
        } else {
            const hub = ctx.currentLocationIata || "??"
            hint.textContent = "Hub: " + hub + " · " + ctx.registration + " · " + ctx.equipment
        }
        return hint
    }

    function _buildLegRow(leg, idx) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;"

        row.appendChild(_mkLabel("From"))
        row.appendChild(_mkIataInput(leg.origin, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "origin", v))
        }))
        row.appendChild(_mkArrow())
        row.appendChild(_mkLabel("To"))
        row.appendChild(_mkIataInput(leg.destination, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "destination", v))
        }))
        row.appendChild(_mkLabel("Dep"))
        row.appendChild(_mkTimeInput(leg.depTimeLocal, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "depTimeLocal", v))
        }))
        row.appendChild(_mkLabel("Price"))
        row.appendChild(_mkPctInput(leg.pricePct, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "pricePct", v))
        }))
        row.appendChild(_mkLabel("Service"))
        row.appendChild(_mkServiceInput(leg.service, (v) => {
            _updateSpec(window.AesAfpLegSpec.setLegField(_spec, idx, "service", v))
        }))
        return row
    }

    function _buildSpecMeta() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;"
        row.appendChild(_mkLabel("Flight#"))
        row.appendChild(_mkTextInput(_spec.flightNumberText || "", 4, "auto", (v) => {
            _updateSpec(window.AesAfpLegSpec.setSpecField(_spec, "flightNumberText", v))
        }))
        const note = document.createElement("span")
        note.textContent = "(optional — leave blank to let AS auto-assign)"
        note.style.cssText = "color:#6b7280;font-size:10px;"
        row.appendChild(note)
        return row
    }

    function _buildActions() {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;"
        const previewBtn = _mkBtn("Preview", "primary", () => {
            _runPreview()
        })
        const resetBtn = _mkBtn("Reset", "default", async () => {
            const ctx = _ctx()
            _spec = _seedSpec(ctx)
            await _flushSave()
            _renderBody()
        })
        const undoBtn = _mkBtn("Undo", "default", async () => {
            const ctx = _ctx()
            if (!ctx || !window.AesAfpStudioDraftStore) return
            const restored = await window.AesAfpStudioDraftStore.popHistory(ctx.server, ctx.aircraftId)
            if (restored && restored.spec) {
                _spec = window.AesAfpLegSpec.normalizeSpec(restored.spec)
                _renderBody()
                _emit("studio:draft-changed", {spec: _spec})
            }
        })
        row.append(previewBtn, resetBtn, undoBtn)
        return row
    }

    function _buildDryRunPane() {
        const wrap = document.createElement("details")
        wrap.dataset.aesStudioDry = "1"
        wrap.style.marginTop = "4px"

        const sum = document.createElement("summary")
        sum.textContent = _lastDryRun ? "Dry-run POST body" : "Dry-run output (click Preview to populate)"
        sum.style.cssText = "cursor:pointer;font-size:11px;color:#9ca3af;"
        wrap.appendChild(sum)

        const pre = document.createElement("pre")
        pre.dataset.aesStudioDryBody = "1"
        pre.style.cssText = "margin:4px 0 0;padding:6px;background:#0f1419;color:#e2e8f0;font-size:10px;line-height:1.4;overflow:auto;max-height:240px;border-radius:3px;"

        if (_lastDryRun) {
            pre.textContent = _formatDryRun(_lastDryRun)
            wrap.open = true
        } else {
            pre.textContent = "(no dry-run yet — Preview to compute)"
        }
        wrap.appendChild(pre)
        return wrap
    }

    // ── Preview pipeline ─────────────────────────────────────────────────

    function _runPreview() {
        const validation = window.AesAfpLegSpec.validateSpec(_spec)
        if (!validation.ok) {
            _renderHint("error", "Cannot preview: " + validation.errors.map(e => e.path + " — " + e.reason).join("; "))
            return
        }
        if (!window.AesAfpFormDriver || typeof window.AesAfpFormDriver.dryRun !== "function") {
            _renderHint("error", "Form driver not loaded — cannot dry-run.")
            return
        }
        // S1: single-leg only. Multi-leg dry-run lands in S2 alongside the
        // form-driver-x addVia plumbing.
        const formLeg = window.AesAfpLegSpec.toFormDriverLeg(_spec.legs[0])
        const result = window.AesAfpFormDriver.dryRun(formLeg)
        _lastDryRun = result
        _renderBody()
        _emit("studio:dry-run-rendered", {spec: _spec, dryRun: result})
    }

    function _formatDryRun(result) {
        const lines = []
        lines.push("POST " + (result.url || "(unknown)"))
        lines.push("")
        const keys = Object.keys(result.body || {}).sort()
        if (!keys.length) {
            lines.push("(no fields)")
        } else {
            const max = Math.max.apply(null, keys.map(k => k.length))
            for (const k of keys) lines.push(k.padEnd(max) + " = " + result.body[k])
        }
        if (result.missed && result.missed.length) {
            lines.push("")
            lines.push("missed: " + result.missed.join(", "))
            if (result.missed.indexOf("form-not-found") >= 0) {
                lines.push("→ Switch AS to the 'New Flight Number' tab so the form is in the DOM, then re-Preview.")
            }
        }
        return lines.join("\n")
    }

    function _renderHint(kind, message) {
        const host = _slot()
        if (!host) return
        const body = host.querySelector("[data-aes-studio-body]")
        if (!body) return
        let hint = body.querySelector("[data-aes-studio-hint]")
        if (!hint) {
            hint = document.createElement("div")
            hint.dataset.aesStudioHint = "1"
            hint.style.cssText = "font-size:10px;margin-top:4px;line-height:1.4;"
            body.appendChild(hint)
        }
        hint.style.color = (kind === "error") ? "#fca5a5"
                        : (kind === "warn")  ? "#fde68a"
                        : "#a7f3d0"
        hint.textContent = message
    }

    // ── Input factories ──────────────────────────────────────────────────

    function _mkLabel(text) {
        const s = document.createElement("span")
        s.textContent = text
        s.style.cssText = "color:#9ca3af;font-size:10px;letter-spacing:0.4px;text-transform:uppercase;"
        return s
    }
    function _mkArrow() {
        const s = document.createElement("span")
        s.textContent = "→"
        s.style.cssText = "color:#6b7280;font-size:12px;"
        return s
    }
    function _mkBaseInput(value, maxlen, width) {
        const inp = document.createElement("input")
        inp.type = "text"
        inp.value = value == null ? "" : String(value)
        if (maxlen != null) inp.maxLength = maxlen
        inp.style.cssText = [
            "background:#0f1419;color:#e2e8f0;",
            "border:1px solid #374151;border-radius:3px;",
            "padding:3px 6px;font-size:11px;",
            "font-family:var(--aes-font-mono,monospace);",
            "width:" + (width || "auto") + ";"
        ].join("")
        return inp
    }
    function _mkIataInput(value, onChange) {
        const inp = _mkBaseInput((value || "").toUpperCase(), 3, "56px")
        inp.placeholder = "IATA"
        inp.style.textTransform = "uppercase"
        inp.addEventListener("input", () => {
            const v = inp.value.toUpperCase()
            if (inp.value !== v) inp.value = v
            onChange(v)
        })
        return inp
    }
    function _mkTimeInput(value, onChange) {
        const inp = _mkBaseInput(value || "", 5, "60px")
        inp.placeholder = "HH:MM"
        inp.addEventListener("input", () => onChange(inp.value))
        inp.addEventListener("blur", () => {
            const v = inp.value.trim()
            if (/^\d{1,2}:\d{2}$/.test(v)) {
                const [h, m] = v.split(":").map(Number)
                if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                    const padded = (h < 10 ? "0" + h : "" + h) + ":" + (m < 10 ? "0" + m : "" + m)
                    if (inp.value !== padded) {
                        inp.value = padded
                        onChange(padded)
                    }
                }
            }
        })
        return inp
    }
    function _mkPctInput(value, onChange) {
        const inp = _mkBaseInput(value == null ? "100" : String(value), 3, "48px")
        inp.placeholder = "100"
        inp.title = "50–200"
        inp.addEventListener("input", () => {
            const v = parseInt(inp.value, 10)
            if (isFinite(v)) onChange(v)
        })
        return inp
    }
    function _mkServiceInput(value, onChange) {
        // S1 ships a free-text input; S2's paste-import will introduce
        // label-fallback (e.g. "Standard" → "719"). The form-driver's
        // setService matches the option `value` directly, so blank or
        // numeric strings both work here.
        const inp = _mkBaseInput(value || "", 24, "120px")
        inp.placeholder = "(default)"
        inp.title = "Service profile option value (e.g. '719' for Standard). Blank = AS default."
        inp.addEventListener("input", () => onChange(inp.value))
        return inp
    }
    function _mkTextInput(value, maxlen, width, onChange) {
        const inp = _mkBaseInput(value || "", maxlen, width)
        inp.addEventListener("input", () => onChange(inp.value))
        return inp
    }
    function _mkBtn(label, kind, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        const isPrimary = kind === "primary"
        b.style.cssText = [
            "background:" + (isPrimary ? "#1e40af" : "#0f1623"),
            "color:" + (isPrimary ? "#dbeafe" : "#cbd5e1"),
            "border:1px solid " + (isPrimary ? "#1d4ed8" : "#374151"),
            "border-radius:3px;padding:4px 10px;font-size:11px;",
            "font-weight:600;cursor:pointer;"
        ].join(";")
        b.addEventListener("click", onClick)
        return b
    }

    // ── Public ───────────────────────────────────────────────────────────

    /** Programmatic open — scrolls panel into view, focuses first input,
     *  emits studio:opened. Tolerant of slot-not-yet-mounted (will render
     *  on next ctx:ready if necessary). */
    async function open(trigger) {
        await render()
        const host = _slot()
        if (host) {
            try { host.scrollIntoView({behavior: "smooth", block: "center"}) }
            catch (_) { /* old browsers — noop */ }
            const firstInput = host.querySelector("input")
            if (firstInput) {
                try { firstInput.focus() } catch (_) {}
            }
        }
        _emit("studio:opened", {trigger: trigger || TRIGGER_INIT})
    }

    function getSpec() { return _spec }

    function attach() {
        if (_attached) return
        const bus = _bus()
        if (!bus) return
        _attached = true
        // Re-render on every ctx:ready — covers initial mount AND Wicket
        // re-mount paths. render() is idempotent.
        bus.on("ctx:ready", () => { render().catch(e => console.warn("[AES studio] render threw", e)) })
        // If ctx is already ready by the time we attach (manifest order
        // may have dispatched ctx:ready before our handler subscribed),
        // render eagerly.
        if (window.AesAfp && window.AesAfp.ctx) {
            render().catch(e => console.warn("[AES studio] initial render threw", e))
        }
    }

    window.AesAfpFlightStudio = {
        attach,
        render,
        open,
        getSpec
    }

    // Late-load guard — Slice A's bus may not be live yet when this
    // module evaluates (manifest order should put us after host.js but
    // parse-vs-execute timing isn't strict). Mirror form-driver.js's
    // poll pattern.
    if (window.AesAfp && window.AesAfp.bus) {
        attach()
    } else {
        let tries = 0
        const id = setInterval(() => {
            if (window.AesAfp && window.AesAfp.bus) {
                clearInterval(id)
                attach()
            } else if (++tries > 50) {
                clearInterval(id)
            }
        }, 100)
    }
})()
