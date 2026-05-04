"use strict"

/**
 * AS-native in-page toast utility. Renders into the existing
 * `.feedbackPanel` slot below the AS navbar so the visuals match
 * AirlineSim's own success/warning/error banners. Adapted from the
 * upstream AES v0.7.8 `modules/notification.js` + `modules/notifications.js`
 * pair, combined into one file because the two classes are tightly coupled.
 *
 * Coexistence: `modules/route-assistant/toast-host.js` is RA-specific and
 * uses its own CSS classes; this one targets `feedbackPanel*` and is the
 * generic AS-style banner. Independent instances, no shared state.
 *
 * Public API on `window.AesNotifications`:
 *   - `Notification`       — single banner element class
 *   - `Notifications`      — container manager (creates / reuses .feedbackPanel)
 *   - `toast(msg, opts)`   — singleton convenience: lazy-creates one Notifications
 *                            instance and forwards .add(msg, opts).
 */
;(function () {
    if (window.AesNotifications) return

    class Notification {
        name = "Notification"
        element

        constructor(content, options) {
            const type = options && options.type ? options.type : "success"
            this.element = this.#createElement(this.#getClassName(type))
            if (content) this.#setContent(content)
        }

        #getClassName(type) {
            switch (type) {
                case "warning": return "feedbackPanelWARNING"
                case "error":   return "feedbackPanelERROR"
                default:        return "feedbackPanelSUCCESS"
            }
        }

        #createElement(className) {
            const li = document.createElement("li")
            li.className = className
            return li
        }

        #createContent(text) {
            const span = document.createElement("span")
            span.innerText = ` ${text}`
            return span
        }

        #setContent(text) {
            this.element.append(this.#createContent(text))
        }

        set message(text) { this.#setContent(text) }
    }

    class Notifications {
        name = "Notifications"
        container

        constructor() {
            const existing = document.querySelector(".feedbackPanel")
            if (existing) {
                this.container = existing
                return
            }
            const target =
                document.querySelector("nav.as-navbar-main + .container-fluid") ||
                document.body
            this.container = this.#createContainer()
            target.prepend(this.container)
        }

        #createContainer() {
            const ul = document.createElement("ul")
            ul.className = "feedbackPanel"
            return ul
        }

        newNotification(message, options) {
            const n = new Notification(message, options)
            this.container.append(n.element)
            const duration = typeof options?.duration === "number" ? options.duration : 5000
            if (duration > 0) {
                window.setTimeout(() => n.element.remove(), duration)
            }
            return n
        }

        add(message, options) {
            return this.newNotification(message, options)
        }
    }

    const api = {
        Notification,
        Notifications,
        _instance: null,
        toast(message, options) {
            if (!api._instance) api._instance = new Notifications()
            return api._instance.add(message, options)
        }
    }

    window.AesNotifications = api
})()
