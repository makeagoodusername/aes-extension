/** Shared logic */
class AES {
    /**
     * Returns the airline name and code from the dashboard
     * @returns {object} {name: string, code: string}
     */
    static getAirlineCode() {
        const factsTable = document.querySelector(".facts table")
        const nameElement = factsTable.querySelector("tr:nth-child(1) td:last-child")
        const codeElement = factsTable.querySelector("tr:nth-child(2) td:last-child")

        return {
            name: nameElement.innerText,
            code: codeElement.innerText
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
        const source = document.querySelector(".as-navbar-bottom span:has(.fa-clock-o)").innerText.trim()
        const sourceAsNumbers = source.toString().replace(/\D/g, "")
        
        // The source always consists of 12 numbers
        const expectedLength = 12
        if (sourceAsNumbers.length != expectedLength) {
            throw new Error(`Unexpected length for source (${sourceAsNumbers.length}). There might’ve been a UI update. Check AES.getServerDate()`)
        }
        
        // Splits the date component from the data,
        // then splits that into an array for the year, month, and day
        let dateArray = source.split(" ")[0].split(/\D+/)
        if (dateArray[0].length === 2) {
            dateArray.reverse()
        }
        let date = dateArray[0]+dateArray[1]+dateArray[2]
        
        // Strip the date component from the data
        // leaving only the time
        let time = source.replace(/.{10}\s/, "")
        
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

// ── L1 account-registry bootstrap ──────────────────────────────────────
//
// Once the manifest content-script chain has loaded (deferred via
// setTimeout 0 to clear the synchronous load phase), kick off the
// account-registry bootstrap. It reads (server, airline) from the
// page DOM, computes the canonical id, sets `window.__aesAccountId`,
// and fires a single `aes:account:touch` message so background.js
// upserts the registry. See modules/_shared/account-registry.js.
//
// Harmless when the registry module / background handler / manifest
// entries aren't all wired yet — touchCurrent rejects silently and
// the bootstrap exits, leaving __aesAccountId unset; acctKey() then
// returns the legacy key shape per the §10 race-condition invariant.
;(function _aesL1ScheduleAccountBootstrap() {
    setTimeout(function () {
        if (typeof AesAccountRegistry === "undefined") return
        AesAccountRegistry.bootstrapFromPage()
    }, 0)
})()
