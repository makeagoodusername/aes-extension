"use strict"

/**
 * In-page Notification API — adapted from the upstream AirlineSim
 * Enhancement Suite v0.7.8 (NEWLY2014 fork). Combines upstream's
 * `notification.js` (single-toast element) and `notifications.js` (manager)
 * into one substrate file using the fork's IIFE singleton convention.
 *
 * Two responsibilities:
 *
 *   1. `AesNotification` — wraps a single AS-native `<li>` element with
 *      `feedbackPanelSUCCESS|WARNING|ERROR` styling. Style provided by
 *      AS itself; we do not ship CSS for the toast — AS already has it.
 *
 *   2. `AesNotifications` — singleton manager that finds (or creates) the
 *      `.feedbackPanel` `<ul>` container next to the AS navbar, then
 *      appends/auto-dismisses toasts.
 *
 * Adaptation notes vs upstream:
 *   - We expose `AesNotification` / `AesNotifications` (Aes-prefixed)
 *     rather than `Notification` / `Notifications`. The W3C Notification
 *     interface is a global on every page — masking it with our class
 *     would silently break any AS-native code that uses Web Notifications.
 *   - Every successful `add()` also emits a `data:notifications:posted`
 *     bus event so other modules can observe (e.g. Strategy's salience
 *     scorer, or a future audit timeline). Bus emit is best-effort:
 *     wrapped in try/catch so a missing bus doesn't break the toast.
 *   - The `route-assistant/toast-host.js` (`RouteAssistantToast`) is a
 *     parallel system used inside the RA panel for bottom-right toasts
 *     with action buttons. We do NOT bridge — different visual contexts
 *     (top AS feedback bar vs bottom-right floating). Callers pick the
 *     right one for the surface they're on.
 *   - Long-op chrome.notifications bridge in
 *     `modules/_background/notifications.js` is a separate concern
 *     (system-tray notifications for completed background scrapes) and
 *     stays untouched.
 */

;(function () {
    if (typeof window === "undefined") return
    if (window.AesNotifications) return

    const FEEDBACK_PANEL_SELECTOR = ".feedbackPanel"
    const NAVBAR_AFTER_SELECTOR   = "nav.as-navbar-main + .container-fluid"
    const DEFAULT_DURATION_MS     = 5000
    const BUS_TOPIC               = "data:notifications:posted"
    const TYPE_TO_CLASS = {
        success: "feedbackPanelSUCCESS",
        warning: "feedbackPanelWARNING",
        error:   "feedbackPanelERROR"
    }

    function _getClassName(type) {
        return TYPE_TO_CLASS[type] || TYPE_TO_CLASS.success
    }

    /**
     * Single-toast wrapper. Constructor builds the `<li>` element (not
     * yet attached to DOM); the manager appends + schedules removal.
     */
    class AesNotification {
        constructor(content, options) {
            const opts = options || {}
            const className = _getClassName(opts.type)
            this.element = document.createElement("li")
            this.element.className = className
            if (content != null && content !== "") {
                this._setContent(content)
            }
        }

        _createContent(text) {
            const span = document.createElement("span")
            span.innerText = " " + String(text)
            return span
        }

        _setContent(text) {
            const content = this._createContent(text)
            this.element.append(content)
        }

        /** Public message setter — replaces or appends the text content. */
        set message(text) {
            // Match upstream behavior — appends rather than replaces.
            this._setContent(text)
        }
    }

    /**
     * Manager. Idempotent — calling new AesNotifications() on every page
     * just re-uses the existing `.feedbackPanel` container if AS has
     * already rendered one.
     */
    class AesNotifications {
        constructor() {
            const target = document.querySelector(NAVBAR_AFTER_SELECTOR)
                        || document.body
            const existing = document.querySelector(FEEDBACK_PANEL_SELECTOR)
            if (existing) {
                this.container = existing
                return
            }
            this.container = this._createContainer()
            // Prepend so the panel sits above page content.
            if (target && target.prepend) {
                target.prepend(this.container)
            } else if (target && target.insertBefore) {
                target.insertBefore(this.container, target.firstChild)
            }
        }

        _createContainer() {
            const ul = document.createElement("ul")
            ul.className = "feedbackPanel"
            return ul
        }

        /**
         * Create + append a notification. Returns the AesNotification
         * instance so callers can grab `.element` for further DOM tweaks.
         *
         * @param {string} message
         * @param {object} [options] — {type: 'success'|'warning'|'error',
         *                              duration: ms (0 = persistent)}
         */
        newNotification(message, options) {
            const opts = options || {}
            const note = new AesNotification(message, opts)
            if (this.container && this.container.append) {
                this.container.append(note.element)
            }
            const duration = (typeof opts.duration === "number")
                ? opts.duration
                : DEFAULT_DURATION_MS
            if (duration > 0) {
                window.setTimeout(function () {
                    if (note.element && note.element.remove) note.element.remove()
                }, duration)
            }

            // Best-effort bus emit. Other modules can observe; the bus is
            // never required for the toast itself to render. If the bus
            // doesn't exist (load-order quirk or alternative context),
            // the call no-ops.
            try {
                if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                    window.AesDataBus.emit(BUS_TOPIC, {
                        message: String(message),
                        type:    opts.type || "success",
                        ts:      Date.now()
                    })
                }
            } catch (_) {
                // Never let bus issues poison a UI feedback path.
            }

            return note
        }

        /** Shorthand alias matching upstream's API. */
        add(message, options) {
            return this.newNotification(message, options)
        }
    }

    window.AesNotification  = AesNotification
    window.AesNotifications = AesNotifications

    // Optional: expose a lazy singleton accessor for callers that don't
    // want to manage their own instance. Most callers SHOULD use
    // `new AesNotifications().add(...)` — singletons here would keep a
    // reference to a stale `.feedbackPanel` container if AS re-rendered
    // the navbar. The accessor refreshes on every call.
    window.aesNotify = function (message, options) {
        return new AesNotifications().add(message, options)
    }
})()
