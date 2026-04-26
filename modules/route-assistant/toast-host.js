"use strict"

/**
 * Toast notification host (Daily-driver QoL — U14, foundation primitive).
 *
 * Singleton DOM container at the bottom-right of the viewport. Every part
 * of the panel that wants to confirm a save / surface a sync result / nudge
 * the user about a state change calls `RouteAssistantToast.show(message)`
 * instead of writing to the console. Future Undo, Alert, and bulk-op
 * completion features all reuse this primitive.
 *
 * Public API:
 *   RouteAssistantToast.show(message, opts)
 *     opts = {
 *       type:     "info" | "success" | "warn" | "error" (default "info")
 *       duration: ms (default 3500). Pass 0 to make the toast persistent.
 *       action:   {label, fn} — renders an action button (e.g. Undo)
 *       id:       optional caller-supplied id; reusing an id replaces
 *                 the existing toast (handy for "re-confirm same action")
 *     }
 *   Returns {id, dismiss(): void}
 *
 *   RouteAssistantToast.dismiss(id)
 *   RouteAssistantToast.clearAll()
 *
 * Stacking: newest toast appears at the BOTTOM of the stack (closest to
 * the viewport edge). When `MAX_TOASTS` is exceeded, the oldest toast is
 * dismissed automatically.
 */
class RouteAssistantToast {
    static MAX_TOASTS    = 6
    static DEFAULT_MS    = 3500
    static CONTAINER_ID  = "aes-toast-host"

    static _seq = 0
    static _registry = new Map()   // id -> {el, timer}

    static show(message, opts) {
        opts = opts || {}
        const host = RouteAssistantToast._ensureHost()
        const id = opts.id || ("aes-toast-" + (++RouteAssistantToast._seq))

        // Reuse an existing toast with the same id (e.g. spammed save calls).
        if (RouteAssistantToast._registry.has(id)) {
            RouteAssistantToast.dismiss(id)
        }

        const type = (opts.type === "success" || opts.type === "warn"
                   || opts.type === "error"   || opts.type === "info") ? opts.type : "info"
        const duration = (opts.duration == null) ? RouteAssistantToast.DEFAULT_MS : Number(opts.duration)

        const el = document.createElement("div")
        el.dataset.toastId = id
        el.style.cssText = RouteAssistantToast._toastStyle(type)

        const msgSpan = document.createElement("span")
        msgSpan.textContent = String(message || "")
        msgSpan.style.cssText = "flex:1;line-height:1.4;"
        el.append(msgSpan)

        if (opts.action && typeof opts.action.fn === "function") {
            const actBtn = document.createElement("button")
            actBtn.textContent = String(opts.action.label || "Action")
            actBtn.style.cssText = "background:transparent;color:#fde68a;border:1px solid rgba(253,230,138,0.5);"
                + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;flex-shrink:0;"
            actBtn.addEventListener("click", () => {
                try { opts.action.fn() } catch (e) { console.warn("[AES toast] action threw", e) }
                RouteAssistantToast.dismiss(id)
            })
            el.append(actBtn)
        }

        const closeBtn = document.createElement("button")
        closeBtn.textContent = "×"
        closeBtn.title = "Dismiss"
        closeBtn.style.cssText = "background:transparent;color:#9ca3af;border:none;font-size:16px;"
            + "cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;"
        closeBtn.addEventListener("click", () => RouteAssistantToast.dismiss(id))
        el.append(closeBtn)

        host.append(el)

        // Slide-in: start translated off-screen right, then slide to 0.
        el.style.transform = "translateX(40px)"
        el.style.opacity   = "0"
        // rAF nudge so the transition fires.
        requestAnimationFrame(() => {
            el.style.transform = "translateX(0)"
            el.style.opacity   = "1"
        })

        let timer = null
        if (duration > 0) {
            timer = setTimeout(() => RouteAssistantToast.dismiss(id), duration)
        }
        RouteAssistantToast._registry.set(id, {el, timer})

        // Trim old toasts if we're over the cap.
        while (RouteAssistantToast._registry.size > RouteAssistantToast.MAX_TOASTS) {
            const oldestId = RouteAssistantToast._registry.keys().next().value
            RouteAssistantToast.dismiss(oldestId)
        }

        return {id: id, dismiss: () => RouteAssistantToast.dismiss(id)}
    }

