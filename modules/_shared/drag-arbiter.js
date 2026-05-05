"use strict"

/**
 * Single owner of every drag gesture across RA / AFP / FSG / canopy.
 *
 * Why this exists: the codebase had five inline drag implementations
 * (wave-strip band drag, FSG band shift, FSG dnd-grid-bridge, wave-overlay
 * chip→lane, wave-strip edge resize). Each re-implemented snap math, ghost
 * rendering, ESC cancellation, and mouseup persistence — and ESC cancelled
 * none of them.
 *
 * The arbiter centralises:
 *   - Gesture registration (so multiple surfaces can compete for one event).
 *   - Priority arbitration (band-edge resize beats band-shift beats lane scroll).
 *   - Universal ESC cancel (one document keydown listener).
 *   - Shared utilities: snap-to-X, ghost renderer, snap-line, hit-testing.
 *   - One audit trail (every effect emits `dragschedule:applied` on the bus).
 *
 * Gesture descriptor (the contract):
 *
 *   {
 *     id:        string,                       // e.g. "ra.unplaced.toLane"
 *     surface:   "ra"|"afp"|"fsg"|"canopy",
 *     matches:   (event, ctx) => boolean,      // first-true-wins; called
 *                                              //   for every startManual/Native
 *     priority:  number,                       // higher first; ties by reg order
 *     feedback?: {
 *       buildGhost?:    (ctx) => GhostSpec|null,
 *       buildSnapLine?: (ctx) => SnapLineSpec|null,
 *       cancelKey?:     "Escape"               // default
 *     },
 *     effect:    (drop) => Promise<{ok, message?, audit?}>,
 *     guard?:    () => Promise<boolean>,       // false → preview-only mode
 *     governedBy?: {                           // metadata for telemetry/audit
 *       settingPath: string,
 *       requiredValue: any,
 *       tier?: "preview-only"|"apply-on-confirm"|"apply-auto"
 *     }
 *   }
 *
 * Lifecycle:
 *   startManual(event, ctx)  ← consumer's mousedown calls this
 *   startNative(event, ctx)  ← consumer's HTML5 dragstart calls this
 *     → walk gestures (priority desc, reg-order tiebreak)
 *     → first matches() → that gesture wins
 *     → guard() runs; false sets previewOnly = true
 *     → buildGhost / buildSnapLine if provided
 *     → attach document mousemove/mouseup/keydown
 *     → emit dragschedule:gesture-start
 *   on move:    update ghost + snap-line; gesture's onMove if defined
 *   on mouseup: compute drop context; effect() (or toast if previewOnly);
 *               emit dragschedule:gesture-end + dragschedule:applied
 *   on ESC:     cancel; emit dragschedule:gesture-end {outcome: "cancelled"}
 *
 * Bus events emitted on AesAfp.bus + AesStrategy.bus + CentralHubBus
 * whichever exist on the page; subscribers pick whichever they listen to.
 */
