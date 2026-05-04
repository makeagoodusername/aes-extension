/**
 * ORS max-rating tracker. Ported from
 * AirlineSim-Enhancement-Suite-main v0.7.8 (NEWLY2014 fork).
 *
 * Annotates the live `/app/info/ors*` results page with:
 *   - the integer rating extracted from the rating-image `title` attribute,
 *     rendered as a span next to the image;
 *   - a "Difference" column showing (max rating seen - row rating) for
 *     totals rows.
 *
 * Persistence: localStorage["tmp_ors_maxRating"] holds the running max
 * across paginated navigations. Distinct from `modules/route-assistant/
 * ors-scraper.js`, which fetches ORS off-page and never touches the live
 * DOM.
 *
 * Public surface:
 *   window.AesOnlineReservationSystem.init()  // re-runs the augmentation
 *
 * Self-runs on script load (matches upstream).
 */
;(function () {
    "use strict"

    if (window.AesOnlineReservationSystem) {
        return
    }

    const LOCAL_STORAGE_KEY = "tmp_ors_maxRating"

    class OnlineReservationSystem {
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
                if (stored !== null) {
                    this.#maxRating = parseInt(stored, 10)
                }
            } catch (e) {
                console.error("[AES ORS] localStorage read failed:", e)
            }
        }

        #clearStoredMaxRating() {
            try {
                localStorage.removeItem(LOCAL_STORAGE_KEY)
            } catch (e) {
                // Ignore
            }
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
                    img.insertAdjacentElement("afterend", this.#generateSpanElement(number))
                }
            })
        }

        #setupNavigationPersistence() {
            document.querySelectorAll(".navigation a[href]").forEach((link) => {
                link.addEventListener("click", () => {
                    localStorage.setItem(LOCAL_STORAGE_KEY, this.#maxRating)
                })
            })
        }

        #generateSpanElement(text) {
            const span = document.createElement("span")
            span.textContent = text
            span.className = "aes-text-left"
            return span
        }

        #addDifferenceColumn() {
            const table = this.#getResultsTable()
            if (!table) return

            const localMaxRating = this.#getMaxRatingFromTable(table)
            this.#maxRating = Math.max(localMaxRating, this.#maxRating)

            const tbodies = table.querySelectorAll("tbody")
            tbodies.forEach((tbody) => this.#processTbody(tbody))
        }

        #getResultsTable() {
            return document.querySelector(".ors-result .as-panel .as-table-well > table.table")
        }

        #getMaxRatingFromTable(table) {
            const ratingImgs = table.querySelectorAll("td.rating img")
            const ratings = Array.from(ratingImgs).map((img) => {
                const title = img.getAttribute("title")
                return title ? parseInt(title.match(/-?\d+/)?.[0] || "0", 10) : 0
            })
            return ratings.length ? Math.max(...ratings) : -100
        }

        #processTbody(tbody) {
            const rows = tbody.querySelectorAll("tr")
            if (rows.length === 0) return

            const headerRow = rows[0]
            const ratingIndex = this.#insertDifferenceHeader(headerRow)
            if (ratingIndex === -1) return

            rows.forEach((row) => this.#insertDifferenceCell(row))
        }

        #insertDifferenceHeader(headerRow) {
            const ths = headerRow.querySelectorAll("th")
            let ratingThIdx = Array.from(ths).findIndex((th) => th.classList.contains("rating"))
            if (ratingThIdx === -1) {
                ratingThIdx = Array.from(ths).findIndex((th) => th.textContent.includes("Rating"))
            }
            if (ratingThIdx === -1) return -1

            const diffTh = document.createElement("th")
            diffTh.textContent = "Difference"
            ths[ratingThIdx].after(diffTh)
            return ratingThIdx
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
                diffTd.textContent = this.#maxRating - rating
            } else {
                diffTd.textContent = ""
            }

            if (ratingTd) {
                ratingTd.after(diffTd)
            }
        }
    }

    const instance = new OnlineReservationSystem()

    window.AesOnlineReservationSystem = {
        init: () => instance.init()
    }

    instance.init()
})()
