/** Shared logic */
class AES {
    /**
     * Returns the airline name and code from the dashboard
     * @returns {object} {name: string, code: string}
     */
    static getAirlineCode() {
        const factsTable = document.querySelector(".facts table")
        const nameElement = factsTable?.querySelector("tr:nth-child(1) td:last-child")
        const codeElement = factsTable?.querySelector("tr:nth-child(2) td:last-child")
        const name = (nameElement?.innerText || "").trim()
        const code = (codeElement?.innerText || "").trim()

        if (!name && !code) {
            const identity = AES.getAirlineIdentity()
            return {
                name: identity,
                code: identity
            }
        }

        return {
            name: name || code,
            code: code || name
        }
    }

    /**
     * Returns a stable per-airline identifier that works on every /app/* page.
     * The top-nav airline name is present on all pages (dashboard, airport,
     * stations, etc), so we prefer it over .facts — which only exists on the
     * enterprise dashboard — to keep storage keys consistent across pages.
     * @returns {string}
     */
    static getAirlineIdentity() {
        const navName = document.querySelector(".as-navbar-main a.name span:not(.caret)")
        if (navName?.innerText) return navName.innerText.trim()
        for (const el of document.querySelectorAll("a.name")) {
            const text = (el.innerText || "").trim()
            if (text) return text
        }
        const factsCell = document.querySelector(".facts table tr:nth-child(2) td:last-child")
        if (factsCell?.innerText) return factsCell.innerText.trim()
        return ""
    }
    
    /**
     * Returns the server name
     * @returns {string} server name
     */
    static getServerName() {
        const hostname = window.location.hostname
        const servername = hostname.split(".")[0]

        return servername
    }

    static getServer() {
        return AES.getServerName()
    }

    /**
     * Formats a currency value local standards
     * @param {integer} currency value
     * @param {string} alignment: "right" | "left"
     * @returns {HTMLElement} span with formatted value
     */
    static formatCurrency(value, alignment) {
        let container = document.createElement("span")
        let formattedValue = Intl.NumberFormat().format(value)
        let indicatorEl = document.createElement("span")
        let valueEl = document.createElement("span")
        let currencyEl = document.createElement("span")
        let containerClasses = "aes-no-text-wrap"
        
        if (alignment === "right") {
            containerClasses = "aes-text-right aes-no-text-wrap"
        }
        
        if (value > 0) {
            valueEl.classList.add("good")
            indicatorEl.classList.add("good")
            indicatorEl.innerText = "+"
        }
        
        if (value < 0) {
            valueEl.classList.add("bad")
            indicatorEl.classList.add("bad")
            indicatorEl.innerText = "-"
            formattedValue = formattedValue.replace("-", "")
        }
        
        valueEl.innerText = formattedValue
        currencyEl.innerText = " AS$"
        
        container.className = containerClasses
        container.append(indicatorEl, valueEl, currencyEl)
        
        return container
    }
    
    /**
     * Formats a date string to human readable format
     * @param {string} "20240524"
     * @returns {string} "2024-05-24" | "error: invalid format for AES.formatDateString"
     */
    static formatDateString(date) {
        if (!date) {
            return
        }
        
        const correctLength = date.length === 8
        const isInteger = Number.isInteger(parseInt(date))
        let result = "error: invalid format for AES.formatDateString"
        
        if (correctLength && isInteger) {
            const year = date.substring(0, 4)
            const month = date.substring(4, 6)
            const day = date.substring(6, 8)
            result = `${year}-${month}-${day}`
        }
        
        return result
    }
    /**
     * Returns a formatted date (week) string
     * @param {string} "212024"
     * @returns {string} "21/2014 | "error: invalid format for AES.formatDateStringWeek"
     */
    static formatDateStringWeek(date) {
        const correctLength = date.toString().length === 6
        const isInteger = Number.isInteger(parseInt(date))
        let result = "error: invalid format for AES.formatDateStringWeek"
        
        if (correctLength && isInteger) {
            const DateAsString = date.toString()
            const week = DateAsString.substring(0, 2)
            const year = DateAsString.substring(2, 6)
            
            result = `${week}/${year}`
        }
        
        return result
    }
    
