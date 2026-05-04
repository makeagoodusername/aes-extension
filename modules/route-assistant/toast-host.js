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
 * Visual styling lives entirely in css/components.css under .aes-toast-host
 * and .aes-toast / .aes-toast--{info|success|warn|error}. This module owns
 * lifecycle (create / dismiss / replace / progress) only — no inline hex.
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
    static VALID_TYPES   = ["info", "success", "warn", "error"]

    /** N2 — session-scoped history of every toast fired. Capped to keep
     *  storage bounded; each entry is a slim record with the original
     *  message, type, action (only the function reference is kept — not
     *  serialisable, so the history is in-memory only, NOT persisted to
     *  chrome.storage). */
    static MAX_HISTORY = 50
    static _history = []

    static _seq = 0
    static _registry = new Map()   // id -> {el, timer, msgEl, progressFill, progressLabel}

    static show(message, opts) {
        opts = opts || {}
        const host = RouteAssistantToast._ensureHost()
        const id = opts.id || ("aes-toast-" + (++RouteAssistantToast._seq))

        // Reuse an existing toast with the same id (e.g. spammed save calls).
        if (RouteAssistantToast._registry.has(id)) {
            RouteAssistantToast.dismiss(id)
        }

        const type = RouteAssistantToast.VALID_TYPES.includes(opts.type) ? opts.type : "info"
        const duration = (opts.duration == null) ? RouteAssistantToast.DEFAULT_MS : Number(opts.duration)

        const el = document.createElement("div")
        el.dataset.toastId = id
        el.className = "aes-toast aes-toast--" + type

        const body = document.createElement("div")
        body.className = "aes-toast__body"

        const msgEl = document.createElement("span")
        msgEl.className = "aes-toast__msg"
        msgEl.textContent = String(message || "")
        body.append(msgEl)

        if (opts.action && typeof opts.action.fn === "function") {
            const actBtn = document.createElement("button")
            actBtn.type = "button"
            actBtn.className = "aes-toast__action"
            actBtn.textContent = String(opts.action.label || "Action")
            actBtn.addEventListener("click", () => {
                try { opts.action.fn() } catch (e) { console.warn("[AES toast] action threw", e) }
                RouteAssistantToast.dismiss(id)
            })
            body.append(actBtn)
        }

        el.append(body)

        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.className = "aes-toast__close"
        closeBtn.textContent = "×"
        closeBtn.title = "Dismiss"
        closeBtn.addEventListener("click", () => RouteAssistantToast.dismiss(id))
        el.append(closeBtn)

        host.append(el)

        // N2 — push to session history. Stored as a slim record; the
        // action.fn is kept by reference so the notification center can
        // re-fire it. History is in-memory only (action functions aren't
        // serialisable). Cap is applied via shift().
        RouteAssistantToast._history.push({
            id:        id,
            message:   String(message || ""),
            type:      type,
            timestamp: Date.now(),
            action:    (opts.action && typeof opts.action.fn === "function")
                ? {label: String(opts.action.label || "Action"), fn: opts.action.fn}
                : null
        })
        if (RouteAssistantToast._history.length > RouteAssistantToast.MAX_HISTORY) {
            RouteAssistantToast._history.shift()
        }

        // Slide-in: start translated off-screen right, then slide to 0.
        // Inline because this is per-instance lifecycle state, not a static style.
        el.style.transform = "translateX(40px)"
        el.style.opacity   = "0"
        requestAnimationFrame(() => {
            el.style.transform = "translateX(0)"
            el.style.opacity   = "1"
        })

        let timer = null
        if (duration > 0) {
            timer = setTimeout(() => RouteAssistantToast.dismiss(id), duration)
        }
        RouteAssistantToast._registry.set(id, {el, timer, msgEl})

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

    /** N2 — session toast history accessors. Most-recent-last order. */
    static getHistory()  { return RouteAssistantToast._history.slice() }
    static clearHistory() { RouteAssistantToast._history = [] }

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
        RouteAssistantToast.show(message, Object.assign({}, opts, {
            id:       id,
            duration: 0,
            type:     opts.type || "info"
        }))
        const rec = RouteAssistantToast._registry.get(id)
        if (!rec) return null

        // Build the progress bar + secondary label inside .aes-toast__body
        // so the bar sits below the message line.
        const bar = document.createElement("div")
        bar.className = "aes-toast__progress"
        const fill = document.createElement("div")
        fill.className = "aes-toast__progress-fill"
        bar.append(fill)

        const subLabel = document.createElement("span")
        subLabel.className = "aes-toast__progress-label"

        const body = rec.el.querySelector(".aes-toast__body")
        if (body) {
            body.append(bar, subLabel)
        }

        rec.progressFill  = fill
        rec.progressLabel = subLabel

        return {
            id: id,
            dismiss: () => RouteAssistantToast.dismiss(id),
            update: (patch) => RouteAssistantToast.update(id, patch),
            complete: (patch) => RouteAssistantToast.complete(id, patch)
        }
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
        if (patch.message != null && rec.msgEl) {
            rec.msgEl.textContent = String(patch.message)
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
     * ("success" / "warn" / "error"). Progress bar fills to 100% and the
     * toast auto-dismisses after `duration` (default 3500ms).
     */
    static complete(id, patch) {
        const rec = RouteAssistantToast._registry.get(id)
        if (!rec) return
        patch = patch || {}
        const finalType = RouteAssistantToast.VALID_TYPES.includes(patch.type) ? patch.type : "success"

        // Re-class the toast so .aes-toast--<type> updates accent stripe + fill colour.
        rec.el.className = "aes-toast aes-toast--" + finalType
        if (rec.progressFill) {
            rec.progressFill.style.width = "100%"
        }
        if (patch.message != null && rec.msgEl) {
            rec.msgEl.textContent = String(patch.message)
        }

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
        host.className = "aes-toast-host"
        document.body.appendChild(host)
        return host
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantToast = RouteAssistantToast
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantToast
}