    static dismiss(id) {
        const rec = RouteAssistantToast._registry.get(id)
        if (!rec) return
        RouteAssistantToast._registry.delete(id)
        if (rec.timer) clearTimeout(rec.timer)
        const el = rec.el
        if (!el || !el.parentNode) return
        // Slide-out + fade.
        el.style.transform = "translateX(40px)"
        el.style.opacity   = "0"
        setTimeout(() => {
            if (el.parentNode) el.parentNode.removeChild(el)
        }, 220)
    }

    static clearAll() {
        for (const id of Array.from(RouteAssistantToast._registry.keys())) {
            RouteAssistantToast.dismiss(id)
        }
    }

    /** Convenience helpers — one-liner call-sites. */
    static info   (m, o) { return RouteAssistantToast.show(m, Object.assign({}, o, {type: "info"})) }
    static success(m, o) { return RouteAssistantToast.show(m, Object.assign({}, o, {type: "success"})) }
    static warn   (m, o) { return RouteAssistantToast.show(m, Object.assign({}, o, {type: "warn"})) }
    static error  (m, o) { return RouteAssistantToast.show(m, Object.assign({}, o, {type: "error"})) }

    /**
     * N1 — Progress toast. Creates a STICKY toast (no auto-dismiss) with
     * an inline progress bar that the caller updates in place via
     * `RouteAssistantToast.update(id, {message, progressPct, progressLabel})`.
     * Call `RouteAssistantToast.complete(id, {message, type})` when the
     * op finishes — that converts the sticky toast to a regular one
     * which auto-dismisses on the standard timer.
     *
     * Returns {id, dismiss(), update({message, progressPct, progressLabel}),
     *          complete({message, type})}
     */
    static progress(message, opts) {
        opts = opts || {}
        const id = opts.id || ("aes-progress-" + (++RouteAssistantToast._seq))
        // Render a regular toast first (sticky — duration 0).
        RouteAssistantToast.show(message, Object.assign({}, opts, {
            id:       id,
            duration: 0,
            type:     opts.type || "info"
        }))
        const rec = RouteAssistantToast._registry.get(id)
        if (!rec) return null
        const el = rec.el

        // Build the progress bar + label inside the toast element. We
        // append after the existing message span so the bar lives below
        // the title line.
        const wrapper = document.createElement("div")
        wrapper.style.cssText = "flex:1 0 100%;display:flex;flex-direction:column;gap:4px;margin-top:2px;"
        const bar = document.createElement("div")
        bar.style.cssText = "height:4px;background:rgba(100,116,139,0.30);border-radius:3px;overflow:hidden;position:relative;"
        const fill = document.createElement("div")
        fill.style.cssText = "height:100%;width:0%;background:#60a5fa;transition:width 200ms ease;"
        bar.append(fill)
        const subLabel = document.createElement("span")
        subLabel.style.cssText = "color:#9ca3af;font-size:10px;"
        wrapper.append(bar, subLabel)
        // Toast layout was `flex` row; add `flex-wrap: wrap` so the
        // progress block sits below the message line.
        el.style.flexWrap = "wrap"
        el.append(wrapper)

        // Stash the elements on the registry record so update() can find them.
        rec.progressFill  = fill
        rec.progressLabel = subLabel

        const handle = {
            id: id,
            dismiss: () => RouteAssistantToast.dismiss(id),
            update: (patch) => RouteAssistantToast.update(id, patch),
            complete: (patch) => RouteAssistantToast.complete(id, patch)
        }
        return handle
    }