    /**
     * Takes a number and adds “(day|days) ago”
     * @param {integer} - 0 | 1 | 256
     @ returns {string} - "0 days ago" | "1 day ago" | "256 days ago"
     */
    static formatDaysAgo(daysAgo) {
        let dayOrDays = "days"
        if (daysAgo === 1) {
            dayOrDays = "day"
        }
        const result = `${daysAgo} ${dayOrDays} ago`

        return result
    }
    
    /**
     * Gets the server’s current date and time
     * @returns {object} datetime - { date: "20240607", time: "16:24 UTC" }
     */
    static getServerDate() {
        const fallbackDate = new Date()
        const fallback = {
            date: fallbackDate.getUTCFullYear().toString()
                + String(fallbackDate.getUTCMonth() + 1).padStart(2, "0")
                + String(fallbackDate.getUTCDate()).padStart(2, "0"),
            time: String(fallbackDate.getUTCHours()).padStart(2, "0")
                + ":" + String(fallbackDate.getUTCMinutes()).padStart(2, "0") + " UTC"
        }

        const sourceEl = document.querySelector(".as-navbar-bottom span:has(.fa-clock-o)")
            || document.querySelector(".as-navbar-bottom span")
            || document.querySelector(".as-navbar-bottom")
        const source = sourceEl ? (sourceEl.innerText || sourceEl.textContent || "").trim() : ""
        if (!source) return fallback

        const sourceAsNumbers = source.toString().replace(/\D/g, "")

        // Splits the date component from the data,
        // then splits that into an array for the year, month, and day
        let dateArray = source.split(" ")[0].split(/\D+/).filter(Boolean)
        if (dateArray.length < 3 && sourceAsNumbers.length >= 8) {
            dateArray = [
                sourceAsNumbers.substring(0, 4),
                sourceAsNumbers.substring(4, 6),
                sourceAsNumbers.substring(6, 8)
            ]
        }
        if (dateArray.length < 3) return fallback
        if (dateArray[0].length === 2) {
            dateArray.reverse()
        }
        let date = dateArray[0]+dateArray[1]+dateArray[2]
        
        // Strip the date component from the data
        // leaving only the time
        let timeMatch = source.match(/\b\d{1,2}:\d{2}(?:\s*[A-Z]{2,4})?\b/)
        let time = timeMatch ? timeMatch[0] : fallback.time
        
        const datetime = {
            date: date,
            time: time
        }
        
        return datetime
    }
    
    /**
     * Returns the difference between dates in days
     * @param {array|string} ["20240520", "20240524"] | ["20240520"] | "20240520"
     * @returns {integer} 4
     */
    static getDateDiff(dates) {
        // If a string is passed:
        // Create an array with the string as its first item
        if (typeof dates === "string") {
            dates = [dates]
        }
        // If `dates` has only one item:
        // Prepend the server date
        if (dates?.length === 1) {
            dates = [AES.getServerDate().date, dates[0]]
        }
        let dateA = new Date(`${this.formatDateString(dates[0])}T12:00:00Z`)
        let dateB = new Date(`${this.formatDateString(dates[1])}T12:00:00Z`)
        let result = Math.round((dateA - dateB)/(1000 * 60 * 60 * 24))
        
        return result
    }
    
    /**
     * Cleans a string of punctuation to returns an integer
     * @param {string} value - "-2,000 AS$" | "2.000 AS$" | "256"
     * @returns {integer} -2000 | 2000 | 256
     */
    static cleanInteger(value) {
        // TODO: create separate function for cleaning currency values
        // value = value.trim()
        // const isExpectedFormat = Boolean(value.match(/^-?(\d+[.,]?)+ AS\$$/))
        //
        // if (!isExpectedFormat) {
        //     throw new Error("cleanInteger(): unexpected format for value")
        // }

        // Match any character that’s no a digit or a dash
        const result = value.replaceAll(/[^\d-]/g, "")
        return parseInt(result, 10)
    }