;(function () {
    if (window.AesDragArbiter) return

    const REG = []
    let _docAttached = false
    let _active = null
    let _idSeq = 0

    function _emit(event, payload) {
        const buses = []
        try { if (window.AesAfp && window.AesAfp.bus) buses.push(window.AesAfp.bus) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) buses.push(window.AesStrategy.bus) } catch (_) {}
        try { if (window.CentralHubBus) buses.push(window.CentralHubBus) } catch (_) {}
        for (const bus of buses) {
            try { bus.emit(event, payload) } catch (_) {}
        }
    }

    function _ensureDocListeners() {
        if (_docAttached) return
        _docAttached = true
        document.addEventListener("mousemove", _onDocMove, true)
        document.addEventListener("mouseup",   _onDocUp,   true)
        document.addEventListener("keydown",   _onDocKey,  true)
    }

    function register(gesture) {
        if (!gesture || typeof gesture.matches !== "function" || typeof gesture.effect !== "function") {
            throw new Error("DragArbiter.register: gesture requires matches() and effect()")
        }
        const id = gesture.id || ("g" + (++_idSeq))
        const entry = Object.assign({}, gesture, {
            id,
            priority: Number(gesture.priority) || 0,
            _regOrder: ++_idSeq
        })
        REG.push(entry)
        REG.sort(_compareReg)
        _ensureDocListeners()
        return id
    }

    function unregister(id) {
        const i = REG.findIndex(g => g.id === id)
        if (i >= 0) REG.splice(i, 1)
    }

    function _compareReg(a, b) {
        if (a.priority !== b.priority) return b.priority - a.priority
        return a._regOrder - b._regOrder
    }

    function _findMatch(event, ctx) {
        for (const g of REG) {
            try { if (g.matches(event, ctx)) return g } catch (_) {}
        }
        return null
    }

    async function startManual(event, ctx) {
        if (_active) return false
        const gesture = _findMatch(event, ctx)
        if (!gesture) return false
        return _begin(gesture, event, ctx, "manual")
    }

    async function startNative(event, ctx) {
        if (_active) return false
        const gesture = _findMatch(event, ctx)
        if (!gesture) return false
        return _begin(gesture, event, ctx, "native")
    }

    async function _begin(gesture, event, ctx, kind) {
        let previewOnly = false
        if (typeof gesture.guard === "function") {
            try {
                const ok = await gesture.guard()
                previewOnly = (ok === false)
            } catch (_) { previewOnly = true }
        }
        const fb = gesture.feedback || {}
        let ghost = null, snapLine = null
        try {
            if (typeof fb.buildGhost === "function") {
                const spec = fb.buildGhost(ctx)
                if (spec) ghost = drawGhost(spec)
            }
            if (typeof fb.buildSnapLine === "function") {
                const spec = fb.buildSnapLine(ctx)
                if (spec) snapLine = drawSnapLine(spec)
            }
        } catch (_) {}
        _active = {
            gesture, ctx, kind, previewOnly,
            ghost, snapLine,
            startedAt: Date.now(),
            startEvent: event,
            lastClientX: event.clientX || 0,
            lastClientY: event.clientY || 0
        }
        if (kind === "manual" && typeof event.preventDefault === "function") {
            // Suppress text selection on manual drag.
            event.preventDefault()
        }
        _emit("dragschedule:gesture-start", {
            gestureId: gesture.id, surface: gesture.surface, kind, previewOnly
        })
        return true
    }

    function _onDocMove(event) {
        if (!_active) return
        _active.lastClientX = event.clientX
        _active.lastClientY = event.clientY
        if (_active.ghost) _active.ghost.move(event.clientX, event.clientY)
        const fb = _active.gesture.feedback || {}
        if (typeof fb.onMove === "function") {
            try { fb.onMove(event, _active.ctx, _active) } catch (_) {}
        }
    }

    async function _onDocUp(event) {
        if (!_active) return
        const a = _active
        _active = null
        const drop = {event, ctx: a.ctx, clientX: event.clientX, clientY: event.clientY}
        let outcome = "applied"
        let result = null
        try {
            if (a.previewOnly) {
                outcome = "preview-only"
                _emit("dragschedule:preview-only", {gestureId: a.gesture.id})
            } else {
                result = await a.gesture.effect(drop)
                if (result && result.ok === false) outcome = "failed"
            }
        } catch (err) {
            outcome = "failed"
            result = {ok: false, message: (err && err.message) || String(err)}
        } finally {
            if (a.ghost) try { a.ghost.destroy() } catch (_) {}
            if (a.snapLine) try { a.snapLine.destroy() } catch (_) {}
        }
        _emit("dragschedule:gesture-end", {
            gestureId: a.gesture.id, surface: a.gesture.surface,
            outcome, durMs: Date.now() - a.startedAt
        })
        if (outcome === "applied" && result && result.audit) {
            _emit("dragschedule:applied", {
                gestureId: a.gesture.id, effect: result.audit
            })
        }
    }

    function _onDocKey(event) {
        if (!_active) return
        const cancelKey = (_active.gesture.feedback && _active.gesture.feedback.cancelKey) || "Escape"
        if (event.key !== cancelKey) return
        cancel("user-cancel")
        event.preventDefault()
        event.stopPropagation()
    }

    function cancel(reason) {
        if (!_active) return
        const a = _active
        _active = null
        if (a.ghost) try { a.ghost.destroy() } catch (_) {}
        if (a.snapLine) try { a.snapLine.destroy() } catch (_) {}
        const fb = a.gesture.feedback || {}
        if (typeof fb.onCancel === "function") {
            try { fb.onCancel(a.ctx, {reason: reason || "cancel"}) } catch (_) {}
        }
        _emit("dragschedule:gesture-end", {
            gestureId: a.gesture.id, surface: a.gesture.surface,
            outcome: "cancelled", reason: reason || "cancel",
            durMs: Date.now() - a.startedAt
        })
    }

    function isActive() { return _active != null }

    /* --- utilities ------------------------------------------------------ */

    function snap(min, granularityMin) {
        const g = Math.max(1, Number(granularityMin) || 5)
        const m = Number(min)
        if (!isFinite(m)) return null
        return Math.round(m / g) * g
    }

    /**
     * Map a clientX inside an element's content rect to a minute (0..1439)
     * using the element's `[data-aes-strip]` total-min/start-min attributes
     * if present, or explicit args.
     */
    function pxToMin(rect, clientX, totalMin, startMin) {
        const r = rect && rect.getBoundingClientRect ? rect.getBoundingClientRect() : rect
        if (!r) return null
        const total = Number(totalMin) || 1440
        const start = Number(startMin) || 0
        const x = clientX - r.left
        const w = r.width || 1
        const t = (x / w) * total + start
        if (!isFinite(t)) return null
        return Math.max(0, Math.min(total - 1, Math.round(t)))
    }

    /**
     * Walk a strip element's lane children (selector configurable) and return
     * the lane DOM whose vertical mid-point is closest to clientY, or null.
     */
    function coordsToWave(stripEl, clientY, laneSelector) {
        if (!stripEl || !stripEl.querySelectorAll) return null
        const lanes = stripEl.querySelectorAll(laneSelector || "[data-aes-wave-lane]")
        let best = null, bestDist = Infinity
        for (const lane of lanes) {
            const r = lane.getBoundingClientRect()
            const mid = r.top + r.height / 2
            const dist = Math.abs(mid - clientY)
            if (dist < bestDist) { bestDist = dist; best = lane }
        }
        return best
    }

    function drawGhost(spec) {
        const el = document.createElement("div")
        el.style.position    = "fixed"
        el.style.pointerEvents = "none"
        el.style.zIndex      = "999999"
        el.style.transform   = "translate(-50%, -50%)"
        el.style.padding     = "4px 8px"
        el.style.borderRadius= "4px"
        el.style.fontSize    = "11px"
        el.style.fontFamily  = "ui-monospace, monospace"
        el.style.background  = (spec && spec.tint) || "rgba(15,23,42,0.92)"
        el.style.color       = "#fff"
        el.style.boxShadow   = "0 4px 12px rgba(0,0,0,0.35)"
        el.style.whiteSpace  = "nowrap"
        el.style.userSelect  = "none"
        if (spec && typeof spec.label === "string") el.textContent = spec.label
        if (spec && spec.opacity != null) el.style.opacity = String(spec.opacity)
        document.body.appendChild(el)
        return {
            move(x, y) { el.style.left = x + "px"; el.style.top = y + "px" },
            update(label, tint) {
                if (typeof label === "string") el.textContent = label
                if (typeof tint === "string") el.style.background = tint
            },
            destroy() { try { el.remove() } catch (_) {} }
        }
    }

    function drawSnapLine(spec) {
        if (!spec || !spec.host) return null
        const host = spec.host
        const line = document.createElement("div")
        line.style.position      = "absolute"
        line.style.top           = "0"
        line.style.bottom        = "0"
        line.style.width         = "1px"
        line.style.background    = spec.color || "#3b82f6"
        line.style.pointerEvents = "none"
        line.style.zIndex        = "10"
        line.style.left          = (spec.leftPct != null ? spec.leftPct : 0) + "%"
        if (host.style && host.style.position === "") host.style.position = "relative"
        host.appendChild(line)
        return {
            move(leftPct) { line.style.left = leftPct + "%" },
            destroy() { try { line.remove() } catch (_) {} }
        }
    }

    function showCancelHint() {
        if (document.getElementById("aes-drag-cancel-hint")) return
        const hint = document.createElement("div")
        hint.id = "aes-drag-cancel-hint"
        hint.textContent = "ESC to cancel"
        hint.style.position    = "fixed"
        hint.style.right       = "12px"
        hint.style.bottom      = "12px"
        hint.style.padding     = "4px 8px"
        hint.style.borderRadius= "3px"
        hint.style.fontSize    = "11px"
        hint.style.fontFamily  = "ui-monospace, monospace"
        hint.style.background  = "rgba(15,23,42,0.85)"
        hint.style.color       = "#fff"
        hint.style.zIndex      = "999998"
        hint.style.pointerEvents = "none"
        document.body.appendChild(hint)
        return { destroy() { try { hint.remove() } catch (_) {} } }
    }

    window.AesDragArbiter = {
        register, unregister,
        startManual, startNative,
        isActive, cancel,
        _registry: REG,                  // for tests / debug; not API-stable
        utils: {
            snap, pxToMin, coordsToWave,
            drawGhost, drawSnapLine, showCancelHint
        }
    }
})()
