"use strict"

/**
 * Lightweight feedbackPanel-style notification element builder ported from
 * upstream AirlineSim Enhancement Suite v0.7.8. No current callers in the
 * fork — exposed as `window.AesNotification` so future modules can build a
 * simple AS-styled toast without pulling in the full notifications subsystem.
 *
 * Usage:
 *   const note = new window.AesNotification("Saved", { type: "success" })
 *   document.querySelector("#feedbackPanel").append(note.element)
 */
;(function () {
    if (window.AesNotification) return

    class Notification {
        name = "Notification"
        element

        constructor(content, {type} = {type: "success"}) {
            const className = this.#getClassName(type)
            this.element = this.#createElement(className)
            if (content) {
                this.#setContent(content)
            }
        }

        #getClassName(type) {
            switch (type) {
                case "warning": return "feedbackPanelWARNING"
                case "error":   return "feedbackPanelERROR"
                default:        return "feedbackPanelSUCCESS"
            }
        }

        #createElement(className) {
            const element = document.createElement("li")
            element.className = className
            return element
        }

        #createContent(text) {
            const content = document.createElement("span")
            content.innerText = ` ${text}`
            return content
        }

        #setContent(text) {
            const content = this.#createContent(text)
            this.element.append(content)
        }

        set message(text) {
            this.#setContent(text)
        }
    }

    window.AesNotification = Notification
})()
