"use strict"

/**
 * In-page enhancements for AS's Online Reservation System results page
 * (`/app/info/ors*`). Adds numeric labels next to rating images and a
 * "Difference" column that compares each row's rating to the max seen so
 * far, persisting the max across navigation in localStorage so consecutive
 * ORS queries show meaningful deltas without round-tripping to the server.
 *
 * Adapted from upstream AES v0.7.8 `modules/onlineReservationSystem/`.
 *
 * Coexistence: `modules/route-assistant/ors-scraper.js` is a server-side
 * rating analyzer used by RA's pricing engine. This module is purely
 * in-page DOM enhancement — different surface, no shared state.
 *
 * Public API on `window.AesOnlineReservationSystem`:
 *   - constructor() — instantiate
 *   - .init()       — apply all enhancements (rating labels, diff column,
 *                     navigation persistence)
 */
;(function () {
    if (window.AesOnlineReservationSystem) return

    const LOCAL_STORAGE_KEY = "tmp_ors_maxRating"

    class OnlineReservationSystem {
        static LOCAL_STORAGE_KEY = LOCAL_STORAGE_KEY
        #maxRating

        constructor() {
            this.#maxRating = -100
        }

        init() {
            this.#restoreMaxRating()
            this.#clearStoredMaxRating()
            this.#addNumberToRating()
            this.#addDifferenceColumn()
            this.#setupNavigationPersistence()
        }

        #restoreMaxRating() {
            try {
                const stored = localStorage.getItem(LOCAL_STORAGE_KEY)
                if (stored !== null) this.#maxRating = parseInt(stored, 10)
            } catch (e) {
                console.error("[AES ORS] localStorage read failed:", e)
            }
        }

        #clearStoredMaxRating() {
            try { localStorage.removeItem(LOCAL_STORAGE_KEY) } catch (_) {}
        }

        #addNumberToRating() {
            const cells = document.querySelectorAll("td.rating, td.aircraft")
            cells.forEach((td) => {
                const img = td.querySelector("img")
                if (!img) return
                const title = img.getAttribute("title")
                const number = title && title.match(/-?\d+/)?.[0]
                if (number) {
                    img.style.marginRight = "6px"
                    img.insertAdjacentElement("afterend", this.#span(number))
                }
            })
        }

        #setupNavigationPersistence() {
            document.querySelectorAll(".navigation a[href]").forEach((link) => {
                link.addEventListener("click", () => {
                    try {
                        localStorage.setItem(LOCAL_STORAGE_KEY, this.#maxRating)
                    } catch (_) {}
                })
            })
        }

        #span(text) {
            const s = document.createElement("span")
            s.textContent = text
            s.className = "aes-text-left"
            return s
        }

        #addDifferenceColumn() {
            const table = this.#getResultsTable()
            if (!table) return

            const localMax = this.#getMaxRatingFromTable(table)
            this.#maxRating = Math.max(localMax, this.#maxRating)

            table.querySelectorAll("tbody").forEach((tb) => this.#processTbody(tb))
        }

        #getResultsTable() {
            return document.querySelector(".ors-result .as-panel .as-table-well > table.table")
        }

        #getMaxRatingFromTable(table) {
            const imgs = table.querySelectorAll("td.rating img")
            const ratings = Array.from(imgs).map((img) => {
                const title = img.getAttribute("title")
                return title ? parseInt(title.match(/-?\d+/)?.[0] || "0", 10) : 0
            })
            return ratings.length ? Math.max(...ratings) : -100
        }

        #processTbody(tbody) {
            const rows = tbody.querySelectorAll("tr")
            if (rows.length === 0) return
            const ratingIndex = this.#insertDifferenceHeader(rows[0])
            if (ratingIndex === -1) return
            rows.forEach((row) => this.#insertDifferenceCell(row))
        }

        #insertDifferenceHeader(headerRow) {
            const ths = headerRow.querySelectorAll("th")
            let idx = Array.from(ths).findIndex((th) => th.classList.contains("rating"))
            if (idx === -1) {
                idx = Array.from(ths).findIndex((th) => th.textContent.includes("Rating"))
            }
            if (idx === -1) return -1
            const diffTh = document.createElement("th")
            diffTh.textContent = "Difference"
            ths[idx].after(diffTh)
            return idx
        }

        #insertDifferenceCell(row) {
            const ratingTd = row.querySelector("td.rating") || row.querySelector("td.aircraft")
            const diffTd = document.createElement("td")
            if (row.classList.contains("totals")) {
                const img = ratingTd ? ratingTd.querySelector("img") : null
                let rating = 0
                if (img) {
                    const title = img.getAttribute("title")
                    rating = title ? parseInt(title.match(/-?\d+/)?.[0] || "0", 10) : 0
                }
                diffTd.textContent = String(this.#maxRating - rating)
            } else {
                diffTd.textContent = ""
            }
            if (ratingTd) ratingTd.after(diffTd)
        }
    }

    window.AesOnlineReservationSystem = OnlineReservationSystem

    // Defensive URL guard — manifest already scopes us to /app/info/ors*,
    // but if a future entry widens the pattern we won't blow up on
    // unrelated pages.
    if (location.pathname.includes("/app/info/ors")) {
        new OnlineReservationSystem().init()
    }
})()