    /**
     * Update an in-flight progress toast in place. `patch` may contain:
     *   - message:       new top-line message text
     *   - progressPct:   number 0..100 — sets the fill bar width
     *   - progressLabel: secondary text under the bar (e.g. "12 / 87 routes")
     */
    static update(id, patch) {
        const rec = RouteAssistantToast._registry.get(id)
        if (!rec || !patch) return
        if (patch.message != null) {
            const span = rec.el.querySelector("span")
            if (span) span.textContent = String(patch.message)
        }
        if (patch.progressPct != null && rec.progressFill) {
            const pct = Math.max(0, Math.min(100, Number(patch.progressPct) || 0))
            rec.progressFill.style.width = pct + "%"
        }
        if (patch.progressLabel != null && rec.progressLabel) {
            rec.progressLabel.textContent = String(patch.progressLabel)
        }
    }

    /**
     * Convert a progress toast to a regular auto-dismissing toast on
     * completion. Patch may set the final message + a new type
     * ("success" / "warn" / "error"). Progress bar fills to 100% and
     * fades out after `duration` (default 2.5s).
     */
    static complete(id, patch) {
        const rec = RouteAssistantToast._registry.get(id)
        if (!rec) return
        patch = patch || {}
        const finalType = patch.type || "success"
        // Restyle the toast for the new type. Re-apply the toast palette CSS.
        const palette = {
            info:    {bg: "#0f1623", border: "#475569", color: "#e5e7eb"},
            success: {bg: "#052e1a", border: "#34d399", color: "#d1fae5"},
            warn:    {bg: "#3a2008", border: "#fbbf24", color: "#fef3c7"},
            error:   {bg: "#3b0e10", border: "#f87171", color: "#fee2e2"}
        }
        const c = palette[finalType] || palette.success
        rec.el.style.background = c.bg
        rec.el.style.color      = c.color
        rec.el.style.borderColor = c.border
        if (rec.progressFill) {
            rec.progressFill.style.width = "100%"
            rec.progressFill.style.background = (finalType === "error") ? "#f87171"
                : (finalType === "warn") ? "#fbbf24" : "#34d399"
        }
        if (patch.message != null) {
            const span = rec.el.querySelector("span")
            if (span) span.textContent = String(patch.message)
        }
        // Re-arm the auto-dismiss timer for a final fade-out.
        if (rec.timer) clearTimeout(rec.timer)
        const duration = (patch.duration != null) ? Number(patch.duration) : 3500
        rec.timer = setTimeout(() => RouteAssistantToast.dismiss(id), duration)
    }

    /** Singleton host element — created lazily on first show(). */
    static _ensureHost() {
        let host = document.getElementById(RouteAssistantToast.CONTAINER_ID)
        if (host) return host
        host = document.createElement("div")
        host.id = RouteAssistantToast.CONTAINER_ID
        host.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:10001;"
            + "display:flex;flex-direction:column;gap:6px;align-items:flex-end;"
            + "pointer-events:none;font:12px/1.4 sans-serif;max-width:420px;"
        document.body.appendChild(host)
        return host
    }

    static _toastStyle(type) {
        const palette = {
            info:    {bg: "#0f1623", border: "#475569", color: "#e5e7eb"},
            success: {bg: "#052e1a", border: "#34d399", color: "#d1fae5"},
            warn:    {bg: "#3a2008", border: "#fbbf24", color: "#fef3c7"},
            error:   {bg: "#3b0e10", border: "#f87171", color: "#fee2e2"}
        }
        const c = palette[type] || palette.info
        return "background:" + c.bg + ";color:" + c.color + ";"
            + "border:1px solid " + c.border + ";border-radius:5px;"
            + "padding:8px 10px;display:flex;align-items:center;gap:10px;"
            + "box-shadow:0 4px 12px rgba(0,0,0,0.35);"
            + "transition:transform 200ms ease, opacity 200ms ease;"
            + "pointer-events:auto;min-width:240px;max-width:420px;"
            + "font-size:12px;"
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantToast
}
