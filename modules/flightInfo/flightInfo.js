"use strict"

/**
 * Vanilla-DOM, async/await-friendly entry point for the AS private flight
 * info page (`/action/info/flight*`). Detects when the user is on a private
 * flight, scrapes the contribution-margin (CM1..CMn) table, persists the
 * snapshot to chrome.storage.local, and renders a compact summary panel.
 *
 * Adapted from upstream AES v0.7.8 `modules/flightInfo/flightInfo.js`. The
 * only behavioural drift from upstream is that this build does NOT
 * auto-instantiate at script load — callers opt in via
 *   new window.AesFlightInfo().init()
 *
 * Coexistence: `content_flightInfo.js` is the canonical, auto-installed
 * handler for the same page (jQuery-based) and includes fork-specific
 * improvements that this module deliberately does not duplicate:
 *   - F-9228-807: airline-scoped storage keys preventing cross-airline collisions
 *   - F-9228-806: surfaces chrome.runtime.lastError on save failures
 *   - AES.normalizeSettings() compatibility shim for legacy settings shapes
 * If you want the canonical fork behaviour, use content_flightInfo.js. If
 * you want the upstream class API (e.g. for a scripted scrape), use this.
 *
 * Storage key shape: `${server}${type}${flightId}` (flat, matches upstream).
 * The fork's content_flightInfo.js writes to a different airline-scoped key.
 *
 * Public API on `window.AesFlightInfo`:
 *   constructor()
 *   .init() — async; gated on privInf + active tab; scrape, persist, render
 */
;(function () {
    if (window.AesFlightInfo) return

    const CM_LABELS = ["Y", "C", "F", "PAX", "Cargo", "Total"]

    class FlightInfo {
        #data = null

        async init() {
            if (!this.#isPrivateFlight() || !this.#isCorrectTabOpen()) return
            this.#data = this.#collectFlightData()
            await this.#saveData()
            this.#render()
        }

        #isPrivateFlight() {
            return document.getElementById("privInf") !== null
        }

        #isCorrectTabOpen() {
            const tab = document.querySelector("#flight-page > ul > li")
            return Boolean(tab && tab.classList.contains("active"))
        }

        #collectFlightData() {
            const dateTime = AES.getServerDate()
            return {
                server: AES.getServerName(),
                flightId: this.#getFlightId(),
                type: "flightInfo",
                money: this.#getFinancials(),
                date: dateTime.date,
                time: dateTime.time
            }
        }

        #getFlightId() {
            const url = new URL(window.location.href)
            return parseInt(url.searchParams.get("id"), 10)
        }

        #getFinancials() {
            const data = {}
            document.querySelectorAll(".cm").forEach((row, index) => {
                const cmLabel = `CM${index + 1}`
                data[cmLabel] = {}
                row.querySelectorAll("td").forEach((cell, i) => {
                    const label = CM_LABELS[i]
                    if (!label) return
                    data[cmLabel][label] = AES.cleanInteger(cell.textContent)
                })
            })
            return data
        }

        async #saveData() {
            const key = `${this.#data.server}${this.#data.type}${this.#data.flightId}`
            const toast = window.AesNotifications && window.AesNotifications.toast
            try {
                await chrome.storage.local.set({ [key]: this.#data })
                const result = await chrome.storage.local.get(["settings"])
                if (result?.settings?.flightInfo?.autoClose) window.close()
                if (toast) toast("Flight information saved successfully.", { type: "success" })
            } catch (e) {
                if (toast) toast("Flight information save failed.", { type: "error" })
                console.error("[AesFlightInfo] save failed", e)
            }
        }

        #render() {
            const container = document.createElement("div")
            container.appendChild(this.#createHeading())
            container.appendChild(this.#createPanel())
            const anchor = document.querySelector("body > .container-fluid > h1")
            if (anchor) anchor.insertAdjacentElement("afterend", container)
        }

        #createHeading() {
            const h = document.createElement("h3")
            h.textContent = "AES Flight Information"
            return h
        }

        #createPanel() {
            const well = document.createElement("div")
            well.className = "as-table-well"
            well.appendChild(this.#buildTable())
            const panel = document.createElement("div")
            panel.className = "as-panel"
            panel.appendChild(well)
            return panel
        }

        #buildTable() {
            const table = document.createElement("table")
            table.className = "aes-table table table-bordered table-striped table-hover"
            table.appendChild(this.#buildTableHead())
            table.appendChild(this.#buildTableBody())
            return table
        }

        #buildTableHead() {
            const thead = document.createElement("thead")
            const row = document.createElement("tr")
            ;["", ...CM_LABELS].forEach(label => {
                const th = document.createElement("th")
                th.className = "aes-text-right"
                th.textContent = label
                row.appendChild(th)
            })
            thead.appendChild(row)
            return thead
        }

        #buildTableBody() {
            const tbody = document.createElement("tbody")
            Object.entries(this.#data.money).forEach(([cm, values]) => {
                const row = document.createElement("tr")
                const th = document.createElement("th")
                th.textContent = cm
                row.appendChild(th)
                CM_LABELS.forEach(label => {
                    const td = document.createElement("td")
                    td.className = "aes-text-right"
                    td.appendChild(AES.formatCurrency(values[label], "right"))
                    row.appendChild(td)
                })
                tbody.appendChild(row)
            })
            return tbody
        }
    }

    window.AesFlightInfo = FlightInfo
})()
