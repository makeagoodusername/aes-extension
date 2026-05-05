/**
 * Content-side feedback toast helper. Ported from
 * AirlineSim-Enhancement-Suite-main v0.7.8 (NEWLY2014 fork) and merged
 * into a single IIFE module exposing `window.AesFeedbackToast`.
 *
 * Distinct from `modules/_background/notifications.js`, which is the
 * service-worker layer that fires desktop chrome.notifications. This
 * module is purely DOM — it appends list items into AS's own
 * `.feedbackPanel` element (or creates one) so toasts use the native
 * AS feedbackPanelSUCCESS/WARNING/ERROR styling already in AS's CSS.
 *
 * Public surface:
 *   window.AesFeedbackToast.show(message, { type, duration })
 *      type:     "success" | "warning" | "error"  (default "success")
 *      duration: ms before auto-dismiss; 0 = sticky (default 5000)
 *
 * The constructor-based pattern from upstream is kept internal; callers
 * use the singleton via `show()`. Idempotent on multiple loads.
 */
;(function () {
    "use strict"

    if (window.AesFeedbackToast) {
        return
    }

    function getOrCreateContainer() {
        const existing = document.querySelector(".feedbackPanel")
        if (existing) {
            return existing
        }
        const container = document.createElement("ul")
        container.className = "feedbackPanel"
        const anchor = document.querySelector("nav.as-navbar-main + .container-fluid")
            || document.body
        anchor.prepend(container)
        return container
    }

    function classFor(type) {
        switch (type) {
            case "warning": return "feedbackPanelWARNING"
            case "error":   return "feedbackPanelERROR"
            default:        return "feedbackPanelSUCCESS"
        }
    }

    function show(message, options) {
        const opts = options || {}
        const li = document.createElement("li")
        li.className = classFor(opts.type)
        const span = document.createElement("span")
        span.innerText = " " + (message == null ? "" : String(message))
        li.append(span)

        const container = getOrCreateContainer()
        container.append(li)

        const duration = typeof opts.duration === "number" ? opts.duration : 5000
        if (duration > 0) {
            window.setTimeout(function () {
                li.remove()
            }, duration)
        }
        return li
    }

    function clear() {
        const container = document.querySelector(".feedbackPanel")
        if (container) {
            while (container.firstChild) {
                container.removeChild(container.firstChild)
            }
        }
    }

    window.AesFeedbackToast = { show, clear }
})()
