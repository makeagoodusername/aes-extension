"use strict"

/**
 * Page-world bridge for the aircraft-flight-plan form driver.
 *
 * Content scripts run in an isolated world — `window.jQuery` and the
 * select2 plugin live in the page's world, unreachable from the form
 * driver. This file is registered with `"world": "MAIN"` in manifest.json
 * so it runs in the page's own JS context.
 *
 * Protocol: the content script writes the desired option value onto the
 * <select> element as `data-aes-pending-value` and dispatches a bubbling
 * `aes:afp:commit-select` Event on that element. CustomEvent.detail does
 * NOT round-trip across the isolated/main world boundary in Chrome, but
 * DOM elements and their attributes are shared — so this handler reads
 * the value off the attribute, calls the page's real jQuery + select2,
 * and lets Wicket's onchange Ajax fire.
 */
;(function () {
    if (window.__aesAfpMainBridge) return
    window.__aesAfpMainBridge = true
    document.addEventListener("aes:afp:commit-select", function (ev) {
        try {
            const sel = ev.target
            if (!sel || !sel.tagName || sel.tagName !== "SELECT") return
            const value = sel.getAttribute("data-aes-pending-value")
            if (value == null) return
            sel.removeAttribute("data-aes-pending-value")
            sel.value = value
            const $ = window.jQuery || window.$
            if ($ && $.fn && typeof $.fn.select2 === "function") {
                const $sel = $(sel)
                // Try v3 first (`triggerChange=true` is the v3-only third arg
                // and already fires the change event Wicket listens for). On
                // success we're done — firing another change here would issue
                // a SECOND Wicket Ajax round-trip, which races with the first
                // and snaps the chip back to its prior server-side value.
                let committed = false
                try { $sel.select2("val", value, true); committed = true } catch (_) { /* v4 */ }
                if (!committed) {
                    try { $sel.val(value).trigger("change"); committed = true } catch (_) {}
                }
                if (!committed) sel.dispatchEvent(new Event("change", {bubbles: true}))
            } else {
                sel.dispatchEvent(new Event("change", {bubbles: true}))
            }
        } catch (e) {
            console.warn("[AES afp main-bridge] commit failed", e)
        }
    }, true)
})()