    /**
     * Safely updates the global `settings` blob in chrome.storage.local.
     * Reads the current snapshot, hands it to `mutator` for in-place
     * editing, writes it back, then invokes `callback(latest)`. Both
     * arguments optional. Ported from v0.7.8 helpers.js.
     * @param {function(object): void} [mutator]
     * @param {function(object): void} [callback]
     */
    static updateSettings(mutator, callback) {
        chrome.storage.local.get(["settings"], function (result) {
            const current = result.settings || {}
            if (typeof mutator === "function") {
                mutator(current)
            }
            chrome.storage.local.set({ settings: current }, function () {
                if (typeof callback === "function") {
                    callback(current)
                }
            })
        })
    }

    /**
     * Builds the storage key for a competitor-monitoring record.
     * Owner-scoped form preferred when ownerAirlineId is present so
     * cross-airline shared-fleet sims don't collide.
     * @param {string} server
     * @param {string} ownerAirlineId
     * @param {string} competitorAirlineId
     * @returns {string}
     */
    static getCompetitorMonitoringKey(server, ownerAirlineId, competitorAirlineId) {
        if (ownerAirlineId) {
            return `${server}${ownerAirlineId}_${competitorAirlineId}competitorMonitoring`
        }
        return `${server}${competitorAirlineId}competitorMonitoring`
    }

    /**
     * Builds the storage key for the owner-scoped
     * competitor-monitoring index.
     * @param {string} server
     * @param {string} ownerAirlineId
     * @returns {string}
     */
    static getCompetitorMonitoringIndexKey(server, ownerAirlineId) {
        return `${server}${ownerAirlineId}competitorMonitoringIndex`
    }

    /**
     * Promise-resolving timeout. Useful for staggering scrapes.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    static sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }

    /**
     * Opens up to 20 URLs in new tabs, 200 ms apart, to avoid AS
     * rate-limiting. Caps at 20 even if `pages.length` exceeds.
     * @param {string[]} pages
     */
    static async openPagesWithDelay(pages) {
        const cap = Math.min(pages.length, 20)
        for (let i = 0; i < cap; i++) {
            window.open(pages[i], "_blank")
            await AES.sleep(200)
        }
    }
}

if (typeof window !== "undefined") {
    window.AES = AES
}

/**
 * HTML-escape a string for safe insertion via innerHTML. Coerces null/undefined
 * to "" so callers can pass possibly-missing fields directly. Defined as a
 * top-level helper so any module loaded after helpers.js (which is in the /app
 * + /action content-script block — i.e. every page on airlinesim.aero) can use
 * it without redefining its own copy.
 */
function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

// ── L1 + L2.2 account-registry bootstrap ───────────────────────────────
//
// Once the manifest content-script chain has loaded (deferred via
// setTimeout 0 to clear the synchronous load phase), kick off the
// account-registry bootstrap. It reads (server, airline) from the
// page DOM, computes the canonical id, sets `window.__aesAccountId`,
// and fires a single `aes:account:touch` message so background.js
// upserts the registry. See modules/_shared/account-registry.js.
//
// After the touch resolves, run the L2.2 legacy-migration shim. It's
// a no-op once `migrationVersion >= 1`; on first run it copies the
// pre-L2 Class C/D legacy keys into the namespaced slot for the
// active account (or flags `migrationPending` for multi-account users
// — the L2.2.c modal handles those). Failures inside the shim are
// caught and logged; the legacy-fallback path in every refactored
// store keeps working until the next mount retries.
//
// Harmless when the registry module / migration shim / background
// handler / manifest entries aren't all wired yet — each layer guards
// for typeof undefined and silently bails.
;(function _aesL1ScheduleAccountBootstrap() {
    setTimeout(async function () {
        if (typeof AesAccountRegistry === "undefined") return
        await AesAccountRegistry.bootstrapFromPage()
        if (typeof AesMigrateLegacy !== "undefined") {
            AesMigrateLegacy.runIfNeeded()
        }
    }, 0)
})()
