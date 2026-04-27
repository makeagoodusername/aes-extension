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

// ---------------------------------------------------------------------------
// AES — account-identity bootstrap (Slice L1).
//
// Resolves (server, airline) from the current AS page, derives a stable
// 12-hex accountId, caches it on window.__aesAccountId for synchronous reads
// by per-store account-aware adapters, and fires a best-effort touch message
// to background.js so the registry refreshes lastSeenAt.
//
// Runs on every /app/* + /action/* page (this file is loaded by the second
// content_scripts manifest entry, alongside jquery + AesAccountRegistry).
// The navbar-based identity probe occasionally returns "" on slow loads
// before the navbar mounts — we retry twice with exponential delay.
// ---------------------------------------------------------------------------
(function aesAccountIdentityBootstrap() {
    if (typeof window === "undefined") return;
    if (window.__aesAccountIdentityBootstrapped) return;
    window.__aesAccountIdentityBootstrapped = true;

    function resolveOnce() {
        if (window.__aesAccountId) return true;
        if (typeof AES === "undefined") return false;
        let server, airline;
        try { server = AES.getServerName(); }     catch (_) { server = ""; }
        try { airline = AES.getAirlineIdentity(); } catch (_) { airline = ""; }
        if (!server || !airline) return false;

        const trimmedAirline = String(airline).trim();
        const accountId = (typeof AesAccountRegistry !== "undefined")
            ? AesAccountRegistry.accountIdOf(server, trimmedAirline)
            : null;
        if (!accountId) return false;

        window.__aesAccountId      = accountId;
        window.__aesAccountServer  = server;
        window.__aesAccountAirline = trimmedAirline;

        // Best-effort touch — failure is non-fatal (background may not be
        // ready yet on cold start; the next page load retries).
        try {
            if (typeof AesAccountRegistry !== "undefined" && AesAccountRegistry.touch) {
                AesAccountRegistry.touch(server, trimmedAirline);
            } else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage(
                    {type: "aes:account:touch", accountId, server, airline: trimmedAirline, meta: {}},
                    () => { void chrome.runtime.lastError; }
                );
            }
        } catch (_) { /* noop */ }

        return true;
    }

    if (resolveOnce()) return;

    // Navbar can mount late on slow pages; retry once after DOM-content,
    // then again at 1.5s and 4s as a final fallback.
    function later() {
        if (resolveOnce()) return;
        setTimeout(() => { if (!resolveOnce()) setTimeout(resolveOnce, 2500); }, 1500);
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", later, {once: true});
    } else {
        later();
    }
})();
